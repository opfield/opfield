import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import { isValidCidr } from '@/lib/ip-cidr.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';

export const CLIENT_IP_SOURCE_VALUES = ['auto', 'direct', 'reverse_proxy', 'cloudflare'] as const;
export type ClientIpSource = (typeof CLIENT_IP_SOURCE_VALUES)[number];

export interface NetworkSecuritySettings {
  clientIpSource: ClientIpSource;
  trustedProxyCidrs: string[];
  trustCloudflareHeaders: boolean;
}

/**
 * Reverse proxy without trusted proxy CIDRs: forwarded headers are believed from any peer. Releases before 2.13.0
 * saved it, and a stored value keeps that meaning; only a new save of it is refused (NetworkSettingsService).
 */
export function isReverseProxyWithoutTrustedProxies(
  config: Pick<NetworkSecuritySettings, 'clientIpSource' | 'trustedProxyCidrs'>
) {
  return config.clientIpSource === 'reverse_proxy' && config.trustedProxyCidrs.length === 0;
}

const SETTINGS_KEY = 'network:client_ip';
const logger = createChildLogger('NetworkSettings');

export const DEFAULT_NETWORK_SECURITY_SETTINGS: NetworkSecuritySettings = {
  clientIpSource: 'auto',
  trustedProxyCidrs: [],
  trustCloudflareHeaders: false,
};

export const REVERSE_PROXY_WITHOUT_PROXIES_WARNING =
  'Reverse proxy has no trusted proxy CIDRs, so Opfield believes forwarded headers from any peer: a client that reaches Opfield without the proxy can choose its own address. Add the ranges your proxy connects from to Trusted proxy CIDRs.';

export class NetworkSettingsService {
  private cached: NetworkSecuritySettings | null = null;
  private cachedAt = 0;
  private warnedReverseProxyWithoutProxies = false;

  constructor(private readonly db: DrizzleClient) {}

  async getConfig(): Promise<NetworkSecuritySettings> {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < 5000) {
      return this.cached;
    }

    const [row] = await this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
    const config = this.normalize(row?.value);
    if (isReverseProxyWithoutTrustedProxies(config) && !this.warnedReverseProxyWithoutProxies) {
      this.warnedReverseProxyWithoutProxies = true;
      logger.warn(REVERSE_PROXY_WITHOUT_PROXIES_WARNING);
    }
    this.cached = config;
    this.cachedAt = now;
    return config;
  }

  async updateConfig(updates: Partial<NetworkSecuritySettings>): Promise<NetworkSecuritySettings> {
    const current = await this.getConfig();
    const next = this.normalize({ ...current, ...updates });
    const invalidCidr = next.trustedProxyCidrs.find((cidr) => !isValidCidr(cidr));
    if (invalidCidr) {
      throw new Error(`Invalid trusted proxy CIDR: ${invalidCidr}`);
    }
    // Only a new save of reverse proxy without trusted proxies is refused. A stored one (accepted by earlier releases)
    // stays valid, so saving it again unchanged, or changing only the Cloudflare option, keeps working.
    if (isReverseProxyWithoutTrustedProxies(next) && !isReverseProxyWithoutTrustedProxies(current)) {
      throw new AppError(
        400,
        'TRUSTED_PROXY_REQUIRED',
        'Reverse proxy needs at least one trusted proxy CIDR: enter the ranges your proxy connects from (without one, any client could choose its own address)'
      );
    }
    await this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value: next, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: next, updatedAt: new Date() },
      });
    this.cached = next;
    this.cachedAt = Date.now();
    return next;
  }

  private normalize(value: unknown): NetworkSecuritySettings {
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    const clientIpSource = CLIENT_IP_SOURCE_VALUES.includes(record.clientIpSource as ClientIpSource)
      ? (record.clientIpSource as ClientIpSource)
      : DEFAULT_NETWORK_SECURITY_SETTINGS.clientIpSource;
    const trustedProxyCidrs = Array.isArray(record.trustedProxyCidrs)
      ? record.trustedProxyCidrs
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
      : DEFAULT_NETWORK_SECURITY_SETTINGS.trustedProxyCidrs;
    const trustCloudflareHeaders =
      typeof record.trustCloudflareHeaders === 'boolean' ? record.trustCloudflareHeaders : false;

    return { clientIpSource, trustedProxyCidrs, trustCloudflareHeaders };
  }
}
