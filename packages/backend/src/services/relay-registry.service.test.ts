import { describe, expect, it, vi } from 'vitest';
import { LEGACY_REGISTRY_NAMESPACE } from '@/lib/legacy-compat.js';
import { AppError } from '@/middleware/error-handler.js';
import { RelayRegistryService } from './relay-registry.service.js';

const binding = (id: string, role: string, repository: string, actions: string[]) => ({
  id,
  nodeId: 'node-1',
  role,
  repository,
  actions,
  contextKind: 'availability',
  contextId: 'policy-1',
  generation: 1,
  status: 'active',
});

function service(writable: boolean) {
  const bindings = [
    binding('b1', 'mirror', `${LEGACY_REGISTRY_NAMESPACE}/availability/policy-1/1/3`, ['pull', 'push']),
    binding('b2', 'runtime', `${LEGACY_REGISTRY_NAMESPACE}/availability/policy-1/1/2`, ['pull']),
  ];
  const db = {
    select: () => ({ from: () => ({ where: async () => bindings }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  const relayPolicy = { ensureInternalRegistryRoutes: vi.fn(async () => undefined), revokeOwner: vi.fn() };
  const dispatch = { sendDockerRegistryBindings: vi.fn(async () => ({ success: true })) };
  const registry = {
    issueToken: vi.fn(async (input: { requested: Array<{ repository: string; actions: string[] }> }) => {
      if (!writable && input.requested.some((grant) => grant.actions.includes('push'))) {
        throw new AppError(503, 'INTERNAL_REGISTRY_NOT_WRITABLE', 'Build admission is paused');
      }
      return {
        token: `token:${input.requested[0]!.repository}:${input.requested[0]!.actions.join('+')}`,
        issuedAt: new Date().toISOString(),
        expiresIn: 120,
      };
    }),
  };
  return {
    relayRegistry: new RelayRegistryService(db as never, relayPolicy as never, dispatch as never, registry as never),
    dispatch,
  };
}

describe('registry binding sync while the registry takes no writes', () => {
  it('renews a grant that may push for pulls only instead of failing every binding of the node', async () => {
    const { relayRegistry, dispatch } = service(false);

    await relayRegistry.syncNode('node-1');

    const [, desired] = dispatch.sendDockerRegistryBindings.mock.calls[0] as unknown as [
      string,
      Array<{ bindingId: string; authorization: string }>,
    ];
    expect(desired.map((entry) => [entry.bindingId, entry.authorization])).toEqual([
      ['b1', `Bearer token:${LEGACY_REGISTRY_NAMESPACE}/availability/policy-1/1/3:pull`],
      ['b2', `Bearer token:${LEGACY_REGISTRY_NAMESPACE}/availability/policy-1/1/2:pull`],
    ]);
  });

  it('grants push again once the registry takes writes', async () => {
    const { relayRegistry, dispatch } = service(true);

    await relayRegistry.syncNode('node-1');

    const [, desired] = dispatch.sendDockerRegistryBindings.mock.calls[0] as unknown as [
      string,
      Array<{ bindingId: string; authorization: string }>,
    ];
    expect(desired[0]!.authorization).toBe(
      `Bearer token:${LEGACY_REGISTRY_NAMESPACE}/availability/policy-1/1/3:pull+push`
    );
  });
});

describe('registry binding sync across an Opfield restart (S6)', () => {
  function hanging() {
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [
            binding('b1', 'runtime', `${LEGACY_REGISTRY_NAMESPACE}/availability/policy-1/1/14`, ['pull']),
          ],
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    let calls = 0;
    const relayPolicy = {
      // The first sync (started for the connection before the restart's reconnect) never ends.
      ensureInternalRegistryRoutes: vi.fn(() =>
        calls++ === 0 ? new Promise<never>(() => undefined) : Promise.resolve()
      ),
      revokeOwner: vi.fn(),
    };
    const dispatch = { sendDockerRegistryBindings: vi.fn(async () => ({ success: true })) };
    const registry = {
      issueToken: vi.fn(async () => ({ token: 't', issuedAt: new Date().toISOString(), expiresIn: 120 })),
    };
    const events = { handlers: [] as Array<(payload: unknown) => void> };
    const relayRegistry = new RelayRegistryService(
      db as never,
      relayPolicy as never,
      dispatch as never,
      registry as never
    );
    relayRegistry.setEventBus({
      subscribe: (_topic: string, handler: (payload: unknown) => void) => events.handlers.push(handler),
    } as never);
    return {
      relayRegistry,
      dispatch,
      connect: (id: string) => {
        for (const handler of events.handlers) handler({ id, status: 'online' });
      },
    };
  }

  it('starts a new queue when the node connects again instead of waiting behind a stuck sync', async () => {
    const { relayRegistry, dispatch, connect } = hanging();
    void relayRegistry.syncNode('node-2');

    connect('node-2');
    await relayRegistry.syncNode('node-2');

    expect(dispatch.sendDockerRegistryBindings).toHaveBeenCalledTimes(1);
  });

  it('releases the queue once a stuck sync passes its bound', async () => {
    vi.useFakeTimers();
    try {
      const { relayRegistry, dispatch } = hanging();
      const stuck = relayRegistry.syncNode('node-2');
      const settled = expect(stuck).rejects.toThrow(/did not finish within 90 s/);
      await vi.advanceTimersByTimeAsync(90_000);
      await settled;

      await relayRegistry.syncNode('node-2');
      expect(dispatch.sendDockerRegistryBindings).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('registry bindings of earlier Availability images', () => {
  it('revokes the context bindings of repositories no pinned image uses and syncs each node once', async () => {
    const rows = [
      {
        ...binding('old-1', 'runtime', `${LEGACY_REGISTRY_NAMESPACE}/availability/policy-1/1/12`, ['pull']),
        nodeId: 'node-1',
      },
      {
        ...binding('old-2', 'runtime', `${LEGACY_REGISTRY_NAMESPACE}/availability/policy-1/1/12`, ['pull']),
        nodeId: 'node-2',
      },
      {
        ...binding('kept', 'runtime', `${LEGACY_REGISTRY_NAMESPACE}/availability/policy-1/1/14`, ['pull']),
        nodeId: 'node-2',
      },
    ];
    const revokedIds: unknown[] = [];
    const db = {
      select: () => ({ from: () => ({ where: async () => rows }) }),
      update: () => ({
        set: () => ({
          where: async () => {
            revokedIds.push('update');
          },
        }),
      }),
    };
    const relayPolicy = {
      ensureInternalRegistryRoutes: vi.fn(async () => undefined),
      revokeOwner: vi.fn(async (_kind: string, _id: string, _options?: unknown) => undefined),
    };
    const relayRegistry = new RelayRegistryService(db as never, relayPolicy as never, {} as never, {} as never);
    const synced: string[] = [];
    vi.spyOn(relayRegistry, 'syncNode').mockImplementation(async (nodeId: string) => {
      synced.push(nodeId);
    });

    await expect(
      relayRegistry.retainContextBindings({
        contextKind: 'availability',
        contextId: 'policy-1',
        repositories: [`${LEGACY_REGISTRY_NAMESPACE}/availability/policy-1/1/14`],
      })
    ).resolves.toBe(2);

    expect(relayPolicy.revokeOwner.mock.calls.map(([, id]) => id)).toEqual(['old-1', 'old-2']);
    expect(synced.sort()).toEqual(['node-1', 'node-2']);
  });
});

describe('registry binding sync of nodes without bindings', () => {
  function withNode(node: { type: string; capabilities: unknown }) {
    const db = {
      select: () => ({
        from: () => ({
          // The bindings query awaits where(); the node query reads one row through limit().
          where: () => Object.assign(Promise.resolve([]), { limit: async () => [node] }),
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    const dispatch = { sendDockerRegistryBindings: vi.fn(async () => ({ success: true })) };
    const relayRegistry = new RelayRegistryService(db as never, {} as never, dispatch as never, {} as never);
    return { relayRegistry, dispatch };
  }

  it('sends nothing to an nginx, monitoring, relay or storage node', async () => {
    for (const type of ['nginx', 'monitoring', 'relay', 'storage']) {
      const { relayRegistry, dispatch } = withNode({ type, capabilities: { capabilities: [] } });
      await relayRegistry.syncNode('node-1');
      expect(dispatch.sendDockerRegistryBindings).not.toHaveBeenCalled();
    }
  });

  it('sends nothing to a Docker daemon without registry access support', async () => {
    const { relayRegistry, dispatch } = withNode({ type: 'docker', capabilities: { capabilities: [] } });
    await relayRegistry.syncNode('node-1');
    expect(dispatch.sendDockerRegistryBindings).not.toHaveBeenCalled();
  });

  it('clears the bindings of a Docker daemon that supports registry access', async () => {
    const { relayRegistry, dispatch } = withNode({
      type: 'docker',
      capabilities: { capabilities: ['docker_registry_proxy_v1'] },
    });
    await relayRegistry.syncNode('node-1');
    expect(dispatch.sendDockerRegistryBindings).toHaveBeenCalledWith('node-1', []);
  });
});

describe('registry sync failures that are expected states (rc.8 O-6)', () => {
  it('logs nothing at warn level for a node not connected yet or an unreachable local relay', async () => {
    const { isExpectedSyncFailure } = await import('./relay-registry-sync.js');
    expect(isExpectedSyncFailure(new Error('Node 1111 is not connected'))).toBe(true);
    expect(isExpectedSyncFailure(new Error('Node disconnected'))).toBe(true);
    expect(isExpectedSyncFailure(new Error('14 UNAVAILABLE: Name resolution failed for target dns:relay:9443'))).toBe(
      true
    );
    expect(isExpectedSyncFailure(new Error('Docker daemon rejected internal registry bindings'))).toBe(false);
  });

  it('also for a node whose daemon is being updated and grants waiting for a policy revision (rc.9 O-1)', async () => {
    const { isExpectedSyncFailure } = await import('./relay-registry-sync.js');
    expect(isExpectedSyncFailure(new Error('Node daemon update is in progress'))).toBe(true);
    expect(isExpectedSyncFailure(new Error('Relay policy revision 412 has not been durably acknowledged'))).toBe(true);
  });
});
