import { container } from '@/container.js';
import { hasScopeBase } from '@/lib/permissions.js';
import { assertComposeChildMutationAllowed } from '@/modules/docker/compose/compose-child.guard.js';
import {
  ContainerArchivePlanSchema,
  ContainerLiveUpdateSchema,
  ContainerRecreateSchema,
  ContainerUpdateSchema,
} from '@/modules/docker/docker.schemas.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import { assertDockerNodeScope } from '@/modules/docker/docker-access.middleware.js';
import { planDockerContainerArchiveImport } from '@/modules/docker/docker-container-archive-operations.js';
import {
  getDockerContainerProcesses,
  getDockerContainerStatsHistory,
  listDockerGpuUsage,
} from '@/modules/docker/docker-container-observability.js';
import {
  containerRecreateRequiredScopes,
  containerUpdateRequiredScopes,
} from '@/modules/docker/docker-container-scope-requirements.js';
import { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { ImageCleanupUpsertSchema } from '@/modules/docker/docker-image-cleanup.schemas.js';
import { DockerImageCleanupService } from '@/modules/docker/docker-image-cleanup.service.js';
import { withNodeLossAnswer } from '@/modules/docker/docker-node-loss.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { User } from '@/types.js';
import {
  ensureDockerContainerScopes,
  ensureToolScopeForResource,
  pickDefinedArguments,
  requiredToolString,
} from './ai.docker-tool-access.js';

const RECREATE_FIELDS = [
  'image',
  'ports',
  'mounts',
  'entrypoint',
  'command',
  'workingDir',
  'user',
  'hostname',
  'labels',
  'stopTimeout',
  'restartPolicy',
  'maxRetries',
  'memoryLimit',
  'memorySwap',
  'nanoCPUs',
  'cpuShares',
  'pidsLimit',
  'gpu',
  'runtimeProfile',
] as const;
const LIVE_UPDATE_FIELDS = [
  'restartPolicy',
  'maxRetries',
  'memoryLimit',
  'memorySwap',
  'nanoCPUs',
  'cpuShares',
  'pidsLimit',
] as const;
const UPDATE_FIELDS = ['tag', 'env', 'removeEnv'] as const;

/**
 * POST /containers/:id/recreate access: docker:containers:manage, the scopes
 * containerRecreateRequiredScopes adds for the changed fields (they also
 * authorize pulling a new image), and the Compose child guard.
 */
export async function assertDockerContainerRecreateAccess(
  dockerService: DockerManagementService,
  user: User,
  nodeId: string,
  containerId: string,
  config: Record<string, unknown>
): Promise<any> {
  const inspected = await ensureDockerContainerScopes(
    dockerService,
    user,
    ['docker:containers:manage', ...containerRecreateRequiredScopes(config)],
    nodeId,
    containerId
  );
  await assertComposeChildMutationAllowed(nodeId, containerId);
  return inspected;
}

/**
 * What a container recreate answers an agent: the node runs it as a task after the call returns, so it is reported
 * as queued with its taskId (not as done), and how to follow it.
 */
export function recreateQueuedAnswer(data: unknown) {
  const taskId =
    data && typeof data === 'object' && typeof (data as { taskId?: unknown }).taskId === 'string'
      ? (data as { taskId: string }).taskId
      : null;
  if ((data as { availabilityManaged?: unknown } | null)?.availabilityManaged) {
    return {
      success: true,
      status: 'queued',
      message: 'Container recreate queued as a rollout of its availability policy; it has not finished yet',
      data,
    };
  }
  return {
    success: true,
    status: 'queued',
    taskId,
    message: taskId
      ? `Container recreate queued on the node as task ${taskId}; it has not finished yet. Read the task (manage_app_variables workload_task for a container of an app environment, or the Docker task tools) until it is succeeded or failed.`
      : 'Container recreate queued on the node; it has not finished yet',
    data,
  };
}

/** Mirrors the container recreate, update, live-update, top, stats-history, GPU usage, image-cleanup and archive-plan routes. */
export async function manageDockerContainerTool(
  dockerService: DockerManagementService,
  user: User,
  args: Record<string, unknown>
): Promise<unknown> {
  const operation = String(args.operation);
  const nodeId = requiredToolString(args.nodeId, 'nodeId');

  switch (operation) {
    case 'recreate': {
      const containerId = requiredToolString(args.containerId, 'containerId');
      const config = ContainerRecreateSchema.parse(pickDefinedArguments(args, RECREATE_FIELDS));
      // The access checks read the container from the node too: a node lost there is answered the same way.
      const data = await withNodeLossAnswer(
        'recreate',
        async () => {
          await assertDockerContainerRecreateAccess(dockerService, user, nodeId, containerId, config);
          return dockerService.recreateWithConfig(nodeId, containerId, config, user.id, {
            actorScopes: user.scopes,
            backgroundImagePull: true,
          });
        },
        (message) => dockerService.recordNodeLostTask(nodeId, containerId, 'recreate', message)
      );
      return recreateQueuedAnswer(data);
    }
    case 'live_update': {
      const containerId = requiredToolString(args.containerId, 'containerId');
      await ensureDockerContainerScopes(dockerService, user, ['docker:containers:edit'], nodeId, containerId);
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const config = ContainerLiveUpdateSchema.parse(pickDefinedArguments(args, LIVE_UPDATE_FIELDS));
      await dockerService.liveUpdateContainer(nodeId, containerId, config, user.id);
      return { success: true };
    }
    case 'update': {
      const containerId = requiredToolString(args.containerId, 'containerId');
      const config = ContainerUpdateSchema.parse(pickDefinedArguments(args, UPDATE_FIELDS));
      return withNodeLossAnswer(
        'update',
        async () => {
          await ensureDockerContainerScopes(
            dockerService,
            user,
            containerUpdateRequiredScopes(config),
            nodeId,
            containerId
          );
          await assertComposeChildMutationAllowed(nodeId, containerId);
          return dockerService.updateContainer(nodeId, containerId, config, user.id, user.scopes);
        },
        (message) => dockerService.recordNodeLostTask(nodeId, containerId, 'update', message)
      );
    }
    case 'processes': {
      const containerId = requiredToolString(args.containerId, 'containerId');
      await ensureDockerContainerScopes(dockerService, user, ['docker:containers:view'], nodeId, containerId);
      return getDockerContainerProcesses(nodeId, containerId);
    }
    case 'stats_history': {
      const containerId = requiredToolString(args.containerId, 'containerId');
      await ensureDockerContainerScopes(dockerService, user, ['docker:containers:view'], nodeId, containerId);
      return getDockerContainerStatsHistory(nodeId, containerId);
    }
    case 'gpu_usage':
      if (!hasScopeBase(user.scopes, 'docker:containers:view')) {
        throw new Error('PERMISSION_DENIED: Missing required scope docker:containers:view');
      }
      assertDockerNodeScope(user.scopes, 'docker:containers:view', nodeId);
      return listDockerGpuUsage(nodeId, user.scopes);
    case 'image_cleanup_get':
    case 'image_cleanup_upsert':
      return manageImageCleanup(dockerService, user, operation, nodeId, args);
    case 'archive_plan_import': {
      if (!hasScopeBase(user.scopes, 'docker:containers:create')) {
        throw new Error('PERMISSION_DENIED: Missing required scope docker:containers:create');
      }
      // LICENSE ENFORCEMENT: Archive operations are Personal entitlements under the project license/TOS.
      await container.resolve(LicensePolicyService).requireFeature('container-export');
      const body = ContainerArchivePlanSchema.parse(args.archiveManifest ?? {});
      return planDockerContainerArchiveImport(nodeId, body, user.scopes);
    }
    default:
      throw new Error(`Unsupported Docker container operation: ${operation}`);
  }
}

/** Container and deployment image-cleanup routes: reading needs docker:containers:view, saving :edit on the target. */
async function manageImageCleanup(
  dockerService: DockerManagementService,
  user: User,
  operation: 'image_cleanup_get' | 'image_cleanup_upsert',
  nodeId: string,
  args: Record<string, unknown>
) {
  const cleanup = container.resolve(DockerImageCleanupService);
  const input =
    operation === 'image_cleanup_upsert'
      ? ImageCleanupUpsertSchema.parse(pickDefinedArguments(args, ['enabled', 'retentionCount']))
      : undefined;
  const scope = input ? 'docker:containers:edit' : 'docker:containers:view';
  if (args.targetType === 'deployment') {
    const deploymentId = requiredToolString(args.deploymentId, 'deploymentId');
    ensureToolScopeForResource(user, scope, `${nodeId}/${deploymentId}`);
    await container.resolve(DockerDeploymentService).get(nodeId, deploymentId);
    return input
      ? cleanup.upsertForDeployment(nodeId, deploymentId, input)
      : cleanup.getForDeployment(nodeId, deploymentId);
  }
  const reference = requiredToolString(args.containerName ?? args.containerId, 'containerName');
  const inspected = await ensureDockerContainerScopes(dockerService, user, [scope], nodeId, reference);
  const containerName = String(inspected?.Name ?? inspected?.name ?? '').replace(/^\//, '') || reference;
  return input
    ? cleanup.upsertForContainer(nodeId, containerName, input)
    : cleanup.getForContainer(nodeId, containerName);
}
