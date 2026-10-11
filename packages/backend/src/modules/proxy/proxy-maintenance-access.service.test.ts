import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ProxyMaintenanceAccessService } from './proxy-maintenance-access.service.js';

const authMocks = vi.hoisted(() => ({ resolveLiveUser: vi.fn() }));
vi.mock('@/modules/auth/live-session-user.js', () => ({ resolveLiveUser: authMocks.resolveLiveUser }));
const { resolveLiveUser } = authMocks;

const host = {
  id: '11111111-1111-4111-8111-111111111111',
  nodeId: '22222222-2222-4222-8222-222222222222',
  domainNames: ['example.test'],
  enabled: true,
  maintenanceEnabled: true,
  isSystem: false,
  type: 'proxy',
  rawConfigEnabled: false,
};

function digest(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}

function harness({ supportsMaintenanceAccess = true }: { supportsMaintenanceAccess?: boolean } = {}) {
  const values = new Map<string, string>();
  const cache = {
    set: vi.fn(async (key: string, value: unknown) => values.set(key, JSON.stringify(value))),
    get: vi.fn(async (key: string) => (values.has(key) ? JSON.parse(values.get(key)!) : null)),
    setIfAbsent: vi.fn(async (key: string, value: unknown) => {
      if (values.has(key)) return false;
      values.set(key, JSON.stringify(value));
      return true;
    }),
    getClient: () => ({
      getdel: vi.fn(async (key: string) => {
        const value = values.get(key) ?? null;
        values.delete(key);
        return value;
      }),
    }),
  };
  const db = {
    query: {
      proxyHosts: { findFirst: vi.fn(async () => host) },
      nodes: {
        findFirst: vi.fn(async () => ({
          id: host.nodeId,
          type: 'nginx',
          status: 'online',
          capabilities: { capabilities: supportsMaintenanceAccess ? ['proxy_maintenance_access_v1'] : [] },
        })),
      },
    },
  };
  const audit = { log: vi.fn() };
  const crypto = { deriveScopedSecret: vi.fn(() => 'derived-secret') };
  return {
    service: new ProxyMaintenanceAccessService(db as any, cache as any, audit as any, crypto as any),
    cache,
    audit,
    crypto,
  };
}

describe('ProxyMaintenanceAccessService', () => {
  it('issues a host-bound one-time code and redeems it into a signed host cookie value', async () => {
    const { service, cache, audit, crypto } = harness();
    resolveLiveUser.mockResolvedValue({
      id: 'user-1',
      isBlocked: false,
      scopes: ['proxy:maintenance:bypass:11111111-1111-4111-8111-111111111111'],
    });

    const issued = await service.issue(host.id, 'user-1');
    expect(issued.code).toHaveLength(32);
    expect(cache.set).toHaveBeenCalledWith(
      `proxy-maintenance-access:code:${digest(issued.code)}`,
      expect.objectContaining({ hostId: host.id, userId: 'user-1' }),
      300
    );

    const token = await service.redeem(host.id, host.nodeId, 'example.test', issued.code);
    expect(token).toMatch(/^[A-Za-z0-9_-]+,\d+$/);
    expect(crypto.deriveScopedSecret).toHaveBeenCalledWith(`proxy-maintenance-access:${host.id}`);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'proxy_host.maintenance_access.redeem' }));
  });

  it('consumes a code when it is attempted against the wrong host', async () => {
    const { service } = harness();
    const issued = await service.issue(host.id, 'user-1');

    await expect(
      service.redeem('33333333-3333-4333-8333-333333333333', host.nodeId, 'example.test', issued.code)
    ).resolves.toBeNull();
    await expect(service.redeem(host.id, host.nodeId, 'example.test', issued.code)).resolves.toBeNull();
  });

  it('does not issue a code for a route whose maintenance page has no team access', async () => {
    const { service, cache } = harness();
    service.setRouteAccessCheck(async () => false);

    await expect(service.issue(host.id, 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'MAINTENANCE_ACCESS_UNAVAILABLE',
    });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('does not issue a code until the target nginx daemon advertises support', async () => {
    const { service } = harness({ supportsMaintenanceAccess: false });

    await expect(service.issue(host.id, 'user-1')).rejects.toMatchObject({
      code: 'MAINTENANCE_ACCESS_UNAVAILABLE',
    });
  });
});
