import { z } from 'zod';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { getResourceScopedIds, hasScope, hasScopeBase, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { parseAppListFilter, withDockerAppMembers } from '@/modules/apps/app-membership.js';
import {
  ComposeAdoptInputSchema,
  ComposeCreateInputSchema,
  ComposeOperationActionSchema,
  ComposeOperationInputSchema,
  ComposeOperationListQuerySchema,
  ComposeRevisionCreateInputSchema,
  ComposeSecretCreateSchema,
  ComposeSecretUpdateSchema,
  ComposeYamlInputSchema,
} from '@/modules/docker/compose/compose.schemas.js';
import { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import {
  assertComposeChildMutationAllowed,
  assertComposeVolumeMutationAllowed,
} from '@/modules/docker/compose/compose-child.guard.js';
import {
  ContainerCreateSchema,
  ContainerDuplicateSchema,
  ContainerKillSchema,
  ContainerStopSchema,
  FileBrowseSchema,
  FileMoveSchema,
  FileUploadChunkQuerySchema,
  FileUploadCompleteSchema,
  FileUploadInitSchema,
  ImagePullSchema,
  LogQuerySchema,
  RegistryCreateSchema,
  RegistryUpdateSchema,
  VolumeCreateSchema,
  VolumeLabelsUpdateSchema,
  VolumeRenameSchema,
  VolumeResizeSchema,
} from '@/modules/docker/docker.schemas.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import { assertDockerResourceScope, dockerNodeListAccess } from '@/modules/docker/docker-access.middleware.js';
import {
  DockerAccessResourceService,
  hasDockerResourceScope,
} from '@/modules/docker/docker-access-resource.service.js';
import {
  DockerBuildCreateSchema,
  DockerBuildListQuerySchema,
  DockerBuildLogQuerySchema,
  DockerBuildSecretNameSchema,
  DockerBuildSecretValueSchema,
  DockerInternalRegistrySettingsSchema,
  DockerPendingContainerVolumesSchema,
  DockerSourceBindingConfigSchema,
  DockerSourceBindingUpsertSchema,
  DockerSourceResourceCreateSchema,
  type DockerSourceTarget,
} from '@/modules/docker/docker-build.schemas.js';
import { filterBuildsByApp } from '@/modules/docker/docker-build-app-filter.js';
import { assertCreateNetworksAccess } from '@/modules/docker/docker-container-create-networks.js';
import {
  type ContainerOperationAnswer,
  pendingOperationBody,
} from '@/modules/docker/docker-container-lifecycle-operations.js';
import {
  deploymentDeployRequiredScopes,
  deploymentUpdateRequiredScopes,
} from '@/modules/docker/docker-container-scope-requirements.js';
import {
  DockerDeploymentCreateSchema,
  type DockerDeploymentDeployInput,
  DockerDeploymentDeploySchema,
  DockerDeploymentSwitchSchema,
  DockerDeploymentUpdateSchema,
} from '@/modules/docker/docker-deployment.schemas.js';
import { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { presentDeploymentForCaller } from '@/modules/docker/docker-deployment-redaction.js';
import { withDockerImageSources } from '@/modules/docker/docker-image-source.js';
import { inspectUserContainer } from '@/modules/docker/docker-internal-containers.js';
import { withNodeLossAnswer } from '@/modules/docker/docker-node-loss.js';
import { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import { sanitizeContainerInspect } from '@/modules/docker/docker-snapshot.service.js';
import {
  assertNotPendingSourceContainer,
  type DockerSourceService as DockerSourceServiceType,
} from '@/modules/docker/docker-source.service.js';
import {
  canListSourceConnectors,
  canPickDockerSource,
  listSourceConnectors,
} from '@/modules/docker/docker-source-connectors.js';
import {
  assertDockerSourceTargetOnNode,
  ComposeSourceProjectCreateSchema,
  createComposeProjectFromSource,
  createDockerSourceResource,
} from '@/modules/docker/docker-source-resource-creation.js';
import { DOCKER_VOLUME_EDIT_SCOPE } from '@/modules/docker/docker-volume-access.js';
import {
  assertSnapshotVolumeVisible,
  getDockerVolumeMetricsSnapshot,
  inspectDockerVolumeSnapshot,
} from '@/modules/docker/docker-volume-snapshot-reads.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { User } from '@/types.js';
import { inspectConsoleCommand, parseConsoleCommandResult } from './ai.console-safety.js';
import { manageContainerLinkForAgent } from './ai.container-link-tools.js';
import { createDockerArchiveDownloadLink, createDockerArchiveUploadLink } from './ai.docker-archive-link.js';
import { dockerArchiveTransferStore } from './ai.docker-archive-transfer.js';
import { manageDockerAvailabilityTool } from './ai.docker-availability-tools.js';
import { assertDockerContainerRecreateAccess, manageDockerContainerTool } from './ai.docker-container-tools.js';
import { listDockerNetworksForAgent, manageDockerNetworkForAgent } from './ai.docker-network-tools.js';
import {
  decodeFileContent,
  decodeUploadChunk,
  ensureDockerSourceContainerScope,
  presentFileContent,
  requiredToolString,
} from './ai.docker-tool-access.js';
import {
  compactAgentList,
  compactDockerContainerForAgent,
  compactDockerDeploymentForAgent,
  compactDockerImageForAgent,
  compactDockerVolumeForAgent,
  dockerContainerMatchesSearch,
  dockerDeploymentMatchesSearch,
  dockerImageMatchesSearch,
  dockerVolumeMatchesSearch,
  hasRegistryHost,
} from './ai.service-helpers.js';

type SavedDockerSource = Awaited<ReturnType<DockerSourceServiceType['get']>>;

export const DOCKER_TOOL_NAMES = new Set([
  'create_docker_container',
  'list_docker_containers',
  'get_docker_container',
  'execute_docker_container_console_command',
  'list_docker_deployments',
  'get_docker_deployment',
  'start_docker_deployment',
  'stop_docker_deployment',
  'restart_docker_deployment',
  'kill_docker_deployment',
  'deploy_docker_deployment',
  'switch_docker_deployment_slot',
  'rollback_docker_deployment',
  'stop_docker_deployment_slot',
  'start_docker_container',
  'stop_docker_container',
  'restart_docker_container',
  'remove_docker_container',
  'rename_docker_container',
  'duplicate_docker_container',
  'get_docker_container_stats',
  'update_docker_container_image',
  'get_docker_container_logs',
  'list_docker_images',
  'pull_docker_image',
  'remove_docker_image',
  'prune_docker_images',
  'list_docker_volumes',
  'list_docker_networks',
  'manage_docker_registry',
  'manage_docker_volume',
  'manage_docker_network',
  'manage_container_link',
  'manage_docker_compose',
  'list_docker_builds',
  'manage_docker_build',
  'manage_docker_source',
  'manage_docker_task',
  'manage_docker_deployment',
  'kill_docker_container',
  'force_cancel_docker_task',
  'manage_docker_container',
  'manage_docker_availability',
  'manage_docker_runtime',
  'upload_docker_container_archive',
  'download_docker_archive',
]);

export interface DockerToolContext {
  dockerService: DockerManagementService;
  ensureToolScope(user: User, scope: string): void;
  ensureToolScopeForResource(user: User, baseScope: string, resourceId: string): void;
}

export async function executeDockerTool(
  context: DockerToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;

  switch (toolName) {
    case 'create_docker_container': {
      const input = ContainerCreateSchema.parse({
        folderId: a.folderId,
        image: a.image,
        registryId: optionalNonEmptyString(a.registryId),
        name: a.name,
        ports: a.ports,
        volumes: a.volumes,
        env: a.env,
        networks: a.networks,
        restartPolicy: a.restartPolicy ?? 'no',
        runtimeProfile: a.runtimeProfile,
        stopTimeout: a.stopTimeout,
        gpu: a.gpu,
        labels: a.labels,
        command: a.command,
      });
      await assertCreateNetworksAccess(user.scopes, a.nodeId, input.networks);
      const data = await context.dockerService.createContainer(a.nodeId, input, user.id, user.scopes);
      const containerId = String((data as any)?.id ?? (data as any)?.Id ?? '');
      if (!containerId) throw new Error('Docker daemon did not return the created container ID');
      try {
        for (const network of input.networks?.slice(1) ?? []) {
          await context.dockerService.connectContainerToNetwork(a.nodeId, network, containerId, user.id);
        }
        // Creating never implies starting: like POST .../start, it needs docker:containers:manage
        // on the new container, otherwise the container is returned stopped.
        const created = await context.dockerService.inspectContainer(a.nodeId, containerId);
        // A folder grant covers containers placed in the folder later, including this one: the request's
        // expanded scopes predate it, so the destination folder grant is checked directly.
        const canStart =
          hasScopeForResource(user.scopes, 'docker:containers:manage', a.nodeId) ||
          hasDockerContainerScope(user, 'docker:containers:manage', a.nodeId, created) ||
          (!!input.folderId && hasScope(user.scopes, `docker:containers:manage:folder/${input.folderId}`));
        if (canStart) await context.dockerService.startContainer(a.nodeId, containerId, user.id);
        const inspect = canStart ? await context.dockerService.inspectContainer(a.nodeId, containerId) : created;
        const name = String((inspect as any)?.Name ?? (data as any)?.name ?? '').replace(/^\//, '');
        return {
          success: true,
          message: canStart
            ? 'Container created and started'
            : 'Container created but not started: starting it requires docker:containers:manage',
          data: {
            ...(data as object),
            id: containerId,
            name,
            state: (inspect as any)?.State?.Status ?? (canStart ? 'running' : 'created'),
          },
        };
      } catch (error) {
        try {
          await context.dockerService.rollbackCreatedContainer(
            a.nodeId,
            containerId,
            String((data as any)?.name ?? '') || undefined,
            user.id
          );
        } catch {
          // Preserve the primary orchestration error. Cleanup failures are surfaced by Docker audit/task state.
        }
        throw error;
      }
    }
    case 'list_docker_containers': {
      // Like GET /nodes/:nodeId/containers: an empty granted folder or a create-only grant lists nothing.
      if (dockerNodeListAccess(user.scopes, 'docker:containers:view', a.nodeId, 'docker:containers:create') === 'empty')
        return compactAgentList([]);
      const containers = await context.dockerService.listContainers(a.nodeId);
      const canViewNode = hasDockerResourceScope(user.scopes, 'docker:containers:view', a.nodeId, '');
      return Array.isArray(containers)
        ? compactAgentList(
            await withDockerAppMembers(
              'container',
              await withDockerImageSources(
                containers
                  .filter(
                    (resource: any) =>
                      canViewNode ||
                      (!!resource.scopeResourceId &&
                        hasDockerResourceScope(
                          user.scopes,
                          'docker:containers:view',
                          a.nodeId,
                          resource.scopeResourceId
                        ))
                  )
                  .filter((container: any) => dockerContainerMatchesSearch(container, a.search))
                  .map((container: any) => compactDockerContainerForAgent(container))
              ),
              (row: any) => (row.name ? { nodeId: a.nodeId, resourceKey: String(row.name) } : null),
              parseAppListFilter(a)
            )
          )
        : containers;
    }
    case 'get_docker_container': {
      const inspected = await ensureDockerContainerScopes(
        context,
        user,
        ['docker:containers:view'],
        a.nodeId,
        a.containerId
      );
      // Same rule as the inspect route: the live inspect carries the environment.
      return hasDockerContainerScope(user, 'docker:containers:environment', a.nodeId, inspected)
        ? inspected
        : sanitizeContainerInspect(inspected);
    }
    case 'execute_docker_container_console_command':
      return executeDockerContainerConsoleCommand(context, user, args);
    case 'list_docker_deployments': {
      if (dockerNodeListAccess(user.scopes, 'docker:containers:view', a.nodeId, 'docker:containers:create') === 'empty')
        return compactAgentList([]);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const deployments = await container.resolve(DockerDeploymentService).listSummary(a.nodeId);
      return compactAgentList(
        await withDockerAppMembers(
          'container',
          await withDockerImageSources(
            deployments
              .filter((deployment: any) =>
                hasDockerResourceScope(user.scopes, 'docker:containers:view', a.nodeId, deployment.id)
              )
              .filter((deployment: any) => dockerDeploymentMatchesSearch(deployment, a.search))
              .map((deployment: any) => compactDockerDeploymentForAgent(deployment)),
            (row: any) => row.desiredImage
          ),
          (row: any) => (row.name ? { nodeId: a.nodeId, resourceKey: String(row.name) } : null),
          parseAppListFilter(a)
        )
      );
    }
    case 'get_docker_deployment': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:view', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const deployment = await container.resolve(DockerDeploymentService).get(a.nodeId, a.deploymentId);
      return presentDeploymentForCaller(deployment, user.scopes, a.nodeId, a.deploymentId);
    }
    case 'start_docker_deployment': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const data = await container.resolve(DockerDeploymentService).start(a.nodeId, a.deploymentId, user.id);
      return { success: true, message: 'Deployment started', data: presentDeployment(user, a, data) };
    }
    case 'stop_docker_deployment': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const data = await container.resolve(DockerDeploymentService).stop(a.nodeId, a.deploymentId, user.id);
      return { success: true, message: 'Deployment stopped', data: presentDeployment(user, a, data) };
    }
    case 'restart_docker_deployment': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const data = await container.resolve(DockerDeploymentService).restart(a.nodeId, a.deploymentId, user.id);
      return { success: true, message: 'Deployment restarted', data: presentDeployment(user, a, data) };
    }
    case 'kill_docker_deployment': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const data = await container.resolve(DockerDeploymentService).kill(a.nodeId, a.deploymentId, user.id);
      return { success: true, message: 'Deployment killed', data: presentDeployment(user, a, data) };
    }
    case 'deploy_docker_deployment': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const service = container.resolve(DockerDeploymentService);
      const requested = DockerDeploymentDeploySchema.parse(args);
      const removeEnv = DeploymentEnvRemovalSchema.parse(a.removeEnv);
      // removeEnv changes the environment as env does.
      ensureDeploymentChangeAccess(
        context,
        user,
        a.nodeId,
        a.deploymentId,
        deploymentDeployRequiredScopes({ ...requested, env: requested.env ?? removeEnv })
      );
      const input = await deployInputWithMergedEnv(service, a.nodeId, a.deploymentId, requested, removeEnv);
      const data = await service.deploy(a.nodeId, a.deploymentId, input, user.id, 'manual', user.scopes);
      return { success: true, message: 'Deployment rollout started', data: presentDeployment(user, a, data) };
    }
    case 'switch_docker_deployment_slot': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const input = DockerDeploymentSwitchSchema.parse(args);
      const data = await container
        .resolve(DockerDeploymentService)
        .switchToSlot(a.nodeId, a.deploymentId, input, user.id, undefined, user.scopes);
      return { success: true, message: `Deployment switched to ${input.slot}`, data: presentDeployment(user, a, data) };
    }
    case 'rollback_docker_deployment': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const data = await container
        .resolve(DockerDeploymentService)
        .rollback(a.nodeId, a.deploymentId, a.force === true, user.id, user.scopes);
      return { success: true, message: 'Deployment rolled back', data: presentDeployment(user, a, data) };
    }
    case 'stop_docker_deployment_slot': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const slot = DockerDeploymentSwitchSchema.shape.slot.parse(a.slot);
      await container.resolve(DockerDeploymentService).stopSlot(a.nodeId, a.deploymentId, slot, user.id);
      return { success: true, message: `Deployment ${slot} slot stopped` };
    }
    case 'start_docker_container':
      await ensureDockerContainerScope(context, user, 'docker:containers:manage', a.nodeId, a.containerId);
      await assertComposeChildMutationAllowed(a.nodeId, a.containerId);
      await context.dockerService.startContainer(a.nodeId, a.containerId, user.id);
      return { success: true };
    case 'stop_docker_container': {
      await ensureDockerContainerScope(context, user, 'docker:containers:manage', a.nodeId, a.containerId);
      await assertComposeChildMutationAllowed(a.nodeId, a.containerId);
      const stopped = await context.dockerService.stopContainer(
        a.nodeId,
        a.containerId,
        ContainerStopSchema.parse({ timeout: a.timeout }).timeout,
        user.id
      );
      return lifecycleToolResult(stopped, 'Container stopped', 'Container stop requested', 'State.Status is exited');
    }
    case 'restart_docker_container': {
      await ensureDockerContainerScope(context, user, 'docker:containers:manage', a.nodeId, a.containerId);
      await assertComposeChildMutationAllowed(a.nodeId, a.containerId);
      const restarted = await context.dockerService.restartContainer(
        a.nodeId,
        a.containerId,
        ContainerStopSchema.parse({ timeout: a.timeout }).timeout,
        user.id
      );
      return lifecycleToolResult(
        restarted,
        'Container restarted',
        'Container restart requested',
        'State.Status is running again'
      );
    }
    case 'kill_docker_container': {
      await ensureDockerContainerScope(context, user, 'docker:containers:manage', a.nodeId, a.containerId);
      await assertComposeChildMutationAllowed(a.nodeId, a.containerId);
      const { signal } = ContainerKillSchema.parse({ signal: a.signal });
      const killed = await context.dockerService.killContainer(a.nodeId, a.containerId, signal, user.id);
      return lifecycleToolResult(
        killed,
        killed.notRunning ? 'The container is not running: nothing was signalled' : `Sent ${signal} to the container`,
        `Sent ${signal} to the container`,
        'State.Status is exited'
      );
    }
    case 'remove_docker_container':
      // As DELETE /containers/:id: a Git-source container its first build has not created is authorized on its
      // reserved identity and refused with 409 SOURCE_CONTAINER_NOT_BUILT.
      await ensureDockerSourceContainerScope(
        context.dockerService,
        user,
        'docker:containers:delete',
        a.nodeId,
        a.containerId
      );
      await assertNotPendingSourceContainer(a.nodeId, a.containerId);
      await assertComposeChildMutationAllowed(a.nodeId, a.containerId);
      return lifecycleToolResult(
        await context.dockerService.removeContainer(a.nodeId, a.containerId, a.force ?? false, user.id),
        'Container removed',
        'Container removed',
        'get_docker_container answers NOT_FOUND (the remove task removes it once the stop ended)'
      );
    case 'rename_docker_container':
      await ensureDockerContainerScope(context, user, 'docker:containers:edit', a.nodeId, a.containerId);
      await assertComposeChildMutationAllowed(a.nodeId, a.containerId);
      await context.dockerService.renameContainer(a.nodeId, a.containerId, a.name, user.id);
      return { success: true };
    case 'duplicate_docker_container': {
      // The duplicate route: docker:containers:create, plus environment and secrets on the source.
      await ensureDockerContainerScopes(
        context,
        user,
        ['docker:containers:environment', 'docker:containers:secrets'],
        a.nodeId,
        a.containerId
      );
      await assertComposeChildMutationAllowed(a.nodeId, a.containerId);
      const { name, folderId } = ContainerDuplicateSchema.parse({ name: a.name, folderId: a.folderId });
      const dupData = await context.dockerService.duplicateContainer(
        a.nodeId,
        a.containerId,
        name,
        user.id,
        user.scopes,
        folderId
      );
      return { success: true, message: 'Container duplicated', data: dupData };
    }
    case 'get_docker_container_stats':
      await ensureDockerContainerScope(context, user, 'docker:containers:view', a.nodeId, a.containerId);
      return context.dockerService.getContainerStats(a.nodeId, a.containerId);
    case 'update_docker_container_image': {
      // Mirrors the recreate route: an image change can expose the container's
      // environment and secrets, so it needs the same scopes as duplicate plus image pull access.
      // The access check reads the container from the node: a node lost there is answered as during the recreate.
      const inspectData = await withNodeLossAnswer(
        'recreate',
        () =>
          assertDockerContainerRecreateAccess(context.dockerService, user, a.nodeId, a.containerId, {
            image: String(a.imageTag ?? ''),
          }),
        (message) => context.dockerService.recordNodeLostTask(a.nodeId, a.containerId, 'recreate', message)
      );
      // A container under Availability runs a mirrored image on every replica: its own image is the workload's.
      const containerName = String((inspectData as any)?.Name ?? '').replace(/^\/+/, '');
      const managed = containerName
        ? await context.dockerService.getManagedContainerConfiguration(a.nodeId, containerName)
        : null;
      const currentImage: string = managed?.image || ((inspectData as any)?.Config?.Image ?? '');
      if (!currentImage) return { error: 'Cannot determine current container image' };
      if (currentImage.includes('@') || /^[a-f0-9]{64}$/i.test(currentImage)) {
        return {
          error: 'Digest and image-ID references cannot be retagged safely; provide a tagged image reference instead',
        };
      }
      const lastColon = currentImage.lastIndexOf(':');
      const lastSlash = currentImage.lastIndexOf('/');
      const imageName = lastColon > lastSlash ? currentImage.slice(0, lastColon) : currentImage;
      const targetRef = `${imageName}:${a.imageTag}`;
      const data = await withNodeLossAnswer(
        'recreate',
        () =>
          context.dockerService.recreateWithConfig(a.nodeId, a.containerId, { image: targetRef }, user.id, {
            actorScopes: user.scopes,
            backgroundImagePull: true,
          }),
        (message) => context.dockerService.recordNodeLostTask(a.nodeId, a.containerId, 'recreate', message)
      );
      return {
        success: true,
        message: managed
          ? `Image update to ${targetRef} rolls out to every Availability replica`
          : `Container image update accepted for ${targetRef}; track task ${String(data?.taskId ?? '')}`,
        data,
      };
    }
    case 'get_docker_container_logs': {
      await ensureDockerContainerScope(context, user, 'docker:containers:view', a.nodeId, a.containerId);
      const { tail, timestamps } = LogQuerySchema.parse({ tail: a.tail, timestamps: a.timestamps });
      return context.dockerService.getContainerLogs(a.nodeId, a.containerId, tail, timestamps);
    }
    case 'list_docker_images': {
      const images = await context.dockerService.listImages(a.nodeId);
      const decorated = Array.isArray(images)
        ? await context.dockerService.decoratePublicImageSnapshot(a.nodeId, images)
        : images;
      return Array.isArray(decorated)
        ? compactAgentList(
            decorated
              .filter(
                (image: any) =>
                  hasDockerResourceScope(user.scopes, 'docker:images:view', a.nodeId, '') ||
                  hasDockerResourceScope(
                    user.scopes,
                    'docker:images:view',
                    a.nodeId,
                    String(image.scopeResourceId ?? image.id ?? image.Id ?? '')
                  )
              )
              .filter((image: any) => dockerImageMatchesSearch(image, a.search))
              .map((image: any) => compactDockerImageForAgent(image))
          )
        : decorated;
    }
    case 'pull_docker_image': {
      const input = ImagePullSchema.parse({
        imageRef: a.imageRef,
        registryId: optionalNonEmptyString(a.registryId),
        folderId: a.folderId,
        workload: a.workload,
      });
      const { DockerRegistryService } = await import('@/modules/docker/docker-registry.service.js');
      const registryService = container.resolve(DockerRegistryService);
      const auth = await registryService.resolveAuthForImagePull(a.nodeId, input.imageRef, input.registryId, {
        actorScopes: user.scopes,
      });
      let finalImageRef = input.imageRef;
      if (auth && !hasRegistryHost(input.imageRef)) {
        finalImageRef = `${auth.url}/${input.imageRef}`;
      }
      if (input.workload) {
        // POST /images/pull-sync with workload: the container/deployment destination authorizes the pull.
        try {
          await context.dockerService.pullImageForWorkload(
            a.nodeId,
            finalImageRef,
            auth?.authJson,
            input.workload.folderId,
            user.id,
            user.scopes
          );
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(
            400,
            'PULL_FAILED',
            error instanceof Error ? error.message : `Failed to pull ${finalImageRef}`
          );
        }
        await registryService.rememberImageRegistry(a.nodeId, finalImageRef, auth?.registryId);
        return { success: true, message: `Pulled ${finalImageRef}`, data: { imageRef: finalImageRef } };
      }
      if (a.wait === true) {
        // POST /images/pull-sync: pull now, validate the image exists, and remember its registry.
        try {
          await context.dockerService.pullImageImmediate(
            a.nodeId,
            finalImageRef,
            auth?.authJson,
            input.folderId,
            user.id,
            user.scopes
          );
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(
            400,
            'PULL_FAILED',
            error instanceof Error ? error.message : `Failed to pull ${finalImageRef}`
          );
        }
        await registryService.rememberImageRegistry(a.nodeId, finalImageRef, auth?.registryId);
        return { success: true, message: `Pulled ${finalImageRef}`, data: { imageRef: finalImageRef } };
      }
      const data = await context.dockerService.pullImage(
        a.nodeId,
        finalImageRef,
        auth?.authJson,
        user.id,
        auth?.registryId,
        input.folderId,
        user.scopes
      );
      return { success: true, message: `Pulling ${finalImageRef}`, data };
    }
    case 'remove_docker_image':
      context.ensureToolScopeForResource(user, 'docker:images:delete', `${a.nodeId}/${a.imageId}`);
      await context.dockerService.removeImage(a.nodeId, a.imageId, a.force ?? false, user.id);
      return { success: true };
    case 'prune_docker_images': {
      context.ensureToolScopeForResource(user, 'docker:images:delete', String(a.nodeId));
      if (a.dryRun === true) {
        const preview = await context.dockerService.previewPruneImages(a.nodeId);
        return {
          success: true,
          message: `A prune would remove ${preview.removable.length} image(s) now; ${preview.waiting.length} more wait for their unused time`,
          data: preview,
        };
      }
      const pruneData = await context.dockerService.pruneImages(a.nodeId, user.id);
      return { success: true, message: 'Unused images pruned', data: pruneData };
    }
    case 'list_docker_volumes': {
      const volumes = await context.dockerService.listVolumes(a.nodeId);
      return Array.isArray(volumes)
        ? compactAgentList(
            volumes
              .filter(
                (volume: any) =>
                  hasDockerResourceScope(user.scopes, 'docker:volumes:view', a.nodeId, '') ||
                  hasDockerResourceScope(
                    user.scopes,
                    'docker:volumes:view',
                    a.nodeId,
                    String(volume.name ?? volume.Name ?? '')
                  )
              )
              .filter((volume: any) => dockerVolumeMatchesSearch(volume, a.search))
              .map((volume: any) => compactDockerVolumeForAgent(volume))
          )
        : volumes;
    }
    case 'list_docker_networks':
      return listDockerNetworksForAgent(context.dockerService, user, a);
    case 'manage_docker_registry':
      return manageDockerRegistry(context, user, args);
    case 'manage_docker_volume':
      return manageDockerVolume(context, user, args);
    case 'manage_docker_network':
      return manageDockerNetworkForAgent(context.dockerService, user, args);
    case 'manage_container_link':
      return manageContainerLinkForAgent(user, args);
    case 'manage_docker_compose':
      return manageDockerCompose(context, user, args);
    case 'list_docker_builds':
      return listDockerBuilds(user, args);
    case 'manage_docker_build':
      return manageDockerBuild(user, args);
    case 'manage_docker_source':
      return manageDockerSource(context, user, args);
    case 'manage_docker_task':
      return manageDockerTask(user, args);
    case 'manage_docker_deployment':
      return manageDockerDeployment(context, user, args);
    case 'force_cancel_docker_task':
      return forceCancelDockerTask(user, args);
    case 'manage_docker_container':
      return manageDockerContainerTool(context.dockerService, user, args);
    case 'manage_docker_availability':
      return manageDockerAvailabilityTool(user, args);
    case 'manage_docker_runtime':
      return manageDockerRuntime(context, user, args);
    case 'upload_docker_container_archive':
      return args.operation === 'link'
        ? createDockerArchiveUploadLink(user, args)
        : dockerArchiveTransferStore().upload(user, args);
    case 'download_docker_archive':
      return args.operation === 'link'
        ? createDockerArchiveDownloadLink(context.dockerService, user, args)
        : dockerArchiveTransferStore().download(context.dockerService, user, args);
    default:
      throw new Error(`Unsupported Docker tool: ${toolName}`);
  }
}

async function manageDockerCompose(context: DockerToolContext, user: User, args: Record<string, unknown>) {
  const a = args as any;
  const operation = String(a.operation);
  const service = container.resolve(DockerComposeService);

  if (operation === 'list') {
    if (!hasScopeBase(user.scopes, 'docker:compose:view')) {
      throw new Error('PERMISSION_DENIED: Missing required scope docker:compose:view');
    }
    const nodeId = optionalNonEmptyString(a.nodeId);
    const projects = await service.list(nodeId);
    return withDockerAppMembers(
      'compose',
      projects.filter((project) =>
        hasDockerResourceScope(user.scopes, 'docker:compose:view', project.nodeId, project.id)
      ),
      (project) => ({ nodeId: project.nodeId, resourceKey: project.id }),
      parseAppListFilter(a)
    );
  }

  const nodeId = String(a.nodeId || '');
  if (!nodeId) throw new Error('nodeId is required');
  if (operation === 'validate' || operation === 'create') {
    if (!hasScopeBase(user.scopes, 'docker:compose:create')) throw new Error('Missing docker:compose:create');
    await container.resolve(LicensePolicyService).requireFeature('compose-applications');
    if (operation === 'validate') {
      return service.validate(
        ComposeYamlInputSchema.parse({
          projectName: a.projectName,
          yaml: a.yaml,
          variables: a.variables ?? {},
          secretKeys: a.secretKeys ?? [],
        })
      );
    }
    return service.create(
      nodeId,
      ComposeCreateInputSchema.parse({
        folderId: a.folderId,
        projectName: a.projectName,
        yaml: a.yaml,
        variables: a.variables ?? {},
        secretKeys: a.secretKeys ?? [],
      }),
      user.id,
      user.scopes
    );
  }

  const projectId = String(a.projectId || '');
  if (!projectId) throw new Error('projectId is required');
  const resourceId = `${nodeId}/${projectId}`;

  if (operation === 'get') {
    context.ensureToolScopeForResource(user, 'docker:compose:view', resourceId);
    return service.get(nodeId, projectId);
  }
  if (operation === 'adopt') {
    context.ensureToolScopeForResource(user, 'docker:compose:create', resourceId);
    context.ensureToolScopeForResource(user, 'docker:compose:manage', resourceId);
    await container.resolve(LicensePolicyService).requireFeature('compose-applications');
    return service.adopt(
      nodeId,
      projectId,
      ComposeAdoptInputSchema.parse({
        yaml: a.yaml,
        variables: a.variables ?? {},
        secretKeys: a.secretKeys ?? [],
      }),
      user.id
    );
  }
  if (operation === 'delete') {
    context.ensureToolScopeForResource(user, 'docker:compose:delete', resourceId);
    await container.resolve(LicensePolicyService).requireFeatureForExistingRuntime('compose-applications');
    await service.deleteProject(nodeId, projectId, user.id);
    return { success: true };
  }
  if (operation === 'revision_list') {
    context.ensureToolScopeForResource(user, 'docker:compose:view', resourceId);
    await service.get(nodeId, projectId);
    return service.listRevisions(projectId);
  }
  if (operation === 'revision_get') {
    context.ensureToolScopeForResource(user, 'docker:compose:view', resourceId);
    await service.get(nodeId, projectId);
    return service.getRevisionForApi(projectId, String(a.revisionId || ''));
  }
  if (operation === 'revision_create') {
    context.ensureToolScopeForResource(user, 'docker:compose:manage', resourceId);
    await container.resolve(LicensePolicyService).requireFeature('compose-applications');
    return service.createRevision(
      nodeId,
      projectId,
      ComposeRevisionCreateInputSchema.parse({
        yaml: a.yaml,
        variables: a.variables ?? {},
        secretKeys: a.secretKeys ?? [],
      }),
      user.id
    );
  }
  if (operation === 'revision_delete') {
    context.ensureToolScopeForResource(user, 'docker:compose:manage', resourceId);
    await container.resolve(LicensePolicyService).requireFeatureForExistingRuntime('compose-applications');
    await service.deleteRevision(nodeId, projectId, String(a.revisionId || ''), user.id);
    return { success: true };
  }
  if (operation === 'operation_list') {
    context.ensureToolScopeForResource(user, 'docker:compose:view', resourceId);
    return service.listOperations(
      nodeId,
      projectId,
      ComposeOperationListQuerySchema.parse({ cursor: a.cursor, limit: a.limit ?? 50 })
    );
  }
  if (operation === 'operation_start') {
    const action = ComposeOperationActionSchema.parse(a.action);
    context.ensureToolScopeForResource(
      user,
      action === 'delete_volumes' ? 'docker:compose:delete' : 'docker:compose:manage',
      resourceId
    );
    // Lifecycle and delete actions on existing projects keep working after the grace period.
    if (['start', 'stop', 'restart', 'down', 'cancel', 'delete_volumes'].includes(action)) {
      await container.resolve(LicensePolicyService).requireFeatureForExistingRuntime('compose-applications');
    } else {
      await container.resolve(LicensePolicyService).requireFeature('compose-applications');
    }
    return service.startOperation(
      nodeId,
      projectId,
      action,
      ComposeOperationInputSchema.parse({
        revisionId: a.revisionId,
        idempotencyKey: a.idempotencyKey,
        removeOrphans: a.removeOrphans,
        volumeNames: a.volumeNames ?? [],
      }),
      user.id
    );
  }
  if (operation === 'secret_list') {
    context.ensureToolScopeForResource(user, 'docker:compose:view', resourceId);
    return service.listSecrets(nodeId, projectId, false);
  }
  if (operation === 'secret_create') {
    context.ensureToolScopeForResource(user, 'docker:compose:manage', resourceId);
    await container.resolve(LicensePolicyService).requireFeature('compose-applications');
    const input = ComposeSecretCreateSchema.parse({ key: a.key, value: a.value });
    return service.createSecret(nodeId, projectId, input.key, input.value, user.id);
  }
  if (operation === 'secret_update') {
    context.ensureToolScopeForResource(user, 'docker:compose:manage', resourceId);
    await container.resolve(LicensePolicyService).requireFeature('compose-applications');
    const input = ComposeSecretUpdateSchema.parse({ value: a.value });
    return service.updateSecret(nodeId, projectId, String(a.secretId || ''), input.value, user.id);
  }
  if (operation === 'secret_delete') {
    context.ensureToolScopeForResource(user, 'docker:compose:manage', resourceId);
    await container.resolve(LicensePolicyService).requireFeatureForExistingRuntime('compose-applications');
    await service.deleteSecret(nodeId, projectId, String(a.secretId || ''), user.id);
    return { success: true };
  }
  if (operation === 'logs') {
    // The Compose log viewer: docker:compose:view on the project covers every service container.
    context.ensureToolScopeForResource(user, 'docker:compose:view', resourceId);
    const project = await service.get(nodeId, projectId);
    const { tail, timestamps } = LogQuerySchema.parse({ tail: a.tail, timestamps: a.timestamps });
    const serviceName = optionalNonEmptyString(a.serviceName);
    const services = (project.services ?? []).filter((item) => !serviceName || item.name === serviceName);
    const logs = [];
    for (const item of services) {
      for (const containerId of item.containerIds ?? []) {
        logs.push({
          service: item.name,
          containerId,
          lines: await context.dockerService.getContainerLogs(nodeId, containerId, tail, timestamps),
        });
      }
    }
    return { projectId, services: logs };
  }
  throw new Error(`Unsupported Docker Compose operation: ${operation}`);
}

async function executeDockerContainerConsoleCommand(
  context: DockerToolContext,
  user: User,
  args: Record<string, unknown>
) {
  const nodeId = String(args.nodeId || '');
  const containerId = String(args.containerId || '');
  if (!nodeId) throw new Error('nodeId is required');
  if (!containerId) throw new Error('containerId is required');
  await ensureDockerContainerScope(context, user, 'docker:containers:console', nodeId, containerId);

  const safety = inspectConsoleCommand(args.command as string[]);
  if (safety.blocked) {
    throw new Error(safety.reason ?? 'Console command is blocked');
  }

  const result = await container.resolve(NodeDispatchService).sendDockerExecCommand(
    nodeId,
    'run',
    {
      containerId,
      command: safety.normalizedCommand,
      user: typeof args.user === 'string' ? args.user : undefined,
    },
    35000
  );
  if (!result.success) {
    throw new Error(result.error || 'Docker console command failed');
  }
  const output = parseConsoleCommandResult(result.detail);
  return {
    nodeId,
    containerId,
    command: safety.normalizedCommand,
    risky: safety.risky,
    ...output,
  };
}

async function ensureDockerContainerScope(
  context: DockerToolContext,
  user: User,
  baseScope: string,
  nodeId: string,
  containerId: string
): Promise<void> {
  await ensureDockerContainerScopes(context, user, [baseScope], nodeId, containerId);
}

/** Inspect once, require every scope on the container, and return the inspect data. */
async function ensureDockerContainerScopes(
  context: DockerToolContext,
  user: User,
  baseScopes: readonly string[],
  nodeId: string,
  containerId: string
): Promise<any> {
  const inspected = await inspectUserContainer(context.dockerService, nodeId, containerId);
  const resourceId = String(inspected?.scopeResourceId ?? '');
  if (!resourceId) throw new Error('PERMISSION_DENIED: Container authorization identity is unavailable');
  for (const baseScope of baseScopes) {
    context.ensureToolScopeForResource(user, baseScope, `${nodeId}/${resourceId}`);
  }
  return inspected;
}

/**
 * A container lifecycle answer for an agent. A request waits at most 45 s; an operation still running then goes on
 * as its task, and the result says so and how to wait for it instead of reporting a failure.
 */
function lifecycleToolResult(
  answer: ContainerOperationAnswer | undefined,
  doneMessage: string,
  requestedMessage: string,
  waitUntil: string
) {
  if (!answer) return { success: true, message: requestedMessage };
  if (!answer.pending) return { success: true, message: doneMessage, data: answer };
  const task = answer.taskId
    ? ` or follow task ${answer.taskId} with manage_docker_task (operation get) until it succeeded`
    : '';
  return {
    success: true,
    pending: true,
    message: `The container is still ${answer.pending}: Opfield stopped waiting after 45 s and the operation goes on. Do not repeat the request. Read the container with get_docker_container until ${waitUntil}${task}.`,
    data: pendingOperationBody({ ...answer, pending: answer.pending }),
  };
}

function hasDockerContainerScope(user: User, baseScope: string, nodeId: string, inspected: any): boolean {
  const resourceId = String(inspected?.scopeResourceId ?? '');
  return !!resourceId && hasScopeForResource(user.scopes, baseScope, `${nodeId}/${resourceId}`);
}

/** Deployment results carry env and the webhook token; shape them like the deployment routes do. */
function presentDeployment<T>(user: User, a: { nodeId: string; deploymentId: string }, data: T): T {
  return presentDeploymentForCaller(data, user.scopes, a.nodeId, a.deploymentId);
}

function ensureDockerDeploymentScope(
  context: DockerToolContext,
  user: User,
  baseScope: string,
  nodeId: string,
  deploymentId: string
): void {
  context.ensureToolScopeForResource(user, baseScope, `${nodeId}/${deploymentId}`);
}

const DeploymentEnvRemovalSchema = z.array(z.string()).optional();

/**
 * deploy_docker_deployment changes the environment as manage_docker_container update does: env sets variables over
 * the saved environment and removeEnv removes keys, so changing one variable keeps the others. The REST deploy route
 * replaces the whole environment with its env.
 */
export async function deployInputWithMergedEnv(
  service: Pick<DockerDeploymentService, 'get'>,
  nodeId: string,
  deploymentId: string,
  input: DockerDeploymentDeployInput,
  removeEnv: string[] | undefined
): Promise<DockerDeploymentDeployInput> {
  if (input.env === undefined && removeEnv === undefined) return input;
  const saved = await service.get(nodeId, deploymentId);
  const env: Record<string, string> = { ...(saved.desiredConfig.env ?? {}), ...(input.env ?? {}) };
  for (const key of removeEnv ?? []) delete env[key];
  return { ...input, env };
}

/** The deploy and update route rule (assertDeploymentChangeAccess in docker-deployment.routes.ts). */
function ensureDeploymentChangeAccess(
  context: DockerToolContext,
  user: User,
  nodeId: string,
  deploymentId: string,
  required: string[]
): void {
  for (const scope of required) ensureDockerDeploymentScope(context, user, scope, nodeId, deploymentId);
}

async function manageDockerRegistry(context: DockerToolContext, user: User, args: Record<string, unknown>) {
  const a = args as any;
  const { DockerRegistryService } = await import('@/modules/docker/docker-registry.service.js');
  const registryService = container.resolve(DockerRegistryService);
  const operation = String(a.operation);
  switch (operation) {
    case 'list':
      context.ensureToolScope(user, 'docker:registries:view');
      return registryService.list(typeof a.nodeId === 'string' ? a.nodeId : undefined);
    case 'get':
      context.ensureToolScopeForResource(user, 'docker:registries:view', String(a.registryId));
      return registryService.get(String(a.registryId));
    case 'create':
      context.ensureToolScope(user, 'docker:registries:create');
      if (
        isPublicDockerHubRegistryUrl(a.url) &&
        !optionalNonEmptyString(a.username) &&
        !optionalNonEmptyString(a.password)
      ) {
        throw new Error(
          'PUBLIC_DOCKER_HUB_REGISTRY_NOT_REQUIRED: Pull public Docker Hub images without registryId; do not create a saved registry'
        );
      }
      return registryService.create(
        RegistryCreateSchema.parse({
          ...args,
          nodeId: optionalNonEmptyString(a.nodeId),
        }),
        user.id
      );
    case 'update':
      context.ensureToolScopeForResource(user, 'docker:registries:edit', String(a.registryId));
      return registryService.update(String(a.registryId), RegistryUpdateSchema.parse(args), user.id);
    case 'delete':
      context.ensureToolScopeForResource(user, 'docker:registries:delete', String(a.registryId));
      await registryService.delete(String(a.registryId), user.id);
      return { success: true };
    case 'test':
      context.ensureToolScopeForResource(user, 'docker:registries:edit', String(a.registryId));
      return registryService.testConnection(String(a.registryId), { actorScopes: user.scopes });
    case 'test_direct':
      context.ensureToolScope(user, 'docker:registries:edit');
      return registryService.testConnectionDirect(
        String(a.url),
        typeof a.username === 'string' ? a.username : undefined,
        typeof a.password === 'string' ? a.password : undefined,
        typeof a.trustedAuthRealm === 'string' ? a.trustedAuthRealm : undefined
      );
    // The internal registry routes require broad docker:registries:view or :edit.
    case 'internal_get': {
      context.ensureToolScope(user, 'docker:registries:view');
      const { DockerRegistryStorageService } = await import(
        '@/modules/docker/registry-storage/registry-storage.service.js'
      );
      const state = await container.resolve(DockerInternalRegistryService).getState();
      return { ...state, storage: await container.resolve(DockerRegistryStorageService).getView() };
    }
    case 'internal_repositories': {
      context.ensureToolScope(user, 'docker:registries:view');
      const { DockerBuildService } = await import('@/modules/docker/docker-build.service.js');
      return container.resolve(DockerBuildService).listInternalRegistryRepositories();
    }
    case 'internal_update_settings': {
      context.ensureToolScope(user, 'docker:registries:edit');
      const [{ DockerRegistryStorageService }, { DockerInternalRegistryUpdateSchema }] = await Promise.all([
        import('@/modules/docker/registry-storage/registry-storage.service.js'),
        import('@/modules/docker/registry-storage/registry-storage.schemas.js'),
      ]);
      const { storage, ...external } = DockerInternalRegistryUpdateSchema.parse({
        externalAccessEnabled: a.externalAccessEnabled,
        externalHostname: optionalNonEmptyString(a.externalHostname),
        externalNginxNodeId: optionalNonEmptyString(a.externalNginxNodeId),
        externalCertificateId: optionalNonEmptyString(a.externalCertificateId),
        storage: a.storage,
      });
      const storageService = container.resolve(DockerRegistryStorageService);
      if (storage) {
        if (storage.backend === 's3' && storage.connectionId) {
          context.ensureToolScopeForResource(user, 'storage:credentials:use', storage.connectionId);
        }
        await storageService.update(storage, { userId: user.id, scopes: user.scopes });
      }
      const registry = container.resolve(DockerInternalRegistryService);
      const state =
        external.externalAccessEnabled === undefined
          ? await registry.getState()
          : await registry.updateSettings(DockerInternalRegistrySettingsSchema.parse(external), user.id);
      return { ...state, storage: await storageService.getView() };
    }
    case 'internal_gc': {
      context.ensureToolScope(user, 'docker:registries:edit');
      return container.resolve(DockerInternalRegistryService).runGarbageCollection({
        dryRun: a.dryRun === true,
        requestedById: user.id,
      });
    }
    case 'internal_resume_maintenance':
      context.ensureToolScope(user, 'docker:registries:edit');
      return container.resolve(DockerInternalRegistryService).resumeMaintenance(z.string().uuid().parse(a.runId));
    default:
      throw new Error(`Unsupported Docker registry operation: ${operation}`);
  }
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isPublicDockerHubRegistryUrl(value: unknown): boolean {
  const raw = optionalNonEmptyString(value);
  if (!raw) return false;
  try {
    const hostname = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
    return hostname === 'docker.io' || hostname === 'index.docker.io' || hostname === 'registry-1.docker.io';
  } catch {
    return false;
  }
}

/**
 * Mirrors docker-volume.routes.ts: the same scopes, zod schemas, visibility
 * checks (requireDockerVolumeScope 'live' = assertUserVolumeVisible), Compose
 * ownership guard, and service calls as the matching REST route.
 */
async function manageDockerVolume(context: DockerToolContext, user: User, args: Record<string, unknown>) {
  const a = args as any;
  const operation = String(a.operation);
  const nodeId = String(a.nodeId);
  const name = operation === 'managed_options' ? '' : requiredToolString(a.name, 'name');
  if (operation === 'create') {
    // POST /nodes/:nodeId/volumes: createVolume enforces docker:volumes:create for the node or folder.
    const input = VolumeCreateSchema.parse({
      name: a.name,
      storageKind: a.storageKind,
      capacityBytes: a.capacityBytes,
      folderId: a.folderId,
    });
    return context.dockerService.createVolume(nodeId, input, user.id, user.scopes);
  }
  if (operation === 'resize') {
    // POST /nodes/:nodeId/volumes/:name/resize
    assertDockerResourceScope(user.scopes, DOCKER_VOLUME_EDIT_SCOPE, nodeId, name);
    await context.dockerService.assertUserVolumeVisible(nodeId, name);
    await assertComposeVolumeMutationAllowed(nodeId, name);
    const { capacityBytes } = VolumeResizeSchema.parse({ capacityBytes: a.capacityBytes });
    await context.dockerService.resizeVolume(nodeId, name, capacityBytes, user.id);
    return { success: true };
  }
  if (operation === 'adopt') {
    // POST /nodes/:nodeId/volumes/:name/adopt
    assertDockerResourceScope(user.scopes, DOCKER_VOLUME_EDIT_SCOPE, nodeId, name);
    await context.dockerService.assertUserVolumeVisible(nodeId, name);
    assertDockerResourceScope(user.scopes, 'docker:volumes:view', nodeId, name);
    await assertComposeVolumeMutationAllowed(nodeId, name);
    return context.dockerService.adoptVolume(nodeId, name, user.id);
  }
  if (operation === 'delete') {
    // DELETE /nodes/:nodeId/volumes/:name; removeVolume re-checks user visibility itself.
    context.ensureToolScopeForResource(user, 'docker:volumes:delete', `${nodeId}/${name}`);
    await assertComposeVolumeMutationAllowed(nodeId, name);
    await context.dockerService.removeVolume(nodeId, name, Boolean(a.force), user.id);
    return { success: true };
  }
  if (operation === 'managed_options') {
    // GET /nodes/:nodeId/managed-volumes: the managed volumes the caller may attach (docker:volumes:view on each).
    const rows = await context.dockerService.listManagedVolumeOptions(nodeId);
    return rows.filter((row) => hasDockerResourceScope(user.scopes, 'docker:volumes:view', nodeId, row.name));
  }
  if (operation === 'inspect') {
    // GET /nodes/:nodeId/volumes/:name serves the cached detail with the public visibility applied.
    assertDockerResourceScope(user.scopes, 'docker:volumes:view', nodeId, name);
    return inspectDockerVolumeSnapshot(nodeId, name);
  }
  if (operation === 'metrics') {
    assertDockerResourceScope(user.scopes, 'docker:volumes:view', nodeId, name);
    await assertSnapshotVolumeVisible(nodeId, name);
    return getDockerVolumeMetricsSnapshot(nodeId, name);
  }
  if (operation === 'rename' || operation === 'update_labels') {
    // POST .../rename and PUT .../labels: the volume edit scope on a visible, non-Compose volume.
    assertDockerResourceScope(user.scopes, DOCKER_VOLUME_EDIT_SCOPE, nodeId, name);
    await context.dockerService.assertUserVolumeVisible(nodeId, name);
    await assertComposeVolumeMutationAllowed(nodeId, name);
    if (operation === 'rename') {
      const { name: newName } = VolumeRenameSchema.parse({ name: a.newName });
      await context.dockerService.renameVolume(nodeId, name, newName, user.id);
    } else {
      const { labels } = VolumeLabelsUpdateSchema.parse({ labels: a.labels });
      await context.dockerService.updateVolumeLabels(nodeId, name, labels, user.id);
    }
    return { success: true };
  }
  if (VOLUME_FILE_OPERATIONS.has(operation)) return manageDockerVolumeFiles(context, user, operation, args);
  throw new Error(`Unsupported Docker volume operation: ${operation}`);
}

const VOLUME_FILE_OPERATIONS = new Set([
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

/**
 * Mirrors the volume file-browser routes: docker:volumes:files:read or :write
 * on a volume the user can see; writes are refused on Compose-owned volumes.
 */
async function manageDockerVolumeFiles(
  context: DockerToolContext,
  user: User,
  operation: string,
  args: Record<string, unknown>
) {
  const a = args as any;
  const nodeId = String(a.nodeId);
  const name = String(a.name);
  const service = context.dockerService;
  const readOnly = operation === 'list_files' || operation === 'read_file';
  assertDockerResourceScope(
    user.scopes,
    readOnly ? 'docker:volumes:files:read' : 'docker:volumes:files:write',
    nodeId,
    name
  );
  await service.assertUserVolumeVisible(nodeId, name);
  if (!readOnly) await assertComposeVolumeMutationAllowed(nodeId, name);
  switch (operation) {
    case 'list_files':
      return service.listVolumeFiles(nodeId, name, FileBrowseSchema.parse({ path: a.path }).path);
    case 'read_file': {
      const { path } = FileBrowseSchema.parse({ path: a.path });
      return presentFileContent(path, await service.readVolumeFile(nodeId, name, path), args);
    }
    case 'write_file': {
      const { path } = FileBrowseSchema.parse({ path: a.path });
      await service.writeVolumeFile(nodeId, name, path, decodeFileContent(args), user.id);
      return { success: true };
    }
    case 'create_file': {
      const { path } = FileBrowseSchema.parse({ path: a.path });
      const hasContent = typeof a.content === 'string' || typeof a.contentBase64 === 'string';
      await service.createVolumeFile(
        nodeId,
        name,
        path,
        hasContent ? decodeFileContent(args) : Buffer.alloc(0),
        user.id
      );
      return { success: true };
    }
    case 'create_directory': {
      const { path } = FileBrowseSchema.parse({ path: a.path });
      await service.createVolumeDirectory(nodeId, name, path, user.id);
      return { success: true };
    }
    case 'delete_file': {
      const { path } = FileBrowseSchema.parse({ path: a.path });
      await service.deleteVolumeFile(nodeId, name, path, user.id);
      return { success: true };
    }
    case 'move_file': {
      const { fromPath, toPath } = FileMoveSchema.parse({ fromPath: a.fromPath, toPath: a.toPath });
      await service.moveVolumeFile(nodeId, name, fromPath, toPath, user.id);
      return { success: true };
    }
    case 'upload_init': {
      const { path, totalBytes } = FileUploadInitSchema.parse({ path: a.path, totalBytes: a.totalBytes });
      return service.initVolumeFileUpload(nodeId, name, path, totalBytes, user.id);
    }
    case 'upload_chunk': {
      const uploadId = requiredToolString(a.uploadId, 'uploadId');
      const { offset } = FileUploadChunkQuerySchema.parse({ offset: a.offset });
      return service.appendVolumeFileUploadChunk(nodeId, name, uploadId, offset, decodeUploadChunk(args));
    }
    case 'upload_complete': {
      const uploadId = requiredToolString(a.uploadId, 'uploadId');
      const { path, totalBytes } = FileUploadCompleteSchema.parse({ path: a.path, totalBytes: a.totalBytes });
      await service.completeVolumeFileUpload(nodeId, name, uploadId, path, totalBytes);
      return { success: true };
    }
    case 'upload_abort':
      await service.abortVolumeFileUpload(nodeId, name, requiredToolString(a.uploadId, 'uploadId'));
      return { success: true };
    default:
      throw new Error(`Unsupported Docker volume file operation: ${operation}`);
  }
}

async function listDockerBuilds(user: User, args: Record<string, unknown>) {
  const a = args as any;
  let sourceBindingId = optionalNonEmptyString(a.sourceBindingId);
  const containerName = optionalNonEmptyString(a.containerName);
  if (containerName) {
    // The source of the container on nodeId, a container its first build has not created included.
    const { containerBuildSourceBindingId } = await import('@/modules/docker/docker-build-container-filter.js');
    const containerSource = await containerBuildSourceBindingId(optionalNonEmptyString(a.nodeId), containerName);
    if (!containerSource || (sourceBindingId && sourceBindingId !== containerSource)) return [];
    sourceBindingId = containerSource;
  }
  const query = DockerBuildListQuerySchema.parse({
    sourceBindingId,
    builderNodeId: optionalNonEmptyString(a.builderNodeId),
    status: optionalNonEmptyString(a.status),
    provider: optionalNonEmptyString(a.provider),
    branch: optionalNonEmptyString(a.branch),
    search: optionalNonEmptyString(a.search),
    limit: a.limit ?? 20,
  });
  const { DockerBuildService } = await import('@/modules/docker/docker-build.service.js');
  const builds = await filterBuildsByApp(
    await container.resolve(DockerBuildService).list(query),
    parseAppListFilter(a)
  );
  const visible = [];
  for (const build of builds) {
    if (a.nodeId && build.target.nodeId !== a.nodeId) continue;
    if (await canAccessDockerBuild(user, build, 'view')) visible.push(build);
  }
  return visible;
}

async function canAccessDockerBuild(user: User, build: any, action: 'view' | 'manage') {
  if (build.target.kind === 'pages_project') {
    return hasScopeForResource(
      user.scopes,
      action === 'view' ? 'pages:view' : 'pages:deploy',
      build.target.pageProjectId
    );
  }
  const compose = build.target.kind === 'compose_project';
  const baseScope = compose ? `docker:compose:${action}` : `docker:containers:${action}`;
  if (hasDockerResourceScope(user.scopes, baseScope, build.target.nodeId, '')) return true;
  // A pending Git source container exists only as its reservation until its first build creates it.
  const resourceId =
    build.target.kind === 'container'
      ? await container.resolve(DockerAccessResourceService).resolveContainer(build.target.nodeId, {
          name: build.target.containerName,
          includeReservations: true,
        })
      : build.target.kind === 'deployment'
        ? build.target.deploymentId
        : build.target.composeProjectId;
  if (!resourceId) return false;
  return hasDockerResourceScope(user.scopes, baseScope, build.target.nodeId, resourceId);
}

async function manageDockerBuild(user: User, args: Record<string, unknown>) {
  const a = args as any;
  const operation = String(a.operation);
  const buildId = String(a.buildId || '');
  if (!buildId) throw new Error('buildId is required');
  const { DockerBuildService } = await import('@/modules/docker/docker-build.service.js');
  const service = container.resolve(DockerBuildService);
  const build = await service.get(buildId);
  const action = operation === 'cancel' || operation === 'retry' ? 'manage' : 'view';
  if (!(await canAccessDockerBuild(user, build, action))) {
    throw new Error(`PERMISSION_DENIED: Missing build target ${action} scope`);
  }
  if (operation === 'get') return build;
  if (operation === 'logs') {
    const query = DockerBuildLogQuerySchema.parse({
      afterSequence: a.afterSequence ?? -1,
      limit: a.limit ?? 200,
    });
    const chunks = await service.listLogs(buildId, query.afterSequence, query.limit);
    // The daemon cuts output into chunks, so the text is the chunks joined, not one entry per chunk.
    return {
      text: chunks.map((chunk) => chunk.content).join(''),
      lastSequence: chunks.length > 0 ? chunks[chunks.length - 1]!.sequence : query.afterSequence,
      chunkCount: chunks.length,
      hasMore: chunks.length >= query.limit,
    };
  }
  if (operation === 'cancel') return service.requestCancellation(buildId, user.id);
  if (operation === 'retry') return service.retry(buildId, user.id);
  throw new Error(`Unsupported Docker build operation: ${operation}`);
}

/**
 * Mirrors the Docker source routes. Container targets accept a pending
 * Git-source container like `allowPendingSource`; deployment and Compose
 * targets must belong to the requested node.
 */
async function manageDockerSource(
  context: DockerToolContext,
  user: User,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;
  const operation = String(a.operation);
  const nodeId = String(a.nodeId || '');
  if (operation === 'admission') {
    // GET /nodes/:nodeId/source-resources/admission
    if (!hasScopeBase(user.scopes, 'docker:containers:create')) {
      throw new Error('PERMISSION_DENIED: Missing required scope docker:containers:create');
    }
    const { DockerBuildService } = await import('@/modules/docker/docker-build.service.js');
    return container.resolve(DockerBuildService).admissionStatus();
  }
  if (operation === 'connectors') {
    // GET /sources/connectors: any workload create/edit scope a source is picked for (Docker or Pages).
    if (!canListSourceConnectors(user.scopes)) {
      throw new Error('PERMISSION_DENIED: Picking a Git source requires create or edit access to its workload');
    }
    return listSourceConnectors(container.resolve(TOKENS.DrizzleClient) as DrizzleClient, user.scopes);
  }
  if (operation === 'repositories') {
    // GET /sources/connectors/:connectorId/repositories: the Docker workload create/edit scopes.
    if (!canPickDockerSource(user.scopes)) {
      throw new Error('PERMISSION_DENIED: Picking a Git source requires create or edit access to its workload');
    }
    return container
      .resolve(IntegrationsService)
      .findDockerBuildSourceRepositories(user, String(a.connectorId || ''), optionalNonEmptyString(a.search));
  }

  // upsert of an existing source: omitted fields and policy keys keep their saved values (create: defaults).
  const sourceConfig = (saved?: SavedDockerSource) =>
    DockerSourceBindingConfigSchema.parse({
      connectorId: a.connectorId ?? saved?.connectorId,
      projectId: a.projectId ?? saved?.projectId,
      branch: a.branch ?? saved?.branch,
      dockerfilePath: a.dockerfilePath ?? saved?.dockerfilePath ?? 'Dockerfile',
      contextPath: a.contextPath ?? saved?.contextPath ?? '.',
      composeFilePath: a.composeFilePath ?? saved?.composeFilePath ?? undefined,
      composeVariables: a.composeVariables ?? saved?.composeVariables ?? {},
      composeSecretKeys: a.composeSecretKeys ?? saved?.composeSecretKeys ?? [],
      autoBuild: a.autoBuild ?? saved?.autoBuild ?? true,
      autoDeploy: a.autoDeploy ?? saved?.autoDeploy ?? true,
      buildArgs: a.buildArgs ?? saved?.buildArgs ?? {},
      buildSecretNames: a.buildSecretNames ?? saved?.buildSecretNames ?? [],
      policy: { ...(saved?.policy ?? {}), ...(a.policy ?? {}) },
    });

  if (operation === 'create') {
    if (!nodeId) throw new Error('nodeId is required');
    if (a.targetType === 'compose') {
      // POST /nodes/:nodeId/compose-projects/from-source
      if (!hasScopeBase(user.scopes, 'docker:compose:create')) {
        throw new Error('PERMISSION_DENIED: Missing required scope docker:compose:create');
      }
      const input = ComposeSourceProjectCreateSchema.parse({
        folderId: a.folderId,
        projectName: a.projectName,
        source: sourceConfig(),
      });
      await container.resolve(LicensePolicyService).requireFeature('compose-applications');
      return createComposeProjectFromSource(nodeId, input, user);
    }
    // POST /nodes/:nodeId/source-resources
    if (!hasScopeBase(user.scopes, 'docker:containers:create')) {
      throw new Error('PERMISSION_DENIED: Missing required scope docker:containers:create');
    }
    await container.resolve(LicensePolicyService).requireFeature('git-push-to-deploy');
    const input = DockerSourceResourceCreateSchema.parse({
      source: sourceConfig(),
      resource:
        a.targetType === 'deployment'
          ? {
              kind: 'deployment',
              folderId: a.folderId,
              name: a.resourceName,
              routes: a.routes,
              health: a.health ?? {},
              drainSeconds: a.drainSeconds ?? 30,
              routerImage: a.routerImage ?? 'nginx:alpine',
              restartPolicy: a.restartPolicy ?? 'unless-stopped',
              runtimeProfile: a.runtimeProfile ?? 'default',
            }
          : {
              kind: 'container',
              folderId: a.folderId,
              name: a.resourceName,
              ...(a.volumes !== undefined ? { volumes: a.volumes } : {}),
              restartPolicy: a.restartPolicy ?? 'no',
              runtimeProfile: a.runtimeProfile ?? 'default',
              ...(a.env !== undefined ? { env: a.env } : {}),
              ...(a.secrets !== undefined ? { secrets: a.secrets } : {}),
            },
    });
    return createDockerSourceResource(nodeId, input, user);
  }

  const { DockerSourceService } = await import('@/modules/docker/docker-source.service.js');
  const sourceService = container.resolve(DockerSourceService);
  const targetType =
    a.targetType === 'deployment' ? 'deployment' : a.targetType === 'compose' ? 'compose' : 'container';
  if (operation === 'pending' && targetType !== 'container') {
    throw new Error('The pending operation applies to container targets only');
  }
  let target: DockerSourceTarget;
  if (targetType === 'compose') {
    const composeProjectId = String(a.composeProjectId || '');
    if (!composeProjectId) throw new Error('composeProjectId is required');
    const requiredScope =
      operation === 'get' || operation === 'secret_list' ? 'docker:compose:view' : 'docker:compose:manage';
    context.ensureToolScopeForResource(user, requiredScope, `${nodeId}/${composeProjectId}`);
    target = { kind: 'compose_project', composeProjectId };
    await assertDockerSourceTargetOnNode(nodeId, target);
    if (operation === 'upsert') {
      await container.resolve(LicensePolicyService).requireFeature('compose-applications');
    }
  } else if (targetType === 'deployment') {
    const deploymentId = String(a.deploymentId || '');
    if (!deploymentId) throw new Error('deploymentId is required');
    const requiredScope =
      operation === 'get' || operation === 'secret_list'
        ? 'docker:containers:view'
        : operation === 'build' || operation === 'sync' || operation === 'rollback'
          ? 'docker:containers:manage'
          : 'docker:containers:edit';
    ensureDockerDeploymentScope(context, user, requiredScope, nodeId, deploymentId);
    target = { kind: 'deployment', deploymentId };
    await assertDockerSourceTargetOnNode(nodeId, target);
  } else {
    const containerName = String(a.containerName || '');
    if (!containerName) throw new Error('containerName is required');
    const requiredScope =
      operation === 'get' || operation === 'secret_list' || operation === 'pending'
        ? 'docker:containers:view'
        : operation === 'build' || operation === 'sync' || operation === 'rollback'
          ? 'docker:containers:manage'
          : 'docker:containers:edit';
    await ensureDockerSourceContainerScope(context.dockerService, user, requiredScope, nodeId, containerName);
    target = { kind: 'container', nodeId, containerName };
  }

  switch (operation) {
    case 'get': {
      // With the latest build and a plain state, so a caller sees why nothing is deployed.
      const { getDockerSourceWithBuildState } = await import('@/modules/docker/docker-source-build-state.js');
      return getDockerSourceWithBuildState(target);
    }
    case 'pending': {
      const pending = await sourceService.getPendingContainer(nodeId, String(a.containerName));
      if (!pending) throw new AppError(404, 'PENDING_SOURCE_NOT_FOUND', 'Pending source container not found');
      // With the latest build and state, so a failed first build says why and what to do.
      const { withPendingDockerSourceBuildState } = await import('@/modules/docker/docker-source-build-state.js');
      return withPendingDockerSourceBuildState(pending);
    }
    case 'pending_volumes': {
      if (targetType !== 'container')
        throw new Error('The pending_volumes operation applies to container targets only');
      const { updatePendingContainerVolumes } = await import('@/modules/docker/docker-pending-container-volumes.js');
      return updatePendingContainerVolumes(
        nodeId,
        String(a.containerName),
        DockerPendingContainerVolumesSchema.parse({ volumes: a.volumes ?? [] }),
        user
      );
    }
    case 'upsert': {
      if (target.kind === 'container') {
        // A Compose service or deployment slot container takes no source of its own (409 SOURCE_TARGET_OWNED).
        const { assertContainerSourceTargetNotOwned } = await import('@/modules/docker/docker-source-target-owner.js');
        await assertContainerSourceTargetNotOwned(target.nodeId, target.containerName);
      }
      const saved = await sourceService.get(target);
      const { withDockerSourceBuildState } = await import('@/modules/docker/docker-source-build-state.js');
      return withDockerSourceBuildState(
        await sourceService.upsert(DockerSourceBindingUpsertSchema.parse({ ...sourceConfig(saved), target }), user)
      );
    }
    case 'remove': {
      if (target.kind !== 'container') return { success: true, removed: await sourceService.remove(target, user.id) };
      // The container keeps running its build: the registry keeps that build as the container's own (keptImage).
      const { detachContainerSourceKeepingImage } = await import('@/modules/docker/docker-container-kept-image.js');
      const detached = await detachContainerSourceKeepingImage(
        container.resolve<import('@/db/client.js').DrizzleClient>(TOKENS.DrizzleClient),
        () => sourceService.remove(target, user.id),
        target
      );
      return { success: true, ...detached };
    }
    case 'resolve':
      return sourceService.resolveCurrent(target, user);
    case 'sync':
      return sourceService.sync(target, user);
    case 'rollback': {
      // POST /nodes/:nodeId/containers/:containerName/source/rollback; other targets are refused by the service.
      const { DockerSourceRollbackSchema } = await import('@/modules/docker/docker-source-rollback.routes.js');
      const result = await sourceService.rollback(
        target,
        DockerSourceRollbackSchema.parse({ buildId: optionalNonEmptyString(a.buildId) }),
        user
      );
      const { withDockerSourceBuildState } = await import('@/modules/docker/docker-source-build-state.js');
      return { ...result, source: await withDockerSourceBuildState(result.source) };
    }
    case 'build':
      return sourceService.createBuild(
        target,
        DockerBuildCreateSchema.parse({ commitSha: optionalNonEmptyString(a.commitSha), force: a.force ?? false }),
        user
      );
    case 'secret_list':
      return sourceService.listBuildSecrets(target);
    case 'secret_upsert': {
      const name = DockerBuildSecretNameSchema.parse(a.secretName);
      const { value } = DockerBuildSecretValueSchema.parse({ value: a.secretValue });
      return sourceService.upsertBuildSecret(target, name, value, user.id);
    }
    case 'secret_delete': {
      const name = DockerBuildSecretNameSchema.parse(a.secretName);
      return { success: true, removed: await sourceService.deleteBuildSecret(target, name, user.id) };
    }
    default:
      throw new Error(`Unsupported Docker source operation: ${operation}`);
  }
}

/** Mirrors GET /tasks and GET /tasks/{id}: docker:tasks for the task node; scoped callers see their nodes only. */
async function manageDockerTask(user: User, args: Record<string, unknown>) {
  const a = args as any;
  if (!hasScopeBase(user.scopes, 'docker:tasks')) {
    throw new Error('PERMISSION_DENIED: Missing required scope docker:tasks');
  }
  const { DockerTaskService } = await import('@/modules/docker/docker-task.service.js');
  const taskService = container.resolve(DockerTaskService);
  if (a.operation === 'get') {
    const task = await taskService.get(String(a.taskId));
    if (!hasScopeForResource(user.scopes, 'docker:tasks', task.nodeId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: docker:tasks:${task.nodeId}`);
    }
    return task;
  }
  if (a.operation === 'list') {
    return taskService.list({
      nodeId: typeof a.nodeId === 'string' ? a.nodeId : undefined,
      status: typeof a.status === 'string' ? a.status : undefined,
      type: typeof a.type === 'string' ? a.type : undefined,
      limit:
        typeof a.limit === 'number' && Number.isFinite(a.limit)
          ? Math.min(Math.max(Math.trunc(a.limit), 1), 1000)
          : undefined,
      allowedNodeIds: user.scopes.includes('docker:tasks')
        ? undefined
        : getResourceScopedIds(user.scopes, 'docker:tasks'),
    });
  }
  throw new Error(`Unsupported Docker task operation: ${String(a.operation)}`);
}

/**
 * Mirrors POST /nodes/{nodeId}/runtime/runsc/preflight and /install: secure runtime install is node control
 * (nodes:manage for the node); broad admin:update keeps working for one release.
 */
async function manageDockerRuntime(context: DockerToolContext, user: User, args: Record<string, unknown>) {
  const operation = String(args.operation);
  if (operation !== 'preflight' && operation !== 'install') {
    throw new Error(`Unsupported Docker runtime operation: ${operation}`);
  }
  const nodeId = requiredToolString(args.nodeId, 'nodeId');
  if (!hasScopeForResource(user.scopes, 'nodes:manage', nodeId) && !hasScope(user.scopes, 'admin:update')) {
    throw new Error(`PERMISSION_DENIED: Missing required scope nodes:manage:${nodeId}`);
  }
  return context.dockerService.manageRunsc(nodeId, operation);
}

/** Mirrors POST /tasks/{id}/force-cancel: docker:tasks:manage on the task node. */
async function forceCancelDockerTask(user: User, args: Record<string, unknown>) {
  const { DockerTaskService } = await import('@/modules/docker/docker-task.service.js');
  const taskService = container.resolve(DockerTaskService);
  const task = await taskService.get(String(args.taskId ?? ''));
  if (!hasScopeForResource(user.scopes, 'docker:tasks:manage', task.nodeId)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: docker:tasks:manage:${task.nodeId}`);
  }
  return taskService.forceCancel(task.id);
}

/** Mirrors the deployment create, update, and delete routes, including their redaction. */
async function manageDockerDeployment(context: DockerToolContext, user: User, args: Record<string, unknown>) {
  const a = args as any;
  const nodeId = String(a.nodeId ?? '');
  const service = container.resolve(DockerDeploymentService);
  switch (String(a.operation)) {
    case 'create': {
      if (!hasScopeBase(user.scopes, 'docker:containers:create')) {
        throw new Error('PERMISSION_DENIED: Missing required scope docker:containers:create');
      }
      // The service checks the node or folder destination against these scopes.
      const data = await service.create(
        nodeId,
        DockerDeploymentCreateSchema.parse(a.payload ?? {}),
        user.id,
        user.scopes
      );
      return presentDeploymentForCaller(data, user.scopes, nodeId, data.id);
    }
    case 'update': {
      const deploymentId = String(a.deploymentId ?? '');
      // As the update route: an env-only save needs environment, anything else edit.
      ensureDockerDeploymentScope(context, user, 'docker:containers:view', nodeId, deploymentId);
      const input = DockerDeploymentUpdateSchema.parse(a.payload ?? {});
      const saved = await service.get(nodeId, deploymentId);
      ensureDeploymentChangeAccess(context, user, nodeId, deploymentId, deploymentUpdateRequiredScopes(input, saved));
      const data = await service.update(nodeId, deploymentId, input, user.id, user.scopes);
      return presentDeploymentForCaller(data, user.scopes, nodeId, deploymentId);
    }
    case 'delete': {
      const deploymentId = String(a.deploymentId ?? '');
      ensureDockerDeploymentScope(context, user, 'docker:containers:delete', nodeId, deploymentId);
      await service.remove(nodeId, deploymentId, user.id);
      return { success: true };
    }
    default:
      throw new Error(`Unsupported Docker deployment operation: ${String(a.operation)}`);
  }
}
