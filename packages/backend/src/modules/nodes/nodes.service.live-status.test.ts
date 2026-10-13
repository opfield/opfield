import { describe, expect, it, vi } from 'vitest';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { NodesService } from './nodes.service.js';

const NODE = '22222222-2222-4222-8222-222222222222';
const UPDATING = { updateInProgress: true, updatePhase: 'reconnecting' };

/** The node row the API reads, against a real registry the node is not connected to. */
async function nodeView(metadata: Record<string, unknown>) {
  const row = { id: NODE, status: 'online', metadata, type: 'docker', healthHistory: [] };
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }) };
  const registry = new NodeRegistryService({} as never);
  // An Opfield that started long ago: the startup reconnect grace is over.
  registry.startAcceptingConnections(Date.now() - 10 * 60_000);
  const service = new NodesService(db as never, {} as never, registry, {} as never, {} as never);
  return (await service.get(NODE)) as { status: string; reconnecting: boolean; isConnected: boolean };
}

describe('the status of a node that is not connected', () => {
  it('stays online and reads as reconnecting while its daemon update restarts it (rc.8 O-3)', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 9, 20, 37) });
    try {
      expect(await nodeView(UPDATING)).toMatchObject({ status: 'online', reconnecting: true, isConnected: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is offline without an update, or once the update waits for tasks and restarted nothing', async () => {
    expect(await nodeView({})).toMatchObject({ status: 'offline', reconnecting: false });
    expect(await nodeView({ updateInProgress: true, updatePhase: 'waiting_for_tasks' })).toMatchObject({
      status: 'offline',
      reconnecting: false,
    });
  });
});
