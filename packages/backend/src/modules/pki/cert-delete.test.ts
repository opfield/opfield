// The schema barrel first, in its production order: the per-table modules import each other circularly.
import '@/db/schema/index.js';
import { describe, expect, it, vi } from 'vitest';
import { pkiRevokedSerials, proxyHosts, sslCertificates } from '@/db/schema/index.js';
import { CertService } from './cert.service.js';
import { OCSPService } from './ocsp.service.js';

// PKI certificates could only be revoked, never deleted (X-O-21). A revoked or expired one can now be deleted; a
// revoked one that has not expired yet stays revoked for CRL and OCSP through pki_revoked_serials.
const ID = 'cccccccc-0000-4000-8000-000000000001';
const DAY = 24 * 60 * 60 * 1000;

function setup(
  cert: Record<string, unknown> | undefined,
  options: { system?: boolean; routes?: unknown[]; linked?: unknown[] } = {}
) {
  const inserted: Array<{ table: unknown; values: unknown }> = [];
  const deleted: unknown[] = [];
  const audit = { log: vi.fn(async () => true) };
  const selectFrom = (table: unknown) => {
    const rows =
      table === proxyHosts ? (options.routes ?? []) : table === sslCertificates ? (options.linked ?? []) : [];
    const where = () =>
      Object.assign(Promise.resolve(rows), { limit: async () => [{ isSystem: options.system ?? false }] });
    return { where };
  };
  const tx = {
    insert: (table: unknown) => ({
      values: (values: unknown) => ({
        onConflictDoNothing: async () => {
          inserted.push({ table, values });
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        deleted.push(table);
      },
    }),
  };
  const db = {
    query: { certificates: { findFirst: async () => cert } },
    select: () => ({ from: selectFrom }),
    transaction: async (callback: (client: typeof tx) => Promise<void>) => callback(tx),
  };
  const service = new CertService(db as never, {} as never, {} as never, audit as never);
  return { service, inserted, deleted, audit };
}

const base = {
  id: ID,
  caId: 'ca-1',
  commonName: 'app.example.com',
  serialNumber: '0a1b',
  revocationReason: 'cessationOfOperation',
};

describe('deleting a PKI certificate', () => {
  it('keeps a revoked certificate that has not expired on the CRL until it would have', async () => {
    const notAfter = new Date(Date.now() + 30 * DAY);
    const revokedAt = new Date(Date.now() - DAY);
    const { service, inserted, deleted, audit } = setup({ ...base, status: 'revoked', revokedAt, notAfter });

    await expect(service.deleteCertificate(ID, 'user-1')).resolves.toEqual({
      deleted: true,
      keptOnCrlUntil: notAfter.toISOString(),
    });
    expect(inserted).toEqual([
      {
        table: pkiRevokedSerials,
        values: { caId: 'ca-1', serialNumber: '0a1b', revokedAt, revocationReason: 'cessationOfOperation', notAfter },
      },
    ]);
    expect(deleted).toHaveLength(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cert.delete', resourceType: 'certificate', resourceId: ID })
    );
  });

  it('deletes an expired certificate without keeping anything', async () => {
    const { service, inserted, deleted } = setup({
      ...base,
      status: 'active',
      revokedAt: null,
      notAfter: new Date(Date.now() - DAY),
    });
    await expect(service.deleteCertificate(ID, 'user-1')).resolves.toEqual({ deleted: true, keptOnCrlUntil: null });
    expect(inserted).toEqual([]);
    expect(deleted).toHaveLength(1);
  });

  it('refuses a valid certificate, one in use, a system certificate and an unknown one', async () => {
    const valid = { ...base, status: 'active', revokedAt: null, notAfter: new Date(Date.now() + DAY) };
    await expect(setup(valid).service.deleteCertificate(ID, 'u')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CERT_STILL_VALID',
    });

    const revoked = { ...base, status: 'revoked', revokedAt: new Date(), notAfter: new Date(Date.now() + DAY) };
    const inUse = setup(revoked, { routes: [{ id: 'route-1', domainNames: ['app.example.com'] }] });
    await expect(inUse.service.deleteCertificate(ID, 'u')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CERT_IN_USE',
      details: { routes: [{ id: 'route-1' }] },
    });
    expect(inUse.deleted).toEqual([]);

    const linked = setup(revoked, { linked: [{ id: 'ssl-1', name: 'App' }] });
    await expect(linked.service.deleteCertificate(ID, 'u')).rejects.toMatchObject({ code: 'CERT_IN_USE' });

    await expect(setup(revoked, { system: true }).service.deleteCertificate(ID, 'u')).rejects.toMatchObject({
      statusCode: 403,
      code: 'SYSTEM_CERT',
    });
    await expect(setup(undefined).service.deleteCertificate(ID, 'u')).rejects.toMatchObject({
      statusCode: 404,
      code: 'CERT_NOT_FOUND',
    });
  });
});

describe('status of a deleted revoked certificate', () => {
  it('stays revoked while its serial is kept, and is unknown otherwise', async () => {
    const revokedAt = new Date(Date.now() - DAY);
    const statusWith = (kept: unknown[]) => {
      const db = {
        query: { certificates: { findFirst: async () => undefined } },
        select: () => ({ from: () => ({ where: () => ({ limit: async () => kept }) }) }),
      };
      return new OCSPService(db as never, {} as never, {} as never, {} as never).getCertificateStatus('ca-1', '0a1b');
    };
    await expect(statusWith([{ revokedAt, revocationReason: 'keyCompromise' }])).resolves.toEqual({
      status: 'revoked',
      revokedAt,
      revocationReason: 'keyCompromise',
    });
    await expect(statusWith([])).resolves.toEqual({ status: 'unknown' });
  });
});

// rc.3 stand O-7 / explore O-11: revoking a certificate a route serves stayed silent, and an SSL certificate linked
// from it kept status "active".
describe('revoking a PKI certificate in use', () => {
  function revokeSetup(linked: Array<{ id: string; name: string }>, routes: Array<{ id: string; domainNames: string[] }>) {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const db = {
      query: { certificates: { findFirst: async () => ({ ...base, status: 'active', notAfter: new Date(Date.now() + DAY) }) } },
      select: () => ({
        from: (table: unknown) => ({
          where: () =>
            Object.assign(Promise.resolve(table === sslCertificates ? linked : table === proxyHosts ? routes : []), {
              limit: async () => [{ isSystem: false }],
            }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            updates.push({ table, values });
          },
        }),
      }),
    };
    const caService = { publishCRL: vi.fn(async () => undefined) };
    const service = new CertService(db as never, {} as never, caService as never, { log: vi.fn(async () => true) } as never);
    return { service, updates, caService };
  }

  it('marks a linked SSL certificate as error with the reason and names what still serves it', async () => {
    const linked = [{ id: 'ssl-1', name: 'app-ssl' }];
    const routes = [{ id: 'route-1', domainNames: ['app.example.com'] }];
    const { service, updates, caService } = revokeSetup(linked, routes);

    await expect(service.revokeCertificate(ID, 'keyCompromise', 'user-1')).resolves.toBe('ca-1');
    expect(caService.publishCRL).toHaveBeenCalledWith('ca-1');
    const sslUpdate = updates.find((update) => update.table === sslCertificates);
    expect(sslUpdate?.values).toMatchObject({ status: 'error' });
    expect(String(sslUpdate?.values.renewalError)).toMatch(/app\.example\.com\) was revoked at .*CRL refuse it/);
    await expect(service.getCertificateUsage(ID)).resolves.toEqual({ routes, sslCertificates: linked });
  });
});
