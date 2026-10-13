import { describe, expect, it, vi } from 'vitest';
import { InternalCertificateRenewalService, isInternalCertificateRenewalDue } from './internal-cert-renewal.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Each db.select() resolves the next queued result; chains are thenable at any step. */
function queuedDb(selects: unknown[][], updates: unknown[][] = []) {
  const chain = (result: unknown) => {
    const node = Promise.resolve(result) as Promise<unknown> & Record<string, unknown>;
    for (const method of ['from', 'where', 'limit', 'orderBy', 'set', 'returning']) {
      node[method] = vi.fn(() => node);
    }
    return node;
  };
  const updateCalls: unknown[] = [];
  const db = {
    select: vi.fn(() => chain(selects.shift() ?? [])),
    update: vi.fn((table: unknown) => {
      updateCalls.push(table);
      return chain(updates.shift() ?? []);
    }),
  };
  return { db, updateCalls };
}

function source(overrides: Record<string, unknown> = {}) {
  const notBefore = new Date(Date.now() - 300 * DAY_MS);
  return {
    id: 'pki-old',
    caId: 'ca-1',
    templateId: 'template-1',
    status: 'active',
    type: 'tls-server',
    commonName: 'api.example.com',
    sans: ['api.example.com'],
    keyAlgorithm: 'ecdsa-p256',
    subjectDn: 'CN=api.example.com, O=Example, OU=Ops, C=DE',
    notBefore,
    notAfter: new Date(notBefore.getTime() + 365 * DAY_MS),
    encryptedPrivateKey: 'enc',
    encryptedDek: 'dek',
    ...overrides,
  };
}

function services(db: unknown) {
  const replacement = {
    id: 'pki-new',
    certificatePem: 'NEW-PEM',
    notBefore: new Date(),
    notAfter: new Date(Date.now() + 365 * DAY_MS),
  };
  const certService = {
    issueCertificate: vi.fn().mockResolvedValue({ certificate: replacement, privateKeyPem: 'NEW-KEY' }),
  };
  const sslService = { applyReissuedInternalCertificate: vi.fn().mockResolvedValue({ failures: [] }) };
  const distribution = { upsertOpfieldAsset: vi.fn().mockResolvedValue({}) };
  const audit = { log: vi.fn().mockResolvedValue(true) };
  const alerts = { createAlert: vi.fn().mockResolvedValue(undefined) };
  const proxy = { resyncTlsHost: vi.fn().mockResolvedValue({}) };
  const service = new InternalCertificateRenewalService(
    db as never,
    certService as never,
    sslService as never,
    distribution as never,
    audit as never,
    alerts as never
  );
  service.setProxyService(proxy as never);
  return { service, certService, sslService, distribution, audit, alerts, proxy, replacement };
}

describe('isInternalCertificateRenewalDue', () => {
  const notBefore = new Date('2026-01-01T00:00:00.000Z');
  const notAfter = new Date(notBefore.getTime() + 365 * DAY_MS);

  it('renews after two thirds of the lifetime', () => {
    expect(isInternalCertificateRenewalDue(notBefore, notAfter, new Date(notAfter.getTime() - 130 * DAY_MS))).toBe(
      false
    );
    expect(isInternalCertificateRenewalDue(notBefore, notAfter, new Date(notAfter.getTime() - 121 * DAY_MS))).toBe(
      true
    );
  });

  it('does not make a short-lived leaf due the day it is issued', () => {
    const shortEnd = new Date(notBefore.getTime() + 30 * DAY_MS);
    expect(isInternalCertificateRenewalDue(notBefore, shortEnd, new Date(notBefore.getTime() + DAY_MS))).toBe(false);
    expect(isInternalCertificateRenewalDue(notBefore, shortEnd, new Date(shortEnd.getTime() - 11 * DAY_MS))).toBe(
      false
    );
    expect(isInternalCertificateRenewalDue(notBefore, shortEnd, new Date(shortEnd.getTime() - 10 * DAY_MS))).toBe(true);
  });
});

describe('InternalCertificateRenewalService', () => {
  it('reissues a due linked leaf from the same CA and template and moves every user onto it', async () => {
    const old = source();
    const { db, updateCalls } = queuedDb(
      [
        [old], // source
        [
          {
            id: 'ca-1',
            status: 'active',
            isSystem: false,
            maxValidityDays: 825,
            commonName: 'Internal CA',
            notAfter: new Date(Date.now() + 3000 * DAY_MS),
          },
        ],
        [{ id: 'template-1' }],
        [{ id: 'ssl-1' }, { id: 'ssl-2' }], // linked SSL rows
      ],
      [[{ id: 'host-1', enabled: true, sslEnabled: true, sslCertificateId: null }]]
    );
    const { service, certService, sslService, distribution, proxy } = services(db);

    const result = await service.reissue('pki-old', 'user-1', 'manual');

    // Same CA and template: the replacement is trusted exactly like the leaf it replaces.
    expect(certService.issueCertificate).toHaveBeenCalledWith(
      expect.objectContaining({ caId: 'ca-1', templateId: 'template-1', commonName: 'api.example.com' }),
      'user-1',
      { clampToCaValidity: true }
    );
    expect(sslService.applyReissuedInternalCertificate).toHaveBeenCalledTimes(2);
    expect(sslService.applyReissuedInternalCertificate).toHaveBeenCalledWith(
      'ssl-1',
      expect.objectContaining({ internalCertId: 'pki-new', certificatePem: 'NEW-PEM', privateKeyPem: 'NEW-KEY' }),
      'user-1',
      'manual'
    );
    expect(updateCalls).toHaveLength(1); // proxy hosts referencing the leaf directly
    expect(distribution.upsertOpfieldAsset).toHaveBeenCalledWith({ type: 'internal', id: 'pki-new' });
    expect(proxy.resyncTlsHost).toHaveBeenCalledWith('host-1', 'user-1');
    expect(result.deliveryFailures).toEqual([]);
  });

  it('records why a leaf the CA can no longer extend is not reissued, without a failure alert', async () => {
    const due = source({ id: 'pki-due' });
    const { db, updateCalls } = queuedDb([[{ internalCertId: 'pki-due' }], [], [due]]);
    const { service, alerts } = services(db);
    const { AppError } = await import('@/middleware/error-handler.js');
    vi.spyOn(service, 'reissue').mockRejectedValue(new AppError(409, 'INTERNAL_CERT_NOT_EXTENDABLE', 'CA ends soon'));

    const result = await service.runDue();

    expect(result).toMatchObject({ renewed: 0, failed: 0, notExtendable: 1 });
    expect(alerts.createAlert).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
    const set = (db.update.mock.results[0]!.value as { set: ReturnType<typeof vi.fn> }).set;
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ renewalError: 'Automatic reissue is not possible: CA ends soon' })
    );
  });

  it('does not reissue from a revoked CA', async () => {
    const { db } = queuedDb([
      [source()],
      [{ id: 'ca-1', status: 'revoked', isSystem: false, maxValidityDays: 365, commonName: 'Old CA' }],
    ]);
    const { service, certService } = services(db);

    await expect(service.reissue('pki-old', 'user-1', 'scheduled')).rejects.toMatchObject({
      code: 'INTERNAL_CERT_CA_NOT_ACTIVE',
    });
    expect(certService.issueCertificate).not.toHaveBeenCalled();
  });

  it('scheduled pass reissues only due leaves Gateway holds the key for', async () => {
    const due = source({ id: 'pki-due' });
    const fresh = source({ id: 'pki-fresh', notBefore: new Date(), notAfter: new Date(Date.now() + 365 * DAY_MS) });
    const csr = source({ id: 'pki-csr', encryptedPrivateKey: null, encryptedDek: null });
    const { db } = queuedDb([
      [{ internalCertId: 'pki-due' }, { internalCertId: 'pki-fresh' }],
      [{ internalCertId: 'pki-csr' }, { internalCertId: 'pki-due' }],
      [due, fresh, csr],
    ]);
    const { service } = services(db);
    const reissue = vi.spyOn(service, 'reissue').mockResolvedValue({
      previousCertificateId: 'pki-due',
      certificateId: 'pki-new',
      notAfter: new Date(),
      sslCertificateIds: [],
      proxyHostIds: [],
      deliveryFailures: [],
    });

    const result = await service.runDue();

    expect(reissue).toHaveBeenCalledTimes(1);
    expect(reissue).toHaveBeenCalledWith('pki-due', '00000000-0000-0000-0000-000000000000', 'scheduled');
    expect(result).toMatchObject({ renewed: 1, failed: 0, csrIssued: 1 });
  });

  it('records a failed scheduled reissue on the linked certificate and alerts once', async () => {
    const due = source({ id: 'pki-due', notAfter: new Date(Date.now() + 5 * DAY_MS) });
    const { db } = queuedDb([[{ internalCertId: 'pki-due' }], [], [due], []], [[{ id: 'ssl-1', name: 'api' }]]);
    const { service, alerts } = services(db);
    vi.spyOn(service, 'reissue').mockRejectedValue(new Error('CA unreachable'));

    const result = await service.runDue();

    expect(result.failed).toBe(1);
    expect(alerts.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'expiry_critical',
        resourceType: 'ssl_certificate',
        resourceId: 'ssl-1',
        message: expect.stringContaining('CA unreachable'),
      })
    );
  });

  it('requires pki:cert:issue on the CA for an interactive renew', async () => {
    const { db } = queuedDb([[{ id: 'ssl-1', type: 'internal', internalCertId: 'pki-old' }], [{ caId: 'ca-1' }]]);
    const { service } = services(db);
    const reissue = vi.spyOn(service, 'reissue');

    await expect(
      service.renewSslCertificate('ssl-1', 'user-1', { actorScopes: ['ssl:cert:issue'] })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(reissue).not.toHaveBeenCalled();
  });

  it('renews by hand with pki:cert:issue on the CA and includes that certificate', async () => {
    const { db } = queuedDb([[{ id: 'ssl-1', type: 'internal', internalCertId: 'pki-old' }], [{ caId: 'ca-1' }]]);
    const { service } = services(db);
    const reissue = vi.spyOn(service, 'reissue').mockResolvedValue({} as never);

    await service.renewSslCertificate('ssl-1', 'user-1', { actorScopes: ['ssl:cert:issue', 'pki:cert:issue:ca-1'] });

    expect(reissue).toHaveBeenCalledWith('pki-old', 'user-1', 'manual', { sslCertificateId: 'ssl-1' });
  });
});
