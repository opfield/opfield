import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayIdentityActivation } from '@/grpc/relay-control.client.js';
import {
  OPFIELD_GRPC_CERTIFICATE_FINAL_RENEW_BEFORE_MS,
  OPFIELD_IDENTITY_RENEW_BEFORE_MS,
} from './grpc-server-certificate.js';
import { OpfieldIdentityRenewalService } from './opfield-identity-renewal.service.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2027, 8, 1);
const keys = forge.pki.rsa.generateKeyPair(1024);
let serial = 100;

function certificatePem(commonName: string, expiresInMs: number): string {
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  serial += 1;
  certificate.serialNumber = serial.toString(16);
  certificate.validity.notBefore = new Date(NOW - 335 * DAY);
  certificate.validity.notAfter = new Date(NOW + expiresInMs);
  certificate.setSubject([{ name: 'commonName', value: commonName }]);
  certificate.setIssuer([{ name: 'commonName', value: 'opfield-system-ca' }]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(certificate);
}

function remainingMs(path: string): number {
  return forge.pki.certificateFromPem(readFileSync(path, 'utf8')).validity.notAfter.getTime() - NOW;
}

describe('OpfieldIdentityRenewalService', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'opfield-identity-renewal-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  /**
   * Stands in for GrpcIdentityService over ensureGrpcServerCert: a refresh re-issues the
   * certificate once it is within the requested window, by default its last week.
   */
  function grpcIdentityFor(certPath: string, keyPath: string) {
    let generation = 0;
    const identity = () => ({ certPath, keyPath, opfieldCertSha256: `sha256:grpc-${generation}` });
    return {
      resolve: vi.fn(async () => identity()),
      refresh: vi.fn(async (options: { renewBeforeMs?: number } = {}) => {
        if (remainingMs(certPath) <= (options.renewBeforeMs ?? OPFIELD_GRPC_CERTIFICATE_FINAL_RENEW_BEFORE_MS)) {
          writeFileSync(certPath, certificatePem('opfield-grpc', 365 * DAY));
          generation += 1;
        }
        return identity();
      }),
      markServed: vi.fn(),
    };
  }

  /** An Opfield without a local relay whose gRPC listener serves `grpc.crt`. */
  function standalone(options: { expiresInMs: number; operatorSupplied?: boolean; pendingEnrollments?: boolean }) {
    const certPath = join(directory, 'grpc.crt');
    const keyPath = join(directory, 'grpc.key');
    writeFileSync(certPath, certificatePem('opfield-grpc', options.expiresInMs));
    writeFileSync(keyPath, 'key');
    let served: Buffer | null = readFileSync(certPath);
    const grpcIdentity = grpcIdentityFor(certPath, keyPath);
    const grpcListener = {
      refreshCredentials: vi.fn(async (path: string) => {
        served = readFileSync(path);
      }),
      servedCertificate: () => served,
      stageRelayTrust: vi.fn(() => vi.fn()),
    };
    const audit = { log: vi.fn().mockResolvedValue(true) };
    const hasPendingEnrollments = vi.fn(async () => options.pendingEnrollments ?? false);
    const service = new OpfieldIdentityRenewalService({
      env: { OPFIELD_RELAY_REQUIRED: false, GRPC_TLS_CERT: options.operatorSupplied ? certPath : undefined } as never,
      grpcIdentity,
      grpcListener,
      hasPendingEnrollments,
      audit,
      now: () => NOW,
    });
    return { service, grpcIdentity, grpcListener, audit, hasPendingEnrollments, certPath, served: () => served };
  }

  /** An Opfield behind its local relay; the relay loads whatever is installed when it is asked. */
  function behindRelay(options: { relayClientExpiresInMs: number; externalExpiresInMs?: number }) {
    const external = { certPath: join(directory, 'grpc.crt'), keyPath: join(directory, 'grpc.key') };
    const paths = {
      externalServer: join(directory, 'external-server.crt'),
      appInternalServer: join(directory, 'app-internal-server.crt'),
      appRelayClient: join(directory, 'app-relay-client.crt'),
      relayAppClient: join(directory, 'relay-app-client.crt'),
    };
    writeFileSync(external.certPath, certificatePem('opfield-grpc', options.externalExpiresInMs ?? 200 * DAY));
    writeFileSync(paths.externalServer, readFileSync(external.certPath));
    writeFileSync(paths.appInternalServer, certificatePem('app', 200 * DAY));
    writeFileSync(paths.appRelayClient, certificatePem('app-relay-client', 200 * DAY));
    writeFileSync(paths.relayAppClient, certificatePem('relay-app-client', options.relayClientExpiresInMs));
    let served: Buffer | null = readFileSync(paths.appInternalServer);
    let generation = 0;
    const grpcIdentity = grpcIdentityFor(external.certPath, external.keyPath);
    const identity = () => ({
      internalServerCertPath: paths.appInternalServer,
      internalServerKeyPath: join(directory, 'app-internal-server.key'),
      appClientCertPath: paths.appRelayClient,
      appClientKeyPath: join(directory, 'app-relay-client.key'),
      relayClientFingerprint: `sha256:relay-${generation}`,
      appClientFingerprint: `sha256:app-${generation}`,
      externalFingerprint: `sha256:external-${generation}`,
      materialDigest: `digest-${generation}`,
    });
    const relayIdentity = {
      // Stands in for the provisioner: it re-issues due leaves and copies the gRPC certificate.
      refresh: vi.fn(async () => {
        let changed = false;
        if (remainingMs(paths.relayAppClient) <= OPFIELD_IDENTITY_RENEW_BEFORE_MS) {
          writeFileSync(paths.relayAppClient, certificatePem('relay-app-client', 365 * DAY));
          changed = true;
        }
        if (!readFileSync(paths.externalServer).equals(readFileSync(external.certPath))) {
          writeFileSync(paths.externalServer, readFileSync(external.certPath));
          changed = true;
        }
        if (changed) generation += 1;
        return identity();
      }),
      installedCertificatePaths: () => paths,
    };
    const loadedNow = (): RelayIdentityActivation => ({
      certificate: Buffer.from(`app-client-${generation}`),
      certificateSha256: `sha256:app-${generation}`,
      loaded: {
        externalCertificateSha256: `sha256:external-${generation}`,
        relayClientCertificateSha256: `sha256:relay-${generation}`,
        appClientCertificateSha256: `sha256:app-${generation}`,
      },
    });
    const relayControl = {
      listener: undefined as ((activation: RelayIdentityActivation) => void) | undefined,
      reloadIdentity: vi.fn(async () => {
        relayControl.listener?.(loadedNow());
        return true;
      }),
      setIdentityActivationListener(listener: (activation: RelayIdentityActivation) => void) {
        relayControl.listener = listener;
      },
    };
    const commitTrust = vi.fn();
    const grpcListener = {
      refreshCredentials: vi.fn(async (path: string) => {
        served = readFileSync(path);
      }),
      servedCertificate: () => served,
      stageRelayTrust: vi.fn(() => commitTrust),
    };
    const onAppClientFingerprint = vi.fn();
    const hasPendingEnrollments = vi.fn(async () => false);
    const service = new OpfieldIdentityRenewalService({
      env: { OPFIELD_RELAY_REQUIRED: true, GRPC_TLS_CERT: undefined } as never,
      grpcIdentity,
      grpcListener,
      relayIdentity,
      relayControl,
      startupRelayIdentity: { materialDigest: 'digest-0' },
      onAppClientFingerprint,
      hasPendingEnrollments,
      now: () => NOW,
    });
    return {
      service,
      grpcIdentity,
      relayIdentity,
      relayControl,
      grpcListener,
      commitTrust,
      onAppClientFingerprint,
      hasPendingEnrollments,
      loadedNow,
    };
  }

  it('leaves identities alone until they enter the renewal window', async () => {
    const { service, grpcIdentity, grpcListener, audit } = standalone({
      expiresInMs: OPFIELD_IDENTITY_RENEW_BEFORE_MS + DAY,
    });

    await expect(service.renewDue()).resolves.toEqual({ renewed: [], failed: [], relayConfirmed: null });
    expect(grpcIdentity.refresh).not.toHaveBeenCalled();
    expect(grpcListener.refreshCredentials).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('renews a due gRPC certificate weeks before expiry, switches the listener, then advertises it', async () => {
    const { service, grpcIdentity, grpcListener, certPath, served } = standalone({
      expiresInMs: OPFIELD_IDENTITY_RENEW_BEFORE_MS - DAY,
    });
    const before = served();

    const result = await service.renewDue();

    expect(result).toEqual({ renewed: ['grpc'], failed: [], relayConfirmed: null });
    expect(grpcIdentity.refresh).toHaveBeenCalledWith({ renewBeforeMs: OPFIELD_IDENTITY_RENEW_BEFORE_MS });
    expect(grpcListener.refreshCredentials).toHaveBeenCalledWith(certPath, join(directory, 'grpc.key'));
    expect(served()).not.toEqual(before);
    expect(served()).toEqual(readFileSync(certPath));
    // Enrollment commands get the new fingerprint only once daemons are served it.
    expect(grpcIdentity.markServed).toHaveBeenCalledWith('sha256:grpc-1');
    expect(grpcIdentity.markServed.mock.invocationCallOrder[0]).toBeGreaterThan(
      grpcListener.refreshCredentials.mock.invocationCallOrder[0]!
    );
    // Once renewed, the next check has nothing to do.
    await expect(service.renewDue()).resolves.toMatchObject({ renewed: [] });
    expect(grpcIdentity.refresh).toHaveBeenCalledOnce();
  });

  it('keeps serving and advertising the current certificate when the switch fails, and retries', async () => {
    const { service, grpcIdentity, grpcListener, served } = standalone({
      expiresInMs: OPFIELD_IDENTITY_RENEW_BEFORE_MS - DAY,
    });
    const before = served();
    grpcListener.refreshCredentials.mockRejectedValueOnce(new Error('secure context rejected'));

    const failed = await service.renewDue();

    expect(failed.renewed).toEqual([]);
    expect(failed.failed).toEqual([{ identity: 'grpc', message: 'secure context rejected' }]);
    expect(served()).toBe(before);
    expect(grpcIdentity.markServed).not.toHaveBeenCalled();

    // The renewed certificate is installed but not served: the next check switches to it.
    const retried = await service.renewDue();
    expect(retried).toMatchObject({ renewed: ['grpc'], failed: [] });
    expect(grpcListener.refreshCredentials).toHaveBeenCalledTimes(2);
    expect(served()).not.toBe(before);
    expect(grpcIdentity.markServed).toHaveBeenCalledOnce();
  });

  it('only warns about an operator-supplied gRPC certificate it cannot renew', async () => {
    const { service, grpcIdentity, grpcListener } = standalone({
      expiresInMs: OPFIELD_IDENTITY_RENEW_BEFORE_MS - DAY,
      operatorSupplied: true,
    });

    await expect(service.renewDue()).resolves.toMatchObject({ renewed: [], failed: [] });
    expect(grpcIdentity.refresh).not.toHaveBeenCalled();
    expect(grpcListener.refreshCredentials).not.toHaveBeenCalled();
  });

  it('postpones the gRPC certificate enrollment commands pin while tokens are outstanding', async () => {
    const { service, grpcIdentity, hasPendingEnrollments } = standalone({
      expiresInMs: 20 * DAY,
      pendingEnrollments: true,
    });

    await expect(service.renewDue()).resolves.toMatchObject({ renewed: [], failed: [] });
    expect(hasPendingEnrollments).toHaveBeenCalled();
    expect(grpcIdentity.refresh).not.toHaveBeenCalled();

    // Once the tokens are used or expire, it renews.
    hasPendingEnrollments.mockResolvedValue(false);
    await expect(service.renewDue()).resolves.toMatchObject({ renewed: ['grpc'] });
    expect(grpcIdentity.refresh).toHaveBeenCalledWith({ renewBeforeMs: OPFIELD_IDENTITY_RENEW_BEFORE_MS });
  });

  it('renews the gRPC certificate in its last week even while enrollment tokens are outstanding', async () => {
    const { service, grpcIdentity } = standalone({
      expiresInMs: OPFIELD_GRPC_CERTIFICATE_FINAL_RENEW_BEFORE_MS - DAY,
      pendingEnrollments: true,
    });

    await expect(service.renewDue()).resolves.toMatchObject({ renewed: ['grpc'], failed: [] });
    expect(grpcIdentity.refresh).toHaveBeenCalledWith({ renewBeforeMs: OPFIELD_IDENTITY_RENEW_BEFORE_MS });
  });

  it('renews the internal relay identities while postponing only the gRPC certificate', async () => {
    const { service, grpcIdentity, relayIdentity, hasPendingEnrollments } = behindRelay({
      relayClientExpiresInMs: 10 * DAY,
      externalExpiresInMs: 20 * DAY,
    });
    hasPendingEnrollments.mockResolvedValue(true);

    await expect(service.renewDue()).resolves.toMatchObject({ renewed: ['grpc'], failed: [], relayConfirmed: true });
    expect(grpcIdentity.refresh).toHaveBeenCalledWith({
      renewBeforeMs: OPFIELD_GRPC_CERTIFICATE_FINAL_RENEW_BEFORE_MS,
    });
    expect(relayIdentity.refresh).toHaveBeenCalledOnce();
    expect(remainingMs(join(directory, 'grpc.crt'))).toBe(20 * DAY);
    expect(remainingMs(join(directory, 'relay-app-client.crt'))).toBe(365 * DAY);
  });

  it('trusts a renewed relay client before switching the listener, reloads the relay, then drops the old trust', async () => {
    const { service, grpcIdentity, relayControl, grpcListener, commitTrust, onAppClientFingerprint } = behindRelay({
      relayClientExpiresInMs: 10 * DAY,
    });

    const result = await service.renewDue();

    expect(result).toEqual({ renewed: ['grpc'], failed: [], relayConfirmed: true });
    expect(grpcListener.stageRelayTrust).toHaveBeenCalledWith('sha256:relay-1');
    expect(grpcListener.stageRelayTrust.mock.invocationCallOrder[0]).toBeLessThan(
      grpcListener.refreshCredentials.mock.invocationCallOrder[0]!
    );
    expect(relayControl.reloadIdentity).toHaveBeenCalledOnce();
    expect(onAppClientFingerprint).toHaveBeenCalledWith('sha256:app-1');
    expect(commitTrust).toHaveBeenCalledOnce();
    expect(relayControl.reloadIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      commitTrust.mock.invocationCallOrder[0]!
    );
    // Daemons reach Opfield through the relay: enrollment commands now pin what it confirmed serving.
    expect(grpcIdentity.markServed).toHaveBeenCalledWith('sha256:external-1');
  });

  it('keeps the renewed relay client trusted when switching the listener fails', async () => {
    const { service, relayControl, grpcListener, commitTrust } = behindRelay({ relayClientExpiresInMs: 10 * DAY });
    grpcListener.refreshCredentials.mockRejectedValueOnce(new Error('secure context rejected'));

    await expect(service.renewDue()).resolves.toMatchObject({
      renewed: [],
      failed: [{ identity: 'grpc', message: 'secure context rejected' }],
    });
    // A relay restarting now presents the renewed client certificate, which Opfield already trusts.
    expect(grpcListener.stageRelayTrust).toHaveBeenCalledWith('sha256:relay-1');
    expect(commitTrust).not.toHaveBeenCalled();
    expect(relayControl.reloadIdentity).not.toHaveBeenCalled();

    // The installed relay identity is activated on the next check, with the trust staged once.
    await expect(service.renewDue()).resolves.toMatchObject({ failed: [], relayConfirmed: true });
    expect(grpcListener.stageRelayTrust).toHaveBeenCalledOnce();
    expect(commitTrust).toHaveBeenCalledOnce();
  });

  it('keeps both relay identities trusted until a fresh reload confirms', async () => {
    const { service, relayControl, commitTrust, onAppClientFingerprint } = behindRelay({
      relayClientExpiresInMs: 10 * DAY,
    });
    relayControl.reloadIdentity.mockRejectedValueOnce(new Error('relay unavailable'));

    const first = await service.renewDue();
    expect(first).toMatchObject({ renewed: ['grpc'], relayConfirmed: false });
    expect(commitTrust).not.toHaveBeenCalled();
    expect(onAppClientFingerprint).not.toHaveBeenCalled();

    const second = await service.renewDue();
    expect(second).toMatchObject({ renewed: [], relayConfirmed: true });
    expect(relayControl.reloadIdentity).toHaveBeenCalledTimes(2);
    expect(commitTrust).toHaveBeenCalledOnce();
    expect(onAppClientFingerprint).toHaveBeenCalledWith('sha256:app-1');

    await service.renewDue();
    expect(relayControl.reloadIdentity).toHaveBeenCalledTimes(2);
  });

  it('never confirms from a reload that moved to another client or loaded other files', async () => {
    const { service, relayControl, commitTrust, onAppClientFingerprint, loadedNow } = behindRelay({
      relayClientExpiresInMs: 10 * DAY,
    });
    // An earlier reload, answered before the renewal was installed, moves to the previous client.
    relayControl.reloadIdentity.mockImplementationOnce(async () => {
      relayControl.listener?.({ ...loadedNow(), certificateSha256: 'sha256:app-0' });
      return true;
    });
    await expect(service.renewDue()).resolves.toMatchObject({ renewed: ['grpc'], relayConfirmed: false });
    expect(onAppClientFingerprint).toHaveBeenCalledWith('sha256:app-0');
    expect(commitTrust).not.toHaveBeenCalled();

    // The relay loaded an older relay client certificate than the one installed.
    relayControl.reloadIdentity.mockImplementationOnce(async () => {
      const activation = loadedNow();
      relayControl.listener?.({
        ...activation,
        loaded: { ...activation.loaded!, relayClientCertificateSha256: 'sha256:relay-0' },
      });
      return true;
    });
    await expect(service.renewDue()).resolves.toMatchObject({ relayConfirmed: false });
    expect(commitTrust).not.toHaveBeenCalled();

    await expect(service.renewDue()).resolves.toMatchObject({ relayConfirmed: true });
    expect(commitTrust).toHaveBeenCalledOnce();
  });

  it('does not treat a relay that answered without reloading as confirmed', async () => {
    const { service, relayControl, commitTrust } = behindRelay({ relayClientExpiresInMs: 10 * DAY });
    relayControl.reloadIdentity.mockResolvedValueOnce(false);

    await expect(service.renewDue()).resolves.toMatchObject({ relayConfirmed: false });
    expect(commitTrust).not.toHaveBeenCalled();
    // The next check asks again instead of assuming the reload happened.
    await expect(service.renewDue()).resolves.toMatchObject({ relayConfirmed: true });
    expect(relayControl.reloadIdentity).toHaveBeenCalledTimes(2);
    expect(commitTrust).toHaveBeenCalledOnce();
  });

  it('finishes the rotation when an admin call converges the relay reload first', async () => {
    const { service, relayControl, commitTrust, onAppClientFingerprint, loadedNow } = behindRelay({
      relayClientExpiresInMs: 10 * DAY,
    });
    relayControl.reloadIdentity.mockRejectedValueOnce(new Error('relay unavailable'));
    await expect(service.renewDue()).resolves.toMatchObject({ relayConfirmed: false });

    // A health probe converged the reload for the installed files.
    relayControl.listener!(loadedNow());

    expect(onAppClientFingerprint).toHaveBeenCalledWith('sha256:app-1');
    expect(commitTrust).toHaveBeenCalledOnce();
    await expect(service.renewDue()).resolves.toMatchObject({ renewed: [], relayConfirmed: null });
    expect(relayControl.reloadIdentity).toHaveBeenCalledOnce();
  });

  it('still renews the web listener when the gRPC check itself fails', async () => {
    const certPath = join(directory, 'web.crt');
    writeFileSync(certPath, certificatePem('gateway-web', OPFIELD_IDENTITY_RENEW_BEFORE_MS - DAY));
    let served = readFileSync(certPath);
    const webIdentity = {
      resolve: vi.fn(async () => ({ certPath, keyPath: join(directory, 'web.key'), certSha256: 'sha256:w' })),
      servedCertificate: () => served,
      reloadServed: vi.fn(async () => {
        writeFileSync(certPath, certificatePem('gateway-web', 365 * DAY));
        served = readFileSync(certPath);
        return { certPath, keyPath: join(directory, 'web.key'), certSha256: 'sha256:v' };
      }),
    };
    const service = new OpfieldIdentityRenewalService({
      env: { OPFIELD_RELAY_REQUIRED: false } as never,
      grpcIdentity: {
        resolve: vi.fn().mockRejectedValue(new Error('system CA unavailable')),
        refresh: vi.fn(),
        markServed: vi.fn(),
      },
      grpcListener: { refreshCredentials: vi.fn(), servedCertificate: () => null, stageRelayTrust: vi.fn() },
      webIdentity,
      now: () => NOW,
    });

    await expect(service.renewDue()).resolves.toMatchObject({
      renewed: ['web'],
      failed: [{ identity: 'grpc', message: 'system CA unavailable' }],
    });
  });

  it('renews the web listener certificate in place and reports a failed switch', async () => {
    const certPath = join(directory, 'web.crt');
    writeFileSync(certPath, certificatePem('gateway-web', OPFIELD_IDENTITY_RENEW_BEFORE_MS - DAY));
    let served = readFileSync(certPath);
    const webIdentity = {
      resolve: vi.fn(async () => ({ certPath, keyPath: join(directory, 'web.key'), certSha256: 'sha256:w' })),
      servedCertificate: () => served,
      reloadServed: vi.fn(async () => {
        writeFileSync(certPath, certificatePem('gateway-web', 365 * DAY));
        served = readFileSync(certPath);
        return { certPath, keyPath: join(directory, 'web.key'), certSha256: 'sha256:v' };
      }),
    };
    const grpcPath = join(directory, 'grpc.crt');
    writeFileSync(grpcPath, certificatePem('opfield-grpc', 200 * DAY));
    const service = new OpfieldIdentityRenewalService({
      env: { OPFIELD_RELAY_REQUIRED: false } as never,
      grpcIdentity: grpcIdentityFor(grpcPath, 'k'),
      grpcListener: { refreshCredentials: vi.fn(), servedCertificate: () => null, stageRelayTrust: vi.fn() },
      webIdentity,
      now: () => NOW,
    });

    webIdentity.reloadServed.mockRejectedValueOnce(new Error('Invalid web TLS certificate: expired'));
    await expect(service.renewDue()).resolves.toMatchObject({
      renewed: [],
      failed: [{ identity: 'web', message: 'Invalid web TLS certificate: expired' }],
    });
    await expect(service.renewDue()).resolves.toMatchObject({ renewed: ['web'], failed: [] });
    expect(webIdentity.reloadServed).toHaveBeenCalledTimes(2);
  });

  it('never runs a settings refresh and a renewal at the same time', async () => {
    const { service, grpcIdentity } = standalone({ expiresInMs: OPFIELD_IDENTITY_RENEW_BEFORE_MS - DAY });
    let active = 0;
    let overlapped = false;
    const refresh = grpcIdentity.refresh.getMockImplementation()!;
    grpcIdentity.refresh.mockImplementation(async (options) => {
      active += 1;
      overlapped ||= active > 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return refresh(options);
    });

    await Promise.all([service.refreshGrpcIdentity(), service.renewDue(), service.refreshGrpcIdentity()]);
    expect(overlapped).toBe(false);
  });
});
