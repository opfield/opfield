import { describe, expect, it } from 'vitest';
import {
  bootstrapAcknowledged,
  bootstrapFromHolders,
  bootstrapFromServing,
  classifyLeaseHolderChange,
  type LeaseObservationCandidate,
  type LeasePlanningPlacement,
  mergeLeaseObservation,
  orderLeaseCandidates,
} from './lease-planning.js';

const NOW = new Date('2026-09-28T00:00:00Z');
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

function placement(nodeId: string, extra: Partial<LeasePlanningPlacement> = {}): LeasePlanningPlacement {
  return { id: `p-${nodeId}`, nodeId, desiredState: 'standby', serving: false, createdAt: NOW, ...extra };
}

function ballot(round: number, proposerId: string) {
  return { round: String(round), incarnation: '1', proposerId };
}

function holding(holderId: string, round: number, source: 'daemon' | 'relay' = 'daemon'): LeaseObservationCandidate {
  return {
    holderId,
    ballot: ballot(round, holderId),
    epoch: 3,
    manifestVersion: 5,
    source,
    sourceId: source === 'daemon' ? holderId : 'relay-1',
  };
}

describe('availability lease manifest planning', () => {
  it('orders candidates by priority, then serving before standby, oldest first (D4, D5)', () => {
    const placements = [
      placement('n-standby-old', { createdAt: at(-60) }),
      placement('n-serving', { desiredState: 'serving', serving: true, createdAt: at(10) }),
      placement('n-standby-new', { createdAt: at(30) }),
      placement('n-removed', { desiredState: 'removed' }),
    ];
    expect(orderLeaseCandidates({ priorityMode: false, nodePriority: [] }, placements)).toEqual([
      'n-serving',
      'n-standby-old',
      'n-standby-new',
    ]);
    expect(
      orderLeaseCandidates({ priorityMode: true, nodePriority: ['n-standby-new', 'n-serving'] }, placements)
    ).toEqual(['n-standby-new', 'n-serving', 'n-standby-old']);
  });

  it('reserves slots for the serving placements, and for observed holders when strict takes over (A5, A7)', () => {
    const placements = [
      placement('n-2', { desiredState: 'serving', serving: true, createdAt: at(5) }),
      placement('n-1', { desiredState: 'serving', serving: true, createdAt: at(1) }),
      placement('n-3'),
    ];
    expect(bootstrapFromServing(placements, 2)).toEqual([
      { slot: 0, holderId: 'n-1' },
      { slot: 1, holderId: 'n-2' },
    ]);
    expect(bootstrapFromServing(placements, 1)).toEqual([{ slot: 0, holderId: 'n-1' }]);
    expect(
      bootstrapFromHolders(
        [
          { slot: 1, holderId: 'n-3' },
          { slot: 0, holderId: null },
          { slot: 4, holderId: 'n-9' },
        ],
        2
      )
    ).toEqual([{ slot: 1, holderId: 'n-3' }]);
  });
});

describe('availability lease observations', () => {
  it('names the holder of the highest ballot and detects a change of holder', () => {
    const first = mergeLeaseObservation(null, { candidates: [holding('n-1', 2)], now: NOW });
    expect(first.next.holderId).toBe('n-1');
    expect(first.change).toEqual({
      from: null,
      to: 'n-1',
      ballot: ballot(2, 'n-1'),
      holderSince: NOW,
      takeoverSource: 'noticed',
      takeoverNotBefore: null,
    });

    const stale = mergeLeaseObservation(first.next, { candidates: [holding('n-2', 1)], now: at(1) });
    expect(stale.next.holderId).toBe('n-1');
    expect(stale.change).toBeNull();

    const refreshed = mergeLeaseObservation(first.next, { candidates: [holding('n-1', 2)], now: at(2) });
    expect(refreshed.next.observedAt).toEqual(at(2));
    expect(refreshed.change).toBeNull();

    const failover = mergeLeaseObservation(first.next, { candidates: [holding('n-2', 9, 'relay')], now: at(3) });
    expect(failover.next).toMatchObject({ holderId: 'n-2', source: 'relay', lastHolderId: 'n-2', holderSince: at(3) });
    expect(failover.change).toEqual({
      from: 'n-1',
      to: 'n-2',
      ballot: ballot(9, 'n-2'),
      holderSince: at(3),
      takeoverSource: 'noticed',
      takeoverNotBefore: NOW,
    });
  });

  it('clears a holder that reports another role and never revives it from the released ballot', () => {
    const held = mergeLeaseObservation(null, {
      candidates: [holding('n-1', 4)],
      reporter: { id: 'n-1', role: 'holding' },
      now: NOW,
    }).next;
    expect(held.claimants).toEqual({ 'n-1': { role: 'holding', observedAt: NOW.toISOString() } });

    const released = mergeLeaseObservation(held, { candidates: [], reporter: { id: 'n-1', role: null }, now: at(5) });
    expect(released.next).toMatchObject({ holderId: null, lastHolderId: 'n-1', claimants: {} });
    expect(released.change).toBeNull();

    const replay = mergeLeaseObservation(released.next, { candidates: [holding('n-1', 4, 'relay')], now: at(6) });
    expect(replay.next.holderId).toBeNull();

    const successor = mergeLeaseObservation(released.next, { candidates: [holding('n-2', 5)], now: at(7) });
    expect(successor.change).toMatchObject({ from: 'n-1', to: 'n-2', ballot: ballot(5, 'n-2'), holderSince: at(7) });

    const reacquired = mergeLeaseObservation(released.next, { candidates: [holding('n-1', 6)], now: at(8) });
    expect(reacquired.next.holderId).toBe('n-1');
    expect(reacquired.change).toBeNull();
  });

  // Stand run rc20 N-5: after a failover while Opfield was down, holderSince and the audit carried the time Opfield
  // noticed the new holder (09:54:13), not the takeover (09:53:04.86) the voters had seen.
  it('records the takeover time the voters report, never before the previous holder was seen nor in the future', () => {
    const first = mergeLeaseObservation(null, { candidates: [holding('n-1', 2)], now: NOW }).next;
    const reported = (since: Date, holderId = 'n-2', round = 9): LeaseObservationCandidate => ({
      ...holding(holderId, round, 'relay'),
      since,
    });

    const late = mergeLeaseObservation(first, { candidates: [reported(at(-50 + 60))], now: at(120) });
    expect(late.next.holderSince).toEqual(at(10));
    expect(late.change).toMatchObject({ from: 'n-1', to: 'n-2', holderSince: at(10) });

    // Several voters report it: the earliest wins; a report for another holder does not count.
    const earliest = mergeLeaseObservation(first, {
      candidates: [reported(at(30), 'n-2', 9), reported(at(20), 'n-2', 8), reported(at(5), 'n-3', 1)],
      now: at(120),
    });
    expect(earliest.next.holderSince).toEqual(at(20));

    // A report older than the previous holder's last observation is bounded by it.
    const refreshed = mergeLeaseObservation(first, { candidates: [holding('n-1', 3)], now: at(40) }).next;
    const bounded = mergeLeaseObservation(refreshed, { candidates: [reported(at(15))], now: at(120) });
    expect(bounded.next.holderSince).toEqual(at(40));

    // A time from the future (a skewed wall clock) or no report at all fall back to when Opfield noticed it.
    expect(mergeLeaseObservation(first, { candidates: [reported(at(500))], now: at(120) }).next.holderSince).toEqual(
      at(120)
    );
    expect(mergeLeaseObservation(first, { candidates: [holding('n-2', 9)], now: at(120) }).next.holderSince).toEqual(
      at(120)
    );
  });

  // Stand run rc20 c (B-14): the local relay, restarted with Opfield after the takeover, reported first; its first
  // sighting (86 s late) became the recorded time. The holder's own acquisition time is exact and wins.
  it('takes the holder its own acquisition time over any voter sighting, and corrects an earlier guess with it', () => {
    const first = mergeLeaseObservation(null, { candidates: [holding('n-1', 2)], now: NOW }).next;
    const sighted = (since: Date): LeaseObservationCandidate => ({ ...holding('n-2', 30, 'relay'), since });
    const own = (since: Date, round = 31): LeaseObservationCandidate => ({
      ...holding('n-2', round),
      since,
      exact: true,
    });

    const both = mergeLeaseObservation(first, { candidates: [sighted(at(95)), own(at(9))], now: at(120) });
    expect(both.next.holderSince).toEqual(at(9));
    expect(both.change).toMatchObject({
      to: 'n-2',
      holderSince: at(9),
      takeoverSource: 'holder',
      takeoverNotBefore: NOW,
    });

    // First noticed from a late voter sighting only; the holder's next report corrects the recorded time.
    const late = mergeLeaseObservation(first, { candidates: [sighted(at(95))], now: at(120) });
    expect(late.change).toMatchObject({ holderSince: at(95), takeoverSource: 'voters' });
    const corrected = mergeLeaseObservation(late.next, { candidates: [own(at(9), 40)], now: at(150) });
    expect(corrected.change).toBeNull();
    expect(corrected.next.holderSince).toEqual(at(9));
    // A voter sighting never moves a recorded holder's time, the holder's own time from the future is ignored.
    expect(
      mergeLeaseObservation(corrected.next, { candidates: [sighted(at(5))], now: at(160) }).next.holderSince
    ).toEqual(at(9));
    expect(mergeLeaseObservation(late.next, { candidates: [own(at(900), 41)], now: at(160) }).next.holderSince).toEqual(
      at(95)
    );
  });

  // Stand run rc20pre2 d: slot 1 of a replicated policy, fenced by a partition and re-acquired by the same node 27 min
  // later, kept holderSince 15:10:04 instead of 15:37:06. Soak M-5: the slot lapsed for 10 min and the same node took
  // it again while Opfield was down; no audit row, holderSince unchanged. A re-acquisition is a new holding: recorded,
  // audited and dated at the takeover.
  it('records a slot the same node acquired again after a lapse as a new holding (M-5)', () => {
    const own = (since: Date, round: number, holdingStart = true): LeaseObservationCandidate => ({
      ...holding('n-1', round),
      since,
      exact: true,
      holdingStart,
    });
    const held = mergeLeaseObservation(null, { candidates: [own(at(0), 5)], now: at(1) }).next;
    expect(held.holderSince).toEqual(at(0));
    // Renewals keep it, and so does a few seconds of clock jitter between reports.
    const renewed = mergeLeaseObservation(held, {
      candidates: [own(at(1), 9)],
      reporter: { id: 'n-1', role: 'holding' },
      now: at(60),
    });
    expect(renewed.change).toBeNull();
    const steady = mergeLeaseObservation(renewed.next, {
      candidates: [own(at(0), 10)],
      reporter: { id: 'n-1', role: 'holding' },
      now: at(65),
    }).next;
    expect(steady.holderSince).toEqual(at(0));

    // The lapse and the re-acquisition fell while Opfield was away: the holder's own time starts a new holding.
    const unseen = mergeLeaseObservation(steady, {
      candidates: [own(at(1_620), 14)],
      reporter: { id: 'n-1', role: 'holding' },
      now: at(9_000),
    });
    expect(unseen.next).toMatchObject({ holderId: 'n-1', holderSince: at(1_620) });
    expect(unseen.change).toMatchObject({
      from: 'n-1',
      to: 'n-1',
      reacquired: true,
      holderSince: at(1_620),
      takeoverSource: 'holder',
    });
    expect(classifyLeaseHolderChange(unseen.change!, 0, [], new Set(), at(9_000))).toBe('reacquired');

    // A copy that kept running through a daemon restart reports its recovered key without a start time; an older
    // daemon reports the recovery as an acquisition, which corrects the time but is no new holding.
    const recovered = mergeLeaseObservation(steady, {
      candidates: [own(at(1_620), 14, false)],
      reporter: { id: 'n-1', role: 'holding' },
      now: at(1_622),
    });
    expect(recovered.change).toBeNull();

    // A fence Opfield saw clears the holder. The same node holding again is a new holding once a time proves it
    // started after that report: its own start, or a voter's first commit of it.
    const fenced = mergeLeaseObservation(steady, {
      candidates: [],
      reporter: { id: 'n-1', role: 'fencing' },
      now: at(100),
    }).next;
    expect(fenced).toMatchObject({ holderId: null, holderSince: null, lastHolderId: 'n-1' });
    const reacquired = mergeLeaseObservation(fenced, {
      candidates: [own(at(1_620), 14)],
      reporter: { id: 'n-1', role: 'holding' },
      now: at(1_622),
    });
    expect(reacquired.next).toMatchObject({ holderId: 'n-1', holderSince: at(1_620) });
    expect(reacquired.change).toMatchObject({
      from: 'n-1',
      to: 'n-1',
      reacquired: true,
      holderSince: at(1_620),
      takeoverSource: 'holder',
      takeoverNotBefore: at(95),
    });
    const sightedAfter = mergeLeaseObservation(fenced, {
      candidates: [{ ...holding('n-1', 14, 'relay'), since: at(1_600) }],
      now: at(1_622),
    });
    expect(sightedAfter.change).toMatchObject({ reacquired: true, holderSince: at(1_600), takeoverSource: 'voters' });

    // A voter's sighting from before the lapse (its first commit of the node outlived it), or no time at all (also a
    // restarted daemon reporting its key before recovering it): nothing proves a new holding yet. The node's own start,
    // once reported, does.
    const stale = mergeLeaseObservation(fenced, {
      candidates: [{ ...holding('n-1', 14, 'relay'), since: at(40) }],
      now: at(1_622),
    });
    expect(stale.change).toBeNull();
    const unknown = mergeLeaseObservation(fenced, { candidates: [holding('n-1', 14, 'relay')], now: at(1_622) });
    expect(unknown.change).toBeNull();
    expect(unknown.next.holderSince).toEqual(at(100));
    for (const guess of [stale.next, unknown.next]) {
      const own14 = mergeLeaseObservation(guess, {
        candidates: [own(at(1_620), 15)],
        reporter: { id: 'n-1', role: 'holding' },
        now: at(1_630),
      });
      expect(own14.change).toMatchObject({ reacquired: true, holderSince: at(1_620), takeoverSource: 'holder' });
      expect(own14.next.holderSince).toEqual(at(1_620));
    }
    // A recovered key (no start time) after such a report is the same holding.
    expect(
      mergeLeaseObservation(unknown.next, {
        candidates: [own(at(1_625), 15, false)],
        reporter: { id: 'n-1', role: 'holding' },
        now: at(1_630),
      }).change
    ).toBeNull();
  });

  it('audits a planned or designated-successor change as a handoff and any other as a failover (D9)', () => {
    const change = { from: 'n-1', to: 'n-2', ballot: ballot(5, 'n-2') };
    const planned = [
      { slot: 0, fromHolderId: 'n-1', toHolderId: 'n-2', operationId: 'op', expiresAt: at(60).toISOString() },
    ];
    expect(classifyLeaseHolderChange(change, 0, planned, new Set(), NOW)).toBe('handoff');
    expect(classifyLeaseHolderChange(change, 1, planned, new Set(), NOW)).toBe('failover');
    expect(classifyLeaseHolderChange(change, 0, planned, new Set(), at(120))).toBe('failover');
    expect(classifyLeaseHolderChange(change, 0, [], new Set(['n-2']), NOW)).toBe('handoff');
    expect(classifyLeaseHolderChange({ ...change, from: null }, 0, [], new Set(), NOW)).toBeNull();
  });

  it('acks a bootstrap only when the reserved holder holds and no other copy may run (A5, A7)', () => {
    const bootstrap = [{ slot: 0, holderId: 'n-1' }];
    const observation = (holderId: string | null, claimants: string[]) => ({
      holderId,
      claimants: Object.fromEntries(claimants.map((id) => [id, { role: 'holding', observedAt: NOW.toISOString() }])),
    });
    expect(bootstrapAcknowledged(bootstrap, new Map([[0, observation('n-1', ['n-1'])]]))).toBe(true);
    expect(bootstrapAcknowledged(bootstrap, new Map([[0, observation('n-1', ['n-1', 'n-2'])]]))).toBe(false);
    expect(bootstrapAcknowledged(bootstrap, new Map([[0, observation('n-2', ['n-2'])]]))).toBe(false);
    expect(bootstrapAcknowledged(bootstrap, new Map())).toBe(false);
  });
});
