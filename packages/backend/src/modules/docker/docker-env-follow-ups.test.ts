import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recordNodeLostTask,
  recreateWithConfig,
  updateContainer,
  updateContainerEnv,
} from './docker-container-mutation-operations.js';
import {
  DAEMON_ERROR,
  type FakeDockerNodeOptions,
  fakeDockerNode,
  gatewayProcess,
  memoryEnvironmentStore,
  memoryTaskStore,
} from './docker-env-follow-ups.test-helpers.js';
import { nodeLossHttpError, withNodeLossAnswer } from './docker-node-loss.js';
import { DockerTaskReconciler } from './docker-task-reconciler.js';

const NODE = '00000000-0000-4000-8000-0000000000a1';
const SECRET = 's3cret-value';
const NEW_SECRET = 'n3w-secret-value';
/** APP_MODE only mirrors the old image's default; API_KEY is set by the user. */
const STORED = { APP_MODE: 'mode-one', API_KEY: SECRET };
const OLD_ENV = ['APP_MODE=mode-one', `API_KEY=${SECRET}`, 'PATH=/usr/bin'];
const NEW_IMAGE_ENV = ['APP_MODE=mode-two', `API_KEY=${SECRET}`, 'PATH=/usr/bin'];

function setup(options: FakeDockerNodeOptions = {}) {
  const node = fakeDockerNode(OLD_ENV, NEW_IMAGE_ENV, options);
  const tasks = memoryTaskStore();
  const environment = memoryEnvironmentStore({ api: STORED });
  const first = gatewayProcess(node, tasks.service, environment.service, NODE);
  return {
    node,
    tasks,
    environment,
    first,
    /** Gateway restarts: the operation's watch is gone, and the next process detaches what the node may still run. */
    restart() {
      vi.clearAllTimers();
      tasks.restart();
      const next = gatewayProcess(node, tasks.service, environment.service, NODE);
      return {
        ...next,
        reconciler: new DockerTaskReconciler(
          () => next.reconcileContext,
          () => true
        ),
      };
    },
    task(id: string | undefined) {
      const row = tasks.rows.get(String(id));
      if (!row) throw new Error(`no task ${id}`);
      return row;
    },
    /** The one task, for an operation that never returned. */
    only() {
      const [row] = [...tasks.rows.values()];
      if (!row || tasks.rows.size !== 1) throw new Error('expected one task');
      return row;
    },
  };
}

/** Lets the operation record its task's tracking (and what it keeps for later) before the restart. */
const settleWrites = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('env follow-ups of an update or recreate Gateway restarted during', () => {
  it('reconciles the stored env after an image update once the node finished it', async () => {
    const t = setup();
    const result = await updateContainer(t.first.ctx, NODE, 'api', { tag: '2' }, 'user-1');
    await settleWrites();

    const next = t.restart();
    // What the task keeps for later shows no env name or value.
    const kept = JSON.stringify(t.task(result.taskId).followUps);
    expect(t.task(result.taskId).followUps).toMatchObject({ containerName: 'api', reconcileEnvAfterImageChange: true });
    for (const plain of [SECRET, 'API_KEY', 'APP_MODE', 'mode-one']) expect(kept).not.toContain(plain);

    await next.reconciler.sweep();
    expect(t.task(result.taskId).status).toBe('running');
    expect(t.environment.stored.get('api')).toEqual(STORED);

    t.node.finish('succeeded');
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({ status: 'succeeded', followUps: null });
    // The stored APP_MODE only mirrored the old image's default: it follows the new image; the user's API_KEY stays.
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-two', API_KEY: SECRET });
  });

  it.each([
    [
      'a recreate with another image',
      {},
      (ctx: Parameters<typeof recreateWithConfig>[0]) =>
        recreateWithConfig(ctx, NODE, 'api', { image: 'registry.local/app:2' }, 'user-1', { skipImagePull: true }),
    ],
    [
      'a recreate whose image Gateway pulls in the background first',
      {},
      (ctx: Parameters<typeof recreateWithConfig>[0]) =>
        recreateWithConfig(ctx, NODE, 'api', { image: 'registry.local/app:2' }, 'user-1', {
          backgroundImagePull: true,
        }),
    ],
    [
      'an image update a daemon before 2.10 answered once done',
      { syncAnswer: true, commandLookup: false },
      (ctx: Parameters<typeof recreateWithConfig>[0]) => updateContainer(ctx, NODE, 'api', { tag: '2' }, 'user-1'),
    ],
  ])('reconciles the stored env after %s once the node finished it', async (_case, options, run) => {
    const t = setup(options);
    const result = await run(t.first.ctx);
    await vi.waitFor(() => expect(t.task(result.taskId).tracking).not.toBeNull());

    const next = t.restart();
    expect(t.task(result.taskId).followUps).toMatchObject({ reconcileEnvAfterImageChange: true });
    t.node.finish('succeeded');
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({ status: 'succeeded', followUps: null });
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-two', API_KEY: SECRET });
  });

  it.each([
    [
      'an update with an env change',
      (ctx: Parameters<typeof updateContainer>[0]) =>
        updateContainer(ctx, NODE, 'api', { env: { API_KEY: NEW_SECRET } }, 'user-1'),
    ],
    [
      'an env change',
      (ctx: Parameters<typeof updateContainer>[0]) =>
        updateContainerEnv(ctx, NODE, 'api', { API_KEY: NEW_SECRET }, undefined, 'user-1'),
    ],
  ])('restores the stored env after %s the node failed', async (_case, run) => {
    const t = setup();
    const result = await run(t.first.ctx);
    await settleWrites();
    // Saved with the operation, before the node ran it.
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-one', API_KEY: NEW_SECRET });

    const next = t.restart();
    const kept = JSON.stringify(t.task(result.taskId).followUps);
    expect(t.task(result.taskId).followUps).toMatchObject({ restoreEnvAfterFailedUpdate: true });
    for (const plain of [SECRET, NEW_SECRET, 'API_KEY', 'APP_MODE', 'mode-one']) expect(kept).not.toContain(plain);

    t.node.finish('failed');
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({ status: 'failed', error: DAEMON_ERROR, followUps: null });
    expect(t.environment.stored.get('api')).toEqual(STORED);
  });
});

describe('env follow-ups of an update or recreate Gateway restarted during before the daemon answered', () => {
  it('restores the stored env after an env update the node got and failed', async () => {
    const t = setup({ answer: 'lost' });
    void updateContainerEnv(t.first.ctx, NODE, 'api', { API_KEY: NEW_SECRET }, undefined, 'user-1');
    await settleWrites();
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-one', API_KEY: NEW_SECRET });

    const next = t.restart();
    const task = t.only();
    expect(task).toMatchObject({ status: 'running', followUps: { restoreEnvAfterFailedUpdate: true } });
    expect(task.commandId).toBeTruthy();
    await next.reconciler.sweep();
    expect(task.status).toBe('running');

    t.node.finish('failed');
    await next.reconciler.sweep();
    expect(task).toMatchObject({ status: 'failed', error: DAEMON_ERROR, followUps: null });
    expect(t.environment.stored.get('api')).toEqual(STORED);
  });

  it('reconciles the stored env after an image update the node got and finished', async () => {
    const t = setup({ answer: 'lost' });
    void updateContainer(t.first.ctx, NODE, 'api', { tag: '2' }, 'user-1');
    await settleWrites();

    const next = t.restart();
    t.node.finish('succeeded');
    await next.reconciler.sweep();
    expect(t.only()).toMatchObject({ status: 'succeeded', followUps: null });
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-two', API_KEY: SECRET });
  });

  it('reconciles the stored env after a recreate the node got and finished', async () => {
    const t = setup({ answer: 'lost' });
    void recreateWithConfig(t.first.ctx, NODE, 'api', { image: 'registry.local/app:2' }, 'user-1', {
      skipImagePull: true,
    });
    await settleWrites();

    const next = t.restart();
    t.node.finish('succeeded');
    await next.reconciler.sweep();
    expect(t.only()).toMatchObject({ status: 'succeeded', followUps: null });
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-two', API_KEY: SECRET });
  });

  it('runs nothing for an update that never reached the node, and puts back the env it saved', async () => {
    const t = setup({ answer: 'never-sent' });
    void updateContainer(t.first.ctx, NODE, 'api', { tag: '2', env: { API_KEY: NEW_SECRET } }, 'user-1');
    await settleWrites();
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-one', API_KEY: NEW_SECRET });

    const next = t.restart();
    await next.reconciler.sweep();
    expect(t.only()).toMatchObject({
      status: 'failed',
      error: 'The update did not run on the node: its daemon restarted or never received it',
      followUps: null,
    });
    // No reconciliation: the old image still runs. The env saved for the update is put back.
    expect(t.environment.stored.get('api')).toEqual(STORED);
    expect(t.environment.writes.map((write) => write.env)).toEqual([
      { APP_MODE: 'mode-one', API_KEY: NEW_SECRET },
      STORED,
    ]);
  });

  it('runs nothing for an image update that never reached the node', async () => {
    const t = setup({ answer: 'never-sent' });
    void updateContainer(t.first.ctx, NODE, 'api', { tag: '2' }, 'user-1');
    await settleWrites();

    const next = t.restart();
    await next.reconciler.sweep();
    expect(t.only()).toMatchObject({ status: 'failed', followUps: null });
    expect(t.environment.writes).toEqual([]);
  });

  it('settles with a daemon that cannot find tasks by command by its containers, and by the deadline otherwise', async () => {
    const replaced = setup({ answer: 'lost', commandLookup: false });
    void updateContainer(replaced.first.ctx, NODE, 'api', { tag: '2' }, 'user-1');
    await settleWrites();
    const next = replaced.restart();
    await next.reconciler.sweep();
    expect(replaced.only().status).toBe('running');
    replaced.node.finish('succeeded');
    await next.reconciler.sweep();
    expect(replaced.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-two', API_KEY: SECRET });

    const stays = setup({ answer: 'never-sent', commandLookup: false });
    void updateContainerEnv(stays.first.ctx, NODE, 'api', { API_KEY: NEW_SECRET }, undefined, 'user-1');
    await settleWrites();
    const later = stays.restart();
    await later.reconciler.sweep();
    expect(stays.only().status).toBe('running');
    // Past the deadline (beyond the daemon's own limit) the old container still runs: the update did not apply.
    vi.setSystemTime(Date.now() + 700_000);
    await later.reconciler.sweep();
    expect(stays.only()).toMatchObject({ status: 'failed', error: 'Timed out', followUps: null });
    expect(stays.environment.stored.get('api')).toEqual(STORED);
  });

  it('leaves an update whose node dropped before it answered to the node, and settles it with the node', async () => {
    const t = setup({ answer: 'disconnected' });
    await expect(
      updateContainerEnv(t.first.ctx, NODE, 'api', { API_KEY: NEW_SECRET }, undefined, 'user-1')
    ).rejects.toThrow('Node disconnected');
    const task = t.only();
    // Not failed, and the saved env stays until the node tells how the update ended.
    expect(task.status).toBe('running');
    expect(task.detachedAt).toBeInstanceOf(Date);
    expect(t.first.transitions.get(NODE, 'api')).toBeUndefined();
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-one', API_KEY: NEW_SECRET });

    t.node.finish('failed');
    await new DockerTaskReconciler(
      () => t.first.reconcileContext,
      () => true
    ).sweep();
    expect(task).toMatchObject({ status: 'failed', error: DAEMON_ERROR, followUps: null });
    expect(t.environment.stored.get('api')).toEqual(STORED);
  });
});

describe('the API answer of an update whose node is lost', () => {
  it('answers that the node did not answer and names the task settled with the node', async () => {
    const t = setup({ answer: 'disconnected' });
    const error = await updateContainer(t.first.ctx, NODE, 'api', { tag: '2' }, 'user-1').catch((caught) => caught);
    const task = t.only();
    expect(error).toMatchObject({ statusCode: 504, code: 'NODE_ANSWER_LOST', details: { taskId: task.id } });
    expect(task.status).toBe('running');
    expect(task.detachedAt).toBeInstanceOf(Date);
  });

  it('answers that nothing was changed and records a failed task when the node drops before the update is sent', async () => {
    const t = setup({ answer: 'dropped-before' });
    const error = await updateContainer(
      t.first.ctx,
      NODE,
      'api',
      { tag: '2', env: { API_KEY: NEW_SECRET } },
      'user-1'
    ).catch((caught) => caught);
    const task = t.only();
    expect(error).toMatchObject({ statusCode: 503, code: 'NODE_UNAVAILABLE', details: { taskId: task.id } });
    expect(task).toMatchObject({
      type: 'update',
      status: 'failed',
      error: 'The node lost its connection before the update was sent; the container was not changed',
    });
    expect(t.environment.stored.get('api')).toEqual(STORED);
  });
});

describe('the API answer of an env update or recreate whose node is lost', () => {
  it('keeps the service error for internal callers and answers API callers with the task settled with the node', async () => {
    const env = setup({ answer: 'disconnected' });
    const envError = await updateContainerEnv(
      env.first.ctx,
      NODE,
      'api',
      { API_KEY: NEW_SECRET },
      undefined,
      'user-1'
    ).catch((caught) => caught);
    // The core and internal rollouts match on the service error: unchanged.
    expect(envError).toBeInstanceOf(Error);
    expect(envError.message).toBe('Node disconnected');
    expect(await nodeLossHttpError(envError, 'env update')).toMatchObject({
      statusCode: 504,
      code: 'NODE_ANSWER_LOST',
      details: { taskId: env.only().id },
    });
    expect(env.only().status).toBe('running');

    const recreate = setup({ answer: 'disconnected' });
    const recreateError = await withNodeLossAnswer('recreate', () =>
      recreateWithConfig(recreate.first.ctx, NODE, 'api', { image: 'registry.local/app:2' }, 'user-1', {
        skipImagePull: true,
      })
    ).catch((caught) => caught);
    expect(recreateError).toMatchObject({
      statusCode: 504,
      code: 'NODE_ANSWER_LOST',
      message: expect.stringContaining('did not answer the recreate'),
      details: { taskId: recreate.only().id },
    });
    expect(recreate.only().detachedAt).toBeInstanceOf(Date);
  });

  it('answers that nothing was changed and records a failed task when the node drops before the env update is sent', async () => {
    const t = setup({ answer: 'dropped-before' });
    const error = await withNodeLossAnswer(
      'env update',
      () => updateContainerEnv(t.first.ctx, NODE, 'api', { API_KEY: NEW_SECRET }, undefined, 'user-1'),
      (message) => recordNodeLostTask(t.first.ctx, NODE, 'api', 'update', message)
    ).catch((caught) => caught);
    const task = t.only();
    expect(error).toMatchObject({ statusCode: 503, code: 'NODE_UNAVAILABLE', details: { taskId: task.id } });
    expect(task).toMatchObject({
      status: 'failed',
      error: 'The node lost its connection before the env update was sent; the container was not changed',
    });
    expect(t.environment.stored.get('api')).toEqual(STORED);
  });

  it('leaves every other error as it is', async () => {
    expect(await nodeLossHttpError(new Error('pull access denied'), 'recreate')).toBeNull();
  });
});

describe('an update whose daemon restarted and forgot it', () => {
  it('puts back the saved env once the reconciler finds the old container and no task', async () => {
    const t = setup();
    const result = await updateContainerEnv(t.first.ctx, NODE, 'api', { API_KEY: NEW_SECRET }, undefined, 'user-1');
    await settleWrites();
    const next = t.restart();
    t.node.forgetTasks();
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({
      status: 'failed',
      error: 'The update did not run on the node: its daemon restarted or never received it',
      followUps: null,
    });
    expect(t.environment.stored.get('api')).toEqual(STORED);
  });

  it('puts back the saved env when the daemon forgot the update with the old container still running', async () => {
    const t = setup();
    const result = await updateContainerEnv(t.first.ctx, NODE, 'api', { API_KEY: NEW_SECRET }, undefined, 'user-1');
    t.node.forgetTasks();
    await vi.advanceTimersByTimeAsync(640_000);
    expect(t.task(result.taskId)).toMatchObject({
      status: 'failed',
      error: 'The Docker daemon restarted before the container was replaced',
      followUps: null,
    });
    expect(t.environment.stored.get('api')).toEqual(STORED);
  });
});

describe('env follow-ups run once', () => {
  it('leaves nothing to the next process once the watch ran the reconciliation', async () => {
    const t = setup();
    const result = await updateContainer(t.first.ctx, NODE, 'api', { tag: '2' }, 'user-1');
    t.node.finish('succeeded');
    // The watch reconciles, and the process stops before it marks the task succeeded.
    t.tasks.failNextEnd();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.environment.writes).toHaveLength(1);
    expect(t.task(result.taskId).status).toBe('running');

    // A user then sets APP_MODE back, which a second reconciliation would undo.
    t.environment.stored.set('api', { APP_MODE: 'mode-one', API_KEY: SECRET });
    const next = t.restart();
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({ status: 'succeeded', followUps: null });
    expect(t.environment.writes).toHaveLength(1);
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-one', API_KEY: SECRET });
  });

  it('leaves nothing to the next process once the watch restored the env', async () => {
    const t = setup();
    const result = await updateContainerEnv(t.first.ctx, NODE, 'api', { API_KEY: NEW_SECRET }, undefined, 'user-1');
    t.node.finish('failed');
    t.tasks.failNextEnd();
    await vi.advanceTimersByTimeAsync(2_000);
    // The env saved before dispatch, then the restore.
    expect(t.environment.writes).toHaveLength(2);
    expect(t.environment.stored.get('api')).toEqual(STORED);
    expect(t.task(result.taskId).status).toBe('running');

    const next = t.restart();
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({ status: 'failed', followUps: null });
    expect(t.environment.writes).toHaveLength(2);
  });

  it('does not run it again when its task could not be settled at once', async () => {
    const t = setup();
    const result = await updateContainer(t.first.ctx, NODE, 'api', { tag: '2' }, 'user-1');
    await settleWrites();
    const next = t.restart();
    t.node.finish('succeeded');

    t.tasks.failNextEnd();
    await next.reconciler.sweep();
    expect(t.environment.writes).toHaveLength(1);
    expect(t.task(result.taskId).status).toBe('running');

    t.environment.stored.set('api', { APP_MODE: 'mode-one', API_KEY: SECRET });
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({ status: 'succeeded', followUps: null });
    expect(t.environment.writes).toHaveLength(1);
  });

  it('waits while another operation holds the container, and drops it once a later operation changed the env', async () => {
    const t = setup();
    const result = await updateContainerEnv(t.first.ctx, NODE, 'api', { API_KEY: NEW_SECRET }, undefined, 'user-1');
    await settleWrites();
    const next = t.restart();
    t.node.finish('failed');

    const held = next.transitions.claim(NODE, [{ name: 'api', state: 'updating' }]);
    await next.reconciler.sweep();
    expect(t.task(result.taskId).status).toBe('running');
    expect(t.task(result.taskId).followUps).not.toBeNull();

    // That operation saved another env meanwhile: putting back the old one would undo it.
    t.environment.stored.set('api', { APP_MODE: 'mode-three', API_KEY: NEW_SECRET });
    next.transitions.release(held);
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({ status: 'failed', error: DAEMON_ERROR, followUps: null });
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-three', API_KEY: NEW_SECRET });
  });

  it('keeps nothing for an image update whose stored env has no entry the new image could change', async () => {
    const t = setup();
    t.environment.stored.set('api', {});
    const result = await updateContainer(t.first.ctx, NODE, 'api', { tag: '2' }, 'user-1');
    await settleWrites();
    expect(t.task(result.taskId).followUps).toBeNull();
  });
});
