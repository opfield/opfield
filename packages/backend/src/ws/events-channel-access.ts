import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { TOOL_STORE_INVALIDATION_CHANNEL_PREFIX } from '@/modules/ai/ai-tool-store-invalidation.js';
import { canReachApps } from '@/modules/apps/app-access.js';
import { MFA_REQUIRED_CHANNEL_PREFIX } from '@/modules/auth/mfa-events.js';
import { userResourceChannelUserId } from '@/modules/auth/user-resource-events.js';
import { dockerScopedNodeIds } from '@/modules/docker/docker-access-resource.service.js';
import { hasAnyDockerNodeRouteAccess } from '@/modules/docker/docker-route-resolvers.js';
import { canViewHostingFinance } from '@/modules/hosting/hosting-permissions.js';
import { INFERENCE_USAGE_CHANGED_CHANNEL } from '@/modules/inference/accounting/inference-usage-events.js';
import { INFERENCE_CATALOG_CHANGED_CHANNEL } from '@/modules/inference/inference-catalog-events.service.js';
import { gitConnectorVisibility } from '@/modules/integrations/integration-permissions.js';
import { hasLoggingHealthAccess } from '@/modules/logging/logging-permissions.js';

/** Lease transitions of database and storage availability sets ({setId, ownerKind, ownerId, action}). */
export const AVAILABILITY_SET_CHANNEL = 'availability.set.changed';

/**
 * An availability set event carries only ids. It goes to viewers of every database (or every storage) of its kind;
 * a viewer granted single resources learns of the change from the resource's own events and its page's refresh.
 */
export function hasAvailabilitySetEventAccess(scopes: string[], payload: unknown): boolean {
  const kind = (payload as { ownerKind?: unknown } | null | undefined)?.ownerKind;
  if (kind === 'managed_database') return hasScope(scopes, 'databases:view');
  if (kind === 'managed_storage') return hasScope(scopes, 'storage:view');
  return false;
}

export const DATABASE_CHANNEL_SCOPE_BASES = [
  'databases:view',
  'databases:edit',
  'databases:query:read',
  'databases:query:write',
  'databases:query:admin',
] as const;

/**
 * Determine the scope required to subscribe to a channel.
 * Channels without an explicit mapping are denied by default.
 */
export function requiredScopeFor(channel: string): string | null {
  if (channel.startsWith('permissions.changed.')) return null;
  if (channel.startsWith(MFA_REQUIRED_CHANNEL_PREFIX)) return null;
  if (channel.startsWith(TOOL_STORE_INVALIDATION_CHANNEL_PREFIX)) return null;
  if (userResourceChannelUserId(channel)) return null;
  if (channel === 'read-model.refreshed') return null;
  if (channel === 'hosting.snapshot.changed' || channel === 'hosting.snapshot.folder.changed')
    return 'hosting:snapshots:view';
  if (channel === 'domain.changed') return 'domains:view';
  if (channel === 'logging.logs.ingested') return 'logs:read';
  if (channel === 'logging.health.changed') return 'logs:environments:view';
  if (channel === 'logging.environment.changed') return 'logs:environments:view';
  if (channel === 'logging.schema.changed') return 'logs:schemas:view';
  if (channel === 'logging.token.changed') return 'logs:tokens:view';
  if (channel === 'system.update.changed') return 'admin:update';
  if (channel === 'inference.core.changed') return 'inference:providers:view';
  if (channel === 'system.license.changed') return null;
  if (channel === 'system.config.changed') return null;
  if (channel === 'status-page.changed') return 'status-page:view';
  if (channel === 'pki.template.changed' || channel === 'pki.template.folder.changed') return 'pki:templates:view';
  if (channel === 'nginx.template.changed' || channel === 'nginx.template.folder.changed')
    return 'proxy:templates:view';
  if (channel === 'docker.folder.changed') return 'docker:containers:view';
  if (channel === 'docker.image-cleanup.changed') return 'docker:containers:view';
  if (channel === 'docker.registry.changed') return 'docker:registries:view';
  if (channel.startsWith('docker.build')) return 'docker:containers:view';
  if (channel === 'docker.file.changed') return 'docker:containers:files:read';
  if (channel === 'docker.volume.file.changed') return 'docker:volumes:files:read';
  if (channel === 'docker.snapshot.changed') return 'docker:containers:view';
  if (channel === 'docker.migration.changed') return 'docker:containers:view';
  if (channel === 'docker.runtime.changed') return 'nodes:details';
  if (channel.startsWith('docker.compose')) return 'docker:compose:view';
  if (channel === 'node.file.changed') return 'nodes:files:read';
  if (channel.startsWith('docker.container')) return 'docker:containers:view';
  if (channel.startsWith('docker.image')) return 'docker:images:view';
  if (channel.startsWith('docker.volume')) return 'docker:volumes:view';
  if (channel.startsWith('docker.network')) return 'docker:networks:view';
  if (channel.startsWith('docker.registry')) return 'docker:registries:view';
  if (channel.startsWith('docker.task')) return 'docker:tasks';
  if (channel.startsWith('docker.webhook')) return 'docker:containers:webhooks';
  if (channel.startsWith('docker.')) return 'docker:containers:view';
  if (channel === 'database.folder.changed') return 'databases:view';
  if (channel.startsWith('database.')) return 'databases:view';
  if (channel === AVAILABILITY_SET_CHANNEL) return 'databases:view';
  if (channel === 'pages.profile.changed') return 'pages:settings:view';
  if (channel === 'pages.folder.changed') return 'pages:view';
  if (channel.startsWith('pages.')) return 'pages:view';
  if (channel.startsWith('proxy.host')) return 'proxy:view';
  if (channel.startsWith('ssl.cert')) return 'ssl:cert:view';
  if (channel === 'cert.changed' || channel === 'cert.folder.changed') return 'pki:cert:view';
  if (channel === 'ca.changed' || channel === 'ca.folder.changed') return 'pki:ca:view';
  if (channel === 'access-list.changed' || channel === 'access-list.folder.changed') return 'acl:view';
  if (channel === 'node.slug.changed') return 'nodes:details';
  if (channel === 'node.changed' || channel === 'node.folder.changed') return 'nodes:details';
  if (channel === 'ingress_group.changed') return 'ingress:groups:view';
  if (channel === 'apps.folder.changed') return 'apps:view';
  if (channel === 'apps') return 'apps:view';
  if (channel === 'user.changed') return 'admin:users';
  if (channel === 'audit.changed') return 'admin:audit';
  if (channel === 'siem.destination.changed' || channel === 'siem.delivery.changed') return 'audit:siem:view';
  if (channel === 'group.changed') return 'admin:groups';
  if (channel === 'notification.alert-rule.changed' || channel === 'notification.alert-rule.folder.changed')
    return 'notifications:alerts:view';
  if (channel === 'notification.webhook.changed' || channel === 'notification.webhook.folder.changed')
    return 'notifications:webhooks:view';
  if (channel === INFERENCE_CATALOG_CHANGED_CHANNEL) return 'feat:ai:use';
  if (channel === 'integration.connector.changed') return 'integrations:gitlab:view';
  if (channel === INFERENCE_USAGE_CHANGED_CHANNEL) return 'feat:ai:use';
  if (channel.startsWith('alert.')) return 'notifications:alerts:view';
  // permissions.changed.<userId> is filtered separately (own user only)
  return null;
}

/**
 * Channels whose events reach every connection that passed `hasChannelAccess`, because they carry only ids,
 * actions or nothing at all (layout refetch pings, per-user channels already pinned to the subscriber at
 * subscribe time, system status). Keep their payloads id-only; a channel with data needs its own branch in
 * canReceiveChannelPayload (events.ws.ts) instead of an entry here.
 */
const DEFAULT_DELIVER_CHANNELS: ReadonlySet<string> = new Set([
  'read-model.refreshed',
  'system.relay.health.changed',
  'logging.health.changed',
  'inference.core.changed',
  'status-page.changed',
  'pki.template.changed',
  'pki.template.folder.changed',
  'nginx.template.folder.changed',
  'cert.folder.changed',
  'ca.folder.changed',
  'access-list.folder.changed',
  'ingress_group.changed',
  'apps.folder.changed',
  'apps',
  'audit.changed',
  'siem.destination.changed',
  'siem.delivery.changed',
  'notification.alert-rule.folder.changed',
  'notification.webhook.folder.changed',
]);

const DEFAULT_DELIVER_PREFIXES = [
  'permissions.changed.',
  MFA_REQUIRED_CHANNEL_PREFIX,
  TOOL_STORE_INVALIDATION_CHANNEL_PREFIX,
  'docker.registry',
] as const;

export function isDefaultDeliverChannel(channel: string): boolean {
  return DEFAULT_DELIVER_CHANNELS.has(channel) || DEFAULT_DELIVER_PREFIXES.some((prefix) => channel.startsWith(prefix));
}

/**
 * Docker Availability policy and operation events (`docker.availability.changed`,
 * `docker.availability.operation.changed`) carry a policy id, an operation id and an action or phase, plus the node
 * when the change is on one node. They name no workload, so they go to callers who may view containers or Compose
 * projects (a node-limited viewer only for its nodes); the client refetches the policy through the filtered routes.
 */
export function hasAvailabilityEventAccess(scopes: string[], payload: unknown): boolean {
  const nodeId = (payload as { nodeId?: unknown } | null | undefined)?.nodeId;
  const bases = ['docker:containers:view', 'docker:compose:view'];
  if (bases.some((base) => hasScope(scopes, base))) return true;
  if (typeof nodeId === 'string') {
    return (
      bases.some((base) => hasScope(scopes, `${base}:${nodeId}`)) || dockerScopedNodeIds(scopes, bases).includes(nodeId)
    );
  }
  return bases.some((base) => hasScopeBase(scopes, base));
}

/**
 * `integration.connector.changed` carries a connector's ID and name: deliver it only to callers who may see
 * that connector (Git connectors through any grant on them, the others through their provider scopes).
 */
export function hasIntegrationConnectorEventAccess(scopes: string[], payload: unknown): boolean {
  const event = payload as { id?: unknown; provider?: unknown } | null | undefined;
  if (typeof event?.id !== 'string' || typeof event.provider !== 'string') return false;
  switch (event.provider) {
    case 'gitlab':
    case 'github':
    case 'git':
      return gitConnectorVisibility(scopes, event.provider)(event.id).visible;
    case 'cloudflare':
      return hasScope(scopes, 'integrations:cloudflare:view') || hasScope(scopes, 'integrations:cloudflare:manage');
    case 'ssh':
      return hasScope(scopes, 'integrations:ssh:view') || hasScope(scopes, 'integrations:ssh:manage');
    case 'hosting':
      return hasScope(scopes, `integrations:hosting:view:${event.id}`);
    default:
      return false;
  }
}

export function hasChannelAccess(scopes: string[], channel: string): boolean {
  if (channel === 'hosting.snapshot.changed' || channel === 'hosting.snapshot.folder.changed')
    return (
      hasScopeBase(scopes, 'hosting:snapshots:view') &&
      hasScopeBase(scopes, 'hosting:resources:view') &&
      hasScopeBase(scopes, 'nodes:details') &&
      hasScopeBase(scopes, 'integrations:hosting:view')
    );
  if (channel.startsWith('permissions.changed.')) return true;
  // Availability sets of databases and storage: subscribing needs a view grant of either kind (see events.ws.ts).
  if (channel === AVAILABILITY_SET_CHANNEL)
    return hasScopeBase(scopes, 'databases:view') || hasScopeBase(scopes, 'storage:view');
  if (channel.startsWith(MFA_REQUIRED_CHANNEL_PREFIX)) return true;
  if (channel.startsWith(TOOL_STORE_INVALIDATION_CHANNEL_PREFIX)) return true;
  if (userResourceChannelUserId(channel)) return true;
  if (channel === 'read-model.refreshed') return true;
  if (channel === 'system.update.changed') return true;
  if (channel === 'system.license.changed') return true;
  if (channel === 'system.config.changed') return true;
  if (channel === 'system.relay.health.changed') return true;
  if (channel === 'integration.connector.changed') {
    // Git scopes may be limited to a connector, group/owner or project/repository; any grant counts. Each
    // event is then filtered by hasIntegrationConnectorEventAccess.
    return (
      hasScopeBase(scopes, 'integrations:gitlab:view') ||
      hasScope(scopes, 'integrations:cloudflare:view') ||
      hasScope(scopes, 'integrations:cloudflare:manage') ||
      hasScopeBase(scopes, 'integrations:github:view') ||
      hasScopeBase(scopes, 'integrations:git:view') ||
      hasScope(scopes, 'integrations:ssh:view') ||
      hasScope(scopes, 'integrations:ssh:manage')
    );
  }
  if (channel.startsWith('docker.build')) {
    return (
      hasScopeBase(scopes, 'docker:containers:view') ||
      hasScopeBase(scopes, 'docker:compose:view') ||
      hasScopeBase(scopes, 'pages:view')
    );
  }
  const required = requiredScopeFor(channel);
  if (!required) return false;

  if (channel === 'docker.folder.changed') {
    return (
      hasScopeBase(scopes, 'docker:containers:view') ||
      hasScopeBase(scopes, 'docker:images:view') ||
      hasScopeBase(scopes, 'docker:volumes:view') ||
      hasScopeBase(scopes, 'docker:networks:view') ||
      hasScopeBase(scopes, 'docker:compose:view') ||
      hasScopeBase(scopes, 'docker:folders:manage')
    );
  }
  if (channel === 'docker.snapshot.changed') {
    return (
      hasScopeBase(scopes, 'docker:containers:view') ||
      hasScopeBase(scopes, 'docker:images:view') ||
      hasScopeBase(scopes, 'docker:volumes:view') ||
      hasScopeBase(scopes, 'docker:networks:view')
    );
  }
  if (channel.startsWith('docker.task')) {
    return hasScope(scopes, 'docker:tasks');
  }
  if (channel === 'docker.migration.changed') {
    return hasScopeBase(scopes, 'docker:containers:view');
  }
  if (channel === 'docker.runtime.changed') {
    return hasScopeBase(scopes, 'nodes:details') || hasAnyDockerNodeRouteAccess(scopes);
  }
  if (channel.startsWith('docker.container')) {
    return hasScopeBase(scopes, 'docker:containers:view');
  }
  if (channel === 'docker.file.changed') {
    return hasScopeBase(scopes, 'docker:containers:files:read');
  }
  if (channel === 'docker.image-cleanup.changed') {
    return hasScopeBase(scopes, 'docker:containers:view');
  }
  if (channel.startsWith('docker.image')) {
    return hasScopeBase(scopes, 'docker:images:view');
  }
  if (channel.startsWith('docker.volume')) {
    return hasScopeBase(scopes, 'docker:volumes:view');
  }
  if (channel.startsWith('docker.network')) {
    return hasScopeBase(scopes, 'docker:networks:view');
  }
  if (channel === 'database.folder.changed') {
    return hasScopeBase(scopes, 'databases:view') || hasScopeBase(scopes, 'databases:folders:manage');
  }
  if (channel.startsWith('database.')) {
    return scopes.some((scope) =>
      DATABASE_CHANNEL_SCOPE_BASES.some((base) => scope === base || scope.startsWith(`${base}:`))
    );
  }
  if (channel === 'pages.profile.changed') {
    return hasScope(scopes, 'pages:settings:view');
  }
  if (channel === 'pages.folder.changed') {
    return (
      hasScopeBase(scopes, 'pages:view') ||
      hasScopeBase(scopes, 'pages:create') ||
      hasScopeBase(scopes, 'pages:folders:manage')
    );
  }
  if (channel.startsWith('pages.')) {
    return hasScopeBase(scopes, 'pages:view');
  }
  if (channel === 'domain.changed') {
    return hasScopeBase(scopes, 'domains:view') || hasScopeBase(scopes, 'domains:folders:manage');
  }
  if (channel === 'ssl.cert.folder.changed') {
    return hasScopeBase(scopes, 'ssl:cert:view') || hasScopeBase(scopes, 'ssl:cert:folders:manage');
  }
  if (channel === 'ssl.cert.changed') {
    return hasScopeBase(scopes, 'ssl:cert:view');
  }
  if (channel.startsWith('proxy.host')) {
    return hasScopeBase(scopes, 'proxy:view') || hasScopeBase(scopes, 'proxy:folders:manage');
  }
  if (channel === 'node.folder.changed') {
    return hasScopeBase(scopes, 'nodes:details') || hasScopeBase(scopes, 'nodes:folders:manage');
  }
  if (channel === 'apps.folder.changed') {
    // Only an action and a folder id travel; the folder tree request applies the grants.
    return canReachApps(scopes) || hasScopeBase(scopes, 'apps:folders:manage');
  }
  if (channel === 'apps') {
    // Only {appId, action} travels; the app requests apply the app, environment and member grants.
    return canReachApps(scopes);
  }
  if (channel === 'ingress_group.changed') {
    // Only the group id travels; the list and detail requests apply the folder grants.
    return hasScopeBase(scopes, 'ingress:groups:view');
  }
  if (channel === 'node.file.changed') {
    return hasScopeBase(scopes, 'nodes:files:read');
  }
  if (channel === 'node.slug.changed') {
    return hasScopeBase(scopes, 'nodes:details') || hasAnyDockerNodeRouteAccess(scopes);
  }
  if (channel === 'node.changed') {
    return hasScopeBase(scopes, 'nodes:details') || hasAnyDockerNodeRouteAccess(scopes);
  }
  // Rule, webhook and fired-alert events name one rule or webhook: events.ws.ts delivers each only to callers who may
  // view it (broadly, on the item, or through its folder).
  if (channel === 'notification.alert-rule.changed' || channel.startsWith('alert.')) {
    return hasScopeBase(scopes, 'notifications:alerts:view');
  }
  if (channel === 'notification.webhook.changed') {
    return hasScopeBase(scopes, 'notifications:webhooks:view');
  }
  // Folder layout events carry only the action and folder id; lists apply the grants.
  if (channel === 'access-list.folder.changed') {
    return hasScopeBase(scopes, 'acl:view') || hasScopeBase(scopes, 'acl:folders:manage');
  }
  if (channel === 'notification.alert-rule.folder.changed') {
    return (
      hasScopeBase(scopes, 'notifications:alerts:view') || hasScopeBase(scopes, 'notifications:alerts:folders:manage')
    );
  }
  if (channel === 'notification.webhook.folder.changed') {
    return (
      hasScopeBase(scopes, 'notifications:webhooks:view') ||
      hasScopeBase(scopes, 'notifications:webhooks:folders:manage')
    );
  }
  if (channel === INFERENCE_CATALOG_CHANGED_CHANNEL) {
    return (
      hasScope(scopes, 'ai:workspace:use') ||
      hasScope(scopes, 'feat:ai:use') ||
      hasScope(scopes, 'inference:providers:view') ||
      hasScope(scopes, 'inference:models:manage') ||
      hasScope(scopes, 'inference:limits:manage') ||
      hasScope(scopes, 'feat:ai:configure')
    );
  }
  if (channel === INFERENCE_USAGE_CHANGED_CHANNEL) {
    return (
      hasScope(scopes, 'ai:workspace:use') ||
      hasScope(scopes, 'feat:ai:use') ||
      hasScope(scopes, 'inference:usage:view') ||
      hasScope(scopes, 'inference:limits:manage')
    );
  }
  if (channel === 'logging.health.changed') {
    return hasLoggingHealthAccess(scopes);
  }
  if (channel === 'logging.logs.ingested') {
    return hasScopeBase(scopes, 'logs:read');
  }
  if (channel === 'logging.environment.changed') {
    return hasScopeBase(scopes, 'logs:environments:view') || hasScopeBase(scopes, 'logs:environments:folders:manage');
  }
  if (channel === 'logging.schema.changed') {
    return hasScopeBase(scopes, 'logs:schemas:view') || hasScopeBase(scopes, 'logs:schemas:folders:manage');
  }
  if (channel === 'logging.token.changed') {
    return hasScopeBase(scopes, 'logs:tokens:view');
  }
  if (channel === 'user.changed') {
    return hasScopeBase(scopes, 'admin:users') || hasScopeBase(scopes, 'admin:users:folders:manage');
  }
  if (channel === 'group.changed') {
    return hasScopeBase(scopes, 'admin:groups') || hasScopeBase(scopes, 'admin:groups:folders:manage');
  }
  if (channel === 'ca.changed') {
    return hasScopeBase(scopes, 'pki:ca:view');
  }
  // Folder layout events carry only the action and folder id; lists apply the grants.
  if (channel === 'ca.folder.changed') {
    return hasScopeBase(scopes, 'pki:ca:view') || hasScopeBase(scopes, 'pki:ca:folders:manage');
  }
  if (channel === 'cert.folder.changed') {
    return hasScopeBase(scopes, 'pki:cert:view') || hasScopeBase(scopes, 'pki:cert:folders:manage');
  }
  if (channel === 'pki.template.folder.changed') {
    return hasScope(scopes, 'pki:templates:view') || hasScopeBase(scopes, 'pki:templates:folders:manage');
  }
  if (channel === 'nginx.template.folder.changed') {
    return hasScopeBase(scopes, 'proxy:templates:view') || hasScopeBase(scopes, 'proxy:templates:folders:manage');
  }

  return hasScopeBase(scopes, required);
}

/** Snapshot metadata is scoped to the VM and every daemon bound to that VM. */
export function hasHostingSnapshotEventAccess(scopes: string[], payload: unknown): boolean {
  const event = payload as { resourceId?: unknown; connectorId?: unknown; nodeIds?: unknown } | null;
  if (
    !event ||
    typeof event.resourceId !== 'string' ||
    typeof event.connectorId !== 'string' ||
    !Array.isArray(event.nodeIds) ||
    !event.nodeIds.length
  )
    return false;
  return (
    hasScope(scopes, `hosting:resources:view:${event.resourceId}`) &&
    hasScope(scopes, `integrations:hosting:view:${event.connectorId}`) &&
    hasScope(scopes, `hosting:snapshots:view:${event.resourceId}`) &&
    event.nodeIds.every((id) => typeof id === 'string' && hasScope(scopes, `nodes:details:${id}`))
  );
}

/** Apply finance visibility at delivery time, never mutate the shared EventBus payload. */
export function projectHostingSnapshotEvent(scopes: string[], payload: unknown): unknown {
  const event = payload as { connectorId?: unknown; snapshot?: unknown } | null;
  if (!event?.snapshot || typeof event.snapshot !== 'object') return payload;
  if (typeof event.connectorId === 'string' && canViewHostingFinance(scopes, event.connectorId)) return payload;
  const { monthlyCost: _cost, storageRate: _rate, ...snapshot } = event.snapshot as Record<string, unknown>;
  return { ...event, snapshot };
}
