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

type Internals = {
  setInstanceDrain(...args: unknown[]): Promise<void>;
  isHeldByUnfinishedUpdate(id: string): Promise<boolean>;
  waitForStreamsToLeave(id: string, timeoutMs: number): Promise<boolean>;
  forceDisconnectDrainingInstance(...args: unknown[]): Promise<void>;
  drainedForUpdate: Map<string, number>;
};

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
  // Every step in the order it ran.
  const steps: string[] = [];
  const written: Array<Record<string, unknown>> = [];
  const update = () => ({
    set: (values: Record<string, unknown>) => {
      written.push(values);
      steps.push(`record ${values.servicePort}`);
      return { where: () => ({ returning: async () => [{ id: 'relay-1' }] }) };
    },
  });
  const db = {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [instance] }) }) })),
    transaction: vi.fn(async (work: (tx: unknown) => Promise<void>) => work({ update })),
  };
  const policy = {
    isRemoteInstanceConnected: vi.fn(() => true),
    setRemoteInstanceServicePort: vi.fn(async (_node: string, port: number) => {
      steps.push(`restart on ${port}`);
      return { commandId: 'c', success: true, detail: `service_port=${port} previous_service_port=9443`, error: '' };
    }),
    refreshAllNodeGrantsIfDue: vi.fn(async () => {
      steps.push('grants');
    }),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const events = { publish: vi.fn() };
  const service = new RelayPoolService(db as never, policy as never, events as never, audit as never, {} as never);
  const internals = service as unknown as Internals;
  const drain = vi.spyOn(internals, 'setInstanceDrain').mockImplementation(async (...args: unknown[]) => {
    steps.push(args[2] ? 'drain' : 'resume');
  });
  vi.spyOn(internals, 'isHeldByUnfinishedUpdate').mockResolvedValue(false);
  vi.spyOn(service, 'settleForUpdate').mockImplementation(async () => {
    steps.push('settle');
  });
  const streamsLeave = vi.spyOn(internals, 'waitForStreamsToLeave').mockImplementation(async () => {
    steps.push('streams left');
    return true;
  });
  const forceDisconnect = vi.spyOn(internals, 'forceDisconnectDrainingInstance').mockImplementation(async () => {
    steps.push('disconnect the rest');
  });
  const snapshotOf = () =>
    (service as unknown as { portChangeView(id: string): Record<string, unknown> | null }).portChangeView('relay-1');
  return { service, internals, policy, audit, written, drain, steps, streamsLeave, forceDisconnect, snapshotOf };
}

describe('Change port of a remote relay', () => {
  beforeEach(() => {
    endpointFree.mockReset().mockResolvedValue(undefined);
    bumpRevision.mockClear();
  });

  // Stand 2.12.6-rc.1, O-1: the worker restarted right after the drain began and cut a request.
  it('restarts the relay only after its streams left, and publishes the endpoint before it takes roles again', async () => {
    const { service, policy, audit, written, drain, steps, internals, snapshotOf } = relay();

    const { done } = await service.changeInstanceServicePort('relay-1', 10443, 'admin-1');
    await done;

    expect(endpointFree).toHaveBeenCalledWith(expect.anything(), ['relay-fra.example.com'], 10443, {
      instanceId: 'relay-1',
      nodeId,
    });
    expect(steps).toEqual([
      'settle',
      'drain',
      'streams left',
      'settle',
      'restart on 10443',
      'record 10443',
      'grants',
      'resume',
    ]);
    // Drained like an update (a planned restart) with the operator drain's grace, and resumed the same way.
    expect(drain.mock.calls).toEqual([
      ['relay-1', 'admin-1', true, false, 'manual'],
      ['relay-1', 'admin-1', false, false],
    ]);
    expect(internals.drainedForUpdate.has('relay-1')).toBe(true);
    expect(policy.setRemoteInstanceServicePort).toHaveBeenCalledWith(nodeId, 10443);
    expect(written).toEqual([expect.objectContaining({ servicePort: 10443 })]);
    expect(bumpRevision).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'relay.instance.service_port.change',
        details: expect.objectContaining({ previousServicePort: 9443, servicePort: 10443 }),
      })
    );
    expect(snapshotOf()).toBeNull();
  });

  it('disconnects what is left after the drain grace before the restart, as a drain does', async () => {
    const { service, steps, streamsLeave, forceDisconnect } = relay();
    streamsLeave.mockImplementationOnce(async () => {
      steps.push('grace ended');
      return false;
    });

    await (await service.changeInstanceServicePort('relay-1', 10443, 'admin-1')).done;

    expect(steps.slice(0, 6)).toEqual([
      'settle',
      'drain',
      'grace ended',
      'disconnect the rest',
      'streams left',
      'settle',
    ]);
    expect(forceDisconnect).toHaveBeenCalledWith('relay-1', 'admin-1', true, 'relay_port_change_drain_grace_ended');
    expect(steps).toContain('restart on 10443');
  });

  it('keeps the old endpoint and shows the relay reason when the relay moved back', async () => {
    const { service, policy, audit, written, drain, snapshotOf } = relay();
    const reason =
      'the relay could not serve on port 10443: listen tcp 0.0.0.0:10443: bind: address already in use; it is back on port 9443';
    policy.setRemoteInstanceServicePort.mockResolvedValue({
      commandId: 'c',
      success: false,
      detail: '',
      error: reason,
    });

    await (await service.changeInstanceServicePort('relay-1', 10443, 'admin-1')).done;

    expect(written).toEqual([]);
    expect(bumpRevision).not.toHaveBeenCalled();
    expect(drain).toHaveBeenLastCalledWith('relay-1', 'admin-1', false, false);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'relay.instance.service_port.change_failed' })
    );
    expect(snapshotOf()).toMatchObject({
      state: 'failed',
      servicePort: 10443,
      previousServicePort: 9443,
      error: reason,
    });
  });

  it('returns once the change began and shows it running', async () => {
    const { service, policy, snapshotOf } = relay();
    let release!: () => void;
    policy.setRemoteInstanceServicePort.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ commandId: 'c', success: true, detail: '', error: '' });
        })
    );

    const { done } = await service.changeInstanceServicePort('relay-1', 10443, 'admin-1');
    await vi.waitFor(() => expect(snapshotOf()).toMatchObject({ state: 'moving', servicePort: 10443 }));
    // A second change of the same relay waits for none: it is refused while this one runs.
    await expect(service.changeInstanceServicePort('relay-1', 10543, 'admin-1')).rejects.toMatchObject({
      code: 'RELAY_DRAIN_IN_PROGRESS',
    });
    release();
    await done;
    expect(snapshotOf()).toBeNull();
  });

  it('leaves an operator drain in place', async () => {
    const { service, drain } = relay({ state: 'draining', manualDrainStartedAt: new Date() });

    await (await service.changeInstanceServicePort('relay-1', 10443, 'admin-1')).done;

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
