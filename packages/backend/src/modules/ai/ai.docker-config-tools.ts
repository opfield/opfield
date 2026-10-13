import { z } from 'zod';
import { container } from '@/container.js';
import { hasScopeBase, hasScopeForResource } from '@/lib/permissions.js';
import { assertComposeChildMutationAllowed } from '@/modules/docker/compose/compose-child.guard.js';
import {
  DockerHealthCheckUpsertSchema,
  EnvUpdateSchema,
  FileBrowseSchema,
  FileMoveSchema,
  FileUploadChunkQuerySchema,
  FileUploadCompleteSchema,
  FileUploadInitSchema,
  SecretCreateSchema,
  SecretUpdateSchema,
} from '@/modules/docker/docker.schemas.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import { dockerScopedNodeIds } from '@/modules/docker/docker-access-resource.service.js';
import { isDockerDeploymentManaged } from '@/modules/docker/docker-deployment-labels.js';
import { inspectUserContainer } from '@/modules/docker/docker-internal-containers.js';
import { withNodeLossAnswer } from '@/modules/docker/docker-node-loss.js';
import { FILE_UPLOAD_MAX_BYTES } from '@/modules/settings/general-settings.service.js';
import type { User } from '@/types.js';
import {
  decodeFileContent,
  decodeUploadChunk,
  presentFileContent,
  requiredToolString,
} from './ai.docker-tool-access.js';

const FileWriteToolSchema = z.object({
  path: FileBrowseSchema.shape.path,
  content: z
    .union([z.string(), z.instanceof(Buffer)])
    .refine(
      (content) =>
        (typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength) <=
        FILE_UPLOAD_MAX_BYTES,
      'File is too large'
    ),
});

const CONTAINER_FILE_OPERATIONS = new Set([
  'list_files',
  'read_file',
  'write_file',
  'create_file',
  'create_directory',
  'delete_file',
  'move_file',
  'upload_init',
  'upload_chunk',
  'upload_complete',
  'upload_abort',
]);
const CONTAINER_FILE_READ_OPERATIONS = new Set(['list_files', 'read_file']);

export interface DockerConfigToolContext {
  dockerService: DockerManagementService;
}

export async function manageDockerContainerConfigTool(
  context: DockerConfigToolContext,
  user: User,
  args: Record<string, unknown>
) {
  const operation = String(args.operation);
  const nodeId = String(args.nodeId);
  const targetType = args.targetType === 'deployment' ? 'deployment' : 'container';
  const deploymentId = String(args.deploymentId ?? '');
  let containerName = String(args.containerName ?? '');
  let containerId = String(args.containerId ?? '');
  const requiredOperationScope = dockerConfigOperationScope(operation);
  if (requiredOperationScope && !hasScopeBase(user.scopes, requiredOperationScope)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${requiredOperationScope}`);
  }
  if (
    targetType === 'deployment' &&
    (operation === 'get_env' || operation === 'update_env' || CONTAINER_FILE_OPERATIONS.has(operation))
  ) {
    throw new Error(`Docker config operation ${operation} does not support deployment targets`);
  }
  let inspectedContainer: Record<string, any> | undefined;
  if (targetType === 'container') {
    if (!containerId && !containerName) throw new Error('Exactly one containerId or containerName target is required');
    let refreshedStaleId = false;
    try {
      inspectedContainer = await inspectUserContainer(context.dockerService, nodeId, containerId || containerName);
    } catch (error) {
      if (!containerId || !containerName) throw error;
      inspectedContainer = await inspectUserContainer(context.dockerService, nodeId, containerName);
      refreshedStaleId = true;
    }
    const resolvedId = String(inspectedContainer?.Id ?? inspectedContainer?.id ?? '');
    const resolvedName = String(inspectedContainer?.Name ?? inspectedContainer?.name ?? '').replace(/^\//, '');
    if (!resolvedId || !resolvedName) throw new Error('Docker container identity could not be resolved');
    // containerId accepts the stable container name (the documented, preferred form) as well as a runtime ID.
    const containerIdMatches =
      containerId === resolvedId ||
      resolvedId.startsWith(containerId) ||
      containerId.replace(/^\//, '') === resolvedName;
    if (containerId && !refreshedStaleId && !containerIdMatches) {
      throw new Error('containerId and resolved Docker identity do not match');
    }
    if (containerName && containerName.replace(/^\//, '') !== resolvedName) {
      throw new Error('containerName and resolved Docker identity do not match');
    }
    const labels = inspectedContainer?.Config?.Labels ?? inspectedContainer?.Labels ?? inspectedContainer?.labels ?? {};
    if (isDockerDeploymentManaged(labels)) {
      throw new Error(
        'MANAGED_DEPLOYMENT_CONTAINER: This container is managed by a blue/green deployment. Use deployment actions instead.'
      );
    }
    containerId = resolvedId;
    containerName = resolvedName;
  }
  const secretContainerName = targetType === 'deployment' ? `deployment:${deploymentId}` : containerName;
  const authorizationResourceId = async (baseScope: string) => {
    if (targetType === 'deployment') return `${nodeId}/${deploymentId}`;
    if (hasScopeForResource(user.scopes, baseScope, nodeId)) return nodeId;
    if (!dockerScopedNodeIds(user.scopes, [baseScope]).includes(nodeId)) return nodeId;
    const resourceId = String(inspectedContainer?.scopeResourceId ?? '');
    if (!resourceId) throw new Error('PERMISSION_DENIED: Container authorization identity is unavailable');
    return `${nodeId}/${resourceId}`;
  };

  if (operation === 'get_env') {
    ensureToolScopeForResource(
      user,
      'docker:containers:environment',
      await authorizationResourceId('docker:containers:environment')
    );
    return context.dockerService.getContainerEnv(nodeId, containerId);
  }
  if (operation === 'update_env') {
    const input = EnvUpdateSchema.parse(args);
    // The scope check reads the container from the node too: a node lost there is answered the same way.
    return withNodeLossAnswer(
      'env update',
      async () => {
        ensureToolScopeForResource(
          user,
          'docker:containers:environment',
          await authorizationResourceId('docker:containers:environment')
        );
        // Same guard as the env route: Compose-managed containers change through their project.
        await assertComposeChildMutationAllowed(nodeId, containerId);
        return context.dockerService.updateContainerEnv(nodeId, containerId, input.env, input.removeEnv, user.id);
      },
      (message) => context.dockerService.recordNodeLostTask(nodeId, containerId, 'update', message)
    );
  }
  if (CONTAINER_FILE_OPERATIONS.has(operation)) {
    const fileScope = CONTAINER_FILE_READ_OPERATIONS.has(operation)
      ? 'docker:containers:files:read'
      : 'docker:containers:files:write';
    ensureToolScopeForResource(user, fileScope, await authorizationResourceId(fileScope));
    return manageContainerFiles(context.dockerService, user, operation, nodeId, containerId, args);
  }
  if (operation.endsWith('_secret') || operation === 'list_secrets') {
    // Listing the keys needs environment, as the secrets list route; values and changes need secrets.
    const secretScope =
      operation === 'list_secrets' && !args.reveal ? 'docker:containers:environment' : 'docker:containers:secrets';
    ensureToolScopeForResource(user, secretScope, await authorizationResourceId(secretScope));
    const { DockerSecretService } = await import('@/modules/docker/docker-secret.service.js');
    const secretService = container.resolve(DockerSecretService);
    if (targetType === 'deployment') {
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      await container.resolve(DockerDeploymentService).get(nodeId, deploymentId);
    }
    if (operation === 'list_secrets') {
      return secretService.list(nodeId, secretContainerName, Boolean(args.reveal));
    }
    if (targetType === 'container') await assertComposeChildMutationAllowed(nodeId, containerId);
    if (operation === 'create_secret') {
      const input = SecretCreateSchema.parse(args);
      return secretService.create(nodeId, secretContainerName, input.key, input.value, user.id);
    }
    if (operation === 'update_secret') {
      const input = SecretUpdateSchema.parse(args);
      return secretService.update(String(args.secretId), nodeId, input.value, user.id, secretContainerName);
    }
    if (operation === 'delete_secret') {
      await secretService.delete(String(args.secretId), nodeId, user.id, secretContainerName);
      return { success: true };
    }
  }
  if (operation.includes('webhook')) {
    ensureToolScopeForResource(
      user,
      'docker:containers:webhooks',
      await authorizationResourceId('docker:containers:webhooks')
    );
    if (targetType === 'deployment') {
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const deploymentService = container.resolve(DockerDeploymentService);
      if (operation === 'get_webhook') return deploymentService.getWebhook(nodeId, deploymentId);
      if (operation === 'upsert_webhook') {
        return deploymentService.upsertWebhook(
          nodeId,
          deploymentId,
          { enabled: args.enabled as boolean | undefined },
          user.id
        );
      }
      if (operation === 'delete_webhook') {
        await deploymentService.deleteWebhook(nodeId, deploymentId, user.id);
        return { success: true };
      }
      if (operation === 'regenerate_webhook_token') {
        return deploymentService.regenerateWebhook(nodeId, deploymentId, user.id);
      }
    }
    const { DockerWebhookService } = await import('@/modules/docker/docker-webhook.service.js');
    const webhookService = container.resolve(DockerWebhookService);
    if (operation === 'get_webhook') return webhookService.getByContainer(nodeId, containerName);
    if (operation === 'upsert_webhook') {
      return webhookService.upsert(nodeId, containerName, { enabled: args.enabled as boolean | undefined }, user.id);
    }
    if (operation === 'delete_webhook') {
      await webhookService.remove(nodeId, containerName, user.id);
      return { success: true };
    }
    if (operation === 'regenerate_webhook_token') {
      return webhookService.regenerateToken(nodeId, containerName, user.id);
    }
  }
  if (operation.includes('health_check')) {
    const readOnly = operation === 'get_health_check';
    ensureToolScopeForResource(
      user,
      readOnly ? 'docker:containers:view' : 'docker:containers:edit',
      await authorizationResourceId(readOnly ? 'docker:containers:view' : 'docker:containers:edit')
    );
    const { DockerHealthCheckService } = await import('@/modules/docker/docker-health-check.service.js');
    const healthService = container.resolve(DockerHealthCheckService);
    const input =
      args.healthCheck && typeof args.healthCheck === 'object'
        ? DockerHealthCheckUpsertSchema.parse(args.healthCheck)
        : undefined;
    if (targetType === 'deployment') {
      if (operation === 'get_health_check') return healthService.getDeployment(nodeId, deploymentId);
      if (operation === 'upsert_health_check') {
        return healthService.upsertDeployment(
          nodeId,
          deploymentId,
          DockerHealthCheckUpsertSchema.parse(args.healthCheck ?? {})
        );
      }
      if (operation === 'test_health_check') return healthService.testDeployment(nodeId, deploymentId, input);
    }
    if (operation === 'get_health_check') return healthService.getContainer(nodeId, containerName);
    if (operation === 'upsert_health_check') {
      return healthService.upsertContainer(
        nodeId,
        containerName,
        DockerHealthCheckUpsertSchema.parse(args.healthCheck ?? {})
      );
    }
    if (operation === 'test_health_check') return healthService.testContainer(nodeId, containerName, input);
  }

  throw new Error(`Unsupported Docker container config operation: ${operation}`);
}

/** Mirrors the container file-browser routes, which hold docker:containers:files:read or :write. */
async function manageContainerFiles(
  dockerService: DockerManagementService,
  user: User,
  operation: string,
  nodeId: string,
  containerId: string,
  args: Record<string, unknown>
) {
  switch (operation) {
    case 'list_files': {
      const input = FileBrowseSchema.parse(args);
      return dockerService.listDirectory(nodeId, containerId, input.path);
    }
    case 'read_file': {
      const input = FileBrowseSchema.parse(args);
      const content = await dockerService.readFile(nodeId, containerId, input.path);
      return presentFileContent(input.path, content, args);
    }
    case 'write_file': {
      const input = FileWriteToolSchema.parse({ path: args.path, content: decodeFileContent(args) });
      await dockerService.writeFile(nodeId, containerId, input.path, input.content, user.id);
      return { success: true };
    }
    case 'create_file': {
      const hasContent = typeof args.content === 'string' || typeof args.contentBase64 === 'string';
      const input = FileWriteToolSchema.parse({ path: args.path, content: hasContent ? decodeFileContent(args) : '' });
      await dockerService.createFile(nodeId, containerId, input.path, hasContent ? input.content : undefined, user.id);
      return { success: true };
    }
    case 'create_directory': {
      const { path } = FileBrowseSchema.parse({ path: args.path });
      await dockerService.createDirectory(nodeId, containerId, path, user.id);
      return { success: true };
    }
    case 'delete_file': {
      const { path } = FileBrowseSchema.parse({ path: args.path });
      await dockerService.deleteFile(nodeId, containerId, path, user.id);
      return { success: true };
    }
    case 'move_file': {
      const { fromPath, toPath } = FileMoveSchema.parse({ fromPath: args.fromPath, toPath: args.toPath });
      await dockerService.moveFile(nodeId, containerId, fromPath, toPath, user.id);
      return { success: true };
    }
    case 'upload_init': {
      const { path, totalBytes } = FileUploadInitSchema.parse({ path: args.path, totalBytes: args.totalBytes });
      return dockerService.initFileUpload(nodeId, containerId, path, totalBytes, user.id);
    }
    case 'upload_chunk': {
      const uploadId = requiredToolString(args.uploadId, 'uploadId');
      const { offset } = FileUploadChunkQuerySchema.parse({ offset: args.offset });
      return dockerService.appendFileUploadChunk(nodeId, containerId, uploadId, offset, decodeUploadChunk(args));
    }
    case 'upload_complete': {
      const uploadId = requiredToolString(args.uploadId, 'uploadId');
      const { path, totalBytes } = FileUploadCompleteSchema.parse({ path: args.path, totalBytes: args.totalBytes });
      await dockerService.completeFileUpload(nodeId, containerId, uploadId, path, totalBytes);
      return { success: true };
    }
    case 'upload_abort': {
      await dockerService.abortFileUpload(nodeId, containerId, requiredToolString(args.uploadId, 'uploadId'));
      return { success: true };
    }
    default:
      throw new Error(`Unsupported Docker container file operation: ${operation}`);
  }
}

function dockerConfigOperationScope(operation: string): string | undefined {
  if (operation === 'get_env' || operation === 'update_env') return 'docker:containers:environment';
  if (CONTAINER_FILE_READ_OPERATIONS.has(operation)) return 'docker:containers:files:read';
  if (CONTAINER_FILE_OPERATIONS.has(operation)) return 'docker:containers:files:write';
  if (operation === 'list_secrets') return 'docker:containers:environment';
  if (operation.endsWith('_secret')) return 'docker:containers:secrets';
  if (operation.includes('webhook')) return 'docker:containers:webhooks';
  if (operation === 'get_health_check') return 'docker:containers:view';
  if (operation === 'upsert_health_check' || operation === 'test_health_check') return 'docker:containers:edit';
  return undefined;
}

function ensureToolScopeForResource(user: User, baseScope: string, resourceId: string) {
  if (!hasScopeForResource(user.scopes, baseScope, resourceId)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${baseScope}:${resourceId}`);
  }
}
