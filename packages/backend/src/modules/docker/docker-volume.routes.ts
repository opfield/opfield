import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { container } from '@/container.js';
import { hasScopeBase } from '@/lib/permissions.js';
import { sanitizeFilename } from '@/lib/utils.js';
import { requireAnyScopeBase } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { assertComposeVolumeMutationAllowed } from './compose/compose-child.guard.js';
import { isComposeOwnedVolume } from './compose/compose-discovery.service.js';
import {
  abortVolumeFileUploadRoute,
  adoptVolumeRoute,
  completeVolumeFileUploadRoute,
  createVolumeDirectoryRoute,
  createVolumeFileRoute,
  createVolumeRoute,
  deleteVolumeFileRoute,
  exportVolumeRoute,
  getVolumeMetricsRoute,
  initVolumeFileUploadRoute,
  inspectVolumeRoute,
  listManagedVolumeOptionsRoute,
  listVolumeFilesRoute,
  listVolumesRoute,
  moveVolumeFileRoute,
  readVolumeFileRoute,
  removeVolumeRoute,
  renameVolumeRoute,
  resizeVolumeRoute,
  updateVolumeLabelsRoute,
  uploadVolumeFileChunkRoute,
  writeVolumeFileRoute,
} from './docker.docs.js';
import {
  FileBrowseSchema,
  FileMoveSchema,
  FileUploadChunkQuerySchema,
  FileUploadCompleteSchema,
  FileUploadInitSchema,
  VolumeCreateSchema,
  VolumeLabelsUpdateSchema,
  VolumeRenameSchema,
  VolumeResizeSchema,
} from './docker.schemas.js';
import { DockerManagementService } from './docker.service.js';
import { assertDockerResourceScope, filterDockerResourcesForScope } from './docker-access.middleware.js';
import { hasDockerResourceScope } from './docker-access-resource.service.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';
import { DOCKER_VOLUME_EDIT_SCOPE } from './docker-volume-access.js';
import {
  assertSnapshotVolumeVisible,
  getDockerVolumeMetricsSnapshot,
  inspectDockerVolumeSnapshot,
} from './docker-volume-snapshot-reads.js';

export { normalizeVolumeDetailItem } from './docker-volume-snapshot-reads.js';

const DOCKER_RESOURCE_LIST_MAX = 1000;
const DOCKER_VOLUME_USED_BY_PREVIEW_MAX = 100;

/**
 * Scope checks alone are not enough: a caller with broad volume scopes must
 * still not reach Opfield's own volumes, which listVolumes hides. Live routes
 * verify against the daemon; snapshot-served routes verify against the cached
 * inventory so they keep working while a node is offline.
 */
function requireDockerVolumeScope(
  baseScope: string,
  visibility: 'live' | 'snapshot' | 'handler' = 'live'
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const nodeId = c.req.param('nodeId');
    const name = c.req.param('name');
    if (!nodeId || !name) throw new HTTPException(403, { message: `Missing required scope: ${baseScope}` });
    assertDockerResourceScope(c.get('effectiveScopes') ?? [], baseScope, nodeId, name);
    if (visibility === 'live') {
      await container.resolve(DockerManagementService).assertUserVolumeVisible(nodeId, name);
    } else if (visibility === 'snapshot') {
      await assertSnapshotVolumeVisible(nodeId, name);
    }
    await next();
  };
}

export function compactVolumeListItem(volume: Record<string, any>) {
  const usedBy = volume.usedBy ?? volume.UsedBy;
  return {
    name: volume.name ?? volume.Name,
    driver: volume.driver ?? volume.Driver,
    mountpoint: volume.mountpoint ?? volume.Mountpoint,
    scope: volume.scope ?? volume.Scope,
    managementState: volume.managementState,
    storageKind: volume.storageKind,
    capacityBytes: volume.capacityBytes,
    usedBytes: volume.usedBytes ?? null,
    adoptable: Boolean(volume.adoptable),
    adoptionReason: volume.adoptionReason,
    availability: volume.availability,
    createdAt: volume.createdAt ?? volume.CreatedAt,
    usedBy: Array.isArray(usedBy) ? usedBy.slice(0, DOCKER_VOLUME_USED_BY_PREVIEW_MAX) : usedBy,
    usedByCount: Array.isArray(usedBy) ? usedBy.length : undefined,
    usedByTruncated: Array.isArray(usedBy) && usedBy.length > DOCKER_VOLUME_USED_BY_PREVIEW_MAX,
    scopeResourceId: volume.scopeResourceId ?? volume.name ?? volume.Name ?? null,
    folderId: volume.folderId ?? null,
    folderIsSystem: volume.folderIsSystem ?? false,
    folderSortOrder: volume.folderSortOrder ?? 0,
  };
}

export function matchesVolumeSearch(volume: Record<string, any>, search: string | undefined) {
  if (!search) return true;
  const usedBy = volume.usedBy ?? volume.UsedBy;
  const haystack = [
    volume.name ?? volume.Name,
    volume.driver ?? volume.Driver,
    volume.mountpoint ?? volume.Mountpoint,
    volume.scope ?? volume.Scope,
    ...(Array.isArray(usedBy) ? usedBy : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(search);
}

async function parseFileContentRequest(c: Parameters<Parameters<OpenAPIHono<AppEnv>['openapi']>[1]>[0]) {
  const path = FileBrowseSchema.parse(c.req.query()).path;
  const content = Buffer.from(await c.req.arrayBuffer());
  return { path, content };
}

export function registerVolumeRoutes(router: OpenAPIHono<AppEnv>) {
  // ─── Volume routes ───────────────────────────────────────────────────

  // The managed volumes the caller may attach: a volume is attached with docker:volumes:view on it. Holders of
  // docker:containers:mounts keep the route and get the volumes they can view.
  router.openapi(
    {
      ...listManagedVolumeOptionsRoute,
      middleware: requireAnyScopeBase('docker:volumes:view', 'docker:containers:mounts'),
    },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const scopes = c.get('effectiveScopes') ?? [];
      const rows = await service.listManagedVolumeOptions(nodeId);
      return c.json({
        data: rows.filter((row) => hasDockerResourceScope(scopes, 'docker:volumes:view', nodeId, row.name)),
      });
    }
  );

  // List volumes
  router.openapi(listVolumesRoute, async (c) => {
    const snapshots = container.resolve(DockerSnapshotService);
    const nodeId = c.req.param('nodeId')!;
    const scopes = c.get('effectiveScopes') ?? [];
    if (!hasScopeBase(scopes, 'docker:volumes:view')) {
      throw new HTTPException(403, { message: 'Missing required scope: docker:volumes:view' });
    }
    await snapshots.assertDockerNode(nodeId);
    const snapshot = await snapshots.getList<any[]>(nodeId, 'volumes');
    const containerSnapshot = await snapshots.getList<any[]>(nodeId, 'containers');
    const data = await container
      .resolve(DockerManagementService)
      .decoratePublicVolumeSnapshot(
        nodeId,
        Array.isArray(snapshot.data) ? snapshot.data : [],
        Array.isArray(containerSnapshot.data) ? containerSnapshot.data : []
      );
    if (!Array.isArray(data)) return c.json({ data });
    const metrics = await snapshots.getDetails<{ usedBytes?: number | null }>(nodeId, 'volume-metrics');
    const search = c.req.query('search')?.trim().toLowerCase();
    const compacted = filterDockerResourcesForScope(
      data
        .filter((item) => !isComposeOwnedVolume(item))
        .filter((item) => matchesVolumeSearch(item, search))
        .map((item) => {
          const name = String(item.name ?? item.Name ?? '');
          return {
            ...compactVolumeListItem({ ...item, usedBytes: metrics[name]?.data?.usedBytes ?? null }),
            nodeId,
            availability: snapshots.availability(nodeId, snapshot),
          };
        }),
      scopes,
      'docker:volumes:view',
      nodeId
    );
    const truncated = compacted.length > DOCKER_RESOURCE_LIST_MAX;
    return c.json({
      data: truncated ? compacted.slice(0, DOCKER_RESOURCE_LIST_MAX) : compacted,
      total: compacted.length,
      limit: DOCKER_RESOURCE_LIST_MAX,
      truncated,
    });
  });

  // Inspect volume
  router.openapi(
    // The handler applies the public volume visibility to the cached detail.
    { ...inspectVolumeRoute, middleware: requireDockerVolumeScope('docker:volumes:view', 'handler') },
    async (c) => {
      const data = await inspectDockerVolumeSnapshot(c.req.param('nodeId')!, c.req.param('name')!);
      return c.json({ data });
    }
  );

  // List volume files
  router.openapi(
    { ...listVolumeFilesRoute, middleware: requireDockerVolumeScope('docker:volumes:files:read') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const rawQuery = Object.fromEntries(new URL(c.req.url).searchParams.entries());
      const { path } = FileBrowseSchema.parse(rawQuery);
      const data = await service.listVolumeFiles(nodeId, name, path);
      return c.json({ data });
    }
  );

  router.openapi(
    { ...readVolumeFileRoute, middleware: requireDockerVolumeScope('docker:volumes:files:read') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const rawQuery = Object.fromEntries(new URL(c.req.url).searchParams.entries());
      const { path } = FileBrowseSchema.parse(rawQuery);
      const data = await service.readVolumeFile(nodeId, name, path);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(data.byteLength),
        },
      });
    }
  );

  router.openapi(
    { ...writeVolumeFileRoute, middleware: requireDockerVolumeScope('docker:volumes:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { path, content } = await parseFileContentRequest(c);
      await service.writeVolumeFile(nodeId, name, path, content, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...createVolumeFileRoute, middleware: requireDockerVolumeScope('docker:volumes:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { path, content } = await parseFileContentRequest(c);
      await service.createVolumeFile(nodeId, name, path, content, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...initVolumeFileUploadRoute, middleware: requireDockerVolumeScope('docker:volumes:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { path, totalBytes } = FileUploadInitSchema.parse(await c.req.json());
      const data = await service.initVolumeFileUpload(nodeId, name, path, totalBytes, user.id);
      return c.json({ data });
    }
  );

  router.openapi(
    { ...uploadVolumeFileChunkRoute, middleware: requireDockerVolumeScope('docker:volumes:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const uploadId = c.req.param('uploadId')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { offset } = FileUploadChunkQuerySchema.parse(c.req.query());
      const content = Buffer.from(await c.req.arrayBuffer());
      const data = await service.appendVolumeFileUploadChunk(nodeId, name, uploadId, offset, content);
      return c.json({ data });
    }
  );

  router.openapi(
    { ...completeVolumeFileUploadRoute, middleware: requireDockerVolumeScope('docker:volumes:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const uploadId = c.req.param('uploadId')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { path, totalBytes } = FileUploadCompleteSchema.parse(await c.req.json());
      await service.completeVolumeFileUpload(nodeId, name, uploadId, path, totalBytes);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...abortVolumeFileUploadRoute, middleware: requireDockerVolumeScope('docker:volumes:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const uploadId = c.req.param('uploadId')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      await service.abortVolumeFileUpload(nodeId, name, uploadId);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...createVolumeDirectoryRoute, middleware: requireDockerVolumeScope('docker:volumes:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { path } = FileBrowseSchema.parse(await c.req.json());
      await service.createVolumeDirectory(nodeId, name, path, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...deleteVolumeFileRoute, middleware: requireDockerVolumeScope('docker:volumes:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const rawQuery = Object.fromEntries(new URL(c.req.url).searchParams.entries());
      const { path } = FileBrowseSchema.parse(rawQuery);
      await service.deleteVolumeFile(nodeId, name, path, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...moveVolumeFileRoute, middleware: requireDockerVolumeScope('docker:volumes:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { fromPath, toPath } = FileMoveSchema.parse(await c.req.json());
      await service.moveVolumeFile(nodeId, name, fromPath, toPath, user.id);
      return c.json({ success: true });
    }
  );

  // Export volume
  router.openapi({ ...exportVolumeRoute, middleware: requireDockerVolumeScope('docker:volumes:export') }, async (c) => {
    const service = container.resolve(DockerManagementService);
    const nodeId = c.req.param('nodeId')!;
    const name = c.req.param('name')!;
    const data = await service.exportVolume(nodeId, name);
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${sanitizeFilename(name)}.tar.gz"`,
      },
    });
  });

  // Rename volume
  router.openapi(
    { ...renameVolumeRoute, middleware: requireDockerVolumeScope(DOCKER_VOLUME_EDIT_SCOPE) },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const body = await c.req.json();
      const { name: newName } = VolumeRenameSchema.parse(body);
      await service.renameVolume(nodeId, name, newName, user.id);
      return c.json({ success: true });
    }
  );

  // Update volume labels
  router.openapi(
    { ...updateVolumeLabelsRoute, middleware: requireDockerVolumeScope(DOCKER_VOLUME_EDIT_SCOPE) },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const body = await c.req.json();
      const { labels } = VolumeLabelsUpdateSchema.parse(body);
      await service.updateVolumeLabels(nodeId, name, labels, user.id);
      return c.json({ success: true });
    }
  );

  // Create volume
  router.openapi(createVolumeRoute, async (c) => {
    const service = container.resolve(DockerManagementService);
    const nodeId = c.req.param('nodeId')!;
    const user = c.get('user')!;
    const body = await c.req.json();
    const config = VolumeCreateSchema.parse(body);
    const data = await service.createVolume(nodeId, config, user.id, c.get('effectiveScopes') ?? []);
    return c.json({ data }, 201);
  });

  router.openapi(
    { ...getVolumeMetricsRoute, middleware: requireDockerVolumeScope('docker:volumes:view', 'snapshot') },
    async (c) => {
      const data = await getDockerVolumeMetricsSnapshot(c.req.param('nodeId')!, c.req.param('name')!);
      return c.json({ data });
    }
  );

  router.openapi(
    { ...resizeVolumeRoute, middleware: requireDockerVolumeScope(DOCKER_VOLUME_EDIT_SCOPE) },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { capacityBytes } = VolumeResizeSchema.parse(await c.req.json());
      await service.resizeVolume(nodeId, name, capacityBytes, user.id);
      return c.json({ success: true });
    }
  );

  // Adopt volume
  router.openapi({ ...adoptVolumeRoute, middleware: requireDockerVolumeScope(DOCKER_VOLUME_EDIT_SCOPE) }, async (c) => {
    const service = container.resolve(DockerManagementService);
    const nodeId = c.req.param('nodeId')!;
    const name = c.req.param('name')!;
    const user = c.get('user')!;
    assertDockerResourceScope(c.get('effectiveScopes') ?? [], 'docker:volumes:view', nodeId, name);
    await assertComposeVolumeMutationAllowed(nodeId, name);
    const data = await service.adoptVolume(nodeId, name, user.id);
    return c.json({ data });
  });

  // Remove volume
  router.openapi({ ...removeVolumeRoute, middleware: requireDockerVolumeScope('docker:volumes:delete') }, async (c) => {
    const service = container.resolve(DockerManagementService);
    const nodeId = c.req.param('nodeId')!;
    const name = c.req.param('name')!;
    const user = c.get('user')!;
    await assertComposeVolumeMutationAllowed(nodeId, name);
    const force = c.req.query('force') === 'true';
    await service.removeVolume(nodeId, name, force, user.id);
    return c.json({ success: true });
  });
}
