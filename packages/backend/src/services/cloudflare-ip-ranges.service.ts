import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { domains, proxyHosts, settings } from '@/db/schema/index.js';
import {
  type CloudflareCidrs,
  currentCloudflareCidrs,
  setCurrentCloudflareCidrs,
  validateCloudflareCidrs,
} from '@/lib/cloudflare-ip-ranges.js';
import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('CloudflareIpRanges');

const SETTINGS_KEY = 'network:cloudflare_ip_ranges';
const API_URL = 'https://api.cloudflare.com/client/v4/ips';
const TEXT_URLS = { ipv4: 'https://www.cloudflare.com/ips-v4', ipv6: 'https://www.cloudflare.com/ips-v6' };
const FETCH_TIMEOUT_MS = 15_000;
export const CLOUDFLARE_IP_RANGES_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Without a successful check this long, while something trusts the ranges, the refresh job fails (job alert). */
export const CLOUDFLARE_IP_RANGES_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

interface StoredRanges extends CloudflareCidrs {
  /** Last successful check against Cloudflare. */
  checkedAt: string | null;
  /** When the list last differed from the one before. */
  changedAt: string | null;
  /** First refresh attempt; the stale clock of an install that never reached Cloudflare starts here. */
  firstAttemptAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export type CloudflareRangeFetcher = (signal: AbortSignal) => Promise<{ ipv4: unknown; ipv6: unknown }>;

/** Cloudflare's published edge ranges: the JSON API, else the two plain-text lists. */
export const fetchCloudflareRanges: CloudflareRangeFetcher = async (signal) => {
  try {
    const response = await fetch(API_URL, { signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { success?: boolean; result?: Record<string, unknown> };
    if (body.success !== true || !body.result) throw new Error('unsuccessful response');
    return { ipv4: body.result.ipv4_cidrs, ipv6: body.result.ipv6_cidrs };
  } catch (apiError) {
    const text = async (url: string) => {
      const response = await fetch(url, { signal, headers: { accept: 'text/plain' } });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return (await response.text()).split(/\s+/).filter(Boolean);
    };
    try {
      return { ipv4: await text(TEXT_URLS.ipv4), ipv6: await text(TEXT_URLS.ipv6) };
    } catch (textError) {
      const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
      throw new Error(`${API_URL}: ${reason(apiError)}; ${reason(textError)}`);
    }
  }
};

function sameRanges(left: CloudflareCidrs, right: CloudflareCidrs): boolean {
  const key = (ranges: CloudflareCidrs) => JSON.stringify([[...ranges.ipv4].sort(), [...ranges.ipv6].sort()]);
  return key(left) === key(right);
}

/**
 * Keeps the Cloudflare edge ranges current with no expiry: the routes behind Cloudflare trust exactly these peers
 * for CF-Connecting-IP. The baked list (lib/cloudflare-ip-ranges.ts) holds until the first successful fetch; a failed
 * fetch keeps the last good list, and the refresh job fails only once that list is stale while something uses it.
 */
export class CloudflareIpRangesService {
  private readonly listeners: Array<() => Promise<void>> = [];

  constructor(
    private readonly db: DrizzleClient,
    private readonly fetchRanges: CloudflareRangeFetcher = fetchCloudflareRanges,
    private readonly now: () => number = Date.now
  ) {}

  /** Runs after a refresh changed the ranges in effect. */
  onChanged(listener: () => Promise<void>): void {
    this.listeners.push(listener);
  }

  /** Puts the stored list in effect (before routes are rendered at start). */
  async load(): Promise<void> {
    const stored = await this.read();
    if (stored) setCurrentCloudflareCidrs(stored);
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    const stored = await this.read();
    const now = new Date(this.now()).toISOString();
    const firstAttemptAt = stored?.firstAttemptAt ?? now;
    let fetched: CloudflareCidrs;
    try {
      const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const raw = await this.fetchRanges(signal ? AbortSignal.any([signal, timeout]) : timeout);
      const ipv4 = validateCloudflareCidrs(raw.ipv4, 4);
      const ipv6 = validateCloudflareCidrs(raw.ipv6, 6);
      if (!ipv4.ok) throw new Error(ipv4.error);
      if (!ipv6.ok) throw new Error(ipv6.error);
      fetched = { ipv4: ipv4.cidrs, ipv6: ipv6.cidrs };
    } catch (error) {
      if (signal?.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      await this.write({
        ...(stored ?? currentCloudflareCidrs()),
        checkedAt: stored?.checkedAt ?? null,
        changedAt: stored?.changedAt ?? null,
        firstAttemptAt,
        lastError: message.slice(0, 500),
        lastErrorAt: now,
      });
      const since = Date.parse(stored?.checkedAt ?? firstAttemptAt);
      const staleMs = this.now() - since;
      if (staleMs > CLOUDFLARE_IP_RANGES_STALE_AFTER_MS && (await this.rangesInUse())) {
        const days = Math.floor(staleMs / (24 * 60 * 60 * 1000));
        throw new Error(
          `Cloudflare IP ranges were not refreshed for ${days} days; routes behind Cloudflare keep the last good list. Last error: ${message}`
        );
      }
      logger.warn('Cloudflare IP ranges could not be refreshed; the last good list stays in effect', {
        error: message,
      });
      return;
    }

    const changed = !sameRanges(fetched, currentCloudflareCidrs());
    await this.write({
      ...fetched,
      checkedAt: now,
      changedAt: changed || !stored ? now : stored.changedAt,
      firstAttemptAt,
      lastError: null,
      lastErrorAt: null,
    });
    if (!changed) return;
    setCurrentCloudflareCidrs(fetched);
    logger.info('Cloudflare IP ranges changed', { ipv4: fetched.ipv4.length, ipv6: fetched.ipv6.length });
    for (const listener of this.listeners) {
      await listener().catch((error) => logger.error('Applying changed Cloudflare IP ranges failed', { error }));
    }
  }

  /** Whether a route trusts Cloudflare's ranges explicitly or may through a Cloudflare-proxied domain. */
  private async rangesInUse(): Promise<boolean> {
    const [route] = await this.db
      .select({ id: proxyHosts.id })
      .from(proxyHosts)
      .where(and(eq(proxyHosts.enabled, true), eq(proxyHosts.clientIpSource, 'cloudflare')))
      .limit(1);
    if (route) return true;
    const [domain] = await this.db
      .select({ id: domains.id })
      .from(domains)
      .where(and(eq(domains.dnsProvider, 'cloudflare'), eq(domains.dnsProxied, true)))
      .limit(1);
    return Boolean(domain);
  }

  private async read(): Promise<StoredRanges | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
    const value = row?.value as Partial<StoredRanges> | undefined;
    if (!value) return null;
    const ipv4 = validateCloudflareCidrs(value.ipv4, 4);
    const ipv6 = validateCloudflareCidrs(value.ipv6, 6);
    if (!ipv4.ok || !ipv6.ok) return null;
    const text = (field: unknown) => (typeof field === 'string' ? field : null);
    return {
      ipv4: ipv4.cidrs,
      ipv6: ipv6.cidrs,
      checkedAt: text(value.checkedAt),
      changedAt: text(value.changedAt),
      firstAttemptAt: text(value.firstAttemptAt),
      lastError: text(value.lastError),
      lastErrorAt: text(value.lastErrorAt),
    };
  }

  private async write(value: StoredRanges): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
}
