import { describe, expect, it, vi } from 'vitest';
import { ADMIN_RECOVERY_LINK_TTL_SECONDS, issueAdminRecoveryLink } from './admin-recovery-link.js';

interface Account {
  id: string;
  email: string;
  isBlocked: boolean;
  deletedAt: Date | null;
  oidcSubject: string | null;
}

/** The owner recorded by setup, the account the lookup finds, and whether it is an active system administrator. */
function fakeDb(found: Account | undefined, isAdmin: boolean, ownerUserId: string | null = 'owner-1') {
  let adminLookup = false;
  const chain = {
    from: () => chain,
    innerJoin: () => {
      adminLookup = true;
      return chain;
    },
    where: () => chain,
    limit: async () => {
      const lookup = adminLookup;
      adminLookup = false;
      if (!lookup) return ownerUserId ? [{ value: { ownerUserId } }] : [];
      return isAdmin && found ? [{ id: found.id }] : [];
    },
  };
  return { select: () => chain, query: { users: { findFirst: vi.fn(async () => found) } } } as never;
}

const owner: Account = {
  id: 'owner-1',
  email: 'owner@example.com',
  isBlocked: false,
  deletedAt: null,
  oidcSubject: null,
};
const other: Account = {
  id: 'admin-2',
  email: 'second@example.com',
  isBlocked: false,
  deletedAt: null,
  oidcSubject: 'precreated:x',
};

describe('admin recovery link', () => {
  it('signs the owner in once within 30 minutes, keeping only the hash of its secret', async () => {
    const set = vi.fn(async () => undefined);
    const link = await issueAdminRecoveryLink(fakeDb(owner, true), { set }, 'https://gw.example.com', {}, () =>
      Date.parse('2026-10-31T10:00:00Z')
    );
    expect(link).toMatchObject({ email: 'owner@example.com', expiresAt: '2026-10-31T10:30:00.000Z' });
    const url = new URL(link.url);
    expect(url.origin + url.pathname).toBe('https://gw.example.com/recovery-sign-in');
    const token = url.searchParams.get('token')!;
    expect(token).toMatch(/^[\w-]{24}\.[\w-]{32}$/);
    expect(set).toHaveBeenCalledWith(
      `local_auth:challenge:${token.split('.')[0]}`,
      expect.objectContaining({ userId: 'owner-1', purpose: 'admin_recovery', attempts: 0 }),
      ADMIN_RECOVERY_LINK_TTL_SECONDS
    );
    expect(ADMIN_RECOVERY_LINK_TTL_SECONDS).toBe(30 * 60);
    expect(JSON.stringify(set.mock.calls)).not.toContain(token.split('.')[1]);
  });

  it('picks another system administrator by email', async () => {
    const set = vi.fn(async () => undefined);
    const link = await issueAdminRecoveryLink(fakeDb(other, true), { set }, 'https://gw.example.com', {
      email: ' Second@Example.com ',
    });
    expect(link.email).toBe('second@example.com');
    expect(set).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ userId: 'admin-2' }), 1800);
  });

  it('issues nothing to an account that is not an active system administrator', async () => {
    const set = vi.fn();
    await expect(
      issueAdminRecoveryLink(fakeDb(other, false), { set }, 'https://gw.example.com', {
        email: 'second@example.com',
      })
    ).rejects.toThrow(/not a system administrator/);
    await expect(
      issueAdminRecoveryLink(fakeDb({ ...owner, isBlocked: true }, true), { set }, 'https://gw.example.com')
    ).rejects.toThrow(/blocked/);
    await expect(
      issueAdminRecoveryLink(fakeDb(undefined, false), { set }, 'https://gw.example.com', {
        email: 'nobody@example.com',
      })
    ).rejects.toThrow(/No account/);
    await expect(issueAdminRecoveryLink(fakeDb(owner, true, null), { set }, 'https://gw.example.com')).rejects.toThrow(
      /--email/
    );
    expect(set).not.toHaveBeenCalled();
  });
});
