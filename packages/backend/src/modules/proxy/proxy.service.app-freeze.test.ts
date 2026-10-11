import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { ProxyService } from './proxy.service.js';
import { appFreezeTargetOfUpstream } from './proxy.service.mutations.js';

const ROUTE = '11111111-1111-4111-8111-111111111111';
const NODE = '22222222-2222-4222-8222-222222222222';

/** A proxy service with only the app freeze guard set (the guard runs before anything else is touched). */
function service(refusal: { code: string } | null) {
  const proxy = Object.create(ProxyService.prototype) as ProxyService;
  const refuse = async () => {
    if (refusal) throw new AppError(409, refusal.code, 'Shop · production is held by an app incident');
  };
  const guard = {
    assertRoute: vi.fn(refuse),
    assertRouteRemovable: vi.fn(refuse),
    assertUpstream: vi.fn(refuse),
  };
  proxy.setAppFreezeGuard(guard);
  return { proxy, guard };
}

describe('Routes of an isolated or shut-down app environment', () => {
  it.each(['APP_ISOLATED', 'APP_INCIDENT_ACTIVE'])('refuse deleting the route (%s)', async (code) => {
    const { proxy, guard } = service({ code });
    await expect(proxy.deleteProxyHost(ROUTE, 'user-1')).rejects.toMatchObject({ code });
    expect(guard.assertRouteRemovable).toHaveBeenCalledWith(ROUTE);
  });

  it('refuse deleting an additional Secure Link of the route', async () => {
    const { proxy, guard } = service({ code: 'APP_INCIDENT_ACTIVE' });
    vi.spyOn(proxy as any, 'requireManagedProxyHost').mockResolvedValue({ id: ROUTE });
    const deleteAdditional = vi.fn();
    (proxy as any).secureLinks = { deleteAdditional };
    await expect(proxy.deleteAdditionalSecureLink(ROUTE, 'binding-1', 'user-1')).rejects.toMatchObject({
      code: 'APP_INCIDENT_ACTIVE',
    });
    expect(guard.assertRouteRemovable).toHaveBeenCalledWith(ROUTE);
    expect(deleteAdditional).not.toHaveBeenCalled();
  });

  it('refuse a user placement change while isolated', async () => {
    const { proxy } = service({ code: 'APP_ISOLATED' });
    await expect(proxy.assertRouteNotAppFrozen(ROUTE)).rejects.toMatchObject({ code: 'APP_ISOLATED' });
  });
});

describe('appFreezeTargetOfUpstream', () => {
  it('names the workload a route or Secure Link upstream reaches', () => {
    expect(
      appFreezeTargetOfUpstream({ upstreamKind: 'docker_container', dockerNodeId: NODE, dockerContainerName: 'api' })
    ).toEqual({ kind: 'container', nodeId: NODE, name: 'api' });
    expect(appFreezeTargetOfUpstream({ dockerContainerName: 'api' }, NODE)).toEqual({
      kind: 'container',
      nodeId: NODE,
      name: 'api',
    });
    expect(appFreezeTargetOfUpstream({ dockerDeploymentId: 'd1' })).toEqual({ kind: 'deployment', id: 'd1' });
    expect(appFreezeTargetOfUpstream({ dockerComposeProjectId: 'p1', dockerNodeId: NODE })).toEqual({
      kind: 'compose',
      id: 'p1',
    });
    expect(appFreezeTargetOfUpstream({ pageProjectId: 'pg' })).toEqual({ kind: 'pages', id: 'pg' });
    expect(appFreezeTargetOfUpstream({ upstreamKind: 'managed_storage', managedStorageId: 's1' })).toEqual({
      kind: 'managedStorage',
      id: 's1',
    });
    expect(appFreezeTargetOfUpstream({ upstreamKind: 'manual', dockerContainerName: 'api' }, NODE)).toBeNull();
    expect(appFreezeTargetOfUpstream({})).toBeNull();
  });
});
