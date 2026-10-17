import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { NodeRegistryService } from './node-registry.service.js';

const NODE = '22222222-2222-4222-8222-222222222222';

function chain<T>(result: T) {
  return Object.assign(Promise.resolve(result), { limit: async () => result, returning: async () => result });
}

/**
 * rc.3 O-A7: the Node Online and Node Offline alerts carry the node's id in {{node.id}}, its display name in
 * {{node.name}}, and its real hostname in {{details.hostname}} (node.id was null and details.hostname held the display
 * name).
 */
describe('the context of node connection alerts', () => {
  it('names the node by id, display name and real hostname', async () => {
    const db = {
      select: () => ({
        from: () => ({ where: () => chain([{ metadata: {}, healthHistory: [], displayName: 'storage-2' }]) }),
      }),
      update: () => ({ set: () => ({ where: () => chain([{ metadata: {} }]) }) }),
    };
    const nodes = new NodeRegistryService(db as never, { offlineDebounceMs: 0 });
    nodes.startAcceptingConnections(Date.now() - 60_000);
    const evaluator = { observeStatefulEvent: vi.fn(async () => undefined) };
    nodes.setEvaluator(evaluator as never);
    await nodes.register(NODE, 'storage', 'relay-1', 'hash', {
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    } as never);
    const online = (evaluator.observeStatefulEvent.mock.calls as unknown[][]).find((call) => call[1] === 'online');
    expect(online?.[2]).toMatchObject({ type: 'node', id: NODE });
    expect(online?.[3]).toEqual({ nodeId: NODE, node_name: expect.any(String), hostname: 'relay-1' });
  });
});
