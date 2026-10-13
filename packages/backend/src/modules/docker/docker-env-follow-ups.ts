import type { DockerTaskFollowUps, DockerTaskTracking } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { ContainerTransition, ContainerTransitionClaim } from './docker-container-transitions.js';
import { envListToMap } from './docker-env-operations.js';
import type { DockerTaskRow, DockerTaskService } from './docker-task.service.js';

const logger = createChildLogger('DockerEnvFollowUps');

/** Placeholder that inspect returns for secret-backed env values. */
export const MASKED_ENV_VALUE = '********';

/** The sealed part of DockerTaskFollowUps: the env its follow-ups need, never in plaintext in the task row. */
export interface DockerEnvFollowUpPayload {
  /** The stored env the operation left. A follow-up Opfield runs after it lost track of the task needs it unchanged. */
  expectedEnv: Record<string, string>;
  /** The keys of `expectedEnv` whose value the replaced runtime had too (reconcileEnvAfterImageChange). */
  mirroredKeys?: string[];
  /** The stored env before the update (restoreEnvAfterFailedUpdate). */
  restoreEnv?: Record<string, string>;
}

/** Tells Opfield that a docker daemon's task_status also finds a task by the Opfield command that started it. */
export const TASK_COMMAND_LOOKUP_CAPABILITY = 'docker_task_command_lookup_v1';

type SealedEnv = DockerTaskFollowUps['sealed'];

/** Seals a follow-up payload with the key and envelope of stored container env (CryptoService.encryptString). */
export function sealEnvFollowUpPayload(
  crypto: Pick<CryptoService, 'encryptString'>,
  payload: DockerEnvFollowUpPayload
): SealedEnv {
  return crypto.encryptString(JSON.stringify(payload));
}

export function openEnvFollowUpPayload(
  crypto: Pick<CryptoService, 'decryptString'>,
  sealed: SealedEnv
): DockerEnvFollowUpPayload {
  const payload = JSON.parse(crypto.decryptString(sealed)) as DockerEnvFollowUpPayload;
  if (!payload || typeof payload !== 'object' || !payload.expectedEnv || typeof payload.expectedEnv !== 'object') {
    throw new Error('Invalid env follow-up payload');
  }
  return payload;
}

export interface DockerEnvFollowUpContext {
  environmentService?: {
    replace(nodeId: string, containerName: string, env: Record<string, string>): Promise<unknown>;
    getDecryptedMap(nodeId: string, containerName: string): Promise<Record<string, string>>;
    sealFollowUpPayload(payload: DockerEnvFollowUpPayload): SealedEnv;
    openFollowUpPayload(sealed: SealedEnv): DockerEnvFollowUpPayload;
  };
  taskService?: Pick<DockerTaskService, 'track' | 'takeFollowUps'>;
  inspectContainer(nodeId: string, containerId: string): Promise<any>;
  claimTransitions(
    nodeId: string,
    entries: ReadonlyArray<{ name: string; state: ContainerTransition }>
  ): ContainerTransitionClaim;
  acquireTransitionLeases(
    nodeId: string,
    names: readonly string[],
    options?: { takeOverToken?: string }
  ): Promise<void>;
  releaseTransitions(claim: ContainerTransitionClaim): void;
}

/**
 * After an image change the daemon drops env values inherited from the
 * previous image. Stored env entries that only mirrored such an inherited
 * value would otherwise pin the old image default on the next env edit, so
 * align them with the new runtime.
 */
export async function reconcileStoredEnvAfterImageChange(
  ctx: Pick<DockerEnvFollowUpContext, 'environmentService' | 'inspectContainer'>,
  nodeId: string,
  name: string,
  previousRuntimeEnv: Record<string, string>,
  newContainerId: string
): Promise<void> {
  if (!ctx.environmentService) return;
  const stored = await ctx.environmentService.getDecryptedMap(nodeId, name);
  if (Object.keys(stored).length === 0) return;
  const inspect = await ctx.inspectContainer(nodeId, newContainerId);
  const nextRuntimeEnv = envListToMap(Array.isArray(inspect?.Config?.Env) ? inspect.Config.Env : []);
  const next = { ...stored };
  let changed = false;
  for (const [key, value] of Object.entries(stored)) {
    if (previousRuntimeEnv[key] !== value || nextRuntimeEnv[key] === value) continue;
    changed = true;
    if (Object.hasOwn(nextRuntimeEnv, key) && nextRuntimeEnv[key] !== MASKED_ENV_VALUE)
      next[key] = nextRuntimeEnv[key]!;
    else delete next[key];
  }
  if (changed) await ctx.environmentService.replace(nodeId, name, next);
}

/** What an update or recreate owes once the node settled it, with the env it needs. */
export interface DockerEnvFollowUpPlan {
  /** The stored env the operation leaves (written right before dispatch, or the one it found). */
  expectedEnv: Record<string, string>;
  /** Set for an image change: the replaced runtime's env (stored entries mirroring it are reconciled). */
  previousRuntimeEnv?: Record<string, string>;
  /** Set when the update saves the env before it runs: put back should the update not apply. */
  restoreEnv?: Record<string, string>;
  /**
   * The lease the operation holds the container with. Once Opfield lost track of the task (it restarted), the
   * follow-ups take it over instead of waiting for it to lapse.
   */
  leaseToken?: string;
}

/** What tells the end of an update or recreate before it is dispatched: no daemon task is known yet. */
export interface DockerReplacementAhead {
  tracking: Extract<DockerTaskTracking, { kind: 'replace' }>;
  /** The command the update or recreate is sent under: the daemon finds its task by it. */
  commandId: string;
}

/** What the operation recorded ahead of its dispatch, and the gate its own watch passes before a follow-up. */
export interface DockerEnvFollowUpGate {
  /** The task's tracking was written ahead: a lost answer leaves the task to DockerTaskReconciler. */
  readonly tracked: boolean;
  /** Whether the watch may run its follow-ups now: they were not kept with the task, or the watch took them first. */
  take(): Promise<boolean>;
}

const untracked = (): DockerEnvFollowUpGate => ({ tracked: false, take: async () => true });

function sameEnv(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && right[key] === left[key])
  );
}

/** Neither the error message nor its cause: a failed query's message carries its parameters (sealed env). */
function errorSummary(error: unknown) {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return {
    error: error instanceof Error ? error.name : 'Error',
    ...(typeof cause?.code === 'string' ? { code: cause.code } : {}),
  };
}

/** The follow-ups record for `plan`, the env sealed; undefined when no follow-up would change anything. */
function followUpsRecord(
  environmentService: NonNullable<DockerEnvFollowUpContext['environmentService']>,
  name: string,
  plan: DockerEnvFollowUpPlan
): DockerTaskFollowUps | undefined {
  const previous = plan.previousRuntimeEnv;
  const mirroredKeys = previous
    ? Object.keys(plan.expectedEnv).filter(
        (key) => Object.hasOwn(previous, key) && previous[key] === plan.expectedEnv[key]
      )
    : [];
  const reconcile = mirroredKeys.length > 0;
  const restore = plan.restoreEnv !== undefined && !sameEnv(plan.restoreEnv, plan.expectedEnv);
  if (!reconcile && !restore) return undefined;
  return {
    containerName: name,
    ...(plan.leaseToken ? { leaseToken: plan.leaseToken } : {}),
    ...(reconcile ? { reconcileEnvAfterImageChange: true } : {}),
    ...(restore ? { restoreEnvAfterFailedUpdate: true } : {}),
    sealed: environmentService.sealFollowUpPayload({
      expectedEnv: plan.expectedEnv,
      ...(reconcile ? { mirroredKeys } : {}),
      ...(restore ? { restoreEnv: plan.restoreEnv } : {}),
    }),
  };
}

/**
 * Writes ahead, before an update or recreate is dispatched (and before an update saves the env): the task's tracking,
 * the command it is sent under, and what it owes once settled (its env follow-ups, the env sealed). However Opfield
 * then loses track of it, even before the daemon answered, DockerTaskReconciler settles it with the node and runs
 * what it owes through runKeptEnvFollowUps; a command that never ran there gets nothing run but the env put back.
 * Never fails the operation: what could not be written runs only from the watch, as before. Nothing is kept for a
 * follow-up that would change nothing.
 */
export async function trackReplacementAhead(
  ctx: Pick<DockerEnvFollowUpContext, 'environmentService' | 'taskService'>,
  taskId: string | undefined,
  name: string,
  ahead: DockerReplacementAhead,
  plan: DockerEnvFollowUpPlan
): Promise<DockerEnvFollowUpGate> {
  const { environmentService, taskService } = ctx;
  if (!taskId || !taskService) return untracked();
  let followUps: DockerTaskFollowUps | undefined;
  try {
    followUps = environmentService ? followUpsRecord(environmentService, name, plan) : undefined;
  } catch (error) {
    logger.warn('Env follow-ups not kept with their task; only its watch in this process runs them', {
      taskId,
      name,
      ...errorSummary(error),
    });
  }
  try {
    await taskService.track(taskId, ahead.tracking, ahead.commandId, followUps);
  } catch (error) {
    logger.warn('Replacement not tracked ahead of its dispatch; only its watch in this process settles it', {
      taskId,
      name,
      ...errorSummary(error),
    });
    return untracked();
  }
  if (!followUps) return { tracked: true, take: async () => true };
  return { tracked: true, take: async () => (await taskService.takeFollowUps(taskId)) !== null };
}

/**
 * How DockerTaskReconciler settled a replacement whose task keeps follow-ups: replaced; failed by the daemon; or not
 * applied, as the daemon has no task of its command and the replaced container still runs (the command never reached
 * the node, or its daemon restarted).
 */
export type DockerTaskFollowUpTrigger =
  | { kind: 'replaced'; newContainerId: string }
  | { kind: 'daemon-task-failed' }
  | { kind: 'not-applied' };

/**
 * Runs what an update or recreate Opfield lost track of still owes, once DockerTaskReconciler settled it with the
 * node: the stored env reconciliation after an image change once the replacement succeeded, or the stored env restore
 * once the update did not apply (the daemon reported it failed, or it never ran there). It is taken from the task
 * first, so it runs once. Like the
 * operation, it holds the container meanwhile: a container another operation holds right now throws 409
 * CONTAINER_BUSY, and the reconciler asks again at its next pass. It runs only while the stored env is still the one the
 * operation left; otherwise a later operation changed it, and the follow-up is dropped. A follow-up that fails once it
 * was taken is logged and not run again.
 */
export async function runKeptEnvFollowUps(
  ctx: DockerEnvFollowUpContext,
  task: Pick<DockerTaskRow, 'id' | 'nodeId' | 'followUps'>,
  trigger: DockerTaskFollowUpTrigger
): Promise<void> {
  const owed = task.followUps;
  const { environmentService, taskService } = ctx;
  if (!owed || !environmentService || !taskService) return;
  const followUp = trigger.kind === 'replaced' ? 'reconcileEnvAfterImageChange' : 'restoreEnvAfterFailedUpdate';
  // The other one cannot be due any more; settling the task drops it.
  if (owed[followUp] !== true) return;
  const nodeId = task.nodeId;
  const name = owed.containerName;
  const claim = ctx.claimTransitions(nodeId, [{ name, state: 'updating' }]);
  try {
    // The operation's own lease is taken over: its process is gone (the task was settled with the node), and waiting
    // for the lease to lapse held the settle up to a minute after the node was back (stand rc.7, O-11).
    await ctx.acquireTransitionLeases(nodeId, [name], { takeOverToken: owed.leaseToken });
    const taken = await taskService.takeFollowUps(task.id);
    if (!taken || taken[followUp] !== true) return;
    const details = { taskId: task.id, nodeId, name, followUp };
    try {
      const payload = environmentService.openFollowUpPayload(taken.sealed);
      const stored = await environmentService.getDecryptedMap(nodeId, name);
      if (!sameEnv(stored, payload.expectedEnv)) {
        logger.warn('Skipped an env follow-up: the stored env changed after the operation', details);
        return;
      }
      if (trigger.kind === 'replaced') {
        const mirrored = Object.fromEntries(
          (payload.mirroredKeys ?? [])
            .filter((key) => Object.hasOwn(payload.expectedEnv, key))
            .map((key) => [key, payload.expectedEnv[key]!])
        );
        await reconcileStoredEnvAfterImageChange(ctx, nodeId, name, mirrored, trigger.newContainerId);
      } else {
        if (!payload.restoreEnv) return;
        await environmentService.replace(nodeId, name, payload.restoreEnv);
      }
      logger.info('Ran the env follow-up of a task settled with its node', details);
    } catch (error) {
      logger.warn('The env follow-up of a task settled with its node failed', { ...details, ...errorSummary(error) });
    }
  } finally {
    ctx.releaseTransitions(claim);
  }
}
