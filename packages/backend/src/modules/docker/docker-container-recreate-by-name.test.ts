import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DockerContainerMutationContext,
  recreateWithConfig,
  updateContainer,
  updateContainerEnv,
} from './docker-container-mutation-operations.js';
import { watchDockerRecreateByName } from './docker-lifecycle-watch.js';

const OLD_RUNTIME = 'a'.repeat(64);
const NEW_RUNTIME = 'b'.repeat(64);

/** A container the request addresses by its name; the daemon answers with an asynchronous task. */
function context() {
  const dispatch = vi.fn(async (_nodeId: string, action: string) => ({
    success: true,
    detail: JSON.stringify({ id: 'daemon-task-1', type: action, status: 'running' }),
  }));
  const ctx = {
    db: {},
    auditService: { log: vi.fn().mockResolvedValue(undefined) },
    nodeDispatch: { sendDockerContainerCommand: dispatch },
    longDockerOperationTimeoutMs: 600_000,
    validateDockerNode: vi.fn().mockResolvedValue({}),
    assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
    assertDockerRuntimeProfileAvailable: vi.fn().mockResolvedValue(undefined),
    resolveContainerName: vi.fn().mockResolvedValue('api'),
    resolveExpectedRecreateState: vi.fn().mockResolvedValue('running'),
    resolveContainerStopTimeout: vi.fn().mockResolvedValue(10),
    resolveStopTimeoutFromInspect: vi.fn().mockReturnValue(10),
    lifecycleWatchTimeoutMs: vi.fn().mockReturnValue(60_000),
    inspectContainer: vi.fn().mockResolvedValue({
      Id: OLD_RUNTIME,
      Name: '/api',
      State: { Status: 'running', Running: true },
      Config: { Env: ['MODE=one'], Labels: {} },
      HostConfig: {},
    }),
    runtimeOperationContext: () => ({}),
    requireNoTransition: vi.fn(),
    setTransition: vi.fn(),
    clearTransition: vi.fn(),
    acquireTransitionLeases: vi.fn().mockResolvedValue(undefined),
    recheckMigrationGuard: vi.fn().mockResolvedValue(undefined),
    emitTransition: vi.fn(),
    createTask: vi.fn().mockResolvedValue({ id: 'task-1' }),
    failTask: vi.fn().mockResolvedValue(undefined),
    watchRecreateByName: vi.fn(),
    parseResult: (result: { detail?: string }) => (result.detail ? JSON.parse(result.detail) : null),
  } as unknown as DockerContainerMutationContext;
  return ctx;
}

const watchedReplacedRuntime = (ctx: DockerContainerMutationContext) =>
  (ctx.watchRecreateByName as ReturnType<typeof vi.fn>).mock.calls[0]?.[2];

describe('recreating a container the request addresses by name', () => {
  it('watches for a runtime other than the replaced one on a recreate', async () => {
    const ctx = context();
    await recreateWithConfig(ctx, 'node-1', 'api', { labels: {} }, 'user-1');
    expect(watchedReplacedRuntime(ctx)).toBe(OLD_RUNTIME);
  });

  it('watches for a runtime other than the replaced one on an update', async () => {
    const ctx = context();
    await updateContainer(ctx, 'node-1', 'api', { env: { MODE: 'two' } }, 'user-1');
    expect(watchedReplacedRuntime(ctx)).toBe(OLD_RUNTIME);
  });

  it('watches for a runtime other than the replaced one on an env change (and a link apply or removal)', async () => {
    const ctx = context();
    await updateContainerEnv(ctx, 'node-1', 'api', { MODE: 'two' }, undefined, 'user-1');
    expect(watchedReplacedRuntime(ctx)).toBe(OLD_RUNTIME);
  });
});

describe('the recreate watcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes with the replacement, not the replaced container that still runs under the name', async () => {
    vi.useFakeTimers();
    const lists = [
      [{ id: OLD_RUNTIME, name: 'api', state: 'running' }],
      [{ id: NEW_RUNTIME, name: 'api', state: 'running' }],
    ];
    const dispatch = vi.fn(async (_nodeId: string, action: string) =>
      action === 'list'
        ? { success: true, detail: JSON.stringify(lists.shift() ?? []) }
        : { success: true, detail: JSON.stringify({ status: 'running' }) }
    );
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const emitContainer = vi.fn();
    watchDockerRecreateByName(
      {
        nodeDispatch: { sendDockerContainerCommand: dispatch },
        parseResult: (result: { detail?: string }) => (result.detail ? JSON.parse(result.detail) : null),
        clearTransition: vi.fn(),
        emitContainer,
        failTask: vi.fn(),
      } as never,
      'node-1',
      'api',
      OLD_RUNTIME,
      undefined,
      'Container recreated',
      'running',
      60_000,
      onComplete,
      'daemon-task-1'
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(onComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onComplete).toHaveBeenCalledWith(NEW_RUNTIME);
    expect(emitContainer).toHaveBeenCalledWith('node-1', 'api', NEW_RUNTIME, 'recreated', { oldId: OLD_RUNTIME });
  });

  /** Watches a recreate whose daemon task answers `task` and whose container list answers `listed`. */
  function watch(
    listed: Array<Record<string, unknown>>,
    task: { success: boolean; detail?: string; error?: string },
    expectedState = 'running'
  ) {
    const dispatch = vi.fn(async (_nodeId: string, action: string) =>
      action === 'list' ? { success: true, detail: JSON.stringify(listed) } : task
    );
    const context = {
      nodeDispatch: { sendDockerContainerCommand: dispatch },
      parseResult: (result: { success: boolean; detail?: string; error?: string }) => {
        if (!result.success) throw new Error(result.error);
        return result.detail ? JSON.parse(result.detail) : null;
      },
      clearTransition: vi.fn(),
      emitContainer: vi.fn(),
      failTask: vi.fn().mockResolvedValue(undefined),
    };
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const onDaemonTaskFailed = vi.fn().mockResolvedValue(undefined);
    watchDockerRecreateByName(
      context as never,
      'node-1',
      'api',
      OLD_RUNTIME,
      'task-1',
      'Container recreated',
      expectedState,
      630_000,
      onComplete,
      'daemon-task-1',
      onDaemonTaskFailed
    );
    return { context, onComplete, onDaemonTaskFailed };
  }

  it('releases the container at once when the daemon is done with a replacement that never started', async () => {
    vi.useFakeTimers();
    const succeeded = { success: true, detail: JSON.stringify({ status: 'succeeded' }) };
    const listed = [{ id: NEW_RUNTIME, name: 'api', state: 'created', status: 'Created' }];
    const { context, onComplete } = watch(listed, succeeded);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(context.failTask).toHaveBeenCalledWith(
      'task-1',
      'Replacement container was created but did not start (Created)',
      'node-1',
      'api'
    );
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('completes a recreate asked created once the daemon started the replacement as an earlier one meant', async () => {
    vi.useFakeTimers();
    const succeeded = { success: true, detail: JSON.stringify({ status: 'succeeded' }) };
    const listed = [{ id: NEW_RUNTIME, name: 'api', state: 'running' }];
    const { context, onComplete } = watch(listed, succeeded, 'created');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onComplete).toHaveBeenCalledWith(NEW_RUNTIME);
    expect(context.clearTransition).toHaveBeenCalledWith('node-1', 'api');
    expect(context.failTask).not.toHaveBeenCalled();
  });

  it('releases the container at once when the daemon restarted and no longer knows the task', async () => {
    vi.useFakeTimers();
    const unknownTask = { success: false, error: 'docker task not found' };
    const { context, onDaemonTaskFailed } = watch([{ id: OLD_RUNTIME, name: 'api', state: 'created' }], unknownTask);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onDaemonTaskFailed).toHaveBeenCalledTimes(1);
    expect(context.failTask).toHaveBeenCalledWith(
      'task-1',
      'The Docker daemon restarted before the container was replaced',
      'node-1',
      'api'
    );
  });
});
