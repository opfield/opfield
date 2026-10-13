import { AppError } from '@/middleware/error-handler.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { getReplacementContainerFailureMessage, replacementReached } from './docker-recreate-watch.js';
import { type DockerTaskService, detachDockerTask, trackDockerTask } from './docker-task.service.js';

const LEGACY_TASK_STATUS_UNSUPPORTED_ERROR = 'unknown container action: task_status';
/** The daemon has no task of the ID: it restarted since (a daemon keeps finished tasks for an hour). */
const DAEMON_TASK_NOT_FOUND_ERROR = 'docker task not found';
const NODE_DISCONNECTED_RE = /node (?:.* )?(?:is not connected|disconnected)/i;
const DISCONNECTED_ERROR = 'Docker node disconnected during container operation';

function isNodeDisconnectedError(error: unknown): boolean {
  return NODE_DISCONNECTED_RE.test(error instanceof Error ? error.message : String(error));
}

export type ContainerAction =
  | 'created'
  | 'started'
  | 'stopped'
  | 'restarted'
  | 'killed'
  | 'removed'
  | 'renamed'
  | 'updated'
  | 'recreated'
  | 'duplicated';

export interface DockerLifecycleWatchContext {
  nodeDispatch: NodeDispatchService;
  taskService?: DockerTaskService;
  eventBus?: EventBusService;
  parseResult: (result: { success: boolean; error?: string; detail?: string }) => unknown;
  clearTransition: (nodeId: string, name: string) => void;
  emitContainer: (
    nodeId: string,
    name: string,
    id: string,
    action: ContainerAction,
    extra?: Record<string, unknown>
  ) => void;
  preserveContainerIdentity?: (nodeId: string, name: string, runtimeId: string) => Promise<unknown>;
  failTask: (taskId: string | undefined, error: string, nodeId?: string, containerName?: string) => Promise<void>;
}

/** How a watched lifecycle operation ended; its task records the same outcome. */
export type DockerTransitionOutcome = { completed: true } | { completed: false; reason: 'timeout' | 'disconnected' };

/** What a watch knows beyond its arguments that settles its task with the node should Opfield lose track of it. */
export interface DockerTransitionTrackingHint {
  /** The container's State.StartedAt before a restart: the restart is done once it changed. */
  previousStartedAt?: string | null;
}

/**
 * The node disconnected while a watched operation ran: the node may still run it. A task with tracking stays active
 * and is settled with the node once it is connected again (DockerTaskReconciler); one without fails as before. The
 * container's transition ends either way.
 */
async function detachWatchedTask(
  context: DockerLifecycleWatchContext,
  tracked: Promise<boolean>,
  taskId: string | undefined,
  nodeId: string,
  name: string
) {
  const kept = (await tracked) ? await detachDockerTask(context.taskService, taskId, DISCONNECTED_ERROR) : false;
  await context.failTask(kept ? undefined : taskId, DISCONNECTED_ERROR, nodeId, name);
}

/**
 * Polls the container until the operation reached its state, then completes its task and ends its transition.
 * The returned promise settles once the task did; it never rejects. A container that no longer exists has no
 * process left: an operation that waits for `exited` (stop, kill) is then complete.
 */
export function watchDockerTransition(
  context: DockerLifecycleWatchContext,
  nodeId: string,
  containerId: string,
  name: string,
  taskId: string | undefined,
  expectedState: string,
  progress: string,
  completedAction: ContainerAction,
  timeoutMs = 60000,
  isComplete?: (inspectData: Record<string, any>) => boolean,
  trackingHint?: DockerTransitionTrackingHint
): Promise<DockerTransitionOutcome> {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    // A stop, kill or restart goes on on the node without this watch: its task records how to tell its end.
    const expect = expectedState === 'exited' ? 'exited' : completedAction === 'restarted' ? 'restarted' : null;
    const tracked: Promise<boolean> = expect
      ? trackDockerTask(context.taskService, taskId, {
          kind: 'state',
          containerId,
          expect,
          previousStartedAt: trackingHint?.previousStartedAt ?? null,
          progress,
          deadlineAt: new Date(start + timeoutMs).toISOString(),
        })
      : Promise.resolve(false);
    const complete = async () => {
      settled = true;
      clearInterval(poll);
      context.clearTransition(nodeId, name);
      if (taskId && context.taskService) {
        await context.taskService
          .update(taskId, { status: 'succeeded', progress, completedAt: new Date() })
          .catch(() => {});
      }
      context.emitContainer(nodeId, name, containerId, completedAction);
      resolve({ completed: true });
    };
    const fail = async (reason: 'timeout' | 'disconnected') => {
      settled = true;
      clearInterval(poll);
      if (reason === 'disconnected') await detachWatchedTask(context, tracked, taskId, nodeId, name);
      else await context.failTask(taskId, 'Timed out', nodeId, name);
      resolve({ completed: false, reason });
    };
    const poll = setInterval(async () => {
      try {
        const result = await context.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
        if (settled) return;
        const data = context.parseResult(result) as Record<string, any>;
        const state = data?.State?.Status;
        const completed = isComplete ? isComplete(data) : state === expectedState;
        if (completed) {
          await complete();
          return;
        }
        if (Date.now() - start > timeoutMs) await fail('timeout');
      } catch (error) {
        if (settled) return;
        if (isNodeDisconnectedError(error)) {
          await fail('disconnected');
          return;
        }
        if (expectedState === 'exited' && error instanceof AppError && error.code === 'CONTAINER_NOT_FOUND') {
          await complete();
          return;
        }
        if (Date.now() - start > timeoutMs) await fail('timeout');
      }
    }, 2000);
  });
}

export function watchDockerRecreateByName(
  context: DockerLifecycleWatchContext,
  nodeId: string,
  containerName: string,
  oldContainerId: string,
  taskId: string | undefined,
  progress: string,
  expectedState: string,
  timeoutMs = 60000,
  onComplete?: (newContainerId: string) => Promise<void>,
  daemonTaskId?: string,
  // Runs when the async daemon task did not apply the change, before the task is failed and the container transition
  // is released: the daemon task reports it failed, or the watch timed out (beyond the daemon task's own limit) with
  // the replaced container still running.
  onDaemonTaskFailed?: () => Promise<void>
) {
  const start = Date.now();
  // The ID of the container the name last showed: the replaced one at the timeout means the change did not apply.
  let lastSeenId: string | undefined;
  const timeOut = async () => {
    if (daemonTaskId && lastSeenId === oldContainerId) await onDaemonTaskFailed?.().catch(() => undefined);
    await context.failTask(taskId, 'Timed out', nodeId, containerName);
  };
  // The replacement goes on on the node without this watch: its task records how to tell its end.
  const tracked = trackDockerTask(context.taskService, taskId, {
    kind: 'replace',
    containerName,
    oldContainerId,
    expectedState,
    daemonTaskId: daemonTaskId ?? null,
    progress,
    deadlineAt: new Date(start + timeoutMs).toISOString(),
  });
  const poll = setInterval(async () => {
    try {
      const result = await context.nodeDispatch.sendDockerContainerCommand(nodeId, 'list');
      const containers = context.parseResult(result);
      if (!Array.isArray(containers)) throw new Error('Docker container list returned an invalid response');
      const match = containers.find((c: any) => {
        const cName = (c.name ?? c.Name ?? '').replace(/^\//, '');
        return cName === containerName;
      });
      lastSeenId = match ? String(match.id ?? match.Id ?? '') : undefined;

      let daemonTaskStatus: string | undefined;
      if (daemonTaskId) {
        const daemonTaskResult = await context.nodeDispatch.sendDockerContainerCommand(nodeId, 'task_status', {
          containerId: daemonTaskId,
        });
        const daemonTaskError = daemonTaskResult.success ? '' : (daemonTaskResult.error?.trim() ?? '');
        if (daemonTaskError === LEGACY_TASK_STATUS_UNSUPPORTED_ERROR) {
          daemonTaskStatus = 'unsupported';
        } else if (daemonTaskError === DAEMON_TASK_NOT_FOUND_ERROR) {
          // The daemon restarted and no longer runs the task: the containers tell how it ended. Asking again only
          // repeated this answer until the watch timed out, with the container held meanwhile.
          daemonTaskStatus = 'unknown';
        } else {
          const daemonTask = context.parseResult(daemonTaskResult) as Record<string, any>;
          daemonTaskStatus = String(daemonTask.status ?? '');
          if (daemonTaskStatus === 'failed') {
            clearInterval(poll);
            await onDaemonTaskFailed?.().catch(() => undefined);
            await context.failTask(
              taskId,
              String(daemonTask.error || 'Docker daemon task failed'),
              nodeId,
              containerName
            );
            return;
          }
        }
      }

      const canEvaluateReplacement =
        !daemonTaskId ||
        daemonTaskStatus === 'running' ||
        daemonTaskStatus === 'succeeded' ||
        daemonTaskStatus === 'unsupported' ||
        daemonTaskStatus === 'unknown';
      // The daemon is done with the replacement: its state no longer changes by this operation.
      const settled = daemonTaskStatus === 'succeeded' || daemonTaskStatus === 'unknown';
      if (match && canEvaluateReplacement) {
        const newId = match.id ?? match.Id;
        const state = match.state ?? match.State ?? '';

        // A replacement that started and now restarts under its restart policy
        // was recreated as asked; waiting for it to stay up would hold the
        // container until the timeout.
        const reached = replacementReached(state, expectedState, settled);
        if (newId !== oldContainerId && reached) {
          clearInterval(poll);
          try {
            await context.preserveContainerIdentity?.(nodeId, containerName, newId);
            await onComplete?.(newId);
          } catch (error) {
            context.clearTransition(nodeId, containerName);
            await context.failTask(
              taskId,
              error instanceof Error ? error.message : 'Failed to finalize recreated container',
              nodeId,
              containerName
            );
            return;
          }
          context.clearTransition(nodeId, containerName);
          if (taskId && context.taskService) {
            await context.taskService
              .update(taskId, { status: 'succeeded', progress, completedAt: new Date() })
              .catch(() => {});
          }
          context.emitContainer(nodeId, containerName, newId, 'recreated', { oldId: oldContainerId });
          return;
        }

        const replacementFailure = getReplacementContainerFailureMessage(match, oldContainerId, expectedState, settled);
        if (replacementFailure) {
          clearInterval(poll);
          await context.failTask(taskId, replacementFailure, nodeId, containerName);
          return;
        }
      }

      // A daemon that restarted left the replaced container in place (the change did not apply) or no container of
      // the name at all: either way nothing more happens on the node, so the container is released now.
      if (daemonTaskStatus === 'unknown' && (!match || lastSeenId === oldContainerId)) {
        clearInterval(poll);
        if (lastSeenId === oldContainerId) await onDaemonTaskFailed?.().catch(() => undefined);
        await context.failTask(
          taskId,
          'The Docker daemon restarted before the container was replaced',
          nodeId,
          containerName
        );
        return;
      }

      if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        await timeOut();
      }
    } catch (error) {
      if (isNodeDisconnectedError(error)) {
        clearInterval(poll);
        await detachWatchedTask(context, tracked, taskId, nodeId, containerName);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        await timeOut();
      }
    }
  }, 2000);
}
