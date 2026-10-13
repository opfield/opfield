import { describe, expect, it, vi } from 'vitest';
import {
  relayEndpoints,
  relayInstancePolicyState,
  relayInstances,
  relayPolicyState,
  relayPools,
  relayRoutes,
} from '@/db/schema/index.js';
import type { RelayPolicyRouteEntry } from '@/db/schema/relay.js';
import { RELAY_REVOCATION_ACK_TIMEOUT_MS } from './relay-revocation-fence.js';
import {
  holdsCurrentSnapshot,
  RelayRevocationFenceService,
  recordBuiltSnapshot,
} from './relay-revocation-fence.service.js';

const T0 = Date.parse('2026-09-27T10:00:00.000Z');

interface World {
  revision: number;
  issued: number;
  applied: number;
  policyRoutes: RelayPolicyRouteEntry[] | null;
  routes: Array<{ id: string; generation: number; targetEndpointId: string; sourceKind: string; sourceId: string }>;
}

function database(world: World) {
  const writes: RelayPolicyRouteEntry[][] = [];
  const execute = vi.fn();
  const answer = (table: unknown, joined: boolean, projected: string[], orphans: boolean) => {
    if (orphans) return [];
    if (table === relayPolicyState) return [{ revision: world.revision }];
    if (table === relayPools) return [{ id: 'system', revision: world.issued }];
    if (table === relayRoutes) return world.routes;
    if (table === relayEndpoints)
      return [{ id: 'endpoint-1', generation: 1, subjectKind: 'daemon', subjectId: 'node-target' }];
    if (table !== relayInstancePolicyState || !world.policyRoutes) return [];
    // The evaluator joins relay_instances for identity and the applied revision; plain history reads do not.
    if (joined)
      return [
        {
          id: 'relay-1',
          poolId: 'system',
          displayName: 'edge-1',
          appliedPolicyRevision: world.applied,
          policyRoutes: world.policyRoutes,
        },
      ];
    return projected.includes('routes') ? [{ routes: world.policyRoutes }] : [{ id: 'relay-1' }];
  };
  const db: any = {
    select: (fields: Record<string, unknown> = {}) => {
      let table: unknown;
      let joined = false;
      let orphans = false;
      const query: any = {
        from: (value: unknown) => {
          table = value;
          return query;
        },
        innerJoin: () => {
          joined = true;
          return query;
        },
        leftJoin: () => {
          orphans = true;
          return query;
        },
        where: () => query,
        limit: () => query,
        // biome-ignore lint/suspicious/noThenProperty: emulate Drizzle's lazy thenable query
        then: (resolve: (rows: unknown[]) => unknown) =>
          Promise.resolve(answer(table, joined, Object.keys(fields), orphans)).then(resolve),
      };
      return query;
    },
    execute,
    // Nothing may lock a relay_instances row under the revision lock (lock order).
    update: (table: unknown) => {
      if (table === relayInstances) throw new Error('relay_instances row locked under the revision lock');
      return {
        set: (values: { routes: RelayPolicyRouteEntry[] }) => ({
          where: async () => {
            writes.push(values.routes);
            world.policyRoutes = values.routes;
          },
        }),
      };
    },
    delete: () => {
      throw new Error('unexpected delete');
    },
    insert: (table: unknown) => ({
      values: (values: { routes: RelayPolicyRouteEntry[] }) => ({
        onConflictDoUpdate: async () => {
          expect(table).toBe(relayInstancePolicyState);
          writes.push(values.routes);
          world.policyRoutes = values.routes;
        },
      }),
    }),
  };
  db.transaction = (fn: (tx: unknown) => unknown) => fn(db);
  return { db, writes, execute };
}

const kept = { routeId: 'route-kept', endpointId: 'endpoint-1', routeGeneration: 1, endpointGeneration: 1 };
const revoked = { routeId: 'route-revoked', endpointId: 'endpoint-1', routeGeneration: 1, endpointGeneration: 1 };
const keptRow = {
  id: 'route-kept',
  generation: 1,
  targetEndpointId: 'endpoint-1',
  sourceKind: 'daemon',
  sourceId: 'node-a',
};
const narrowedRow = {
  id: 'route-revoked',
  generation: 2,
  targetEndpointId: 'endpoint-1',
  sourceKind: 'daemon',
  sourceId: 'node-b',
};

describe('RelayRevocationFenceService', () => {
  it('records built tuples inside the snapshot transaction', async () => {
    const world: World = { revision: 5, issued: 10, applied: 10, policyRoutes: [kept, revoked], routes: [keptRow] };
    const { db, writes } = database(world);
    await recordBuiltSnapshot(db, 'relay-1', { routes: world.policyRoutes! }, [kept], {
      key: 'content',
      revision: 11,
      issuedAtUnix: 1_000,
      expiresAtUnix: 1_900,
    });
    expect(writes).toEqual([[kept, { ...revoked, removedAtRevision: 11 }]]);
  });

  it('reuses a snapshot only while the relay holds the same content and half its lease remains', () => {
    const previous = {
      snapshotKey: 'content',
      snapshotRevision: 12,
      snapshotIssuedAtUnix: 1_000,
      snapshotExpiresAtUnix: 1_900,
    };
    expect(holdsCurrentSnapshot(previous, 'content', 12, 1_300, 900)).toBe(true);
    // Changed content, a relay on another revision, or a lease past half its life: build anew.
    expect(holdsCurrentSnapshot(previous, 'changed', 12, 1_300, 900)).toBe(false);
    expect(holdsCurrentSnapshot(previous, 'content', 11, 1_300, 900)).toBe(false);
    expect(holdsCurrentSnapshot(previous, 'content', 12, 1_450, 900)).toBe(false);
    expect(holdsCurrentSnapshot(undefined, 'content', 12, 1_300, 900)).toBe(false);
    expect(holdsCurrentSnapshot({ ...previous, snapshotKey: null }, 'content', 12, 1_300, 900)).toBe(false);
  });

  it('fences a relay that missed the revocation, notifies the affected daemons and clears on acknowledgement', async () => {
    const world: World = {
      revision: 5,
      issued: 11,
      applied: 10,
      policyRoutes: [kept, { ...revoked, removedAtRevision: 11 }],
      routes: [keptRow, narrowedRow],
    };
    const { db, execute } = database(world);
    const service = new RelayRevocationFenceService(db);

    await expect(service.evaluate(new Date(T0))).resolves.toEqual({ transitions: [], nodeIds: [] });
    expect(execute).toHaveBeenCalledTimes(1);
    const stale = await service.evaluate(new Date(T0 + RELAY_REVOCATION_ACK_TIMEOUT_MS));
    expect(stale).toEqual({
      transitions: [{ instanceId: 'relay-1', poolId: 'system', displayName: 'edge-1', stale: true, staleRoutes: 1 }],
      // The source of the narrowed route loses the relay; the endpoint daemon gains the fence.
      nodeIds: ['node-b', 'node-target'],
    });
    expect(world.policyRoutes?.find(({ routeId }) => routeId === 'route-kept')).toEqual(kept);

    // A report of a revision Opfield never issued acknowledges nothing.
    world.applied = 50;
    await expect(service.evaluate(new Date(T0 + 200_000))).resolves.toEqual({ transitions: [], nodeIds: [] });
    expect(world.policyRoutes?.some(({ staleAt }) => staleAt)).toBe(true);

    world.applied = 11;
    const cleared = await service.evaluate(new Date(T0 + 300_000));
    expect(cleared.transitions).toEqual([
      { instanceId: 'relay-1', poolId: 'system', displayName: 'edge-1', stale: false, staleRoutes: 0 },
    ]);
    expect(cleared.nodeIds).toEqual(['node-b', 'node-target']);
    expect(world.policyRoutes).toEqual([kept]);
  });

  it('skips the revision lock when policy did not change and no relay holds a dropped tuple', async () => {
    const world: World = { revision: 5, issued: 11, applied: 11, policyRoutes: null, routes: [keptRow] };
    const { db, execute } = database(world);
    const service = new RelayRevocationFenceService(db);
    await service.evaluate(new Date(T0));
    await service.evaluate(new Date(T0 + 5_000));
    expect(execute).not.toHaveBeenCalled();
  });
});
