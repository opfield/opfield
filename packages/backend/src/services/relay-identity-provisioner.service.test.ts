import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayIdentityProvisionerService, recoverIdentityFileSet } from './relay-identity-provisioner.service.js';

const DAY = 24 * 60 * 60 * 1000;
const keys = forge.pki.rsa.generateKeyPair(1024);
let serial = 10;

function certificatePem(commonName: string, notAfter: Date): string {
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  serial += 1;
  certificate.serialNumber = serial.toString(16);
  certificate.validity.notBefore = new Date(Date.now() - 2 * DAY);
  certificate.validity.notAfter = notAfter;
  certificate.setSubject([{ name: 'commonName', value: commonName }]);
  certificate.setIssuer([{ name: 'commonName', value: 'opfield-system-ca' }]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(certificate);
}

describe('RelayIdentityProvisionerService', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'relay-identity-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function provisioner() {
    const external = { certPath: join(directory, 'grpc.crt'), keyPath: join(directory, 'grpc.key') };
    writeFileSync(external.certPath, 'external-certificate');
    writeFileSync(external.keyPath, 'external-key');
    const db = {
      select: () => {
        const query: any = Promise.resolve([]);
        for (const method of ['from', 'where', 'limit']) query[method] = () => query;
        return query;
      },
    };
    const lifecycle = {
      issueCurrent: vi.fn(async (input: { commonName: string }) => ({
        certificate: { certificatePem: certificatePem(input.commonName, new Date(Date.now() + 365 * DAY)) },
        privateKeyPem: `${input.commonName}-renewed-key`,
      })),
    };
    return new RelayIdentityProvisionerService(
      db as never,
      {} as never,
      lifecycle as never,
      { getSystemCACertPem: async () => 'system-ca', getSystemCAId: async () => 'ca-1' } as never,
      { resolve: async () => external } as never,
      join(directory, 'identity')
    );
  }

  it('keeps the client pair a renewal replaces so the running relay can still be asked to reload', async () => {
    const identityDir = join(directory, 'identity');
    const installed = certificatePem('app-relay-client', new Date(Date.now() + 3 * DAY));
    await provisioner().ensure(); // creates the directory layout
    writeFileSync(join(identityDir, 'app-relay-client.crt'), installed);
    writeFileSync(join(identityDir, 'app-relay-client.key'), 'installed-key');

    const identity = await provisioner().ensure();

    expect(identity.previousAppClientCertPath).toBe(join(identityDir, 'app-relay-client.previous.crt'));
    expect(readFileSync(identity.previousAppClientCertPath!, 'utf8')).toBe(installed);
    expect(readFileSync(identity.previousAppClientKeyPath!, 'utf8')).toBe('installed-key');
    expect(readFileSync(identity.appClientCertPath, 'utf8')).not.toBe(installed);
  });

  it('drops a previous pair that expired: no relay can still trust it', async () => {
    const identityDir = join(directory, 'identity');
    await provisioner().ensure();
    writeFileSync(
      join(identityDir, 'app-relay-client.crt'),
      certificatePem('app-relay-client', new Date(Date.now() - DAY))
    );
    writeFileSync(
      join(identityDir, 'app-relay-client.previous.crt'),
      certificatePem('old', new Date(Date.now() - DAY))
    );
    writeFileSync(join(identityDir, 'app-relay-client.previous.key'), 'old-key');

    const identity = await provisioner().ensure();

    expect(identity.previousAppClientCertPath).toBeUndefined();
    expect(existsSync(join(identityDir, 'app-relay-client.previous.crt'))).toBe(false);
  });

  /** A provisioner whose three service leaves are current in the database and expire in `remainingMs`. */
  function provisionerWithCurrentLeaves(remainingMs: number) {
    const external = { certPath: join(directory, 'grpc.crt'), keyPath: join(directory, 'grpc.key') };
    writeFileSync(external.certPath, 'external-certificate');
    writeFileSync(external.keyPath, 'external-key');
    const notAfter = new Date(Date.now() + remainingMs);
    const current = new Map<string, string>();
    // ensure() looks the three leaves up in this order, each with one query.
    const owners = ['app-internal-server', 'app-relay-client', 'relay-app-client'];
    let lookups = 0;
    const db = {
      select: () => {
        const ownerId = owners[lookups++ % owners.length]!;
        const query: any = {
          from: () => query,
          where: () => query,
          limit: () => {
            if (!current.has(ownerId)) current.set(ownerId, certificatePem(ownerId, notAfter));
            return Promise.resolve([{ id: ownerId, certificatePem: current.get(ownerId), notAfter }]);
          },
        };
        return query;
      },
    };
    const lifecycle = {
      issueCurrent: vi.fn(async (input: { commonName: string }) => ({
        certificate: { certificatePem: certificatePem(input.commonName, new Date(Date.now() + 365 * DAY)) },
        privateKeyPem: `${input.commonName}-renewed-key`,
      })),
    };
    const service = new RelayIdentityProvisionerService(
      db as never,
      { getCertificatePrivateKey: async (id: string) => `${id}-key` } as never,
      lifecycle as never,
      { getSystemCACertPem: async () => 'system-ca', getSystemCAId: async () => 'ca-1' } as never,
      { resolve: async () => external } as never,
      join(directory, 'identity')
    );
    return { service, lifecycle };
  }

  it('renews service leaves a month before they expire, not a week', async () => {
    const reused = provisionerWithCurrentLeaves(31 * DAY);
    const first = await reused.service.ensure();
    expect(reused.lifecycle.issueCurrent).not.toHaveBeenCalled();
    // Unchanged material needs no relay reload.
    expect((await reused.service.refresh()).materialDigest).toBe(first.materialDigest);

    const due = provisionerWithCurrentLeaves(29 * DAY);
    const renewed = await due.service.ensure();
    expect(due.lifecycle.issueCurrent).toHaveBeenCalledTimes(3);
    expect(renewed.materialDigest).not.toBe(first.materialDigest);
  });

  it('keeps the provisioned identity when a refresh fails', async () => {
    const { service, lifecycle } = provisionerWithCurrentLeaves(29 * DAY);
    const current = await service.ensure();
    lifecycle.issueCurrent.mockRejectedValueOnce(new Error('issuance failed'));

    await expect(service.refresh()).rejects.toThrow('issuance failed');
    const issued = lifecycle.issueCurrent.mock.calls.length;
    await expect(service.ensure()).resolves.toBe(current);
    expect(lifecycle.issueCurrent).toHaveBeenCalledTimes(issued);
  });

  it('keeps the installed identity intact when provisioning stops before the set is committed', async () => {
    const identityDir = join(directory, 'identity');
    await provisioner().ensure();
    const installedClient = readFileSync(join(identityDir, 'app-relay-client.crt'), 'utf8');
    // A crash while staging leaves only *.next files; the installed set is still complete.
    writeFileSync(join(identityDir, 'app-relay-client.crt.next'), 'half-written');

    recoverIdentityFileSet(identityDir);

    expect(existsSync(join(identityDir, 'app-relay-client.crt.next'))).toBe(false);
    expect(readFileSync(join(identityDir, 'app-relay-client.crt'), 'utf8')).toBe(installedClient);
  });

  it('finishes a committed set whose renames were interrupted', async () => {
    const identityDir = join(directory, 'identity');
    await provisioner().ensure();
    const certificate = join(identityDir, 'relay-app-client.crt');
    const key = join(identityDir, 'relay-app-client.key');
    writeFileSync(`${certificate}.next`, 'new-certificate');
    writeFileSync(`${key}.next`, 'new-key');
    writeFileSync(
      join(identityDir, '.commit'),
      JSON.stringify([
        { staged: `${certificate}.next`, path: certificate },
        { staged: `${key}.next`, path: key },
      ])
    );

    recoverIdentityFileSet(identityDir);

    expect(readFileSync(certificate, 'utf8')).toBe('new-certificate');
    expect(readFileSync(key, 'utf8')).toBe('new-key');
    expect(existsSync(join(identityDir, '.commit'))).toBe(false);
  });
});
