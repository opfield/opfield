import { randomBytes } from 'node:crypto';
import type { DockerTaskFollowUps, DockerTaskTracking } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { CryptoService } from '@/services/crypto.service.js';
import type { DockerContainerMutationContext } from './docker-container-mutation-operations.js';
import { DockerContainerTransitions } from './docker-container-transitions.js';
import {
  openEnvFollowUpPayload,
  runKeptEnvFollowUps,
  sealEnvFollowUpPayload,
  TASK_COMMAND_LOOKUP_CAPABILITY,
} from './docker-env-follow-ups.js';
import { type DockerLifecycleWatchContext, watchDockerRecreateByName } from './docker-lifecycle-watch.js';
import type { DockerTaskRow } from './docker-task.service.js';
import type { DockerTaskReconcileContext } from './docker-task-reconciler.js';

export const OLD_RUNTIME = 'a'.repeat(64);
export const NEW_RUNTIME = 'b'.repeat(64);
export const DAEMON_ERROR = 'pull access denied for app:2';

export function parseResult(result: { success: boolean; error?: string; detail?: string }) {
  if (!result.success) {
    if (/No such container/.test(result.error ?? '')) throw new AppError(404, 'CONTAINER_NOT_FOUND', 'gone');
    throw new AppError(502, 'DISPATCH_ERROR', result.error ?? 'failed');
  }
  return result.detail ? JSON.parse(result.detail) : null;
}

const ok = (detail: unknown) => ({ success: true, error: '', detail: JSON.stringify(detail) });

export interface FakeDockerNodeOptions {
  /** A daemon before 2.10: it replaces the container at once and answers with the new one. */
  syncAnswer?: boolean;
  /** The daemon finds a task by the Opfield command that started it (TASK_COMMAND_LOOKUP_CAPABILITY); default on. */
  commandLookup?: boolean;
  /**
   * How an update's or recreate's command goes: `lost`: the daemon runs it, its answer never reaches Opfield;
   * `never-sent`: it never reaches the daemon; `disconnected`: the daemon runs it, the node's stream drops before the
   * answer; `dropped-before`: the node's stream drops while Opfield reads the container, before anything is sent.
   */
  answer?: 'normal' | 'lost' | 'never-sent' | 'disconnected' | 'dropped-before';
}

/**
 * A Docker node whose daemon runs updates and recreates as asynchronous tasks: `api` runs as OLD_RUNTIME with
 * `oldEnv` until `finish` replaces it with NEW_RUNTIME running `newEnv`, or fails the daemon task.
 */
export function fakeDockerNode(oldEnv: string[], newEnv: string[], options: FakeDockerNodeOptions = {}) {
  const commandLookup = options.commandLookup ?? true;
  let containers = [{ id: OLD_RUNTIME, name: 'api', state: 'running', env: oldEnv }];
  let daemonTask: Record<string, string> | null = null;
  const replace = () => {
    containers = [{ id: NEW_RUNTIME, name: 'api', state: 'running', env: newEnv }];
  };
  const sendDockerContainerCommand = async (
    _nodeId: string,
    action: string,
    command: Record<string, unknown> = {},
    _timeoutMs?: number,
    commandId?: string
  ): Promise<{ success: boolean; error?: string; detail?: string }> => {
    switch (action) {
      case 'update':
      case 'recreate': {
        if (options.answer === 'never-sent') return new Promise(() => undefined);
        if (options.syncAnswer) {
          replace();
          return ok({ Id: NEW_RUNTIME });
        }
        daemonTask = { id: 'daemon-task-1', type: action, status: 'running', commandId: commandId ?? '' };
        if (options.answer === 'lost') return new Promise(() => undefined);
        if (options.answer === 'disconnected') throw new Error('Node disconnected');
        return ok(daemonTask);
      }
      case 'task_status': {
        const id = String(command.containerId ?? '');
        const known = daemonTask && (daemonTask.id === id || (commandLookup && !!id && daemonTask.commandId === id));
        return known ? ok(daemonTask) : { success: false, error: 'docker task not found' };
      }
      case 'list':
        return ok(containers.map(({ id, name, state }) => ({ id, name, state })));
      case 'inspect': {
        if (options.answer === 'dropped-before') throw new Error('Node disconnected');
        const container = containers.find(
          (entry) => entry.id === command.containerId || entry.name === command.containerId
        );
        if (!container) return { success: false, error: 'No such container' };
        return ok({
          Id: container.id,
          Name: `/${container.name}`,
          State: { Status: container.state, Running: container.state === 'running' },
          Config: { Env: container.env, Labels: {} },
          HostConfig: {},
        });
      }
      default:
        return ok({});
    }
  };
  return {
    commandLookup,
    dispatch: { sendDockerContainerCommand, sendDockerImageCommand: async () => ok({}) },
    /** The daemon restarts: it no longer knows its tasks, and the old container stays. */
    forgetTasks() {
      daemonTask = null;
    },
    /** The daemon's task ends: the container is replaced, or the task fails and the old container stays. */
    finish(outcome: 'succeeded' | 'failed') {
      if (outcome === 'succeeded') {
        replace();
        if (daemonTask) daemonTask = { ...daemonTask, status: 'succeeded' };
      } else if (daemonTask) {
        daemonTask = { ...daemonTask, status: 'failed', error: DAEMON_ERROR };
      }
    },
  };
}

type TaskStore = DockerContainerMutationContext['taskService'] & object;
type EnvironmentStore = DockerContainerMutationContext['environmentService'] & object;

/**
 * One Opfield process's container operations against `node`: the operations' own watches run here (until the test
 * stops the timers, as a restart does), and so does what the task reconciler of this process runs.
 */
export function opfieldProcess(
  node: ReturnType<typeof fakeDockerNode>,
  tasks: TaskStore,
  environment: EnvironmentStore,
  nodeId: string
) {
  const transitions = new DockerContainerTransitions();
  const failTask = async (taskId: string | undefined, error: string, failedNodeId?: string, name?: string) => {
    if (failedNodeId && name) transitions.clear(failedNodeId, name);
    if (taskId) await tasks.update(taskId, { status: 'failed', error, completedAt: new Date() }).catch(() => undefined);
  };
  const lifecycle = {
    nodeDispatch: node.dispatch,
    taskService: tasks,
    parseResult,
    clearTransition: (id: string, name: string) => transitions.clear(id, name),
    emitContainer: () => undefined,
    failTask,
    preserveContainerIdentity: async () => undefined,
  } as unknown as DockerLifecycleWatchContext;
  const nothing = async () => undefined;
  const ctx = {
    db: {},
    auditService: { log: nothing },
    nodeDispatch: node.dispatch,
    environmentService: environment,
    taskService: tasks,
    longDockerOperationTimeoutMs: 600_000,
    validateDockerNode: nothing,
    assertNotManagedDeploymentInternal: nothing,
    assertDockerRuntimeProfileAvailable: nothing,
    assertDockerGpuCapability: nothing,
    assertDockerPortBindIpCapability: nothing,
    recheckMigrationGuard: nothing,
    resolveContainerName: async () => 'api',
    resolveExpectedRecreateState: async () => 'running',
    resolveContainerStopTimeout: async () => 10,
    resolveStopTimeoutFromInspect: () => 10,
    lifecycleWatchTimeoutMs: () => 60_000,
    inspectContainer: async (inspectNodeId: string, containerId: string) =>
      parseResult(await node.dispatch.sendDockerContainerCommand(inspectNodeId, 'inspect', { containerId })),
    runtimeOperationContext: () => ({}),
    requireNoTransition: (id: string, name: string) => transitions.requireIdle(id, name),
    setTransition: (id: string, name: string, state: never) => transitions.set(id, name, state),
    clearTransition: (id: string, name: string) => transitions.clear(id, name),
    claimTransitions: (id: string, entries: never) => transitions.claim(id, entries),
    releaseTransitions: (claim: never) => transitions.release(claim),
    acquireTransitionLeases: (id: string, names: readonly string[]) => transitions.acquireLeases(id, names),
    emitTransition: () => undefined,
    emitContainer: () => undefined,
    createTask: (taskNodeId: string, containerId: string, containerName: string, type: string) =>
      (tasks as unknown as { create(input: Record<string, string>): Promise<{ id: string }> }).create({
        nodeId: taskNodeId,
        containerId,
        containerName,
        type,
      }),
    failTask,
    watchRecreateByName: (...args: unknown[]) =>
      (watchDockerRecreateByName as (...watchArgs: unknown[]) => void)(lifecycle, ...args),
    parseResult,
  } as unknown as DockerContainerMutationContext;
  /** What DockerTaskReconciler of this process works with (DockerManagementService.taskReconcileContext). */
  const reconcileContext = {
    ...lifecycle,
    taskService: tasks,
    finishPull: nothing,
    nodeHasCapability: (_nodeId: string, capability: string) =>
      capability === TASK_COMMAND_LOOKUP_CAPABILITY && node.commandLookup,
    runFollowUps: (task: DockerTaskRow, trigger: Parameters<typeof runKeptEnvFollowUps>[2]) =>
      runKeptEnvFollowUps(ctx, task, trigger),
  } as unknown as DockerTaskReconcileContext;
  return { ctx, transitions, reconcileContext, nodeId };
}

/**
 * The task records DockerTaskService keeps, in memory, with its rules: only an active task keeps follow-ups, they are
 * taken once, and a task's end drops them. `restart` is what the next Opfield process does at startup.
 */
export function memoryTaskStore() {
  const rows = new Map<string, DockerTaskRow>();
  const isActive = (row: DockerTaskRow) => row.status === 'pending' || row.status === 'running';
  let failNextEnd = false;
  const end = (row: DockerTaskRow, values: Partial<DockerTaskRow>) => {
    if (failNextEnd) {
      failNextEnd = false;
      throw new Error('the process stopped before it ended the task');
    }
    Object.assign(row, values, { followUps: null, detachedAt: null });
  };
  const service = {
    async create(input: { nodeId: string; containerId?: string; containerName?: string; type: string }) {
      const id = `task-${rows.size + 1}`;
      const row: DockerTaskRow = {
        id,
        nodeId: input.nodeId,
        containerId: input.containerId ?? null,
        containerName: input.containerName ?? null,
        type: input.type,
        status: 'running',
        progress: null,
        error: null,
        createdAt: new Date(),
        completedAt: null,
        commandId: null,
        tracking: null,
        detachedAt: null,
        followUps: null,
      };
      rows.set(id, row);
      return row;
    },
    async track(id: string, tracking: DockerTaskTracking, commandId?: string, followUps?: DockerTaskFollowUps) {
      const row = rows.get(id);
      if (!row) return;
      row.tracking = tracking;
      if (commandId) row.commandId = commandId;
      if (followUps) row.followUps = followUps;
    },
    async takeFollowUps(id: string) {
      const row = rows.get(id);
      if (!row || !isActive(row) || !row.followUps) return null;
      const taken = row.followUps;
      row.followUps = null;
      return taken;
    },
    async detach(id: string, error: string) {
      const row = rows.get(id);
      if (row && isActive(row) && row.tracking) {
        row.detachedAt = new Date();
        return true;
      }
      if (row && isActive(row)) end(row, { status: 'failed', error });
      return false;
    },
    async listDetached(nodeId?: string) {
      return [...rows.values()].filter((row) => isActive(row) && row.detachedAt && (!nodeId || row.nodeId === nodeId));
    },
    async noteDetached(id: string, progress: string) {
      const row = rows.get(id);
      if (row) row.progress = progress;
    },
    async settle(id: string, outcome: { status: string; progress?: string; error?: string }) {
      const row = rows.get(id);
      if (!row || !isActive(row)) return false;
      end(row, { ...outcome, completedAt: new Date() });
      return true;
    },
    async update(id: string, values: { status?: string; progress?: string; error?: string; completedAt?: Date }) {
      const row = rows.get(id);
      if (!row) throw new Error('Docker task not found');
      if (values.status && values.status !== 'pending' && values.status !== 'running') end(row, values);
      else Object.assign(row, values);
      return row;
    },
  };
  return {
    service: service as unknown as TaskStore,
    rows,
    /** The next end of a task throws, as when the process stops right before it. */
    failNextEnd() {
      failNextEnd = true;
    },
    /** DockerTaskService.detachActiveTasksOnStartup of the next process. */
    restart() {
      for (const row of rows.values()) {
        if (!isActive(row)) continue;
        if (row.tracking) row.detachedAt ??= new Date();
        else Object.assign(row, { status: 'failed', followUps: null, completedAt: new Date() });
      }
    },
  };
}

/** Stored container env as DockerEnvironmentService keeps it, in memory, sealing with a key of its own. */
export function memoryEnvironmentStore(initial: Record<string, Record<string, string>>) {
  const crypto = new CryptoService(randomBytes(32).toString('hex'));
  const stored = new Map(Object.entries(initial).map(([name, env]) => [name, { ...env }]));
  const writes: Array<{ name: string; env: Record<string, string> }> = [];
  const service = {
    async getDecryptedMap(_nodeId: string, name: string) {
      return { ...(stored.get(name) ?? {}) };
    },
    async replace(_nodeId: string, name: string, env: Record<string, string>) {
      writes.push({ name, env: { ...env } });
      stored.set(name, { ...env });
    },
    async deleteImported() {},
    async rename() {},
    async copy() {},
    sealFollowUpPayload: (payload: Parameters<typeof sealEnvFollowUpPayload>[1]) =>
      sealEnvFollowUpPayload(crypto, payload),
    openFollowUpPayload: (sealed: Parameters<typeof openEnvFollowUpPayload>[1]) =>
      openEnvFollowUpPayload(crypto, sealed),
  };
  return { service: service as EnvironmentStore, stored, writes, crypto };
}
