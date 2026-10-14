import { describe, expect, it, vi } from 'vitest';
import { ProxyService } from './proxy.service.js';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE_ID = '22222222-2222-4222-8222-222222222222';

function binding(overrides: Record<string, unknown>) {
  return {
    id: 'link-id',
    proxyHostId: HOST_ID,
    name: 'link',
    purpose: 'user_managed',
    referenceId: null,
    status: 'provisioning',
    generation: 1,
    targetContainer: 'application',
    forwardScheme: 'http',
    lastError: null,
    ...overrides,
  } as any;
}

function harness(host: Record<string, unknown>, bindings: unknown[]) {
  const row = {
    id: HOST_ID,
    isSystem: false,
    upstreamKind: 'pages',
    nodeId: null,
    ingressGroupId: null,
    dockerNodeId: null,
    secureLinkGeneration: 0,
    secureLinkStatus: 'legacy',
    secureLinkLastError: null,
    secureLinkMigratedAt: null,
    healthCheckEnabled: false,
    healthCheckInterval: null,
    rateLimitEnabled: false,
    rateLimitMode: null,
    rateLimitOptions: null,
    ...host,
  };
  const db = {
    query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(row) } },
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: ROUTE_ID, path: '/api' }]) })),
    })),
  } as any;
  const secureLinks = { listAllAdditional: vi.fn().mockResolvedValue(bindings) } as any;
  const service = new ProxyService(db, {} as any, {} as any, {} as any, {} as any, {} as any, undefined, secureLinks);
  return { service, secureLinks };
}

describe('getProxySecureLinkStatus', () => {
  it('lists the additional links of a Pages route without a primary Secure Link', async () => {
    const { service } = harness({}, [
      binding({ id: 'owned', name: 'route_x', purpose: 'additional_route', referenceId: ROUTE_ID }),
      binding({ id: 'manual', name: 'metrics' }),
      binding({ id: 'member', name: 'availability', purpose: 'availability_member', referenceId: ROUTE_ID }),
    ]);

    const status = await service.getProxySecureLinkStatus(HOST_ID);

    expect(status.hasPrimary).toBe(false);
    expect(status.state).toBeNull();
    expect(status.runtime).toBeNull();
    expect(status.history).toEqual([]);
    expect(status.additionalLinks.map((link) => [link.id, link.purpose, link.referenceId, link.label])).toEqual([
      ['owned', 'additional_route', ROUTE_ID, '/api'],
      ['manual', 'user_managed', null, 'metrics'],
    ]);
  });

  it('keeps the primary part of a Docker route', async () => {
    const { service } = harness(
      {
        upstreamKind: 'docker_container',
        nodeId: 'nginx-node',
        dockerNodeId: 'docker-node',
        secureLinkGeneration: 3,
        secureLinkStatus: 'active',
      },
      []
    );
    vi.spyOn(service as any, 'ingressNodesOf').mockResolvedValue([]);
    vi.spyOn(service as any, 'sampleSecureLinkRuntime').mockResolvedValue({
      snapshot: { timestamp: new Date().toISOString(), runtime: null, traffic: null },
      history: [],
    });

    const status = await service.getProxySecureLinkStatus(HOST_ID);

    expect(status.hasPrimary).toBe(true);
    expect(status.state).toBe('active');
    expect(status.generation).toBe(3);
    expect(status.additionalLinks).toEqual([]);
  });
});
