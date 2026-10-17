import { describe, expect, it } from 'vitest';
import { sshHostKeyFingerprintsHealth } from '@/grpc/services/health-report.js';
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

  // rc.4 NF-2: daemons sent the fingerprints, but the backend left them out of the stored report, so the check above
  // never fired on a real node.
  it('are refused by the host key a node sent in its health report, at an address the node does not report', async () => {
    const stored = {
      localIpAddresses: ['172.20.0.132'],
      ...sshHostKeyFingerprintsHealth({
        localIpAddresses: ['172.20.0.132'],
        sshHostKeyFingerprints: ['SHA256:Storage2Ed25519', 'SHA256:Storage2Rsa', '', 'not-a-fingerprint'],
      }),
    };
    expect(stored.sshHostKeyFingerprints).toEqual(['SHA256:Storage2Ed25519', 'SHA256:Storage2Rsa']);
    const rows = [{ id: 'node-storage-2', hostname: 'storage-2', displayName: null, report: stored }];
    const db = { select: () => ({ from: async () => rows }) };
    const ssh = new ExternalSshService(db as never, {} as never);
    await expect(ssh.create(user, input('SHA256:Storage2Rsa'))).rejects.toMatchObject({
      statusCode: 403,
      code: 'SSH_MANAGED_TARGET_BLOCKED',
      details: { nodeId: 'node-storage-2', nodeName: 'storage-2' },
    });
    expect(sshHostKeyFingerprintsHealth({ sshHostKeyFingerprints: [] })).toEqual({});
    expect(sshHostKeyFingerprintsHealth({})).toEqual({});
  });
});
