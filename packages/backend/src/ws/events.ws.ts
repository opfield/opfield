import type { WSContext } from 'hono/ws';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { TOOL_STORE_INVALIDATION_CHANNEL_PREFIX } from '@/modules/ai/ai-tool-store-invalidation.js';
import { MFA_REQUIRED_CHANNEL_PREFIX } from '@/modules/auth/mfa-events.js';
import { userResourceChannelUserId } from '@/modules/auth/user-resource-events.js';
import { resolveWebSocketCredentialContext } from '@/modules/auth/websocket-auth.js';
import {
  DockerAccessResourceService,
  dockerScopedNodeIds,
  hasDockerResourceScope,
} from '@/modules/docker/docker-access-resource.service.js';
import { hasDockerNodeRouteAccess } from '@/modules/docker/docker-route-resolvers.js';
import {
  INFERENCE_USAGE_CHANGED_CHANNEL,
  type InferenceUsageChangedEvent,
} from '@/modules/inference/accounting/inference-usage-events.js';
import { INFERENCE_CATALOG_CHANGED_CHANNEL } from '@/modules/inference/inference-catalog-events.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import {
  AVAILABILITY_SET_CHANNEL,
  DATABASE_CHANNEL_SCOPE_BASES,
  hasAvailabilityEventAccess,
  hasAvailabilitySetEventAccess,
  hasChannelAccess,
  hasHostingSnapshotEventAccess,
  hasIntegrationConnectorEventAccess,
  isDefaultDeliverChannel,
  projectHostingSnapshotEvent,
  requiredScopeFor,
} from './events-channel-access.js';

const logger = createChildLogger('Events-WebSocket');
const MAX_EVENT_MESSAGE_BYTES = 64 * 1024;
const MAX_PENDING_MESSAGES = 32;
const MAX_PENDING_MESSAGE_BYTES = 64 * 1024;
const KEEPALIVE_INTERVAL_MS = 5_000;

interface ConnState {
  sessionToken?: string;
  deliveryQueue?: Promise<void>;
  queuedDeliveries?: number;
  /** Until when the cached effective scopes are trusted for folder/node grant users (epoch ms). */
  scopesFreshUntil?: number;
  user: User | null;
  scopes: string[];
  authenticated: boolean;
  /** channel → unsubscribe fn from EventBus */
  subs: Map<string, () => void>;
  keepalive: ReturnType<typeof setInterval> | null;
  /** unsubscribe from this user's permissions.changed.<userId> */
  permsUnsub: (() => void) | null;
  /** Messages received before authentication completes — drained on auth. */
  pendingMessages: ClientMsg[];
  preAuthMessageCount: number;
  pendingMessageBytes: number;
}

interface ClientMsg {
  type: 'subscribe' | 'unsubscribe' | 'ping';
  channels?: string[];
}

type ServerMsg =
  | { type: 'event'; channel: string; payload: unknown }
  | { type: 'subscribed'; channels: string[]; rejected: string[] }
  | { type: 'permissions'; scopes: string[] }
  | { type: 'pong' }
  | { type: 'error'; message: string };

const states = new WeakMap<WSContext, ConnState>();

function send(ws: WSContext, msg: ServerMsg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* ignore */
  }
}

function isProxyFolderLayoutPayload(payload: unknown): boolean {
  const action = (payload as { action?: string } | undefined)?.action;
  return (
    action === 'folders_reordered' ||
    action === 'hosts_moved' ||
    action === 'hosts_reordered' ||
    !!action?.startsWith('folder_')
  );
}

function dockerEventResourceId(payload: unknown): string | null {
  const event = payload as
    | {
        nodeId?: string;
        scopeResourceId?: string;
        deploymentId?: string;
        containerId?: string;
        id?: string;
        containerName?: string;
        name?: string;
        projectId?: string;
      }
    | undefined;
  if (event?.scopeResourceId) return event.scopeResourceId;
  if (event?.projectId) return event.projectId;
  if (event?.deploymentId) return event.deploymentId;
  if (!event?.nodeId) return null;
  try {
    return container.resolve(DockerAccessResourceService).cachedContainerResourceId(event.nodeId, {
      runtimeId: event.containerId ?? event.id,
      name: event.containerName ?? event.name,
    });
  } catch {
    return null;
  }
}

function hasDockerEventAccess(scopes: string[], baseScope: string, payload: unknown): boolean {
  const nodeId = (payload as { nodeId?: string } | undefined)?.nodeId;
  if (!nodeId) return false;
  return hasDockerResourceScope(scopes, baseScope, nodeId, dockerEventResourceId(payload) ?? '');
}

export function canReceiveChannelPayload(
  scopes: string[],
  channel: string,
  payload: unknown,
  userId?: string
): boolean {
  if (channel === 'domain.changed') {
    const event = payload as { id?: unknown; folderId?: unknown; action?: unknown } | undefined;
    if (typeof event?.id === 'string') return hasScope(scopes, `domains:view:${event.id}`);
    // Layout invalidations contain no domain data; an object with no identity is
    // not implicitly treated as a readable domain.
    return (
      hasScopeBase(scopes, 'domains:folders:manage') ||
      (hasScopeBase(scopes, 'domains:view') &&
        typeof event?.action === 'string' &&
        [
          'folder_created',
          'folder_updated',
          'folder_deleted',
          'folders_reordered',
          'resources_moved',
          'resources_reordered',
        ].includes(event.action))
    );
  }
  if (channel === 'hosting.snapshot.changed' || channel === 'hosting.snapshot.folder.changed')
    return hasHostingSnapshotEventAccess(scopes, payload);
  if (channel === 'integration.connector.changed') return hasIntegrationConnectorEventAccess(scopes, payload);
  if (channel === AVAILABILITY_SET_CHANNEL) return hasAvailabilitySetEventAccess(scopes, payload);
  if (channel === 'docker.availability.changed' || channel === 'docker.availability.operation.changed')
    return hasAvailabilityEventAccess(scopes, payload);
  const resourceChannelUserId = userResourceChannelUserId(channel);
  if (resourceChannelUserId) return resourceChannelUserId === userId;
  if (channel === 'system.update.changed') return true;
  if (channel === 'system.license.changed') return true;
  if (channel === 'system.config.changed') return true;
  if (channel === INFERENCE_USAGE_CHANGED_CHANNEL) {
    const event = payload as Partial<InferenceUsageChangedEvent> | undefined;
    if (hasScope(scopes, 'inference:usage:view') || hasScope(scopes, 'inference:limits:manage')) return true;
    return event?.targetUserId === null || event?.targetUserId === userId;
  }
  if (channel === INFERENCE_CATALOG_CHANGED_CHANNEL) return hasChannelAccess(scopes, channel);
  if (channel === 'docker.snapshot.changed') {
    const event = payload as { nodeId?: string; kind?: string } | undefined;
    if (!event?.nodeId || !event.kind) return false;
    const scope =
      event.kind === 'containers' || event.kind === 'container-detail'
        ? 'docker:containers:view'
        : event.kind === 'images'
          ? 'docker:images:view'
          : event.kind === 'volumes' || event.kind === 'volume-detail'
            ? 'docker:volumes:view'
            : event.kind === 'networks'
              ? 'docker:networks:view'
              : null;
    if (!scope) return false;
    if (hasScope(scopes, scope) || hasScope(scopes, `${scope}:${event.nodeId}`)) return true;
    return dockerScopedNodeIds(scopes, [scope]).includes(event.nodeId);
  }
  if (channel === 'docker.folder.changed') {
    if (
      hasScope(scopes, 'docker:containers:view') ||
      hasScope(scopes, 'docker:images:view') ||
      hasScope(scopes, 'docker:volumes:view') ||
      hasScope(scopes, 'docker:networks:view') ||
      hasScope(scopes, 'docker:compose:view') ||
      // Layout events carry only the action, folder id and node ids; a folder-limited manager refetches its tree.
      hasScopeBase(scopes, 'docker:folders:manage')
    ) {
      return true;
    }
    const nodeIds = (payload as { nodeIds?: string[] } | undefined)?.nodeIds;
    const childScopedNodeIds = new Set(
      dockerScopedNodeIds(scopes, [
        'docker:containers:view',
        'docker:images:view',
        'docker:volumes:view',
        'docker:networks:view',
      ])
    );
    return (
      Array.isArray(nodeIds) &&
      nodeIds.some(
        (nodeId) =>
          hasScope(scopes, `docker:containers:view:${nodeId}`) ||
          hasScope(scopes, `docker:images:view:${nodeId}`) ||
          hasScope(scopes, `docker:volumes:view:${nodeId}`) ||
          hasScope(scopes, `docker:networks:view:${nodeId}`) ||
          hasScope(scopes, `docker:compose:view:${nodeId}`) ||
          childScopedNodeIds.has(nodeId)
      )
    );
  }
  if (channel.startsWith('docker.webhook')) {
    return hasDockerEventAccess(scopes, 'docker:containers:webhooks', payload);
  }
  if (channel.startsWith('docker.build')) {
    const event = payload as { targetKind?: string; scopeResourceId?: string } | undefined;
    if (event?.targetKind === 'pages_project') {
      return (
        !!event.scopeResourceId &&
        (hasScope(scopes, 'pages:view') || hasScope(scopes, `pages:view:${event.scopeResourceId}`))
      );
    }
    return hasDockerEventAccess(
      scopes,
      event?.targetKind === 'compose_project' ? 'docker:compose:view' : 'docker:containers:view',
      payload
    );
  }
  if (channel.startsWith('docker.deployment') || channel.startsWith('docker.health')) {
    return hasDockerEventAccess(scopes, 'docker:containers:view', payload);
  }
  if (channel.startsWith('docker.task')) {
    return hasScope(scopes, 'docker:tasks');
  }
  if (channel.startsWith('docker.compose')) {
    return hasDockerEventAccess(scopes, 'docker:compose:view', payload);
  }
  if (channel === 'docker.migration.changed') {
    const event = payload as { sourceNodeId?: string; targetNodeId?: string; scopeResourceId?: string } | undefined;
    if (!event?.sourceNodeId || !event.targetNodeId || !event.scopeResourceId) return false;
    return [event.sourceNodeId, event.targetNodeId].some((nodeId) =>
      hasDockerResourceScope(scopes, 'docker:containers:view', nodeId, event.scopeResourceId!)
    );
  }
  if (channel === 'docker.runtime.changed') {
    const nodeId = (payload as { nodeId?: string } | undefined)?.nodeId;
    return (
      hasScope(scopes, 'nodes:details') ||
      !!(nodeId && (hasScope(scopes, `nodes:details:${nodeId}`) || hasDockerNodeRouteAccess(scopes, nodeId)))
    );
  }
  if (channel.startsWith('docker.container')) {
    return hasDockerEventAccess(scopes, 'docker:containers:view', payload);
  }
  if (channel === 'docker.file.changed') {
    return hasDockerEventAccess(scopes, 'docker:containers:files:read', payload);
  }
  if (channel === 'docker.volume.file.changed') {
    const event = payload as { nodeId?: string; volumeName?: string } | undefined;
    return (
      !!event?.nodeId &&
      !!event.volumeName &&
      hasDockerResourceScope(scopes, 'docker:volumes:files:read', event.nodeId, event.volumeName)
    );
  }
  if (channel === 'node.file.changed') {
    const nodeId = (payload as { nodeId?: string } | undefined)?.nodeId;
    return hasScope(scopes, 'nodes:files:read') || !!(nodeId && hasScope(scopes, `nodes:files:read:${nodeId}`));
  }
  if (channel === 'docker.image-cleanup.changed') {
    return hasDockerEventAccess(scopes, 'docker:containers:view', payload);
  }
  if (channel.startsWith('docker.image')) {
    const event = payload as { nodeId?: string; ref?: string; action?: string } | undefined;
    if (!event?.nodeId) return false;
    if (hasScope(scopes, 'docker:images:view') || hasScope(scopes, `docker:images:view:${event.nodeId}`)) return true;
    return (
      !!event.ref &&
      event.ref !== '*' &&
      event.action !== 'pulled' &&
      hasDockerResourceScope(scopes, 'docker:images:view', event.nodeId, event.ref)
    );
  }
  if (channel.startsWith('docker.volume')) {
    const event = payload as { nodeId?: string; name?: string } | undefined;
    return (
      !!event?.nodeId && !!event.name && hasDockerResourceScope(scopes, 'docker:volumes:view', event.nodeId, event.name)
    );
  }
  if (channel.startsWith('docker.network')) {
    const nodeId = (payload as { nodeId?: string } | undefined)?.nodeId;
    return hasScope(scopes, 'docker:networks:view') || !!(nodeId && hasScope(scopes, `docker:networks:view:${nodeId}`));
  }
  if (channel === 'database.folder.changed') {
    return hasScopeBase(scopes, 'databases:view') || hasScopeBase(scopes, 'databases:folders:manage');
  }
  if (channel.startsWith('database.')) {
    const databaseId = (payload as { id?: string } | undefined)?.id;
    return (
      DATABASE_CHANNEL_SCOPE_BASES.some((base) => hasScope(scopes, base)) ||
      !!(databaseId && DATABASE_CHANNEL_SCOPE_BASES.some((base) => hasScope(scopes, `${base}:${databaseId}`)))
    );
  }
  if (channel === 'pages.profile.changed') {
    return hasScope(scopes, 'pages:settings:view');
  }
  if (channel === 'pages.folder.changed') {
    // Folder layout events carry only an action and a folder id, never project data, and the client
    // refetches the folder tree (filtered server-side). Folder-only and create-only users need them too.
    return (
      hasScopeBase(scopes, 'pages:folders:manage') ||
      hasScopeBase(scopes, 'pages:view') ||
      hasScopeBase(scopes, 'pages:create')
    );
  }
  if (channel.startsWith('pages.')) {
    const event = payload as { scopeResourceId?: string; projectId?: string } | undefined;
    const projectId = event?.scopeResourceId ?? event?.projectId;
    if (!projectId) {
      return channel === 'pages.migration.changed' && hasScope(scopes, 'pages:settings:view');
    }
    return hasScope(scopes, 'pages:view') || hasScope(scopes, `pages:view:${projectId}`);
  }
  if (channel === 'notification.alert-rule.changed' || channel.startsWith('alert.')) {
    const event = payload as { id?: unknown; ruleId?: unknown } | undefined;
    const ruleId = channel.startsWith('alert.') ? event?.ruleId : event?.id;
    return (
      hasScope(scopes, 'notifications:alerts:view') ||
      (typeof ruleId === 'string' && hasScope(scopes, `notifications:alerts:view:${ruleId}`))
    );
  }
  if (channel === 'notification.webhook.changed') {
    const webhookId = (payload as { id?: unknown } | undefined)?.id;
    return (
      hasScope(scopes, 'notifications:webhooks:view') ||
      (typeof webhookId === 'string' && hasScope(scopes, `notifications:webhooks:view:${webhookId}`))
    );
  }
  if (channel === 'logging.logs.ingested') {
    const environmentId = (payload as { environmentId?: string } | undefined)?.environmentId;
    return hasScope(scopes, 'logs:read') || !!(environmentId && hasScope(scopes, `logs:read:${environmentId}`));
  }
  if (channel === 'logging.environment.changed') {
    const environmentId = (payload as { id?: string } | undefined)?.id;
    return (
      hasScope(scopes, 'logs:environments:view') ||
      !!(environmentId && hasScope(scopes, `logs:environments:view:${environmentId}`)) ||
      (!environmentId && hasScopeBase(scopes, 'logs:environments:folders:manage'))
    );
  }
  if (channel === 'logging.schema.changed') {
    const schemaId = (payload as { id?: string } | undefined)?.id;
    return (
      hasScope(scopes, 'logs:schemas:view') ||
      !!(schemaId && hasScope(scopes, `logs:schemas:view:${schemaId}`)) ||
      (!schemaId && hasScopeBase(scopes, 'logs:schemas:folders:manage'))
    );
  }
  if (channel === 'logging.token.changed') {
    const environmentId = (payload as { environmentId?: string } | undefined)?.environmentId;
    return (
      hasScope(scopes, 'logs:tokens:view') || !!(environmentId && hasScope(scopes, `logs:tokens:view:${environmentId}`))
    );
  }
  if (channel.startsWith('proxy.host')) {
    const hostId = (payload as { id?: string } | undefined)?.id;
    return (
      hasScope(scopes, 'proxy:view') ||
      !!(hostId && hasScope(scopes, `proxy:view:${hostId}`)) ||
      (hasScopeBase(scopes, 'proxy:view') && !hostId && isProxyFolderLayoutPayload(payload)) ||
      (hasScopeBase(scopes, 'proxy:folders:manage') && !hostId && isProxyFolderLayoutPayload(payload))
    );
  }
  if (channel.startsWith('ssl.cert')) {
    const certId = (payload as { id?: string } | undefined)?.id;
    return hasScope(scopes, 'ssl:cert:view') || !!(certId && hasScope(scopes, `ssl:cert:view:${certId}`));
  }
  if (channel === 'cert.changed') {
    const certId = (payload as { id?: string } | undefined)?.id;
    return hasScope(scopes, 'pki:cert:view') || !!(certId && hasScope(scopes, `pki:cert:view:${certId}`));
  }
  if (channel === 'ca.changed') {
    const caId = (payload as { id?: string } | undefined)?.id;
    return hasScope(scopes, 'pki:ca:view') || !!(caId && hasScope(scopes, `pki:ca:view:${caId}`));
  }
  if (channel === 'access-list.changed') {
    const aclId = (payload as { id?: string } | undefined)?.id;
    return hasScope(scopes, 'acl:view') || !!(aclId && hasScope(scopes, `acl:view:${aclId}`));
  }
  if (channel === 'node.slug.changed') {
    const nodeId = (payload as { id?: string } | undefined)?.id;
    return !!nodeId && (hasScope(scopes, `nodes:details:${nodeId}`) || hasDockerNodeRouteAccess(scopes, nodeId));
  }
  if (channel === 'node.changed') {
    const nodeId = (payload as { id?: string } | undefined)?.id;
    return (
      hasScope(scopes, 'nodes:details') ||
      !!(nodeId && (hasScope(scopes, `nodes:details:${nodeId}`) || hasDockerNodeRouteAccess(scopes, nodeId)))
    );
  }
  if (channel === 'node.folder.changed') {
    return hasScope(scopes, 'nodes:details') || hasScopeBase(scopes, 'nodes:folders:manage');
  }
  if (channel === 'user.changed') {
    const userId = (payload as { id?: string } | undefined)?.id;
    return (
      hasScope(scopes, 'admin:users') ||
      !!(userId && hasScope(scopes, `admin:users:${userId}`)) ||
      (!userId && hasScopeBase(scopes, 'admin:users:folders:manage'))
    );
  }
  if (channel === 'group.changed') {
    const groupId = (payload as { id?: string } | undefined)?.id;
    return (
      hasScope(scopes, 'admin:groups') ||
      !!(groupId && hasScope(scopes, `admin:groups:${groupId}`)) ||
      (!groupId && hasScopeBase(scopes, 'admin:groups:folders:manage'))
    );
  }
  if (channel === 'nginx.template.changed') {
    const templateId = (payload as { id?: string } | undefined)?.id;
    return (
      hasScope(scopes, 'proxy:templates:view') ||
      !!(templateId && hasScope(scopes, `proxy:templates:view:${templateId}`))
    );
  }
  // Anything not handled above is denied unless it is one of the channels that reach every
  // subscriber who passed hasChannelAccess; a new channel is never delivered by default.
  return isDefaultDeliverChannel(channel);
}

async function authenticate(token: string): Promise<{ user: User; scopes: string[] } | null> {
  const result = await resolveWebSocketCredentialContext({ type: 'session', value: token });
  return result ? { user: result.user, scopes: result.scopes } : null;
}

function closeUnauthenticated(ws: WSContext, state: ConnState, message = 'unauthenticated') {
  send(ws, { type: 'error', message });
  clearAll(state);
  try {
    ws.close(4001, message);
  } catch {
    /* ignore */
  }
}

function closePolicyViolation(ws: WSContext, state: ConnState, message: string) {
  send(ws, { type: 'error', message });
  state.pendingMessages.length = 0;
  state.preAuthMessageCount = 0;
  state.pendingMessageBytes = 0;
  clearAll(state);
  try {
    ws.close(4008, message);
  } catch {
    /* ignore */
  }
}

function clearAll(state: ConnState) {
  state.authenticated = false;
  state.sessionToken = undefined;
  for (const unsub of state.subs.values()) {
    try {
      unsub();
    } catch {
      /* ignore */
    }
  }
  state.subs.clear();
  if (state.permsUnsub) {
    try {
      state.permsUnsub();
    } catch {
      /* ignore */
    }
    state.permsUnsub = null;
  }
  if (state.keepalive) {
    clearInterval(state.keepalive);
    state.keepalive = null;
  }
}

function subscribePerUser(ws: WSContext, state: ConnState) {
  if (!state.user) return;
  const eventBus = container.resolve(EventBusService);
  const channel = `permissions.changed.${state.user.id}`;
  // Side-effect listener: refresh server-side scopes and drop subscriptions
  // the user has lost access to. The actual delivery to the client goes
  // through the client's explicit subscribe path so we don't double-emit.
  state.permsUnsub = eventBus.subscribe(channel, async (_payload) => {
    try {
      const fresh = state.sessionToken ? await authenticate(state.sessionToken) : null;
      if (!fresh || fresh.user.isBlocked) {
        closeUnauthenticated(ws, state);
        return;
      }
      if (fresh) {
        state.user = fresh.user;
        state.scopes = fresh.scopes;
        markScopesResolved(state);
      }
    } catch {
      closeUnauthenticated(ws, state);
      return;
    }
    for (const ch of [...state.subs.keys()]) {
      const required = requiredScopeFor(ch);
      if (required && !hasChannelAccess(state.scopes, ch)) {
        const unsub = state.subs.get(ch);
        unsub?.();
        state.subs.delete(ch);
      }
    }
    send(ws, { type: 'permissions', scopes: state.scopes });
  });
}

/**
 * How long a connection with folder, node, provider, or account grants trusts its expanded scopes
 * before re-resolving them. Re-resolving costs 2 + E queries (E per expanded grant family), so doing
 * it for every event let a busy Opfield saturate the delivery queue.
 */
const DYNAMIC_SCOPES_TTL_MS = 5_000;

/** Events that can change which resources a folder or node grant covers: creations, moves, and folder edits. */
function changesGrantMembership(channel: string, payload: unknown): boolean {
  if (channel.includes('folder')) return true;
  const action = (payload as { action?: unknown } | null | undefined)?.action;
  return typeof action === 'string' && /creat|move|restor|import|adopt|migrat|folder/i.test(action);
}

function markScopesResolved(state: ConnState) {
  state.scopesFreshUntil = Date.now() + DYNAMIC_SCOPES_TTL_MS;
}

/** Re-evaluate dynamic membership before delivery: moves and new resources do not
 * change the stored grant, but do change the concrete IDs it authorizes. Expanded scopes are
 * cached for a few seconds and refreshed early whenever an event can change membership. */
function deliverEvent(ws: WSContext, state: ConnState, channel: string, payload: unknown) {
  const deliver = () => {
    if (
      !state.authenticated ||
      !state.subs.has(channel) ||
      !canReceiveChannelPayload(state.scopes, channel, payload, state.user?.id)
    )
      return;
    send(ws, {
      type: 'event',
      channel,
      payload: channel === 'hosting.snapshot.changed' ? projectHostingSnapshotEvent(state.scopes, payload) : payload,
    });
  };
  const dynamic = state.scopes.some((scope) => /:(folder|node|provider|account)\//.test(scope));
  if (!dynamic || channel.startsWith('permissions.changed.')) {
    deliver();
    return;
  }
  if (changesGrantMembership(channel, payload)) state.scopesFreshUntil = 0;
  // Cached scopes are still fresh and nothing is waiting ahead of this event: deliver in order now.
  if (!state.queuedDeliveries && Date.now() < (state.scopesFreshUntil ?? 0)) {
    deliver();
    return;
  }
  if ((state.queuedDeliveries ?? 0) >= MAX_PENDING_MESSAGES) {
    closePolicyViolation(ws, state, 'event authorization queue overflow');
    return;
  }
  state.queuedDeliveries = (state.queuedDeliveries ?? 0) + 1;
  state.deliveryQueue = (state.deliveryQueue ?? Promise.resolve())
    .then(async () => {
      if (!state.authenticated || !state.subs.has(channel)) return;
      // Queued events share one refresh: only the first re-resolves until the cache expires again.
      if (Date.now() >= (state.scopesFreshUntil ?? 0)) {
        const fresh = state.sessionToken ? await authenticate(state.sessionToken) : null;
        if (!fresh) {
          closeUnauthenticated(ws, state);
          return;
        }
        const changed = JSON.stringify(state.scopes) !== JSON.stringify(fresh.scopes);
        state.user = fresh.user;
        state.scopes = fresh.scopes;
        markScopesResolved(state);
        if (changed) send(ws, { type: 'permissions', scopes: state.scopes });
      }
      deliver();
    })
    .catch(() => closeUnauthenticated(ws, state))
    .finally(() => {
      state.queuedDeliveries = Math.max(0, (state.queuedDeliveries ?? 1) - 1);
    });
}

export function createEventsWSHandlers() {
  return {
    onOpen(_event: Event, ws: WSContext) {
      const state: ConnState = {
        user: null,
        scopes: [],
        authenticated: false,
        subs: new Map(),
        keepalive: null,
        permsUnsub: null,
        pendingMessages: [],
        preAuthMessageCount: 0,
        pendingMessageBytes: 0,
      };
      states.set(ws, state);
      state.keepalive = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: 'pong' }));
        } catch {
          if (state.keepalive) clearInterval(state.keepalive);
        }
      }, KEEPALIVE_INTERVAL_MS);
    },

    async onMessage(event: MessageEvent, ws: WSContext) {
      const state = states.get(ws);
      if (!state) return;

      let msg: ClientMsg;
      const rawText = typeof event.data === 'string' ? event.data : String(event.data);
      const messageBytes = Buffer.byteLength(rawText, 'utf8');
      if (messageBytes > MAX_EVENT_MESSAGE_BYTES) {
        closePolicyViolation(ws, state, 'message too large');
        return;
      }

      if (!state.authenticated) {
        if (
          state.preAuthMessageCount >= MAX_PENDING_MESSAGES ||
          state.pendingMessageBytes + messageBytes > MAX_PENDING_MESSAGE_BYTES
        ) {
          closePolicyViolation(ws, state, 'pre-auth message limit exceeded');
          return;
        }
        state.preAuthMessageCount += 1;
        state.pendingMessageBytes += messageBytes;
      }

      try {
        const raw = JSON.parse(rawText);
        if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') {
          send(ws, { type: 'error', message: 'invalid message' });
          return;
        }
        msg = raw as ClientMsg;
      } catch {
        send(ws, { type: 'error', message: 'invalid json' });
        return;
      }

      if (msg.type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }

      // Queue messages until authentication completes (auth is async).
      if (!state.authenticated) {
        state.pendingMessages.push(msg);
        return;
      }

      processMessage(ws, state, msg);
    },

    onClose(_event: Event, ws: WSContext) {
      const state = states.get(ws);
      if (state) {
        clearAll(state);
      }
    },

    onError(_event: Event, ws: WSContext) {
      const state = states.get(ws);
      if (state) {
        clearAll(state);
      }
    },
  };
}

function processMessage(ws: WSContext, state: ConnState, msg: ClientMsg) {
  const eventBus = container.resolve(EventBusService);

  if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
    const accepted: string[] = [];
    const rejected: string[] = [];
    const retained: Array<{ channel: string; payload: unknown }> = [];
    for (const ch of msg.channels) {
      if (typeof ch !== 'string' || !ch) continue;
      if (state.subs.has(ch)) {
        accepted.push(ch);
        continue;
      }
      if (!hasChannelAccess(state.scopes, ch)) {
        rejected.push(ch);
        continue;
      }
      // permissions.changed.<userId>: only the user's own is allowed
      if (ch.startsWith('permissions.changed.')) {
        const targetUserId = ch.slice('permissions.changed.'.length);
        if (targetUserId !== state.user?.id) {
          rejected.push(ch);
          continue;
        }
      }
      if (ch.startsWith(MFA_REQUIRED_CHANNEL_PREFIX)) {
        const targetUserId = ch.slice(MFA_REQUIRED_CHANNEL_PREFIX.length);
        if (targetUserId !== state.user?.id) {
          rejected.push(ch);
          continue;
        }
      }
      if (ch.startsWith(TOOL_STORE_INVALIDATION_CHANNEL_PREFIX)) {
        const targetUserId = ch.slice(TOOL_STORE_INVALIDATION_CHANNEL_PREFIX.length);
        if (targetUserId !== state.user?.id) {
          rejected.push(ch);
          continue;
        }
      }
      const resourceChannelUserId = userResourceChannelUserId(ch);
      if (resourceChannelUserId && resourceChannelUserId !== state.user?.id) {
        rejected.push(ch);
        continue;
      }
      const unsub = eventBus.subscribe(ch, (payload) => deliverEvent(ws, state, ch, payload));
      state.subs.set(ch, unsub);
      accepted.push(ch);
      const retainedPayload = eventBus.getRetained(ch);
      if (retainedPayload !== undefined) retained.push({ channel: ch, payload: retainedPayload });
    }
    send(ws, { type: 'subscribed', channels: accepted, rejected });
    for (const event of retained) {
      deliverEvent(ws, state, event.channel, event.payload);
    }
    return;
  }

  if (msg.type === 'unsubscribe' && Array.isArray(msg.channels)) {
    for (const ch of msg.channels) {
      const unsub = state.subs.get(ch);
      if (unsub) {
        unsub();
        state.subs.delete(ch);
      }
    }
  }
}

/**
 * Authenticate after onOpen — same pattern as the AI WS endpoint.
 */
export async function authenticateEventsConnection(ws: WSContext, token: string): Promise<void> {
  const state = states.get(ws);
  if (!state) return;
  const authResult = await authenticate(token);
  if (!authResult) {
    closeUnauthenticated(ws, state);
    return;
  }
  state.user = authResult.user;
  state.sessionToken = token;
  state.scopes = authResult.scopes;
  markScopesResolved(state);
  state.authenticated = true;
  subscribePerUser(ws, state);
  send(ws, { type: 'permissions', scopes: state.scopes });
  logger.debug('client authenticated', { userId: state.user.id });
  // Drain anything the client sent before auth completed
  const pending = state.pendingMessages.splice(0);
  state.preAuthMessageCount = 0;
  state.pendingMessageBytes = 0;
  for (const msg of pending) {
    processMessage(ws, state, msg);
  }
}
