import { randomUUID } from 'node:crypto';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import {
  filterOpfieldInternalImages,
  isDanglingDockerImage,
  isOpfieldInternalImage,
} from './docker-internal-images.js';
import type { DockerRegistryService } from './docker-registry.service.js';
import { type DockerTaskService, detachDockerTask, trackDockerTask } from './docker-task.service.js';
import { isLostTrackError } from './docker-task-reconciler.js';

type DockerDispatchResult = { success: boolean; error?: string; detail?: string };

export interface DockerImageOperationContext {
  nodeDispatch: NodeDispatchService;
  auditService: AuditService;
  taskService?: DockerTaskService;
  registryService?: DockerRegistryService;
  eventBus?: EventBusService;
  onImagePulled?(nodeId: string, imageRef: string, folderId: string | null | undefined, userId: string): Promise<void>;
  /** The images the node had before a pull by a user: only an image the pull created is placed for the user. */
  existingImageIds?: ReadonlySet<string>;
  parseResult(result: DockerDispatchResult): unknown;
  createTask(
    nodeId: string,
    containerId: string,
    containerName: string,
    type: string
  ): Promise<{ id: string } | undefined>;
  longDockerOperationTimeoutMs: number;
}

export async function listAllImages(context: DockerImageOperationContext, nodeId: string) {
  const result = await context.nodeDispatch.sendDockerImageCommand(nodeId, 'list');
  return context.parseResult(result);
}

export async function listImages(context: DockerImageOperationContext, nodeId: string) {
  const images = await listAllImages(context, nodeId);
  return Array.isArray(images) ? filterOpfieldInternalImages(images) : images;
}

export async function pullImage(
  context: DockerImageOperationContext,
  nodeId: string,
  imageRef: string,
  registryAuth?: string,
  userId?: string,
  registryId?: string,
  folderId?: string | null
) {
  const task = await context.createTask(nodeId, '', imageRef, 'pull');
  // The pull runs as a command Opfield names, so the daemon can tell how it ended should Opfield lose its answer
  // (Opfield restarted, or the node's control stream dropped while the pull ran on): the task is then settled with
  // the node instead of failing while the node still pulls (DockerTaskReconciler).
  const commandId = randomUUID();
  await trackDockerTask(
    context.taskService,
    task?.id,
    {
      kind: 'pull',
      imageRef,
      deadlineAt: new Date(Date.now() + context.longDockerOperationTimeoutMs).toISOString(),
      registryId: registryId ?? null,
      folderId: folderId ?? null,
      userId: userId ?? null,
      ...(userId && context.existingImageIds ? { preexistingImageIds: [...context.existingImageIds] } : {}),
    },
    commandId
  );
  if (userId) {
    await context.auditService.log({
      action: 'docker.image.pull',
      userId,
      resourceType: 'docker-image',
      details: { nodeId, imageRef },
    });
  }

  context.nodeDispatch
    .sendDockerImageCommand(
      nodeId,
      'pull',
      { imageRef, registryAuthJson: registryAuth },
      context.longDockerOperationTimeoutMs,
      commandId
    )
    .then(async (result) => {
      try {
        context.parseResult(result);
      } catch (err) {
        if (task?.id && context.taskService) {
          context.taskService
            .update(task.id, {
              status: 'failed',
              error: err instanceof Error ? err.message : 'Pull failed',
              completedAt: new Date(),
            })
            .catch(() => {});
        }
        return;
      }
      try {
        if (userId) await context.onImagePulled?.(nodeId, imageRef, folderId, userId);
      } catch (err) {
        if (task?.id && context.taskService) {
          context.taskService
            .update(task.id, {
              status: 'failed',
              error: err instanceof Error ? err.message : 'Image pull placement failed',
              completedAt: new Date(),
            })
            .catch(() => {});
        }
        return;
      }
      if (task?.id && context.taskService) {
        context.taskService
          .update(task.id, { status: 'succeeded', progress: `Pulled ${imageRef}`, completedAt: new Date() })
          .catch(() => {});
      }
      await context.registryService?.rememberImageRegistry?.(nodeId, imageRef, registryId);
      context.eventBus?.publish('docker.image.changed', { nodeId, ref: imageRef, action: 'pulled' });
    })
    .catch((err) => {
      if (task?.id && context.taskService) {
        const error = err instanceof Error ? err.message : 'Pull failed';
        // The node may still pull: the task stays active until the node tells how the pull ended.
        if (isLostTrackError(err)) void detachDockerTask(context.taskService, task.id, error);
        else context.taskService.update(task.id, { status: 'failed', error, completedAt: new Date() }).catch(() => {});
      }
    });

  return { taskId: task?.id, message: `Pulling ${imageRef}...` };
}

export async function removeImage(
  context: DockerImageOperationContext,
  nodeId: string,
  imageId: string,
  force: boolean,
  userId: string | null
) {
  const result = await context.nodeDispatch.sendDockerImageCommand(nodeId, 'remove', { imageRef: imageId, force });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.image.remove',
    userId,
    resourceType: 'docker-image',
    resourceId: imageId,
    details: { nodeId },
  });
  context.eventBus?.publish('docker.image.changed', { nodeId, ref: imageId, action: 'removed' });
}

export async function pruneImages(context: DockerImageOperationContext, nodeId: string, userId: string) {
  const images = await listAllImages(context, nodeId);
  const deleted: string[] = [];
  let spaceReclaimed = 0;
  if (Array.isArray(images)) {
    for (const image of images) {
      if (isOpfieldInternalImage(image) || !isDanglingDockerImage(image)) continue;
      const imageId = String(image.id ?? image.Id ?? '');
      if (!imageId) continue;
      try {
        const result = await context.nodeDispatch.sendDockerImageCommand(nodeId, 'remove', {
          imageRef: imageId,
          force: false,
        });
        context.parseResult(result);
        deleted.push(imageId);
        spaceReclaimed += Number(image.size ?? image.Size ?? 0);
      } catch {
        // Docker rejects in-use or parent images; keep pruning the remaining safe candidates.
      }
    }
  }
  const data = { ImagesDeleted: deleted, SpaceReclaimed: spaceReclaimed };
  await context.auditService.log({
    action: 'docker.image.prune',
    userId,
    resourceType: 'docker-image',
    details: { nodeId },
  });
  context.eventBus?.publish('docker.image.changed', { nodeId, ref: '*', action: 'pruned' });
  return data;
}
