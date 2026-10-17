import { describe, expect, it } from 'vitest';
import { ExternalSshService } from './external-ssh.service.js';

// rc.3 GF-4: an agent reached ingress-1 over SSH through a forward on an address the node does not report; the host
// key was the node's. Nodes now report their SSH host keys, and a connector pinned to one is refused.
const nodeRows = [
  {
    id: 'node-ingress-1',
    hostname: 'ingress-1',
    displayName: 'ingress-1',
    report: {
      localIpAddresses: ['172.20.0.131'],
      sshHostKeyFingerprints: ['SHA256:T6w3yuIngressHostKey'],
    },
  },
  { id: 'node-old', hostname: 'old-node', displayName: null, report: { localIpAddresses: ['172.20.0.140'] } },
];

function service() {
  const db = { select: () => ({ from: async () => nodeRows }) };
  return new ExternalSshService(db as never, {} as never);
}

const user = { id: 'u1', scopes: ['integrations:ssh:manage'] } as never;
const input = (hostFingerprint: string) => ({
  name: 'forward',
  host: '203.0.113.237',
  username: 'root',
  authMethod: 'password' as const,
  secret: 'x',
  hostFingerprint,
});

describe('SSH connectors to enrolled nodes', () => {
  it('are refused by the node host key, whatever address reaches the node', async () => {
    await expect(service().create(user, input('SHA256:T6w3yuIngressHostKey'))).rejects.toMatchObject({
      statusCode: 403,
      code: 'SSH_MANAGED_TARGET_BLOCKED',
      message: expect.stringContaining('ingress-1'),
      details: { nodeId: 'node-ingress-1', nodeName: 'ingress-1' },
    });
  });

  it('pass the host key check for a host that is no node', async () => {
    await expect(
      (service() as unknown as { assertNotNodeHostKey: (fingerprint: string) => Promise<void> }).assertNotNodeHostKey(
        'SHA256:SomeOtherHost'
      )
    ).resolves.toBeUndefined();
  });
});
