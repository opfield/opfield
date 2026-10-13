import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import forge from 'node-forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayControlClient } from './relay-control.client.js';
import { loadRelayV1Proto } from './relay-proto.js';

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

describe('Gateway channels to the local relay', () => {
  let dir: string;
  let identities: ReturnType<typeof issueIdentities>;
  let port = 0;
  let server: grpc.Server | null = null;

  const startRelay = async () => {
    const relay = new grpc.Server();
    relay.addService(loadRelayV1Proto().RelayAdmin.service, {
      GetHealth: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
        callback(null, { liveness: true, readiness: true, buildVersion: 'relay-1', protocolMajor: 1 }),
    });
    const credentials = grpc.ServerCredentials.createSsl(
      Buffer.from(identities.ca),
      [{ private_key: Buffer.from(identities.server.key), cert_chain: Buffer.from(identities.server.cert) }],
      true
    );
    port = await new Promise<number>((resolve, reject) =>
      relay.bindAsync(`127.0.0.1:${port}`, credentials, (error, bound) => (error ? reject(error) : resolve(bound)))
    );
    server = relay;
  };
  const stopRelay = () => {
    server?.forceShutdown();
    server = null;
  };
  const channelState = (client: RelayControlClient) =>
    ((client as any).admin.getChannel() as grpc.Channel).getConnectivityState(false);
  const waitForState = async (client: RelayControlClient, state: grpc.connectivityState) => {
    const deadline = Date.now() + 10_000;
    while (channelState(client) !== state) {
      if (Date.now() > deadline) throw new Error(`channel never reached ${grpc.connectivityState[state]}`);
      await client.getHealth(500).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  beforeAll(async () => {
    identities = issueIdentities();
    dir = mkdtempSync(join(tmpdir(), 'relay-reconnect-'));
    writeFileSync(join(dir, 'ca.pem'), identities.ca);
    writeFileSync(join(dir, 'client.pem'), identities.client.cert);
    writeFileSync(join(dir, 'client.key'), identities.client.key);
    await startRelay();
  }, 60_000);

  afterAll(() => {
    stopRelay();
    rmSync(dir, { recursive: true, force: true });
  });

  const newClient = () =>
    new RelayControlClient({
      target: `127.0.0.1:${port}`,
      systemCaPath: join(dir, 'ca.pem'),
      certificatePath: join(dir, 'client.pem'),
      privateKeyPath: join(dir, 'client.key'),
    });

  it('leaves a connected channel alone', async () => {
    const client = newClient();
    await expect(client.getHealth()).resolves.toMatchObject({ buildVersion: 'relay-1' });
    const admin = (client as any).admin;
    const broker = (client as any).broker;
    // The tunnel broker had no call yet: idle, its first call resolves the relay anew.
    expect(client.reconnectIfDown()).toBe(false);
    await expect(client.getHealth()).resolves.toMatchObject({ buildVersion: 'relay-1' });
    expect((client as any).admin).toBe(admin);
    expect((client as any).broker).toBe(broker);
    client.close();
  });

  it('replaces a failed channel; the new one reaches the relay at once when it is back', async () => {
    const client = newClient();
    await client.getHealth();
    stopRelay();
    await waitForState(client, grpc.connectivityState.TRANSIENT_FAILURE);

    expect(client.reconnectIfDown()).toBe(true);
    await startRelay();
    const startedAt = Date.now();
    await expect(client.getHealth(2_000)).resolves.toMatchObject({ buildVersion: 'relay-1' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(channelState(client)).toBe(grpc.connectivityState.READY);
    client.close();
  }, 30_000);
});
