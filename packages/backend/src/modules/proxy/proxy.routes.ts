import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeBase, hasScopeForCreation } from '@/lib/permissions.js';
import { resolveSlugVisibleTo } from '@/lib/slug-lookup.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScopeBase, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import { assertRoutePlacementOnGroup } from '@/modules/ingress-groups/ingress-group-operations.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { assertFolderManage } from '@/modules/resource-folders/resource-folder-access.js';
import type { AppEnv } from '@/types.js';
import {
  createAdditionalRouteRoute,
  deleteAdditionalRouteRoute,
  getAdditionalRouteRoute,
  listAdditionalRoutesRoute,
  retryAdditionalRouteRoute,
  updateAdditionalRouteRoute,
} from './additional-route.docs.js';
import { AdditionalRouteService } from './additional-route.service.js';
import { CreateAdditionalRouteSchema, UpdateAdditionalRouteSchema } from './additional-route.validation.js';
import { FolderService } from './folder.service.js';
import {
  redactProxyHostForScopes,
  redactAdditionalRouteForScopes as serializeAdditionalRoute,
} from './page-target-visibility.js';
import {
  changeRouteIngressPlacementRoute,
  createProxyHostRoute,
  deleteProxyHostRoute,
  getProxyHostBySlugRoute,
  getProxyHostHealthHistoryRoute,
  getProxyHostRoute,
  listProxyHostsRoute,
  listRouteIngressNodesRoute,
  renderedProxyConfigRoute,
  resyncProxyHostTlsRoute,
  toggleProxyHostRoute,
  toggleProxyMaintenanceRoute,
  updateProxyHostRoute,
  validateProxyConfigRoute,
} from './proxy.docs.js';
import {
  CreateAdditionalSecureLinkSchema,
  CreateProxyHostSchema,
  ProxyHostListQuerySchema,
  parseRetargetAdditionalSecureLink,
  RouteIngressNodeListQuerySchema,
  RouteIngressPlacementSchema,
  ToggleProxyHostSchema,
  ToggleProxyMaintenanceSchema,
  UpdateProxyHostSchema,
  ValidateAdvancedConfigSchema,
} from './proxy.schemas.js';
import { ProxyService } from './proxy.service.js';
import { hasProxyDestinationScope } from './proxy-destination-scope.js';
import { ProxyMaintenanceAccessService } from './proxy-maintenance-access.service.js';
import { redactRawProxyConfigForBrowser } from './raw-visibility.js';
import { createRouteMaybeWithDomains } from './route-missing-domains.js';
import { registerMissingRouteDomainsRoutes } from './route-missing-domains.routes.js';
import { assertTlsResyncAccess } from './tls-resync-access.js';

export const proxyRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

proxyRoutes.use('*', authMiddleware);

type RawModeState = { type?: string | null; rawConfigEnabled?: boolean | null };

/**
 * A raw-mode "toggle" is an actual change of the stored mode. Clients that
 * submit a complete form echo the unchanged `rawConfigEnabled`/`type`, which
 * must not require the raw scopes.
 */
function requestTogglesRawProxyConfig(
  input: { type?: string; rawConfigEnabled?: unknown },
  existing: RawModeState = {}
): boolean {
  const becomesRawType = input.type === 'raw' && existing.type !== 'raw';
  const leavesRawType = existing.type === 'raw' && input.type !== undefined && input.type !== 'raw';
  const changesFlag =
    input.rawConfigEnabled !== undefined && input.rawConfigEnabled !== (existing.rawConfigEnabled ?? false);
  return becomesRawType || leavesRawType || changesFlag;
}

function normalizedAdvancedConfig(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requestOnlyUpdatesRawProxyConfig(input: Record<string, unknown>): boolean {
  const rawKeys = new Set(['rawConfig']);
  return Object.keys(input).length > 0 && Object.keys(input).every((key) => rawKeys.has(key));
}

function canReadRawProxyConfig(scopes: string[], id: string) {
  return scopes.includes('proxy:raw:read') || scopes.includes(`proxy:raw:read:${id}`);
}

function serializeProxyHostForBrowser(host: Record<string, unknown>, scopes: string[], id: string) {
  const scoped = redactProxyHostForScopes(host, scopes);
  return canReadRawProxyConfig(scopes, id) ? scoped : redactRawProxyConfigForBrowser(scoped);
}

proxyRoutes.openapi({ ...listProxyHostsRoute, middleware: requireScopeBase('proxy:view') }, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const query = ProxyHostListQuerySchema.parse(c.req.query());
  const scopes = c.get('effectiveScopes') || [];
  const result = await proxyService.listProxyHosts(
    query,
    hasScope(scopes, 'proxy:view') ? undefined : { allowedIds: getResourceScopedIds(scopes, 'proxy:view') }
  );
  const scopedData = result.data.map((host) => redactProxyHostForScopes(host as any, scopes));
  return c.json({ ...result, data: scopedData });
});

// Registered before /{id}. Any proxy:create grant form (broad, folder or node) may list the ingress
// nodes it can create routes on, without nodes:details.
proxyRoutes.openapi({ ...listRouteIngressNodesRoute, middleware: requireScopeBase('proxy:create') }, async (c) => {
  const { folderId } = RouteIngressNodeListQuerySchema.parse(c.req.query());
  const scopes = c.get('effectiveScopes') || [];
  const proxyService = container.resolve(ProxyService);
  const [data, groups] = await Promise.all([
    proxyService.listRouteIngressNodes(scopes, folderId),
    proxyService.listRouteIngressGroups(scopes, folderId),
  ]);
  return c.json({ data, groups });
});

proxyRoutes.openapi(getProxyHostBySlugRoute, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const scopes = c.get('effectiveScopes') || [];
  // A Route the caller may not view answers like a missing slug.
  const host = await resolveSlugVisibleTo(
    'Route',
    () => proxyService.getProxyHostBySlug(c.req.param('slug')!),
    (id) => hasScope(scopes, `proxy:view:${id}`)
  );
  const [withApp] = await proxyService.withAppField([host as any]);
  return c.json({ data: serializeProxyHostForBrowser(withApp, scopes, host.id) });
});

proxyRoutes.openapi({ ...getProxyHostRoute, middleware: requireScopeForResource('proxy:view', 'id') }, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const id = c.req.param('id')!;
  const host = await proxyService.getProxyHost(id);
  const scopes = c.get('effectiveScopes') || [];
  const [withApp] = await proxyService.withAppField([host as any]);
  return c.json({ data: serializeProxyHostForBrowser(withApp, scopes, id) });
});

proxyRoutes.openapi(
  { ...getProxyHostHealthHistoryRoute, middleware: requireScopeForResource('proxy:view', 'id') },
  async (c) => {
    const proxyService = container.resolve(ProxyService);
    const id = c.req.param('id')!;
    const healthHistory = await proxyService.getProxyHostHealthHistory(id);
    return c.json({ data: healthHistory });
  }
);

proxyRoutes.get('/:id/secure-link', requireScopeForResource('proxy:view', 'id'), async (c) => {
  const data = await container.resolve(ProxyService).getProxySecureLinkStatus(c.req.param('id')!);
  return c.json({ data });
});

proxyRoutes.post(
  '/:id/maintenance-access-code',
  requireScopeForResource('proxy:maintenance:bypass', 'id'),
  async (c) => {
    const data = await container.resolve(ProxyMaintenanceAccessService).issue(c.req.param('id')!, c.get('user')!.id);
    return c.json({ data });
  }
);

proxyRoutes.get('/:id/additional-secure-links', requireScopeForResource('proxy:view', 'id'), async (c) => {
  const data = await container.resolve(ProxyService).listAdditionalSecureLinks(c.req.param('id')!);
  return c.json({ data });
});

proxyRoutes.post('/:id/additional-secure-links', requireScopeForResource('proxy:edit', 'id'), async (c) => {
  const data = await container
    .resolve(ProxyService)
    .createAdditionalSecureLink(
      c.req.param('id')!,
      CreateAdditionalSecureLinkSchema.parse(await c.req.json()),
      c.get('user')!.id,
      c.get('effectiveScopes') || []
    );
  return c.json({ data }, 201);
});

proxyRoutes.post(
  '/:id/additional-secure-links/:bindingId/retry',
  requireScopeForResource('proxy:edit', 'id'),
  async (c) => {
    const data = await container
      .resolve(ProxyService)
      .retryAdditionalSecureLink(
        c.req.param('id')!,
        c.req.param('bindingId')!,
        c.get('user')!.id,
        c.get('effectiveScopes') || []
      );
    return c.json({ data });
  }
);

// Moves the link to another target in place; the destination needs the same
// access as creating the link (e.g. storage:view on a managed storage cluster).
proxyRoutes.post(
  '/:id/additional-secure-links/:bindingId/retarget',
  requireScopeForResource('proxy:edit', 'id'),
  async (c) => {
    const data = await container
      .resolve(ProxyService)
      .retargetAdditionalSecureLink(
        c.req.param('id')!,
        c.req.param('bindingId')!,
        parseRetargetAdditionalSecureLink(await c.req.json()),
        c.get('user')!.id,
        c.get('effectiveScopes') || []
      );
    return c.json({ data });
  }
);

proxyRoutes.delete(
  '/:id/additional-secure-links/:bindingId',
  requireScopeForResource('proxy:edit', 'id'),
  async (c) => {
    await container
      .resolve(ProxyService)
      .deleteAdditionalSecureLink(c.req.param('id')!, c.req.param('bindingId')!, c.get('user')!.id);
    return c.body(null, 204);
  }
);

proxyRoutes.openapi(
  { ...listAdditionalRoutesRoute, middleware: requireScopeForResource('proxy:view', 'id') },
  async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    const rows = await container.resolve(AdditionalRouteService).list(c.req.param('id')!);
    return c.json({ data: rows.map((row) => serializeAdditionalRoute(row as Record<string, unknown>, scopes)) });
  }
);

proxyRoutes.openapi(
  { ...createAdditionalRouteRoute, middleware: requireScopeForResource('proxy:edit', 'id') },
  async (c) => {
    const user = c.get('user')!;
    const scopes = c.get('effectiveScopes') || [];
    const input = CreateAdditionalRouteSchema.parse(await c.req.json());
    if (input.advancedConfig !== undefined && !hasScope(scopes, `proxy:advanced:${c.req.param('id')!}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Advanced proxy configuration scope is required', {
        requiredScope: `proxy:advanced:${c.req.param('id')!}`,
      });
    }
    if (input.targetKind === 'pages') {
      await container.resolve(LicensePolicyService).requireFeature('pages');
      await container.resolve(PageProfileService).requireEnabled();
    }
    const row = await container.resolve(AdditionalRouteService).create(c.req.param('id')!, input, user.id, scopes);
    const view = await container.resolve(AdditionalRouteService).present(row);
    return c.json({ data: serializeAdditionalRoute(view as Record<string, unknown>, scopes) }, 201);
  }
);

proxyRoutes.openapi(
  { ...getAdditionalRouteRoute, middleware: requireScopeForResource('proxy:view', 'id') },
  async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    const row = await container.resolve(AdditionalRouteService).get(c.req.param('id')!, c.req.param('routeId')!);
    const view = await container.resolve(AdditionalRouteService).present(row);
    return c.json({ data: serializeAdditionalRoute(view as Record<string, unknown>, scopes) });
  }
);

proxyRoutes.openapi(
  { ...updateAdditionalRouteRoute, middleware: requireScopeForResource('proxy:edit', 'id') },
  async (c) => {
    const user = c.get('user')!;
    const scopes = c.get('effectiveScopes') || [];
    const input = UpdateAdditionalRouteSchema.parse(await c.req.json());
    if (input.targetKind === 'pages' || input.pageProjectId != null || input.pageTagId != null) {
      await container.resolve(LicensePolicyService).requireFeature('pages');
      await container.resolve(PageProfileService).requireEnabled();
    }
    if (input.advancedConfig !== undefined && !hasScope(scopes, `proxy:advanced:${c.req.param('id')!}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Advanced proxy configuration scope is required', {
        requiredScope: `proxy:advanced:${c.req.param('id')!}`,
      });
    }
    const row = await container
      .resolve(AdditionalRouteService)
      .update(c.req.param('id')!, c.req.param('routeId')!, input, user.id, scopes);
    const view = await container.resolve(AdditionalRouteService).present(row);
    return c.json({ data: serializeAdditionalRoute(view as Record<string, unknown>, scopes) });
  }
);

proxyRoutes.openapi(
  { ...retryAdditionalRouteRoute, middleware: requireScopeForResource('proxy:edit', 'id') },
  async (c) => {
    const user = c.get('user')!;
    const scopes = c.get('effectiveScopes') || [];
    const existing = await container.resolve(AdditionalRouteService).get(c.req.param('id')!, c.req.param('routeId')!);
    // Retrying an existing Pages route keeps it serving after the license grace period.
    if (existing.targetKind === 'pages') {
      await container.resolve(LicensePolicyService).requireFeatureForExistingRuntime('pages');
    }
    const row = await container
      .resolve(AdditionalRouteService)
      .retry(c.req.param('id')!, c.req.param('routeId')!, user.id, scopes);
    const view = await container.resolve(AdditionalRouteService).present(row);
    return c.json({ data: serializeAdditionalRoute(view as Record<string, unknown>, scopes) });
  }
);

proxyRoutes.openapi(
  { ...deleteAdditionalRouteRoute, middleware: requireScopeForResource('proxy:edit', 'id') },
  async (c) => {
    await container
      .resolve(AdditionalRouteService)
      .remove(c.req.param('id')!, c.req.param('routeId')!, c.get('user')!.id);
    return c.body(null, 204);
  }
);

registerMissingRouteDomainsRoutes(proxyRoutes);

proxyRoutes.openapi(createProxyHostRoute, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const user = c.get('user')!;
  const request = CreateProxyHostSchema.parse(await c.req.json());
  const scopes = c.get('effectiveScopes') || [];
  if (request.upstreamKind === 'pages') {
    await container.resolve(LicensePolicyService).requireFeature('pages');
    await container.resolve(PageProfileService).requireEnabled();
  }
  if (!hasScopeBase(scopes, 'proxy:create')) {
    throw new AppError(403, 'FORBIDDEN', 'Missing proxy:create permission for the selected destination');
  }
  // Without nodeId the route takes the node or ingress group of its registered domains or the caller's only
  // eligible node; every destination check below runs against it (every member of a group).
  const placement =
    request.nodeId && !request.ingressGroupId
      ? { nodeId: request.nodeId, ingressGroupId: null }
      : await proxyService.resolveRouteIngressNode(scopes, request);
  const input = { ...request, nodeId: placement.nodeId, ingressGroupId: placement.ingressGroupId ?? undefined };
  const destinationNodes: string | string[] = placement.ingressGroupId
    ? await assertRoutePlacementOnGroup(scopes, placement.ingressGroupId, input.folderId)
    : input.nodeId;
  if (!placement.ingressGroupId && !hasScopeForCreation(scopes, 'proxy:create', input.folderId, input.nodeId)) {
    throw new AppError(403, 'FORBIDDEN', 'Missing proxy:create permission for the selected destination');
  }
  await container.resolve(FolderService).assertFolderExists(input.folderId);
  // Advanced, raw and unrestricted grants apply to the new route's destination:
  // a folder- or node-scoped grant covers routes created there.
  if (input.advancedConfig && !hasProxyDestinationScope(scopes, 'proxy:advanced', input.folderId, destinationNodes)) {
    throw new AppError(403, 'FORBIDDEN', 'Advanced config requires proxy:advanced scope for the selected destination', {
      requiredScope: 'proxy:advanced',
    });
  }
  if (
    input.upstreamKind === 'pages' &&
    (!input.pageProjectId || !hasScope(scopes, `pages:view:${input.pageProjectId}`))
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Viewing the selected Page Project is required');
  }
  const unrestricted = hasProxyDestinationScope(scopes, 'proxy:unrestricted', input.folderId, destinationNodes);
  const canWriteRaw = hasProxyDestinationScope(scopes, 'proxy:raw:write', input.folderId, destinationNodes);
  if (requestTogglesRawProxyConfig(input) && !canWriteRaw) {
    throw new AppError(403, 'FORBIDDEN', 'Enabling raw mode requires proxy:raw:write scope', {
      requiredScope: 'proxy:raw:write',
    });
  }
  if (input.rawConfig !== undefined && !canWriteRaw) {
    throw new AppError(403, 'FORBIDDEN', 'Writing raw config requires proxy:raw:write scope', {
      requiredScope: 'proxy:raw:write',
    });
  }
  await proxyService.assertReferenceAccess(scopes, input);
  const { route: host, response } = await createRouteMaybeWithDomains(
    input.createMissingDomains,
    scopes,
    user.id,
    { domainNames: input.domainNames, folderId: input.folderId, ...placement },
    () =>
      proxyService.createProxyHost(input, user.id, {
        bypassAdvancedValidation: unrestricted,
        bypassRawValidation: unrestricted,
        actorScopes: scopes,
      })
  );
  return c.json({ data: { ...serializeProxyHostForBrowser(host as any, scopes, (host as any).id), ...response } }, 201);
});

proxyRoutes.openapi(updateProxyHostRoute, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const input = UpdateProxyHostSchema.parse(await c.req.json());
  const scopes = c.get('effectiveScopes') || [];
  // A caller without raw read access received rawConfig: null (see serializeProxyHostForBrowser);
  // echoing it back in a full-object PUT is not a raw config write.
  if (input.rawConfig === null && !canReadRawProxyConfig(scopes, id)) {
    delete input.rawConfig;
  }
  const existing = await proxyService.getProxyHost(id);
  // Moving a route between folders goes through the same checks as the move
  // endpoint. An unchanged folderId (full-object PUT) is ignored.
  if (input.folderId !== undefined) {
    if ((input.folderId ?? null) === ((existing as { folderId?: string | null }).folderId ?? null)) {
      delete input.folderId;
    } else {
      // Folder management is needed where the route leaves and where it lands (broadly or on those folders).
      assertFolderManage(scopes, 'proxy:folders:manage', (existing as { folderId?: string | null }).folderId ?? null);
      assertFolderManage(scopes, 'proxy:folders:manage', input.folderId ?? null);
      if (!hasScope(scopes, `proxy:edit:${id}`) || !hasScopeForCreation(scopes, 'proxy:edit', input.folderId)) {
        throw new AppError(403, 'FORBIDDEN', 'Missing route edit access for the move destination');
      }
      await container
        .resolve(FolderService)
        .assertFolderChange((existing as { folderId?: string | null }).folderId ?? null, input.folderId ?? null);
    }
  }
  const existingPageTarget = existing.pageTarget as { projectId?: unknown; tagId?: unknown } | null | undefined;
  if (input.upstreamKind === 'pages' || input.pageProjectId != null || input.pageTagId != null) {
    // Editing a host that keeps its existing Page target is not a new Pages route.
    const keepsPageTarget =
      existing.upstreamKind === 'pages' &&
      (input.upstreamKind === undefined || input.upstreamKind === 'pages') &&
      (input.pageProjectId == null || input.pageProjectId === existingPageTarget?.projectId) &&
      (input.pageTagId == null || input.pageTagId === (existingPageTarget?.tagId ?? null));
    const policy = container.resolve(LicensePolicyService);
    if (keepsPageTarget) await policy.requireFeatureForExistingRuntime('pages');
    else await policy.requireFeature('pages');
    await container.resolve(PageProfileService).requireEnabled();
  }
  if (
    existing.upstreamKind === 'pages' &&
    (typeof existingPageTarget?.projectId !== 'string' ||
      !hasScope(scopes, `pages:view:${existingPageTarget.projectId}`))
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Viewing the selected Page Project is required');
  }
  const rawOnlyUpdate = requestOnlyUpdatesRawProxyConfig(input);
  if (!rawOnlyUpdate && !hasScope(scopes, `proxy:edit:${id}`)) {
    throw new AppError(403, 'FORBIDDEN', 'Editing route settings requires proxy:edit scope');
  }
  if (
    (input.pageProjectId !== undefined || input.pageTagId !== undefined) &&
    (!input.pageProjectId || !input.pageTagId || !hasScope(scopes, `pages:view:${input.pageProjectId}`))
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Viewing the selected Page Project is required');
  }
  // Setting or clearing the advanced config both need the scope; echoing the
  // stored value (or the redacted null a scope-less viewer received) does not.
  if (
    input.advancedConfig !== undefined &&
    !hasScope(scopes, `proxy:advanced:${id}`) &&
    normalizedAdvancedConfig(input.advancedConfig) !== normalizedAdvancedConfig(existing.advancedConfig)
  ) {
    if (normalizedAdvancedConfig(input.advancedConfig) === null) {
      delete input.advancedConfig;
    } else {
      throw new AppError(403, 'FORBIDDEN', 'Advanced config requires proxy:advanced scope');
    }
  }
  const unrestricted = hasScope(scopes, `proxy:unrestricted:${id}`);
  const canWriteRaw = hasScope(scopes, `proxy:raw:write:${id}`);
  if (requestTogglesRawProxyConfig(input, existing) && !canWriteRaw) {
    throw new AppError(403, 'FORBIDDEN', 'Toggling raw mode requires proxy:raw:write scope', {
      requiredScope: `proxy:raw:write:${id}`,
    });
  }
  if (input.rawConfig !== undefined && !canWriteRaw) {
    throw new AppError(403, 'FORBIDDEN', 'Writing raw config requires proxy:raw:write scope', {
      requiredScope: `proxy:raw:write:${id}`,
    });
  }
  // Moving a route to another ingress node is creating it there: any destination
  // grant form (broad, node, or the route's folder) is accepted.
  const destinationFolderId =
    input.folderId !== undefined ? input.folderId : ((existing as { folderId?: string | null }).folderId ?? null);
  const existingGroupId = (existing as { ingressGroupId?: string | null }).ingressGroupId ?? null;
  if (input.ingressGroupId && input.ingressGroupId !== existingGroupId) {
    // Moving onto an ingress group creates the route on every member.
    await assertRoutePlacementOnGroup(scopes, input.ingressGroupId, destinationFolderId);
  } else if (
    input.nodeId &&
    input.nodeId !== existing.nodeId &&
    !(existingGroupId && input.ingressGroupId === null) &&
    !hasScopeForCreation(scopes, 'proxy:create', destinationFolderId, input.nodeId)
  ) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: proxy:create:node/${input.nodeId}`, {
      requiredScope: `proxy:create:node/${input.nodeId}`,
    });
  }
  await proxyService.assertReferenceAccess(scopes, input, existing);
  const host = await proxyService.updateProxyHost(id, input, user.id, {
    bypassAdvancedValidation: unrestricted,
    bypassRawValidation: unrestricted,
    actorScopes: scopes,
  });
  return c.json({ data: serializeProxyHostForBrowser(host as any, scopes, id) });
});

proxyRoutes.openapi(
  { ...changeRouteIngressPlacementRoute, middleware: requireScopeForResource('proxy:edit', 'id') },
  async (c) => {
    const id = c.req.param('id')!;
    const input = RouteIngressPlacementSchema.parse(await c.req.json());
    const scopes = c.get('effectiveScopes') || [];
    const proxyService = container.resolve(ProxyService);
    await proxyService.assertRouteNotAppFrozen(id);
    const existing = await proxyService.getProxyHost(id);
    const existingGroupId = (existing as { ingressGroupId?: string | null }).ingressGroupId ?? null;
    // Keeping the group the route is on changes nothing and needs no check.
    if (input.ingressGroupId && input.ingressGroupId !== existingGroupId) {
      await assertRoutePlacementOnGroup(
        scopes,
        input.ingressGroupId,
        (existing as { folderId?: string | null }).folderId ?? null
      );
    }
    await proxyService.changeRoutePlacement(
      id,
      { ingressGroupId: input.ingressGroupId, nodeId: input.nodeId ?? null },
      c.get('user')!.id
    );
    const host = await proxyService.getProxyHost(id);
    return c.json({ data: serializeProxyHostForBrowser(host as any, scopes, id) });
  }
);

proxyRoutes.openapi(
  { ...deleteProxyHostRoute, middleware: requireScopeForResource('proxy:delete', 'id') },
  async (c) => {
    const proxyService = container.resolve(ProxyService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    await proxyService.deleteProxyHost(id, user.id);
    return c.body(null, 204);
  }
);

proxyRoutes.openapi({ ...toggleProxyHostRoute, middleware: requireScopeForResource('proxy:edit', 'id') }, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const { enabled } = ToggleProxyHostSchema.parse(await c.req.json());
  const host = await proxyService.toggleProxyHost(id, enabled, user.id);
  const scopes = c.get('effectiveScopes') || [];
  return c.json({ data: serializeProxyHostForBrowser(host as any, scopes, id) });
});

proxyRoutes.openapi(
  { ...toggleProxyMaintenanceRoute, middleware: requireScopeForResource('proxy:edit', 'id') },
  async (c) => {
    const proxyService = container.resolve(ProxyService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    const { enabled } = ToggleProxyMaintenanceSchema.parse(await c.req.json());
    const host = await proxyService.toggleMaintenance(id, enabled, user.id);
    const scopes = c.get('effectiveScopes') || [];
    return c.json({ data: serializeProxyHostForBrowser(host as any, scopes, id) });
  }
);

// Retrying TLS delivery is a route edit; system routes stay admin:update only, and
// admin:update is still accepted for one release (rc.9 compatibility).
proxyRoutes.openapi(resyncProxyHostTlsRoute, async (c) => {
  const id = c.req.param('id')!;
  await assertTlsResyncAccess(c.get('effectiveScopes') || [], 'route', id);
  const proxyService = container.resolve(ProxyService);
  const user = c.get('user')!;
  const result = await proxyService.resyncTlsHost(id, user.id);
  return c.json({ data: result });
});

proxyRoutes.openapi(renderedProxyConfigRoute, async (c) => {
  const id = c.req.param('id')!;
  const scopes = c.get('effectiveScopes') || [];
  if (!scopes.includes(`proxy:raw:read:${id}`) && !scopes.includes('proxy:raw:read')) {
    return c.json({ message: `Missing required scope: proxy:raw:read:${id}` }, 403);
  }
  const proxyService = container.resolve(ProxyService);
  const rendered = await proxyService.getRenderedConfig(id);
  return c.json({ data: { rendered } });
});

proxyRoutes.openapi(validateProxyConfigRoute, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const scopes = c.get('effectiveScopes') || [];
  const { snippet, mode, proxyHostId, folderId, nodeId } = ValidateAdvancedConfigSchema.parse(await c.req.json());

  // An existing route is checked on its own grants; a route about to be created
  // on its destination folder or ingress node.
  const holds = (baseScope: string) =>
    proxyHostId
      ? hasScope(scopes, `${baseScope}:${proxyHostId}`)
      : hasProxyDestinationScope(scopes, baseScope, folderId, nodeId);
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
  const result =
    mode === 'advanced'
      ? await proxyService.validateAdvancedConfig(snippet, false, unrestricted, false, proxyHostId)
      : await proxyService.validateAdvancedConfig(snippet, true, false, unrestricted);
  return c.json({ data: result });
});
