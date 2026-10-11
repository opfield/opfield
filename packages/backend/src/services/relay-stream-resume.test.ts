import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { relayEndpoints, relayRoutes } from '@/db/schema/index.js';
import { RelayGrantIssuerService } from './relay-grant-issuer.service.js';
import { LOCAL_RELAY_DRAIN_CAPABILITY } from './relay-local-takeover.js';
import {
  candidateDrainDeadline,
  DRAIN_DEADLINE_MARGIN_MS,
  DRAIN_KEEPS_LOCAL_SERVICES_CAPABILITY,
  deriveRouteResumeKey,
  drainDeadline,
  drainGraceMs,
  drainOutcomeNote,
  gatewayStreamReport,
  localRelayPauseNote,
  MANUAL_DRAIN_TIMEOUT_MS,
  PROXY_HALF_CLOSE_TIMEOUT_MS,
  planResumeTransitions,
  RELAY_STREAM_RESUME_CAPABILITY,
  RELAY_UPDATE_DRAIN_GRACE_MS,
  RESUMABLE_DRAIN_GRACE_MS,
  RESUME_KEY_ROTATION_MS,
  relayCandidateDrainDeadline,
  relayDrainOutcome,
  relaySessionSplit,
  relayStreamCounters,
  relayStreamOutcome,
  resumeKdfInfo,
  resumeKeyId,
  sourceStreamResume,
  targetRouteResume,
  workloadLegacyStreams,
} from './relay-stream-resume.js';

interface Vectors {
  constants: { capability: string; drain_deadline_margin_ms: number; proxy_half_close_timeout_ms: number };
  kdf: Array<{
    secret_hex: string;
    route_id: string;
    key_version: string;
    info_hex: string;
    key_hex: string;
    key_id: string;
  }>;
}

/** Normative, shared with the daemons (packages/daemons/shared/relayresume). */
const vectors = JSON.parse(
  readFileSync(join(process.cwd(), '../../proto/testdata/relay-resume-v1.json'), 'utf8')
) as Vectors;

const SECRET = Buffer.from(vectors.kdf[0]!.secret_hex, 'hex');

function routeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'route-1',
    ownerKind: 'managed_database_binding',
    resumeState: 'on' as const,
    keyVersion: 1,
    prevKeyVersion: null as number | null,
    ...overrides,
  };
}

describe('RSv1 route keys', () => {
  it('derives every vector key and key id', () => {
    for (const vector of vectors.kdf) {
      expect(resumeKdfInfo(vector.route_id, BigInt(vector.key_version)).toString('hex')).toBe(vector.info_hex);
      expect(
        deriveRouteResumeKey(
          Buffer.from(vector.secret_hex, 'hex'),
          vector.route_id,
          Number(vector.key_version)
        ).toString('hex')
      ).toBe(vector.key_hex);
      expect(resumeKeyId(Number(vector.key_version))).toBe(vector.key_id);
    }
  });

  it('agrees with the frozen constants', () => {
    expect(RELAY_STREAM_RESUME_CAPABILITY).toBe(vectors.constants.capability);
    expect(DRAIN_DEADLINE_MARGIN_MS).toBe(vectors.constants.drain_deadline_margin_ms);
    expect(PROXY_HALF_CLOSE_TIMEOUT_MS).toBe(vectors.constants.proxy_half_close_timeout_ms);
  });

  it('refuses a secret of the wrong size', () => {
    expect(() => deriveRouteResumeKey(Buffer.alloc(16), 'route-1', 1)).toThrow('32 bytes');
  });
});

describe('RSv1 issuance by route state', () => {
  it('gives sources a key only while the route is on, or the previous key while it rotates', () => {
    expect(sourceStreamResume(SECRET, routeRow())).toEqual({
      version: 1,
      keyId: 'v1',
      key: deriveRouteResumeKey(SECRET, 'route-1', 1),
    });
    expect(sourceStreamResume(SECRET, routeRow({ resumeState: 'rotating', keyVersion: 3, prevKeyVersion: 2 }))).toEqual(
      { version: 1, keyId: 'v2', key: deriveRouteResumeKey(SECRET, 'route-1', 2) }
    );
    for (const resumeState of ['off', 'enabling', 'disabling'] as const) {
      expect(sourceStreamResume(SECRET, routeRow({ resumeState }))).toBeUndefined();
    }
    expect(sourceStreamResume(null, routeRow())).toBeUndefined();
  });

  it('gives proxy routes the half-close timeout the relay used to enforce', () => {
    expect(sourceStreamResume(SECRET, routeRow({ ownerKind: 'proxy_host_secure_link' }))?.halfCloseTimeoutMs).toBe(
      PROXY_HALF_CLOSE_TIMEOUT_MS
    );
  });

  it('lists the route on the target in every state but off, with the previous key', () => {
    expect(targetRouteResume(SECRET, routeRow({ resumeState: 'off' }))).toBeUndefined();
    for (const resumeState of ['enabling', 'on', 'disabling'] as const) {
      expect(targetRouteResume(SECRET, routeRow({ resumeState }))).toEqual({
        routeId: 'route-1',
        version: 1,
        keyId: 'v1',
        key: deriveRouteResumeKey(SECRET, 'route-1', 1),
      });
    }
    expect(targetRouteResume(SECRET, routeRow({ resumeState: 'rotating', keyVersion: 3, prevKeyVersion: 2 }))).toEqual({
      routeId: 'route-1',
      version: 1,
      keyId: 'v3',
      key: deriveRouteResumeKey(SECRET, 'route-1', 3),
      prevKeyId: 'v2',
      prevKey: deriveRouteResumeKey(SECRET, 'route-1', 2),
    });
  });
});

describe('RSv1 capability transitions', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const fresh = new Date(now - 1000);
  const plan = (resumeState: string, desired: boolean, keyRotatedAt: Date | null = fresh) =>
    planResumeTransitions([{ id: 'r', resumeState: resumeState as never, desired, keyRotatedAt }], now);

  it('enables targets first and disables sources first', () => {
    expect(plan('off', true).enable).toEqual(['r']);
    expect(plan('off', false)).toEqual({ enable: [], rotate: [], cancel: [], disable: [], reenable: [] });
    expect(plan('on', false).disable).toEqual(['r']);
    expect(plan('rotating', false).disable).toEqual(['r']);
  });

  it('finishes an interrupted step, or turns it back', () => {
    expect(plan('enabling', true).enable).toEqual(['r']);
    expect(plan('enabling', false).cancel).toEqual(['r']);
    expect(plan('rotating', true).rotate).toEqual(['r']);
    expect(plan('disabling', false).disable).toEqual(['r']);
    expect(plan('disabling', true).reenable).toEqual(['r']);
  });

  it('rotates a key once its period passed', () => {
    expect(plan('on', true).rotate).toEqual([]);
    expect(plan('on', true, new Date(now - RESUME_KEY_ROTATION_MS)).rotate).toEqual(['r']);
    expect(plan('on', true, null).rotate).toEqual(['r']);
  });
});

describe('drain timing', () => {
  it('drains in 2 minutes only when every stream can move', () => {
    expect(drainGraceMs('update', true)).toBe(RESUMABLE_DRAIN_GRACE_MS);
    expect(drainGraceMs('manual', true)).toBe(RESUMABLE_DRAIN_GRACE_MS);
    expect(drainGraceMs('update', false)).toBe(RELAY_UPDATE_DRAIN_GRACE_MS);
    expect(drainGraceMs('manual', false)).toBe(MANUAL_DRAIN_TIMEOUT_MS);
    expect(RESUMABLE_DRAIN_GRACE_MS).toBe(2 * 60_000);
    expect(RELAY_UPDATE_DRAIN_GRACE_MS).toBe(30 * 60_000);
  });

  it('never moves a running drain later', () => {
    const now = 1_000_000;
    const running = new Date(now + 60_000);
    expect(drainDeadline({ state: 'draining', drainDeadlineAt: running }, 30 * 60_000, now)).toEqual(running);
    expect(drainDeadline({ state: 'draining', drainDeadlineAt: running }, 10_000, now)).toEqual(new Date(now + 10_000));
    // A deadline left over from an earlier drain does not count.
    expect(drainDeadline({ state: 'ready', drainDeadlineAt: new Date(0) }, 120_000, now)).toEqual(
      new Date(now + 120_000)
    );
  });

  it('tells sources to leave a margin before the drain ends', () => {
    expect(candidateDrainDeadline(null)).toBeUndefined();
    expect(candidateDrainDeadline(new Date(100_000))).toBe(String(100_000 - DRAIN_DEADLINE_MARGIN_MS));
  });

  it('gives only a relay drain a deadline, never a generation placement drained (stand 2.12 N-2)', () => {
    const at = new Date(100_000);
    expect(relayCandidateDrainDeadline('draining', 'draining', at)).toBe(String(100_000 - DRAIN_DEADLINE_MARGIN_MS));
    // Daemons keep their streams on a relay that stays when its old generation drains without a deadline.
    expect(relayCandidateDrainDeadline('draining', 'ready', at)).toBeUndefined();
    expect(relayCandidateDrainDeadline('active', 'draining', at)).toBeUndefined();
  });
});

describe('relay stream reports', () => {
  const report = (moved: number, cut: number, byRelay: Array<[string, number, number]>) => ({
    resumableSessions: 0,
    legacySessions: 0,
    suspendedSessions: 0,
    migrationsOkTotal: moved,
    migrationsFailedTotal: 0,
    cutTotal: cut,
    retransmittedBytesTotal: 0,
    unackedBytes: 0,
    migrationStallP50Ms: 0,
    migrationStallP95Ms: 0,
    resumeRefusedTotal: 0,
    laneRotationsTotal: 0,
    laneMovesTotal: 0,
    byRelay: byRelay.map(([relayInstanceId, resumable, legacy]) => ({ relayInstanceId, resumable, legacy })),
  });

  it('sums the resumable and raw streams through one relay', () => {
    const reports = [
      {
        nodeId: 'a',
        report: report(0, 0, [
          ['relay-1', 3, 1],
          ['relay-2', 5, 0],
        ]),
      },
      { nodeId: 'b', report: report(0, 0, [['relay-1', 2, 0]]) },
    ];
    expect(relaySessionSplit(reports, 'relay-1')).toEqual({ resumable: 5, legacy: 1, reporting: true });
    expect(relaySessionSplit([], 'relay-1')).toEqual({ resumable: 0, legacy: 0, reporting: false });
  });

  it('counts what moved and was cut between two snapshots, across daemon restarts', () => {
    const before = relayStreamCounters([
      { nodeId: 'a', report: report(10, 1, []) },
      { nodeId: 'b', report: report(50, 0, []) },
    ]);
    const after = relayStreamCounters([
      { nodeId: 'a', report: report(14, 2, []) },
      // Restarted: its totals start over.
      { nodeId: 'b', report: report(3, 0, []) },
      { nodeId: 'c', report: report(99, 9, []) },
    ]);
    expect(relayStreamOutcome(before, after)).toEqual({ moved: 7, cut: 1 });
  });

  it('writes plain step notes', () => {
    expect(drainOutcomeNote({ moved: 0, cut: 0 })).toBeNull();
    expect(drainOutcomeNote({ moved: 12, cut: 0 })).toBe('12 streams moved to other relays, none cut.');
    // Stand 2.12 N-3: pool-wide moves are bounded by the streams the drained relay carried.
    expect(relayDrainOutcome({ moved: 91, cut: 0 }, 0)).toEqual({ moved: 0, cut: 0 });
    expect(drainOutcomeNote(relayDrainOutcome({ moved: 91, cut: 0 }, 0))).toBeNull();
    expect(relayDrainOutcome({ moved: 91, cut: 2 }, 5)).toEqual({ moved: 3, cut: 2 });
    expect(relayDrainOutcome({ moved: 4, cut: 0 }, 10)).toEqual({ moved: 4, cut: 0 });
    expect(drainOutcomeNote({ moved: 1, cut: 1 }, 2)).toBe('1 stream moved to other relays, 3 streams cut.');
    expect(localRelayPauseNote(8_400, { moved: 4, cut: 0 }, 'no other relay was ready')).toBe(
      'Streams through the local relay paused for 8 s while it was recreated (no other relay was ready); 4 streams resumed.'
    );
  });
});

type Rows = { table: unknown; projected: boolean; filtered: boolean; rows: unknown[] };

/** A Drizzle stand-in that answers by table, projection and whether the query was filtered. */
function database(answers: Rows[]) {
  return {
    select: (fields?: unknown) => {
      let table: unknown;
      let filtered = false;
      const query: any = {
        from: (value: unknown) => {
          table = value;
          return query;
        },
        where: () => {
          filtered = true;
          return query;
        },
        limit: () => query,
        innerJoin: () => query,
        // biome-ignore lint/suspicious/noThenProperty: emulate Drizzle's lazy thenable query
        then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => {
          const answer = answers.find(
            (candidate) =>
              candidate.table === table &&
              candidate.projected === (fields !== undefined) &&
              candidate.filtered === filtered
          );
          return Promise.resolve(answer?.rows ?? []).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

function relay(instanceId: string, instanceState = 'ready', drainDeadlineAt: Date | null = null) {
  return {
    endpointId: 'endpoint-1',
    generation: 3,
    state: 'active',
    role: 'active',
    instanceState,
    poolId: 'system',
    instanceId,
    kind: 'remote',
    addresses: [`${instanceId}.example`],
    port: 9443,
    certificateIdentity: `relay-${instanceId}`,
    certificateFingerprint: 'sha256:relay',
    capabilities: { features: ['relay_pool_v1'] },
    drainDeadlineAt,
  };
}

const endpoint = {
  id: 'endpoint-1',
  generation: 1,
  status: 'active',
  ownerKind: 'managed_database',
  ownerId: 'db-1',
  subjectKind: 'daemon',
  subjectId: 'node-target',
  maxConcurrentSessions: 256,
};

const route = {
  id: 'route-1',
  generation: 1,
  ownerKind: 'managed_database_binding',
  ownerId: 'binding-1',
  sourceKind: 'daemon',
  sourceId: 'node-source',
  sourceCertificateSha256: 'sha256:app',
  targetEndpointId: 'endpoint-1',
  maxConcurrentSessions: 16,
  maxFrameBytes: 1024 * 1024,
  managedDatabaseListener: null,
  resumeState: 'on',
  keyVersion: 4,
  prevKeyVersion: 3,
};

function issuer(answers: Rows[], deadline: Date | null = null) {
  const service = new RelayGrantIssuerService(database(answers) as never, {} as never, {} as never) as any;
  service.setResumeSecretSource(async () => SECRET);
  service.requireNodeIdentity = vi.fn().mockResolvedValue({ certificateFingerprint: 'sha256:node' });
  service.requireState = vi.fn().mockResolvedValue({ revision: 20, gatewayInstanceId: 'gateway' });
  service.getPoolProjection = vi
    .fn()
    .mockResolvedValue(new Map([['endpoint-1', [relay('relay-a'), relay('relay-draining', 'draining', deadline)]]]));
  service.nodeSupportsPool = vi.fn().mockResolvedValue(true);
  service.endpointPathSupportsPool = vi.fn().mockResolvedValue(true);
  service.signGrant = vi.fn(async (claims: unknown) => ({
    keyId: 'grant',
    payload: claims,
    signature: Buffer.alloc(0),
  }));
  return service;
}

describe('RelayGrantIssuerService RSv1 fields', () => {
  it('gives a source its route key and the drain deadline of a draining relay', async () => {
    const deadline = new Date('2026-10-05T12:02:00Z');
    const service = issuer(
      [
        { table: relayRoutes, projected: false, filtered: true, rows: [route] },
        { table: relayEndpoints, projected: false, filtered: false, rows: [endpoint] },
      ],
      deadline
    );
    const bundle = await service.getNodeGrantBundle('node-source');
    const connect = bundle.grants.find((grant: { role: string }) => grant.role === 'connect');
    expect(connect.streamResume).toEqual({ version: 1, keyId: 'v4', key: deriveRouteResumeKey(SECRET, 'route-1', 4) });
    expect(
      connect.candidates.map(({ drainDeadlineUnixMs }: { drainDeadlineUnixMs?: string }) => drainDeadlineUnixMs)
    ).toEqual([undefined, String(deadline.getTime() - DRAIN_DEADLINE_MARGIN_MS)]);
  });

  it('gives no key to the source of a route that is not on', async () => {
    const service = issuer([
      { table: relayRoutes, projected: false, filtered: true, rows: [{ ...route, resumeState: 'enabling' }] },
      { table: relayEndpoints, projected: false, filtered: false, rows: [endpoint] },
    ]);
    const bundle = await service.getNodeGrantBundle('node-source');
    expect(bundle.grants.find((grant: { role: string }) => grant.role === 'connect').streamResume).toBeUndefined();
  });

  it('gives the target the current and previous key of each resumable route', async () => {
    const service = issuer([
      { table: relayEndpoints, projected: false, filtered: true, rows: [endpoint] },
      {
        table: relayRoutes,
        projected: true,
        filtered: true,
        rows: [
          { ...route, id: 'route-2', resumeState: 'off' },
          { ...route, resumeState: 'rotating' },
        ],
      },
    ]);
    const bundle = await service.getNodeGrantBundle('node-target');
    const registration = bundle.grants.find((grant: { role: string }) => grant.role === 'endpoint');
    expect(registration.resumeRoutes).toEqual([
      {
        routeId: 'route-1',
        version: 1,
        keyId: 'v4',
        key: deriveRouteResumeKey(SECRET, 'route-1', 4),
        prevKeyId: 'v3',
        prevKey: deriveRouteResumeKey(SECRET, 'route-1', 3),
      },
    ]);
  });

  it("gives Gateway's own source its route key", async () => {
    const service = issuer([
      { table: relayRoutes, projected: false, filtered: true, rows: [{ ...route, sourceKind: 'gateway' }] },
      { table: relayEndpoints, projected: false, filtered: true, rows: [endpoint] },
    ]);
    const assignment = await service.issueGatewayConnectAssignment('route-1', 'sha256:app');
    expect(assignment.streamResume?.keyId).toBe('v4');
    expect(assignment.candidates.map(({ local }: { local: boolean }) => local)).toEqual([false, false]);
  });
});

describe("Gateway's own streams", () => {
  it('reports them like a daemon, with the local relay for pre-pool streams', () => {
    const report = gatewayStreamReport(
      {
        sessions: { resumable: 2, legacy: 1 },
        byRelay: { 'relay-1': { resumable: 2, legacy: 0 }, local: { resumable: 0, legacy: 1 } },
        suspended: 0,
        unackedBytes: 10,
        migrations: { 'drain:ok': 3, 'goaway:ok': 1, 'path_failure:timeout': 1, 'lane:ok': 2, 'lane:no_relay': 1 },
        migrationStallMs: { p50: 4, p95: 9 },
        retransmittedBytes: 100,
      },
      'local-relay-id'
    );
    // Moves off a connection the target replaced are counted apart, like the daemons' lane moves.
    expect(report).toMatchObject({
      migrationsOkTotal: 4,
      migrationsFailedTotal: 1,
      laneMovesTotal: 2,
      cutTotal: 1,
      migrationStallP95Ms: 9,
    });
    // Only refused resumes and unplanned moves out of time cut a live stream: a planned move that found no path or
    // no answer kept it, and "rejected" is a stream that ended meanwhile (stand rc.6 O-3).
    const failedMoves = gatewayStreamReport(
      {
        sessions: { resumable: 0, legacy: 0 },
        byRelay: {},
        suspended: 0,
        unackedBytes: 0,
        migrations: {
          'drain:no_relay': 2,
          'return:timeout': 1,
          'return:rejected': 1,
          'goaway:resume_rejected': 1,
          'path_failure:timeout': 1,
          'path_failure:resume_rejected': 1,
          'path_failure:rejected': 1,
          'lane:resume_rejected': 1,
        },
        migrationStallMs: { p50: 0, p95: 0 },
        retransmittedBytes: 0,
      },
      'local-relay-id'
    );
    expect(failedMoves).toMatchObject({ migrationsOkTotal: 0, migrationsFailedTotal: 8, cutTotal: 4 });
    expect(relaySessionSplit([{ nodeId: 'gateway', report }], 'local-relay-id')).toEqual({
      resumable: 0,
      legacy: 1,
      reporting: true,
    });
    // Before the local relay identity is known, its streams are not attributed.
    const unattributed = gatewayStreamReport(
      {
        sessions: { resumable: 0, legacy: 1 },
        byRelay: { local: { resumable: 0, legacy: 1 } },
        suspended: 0,
        unackedBytes: 0,
        migrations: {},
        migrationStallMs: { p50: 0, p95: 0 },
        retransmittedBytes: 0,
      },
      null
    );
    expect(unattributed.byRelay).toEqual([]);
  });
});

describe('raw streams that hold a drain', () => {
  const registry = new Set(['registry']);
  const health = {
    assignmentTunnels: [
      { endpointId: 'registry', activeTunnels: 40 },
      { endpointId: 'workload', activeTunnels: 2 },
    ],
  };
  const local = { kind: 'local', capabilities: { features: [DRAIN_KEEPS_LOCAL_SERVICES_CAPABILITY] }, health };

  it('names the capability the local relay advertises', () => {
    expect(DRAIN_KEEPS_LOCAL_SERVICES_CAPABILITY).toBe(LOCAL_RELAY_DRAIN_CAPABILITY);
  });

  it('leaves out the registry streams a draining local relay keeps serving', () => {
    expect(workloadLegacyStreams(40, local, registry)).toBe(0);
    expect(workloadLegacyStreams(41, local, registry)).toBe(1);
  });

  it('counts every raw stream on a relay that does not keep local services', () => {
    expect(workloadLegacyStreams(40, { ...local, kind: 'remote' }, registry)).toBe(40);
    expect(workloadLegacyStreams(40, { ...local, capabilities: { features: [] } }, registry)).toBe(40);
    expect(workloadLegacyStreams(0, local, registry)).toBe(0);
  });
});
