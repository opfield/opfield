import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/resource-scope-cleanup.js', () => ({
  transactionWithScopeCleanup: vi.fn(async () => undefined),
}));

import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { ProxyService } from './proxy.service.js';

// housekeeping O-1 (rc.3): deleting a route whose node was offline failed with "NGINX_CONFIG_FAILED ... is not
// connected", and only deleting the whole node removed it. The node drops the config on its reconnect resync.
const ROUTE = '11111111-1111-4111-8111-111111111111';
const NODE = '22222222-2222-4222-8222-222222222222';

function service(connected: boolean) {
  const proxy: any = Object.create(ProxyService.prototype);
  const route = {
    id: ROUTE,
    nodeId: NODE,
    ingressGroupId: null,
    isSystem: false,
    upstreamKind: 'manual',
    domainNames: ['a.test'],
  };
  proxy.db = { query: { proxyHosts: { findFirst: vi.fn(async () => route) } } };
  proxy.nodeDispatch = { isNodeConnected: vi.fn(() => connected) };
  proxy.certificateDistribution = { deactivateHost: vi.fn(async () => {}) };
  proxy.auditService = { log: vi.fn(async () => {}) };
  proxy.hostConfigEpochs = new Map();
  proxy.withdrawHost = vi.fn(async () => {
    throw new Error(`Node ${NODE} is not connected`);
  });
  proxy.forgetSecureLinkRuntime = vi.fn();
  proxy.emitHost = vi.fn();
  proxy.reconcileMaintenanceAlerts = vi.fn();
  return proxy;
}

describe('deleting a route on an offline node', () => {
  it('deletes it without the node and leaves the config to the reconnect resync', async () => {
    const proxy = service(false);
    await proxy.deleteProxyHost(ROUTE, 'user-1');
    expect(proxy.withdrawHost).not.toHaveBeenCalled();
    expect(proxy.certificateDistribution.deactivateHost).toHaveBeenCalledWith(ROUTE, NODE);
    expect(transactionWithScopeCleanup).toHaveBeenCalled();
    expect(proxy.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'proxy_host.delete',
        details: expect.objectContaining({ abandonedOfflineNode: true, nodeCleanupOnReconnect: true }),
      })
    );
  });

  it('still removes the config first on a connected node', async () => {
    const proxy = service(true);
    await expect(proxy.deleteProxyHost(ROUTE, 'user-1')).rejects.toMatchObject({ code: 'NGINX_CONFIG_FAILED' });
    expect(proxy.withdrawHost).toHaveBeenCalled();
  });
});
