import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerArtifactPins,
  dockerAvailabilityOperations,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerBuildArtifacts,
  dockerBuilds,
  dockerComposeProjects,
  dockerComposeRevisions,
  dockerDeploymentSlots,
  dockerDeployments,
  dockerInternalRegistryState,
  dockerRegistryMaintenanceRuns,
  dockerSourceBindings,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DockerService } from '@/services/docker.service.js';
import { ACTIVE_BUILD_STATUSES } from './docker-build-policy.js';
import { classifyRegistryRetentionArtifacts, type RegistryRetentionArtifact } from './docker-registry-retention.js';
import type { DockerRegistryGrant, DockerRegistryTokenService } from './docker-registry-token.service.js';

export {
  REGISTRY_BUILDS_KEPT_PER_CONTAINER,
  type RegistryRetentionArtifact,
  selectRegistryRetentionCandidates,
} from './docker-registry-retention.js';

const REGISTRY_STATE_ID = 'system';

export const DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS = 15 * 60_000;
export const MAX_REGISTRY_WRITE_TOKEN_TTL_SECONDS = 30;
export const REGISTRY_WRITE_DRAIN_GRACE_MS = (MAX_REGISTRY_WRITE_TOKEN_TTL_SECONDS + 5) * 1000;

export async function registryRuntimeReferences(db: DrizzleClient): Promise<string> {
  return JSON.stringify(
    await Promise.all([
      db
        .select({ spec: dockerAvailabilityPolicies.portableSpec, image: dockerAvailabilityPolicies.imageReference })
        .from(dockerAvailabilityPolicies),
      db
        .select({
          runtime: dockerAvailabilityPlacements.runtimeIdentity,
          image: dockerAvailabilityPlacements.imageReference,
        })
        .from(dockerAvailabilityPlacements)
        .where(sql`${dockerAvailabilityPlacements.actualState} <> 'removed'`),
      db
        .select({ requested: dockerAvailabilityOperations.requestedPolicy })
        .from(dockerAvailabilityOperations)
        .where(sql`${dockerAvailabilityOperations.status} in ('pending', 'running', 'waiting')`),
      db
        .select({ source: dockerComposeRevisions.sourceYaml, model: dockerComposeRevisions.normalizedModel })
        .from(dockerComposeProjects)
        .innerJoin(dockerComposeRevisions, eq(dockerComposeRevisions.id, dockerComposeProjects.activeRevisionId)),
      db.select({ config: dockerDeployments.desiredConfig }).from(dockerDeployments),
      // A blue/green slot keeps the image it ran until it is reused.
      db
        .select({ image: dockerDeploymentSlots.image, config: dockerDeploymentSlots.desiredConfig })
        .from(dockerDeploymentSlots),
    ])
  );
}

export type RegistryState = typeof dockerInternalRegistryState.$inferSelect;
export type MaintenanceRun = typeof dockerRegistryMaintenanceRuns.$inferSelect;
type RegistryStateUpdate = Partial<typeof dockerInternalRegistryState.$inferInsert>;
type MaintenanceRunUpdate = Partial<typeof dockerRegistryMaintenanceRuns.$inferInsert>;

export interface DockerRegistryMaintenanceExecutor {
  hasRepositories(): Promise<boolean>;
  storageUsedBytes(): Promise<number>;
  pauseAdmissions(): Promise<void>;
  drainUploads(): Promise<void>;
  deleteManifest(repository: string, digest: string): Promise<void>;
  enterReadOnly(): Promise<void>;
  collectGarbage(): Promise<void>;
  verifyIntegrity(retained: Array<{ repository: string; digest: string }>): Promise<void>;
  restoreWrites(): Promise<void>;
}

export function createDockerRegistryMaintenanceExecutor(
  docker: DockerService,
  tokenService: DockerRegistryTokenService,
  registryUrl = process.env.OPFIELD_INTERNAL_REGISTRY_URL || 'http://registry:5000',
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
): DockerRegistryMaintenanceExecutor {
  const waitUntilRegistryReady = async () => {
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(new URL('/v2/', registryUrl), {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok || response.status === 401) {
          await response.body?.cancel();
          return;
        }
        lastError = new Error(`Registry readiness probe failed (${response.status})`);
        await response.body?.cancel();
      } catch (error) {
        lastError = error;
      }
      await wait(250);
    }
    throw new Error(
      `Managed registry did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  };
  const request = async (repository: string, digest: string, method: 'GET' | 'DELETE', action: 'pull' | 'delete') => {
    const grant = { repository, actions: [action] } satisfies DockerRegistryGrant;
    const issued = tokenService.issueToken({
      subject: 'opfield:registry-maintenance',
      requested: [grant],
      allowed: [grant],
      ttlSeconds: 300,
    });
    const encodedRepository = repository.split('/').map(encodeURIComponent).join('/');
    return fetch(new URL(`/v2/${encodedRepository}/manifests/${encodeURIComponent(digest)}`, registryUrl), {
      method,
      headers: {
        authorization: `Bearer ${issued.token}`,
        accept: [
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.docker.distribution.manifest.v2+json',
        ].join(', '),
      },
      signal: AbortSignal.timeout(30_000),
    });
  };
  return {
    hasRepositories: () => docker.managedRegistryHasRepositories(),
    storageUsedBytes: () => docker.managedRegistryStorageUsedBytes(),
    pauseAdmissions: async () => undefined,
    drainUploads: async () => {
      await wait(REGISTRY_WRITE_DRAIN_GRACE_MS);
      await docker.restartManagedRegistry();
      await waitUntilRegistryReady();
    },
    deleteManifest: async (repository, digest) => {
      const response = await request(repository, digest, 'DELETE', 'delete');
      if (response.status !== 202 && response.status !== 404) {
        throw new Error(`Registry manifest deletion failed (${response.status})`);
      }
    },
    enterReadOnly: async () => docker.stopManagedRegistry(),
    collectGarbage: async () => {
      await docker.runManagedRegistryGarbageCollection(false);
      await waitUntilRegistryReady();
    },
    verifyIntegrity: async (retained) => {
      for (const artifact of retained) {
        const response = await request(artifact.repository, artifact.digest, 'GET', 'pull');
        if (!response.ok) {
          throw new Error(`Retained registry artifact is unreadable (${response.status}): ${artifact.digest}`);
        }
        await response.body?.cancel();
      }
    },
    restoreWrites: async () => {
      await docker.recoverManagedRegistryMaintenance();
      await waitUntilRegistryReady();
    },
  };
}

export interface DockerRegistryMaintenanceStore {
  initialize(): Promise<void>;
  getState(): Promise<RegistryState>;
  updateState(values: RegistryStateUpdate): Promise<RegistryState>;
  acquireLease(owner: string, leaseExpiresAt: Date, now: Date): Promise<RegistryState>;
  renewLease(owner: string, leaseExpiresAt: Date): Promise<void>;
  createRun(owner: string, leaseExpiresAt: Date, dryRun: boolean): Promise<MaintenanceRun>;
  getRun(id: string): Promise<MaintenanceRun>;
  updateRun(id: string, values: MaintenanceRunUpdate): Promise<MaintenanceRun>;
  listRetentionArtifacts(now: Date): Promise<RegistryRetentionArtifact[]>;
  markArtifactDeleted(id: string, now: Date): Promise<void>;
  markInterruptedRunsFailed?(now: Date, message: string): Promise<void>;
  /** The source binding of a finished build, and whether another build of it is still running. */
  buildRetentionScope?(buildId: string): Promise<{ sourceBindingId: string; busy: boolean } | null>;
  /** Whether a build or an Availability operation may push to or pull from the registry now. */
  hasActiveRegistryUsers?(): Promise<boolean>;
  /** Whether artifacts were deleted since the last garbage collection, so their layers still take space. */
  hasUncollectedDeletions?(lastGcAt: Date | null): Promise<boolean>;
}

class DrizzleDockerRegistryMaintenanceStore implements DockerRegistryMaintenanceStore {
  constructor(private readonly db: DrizzleClient) {}

  async initialize(): Promise<void> {
    await this.db.insert(dockerInternalRegistryState).values({ id: REGISTRY_STATE_ID }).onConflictDoNothing();
  }

  async getState(): Promise<RegistryState> {
    const [state] = await this.db
      .select()
      .from(dockerInternalRegistryState)
      .where(eq(dockerInternalRegistryState.id, REGISTRY_STATE_ID))
      .limit(1);
    if (!state)
      throw new AppError(503, 'INTERNAL_REGISTRY_STATE_UNAVAILABLE', 'Internal registry state is unavailable');
    return state;
  }

  async updateState(values: RegistryStateUpdate): Promise<RegistryState> {
    const [state] = await this.db
      .update(dockerInternalRegistryState)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(dockerInternalRegistryState.id, REGISTRY_STATE_ID))
      .returning();
    if (!state)
      throw new AppError(503, 'INTERNAL_REGISTRY_STATE_UNAVAILABLE', 'Internal registry state is unavailable');
    return state;
  }

  async acquireLease(owner: string, leaseExpiresAt: Date, now: Date): Promise<RegistryState> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-internal-registry-maintenance'))`);
      const [state] = await tx
        .select()
        .from(dockerInternalRegistryState)
        .where(eq(dockerInternalRegistryState.id, REGISTRY_STATE_ID))
        .limit(1);
      if (!state)
        throw new AppError(503, 'INTERNAL_REGISTRY_STATE_UNAVAILABLE', 'Internal registry state is unavailable');
      if (
        state.maintenanceLeaseOwner &&
        state.maintenanceLeaseOwner !== owner &&
        state.maintenanceLeaseExpiresAt &&
        state.maintenanceLeaseExpiresAt > now
      ) {
        throw new AppError(409, 'REGISTRY_MAINTENANCE_BUSY', 'Internal registry maintenance is already running');
      }
      const [leased] = await tx
        .update(dockerInternalRegistryState)
        .set({
          status: 'maintenance',
          writable: false,
          maintenancePhase: 'acquiring_lease',
          maintenanceLeaseOwner: owner,
          maintenanceLeaseExpiresAt: leaseExpiresAt,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(dockerInternalRegistryState.id, REGISTRY_STATE_ID))
        .returning();
      return leased;
    });
  }

  async renewLease(owner: string, leaseExpiresAt: Date): Promise<void> {
    const [state] = await this.db
      .update(dockerInternalRegistryState)
      .set({ maintenanceLeaseExpiresAt: leaseExpiresAt, updatedAt: new Date() })
      .where(
        and(
          eq(dockerInternalRegistryState.id, REGISTRY_STATE_ID),
          eq(dockerInternalRegistryState.maintenanceLeaseOwner, owner)
        )
      )
      .returning({ id: dockerInternalRegistryState.id });
    if (!state) throw new AppError(409, 'REGISTRY_MAINTENANCE_LEASE_LOST', 'Registry maintenance lease was lost');
  }

  async createRun(owner: string, leaseExpiresAt: Date, dryRun: boolean): Promise<MaintenanceRun> {
    const [run] = await this.db
      .insert(dockerRegistryMaintenanceRuns)
      .values({ phase: 'acquiring_lease', leaseOwner: owner, leaseExpiresAt, dryRun })
      .returning();
    return run;
  }

  async getRun(id: string): Promise<MaintenanceRun> {
    const [run] = await this.db
      .select()
      .from(dockerRegistryMaintenanceRuns)
      .where(eq(dockerRegistryMaintenanceRuns.id, id))
      .limit(1);
    if (!run) throw new AppError(404, 'REGISTRY_MAINTENANCE_NOT_FOUND', 'Registry maintenance run not found');
    return run;
  }

  async updateRun(id: string, values: MaintenanceRunUpdate): Promise<MaintenanceRun> {
    const [run] = await this.db
      .update(dockerRegistryMaintenanceRuns)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(dockerRegistryMaintenanceRuns.id, id))
      .returning();
    if (!run) throw new AppError(404, 'REGISTRY_MAINTENANCE_NOT_FOUND', 'Registry maintenance run not found');
    return run;
  }

  async listRetentionArtifacts(now: Date): Promise<RegistryRetentionArtifact[]> {
    const [artifacts, pins, references, bindings] = await Promise.all([
      this.db
        .select({
          id: dockerBuildArtifacts.id,
          buildId: dockerBuildArtifacts.buildId,
          sourceBindingId: dockerBuildArtifacts.sourceBindingId,
          ownerKind: dockerBuildArtifacts.ownerKind,
          repository: dockerBuildArtifacts.registryRepository,
          digest: dockerBuildArtifacts.digest,
          createdAt: dockerBuildArtifacts.createdAt,
          policyDecision: dockerBuildArtifacts.policyDecision,
          buildStatus: dockerBuilds.status,
        })
        .from(dockerBuildArtifacts)
        .leftJoin(dockerBuilds, eq(dockerBuilds.id, dockerBuildArtifacts.buildId))
        .where(inArray(dockerBuildArtifacts.status, ['ready', 'rejected']))
        .orderBy(desc(dockerBuildArtifacts.createdAt)),
      this.db
        .select({
          artifactId: dockerArtifactPins.artifactId,
          kind: dockerArtifactPins.kind,
          ownerKey: dockerArtifactPins.ownerKey,
          composeRevisionId: dockerArtifactPins.composeRevisionId,
        })
        .from(dockerArtifactPins)
        .where(or(isNull(dockerArtifactPins.expiresAt), gt(dockerArtifactPins.expiresAt, now))),
      registryRuntimeReferences(this.db),
      this.db
        .select({
          id: dockerSourceBindings.id,
          targetKind: dockerSourceBindings.targetKind,
          nodeId: dockerSourceBindings.nodeId,
          containerName: dockerSourceBindings.containerName,
          deploymentId: dockerSourceBindings.deploymentId,
          composeProjectId: dockerSourceBindings.composeProjectId,
        })
        .from(dockerSourceBindings),
    ]);
    return classifyRegistryRetentionArtifacts({ artifacts, pins, references, bindings });
  }

  async buildRetentionScope(buildId: string): Promise<{ sourceBindingId: string; busy: boolean } | null> {
    const [build] = await this.db
      .select({ sourceBindingId: dockerBuilds.sourceBindingId })
      .from(dockerBuilds)
      .where(eq(dockerBuilds.id, buildId))
      .limit(1);
    if (!build) return null;
    const [other] = await this.db
      .select({ id: dockerBuilds.id })
      .from(dockerBuilds)
      .where(
        and(
          eq(dockerBuilds.sourceBindingId, build.sourceBindingId),
          ne(dockerBuilds.id, buildId),
          inArray(dockerBuilds.status, ACTIVE_BUILD_STATUSES)
        )
      )
      .limit(1);
    return { sourceBindingId: build.sourceBindingId, busy: Boolean(other) };
  }

  async hasActiveRegistryUsers(): Promise<boolean> {
    const [[build], [operation]] = await Promise.all([
      this.db
        .select({ id: dockerBuilds.id })
        .from(dockerBuilds)
        .where(inArray(dockerBuilds.status, ACTIVE_BUILD_STATUSES))
        .limit(1),
      this.db
        .select({ id: dockerAvailabilityOperations.id })
        .from(dockerAvailabilityOperations)
        .where(inArray(dockerAvailabilityOperations.status, ['pending', 'running', 'waiting']))
        .limit(1),
    ]);
    return Boolean(build || operation);
  }

  async hasUncollectedDeletions(lastGcAt: Date | null): Promise<boolean> {
    const [deleted] = await this.db
      .select({ id: dockerBuildArtifacts.id })
      .from(dockerBuildArtifacts)
      .where(
        lastGcAt
          ? and(eq(dockerBuildArtifacts.status, 'deleted'), gt(dockerBuildArtifacts.updatedAt, lastGcAt))
          : eq(dockerBuildArtifacts.status, 'deleted')
      )
      .limit(1);
    return Boolean(deleted);
  }

  async markArtifactDeleted(id: string, now: Date): Promise<void> {
    await this.db
      .update(dockerBuildArtifacts)
      .set({ status: 'deleted', updatedAt: now })
      .where(eq(dockerBuildArtifacts.id, id));
  }

  async markInterruptedRunsFailed(now: Date, message: string): Promise<void> {
    await this.db
      .update(dockerRegistryMaintenanceRuns)
      .set({ status: 'failed', phase: 'failed', error: message, completedAt: now, updatedAt: now })
      .where(eq(dockerRegistryMaintenanceRuns.status, 'running'));
  }
}

export function createDockerRegistryMaintenanceStore(db: DrizzleClient): DockerRegistryMaintenanceStore {
  return new DrizzleDockerRegistryMaintenanceStore(db);
}

export const unavailableDockerRegistryMaintenanceExecutor: DockerRegistryMaintenanceExecutor = {
  hasRepositories: async () => {
    throw new AppError(503, 'REGISTRY_CONTROL_UNAVAILABLE', 'Internal registry control channel is unavailable');
  },
  storageUsedBytes: async () => {
    throw new AppError(503, 'REGISTRY_CONTROL_UNAVAILABLE', 'Internal registry control channel is unavailable');
  },
  pauseAdmissions: async () => {
    throw new AppError(503, 'REGISTRY_CONTROL_UNAVAILABLE', 'Internal registry control channel is unavailable');
  },
  drainUploads: async () => undefined,
  deleteManifest: async () => undefined,
  enterReadOnly: async () => undefined,
  collectGarbage: async () => undefined,
  verifyIntegrity: async () => undefined,
  restoreWrites: async () => undefined,
};
