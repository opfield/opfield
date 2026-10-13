import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, gt } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerBuilds, dockerSourceBindings } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

const rolloutContext = new AsyncLocalStorage<{ buildId: string }>();

/**
 * Runs a build rollout's own mutations of its target. The guard admits calls
 * made inside `operation` for that build; every other caller is refused.
 */
export function runAsDockerBuildRollout<T>(buildId: string, operation: () => Promise<T>): Promise<T> {
  return rolloutContext.run({ buildId }, operation);
}

export type DockerBuildRolloutTarget =
  | { kind: 'container'; nodeId: string; containerName: string }
  | { kind: 'deployment'; deploymentId: string }
  | { kind: 'compose_project'; composeProjectId: string };

export interface ActiveDockerBuildRollout {
  buildId: string;
  commitSha: string;
  sourceBindingId: string;
  targetKind: string;
  nodeId: string | null;
  containerName: string | null;
  deploymentId: string | null;
  composeProjectId: string | null;
}

const TARGET_NOUN: Record<DockerBuildRolloutTarget['kind'], string> = {
  container: 'container',
  deployment: 'deployment',
  compose_project: 'Compose project',
};

export function dockerBuildRolloutConflict(
  rollout: Pick<ActiveDockerBuildRollout, 'buildId' | 'commitSha'>,
  kind: DockerBuildRolloutTarget['kind']
): AppError {
  return new AppError(
    409,
    'BUILD_ROLLOUT_IN_PROGRESS',
    `A deployment of build ${rollout.commitSha.slice(0, 10)} is in progress for this ${TARGET_NOUN[kind]}; try again when it finishes`,
    { buildId: rollout.buildId, commitSha: rollout.commitSha, retryable: true }
  );
}

function matchesTarget(rollout: ActiveDockerBuildRollout, target: DockerBuildRolloutTarget): boolean {
  if (rollout.targetKind !== target.kind) return false;
  if (target.kind === 'container') {
    return rollout.nodeId === target.nodeId && rollout.containerName === target.containerName;
  }
  if (target.kind === 'deployment') return rollout.deploymentId === target.deploymentId;
  return rollout.composeProjectId === target.composeProjectId;
}

/**
 * A build rollout owns its target from the moment it is accepted (`deploying`)
 * until it succeeds, fails or is cancelled. Ownership is the build row and its
 * lease, so it survives an Opfield restart and lapses with the lease; recovery
 * then either resumes the rollout (re-leasing it) or settles the build.
 */
export class DockerBuildRolloutGuard {
  constructor(private readonly db: DrizzleClient) {}

  /** Rollouts holding a live lease, except the one making the current call. */
  async active(now = new Date()): Promise<ActiveDockerBuildRollout[]> {
    const rows = await this.db
      .select({
        buildId: dockerBuilds.id,
        commitSha: dockerBuilds.commitSha,
        sourceBindingId: dockerBuilds.sourceBindingId,
        targetKind: dockerSourceBindings.targetKind,
        nodeId: dockerSourceBindings.nodeId,
        containerName: dockerSourceBindings.containerName,
        deploymentId: dockerSourceBindings.deploymentId,
        composeProjectId: dockerSourceBindings.composeProjectId,
      })
      .from(dockerBuilds)
      .innerJoin(dockerSourceBindings, eq(dockerSourceBindings.id, dockerBuilds.sourceBindingId))
      .where(and(eq(dockerBuilds.status, 'deploying'), gt(dockerBuilds.leaseExpiresAt, now)));
    const own = rolloutContext.getStore()?.buildId;
    if (!own) return rows;
    // Builds of the same source (e.g. the services of one Compose batch) are
    // serialized by the source lock and belong to the calling rollout.
    const ownSource = rows.find((row) => row.buildId === own)?.sourceBindingId;
    return rows.filter((row) => row.buildId !== own && (!ownSource || row.sourceBindingId !== ownSource));
  }

  async find(target: DockerBuildRolloutTarget): Promise<ActiveDockerBuildRollout | null> {
    return (await this.active()).find((rollout) => matchesTarget(rollout, target)) ?? null;
  }

  async assertAllowed(target: DockerBuildRolloutTarget): Promise<void> {
    const rollout = await this.find(target);
    if (rollout) throw dockerBuildRolloutConflict(rollout, target.kind);
  }

  /**
   * Container requests may name a runtime ID, a physical replica or the logical
   * workload. Identities are resolved only when a container rollout is active.
   */
  async assertContainerAllowed(
    resolveIdentities: () => Promise<Array<{ nodeId: string; containerName: string }>>
  ): Promise<void> {
    const rollouts = (await this.active()).filter((rollout) => rollout.targetKind === 'container');
    if (rollouts.length === 0) return;
    const identities = await resolveIdentities();
    const owner = rollouts.find((rollout) =>
      identities.some((identity) => matchesTarget(rollout, { kind: 'container', ...identity }))
    );
    if (owner) throw dockerBuildRolloutConflict(owner, 'container');
  }
}
