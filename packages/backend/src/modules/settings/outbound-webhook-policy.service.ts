import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { eq } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import { ipInAnyCidr, isAlwaysBlockedOutboundIp, isPrivateIp, isValidCidr, normalizeIp } from '@/lib/ip-cidr.js';

export interface OutboundWebhookPolicy {
  allowPrivateNetworks: boolean;
  allowedPrivateCidrs: string[];
}

export interface OutboundTargetCheckOptions {
  /**
   * When set, a Gateway self address is refused only on these ports. Health checks use it so an
   * upstream on the Gateway host's own LAN address stays reachable while the Gateway's own
   * services on that address do not. Webhooks leave it unset and refuse every self address.
   */
  selfAddressBlockedPorts?: ReadonlySet<number>;
}

export interface OutboundWebhookTargetCheck {
  url: string;
  resolvedAddresses: string[];
  allowed: boolean;
  reason?: string;
}

const SETTINGS_KEY = 'network:outbound_webhooks';
const DEFAULT_ALLOWED_PRIVATE_CIDRS = ['10.0.0.0/8', '172.16.0.0/12'];

export const DEFAULT_OUTBOUND_WEBHOOK_POLICY: OutboundWebhookPolicy = {
  allowPrivateNetworks: true,
  allowedPrivateCidrs: DEFAULT_ALLOWED_PRIVATE_CIDRS,
};

export class OutboundWebhookPolicyService {
  private cached: OutboundWebhookPolicy | null = null;
  private cachedAt = 0;

  constructor(private readonly db: DrizzleClient) {}

  async getConfig(): Promise<OutboundWebhookPolicy> {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < 5000) return this.cached;

    let row: { value: unknown } | undefined;
    try {
      [row] = await this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
    } catch (error) {
      // While Postgres is down, alerts about that outage still go out under the last policy read.
      if (this.cached) return this.cached;
      throw error;
    }
    const config = this.normalize(row?.value);
    this.cached = config;
    this.cachedAt = now;
    return config;
  }

  async updateConfig(updates: Partial<OutboundWebhookPolicy>): Promise<OutboundWebhookPolicy> {
    const current = await this.getConfig();
    const next = this.normalize({ ...current, ...updates });
    const invalidCidr = next.allowedPrivateCidrs.find((cidr) => !isValidCidr(cidr));
    if (invalidCidr) throw new Error(`Invalid private webhook CIDR: ${invalidCidr}`);

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

  private normalize(value: unknown): OutboundWebhookPolicy {
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    const allowedPrivateCidrs = Array.isArray(record.allowedPrivateCidrs)
      ? record.allowedPrivateCidrs
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
      : DEFAULT_OUTBOUND_WEBHOOK_POLICY.allowedPrivateCidrs;

    return {
      allowPrivateNetworks:
        typeof record.allowPrivateNetworks === 'boolean'
          ? record.allowPrivateNetworks
          : DEFAULT_OUTBOUND_WEBHOOK_POLICY.allowPrivateNetworks,
      allowedPrivateCidrs,
    };
  }
}

export async function checkOutboundWebhookTarget(
  rawUrl: string,
  policy: OutboundWebhookPolicy,
  env: Env,
  publicUrl?: string | null,
  options: OutboundTargetCheckOptions = {}
): Promise<OutboundWebhookTargetCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { url: rawUrl, resolvedAddresses: [], allowed: false, reason: 'Webhook URL is invalid' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      url: rawUrl,
      resolvedAddresses: [],
      allowed: false,
      reason: 'Webhook URL protocol is not allowed',
    };
  }

  const hostname = stripHostnameBrackets(url.hostname.toLowerCase());

  let resolvedAddresses: string[];
  try {
    resolvedAddresses = await resolveTargetAddresses(hostname);
  } catch {
    return {
      url: rawUrl,
      resolvedAddresses: [],
      allowed: false,
      reason: 'Webhook target did not resolve to an IP address',
    };
  }
  if (resolvedAddresses.length === 0) {
    return {
      url: rawUrl,
      resolvedAddresses: [],
      allowed: false,
      reason: 'Webhook target did not resolve to an IP address',
    };
  }

  const selfAddresses = await getSelfAddresses(env, publicUrl);
  const targetPort = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const selfPortBlocked = !options.selfAddressBlockedPorts || options.selfAddressBlockedPorts.has(targetPort);
  for (const ip of resolvedAddresses) {
    if (isAlwaysBlockedOutboundIp(ip)) {
      return {
        url: rawUrl,
        resolvedAddresses,
        allowed: false,
        reason: `Webhook target address ${ip} is not allowed`,
      };
    }
    if (selfAddresses.has(ip) && selfPortBlocked) {
      return {
        url: rawUrl,
        resolvedAddresses,
        allowed: false,
        reason: options.selfAddressBlockedPorts
          ? `Target ${ip}:${targetPort} is an Opfield service port`
          : `Webhook target resolves to Opfield address ${ip}`,
      };
    }
    if (isPrivateIp(ip) && (!policy.allowPrivateNetworks || !ipInAnyCidr(ip, policy.allowedPrivateCidrs))) {
      return {
        url: rawUrl,
        resolvedAddresses,
        allowed: false,
        reason: `Webhook target address ${ip} is private and not allowlisted`,
      };
    }
  }

  return { url: rawUrl, resolvedAddresses, allowed: true };
}

async function resolveTargetAddresses(hostname: string): Promise<string[]> {
  const directIp = normalizeIp(hostname);
  if (directIp) return [directIp];
  const records = await lookup(hostname, { all: true, verbatim: true });
  return [...new Set(records.map((record) => normalizeIp(record.address)).filter((ip): ip is string => !!ip))];
}

async function getSelfAddresses(env: Env, publicUrl?: string | null): Promise<Set<string>> {
  const addresses = new Set<string>();
  for (const iface of Object.values(networkInterfaces())) {
    for (const address of iface ?? []) {
      const ip = normalizeIp(address.address);
      if (ip && (isAlwaysBlockedOutboundIp(ip) || isPrivateIp(ip))) addresses.add(ip);
    }
  }

  const bindHost = normalizeIp(env.BIND_HOST);
  if (
    bindHost &&
    bindHost !== '0.0.0.0' &&
    bindHost !== '::' &&
    (isAlwaysBlockedOutboundIp(bindHost) || isPrivateIp(bindHost))
  ) {
    addresses.add(bindHost);
  }

  const appHostname = getUrlHostname(publicUrl ?? env.APP_URL);
  if (appHostname) {
    for (const ip of await resolveTargetAddressesSafe(appHostname)) {
      if (isAlwaysBlockedOutboundIp(ip) || isPrivateIp(ip)) addresses.add(ip);
    }
  }

  return addresses;
}

function stripHostnameBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

async function resolveTargetAddressesSafe(hostname: string): Promise<string[]> {
  try {
    return await resolveTargetAddresses(stripHostnameBrackets(hostname.toLowerCase()));
  } catch {
    return [];
  }
}

function getUrlHostname(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}
