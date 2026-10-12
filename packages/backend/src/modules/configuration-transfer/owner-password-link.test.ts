import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { issueOwnerPasswordLink, OWNER_PASSWORD_LINK_TTL_SECONDS } from './owner-password-link.js';
import { detachManagedSignIn, MANAGED_SIGN_IN_DETACH_SQL } from './transfer-docker.js';

function fakeDb(owner: { id: string; email: string; authMethod: string; isBlocked: boolean } | null) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [{ value: { ownerUserId: 'owner-1' } }],
  };
  return { select: () => chain, query: { users: { findFirst: vi.fn(async () => owner) } } } as never;
}

describe('the owner of a copy restored from a managed installation', () => {
  it('switches sign-in only when the restored database was a managed cloud installation', async () => {
    const managed = vi.fn(async (_id: string, command: string[]) => ({
      exitCode: 0,
      output: command.at(-1)!.startsWith('SELECT') ? 'true\n' : 'COMMIT',
    }));
    await expect(detachManagedSignIn({ execInContainer: managed } as never, { postgres: 'pg' } as never)).resolves.toBe(
      true
    );
    expect(managed.mock.calls[1]![1].at(-1)).toBe(MANAGED_SIGN_IN_DETACH_SQL);

    const selfHosted = vi.fn(async () => ({ exitCode: 0, output: 'false\n' }));
    await expect(
      detachManagedSignIn({ execInContainer: selfHosted } as never, { postgres: 'pg' } as never)
    ).resolves.toBe(false);
    expect(selfHosted).toHaveBeenCalledOnce();
  });

  it('gets a one-time password link valid for a day', async () => {
    const set = vi.fn(async () => undefined);
    const link = await issueOwnerPasswordLink(
      fakeDb({ id: 'owner-1', email: 'owner@example.com', authMethod: 'password', isBlocked: false }),
      { set },
      'https://gw.example.com',
      () => Date.parse('2026-10-12T10:00:00Z')
    );
    expect(link).toMatchObject({ email: 'owner@example.com', expiresAt: '2026-10-13T10:00:00.000Z' });
    const token = new URL(link.url).searchParams.get('token')!;
    expect(token).toMatch(/^[\w-]{24}\.[\w-]{32}$/);
    expect(set).toHaveBeenCalledWith(
      `local_auth:challenge:${token.split('.')[0]}`,
      expect.objectContaining({ userId: 'owner-1', purpose: 'password_setup', attempts: 0 }),
      OWNER_PASSWORD_LINK_TTL_SECONDS
    );
    expect(JSON.stringify(set.mock.calls)).not.toContain(token.split('.')[1]);
  });

  it('issues no link to an owner who signs in another way', async () => {
    const set = vi.fn();
    await expect(
      issueOwnerPasswordLink(
        fakeDb({ id: 'owner-1', email: 'owner@example.com', authMethod: 'oidc', isBlocked: false }),
        { set },
        'https://gw.example.com'
      )
    ).rejects.toThrow('does not sign in with a password');
    expect(set).not.toHaveBeenCalled();
  });
});
