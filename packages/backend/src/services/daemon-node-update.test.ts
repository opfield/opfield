import { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { NodeUpdatePostponedError } from './availability-members.service.js';
import { batchUpdatesBefore, dispatchNodeDaemonUpdate, resumeQueuedDaemonUpdates } from './daemon-node-update.js';
import {
  connectorReplacementToRecord,
  DaemonUpdateService,
  LAUNCHER_CANDIDATE_TRIAL_LIMIT_MS,
  lastUpdateConnectionsToRecord,
  nodeUpdateFailure,
} from './daemon-update.service.js';
import type { NodeLongTask } from './node-long-tasks.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const BACKUP: NodeLongTask = { kind: 'backup', id: 'run-1', label: 'Backup of orders' };
const BUILD: NodeLongTask = { kind: 'build', id: 'build-1', label: 'Build of acme/web' };

/** One docker node in memory; where clauses are not evaluated (the flows under test run one step at a time). */
function harness(
  options: {
    tasks?: NodeLongTask[];
    leaseMember?: boolean;
    metadata?: Record<string, unknown>;
    daemonVersion?: string;
    capabilities?: Record<string, unknown>;
    type?: string;
  } = {}
) {
  const node = {
    id: NODE_ID,
    type: options.type ?? 'docker',
    daemonVersion: options.daemonVersion ?? 'v2.12.0',
    capabilities: options.capabilities ?? { architecture: 'amd64', capabilities: ['daemon_stream_handover_v1'] },
    metadata: { ...(options.metadata ?? {}) } as Record<string, unknown>,
  };
  const sqlWrites: SQL[] = [];
  const db = {
    select: () => {
      const query: any = Promise.resolve([node]);
      for (const method of ['from', 'where', 'limit']) query[method] = () => query;
      return query;
    },
    update: () => ({
      set: (values: { metadata?: unknown }) => {
        if (values.metadata instanceof SQL) sqlWrites.push(values.metadata);
        else if (values.metadata) node.metadata = structuredClone(values.metadata as Record<string, unknown>);
        const done: any = Promise.resolve();
        done.returning = async () => [{ id: NODE_ID }];
        return { where: () => done };
      },
    }),
  };
  const service = new DaemonUpdateService(db as never, { RELEASES_API_URL: 'https://releases.invalid' } as never);
  const events: unknown[] = [];
  service.setEventBus({ publish: (_event: string, payload: unknown) => events.push(payload) } as never);
  Object.assign(service, {
    getLatestRelease: async () => ({
      daemonType: 'docker',
      tagName: 'v2.12.1-docker',
      version: 'v2.12.1',
      releaseNotes: null,
      releaseUrl: null,
    }),
    prepareTrustedDaemonUpdate: async () => ({
      downloadUrl: 'https://a.invalid/d',
      checksum: 'c',
      signedManifest: '{}',
    }),
  });
  const sendUpdateDaemonCommand = vi.fn(async () => ({
    accepted: Promise.resolve(),
    result: new Promise<never>(() => undefined),
  }));
  const state = { tasks: options.tasks ?? [], clock: Date.now() };
  const enqueue = vi.fn(async (request: { run: () => Promise<void> }) => request.run());
  const deps = {
    db: db as never,
    daemonUpdateService: service,
    dispatch: { isNodeConnected: () => true, sendUpdateDaemonCommand } as never,
    rollout: { isLeaseMember: async () => options.leaseMember === true, enqueue } as never,
    listLongTasks: async () => state.tasks,
    taskWait: { pollMs: 1, timeoutMs: 30 * 60_000, now: () => state.clock },
    ingressWaitFor: vi.fn(async () => [] as never[]),
  };
  return { node, deps, service, state, sendUpdateDaemonCommand, enqueue, events, sqlWrites };
}

describe('daemon update after the availability handoff (rc.6 async pair)', () => {
  it('never restarts the daemon under a primary that kept its role: the update is postponed with the reason', async () => {
    const { deps, sendUpdateDaemonCommand } = harness();
    const beforeRestart = vi.fn(async () => {
      throw new NodeUpdatePostponedError('The update was postponed: the primary of b-pa could not hand over');
    });
    await expect(dispatchNodeDaemonUpdate(NODE_ID, { ...deps, beforeRestart })).rejects.toMatchObject({
      code: 'NODE_UPDATE_POSTPONED',
      message: 'The update was postponed: the primary of b-pa could not hand over',
    });
    expect(sendUpdateDaemonCommand).not.toHaveBeenCalled();
  });

  it('"update now" overrides a postponed handoff and the result says so', async () => {
    const { deps, sendUpdateDaemonCommand, sqlWrites } = harness();
    const beforeRestart = vi.fn(async () => {
      throw new NodeUpdatePostponedError(
        'The update was postponed: the primary of b-pa (rebuild running) could not hand over'
      );
    });
    await dispatchNodeDaemonUpdate(NODE_ID, { ...deps, beforeRestart }, { now: true });
    expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1);
    expect(sqlWrites.length).toBeGreaterThan(0);
  });

  it('goes on after any other handoff failure', async () => {
    const { deps, sendUpdateDaemonCommand } = harness();
    const beforeRestart = vi.fn(async () => {
      throw new Error('relay unreachable');
    });
    await dispatchNodeDaemonUpdate(NODE_ID, { ...deps, beforeRestart });
    expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1);
  });
});

describe('daemon update right after Opfield restarts (O-3)', () => {
  it('waits for a node seen a moment ago to reconnect instead of refusing it', async () => {
    const { node, deps, sendUpdateDaemonCommand } = harness();
    Object.assign(node, { lastSeenAt: new Date() });
    let checks = 0;
    const dispatch = { ...(deps.dispatch as object), isNodeConnected: () => ++checks > 2 };
    await dispatchNodeDaemonUpdate(NODE_ID, { ...deps, dispatch: dispatch as never });
    expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1);
  });

  it('refuses a node that has been away for longer at once', async () => {
    const { node, deps, sendUpdateDaemonCommand } = harness();
    Object.assign(node, { lastSeenAt: new Date(Date.now() - 5 * 60_000) });
    const dispatch = { ...(deps.dispatch as object), isNodeConnected: () => false };
    const started = Date.now();
    await expect(dispatchNodeDaemonUpdate(NODE_ID, { ...deps, dispatch: dispatch as never })).rejects.toMatchObject({
      code: 'NODE_NOT_CONNECTED',
    });
    expect(Date.now() - started).toBeLessThan(400);
    expect(sendUpdateDaemonCommand).not.toHaveBeenCalled();
  });
});

describe('daemon update task wait', () => {
  it('sends at once when the node runs no long task', async () => {
    const { deps, node, sendUpdateDaemonCommand } = harness();
    await expect(dispatchNodeDaemonUpdate(NODE_ID, deps)).resolves.toEqual({
      scheduled: true,
      targetVersion: 'v2.12.1',
    });
    expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1);
    expect(node.metadata.updatePhase).toBe('executing');
  });

  it('waits for the long tasks of the node, shows the ones left, and sends once they end', async () => {
    const { deps, node, state, service, sendUpdateDaemonCommand } = harness({ tasks: [BACKUP, BUILD] });
    const result = await dispatchNodeDaemonUpdate(NODE_ID, deps);
    expect(result).toEqual({ scheduled: true, targetVersion: 'v2.12.1', waitingForTasks: 2 });
    expect(node.metadata.updatePhase).toBe('waiting_for_tasks');
    expect(node.metadata.updateWaitingForTasks).toEqual([BACKUP, BUILD]);
    // Nothing restarted yet: the node takes the commands its tasks need.
    await expect(service.isNodeUpdateInProgress(NODE_ID)).resolves.toBe(false);
    // The metadata deadline outlasts the 30 minute wait.
    expect(Date.parse(String(node.metadata.updateDeadlineAt)) - Date.now()).toBeGreaterThan(30 * 60_000);

    state.tasks = [BUILD];
    await vi.waitFor(() => expect(node.metadata.updateWaitingForTasks).toEqual([BUILD]));
    expect(sendUpdateDaemonCommand).not.toHaveBeenCalled();

    state.tasks = [];
    await vi.waitFor(() => expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1));
    expect(node.metadata.updatePhase).toBe('executing');
    expect(node.metadata.updateWaitingForTasks).toBeUndefined();
    expect(node.metadata.updateWarnings).toBeUndefined();
    await expect(service.isNodeUpdateInProgress(NODE_ID)).resolves.toBe(true);
  });

  it('goes ahead after 30 minutes with a warning that the update result keeps', async () => {
    const { deps, node, state, service, sendUpdateDaemonCommand } = harness({ tasks: [BACKUP] });
    await dispatchNodeDaemonUpdate(NODE_ID, deps);
    state.clock += 30 * 60_000;
    await vi.waitFor(() => expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1));
    expect(node.metadata.updateWarnings).toEqual([
      'Updated after waiting 30 min while 1 running task (Backup of orders) still ran',
    ]);

    await expect(service.clearNodeUpdateInProgressOnReconnect(NODE_ID, 'v2.12.1')).resolves.toBe(true);
    expect(node.metadata.updateInProgress).toBeUndefined();
    expect(node.metadata.updateWarnings).toBeUndefined();
    expect(node.metadata.lastUpdate).toEqual({
      targetVersion: 'v2.12.1',
      completedAt: expect.any(String),
      warnings: ['Updated after waiting 30 min while 1 running task (Backup of orders) still ran'],
    });
  });

  it('"update now" ends the wait of a waiting update and keeps why it went ahead', async () => {
    const { deps, node, sendUpdateDaemonCommand } = harness({ tasks: [BACKUP] });
    await dispatchNodeDaemonUpdate(NODE_ID, deps);
    expect(sendUpdateDaemonCommand).not.toHaveBeenCalled();

    await expect(dispatchNodeDaemonUpdate(NODE_ID, deps, { now: true })).resolves.toEqual({
      scheduled: true,
      targetVersion: 'v2.12.1',
      waitSkipped: true,
    });
    await vi.waitFor(() => expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1));
    expect(node.metadata.updatePhase).toBe('executing');
    expect(node.metadata.updateNow).toBeUndefined();
    expect(node.metadata.updateWarnings).toEqual(['Updated on request while 1 running task (Backup of orders) ran']);
  });

  it('"update now" does not wait at all for a new update', async () => {
    const { deps, node, sendUpdateDaemonCommand } = harness({ tasks: [BACKUP] });
    await expect(dispatchNodeDaemonUpdate(NODE_ID, deps, { now: true })).resolves.toEqual({
      scheduled: true,
      targetVersion: 'v2.12.1',
    });
    expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1);
    expect(node.metadata.updateWarnings).toEqual(['Updated on request while 1 running task (Backup of orders) ran']);
  });

  it('"update now" does not wait for the lease peers of a new update and says so', async () => {
    const { deps, node, enqueue, sendUpdateDaemonCommand } = harness({ leaseMember: true });
    await expect(dispatchNodeDaemonUpdate(NODE_ID, deps, { now: true })).resolves.toEqual({
      scheduled: true,
      targetVersion: 'v2.12.1',
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1);
    expect(node.metadata.updateWarnings).toEqual(['Updated on request without waiting for its lease peers']);
  });

  it('"update now" ends the wait of an update queued for its lease peers', async () => {
    const { deps, node, enqueue } = harness({ leaseMember: true });
    let queued: { run: () => Promise<void> } | null = null;
    enqueue.mockImplementation(async (request: { run: () => Promise<void> }) => {
      queued = request;
    });
    const releaseWait = vi.fn(() => {
      void queued?.run();
      return true;
    });
    Object.assign(deps.rollout as object, { releaseWait });
    await dispatchNodeDaemonUpdate(NODE_ID, deps);
    expect(node.metadata.updatePhase).toBe('waiting_for_lease_peers');
    node.metadata.updateWaitingFor = [{ memberId: 'peer', policyId: 'p', reason: 'availability_catching_up' }];

    await expect(dispatchNodeDaemonUpdate(NODE_ID, deps, { now: true })).resolves.toEqual({
      scheduled: true,
      targetVersion: 'v2.12.1',
      waitSkipped: true,
    });
    expect(releaseWait).toHaveBeenCalledWith(NODE_ID);
    await vi.waitFor(() => expect(node.metadata.updatePhase).toBe('executing'));
    expect(node.metadata.updateWarnings).toEqual([
      'Updated on request without waiting for its lease peers (peer availability_catching_up)',
    ]);
  });

  it('"update now" during the task wait of a lease member skips its lease peers too', async () => {
    const { deps, node, enqueue, sendUpdateDaemonCommand } = harness({ tasks: [BACKUP], leaseMember: true });
    await dispatchNodeDaemonUpdate(NODE_ID, deps);
    await dispatchNodeDaemonUpdate(NODE_ID, deps, { now: true });
    await vi.waitFor(() => expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1));
    expect(enqueue).not.toHaveBeenCalled();
    expect(node.metadata.updateWarnings).toEqual([
      'Updated on request while 1 running task (Backup of orders) ran',
      'Updated on request without waiting for its lease peers',
    ]);
  });

  it('sends an ingress node through the rollout queue, where it waits for the other nodes of its batch', async () => {
    const { deps, node, enqueue, sendUpdateDaemonCommand } = harness({ type: 'nginx' });
    await expect(dispatchNodeDaemonUpdate(NODE_ID, deps)).resolves.toEqual({
      scheduled: true,
      targetVersion: 'v2.12.1',
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const request = (enqueue.mock.calls[0] as unknown as [{ waitFor?: () => Promise<unknown> }])[0];
    await request.waitFor?.();
    expect(deps.ingressWaitFor).toHaveBeenCalledWith(NODE_ID);
    await vi.waitFor(() => expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1));
    expect(node.metadata.updatePhase).toBe('executing');
  });

  it('lets an ingress node wait for the other nodes whose update restarts them now or soon', async () => {
    const rows = [
      { id: 'executing', metadata: { updateInProgress: true, updatePhase: 'executing' } },
      { id: 'reconnecting', metadata: { updateInProgress: true, updatePhase: 'reconnecting' } },
      { id: 'queued', metadata: { updateInProgress: true, updatePhase: 'waiting_for_lease_peers' } },
      // Restarts later, on its own, once its tasks end.
      { id: 'tasks', metadata: { updateInProgress: true, updatePhase: 'waiting_for_tasks' } },
    ];
    const query: any = Promise.resolve(rows);
    query.from = () => query;
    query.where = () => query;
    const blockers = await batchUpdatesBefore({ select: () => query } as never, NODE_ID);
    expect(blockers).toEqual(
      ['executing', 'reconnecting', 'queued'].map((memberId) => ({ memberId, policyId: '', reason: 'ingress_last' }))
    );
  });

  it('keeps other nodes that are no lease members on the fast path', async () => {
    const { deps, enqueue, sendUpdateDaemonCommand } = harness({ type: 'docker' });
    await dispatchNodeDaemonUpdate(NODE_ID, deps);
    expect(enqueue).not.toHaveBeenCalled();
    expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1);
  });

  it('waits for tasks first, then for lease peers', async () => {
    const { deps, node, state, enqueue, sendUpdateDaemonCommand } = harness({ tasks: [BACKUP], leaseMember: true });
    const result = await dispatchNodeDaemonUpdate(NODE_ID, deps);
    expect(result.waitingForTasks).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
    state.tasks = [];
    await vi.waitFor(() => expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(node.metadata.updatePhase).toBe('executing');
  });

  it('takes a waiting update up again after an Opfield restart, bounded from when its wait began', async () => {
    const startedAt = new Date(Date.now() - 40 * 60_000);
    const { deps, node, sendUpdateDaemonCommand } = harness({
      tasks: [BACKUP],
      metadata: {
        updateInProgress: true,
        updateOperationId: 'before-restart',
        updateTargetVersion: 'v2.12.1',
        updateStartedAt: startedAt.toISOString(),
        updatePhase: 'waiting_for_tasks',
        updateTaskWaitStartedAt: startedAt.toISOString(),
        updateWaitingForTasks: [BACKUP],
        updateDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    await expect(resumeQueuedDaemonUpdates(deps, new Date())).resolves.toBe(1);
    // The 30 minutes ran out during the restart: the update goes ahead with its warning.
    await vi.waitFor(() => expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1));
    expect(node.metadata.updateWarnings).toEqual([
      'Updated after waiting 30 min while 1 running task (Backup of orders) still ran',
    ]);
  });

  it('does not wait for tasks again for an update that was waiting for its lease peers', async () => {
    const { deps, node, sendUpdateDaemonCommand } = harness({
      tasks: [BACKUP],
      leaseMember: true,
      metadata: {
        updateInProgress: true,
        updateOperationId: 'before-restart',
        updateTargetVersion: 'v2.12.1',
        updateStartedAt: new Date(Date.now() - 60_000).toISOString(),
        updatePhase: 'waiting_for_lease_peers',
        updateWarnings: ['Updated on request while 1 running task (Backup of orders) ran'],
        updateDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    await expect(resumeQueuedDaemonUpdates(deps, new Date())).resolves.toBe(1);
    await vi.waitFor(() => expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1));
    expect(node.metadata.updateWarnings).toEqual(['Updated on request while 1 running task (Backup of orders) ran']);
  });
});

describe('connections of the last update', () => {
  const report = {
    fromVersion: 'v2.12.0',
    toVersion: 'v2.12.1',
    startedAtUnixMs: 1_800_000_000_000,
    finishedAtUnixMs: 1_800_000_004_000,
    handover: true,
    handedOver: 40,
    kept: 38,
    cut: { raw_stream: 2 },
    pauseP50Ms: 900,
    pauseP99Ms: 1800,
    pauseMaxMs: 2100,
  };

  it('records a final report of the completed update once', async () => {
    const { service, sqlWrites, events } = harness({
      metadata: { lastUpdate: { targetVersion: 'v2.12.1', completedAt: '2027-01-15T08:00:00.000Z', warnings: [] } },
    });
    await expect(service.recordLastUpdateConnections(NODE_ID, report)).resolves.toBe(true);
    expect(sqlWrites).toHaveLength(1);
    expect(events).toEqual([{ id: NODE_ID, action: 'updated' }]);
    // Later health reports repeat it: no read, no write.
    await expect(service.recordLastUpdateConnections(NODE_ID, report)).resolves.toBe(false);
    expect(sqlWrites).toHaveLength(1);
  });

  it('keeps the counts by class and pauses, and skips reports already kept or of another update', () => {
    const lastUpdate = { targetVersion: '2.12.1', completedAt: '2027-01-15T08:00:00.000Z', warnings: [] };
    const connections = lastUpdateConnectionsToRecord({ lastUpdate }, report);
    expect(connections).toEqual({
      fromVersion: 'v2.12.0',
      toVersion: 'v2.12.1',
      finishedAtUnixMs: 1_800_000_004_000,
      handover: true,
      handedOver: 40,
      kept: 38,
      cut: { raw_stream: 2 },
      pauseP50Ms: 900,
      pauseP99Ms: 1800,
      pauseMaxMs: 2100,
    });
    expect(lastUpdateConnectionsToRecord({ lastUpdate: { ...lastUpdate, connections } }, report)).toBe('skip');
    expect(lastUpdateConnectionsToRecord({ lastUpdate: { ...lastUpdate, targetVersion: 'v2.12.0' } }, report)).toBe(
      'skip'
    );
    // The daemon reports before Opfield saw it register on the target: try again with the next report.
    expect(lastUpdateConnectionsToRecord({ updateInProgress: true, updateTargetVersion: 'v2.12.1' }, report)).toBe(
      'pending'
    );
  });

  it('keeps a report of something later on the same version away from an older result', () => {
    const lastUpdate = { targetVersion: 'v2.12.1', completedAt: '2027-01-15T08:00:00.000Z', warnings: [] };
    const later = { ...report, startedAtUnixMs: Date.parse('2027-01-15T18:30:00.000Z') };
    expect(lastUpdateConnectionsToRecord({ lastUpdate }, later)).toBe('skip');
  });

  // Stand rc.8 O-2: an update rc.7 -> rc.8 rolled back; the restored rc.7 cut every link connection of its workloads
  // (rc.7's start order) and reported them kept, and the report landed on the result of the update to rc.7 ten hours
  // before.
  it('records a rollback as the result, with what the previous daemon cannot account for as cut', async () => {
    const { service, node, sqlWrites } = harness({
      metadata: {
        lastUpdate: { targetVersion: 'v2.11.4-rc.7', completedAt: '2026-10-09T10:10:13.000Z', warnings: [] },
        updateInProgress: true,
        updateOperationId: 'op-1',
        updateTargetVersion: 'v2.11.4-rc.8',
        updatePhase: 'reconnecting',
        updateReconnectStartedAt: '2026-10-09T20:36:05.000Z',
      },
    });
    const rolledBack = {
      fromVersion: 'v2.11.4-rc.8',
      toVersion: 'v2.11.4-rc.7',
      startedAtUnixMs: Date.parse('2026-10-09T20:39:05.459Z'),
      finishedAtUnixMs: Date.parse('2026-10-09T20:39:09.000Z'),
      handover: true,
      handedOver: 37,
      kept: 37,
      cut: {},
      pauseP50Ms: 1000,
      pauseP99Ms: 1300,
      pauseMaxMs: 1300,
    };
    // Its report comes while Opfield still waits for the update: it may belong to it.
    await expect(service.recordLastUpdateConnections(NODE_ID, rolledBack)).resolves.toBe(false);
    const cameBack = new Date('2026-10-09T20:39:08.000Z');
    await expect(service.clearNodeUpdateInProgressOnReconnect(NODE_ID, 'v2.11.4-rc.7', cameBack)).resolves.toBe(true);
    expect(node.metadata.updateInProgress).toBeUndefined();
    expect(String(node.metadata.updateLastError)).toContain('rolled back');
    expect(node.metadata.lastUpdate).toEqual({
      targetVersion: 'v2.11.4-rc.8',
      rolledBackTo: 'v2.11.4-rc.7',
      completedAt: cameBack.toISOString(),
      warnings: [],
    });
    expect(lastUpdateConnectionsToRecord(node.metadata, rolledBack)).toEqual({
      fromVersion: 'v2.11.4-rc.8',
      toVersion: 'v2.11.4-rc.7',
      finishedAtUnixMs: rolledBack.finishedAtUnixMs,
      handover: true,
      handedOver: 37,
      kept: 0,
      cut: { unverified: 37 },
      pauseP50Ms: 0,
      pauseP99Ms: 0,
      pauseMaxMs: 0,
    });
    await expect(service.recordLastUpdateConnections(NODE_ID, rolledBack)).resolves.toBe(true);
    expect(sqlWrites).toHaveLength(1);
    // A rollback to a daemon that accounts for its connections keeps its counts.
    const accounted = {
      ...rolledBack,
      fromVersion: 'v2.11.5',
      toVersion: 'v2.11.4',
      kept: 30,
      cut: { local_closed: 7 },
    };
    const record = {
      lastUpdate: { targetVersion: 'v2.11.5', rolledBackTo: 'v2.11.4', completedAt: cameBack.toISOString() },
    };
    expect(lastUpdateConnectionsToRecord(record, accounted)).toMatchObject({ kept: 30, cut: { local_closed: 7 } });
  });

  // Stand rc.9 O-4: the sessions a replaced Secure Link connector carried when it was removed an hour after a Relay
  // Pool update were booked on the node's last daemon update record, whose finish moved to the removal.
  it('keeps a connector replacement as its own entry and never changes the recorded update', async () => {
    const { service, node, sqlWrites } = harness({
      metadata: { lastUpdate: { targetVersion: 'v2.12.1', completedAt: '2027-01-15T08:00:00.000Z', warnings: [] } },
    });
    const connections = lastUpdateConnectionsToRecord(node.metadata, report);
    expect(connections).toMatchObject({ cut: { raw_stream: 2 }, finishedAtUnixMs: report.finishedAtUnixMs });
    node.metadata = { lastUpdate: { ...(node.metadata.lastUpdate as object), connections } };
    const retired = {
      ...report,
      finishedAtUnixMs: report.finishedAtUnixMs + 3_600_000,
      cut: { raw_stream: 2, connector_retired: 46 },
    };
    expect(lastUpdateConnectionsToRecord(node.metadata, retired)).toBe('skip');
    expect(connectorReplacementToRecord(node.metadata, retired)).toEqual({
      at: new Date(retired.finishedAtUnixMs).toISOString(),
      connectionsCut: 46,
      daemonVersion: 'v2.12.1',
    });
    await expect(service.recordLastUpdateConnections(NODE_ID, retired)).resolves.toBe(true);
    expect(sqlWrites).toHaveLength(1);
    const written = sqlWrites[0]!.queryChunks.map((chunk) => (chunk as { value?: string[] }).value?.join('') ?? '');
    expect(written.join('')).toContain('lastConnectorReplacement');
    const kept = { at: new Date(retired.finishedAtUnixMs).toISOString(), connectionsCut: 46 };
    expect(connectorReplacementToRecord({ lastConnectorReplacement: kept }, retired)).toBe('skip');
    // An update's first report that already carries one: the update's own counts leave it out.
    const fresh = { lastUpdate: { targetVersion: 'v2.12.1', completedAt: '2027-01-15T08:00:00.000Z', warnings: [] } };
    expect(lastUpdateConnectionsToRecord(fresh, retired)).toMatchObject({ cut: { raw_stream: 2 } });
    const freshCut = (lastUpdateConnectionsToRecord(fresh, retired) as { cut: object }).cut;
    expect(freshCut).not.toHaveProperty('connector_retired');
  });

  // rc.10 upgrade run, F-2: a 2.11.3 daemon writes no report, so the update to 2.11.4 that cut every Secure Link stream
  // showed no kept/cut line at all.
  it('records an update from a daemon without live handover as cutting all connections of the node', async () => {
    const { deps, node, service } = harness({ daemonVersion: 'v2.11.3', capabilities: { architecture: 'amd64' } });
    await dispatchNodeDaemonUpdate(NODE_ID, deps);
    expect(node.metadata).toMatchObject({ updateFromVersion: 'v2.11.3', updateFromHandover: false });
    const cameBack = new Date();
    await expect(service.clearNodeUpdateInProgressOnReconnect(NODE_ID, 'v2.12.1', cameBack)).resolves.toBe(true);
    expect(node.metadata.lastUpdate).toEqual({
      targetVersion: 'v2.12.1',
      completedAt: cameBack.toISOString(),
      warnings: [],
      connections: {
        fromVersion: 'v2.11.3',
        toVersion: 'v2.12.1',
        finishedAtUnixMs: cameBack.getTime(),
        handover: false,
        handedOver: 0,
        kept: 0,
        cut: { uncounted: 1 },
        pauseP50Ms: 0,
        pauseP99Ms: 0,
        pauseMaxMs: 0,
      },
    });
    expect(node.metadata).not.toHaveProperty('updateFromVersion');
    expect(node.metadata).not.toHaveProperty('updateFromHandover');
    // A report the new daemon kept from an earlier update does not replace it.
    const stale = { ...report, toVersion: 'v2.12.1', finishedAtUnixMs: cameBack.getTime() - 60_000 };
    expect(lastUpdateConnectionsToRecord(node.metadata, stale)).toBe('skip');
  });

  // rc.10 upgrade run F-3 with F-2: the new daemon restarts its whole service once right after the update from 2.11.3
  // and reports that restart as the same update. The record keeps both cuts: one story, not two updates.
  it('adds the service restart right after an update from a daemon without live handover to its record', async () => {
    const { deps, node, service } = harness({ daemonVersion: 'v2.11.3', capabilities: { architecture: 'amd64' } });
    await dispatchNodeDaemonUpdate(NODE_ID, deps);
    const cameBack = new Date();
    await expect(service.clearNodeUpdateInProgressOnReconnect(NODE_ID, 'v2.12.1', cameBack)).resolves.toBe(true);
    const restart = {
      fromVersion: 'v2.11.3',
      toVersion: 'v2.12.1',
      startedAtUnixMs: cameBack.getTime() + 4 * 60_000,
      finishedAtUnixMs: cameBack.getTime() + 4 * 60_000 + 3_000,
      handover: false,
      handedOver: 0,
      kept: 0,
      cut: { service_restart: 12, connector_retired: 3 },
      pauseP50Ms: 0,
      pauseP99Ms: 0,
      pauseMaxMs: 0,
    };
    const connections = lastUpdateConnectionsToRecord(node.metadata, restart);
    expect(connections).toEqual({
      fromVersion: 'v2.11.3',
      toVersion: 'v2.12.1',
      finishedAtUnixMs: restart.finishedAtUnixMs,
      handover: false,
      handedOver: 0,
      kept: 0,
      cut: { uncounted: 1, service_restart: 12 },
      pauseP50Ms: 0,
      pauseP99Ms: 0,
      pauseMaxMs: 0,
    });
    await expect(service.recordLastUpdateConnections(NODE_ID, restart)).resolves.toBe(true);
    const merged = { lastUpdate: { ...(node.metadata.lastUpdate as object), connections } };
    // Once merged, the same report or a later one of this update changes nothing.
    expect(lastUpdateConnectionsToRecord(merged, restart)).toBe('skip');
    expect(
      lastUpdateConnectionsToRecord(merged, { ...restart, finishedAtUnixMs: restart.finishedAtUnixMs + 60_000 })
    ).toBe('skip');
    // A report of another update, or without a service restart, does not join the record.
    expect(lastUpdateConnectionsToRecord(node.metadata, { ...restart, fromVersion: 'v2.12.0' })).toBe('skip');
    expect(lastUpdateConnectionsToRecord(node.metadata, { ...restart, cut: { raw_stream: 2 } })).toBe('skip');
  });

  it('leaves the counts to the daemon when the one updated from hands connections over', async () => {
    const { deps, node, service } = harness();
    await dispatchNodeDaemonUpdate(NODE_ID, deps);
    expect(node.metadata).toMatchObject({ updateFromVersion: 'v2.12.0', updateFromHandover: true });
    await expect(service.clearNodeUpdateInProgressOnReconnect(NODE_ID, 'v2.12.1')).resolves.toBe(true);
    expect(node.metadata.lastUpdate).not.toHaveProperty('connections');
    const fresh = { ...report, startedAtUnixMs: Date.now(), finishedAtUnixMs: Date.now() + 5_000 };
    expect(lastUpdateConnectionsToRecord(node.metadata, fresh)).toMatchObject({ kept: 38 });
  });

  it('records a rollback onto a daemon without live handover as cutting all connections', async () => {
    const { deps, node, service } = harness({ daemonVersion: 'v2.11.3', capabilities: { architecture: 'amd64' } });
    await dispatchNodeDaemonUpdate(NODE_ID, deps);
    node.metadata.updatePhase = 'reconnecting';
    node.metadata.updateReconnectStartedAt = new Date(Date.now() - 1_000).toISOString();
    const cameBack = new Date();
    await expect(service.clearNodeUpdateInProgressOnReconnect(NODE_ID, 'v2.11.3', cameBack)).resolves.toBe(true);
    expect(node.metadata.lastUpdate).toMatchObject({
      targetVersion: 'v2.12.1',
      rolledBackTo: 'v2.11.3',
      connections: { fromVersion: 'v2.12.1', toVersion: 'v2.11.3', kept: 0, cut: { uncounted: 1 } },
    });
  });

  it('waits for the update to complete before it records its report', async () => {
    const { service, sqlWrites, node } = harness({
      metadata: { updateInProgress: true, updateTargetVersion: 'v2.12.1', updatePhase: 'reconnecting' },
    });
    await expect(service.recordLastUpdateConnections(NODE_ID, report)).resolves.toBe(false);
    node.metadata = { lastUpdate: { targetVersion: 'v2.12.1', completedAt: '2027-01-15T08:00:00.000Z', warnings: [] } };
    await expect(service.recordLastUpdateConnections(NODE_ID, report)).resolves.toBe(true);
    expect(sqlWrites).toHaveLength(1);
  });
});

describe('daemon update reconnect deadline', () => {
  it('waits for the daemon at least as long as its launcher keeps the new daemon on trial', async () => {
    const { service, node } = harness({
      metadata: {
        updateInProgress: true,
        updateOperationId: 'op-1',
        updateTargetVersion: 'v2.12.1',
        updatePhase: 'executing',
      },
    });
    service.trackNodeUpdateCompletion(NODE_ID, 'op-1', Promise.resolve({ commandId: 'c', success: true } as never));
    await vi.waitFor(() => expect(node.metadata.updatePhase).toBe('reconnecting'));
    // A rollback after the launcher's trial (3.5 min) must find the update still waiting, not failed and offline.
    expect(Date.parse(String(node.metadata.updateDeadlineAt)) - Date.now()).toBeGreaterThan(
      LAUNCHER_CANDIDATE_TRIAL_LIMIT_MS + 30_000
    );
  });
});

describe('a failed daemon update stays visible and is not repeated at once', () => {
  const DOWNLOAD_FAILURE =
    'download binary: Get "https://get.opfield.dev/opfield/docker-daemon/v2.12.1-docker/docker-daemon-linux-amd64": dial tcp 172.67.129.110:443: i/o timeout';

  it('keeps why and for which release, lists it with the node, and refuses the same release for a minute', async () => {
    const { deps, node, service, sendUpdateDaemonCommand } = harness();
    sendUpdateDaemonCommand.mockImplementationOnce(async () => ({
      accepted: Promise.resolve(),
      result: Promise.resolve({ success: false, error: DOWNLOAD_FAILURE, detail: '', commandId: '' }) as never,
    }));
    await dispatchNodeDaemonUpdate(NODE_ID, deps);
    await vi.waitFor(() => expect(node.metadata.updateLastError).toBe(DOWNLOAD_FAILURE));
    expect(node.metadata.updateLastErrorTargetVersion).toBe('v2.12.1');
    expect(node.metadata.updateInProgress).toBeUndefined();

    const docker = (await service.getCachedStatus()).find((status) => status.daemonType === 'docker');
    expect(docker?.nodes[0]?.lastUpdateError).toMatchObject({
      message: DOWNLOAD_FAILURE,
      targetVersion: 'v2.12.1',
      at: expect.any(String),
    });

    await expect(dispatchNodeDaemonUpdate(NODE_ID, deps)).rejects.toMatchObject({
      code: 'DAEMON_UPDATE_RETRY_TOO_SOON',
      message: expect.stringContaining('i/o timeout'),
    });
    expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1);

    node.metadata.updateLastErrorAt = new Date(Date.now() - 61_000).toISOString();
    await dispatchNodeDaemonUpdate(NODE_ID, deps);
    expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(2);
    // A new attempt clears the old reason.
    expect(node.metadata.updateLastError).toBeUndefined();
    expect(node.metadata.updateLastErrorTargetVersion).toBeUndefined();
  });

  it('forgets a failure once the node runs that release, and shows none while an update runs', () => {
    const failed = {
      updateLastError: 'x',
      updateLastErrorAt: '2026-10-18T20:58:01.762Z',
      updateLastErrorTargetVersion: 'v2.12.6',
    };
    expect(nodeUpdateFailure(failed, 'v2.12.3')).toEqual({
      message: 'x',
      at: '2026-10-18T20:58:01.762Z',
      targetVersion: 'v2.12.6',
    });
    expect(nodeUpdateFailure(failed, 'v2.12.6')).toBeNull();
    expect(nodeUpdateFailure({ ...failed, updateInProgress: true }, 'v2.12.3')).toBeNull();
    // Records from before 2.12.7 carry no release: shown until the next update.
    expect(nodeUpdateFailure({ updateLastError: 'x' }, 'v2.12.6')).toMatchObject({ targetVersion: null });
  });
});
