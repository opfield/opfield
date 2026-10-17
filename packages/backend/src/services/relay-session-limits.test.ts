import { describe, expect, it, vi } from 'vitest';
import { relayEndpoints, relayRoutes } from '@/db/schema/index.js';
import { RelayGrantIssuerService } from './relay-grant-issuer.service.js';
import { relayPolicySnapshotContent } from './relay-policy-snapshot-content.js';
import {
  CONTAINER_LINK_RELAY_MAX_CONCURRENT_SESSIONS,
  effectiveRelayMaxConcurrentSessions,
  MANAGED_LINK_RELAY_MAX_CONCURRENT_SESSIONS,
  managedDatabaseConnectionLimit,
  RELAY_REGISTRY_FAIR_SHARE_CAPABILITY,
  RELAY_UNCAPPED_SESSIONS,
  relaySessionLimitTarget,
} from './relay-session-limits.js';

const listener = {
  networkName: 'opfield-db-binding',
  listenAddress: '172.28.0.1',
  listenPort: 5432,
  allowedSources: ['deployment:mailroom'],
};

// Rows as an existing installation holds them: the column default of 16 sessions.
const databaseEndpoint = {
  id: 'endpoint-database',
  generation: 2,
  status: 'active',
  ownerKind: 'managed_database',
  ownerId: 'database-1',
  subjectKind: 'daemon',
  subjectId: 'node-database',
  certificateSha256: 'sha256:database',
  maxConcurrentSessions: 256,
};
const storageEndpoint = {
  ...databaseEndpoint,
  id: 'endpoint-storage',
  ownerKind: 'managed_storage',
  ownerId: 'cluster-1',
};
const databaseLinkRoute = {
  id: 'route-database-link',
  generation: 4,
  ownerKind: 'managed_database_binding',
  ownerId: 'binding-1',
  sourceKind: 'daemon',
  sourceId: 'node-workload',
  sourceCertificateSha256: 'sha256:workload',
  targetEndpointId: 'endpoint-database',
  maxConcurrentSessions: 16,
  maxFrameBytes: 1024 * 1024,
  managedDatabaseListener: listener,
};
const storageLinkRoute = {
  ...databaseLinkRoute,
  id: 'route-storage-link',
  generation: 7,
  ownerKind: 'managed_storage_binding',
  ownerId: 'storage-link-1',
  targetEndpointId: 'endpoint-storage',
  managedDatabaseListener: null,
};

/** A Drizzle stand-in that answers by table and whether the query was filtered. */
function database(answers: Array<{ table: unknown; filtered: boolean; rows: unknown[] }>) {
  return {
    select: () => {
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
          const answer = answers.find((candidate) => candidate.table === table && candidate.filtered === filtered);
          return Promise.resolve(answer?.rows ?? []).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

function poolRelay(endpointId: string) {
  return {
    endpointId,
    generation: 1,
    state: 'active',
    role: 'active',
    instanceState: 'ready',
    poolId: 'system',
    instanceId: 'relay-1',
    kind: 'remote',
    addresses: ['relay-1.example'],
    port: 9443,
    certificateIdentity: 'relay-relay-1',
    certificateFingerprint: 'sha256:relay',
    capabilities: { features: ['relay_pool_v1'] },
  };
}

// The database behind endpoint-database accepts 500 connections.
const sessionLimits = { databaseByEndpoint: new Map([['endpoint-database', 500]]) };

describe('relay session limits', () => {
  it('reads the connection limit from the managed database engine settings', () => {
    expect(managedDatabaseConnectionLimit('postgres', {})).toBe(100);
    expect(managedDatabaseConnectionLimit('postgres', { postgresConfig: { maxConnections: 500 } })).toBe(500);
    expect(managedDatabaseConnectionLimit('redis', { redisConfig: { maxclients: 2000 } })).toBe(2000);
    expect(managedDatabaseConnectionLimit('redis', null)).toBe(10_000);
    expect(managedDatabaseConnectionLimit('clickhouse', {})).toBe(4096);
  });

  it('gives a database link its database limit and leaves HTTP links uncapped', () => {
    expect(effectiveRelayMaxConcurrentSessions(databaseLinkRoute, sessionLimits)).toBe(500);
    // A database Opfield does not know (no limits loaded) keeps the link capacity.
    expect(effectiveRelayMaxConcurrentSessions(databaseLinkRoute)).toBe(MANAGED_LINK_RELAY_MAX_CONCURRENT_SESSIONS);
    expect(effectiveRelayMaxConcurrentSessions(databaseEndpoint, sessionLimits)).toBe(564);
    expect(effectiveRelayMaxConcurrentSessions(databaseEndpoint)).toBe(256);
    expect(effectiveRelayMaxConcurrentSessions(storageLinkRoute, sessionLimits)).toBe(RELAY_UNCAPPED_SESSIONS);
    expect(effectiveRelayMaxConcurrentSessions(storageEndpoint, sessionLimits)).toBe(RELAY_UNCAPPED_SESSIONS);
    expect(
      effectiveRelayMaxConcurrentSessions({ ownerKind: 'proxy_host_secure_link', maxConcurrentSessions: 16 })
    ).toBe(RELAY_UNCAPPED_SESSIONS);
    expect(effectiveRelayMaxConcurrentSessions({ ownerKind: 'container_link', maxConcurrentSessions: 16 })).toBe(
      CONTAINER_LINK_RELAY_MAX_CONCURRENT_SESSIONS
    );
    expect(
      effectiveRelayMaxConcurrentSessions({ ownerKind: 'managed_database_gateway', maxConcurrentSessions: 16 })
    ).toBe(16);
  });

  it('carries the limits in the relay snapshot without moving the route generation', () => {
    const content = relayPolicySnapshotContent({
      gatewayInstanceId: 'opfield-1',
      poolId: 'system',
      relayInstanceId: 'relay-1',
      grantKeys: [],
      assignments: [
        { endpointId: 'endpoint-database', assignmentGeneration: 1 },
        { endpointId: 'endpoint-storage', assignmentGeneration: 1 },
      ],
      endpoints: [databaseEndpoint, storageEndpoint] as never,
      routes: [databaseLinkRoute, storageLinkRoute] as never,
      admission: {
        adaptiveAdmissionEnabled: true,
        proxyTargetPressurePercent: 70,
        databaseReservePercent: 20,
        hardPressurePercent: 95,
      },
      policyKeys: [],
      routePolicy: () => ({}),
      sessionLimits,
      leaseGate: null,
      lease: null,
    });
    expect(content.routes).toEqual([
      expect.objectContaining({ routeId: 'route-database-link', generation: '4', maxConcurrentSessions: 500 }),
      expect.objectContaining({
        routeId: 'route-storage-link',
        generation: '7',
        maxConcurrentSessions: RELAY_UNCAPPED_SESSIONS,
      }),
    ]);
    expect(content.endpoints.map(({ maxConcurrentSessions }) => maxConcurrentSessions)).toEqual([
      564,
      RELAY_UNCAPPED_SESSIONS,
    ]);
  });

  it('signs the limits into the source daemon grants without moving the route generation', async () => {
    const service = new RelayGrantIssuerService(
      database([
        { table: relayRoutes, filtered: true, rows: [databaseLinkRoute, storageLinkRoute] },
        { table: relayEndpoints, filtered: false, rows: [databaseEndpoint, storageEndpoint] },
        // The session-limit read; the node's own endpoint read gets these rows too and finds no active endpoint.
        {
          table: relayEndpoints,
          filtered: true,
          rows: [
            {
              endpointId: 'endpoint-database',
              type: 'postgres',
              engineConfig: { postgresConfig: { maxConnections: 500 } },
            },
          ],
        },
      ]) as never,
      {} as never,
      {} as never
    ) as any;
    service.requireNodeIdentity = vi.fn().mockResolvedValue({ certificateFingerprint: 'sha256:workload' });
    service.requireState = vi.fn().mockResolvedValue({ revision: 30, gatewayInstanceId: 'opfield-1' });
    service.getPoolProjection = vi.fn().mockResolvedValue(
      new Map([
        ['endpoint-database', [poolRelay('endpoint-database')]],
        ['endpoint-storage', [poolRelay('endpoint-storage')]],
      ])
    );
    service.nodeSupportsPool = vi.fn().mockResolvedValue(true);
    service.endpointPathSupportsPool = vi.fn().mockResolvedValue(true);
    service.signGrant = vi.fn(async (claims: unknown) => ({
      keyId: 'grant',
      payload: claims,
      signature: Buffer.alloc(0),
    }));

    const bundle = await service.getNodeGrantBundle('node-workload');
    const links = bundle.grants.filter(({ role }: { role: string }) => role === 'connect');
    expect(links).toHaveLength(2);
    for (const link of links) {
      const database = link.routeId === databaseLinkRoute.id;
      const route = database ? databaseLinkRoute : storageLinkRoute;
      const expected = {
        routeId: route.id,
        routeGeneration: route.generation,
        maxConcurrentSessions: database ? 500 : RELAY_UNCAPPED_SESSIONS,
      };
      // The legacy grant and every pool candidate grant: the relay enforces the lower of grant and policy.
      expect(link.grant.payload).toMatchObject(expected);
      expect(link.candidates).toHaveLength(1);
      expect(link.candidates[0].grant.payload).toMatchObject(expected);
    }
    // The daemon keeps its listener: the generation it compares is the route's own.
    expect(
      links.find(({ routeId }: { routeId: string }) => routeId === databaseLinkRoute.id).managedDatabaseListener
    ).toEqual({ ...listener, routeGeneration: 4 });
  });

  it('uncaps container links only for relays with registry fair share, in the snapshot and in their grants', async () => {
    const containerEndpoint = {
      ...databaseEndpoint,
      id: 'endpoint-container',
      ownerKind: 'container_link',
      ownerId: 'link-1',
      maxConcurrentSessions: 16,
    };
    const containerLinkRoute = {
      ...storageLinkRoute,
      id: 'route-container-link',
      ownerKind: 'container_link',
      ownerId: 'link-1',
      targetEndpointId: 'endpoint-container',
      maxConcurrentSessions: 16,
    };
    const fairShare = relaySessionLimitTarget(['relay_pool_v1', RELAY_REGISTRY_FAIR_SHARE_CAPABILITY]);
    expect(relaySessionLimitTarget(['relay_pool_v1'])).toEqual({ registryFairShare: false });
    expect(relaySessionLimitTarget(undefined)).toEqual({ registryFairShare: false });
    expect(effectiveRelayMaxConcurrentSessions(containerLinkRoute, undefined, fairShare)).toBe(RELAY_UNCAPPED_SESSIONS);
    expect(effectiveRelayMaxConcurrentSessions(storageLinkRoute, undefined, fairShare)).toBe(RELAY_UNCAPPED_SESSIONS);
    expect(effectiveRelayMaxConcurrentSessions(databaseLinkRoute, sessionLimits, fairShare)).toBe(500);

    const snapshot = (limitTarget?: { registryFairShare: boolean }) => {
      const routePolicy = vi.fn((ownerKind: string, target?: { registryFairShare: boolean }) => ({
        trafficClass: ownerKind === 'container_link' && target?.registryFairShare ? 'registry' : 'database',
      }));
      const content = relayPolicySnapshotContent({
        gatewayInstanceId: 'opfield-1',
        poolId: 'system',
        relayInstanceId: 'relay-1',
        grantKeys: [],
        assignments: [{ endpointId: 'endpoint-container', assignmentGeneration: 1 }],
        endpoints: [containerEndpoint] as never,
        routes: [containerLinkRoute] as never,
        admission: {
          adaptiveAdmissionEnabled: true,
          proxyTargetPressurePercent: 70,
          databaseReservePercent: 20,
          hardPressurePercent: 95,
        },
        policyKeys: [],
        routePolicy,
        leaseGate: null,
        lease: null,
        ...(limitTarget ? { limitTarget } : {}),
      });
      return content;
    };
    const capable = snapshot(fairShare);
    expect(capable.routes[0]).toMatchObject({
      generation: '7',
      trafficClass: 'registry',
      maxConcurrentSessions: RELAY_UNCAPPED_SESSIONS,
    });
    expect(capable.endpoints[0].maxConcurrentSessions).toBe(RELAY_UNCAPPED_SESSIONS);
    const older = snapshot();
    expect(older.routes[0]).toMatchObject({
      generation: '7',
      trafficClass: 'database',
      maxConcurrentSessions: CONTAINER_LINK_RELAY_MAX_CONCURRENT_SESSIONS,
    });
    expect(older.endpoints[0].maxConcurrentSessions).toBe(CONTAINER_LINK_RELAY_MAX_CONCURRENT_SESSIONS);

    const service = new RelayGrantIssuerService(
      database([
        { table: relayRoutes, filtered: true, rows: [containerLinkRoute] },
        { table: relayEndpoints, filtered: false, rows: [containerEndpoint] },
        { table: relayEndpoints, filtered: true, rows: [] },
      ]) as never,
      {} as never,
      {} as never
    ) as any;
    service.requireNodeIdentity = vi.fn().mockResolvedValue({ certificateFingerprint: 'sha256:workload' });
    service.requireState = vi.fn().mockResolvedValue({ revision: 30, gatewayInstanceId: 'opfield-1' });
    service.getPoolProjection = vi.fn().mockResolvedValue(
      new Map([
        [
          'endpoint-container',
          [
            poolRelay('endpoint-container'),
            {
              ...poolRelay('endpoint-container'),
              instanceId: 'relay-2',
              capabilities: { features: ['relay_pool_v1', RELAY_REGISTRY_FAIR_SHARE_CAPABILITY] },
            },
          ],
        ],
      ])
    );
    service.nodeSupportsPool = vi.fn().mockResolvedValue(true);
    service.endpointPathSupportsPool = vi.fn().mockResolvedValue(true);
    service.signGrant = vi.fn(async (claims: unknown) => ({
      keyId: 'grant',
      payload: claims,
      signature: Buffer.alloc(0),
    }));

    const bundle = await service.getNodeGrantBundle('node-workload');
    const [link] = bundle.grants.filter(({ role }: { role: string }) => role === 'connect');
    // The legacy grant is not scoped to one relay: it keeps the cap every relay enforces alike.
    expect(link.grant.payload).toMatchObject({ maxConcurrentSessions: CONTAINER_LINK_RELAY_MAX_CONCURRENT_SESSIONS });
    expect(
      link.candidates.map(({ relayInstanceId, grant }: { relayInstanceId: string; grant: { payload: any } }) => [
        relayInstanceId,
        grant.payload.maxConcurrentSessions,
        grant.payload.routeGeneration,
      ])
    ).toEqual([
      ['relay-1', CONTAINER_LINK_RELAY_MAX_CONCURRENT_SESSIONS, 7],
      ['relay-2', RELAY_UNCAPPED_SESSIONS, 7],
    ]);
  });
});
