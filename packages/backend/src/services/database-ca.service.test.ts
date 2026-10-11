import { describe, expect, it, vi } from 'vitest';
import { DatabaseCAService, SET_MEMBER_LEAF_EXT_KEY_USAGE } from './database-ca.service.js';

/** A database whose availability set rows the select returns (`sets`), and the Database CA row. */
function harness(sets: Array<{ id: string }>) {
  const db = {
    select: vi.fn((columns: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          // The Database CA lookup selects the CA's PEM; the set lookup only an id.
          limit: vi
            .fn()
            .mockResolvedValue('certificatePem' in columns ? [{ id: 'db-ca', certificatePem: 'pem' }] : sets),
        })),
      })),
    })),
  };
  const lifecycle = {
    issueCurrent: vi.fn().mockResolvedValue({ certificate: { id: 'leaf' }, privateKeyPem: 'key' }),
    issuePending: vi.fn().mockResolvedValue({ certificate: { id: 'leaf' }, privateKeyPem: 'key' }),
  };
  const service = new DatabaseCAService(db as never, {} as never, {} as never);
  service.setSystemCertificateLifecycleService(lifecycle as never);
  return { service, lifecycle };
}

describe('managed database leaves', () => {
  it('issues and renews a set member leaf for server and client use (it is the replication client too)', async () => {
    const { service, lifecycle } = harness([{ id: 'set-1' }]);
    await service.issueManagedDatabaseCertificate('db-1', ['10.0.0.5']);
    await service.issuePendingManagedDatabaseCertificate('db-1', ['10.0.0.5']);
    expect(SET_MEMBER_LEAF_EXT_KEY_USAGE).toEqual(['serverAuth', 'clientAuth']);
    expect(lifecycle.issueCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tls-server', sans: ['10.0.0.5'] }),
      expect.any(String),
      { type: 'managed_database', id: 'db-1' },
      undefined,
      { extKeyUsage: SET_MEMBER_LEAF_EXT_KEY_USAGE }
    );
    expect(lifecycle.issuePending).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tls-server' }),
      expect.any(String),
      { type: 'managed_database', id: 'db-1' },
      undefined,
      { extKeyUsage: SET_MEMBER_LEAF_EXT_KEY_USAGE }
    );
  });

  it('keeps a single-node database leaf for server use only', async () => {
    const { service, lifecycle } = harness([]);
    await service.issueManagedDatabaseCertificate('db-2', ['10.0.0.6']);
    expect(lifecycle.issueCurrent.mock.calls[0]![4]).toEqual({});
  });
});
