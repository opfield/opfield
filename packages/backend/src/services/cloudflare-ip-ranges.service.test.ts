import { afterEach, describe, expect, it, vi } from 'vitest';
import { domains, proxyHosts, settings } from '@/db/schema/index.js';
import {
  BAKED_CLOUDFLARE_IPV4_CIDRS,
  BAKED_CLOUDFLARE_IPV6_CIDRS,
  currentCloudflareCidrs,
  setCurrentCloudflareCidrs,
} from '@/lib/cloudflare-ip-ranges.js';
import { CLOUDFLARE_IP_RANGES_STALE_AFTER_MS, CloudflareIpRangesService } from './cloudflare-ip-ranges.service.js';

const DAY = 24 * 60 * 60 * 1000;
const baked = { ipv4: [...BAKED_CLOUDFLARE_IPV4_CIDRS], ipv6: [...BAKED_CLOUDFLARE_IPV6_CIDRS] };

/** Just enough of drizzle for the service: the settings row, and whether a route or domain uses the ranges. */
function fakeDb(state: { stored?: unknown; cloudflareRoute?: boolean; proxiedDomain?: boolean }) {
  const rows = (table: unknown) => {
    if (table === settings) return state.stored ? [{ key: 'network:cloudflare_ip_ranges', value: state.stored }] : [];
    if (table === proxyHosts) return state.cloudflareRoute ? [{ id: 'route' }] : [];
    if (table === domains) return state.proxiedDomain ? [{ id: 'domain' }] : [];
    return [];
  };
  return {
    select: () => ({
      from: (table: unknown) => ({ where: () => ({ limit: async () => rows(table) }) }),
    }),
    insert: () => ({
      values: (row: { value: unknown }) => ({
        onConflictDoUpdate: async () => {
          state.stored = row.value;
        },
      }),
    }),
  };
}

afterEach(() => setCurrentCloudflareCidrs(baked));

describe('CloudflareIpRangesService', () => {
  it('applies a changed list once and keeps it across a restart', async () => {
    const state: { stored?: unknown } = {};
    const next = { ipv4: [...baked.ipv4, '198.51.100.0/24'], ipv6: baked.ipv6 };
    const listener = vi.fn(async () => undefined);
    const service = new CloudflareIpRangesService(fakeDb(state) as never, async () => next);
    service.onChanged(listener);

    await service.refresh();
    expect(currentCloudflareCidrs().ipv4).toContain('198.51.100.0/24');
    expect(listener).toHaveBeenCalledTimes(1);
    await service.refresh();
    expect(listener).toHaveBeenCalledTimes(1);

    setCurrentCloudflareCidrs(baked);
    await new CloudflareIpRangesService(fakeDb(state) as never).load();
    expect(currentCloudflareCidrs().ipv4).toContain('198.51.100.0/24');
  });

  it('keeps the last good list when Cloudflare answers with a list too wide to trust', async () => {
    const state: { stored?: unknown } = {};
    const service = new CloudflareIpRangesService(fakeDb(state) as never, async () => ({
      ipv4: ['0.0.0.0/0', ...baked.ipv4],
      ipv6: baked.ipv6,
    }));
    await service.refresh();
    expect(currentCloudflareCidrs()).toEqual(baked);
    expect((state.stored as { lastError: string }).lastError).toContain('too wide');
  });

  it('fails only once the list is stale while a route uses it', async () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const state: { stored?: unknown; cloudflareRoute?: boolean } = { cloudflareRoute: false };
    const failing = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.cloudflare.com');
    };
    const service = new CloudflareIpRangesService(fakeDb(state) as never, failing, () => now);

    await expect(service.refresh()).resolves.toBeUndefined();
    now += CLOUDFLARE_IP_RANGES_STALE_AFTER_MS + DAY;
    // Stale, but nothing trusts the ranges: no alert.
    await expect(service.refresh()).resolves.toBeUndefined();
    state.cloudflareRoute = true;
    await expect(service.refresh()).rejects.toThrow('Cloudflare IP ranges were not refreshed for 15 days');
    expect(currentCloudflareCidrs()).toEqual(baked);
  });

  it('measures staleness from the last successful check', async () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    let fail = false;
    const state: { stored?: unknown; proxiedDomain?: boolean } = { proxiedDomain: true };
    const service = new CloudflareIpRangesService(
      fakeDb(state) as never,
      async () => {
        if (fail) throw new Error('timeout');
        return baked;
      },
      () => now
    );
    await service.refresh();
    fail = true;
    now += CLOUDFLARE_IP_RANGES_STALE_AFTER_MS - DAY;
    await expect(service.refresh()).resolves.toBeUndefined();
    now += 2 * DAY;
    await expect(service.refresh()).rejects.toThrow('timeout');
  });
});
