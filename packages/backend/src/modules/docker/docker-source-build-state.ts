import { desc, eq } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { dockerBuildArtifacts, dockerBuilds, dockerSourceBindings } from '@/db/schema/index.js';
import type { DockerSourceTarget } from './docker-build.schemas.js';
import { DockerSourceService } from './docker-source.service.js';
import { findContainerSourceTargetOwner, sourceTargetOwnedAdvice } from './docker-source-target-owner.js';

/** One build of a Git source, as its source answer shows it. */
export interface DockerSourceBuildSummary {
  id: string;
  status: string;
  trigger: string;
  commitSha: string;
  serviceName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  policyDecision: string | null;
  policyReason: string | null;
  /** Vulnerability counts of the scanned image over the full report; null before a scan. */
  scanCounts: { critical: number; high: number; medium: number; low: number; unknown: number } | null;
  rolloutNote: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface DockerSourceStateInput {
  autoBuild: boolean;
  autoDeploy: boolean;
  /** The branch head the last poll or sync recorded. */
  desiredCommitSha?: string | null;
  deployedCommitSha: string | null;
  lastPollError: string | null;
}

const ACTIVE = new Set(['queued', 'claimed', 'checking_out', 'building', 'scanning', 'pushing']);
const POLICY_REJECTED = 'BUILD_ARTIFACT_POLICY_REJECTED';
/** A rejection recorded before the reason said what to do (2.12.2 and earlier). */
const POLICY_FIX =
  'Update the affected packages and build again, or change the Git source policy: vulnerabilityScope "application" (OS packages only reported), "fixable_application" or "fixable_all" (only findings with a released fix), or a vulnerabilityThreshold above the blocking severities.';

function short(sha: string): string {
  return sha.slice(0, 10);
}

function withPeriod(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * The plain state of a Git source: what its latest build did and what runs on the target, with what to do when nothing
 * was deployed. `builds` are the latest build, or for a Compose source the service builds of its latest commit.
 */
export function describeDockerSourceState(source: DockerSourceStateInput, builds: DockerSourceBuildSummary[]): string {
  const state = describeLatestBuild(source, builds);
  // A newer head whose build was refused (the internal registry takes no pushes, no Build Worker): say so first, the
  // state of the latest build alone reads as if the head were deployed.
  const head = source.desiredCommitSha?.toLowerCase();
  if (builds.length > 0 && source.lastPollError && head && !builds.some((build) => build.commitSha.toLowerCase() === head)) {
    return `Commit ${short(head)} was not built: ${withPeriod(source.lastPollError)} The next poll or sync builds it once that is resolved. ${state}`;
  }
  return state;
}

function describeLatestBuild(source: DockerSourceStateInput, builds: DockerSourceBuildSummary[]): string {
  const deployed = source.deployedCommitSha
    ? `The target runs commit ${short(source.deployedCommitSha)}.`
    : 'Nothing has been deployed from this source yet.';
  const latest = builds[0];
  if (!latest) {
    if (source.lastPollError) return `No build yet: ${withPeriod(source.lastPollError)} ${deployed}`;
    return source.autoBuild
      ? `No build yet: the next repository poll queues one; run build (or sync) to start it now. ${deployed}`
      : `No build yet: automatic builds are off; run build to start one. ${deployed}`;
  }
  const commit = short(latest.commitSha);
  const failed = builds.find((build) => build.status === 'failed');
  if (failed) {
    const service = failed.serviceName ? ` (service ${failed.serviceName})` : '';
    if (failed.errorCode === POLICY_REJECTED) {
      const reason = failed.errorMessage || failed.policyReason || 'The vulnerability policy rejected the image';
      const fix = reason.includes('The image was not deployed') ? '' : ` ${POLICY_FIX}`;
      return `Latest build of commit ${commit}${service} failed: the vulnerability policy rejected the image, so it was not deployed. ${withPeriod(reason)}${fix} ${deployed}`;
    }
    const reason = failed.errorMessage ? `: ${withPeriod(failed.errorMessage)}` : '.';
    return `Latest build of commit ${commit}${service} failed (${failed.errorCode ?? 'BUILD_FAILED'})${reason} Fix the cause, then build again (manage_docker_source build, or manage_docker_build retry). ${deployed}`;
  }
  if (builds.some((build) => ACTIVE.has(build.status))) {
    return `Build of commit ${commit} is in progress (${latest.status}). ${deployed}`;
  }
  if (builds.some((build) => build.status === 'deploying'))
    return `Build of commit ${commit} is being deployed. ${deployed}`;
  if (latest.status === 'cancelled') return `Latest build of commit ${commit} was cancelled. ${deployed}`;
  if (latest.status === 'superseded')
    return `Latest build of commit ${commit} was superseded by a newer commit. ${deployed}`;
  if (source.deployedCommitSha?.toLowerCase() === latest.commitSha.toLowerCase()) {
    return `Commit ${commit} is deployed.${latest.rolloutNote ? ` ${withPeriod(latest.rolloutNote)}` : ''}`;
  }
  if (!source.autoDeploy) {
    return `Build of commit ${commit} succeeded; automatic deployment is off, so it was not deployed. ${deployed}`;
  }
  // The target runs an earlier commit although the newest build succeeded: it was rolled back.
  if (source.deployedCommitSha) {
    return `Build of commit ${commit} succeeded, but the target runs the earlier commit ${short(source.deployedCommitSha)} (rolled back). The next new commit deploys again; to deploy ${commit} now, build it again with force.`;
  }
  return `Build of commit ${commit} succeeded. ${deployed}`;
}

/** The latest build of a source; for a Compose source, every service build of its latest commit. */
export async function readLatestDockerSourceBuilds(
  sourceBindingId: string,
  db: DrizzleClient = container.resolve<DrizzleClient>(TOKENS.DrizzleClient)
): Promise<DockerSourceBuildSummary[]> {
  const select = () =>
    db
      .select({
        build: dockerBuilds,
        policyDecision: dockerBuildArtifacts.policyDecision,
        policyReason: dockerBuildArtifacts.policyReason,
        scanSummary: dockerBuildArtifacts.scanSummary,
      })
      .from(dockerBuilds)
      .leftJoin(dockerBuildArtifacts, eq(dockerBuildArtifacts.buildId, dockerBuilds.id));
  const [newest] = await select()
    .where(eq(dockerBuilds.sourceBindingId, sourceBindingId))
    .orderBy(desc(dockerBuilds.createdAt), desc(dockerBuilds.id))
    .limit(1);
  if (!newest) return [];
  const rows = newest.build.batchId
    ? await select()
        .where(eq(dockerBuilds.batchId, newest.build.batchId))
        .orderBy(desc(dockerBuilds.createdAt), desc(dockerBuilds.id))
    : [newest];
  return rows.map(({ build, policyDecision, policyReason, scanSummary }) => {
    const note = (build.progress as Record<string, unknown> | null)?.rolloutNote;
    return {
      id: build.id,
      status: build.status,
      trigger: build.trigger,
      commitSha: build.commitSha,
      serviceName: build.serviceName,
      errorCode: build.errorCode,
      errorMessage: build.errorMessage,
      policyDecision: policyDecision ?? null,
      policyReason: policyReason ?? null,
      scanCounts: scanSummary
        ? {
            critical: scanSummary.critical,
            high: scanSummary.high,
            medium: scanSummary.medium,
            low: scanSummary.low,
            unknown: scanSummary.unknown,
          }
        : null,
      rolloutNote: typeof note === 'string' && note ? note : null,
      createdAt: build.createdAt,
      completedAt: build.completedAt,
    };
  });
}

/**
 * The source as its get and save answers show it: with its latest build (`latestBuild`; `latestBuilds` holds every
 * service build of a Compose commit) and `state`, a sentence saying why nothing is deployed when that is the case.
 * A container source whose container a Compose project or blue/green deployment owns (attached before that was
 * refused) is reported in `invalidTarget` and `state` with where to attach instead; nothing is changed.
 */
export async function withDockerSourceBuildState<
  T extends DockerSourceStateInput & { id: string; target: { kind: string; nodeId?: string; containerName?: string } },
>(source: T) {
  const latestBuilds = await readLatestDockerSourceBuilds(source.id);
  const owner =
    source.target.kind === 'container' && source.target.nodeId && source.target.containerName
      ? await findContainerSourceTargetOwner(source.target.nodeId, source.target.containerName)
      : null;
  const invalidTarget =
    owner && source.target.containerName
      ? { code: 'SOURCE_TARGET_OWNED', message: sourceTargetOwnedAdvice(source.target.containerName, owner) }
      : null;
  const state = describeDockerSourceState(source, latestBuilds);
  return {
    ...source,
    latestBuild: latestBuilds[0] ?? null,
    latestBuilds,
    invalidTarget,
    state: invalidTarget ? `Invalid target: ${invalidTarget.message} ${state}` : state,
  };
}

export async function getDockerSourceWithBuildState(target: DockerSourceTarget) {
  const source = await container.resolve(DockerSourceService).get(target);
  return source ? withDockerSourceBuildState(source) : null;
}

/**
 * A container its first build has not created yet (`manage_docker_source pending`, the pending page) with the same
 * latest build and `state` as the source answers, so a failed first build says why and what to do.
 */
export async function withPendingDockerSourceBuildState<T extends { sourceBindingId: string }>(pending: T) {
  const [binding] = await container
    .resolve<DrizzleClient>(TOKENS.DrizzleClient)
    .select({
      autoBuild: dockerSourceBindings.autoBuild,
      autoDeploy: dockerSourceBindings.autoDeploy,
      desiredCommitSha: dockerSourceBindings.desiredCommitSha,
      deployedCommitSha: dockerSourceBindings.deployedCommitSha,
      lastPollError: dockerSourceBindings.lastPollError,
    })
    .from(dockerSourceBindings)
    .where(eq(dockerSourceBindings.id, pending.sourceBindingId))
    .limit(1);
  const latestBuilds = await readLatestDockerSourceBuilds(pending.sourceBindingId);
  return {
    ...pending,
    latestBuild: latestBuilds[0] ?? null,
    latestBuilds,
    state: binding ? describeDockerSourceState(binding, latestBuilds) : null,
  };
}
