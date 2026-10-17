import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { container } from '@/container.js';
import { hasScopeBase } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import {
  listImagesRoute,
  pruneImagesRoute,
  pullImageRoute,
  pullImageSyncRoute,
  removeImageRoute,
} from './docker.docs.js';
import { ImagePullSchema } from './docker.schemas.js';
import { DockerManagementService } from './docker.service.js';
import { assertDockerResourceScope, filterDockerResourcesForScope } from './docker-access.middleware.js';
import { filterOpfieldInternalImages } from './docker-internal-images.js';
import { DockerRegistryService } from './docker-registry.service.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';

const DOCKER_RESOURCE_LIST_MAX = 1000;
const DOCKER_IMAGE_REF_PREVIEW_MAX = 20;

function requireDockerImageScope(baseScope: string, imageParam = 'imageId'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const nodeId = c.req.param('nodeId');
    const imageId = c.req.param(imageParam);
    if (!nodeId || !imageId) throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${baseScope}`);
    assertDockerResourceScope(c.get('effectiveScopes') ?? [], baseScope, nodeId, imageId);
    await next();
  };
}

function requireDockerImageNodeScope(baseScope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const nodeId = c.req.param('nodeId');
    if (!nodeId) throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${baseScope}`);
    assertDockerResourceScope(c.get('effectiveScopes') ?? [], baseScope, nodeId, '');
    await next();
  };
}

export function compactImageListItem(image: Record<string, any>) {
  const repoTags = image.repoTags ?? image.RepoTags;
  const repoDigests = image.repoDigests ?? image.RepoDigests;
  return {
    id: image.id ?? image.Id,
    parentId: image.parentId ?? image.ParentId,
    repoTags: Array.isArray(repoTags) ? repoTags.slice(0, DOCKER_IMAGE_REF_PREVIEW_MAX) : repoTags,
    repoTagsCount: Array.isArray(repoTags) ? repoTags.length : undefined,
    repoTagsTruncated: Array.isArray(repoTags) && repoTags.length > DOCKER_IMAGE_REF_PREVIEW_MAX,
    repoDigests: Array.isArray(repoDigests) ? repoDigests.slice(0, DOCKER_IMAGE_REF_PREVIEW_MAX) : repoDigests,
    repoDigestsCount: Array.isArray(repoDigests) ? repoDigests.length : undefined,
    repoDigestsTruncated: Array.isArray(repoDigests) && repoDigests.length > DOCKER_IMAGE_REF_PREVIEW_MAX,
    created: image.created ?? image.Created,
    size: image.size ?? image.Size,
    virtualSize: image.virtualSize ?? image.VirtualSize,
    sharedSize: image.sharedSize ?? image.SharedSize,
    containers: image.containers ?? image.Containers,
    scopeResourceId: image.scopeResourceId ?? image.id ?? image.Id ?? null,
    folderId: image.folderId ?? null,
    folderIsSystem: image.folderIsSystem ?? false,
    folderSortOrder: image.folderSortOrder ?? 0,
  };
}

export function matchesImageSearch(image: Record<string, any>, search: string | undefined) {
  if (!search) return true;
  const repoTags = image.repoTags ?? image.RepoTags;
  const repoDigests = image.repoDigests ?? image.RepoDigests;
  const haystack = [
    image.id ?? image.Id,
    image.parentId ?? image.ParentId,
    ...(Array.isArray(repoTags) ? repoTags : []),
    ...(Array.isArray(repoDigests) ? repoDigests : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(search);
}

export function registerImageRoutes(router: OpenAPIHono<AppEnv>) {
  // ─── Image routes ────────────────────────────────────────────────────

  // List images
  router.openapi(listImagesRoute, async (c) => {
    const snapshots = container.resolve(DockerSnapshotService);
    const nodeId = c.req.param('nodeId')!;
    const scopes = c.get('effectiveScopes') ?? [];
    if (!hasScopeBase(scopes, 'docker:images:view')) {
      throw new AppError(403, 'FORBIDDEN', 'Missing required scope: docker:images:view');
    }
    await snapshots.assertDockerNode(nodeId);
    const snapshot = await snapshots.getList<any[]>(nodeId, 'images');
    const data = snapshot.data;
    if (!Array.isArray(data)) return c.json({ data });
    const search = c.req.query('search')?.trim().toLowerCase();
    const docker = container.resolve(DockerManagementService);
    const decorated = docker.decoratePublicImageSnapshot
      ? await docker.decoratePublicImageSnapshot(nodeId, data)
      : data;
    const compacted = filterDockerResourcesForScope(
      filterOpfieldInternalImages(decorated)
        .filter((item) => matchesImageSearch(item, search))
        .map((item) => ({
          ...compactImageListItem(item),
          nodeId,
          availability: snapshots.availability(nodeId, snapshot),
        })),
      scopes,
      'docker:images:view',
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

  // Pull image
  router.openapi(pullImageRoute, async (c) => {
    const service = container.resolve(DockerManagementService);
    const registryService = container.resolve(DockerRegistryService);
    const nodeId = c.req.param('nodeId')!;
    const user = c.get('user')!;
    const body = await c.req.json();
    const { imageRef, registryId, folderId, workload } = ImagePullSchema.parse(body);
    if (workload) {
      throw new AppError(400, 'WORKLOAD_PULL_SYNC_ONLY', 'Pull an image for a workload with POST /api/docker/nodes/{nodeId}/images/pull-sync');
    }

    // Resolve registry credentials and prefix image ref if using private registry
    let finalImageRef = imageRef;
    let registryAuth: string | undefined;
    const auth = await registryService.resolveAuthForImagePull(nodeId, imageRef, registryId, {
      actorScopes: c.get('effectiveScopes') || [],
    });
    if (auth) {
      registryAuth = auth.authJson;
      // Prefix image ref with registry URL if not already prefixed
      if (!hasRegistryHost(imageRef)) {
        finalImageRef = `${auth.url}/${imageRef}`;
      }
    }

    const data = await service.pullImage(
      nodeId,
      finalImageRef,
      registryAuth,
      user.id,
      auth?.registryId,
      folderId,
      c.get('effectiveScopes') ?? []
    );
    return c.json({ data });
  });

  // Pull image (synchronous — waits for completion, validates image exists)
  router.openapi(pullImageSyncRoute, async (c) => {
    const registryService = container.resolve(DockerRegistryService);
    const nodeId = c.req.param('nodeId')!;
    const body = await c.req.json();
    const user = c.get('user')!;
    const { imageRef, registryId, folderId, workload } = ImagePullSchema.parse(body);

    let finalImageRef = imageRef;
    let registryAuth: string | undefined;
    const auth = await registryService.resolveAuthForImagePull(nodeId, imageRef, registryId, {
      actorScopes: c.get('effectiveScopes') || [],
    });
    if (auth) {
      registryAuth = auth.authJson;
      if (!hasRegistryHost(imageRef)) {
        finalImageRef = `${auth.url}/${imageRef}`;
      }
    }

    const service = container.resolve(DockerManagementService);
    const scopes = c.get('effectiveScopes') ?? [];
    try {
      // A deploy pulls for the container or deployment it creates: that destination authorizes the pull.
      if (workload) {
        await service.pullImageForWorkload(nodeId, finalImageRef, registryAuth, workload.folderId, user.id, scopes);
      } else {
        await service.pullImageImmediate(nodeId, finalImageRef, registryAuth, folderId, user.id, scopes);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        400,
        'PULL_FAILED',
        error instanceof Error ? error.message : `Failed to pull ${finalImageRef}`
      );
    }
    await registryService.rememberImageRegistry(nodeId, finalImageRef, auth?.registryId);
    return c.json({ data: { success: true, imageRef: finalImageRef } });
  });

  // Remove image
  router.openapi({ ...removeImageRoute, middleware: requireDockerImageScope('docker:images:delete') }, async (c) => {
    const service = container.resolve(DockerManagementService);
    const nodeId = c.req.param('nodeId')!;
    const imageId = c.req.param('imageId')!;
    const user = c.get('user')!;
    const force = c.req.query('force') === 'true';
    await service.removeImage(nodeId, imageId, force, user.id);
    return c.json({ success: true });
  });

  // Prune images
  router.openapi(
    { ...pruneImagesRoute, middleware: requireDockerImageNodeScope('docker:images:delete') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const user = c.get('user')!;
      if (c.req.query('dryRun') === 'true') return c.json({ data: await service.previewPruneImages(nodeId) });
      const data = await service.pruneImages(nodeId, user.id);
      return c.json({ data });
    }
  );
}

function hasRegistryHost(imageRef: string) {
  const firstSegment = imageRef.split('/')[0] ?? '';
  return firstSegment === 'localhost' || firstSegment.includes('.') || firstSegment.includes(':');
}
