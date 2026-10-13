import type { DockerTaskTracking } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { type DockerTaskFollowUpTrigger, TASK_COMMAND_LOOKUP_CAPABILITY } from './docker-env-follow-ups.js';
import { resolvePulledDockerImage } from './docker-internal-images.js';
import type { ContainerAction, DockerLifecycleWatchContext } from './docker-lifecycle-watch.js';
import { getReplacementContainerFailureMessage, replacementReached } from './docker-recreate-watch.js';
import type { DockerTaskRow, DockerTaskService } from './docker-task.service.js';

const logger = createChildLogger('DockerTaskReconciler');

/** One question to a daemon; a node that does not answer in time is asked again at the next pass. */
const QUERY_TIMEOUT_MS = 15_000;
const LEGACY_PULL_STATUS_ERROR = 'unknown image action: pull_status';
const LEGACY_TASK_STATUS_ERROR = 'unknown container action: task_status';
const DAEMON_TASK_NOT_FOUND_ERROR = 'docker task not found';
const STOPPABLE_CONTAINER_STATES = new Set(['running', 'restarting', 'paused', 'removing']);

/**
 * The error of a command whose node may still run it: the node's control stream dropped while the command was in
 * flight (`Node disconnected`, also when Opfield shuts down), or its answer did not come in time. A command that was
 * never sent (`Node <id> is not connected`) fails with another error.
 */
export function isLostTrackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === 'Node disconnected' || /^Command \S+ timed out after \d+ms$/.test(message);
}

export interface DockerTaskReconcileContext extends DockerLifecycleWatchContext {
  taskService: DockerTaskService;
  /** What a live pull does once it succeeded: places the image for its user, remembers its registry, tells the UI. */
  finishPull(nodeId: string, tracking: Extract<DockerTaskTracking, { kind: 'pull' }>): Promise<void>;
  /**
   * Runs what an update or recreate keeps for once it is settled (its env follow-ups, see runKeptEnvFollowUps), before
   * its task is settled. Throws when it cannot run yet (the container is held by another operation): the task is then
   * settled at a later pass.
   */
  runFollowUps?(task: DockerTaskRow, trigger: DockerTaskFollowUpTrigger): Promise<void>;
  /** Whether the connected node's daemon advertised `capability`. */
  nodeHasCapability?(nodeId: string, capability: string): boolean;
}

type Outcome =
  | { status: 'succeeded'; progress: string; after?: () => void | Promise<void> }
  | { status: 'failed'; error: string }
  | { status: 'running'; progress: string };

/**
 * Settles the Docker tasks Opfield lost track of with their nodes (F-1). Opfield restarted, or a node's control
 * stream dropped, while an image pull or a container stop, restart, kill, update or recreate ran on the node: the
 * work goes on there, so the task stays active (and a daemon update waiting for the node's tasks keeps waiting) until
 * the connected node tells how it ended. An update or recreate also gets the env follow-ups its watch would have run.
 * Runs at every node connect and every few seconds while detached tasks are left; the deadline of the task's own watch
 * bounds what cannot be told.
 */
export class DockerTaskReconciler {
  private readonly inFlight = new Set<string>();
  private sweeping: Promise<void> | null = null;

  constructor(
    private readonly context: () => DockerTaskReconcileContext | null,
    private readonly isNodeConnected: (nodeId: string) => boolean,
    private readonly now: () => number = Date.now
  ) {}

  /** Settles what the connected nodes can tell now; one pass at a time. */
  sweep(nodeId?: string): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.runSweep(nodeId).finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private async runSweep(nodeId?: string): Promise<void> {
    const ctx = this.context();
    if (!ctx) return;
    const tasks = await ctx.taskService.listDetached(nodeId);
    for (const task of tasks) {
      if (!this.isNodeConnected(task.nodeId) || this.inFlight.has(task.id)) continue;
      this.inFlight.add(task.id);
      try {
        await this.reconcile(ctx, task);
      } catch (error) {
        logger.debug('Docker task not settled yet', {
          taskId: task.id,
          nodeId: task.nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.inFlight.delete(task.id);
      }
    }
  }

  private async reconcile(ctx: DockerTaskReconcileContext, task: DockerTaskRow): Promise<void> {
    const tracking = task.tracking;
    if (!tracking) {
      await ctx.taskService.settle(task.id, { status: 'failed', error: 'Opfield lost track of the task' });
      return;
    }
    let outcome: Outcome;
    switch (tracking.kind) {
      case 'pull':
        outcome = await this.pullOutcome(ctx, task, tracking);
        break;
      case 'state':
        outcome = await this.stateOutcome(ctx, task, tracking);
        break;
      case 'replace':
        outcome = await this.replaceOutcome(ctx, task, tracking);
        break;
      case 'remove':
        outcome = await this.removeOutcome(ctx, task, tracking);
        break;
    }
    if (outcome.status === 'running') {
      await ctx.taskService.noteDetached(task.id, outcome.progress);
      return;
    }
    if (outcome.status === 'failed') {
      if (await ctx.taskService.settle(task.id, outcome)) {
        logger.info('Docker task settled with its node', { taskId: task.id, nodeId: task.nodeId, status: 'failed' });
      }
      return;
    }
    if (await ctx.taskService.settle(task.id, { status: 'succeeded', progress: outcome.progress })) {
      logger.info('Docker task settled with its node', { taskId: task.id, nodeId: task.nodeId, status: 'succeeded' });
      await outcome.after?.();
    }
  }

  private pastDeadline(deadlineAt: string): boolean {
    const deadline = Date.parse(deadlineAt);
    return Number.isFinite(deadline) && this.now() > deadline;
  }

  /**
   * The daemon tells how the pull of the task's command ended (pull_status). A daemon that has no record of it (it
   * restarted, so the pull was cut) or predates pull_status is judged by the image: present means pulled. Only an
   * older daemon leaves a missing image open until the pull's deadline, since its pull may still run.
   */
  private async pullOutcome(
    ctx: DockerTaskReconcileContext,
    task: DockerTaskRow,
    tracking: Extract<DockerTaskTracking, { kind: 'pull' }>
  ): Promise<Outcome> {
    const succeeded: Outcome = {
      status: 'succeeded',
      progress: `Pulled ${tracking.imageRef}`,
      after: () =>
        ctx.finishPull(task.nodeId, tracking).catch((error) => {
          logger.warn('Pulled image not placed after its task was settled', {
            taskId: task.id,
            nodeId: task.nodeId,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    };
    let reported: 'unknown' | 'unsupported' = 'unknown';
    const status = await ctx.nodeDispatch.sendDockerImageCommand(
      task.nodeId,
      'pull_status',
      { imageRef: tracking.imageRef },
      QUERY_TIMEOUT_MS
    );
    if (!status.success) {
      if (status.error?.trim() !== LEGACY_PULL_STATUS_ERROR) {
        throw new Error(status.error || 'pull_status failed');
      }
      reported = 'unsupported';
    } else {
      const pulls = parsePulls(status.detail);
      const pull = task.commandId ? pulls.find((entry) => entry.commandId === task.commandId) : undefined;
      if (pull?.state === 'running') return { status: 'running', progress: `Pulling ${tracking.imageRef} on the node` };
      if (pull?.state === 'succeeded') return succeeded;
      if (pull?.state === 'failed') return { status: 'failed', error: pull.error || 'Pull failed' };
    }
    const images = ctx.parseResult(
      await ctx.nodeDispatch.sendDockerImageCommand(task.nodeId, 'list', {}, QUERY_TIMEOUT_MS)
    );
    if (Array.isArray(images) && resolvePulledDockerImage(images, tracking.imageRef)) return succeeded;
    if (reported === 'unknown') {
      return {
        status: 'failed',
        error: 'The pull did not finish on the node: its daemon restarted or never received it',
      };
    }
    return this.pastDeadline(tracking.deadlineAt)
      ? { status: 'failed', error: 'Timed out' }
      : { status: 'running', progress: `Pulling ${tracking.imageRef} on the node` };
  }

  /** A stop or kill is done once the container has no process (or is gone), a restart once it started again. */
  private async stateOutcome(
    ctx: DockerTaskReconcileContext,
    task: DockerTaskRow,
    tracking: Extract<DockerTaskTracking, { kind: 'state' }>
  ): Promise<Outcome> {
    const name = task.containerName ?? tracking.containerId;
    const action: ContainerAction =
      tracking.expect === 'restarted' ? 'restarted' : task.type === 'kill' ? 'killed' : 'stopped';
    let data: Record<string, any> | null;
    try {
      data = ctx.parseResult(
        await ctx.nodeDispatch.sendDockerContainerCommand(
          task.nodeId,
          'inspect',
          { containerId: tracking.containerId },
          QUERY_TIMEOUT_MS
        )
      ) as Record<string, any> | null;
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'CONTAINER_NOT_FOUND')) throw error;
      if (tracking.expect === 'exited') {
        return { status: 'succeeded', progress: tracking.progress, after: () => this.emit(ctx, task, name, action) };
      }
      return { status: 'failed', error: 'The container no longer exists' };
    }
    const state = data?.State;
    const done =
      tracking.expect === 'exited'
        ? typeof state?.Status === 'string' && !STOPPABLE_CONTAINER_STATES.has(state.Status)
        : tracking.previousStartedAt
          ? typeof state?.StartedAt === 'string' && state.StartedAt !== tracking.previousStartedAt
          : state?.Status === 'running';
    if (done) {
      return { status: 'succeeded', progress: tracking.progress, after: () => this.emit(ctx, task, name, action) };
    }
    return this.pastDeadline(tracking.deadlineAt)
      ? { status: 'failed', error: 'Timed out' }
      : { status: 'running', progress: 'Still running on the node' };
  }

  /**
   * An update or recreate is done once a container of its name with another ID reached the expected state. Its daemon
   * task is asked for by its ID, or, when Opfield lost the answer that named it, by the command it was sent under. A
   * daemon that has no task of it (one that finds tasks by command, or knew its ID) no longer runs it: the command never
   * reached it, or the daemon restarted. With the replaced container still in place the change then did not apply.
   */
  private async replaceOutcome(
    ctx: DockerTaskReconcileContext,
    task: DockerTaskRow,
    tracking: Extract<DockerTaskTracking, { kind: 'replace' }>
  ): Promise<Outcome> {
    let daemonTaskRunning = false;
    // The daemon is done with the replacement (its task succeeded, or it restarted and no longer runs it).
    let daemonTaskSettled = false;
    let notOnNode = false;
    const lookupId = tracking.daemonTaskId || task.commandId;
    if (lookupId) {
      const result = await ctx.nodeDispatch.sendDockerContainerCommand(
        task.nodeId,
        'task_status',
        { containerId: lookupId },
        QUERY_TIMEOUT_MS
      );
      if (result.success) {
        const daemonTask = ctx.parseResult(result) as Record<string, any> | null;
        const daemonStatus = String(daemonTask?.status ?? '');
        if (daemonStatus === 'failed') {
          // The update did not apply: what it saved beforehand is put back first, as its watch does.
          await this.runFollowUps(ctx, task, { kind: 'daemon-task-failed' });
          return { status: 'failed', error: String(daemonTask?.error || 'Docker daemon task failed') };
        }
        daemonTaskRunning = daemonStatus === 'running' || daemonStatus === 'pending';
        daemonTaskSettled = daemonStatus === 'succeeded';
      } else {
        // A daemon that restarted no longer knows the task, an older one cannot tell: the containers tell then.
        // Any other answer (a busy daemon) is asked again at the next pass.
        const error = result.error?.trim() ?? '';
        if (error !== LEGACY_TASK_STATUS_ERROR && error !== DAEMON_TASK_NOT_FOUND_ERROR) {
          throw new Error(error || 'task_status failed');
        }
        daemonTaskSettled = error === DAEMON_TASK_NOT_FOUND_ERROR;
        notOnNode =
          error === DAEMON_TASK_NOT_FOUND_ERROR &&
          (!!tracking.daemonTaskId || !!ctx.nodeHasCapability?.(task.nodeId, TASK_COMMAND_LOOKUP_CAPABILITY));
      }
    }
    const containers = ctx.parseResult(
      await ctx.nodeDispatch.sendDockerContainerCommand(task.nodeId, 'list', {}, QUERY_TIMEOUT_MS)
    );
    if (!Array.isArray(containers)) throw new Error('Docker container list returned an invalid response');
    const match = containers.find(
      (container: any) => String(container.name ?? container.Name ?? '').replace(/^\//, '') === tracking.containerName
    );
    if (match && !daemonTaskRunning) {
      const newId = String(match.id ?? match.Id ?? '');
      const state = String(match.state ?? match.State ?? '');
      const reached = replacementReached(state, tracking.expectedState, daemonTaskSettled);
      if (newId && newId !== tracking.oldContainerId && reached) {
        await ctx.preserveContainerIdentity?.(task.nodeId, tracking.containerName, newId);
        await this.runFollowUps(ctx, task, { kind: 'replaced', newContainerId: newId });
        return {
          status: 'succeeded',
          progress: tracking.progress,
          after: () =>
            ctx.emitContainer(task.nodeId, tracking.containerName, newId, 'recreated', {
              oldId: tracking.oldContainerId,
            }),
        };
      }
      const failure = getReplacementContainerFailureMessage(
        match,
        tracking.oldContainerId,
        tracking.expectedState,
        daemonTaskSettled
      );
      if (failure) return { status: 'failed', error: failure };
      if (notOnNode && String(match.id ?? match.Id ?? '') === tracking.oldContainerId) {
        // What the operation saved beforehand is put back, as when its dispatch fails.
        await this.runFollowUps(ctx, task, { kind: 'not-applied' });
        return {
          status: 'failed',
          error: `The ${task.type === 'recreate' ? 'recreate' : 'update'} did not run on the node: its daemon restarted or never received it`,
        };
      }
    }
    if (daemonTaskRunning) return { status: 'running', progress: 'Replacing the container on the node' };
    if (!this.pastDeadline(tracking.deadlineAt)) {
      return { status: 'running', progress: 'Replacing the container on the node' };
    }
    // Past the deadline, which outlasts an asynchronous daemon task's own limit, the replaced container still running
    // means the change did not apply.
    const asynchronous = !!tracking.daemonTaskId || tracking.beforeAnswer === true;
    if (asynchronous && match && String(match.id ?? match.Id ?? '') === tracking.oldContainerId) {
      await this.runFollowUps(ctx, task, { kind: 'not-applied' });
    }
    return { status: 'failed', error: 'Timed out' };
  }

  /** Opfield runs this removal itself after a stop; without Opfield it did not run. */
  private async removeOutcome(
    ctx: DockerTaskReconcileContext,
    task: DockerTaskRow,
    tracking: Extract<DockerTaskTracking, { kind: 'remove' }>
  ): Promise<Outcome> {
    try {
      ctx.parseResult(
        await ctx.nodeDispatch.sendDockerContainerCommand(
          task.nodeId,
          'inspect',
          { containerId: tracking.containerId },
          QUERY_TIMEOUT_MS
        )
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'CONTAINER_NOT_FOUND') {
        return { status: 'succeeded', progress: 'Container removed' };
      }
      throw error;
    }
    return { status: 'failed', error: 'Opfield restarted before it removed the container; remove it again' };
  }

  private async runFollowUps(
    ctx: DockerTaskReconcileContext,
    task: DockerTaskRow,
    trigger: DockerTaskFollowUpTrigger
  ): Promise<void> {
    if (task.followUps && ctx.runFollowUps) await ctx.runFollowUps(task, trigger);
  }

  private emit(ctx: DockerTaskReconcileContext, task: DockerTaskRow, name: string, action: ContainerAction) {
    ctx.emitContainer(task.nodeId, name, task.containerId ?? '', action);
  }
}

function parsePulls(detail: string | undefined): Array<{ commandId: string; state: string; error?: string }> {
  if (!detail) return [];
  try {
    const parsed = JSON.parse(detail) as { pulls?: unknown };
    return Array.isArray(parsed.pulls)
      ? parsed.pulls.filter(
          (entry): entry is { commandId: string; state: string; error?: string } =>
            !!entry && typeof entry === 'object' && typeof (entry as { commandId?: unknown }).commandId === 'string'
        )
      : [];
  } catch {
    return [];
  }
}
