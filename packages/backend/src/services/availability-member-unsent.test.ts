import { describe, expect, it, vi } from 'vitest';
import { AvailabilityMembersService } from './availability-members.service.js';
import { NodeDispatchService } from './node-dispatch.service.js';

function dispatchFor(connected: Record<string, string[]>) {
  const registry = {
    getNode: (nodeId: string) => (connected[nodeId] ? { id: nodeId } : undefined),
    hasCapability: (nodeId: string, capability: string) => connected[nodeId]?.includes(capability) ?? false,
    sendCommand: vi.fn(async () => ({ success: true })),
  };
  return new NodeDispatchService(registry as never, {} as never);
}

describe('availability member commands that reach no node (rc2 DB-O-1)', () => {
  it('names a node that is not connected as not connected, not as one without member runtime', async () => {
    const dispatch = dispatchFor({});
    expect(
      await dispatch.sendAvailabilityMember('frozen-node', { remove: { setId: 's', memberId: 'm' } } as never)
    ).toBeNull();
    expect(dispatch.availabilityMemberUnsentReason('frozen-node')).toMatch(/not connected to Opfield/);
    expect(dispatch.availabilityMemberUnsentReason('frozen-node')).not.toMatch(/does not run availability members/);
  });

  it('names a connected node whose daemon lacks member runtime as one that needs a daemon update', () => {
    const dispatch = dispatchFor({ 'old-node': [] });
    expect(dispatch.availabilityMemberUnsentReason('old-node')).toMatch(/does not run availability members; update/);
  });

  it('the members service names the reason of a node it could not reach', async () => {
    const dispatch = dispatchFor({});
    const service = new AvailabilityMembersService({} as never, dispatch);
    expect(service.unsentReason('frozen-node')).toMatch(/not connected to Opfield/);
    // A dispatch without the reason (older hosts) still never claims a missing member runtime.
    const bare = new AvailabilityMembersService({} as never, { sendAvailabilityMember: async () => null });
    expect(bare.unsentReason('frozen-node')).toMatch(/not connected to Opfield/);
  });
});
