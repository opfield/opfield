import { AppError } from '@/middleware/error-handler.js';
import type { DockerContainerMutationContext } from './docker-container-mutation-operations.js';
import type { DockerTransitionOutcome } from './docker-lifecycle-watch.js';
import { validateDockerRuntimeResourceConfig } from './docker-runtime-operations.js';

/** States with a process for a stop to end. Docker leaves a created, exited or dead container as it is. */
const STOPPABLE_CONTAINER_STATES = new Set(['running', 'restarting', 'paused']);

type StoppingTransition = 'stopping' | 'killing';

/** Transitions that end with the container stopped: a stop or a removal waits for them instead of refusing. */
const STOPPING_TRANSITIONS: readonly StoppingTransition[] = ['stopping', 'killing'];

/** The transition of a lifecycle operation a request answered before it ended. */
export type PendingTransition = StoppingTransition | 'restarting';

/** An inspect that shows no process left: the stop or kill is done. */
function hasNoProcess(data: Record<string, any>): boolean {
  const status = data?.State?.Status;
  return typeof status === 'string' && !STOPPABLE_CONTAINER_STATES.has(status);
}

/** SIGKILL always ends the process; any other signal may leave it running. */
function signalEndsProcess(signal: string): boolean {
  return /^(?:(?:SIG)?KILL|9)$/i.test(signal.trim());
}

/**
 * How long a lifecycle request waits for its result before it answers that the operation still runs: well below the
 * 60 s read timeout of a reverse proxy in front of Opfield, so a slow stop never ends in a proxy timeout.
 */
export const LIFECYCLE_ANSWER_WAIT_MS = 45_000;

/**
 * What a lifecycle request answers. `pending` is set when the operation still ran when the request stopped waiting:
 * the container's transition, with `taskId` the task to follow.
 */
export interface ContainerOperationAnswer {
  taskId: string | undefined;
  containerId: string;
  name: string;
  pending?: PendingTransition;
  /** A kill found no process to signal: the container was not running. */
  notRunning?: true;
}

/** The body of a 202 answer: the task that still runs and the container's transition. */
export function pendingOperationBody(answer: ContainerOperationAnswer & { pending: PendingTransition }) {
  return {
    taskId: answer.taskId ?? null,
    containerId: answer.containerId,
    name: answer.name,
    transition: answer.pending,
  };
}

/**
 * Waits for a stop or kill of `name` that runs in this process to end, as a second `docker stop` waits for the
 * first, for at most `timeoutMs`. Resolves with the stop transition still running then, undefined once none runs;
 * the caller checks the transition again.
 */
export async function waitForStopInFlight(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  name: string,
  timeoutMs = LIFECYCLE_ANSWER_WAIT_MS
): Promise<StoppingTransition | undefined> {
  return (await ctx.waitWhileTransition(nodeId, name, STOPPING_TRANSITIONS, timeoutMs)) as
    | StoppingTransition
    | undefined;
}

/** The watch's outcome, or undefined when it has not settled within the request's wait. */
async function settleWithinAnswerWait(watch: Promise<DockerTransitionOutcome>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), LIFECYCLE_ANSWER_WAIT_MS);
  });
  try {
    return await Promise.race([watch, waited]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Answers once the watched operation completed. One still running after the request's wait is answered as pending
 * (its task goes on); one that failed is an error that names its task, which records the same outcome.
 */
async function answerWhenDone(
  watch: Promise<DockerTransitionOutcome>,
  answer: ContainerOperationAnswer,
  transition: PendingTransition,
  done: string
): Promise<ContainerOperationAnswer> {
  const outcome = await settleWithinAnswerWait(watch);
  if (!outcome) return { ...answer, pending: transition };
  if (outcome.completed) return answer;
  const details = answer.taskId ? { taskId: answer.taskId } : undefined;
  if (outcome.reason === 'disconnected') {
    throw new AppError(502, 'NODE_OFFLINE', `The Docker node disconnected before the container ${done}`, details);
  }
  throw new AppError(504, 'CONTAINER_OPERATION_TIMEOUT', `The container has not ${done} in time`, details);
}

/** The task of the stop or kill of `name` that still runs on the node, if any. */
async function runningStopTaskId(ctx: DockerContainerMutationContext, nodeId: string, name: string) {
  const tasks = await ctx.taskService?.list({ nodeId, status: 'running' }).catch(() => []);
  return tasks?.find((task) => task.containerName === name && ['stop', 'kill'].includes(task.type))?.id;
}

export async function startContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  userId: string
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  ctx.requireNoTransition(nodeId, name);
  if (ctx.runtimeSettingsService) {
    const persistedRuntime = await ctx.runtimeSettingsService.get(nodeId, name);
    if (persistedRuntime) {
      await validateDockerRuntimeResourceConfig(
        ctx.runtimeOperationContext(),
        nodeId,
        containerId,
        persistedRuntime as Record<string, unknown>
      );
      const updateResult = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'live_update', {
        containerId,
        configJson: JSON.stringify(persistedRuntime),
      });
      ctx.parseResult(updateResult);
    }
  }
  const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'start', { containerId });
  ctx.parseResult(result);
  await ctx.auditService.log({
    action: 'docker.container.start',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });
  ctx.emitContainer(nodeId, name, containerId, 'started');
  return { taskId: undefined, containerId, name };
}

/** False only when an inspect shows no process to stop; an inspect failure leaves the decision to the stop. */
async function containerHasProcessToStop(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string
): Promise<boolean> {
  try {
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
    const status = ctx.parseResult(result)?.State?.Status;
    return typeof status !== 'string' || STOPPABLE_CONTAINER_STATES.has(status);
  } catch {
    return true;
  }
}

/**
 * Answers once the container has stopped, as `docker stop` does: a read or a removal right after the answer sees
 * it stopped. A stop already running here is waited for; this stop then finds the container stopped. A stop that
 * outlasts the request's wait is answered as pending with its task.
 */
export async function stopContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  timeout: number | undefined,
  userId: string
): Promise<ContainerOperationAnswer> {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  const stopping = await waitForStopInFlight(ctx, nodeId, name);
  if (stopping) {
    return { taskId: await runningStopTaskId(ctx, nodeId, name), containerId, name, pending: stopping };
  }
  const stopTimeout = await ctx.resolveContainerStopTimeout(nodeId, containerId, timeout);
  ctx.requireNoTransition(nodeId, name);
  if (!(await containerHasProcessToStop(ctx, nodeId, containerId))) {
    // A container that never started (created) or already exited is stopped: the stop completes now instead of
    // holding "stopping" until a watch for an `exited` state that never comes times out.
    const task = await ctx.createTask(nodeId, containerId, name, 'stop');
    if (task && ctx.taskService) {
      await ctx.taskService
        .update(task.id, { status: 'succeeded', progress: 'Container stopped', completedAt: new Date() })
        .catch(() => undefined);
    }
    await ctx.auditService.log({
      action: 'docker.container.stop',
      userId,
      resourceType: 'docker-container',
      resourceId: containerId,
      details: { nodeId, name, containerName: name },
    });
    ctx.emitContainer(nodeId, name, containerId, 'stopped');
    return { taskId: task?.id, containerId, name };
  }
  ctx.setTransition(nodeId, name, 'stopping');
  ctx.emitTransition(nodeId, name, containerId, 'stopping');
  const task = await ctx.createTask(nodeId, containerId, name, 'stop');
  try {
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'stop', {
      containerId,
      timeoutSeconds: stopTimeout,
      configJson: JSON.stringify({ timeoutProvided: true }),
    });
    ctx.parseResult(result);
  } catch (err) {
    await ctx.failTask(task?.id, err instanceof Error ? err.message : 'Failed to stop container', nodeId, name);
    throw err;
  }
  // The daemon stops the container in the background: the watch sees it end.
  const stopped = ctx.watchTransition(
    nodeId,
    containerId,
    name,
    task?.id,
    'exited',
    'Container stopped',
    'stopped',
    ctx.lifecycleWatchTimeoutMs(stopTimeout),
    hasNoProcess
  );
  await ctx.auditService.log({
    action: 'docker.container.stop',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });
  return answerWhenDone(stopped, { taskId: task?.id, containerId, name }, 'stopping', 'stopped');
}

/** Answers once Docker has started the container again, or as pending with its task after the request's wait. */
export async function restartContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  timeout: number | undefined,
  userId: string
): Promise<ContainerOperationAnswer> {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  const stopTimeout = await ctx.resolveContainerStopTimeout(nodeId, containerId, timeout);
  let previousStartedAt: string | undefined;
  try {
    const inspectResult = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
    previousStartedAt = ctx.parseResult(inspectResult)?.State?.StartedAt;
  } catch {
    previousStartedAt = undefined;
  }
  ctx.requireNoTransition(nodeId, name);
  ctx.setTransition(nodeId, name, 'restarting');
  ctx.emitTransition(nodeId, name, containerId, 'restarting');
  const task = await ctx.createTask(nodeId, containerId, name, 'restart');
  try {
    if (ctx.runtimeSettingsService) {
      const persistedRuntime = await ctx.runtimeSettingsService.get(nodeId, name);
      if (persistedRuntime) {
        await validateDockerRuntimeResourceConfig(
          ctx.runtimeOperationContext(),
          nodeId,
          containerId,
          persistedRuntime as Record<string, unknown>
        );
        const updateResult = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'live_update', {
          containerId,
          configJson: JSON.stringify(persistedRuntime),
        });
        ctx.parseResult(updateResult);
      }
    }
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'restart', {
      containerId,
      timeoutSeconds: stopTimeout,
      configJson: JSON.stringify({ timeoutProvided: true }),
    });
    ctx.parseResult(result);
  } catch (err) {
    await ctx.failTask(task?.id, err instanceof Error ? err.message : 'Failed to restart container', nodeId, name);
    throw err;
  }
  const restarted = ctx.watchTransition(
    nodeId,
    containerId,
    name,
    task?.id,
    'running',
    'Container restarted',
    'restarted',
    ctx.lifecycleWatchTimeoutMs(stopTimeout, 60),
    (data) => {
      const state = data?.State;
      // Docker sets StartedAt when it starts the container again: the restart is done then, as a start is, even
      // when the process exits at once.
      if (!previousStartedAt) return state?.Status === 'running';
      return typeof state?.StartedAt === 'string' && state.StartedAt !== previousStartedAt;
    },
    { previousStartedAt: previousStartedAt ?? null }
  );
  await ctx.auditService.log({
    action: 'docker.container.restart',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });
  return answerWhenDone(restarted, { taskId: task?.id, containerId, name }, 'restarting', 'restarted');
}

/**
 * SIGKILL answers once the container has exited (as pending with its task after the request's wait). Any other
 * signal may leave the process running: the kill is done once the daemon delivered it.
 */
export async function killContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  signal: string,
  userId: string,
  trustedStableName?: string
): Promise<ContainerOperationAnswer> {
  await ctx.validateDockerNode(nodeId);
  // A trusted stable name is supplied only for an already-authorized lifecycle
  // transition whose runtime may be temporarily absent. Direct kill requests
  // must still prove that the target is not an Opfield-owned container.
  if (!trustedStableName) await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = trustedStableName ?? (await ctx.resolveContainerName(nodeId, containerId));
  if (!(await containerHasProcessToStop(ctx, nodeId, containerId))) {
    // Docker refuses to signal a container without a process ("is not running"). Like a stop of it, the kill is
    // done at once: the container is already stopped.
    const task = await ctx.createTask(nodeId, containerId, name, 'kill');
    if (task && ctx.taskService) {
      await ctx.taskService
        .update(task.id, { status: 'succeeded', progress: 'Container is not running', completedAt: new Date() })
        .catch(() => undefined);
    }
    await ctx.auditService.log({
      action: 'docker.container.kill',
      userId,
      resourceType: 'docker-container',
      resourceId: containerId,
      details: { nodeId, name, containerName: name, signal },
    });
    return { taskId: task?.id, containerId, name, notRunning: true };
  }
  ctx.setTransition(nodeId, name, 'killing');
  ctx.emitTransition(nodeId, name, containerId, 'killing');
  const task = await ctx.createTask(nodeId, containerId, name, 'kill');
  try {
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'kill', {
      containerId,
      signal,
      configJson: JSON.stringify({ containerName: name, emergency: true }),
    });
    ctx.parseResult(result);
  } catch (err) {
    await ctx.failTask(task?.id, err instanceof Error ? err.message : 'Failed to kill container', nodeId, name);
    throw err;
  }
  const exited = signalEndsProcess(signal)
    ? ctx.watchTransition(
        nodeId,
        containerId,
        name,
        task?.id,
        'exited',
        `Container killed (${signal})`,
        'killed',
        undefined,
        hasNoProcess
      )
    : undefined;
  if (!exited) {
    ctx.clearTransition(nodeId, name);
    ctx.emitTransition(nodeId, name, containerId, null);
    if (task && ctx.taskService) {
      await ctx.taskService
        .update(task.id, { status: 'succeeded', progress: `Sent ${signal}`, completedAt: new Date() })
        .catch(() => undefined);
    }
  }
  await ctx.auditService.log({
    action: 'docker.container.kill',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name, signal },
  });
  const answer = { taskId: task?.id, containerId, name };
  return exited ? answerWhenDone(exited, answer, 'killing', 'exited') : answer;
}
