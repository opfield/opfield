import { describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { resolveClientIp } from '@/lib/request-ip.js';
import { NetworkSettingsService, REVERSE_PROXY_WITHOUT_PROXIES_WARNING } from './network-settings.service.js';

/** A settings table holding one stored value; writes are recorded. */
function settingsDb(stored: unknown) {
  const writes: unknown[] = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (stored ? [{ value: stored }] : []) }) }) }),
    insert: () => ({
      values: (row: { value: unknown }) => ({
        onConflictDoUpdate: async () => {
          writes.push(row.value);
        },
      }),
    }),
  };
  return { db: db as unknown as DrizzleClient, writes };
}

describe('client IP trust settings', () => {
  it('refuses reverse proxy without trusted proxies, which would let any client choose its address', async () => {
    const { db, writes } = settingsDb(null);
    const service = new NetworkSettingsService(db);
    await expect(
      service.updateConfig({ clientIpSource: 'reverse_proxy', trustedProxyCidrs: [] })
    ).rejects.toMatchObject({ statusCode: 400, code: 'TRUSTED_PROXY_REQUIRED' });
    await expect(service.updateConfig({ clientIpSource: 'reverse_proxy' })).rejects.toMatchObject({
      code: 'TRUSTED_PROXY_REQUIRED',
    });
    expect(writes).toEqual([]);
    await expect(
      service.updateConfig({ clientIpSource: 'reverse_proxy', trustedProxyCidrs: ['10.0.0.0/8'] })
    ).resolves.toEqual({
      clientIpSource: 'reverse_proxy',
      trustedProxyCidrs: ['10.0.0.0/8'],
      trustCloudflareHeaders: false,
    });
    // Clearing the proxies of a reverse proxy config is the same combination.
    await expect(service.updateConfig({ trustedProxyCidrs: [] })).rejects.toMatchObject({
      code: 'TRUSTED_PROXY_REQUIRED',
    });
    expect(writes).toHaveLength(1);
  });

  it('keeps a stored reverse proxy without trusted proxies: same meaning, a warning, and re-saves pass', async () => {
    const stored = { clientIpSource: 'reverse_proxy', trustedProxyCidrs: [], trustCloudflareHeaders: false };
    const { db, writes } = settingsDb(stored);
    const service = new NetworkSettingsService(db);
    const config = await service.getConfig();
    expect(config).toEqual(stored);

    // Forwarded headers are believed as in 2.12.8; the settings page recommends adding the proxy's ranges.
    const forwarded = new Headers({ 'x-forwarded-for': '203.0.113.9' });
    expect(resolveClientIp(forwarded, '198.51.100.20', config)).toMatchObject({
      ipAddress: '203.0.113.9',
      warning: REVERSE_PROXY_WITHOUT_PROXIES_WARNING,
    });

    // A script that PUTs the unchanged stored value, or a change of another field, is not refused.
    await expect(service.updateConfig({ ...stored } as never)).resolves.toEqual(stored);
    await expect(service.updateConfig({ trustCloudflareHeaders: true })).resolves.toEqual({
      ...stored,
      trustCloudflareHeaders: true,
    });
    expect(writes).toHaveLength(2);
  });
});
