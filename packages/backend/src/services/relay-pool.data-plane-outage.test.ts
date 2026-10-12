import { describe, expect, it, vi } from 'vitest';
import type { relayInstances } from '@/db/schema/index.js';
import { logger } from '@/lib/logger.js';
import { LOCAL_RELAY_RECONNECT_GRACE_MS, type LocalRelayOutage } from './local-relay-outage.js';
import { RelayPoolService } from './relay-pool.service.js';

type RelayInstanceRow = typeof relayInstances.$inferSelect;

const instances = [
  { id: 'relay-uk', displayName: 'relay-1' },
  { id: 'relay-deb', displayName: 'deb-fresh-2' },
] as RelayInstanceRow[];

describe('the data-plane judgement of remote relays during a local relay outage (O-4)', () => {
  it('holds while the outage window covers, and is judged from the reports again after it', async () => {
    let outage: LocalRelayOutage | null = null;
    // The nodes report deb-fresh-2's relay port unreachable; during the outage no report arrives at all.
    let failing = new Set(['relay-deb']);
    const relayDataPlaneFailures = vi.fn(async () => failing);
    const service = new RelayPoolService(
      {} as never,
      {} as never,
      { publish: () => undefined } as never,
      {} as never,
      {} as never
    );
    service.setTopology({ endpointPaths: vi.fn() as never, relayDataPlaneFailures });
    service.setLocalRelayOutage({ latestOutage: () => outage });
    const judge = () => (service as any).dataPlaneFailures(instances) as Promise<Set<string>>;

    expect([...(await judge())]).toEqual(['relay-deb']);

    const now = Date.now();
    outage = { since: now - 60_000, servingAgainAt: null, planned: false };
    failing = new Set();
    expect([...(await judge())]).toEqual(['relay-deb']);
    // Serving again: the reconnect grace still covers.
    outage = { ...outage, servingAgainAt: now - 1_000 };
    expect([...(await judge())]).toEqual(['relay-deb']);
    expect(relayDataPlaneFailures).toHaveBeenCalledTimes(1);

    outage = { ...outage, servingAgainAt: now - LOCAL_RELAY_RECONNECT_GRACE_MS - 1 };
    expect([...(await judge())]).toEqual([]);
    expect(relayDataPlaneFailures).toHaveBeenCalledTimes(2);
  });
});

/**
 * Right after a relay's planned restart (a Relay Pool update) the nodes' reports still carry what they measured while
 * it was down (stand rc.12 F-2: relay-1 reported unreachable 11 s after its update restart): information within the
 * grace, a warning only once it outlasts it.
 */
describe('the data-plane judgement of a relay right after its update restart', () => {
  it('logs information within the grace and warns once it persists', async () => {
    const failing = new Set(['relay-uk']);
    const service = new RelayPoolService(
      {} as never,
      {} as never,
      { publish: () => undefined } as never,
      {} as never,
      {} as never
    );
    service.setTopology({ endpointPaths: vi.fn() as never, relayDataPlaneFailures: vi.fn(async () => failing) });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const unreachable = 'Most nodes that measure a relay cannot reach its relay port; it gets no assignments meanwhile';
    try {
      // The update drained relay-1, restarted it and resumed it a moment ago.
      (service as any).drainedForUpdate.set('relay-uk', Date.now() - 30_000);
      (service as any).forgetPlannedDrain('relay-uk');
      const note = (now: number) => (service as any).noteDataPlaneChanges(instances, failing, now);
      const resumedAt = Date.now();
      note(resumedAt + 11_000);
      note(resumedAt + 30_000);
      expect(warn).not.toHaveBeenCalledWith(unreachable, expect.anything());
      expect(info).toHaveBeenCalledTimes(1);
      note(resumedAt + 91_000);
      note(resumedAt + 120_000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(unreachable, { relayInstanceId: 'relay-uk', relay: 'relay-1' });

      // A relay that did not restart by plan warns at once.
      note(resumedAt + 121_000);
      failing.add('relay-deb');
      note(resumedAt + 122_000);
      expect(warn).toHaveBeenLastCalledWith(unreachable, { relayInstanceId: 'relay-deb', relay: 'deb-fresh-2' });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});
