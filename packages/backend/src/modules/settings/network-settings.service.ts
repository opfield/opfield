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
  /**
   * Never saved: the stored settings ask for reverse_proxy without trusted proxies, which trusted forwarded headers
   * from any peer and which earlier releases accepted. They are read as auto plus this marker: forwarded headers are
   * then believed from loopback and private-network peers only (resolveClientIp and its warning).
   */
  reverseProxyWithoutTrustedProxies?: true;
}

const SETTINGS_KEY = 'network:client_ip';
const logger = createChildLogger('NetworkSettings');

export const DEFAULT_NETWORK_SECURITY_SETTINGS: NetworkSecuritySettings = {
  clientIpSource: 'auto',
  trustedProxyCidrs: [],
  trustCloudflareHeaders: false,
};

export const REVERSE_PROXY_WITHOUT_PROXIES_WARNING =
  'Client IP source is set to Reverse proxy without trusted proxy CIDRs, so Opfield trusts forwarded headers only from loopback and private-network peers. Add the proxy ranges and choose Reverse proxy again.';

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
    if (config.reverseProxyWithoutTrustedProxies && !this.warnedReverseProxyWithoutProxies) {
      this.warnedReverseProxyWithoutProxies = true;
      logger.warn(REVERSE_PROXY_WITHOUT_PROXIES_WARNING);
    }
    this.cached = config;
    this.cachedAt = now;
    return config;
  }

  async updateConfig(updates: Partial<NetworkSecuritySettings>): Promise<NetworkSecuritySettings> {
    const current = await this.getConfig();
    // A current config read as auto carries its marker along; normalize drops it, so only a request that names
    // reverse_proxy (or keeps it while clearing the proxies) is refused below.
    const next = this.normalize({ ...current, ...updates });
    const invalidCidr = next.trustedProxyCidrs.find((cidr) => !isValidCidr(cidr));
    if (invalidCidr) {
      throw new Error(`Invalid trusted proxy CIDR: ${invalidCidr}`);
    }
    if (next.reverseProxyWithoutTrustedProxies) {
      throw new AppError(
        400,
        'TRUSTED_PROXY_REQUIRED',
        'Reverse proxy needs at least one trusted proxy CIDR: without one any client could choose its own address'
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

    if (clientIpSource === 'reverse_proxy' && trustedProxyCidrs.length === 0) {
      return {
        clientIpSource: 'auto',
        trustedProxyCidrs,
        trustCloudflareHeaders,
        reverseProxyWithoutTrustedProxies: true,
      };
    }
    return { clientIpSource, trustedProxyCidrs, trustCloudflareHeaders };
  }
}
