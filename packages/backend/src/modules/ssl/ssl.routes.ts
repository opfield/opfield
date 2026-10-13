import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { appForMember } from '@/modules/apps/app-membership.js';
import {
  authMiddleware,
  requireAnyScopeBase,
  requireScopeBase,
  requireScopeForResource,
} from '@/modules/auth/auth.middleware.js';
import { assertTlsResyncAccess } from '@/modules/proxy/tls-resync-access.js';
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
import type { AppEnv } from '@/types.js';
import {
  cancelPendingAcmeCertificateRoute,
  createSslCertificateFolderRoute,
  deleteSslCertificateFolderRoute,
  deleteSslCertificateRoute,
  getSslCertificateRoute,
  linkInternalSslCertificateRoute,
  listSslCertificateFoldersRoute,
  listSslCertificatesRoute,
  moveSslCertificateFolderRoute,
  moveSslCertificatesToFolderRoute,
  renewSslCertificateRoute,
  reorderSslCertificateFoldersRoute,
  reorderSslCertificatesRoute,
  requestAcmeCertificateRoute,
  resyncSslCertificateDistributionRoute,
  setSslCertificateAutoRenewRoute,
  updateSslCertificateFolderRoute,
  uploadSslCertificateRoute,
  verifyDnsSslCertificateRoute,
} from './ssl.docs.js';
import {
  LinkInternalCertSchema,
  RequestACMECertSchema,
  SetSslAutoRenewSchema,
  SSLCertListQuerySchema,
  UploadCertSchema,
} from './ssl.schemas.js';
import { SSLService } from './ssl.service.js';
import { SSLCertificateFolderService } from './ssl-certificate-folders.service.js';

export const sslRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

sslRoutes.use('*', authMiddleware);

sslRoutes.openapi(
  {
    ...listSslCertificateFoldersRoute,
    middleware: requireAnyScopeBase('ssl:cert:view', 'ssl:cert:folders:manage', 'ssl:cert:issue'),
  },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    const scopes = c.get('effectiveScopes') || [];
    const canManageFolders = hasScope(scopes, 'ssl:cert:folders:manage');
    const hasGlobalView = hasScope(scopes, 'ssl:cert:view');
    const hasGlobalCreate = hasScope(scopes, 'ssl:cert:issue');
    const allowedFolderIds = getFolderScopedIds(scopes, [
      'ssl:cert:view',
      'ssl:cert:issue',
      'ssl:cert:renew',
      'ssl:cert:delete',
      'ssl:cert:folders:manage',
    ]);
    const data = await service.getFolderTree(
      canManageFolders || hasGlobalView || hasGlobalCreate
        ? { includeAllFolders: true }
        : { allowedResourceIds: getResourceScopedIds(scopes, 'ssl:cert:view'), allowedFolderIds }
    );
    return c.json({ data });
  }
);

sslRoutes.openapi(
  { ...createSslCertificateFolderRoute, middleware: requireScopeBase('ssl:cert:folders:manage') },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    const input = CreateResourceFolderSchema.parse(await c.req.json());
    assertFolderManage(c.get('effectiveScopes') ?? [], 'ssl:cert:folders:manage', input.parentId ?? null);
    const data = await service.createFolder(input, c.get('user')!.id);
    return c.json({ data }, 201);
  }
);

sslRoutes.openapi(
  { ...reorderSslCertificateFoldersRoute, middleware: requireScopeBase('ssl:cert:folders:manage') },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    const input = ReorderResourceFoldersSchema.parse(await c.req.json());
    await assertFolderManageForFolders(
      service,
      c.get('effectiveScopes') ?? [],
      'ssl:cert:folders:manage',
      input.items.map((item) => item.id)
    );
    await service.reorderFolders(input);
    return c.json({ success: true });
  }
);

sslRoutes.openapi(
  { ...moveSslCertificatesToFolderRoute, middleware: requireScopeBase('ssl:cert:folders:manage') },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    const input = MoveResourcesToFolderSchema.parse(await c.req.json());
    const scopes = c.get('effectiveScopes') ?? [];
    await assertFolderManageForResources(service, scopes, 'ssl:cert:folders:manage', input.ids, input.folderId);
    if (!input.ids.every((id) => hasScopeForResource(scopes, 'ssl:cert:issue', id))) {
      throw new AppError(403, 'FORBIDDEN', 'Missing SSL certificate issue access for one or more move sources');
    }
    if (!hasScopeForCreation(scopes, 'ssl:cert:issue', input.folderId)) {
      throw new AppError(403, 'FORBIDDEN', 'Missing SSL certificate issue access for the move destination');
    }
    await service.moveResourcesToFolder(input, c.get('user')!.id);
    return c.json({ success: true });
  }
);

sslRoutes.openapi(
  { ...reorderSslCertificatesRoute, middleware: requireScopeBase('ssl:cert:folders:manage') },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    const input = ReorderResourcesSchema.parse(await c.req.json());
    await assertFolderManageForResources(
      service,
      c.get('effectiveScopes') ?? [],
      'ssl:cert:folders:manage',
      input.items.map((item) => item.id),
      undefined
    );
    await service.reorderResources(input);
    return c.json({ success: true });
  }
);

sslRoutes.openapi(
  { ...updateSslCertificateFolderRoute, middleware: requireScopeBase('ssl:cert:folders:manage') },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    await assertFolderManageForFolder(
      service,
      c.get('effectiveScopes') ?? [],
      'ssl:cert:folders:manage',
      c.req.param('id')!
    );
    const data = await service.updateFolder(
      c.req.param('id')!,
      UpdateResourceFolderSchema.parse(await c.req.json()),
      c.get('user')!.id
    );
    return c.json({ data });
  }
);

sslRoutes.openapi(
  { ...moveSslCertificateFolderRoute, middleware: requireScopeBase('ssl:cert:folders:manage') },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    const data = await service.moveFolder(
      c.req.param('id')!,
      MoveResourceFolderSchema.parse(await c.req.json()),
      c.get('user')!.id,
      { scopes: c.get('effectiveScopes') ?? [], editScope: 'ssl:cert:issue' },
      { scopes: c.get('effectiveScopes') ?? [], manageScope: 'ssl:cert:folders:manage' }
    );
    return c.json({ data });
  }
);

sslRoutes.openapi(
  { ...deleteSslCertificateFolderRoute, middleware: requireScopeBase('ssl:cert:folders:manage') },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    await assertFolderManageForFolder(
      service,
      c.get('effectiveScopes') ?? [],
      'ssl:cert:folders:manage',
      c.req.param('id')!
    );
    await service.deleteFolder(c.req.param('id')!, c.get('user')!.id);
    return c.json({ success: true });
  }
);

// List SSL certificates (paginated, filterable)
sslRoutes.openapi({ ...listSslCertificatesRoute, middleware: requireScopeBase('ssl:cert:view') }, async (c) => {
  const sslService = container.resolve(SSLService);
  const query = SSLCertListQuerySchema.parse({
    page: c.req.query('page'),
    limit: c.req.query('limit'),
    type: c.req.query('type'),
    status: c.req.query('status'),
    search: c.req.query('search'),
    showSystem: c.req.query('showSystem'),
    excludeAppMembers: c.req.query('excludeAppMembers'),
    appId: c.req.query('appId'),
  });
  const scopes = c.get('effectiveScopes') || [];
  if (query.showSystem && !hasScope(scopes, 'admin:details:certificates')) {
    return c.json({ code: 'FORBIDDEN', message: 'Missing required scope: admin:details:certificates' }, 403);
  }
  const result = await sslService.listCerts(
    query,
    hasScope(scopes, 'ssl:cert:view') ? undefined : { allowedIds: getResourceScopedIds(scopes, 'ssl:cert:view') }
  );
  return c.json(result);
});

// Get SSL certificate detail
sslRoutes.openapi(
  { ...getSslCertificateRoute, middleware: requireScopeForResource('ssl:cert:view', 'id') },
  async (c) => {
    const sslService = container.resolve(SSLService);
    const id = c.req.param('id')!;
    const cert = await sslService.getCert(id);
    return c.json({ data: { ...cert, app: await appForMember({ type: 'certificate', id }) } });
  }
);

// Request ACME certificate
sslRoutes.openapi(requestAcmeCertificateRoute, async (c) => {
  const sslService = container.resolve(SSLService);
  const user = c.get('user')!;
  const body = await c.req.json();
  const input = RequestACMECertSchema.parse(body);
  if (!hasScopeForCreation(c.get('effectiveScopes') ?? [], 'ssl:cert:issue', input.folderId)) {
    throw new AppError(403, 'FORBIDDEN', 'Missing ssl:cert:issue permission for the selected destination');
  }
  await container.resolve(SSLCertificateFolderService).assertFolderExists(input.folderId);
  const result = await sslService.requestACMECert(input, user.id, user.email);
  await grantCreatedResourcePermissions(user.id, 'ssl:cert', result.certificate.id, { folderId: input.folderId });
  return c.json({ data: result }, 201);
});

// Upload certificate
sslRoutes.openapi(uploadSslCertificateRoute, async (c) => {
  const sslService = container.resolve(SSLService);
  const user = c.get('user')!;
  const body = await c.req.json();
  const input = UploadCertSchema.parse(body);
  if (!hasScopeForCreation(c.get('effectiveScopes') ?? [], 'ssl:cert:issue', input.folderId)) {
    throw new AppError(403, 'FORBIDDEN', 'Missing ssl:cert:issue permission for the selected destination');
  }
  await container.resolve(SSLCertificateFolderService).assertFolderExists(input.folderId);
  const cert = await sslService.uploadCert(input, user.id);
  await grantCreatedResourcePermissions(user.id, 'ssl:cert', cert.id, { folderId: input.folderId });
  return c.json({ data: cert }, 201);
});

// Link internal CA certificate
sslRoutes.openapi(linkInternalSslCertificateRoute, async (c) => {
  const sslService = container.resolve(SSLService);
  const user = c.get('user')!;
  const body = await c.req.json();
  const input = LinkInternalCertSchema.parse(body);
  if (!hasScopeForCreation(c.get('effectiveScopes') ?? [], 'ssl:cert:issue', input.folderId)) {
    throw new AppError(403, 'FORBIDDEN', 'Missing ssl:cert:issue permission for the selected destination');
  }
  await container.resolve(SSLCertificateFolderService).assertFolderExists(input.folderId);
  const cert = await sslService.linkInternalCert(input, user.id, c.get('effectiveScopes') ?? []);
  await grantCreatedResourcePermissions(user.id, 'ssl:cert', cert.id, { folderId: input.folderId });
  return c.json({ data: cert }, 201);
});

// Manual renew. Renewal and the per-certificate ACME steps below need ssl:cert:renew on the certificate, which
// ssl:cert:issue still implies.
sslRoutes.openapi(
  { ...renewSslCertificateRoute, middleware: requireScopeForResource('ssl:cert:renew', 'id') },
  async (c) => {
    const sslService = container.resolve(SSLService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    const cert = await sslService.renewCert(id, user.id, user.email, {
      actorScopes: c.get('effectiveScopes') ?? [],
    });
    return c.json({ data: cert });
  }
);

sslRoutes.openapi(
  { ...setSslCertificateAutoRenewRoute, middleware: requireScopeForResource('ssl:cert:renew', 'id') },
  async (c) => {
    const sslService = container.resolve(SSLService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    const body = await c.req.json();
    const input = SetSslAutoRenewSchema.parse(body);
    const cert = await sslService.setAutoRenew(id, input, user.id);
    return c.json({ data: cert });
  }
);

// Complete DNS-01 verification
sslRoutes.openapi(
  { ...verifyDnsSslCertificateRoute, middleware: requireScopeForResource('ssl:cert:renew', 'id') },
  async (c) => {
    const sslService = container.resolve(SSLService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    const cert = await sslService.completeDNS01Verification(id, user.id, { contactEmail: user.email });
    return c.json({ data: cert });
  }
);

sslRoutes.openapi(
  { ...cancelPendingAcmeCertificateRoute, middleware: requireScopeForResource('ssl:cert:renew', 'id') },
  async (c) => {
    const sslService = container.resolve(SSLService);
    const user = c.get('user')!;
    await sslService.cancelPendingAcmeIssue(c.req.param('id')!, user.id);
    return c.body(null, 204);
  }
);

// Re-delivering a certificate to its nodes is a certificate issue action on that
// certificate; it never exposes certificate material. System certificates stay
// admin:update only, and admin:update is still accepted for one release (rc.9).
sslRoutes.openapi(resyncSslCertificateDistributionRoute, async (c) => {
  const id = c.req.param('id')!;
  await assertTlsResyncAccess(c.get('effectiveScopes') || [], 'certificate', id);
  const sslService = container.resolve(SSLService);
  const user = c.get('user')!;
  const result = await sslService.resyncDistribution(id, user.id);
  return c.json({ data: result });
});

// Delete SSL certificate
sslRoutes.openapi(
  { ...deleteSslCertificateRoute, middleware: requireScopeForResource('ssl:cert:delete', 'id') },
  async (c) => {
    const sslService = container.resolve(SSLService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    await sslService.deleteCert(id, user.id);
    return c.body(null, 204);
  }
);
