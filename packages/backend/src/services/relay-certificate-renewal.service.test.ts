import { createHash, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { describe, expect, it, vi } from 'vitest';
import {
  RELAY_CERTIFICATE_RENEW_BEFORE_MS,
  RelayCertificateRenewalService,
} from './relay-certificate-renewal.service.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const keys = forge.pki.rsa.generateKeyPair(1024);

function certificatePem(commonName: string, notAfter: Date): string {
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '0a';
  certificate.validity.notBefore = new Date(Date.now() - DAY);
  certificate.validity.notAfter = notAfter;
  certificate.setSubject([{ name: 'commonName', value: commonName }]);
  certificate.setIssuer([{ name: 'commonName', value: 'opfield-system-ca' }]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(certificate);
}

function relay(overrides: Record<string, unknown> = {}) {
  return {
    id: 'relay-1',
    poolId: 'system',
    kind: 'remote',
    nodeId: 'node-1',
    advertisedAddresses: ['relay.example.test'],
    certificateFingerprint: 'sha256:pinned',
    certificateExpiresAt: new Date(Date.now() + 10 * DAY),
    capabilities: { protocolMajor: 1, features: ['relay_pool_v1', 'server_certificate_rollover_v1'] },
    ...overrides,
  };
}

function harness(
  options: { dispatchResult?: { success: boolean; error?: string }; connected?: boolean; rows?: unknown[] } = {}
) {
  const renewedExpiry = new Date(Date.now() + 365 * DAY);
  const lifecycle = {
    issuePending: vi.fn(async (input: { commonName: string }) => ({
      certificate: { certificatePem: certificatePem(input.commonName, renewedExpiry), serialNumber: 'serial-2' },
      privateKeyPem: 'renewed-key',
    })),
    promotePending: vi.fn(async (_owner: unknown, _serial: string, bind: (tx: any, promoted: any) => Promise<void>) => {
      await bind(tx, { id: 'cert-2', serialNumber: 'serial-2', notAfter: renewedExpiry, certificatePem: '' });
      return true;
    }),
  };
  const writes: any[] = [];
  const tx = {
    update: () => ({
      set: (values: unknown) => ({
        where: async () => {
          writes.push(values);
        },
      }),
    }),
  };
  const rows: unknown[] = options.rows ?? [relay()];
  const db = {
    select: () => {
      const query: any = Promise.resolve(rows);
      for (const method of ['from', 'where', 'limit']) query[method] = () => query;
      return query;
    },
  };
  const dispatch = {
    renewRelayIdentity: vi.fn().mockResolvedValue(options.dispatchResult ?? { success: true, detail: 'ok' }),
    isNodeConnected: vi.fn(() => options.connected ?? true),
  };
  const policy = { refreshAllNodeGrantsIfDue: vi.fn().mockResolvedValue(undefined) };
  const service = new RelayCertificateRenewalService(
    db as never,
    lifecycle as never,
    { getSystemCAId: vi.fn().mockResolvedValue('ca-1') },
    dispatch as never,
    policy,
    { log: vi.fn().mockResolvedValue(true) }
  );
  return { service, lifecycle, dispatch, policy, writes, renewedExpiry };
}

describe('RelayCertificateRenewalService', () => {
  it('publishes a renewed certificate only after the relay serves it, keeping the pinned one', async () => {
    const { service, lifecycle, dispatch, policy, writes, renewedExpiry } = harness();

    await expect(service.renewDue()).resolves.toBe(1);

    const sent = (dispatch.renewRelayIdentity.mock.calls[0] as unknown as [string, any])[1];
    // A new identity next to the one daemons pin, which the relay keeps serving.
    expect(sent.serverIdentity).not.toBe('relay-relay-1');
    expect(sent.retainServerFingerprint).toBe('sha256:pinned');
    expect(dispatch.renewRelayIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycle.promotePending.mock.invocationCallOrder[0]!
    );
    const fingerprint = `sha256:${createHash('sha256').update(new X509Certificate(sent.serverCertificate).raw).digest('hex')}`;
    expect(writes).toEqual([
      expect.objectContaining({
        certificateIdentity: sent.serverIdentity,
        certificateFingerprint: fingerprint,
        certificateExpiresAt: renewedExpiry,
      }),
    ]);
    // Daemons get grant bundles that pin the renewed certificate.
    expect(policy.refreshAllNodeGrantsIfDue).toHaveBeenCalledWith(true);
  });

  it('keeps the published certificate when the relay does not confirm, and retries an hour later', async () => {
    const { service, lifecycle, writes, dispatch } = harness({
      dispatchResult: { success: false, error: 'unsupported command for relay supervisor' },
    });

    await expect(service.renewDue()).resolves.toBe(0);
    expect(lifecycle.promotePending).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(service.describeCertificates([relay()] as never).get('relay-1')?.state).toBe('renewal_failed');

    await service.renewDue();
    expect(dispatch.renewRelayIdentity).toHaveBeenCalledTimes(1);
    dispatch.renewRelayIdentity.mockResolvedValue({ success: true, detail: 'ok' });
    await expect(service.renewDue(new Date(Date.now() + HOUR + 60_000))).resolves.toBe(1);
    expect(dispatch.renewRelayIdentity).toHaveBeenCalledTimes(2);
    expect(service.describeCertificates([relay()] as never).get('relay-1')?.state).toBe('expiring');
  });

  it('sends the renewed key only over the connected supervisor stream', async () => {
    const { service, dispatch } = harness({ connected: false });
    await expect(service.renewDue()).resolves.toBe(0);
    expect(dispatch.renewRelayIdentity).not.toHaveBeenCalled();
    await expect(service.renewInstanceCertificate('relay-1', 'admin')).rejects.toMatchObject({
      code: 'RELAY_NOT_CONNECTED',
    });
  });

  it('reports expired and expiring certificates instead of letting them lapse silently', () => {
    const { service } = harness();
    const now = new Date();
    const statuses = service.describeCertificates(
      [
        relay({ id: 'expired', certificateExpiresAt: new Date(now.getTime() - DAY) }),
        relay({ id: 'expiring', certificateExpiresAt: new Date(now.getTime() + 5 * DAY) }),
        relay({ id: 'fine', certificateExpiresAt: new Date(now.getTime() + RELAY_CERTIFICATE_RENEW_BEFORE_MS + DAY) }),
      ] as never,
      now
    );
    expect(statuses.get('expired')?.state).toBe('expired');
    expect(statuses.get('expiring')?.state).toBe('expiring');
    expect(statuses.has('fine')).toBe(false);
  });

  it('refuses to renew on a worker that would stop serving the certificate daemons pin', async () => {
    const { service, dispatch, lifecycle } = harness({
      rows: [relay({ capabilities: { protocolMajor: 1, features: ['relay_pool_v1'] } })],
    });
    await expect(service.renewDue()).resolves.toBe(0);
    expect(lifecycle.issuePending).not.toHaveBeenCalled();
    expect(dispatch.renewRelayIdentity).not.toHaveBeenCalled();
    expect(service.describeCertificates([relay()] as never).get('relay-1')?.state).toBe('renewal_failed');
  });

  it('does not renew again before daemons had a day to receive the last renewal', async () => {
    const { service, dispatch } = harness({
      rows: [relay({ certificateExpiresAt: new Date(Date.now() + 365 * DAY - 60_000) })],
    });
    await expect(service.renewInstanceCertificate('relay-1', 'admin')).rejects.toMatchObject({
      code: 'RELAY_CERTIFICATE_RECENTLY_RENEWED',
    });
    expect(dispatch.renewRelayIdentity).not.toHaveBeenCalled();
  });
});
