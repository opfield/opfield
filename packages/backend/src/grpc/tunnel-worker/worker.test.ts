import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import forge from 'node-forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayControlClient } from '../relay-control.client.js';
import { loadRelayV1Proto } from '../relay-proto.js';
import { RelayTunnelHost } from './host.js';

/** A CA with a server leaf for 127.0.0.1 and a client leaf, as the local relay and Opfield present them. */
function issueIdentities() {
  const keypair = () => forge.pki.rsa.generateKeyPair(2048);
  const certificate = (
    subject: string,
    keys: forge.pki.rsa.KeyPair,
    issuer: { cert: forge.pki.Certificate; keys: forge.pki.rsa.KeyPair } | null,
    extensions: object[]
  ) => {
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = String(Math.floor(Math.random() * 1e9));
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60_000);
    cert.setSubject([{ name: 'commonName', value: subject }]);
    cert.setIssuer(issuer ? issuer.cert.subject.attributes : [{ name: 'commonName', value: subject }]);
    cert.setExtensions(extensions);
    cert.sign(issuer ? issuer.keys.privateKey : keys.privateKey, forge.md.sha256.create());
    return cert;
  };
  const caKeys = keypair();
  const ca = certificate('test-ca', caKeys, null, [
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true },
  ]);
  const leaf = (name: string, usage: object) => {
    const keys = keypair();
    const cert = certificate(name, keys, { cert: ca, keys: caKeys }, [
      { name: 'basicConstraints', cA: false },
      usage,
      { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
    ]);
    return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
  };
  return {
    ca: forge.pki.certificateToPem(ca),
    server: leaf('relay', { name: 'extKeyUsage', serverAuth: true }),
    client: leaf('gateway-app', { name: 'extKeyUsage', clientAuth: true }),
  };
}

describe('Opfield tunnel worker thread', () => {
  let dir: string;
  let server: grpc.Server;
  let port = 0;
  const opens: string[] = [];

  beforeAll(async () => {
    const identities = issueIdentities();
    dir = mkdtempSync(join(tmpdir(), 'relay-tunnel-worker-'));
    writeFileSync(join(dir, 'ca.pem'), identities.ca);
    writeFileSync(join(dir, 'client.pem'), identities.client.cert);
    writeFileSync(join(dir, 'client.key'), identities.client.key);
    server = new grpc.Server();
    // A relay whose tunnels echo every data frame after Ready.
    server.addService(loadRelayV1Proto().TunnelBroker.service, {
      OpenTunnel: (call: grpc.ServerDuplexStream<any, any>) => {
        call.on('data', (message: any) => {
          if (message.open) {
            opens.push(message.open.grant.keyId);
            call.write({ ready: { maxFrameBytes: 64 * 1024 } });
          } else if (message.data) call.write({ data: { data: message.data.data } });
          else if (message.close || message.halfClose) call.end();
        });
        call.on('error', () => undefined);
        call.on('end', () => call.end());
      },
    });
    const credentials = grpc.ServerCredentials.createSsl(
      Buffer.from(identities.ca),
      [{ private_key: Buffer.from(identities.server.key), cert_chain: Buffer.from(identities.server.cert) }],
      true
    );
    port = await new Promise<number>((resolve, reject) =>
      server.bindAsync('127.0.0.1:0', credentials, (error, bound) => (error ? reject(error) : resolve(bound)))
    );
  }, 60_000);

  afterAll(() => {
    server?.forceShutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens tunnels to the relay from the worker with the main client identity', async () => {
    const client = new RelayControlClient({
      target: `127.0.0.1:${port}`,
      systemCaPath: join(dir, 'ca.pem'),
      certificatePath: join(dir, 'client.pem'),
      privateKeyPath: join(dir, 'client.key'),
    });
    const host = RelayTunnelHost.inWorker(client);
    try {
      host.onAccept((_key, slotId) => {
        void host.bindRaw(slotId, {
          kind: 'local',
          grant: { keyId: 'endpoint-grant', payload: Buffer.from('p'), signature: Buffer.from('s') },
          relayId: 'local',
        });
      });
      const endpoint = await host.createEndpoint('database:db-1:interactive');
      const payload = Buffer.alloc(200 * 1024, 7);
      const net = await import('node:net');
      const socket = net.connect({ host: '127.0.0.1', port: endpoint });
      const received: Buffer[] = [];
      let total = 0;
      await new Promise<void>((resolve, reject) => {
        socket.on('data', (chunk: Buffer) => {
          received.push(chunk);
          total += chunk.length;
          if (total >= payload.length) resolve();
        });
        socket.once('error', reject);
        socket.write(payload);
      });
      socket.destroy();
      expect(Buffer.concat(received).equals(payload)).toBe(true);
      expect(opens).toContain('endpoint-grant');
      await expect.poll(() => host.relayResumeStats().sessions.legacy, { timeout: 5_000, interval: 200 }).toBe(0);
    } finally {
      await host.close();
      client.close();
    }
  }, 30_000);
});
