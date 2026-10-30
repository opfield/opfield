import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { COMMAND_RESULTS_RESENT_CAPABILITY, NodeRegistryService } from './node-registry.service.js';

const NODE = '11111111-1111-4111-8111-111111111111';

function chain<T>(result: T) {
  return Object.assign(Promise.resolve(result), { limit: async () => result, returning: async () => result });
}

function registry(offlineDebounceMs = 5_000) {
  const db = {
    select: () => ({ from: () => ({ where: () => chain([{ metadata: {}, healthHistory: [] }]) }) }),
    update: () => ({ set: () => ({ where: () => chain([{ metadata: {} }]) }) }),
  };
  const nodes = new NodeRegistryService(db as never, { offlineDebounceMs });
  nodes.startAcceptingConnections(Date.now() - 60_000);
  return nodes;
}

const stream = () => ({ write: vi.fn(), end: vi.fn(), destroy: vi.fn() }) as never;
const resends = { capabilities: [COMMAND_RESULTS_RESENT_CAPABILITY] };

/**
 * A command in flight when a node's control stream ends (stand rc.9: storage-1's launcher reconnected right after a
 * daemon update while a command ran) gets the result its daemon delivers on the next stream, when the daemon resends
 * results across a reconnect; otherwise it fails as before.
 */
describe('commands in flight across a control reconnect', () => {
  it('resolve with the result delivered on the next stream', async () => {
    const nodes = registry();
    const first = stream();
    await nodes.register(NODE, 'storage', 'storage-1', 'hash', first, resends);
    const result = nodes.sendCommand(NODE, { commandId: 'cmd-1' } as never);
    await nodes.deregister(NODE, first);
    await nodes.register(NODE, 'storage', 'storage-1', 'hash', stream(), resends);
    nodes.handleCommandResult(NODE, { commandId: 'cmd-1', success: true } as never);
    await expect(result).resolves.toMatchObject({ commandId: 'cmd-1', success: true });
  });

  it('fail when the next stream does not resend results', async () => {
    const nodes = registry();
    const first = stream();
    await nodes.register(NODE, 'storage', 'storage-1', 'hash', first, resends);
    const result = nodes.sendCommand(NODE, { commandId: 'cmd-2' } as never);
    await nodes.deregister(NODE, first);
    await nodes.register(NODE, 'storage', 'storage-1', 'hash', stream());
    await expect(result).rejects.toThrow('Node disconnected');
  });

  it('fail at once when the daemon does not resend results', async () => {
    const nodes = registry();
    const first = stream();
    await nodes.register(NODE, 'storage', 'storage-1', 'hash', first);
    const result = nodes.sendCommand(NODE, { commandId: 'cmd-3' } as never);
    await nodes.deregister(NODE, first);
    await expect(result).rejects.toThrow('Node disconnected');
  });

  it('resolve across a reconnect of the same daemon process', async () => {
    const nodes = registry();
    const first = stream();
    await nodes.register(NODE, 'docker', 'app-1', 'hash', first, { ...resends, processInstanceId: 'p-1' });
    const result = nodes.sendCommand(NODE, { commandId: 'cmd-5' } as never);
    await nodes.deregister(NODE, first);
    await nodes.register(NODE, 'docker', 'app-1', 'hash', stream(), { ...resends, processInstanceId: 'p-1' });
    nodes.handleCommandResult(NODE, { commandId: 'cmd-5', success: true } as never);
    await expect(result).resolves.toMatchObject({ success: true });
  });

  it('fail at once when the daemon came back as a new process, which lost them', async () => {
    const nodes = registry();
    const first = stream();
    await nodes.register(NODE, 'docker', 'app-1', 'hash', first, { ...resends, processInstanceId: 'p-1' });
    const result = nodes.sendCommand(NODE, { commandId: 'cmd-6' } as never);
    await nodes.deregister(NODE, first);
    await nodes.register(NODE, 'docker', 'app-1', 'hash', stream(), { ...resends, processInstanceId: 'p-2' });
    await expect(result).rejects.toThrow('Node disconnected');
  });

  it('fail when the node does not come back within its offline grace', async () => {
    const nodes = registry(20);
    const first = stream();
    await nodes.register(NODE, 'storage', 'storage-1', 'hash', first, resends);
    const result = nodes.sendCommand(NODE, { commandId: 'cmd-4' } as never);
    await nodes.deregister(NODE, first);
    await expect(result).rejects.toThrow('Node disconnected');
  });
});

/**
 * A command sent on a stream that ends before it is answered, with no answer over the next one, was lost with that
 * stream, not slow (stand rc.12 F-2: health probes sent while a batch updated ingress-1 warned as timeouts).
 */
describe('a command that times out', () => {
  it('fails as Node disconnected when its stream was replaced meanwhile', async () => {
    vi.useFakeTimers();
    try {
      const nodes = registry();
      const first = stream();
      await nodes.register(NODE, 'nginx', 'ingress-1', 'hash', first, resends);
      const result = nodes.sendCommand(NODE, { commandId: 'probe-1' } as never, 15_000);
      void result.catch(() => {});
      await nodes.deregister(NODE, first);
      await nodes.register(NODE, 'nginx', 'ingress-1', 'hash', stream(), resends);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(result).rejects.toThrow(/^Node disconnected$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails as a timeout when its stream stayed', async () => {
    vi.useFakeTimers();
    try {
      const nodes = registry();
      await nodes.register(NODE, 'nginx', 'ingress-1', 'hash', stream(), resends);
      const result = nodes.sendCommand(NODE, { commandId: 'probe-2' } as never, 15_000);
      void result.catch(() => {});
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(result).rejects.toThrow(/^Command probe-2 timed out after 15000ms$/);
    } finally {
      vi.useRealTimers();
    }
  });
});
