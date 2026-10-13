import type { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { inheritedContainerLayer } from '@/modules/apps/app-container-layer.js';
import { appForMember, parseAppListFilter, withAppMembers } from '@/modules/apps/app-membership.js';
import { assertNotImpersonating, requireAnyScopeBase, requireScopeBase } from '@/modules/auth/auth.middleware.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { AppEnv } from '@/types.js';
import { DockerAvailabilityService } from './availability/docker-availability.service.js';
import { DockerWorkloadResolverService } from './availability/docker-workload-resolver.service.js';
import { assertComposeChildMutationAllowed } from './compose/compose-child.guard.js';
import { isComposeOwnedContainer } from './compose/compose-discovery.service.js';
import {
  abortContainerFileUploadRoute,
  completeContainerFileUploadRoute,
  containerEnvRoute,
  containerLogsRoute,
  containerStatsHistoryRoute,
  containerStatsRoute,
  containerTopRoute,
  createContainerDirectoryRoute,
  createContainerFileRoute,
  createContainerRoute,
  createContainerSecretRoute,
  deleteContainerFileRoute,
  deleteContainerSecretRoute,
  duplicateContainerRoute,
  exportContainerArchiveRoute,
  importContainerArchiveRoute,
  initContainerFileUploadRoute,
  inspectContainerByNameRoute,
  inspectContainerRoute,
  killContainerRoute,
  listContainerFilesRoute,
  listContainerGpuUsageRoute,
  listContainerSecretsRoute,
  listContainersRoute,
  liveUpdateContainerRoute,
  moveContainerFileRoute,
  planContainerArchiveImportRoute,
  readContainerFileRoute,
  recreateContainerRoute,
  removeContainerRoute,
  renameContainerRoute,
  restartContainerRoute,
  startContainerRoute,
  stopContainerRoute,
  updateContainerEnvRoute,
  updateContainerRoute,
  updateContainerSecretRoute,
  uploadContainerFileChunkRoute,
  writeContainerFileRoute,
} from './docker.docs.js';
import {
  ContainerArchiveExportQuerySchema,
  ContainerArchiveImportQuerySchema,
  ContainerArchivePlanSchema,
  ContainerArchiveResolutionSchema,
  ContainerCreateSchema,
  ContainerDuplicateSchema,
  ContainerKillSchema,
  ContainerLiveUpdateSchema,
  ContainerRecreateSchema,
  ContainerRenameSchema,
  ContainerStopSchema,
  ContainerUpdateSchema,
  EnvUpdateSchema,
  FileBrowseSchema,
  FileMoveSchema,
  FileUploadChunkQuerySchema,
  FileUploadCompleteSchema,
  FileUploadInitSchema,
  LogQuerySchema,
  SecretCreateSchema,
  SecretUpdateSchema,
} from './docker.schemas.js';
import { DockerManagementService } from './docker.service.js';
import {
  assertDockerNodeScope,
  dockerNodeListAccess,
  filterDockerResourcesForScope,
  requireDockerContainerScope,
} from './docker-access.middleware.js';
import {
  importDockerContainerArchive,
  openDockerContainerArchiveExport,
  planDockerContainerArchiveImport,
} from './docker-container-archive-operations.js';
import { assertCreateNetworksAccess } from './docker-container-create-networks.js';
import { pendingOperationBody } from './docker-container-lifecycle-operations.js';
import {
  getDockerContainerProcesses,
  getDockerContainerStatsHistory,
  getLatestDockerContainerStats,
  listDockerGpuUsage,
} from './docker-container-observability.js';
import {
  containerRecreateRequiredScopes,
  containerUpdateRequiredScopes,
} from './docker-container-scope-requirements.js';
import { assertDockerCreationAccess } from './docker-creation-access.js';
import { isDockerDeploymentManaged } from './docker-deployment-labels.js';
import { assertUserContainerAccessible } from './docker-internal-containers.js';
import { labelString } from './docker-managed-labels.js';
import { answerNodeLoss } from './docker-node-loss.middleware.js';
import { resolveDockerContainerByName } from './docker-route-resolvers.js';
import { DockerSecretService } from './docker-secret.service.js';
import { DockerSnapshotService, sanitizeContainerInspect } from './docker-snapshot.service.js';
import { DockerSnapshotReconciler } from './docker-snapshot-reconciler.service.js';
import { assertNotPendingSourceContainer } from './docker-source.service.js';

const DOCKER_RESOURCE_LIST_MAX = 1000;
const DOCKER_CONTAINER_PORT_PREVIEW_MAX = 64;

/**
 * The cached inspect of a container. Right after a recreate the container list can name the new runtime before its
 * inspect is cached: the inspect is then read from the node once, instead of answering 404 for a container that
 * exists.
 */
async function containerDetailSnapshot(nodeId: string, key: string) {
  const snapshots = container.resolve(DockerSnapshotService);
  try {
    return await snapshots.getContainerDetailSnapshot(nodeId, key);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'CONTAINER_NOT_FOUND') throw error;
    try {
      await container.resolve(DockerSnapshotReconciler).refreshNow(nodeId, 'container-detail', key);
    } catch {
      // Not in the node's container list either: it does not exist.
      throw error;
    }
    return snapshots.getContainerDetailSnapshot(nodeId, key);
  }
}

function assertUserContainerSnapshot(data: Record<string, any> | null | undefined): void {
  assertUserContainerAccessible(data);
}

function filterContainerDatabaseLinksForScopes(data: any, scopes: string[]) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.databaseLinks)) return data;
  const databaseLinks = data.databaseLinks.filter((link: any) => {
    const databaseId = String(link?.database?.id ?? '');
    return hasScopeForResource(scopes, 'databases:view', databaseId);
  });
  return {
    ...data,
    databaseLinks,
    secureLinkDown: Boolean(data.secureLinkDown),
  };
}

export { containerRecreateRequiredScopes, containerUpdateRequiredScopes };

async function assertAdditionalContainerScopes(
  c: Parameters<Parameters<OpenAPIHono<AppEnv>['openapi']>[1]>[0],
  scopes: string[]
) {
  for (const scope of scopes) {
    await requireDockerContainerScope(scope)(c as any, async () => {});
  }
}

async function callerHasContainerScope(
  c: Parameters<Parameters<OpenAPIHono<AppEnv>['openapi']>[1]>[0],
  scope: string,
  identifierParam: string
): Promise<boolean> {
  try {
    await requireDockerContainerScope(scope, identifierParam)(c as any, async () => {});
    return true;
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403) return false;
    throw error;
  }
}

async function parseFileContentRequest(c: Parameters<Parameters<OpenAPIHono<AppEnv>['openapi']>[1]>[0]) {
  const path = FileBrowseSchema.parse(c.req.query()).path;
  const content = Buffer.from(await c.req.arrayBuffer());
  return { path, content };
}

export function compactContainerListItem(container: Record<string, any>) {
  const ports = container.ports ?? container.Ports;
  const labels = (container.labels ?? container.Labels ?? {}) as Record<string, string>;
  return {
    id: container.id ?? container.Id,
    name: ((container.name ?? container.Name ?? '') as string).replace(/^\//, ''),
    image: labelString(labels, 'archive.image.reference') || container.image || container.Image || '',
    pendingSourceBuild: container.pendingSourceBuild === true,
    state: container.state ?? container.State,
    status: container.status ?? container.Status,
    created: container.created ?? container.Created,
    ports: Array.isArray(ports) ? ports.slice(0, DOCKER_CONTAINER_PORT_PREVIEW_MAX) : ports,
    portsCount: Array.isArray(ports) ? ports.length : undefined,
    portsTruncated: Array.isArray(ports) && ports.length > DOCKER_CONTAINER_PORT_PREVIEW_MAX,
    // TCP ports the running container listens on; null when the node did not report them.
    listeningPorts: Array.isArray(container.listeningPorts) ? container.listeningPorts : null,
    kind: container.kind ?? 'container',
    deploymentId: container.deploymentId,
    activeSlot: container.activeSlot,
    primaryRoute: container.primaryRoute,
    activeSlotContainerId: container.activeSlotContainerId,
    healthCheckId: container.healthCheckId,
    healthCheckEnabled: container.healthCheckEnabled,
    healthStatus: container.healthStatus,
    secureLinkDown: Boolean(container.secureLinkDown),
    lastHealthCheckAt: container.lastHealthCheckAt,
    folderId: container.folderId,
    folderIsSystem: container.folderIsSystem,
    folderSortOrder: container.folderSortOrder,
    scopeResourceId: container.scopeResourceId,
    _transition: container._transition,
  };
}

export function matchesContainerSearch(container: Record<string, any>, search: string | undefined) {
  if (!search) return true;
  const ports = container.ports ?? container.Ports;
  const portText = Array.isArray(ports)
    ? ports.map((port: any) => [port.ip, port.publicPort, port.privatePort, port.type].join(' ')).join(' ')
    : '';
  const haystack = [
    container.id ?? container.Id,
    container.name ?? container.Name,
    container.image ?? container.Image,
    container.state ?? container.State,
    container.status ?? container.Status,
    container.kind,
    container.deploymentId,
    container.activeSlot,
    portText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(search);
}

/** Resolve container name from container ID via inspect */
async function resolveContainerName(nodeId: string, containerId: string): Promise<string> {
  const workload = await container
    .resolve(DockerWorkloadResolverService)
    .resolve({ type: 'container', nodeId, containerName: containerId });
  if (workload) return workload.managementTarget.resourceId;
  const dockerService = container.resolve(DockerManagementService);
  const inspect = await dockerService.inspectContainer(nodeId, containerId);
  const labels = inspect?.Config?.Labels ?? {};
  if (isDockerDeploymentManaged(labels)) {
    throw new AppError(
      409,
      'MANAGED_DEPLOYMENT_CONTAINER',
      'This container is managed by a blue/green deployment. Use deployment actions instead.'
    );
  }
  const name = (inspect?.Name ?? '').replace(/^\//, '');
  if (!name) throw new Error('Could not resolve container name');
  return name;
}

/** The app environment layer of a container, by its name on the node (null outside apps). */
async function containerInheritedEnv(nodeId: string, containerId: string) {
  try {
    const name = await resolveContainerName(nodeId, containerId);
    return name
      ? await inheritedContainerLayer(container.resolve(TOKENS.DrizzleClient) as DrizzleClient, nodeId, name)
      : null;
  } catch {
    return null;
  }
}

/** `app` of a container detail (by its name on the node). */
async function containerApp(nodeId: string, data: unknown) {
  const record = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const name = String(record.name ?? record.Name ?? '').replace(/^\/+/, '');
  return name ? appForMember({ type: 'container', id: name, nodeId }) : null;
}

export function registerContainerRoutes(router: OpenAPIHono<AppEnv>) {
  // ─── Container routes ────────────────────────────────────────────────

  // List containers
  router.openapi(
    { ...listContainersRoute, middleware: requireAnyScopeBase('docker:containers:view', 'docker:containers:create') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const snapshots = container.resolve(DockerSnapshotService);
      const nodeId = c.req.param('nodeId')!;
      if (
        dockerNodeListAccess(
          c.get('effectiveScopes') ?? [],
          'docker:containers:view',
          nodeId,
          'docker:containers:create'
        ) === 'empty'
      ) {
        return c.json({ data: [], total: 0, limit: DOCKER_RESOURCE_LIST_MAX, truncated: false });
      }
      await snapshots.assertDockerNode(nodeId);
      const snapshot = await snapshots.getList<any[]>(nodeId, 'containers');
      const data = await service.decoratePublicContainerSnapshot(
        nodeId,
        snapshot.data.filter((item) => !isComposeOwnedContainer(item))
      );
      if (!Array.isArray(data)) return c.json({ data });
      const search = c.req.query('search')?.trim().toLowerCase();
      const visible = filterDockerResourcesForScope(
        data.map((item) => compactContainerListItem(item)),
        c.get('effectiveScopes') ?? [],
        'docker:containers:view',
        nodeId
      );
      const compacted = visible
        .filter((item) => matchesContainerSearch(item, search))
        .map((item) => ({
          ...item,
          nodeId,
          availability: snapshots.availability(nodeId, snapshot),
        }));
      const logicalStates = await container.resolve(DockerAvailabilityService).listContainerSurfaceStates(
        nodeId,
        compacted.map((item) => ({ name: String(item.name), deploymentId: item.deploymentId ?? null }))
      );
      const logical = compacted.map((item) => {
        const key = item.deploymentId ? `deployment:${item.deploymentId}` : `container:${item.name}`;
        const state = logicalStates[key];
        return state
          ? {
              ...item,
              image: state.sourceImageReference ?? item.image,
              availabilityPolicyStatus: state.status,
              availabilityHealthStatus: state.healthStatus,
              availabilityServing: state.serving,
              availabilityDesired: state.desired,
            }
          : item;
      });
      // `app` on every row; excludeAppMembers / appId filter (the normal list leaves app members out).
      const listed = await withAppMembers('containers', logical, parseAppListFilter(c.req.query()));
      const truncated = listed.length > DOCKER_RESOURCE_LIST_MAX;
      return c.json({
        data: truncated ? listed.slice(0, DOCKER_RESOURCE_LIST_MAX) : listed,
        total: listed.length,
        limit: DOCKER_RESOURCE_LIST_MAX,
        truncated,
      });
    }
  );

  router.openapi(
    { ...listContainerGpuUsageRoute, middleware: requireScopeBase('docker:containers:view') },
    async (c) => {
      const nodeId = c.req.param('nodeId')!;
      const scopes = c.get('effectiveScopes') ?? [];
      assertDockerNodeScope(scopes, 'docker:containers:view', nodeId);
      return c.json({ data: await listDockerGpuUsage(nodeId, scopes) });
    }
  );

  // Create container
  router.openapi({ ...createContainerRoute, middleware: requireScopeBase('docker:containers:create') }, async (c) => {
    const service = container.resolve(DockerManagementService);
    const nodeId = c.req.param('nodeId')!;
    const user = c.get('user')!;
    const body = await c.req.json();
    const config = ContainerCreateSchema.parse(body);
    await assertCreateNetworksAccess(c.get('effectiveScopes') || [], nodeId, config.networks);
    const data = await service.createContainer(nodeId, config, user.id, c.get('effectiveScopes') || []);
    return c.json({ data }, 201);
  });

  // Inspect container
  router.openapi(
    {
      ...inspectContainerByNameRoute,
      middleware: requireDockerContainerScope('docker:containers:view', 'containerName', {
        allowBroadWithoutResolve: true,
      }),
    },
    async (c) => {
      const snapshots = container.resolve(DockerSnapshotService);
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const requestedName = c.req.param('containerName')!;
      const runtimeTarget = await container
        .resolve(DockerWorkloadResolverService)
        .resolveContainerRuntimeTarget(nodeId, requestedName);
      const inspectNodeId = runtimeTarget?.nodeId ?? nodeId;
      const inspectIdentifier = runtimeTarget?.containerId ?? requestedName;
      if (runtimeTarget) {
        let resolved = await service.inspectContainer(inspectNodeId, inspectIdentifier);
        // A replica on another node gets the logical workload's secrets in plain text under its internal name.
        const policy = runtimeTarget.workload.policy;
        const logicalNames = [...new Set([policy.containerName ?? '', policy.displayName])];
        resolved = await service.maskSecretEnv(
          resolved,
          [policy.originNodeId, policy.sourceNodeId].flatMap((ownerNodeId) =>
            logicalNames.map((containerName) => ({ nodeId: ownerNodeId, containerName }))
          )
        );
        // The live inspect carries the environment; snapshots never do.
        if (!(await callerHasContainerScope(c, 'docker:containers:environment', 'containerName'))) {
          resolved = sanitizeContainerInspect(resolved);
        }
        const data = filterContainerDatabaseLinksForScopes(
          await service.decorateContainerDetailSnapshot(inspectNodeId, resolved),
          c.get('effectiveScopes') ?? []
        );
        return c.json({
          data: {
            ...(data && typeof data === 'object' ? data : { value: data }),
            Name: `/${requestedName}`,
            nodeId: inspectNodeId,
            logicalWorkload: {
              policyId: runtimeTarget.workload.policy.id,
              resourceKind: runtimeTarget.workload.policy.resourceKind,
              mode: runtimeTarget.workload.policy.mode,
              managementNodeId: runtimeTarget.workload.managementTarget.nodeId,
              managementResourceId: runtimeTarget.workload.managementTarget.resourceId,
              runtimeNodeId: runtimeTarget.nodeId,
              runtimeContainerId: runtimeTarget.containerId,
              placementId: runtimeTarget.placementId,
            },
            availability: 'available',
          },
        });
      }
      if (c.req.query('_t')) {
        const reconciler = container.resolve(DockerSnapshotReconciler);
        await reconciler.refreshNow(inspectNodeId, 'containers');
        await reconciler.refreshNow(inspectNodeId, 'container-detail', inspectIdentifier);
      }
      const detail = await containerDetailSnapshot(inspectNodeId, inspectIdentifier);
      const resolved = await resolveDockerContainerByName(
        { inspectContainer: async () => detail.data },
        inspectNodeId,
        inspectIdentifier
      );
      assertUserContainerSnapshot(resolved);
      const data = filterContainerDatabaseLinksForScopes(
        await service.decoratePublicContainerDetailSnapshot(inspectNodeId, resolved),
        c.get('effectiveScopes') ?? []
      );
      return c.json({
        data: {
          ...(data && typeof data === 'object' ? data : { value: data }),
          nodeId: inspectNodeId,
          availability: snapshots.availability(inspectNodeId, detail),
          app: await containerApp(inspectNodeId, data),
        },
      });
    }
  );

  router.openapi(
    {
      ...inspectContainerRoute,
      middleware: requireDockerContainerScope('docker:containers:view', 'containerId', {
        allowBroadWithoutResolve: true,
      }),
    },
    async (c) => {
      const snapshots = container.resolve(DockerSnapshotService);
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      if (c.req.query('_t')) {
        const reconciler = container.resolve(DockerSnapshotReconciler);
        await reconciler.refreshNow(nodeId, 'containers');
        await reconciler.refreshNow(nodeId, 'container-detail', containerId);
      }
      const detail = await containerDetailSnapshot(nodeId, containerId);
      const availabilityIdentity = await container
        .resolve(DockerAvailabilityService)
        .resolveRuntimeAccessIdentity(nodeId, containerId);
      if (!availabilityIdentity) assertUserContainerSnapshot(detail.data);
      const data = filterContainerDatabaseLinksForScopes(
        availabilityIdentity
          ? await service.decorateContainerDetailSnapshot(nodeId, detail.data)
          : await service.decoratePublicContainerDetailSnapshot(nodeId, detail.data),
        c.get('effectiveScopes') ?? []
      );
      return c.json({
        data: {
          ...(data && typeof data === 'object' ? data : { value: data }),
          nodeId,
          availability: snapshots.availability(nodeId, detail),
          app: await containerApp(nodeId, data),
        },
      });
    }
  );

  // Start container
  router.openapi(
    { ...startContainerRoute, middleware: requireDockerContainerScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const started = await service.startContainer(nodeId, containerId, user.id);
      await container.resolve(DockerSnapshotReconciler).refreshContainerNow(nodeId, [containerId, started?.name]);
      return c.json({ success: true });
    }
  );

  // Stop container
  router.openapi(
    { ...stopContainerRoute, middleware: requireDockerContainerScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json().catch(() => ({}));
      const { timeout } = ContainerStopSchema.parse(body);
      const stopped = await service.stopContainer(nodeId, containerId, timeout, user.id);
      await container.resolve(DockerSnapshotReconciler).refreshContainerNow(nodeId, [containerId, stopped?.name]);
      if (stopped?.pending)
        return c.json({ data: pendingOperationBody({ ...stopped, pending: stopped.pending }) }, 202);
      return c.json({ success: true });
    }
  );

  // Restart container
  router.openapi(
    { ...restartContainerRoute, middleware: requireDockerContainerScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json().catch(() => ({}));
      const { timeout } = ContainerStopSchema.parse(body);
      const restarted = await service.restartContainer(nodeId, containerId, timeout, user.id);
      await container.resolve(DockerSnapshotReconciler).refreshContainerNow(nodeId, [containerId, restarted?.name]);
      if (restarted?.pending)
        return c.json({ data: pendingOperationBody({ ...restarted, pending: restarted.pending }) }, 202);
      return c.json({ success: true });
    }
  );

  // Kill container
  router.openapi(
    {
      ...killContainerRoute,
      middleware: requireDockerContainerScope('docker:containers:manage', 'containerId', {
        allowTransitionIdentityFallback: true,
      }),
    },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json().catch(() => ({}));
      const { signal } = ContainerKillSchema.parse(body);
      const killed = await service.killContainer(nodeId, containerId, signal, user.id);
      await container.resolve(DockerSnapshotReconciler).refreshContainerNow(nodeId, [containerId, killed.name]);
      if (killed.pending) return c.json({ data: pendingOperationBody({ ...killed, pending: killed.pending }) }, 202);
      return c.json({ success: true });
    }
  );

  // Remove container
  router.openapi(
    {
      ...removeContainerRoute,
      middleware: requireDockerContainerScope('docker:containers:delete', 'containerId', { allowPendingSource: true }),
    },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      // A Git-source container waiting for its first build has nothing to inspect or remove yet.
      await assertNotPendingSourceContainer(nodeId, containerId);
      await assertComposeChildMutationAllowed(nodeId, containerId);
      // Opfield never removes an active container; a stopped one needs no force.
      const removal = await service.removeContainer(nodeId, containerId, false, user.id);
      if (removal.pending) return c.json({ data: pendingOperationBody({ ...removal, pending: removal.pending }) }, 202);
      return c.json({ success: true });
    }
  );

  // Rename container
  router.openapi(
    { ...renameContainerRoute, middleware: requireDockerContainerScope('docker:containers:edit') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json();
      const { name } = ContainerRenameSchema.parse(body);
      await service.renameContainer(nodeId, containerId, name, user.id);
      return c.json({ success: true });
    }
  );

  // Duplicate container
  router.openapi(
    {
      ...duplicateContainerRoute,
      middleware: [
        requireScopeBase('docker:containers:create'),
        requireDockerContainerScope('docker:containers:environment'),
        requireDockerContainerScope('docker:containers:secrets'),
      ],
    },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json();
      const { name, folderId } = ContainerDuplicateSchema.parse(body);
      const data = await service.duplicateContainer(
        nodeId,
        containerId,
        name,
        (user as import('@/types.js').User).id,
        c.get('effectiveScopes') || [],
        folderId
      );
      return c.json({ data }, 201);
    }
  );

  router.openapi(
    { ...exportContainerArchiveRoute, middleware: requireDockerContainerScope('docker:containers:export') },
    async (c) => {
      // LICENSE ENFORCEMENT: Archive operations are Personal entitlements under the project license/TOS.
      await container.resolve(LicensePolicyService).requireFeature('container-export');
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const query = ContainerArchiveExportQuerySchema.parse(c.req.query());
      // An archive with secrets carries their values out of Opfield.
      if (query.includeSecrets)
        assertNotImpersonating(c, 'Archives with secrets cannot be exported while impersonating');
      const archive = await openDockerContainerArchiveExport({
        nodeId,
        containerId,
        query,
        actorScopes: c.get('effectiveScopes') || [],
        userId: c.get('user')!.id,
      });
      return new Response(archive.stream, {
        headers: {
          'Content-Type': 'application/vnd.opfield.gwca',
          'Content-Disposition': `attachment; filename="${archive.filename}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
  );

  router.openapi(
    { ...planContainerArchiveImportRoute, middleware: requireScopeBase('docker:containers:create') },
    async (c) => {
      await container.resolve(LicensePolicyService).requireFeature('container-export');
      const nodeId = c.req.param('nodeId')!;
      const body = ContainerArchivePlanSchema.parse(await c.req.json());
      const data = await planDockerContainerArchiveImport(nodeId, body, c.get('effectiveScopes') || []);
      return c.json({ data });
    }
  );

  router.openapi(
    { ...importContainerArchiveRoute, middleware: requireScopeBase('docker:containers:create') },
    async (c) => {
      await container.resolve(LicensePolicyService).requireFeature('container-export');
      const nodeId = c.req.param('nodeId')!;
      const query = ContainerArchiveImportQuerySchema.parse(c.req.query());
      await assertDockerCreationAccess(
        container.resolve<DrizzleClient>(TOKENS.DrizzleClient),
        c.get('effectiveScopes') || [],
        'docker:containers:create',
        nodeId,
        query.folderId
      );
      if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/vnd.opfield.gwca') {
        throw new AppError(415, 'GWCA_MEDIA_TYPE_REQUIRED', 'Content-Type must be application/vnd.opfield.gwca');
      }
      const body = c.req.raw.body;
      if (!body) throw new AppError(400, 'GWCA_EMPTY', 'Container archive body is required');
      await assertNodeAllowsServiceCreation(container.resolve(TOKENS.DrizzleClient) as DrizzleClient, nodeId, 'docker');
      let resolution: ReturnType<typeof ContainerArchiveResolutionSchema.parse> = {};
      if (query.resolution) {
        try {
          resolution = ContainerArchiveResolutionSchema.parse(JSON.parse(query.resolution));
        } catch {
          throw new AppError(400, 'GWCA_RESOLUTION_INVALID', 'Archive import resolution is invalid');
        }
      }
      const data = await importDockerContainerArchive({
        nodeId,
        name: query.name,
        folderId: query.folderId,
        resolution,
        body,
        actorScopes: c.get('effectiveScopes') || [],
        userId: c.get('user')!.id,
      });
      return c.json({ data }, 201);
    }
  );

  // Update container (pull + redeploy). The scopes depend on the change: see containerUpdateRequiredScopes.
  router.openapi(
    {
      ...updateContainerRoute,
      middleware: answerNodeLoss('update', 'update', requireDockerContainerScope('docker:containers:view')),
    },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      const body = await c.req.json();
      const config = ContainerUpdateSchema.parse(body);
      await assertAdditionalContainerScopes(c, containerUpdateRequiredScopes(config));
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const data = await service.updateContainer(nodeId, containerId, config, user.id, c.get('effectiveScopes') || []);
      return c.json({ data });
    }
  );

  // Live update container (no recreation — resource limits + restart policy)
  router.openapi(
    { ...liveUpdateContainerRoute, middleware: requireDockerContainerScope('docker:containers:edit') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json();
      const config = ContainerLiveUpdateSchema.parse(body);
      await service.liveUpdateContainer(nodeId, containerId, config, user.id);
      return c.json({ success: true });
    }
  );

  // Recreate container with new config (ports, mounts, entrypoint, etc.)
  router.openapi(
    {
      ...recreateContainerRoute,
      middleware: answerNodeLoss('recreate', 'recreate', requireDockerContainerScope('docker:containers:manage')),
    },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json();
      const config = ContainerRecreateSchema.parse(body);
      await assertAdditionalContainerScopes(c, containerRecreateRequiredScopes(config));
      const data = await service.recreateWithConfig(nodeId, containerId, config, user.id, {
        actorScopes: c.get('effectiveScopes') || [],
        backgroundImagePull: true,
      });
      return c.json({ data });
    }
  );

  // Container logs
  router.openapi(
    { ...containerLogsRoute, middleware: requireDockerContainerScope('docker:containers:view') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const rawQuery = c.req.query();
      const { tail, timestamps } = LogQuerySchema.parse(rawQuery);
      const data = await service.getContainerLogs(nodeId, containerId, tail, timestamps);
      return c.json({ data });
    }
  );

  // Container stats from background health reports (never dispatches from this GET)
  router.openapi(
    { ...containerStatsRoute, middleware: requireDockerContainerScope('docker:containers:view') },
    async (c) => {
      const data = await getLatestDockerContainerStats(c.req.param('nodeId')!, c.req.param('containerId')!);
      return c.json({ data });
    }
  );

  // Container stats history (for sparklines)
  router.openapi(
    { ...containerStatsHistoryRoute, middleware: requireDockerContainerScope('docker:containers:view') },
    async (c) => {
      const data = await getDockerContainerStatsHistory(c.req.param('nodeId')!, c.req.param('containerId')!);
      return c.json({ data });
    }
  );

  // Container top (process list)
  router.openapi(
    { ...containerTopRoute, middleware: requireDockerContainerScope('docker:containers:view') },
    async (c) => {
      return c.json(await getDockerContainerProcesses(c.req.param('nodeId')!, c.req.param('containerId')!));
    }
  );

  // Get container env
  router.openapi(
    { ...containerEnvRoute, middleware: requireDockerContainerScope('docker:containers:environment') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const data = await service.getContainerEnv(nodeId, containerId);
      // Variables and secret keys the container gets from its app environment (shown as inherited, read-only).
      const inherited = await containerInheritedEnv(nodeId, containerId);
      return c.json({ data, inherited });
    }
  );

  // Update container env (recreates the container with it)
  router.openapi(
    {
      ...updateContainerEnvRoute,
      middleware: answerNodeLoss('env update', 'update', requireDockerContainerScope('docker:containers:environment')),
    },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json();
      const { env, removeEnv } = EnvUpdateSchema.parse(body);
      const data = await service.updateContainerEnv(nodeId, containerId, env, removeEnv, user.id);
      return c.json({ data });
    }
  );

  // ─── Secret routes ────────────────────────────────────────────────────

  // List secrets: the keys with docker:containers:environment, the values only with docker:containers:secrets
  router.openapi(
    { ...listContainerSecretsRoute, middleware: requireDockerContainerScope('docker:containers:environment') },
    async (c) => {
      const service = container.resolve(DockerSecretService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const containerName = await resolveContainerName(nodeId, containerId);
      // An impersonating administrator sees the keys, never the values.
      const reveal =
        !c.get('impersonation') && (await callerHasContainerScope(c, 'docker:containers:secrets', 'containerId'));
      const data = await service.list(nodeId, containerName, reveal);
      return c.json({ data });
    }
  );

  // Create secret
  router.openapi(
    { ...createContainerSecretRoute, middleware: requireDockerContainerScope('docker:containers:secrets') },
    async (c) => {
      const service = container.resolve(DockerSecretService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const containerName = await resolveContainerName(nodeId, containerId);
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const user = c.get('user')!;
      const body = await c.req.json();
      const { key, value } = SecretCreateSchema.parse(body);
      const data = await service.create(nodeId, containerName, key, value, user.id);
      return c.json({ data }, 201);
    }
  );

  // Update secret
  router.openapi(
    { ...updateContainerSecretRoute, middleware: requireDockerContainerScope('docker:containers:secrets') },
    async (c) => {
      const service = container.resolve(DockerSecretService);
      const nodeId = c.req.param('nodeId')!;
      const secretId = c.req.param('secretId')!;
      const containerId = c.req.param('containerId')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const containerName = await resolveContainerName(nodeId, containerId);
      const user = c.get('user')!;
      const body = await c.req.json();
      const { value } = SecretUpdateSchema.parse(body);
      const data = await service.update(secretId, nodeId, value, user.id, containerName);
      return c.json({ data });
    }
  );

  // Delete secret
  router.openapi(
    { ...deleteContainerSecretRoute, middleware: requireDockerContainerScope('docker:containers:secrets') },
    async (c) => {
      const service = container.resolve(DockerSecretService);
      const nodeId = c.req.param('nodeId')!;
      const secretId = c.req.param('secretId')!;
      const containerId = c.req.param('containerId')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const containerName = await resolveContainerName(nodeId, containerId);
      const user = c.get('user')!;
      await service.delete(secretId, nodeId, user.id, containerName);
      return c.json({ success: true });
    }
  );

  // ─── File browser routes ─────────────────────────────────────────────

  // List directory
  router.openapi(
    { ...listContainerFilesRoute, middleware: requireDockerContainerScope('docker:containers:files:read') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const rawQuery = c.req.query();
      const { path } = FileBrowseSchema.parse(rawQuery);
      const data = await service.listDirectory(nodeId, containerId, path);
      const truncated = Array.isArray(data) && data.length > DOCKER_RESOURCE_LIST_MAX;
      return c.json({
        data: truncated ? data.slice(0, DOCKER_RESOURCE_LIST_MAX) : data,
        total: Array.isArray(data) ? data.length : undefined,
        limit: DOCKER_RESOURCE_LIST_MAX,
        truncated,
      });
    }
  );

  // Read file
  router.openapi(
    { ...readContainerFileRoute, middleware: requireDockerContainerScope('docker:containers:files:read') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const rawQuery = c.req.query();
      const { path } = FileBrowseSchema.parse(rawQuery);
      const data = await service.readFile(nodeId, containerId, path);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(data.byteLength),
        },
      });
    }
  );

  // Write file
  router.openapi(
    { ...writeContainerFileRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      const { path, content } = await parseFileContentRequest(c);
      await service.writeFile(nodeId, containerId, path, content, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...createContainerFileRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      const { path, content } = await parseFileContentRequest(c);
      await service.createFile(nodeId, containerId, path, content, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...initContainerFileUploadRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      const { path, totalBytes } = FileUploadInitSchema.parse(await c.req.json());
      const data = await service.initFileUpload(nodeId, containerId, path, totalBytes, user.id);
      return c.json({ data });
    }
  );

  router.openapi(
    { ...uploadContainerFileChunkRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const uploadId = c.req.param('uploadId')!;
      const { offset } = FileUploadChunkQuerySchema.parse(c.req.query());
      const content = Buffer.from(await c.req.arrayBuffer());
      const data = await service.appendFileUploadChunk(nodeId, containerId, uploadId, offset, content);
      return c.json({ data });
    }
  );

  router.openapi(
    { ...completeContainerFileUploadRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const uploadId = c.req.param('uploadId')!;
      const { path, totalBytes } = FileUploadCompleteSchema.parse(await c.req.json());
      await service.completeFileUpload(nodeId, containerId, uploadId, path, totalBytes);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...abortContainerFileUploadRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const uploadId = c.req.param('uploadId')!;
      await service.abortFileUpload(nodeId, containerId, uploadId);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...createContainerDirectoryRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      const body = await c.req.json();
      const { path } = FileBrowseSchema.parse(body);
      await service.createDirectory(nodeId, containerId, path, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...deleteContainerFileRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      const rawQuery = c.req.query();
      const { path } = FileBrowseSchema.parse(rawQuery);
      await service.deleteFile(nodeId, containerId, path, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...moveContainerFileRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      const body = await c.req.json();
      const { fromPath, toPath } = FileMoveSchema.parse(body);
      await service.moveFile(nodeId, containerId, fromPath, toPath, user.id);
      return c.json({ success: true });
    }
  );
}
