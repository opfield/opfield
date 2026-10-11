import { describe, expect, it, vi } from 'vitest';
import type { LeaseUpdatePeerState, LeaseUpdateView } from './daemon-update-lease-gate.js';
import { DaemonUpdateRollout, DaemonUpdateWaitTimeoutError } from './daemon-update-rollout.service.js';

/**
 * A fake lease state: members restart when their update runs (updating -> back without a report -> abstaining ->
 * settled), driven by `advance`.
 */
function fakeCluster(policies: Record<string, string[]>, holders: string[] = []) {
  const clock = { t: 1_800_000_000_000 };
  const states = new Map<string, LeaseUpdatePeerState>();
  for (const members of Object.values(policies))
    for (const id of members)
      states.set(id, { updating: false, since: clock.t - 3_600_000, reportedAt: clock.t, abstaining: false });
  const view = (): LeaseUpdateView => ({
    topology: {
      policyMembers: new Map(Object.entries(policies).map(([id, members]) => [id, new Set(members)])),
      holders: new Set(holders),
    },
    states: new Map([...states].map(([id, state]) => [id, { ...state }])),
  });
  const set = (id: string, patch: Partial<LeaseUpdatePeerState>) => states.set(id, { ...states.get(id)!, ...patch });
  return { clock, view, set, now: () => clock.t };
}

/** Passes run only when a test calls runPass. */
const manualPasses = { coalesceMs: 2 ** 30, pollMs: 2 ** 30 };

describe('DaemonUpdateRollout', () => {
  it('sends updates of members of no lease policy through the fast path', async () => {
    const cluster = fakeCluster({ checkout: ['d1', 'd2', 'witness'] });
    const rollout = new DaemonUpdateRollout({
      loadView: async () => cluster.view(),
      now: cluster.now,
      ...manualPasses,
    });
    await expect(rollout.isLeaseMember('nginx-1')).resolves.toBe(false);
    await expect(rollout.isLeaseMember('storage-1')).resolves.toBe(false);
    await expect(rollout.isLeaseMember('d1')).resolves.toBe(true);
    await expect(rollout.isLeaseMember('witness')).resolves.toBe(true);
  });

  it('restarts one member of a policy at a time and the next only once the first votes again', async () => {
    const cluster = fakeCluster({ checkout: ['d1', 'd2', 'witness'] });
    const rollout = new DaemonUpdateRollout({
      loadView: async () => cluster.view(),
      now: cluster.now,
      ...manualPasses,
    });
    const order: string[] = [];
    const run = (id: string) => async () => {
      order.push(id);
      cluster.set(id, { updating: true });
    };
    const waits: string[] = [];
    const d1 = rollout.enqueue({ memberId: 'd1', run: run('d1') });
    const d2 = rollout.enqueue({
      memberId: 'd2',
      run: run('d2'),
      onWait: (blockers) => void waits.push(blockers.map((b) => `${b.memberId}:${b.reason}`).join(',')),
    });

    await rollout.runPass();
    await d1;
    expect(order).toEqual(['d1']);

    // d1 restarts, reconnects without a lease report, then abstains (first start from an rc.19 store).
    cluster.clock.t += 12_000;
    await rollout.runPass();
    cluster.set('d1', { updating: false, since: cluster.clock.t, reportedAt: cluster.clock.t - 13_000 });
    await rollout.runPass();
    cluster.clock.t += 2_000;
    cluster.set('d1', { reportedAt: cluster.clock.t, abstaining: true });
    await rollout.runPass();
    expect(order).toEqual(['d1']);

    cluster.clock.t += 33_000;
    cluster.set('d1', { reportedAt: cluster.clock.t, abstaining: false });
    await rollout.runPass();
    await d2;
    expect(order).toEqual(['d1', 'd2']);
    expect(waits).toEqual(['d1:updating', 'd1:reconnecting', 'd1:abstaining']);
  });

  it('updates standbys before the holder of a policy', async () => {
    const cluster = fakeCluster({ hafo: ['app-node-2', 'app-node-1', 'secure-node-1'] }, ['app-node-2']);
    const rollout = new DaemonUpdateRollout({
      loadView: async () => cluster.view(),
      now: cluster.now,
      ...manualPasses,
    });
    const order: string[] = [];
    const settleAll = () => {
      for (const id of ['app-node-2', 'app-node-1', 'secure-node-1'])
        cluster.set(id, { updating: false, since: cluster.clock.t - 60_000, reportedAt: cluster.clock.t });
    };
    const requests = ['app-node-2', 'app-node-1', 'secure-node-1'].map((id) =>
      rollout.enqueue({
        memberId: id,
        run: async () => {
          order.push(id);
          cluster.set(id, { updating: true });
        },
      })
    );
    for (let pass = 0; pass < 3; pass += 1) {
      await rollout.runPass();
      cluster.clock.t += 60_000;
      settleAll();
    }
    await Promise.all(requests);
    expect(order).toEqual(['app-node-1', 'secure-node-1', 'app-node-2']);
  });

  it('updates members that share no policy in the same pass', async () => {
    const cluster = fakeCluster({ checkout: ['d1', 'd2', 'r1'], hafo: ['a1', 'a2', 'r2'] });
    const rollout = new DaemonUpdateRollout({
      loadView: async () => cluster.view(),
      now: cluster.now,
      ...manualPasses,
    });
    const order: string[] = [];
    const requests = ['d1', 'a1', 'd2'].map((id) =>
      rollout.enqueue({ memberId: id, run: async () => void order.push(id) })
    );
    await rollout.runPass();
    expect([...order].sort()).toEqual(['a1', 'd1']);
    cluster.clock.t += 1_000;
    await rollout.runPass();
    await Promise.all(requests);
    expect(order.slice(2)).toEqual(['d2']);
  });

  it('gives up with a clear error when the peers never settle', async () => {
    const cluster = fakeCluster({ checkout: ['d1', 'd2'] });
    cluster.set('d1', { updating: true });
    const rollout = new DaemonUpdateRollout({
      loadView: async () => cluster.view(),
      now: cluster.now,
      ...manualPasses,
    });
    const run = vi.fn();
    const waiting = rollout.enqueue({ memberId: 'd2', run, timeoutMs: 60_000 });
    await rollout.runPass();
    cluster.clock.t += 60_000;
    await rollout.runPass();
    await expect(waiting).rejects.toBeInstanceOf(DaemonUpdateWaitTimeoutError);
    await expect(waiting).rejects.toThrow('d1 updating');
    expect(run).not.toHaveBeenCalled();
    expect(rollout.pending()).toEqual([]);
  });

  it('lets a waiting request go at once on the operator\'s "update now"', async () => {
    const cluster = fakeCluster({ checkout: ['d1', 'd2'] });
    cluster.set('d1', { updating: true });
    const rollout = new DaemonUpdateRollout({
      loadView: async () => cluster.view(),
      now: cluster.now,
      ...manualPasses,
    });
    const run = vi.fn();
    const waiting = rollout.enqueue({ memberId: 'd2', run });
    await rollout.runPass();
    expect(run).not.toHaveBeenCalled();
    expect(rollout.releaseWait('d9')).toBe(false);
    expect(rollout.releaseWait('d2')).toBe(true);
    await waiting;
    expect(run).toHaveBeenCalledTimes(1);
    expect(rollout.pending()).toEqual([]);
  });

  it('drops a waiting request when its rollout is abandoned', async () => {
    const cluster = fakeCluster({ checkout: ['d1', 'r1'] });
    cluster.set('d1', { updating: true });
    const rollout = new DaemonUpdateRollout({
      loadView: async () => cluster.view(),
      now: cluster.now,
      ...manualPasses,
    });
    const abort = new AbortController();
    const waiting = rollout.enqueue({ memberId: 'r1', run: vi.fn(), signal: abort.signal });
    abort.abort();
    await expect(waiting).rejects.toThrow('abandoned');
    expect(rollout.pending()).toEqual([]);
  });

  it('lets an ingress node of a batch restart only after the other nodes finished their updates', async () => {
    const cluster = fakeCluster({ checkout: ['d1', 'd2', 'witness'] });
    const rollout = new DaemonUpdateRollout({
      loadView: async () => cluster.view(),
      now: cluster.now,
      ...manualPasses,
    });
    // app-node-1 restarts now (no lease member); d1 is queued as a lease member (its update shows in progress).
    const updating = new Set(['app-node-1', 'd1']);
    const order: string[] = [];
    const waits: string[] = [];
    const ingress = rollout.enqueue({
      memberId: 'ingress-1',
      run: async () => void order.push('ingress-1'),
      waitFor: async () =>
        [...updating].map((memberId) => ({ memberId, policyId: '', reason: 'ingress_last' as const })),
      onWait: (blockers) => void waits.push(blockers.map((b) => `${b.memberId}:${b.reason}`).join(',')),
    });
    const d1 = rollout.enqueue({
      memberId: 'd1',
      run: async () => {
        order.push('d1');
        cluster.set('d1', { updating: true });
      },
    });
    await rollout.runPass();
    await d1;
    expect(order).toEqual(['d1']);
    expect(waits).toEqual(['app-node-1:ingress_last,d1:ingress_last']);

    updating.delete('app-node-1');
    await rollout.runPass();
    expect(order).toEqual(['d1']);

    updating.delete('d1');
    await rollout.runPass();
    await ingress;
    expect(order).toEqual(['d1', 'ingress-1']);
  });

  it('runs an ingress node with nothing else updating at once, and past its timeout without waiting more', async () => {
    const cluster = fakeCluster({});
    const rollout = new DaemonUpdateRollout({
      loadView: async () => cluster.view(),
      now: cluster.now,
      ...manualPasses,
    });
    const alone = vi.fn(async () => undefined);
    const first = rollout.enqueue({ memberId: 'ingress-1', run: alone, waitFor: async () => [] });
    await rollout.runPass();
    await first;
    expect(alone).toHaveBeenCalledTimes(1);

    const stuck = vi.fn(async () => undefined);
    const second = rollout.enqueue({
      memberId: 'ingress-2',
      run: stuck,
      timeoutMs: 60_000,
      waitFor: async () => [{ memberId: 'app-node-1', policyId: '', reason: 'ingress_last' }],
    });
    await rollout.runPass();
    expect(stuck).not.toHaveBeenCalled();
    cluster.clock.t += 60_000;
    await rollout.runPass();
    await second;
    expect(stuck).toHaveBeenCalledTimes(1);
  });

  it('waits after a relay restart until it reports an acceptor that votes, bounded', async () => {
    const cluster = fakeCluster({ checkout: ['d1', 'd2', 'r1'] });
    const since = cluster.clock.t;
    cluster.set('r1', { since: null, reportedAt: since - 5_000 });
    const sleeps: number[] = [];
    const rollout = new DaemonUpdateRollout({
      loadView: async () => cluster.view(),
      now: cluster.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        cluster.clock.t += ms;
        if (cluster.clock.t - since >= 10_000) cluster.set('r1', { reportedAt: cluster.clock.t, abstaining: true });
        if (cluster.clock.t - since >= 40_000) cluster.set('r1', { reportedAt: cluster.clock.t, abstaining: false });
      },
    });
    await expect(rollout.awaitSettled('r1', since)).resolves.toBe('settled');
    expect(cluster.clock.t - since).toBeGreaterThanOrEqual(40_000);

    cluster.set('r1', { reportedAt: cluster.clock.t, abstaining: true });
    const stuck = new DaemonUpdateRollout({
      loadView: async () => cluster.view(),
      now: cluster.now,
      sleep: async (ms) => void (cluster.clock.t += ms),
    });
    await expect(stuck.awaitSettled('r1', cluster.clock.t)).resolves.toBe('timed_out');
    await expect(stuck.awaitSettled('not-a-member', cluster.clock.t)).resolves.toBe('settled');
  });
});
