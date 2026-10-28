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

  it('reads a stored reverse proxy without trusted proxies as auto, with a warning, and saves over it', async () => {
    const { db, writes } = settingsDb({
      clientIpSource: 'reverse_proxy',
      trustedProxyCidrs: [],
      trustCloudflareHeaders: false,
    });
    const service = new NetworkSettingsService(db);
    const config = await service.getConfig();
    expect(config).toMatchObject({ clientIpSource: 'auto', reverseProxyWithoutTrustedProxies: true });

    // Forwarded headers are no longer believed from any peer, and the settings page says why.
    const resolution = resolveClientIp(new Headers({ 'x-forwarded-for': '203.0.113.9' }), '198.51.100.20', config);
    expect(resolution).toMatchObject({ ipAddress: '198.51.100.20', warning: REVERSE_PROXY_WITHOUT_PROXIES_WARNING });

    // Saving anything else stores plain auto; the marker is never written.
    await service.updateConfig({ trustCloudflareHeaders: true });
    expect(writes).toEqual([{ clientIpSource: 'auto', trustedProxyCidrs: [], trustCloudflareHeaders: true }]);
  });
});
