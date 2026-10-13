import { describe, expect, it, vi } from 'vitest';
import type { DockerTaskTracking } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { pullImage } from './docker-image-operations.js';
import { watchDockerRecreateByName, watchDockerTransition } from './docker-lifecycle-watch.js';
import type { DockerTaskRow } from './docker-task.service.js';
import { type DockerTaskReconcileContext, DockerTaskReconciler, isLostTrackError } from './docker-task-reconciler.js';

const T0 = Date.UTC(2026, 9, 8, 17, 9);
const NODE = '00000000-0000-4000-8000-0000000000a1';
const PULL_REF = 'pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime';

type Settled = { status: string; progress?: string; error?: string };

/** An in-memory DockerTaskService: active tasks, what was settled, kept or detached. */
function tasks(rows: DockerTaskRow[]) {
  const settled = new Map<string, Settled>();
  const notes = new Map<string, string>();
  const tracked = new Map<string, { tracking: DockerTaskTracking; commandId?: string }>();
  const detached: string[] = [];
  const service = {
    listDetached: vi.fn(async (nodeId?: string) =>
      rows.filter((row) => !settled.has(row.id) && row.detachedAt && (!nodeId || row.nodeId === nodeId))
    ),
    settle: vi.fn(async (id: string, outcome: Settled) => {
      if (settled.has(id)) return false;
      settled.set(id, outcome);
      return true;
    }),
    noteDetached: vi.fn(async (id: string, progress: string) => {
      notes.set(id, progress);
    }),
    track: vi.fn(async (id: string, tracking: DockerTaskTracking, commandId?: string) => {
      tracked.set(id, { tracking, commandId });
    }),
    detach: vi.fn(async (id: string) => {
      if (!tracked.has(id)) return false;
      detached.push(id);
      return true;
    }),
    update: vi.fn(async (id: string, values: Settled) => {
      settled.set(id, values);
      return { id };
    }),
  };
  return { service, settled, notes, tracked, detached };
}

function row(
  id: string,
  type: string,
  tracking: DockerTaskTracking,
  extra: Partial<DockerTaskRow> = {}
): DockerTaskRow {
  return {
    id,
    nodeId: NODE,
    containerId: 'c1',
    containerName: 'app',
    type,
    status: 'running',
    progress: null,
    error: null,
    createdAt: new Date(T0),
    completedAt: null,
    commandId: null,
    tracking,
    detachedAt: new Date(T0 + 30_000),
    followUps: null,
    ...extra,
  };
}

function ok(detail: unknown) {
  return {
    commandId: 'x',
    success: true,
    error: '',
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
  };
}

function refused(error: string) {
  return { commandId: 'x', success: false, error, detail: '' };
}

function parseResult(result: { success: boolean; error?: string; detail?: string }) {
  if (!result.success) {
    if (/No such container/.test(result.error ?? '')) throw new AppError(404, 'CONTAINER_NOT_FOUND', 'gone');
    throw new AppError(502, 'DISPATCH_ERROR', result.error ?? 'failed');
  }
  return result.detail ? JSON.parse(result.detail) : null;
}

function reconciler(
  rows: DockerTaskRow[],
  daemon: {
    image?: (action: string, options: Record<string, unknown>) => unknown;
    container?: (action: string, options: Record<string, unknown>) => unknown;
  },
  now = T0 + 60_000,
  connected = true
) {
  const store = tasks(rows);
  const finishPull = vi.fn(async () => undefined);
  const preserveContainerIdentity = vi.fn(async () => undefined);
  const emitContainer = vi.fn();
  const sendDockerImageCommand = vi.fn(async (_node: string, action: string, options: Record<string, unknown>) =>
    daemon.image!(action, options)
  );
  const sendDockerContainerCommand = vi.fn(async (_node: string, action: string, options: Record<string, unknown>) =>
    daemon.container!(action, options)
  );
  const context = {
    nodeDispatch: { sendDockerImageCommand, sendDockerContainerCommand },
    taskService: store.service,
    parseResult,
    clearTransition: vi.fn(),
    emitContainer,
    failTask: vi.fn(),
    preserveContainerIdentity,
    finishPull,
  } as unknown as DockerTaskReconcileContext;
  const subject = new DockerTaskReconciler(
    () => context,
    () => connected,
    () => now
  );
  return { subject, store, finishPull, preserveContainerIdentity, emitContainer, sendDockerImageCommand };
}

const pullTracking = (deadlineOffset = 600_000): DockerTaskTracking => ({
  kind: 'pull',
  imageRef: PULL_REF,
  deadlineAt: new Date(T0 + deadlineOffset).toISOString(),
});

describe('Docker tasks Gateway lost track of (F-1)', () => {
  it('keeps a pull the node still runs, then settles it with how it ended', async () => {
    let state = 'running';
    const pull = row('p1', 'pull', pullTracking(), { commandId: 'cmd-1', containerId: '', containerName: PULL_REF });
    const t = reconciler([pull], {
      image: (action) =>
        action === 'pull_status'
          ? ok({
              pulls: [
                { commandId: 'cmd-0', state: 'failed' },
                { commandId: 'cmd-1', state },
              ],
            })
          : ok([]),
    });
    await t.subject.sweep();
    expect(t.store.settled.has('p1')).toBe(false);
    expect(t.store.notes.get('p1')).toBe(`Pulling ${PULL_REF} on the node`);

    state = 'succeeded';
    await t.subject.sweep();
    expect(t.store.settled.get('p1')).toEqual({ status: 'succeeded', progress: `Pulled ${PULL_REF}` });
    expect(t.finishPull).toHaveBeenCalledWith(NODE, pull.tracking);
  });

  it('fails a pull the node reports failed, with its error', async () => {
    const t = reconciler([row('p1', 'pull', pullTracking(), { commandId: 'cmd-1' })], {
      image: () => ok({ pulls: [{ commandId: 'cmd-1', state: 'failed', error: 'toomanyrequests' }] }),
    });
    await t.subject.sweep();
    expect(t.store.settled.get('p1')).toEqual({ status: 'failed', error: 'toomanyrequests' });
    expect(t.finishPull).not.toHaveBeenCalled();
  });

  it('judges a pull the daemon has no record of by the image: present is pulled, missing failed', async () => {
    let images: unknown[] = [{ Id: 'sha256:aa', RepoTags: [PULL_REF] }];
    const daemon = {
      image: (action: string) => (action === 'pull_status' ? ok({ pulls: [] }) : ok(images)),
    };
    const present = reconciler([row('p1', 'pull', pullTracking(), { commandId: 'cmd-1' })], daemon);
    await present.subject.sweep();
    expect(present.store.settled.get('p1')?.status).toBe('succeeded');

    images = [];
    const missing = reconciler([row('p2', 'pull', pullTracking(), { commandId: 'cmd-2' })], daemon);
    await missing.subject.sweep();
    expect(missing.store.settled.get('p2')).toEqual({
      status: 'failed',
      error: 'The pull did not finish on the node: its daemon restarted or never received it',
    });
  });

  it('waits for a pull on a daemon without pull_status until the pull’s deadline', async () => {
    const daemon = {
      image: (action: string) => (action === 'pull_status' ? refused('unknown image action: pull_status') : ok([])),
    };
    const early = reconciler([row('p1', 'pull', pullTracking(600_000))], daemon, T0 + 120_000);
    await early.subject.sweep();
    expect(early.store.settled.has('p1')).toBe(false);

    const late = reconciler([row('p1', 'pull', pullTracking(600_000))], daemon, T0 + 601_000);
    await late.subject.sweep();
    expect(late.store.settled.get('p1')).toEqual({ status: 'failed', error: 'Timed out' });
  });

  it('asks a busy daemon again instead of settling', async () => {
    const t = reconciler([row('p1', 'pull', pullTracking(), { commandId: 'cmd-1' })], {
      image: () => refused('daemon is busy handling long-running commands; retry shortly'),
    });
    await t.subject.sweep();
    expect(t.store.settled.size).toBe(0);
  });

  it('leaves the tasks of a node that is not connected alone', async () => {
    const image = vi.fn();
    const t = reconciler([row('p1', 'pull', pullTracking())], { image }, T0, false);
    await t.subject.sweep();
    expect(image).not.toHaveBeenCalled();
    expect(t.store.settled.size).toBe(0);
  });

  it('settles a stop once the container has no process, a restart once it started again', async () => {
    let status = 'running';
    let startedAt = '2026-10-08T16:00:00Z';
    const stop = row('s1', 'stop', {
      kind: 'state',
      containerId: 'c1',
      expect: 'exited',
      progress: 'Container stopped',
      deadlineAt: new Date(T0 + 120_000).toISOString(),
    });
    const restart = row('r1', 'restart', {
      kind: 'state',
      containerId: 'c1',
      expect: 'restarted',
      previousStartedAt: '2026-10-08T16:00:00Z',
      progress: 'Container restarted',
      deadlineAt: new Date(T0 + 120_000).toISOString(),
    });
    const t = reconciler([stop, restart], {
      container: () => ok({ State: { Status: status, StartedAt: startedAt } }),
    });
    await t.subject.sweep();
    expect(t.store.settled.size).toBe(0);

    status = 'exited';
    await t.subject.sweep();
    expect(t.store.settled.get('s1')).toEqual({ status: 'succeeded', progress: 'Container stopped' });
    expect(t.store.settled.has('r1')).toBe(false);
    expect(t.emitContainer).toHaveBeenCalledWith(NODE, 'app', 'c1', 'stopped');

    status = 'running';
    startedAt = '2026-10-08T17:09:40Z';
    await t.subject.sweep();
    expect(t.store.settled.get('r1')).toEqual({ status: 'succeeded', progress: 'Container restarted' });
  });

  it('fails a container operation that did not end by its deadline, and counts a gone container as stopped', async () => {
    const stop = (id: string) =>
      row(id, 'stop', {
        kind: 'state',
        containerId: 'c1',
        expect: 'exited',
        progress: 'Container stopped',
        deadlineAt: new Date(T0 + 30_000).toISOString(),
      });
    const late = reconciler([stop('s1')], { container: () => ok({ State: { Status: 'running' } }) });
    await late.subject.sweep();
    expect(late.store.settled.get('s1')).toEqual({ status: 'failed', error: 'Timed out' });

    const gone = reconciler([stop('s2')], { container: () => refused('No such container: c1') });
    await gone.subject.sweep();
    expect(gone.store.settled.get('s2')?.status).toBe('succeeded');
  });

  it('settles an update once its replacement runs, and keeps the container’s identity', async () => {
    let daemonStatus = 'running';
    let containers = [{ Id: 'old', Names: ['/app'], name: 'app', id: 'old', state: 'running' }];
    const update = row('u1', 'update', {
      kind: 'replace',
      containerName: 'app',
      oldContainerId: 'old',
      expectedState: 'running',
      daemonTaskId: 'dt-1',
      progress: 'Container updated',
      deadlineAt: new Date(T0 + 600_000).toISOString(),
    });
    const t = reconciler([update], {
      container: (action) => (action === 'task_status' ? ok({ status: daemonStatus }) : ok(containers)),
    });
    await t.subject.sweep();
    expect(t.store.settled.size).toBe(0);

    daemonStatus = 'succeeded';
    containers = [{ Id: 'new', Names: ['/app'], name: 'app', id: 'new', state: 'running' }];
    await t.subject.sweep();
    expect(t.store.settled.get('u1')).toEqual({ status: 'succeeded', progress: 'Container updated' });
    expect(t.preserveContainerIdentity).toHaveBeenCalledWith(NODE, 'app', 'new');
  });

  it('fails an update its daemon task failed', async () => {
    const t = reconciler(
      [
        row('u1', 'update', {
          kind: 'replace',
          containerName: 'app',
          oldContainerId: 'old',
          expectedState: 'running',
          daemonTaskId: 'dt-1',
          progress: 'Container updated',
          deadlineAt: new Date(T0 + 600_000).toISOString(),
        }),
      ],
      { container: (action) => (action === 'task_status' ? ok({ status: 'failed', error: 'pull denied' }) : ok([])) }
    );
    await t.subject.sweep();
    expect(t.store.settled.get('u1')).toEqual({ status: 'failed', error: 'pull denied' });
  });

  it('settles a removal Gateway did not get to run by whether the container is gone', async () => {
    const gone = reconciler([row('d1', 'remove', { kind: 'remove', containerId: 'c1' })], {
      container: () => refused('No such container: c1'),
    });
    await gone.subject.sweep();
    expect(gone.store.settled.get('d1')).toEqual({ status: 'succeeded', progress: 'Container removed' });

    const left = reconciler([row('d2', 'remove', { kind: 'remove', containerId: 'c1' })], {
      container: () => ok({ State: { Status: 'exited' } }),
    });
    await left.subject.sweep();
    expect(left.store.settled.get('d2')?.status).toBe('failed');
  });
});

describe('losing track of a running Docker task (F-1)', () => {
  it('detaches a pull whose answer was lost, under the command ID the daemon reports it by', async () => {
    const store = tasks([]);
    let rejectPull!: (error: Error) => void;
    const sendDockerImageCommand = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectPull = reject;
        })
    );
    const answer = await pullImage(
      {
        nodeDispatch: { sendDockerImageCommand } as never,
        auditService: { log: vi.fn() } as never,
        taskService: store.service as never,
        parseResult,
        createTask: async () => ({ id: 'p1' }),
        longDockerOperationTimeoutMs: 600_000,
      },
      NODE,
      PULL_REF
    );
    expect(answer.taskId).toBe('p1');
    const recorded = store.tracked.get('p1');
    expect(recorded?.tracking).toMatchObject({ kind: 'pull', imageRef: PULL_REF });
    expect(sendDockerImageCommand).toHaveBeenCalledWith(
      NODE,
      'pull',
      expect.objectContaining({ imageRef: PULL_REF }),
      600_000,
      recorded?.commandId
    );

    // Opfield shuts down while the node pulls: the pending command is rejected, the task is kept.
    rejectPull(new Error('Node disconnected'));
    await vi.waitFor(() => expect(store.detached).toEqual(['p1']));
    expect(store.service.update).not.toHaveBeenCalledWith('p1', expect.objectContaining({ status: 'failed' }));
  });

  it('fails a pull that was never sent', () => {
    expect(isLostTrackError(new Error('Node 1 is not connected'))).toBe(false);
    expect(isLostTrackError(new Error('Node disconnected'))).toBe(true);
    expect(isLostTrackError(new Error('Command abc timed out after 600000ms'))).toBe(true);
  });

  it('detaches a watched stop when the node disconnects, and ends its transition', async () => {
    vi.useFakeTimers({ now: T0 });
    try {
      const store = tasks([]);
      const failTask = vi.fn(async () => undefined);
      const watch = watchDockerTransition(
        {
          nodeDispatch: {
            sendDockerContainerCommand: vi.fn(async () => {
              throw new Error(`Node ${NODE} is not connected`);
            }),
          } as never,
          taskService: store.service as never,
          parseResult,
          clearTransition: vi.fn(),
          emitContainer: vi.fn(),
          failTask,
        },
        NODE,
        'c1',
        'app',
        's1',
        'exited',
        'Container stopped',
        'stopped',
        60_000
      );
      await vi.advanceTimersByTimeAsync(2_100);
      await expect(watch).resolves.toEqual({ completed: false, reason: 'disconnected' });
      expect(store.tracked.get('s1')?.tracking).toMatchObject({ kind: 'state', expect: 'exited', containerId: 'c1' });
      expect(store.detached).toEqual(['s1']);
      // The transition ends; the task is not failed.
      expect(failTask).toHaveBeenCalledWith(undefined, expect.any(String), NODE, 'app');
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches a watched update when the node disconnects', async () => {
    vi.useFakeTimers({ now: T0 });
    try {
      const store = tasks([]);
      const failTask = vi.fn(async () => undefined);
      watchDockerRecreateByName(
        {
          nodeDispatch: {
            sendDockerContainerCommand: vi.fn(async () => {
              throw new Error('Node disconnected');
            }),
          } as never,
          taskService: store.service as never,
          parseResult,
          clearTransition: vi.fn(),
          emitContainer: vi.fn(),
          failTask,
        },
        NODE,
        'app',
        'old',
        'u1',
        'Container updated',
        'running',
        600_000,
        undefined,
        'dt-1'
      );
      await vi.advanceTimersByTimeAsync(2_100);
      expect(store.tracked.get('u1')?.tracking).toMatchObject({ kind: 'replace', daemonTaskId: 'dt-1' });
      expect(store.detached).toEqual(['u1']);
      expect(failTask).toHaveBeenCalledWith(undefined, expect.any(String), NODE, 'app');
    } finally {
      vi.useRealTimers();
    }
  });
});
