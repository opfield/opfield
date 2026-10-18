import { describe, expect, it, vi } from 'vitest';
import type { relayInstances } from '@/db/schema/index.js';
import { type OpfieldRelayCandidate, orderOpfieldRelayCandidates } from './opfield-relay-paths.js';
import { planRelays, RelayPoolService } from './relay-pool.service.js';
import type { EndpointLatencyPath, PlannedRelayAssignment } from './relay-topology.js';

type RelayInstanceRow = typeof relayInstances.$inferSelect;

/**
 * Stand rc.7, F-3 (netem: NL 300 ms, UK 60 ms, the local relay next to the nodes; spread fixed 2). Every endpoint had
 * the local relay as its primary and a standby picked by hash, NL for about half of them, so during each local relay
 * outage and the local relay's drain in a Relay Pool update their streams (Opfield's own as well) could only go to
 * the 300-ms relay. The update also held back the relay it had just finished, so the local relay's workloads were
 * placed on NL, and the local relay itself only became a primary again 2 minutes after its own update.
 */

function relay(id: string, overrides: Partial<RelayInstanceRow> = {}): RelayInstanceRow {
  return {
    id,
    poolId: 'system',
    kind: id === 'relay-local' ? 'local' : 'remote',
    nodeId: id === 'relay-local' ? null : `node-${id}`,
    faultDomainId: `fd-${id}`,
    displayName: id,
    advertisedAddresses: [],
    servicePort: 9443,
    state: 'ready',
    manualDrainStartedAt: null,
    drainForcedAt: null,
    drainDeadlineAt: null,
    certificateIdentity: 'identity',
    certificateFingerprint: 'fingerprint',
    certificateExpiresAt: null,
    policySigningKeyId: null,
    policyPublicKeyFingerprint: null,
    buildVersion: null,
    protocolMajor: 1,
    capabilities: { protocolMajor: 1, features: ['relay_pool_v1'] },
    appliedPolicyRevision: 1,
    policyExpiresAt: null,
    lastSeenAt: new Date(),
    health: { admissionState: 'ready' } as RelayInstanceRow['health'],
    desiredArtifact: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as RelayInstanceRow;
}

/** Round trips every node measures: the endpoint node and one source node. */
function measured(rtts: Record<string, number>): EndpointLatencyPath {
  return { endpoint: new Map(Object.entries(rtts)), sources: [new Map(Object.entries(rtts))] };
}

const netem = measured({ 'relay-local': 1.5, 'relay-uk': 61, 'relay-nl': 301 });
const endpoints = Array.from({ length: 12 }, (_, index) => `endpoint-${index + 1}`);
const roles = (planned: PlannedRelayAssignment[]) =>
  Object.fromEntries(planned.map(({ instance, role }) => [instance.id, role]));

describe('Standbys are the nearest relays (stand rc.7, F-3)', () => {
  it('makes the nearest remote relay the standby of every endpoint, whatever the hash prefers', () => {
    const instances = [relay('relay-local'), relay('relay-nl'), relay('relay-uk')];
    for (const endpointId of endpoints) {
      const planned = planRelays(endpointId, instances, 2, false, netem, []);
      expect(roles(planned), endpointId).toEqual({ 'relay-local': 'primary', 'relay-uk': 'fallback' });
    }
  });

  it('moves a standby to a clearly nearer relay, and keeps it among equally near ones', () => {
    const instances = [relay('relay-local'), relay('relay-nl'), relay('relay-uk')];
    const onNl = [
      { relayInstanceId: 'relay-local', role: 'primary' },
      { relayInstanceId: 'relay-nl', role: 'fallback' },
    ];
    const onUk = [
      { relayInstanceId: 'relay-local', role: 'primary' },
      { relayInstanceId: 'relay-uk', role: 'fallback' },
    ];
    for (const endpointId of endpoints) {
      expect(roles(planRelays(endpointId, instances, 2, false, netem, onNl))['relay-uk'], endpointId).toBe('fallback');
    }
    // Without netem the remote relays are a few milliseconds apart: no standby moves (a move is a new generation).
    const lan = measured({ 'relay-local': 0.7, 'relay-uk': 4, 'relay-nl': 2.5 });
    for (const endpointId of endpoints) {
      expect(roles(planRelays(endpointId, instances, 2, false, lan, onNl))['relay-nl'], endpointId).toBe('fallback');
      expect(roles(planRelays(endpointId, instances, 2, false, lan, onUk))['relay-uk'], endpointId).toBe('fallback');
    }
  });

  it("sends Opfield's own streams to the 60-ms relay when the local relay stops", () => {
    const instances = [relay('relay-local'), relay('relay-nl'), relay('relay-uk')];
    const rtt: Record<string, number> = { 'relay-uk': 60, 'relay-nl': 300 };
    for (const endpointId of endpoints) {
      const candidates: OpfieldRelayCandidate[] = planRelays(endpointId, instances, 2, false, netem, []).map(
        ({ instance, role }) => ({
          relayInstanceId: instance.id,
          assignmentState: 'active',
          addresses: ['192.0.2.1'],
          port: 9443,
          local: instance.kind === 'local',
          topology: { role: role === 'fallback' ? 'standby' : 'primary' },
        })
      );
      // A graceful stop of the local relay after a quiet period: every remote relay measured, the local one down.
      const ordered = orderOpfieldRelayCandidates(
        candidates,
        (candidate) =>
          candidate.local
            ? { available: false, rttMs: 0, stable: false }
            : { available: true, rttMs: rtt[candidate.relayInstanceId], stable: true },
        'relay-local'
      );
      expect(ordered[0]?.relayInstanceId, endpointId).toBe('relay-uk');
    }
  });
});

/** A RelayPoolService whose relays drain and resume through its update path, and its placement view. */
function pool(instances: Record<string, RelayInstanceRow>) {
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            throw new Error('not looked up in this test');
          },
        }),
      }),
    })),
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
  };
  const policy = {
    isRemoteInstanceConnected: vi.fn(() => true),
    setRemoteInstanceDrain: vi.fn(async () => undefined),
    setLocalInstanceDrain: vi.fn(async () => undefined),
    reconcileAndSync: vi.fn(async () => undefined),
  };
  const service = new RelayPoolService(
    db as never,
    policy as never,
    { publish: vi.fn() } as never,
    { log: vi.fn(async () => undefined) } as never,
    {} as never
  );
  vi.spyOn(service as unknown as { evacuateInstance(id: string): Promise<void> }, 'evacuateInstance').mockResolvedValue(
    undefined
  );
  const drain = async (id: string, enabled: boolean) => {
    db.select.mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: async () => [instances[id]] }) }),
    } as never);
    await service.drainInstance(id, null, enabled, { manual: false });
  };
  const holdBack = (rows: RelayInstanceRow[], now: number) =>
    (
      service as unknown as {
        placementView(rows: RelayInstanceRow[], failing: ReadonlySet<string>, now: number): { holdBack: Set<string> };
      }
    ).placementView(rows, new Set(), now).holdBack;
  return { service, drain, holdBack };
}

describe('A Relay Pool update places by distance (stand rc.7, F-3)', () => {
  it("puts the local relay's workloads on the relay the update just finished when it is the nearest", async () => {
    const uk = relay('relay-uk');
    const t = pool({ 'relay-uk': uk });
    const start = Date.now();
    // The update drains UK, restarts it (its control stream drops: offline), and resumes it.
    await t.drain('relay-uk', true);
    t.holdBack([relay('relay-local'), relay('relay-uk', { state: 'draining' }), relay('relay-nl')], start);
    t.holdBack([relay('relay-local'), relay('relay-uk', { state: 'offline' }), relay('relay-nl')], start + 20_000);
    await t.drain('relay-uk', false);
    // Two seconds later it drains the local relay: its workloads are planned without it.
    const instances = [relay('relay-local', { state: 'draining' }), relay('relay-uk'), relay('relay-nl')];
    const held = t.holdBack(instances, start + 42_000);
    expect([...held]).toEqual([]);
    const reference = [
      { relayInstanceId: 'relay-local', role: 'primary' },
      { relayInstanceId: 'relay-nl', role: 'fallback' },
    ];
    for (const endpointId of endpoints) {
      const planned = planRelays(
        endpointId,
        instances.filter(({ state }) => state === 'ready'),
        2,
        false,
        netem,
        reference,
        false,
        undefined,
        held
      );
      expect(roles(planned)['relay-uk'], endpointId).toBe('primary');
    }
  });

  it('makes the local relay the primary again as soon as the update resumes it', async () => {
    const local = relay('relay-local');
    const t = pool({ 'relay-local': local });
    const start = Date.now();
    await t.drain('relay-local', true);
    t.holdBack([relay('relay-local', { state: 'draining' }), relay('relay-uk'), relay('relay-nl')], start);
    // Recreated: the supervisor finds it unreachable, then synchronizing.
    t.holdBack([relay('relay-local', { state: 'offline' }), relay('relay-uk'), relay('relay-nl')], start + 60_000);
    t.holdBack(
      [relay('relay-local', { state: 'synchronizing' }), relay('relay-uk'), relay('relay-nl')],
      start + 70_000
    );
    await t.drain('relay-local', false);
    const instances = [relay('relay-local'), relay('relay-uk'), relay('relay-nl')];
    const held = t.holdBack(instances, start + 75_000);
    expect([...held]).toEqual([]);
    const evacuated = [
      { relayInstanceId: 'relay-uk', role: 'primary' },
      { relayInstanceId: 'relay-nl', role: 'fallback' },
    ];
    for (const endpointId of endpoints) {
      const planned = planRelays(endpointId, instances, 2, false, netem, evacuated, false, undefined, held);
      expect(roles(planned), endpointId).toEqual({ 'relay-local': 'primary', 'relay-uk': 'fallback' });
    }
  });

  it('still holds back a relay that failed outside a drain', () => {
    const t = pool({});
    const start = Date.now();
    // It served (a relay that joined while Opfield runs and never served is placed at once when ready)...
    t.holdBack([relay('relay-local'), relay('relay-uk'), relay('relay-nl')], start - 1_000);
    // ...then went past its disconnect grace, not drained.
    const gone = relay('relay-uk', { state: 'offline', lastSeenAt: new Date(start - 10 * 60_000) });
    t.holdBack([relay('relay-local'), gone, relay('relay-nl')], start);
    expect([...t.holdBack([relay('relay-local'), relay('relay-uk'), relay('relay-nl')], start + 1_000)]).toEqual([
      'relay-uk',
    ]);
  });
});
