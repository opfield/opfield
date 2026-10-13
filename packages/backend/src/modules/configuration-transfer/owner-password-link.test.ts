import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RESTORED_MARKER_FILE } from './configuration-restore.js';
import {
  claimRestoredOwnerLink,
  issueOwnerPasswordLink,
  keepRestoredOwnerLink,
  OWNER_PASSWORD_LINK_TTL_SECONDS,
  ownerLinkClaimHash,
} from './owner-password-link.js';
import { completeConfigurationRestore } from './restore-startup.js';
import { detachManagedSignIn, MANAGED_SIGN_IN_DETACH_SQL, MANAGED_SOURCE_LICENSE_SETTINGS } from './transfer-docker.js';
import { RESTORE_STAGING_DIR } from './transfer-layout.js';

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
    await expect(
      detachManagedSignIn(
        { execInContainer: managed } as never,
        { postgres: 'pg', database: { role: 'opfield', name: 'opfield' } } as never
      )
    ).resolves.toBe(true);
    expect(managed.mock.calls[1]![1].at(-1)).toBe(MANAGED_SIGN_IN_DETACH_SQL);
    // The cloud installation's license does not come along; a self-hosted source keeps it (nothing runs).
    for (const key of MANAGED_SOURCE_LICENSE_SETTINGS) expect(MANAGED_SIGN_IN_DETACH_SQL).toContain(`'${key}'`);
    expect(MANAGED_SIGN_IN_DETACH_SQL).not.toContain('license:onboarding_completed');

    const selfHosted = vi.fn(async () => ({ exitCode: 0, output: 'false\n' }));
    await expect(
      detachManagedSignIn(
        { execInContainer: selfHosted } as never,
        { postgres: 'pg', database: { role: 'opfield', name: 'opfield' } } as never
      )
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

describe('the owner password link in the setup wizard', () => {
  function memoryCache() {
    const values = new Map<string, unknown>();
    return {
      values,
      set: vi.fn(async (key: string, value: unknown) => void values.set(key, value)),
      get: vi.fn(async (key: string) => (values.get(key) ?? null) as never),
      delete: vi.fn(async (key: string) => void values.delete(key)),
    };
  }
  const link = { email: 'owner@example.com', url: 'https://gw.example.com/reset-password?token=a.b', expiresAt: 'x' };

  it('gives the link once, and only to the browser holding the claim', async () => {
    const cache = memoryCache();
    const claim = 'c'.repeat(43);
    await keepRestoredOwnerLink(cache, ownerLinkClaimHash(claim), link);
    expect(JSON.stringify([...cache.values])).not.toContain(claim);
    await expect(claimRestoredOwnerLink(cache, 'd'.repeat(43))).resolves.toBeNull();
    await expect(claimRestoredOwnerLink(cache, claim)).resolves.toEqual(link);
    await expect(claimRestoredOwnerLink(cache, claim)).resolves.toBeNull();
  });

  it('is issued on the first start after a wizard restore of a managed source', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'restore-owner-'));
    try {
      mkdirSync(join(dataDir, RESTORE_STAGING_DIR), { recursive: true });
      const marker = { address: {}, ownerSignIn: 'password-link', ownerLinkClaimHash: 'f'.repeat(64) };
      writeFileSync(join(dataDir, RESTORE_STAGING_DIR, RESTORED_MARKER_FILE), JSON.stringify(marker));
      const issue = vi.fn(async () => undefined);
      await completeConfigurationRestore({ updateConfig: vi.fn() }, { log: vi.fn(async () => true) }, dataDir, issue);
      expect(issue).toHaveBeenCalledWith('f'.repeat(64));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
