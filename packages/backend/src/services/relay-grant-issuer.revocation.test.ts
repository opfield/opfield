import { describe, expect, it, vi } from 'vitest';
import { relayEndpoints, relayInstancePolicyState, relayRoutes } from '@/db/schema/index.js';
import type { RelayPolicyRouteEntry } from '@/db/schema/relay.js';
import { RelayGrantIssuerService } from './relay-grant-issuer.service.js';
import { LEGACY_INSTALL_DIR_NAME, LEGACY_RELAY_SOURCE_KIND } from '@/lib/legacy-compat.js';

const STALE_AT = '2026-09-27T10:01:30.000Z';

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

function relay(instanceId: string) {
  return {
    endpointId: 'endpoint-1',
    generation: 3,
    state: 'active',
    role: 'active',
    instanceState: 'ready',
    poolId: 'system',
    instanceId,
    kind: 'remote',
    addresses: [`${instanceId}.example`],
    port: 9443,
    certificateIdentity: `relay-${instanceId}`,
    certificateFingerprint: 'sha256:relay',
    capabilities: { features: ['relay_pool_v1'] },
  };
}

function issuer(answers: Rows[]) {
  const service = new RelayGrantIssuerService(database(answers) as never, {} as never, {} as never) as any;
  service.requireNodeIdentity = vi.fn().mockResolvedValue({ certificateFingerprint: 'sha256:node' });
  service.requireState = vi.fn().mockResolvedValue({ revision: 20, opfieldInstanceId: `${LEGACY_INSTALL_DIR_NAME}` });
  service.getPoolProjection = vi
    .fn()
    .mockResolvedValue(new Map([['endpoint-1', [relay('relay-stale'), relay('relay-current')]]]));
  service.nodeSupportsPool = vi.fn().mockResolvedValue(true);
  service.endpointPathSupportsPool = vi.fn().mockResolvedValue(true);
  service.signGrant = vi.fn(async (claims: unknown) => ({
    keyId: 'grant',
    payload: claims,
    signature: Buffer.alloc(0),
  }));
  return service;
}

const endpoint = {
  id: 'endpoint-1',
  generation: 1,
  status: 'active',
  ownerKind: 'proxy_host_secure_link',
  ownerId: 'link-1',
  subjectKind: 'daemon',
  subjectId: 'node-target',
  maxConcurrentSessions: 256,
};

function route(id: string, generation: number) {
  return {
    id,
    generation,
    ownerKind: 'proxy_host_secure_link',
    ownerId: id,
    sourceKind: 'daemon',
    sourceId: 'node-source',
    targetEndpointId: 'endpoint-1',
    maxConcurrentSessions: 16,
    maxFrameBytes: 1024 * 1024,
    managedDatabaseListener: null,
  };
}

const staleHistory: RelayPolicyRouteEntry[] = [
  { routeId: 'route-kept', endpointId: 'endpoint-1', routeGeneration: 1, endpointGeneration: 1 },
  {
    routeId: 'route-narrowed',
    endpointId: 'endpoint-1',
    routeGeneration: 1,
    endpointGeneration: 1,
    removedAtRevision: 30,
    revokedAt: '2026-09-27T10:00:00.000Z',
    staleAt: STALE_AT,
  },
  {
    routeId: 'route-deleted',
    endpointId: 'endpoint-1',
    routeGeneration: 4,
    endpointGeneration: 1,
    removedAtRevision: 30,
    revokedAt: '2026-09-27T10:00:00.000Z',
    staleAt: STALE_AT,
  },
];

const staleRelays: Rows = {
  table: relayInstancePolicyState,
  projected: true,
  filtered: true,
  rows: [{ id: 'relay-stale', policyRoutes: staleHistory }],
};

describe('RelayGrantIssuerService revocation fences', () => {
  it('keeps a source away from a stale relay for the revoked route only', async () => {
    const service = issuer([
      staleRelays,
      {
        table: relayRoutes,
        projected: false,
        filtered: true,
        rows: [route('route-narrowed', 2), route('route-kept', 1)],
      },
      { table: relayEndpoints, projected: false, filtered: false, rows: [endpoint] },
    ]);
    const bundle = await service.getNodeGrantBundle('node-source');
    const candidates = (routeId: string) =>
      bundle.grants
        .find((grant: { routeId?: string }) => grant.routeId === routeId)
        .candidates.map(({ relayInstanceId }: { relayInstanceId: string }) => relayInstanceId);
    expect(candidates('route-narrowed')).toEqual(['relay-current']);
    // The same stale relay keeps serving routes it was not stale for.
    expect(candidates('route-kept')).toEqual(['relay-stale', 'relay-current']);
    expect(bundle.revocationFences).toBeUndefined();
  });

  it('keeps Opfield itself away from a stale relay for the revoked route', async () => {
    const opfieldRoute = {
      ...route('route-narrowed', 2),
      sourceKind: LEGACY_RELAY_SOURCE_KIND,
      sourceCertificateSha256: 'sha256:app',
    };
    const service = issuer([
      staleRelays,
      { table: relayRoutes, projected: false, filtered: true, rows: [opfieldRoute] },
      { table: relayEndpoints, projected: false, filtered: true, rows: [endpoint] },
    ]);
    const assignment = await service.issueOpfieldConnectAssignment('route-narrowed', 'sha256:app');
    expect(assignment.candidates.map(({ relayInstanceId }: { relayInstanceId: string }) => relayInstanceId)).toEqual([
      'relay-current',
    ]);
  });

  it('ships the endpoint daemon a fence naming the stale relay and the revoked routes', async () => {
    const service = issuer([
      staleRelays,
      { table: relayEndpoints, projected: false, filtered: true, rows: [endpoint] },
      { table: relayEndpoints, projected: false, filtered: false, rows: [endpoint] },
      {
        table: relayRoutes,
        projected: true,
        filtered: true,
        rows: [{ id: 'route-narrowed', generation: 2, targetEndpointId: 'endpoint-1' }],
      },
    ]);
    const bundle = await service.getNodeGrantBundle('node-target');
    expect(bundle.revocationFences).toEqual([
      {
        relayInstanceId: 'relay-stale',
        endpointId: 'endpoint-1',
        routes: [
          { routeId: 'route-deleted', allowedGeneration: '0' },
          { routeId: 'route-narrowed', allowedGeneration: '2' },
        ],
      },
    ]);
    // The endpoint stays registered on the stale relay: its other routes keep working there.
    const registration = bundle.grants.find((grant: { role: string }) => grant.role === 'endpoint');
    expect(registration.candidates.map(({ relayInstanceId }: { relayInstanceId: string }) => relayInstanceId)).toEqual([
      'relay-stale',
      'relay-current',
    ]);
  });

  it('sends no fence once no relay is stale', async () => {
    const service = issuer([{ table: relayEndpoints, projected: false, filtered: true, rows: [endpoint] }]);
    const bundle = await service.getNodeGrantBundle('node-target');
    expect(bundle.revocationFences).toBeUndefined();
  });
});

describe('RelayGrantIssuerService dial targets', () => {
  it("names each relay's own service port in the candidates daemons dial", async () => {
    const service = issuer([{ table: relayEndpoints, projected: false, filtered: true, rows: [endpoint] }]);
    service.getPoolProjection = vi
      .fn()
      .mockResolvedValue(new Map([['endpoint-1', [{ ...relay('relay-custom'), port: 853 }, relay('relay-default')]]]));
    const bundle = await service.getNodeGrantBundle('node-target');
    const registration = bundle.grants.find((grant: { role: string }) => grant.role === 'endpoint');
    expect(
      registration.candidates.map(({ relayInstanceId, addresses, port }: Record<string, unknown>) => ({
        relayInstanceId,
        addresses,
        port,
      }))
    ).toEqual([
      { relayInstanceId: 'relay-custom', addresses: ['relay-custom.example'], port: 853 },
      { relayInstanceId: 'relay-default', addresses: ['relay-default.example'], port: 9443 },
    ]);
  });
});
