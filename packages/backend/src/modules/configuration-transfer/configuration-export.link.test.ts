import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { ConfigurationExportService } from './configuration-export.service.js';

const takeOneTimeLink = vi.hoisted(() => vi.fn());
vi.mock('@/lib/one-time-link.js', () => ({ issueOneTimeLink: vi.fn(), takeOneTimeLink }));

const EXPORT_ID = 'export-1';
const USER_ID = 'user-1';

function serviceWithReadyExport() {
  const service = new ConfigurationExportService({} as never, {} as never, {} as never, {} as never, {} as never);
  const ticket = {
    id: EXPORT_ID,
    userId: USER_ID,
    state: 'ready',
    passphrase: 'a long passphrase',
    createdAt: new Date().toISOString(),
    filename: 'export.opfield',
    error: null,
    finishedAt: null,
  };
  (service as unknown as { tickets: Map<string, unknown> }).tickets.set(EXPORT_ID, ticket);
  return { service, ticket };
}

afterEach(() => {
  container.reset();
  takeOneTimeLink.mockReset();
});

describe('configuration export download link', () => {
  it.each([
    ['blocked', { isBlocked: true, scopes: ['admin:system'] }],
    ['deleted', { isDeleted: true, scopes: ['admin:system'] }],
    ['without admin:system any more', { scopes: ['admin:users'] }],
    ['gone', null],
  ])('refuses the download when the issuer is %s, and drops the passphrase', async (_label, issuer) => {
    takeOneTimeLink.mockResolvedValue({ exportId: EXPORT_ID, userId: USER_ID });
    container.registerInstance(AuthService, { getUserById: vi.fn().mockResolvedValue(issuer) } as never);
    const { service, ticket } = serviceWithReadyExport();

    await expect(service.openDownload('opfce_token')).rejects.toMatchObject({ statusCode: 403 });

    expect(ticket.passphrase).toBeNull();
    expect(ticket.state).toBe('failed');
  });

  it('still rejects an unknown or reused link before looking up the issuer', async () => {
    takeOneTimeLink.mockResolvedValue(null);
    const getUserById = vi.fn();
    container.registerInstance(AuthService, { getUserById } as never);
    const { service } = serviceWithReadyExport();

    await expect(service.openDownload('opfce_token')).rejects.toMatchObject({ statusCode: 404 });
    expect(getUserById).not.toHaveBeenCalled();
  });
});
