import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  authMiddleware,
  requireAnyScopeBase,
  requireScopeBase,
  requireScopeForResource,
} from '@/modules/auth/auth.middleware.js';
import {
  domainNginxNodeOptionsForScopes,
  resolveDomainCreationNginxNodeId,
} from '@/modules/domains/domain-creation-access.js';
import { DomainFolderService } from '@/modules/domains/domain-folders.service.js';
import {
  assertCanPreviewDomainDestination,
  assertDomainCreationOnGroup,
  assertDomainPlacementAccess,
} from '@/modules/ingress-groups/ingress-group-operations.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import {
  assertFolderManage,
  assertFolderManageForFolder,
  assertFolderManageForFolders,
  assertFolderManageForResources,
} from '@/modules/resource-folders/resource-folder-access.js';
import { SSLService } from '@/modules/ssl/ssl.service.js';
import { SSLCertificateFolderService } from '@/modules/ssl/ssl-certificate-folders.service.js';
import type { AppEnv } from '@/types.js';
import {
  changeDomainIngressPlacementRoute,
  checkDomainDnsRoute,
  createDomainFolderRoute,
  createDomainRoute,
  deleteDomainFolderRoute,
  deleteDomainRoute,
  getDomainRoute,
  issueDomainCertificateRoute,
  listDomainFoldersRoute,
  listDomainNginxNodesRoute,
  listDomainsRoute,
  migrateDomainIngressRoute,
  moveDomainFolderRoute,
  moveDomainsToFolderRoute,
  previewDomainIngressMigrationRoute,
  previewDomainRoute,
  reorderDomainFoldersRoute,
  reorderDomainsRoute,
  resolveCloudflareMigrationRoute,
  searchDomainsRoute,
  updateDomainFolderRoute,
  updateDomainRoute,
} from './domain.docs.js';
import {
  CreateDomainSchema,
  DeleteDomainSchema,
  DomainIngressMigrationSchema,
  DomainIngressPlacementSchema,
  DomainListQuerySchema,
  IssueDomainCertificateSchema,
  PreviewDomainSchema,
  ResolveCloudflareMigrationSchema,
  UpdateDomainSchema,
} from './domain.schemas.js';
import { DomainsService } from './domain.service.js';

export const domainRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

domainRoutes.use('*', authMiddleware);

domainRoutes.openapi(
  {
    ...listDomainFoldersRoute,
    middleware: requireAnyScopeBase('domains:view', 'domains:folders:manage', 'domains:create'),
  },
  async (c) => {
    const service = container.resolve(DomainFolderService);
    const scopes = c.get('effectiveScopes') || [];
    const canManageFolders = hasScope(scopes, 'domains:folders:manage');
    const hasGlobalView = hasScope(scopes, 'domains:view');
    const hasGlobalCreate = hasScope(scopes, 'domains:create');
    const allowedFolderIds = getFolderScopedIds(scopes, [
      'domains:view',
      'domains:edit',
      'domains:create',
      'domains:folders:manage',
    ]);
    const data = await service.getFolderTree(
      canManageFolders || hasGlobalView || hasGlobalCreate
        ? { includeAllFolders: true }
        : { allowedResourceIds: getResourceScopedIds(scopes, 'domains:view'), allowedFolderIds }
    );
    return c.json({ data });
  }
);

domainRoutes.openapi(
  { ...createDomainFolderRoute, middleware: requireScopeBase('domains:folders:manage') },
  async (c) => {
    const service = container.resolve(DomainFolderService);
    const user = c.get('user')!;
    const input = CreateResourceFolderSchema.parse(await c.req.json());
    assertFolderManage(c.get('effectiveScopes') ?? [], 'domains:folders:manage', input.parentId ?? null);
    const data = await service.createFolder(input, user.id);
    return c.json({ data }, 201);
  }
);

domainRoutes.openapi(
  { ...reorderDomainFoldersRoute, middleware: requireScopeBase('domains:folders:manage') },
  async (c) => {
    const service = container.resolve(DomainFolderService);
    const input = ReorderResourceFoldersSchema.parse(await c.req.json());
    await assertFolderManageForFolders(
      service,
      c.get('effectiveScopes') ?? [],
      'domains:folders:manage',
      input.items.map((item) => item.id)
    );
    await service.reorderFolders(input);
    return c.json({ success: true });
  }
);

domainRoutes.openapi(
  { ...moveDomainsToFolderRoute, middleware: requireScopeBase('domains:folders:manage') },
  async (c) => {
    const service = container.resolve(DomainFolderService);
    const user = c.get('user')!;
    const input = MoveResourcesToFolderSchema.parse(await c.req.json());
    const scopes = c.get('effectiveScopes') ?? [];
    await assertFolderManageForResources(service, scopes, 'domains:folders:manage', input.ids, input.folderId);
    if (!input.ids.every((id) => hasScopeForResource(scopes, 'domains:edit', id))) {
      throw new AppError(403, 'FORBIDDEN', 'Missing domain edit access for one or more move sources');
    }
    if (!hasScopeForCreation(scopes, 'domains:edit', input.folderId)) {
      throw new AppError(403, 'FORBIDDEN', 'Missing domain edit access for the move destination');
    }
    await service.moveResourcesToFolder(input, user.id);
    return c.json({ success: true });
  }
);

domainRoutes.openapi({ ...reorderDomainsRoute, middleware: requireScopeBase('domains:folders:manage') }, async (c) => {
  const service = container.resolve(DomainFolderService);
  const input = ReorderResourcesSchema.parse(await c.req.json());
  await assertFolderManageForResources(
    service,
    c.get('effectiveScopes') ?? [],
    'domains:folders:manage',
    input.items.map((item) => item.id),
    undefined
  );
  await service.reorderResources(input);
  return c.json({ success: true });
});

domainRoutes.openapi(
  { ...updateDomainFolderRoute, middleware: requireScopeBase('domains:folders:manage') },
  async (c) => {
    const service = container.resolve(DomainFolderService);
    const user = c.get('user')!;
    const input = UpdateResourceFolderSchema.parse(await c.req.json());
    await assertFolderManageForFolder(
      service,
      c.get('effectiveScopes') ?? [],
      'domains:folders:manage',
      c.req.param('id')!
    );
    const data = await service.updateFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

domainRoutes.openapi(
  { ...moveDomainFolderRoute, middleware: requireScopeBase('domains:folders:manage') },
  async (c) => {
    const service = container.resolve(DomainFolderService);
    const user = c.get('user')!;
    const input = MoveResourceFolderSchema.parse(await c.req.json());
    const scopes = c.get('effectiveScopes') ?? [];
    const data = await service.moveFolder(
      c.req.param('id')!,
      input,
      user.id,
      { scopes, editScope: 'domains:edit' },
      { scopes, manageScope: 'domains:folders:manage' }
    );
    return c.json({ data });
  }
);

domainRoutes.openapi(
  { ...deleteDomainFolderRoute, middleware: requireScopeBase('domains:folders:manage') },
  async (c) => {
    const service = container.resolve(DomainFolderService);
    const user = c.get('user')!;
    await assertFolderManageForFolder(
      service,
      c.get('effectiveScopes') ?? [],
      'domains:folders:manage',
      c.req.param('id')!
    );
    await service.deleteFolder(c.req.param('id')!, user.id);
    return c.json({ success: true });
  }
);

// List domains (paginated)
domainRoutes.openapi({ ...listDomainsRoute, middleware: requireScopeBase('domains:view') }, async (c) => {
  const domainsService = container.resolve(DomainsService);
  const query = DomainListQuerySchema.parse({
    page: c.req.query('page'),
    limit: c.req.query('limit'),
    search: c.req.query('search'),
    dnsStatus: c.req.query('dnsStatus'),
    excludeAppMembers: c.req.query('excludeAppMembers'),
    appId: c.req.query('appId'),
  });
  const scopes = c.get('effectiveScopes') || [];
  const result = await domainsService.listDomains(
    query,
    hasScope(scopes, 'domains:view') ? undefined : { allowedIds: getResourceScopedIds(scopes, 'domains:view') }
  );
  return c.json(result);
});

// Autocomplete search (must be before /:id)
domainRoutes.openapi({ ...searchDomainsRoute, middleware: requireScopeBase('domains:view') }, async (c) => {
  const domainsService = container.resolve(DomainsService);
  const q = c.req.query('q') || '';
  const scopes = c.get('effectiveScopes') || [];
  const results = await domainsService.searchDomains(
    q,
    hasScope(scopes, 'domains:view') ? undefined : { allowedIds: getResourceScopedIds(scopes, 'domains:view') }
  );
  return c.json({ data: results });
});

// Creation helpers accept every domains:create grant form (broad, folder, node);
// the create call itself checks the chosen destination.
domainRoutes.openapi({ ...listDomainNginxNodesRoute, middleware: requireScopeBase('domains:create') }, async (c) => {
  const domainsService = container.resolve(DomainsService);
  const scopes = c.get('effectiveScopes') || [];
  const options = await domainsService.getNginxNodeOptions();
  return c.json({
    data: {
      ...domainNginxNodeOptionsForScopes(options, scopes),
      ingressGroups: await domainsService.getIngressGroupOptions(scopes, options),
    },
  });
});

// Preview domain DNS (must be before /:id)
domainRoutes.openapi({ ...previewDomainRoute, middleware: requireScopeBase('domains:create') }, async (c) => {
  const body = await c.req.json();
  const input = PreviewDomainSchema.parse(body);
  // The preview returns node hostnames and addresses: node-only creators may preview only on nodes of
  // their grant (and must name them; every member for an ingress group).
  await assertCanPreviewDomainDestination(c.get('effectiveScopes') || [], input);
  const domainsService = container.resolve(DomainsService);
  try {
    const preview = await domainsService.previewDomain(input);
    return c.json({ data: preview });
  } catch (err) {
    if (err instanceof AppError) {
      return c.json({ code: err.code, message: err.message, details: err.details }, err.statusCode as never);
    }
    return c.json({ code: 'ERROR', message: err instanceof Error ? err.message : 'Failed to preview domain' }, 400);
  }
});

// Get domain detail with usage
domainRoutes.openapi({ ...getDomainRoute, middleware: requireScopeForResource('domains:view', 'id') }, async (c) => {
  const domainsService = container.resolve(DomainsService);
  try {
    const domain = await domainsService.getDomain(c.req.param('id')!);
    return c.json({ data: domain });
  } catch {
    return c.json({ code: 'NOT_FOUND', message: 'Domain not found' }, 404);
  }
});

// Create domain
domainRoutes.openapi(createDomainRoute, async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json();
  const request = CreateDomainSchema.parse(body);
  const scopes = c.get('effectiveScopes') ?? [];
  const domainsService = container.resolve(DomainsService);
  // A node-limited creator that omits nginxNodeId gets its only granted ingress node (or the list).
  const nginxNodeId = await resolveDomainCreationNginxNodeId(scopes, request, () =>
    domainsService.getNginxNodeOptions()
  );
  const input = nginxNodeId && !request.ingressGroupId ? { ...request, nginxNodeId } : request;
  if (input.ingressGroupId) {
    // A domain on an ingress group is served by every member.
    await assertDomainCreationOnGroup(scopes, input.ingressGroupId, input.folderId);
  } else if (!hasScopeForCreation(scopes, 'domains:create', input.folderId, input.nginxNodeId)) {
    throw new AppError(403, 'FORBIDDEN', 'Missing domains:create permission for the selected destination');
  }
  await container.resolve(DomainFolderService).assertFolderExists(input.folderId);
  try {
    const domain = await domainsService.createDomain(input, user.id);
    return c.json({ data: domain }, 201);
  } catch (err) {
    if (err instanceof AppError) {
      return c.json({ code: err.code, message: err.message, details: err.details }, err.statusCode as never);
    }
    const msg = err instanceof Error ? err.message : 'Failed to create domain';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return c.json({ code: 'DUPLICATE', message: 'Domain already exists' }, 409);
    }
    return c.json({ code: 'ERROR', message: msg }, 400);
  }
});

// Update domain
domainRoutes.openapi({ ...updateDomainRoute, middleware: requireScopeForResource('domains:edit', 'id') }, async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json();
  const input = UpdateDomainSchema.parse(body);
  const domainsService = container.resolve(DomainsService);
  if (input.ingressGroupId !== undefined)
    await assertDomainPlacementAccess(c.get('effectiveScopes') || [], c.req.param('id')!, input);
  try {
    const domain = await domainsService.updateDomain(c.req.param('id')!, input, user.id);
    return c.json({ data: domain });
  } catch (err) {
    if (err instanceof AppError) {
      return c.json({ code: err.code, message: err.message, details: err.details }, err.statusCode as never);
    }
    return c.json({ code: 'ERROR', message: err instanceof Error ? err.message : 'Failed to update domain' }, 400);
  }
});

// Delete domain
domainRoutes.openapi(
  { ...deleteDomainRoute, middleware: requireScopeForResource('domains:delete', 'id') },
  async (c) => {
    const user = c.get('user')!;
    const domainsService = container.resolve(DomainsService);
    try {
      const rawBody = await c.req.text();
      const input = rawBody ? DeleteDomainSchema.parse(JSON.parse(rawBody)) : {};
      await domainsService.deleteDomain(c.req.param('id')!, user.id, input);
      return c.json({ data: { success: true } });
    } catch (err) {
      if (err instanceof AppError) {
        return c.json({ code: err.code, message: err.message, details: err.details }, err.statusCode as never);
      }
      if (err instanceof SyntaxError) {
        return c.json({ code: 'BAD_REQUEST', message: 'Malformed JSON in request body' }, 400);
      }
      return c.json({ code: 'ERROR', message: err instanceof Error ? err.message : 'Failed to delete domain' }, 400);
    }
  }
);

// Manual DNS check
domainRoutes.openapi(
  { ...checkDomainDnsRoute, middleware: requireScopeForResource('domains:edit', 'id') },
  async (c) => {
    const domainsService = container.resolve(DomainsService);
    try {
      // `repair=false` (the detail dialog's check on open) is read-only: it never rewrites provider records.
      const repair = c.req.query('repair') !== 'false';
      const domain = await domainsService.checkDns(c.req.param('id')!, { repair });
      return c.json({ data: domain });
    } catch {
      return c.json({ code: 'NOT_FOUND', message: 'Domain not found' }, 404);
    }
  }
);

domainRoutes.openapi(
  { ...resolveCloudflareMigrationRoute, middleware: requireScopeForResource('domains:edit', 'id') },
  async (c) => {
    const user = c.get('user')!;
    const input = ResolveCloudflareMigrationSchema.parse(await c.req.json());
    const domainsService = container.resolve(DomainsService);
    try {
      return c.json({
        data: await domainsService.resolveCloudflareMigration(
          c.req.param('id')!,
          input,
          user.id,
          c.get('effectiveScopes') || []
        ),
      });
    } catch (err) {
      if (err instanceof AppError) {
        return c.json({ code: err.code, message: err.message, details: err.details }, err.statusCode as never);
      }
      return c.json(
        { code: 'ERROR', message: err instanceof Error ? err.message : 'Failed to resolve Cloudflare migration' },
        400
      );
    }
  }
);

domainRoutes.openapi(
  { ...previewDomainIngressMigrationRoute, middleware: requireScopeForResource('domains:edit', 'id') },
  async (c) => {
    const input = DomainIngressMigrationSchema.parse(await c.req.json());
    const domainsService = container.resolve(DomainsService);
    try {
      return c.json({ data: await domainsService.previewIngressMigration(c.req.param('id')!, input) });
    } catch (err) {
      if (err instanceof AppError) {
        return c.json({ code: err.code, message: err.message, details: err.details }, err.statusCode as never);
      }
      return c.json(
        { code: 'ERROR', message: err instanceof Error ? err.message : 'Failed to preview ingress migration' },
        400
      );
    }
  }
);

domainRoutes.openapi(
  { ...migrateDomainIngressRoute, middleware: requireScopeForResource('domains:edit', 'id') },
  async (c) => {
    const user = c.get('user')!;
    const input = DomainIngressMigrationSchema.parse(await c.req.json());
    const domainsService = container.resolve(DomainsService);
    try {
      return c.json({
        data: await domainsService.migrateIngress(c.req.param('id')!, input, user.id, c.get('effectiveScopes') || []),
      });
    } catch (err) {
      if (err instanceof AppError) {
        return c.json({ code: err.code, message: err.message, details: err.details }, err.statusCode as never);
      }
      return c.json({ code: 'ERROR', message: err instanceof Error ? err.message : 'Failed to migrate ingress' }, 400);
    }
  }
);

domainRoutes.openapi(
  { ...changeDomainIngressPlacementRoute, middleware: requireScopeForResource('domains:edit', 'id') },
  async (c) => {
    const id = c.req.param('id')!;
    const input = DomainIngressPlacementSchema.parse(await c.req.json());
    await assertDomainPlacementAccess(c.get('effectiveScopes') || [], id, input);
    const data = await container.resolve(DomainsService).changeDomainIngressPlacement(id, input, c.get('user')!.id);
    return c.json({ data });
  }
);

// Issue ACME cert for domain. Issuing changes nothing on the domain, so viewing it is enough.
domainRoutes.openapi(
  { ...issueDomainCertificateRoute, middleware: requireScopeForResource('domains:view', 'id') },
  async (c) => {
    const user = c.get('user')!;
    const domainsService = container.resolve(DomainsService);
    const sslService = container.resolve(SSLService);
    let folderId: string | null | undefined;
    try {
      const rawBody = await c.req.text();
      folderId = rawBody ? IssueDomainCertificateSchema.parse(JSON.parse(rawBody)).folderId : undefined;
    } catch {
      return c.json({ code: 'BAD_REQUEST', message: 'Invalid request body' }, 400);
    }
    // The certificate is a new SSL resource: the caller needs ssl:cert:issue on
    // the SSL certificate folder it lands in (or broadly for the root).
    if (!hasScopeForCreation(c.get('effectiveScopes') || [], 'ssl:cert:issue', folderId)) {
      throw new AppError(403, 'FORBIDDEN', 'Missing ssl:cert:issue permission for the selected certificate folder', {
        requiredScope: folderId ? `ssl:cert:issue:folder/${folderId}` : 'ssl:cert:issue',
      });
    }
    await container.resolve(SSLCertificateFolderService).assertFolderExists(folderId);

    let domainRow: Awaited<ReturnType<DomainsService['getDomain']>> | undefined;
    try {
      domainRow = await domainsService.getDomain(c.req.param('id')!);
    } catch {
      return c.json({ code: 'NOT_FOUND', message: 'Domain not found' }, 404);
    }

    try {
      const cert = await sslService.requestACMECert(
        {
          domains: [domainRow.domain],
          challengeType: domainRow.dnsProvider === 'cloudflare' ? 'dns-01' : 'http-01',
          provider: 'letsencrypt',
          autoRenew: true,
          ...(domainRow.dnsProvider === 'cloudflare' ? { dnsProvider: 'cloudflare' as const } : {}),
          folderId: folderId ?? null,
        },
        user.id,
        user.email
      );
      // Like every other certificate creation: the issuer keeps sight of the new certificate.
      await grantCreatedResourcePermissions(user.id, 'ssl:cert', cert.certificate.id, { folderId: folderId ?? null });
      return c.json({ data: cert }, 201);
    } catch (err) {
      return c.json({ code: 'CERT_ERROR', message: err instanceof Error ? err.message : 'Failed to issue cert' }, 400);
    }
  }
);
