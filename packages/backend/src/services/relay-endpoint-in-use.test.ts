import { describe, expect, it } from 'vitest';
import { assertRelayEndpointFree } from './relay-endpoint-in-use.js';

type Row = Record<string, unknown>;

/** Answers the instance list (awaited after from) and the pending relay node list (awaited after where). */
function executor(instances: Row[], pendingNodes: Row[]) {
  return {
    select: () => ({
      from: () => ({
        // biome-ignore lint/suspicious/noThenProperty: drizzle queries are awaited as thenables
        then: (resolve: (rows: Row[]) => unknown) => resolve(instances),
        where: async () => pendingNodes,
      }),
    }),
  } as never;
}

const frankfurt = {
  id: 'relay-fra',
  nodeId: 'node-fra',
  displayName: 'Frankfurt Relay',
  advertisedAddresses: ['relay-fra.example.com', '2001:db8::1'],
  servicePort: 8443,
};

describe('Relay endpoint in use', () => {
  it('refuses the address and port another relay listens on', async () => {
    await expect(
      assertRelayEndpointFree(executor([frankfurt], []), ['Relay-FRA.example.com'], 8443)
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'RELAY_ENDPOINT_IN_USE',
      message: 'Frankfurt Relay already listens on relay-fra.example.com:8443.',
    });
    await expect(assertRelayEndpointFree(executor([frankfurt], []), ['[2001:db8::1]'], 8443)).rejects.toMatchObject({
      message: 'Frankfurt Relay already listens on [2001:db8::1]:8443.',
    });
  });

  it('accepts the same address on another port, and the relay itself', async () => {
    await expect(
      assertRelayEndpointFree(executor([frankfurt], []), ['relay-fra.example.com'], 9443)
    ).resolves.toBeUndefined();
    await expect(
      assertRelayEndpointFree(executor([frankfurt], []), ['relay-fra.example.com'], 8443, { instanceId: 'relay-fra' })
    ).resolves.toBeUndefined();
  });

  it('refuses the address and port of a relay node waiting to enroll, its default port included', async () => {
    const pending = [
      {
        id: 'node-new',
        hostname: 'relay-ams',
        displayName: 'Amsterdam Relay',
        serviceAddresses: ['relay-ams.example.com'],
        metadata: { createdById: 'admin' },
      },
    ];
    await expect(
      assertRelayEndpointFree(executor([frankfurt], pending), ['relay-ams.example.com'], 9443)
    ).rejects.toMatchObject({ code: 'RELAY_ENDPOINT_IN_USE', message: expect.stringContaining('Amsterdam Relay') });
    await expect(
      assertRelayEndpointFree(executor([frankfurt], pending), ['relay-ams.example.com'], 10443)
    ).resolves.toBeUndefined();
  });
});
