import type { z } from 'zod';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { hasScope, hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import { beginNodeArchiveTransfer, releaseWhenStreamEnds } from '@/services/node-long-tasks.js';
import type {
  ContainerArchiveExportQuerySchema,
  ContainerArchivePlanSchema,
  ContainerArchiveResolutionSchema,
} from './docker.schemas.js';
import { DockerManagementService } from './docker.service.js';
import { assertContainerNameNotReserved, hasDockerResourceScope } from './docker-access-resource.service.js';
import { type DockerArchiveOperations, dockerArchiveCommercialRuntime } from './docker-archive-commercial-runtime.js';
import { assertDockerCreationAccess } from './docker-creation-access.js';
import { envListToMap } from './docker-env-operations.js';
import { DockerEnvironmentService } from './docker-environment.service.js';
import { dockerGpuAttachmentFromInspect } from './docker-gpu-attachment.js';
import { inspectUserContainer } from './docker-internal-containers.js';
import { isReservedOpfieldNetworkName } from './docker-internal-networks.js';
import { labelValue } from './docker-managed-labels.js';
import { DockerMigrationDispatchAdapter } from './docker-migration-dispatch.js';
import { DockerRegistryService } from './docker-registry.service.js';
import { DockerSecretService } from './docker-secret.service.js';
import { assertDockerMountChangeAllowed } from './docker-socket-mount.guard.js';

/**
 * Container archive (.gwca) plan, export and import, shared by the REST routes
 * and the MCP archive transfer tools. Callers enforce the route middleware
 * scope and the `container-export` license entitlement before calling in.
 */

type ContainerArchiveExportQuery = z.infer<typeof ContainerArchiveExportQuerySchema>;
type ContainerArchivePlanInput = z.infer<typeof ContainerArchivePlanSchema>;
type ContainerArchiveResolution = z.infer<typeof ContainerArchiveResolutionSchema>;

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

function inspectedContainerLabels(inspected: unknown): Record<string, unknown> {
  if (!inspected || typeof inspected !== 'object') return {};
  const record = inspected as { Config?: { Labels?: unknown }; Labels?: unknown; labels?: unknown };
  const labels = record.Config?.Labels ?? record.Labels ?? record.labels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return {};
  return labels as Record<string, unknown>;
}

/**
 * A container that carries a Compose project label is owned by that project,
 * so it is never exported as a standalone archive. This is the rule the
 * container page uses to hide the export action; it runs on the inspected
 * container before any export work starts.
 */
export function assertDockerContainerArchiveExportAllowed(nodeId: string, containerId: string, inspected: unknown) {
  const labels = inspectedContainerLabels(inspected);
  const projectName = labels[COMPOSE_PROJECT_LABEL];
  if (typeof projectName !== 'string' || projectName === '') return;
  const projectId = labelValue(labels, 'compose.project-id');
  throw new AppError(
    409,
    'DOCKER_ARCHIVE_COMPOSE_CONTAINER',
    `This container belongs to Compose project ${projectName} and cannot be exported as a container archive; manage it through the Compose project instead`,
    {
      nodeId,
      containerId,
      projectName,
      projectId: typeof projectId === 'string' && projectId !== '' ? projectId : null,
    }
  );
}

/**
 * What an export may carry for this caller and this container, checked wherever an export is admitted (the REST
 * download, and an MCP download or one-time link when it is issued): a portable image needs files access, the
 * environment and the secrets their own scopes. A Secure Runtime (gVisor) container cannot be exported: an archive
 * does not carry its runtime.
 */
export function assertDockerContainerArchiveContentAccess(
  nodeId: string,
  inspected: unknown,
  query: Pick<ContainerArchiveExportQuery, 'imageMode' | 'includeEnvironment' | 'includeSecrets'>,
  actorScopes: readonly string[]
) {
  const inspect = (inspected ?? {}) as Record<string, any>;
  if (inspect.HostConfig?.Runtime === 'runsc') {
    throw new AppError(
      409,
      'DOCKER_ARCHIVE_SECURE_RUNTIME',
      'A container that runs on Secure Runtime (gVisor) cannot be exported as a container archive.'
    );
  }
  const scopes = [...actorScopes];
  const scopeResourceId = String(inspect.scopeResourceId ?? '');
  if (
    query.imageMode === 'portable' &&
    !hasDockerResourceScope(scopes, 'docker:containers:files:read', nodeId, scopeResourceId)
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Exporting a portable container archive requires files access');
  }
  if (
    query.includeEnvironment &&
    !hasDockerResourceScope(scopes, 'docker:containers:environment', nodeId, scopeResourceId)
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Exporting a container archive requires environment access');
  }
  if (query.includeSecrets && !hasDockerResourceScope(scopes, 'docker:containers:secrets', nodeId, scopeResourceId)) {
    throw new AppError(403, 'FORBIDDEN', 'Exporting archive secrets is not permitted for this container');
  }
}

/**
 * Networks an imported container joins, after the import resolution is applied. The same rules as a direct create
 * (resolveCreateNetworks): no shared namespaces (`host`, `container:<id>`), `none` only on its own, and never a
 * Gateway-managed network. Reserved names are refused as a whole because the daemon creates a missing createable
 * network under the archive's name.
 */
export function assertArchiveNetworksAllowed(networks: ReadonlyArray<{ name: string }>) {
  const names = networks.map((network) => network.name.trim()).filter(Boolean);
  for (const name of names) {
    if (name === 'host' || name.includes(':')) {
      throw new AppError(400, 'NETWORK_MODE_NOT_ALLOWED', `Network mode "${name}" is not allowed for containers`);
    }
    if (isReservedOpfieldNetworkName(name)) {
      throw new AppError(409, 'MANAGED_NETWORK', 'Opfield-managed networks cannot be connected manually');
    }
  }
  if (names.length > 1 && names.includes('none')) {
    throw new AppError(400, 'NETWORK_MODE_NOT_ALLOWED', 'The none network cannot be combined with other networks');
  }
}

function archiveImportPlanAccess(actorScopes: readonly string[], nodeId: string) {
  return {
    canViewNetworks: hasScopeForResource([...actorScopes], 'docker:networks:view', nodeId),
    canCreateNetworks: hasScopeForResource([...actorScopes], 'docker:networks:create', nodeId),
    canViewVolumes: hasScopeForResource([...actorScopes], 'docker:volumes:view', nodeId),
    canCreateVolumes: hasScopeForResource([...actorScopes], 'docker:volumes:create', nodeId),
  };
}

/**
 * Environment and secrets of an imported container: granted on the target node (or broadly), or on the destination
 * folder the new container is placed in.
 */
export function canImportArchiveContent(
  actorScopes: readonly string[],
  scope: 'docker:containers:environment' | 'docker:containers:secrets',
  nodeId: string,
  folderId: string | undefined
): boolean {
  return (
    hasDockerResourceScope([...actorScopes], scope, nodeId, '') ||
    (!!folderId && hasScope([...actorScopes], `${scope}:folder/${folderId}`))
  );
}

function canPlanArchiveImport(actorScopes: readonly string[], nodeId: string) {
  return (
    hasScopeForCreation(actorScopes, 'docker:containers:create', undefined, nodeId) ||
    actorScopes.some((scope) => scope.startsWith('docker:containers:create:folder/'))
  );
}

/** Resolve an archive manifest summary against the destination node's networks, volumes and ports. */
export async function planDockerContainerArchiveImport(
  nodeId: string,
  body: ContainerArchivePlanInput,
  actorScopes: readonly string[]
) {
  if (!canPlanArchiveImport(actorScopes, nodeId)) {
    throw new AppError(403, 'FORBIDDEN', 'Missing docker:containers:create for the destination node');
  }
  await assertNodeAllowsServiceCreation(container.resolve(TOKENS.DrizzleClient) as DrizzleClient, nodeId, 'docker');
  const data = await container.resolve(DockerMigrationDispatchAdapter).planArchiveImport(nodeId, {
    manifest: { schemaVersion: 1, ...body },
    ...archiveImportPlanAccess(actorScopes, nodeId),
  });
  const managedNames = new Set(
    (await container.resolve(DockerManagementService).listManagedVolumeOptions(nodeId)).map((row) => row.name)
  );
  data.volumes = data.volumes.filter((volume) => managedNames.has(volume.name));
  return data;
}

/**
 * Open a container archive export stream. The caller already holds
 * docker:containers:export for the container; environment, secrets and
 * portable image contents need their own container scopes. Compose
 * containers are refused before anything is read or streamed.
 */
export async function openDockerContainerArchiveExport(args: {
  nodeId: string;
  containerId: string;
  query: ContainerArchiveExportQuery;
  actorScopes: readonly string[];
  userId: string;
}): Promise<{ filename: string; stream: ReadableStream<Uint8Array> }> {
  const { nodeId, containerId, query } = args;
  const actorScopes = [...args.actorScopes];
  const docker = container.resolve(DockerManagementService);
  const inspected = await inspectUserContainer(docker, nodeId, containerId);
  assertDockerContainerArchiveExportAllowed(nodeId, containerId, inspected);
  if (dockerGpuAttachmentFromInspect(inspected).mode !== 'none') {
    throw new AppError(
      409,
      'GPU_ARCHIVE_UNSUPPORTED',
      'Containers with GPU mappings cannot be exported as portable archives.'
    );
  }
  assertDockerContainerArchiveContentAccess(nodeId, inspected, query, actorScopes);
  let environment: Record<string, string> = {};
  let secrets: Record<string, string> = {};
  let secretKeys: string[] = [];
  if (query.includeEnvironment) {
    environment = envListToMap(await docker.getContainerEnv(nodeId, containerId));
    const containerName = String(inspected?.Name ?? '').replace(/^\/+/, '');
    if (!containerName) throw new AppError(409, 'GWCA_SOURCE_INVALID', 'Could not resolve container name');
    const secretService = container.resolve(DockerSecretService);
    // Database and storage link credentials belong to the link: the archive carries the user's secrets only.
    if (query.includeSecrets) {
      secrets = await secretService.getUserDecryptedMap(nodeId, containerName);
    } else {
      secretKeys = (await secretService.list(nodeId, containerName, false)).map((secret) => secret.key);
    }
  }
  const dispatch = container.resolve(DockerMigrationDispatchAdapter);
  // A daemon update of the node waits for the export until its stream ends.
  const release = beginNodeArchiveTransfer(
    nodeId,
    'archive_export',
    `Export of container ${String(inspected?.Name ?? containerId).replace(/^\/+/, '')}`
  );
  let archive: Awaited<ReturnType<DockerArchiveOperations['openGwcaExport']>>;
  try {
    archive = await container.resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition).executeDockerArchive(
      'openGwcaExport',
      {
        dispatch,
        nodeId,
        containerId,
        includeWritableLayer: query.includeWritableLayer,
        imageMode: query.imageMode,
        environment,
        secrets,
        secretKeys,
        includeEnvironment: query.includeEnvironment,
        includeSecrets: query.includeSecrets,
      },
      dockerArchiveCommercialRuntime
    );
  } catch (error) {
    release();
    throw error;
  }
  await container.resolve(AuditService).log({
    action: 'docker.container.archive.export',
    userId: args.userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: {
      nodeId,
      includeWritableLayer: query.includeWritableLayer,
      includeEnvironment: query.includeEnvironment,
      includeSecrets: query.includeSecrets,
      imageMode: query.imageMode,
    },
  });
  return { filename: archive.filename, stream: releaseWhenStreamEnds(archive.stream, release) };
}

interface ContainerArchiveImportArgs {
  nodeId: string;
  name: string;
  folderId?: string;
  resolution: ContainerArchiveResolution;
  body: ReadableStream<Uint8Array>;
  actorScopes: readonly string[];
  userId: string;
}

/**
 * Import a container archive stream as a new container. The caller already
 * checked docker:containers:create for the node or folder, the service
 * creation lock, and parsed the resolution.
 */
export async function importDockerContainerArchive(
  args: ContainerArchiveImportArgs
): Promise<{ containerId: string; containerName: string; imageId: string }> {
  // A daemon update of the node waits for the import to finish.
  const release = beginNodeArchiveTransfer(args.nodeId, 'archive_import', `Import of container ${args.name}`);
  try {
    return await importArchive(args);
  } finally {
    release();
  }
}

async function importArchive(
  args: ContainerArchiveImportArgs
): Promise<{ containerId: string; containerName: string; imageId: string }> {
  const { nodeId, resolution, userId } = args;
  const actorScopes = [...args.actorScopes];
  // The routes check this before streaming; repeat it here so no caller can import into an unauthorized folder.
  await assertDockerCreationAccess(
    container.resolve<DrizzleClient>(TOKENS.DrizzleClient),
    actorScopes,
    'docker:containers:create',
    nodeId,
    args.folderId
  );
  // An imported container must not take the name (and so the identity) a Git source reserves.
  await assertContainerNameNotReserved(container.resolve<DrizzleClient>(TOKENS.DrizzleClient), nodeId, args.name);
  const dispatch = container.resolve(DockerMigrationDispatchAdapter);
  const registryService = container.resolve(DockerRegistryService);
  const data = await container.resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition).executeDockerArchive(
    'importGwca',
    {
      dispatch,
      nodeId,
      name: args.name,
      body: args.body,
      resolution,
      authorizeContents: async (archiveContainer) => {
        assertDockerMountChangeAllowed({
          nodeId,
          actorScopes,
          currentDefinitions: [],
          nextDefinitions: (archiveContainer.mounts ?? []).map((mount) => ({
            type: mount.type,
            source: mount.source,
            target: mount.target,
            readOnly: mount.readOnly,
          })),
          // New volumes need docker:volumes:create (checked below); an existing one is attached with its view.
          createdVolumes: (archiveContainer.mounts ?? [])
            .filter((mount) => mount.type === 'volume' && mount.createNew)
            .map((mount) => mount.source),
        });
        if (
          Object.keys(archiveContainer.environment ?? {}).length > 0 &&
          !canImportArchiveContent(actorScopes, 'docker:containers:environment', nodeId, args.folderId)
        ) {
          throw new AppError(403, 'FORBIDDEN', 'Importing archive environment is not permitted on the target node');
        }
        if (
          Object.keys(archiveContainer.secrets ?? {}).length > 0 &&
          !canImportArchiveContent(actorScopes, 'docker:containers:secrets', nodeId, args.folderId)
        ) {
          throw new AppError(403, 'FORBIDDEN', 'Importing archive secrets is not permitted on the target node');
        }
        assertArchiveNetworksAllowed(archiveContainer.networks ?? []);
        const canCreateNetworks = hasScopeForResource(actorScopes, 'docker:networks:create', nodeId);
        if (!canCreateNetworks && (archiveContainer.networks ?? []).some((network) => network.createNew)) {
          throw new AppError(403, 'FORBIDDEN', 'Creating archive networks is not permitted on the target node');
        }
        for (const network of archiveContainer.networks ?? []) {
          if (!canCreateNetworks) network.createable = false;
        }
        const canCreateVolumes = hasScopeForResource(actorScopes, 'docker:volumes:create', nodeId);
        if (!canCreateVolumes && (archiveContainer.mounts ?? []).some((mount) => mount.createNew)) {
          throw new AppError(403, 'FORBIDDEN', 'Creating archive volumes is not permitted on the target node');
        }
        await container.resolve(DockerManagementService).assertManagedVolumeSelections(
          nodeId,
          (archiveContainer.mounts ?? [])
            .filter((mount) => mount.type === 'volume' && !mount.createNew)
            .map((mount) => mount.source)
        );
      },
      resolveRegistryAuthCandidates: async (imageReference) =>
        (
          await registryService.resolveAuthCandidatesForImagePull(nodeId, imageReference, undefined, {
            actorScopes,
          })
        ).map((candidate) => candidate.authJson),
    },
    dockerArchiveCommercialRuntime
  );
  const docker = container.resolve(DockerManagementService);
  try {
    await container.resolve(DockerEnvironmentService).replace(nodeId, data.containerName, data.environment);
    await container.resolve(DockerSecretService).replaceImported(nodeId, data.containerName, data.secrets, userId);
    await docker.registerImportedContainer(nodeId, data.containerName, data.containerId, args.folderId, userId);
    await docker.registerImportedManagedVolumes(nodeId, data.createdVolumes, userId);
  } catch (error) {
    await container
      .resolve(DockerEnvironmentService)
      .deleteImported(nodeId, data.containerName)
      .catch(() => undefined);
    await container
      .resolve(DockerSecretService)
      .deleteImported(nodeId, data.containerName)
      .catch(() => undefined);
    await docker.removeContainer(nodeId, data.containerId, true, userId).catch(() => undefined);
    await dispatch.cleanupArchiveImport(nodeId, data.archiveId).catch(() => undefined);
    throw error;
  }
  await container.resolve(AuditService).log({
    action: 'docker.container.archive.import',
    userId,
    resourceType: 'docker-container',
    resourceId: data.containerId,
    details: {
      nodeId,
      requestedName: args.name,
      name: data.containerName,
      imageId: data.imageId,
      resolution,
      importedSecretKeys: Object.keys(data.secrets),
    },
  });
  return { containerId: data.containerId, containerName: data.containerName, imageId: data.imageId };
}
