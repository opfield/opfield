import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope, hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertRoutePlacementOnGroup } from '@/modules/ingress-groups/ingress-group-operations.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { getNginxLogHistory } from '@/modules/monitoring/log-relay.service.js';
import { requestProxyLogHistory } from '@/modules/monitoring/proxy-log-nodes.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { CreateFolderSchema, MoveHostsToFolderSchema } from '@/modules/proxy/folder.schemas.js';
import type { FolderService } from '@/modules/proxy/folder.service.js';
import { redactProxyHostForScopes } from '@/modules/proxy/page-target-visibility.js';
import {
  CreateProxyHostSchema,
  ProxyHostListQuerySchema,
  RouteIngressNodeListQuerySchema,
  UpdateProxyHostSchema,
  ValidateAdvancedConfigSchema,
} from '@/modules/proxy/proxy.schemas.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import { hasProxyDestinationScope } from '@/modules/proxy/proxy-destination-scope.js';
import { ProxyMaintenanceAccessService } from '@/modules/proxy/proxy-maintenance-access.service.js';
import {
  reservedTemplateVariableNames,
  withoutReservedTemplateVariables,
} from '@/modules/proxy/proxy-template-variables.js';
import { redactRawProxyConfigForBrowser } from '@/modules/proxy/raw-visibility.js';
import {
  assertFolderManage,
  assertFolderManageForFolder,
  assertFolderManageForResources,
} from '@/modules/resource-folders/resource-folder-access.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { User } from '@/types.js';
import {
  agentPage,
  agentPageLimit,
  allowedResourceIdsForScopes,
  compactProxyHostForAgent,
  PROXY_HOST_UPDATE_FIELDS,
} from './ai.service-helpers.js';

const logger = createChildLogger('AIProxyTools');

export const PROXY_TOOL_NAMES = new Set([
  'list_routes',
  'get_route',
  'create_route',
  'list_route_ingress_nodes',
  'update_route',
  'set_route_maintenance',
  'delete_route',
  'create_route_folder',
  'move_routes_to_folder',
  'delete_route_folder',
  'manage_route',
]);

/** update_route accepts the shared field list plus the Compose service target that create_route accepts. */
const ROUTE_UPDATE_FIELDS = [
  ...PROXY_HOST_UPDATE_FIELDS,
  'dockerComposeProjectId',
  'dockerComposeServiceName',
  'ingressGroupId',
];

export interface ProxyToolContext {
  proxyService: ProxyService;
  folderService: FolderService;
}

export async function executeProxyTool(
  context: ProxyToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;
  const compact = (host: Record<string, any>) => compactProxyHostForAgent(redactProxyHostForScopes(host, user.scopes));

  switch (toolName) {
    case 'list_routes': {
      const result = await context.proxyService.listProxyHosts(
        ProxyHostListQuerySchema.parse({
          search: a.search,
          type: a.type,
          enabled: a.enabled,
          healthStatus: a.healthStatus,
          nodeId: a.nodeId,
          excludeAppMembers: a.excludeAppMembers,
          appId: a.appId,
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
        }),
        { allowedIds: allowedResourceIdsForScopes(user.scopes, 'proxy:view') }
      );
      return {
        ...result,
        data: result.data.map((host: any) => compact(host)),
      };
    }
    case 'get_route': {
      const [host] = await context.proxyService.withAppField([await context.proxyService.getProxyHost(a.routeId)]);
      return compact(host);
    }
    case 'list_route_ingress_nodes': {
      // Mirrors GET /proxy-hosts/ingress-nodes: any proxy:create grant form, no node permission.
      const { folderId } = RouteIngressNodeListQuerySchema.parse({ folderId: a.folderId ?? undefined });
      const [data, groups] = await Promise.all([
        context.proxyService.listRouteIngressNodes(user.scopes, folderId),
        context.proxyService.listRouteIngressGroups(user.scopes, folderId),
      ]);
      return { data, groups };
    }
    case 'create_route': {
      const request = CreateProxyHostSchema.parse({
        type: a.type,
        upstreamKind: a.upstreamKind,
        nodeId: a.nodeId,
        ingressGroupId: a.ingressGroupId,
        domainNames: a.domainNames,
        forwardHost: a.forwardHost,
        forwardPort: a.forwardPort,
        forwardScheme: a.forwardScheme,
        upstreamIpv6Enabled: a.upstreamIpv6Enabled,
        dockerNodeId: a.dockerNodeId,
        dockerContainerName: a.dockerContainerName,
        dockerComposeProjectId: a.dockerComposeProjectId,
        dockerComposeServiceName: a.dockerComposeServiceName,
        dockerDeploymentId: a.dockerDeploymentId,
        dockerContainerPort: a.dockerContainerPort,
        pageProjectId: a.pageProjectId,
        pageTagId: a.pageTagId,
        relaySpreadMode: a.relaySpreadMode,
        relaySpreadCount: a.relaySpreadCount,
        sslEnabled: a.sslEnabled,
        sslForced: a.sslForced,
        http2Support: a.http2Support,
        websocketSupport: a.websocketSupport,
        sslCertificateId: a.sslCertificateId,
        redirectUrl: a.redirectUrl,
        redirectStatusCode: a.redirectStatusCode,
        customHeaders: a.customHeaders,
        cacheEnabled: a.cacheEnabled,
        cacheOptions: a.cacheOptions,
        rateLimitEnabled: a.rateLimitEnabled,
        rateLimitMode: a.rateLimitMode ?? (a.rateLimitEnabled ? 'custom' : undefined),
        rateLimitOptions: a.rateLimitOptions,
        customRewrites: a.customRewrites,
        advancedConfig: a.advancedConfig,
        internalCertificateId: a.internalCertificateId,
        accessListId: a.accessListId,
        folderId: a.folderId,
        nginxTemplateId: a.nginxTemplateId,
        templateVariables: dropReservedTemplateVariables(a.templateVariables),
        healthCheckEnabled: a.healthCheckEnabled,
        healthCheckUrl: a.healthCheckUrl,
        healthCheckInterval: a.healthCheckInterval,
        healthCheckExpectedStatus: a.healthCheckExpectedStatus,
        healthCheckExpectedBody: a.healthCheckExpectedBody,
        healthCheckBodyMatchMode: a.healthCheckBodyMatchMode,
        healthCheckSlowThreshold: a.healthCheckSlowThreshold,
      });
      if (request.upstreamKind === 'pages') await requirePagesAvailable();
      // Like POST /proxy-hosts: without nodeId the route takes the node or ingress group of its registered domains
      // or the caller's only eligible node, and every destination check below runs against it (each group member).
      const placement =
        request.nodeId && !request.ingressGroupId
          ? { nodeId: request.nodeId, ingressGroupId: null }
          : await context.proxyService.resolveRouteIngressNode(user.scopes, request);
      const input = { ...request, nodeId: placement.nodeId, ingressGroupId: placement.ingressGroupId ?? undefined };
      const destination: string | string[] = placement.ingressGroupId
        ? await assertRoutePlacementOnGroup(user.scopes, placement.ingressGroupId, input.folderId)
        : input.nodeId;
      if (
        !placement.ingressGroupId &&
        !hasScopeForCreation(user.scopes, 'proxy:create', input.folderId, input.nodeId)
      ) {
        throw new AppError(403, 'FORBIDDEN', 'Missing proxy:create permission for the selected destination');
      }
      await context.folderService.assertFolderExists(input.folderId);
      // Advanced, raw and unrestricted grants apply to the new route's destination folder or node.
      if (
        input.advancedConfig &&
        !hasProxyDestinationScope(user.scopes, 'proxy:advanced', input.folderId, destination)
      ) {
        throw new AppError(
          403,
          'FORBIDDEN',
          'Advanced config requires proxy:advanced scope for the selected destination'
        );
      }
      if (input.upstreamKind === 'pages') requirePageProjectAccess(user, input.pageProjectId);
      if (
        togglesRawMode(input) &&
        !hasProxyDestinationScope(user.scopes, 'proxy:raw:write', input.folderId, destination)
      ) {
        throw new AppError(403, 'FORBIDDEN', 'Enabling raw mode requires proxy:raw:write scope');
      }
      await context.proxyService.assertReferenceAccess(user.scopes, input);
      const unrestricted = hasProxyDestinationScope(user.scopes, 'proxy:unrestricted', input.folderId, destination);
      return compact(
        await context.proxyService.createProxyHost(input, user.id, {
          actorScopes: user.scopes,
          bypassAdvancedValidation: unrestricted,
          bypassRawValidation: unrestricted,
        })
      );
    }
    case 'update_route': {
      const { routeId } = a;
      if ('rawConfig' in a) {
        throw new Error('Raw config changes require dedicated raw config tools');
      }
      const enabledArg = typeof a.enabled === 'boolean' ? a.enabled : undefined;
      const updateFields: Record<string, unknown> = UpdateProxyHostSchema.parse(
        [...ROUTE_UPDATE_FIELDS, 'advancedConfig', 'rawConfigEnabled'].reduce<Record<string, unknown>>(
          (fields, field) => {
            if (field !== 'enabled' && a[field] !== undefined) fields[field] = a[field];
            return fields;
          },
          {}
        )
      );
      // The raw flag is only forwarded when it changes the stored mode (checked below).
      const rawConfigEnabled = updateFields.rawConfigEnabled;
      delete updateFields.rawConfigEnabled;
      const existing = await context.proxyService.getProxyHost(routeId);
      // Moving a route between folders goes through the same checks as the
      // move endpoint. An unchanged folderId is ignored.
      if (updateFields.folderId !== undefined) {
        const folderId = (updateFields.folderId as string | null) ?? null;
        if (folderId === ((existing as { folderId?: string | null }).folderId ?? null)) {
          delete updateFields.folderId;
        } else {
          // Folder management is needed where the route leaves and where it lands, as in the REST update.
          assertFolderManage(
            user.scopes,
            'proxy:folders:manage',
            (existing as { folderId?: string | null }).folderId ?? null
          );
          assertFolderManage(user.scopes, 'proxy:folders:manage', folderId);
          if (
            !hasScope(user.scopes, `proxy:edit:${routeId}`) ||
            !hasScopeForCreation(user.scopes, 'proxy:edit', folderId)
          ) {
            throw new AppError(403, 'FORBIDDEN', 'Missing route edit access for the move destination');
          }
          await context.folderService.assertFolderChange(
            (existing as { folderId?: string | null }).folderId ?? null,
            folderId ?? null
          );
        }
      }
      if (
        updateFields.upstreamKind === 'pages' ||
        updateFields.pageProjectId != null ||
        updateFields.pageTagId != null
      ) {
        await requirePagesAvailable();
      }
      // An enabled-only call is POST /proxy-hosts/{id}/toggle, which does not check the Page Project.
      const toggleOnly = Object.keys(updateFields).length === 0 && enabledArg !== undefined;
      if (!toggleOnly) requireExistingPageRouteAccess(user, existing);
      if (updateFields.pageProjectId !== undefined || updateFields.pageTagId !== undefined) {
        if (typeof updateFields.pageProjectId !== 'string' || typeof updateFields.pageTagId !== 'string') {
          throw new AppError(403, 'FORBIDDEN', 'Viewing the selected Page Project is required');
        }
        requirePageProjectAccess(user, updateFields.pageProjectId);
      }
      // Setting or clearing the advanced config both need the scope; echoing
      // the stored value (or the redacted null) does not.
      if (
        updateFields.advancedConfig !== undefined &&
        !hasScope(user.scopes, `proxy:advanced:${routeId}`) &&
        normalizedAdvancedConfig(updateFields.advancedConfig) !== normalizedAdvancedConfig(existing.advancedConfig)
      ) {
        if (normalizedAdvancedConfig(updateFields.advancedConfig) !== null) {
          throw new AppError(403, 'FORBIDDEN', 'Advanced config requires proxy:advanced scope');
        }
        delete updateFields.advancedConfig;
      }
      // A raw-mode toggle is an actual change of the stored mode; echoing the
      // stored type/flag does not need the raw scopes.
      const rawToggle = togglesRawMode({ type: updateFields.type, rawConfigEnabled }, existing as RawModeState);
      if (rawToggle) {
        if (!hasScope(user.scopes, `proxy:raw:write:${routeId}`)) {
          throw new AppError(403, 'FORBIDDEN', 'Toggling raw mode requires proxy:raw:write scope');
        }
        if (rawConfigEnabled !== undefined) updateFields.rawConfigEnabled = rawConfigEnabled;
      }
      // Moving a route to another ingress node is creating it there: any destination grant form is accepted.
      const destinationFolderId =
        updateFields.folderId !== undefined
          ? ((updateFields.folderId as string | null) ?? null)
          : ((existing as { folderId?: string | null }).folderId ?? null);
      const existingGroupId = (existing as { ingressGroupId?: string | null }).ingressGroupId ?? null;
      if (typeof updateFields.ingressGroupId === 'string' && updateFields.ingressGroupId !== existingGroupId) {
        // Moving onto an ingress group creates the route on every member.
        await assertRoutePlacementOnGroup(user.scopes, updateFields.ingressGroupId, destinationFolderId);
      } else if (
        typeof updateFields.nodeId === 'string' &&
        updateFields.nodeId &&
        updateFields.nodeId !== existing.nodeId &&
        !(existingGroupId && updateFields.ingressGroupId === null) &&
        !hasScopeForCreation(user.scopes, 'proxy:create', destinationFolderId, updateFields.nodeId)
      ) {
        throw new AppError(403, 'FORBIDDEN', `Missing required scope: proxy:create:node/${updateFields.nodeId}`);
      }
      if (updateFields.templateVariables !== undefined) {
        updateFields.templateVariables = dropReservedTemplateVariables(updateFields.templateVariables);
      }
      // The update route does not accept `enabled`; enabling or disabling goes
      // through the toggle lifecycle, which protects system and public routes.
      await context.proxyService.assertReferenceAccess(user.scopes, updateFields, existing);
      const unrestricted = hasScope(user.scopes, `proxy:unrestricted:${routeId}`);
      let updated: Record<string, any> = existing;
      if (Object.keys(updateFields).length > 0 || enabledArg === undefined) {
        updated = await context.proxyService.updateProxyHost(routeId, updateFields, user.id, {
          actorScopes: user.scopes,
          bypassAdvancedValidation: unrestricted,
          ...(rawToggle ? { bypassRawValidation: unrestricted } : {}),
        });
      }
      if (enabledArg !== undefined && enabledArg !== updated.enabled) {
        updated = await context.proxyService.toggleProxyHost(routeId, enabledArg, user.id);
      }
      return compact(updated);
    }
    case 'set_route_maintenance':
      return compact(await context.proxyService.toggleMaintenance(a.routeId, a.enabled === true, user.id));
    case 'delete_route':
      await context.proxyService.deleteProxyHost(a.routeId, user.id);
      return { success: true };
    case 'create_route_folder': {
      const input = CreateFolderSchema.parse({ name: a.name, parentId: a.parentId });
      assertFolderManage(user.scopes, 'proxy:folders:manage', input.parentId ?? null);
      return context.folderService.createFolder(input, user.id);
    }
    case 'move_routes_to_folder': {
      const input = MoveHostsToFolderSchema.parse({ hostIds: a.routeIds, folderId: a.folderId });
      await assertFolderManageForResources(
        context.folderService,
        user.scopes,
        'proxy:folders:manage',
        input.hostIds,
        input.folderId
      );
      for (const routeId of input.hostIds) {
        if (!hasScope(user.scopes, `proxy:edit:${routeId}`)) {
          throw new Error(`PERMISSION_DENIED: Missing required scope proxy:edit:${routeId}`);
        }
      }
      if (!hasScopeForCreation(user.scopes, 'proxy:edit', input.folderId)) {
        throw new AppError(403, 'FORBIDDEN', 'Missing route edit access for the move destination');
      }
      return context.folderService.moveHostsToFolder(input, user.id);
    }
    case 'delete_route_folder':
      await assertFolderManageForFolder(context.folderService, user.scopes, 'proxy:folders:manage', a.folderId);
      await context.folderService.deleteFolder(a.folderId, user.id);
      return { success: true };
    case 'manage_route':
      return manageRoute(context, user, a);
    default:
      throw new Error(`Unsupported proxy tool: ${toolName}`);
  }
}

async function manageRoute(context: ProxyToolContext, user: User, a: Record<string, any>): Promise<unknown> {
  if (a.operation === 'validate_config') {
    // Mirrors POST /proxy-hosts/validate-config.
    const { snippet, mode, proxyHostId, folderId, nodeId } = ValidateAdvancedConfigSchema.parse({
      snippet: a.snippet,
      mode: a.mode,
      proxyHostId: a.routeId,
      folderId: a.folderId,
      nodeId: a.nodeId,
    });
    // An existing route is checked on its own grants; a route about to be created on its destination.
    const holds = (baseScope: string) =>
      proxyHostId
        ? hasScope(user.scopes, `${baseScope}:${proxyHostId}`)
        : hasProxyDestinationScope(user.scopes, baseScope, folderId, nodeId);
    if (!holds(mode === 'raw' ? 'proxy:raw:write' : 'proxy:advanced')) {
      throw new AppError(
        403,
        'FORBIDDEN',
        mode === 'raw'
          ? 'Raw config validation requires proxy:raw:write scope'
          : 'Advanced config requires proxy:advanced scope'
      );
    }
    const unrestricted = holds('proxy:unrestricted');
    return mode === 'advanced'
      ? context.proxyService.validateAdvancedConfig(snippet, false, unrestricted, false, proxyHostId)
      : context.proxyService.validateAdvancedConfig(snippet, true, false, unrestricted);
  }
  if (a.operation === 'get_by_slug') {
    const slug = typeof a.slug === 'string' ? a.slug : '';
    if (!slug) throw new AppError(400, 'SLUG_REQUIRED', 'slug is required for get_by_slug');
    const host = await context.proxyService.getProxyHostBySlug(slug);
    requireRouteView(user, host.id);
    return routeConfigForAgent(user, host);
  }

  const routeId = typeof a.routeId === 'string' ? a.routeId : '';
  if (!routeId) throw new AppError(400, 'ROUTE_ID_REQUIRED', `routeId is required for ${String(a.operation)}`);
  if (a.operation !== 'maintenance_access_code') requireRouteView(user, routeId);
  if (a.operation === 'get_config') return routeConfigForAgent(user, await context.proxyService.getProxyHost(routeId));
  if (a.operation === 'health_history') return context.proxyService.getProxyHostHealthHistory(routeId);
  if (a.operation === 'secure_link_status') return context.proxyService.getProxySecureLinkStatus(routeId);
  if (a.operation === 'access_logs') return routeAccessLogs(context, routeId, a.tail);
  if (a.operation === 'maintenance_access_code') {
    // Mirrors POST /proxy-hosts/{id}/maintenance-access-code: a short-lived code for the maintenance page.
    if (!hasScopeForResource(user.scopes, 'proxy:maintenance:bypass', routeId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: proxy:maintenance:bypass:${routeId}`);
    }
    return container.resolve(ProxyMaintenanceAccessService).issue(routeId, user.id);
  }
  throw new Error(`Unsupported route operation: ${String(a.operation)}`);
}

const ACCESS_LOG_TAIL_MAX = 200;

/**
 * Snapshot of the Route log viewer (/ws/proxy-logs, proxy:view:<id>): the
 * newest nginx access and error lines from the Route's node, falling back to
 * the Gateway's buffered history when the node does not answer in time.
 */
async function routeAccessLogs(context: ProxyToolContext, routeId: string, tailArg: unknown) {
  const host = await context.proxyService.getProxyHost(routeId);
  const nodeId = typeof host.nodeId === 'string' ? host.nodeId : null;
  if (!nodeId) throw new AppError(409, 'ROUTE_NODE_REQUIRED', 'The route has no nginx node');
  // A route on an ingress group logs on every member; the lines of all members are merged by time.
  const nodeIds: string[] =
    Array.isArray(host.servingNodeIds) && host.servingNodeIds.length ? host.servingNodeIds : [nodeId];
  const tail = Math.min(Math.max(Math.trunc(typeof tailArg === 'number' ? tailArg : 100), 1), ACCESS_LOG_TAIL_MAX);
  const buffered = getNginxLogHistory(routeId).filter((entry) => nodeIds.includes(entry.nodeId));
  const result = await requestProxyLogHistory(container.resolve(NodeRegistryService), nodeIds, routeId, tail);
  if (!result.ok && buffered.length === 0) {
    throw new AppError(503, 'ROUTE_LOGS_UNAVAILABLE', result.message);
  }
  return {
    routeId,
    nodeId,
    ...(nodeIds.length > 1 ? { nodeIds } : {}),
    cached: !result.ok,
    entries: (result.ok ? result.entries : buffered).slice(-tail),
  };
}

function requireRouteView(user: User, routeId: string) {
  if (!hasScopeForResource(user.scopes, 'proxy:view', routeId)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: proxy:view:${routeId}`);
  }
}

/**
 * Full route settings as the browser receives them: Page targets and the
 * advanced snippet follow the caller's scopes, and the stored raw config is
 * only included with an exact proxy:raw:read grant (like GET /proxy-hosts/{id}).
 */
function routeConfigForAgent(user: User, host: Record<string, any>) {
  const scoped = redactProxyHostForScopes(host, user.scopes);
  const canReadRaw = user.scopes.includes('proxy:raw:read') || user.scopes.includes(`proxy:raw:read:${host.id}`);
  return canReadRaw ? scoped : redactRawProxyConfigForBrowser(scoped);
}

type RawModeState = { type?: string | null; rawConfigEnabled?: boolean | null };

/** Mirrors proxy.routes.ts: only an actual change of the stored raw mode counts as a toggle. */
function togglesRawMode(input: { type?: unknown; rawConfigEnabled?: unknown }, existing: RawModeState = {}): boolean {
  const becomesRawType = input.type === 'raw' && existing.type !== 'raw';
  const leavesRawType = existing.type === 'raw' && input.type !== undefined && input.type !== 'raw';
  const changesFlag =
    input.rawConfigEnabled !== undefined && input.rawConfigEnabled !== (existing.rawConfigEnabled ?? false);
  return becomesRawType || leavesRawType || changesFlag;
}

function normalizedAdvancedConfig(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Same rule as the proxy host schemas: Gateway-managed render keys cannot be
 * overridden, and are dropped (and logged) instead of rejecting the save.
 */
function dropReservedTemplateVariables<T>(variables: T): T {
  if (variables === undefined || variables === null) return variables;
  if (typeof variables !== 'object' || Array.isArray(variables)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'templateVariables must be an object');
  }
  const reserved = reservedTemplateVariableNames(variables as Record<string, unknown>);
  if (reserved.length === 0) return variables;
  logger.info('Dropped Opfield-managed template variables from proxy host input', { reserved });
  return withoutReservedTemplateVariables(variables as Record<string, unknown>) as T;
}

async function requirePagesAvailable() {
  await container.resolve(LicensePolicyService).requireFeature('pages');
  await container.resolve(PageProfileService).requireEnabled();
}

function requirePageProjectAccess(user: User, projectId: unknown) {
  if (typeof projectId !== 'string' || !hasScopeForResource(user.scopes, 'pages:view', projectId)) {
    throw new AppError(403, 'FORBIDDEN', 'Viewing the selected Page Project is required');
  }
}

/** PUT /proxy-hosts/{id} refuses any change to an existing Pages route without viewing its Page Project. */
export function requireExistingPageRouteAccess(
  user: User,
  existing: { upstreamKind?: unknown; pageTarget?: unknown } | null | undefined
) {
  if (existing?.upstreamKind !== 'pages') return;
  requirePageProjectAccess(user, (existing.pageTarget as { projectId?: unknown } | null | undefined)?.projectId);
}
