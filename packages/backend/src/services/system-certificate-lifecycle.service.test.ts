import { describe, expect, it, vi } from 'vitest';
import { SystemCertificateLifecycleService } from './system-certificate-lifecycle.service.js';

describe('SystemCertificateLifecycleService staged (pending) leaves', () => {
  const input = {
    caId: 'system-ca',
    type: 'tls-client' as const,
    commonName: 'node-1',
    sans: ['node-1'],
    keyAlgorithm: 'ecdsa-p256' as const,
    validityDays: 365,
  };

  function makeDb(options: { reusable?: any[]; txSelects?: any[][] }) {
    const sets: any[] = [];
    const txSelects = [...(options.txSelects ?? [])];
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const rows = txSelects.shift() ?? [];
            return Object.assign(Promise.resolve(rows), { limit: vi.fn().mockResolvedValue(rows) });
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((value: unknown) => {
          sets.push(value);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([{ isSystem: true }]),
            orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(options.reusable ?? []) })),
          })),
        })),
      })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    return { db, tx, sets };
  }

  it('stages a new leaf as pending without retiring the current one', async () => {
    const { db, sets } = makeDb({ txSelects: [[]] });
    const certService = {
      issueCertificate: vi.fn().mockResolvedValue({
        certificate: { id: 'new-cert', serialNumber: 'bb02', notAfter: new Date(), certificatePem: 'pem' },
        privateKeyPem: 'key',
      }),
    };
    const bind = vi.fn(async () => undefined);
    const service = new SystemCertificateLifecycleService(db as any, certService as any, {} as any);

    const issued = await service.issuePending(input, 'system-user', { type: 'node', id: 'node-1' }, bind);

    expect(issued.certificate.id).toBe('new-cert');
    expect(bind).toHaveBeenCalledOnce();
    expect(sets).toContainEqual(expect.objectContaining({ systemLifecycleState: 'pending' }));
    expect(sets).not.toContainEqual(expect.objectContaining({ status: 'revoked' }));
  });

  it('returns the same staged leaf again instead of issuing another one', async () => {
    const pending = {
      id: 'pending-cert',
      serialNumber: 'bb02',
      certificatePem: 'pem',
      notAfter: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000),
      status: 'active',
    };
    const { db } = makeDb({ reusable: [pending] });
    const certService = {
      issueCertificate: vi.fn(),
      getCertificatePrivateKey: vi.fn().mockResolvedValue('same-key'),
    };
    const bind = vi.fn(async () => undefined);
    const service = new SystemCertificateLifecycleService(db as any, certService as any, {} as any);

    const issued = await service.issuePending(input, 'system-user', { type: 'node', id: 'node-1' }, bind);

    expect(certService.issueCertificate).not.toHaveBeenCalled();
    expect(issued.certificate.id).toBe('pending-cert');
    expect(issued.privateKeyPem).toBe('same-key');
    expect(bind).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ serialNumber: 'bb02' }));
  });

  it('issues a leaf with the usages its owner needs and replaces a staged leaf that lacks them', async () => {
    const pending = {
      id: 'pending-cert',
      serialNumber: 'bb02',
      certificatePem: 'pem',
      notAfter: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000),
      status: 'active',
      extKeyUsage: ['serverAuth'],
    };
    const { db } = makeDb({ reusable: [pending], txSelects: [[]] });
    const certService = {
      issueCertificate: vi.fn().mockResolvedValue({
        certificate: { id: 'new-cert', serialNumber: 'bb03', notAfter: new Date(), certificatePem: 'pem' },
        privateKeyPem: 'key',
      }),
      getCertificatePrivateKey: vi.fn().mockResolvedValue('same-key'),
    };
    const service = new SystemCertificateLifecycleService(db as any, certService as any, {} as any);
    const usages = ['serverAuth', 'clientAuth'];

    const issued = await service.issuePending(
      input,
      'system-user',
      { type: 'managed_database', id: 'db-1' },
      undefined,
      {
        extKeyUsage: usages,
      }
    );

    expect(issued.certificate.id).toBe('new-cert');
    expect(certService.issueCertificate).toHaveBeenCalledWith(
      input,
      'system-user',
      expect.objectContaining({ extKeyUsage: usages })
    );
  });

  it('promotes the staged leaf and supersedes the previous current leaf in the same transaction', async () => {
    const pending = {
      id: 'pending-cert',
      caId: 'system-ca',
      serialNumber: 'bb02',
      notAfter: new Date(),
      certificatePem: 'pem',
    };
    const { db, sets } = makeDb({ txSelects: [[pending], [{ id: 'current-cert', caId: 'system-ca' }]] });
    const generateCRL = vi.fn().mockResolvedValue(undefined);
    const bind = vi.fn(async () => undefined);
    const service = new SystemCertificateLifecycleService(db as any, {} as any, { generateCRL } as any);

    await expect(service.promotePending({ type: 'node', id: 'node-1' }, 'bb02', bind)).resolves.toBe(true);

    expect(sets).toContainEqual(expect.objectContaining({ status: 'revoked', systemLifecycleState: 'superseded' }));
    expect(sets).toContainEqual(expect.objectContaining({ systemLifecycleState: 'current' }));
    expect(bind).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'pending-cert' }));
    expect(generateCRL).toHaveBeenCalledWith('system-ca', { allowSystem: true });
  });

  it('does not touch certificates when no staged leaf matches the serial', async () => {
    const { db, sets } = makeDb({ txSelects: [[]] });
    const bind = vi.fn(async () => undefined);
    const service = new SystemCertificateLifecycleService(db as any, {} as any, { generateCRL: vi.fn() } as any);

    await expect(service.promotePending({ type: 'node', id: 'node-1' }, 'bb02', bind)).resolves.toBe(false);

    expect(sets).toEqual([]);
    expect(bind).toHaveBeenCalledWith(expect.anything(), null);
  });
});
