import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';

const endpointFree = vi.hoisted(() => vi.fn(async () => undefined));
const bumpRevision = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./relay-endpoint-in-use.js', () => ({ assertRelayEndpointFree: endpointFree }));
vi.mock('./relay-policy-reconciler.js', async (original) => ({
  ...(await original<typeof import('./relay-policy-reconciler.js')>()),
  bumpRelayPolicyRevision: bumpRevision,
}));

const { RelayPoolService } = await import('./relay-pool.service.js');

const nodeId = '11111111-1111-4111-8111-111111111111';

function relay(overrides: Record<string, unknown> = {}) {
  const instance = {
    id: 'relay-1',
    poolId: 'system',
    kind: 'remote',
    nodeId,
    state: 'ready',
    servicePort: 9443,
    advertisedAddresses: ['relay-fra.example.com'],
    manualDrainStartedAt: null,
    capabilities: { protocolMajor: 1, features: ['relay_pool_v1', 'relay_service_port_v1'] },
    ...overrides,
  };
  const written: Array<Record<string, unknown>> = [];
  const update = () => ({
    set: (values: Record<string, unknown>) => {
      written.push(values);
      return { where: () => ({ returning: async () => [{ id: 'relay-1' }] }) };
    },
  });
  const db = {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [instance] }) }) })),
    transaction: vi.fn(async (work: (tx: unknown) => Promise<void>) => work({ update })),
  };
  const policy = {
    isRemoteInstanceConnected: vi.fn(() => true),
    setRemoteInstanceServicePort: vi.fn(async () => ({
      commandId: 'c',
      success: true,
      detail: 'service_port=10443 previous_service_port=9443',
      error: '',
    })),
    refreshAllNodeGrantsIfDue: vi.fn(async () => undefined),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const events = { publish: vi.fn() };
  const service = new RelayPoolService(db as never, policy as never, events as never, audit as never, {} as never);
  const internals = service as unknown as {
    setInstanceDrain(id: string, userId: string | null, enabled: boolean, manual: boolean): Promise<void>;
    isHeldByUnfinishedUpdate(id: string): Promise<boolean>;
  };
  const drain = vi.spyOn(internals, 'setInstanceDrain').mockResolvedValue(undefined);
  vi.spyOn(internals, 'isHeldByUnfinishedUpdate').mockResolvedValue(false);
  return { service, policy, audit, written, drain };
}

describe('Change port of a remote relay', () => {
  beforeEach(() => {
    endpointFree.mockReset().mockResolvedValue(undefined);
    bumpRevision.mockClear();
  });

  it('drains the relay, moves it, records the endpoint and returns it to the pool', async () => {
    const { service, policy, audit, written, drain } = relay();

    await service.changeInstanceServicePort('relay-1', 10443, 'admin-1');

    expect(endpointFree).toHaveBeenCalledWith(expect.anything(), ['relay-fra.example.com'], 10443, {
      instanceId: 'relay-1',
      nodeId,
    });
    expect(drain.mock.calls).toEqual([
      ['relay-1', 'admin-1', true, true],
      ['relay-1', 'admin-1', false, true],
    ]);
    expect(policy.setRemoteInstanceServicePort).toHaveBeenCalledWith(nodeId, 10443);
    expect(written).toEqual([expect.objectContaining({ servicePort: 10443 })]);
    expect(bumpRevision).toHaveBeenCalledTimes(1);
    expect(policy.refreshAllNodeGrantsIfDue).toHaveBeenCalledWith(true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.instance.service_port.change',
        details: expect.objectContaining({ previousServicePort: 9443, servicePort: 10443 }),
      })
    );
  });

  it('keeps the old endpoint and says why when the relay moved back', async () => {
    const { service, policy, audit, written, drain } = relay();
    const reason = 'the relay worker did not become ready on port 10443 (connection refused); it is back on port 9443';
    policy.setRemoteInstanceServicePort.mockResolvedValue({
      commandId: 'c',
      success: false,
      detail: '',
      error: reason,
    });

    await expect(service.changeInstanceServicePort('relay-1', 10443, 'admin-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'RELAY_SERVICE_PORT_CHANGE_FAILED',
      message: reason,
    });
    expect(written).toEqual([]);
    expect(bumpRevision).not.toHaveBeenCalled();
    expect(drain).toHaveBeenLastCalledWith('relay-1', 'admin-1', false, true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'relay.instance.service_port.change_failed' })
    );
  });

  it('leaves an operator drain in place', async () => {
    const { service, drain } = relay({ state: 'draining', manualDrainStartedAt: new Date() });

    await service.changeInstanceServicePort('relay-1', 10443, 'admin-1');

    expect(drain).not.toHaveBeenCalled();
  });

  it('asks for a relay update when the relay does not know the command', async () => {
    const { service, policy, drain } = relay({ capabilities: { protocolMajor: 1, features: ['relay_pool_v1'] } });

    await expect(service.changeInstanceServicePort('relay-1', 10443, 'admin-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'RELAY_UPDATE_REQUIRED',
      message: expect.stringMatching(/^Update the relay first/),
    });
    expect(drain).not.toHaveBeenCalled();
    expect(policy.setRemoteInstanceServicePort).not.toHaveBeenCalled();
  });

  it('refuses a protected relay and the local relay', async () => {
    const protectedRelay = relay({
      capabilities: { protocolMajor: 1, features: ['relay_pool_v1', 'relay_service_port_v1', 'node_protected_v1'] },
    });
    await expect(protectedRelay.service.changeInstanceServicePort('relay-1', 10443, null)).rejects.toMatchObject({
      code: 'RELAY_PROTECTED',
    });
    const local = relay({ kind: 'local', nodeId: null });
    await expect(local.service.changeInstanceServicePort('relay-1', 10443, null)).rejects.toMatchObject({
      code: 'LOCAL_RELAY_SERVICE_PORT_UNSUPPORTED',
    });
  });

  it('refuses an address and port another relay uses before draining', async () => {
    const { service, drain, policy } = relay();
    endpointFree.mockRejectedValue(
      new AppError(409, 'RELAY_ENDPOINT_IN_USE', 'Frankfurt Relay already listens on relay-fra.example.com:8443.')
    );

    await expect(service.changeInstanceServicePort('relay-1', 8443, 'admin-1')).rejects.toMatchObject({
      code: 'RELAY_ENDPOINT_IN_USE',
    });
    expect(drain).not.toHaveBeenCalled();
    expect(policy.setRemoteInstanceServicePort).not.toHaveBeenCalled();
  });

  it('refuses a value that is not a TCP port', async () => {
    const { service } = relay();
    for (const port of [0, 65536, 1.5]) {
      await expect(service.changeInstanceServicePort('relay-1', port, null)).rejects.toMatchObject({
        statusCode: 400,
        code: 'RELAY_SERVICE_PORT_INVALID',
      });
    }
  });
});
