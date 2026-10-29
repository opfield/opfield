import { generateKeyPairSync } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  managedDatabaseBindingPlacements,
  relayEndpointAssignments,
  relayEndpoints,
  relayGrantSigningKeys,
  relayInstancePolicyState,
  relayInstances,
  relayPolicyState,
  relayRoutes,
} from '@/db/schema/index.js';
import { decodeRelayV1Message } from '@/grpc/relay-proto.js';
import {
  LEGACY_INSTALL_DIR_NAME,
  LEGACY_INTERNAL_REGISTRY_ID,
  LEGACY_MANAGED_DATABASE_OWNER_KIND,
  LEGACY_RELAY_SOURCE_KIND,
} from '@/lib/legacy-compat.js';
import { logger } from '@/lib/logger.js';
import { RelayPolicyNotAcknowledgedError } from './relay-grant-issuer.service.js';
import {
  describeGrantRefreshFailures,
  LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE,
  managedDatabaseListenerConfigsEqual,
  RelayPolicyService,
} from './relay-policy.service.js';
import { RELAY_UNCAPPED_SESSIONS } from './relay-session-limits.js';

function createService(
  db: unknown,
  relay: {
    applySnapshot: ReturnType<typeof vi.fn>;
    getHealth?: ReturnType<typeof vi.fn>;
    getRouteRuntime?: ReturnType<typeof vi.fn>;
    bootstrapPolicyTrust?: ReturnType<typeof vi.fn>;
    applyEncodedSnapshot?: ReturnType<typeof vi.fn>;
    resetLocalPolicyTrust?: ReturnType<typeof vi.fn>;
  }
) {
  return new RelayPolicyService(
    db as never,
    {} as never,
    {
      getConfig: vi.fn().mockResolvedValue({
        relayGrantTtlHours: 4,
        relay: {
          dataLanes: 4,
          readChunkBytes: 32 * 1024,
          adaptiveAdmissionEnabled: true,
          proxyTargetPressurePercent: 70,
          databaseReservePercent: 20,
          hardPressurePercent: 95,
        },
      }),
    } as never,
    relay as never
  );
}

describe('RelayPolicyService bundle cache lifecycle', () => {
  function fixture() {
    const db: any = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      delete: () => ({ where: () => ({ returning: async () => [] }) }),
    };
    db.transaction = vi.fn(async (fn: (tx: any) => unknown) => fn(db));
    const service = createService(db, { applySnapshot: vi.fn() });
    vi.spyOn(service, 'syncSnapshot').mockResolvedValue(1);
    const bundle = { revision: '1', generatedAtUnixMs: '100', grants: [] };
    const generate = vi.spyOn(service, 'getNodeGrantBundle').mockResolvedValue(bundle);
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    service.setNodeDispatch({ sendRelayGrantBundle: dispatch } as never);
    return { db, service, bundle, generate, dispatch, state: service as any };
  }

  it('clears completed bundles after commit, including when snapshot publication fails', async () => {
    const { service, state } = fixture();
    await service.syncNodeGrantBundle('node');
    expect(state.lastNodeGrantBundles.size).toBe(1);
    vi.mocked(service.syncSnapshot).mockRejectedValue(new Error('publication failed'));
    await expect(service.revokeNode('node')).rejects.toThrow('publication failed');
    expect(state.lastNodeGrantBundles.size).toBe(0);
    expect(state.nodeGrantSyncs.size).toBe(0);
  });

  it('keeps bundles when revocation transaction fails', async () => {
    const { db, service, state } = fixture();
    await service.syncNodeGrantBundle('node');
    db.transaction.mockRejectedValue(new Error('transaction failed'));
    await expect(service.revokeNode('node')).rejects.toThrow('transaction failed');
    expect(state.lastNodeGrantBundles.size).toBe(1);
  });

  it.each(['generation', 'dispatch'] as const)('does not reinsert after revocation during %s', async (stage) => {
    const { service, state, generate, dispatch, bundle } = fixture();
    let resolve!: (value: any) => void;
    const pending = new Promise<any>((done) => {
      resolve = done;
    });
    (stage === 'generation' ? generate : dispatch).mockReturnValueOnce(pending);
    const syncing = service.syncNodeGrantBundle('node');
    await vi.waitFor(() => expect(stage === 'generation' ? generate : dispatch).toHaveBeenCalledOnce());
    await service.revokeNode('node');
    resolve(stage === 'generation' ? bundle : { success: true });
    await syncing;
    expect(state.lastNodeGrantBundles.size).toBe(0);
    expect(state.nodeGrantSyncs.size).toBe(0);
  });

  it('invalidates queued old syncs and preserves a new owner when old work settles', async () => {
    const { service, state, dispatch } = fixture();
    let releaseOld!: (value: any) => void;
    let releaseNew!: (value: any) => void;
    dispatch.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseOld = resolve;
      })
    );
    const first = service.syncNodeGrantBundle('node');
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const queued = service.syncNodeGrantBundle('node');
    await service.revokeNode('node');
    dispatch.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseNew = resolve;
      })
    );
    const successor = service.syncNodeGrantBundle('node');
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledOnce();
    const owner = state.nodeGrantSyncs.get('node');
    releaseOld({ success: true });
    await Promise.all([first, queued]);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(state.nodeGrantSyncs.get('node')).toBe(owner);
    expect(state.lastNodeGrantBundles.size).toBe(0);
    releaseNew({ success: true });
    await successor;
    expect(state.lastNodeGrantBundles.size).toBe(1);
    expect(state.nodeGrantSyncs.size).toBe(0);
    expect(state.nodeGrantEpochs.size).toBe(0);
  });

  it.each(['reject', 'unsuccessful'] as const)('keeps acknowledged A when queued B is %s', async (failure) => {
    const { service, state, dispatch, generate, bundle } = fixture();
    let release!: (value: any) => void;
    dispatch.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    if (failure === 'reject') dispatch.mockRejectedValueOnce(new Error('B failed'));
    else dispatch.mockResolvedValueOnce({ success: false, error: 'B failed' });
    generate.mockResolvedValueOnce(bundle).mockResolvedValueOnce({ ...bundle, generatedAtUnixMs: '200' });
    const first = service.syncNodeGrantBundle('node');
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const second = service.syncNodeGrantBundle('node');
    const results = Promise.allSettled([first, second]);
    release({ success: true });
    await results;
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(state.lastNodeGrantBundles.get('node')).toEqual(bundle);
    expect(state.nodeGrantSyncs.size).toBe(0);
    expect(state.nodeGrantEpochs.size).toBe(0);
  });

  it('releases epoch keys through repeated successful, failed and revoked lifecycles', async () => {
    const { service, state, dispatch } = fixture();
    for (let i = 0; i < 100; i++) {
      dispatch.mockResolvedValueOnce({ success: i % 2 === 0 });
      await service.syncNodeGrantBundle(`node-${i}`);
      await service.revokeNode(`node-${i}`);
    }
    expect(state.lastNodeGrantBundles.size).toBe(0);
    expect(state.nodeGrantSyncs.size).toBe(0);
    expect(state.nodeGrantEpochs.size).toBe(0);
  });
});

describe('managed database listener equality', () => {
  it('treats JSONB key and source ordering as semantically unchanged', () => {
    const persisted = {
      listenPort: 8123,
      networkName: 'opfield-db-binding',
      listenAddress: '172.28.0.1',
      allowedSources: ['container:worker', 'container:api'],
    };
    const desired = {
      networkName: 'opfield-db-binding',
      listenAddress: '172.28.0.1',
      listenPort: 8123,
      allowedSources: ['container:api', 'container:worker'],
    };

    expect(managedDatabaseListenerConfigsEqual(persisted, desired)).toBe(true);
  });

  it('detects a listener routing change', () => {
    const current = {
      networkName: 'opfield-db-binding',
      listenAddress: '172.28.0.1',
      listenPort: 5432,
      allowedSources: ['container:api'],
    };

    expect(managedDatabaseListenerConfigsEqual(current, { ...current, listenPort: 6379 })).toBe(false);
    expect(managedDatabaseListenerConfigsEqual(current, { ...current, allowedSources: ['container:other'] })).toBe(
      false
    );
  });
});

describe('RelayPolicyService route runtime', () => {
  // No remote relay holds a route unless a test says so (remoteRouteHolders reads relay_instance_policy_state).
  let remoteHolders: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    remoteHolders = vi.spyOn(RelayPolicyService.prototype as any, 'remoteRouteHolders').mockResolvedValue([]);
  });
  afterEach(() => remoteHolders.mockRestore());

  it('allocates signed revisions above both pool and legacy/global revisions', async () => {
    const rows = [
      [{ revision: 900, opfieldInstanceId: `${LEGACY_INSTALL_DIR_NAME}` }],
      [{ id: 'local', poolId: 'system' }],
      [],
      [],
    ];
    const lock = vi.fn();
    const select = () => {
      if (rows.length < 4) expect(lock).toHaveBeenCalledWith('share');
      const q: any = Promise.resolve(rows.shift());
      for (const method of ['from', 'where', 'limit', 'innerJoin']) q[method] = () => q;
      q.for = (mode: string) => {
        lock(mode);
        return q;
      };
      return q;
    };
    const set = vi.fn(() => ({ where: () => ({ returning: async () => [{ revision: 901 }] }) }));
    const db: any = {
      select,
      execute: vi.fn(),
      update: () => ({ set }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
    };
    db.transaction = (fn: any) => fn(db);
    const service = createService(db, { applySnapshot: vi.fn() });
    (service as any).policyKeys.resolveInstancePolicyKeys = async () => ({ signingKeyId: 'test', keys: [] });
    (service as any).policyKeys.signPayload = async () => ({ signingKeyId: 'test', signature: Buffer.alloc(64) });
    expect(await (service as any).buildInstanceSnapshot('local')).toMatchObject({ revision: 901, globalRevision: 900 });
    const expression = new PgDialect().sqlToQuery((set.mock.calls[0] as any)[0].desiredPolicyRevision);
    expect(expression.sql).toBe(
      'greatest(greatest("relay_pools"."desired_policy_revision", $1), least($2, greatest("relay_pools"."desired_policy_revision", $3) + $4)) + 1'
    );
    expect(expression.params).toEqual([900, 0, 900, 1_000_000]);
  });
  it('records the route tuples each relay snapshot carries and keeps dropped ones until acknowledged', async () => {
    const dropped = { routeId: 'route-old', endpointId: 'endpoint', routeGeneration: 1, endpointGeneration: 2 };
    const rows = [
      [{ revision: 900, opfieldInstanceId: `${LEGACY_INSTALL_DIR_NAME}` }],
      [{ id: 'remote', poolId: 'system' }],
      [],
      [{ endpointId: 'endpoint', assignmentGeneration: 3, generationState: 'active' }],
      [{ id: 'endpoint', generation: 2, subjectKind: 'daemon', subjectId: 'node', certificateSha256: 'sha256:n' }],
      [{ id: 'route-new', generation: 5, targetEndpointId: 'endpoint', sourceKind: 'daemon', ownerKind: 'x' }],
      [{ routes: [dropped] }],
    ];
    const select = () => {
      const q: any = Promise.resolve(rows.shift());
      for (const method of ['from', 'where', 'limit', 'innerJoin', 'for']) q[method] = () => q;
      return q;
    };
    const set = vi.fn(() => ({ where: () => ({ returning: async () => [{ revision: 901 }] }) }));
    const history = vi.fn();
    const db: any = {
      select,
      execute: vi.fn(),
      update: (table: unknown) => {
        // The build must not lock a relay_instances row after relay_policy_state (lock order).
        expect(table).not.toBe(relayInstances);
        return { set };
      },
      insert: () => ({ values: (values: unknown) => ({ onConflictDoUpdate: async () => history(values) }) }),
    };
    db.transaction = (fn: any) => fn(db);
    const service = createService(db, { applySnapshot: vi.fn() });
    (service as any).policyKeys.resolveInstancePolicyKeys = async () => ({ signingKeyId: 'test', keys: [] });
    (service as any).policyKeys.signPayload = async () => ({ signingKeyId: 'test', signature: Buffer.alloc(64) });
    await (service as any).buildInstanceSnapshot('remote');
    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'remote',
        routes: [
          { routeId: 'route-new', endpointId: 'endpoint', routeGeneration: 5, endpointGeneration: 2 },
          { ...dropped, removedAtRevision: 901 },
        ],
      })
    );
  });

  it('reads managed database binding runtime from its owned Relay route', async () => {
    const where = vi.fn().mockResolvedValue([{ id: 'route-binding-1' }]);
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };
    const getRouteRuntime = vi.fn().mockResolvedValue({
      routeId: 'route-binding-1',
      activeTunnels: '3',
      openedTotal: '9',
      completedTotal: '7',
      failedTotal: '1',
      throttledTotal: '2',
      sourceToTargetBytes: '1024',
      targetToSourceBytes: '2048',
      setupLatencyP95Microseconds: '12500',
      averageDurationMilliseconds: '350',
      lastActivityUnixMilliseconds: '1787932800000',
      metricsSinceUnixMilliseconds: '1787929200000',
    });
    const service = createService(db, { applySnapshot: vi.fn(), getRouteRuntime });

    await expect(service.getManagedDatabaseBindingRouteRuntime('binding-1')).resolves.toEqual({
      routeId: 'route-binding-1',
      activeStreams: 3,
      openedTotal: '9',
      completedTotal: '7',
      failedTotal: '1',
      throttledTotal: '2',
      sourceToTargetBytes: '1024',
      targetToSourceBytes: '2048',
      setupLatencyP95Ms: 12.5,
      averageDurationMs: 350,
      lastActivityAt: '2026-08-28T16:00:00.000Z',
      metricsSince: '2026-08-28T15:00:00.000Z',
      connections: null,
      relayCountersComplete: true,
    });
    expect(getRouteRuntime).toHaveBeenCalledWith('route-binding-1');
  });

  it('sums the placement routes of an Availability database link that has no route of its own', async () => {
    const answers = new Map<unknown, unknown[][]>([
      // The link's own route lookup, then the routes of its placements.
      [relayRoutes, [[], [{ id: 'route-placement-1' }, { id: 'route-placement-2' }, { id: 'route-placement-3' }]]],
      [managedDatabaseBindingPlacements, [[{ id: 'placement-1' }, { id: 'placement-2' }, { id: 'placement-3' }]]],
    ]);
    const query = (table: unknown) => {
      const rows = Promise.resolve(answers.get(table)!.shift() ?? []);
      return { where: () => Object.assign(rows, { limit: () => rows }) };
    };
    const db = { select: vi.fn(() => ({ from: query })) };
    const report = (routeId: string, opened: number, throttled: number) => ({
      routeId,
      activeTunnels: '2',
      openedTotal: String(opened),
      completedTotal: String(opened - 2),
      failedTotal: '0',
      throttledTotal: String(throttled),
      sourceToTargetBytes: '100',
      targetToSourceBytes: '200',
      setupLatencyP95Microseconds: '4000',
      averageDurationMilliseconds: '50',
      lastActivityUnixMilliseconds: '1787932800000',
      metricsSinceUnixMilliseconds: '1787929200000',
    });
    const getRouteRuntime = vi.fn(async (routeId: string) => {
      if (routeId === 'route-placement-3') throw new Error('relay route is not active');
      return routeId === 'route-placement-1' ? report(routeId, 10, 3) : report(routeId, 6, 4);
    });
    const service = createService(db, { applySnapshot: vi.fn(), getRouteRuntime });

    await expect(service.getManagedDatabaseBindingRouteRuntime('binding-1')).resolves.toMatchObject({
      activeStreams: 4,
      openedTotal: '16',
      completedTotal: '12',
      throttledTotal: '7',
      sourceToTargetBytes: '200',
      targetToSourceBytes: '400',
    });
    expect(getRouteRuntime).toHaveBeenCalledTimes(3);
  });

  describe('managed link connections reported by the workload node', () => {
    const relayReport = (routeId: string, active: number, throttled: number) => ({
      routeId,
      activeTunnels: String(active),
      openedTotal: '90',
      completedTotal: '20',
      failedTotal: '0',
      throttledTotal: String(throttled),
      sourceToTargetBytes: '100',
      targetToSourceBytes: '200',
      setupLatencyP95Microseconds: '4000',
      averageDurationMilliseconds: '50',
      lastActivityUnixMilliseconds: '1787932800000',
      metricsSinceUnixMilliseconds: '1787929200000',
    });
    const linkReport = (ownerKind: string, ownerId: string, active: number, rejected: number, at: string | null) => ({
      ownerKind,
      ownerId,
      activeConnections: active,
      connectionLimit: 64,
      rejectedTotal: rejected,
      lastRejectionReason: at ? 'link_limit' : null,
      lastRejectedAt: at,
      openedTotal: active * 10,
      sourceToTargetBytes: active * 1000,
      targetToSourceBytes: active * 3000,
    });
    const routesDb = (...answers: unknown[][]) => {
      const rows = [...answers];
      return { select: vi.fn(() => ({ from: () => ({ where: async () => rows.shift() ?? [] }) })) };
    };

    it('takes the open connections, sessions and bytes the node carried on every relay and adds its refusals', async () => {
      // The local relay carries 30 of the link's 64 connections; the pool's other relays carry the rest.
      const db = routesDb([
        {
          id: 'route-1',
          ownerKind: 'managed_database_binding',
          ownerId: 'binding-1',
          sourceKind: 'daemon',
          sourceId: 'node-1',
        },
      ]);
      const service = createService(db, {
        applySnapshot: vi.fn(),
        getRouteRuntime: vi.fn().mockResolvedValue(relayReport('route-1', 30, 2)),
      });
      const reportedAt = new Date();
      const managedLinkReport = vi.fn(() => ({
        link: linkReport('managed_database_binding', 'binding-1', 64, 6, '2026-10-02T10:00:00.000Z'),
        reportedAt,
      }));
      const requestHealthReport = vi.fn();
      service.setManagedLinkReports({ managedLinkReport, requestHealthReport });

      const runtime = await service.getManagedDatabaseBindingRouteRuntime('binding-1');
      // Completions stay the relay's: the node does not measure them.
      expect(runtime).toMatchObject({
        activeStreams: 64,
        throttledTotal: '8',
        openedTotal: '640',
        sourceToTargetBytes: '64000',
        targetToSourceBytes: '192000',
        completedTotal: '20',
        connections: {
          active: 64,
          limit: 64,
          rejectedTotal: '6',
          lastRejectionReason: 'link_limit',
          lastRejectedAt: '2026-10-02T10:00:00.000Z',
          reportedAt: reportedAt.toISOString(),
        },
      });
      expect(managedLinkReport).toHaveBeenCalledWith('node-1', 'managed_database_binding', 'binding-1');
      // A fresh report needs no new one.
      expect(requestHealthReport).not.toHaveBeenCalled();
    });

    it('takes completed sessions from nodes that count them and from the relays otherwise', async () => {
      const route = {
        id: 'route-1',
        ownerKind: 'container_link',
        ownerId: 'link-1',
        sourceKind: 'daemon',
        sourceId: 'node-1',
      };
      const db = routesDb([route], [route]);
      const service = createService(db, {
        applySnapshot: vi.fn(),
        getRouteRuntime: vi.fn().mockResolvedValue(relayReport('route-1', 0, 0)),
      });
      const report = (countsCompleted: boolean) => ({
        link: { ...linkReport('container_link', 'link-1', 1, 0, null), completedTotal: 7 },
        reportedAt: new Date(),
        countsCompleted,
      });
      service.setManagedLinkReports({ managedLinkReport: vi.fn(() => report(true)), requestHealthReport: vi.fn() });
      // Same-node sessions never reach a relay: the node's count is the link's.
      await expect(service.getContainerLinkRouteRuntime('link-1')).resolves.toMatchObject({ completedTotal: '7' });

      service.setManagedLinkReports({ managedLinkReport: vi.fn(() => report(false)), requestHealthReport: vi.fn() });
      // An older daemon reports no completions: the relay's value stands.
      await expect(service.getContainerLinkRouteRuntime('link-1')).resolves.toMatchObject({ completedTotal: '20' });
    });

    it('counts the connections a node reports for a container link, same-node dials included', async () => {
      const db = routesDb([
        { id: 'route-1', ownerKind: 'container_link', ownerId: 'link-1', sourceKind: 'daemon', sourceId: 'node-1' },
      ]);
      const service = createService(db, {
        applySnapshot: vi.fn(),
        getRouteRuntime: vi.fn().mockResolvedValue(relayReport('route-1', 0, 0)),
      });
      const managedLinkReport = vi.fn(() => ({
        link: linkReport('container_link', 'link-1', 5, 0, null),
        reportedAt: new Date(),
      }));
      service.setManagedLinkReports({ managedLinkReport, requestHealthReport: vi.fn() });

      const runtime = await service.getContainerLinkRouteRuntime('link-1');

      expect(runtime).toMatchObject({ activeStreams: 5, connections: { active: 5 } });
      expect(managedLinkReport).toHaveBeenCalledWith('node-1', 'container_link', 'link-1');
    });

    it('asks the node for a fresh report when its last one is older than the runtime poll', async () => {
      const db = routesDb([
        {
          id: 'route-1',
          ownerKind: 'managed_storage_binding',
          ownerId: 'storage-binding-1',
          sourceKind: 'daemon',
          sourceId: 'node-1',
        },
      ]);
      const getRouteRuntime = vi.fn().mockResolvedValue(relayReport('route-1', 3, 0));
      const service = createService(db, { applySnapshot: vi.fn(), getRouteRuntime });
      const requestHealthReport = vi.fn();
      service.setManagedLinkReports({
        managedLinkReport: vi.fn(() => ({
          link: linkReport('managed_storage_binding', 'storage-binding-1', 3, 0, null),
          reportedAt: new Date(Date.now() - 20_000),
        })),
        requestHealthReport,
      });

      await expect(service.getManagedStorageBindingRouteRuntime('storage-binding-1')).resolves.toMatchObject({
        activeStreams: 3,
        throttledTotal: '0',
        connections: { active: 3, limit: 64, rejectedTotal: '0', lastRejectionReason: null },
      });
      expect(getRouteRuntime).toHaveBeenCalledWith('route-1');
      expect(requestHealthReport).toHaveBeenCalledWith('node-1', 5_000);
    });

    it('merges the counters of the remote relays that hold a link the local relay does not (stand rc.1 F5)', async () => {
      const route = {
        id: 'route-1',
        ownerKind: 'managed_storage_binding',
        ownerId: 'storage-binding-1',
        sourceKind: 'daemon',
        sourceId: 'node-1',
      };
      const db = routesDb([route], [route]);
      const notHeld = Object.assign(new Error('5 NOT_FOUND: relay route is not active'), { code: 5 });
      const service = createService(db, {
        applySnapshot: vi.fn(),
        getRouteRuntime: vi.fn().mockRejectedValue(notHeld),
      });
      remoteHolders.mockResolvedValue([{ nodeId: 'relay-1' }, { nodeId: 'relay-2' }]);
      // protojson of RouteRuntimeResponse: 64-bit counters as strings.
      const answer = (failed: string, p95: string, last: string) => ({
        success: true,
        detail: JSON.stringify({
          runtimes: [
            {
              ...relayReport('route-1', 2, 1),
              failedTotal: failed,
              setupLatencyP95Microseconds: p95,
              lastActivityUnixMilliseconds: last,
            },
          ],
          missing: [],
        }),
      });
      const getRelayRouteRuntime = vi.fn(async (nodeId: string) =>
        nodeId === 'relay-1' ? answer('3', '9000', '1787932900000') : answer('2', '4000', '1787932800000')
      );
      service.setNodeDispatch({ getRelayRouteRuntime } as never);
      service.setManagedLinkReports({
        managedLinkReport: vi.fn(() => ({
          link: linkReport('managed_storage_binding', 'storage-binding-1', 4, 0, null),
          reportedAt: new Date(),
        })),
        requestHealthReport: vi.fn(),
      });

      await expect(service.getManagedStorageBindingRouteRuntime('storage-binding-1')).resolves.toMatchObject({
        routeId: 'route-1',
        activeStreams: 4,
        openedTotal: '40',
        failedTotal: '5',
        setupLatencyP95Ms: 9,
        lastActivityAt: new Date(1787932900000).toISOString(),
        relayCountersComplete: true,
        connections: { active: 4 },
      });
      expect(getRelayRouteRuntime).toHaveBeenCalledWith('relay-1', ['route-1'], 2_000);

      // A relay daemon without the command, or one that does not answer in time: what is known, marked incomplete.
      getRelayRouteRuntime.mockImplementation(async (nodeId: string) => {
        if (nodeId === 'relay-1') return null as never;
        throw new Error('command timed out');
      });
      await expect(service.getManagedStorageBindingRouteRuntime('storage-binding-1')).resolves.toMatchObject({
        activeStreams: 4,
        failedTotal: '0',
        relayCountersComplete: false,
        connections: { active: 4 },
      });
    });

    it('sums a route Secure Link over the relays of its member routes and never fails', async () => {
      const db = {
        select: vi.fn(() => ({ from: () => ({ where: async () => [{ id: 'route-a' }, { id: 'route-b' }] }) })),
      };
      const notHeld = Object.assign(new Error('relay route is not active'), { code: 5 });
      const getRouteRuntime = vi.fn(async (routeId: string) => {
        if (routeId === 'route-b') throw notHeld;
        return relayReport('route-a', 1, 0);
      });
      const service = createService(db, { applySnapshot: vi.fn(), getRouteRuntime });
      remoteHolders.mockResolvedValue([{ nodeId: 'relay-1' }]);
      service.setNodeDispatch({
        getRelayRouteRuntime: vi.fn(async () => ({
          success: true,
          detail: JSON.stringify({ runtimes: [relayReport('route-b', 2, 1)], missing: ['route-a'] }),
        })),
      } as never);

      await expect(service.getProxyRouteRuntime('host-1')).resolves.toMatchObject({
        activeStreams: 3,
        openedTotal: '180',
        throttledTotal: '1',
        relayCountersComplete: true,
      });

      // The local relay is down: its share is unknown, the remote one still counts.
      getRouteRuntime.mockRejectedValue(Object.assign(new Error('relay unavailable'), { code: 14 }));
      await expect(service.getProxyRouteRuntime('host-1')).resolves.toMatchObject({
        activeStreams: 2,
        relayCountersComplete: false,
      });
    });

    it('keeps the relay counts while a node does not report links (an older daemon)', async () => {
      const db = routesDb(
        [],
        [{ id: 'placement-1' }, { id: 'placement-2' }],
        [
          {
            id: 'route-1',
            ownerKind: 'managed_database_binding',
            ownerId: 'placement-1',
            sourceKind: 'daemon',
            sourceId: 'node-1',
          },
          {
            id: 'route-2',
            ownerKind: 'managed_database_binding',
            ownerId: 'placement-2',
            sourceKind: 'daemon',
            sourceId: 'node-2',
          },
        ]
      );
      const service = createService(db, {
        applySnapshot: vi.fn(),
        getRouteRuntime: vi.fn(async (routeId: string) => relayReport(routeId, 5, 1)),
      });
      service.setManagedLinkReports({
        managedLinkReport: vi.fn((nodeId: string, ownerKind: string, ownerId: string) =>
          nodeId === 'node-1' ? { link: linkReport(ownerKind, ownerId, 9, 4, null), reportedAt: new Date() } : null
        ),
        requestHealthReport: vi.fn(),
      });

      await expect(service.getManagedDatabaseBindingRouteRuntime('binding-1')).resolves.toMatchObject({
        activeStreams: 10,
        throttledTotal: '2',
        openedTotal: '180',
        sourceToTargetBytes: '200',
        connections: null,
      });
    });

    it('sums the reports of an Availability link across its placements', async () => {
      const db = routesDb(
        [],
        [{ id: 'placement-1' }, { id: 'placement-2' }],
        [
          {
            id: 'route-1',
            ownerKind: 'managed_database_binding',
            ownerId: 'placement-1',
            sourceKind: 'daemon',
            sourceId: 'node-1',
          },
          {
            id: 'route-2',
            ownerKind: 'managed_database_binding',
            ownerId: 'placement-2',
            sourceKind: 'daemon',
            sourceId: 'node-2',
          },
        ]
      );
      const service = createService(db, {
        applySnapshot: vi.fn(),
        getRouteRuntime: vi.fn(async (routeId: string) => relayReport(routeId, 1, 0)),
      });
      const older = new Date(Date.now() - 1_000);
      service.setManagedLinkReports({
        managedLinkReport: vi.fn((nodeId: string, ownerKind: string, ownerId: string) =>
          nodeId === 'node-1'
            ? { link: linkReport(ownerKind, ownerId, 12, 1, '2026-10-02T09:00:00.000Z'), reportedAt: older }
            : // The second placement's node runs none of the link's connections now.
              { link: null, reportedAt: new Date() }
        ),
        requestHealthReport: vi.fn(),
      });

      await expect(service.getManagedDatabaseBindingRouteRuntime('binding-1')).resolves.toMatchObject({
        activeStreams: 12,
        throttledTotal: '1',
        openedTotal: '120',
        sourceToTargetBytes: '12000',
        targetToSourceBytes: '36000',
        connections: {
          active: 12,
          limit: 64,
          rejectedTotal: '1',
          lastRejectedAt: '2026-10-02T09:00:00.000Z',
          reportedAt: older.toISOString(),
        },
      });
    });
  });

  it('recreates the adopted binding route when the previous owner route is already gone', async () => {
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
        })),
      })),
    };
    const db = {
      transaction: vi.fn(async (callback: (writer: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const service = createService(db, { applySnapshot: vi.fn() });
    vi.spyOn(service as any, 'ensureManagedDatabaseEndpoint').mockResolvedValue('endpoint-1');
    (service as any).grantIssuer = {
      requireNodeIdentity: vi.fn().mockResolvedValue({ certificateFingerprint: 'sha256:source' }),
    };
    const ensureRoute = vi.spyOn(service as any, 'ensureRoute').mockResolvedValue('route-new');
    vi.spyOn(service, 'syncSnapshot').mockResolvedValue(9);
    vi.spyOn(service as any, 'syncNodeGrants').mockResolvedValue(undefined);
    const listener = {
      networkName: 'opfield-db-binding',
      listenAddress: '172.28.0.1',
      listenPort: 5432,
      allowedSources: ['container:api'],
    };

    await expect(
      service.adoptBindingRoute(
        'missing-owner',
        'projection-owner',
        'database-1',
        'node-source',
        'node-target',
        listener
      )
    ).resolves.toBe('route-new');

    expect(ensureRoute).toHaveBeenCalledWith(
      'managed_database_binding',
      'projection-owner',
      'daemon',
      'node-source',
      'sha256:source',
      'endpoint-1',
      listener,
      // The connector egress of the route is kept as it is.
      undefined
    );
  });

  describe('adopting a binding route for a new owner', () => {
    const listener = {
      networkName: 'opfield-db-binding',
      listenAddress: '172.28.0.1',
      listenPort: 5432,
      allowedSources: ['deployment:api'],
    };
    const placementRoute = {
      id: 'route-1',
      generation: 5,
      ownerKind: 'managed_database_binding',
      ownerId: 'placement-binding',
      sourceKind: 'daemon',
      sourceId: 'node-source',
      sourceCertificateSha256: 'sha256:source',
      targetEndpointId: 'endpoint-1',
      managedDatabaseListener: { ...listener, allowedSources: [...listener.allowedSources] },
    };

    async function adopt(desiredListener: typeof listener, sourceNodeId = 'node-source') {
      const updates = new Map<unknown, Record<string, unknown>>();
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([placementRoute]) })) })),
        })),
        delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
        update: vi.fn((table: unknown) => ({
          set: vi.fn((values: Record<string, unknown>) => {
            updates.set(table, values);
            return { where: vi.fn().mockResolvedValue(undefined) };
          }),
        })),
      };
      const db = { transaction: vi.fn(async (callback: (writer: typeof tx) => Promise<unknown>) => callback(tx)) };
      const service = createService(db, { applySnapshot: vi.fn() });
      vi.spyOn(service as any, 'ensureManagedDatabaseEndpoint').mockResolvedValue('endpoint-1');
      (service as any).grantIssuer = {
        requireNodeIdentity: vi.fn().mockResolvedValue({
          certificateFingerprint: sourceNodeId === 'node-source' ? 'sha256:source' : 'sha256:other',
        }),
      };
      const ensureRoute = vi.spyOn(service as any, 'ensureRoute');
      vi.spyOn(service, 'syncSnapshot').mockResolvedValue(9);
      vi.spyOn(service as any, 'syncNodeGrants').mockResolvedValue(undefined);
      await expect(
        service.adoptBindingRoute(
          'placement-binding',
          'binding-1',
          'database-1',
          sourceNodeId,
          'node-target',
          desiredListener
        )
      ).resolves.toBe('route-1');
      expect(ensureRoute).not.toHaveBeenCalled();
      // The policy revision moves either way: the route changed owner.
      expect(updates.get(relayPolicyState)).toBeDefined();
      return updates.get(relayRoutes)!;
    }

    it('keeps the generation, so open connections survive, when the listener stays the same', async () => {
      const route = await adopt({ ...listener, allowedSources: [...listener.allowedSources] });
      expect(route).toMatchObject({ ownerId: 'binding-1', generation: 5, managedDatabaseListener: listener });
    });

    it('keeps the generation when only the admitted workloads change', async () => {
      const allowedSources = ['compose:api:web'];
      expect(await adopt({ ...listener, allowedSources })).toMatchObject({
        generation: 5,
        managedDatabaseListener: { ...listener, allowedSources },
      });
    });

    it('moves the generation when the listener address or the source changes', async () => {
      expect(await adopt({ ...listener, listenAddress: '172.29.0.1' })).toMatchObject({ generation: 6 });
      expect(await adopt(listener, 'node-other')).toMatchObject({ generation: 6, sourceId: 'node-other' });
    });
  });
});

describe('RelayPolicyService storage link routes', () => {
  const route = (id: string, sourceId: string, targetEndpointId = 'endpoint-old') => ({
    id,
    generation: 3,
    ownerKind: 'managed_storage_binding',
    ownerId: 'link-1',
    sourceKind: 'daemon',
    sourceId,
    sourceCertificateSha256: `sha256:${sourceId}`,
    targetEndpointId,
  });

  function harness(routes: ReturnType<typeof route>[]) {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const inserts: Array<Record<string, unknown>> = [];
    const tx = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(routes) })) })),
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          inserts.push(values);
          return { returning: vi.fn().mockResolvedValue([{ id: 'route-new' }]) };
        }),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updates.push({ table, values });
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    const db = { transaction: vi.fn(async (callback: (writer: typeof tx) => Promise<unknown>) => callback(tx)) };
    const service = createService(db, { applySnapshot: vi.fn() });
    vi.spyOn(service as any, 'ensureManagedStorageEndpoint').mockResolvedValue('endpoint-new');
    (service as any).grantIssuer = {
      requireNodeIdentity: vi.fn(async (nodeId: string) => ({ certificateFingerprint: `sha256:${nodeId}` })),
    };
    vi.spyOn(service, 'syncSnapshot').mockResolvedValue(9);
    const syncNodeGrants = vi.spyOn(service as any, 'syncNodeGrants').mockResolvedValue(undefined);
    return { service, updates, inserts, syncNodeGrants };
  }

  it('adds the route of a placement node next to the link route', async () => {
    const { service, updates, inserts } = harness([route('route-a', 'node-a', 'endpoint-new')]);
    await expect(service.ensureStorageBindingRoute('link-1', 'cluster-1', 'node-b', 'node-storage')).resolves.toBe(
      'route-new'
    );
    expect(inserts).toEqual([
      expect.objectContaining({ ownerKind: 'managed_storage_binding', ownerId: 'link-1', sourceId: 'node-b' }),
    ]);
    expect(updates.filter(({ table }) => table === relayRoutes)).toEqual([]);
  });

  it('takes every route of the link to the cluster the link moves to', async () => {
    const { service, updates, inserts, syncNodeGrants } = harness([
      route('route-a', 'node-a'),
      route('route-b', 'node-b'),
    ]);
    await expect(service.ensureStorageBindingRoute('link-1', 'cluster-2', 'node-a', 'node-storage')).resolves.toBe(
      'route-a'
    );
    expect(inserts).toEqual([]);
    expect(updates.filter(({ table }) => table === relayRoutes).map(({ values }) => values)).toEqual([
      expect.objectContaining({ targetEndpointId: 'endpoint-new', generation: 4 }),
      expect.objectContaining({ targetEndpointId: 'endpoint-new', generation: 4 }),
    ]);
    expect(syncNodeGrants.mock.calls.map(([nodeId]) => nodeId)).toEqual(['node-storage', 'node-a', 'node-b']);
  });
});

describe('RelayPolicyService snapshots', () => {
  it('serializes snapshot publication and continues after an earlier RPC failure', async () => {
    const service = createService({}, { applySnapshot: vi.fn() });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publish = vi
      .spyOn(service as any, 'syncSnapshotOnce')
      .mockImplementationOnce(async () => {
        await blocked;
        throw new Error('RPC failed');
      })
      .mockResolvedValueOnce(12);
    const first = expect(service.syncSnapshot()).rejects.toThrow('RPC failed');
    await Promise.resolve();
    const second = service.syncSnapshot();
    // Callers that arrive while a build is queued and not started share it.
    expect(service.syncSnapshot()).toBe(second);
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
    release();
    await first;
    await expect(second).resolves.toBe(12);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('refreshes the durable fence for grant issuance but bounds retries and preserves unrelated errors', async () => {
    const service = createService({}, { applySnapshot: vi.fn() });
    const issuer = (service as any).grantIssuer;
    const sync = vi.spyOn(service, 'syncSnapshot').mockResolvedValue(12);
    issuer.getNodeGrantBundle = vi
      .fn()
      .mockRejectedValueOnce(new RelayPolicyNotAcknowledgedError(11))
      .mockResolvedValueOnce({ revision: '11', grants: [] });
    await expect(service.getNodeGrantBundle('node')).resolves.toMatchObject({ revision: '11' });
    expect(sync).toHaveBeenCalledTimes(1);
    sync.mockClear();
    issuer.issueOpfieldConnectGrant = vi.fn().mockRejectedValue(new RelayPolicyNotAcknowledgedError(12));
    await expect(service.issueOpfieldConnectGrant('route', 'fingerprint')).rejects.toThrow('revision 12');
    expect(sync).toHaveBeenCalledTimes(2);
    expect(issuer.issueOpfieldConnectGrant).toHaveBeenCalledTimes(3);
    sync.mockClear();
    issuer.getNodeGrantBundle.mockRejectedValue(new Error('identity revoked'));
    await expect(service.getNodeGrantBundle('node')).rejects.toThrow('identity revoked');
    expect(sync).not.toHaveBeenCalled();
  });

  it('does not let a delayed pool ACK authorize a newer global projection', async () => {
    let globalRevision = 10;
    let transportRevision = 100;
    const local = {
      id: 'local',
      poolId: 'system',
      buildVersion: 'test',
      protocolMajor: 1,
      capabilities: { protocolMajor: 1, features: ['relay_pool_v1'] },
    };
    const key = { keyId: 'grant-key', encryptedPrivateKey: 'encrypted', encryptedDek: 'dek', publicKey: '' };
    const db: any = {
      select: () => {
        let table: unknown;
        const query: any = {
          from: (value: unknown) => {
            table = value;
            return query;
          },
          // biome-ignore lint/suspicious/noThenProperty: emulate Drizzle's lazy thenable query
          then: (resolve: (rows: unknown[]) => unknown) =>
            Promise.resolve(
              table === relayPolicyState
                ? [{ revision: globalRevision, opfieldInstanceId: `${LEGACY_INSTALL_DIR_NAME}` }]
                : table === relayInstances
                  ? [local]
                  : table === relayGrantSigningKeys
                    ? [key]
                    : []
            ).then(resolve),
        };
        for (const method of ['where', 'limit', 'innerJoin', 'for']) query[method] = () => query;
        return query;
      },
      execute: vi.fn(),
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [{ revision: ++transportRevision }] }) }),
      }),
    };
    db.transaction = (fn: any) => fn(db);
    let releaseFirstAck!: () => void;
    let snapshotSent!: () => void;
    const firstAck = new Promise<void>((resolve) => {
      releaseFirstAck = resolve;
    });
    const sent = new Promise<void>((resolve) => {
      snapshotSent = resolve;
    });
    const applyEncodedSnapshot = vi
      .fn()
      .mockImplementationOnce(async () => {
        snapshotSent();
        await firstAck;
        return { appliedRevision: '101' };
      })
      .mockResolvedValueOnce({ appliedRevision: '102' });
    const service = createService(db, {
      applySnapshot: vi.fn(),
      getHealth: vi
        .fn()
        .mockResolvedValue({ ...local, relayInstanceId: local.id, capabilities: local.capabilities.features }),
      bootstrapPolicyTrust: vi.fn(),
      applyEncodedSnapshot,
    });
    const keys = (service as any).policyKeys;
    keys.resolveInstancePolicyKeys = async () => ({ signingKeyId: 'policy-key', keys: [] });
    keys.getEnrollmentTrust = async () => ({ keyId: 'policy-key', publicKey: '', fingerprint: '' });
    keys.signPayload = async () => ({ signingKeyId: 'policy-key', signature: Buffer.alloc(64) });
    const issuer = (service as any).grantIssuer;
    const { privateKey } = generateKeyPairSync('ed25519');
    issuer.cryptoService.decryptPrivateKey = () => privateKey.export({ type: 'pkcs8', format: 'pem' });
    const claims = { kind: 'endpoint', subjectKind: 'daemon', subjectId: 'node', certificateSha256: 'sha256:test' };

    const syncingOldProjection = service.syncSnapshot();
    await sent;
    // A transition commits while the old projection is in flight. The pool's
    // transport sequence already exceeds both global revisions.
    globalRevision = 11;
    releaseFirstAck();
    await expect(syncingOldProjection).resolves.toBe(101);
    await expect(issuer.signGrant(claims)).rejects.toThrow(
      'Relay policy revision 11 has not been durably acknowledged'
    );

    await expect(service.syncSnapshot()).resolves.toBe(102);
    issuer.acknowledgeRevision(10); // A late ACK cannot regress the already confirmed fence.
    await expect(issuer.signGrant(claims)).resolves.toMatchObject({ keyId: 'grant-key' });
  });

  it('does not spend a revision or re-apply policy while the relay holds unchanged content', async () => {
    const local = {
      id: 'local',
      poolId: 'system',
      buildVersion: 'test',
      protocolMajor: 1,
      capabilities: { protocolMajor: 1, features: ['relay_pool_v1'] },
    };
    let grantKeys = [{ keyId: 'grant-a', publicKey: '' }];
    let bookkeeping: Record<string, unknown> | undefined;
    let poolRevision = 100;
    let applied = 0;
    const db: any = {
      select: () => {
        let table: unknown;
        const query: any = {
          from: (value: unknown) => {
            table = value;
            return query;
          },
          // biome-ignore lint/suspicious/noThenProperty: emulate Drizzle's lazy thenable query
          then: (resolve: (rows: unknown[]) => unknown) =>
            Promise.resolve(
              table === relayPolicyState
                ? [{ revision: 10, opfieldInstanceId: `${LEGACY_INSTALL_DIR_NAME}` }]
                : table === relayInstances
                  ? [local]
                  : table === relayGrantSigningKeys
                    ? grantKeys
                    : table === relayInstancePolicyState && bookkeeping
                      ? [bookkeeping]
                      : []
            ).then(resolve),
        };
        for (const method of ['where', 'limit', 'innerJoin', 'for']) query[method] = () => query;
        return query;
      },
      execute: vi.fn(),
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [{ revision: ++poolRevision }] }) }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: async () => {
            bookkeeping = values;
          },
        }),
      }),
    };
    db.transaction = (fn: any) => fn(db);
    const applyEncodedSnapshot = vi.fn(async () => {
      applied = poolRevision;
      return { appliedRevision: String(poolRevision) };
    });
    const service = createService(db, {
      applySnapshot: vi.fn(),
      getHealth: vi.fn(async () => ({
        ...local,
        relayInstanceId: local.id,
        capabilities: local.capabilities.features,
        appliedRevision: String(applied),
      })),
      bootstrapPolicyTrust: vi.fn(),
      applyEncodedSnapshot,
    });
    const keys = (service as any).policyKeys;
    let signingKeyId = 'policy-key';
    keys.resolveInstancePolicyKeys = async () => ({ signingKeyId, keys: [] });
    keys.signPayload = async () => ({ signingKeyId, signature: Buffer.alloc(64) });
    keys.getEnrollmentTrust = async () => ({ keyId: 'policy-key', publicKey: '', fingerprint: '' });
    let leaseBlocks: unknown[] = [];
    let leaseKeyRotations: unknown[] = [];
    let gatedRoutes = new Map<string, string>();
    service.setAvailabilityLeaseSource({
      relayPolicyFields: async () => ({ leaseBlocks, leaseKeyRotations }),
      retainedSigningKeyIds: async () => [],
      relayLeasePolicyIds: async () => ({ endpoints: new Map(), routes: gatedRoutes }),
    });
    let expected = 101;
    const sync = async (changed: boolean) => {
      const applies = applyEncodedSnapshot.mock.calls.length;
      if (changed) expected += 1;
      await expect(service.syncSnapshot()).resolves.toBe(expected);
      expect(poolRevision).toBe(expected);
      expect(applyEncodedSnapshot).toHaveBeenCalledTimes(applies + (changed ? 1 : 0));
    };

    expected = 100;
    await sync(true);
    await sync(false);
    await sync(false);

    // Every kind of content change is built and applied under a new revision, and only once.
    grantKeys = [...grantKeys, { keyId: 'grant-b', publicKey: '' }];
    await sync(true);
    await sync(false);
    leaseBlocks = [
      {
        signingKeyId: 'policy-key',
        kind: 'LEASE_BLOCK_KIND_MANIFEST',
        payload: Buffer.from('m1'),
        signature: Buffer.alloc(64),
      },
    ];
    await sync(true);
    await sync(false);
    leaseKeyRotations = [
      {
        previousKeyId: 'old',
        keyId: 'policy-key',
        publicKey: Buffer.alloc(32, 1),
        publicKeyFingerprint: 'sha256:a',
        signature: Buffer.alloc(64, 3),
      },
    ];
    await sync(true);
    gatedRoutes = new Map([['route-1', 'policy-1']]);
    // No route of this relay is gated: the gate adds nothing to its envelope.
    await sync(false);
    signingKeyId = 'rotated-key';
    await sync(true);
    await sync(false);

    // So is unchanged content once the relay no longer reports holding it (restored relay).
    applied = 50;
    await sync(true);

    // N-7: the relay lost its relay.db and reports no policy, while Opfield's stored report still names the
    // snapshot it held. The live report decides: the snapshot goes out at once.
    (local as any).appliedPolicyRevision = poolRevision;
    applied = 0;
    await sync(true);
    await sync(false);

    // A forced build (a relay reconnecting) sends even unchanged content.
    const forced = await (service as any).buildInstanceSnapshot('local', undefined, 0, { force: true });
    expect(forced.encodedRequest).not.toBeNull();
    expect(forced.revision).toBe(expected + 1);
  });

  it('delivers a remote relay its snapshot at once when it reports holding none (N-7)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-28T11:00:25Z'));
      const service = createService({}, { applySnapshot: vi.fn() });
      service.setNodeDispatch({} as never);
      const sync = vi.spyOn(service, 'syncRemoteInstancePolicy').mockResolvedValue(1);
      // Holding the revision it held before, or a newer one: nothing to do.
      service.noteRemoteAppliedRevision('relay-136', 40, 40);
      service.noteRemoteAppliedRevision('relay-136', 41, 40);
      expect(sync).not.toHaveBeenCalled();
      // relay.db renamed: the relay restarted without policy.
      service.noteRemoteAppliedRevision('relay-136', 0, 41);
      expect(sync).toHaveBeenCalledExactlyOnceWith('relay-136', 10_000, { force: true });
      // Its reports repeat until the snapshot lands; the push is not repeated every report.
      service.noteRemoteAppliedRevision('relay-136', 0, 0);
      expect(sync).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5_000);
      service.noteRemoteAppliedRevision('relay-136', 0, 0);
      expect(sync).toHaveBeenCalledTimes(2);
      // Restored from an older copy.
      service.noteRemoteAppliedRevision('relay-137', 30, 41);
      expect(sync).toHaveBeenLastCalledWith('relay-137', 10_000, { force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers the local relay its snapshot as soon as it reports needing one (N-7)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-28T10:59:05Z'));
      const service = createService({}, { applySnapshot: vi.fn() });
      const handlers = new Map<string, (payload: unknown) => void>();
      service.setEventBus({ subscribe: (event: string, handler: any) => handlers.set(event, handler) } as never);
      const sync = vi.spyOn(service, 'syncSnapshot').mockResolvedValue(1);
      const health = handlers.get('system.relay.health.changed')!;
      health({ state: 'suspect', reason: 'unreachable' });
      expect(sync).not.toHaveBeenCalled();
      health({ state: 'suspect', reason: 'policy_snapshot_required' });
      expect(sync).toHaveBeenCalledTimes(1);
      health({ state: 'critical', reason: 'policy_snapshot_required' });
      expect(sync).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2_000);
      health({ state: 'critical', reason: 'policy_snapshot_required' });
      expect(sync).toHaveBeenCalledTimes(2);
      // Serving again after an outage: grants went out meanwhile without its acknowledgement (F-2).
      vi.advanceTimersByTime(2_000);
      health({ state: 'healthy', reason: null });
      expect(sync).toHaveBeenCalledTimes(3);
      // Pool and relay runtime events say nothing of the local relay.
      vi.advanceTimersByTime(2_000);
      health({ poolId: 'system', action: 'instances_offline' });
      expect(sync).toHaveBeenCalledTimes(3);
      // The publish that opens an outage still reads healthy: nothing goes to a relay that does not serve.
      service.setLocalRelayOutage({
        latestOutage: () => ({ since: Date.now(), servingAgainAt: null, planned: false }),
      });
      vi.advanceTimersByTime(2_000);
      health({ state: 'healthy', reason: null });
      expect(sync).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replace a pool snapshot with legacy policy when Relay health lookup fails', async () => {
    const applySnapshot = vi.fn();
    const getHealth = vi.fn().mockRejectedValue(new Error('temporary Relay health failure'));
    const service = createService({} as never, { applySnapshot, getHealth });

    await expect(service.syncSnapshot()).rejects.toThrow('temporary Relay health failure');
    expect(applySnapshot).not.toHaveBeenCalled();
  });

  it('reads the complete snapshot in one read-only repeatable-read transaction', async () => {
    const rows = new Map<unknown, unknown[]>([
      [relayPolicyState, [{ revision: 7, opfieldInstanceId: 'opfield-1' }]],
      [relayGrantSigningKeys, [{ keyId: 'key-1', publicKey: Buffer.alloc(32, 1).toString('base64') }]],
      [
        relayEndpoints,
        [
          {
            id: 'endpoint-1',
            generation: 3,
            status: 'active',
            subjectKind: 'daemon',
            subjectId: 'node-target',
            certificateSha256: `sha256:${'a'.repeat(64)}`,
            maxConcurrentSessions: 8,
          },
        ],
      ],
      [
        relayRoutes,
        [
          {
            id: 'route-1',
            ownerKind: 'managed_database_binding',
            generation: 4,
            sourceKind: 'daemon',
            sourceId: 'node-source',
            sourceCertificateSha256: `sha256:${'b'.repeat(64)}`,
            targetEndpointId: 'endpoint-1',
            maxConcurrentSessions: 6,
            maxFrameBytes: 1024,
          },
          {
            id: 'route-2',
            ownerKind: 'proxy_host_secure_link',
            generation: 1,
            sourceKind: 'daemon',
            sourceId: 'node-source',
            sourceCertificateSha256: `sha256:${'b'.repeat(64)}`,
            targetEndpointId: 'endpoint-1',
            maxConcurrentSessions: 6,
            maxFrameBytes: 1024,
          },
        ],
      ],
    ]);
    const tx = {
      select: vi.fn(() => ({
        from: (table: unknown) => {
          const selected = rows.get(table) ?? [];
          if (table === relayPolicyState) {
            return { where: () => ({ limit: (limit: number) => Promise.resolve(selected.slice(0, limit)) }) };
          }
          if (table === relayGrantSigningKeys) {
            return { where: () => Promise.resolve(selected) };
          }
          return Promise.resolve(selected);
        },
      })),
    };
    const transaction = vi.fn(async (callback: (value: typeof tx) => unknown, _config: unknown) => callback(tx));
    const db = { transaction, select: vi.fn(() => Promise.reject(new Error('read escaped transaction'))) };
    const applySnapshot = vi.fn().mockResolvedValue({ appliedRevision: '7', unchanged: false });
    const service = createService(db, { applySnapshot });

    await expect(service.syncSnapshot()).resolves.toBe(7);

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(applySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: '7',
        opfieldInstanceId: 'opfield-1',
        admissionPolicy: {
          enabled: true,
          proxyTargetPressurePercent: 70,
          databaseReservePercent: 20,
          hardPressurePercent: 95,
        },
        endpoints: [expect.objectContaining({ endpointId: 'endpoint-1', generation: '3' })],
        routes: [
          expect.objectContaining({
            routeId: 'route-1',
            generation: '4',
            maxConcurrentSessions: 64,
            disableIdleTimeout: true,
            trafficClass: 'database',
          }),
          expect.objectContaining({
            routeId: 'route-2',
            generation: '1',
            maxConcurrentSessions: RELAY_UNCAPPED_SESSIONS,
            disableIdleTimeout: true,
            trafficClass: 'proxy',
          }),
        ],
      })
    );
  });

  it('does not reissue unchanged grants on every policy reconciliation', async () => {
    const service = createService({} as never, { applySnapshot: vi.fn() });
    const issuer = (service as any).grantIssuer;
    issuer.requireState = vi.fn().mockResolvedValue({ revision: 7 });
    issuer.policyNodeIds = vi.fn().mockResolvedValue([]);

    await service.refreshAllNodeGrantsIfDue();
    await service.refreshAllNodeGrantsIfDue();

    expect(issuer.policyNodeIds).toHaveBeenCalledOnce();
  });

  it('retries only the daemon whose grant refresh failed and skips disconnected ones', async () => {
    const service = createService({} as never, { applySnapshot: vi.fn() });
    const issuer = (service as any).grantIssuer;
    issuer.requireState = vi.fn().mockResolvedValue({ revision: 7 });
    issuer.policyNodeIds = vi.fn().mockResolvedValue(['up', 'failing', 'offline']);
    service.setNodeDispatch({ isNodeConnected: (nodeId: string) => nodeId !== 'offline' } as never);
    const grants = vi.spyOn(service, 'syncNodeGrants').mockImplementation(async (nodeId) => {
      if (nodeId === 'failing') throw new Error('down');
    });

    await expect(service.refreshAllNodeGrantsIfDue()).rejects.toThrow('1 daemon(s)');
    expect(grants.mock.calls).toEqual([
      ['up', { skipUnchanged: true }],
      ['failing', { skipUnchanged: true }],
    ]);

    grants.mockClear();
    grants.mockResolvedValue(undefined);
    await service.refreshAllNodeGrantsIfDue();
    expect(grants.mock.calls).toEqual([['failing', { skipUnchanged: true }]]);

    grants.mockClear();
    await service.refreshAllNodeGrantsIfDue();
    expect(grants).not.toHaveBeenCalled();
    expect(issuer.policyNodeIds).toHaveBeenCalledOnce();
  });

  it('serializes grant bundle generation and dispatch per node', async () => {
    const service = createService({} as never, { applySnapshot: vi.fn() });
    let releaseFirst!: () => void;
    const firstDispatch = new Promise<{ success: true }>((resolve) => {
      releaseFirst = () => resolve({ success: true });
    });
    const sendRelayGrantBundle = vi.fn().mockReturnValueOnce(firstDispatch).mockResolvedValueOnce({ success: true });
    service.setNodeDispatch({ sendRelayGrantBundle } as never);
    const bundles = vi
      .spyOn(service, 'getNodeGrantBundle')
      .mockResolvedValueOnce({ revision: '7', generatedAtUnixMs: '100', grants: [] })
      .mockResolvedValueOnce({ revision: '7', generatedAtUnixMs: '101', grants: [] });

    const first = service.syncNodeGrantBundle('node-1');
    await vi.waitFor(() => expect(sendRelayGrantBundle).toHaveBeenCalledOnce());
    const second = service.syncNodeGrantBundle('node-1');
    await Promise.resolve();

    expect(bundles).toHaveBeenCalledOnce();
    releaseFirst();
    await Promise.all([first, second]);
    expect(sendRelayGrantBundle.mock.calls.map((call) => call[1].generatedAtUnixMs)).toEqual(['100', '101']);
  });

  it('does not resend a routine bundle that allows the same as the one just delivered', async () => {
    const service = createService({} as never, { applySnapshot: vi.fn() });
    const sendRelayGrantBundle = vi.fn().mockResolvedValue({ success: true });
    service.setNodeDispatch({ sendRelayGrantBundle } as never);
    const signed = (claims: Record<string, unknown>) => ({
      keyId: 'grant-key',
      payload: Buffer.from(JSON.stringify(claims)),
      signature: Buffer.from(String(Math.random())),
    });
    let routeGeneration = 1;
    let issuedAt = 1_000;
    vi.spyOn(service, 'getNodeGrantBundle').mockImplementation(async () => {
      issuedAt += 1;
      return {
        revision: '7',
        generatedAtUnixMs: String(issuedAt),
        grants: [
          {
            role: 'connect',
            ownerKind: 'proxy_host_secure_link',
            ownerId: 'link',
            routeId: 'route',
            grant: signed({ grantId: `g-${issuedAt}`, issuedAt, expiresAt: issuedAt + 60, routeGeneration }),
          },
        ],
      };
    });

    await service.syncNodeGrants('node-1', { skipUnchanged: true });
    await service.syncNodeGrants('node-1', { skipUnchanged: true });
    expect(sendRelayGrantBundle).toHaveBeenCalledTimes(1);
    // A reconnect or revocation path delivers regardless.
    await service.syncNodeGrants('node-1');
    expect(sendRelayGrantBundle).toHaveBeenCalledTimes(2);
    // A changed grant is delivered even on the routine path.
    routeGeneration = 2;
    await service.syncNodeGrants('node-1', { skipUnchanged: true });
    expect(sendRelayGrantBundle).toHaveBeenCalledTimes(3);
  });

  it('skips an unchanged routine bundle without waiting for remote relay pushes (N-14)', async () => {
    const service = createService({} as never, { applySnapshot: vi.fn() });
    const sendRelayGrantBundle = vi.fn().mockResolvedValue({ success: true });
    service.setNodeDispatch({ sendRelayGrantBundle } as never);
    vi.spyOn(service, 'getNodeGrantBundle').mockResolvedValue({
      revision: '7',
      generatedAtUnixMs: '100',
      grants: [],
    } as never);
    await service.syncNodeGrants('node-1', { skipUnchanged: true });
    expect(sendRelayGrantBundle).toHaveBeenCalledTimes(1);
    // A remote push that never finishes (a busy or unreachable pool relay) no longer costs every routine sync the grace.
    const wait = vi.spyOn(service as any, 'waitForRemotePush');
    await service.syncNodeGrants('node-1', { skipUnchanged: true });
    expect(wait).not.toHaveBeenCalled();
    expect(sendRelayGrantBundle).toHaveBeenCalledTimes(1);
    // A delivery that is not routine still waits for the push.
    await service.syncNodeGrants('node-1');
    expect(wait).toHaveBeenCalledTimes(1);
    expect(sendRelayGrantBundle).toHaveBeenCalledTimes(2);
  });

  it("publishes and grants a node's registry routes once for all of its bindings (N-14)", async () => {
    const service = createService({} as never, { applySnapshot: vi.fn() }) as any;
    const reconcile = vi.spyOn(service, 'reconcileInternalRegistryEndpoint').mockResolvedValue('endpoint');
    service.grantIssuer = { requireNodeIdentity: vi.fn().mockResolvedValue({ certificateFingerprint: 'fp' }) };
    const ensureRoute = vi
      .spyOn(service, 'ensureRoute')
      .mockImplementation(async (_kind: unknown, ownerId: unknown) => `route-${ownerId}`);
    const snapshot = vi.spyOn(service, 'syncSnapshot').mockResolvedValue(1);
    const grants = vi.spyOn(service, 'syncNodeGrants').mockResolvedValue(undefined);

    const routes = await service.ensureInternalRegistryRoutes(['a', 'b', 'c'], 'node-1');

    expect([...routes.entries()]).toEqual([
      ['a', 'route-a'],
      ['b', 'route-b'],
      ['c', 'route-c'],
    ]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(ensureRoute).toHaveBeenCalledTimes(3);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(grants).toHaveBeenCalledTimes(1);
    expect(grants).toHaveBeenCalledWith('node-1', { skipUnchanged: true });
    // Published only after every route exists.
    expect(snapshot.mock.invocationCallOrder[0]).toBeGreaterThan(ensureRoute.mock.invocationCallOrder[2]!);
    await expect(service.ensureInternalRegistryRoute('d', 'node-1')).resolves.toBe('route-d');
  });

  it('probes the managed database source route before declaring the binding usable', async () => {
    const service = createService({} as never, { applySnapshot: vi.fn() });
    const sendRelayGrantBundle = vi.fn().mockResolvedValue({ success: true });
    const probeRelayCandidate = vi.fn().mockResolvedValue({ success: true });
    service.setNodeDispatch({ sendRelayGrantBundle, probeRelayCandidate } as never);
    const candidate = { relayInstanceId: 'relay-1', assignmentGeneration: '3' } as any;
    const getNodeGrantBundle = vi.spyOn(service, 'getNodeGrantBundle').mockResolvedValue({
      revision: '7',
      generatedAtUnixMs: '100',
      grants: [
        {
          role: 'connect',
          ownerKind: 'managed_database_binding',
          ownerId: '11111111-1111-4111-8111-111111111111',
          routeId: 'route-1',
          targetEndpointId: 'endpoint-1',
          grant: 'signed-grant',
          candidates: [candidate],
        },
      ],
    } as any);

    await service.syncNodeGrantBundle('node-1');
    await service.probeManagedDatabaseBindingRoute('node-1', '11111111-1111-4111-8111-111111111111');

    expect(getNodeGrantBundle).toHaveBeenCalledOnce();
    expect(probeRelayCandidate).toHaveBeenCalledWith('node-1', {
      probeId: '11111111-1111-4111-8111-111111111111',
      role: 'source',
      endpointId: 'endpoint-1',
      routeId: 'route-1',
      assignmentGeneration: '3',
      candidate,
    });
  });

  it('checks Relay Pool support without treating the internal registry local service as a node', async () => {
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ nodeId: LEGACY_INTERNAL_REGISTRY_ID, subjectKind: 'local_service' }]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => Promise.resolve([{ sourceKind: 'daemon', sourceId: '11111111-1111-4111-8111-111111111111' }]),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () =>
            Promise.resolve([
              {
                id: '11111111-1111-4111-8111-111111111111',
                capabilities: { capabilities: ['relay_pool_v1'] },
              },
            ]),
        }),
      });
    const service = createService({ select } as never, { applySnapshot: vi.fn() });

    await expect((service as any).grantIssuer.endpointPathSupportsPool('endpoint-1')).resolves.toBe(true);
  });

  it('keeps a persisted owner revocation when the runtime snapshot must be deferred', async () => {
    const joined = (rows: unknown[]) => ({ where: () => Promise.resolve(rows) });
    const ownedRoute = {
      sourceKind: 'daemon',
      sourceId: 'source-node',
      subjectKind: 'daemon',
      subjectId: 'target-node',
    };
    const ownedEndpoint = { subjectKind: 'daemon', subjectId: 'target-node', sourceKind: null, sourceId: null };
    const select = vi
      .fn()
      .mockReturnValueOnce({ from: () => ({ innerJoin: () => joined([ownedRoute]) }) })
      .mockReturnValueOnce({ from: () => ({ leftJoin: () => joined([ownedEndpoint]) }) });
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const tx = {
      select,
      delete: vi.fn(() => ({
        where: () => ({ returning: () => Promise.resolve([{ id: 'deleted' }]) }),
      })),
      update: vi.fn(() => ({ set: () => ({ where: updateWhere }) })),
    };
    const db = { transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)) };
    const service = createService(db, { applySnapshot: vi.fn() });
    vi.spyOn(service, 'syncSnapshot').mockRejectedValue(new Error('relay unavailable'));
    const grants = vi.spyOn(service as any, 'syncNodeGrants').mockResolvedValue(undefined);

    await expect(
      service.revokeOwner('proxy_host_secure_link', 'proxy-1', { allowDeferredSnapshot: true })
    ).resolves.toBeUndefined();

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(tx.delete).toHaveBeenCalledTimes(2);
    expect(updateWhere).toHaveBeenCalledOnce();
    // Only the daemons that lost something get a new bundle.
    expect(new Set(grants.mock.calls.map(([nodeId]) => nodeId))).toEqual(new Set(['source-node', 'target-node']));
  });
});

describe('describeGrantRefreshFailures', () => {
  it('names the daemons once per distinct reason and caps the list', () => {
    const rotation = 'new policy signing keys require signed rotation';
    const failures = [
      ...['n1', 'n2', 'n3', 'n4', 'n5'].map((nodeId) => ({ nodeId, reason: rotation })),
      { nodeId: 'n6', reason: 'daemon offline' },
    ];
    expect(describeGrantRefreshFailures(failures)).toBe(`${rotation} (n1, n2, n3 and 2 more); daemon offline (n6)`);
    // The fallback refusal names its daemon: still one reason, and the reasons are capped too.
    const rejected = ['node-1', 'node-2', 'node-3', 'node-4'].map((nodeId) => ({
      nodeId,
      reason: `Daemon ${nodeId} rejected relay grants`,
    }));
    expect(describeGrantRefreshFailures(rejected)).toBe(
      'Daemon <node> rejected relay grants (node-1, node-2, node-3 and 1 more)'
    );
    const distinct = ['w', 'x', 'y', 'z'].map((nodeId) => ({ nodeId: `${nodeId}1`, reason: `error ${nodeId}` }));
    expect(describeGrantRefreshFailures(distinct)).toBe('error w (w1); error x (x1); error y (y1); 1 other reason(s)');
  });
});

describe('RelayPolicyService pending grant refresh reports', () => {
  it('reports the same pending refresh once per interval and a different one at once', () => {
    const service = createService({}, { applySnapshot: vi.fn() });
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    try {
      const report = (message: string, at: number) =>
        (service as any).reportPendingGrantRefresh(new Error(message), at);
      const pending = (count: number) => `Failed to refresh relay grants for ${count} daemon(s)`;
      // rc.20 B-17: every rebalance activation reconciled while one daemon was away, one warning every 2 s.
      // A planned Relay Pool update leaves bundles pending too: info, not a warning (rc.11 O-2).
      for (let at = 0; at < 60_000; at += 2_000) report(pending(1), at);
      expect(info).toHaveBeenCalledOnce();
      expect(debug).toHaveBeenCalledTimes(29);
      report(pending(2), 61_000);
      expect(info).toHaveBeenCalledTimes(2);
      report(pending(2), 61_000 + 5 * 60_000);
      expect(info).toHaveBeenCalledTimes(3);
      expect(info).toHaveBeenLastCalledWith('Relay policy reconciled but some daemon grant bundles remain pending', {
        error: pending(2),
      });
    } finally {
      info.mockRestore();
      debug.mockRestore();
    }
  });
});

describe('RelayPolicyService lifecycle events', () => {
  it('bumps and reapplies the relay snapshot when persisted relay settings change', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const where = vi.fn().mockResolvedValue(undefined);
    const tx = { update: vi.fn(() => ({ set: vi.fn(() => ({ where })) })) };
    const db = { transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)) };
    const service = createService(db, { applySnapshot: vi.fn() });
    const syncSnapshot = vi.spyOn(service, 'syncSnapshot').mockResolvedValue(8);
    const refresh = vi.spyOn(service, 'refreshAllNodeGrantsIfDue').mockResolvedValue(undefined);
    service.setEventBus({
      subscribe: vi.fn((channel: string, handler: (payload: unknown) => void) => handlers.set(channel, handler)),
    } as never);

    handlers.get('system.config.changed')!({ relayChanged: true });
    await (service as any).relaySettingsSync;

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(syncSnapshot).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(true);
  });

  it('ignores binding events on the shared database channel', () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const service = createService({ transaction: vi.fn(), select: vi.fn() }, { applySnapshot: vi.fn() });
    const updateStatus = vi.spyOn(service as any, 'updateManagedDatabaseStatus').mockResolvedValue(undefined);
    const revokeOwner = vi.spyOn(service, 'revokeOwner').mockResolvedValue(undefined);
    service.setEventBus({
      subscribe: vi.fn((channel: string, handler: (payload: unknown) => void) => handlers.set(channel, handler)),
    } as never);

    const databaseChanged = handlers.get('database.changed')!;
    databaseChanged({
      resourceKind: 'managed_database_binding',
      managedDatabaseId: 'database-1',
      bindingId: 'binding-1',
      action: 'binding.ready',
      status: 'ready',
    });
    databaseChanged({
      resourceKind: 'managed_database_binding',
      managedDatabaseId: 'database-1',
      bindingId: 'binding-1',
      action: 'binding.deleted',
      status: 'deleting',
    });

    expect(updateStatus).not.toHaveBeenCalled();
    expect(revokeOwner).not.toHaveBeenCalled();
  });

  it('continues to apply managed database lifecycle events', () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const service = createService({ transaction: vi.fn(), select: vi.fn() }, { applySnapshot: vi.fn() });
    const updateStatus = vi.spyOn(service as any, 'updateManagedDatabaseStatus').mockResolvedValue(undefined);
    service.setEventBus({
      subscribe: vi.fn((channel: string, handler: (payload: unknown) => void) => handlers.set(channel, handler)),
    } as never);

    handlers.get('database.changed')!({
      resourceKind: 'managed_database',
      managedDatabaseId: 'database-1',
      action: 'ready',
      status: 'ready',
    });

    expect(updateStatus).toHaveBeenCalledWith('database-1', 'ready');
  });
});

describe('RelayPolicyService opfield tunnels', () => {
  it.each(['error', 'deleting', 'stopped'])('does not reactivate a database in %s status', async (status) => {
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ nodeId: 'node-target', status }]) }),
        }),
      })),
    };
    const service = createService(db, { applySnapshot: vi.fn() });
    const ensureRoute = vi.spyOn(service, 'ensureOpfieldRoute');

    await expect(service.openOpfieldTunnel('database-1', `sha256:${'a'.repeat(64)}`)).rejects.toThrow(
      'Managed database is unavailable'
    );
    expect(ensureRoute).not.toHaveBeenCalled();
  });

  function inactiveEndpointFixture() {
    const update = vi.fn();
    const tx = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  id: 'endpoint-1',
                  subjectId: 'node-target',
                  certificateSha256: `sha256:${'a'.repeat(64)}`,
                  status: 'inactive',
                },
              ]),
          }),
        }),
      })),
      update,
    };
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ nodeId: 'node-target', status: 'ready' }]) }),
        }),
      })),
      transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const service = createService(db, { applySnapshot: vi.fn() });
    vi.spyOn((service as any).grantIssuer, 'requireNodeIdentity').mockResolvedValue({
      certificateFingerprint: `sha256:${'a'.repeat(64)}`,
    });
    return { service, update };
  }

  it('leaves endpoint status to the lifecycle reconciliation and refuses with a code while it stays inactive', async () => {
    const { service, update } = inactiveEndpointFixture();
    const reconcile = vi.spyOn(service as any, 'reconcileInactiveEndpoint').mockResolvedValue(false);

    await expect(service.ensureManagedDatabaseEndpoint('database-1', 'node-target')).rejects.toMatchObject({
      statusCode: 409,
      code: 'MANAGED_DATABASE_RELAY_ENDPOINT_PENDING',
    });
    expect(reconcile).toHaveBeenCalledWith('managed_database', 'database-1');
    expect(update).not.toHaveBeenCalled();
  });

  it('serves the endpoint of a ready database once the reconciliation activated it (restore into a new database)', async () => {
    const { service, update } = inactiveEndpointFixture();
    vi.spyOn(service as any, 'reconcileInactiveEndpoint').mockResolvedValue(true);
    vi.spyOn(service as any, 'ensureLegacyCompatibleAssignment').mockResolvedValue(undefined);
    vi.spyOn(service, 'syncSnapshot').mockResolvedValue(undefined as never);

    await expect(service.ensureManagedDatabaseEndpoint('database-1', 'node-target')).resolves.toBe('endpoint-1');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('RelayPolicyService policy signing trust', () => {
  const ACTIVE = { keyId: 'active', publicKey: Buffer.alloc(32, 1), fingerprint: 'sha256:active' };
  const signedRotationRefusal = () =>
    Object.assign(new Error('9 FAILED_PRECONDITION: new policy signing keys require signed rotation'), { code: 9 });

  function localPoolFixture(
    relayOverrides: Record<string, ReturnType<typeof vi.fn>> = {},
    tables: Map<unknown, unknown[]> = new Map()
  ) {
    let transportRevision = 100;
    const local = {
      id: 'local',
      poolId: 'system',
      kind: 'local',
      policySigningKeyId: null,
      health: null,
      buildVersion: 'test',
      protocolMajor: 1,
      capabilities: { protocolMajor: 1, features: ['relay_pool_v1', 'policy_trust_reset_v1'] },
    };
    const db: any = {
      select: () => {
        let table: unknown;
        const query: any = {
          from: (value: unknown) => {
            table = value;
            return query;
          },
          // biome-ignore lint/suspicious/noThenProperty: emulate Drizzle's lazy thenable query
          then: (resolve: (rows: unknown[]) => unknown) =>
            Promise.resolve(
              tables.has(table)
                ? tables.get(table)!
                : table === relayPolicyState
                  ? [{ revision: 10, opfieldInstanceId: `${LEGACY_INSTALL_DIR_NAME}` }]
                  : table === relayInstances
                    ? [local]
                    : []
            ).then(resolve),
        };
        for (const method of ['where', 'limit', 'innerJoin', 'for']) query[method] = () => query;
        return query;
      },
      execute: vi.fn(),
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [{ revision: ++transportRevision }] }) }),
      }),
    };
    db.transaction = (fn: any) => fn(db);
    const relay = {
      applySnapshot: vi.fn(),
      getHealth: vi.fn().mockResolvedValue({
        ...local,
        relayInstanceId: local.id,
        capabilities: local.capabilities.features,
        policyKeyIds: ['stale'],
      }),
      bootstrapPolicyTrust: vi.fn().mockResolvedValue(undefined),
      applyEncodedSnapshot: vi.fn(async () => ({ appliedRevision: String(transportRevision) })),
      resetLocalPolicyTrust: vi.fn().mockResolvedValue({ replacedKeyIds: ['stale'] }),
      ...relayOverrides,
    };
    const service = createService(db, relay);
    const keys = (service as any).policyKeys;
    keys.getEnrollmentTrust = vi.fn().mockResolvedValue(ACTIVE);
    keys.resolveInstancePolicyKeys = vi.fn().mockResolvedValue({ signingKeyId: 'active', keys: [] });
    keys.signPayload = vi.fn(async () => ({ signingKeyId: 'active', signature: Buffer.alloc(64) }));
    return { service, relay, keys, local };
  }

  it("signs each relay's snapshot with the key its own trust selects and starts validFrom early", async () => {
    const { service, keys, local } = localPoolFixture();
    const activatedAt = new Date('2026-09-23T12:00:00Z');
    const verifyUntil = new Date('2026-09-23T12:30:00Z');
    keys.resolveInstancePolicyKeys.mockResolvedValue({
      signingKeyId: 'old',
      keys: [
        {
          keyId: 'active',
          publicKey: Buffer.alloc(32, 1),
          fingerprint: 'sha256:a',
          status: 'active',
          activatedAt,
          verifyUntil: null,
        },
        {
          keyId: 'old',
          publicKey: Buffer.alloc(32, 2),
          fingerprint: 'sha256:o',
          status: 'verification_only',
          activatedAt: null,
          verifyUntil,
        },
      ],
    });

    await (service as any).buildInstanceSnapshot('local', ['old']);

    expect(keys.resolveInstancePolicyKeys).toHaveBeenCalledWith(
      expect.objectContaining({ id: local.id, policySigningKeyId: null }),
      expect.any(Date),
      ['old']
    );
    const [payload, signingKeyId] = keys.signPayload.mock.calls[0] as unknown as [Buffer, string];
    expect(signingKeyId).toBe('old');
    const decoded = decodeRelayV1Message('PolicyEnvelopePayload', payload) as {
      policySigningKeys: Array<{ keyId: string; status: string; validFromUnix: string; verifyUntilUnix: string }>;
    };
    expect(decoded.policySigningKeys).toEqual([
      expect.objectContaining({
        keyId: 'active',
        status: 'active',
        validFromUnix: String(activatedAt.getTime() / 1000 - 300),
        verifyUntilUnix: '0',
      }),
      expect.objectContaining({
        keyId: 'old',
        status: 'verification_only',
        validFromUnix: '0',
        verifyUntilUnix: String(verifyUntil.getTime() / 1000),
      }),
    ]);
  });

  it('carries the availability lease blocks and key chain in every signed relay snapshot', async () => {
    const { service, keys } = localPoolFixture();
    const block = {
      signingKeyId: 'active',
      kind: 'LEASE_BLOCK_KIND_MANIFEST',
      payload: Buffer.from('manifest'),
      signature: Buffer.alloc(64, 7),
    };
    const rotation = {
      previousKeyId: 'old',
      keyId: 'active',
      publicKey: Buffer.alloc(32, 1),
      publicKeyFingerprint: 'sha256:a',
      signature: Buffer.alloc(64, 3),
    };
    service.setAvailabilityLeaseSource({
      relayPolicyFields: async () => ({ leaseBlocks: [block], leaseKeyRotations: [rotation] }),
      retainedSigningKeyIds: async () => ['old'],
    });

    await (service as any).buildInstanceSnapshot('local', ['active']);

    const [payload] = keys.signPayload.mock.calls[0] as unknown as [Buffer, string];
    const decoded = decodeRelayV1Message('PolicyEnvelopePayload', payload) as {
      leaseBlocks: unknown[];
      leaseKeyRotations: unknown[];
    };
    expect(decoded.leaseBlocks).toEqual([block]);
    expect(decoded.leaseKeyRotations).toEqual([rotation]);
    await expect((keys as any).retainedKeyIds()).resolves.toEqual(['old']);
  });

  it('marks lease-gated endpoints and routes with their policy, and fails closed without the gate', async () => {
    const endpoint = {
      id: 'endpoint-1',
      ownerKind: 'proxy_host_secure_link',
      ownerId: 'member-link',
      generation: 1,
      subjectKind: 'daemon',
      subjectId: 'node-1',
      certificateSha256: 'sha256:node',
      maxConcurrentSessions: 0,
    };
    const route = {
      id: 'route-1',
      ownerKind: 'managed_database_binding',
      ownerId: 'projection-1',
      generation: 1,
      sourceKind: 'daemon',
      sourceId: 'node-1',
      sourceCertificateSha256: 'sha256:node',
      targetEndpointId: 'endpoint-1',
      maxConcurrentSessions: 0,
      maxFrameBytes: 0,
    };
    const plain = { ...endpoint, id: 'endpoint-2', ownerId: 'other-link' };
    const tables = new Map<unknown, unknown[]>([
      [
        relayEndpointAssignments,
        [
          { endpointId: 'endpoint-1', assignmentGeneration: 1, generationState: 'active' },
          { endpointId: 'endpoint-2', assignmentGeneration: 1, generationState: 'active' },
        ],
      ],
      [relayEndpoints, [endpoint, plain]],
      [relayRoutes, [route]],
    ]);
    const { service, keys } = localPoolFixture({}, tables);
    const relayLeasePolicyIds = vi.fn(async () => ({
      endpoints: new Map([['endpoint-1', 'policy-1']]),
      routes: new Map([['route-1', 'policy-1']]),
    }));
    service.setAvailabilityLeaseSource({
      relayPolicyFields: async () => ({ leaseBlocks: [], leaseKeyRotations: [] }),
      retainedSigningKeyIds: async () => [],
      relayLeasePolicyIds,
    });

    await (service as any).buildInstanceSnapshot('local', ['active']);

    expect(relayLeasePolicyIds).toHaveBeenCalledWith([endpoint, plain], [route]);
    const [payload] = keys.signPayload.mock.calls[0] as unknown as [Buffer, string];
    const decoded = decodeRelayV1Message('PolicyEnvelopePayload', payload) as {
      endpoints: Array<{ endpointId: string; leasePolicyId: string }>;
      routes: Array<{ routeId: string; leasePolicyId: string }>;
    };
    expect(decoded.endpoints.map(({ endpointId, leasePolicyId }) => [endpointId, leasePolicyId])).toEqual([
      ['endpoint-1', 'policy-1'],
      ['endpoint-2', ''],
    ]);
    expect(decoded.routes).toEqual([expect.objectContaining({ routeId: 'route-1', leasePolicyId: 'policy-1' })]);

    relayLeasePolicyIds.mockRejectedValueOnce(new Error('database unavailable'));
    await expect((service as any).buildInstanceSnapshot('local', ['active'])).rejects.toThrow('database unavailable');
  });

  it('pins the active key on the local relay and signs with it', async () => {
    const { service, relay, keys } = localPoolFixture();
    await expect(service.syncSnapshot()).resolves.toBe(101);
    expect(relay.bootstrapPolicyTrust).toHaveBeenCalledWith('active', ACTIVE.publicKey, ACTIVE.fingerprint);
    expect(relay.resetLocalPolicyTrust).not.toHaveBeenCalled();
    expect(keys.resolveInstancePolicyKeys).toHaveBeenCalledWith(expect.anything(), expect.any(Date), ['active']);
  });

  it('lets a retained old key introduce the active key to a lagging local relay without a reset', async () => {
    const { service, relay, keys } = localPoolFixture({
      bootstrapPolicyTrust: vi.fn().mockRejectedValue(signedRotationRefusal()),
    });
    keys.resolveInstancePolicyKeys.mockResolvedValue({ signingKeyId: 'stale', keys: [] });

    await expect(service.syncSnapshot()).resolves.toBe(101);
    expect(relay.resetLocalPolicyTrust).not.toHaveBeenCalled();
    expect(keys.resolveInstancePolicyKeys).toHaveBeenLastCalledWith(expect.anything(), expect.any(Date), ['stale']);
    expect(relay.applyEncodedSnapshot).toHaveBeenCalledTimes(1);
  });

  it('re-pins a local relay restored from a backup older than every key Opfield can sign with', async () => {
    const { service, relay, keys } = localPoolFixture({
      bootstrapPolicyTrust: vi.fn().mockRejectedValue(signedRotationRefusal()),
    });

    await expect(service.syncSnapshot()).resolves.toBe(101);
    expect(relay.resetLocalPolicyTrust).toHaveBeenCalledWith('active', ACTIVE.publicKey, ACTIVE.fingerprint);
    expect(keys.resolveInstancePolicyKeys).toHaveBeenLastCalledWith(expect.anything(), expect.any(Date), ['active']);
    expect(relay.applyEncodedSnapshot).toHaveBeenCalledTimes(1);
  });

  it('reports an actionable status when the local relay predates the reset call', async () => {
    const refusal = signedRotationRefusal();
    const { service, relay, local } = localPoolFixture({
      bootstrapPolicyTrust: vi.fn().mockRejectedValue(refusal),
    });
    relay.getHealth.mockResolvedValue({
      ...local,
      relayInstanceId: local.id,
      capabilities: ['relay_pool_v1'],
      policyKeyIds: ['stale'],
    });

    await expect(service.syncSnapshot()).rejects.toThrow('Update the Relay Pool');
    expect(relay.resetLocalPolicyTrust).not.toHaveBeenCalled();
    expect(relay.applyEncodedSnapshot).not.toHaveBeenCalled();
    expect(service.getLocalPolicyTrustStatus()).toMatchObject({
      state: 'recovery_unsupported',
      message: LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE,
      trustedKeyIds: ['stale'],
    });
  });

  it('recovers a locked-out local relay on the first sync after it is updated to a build that can reset', async () => {
    const { service, relay, local } = localPoolFixture({
      bootstrapPolicyTrust: vi.fn().mockRejectedValue(signedRotationRefusal()),
    });
    relay.getHealth.mockResolvedValue({
      ...local,
      relayInstanceId: local.id,
      capabilities: ['relay_pool_v1'],
      policyKeyIds: ['stale'],
    });
    await expect(service.syncSnapshot()).rejects.toThrow('Update the Relay Pool');

    // The Relay Pool update replaced the container; no cooldown holds the reset back.
    relay.getHealth.mockResolvedValue({
      ...local,
      relayInstanceId: local.id,
      capabilities: ['relay_pool_v1', 'policy_trust_reset_v1'],
      policyKeyIds: ['stale'],
    });
    await expect(service.syncSnapshot()).resolves.toBe(101);
    expect(relay.resetLocalPolicyTrust).toHaveBeenCalledOnce();
    expect(service.getLocalPolicyTrustStatus()).toMatchObject({ state: 'recovered' });
  });

  it('starts no cooldown when a relay answers that it cannot reset', async () => {
    const reset = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('12 UNIMPLEMENTED'), { code: 12 }))
      .mockResolvedValueOnce({ replacedKeyIds: ['stale'] });
    const { service } = localPoolFixture({
      bootstrapPolicyTrust: vi.fn().mockRejectedValue(signedRotationRefusal()),
      resetLocalPolicyTrust: reset,
    });

    await expect(service.syncSnapshot()).rejects.toThrow('Update the Relay Pool');
    expect(service.getLocalPolicyTrustStatus()).toMatchObject({ state: 'recovery_unsupported' });
    await expect(service.syncSnapshot()).resolves.toBe(101);
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('audits a reset, shows the recovery, and never repeats it within the cooldown', async () => {
    const { service, relay } = localPoolFixture({
      bootstrapPolicyTrust: vi.fn().mockRejectedValue(signedRotationRefusal()),
    });
    const audit = { log: vi.fn().mockResolvedValue(true) };
    service.setAuditService(audit);

    await expect(service.syncSnapshot()).resolves.toBe(101);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.policy_trust.reset',
        resourceId: 'local',
        details: expect.objectContaining({ activeKeyId: 'active', replacedKeyIds: ['stale'] }),
      })
    );
    expect(service.getLocalPolicyTrustStatus()).toMatchObject({ state: 'recovered', trustedKeyIds: ['active'] });

    // Locked out again right away: something else is wrong, a second reset would only loop.
    await expect(service.syncSnapshot()).rejects.toThrow('cooldown');
    expect(relay.resetLocalPolicyTrust).toHaveBeenCalledTimes(1);
    expect(service.getLocalPolicyTrustStatus()).toMatchObject({ state: 'locked_out' });
  });

  it('re-pins the active key when the relay pins it but refuses its signature window', async () => {
    const lockout = Object.assign(new Error('9 FAILED_PRECONDITION: policy envelope signature is invalid'), {
      code: 9,
    });
    const { service, relay } = localPoolFixture();
    relay.applyEncodedSnapshot.mockRejectedValueOnce(lockout);

    await expect(service.syncSnapshot()).resolves.toBe(102);
    expect(relay.bootstrapPolicyTrust).toHaveBeenCalledTimes(1); // The relay already pins the key.
    expect(relay.resetLocalPolicyTrust).toHaveBeenCalledWith('active', ACTIVE.publicKey, ACTIVE.fingerprint);
    expect(relay.applyEncodedSnapshot).toHaveBeenCalledTimes(2);
  });

  it('never resets trust for refusals a retry or a new snapshot repairs', async () => {
    const { service, relay } = localPoolFixture({
      applyEncodedSnapshot: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('9 FAILED_PRECONDITION: policy envelope was issued in the future'), { code: 9 })
        ),
    });

    await expect(service.syncSnapshot()).rejects.toThrow('issued in the future');
    expect(relay.resetLocalPolicyTrust).not.toHaveBeenCalled();
    expect(service.getLocalPolicyTrustStatus()).toBeNull();
  });

  it('continues the pool revision above what the local relay already applied', async () => {
    const { service, relay } = localPoolFixture();
    relay.getHealth.mockResolvedValue({
      ...(await relay.getHealth()),
      appliedRevision: '5000',
    });
    const build = vi.spyOn(service as any, 'buildInstanceSnapshot');
    await service.syncSnapshot();
    expect(build).toHaveBeenCalledWith('local', ['active'], 5000, { liveAppliedRevision: 5000 });
  });

  it('never resets trust for other bootstrap failures', async () => {
    const { service, relay } = localPoolFixture({
      bootstrapPolicyTrust: vi.fn().mockRejectedValue(new Error('14 UNAVAILABLE: connection refused')),
    });

    await expect(service.syncSnapshot()).rejects.toThrow('connection refused');
    expect(relay.resetLocalPolicyTrust).not.toHaveBeenCalled();
  });

  it('destroys unneeded old private keys on every rotation pass', async () => {
    const service = createService({}, { applySnapshot: vi.fn() });
    const keys = (service as any).policyKeys;
    keys.promoteAcknowledgedPending = vi.fn().mockResolvedValue(false);
    keys.retireExpiredVerificationKeys = vi.fn().mockResolvedValue(false);
    keys.destroyUnneededPrivateKeys = vi.fn().mockResolvedValue(true);

    await expect(service.finalizePolicySigningKeyRotation()).resolves.toBe(false);
    expect(keys.destroyUnneededPrivateKeys).toHaveBeenCalledTimes(1);
  });
});

describe('RelayPolicyService relay recovery surfaces', () => {
  it('allocates a revision above the one a relay reported after an Opfield database restore', async () => {
    const rows = [
      [{ revision: 900, opfieldInstanceId: `${LEGACY_INSTALL_DIR_NAME}` }],
      [{ id: 'remote', poolId: 'system', appliedPolicyRevision: 7000 }],
      [],
      [],
    ];
    const select = () => {
      const q: any = Promise.resolve(rows.shift());
      for (const method of ['from', 'where', 'limit', 'innerJoin', 'for']) q[method] = () => q;
      return q;
    };
    const set = vi.fn(() => ({ where: () => ({ returning: async () => [{ revision: 7001 }] }) }));
    const db: any = {
      select,
      execute: vi.fn(),
      update: () => ({ set }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
    };
    db.transaction = (fn: any) => fn(db);
    const service = createService(db, { applySnapshot: vi.fn() });
    (service as any).policyKeys.resolveInstancePolicyKeys = async () => ({ signingKeyId: 'test', keys: [] });
    (service as any).policyKeys.signPayload = async () => ({ signingKeyId: 'test', signature: Buffer.alloc(64) });

    await (service as any).buildInstanceSnapshot('remote', undefined, 6500);
    const expression = new PgDialect().sqlToQuery((set.mock.calls[0] as any)[0].desiredPolicyRevision);
    // The relay's report counts, but one report moves the sequence by a bounded jump only.
    expect(expression.params).toEqual([900, 7000, 900, 1_000_000]);
  });

  it('flags remote relays only re-enrollment repairs and local relays that cannot reset', async () => {
    const service = createService({}, { applySnapshot: vi.fn() });
    (service as any).policyKeys.assessReportedTrust = vi.fn(async (sets: string[][]) =>
      sets.map((reported) => (reported.length === 0 ? null : !reported.includes('destroyed')))
    );
    const trust = await service.describePolicyTrust([
      { id: 'remote-locked', kind: 'remote', health: { policySigningKeyIds: ['destroyed'] } },
      { id: 'remote-fine', kind: 'remote', health: { policySigningKeyIds: ['active'] } },
      { id: 'remote-unknown', kind: 'remote', health: null },
      {
        id: 'local',
        kind: 'local',
        health: { policySigningKeyIds: ['destroyed'] },
        capabilities: { features: ['relay_pool_v1'] },
      },
    ]);
    expect(trust.get('remote-locked')).toMatchObject({
      state: 'reenrollment_required',
      trustedKeyIds: ['destroyed'],
      message: expect.stringContaining('Re-enroll'),
    });
    expect(trust.has('remote-fine')).toBe(false);
    expect(trust.has('remote-unknown')).toBe(false);
    expect(trust.get('local')).toMatchObject({ state: 'recovery_unsupported' });
  });

  it('delivers a changed policy to remote relays once, in order, before grants go out', async () => {
    const service = createService({}, { applySnapshot: vi.fn() });
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const once = vi
      .spyOn(service as any, 'syncRemoteInstancePolicyOnce')
      .mockImplementationOnce(async () => {
        await blocked;
        order.push('first');
        return 1;
      })
      .mockImplementationOnce(async () => {
        order.push('second');
        return 2;
      });
    const first = service.syncRemoteInstancePolicy('node-1');
    const second = service.syncRemoteInstancePolicy('node-1', 10_000);
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    // The second push waits for the first to be delivered.
    expect(once).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(['first', 'second']);
    expect(once).toHaveBeenLastCalledWith('node-1', 10_000, false);

    const db: any = {
      select: () => {
        const q: any = Promise.resolve([{ nodeId: 'node-1' }, { nodeId: 'node-2' }]);
        q.from = () => q;
        q.where = () => q;
        return q;
      },
    };
    const pushing = createService(db, { applySnapshot: vi.fn() });
    pushing.setNodeDispatch({} as never);
    const push = vi.spyOn(pushing, 'syncRemoteInstancePolicy').mockResolvedValue(1);
    (pushing as any).remotePolicyRevisions.set('node-2', 12);
    await (pushing as any).pushChangedRemotePolicies(12);
    expect(push).toHaveBeenCalledExactlyOnceWith('node-1', 10_000);

    // A relay that did not answer is left to the lease refresh for a while.
    push.mockClear();
    push.mockRejectedValueOnce(new Error('timed out'));
    await (pushing as any).pushChangedRemotePolicies(13);
    expect(push).toHaveBeenCalledTimes(2);
    push.mockClear();
    await (pushing as any).pushChangedRemotePolicies(14);
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe('RelayPolicyService remote pushes after the control plane returns (B-18)', () => {
  function relayDb(rows: unknown[]) {
    return {
      select: () => {
        const q: any = Promise.resolve(rows);
        q.from = () => q;
        q.where = () => q;
        q.limit = () => Promise.resolve(rows);
        return q;
      },
    } as any;
  }

  it('keeps pushing policy changes to a relay that was only disconnected', async () => {
    const pushing = createService(relayDb([{ nodeId: 'relay-137' }]), { applySnapshot: vi.fn() });
    pushing.setNodeDispatch({} as never);
    const push = vi
      .spyOn(pushing, 'syncRemoteInstancePolicy')
      .mockRejectedValueOnce(new Error('Node relay-137 is not connected'))
      .mockResolvedValue(1);

    // Opfield returns before the relay node reconnected.
    await (pushing as any).pushChangedRemotePolicies(20);
    // A member endpoint changes right after the relay reconnected: its policy must reach the relay before the
    // daemons present grants for it, not a minute later.
    await (pushing as any).pushChangedRemotePolicies(21);

    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenLastCalledWith('relay-137', 10_000);
  });

  it('lifts the push cooldown of a relay that took a snapshot again', async () => {
    const service = createService(relayDb([{ id: 'instance-137', nodeId: 'relay-137' }]), { applySnapshot: vi.fn() });
    const sendRelayPolicy = vi.fn().mockResolvedValue({ success: true });
    service.setNodeDispatch({ sendRelayPolicy } as never);
    vi.spyOn(service as any, 'buildInstanceSnapshot').mockResolvedValue({
      encodedRequest: Buffer.from('snapshot'),
      revision: 7,
      expiresAtUnix: 1,
      globalRevision: 30,
    });
    (service as any).remotePolicyPushFailedAt.set('relay-137', Date.now());

    // The forced push on reconnect.
    await service.syncRemoteInstancePolicy('relay-137', undefined, { force: true });

    expect(sendRelayPolicy).toHaveBeenCalledOnce();
    expect((service as any).remotePolicyPushFailedAt.has('relay-137')).toBe(false);
  });
});

describe('RelayPolicyService grant issuance around the local relay', () => {
  it('issues grants without the local relay acknowledgement only while that relay is unreachable', async () => {
    const service = createService({}, { applySnapshot: vi.fn() });
    service.setNodeDispatch({} as never);
    const issuer = (service as any).grantIssuer;
    const push = vi.spyOn(service as any, 'pushChangedRemotePolicies').mockResolvedValue(undefined);
    const allow = vi.spyOn(issuer, 'allowUnacknowledgedRevision');
    vi.spyOn(service, 'syncSnapshot').mockRejectedValue(
      Object.assign(new Error('14 UNAVAILABLE: connect ECONNREFUSED'), { code: 14 })
    );
    issuer.getNodeGrantBundle = vi
      .fn()
      .mockRejectedValueOnce(new RelayPolicyNotAcknowledgedError(12))
      .mockResolvedValueOnce({ revision: '12', grants: [] });

    await expect(service.getNodeGrantBundle('node')).resolves.toMatchObject({ revision: '12' });
    // Remote relays get the policy before grants that depend on it.
    expect(push).toHaveBeenCalledWith(12);
    expect(allow).toHaveBeenCalledWith(12);

    // A relay that refuses the policy is not unreachable: the fence holds.
    vi.mocked(service.syncSnapshot).mockRejectedValue(
      Object.assign(new Error('9 FAILED_PRECONDITION: snapshot revision conflicts'), { code: 9 })
    );
    issuer.getNodeGrantBundle.mockRejectedValue(new RelayPolicyNotAcknowledgedError(13));
    await expect(service.getNodeGrantBundle('node')).rejects.toThrow('conflicts');
    expect(allow).toHaveBeenCalledTimes(1);
  });

  it('lets the fence pass a bypassed revision and nothing newer', async () => {
    const service = createService({}, { applySnapshot: vi.fn() });
    const issuer = (service as any).grantIssuer;
    let revision = 12;
    issuer.requireState = async () => ({ revision, opfieldInstanceId: `${LEGACY_INSTALL_DIR_NAME}` });
    issuer.settings = { getConfig: async () => ({ relayGrantTtlHours: 4 }) };
    issuer.db = {
      select: () => {
        const query: any = Promise.resolve([{ keyId: 'grant', encryptedPrivateKey: 'x', encryptedDek: 'y' }]);
        for (const method of ['from', 'where', 'limit']) query[method] = () => query;
        return query;
      },
    };
    const { privateKey } = generateKeyPairSync('ed25519');
    issuer.cryptoService = { decryptPrivateKey: () => privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    const claims = { kind: 'endpoint', subjectKind: 'daemon', subjectId: 'node', certificateSha256: 'sha256:x' };
    await expect(issuer.signGrant(claims)).rejects.toThrow('revision 12');
    issuer.allowUnacknowledgedRevision(12);
    await expect(issuer.signGrant(claims)).resolves.toMatchObject({ keyId: 'grant' });
    revision = 13;
    await expect(issuer.signGrant(claims)).rejects.toThrow('revision 13');
  });

  it('opens an Opfield tunnel on an intact route without re-ensuring it', async () => {
    const rows: Record<string, unknown[]> = {
      route: [
        {
          id: 'route-1',
          sourceKind: LEGACY_RELAY_SOURCE_KIND,
          sourceId: `${LEGACY_INSTALL_DIR_NAME}`,
          sourceCertificateSha256: 'sha256:app',
          targetEndpointId: 'endpoint-1',
        },
      ],
      endpoint: [
        {
          id: 'endpoint-1',
          ownerKind: 'managed_database',
          ownerId: 'db-1',
          subjectId: 'node-1',
          certificateSha256: 'sha256:node',
          status: 'active',
        },
      ],
      assignment: [{ id: 'generation-1' }],
    };
    const order = ['route', 'endpoint', 'assignment'];
    const db: any = {
      select: () => {
        const query: any = Promise.resolve(rows[order.shift()!]);
        for (const method of ['from', 'where', 'limit']) query[method] = () => query;
        return query;
      },
    };
    const service = createService(db, { applySnapshot: vi.fn() });
    const issuer = (service as any).grantIssuer;
    issuer.requireState = async () => ({ revision: 1, opfieldInstanceId: `${LEGACY_INSTALL_DIR_NAME}` });
    issuer.requireNodeIdentity = async () => ({ certificateFingerprint: 'sha256:node' });
    const route = (service as any).currentOpfieldRoute(
      LEGACY_MANAGED_DATABASE_OWNER_KIND,
      'managed_database',
      'db-1',
      'node-1',
      'sha256:app'
    );
    await expect(route).resolves.toBe('route-1');

    // The target node's certificate changed: the route must be re-ensured.
    order.push('route', 'endpoint', 'assignment');
    issuer.requireNodeIdentity = async () => ({ certificateFingerprint: 'sha256:renewed' });
    await expect(
      (service as any).currentOpfieldRoute(
        LEGACY_MANAGED_DATABASE_OWNER_KIND,
        'managed_database',
        'db-1',
        'node-1',
        'sha256:app'
      )
    ).resolves.toBeNull();
  });

  it('continues the revision above a daemon that holds newer grants after a database restore', async () => {
    const set = vi.fn(() => ({ where: async () => undefined }));
    const db: any = { update: () => ({ set }) };
    const service = createService(db, { applySnapshot: vi.fn() });
    (service as any).grantIssuer.requireState = async () => ({
      revision: 40,
      opfieldInstanceId: `${LEGACY_INSTALL_DIR_NAME}`,
    });
    const sync = vi.spyOn(service, 'syncSnapshot').mockResolvedValue(1);
    const bundles = vi
      .spyOn(service, 'syncNodeGrantBundle')
      .mockResolvedValueOnce({ success: false, error: 'relay grant revision 40 is older than 9000' } as never)
      .mockResolvedValueOnce({ success: true } as never);
    service.setNodeDispatch({} as never);

    await expect(service.syncNodeGrants('node-1')).resolves.toBeUndefined();
    const expression = new PgDialect().sqlToQuery((set.mock.calls[0] as any)[0].revision);
    expect(expression.sql).toBe('greatest("relay_policy_state"."revision" + 1, $1)');
    expect(expression.params).toEqual([9001]);
    expect(sync).toHaveBeenCalledOnce();
    expect(bundles).toHaveBeenCalledTimes(2);

    // Rate-limited: a second refusal right away is reported, not looped on.
    bundles.mockResolvedValueOnce({ success: false, error: 'stale relay grant bundle' } as never);
    await expect(service.syncNodeGrants('node-1')).rejects.toThrow('stale relay grant bundle');
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('treats only real restore evidence as a reason to raise the revision, by a bounded jump', async () => {
    const set = vi.fn(() => ({ where: async () => undefined }));
    const service = createService({ update: () => ({ set }) } as never, { applySnapshot: vi.fn() });
    (service as any).grantIssuer.requireState = async () => ({
      revision: 40,
      opfieldInstanceId: `${LEGACY_INSTALL_DIR_NAME}`,
    });
    vi.spyOn(service, 'syncSnapshot').mockResolvedValue(1);
    const raise = (error: string) => (service as any).raiseRevisionAboveDaemon('node-1', error);

    // An older bundle delivered late: the daemon holds a revision Opfield issued.
    await expect(raise('relay grant revision 30 is older than 35')).resolves.toBe(false);
    // One stale refusal without a revision is ordinary out-of-order delivery.
    await expect(raise('stale relay grant bundle')).resolves.toBe(false);
    await expect(raise('stale relay grant bundle')).resolves.toBe(false);
    expect(set).not.toHaveBeenCalled();
    // A daemon that keeps refusing holds a sequence Opfield lost.
    await expect(raise('stale relay grant bundle')).resolves.toBe(true);
    expect(new PgDialect().sqlToQuery((set.mock.calls[0] as any)[0].revision).params).toEqual([1_000_041]);

    // A daemon claiming a revision near the precision limit moves it by the bounded jump only.
    (service as any).lastRevisionRaiseAt = 0;
    await expect(raise(`relay grant revision 1 is older than ${Number.MAX_SAFE_INTEGER - 10}`)).resolves.toBe(true);
    expect(new PgDialect().sqlToQuery((set.mock.calls[1] as any)[0].revision).params).toEqual([1_000_041]);
  });

  it('never makes the local snapshot sync wait for remote relays', async () => {
    const service = createService({}, { applySnapshot: vi.fn() });
    service.setNodeDispatch({} as never);
    const push = vi.spyOn(service as any, 'pushChangedRemotePolicies').mockReturnValue(new Promise(() => undefined));
    (service as any).startRemotePush(7);
    expect((service as any).remotePushRevision).toBe(7);
    // A grant dispatch waits for the push only briefly.
    vi.useFakeTimers();
    try {
      const waited = (service as any).waitForRemotePush();
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(waited).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    await Promise.resolve();
    expect(push).toHaveBeenCalledWith(7);
  });
});

describe('RelayPolicyService local trust reset guards', () => {
  const ACTIVE = { keyId: 'active', publicKey: Buffer.alloc(32, 1), fingerprint: 'sha256:active' };
  function recoveryService(resetLocalPolicyTrust: ReturnType<typeof vi.fn>) {
    const service = createService({}, { applySnapshot: vi.fn(), resetLocalPolicyTrust });
    return service as any;
  }
  const health = (capabilities: string[]) => ({ policyKeyIds: ['old'], relayInstanceId: 'local', capabilities });

  it('does not start the reset cooldown when the relay could not be reached', async () => {
    const reset = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('14 UNAVAILABLE'), { code: 14 }))
      .mockResolvedValueOnce({ replacedKeyIds: ['old'] });
    const service = recoveryService(reset);
    const refusal = Object.assign(new Error('9 FAILED_PRECONDITION: policy envelope signature is invalid'), {
      code: 9,
    });
    await expect(service.recoverLocalPolicyTrust(ACTIVE, health(['policy_trust_reset_v1']), refusal)).rejects.toThrow(
      'UNAVAILABLE'
    );
    await expect(
      service.recoverLocalPolicyTrust(ACTIVE, health(['policy_trust_reset_v1']), refusal)
    ).resolves.toBeUndefined();
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('tells the operator to update a local relay that cannot rebind to this Opfield', async () => {
    const reset = vi.fn();
    const service = recoveryService(reset);
    const refusal = Object.assign(
      new Error(`9 FAILED_PRECONDITION: snapshot ${LEGACY_INSTALL_DIR_NAME} instance changed`),
      { code: 9 }
    );
    await expect(service.recoverLocalPolicyTrust(ACTIVE, health(['relay_pool_v1']), refusal)).rejects.toThrow(
      'Update the Relay Pool'
    );
    expect(reset).not.toHaveBeenCalled();
    expect(service.getLocalPolicyTrustStatus()).toMatchObject({ state: 'recovery_unsupported' });
  });
});
