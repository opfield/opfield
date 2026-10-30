import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { container } from '@/container.js';
import { currentCloudflareCidrList } from '@/lib/cloudflare-ip-ranges.js';
import { ipInAnyCidr, normalizeIp } from '@/lib/ip-cidr.js';
import {
  DEFAULT_NETWORK_SECURITY_SETTINGS,
  isReverseProxyWithoutTrustedProxies,
  type NetworkSecuritySettings,
  NetworkSettingsService,
  REVERSE_PROXY_WITHOUT_PROXIES_WARNING,
} from '@/modules/settings/network-settings.service.js';
import type { AppEnv } from '@/types.js';

export interface ClientIpResolution {
  ipAddress?: string;
  remoteAddress?: string;
  source: 'remote' | 'cloudflare' | 'forwarded' | 'real-ip' | 'unknown';
  warning?: string;
  /**
   * The address does not tell clients apart: proxy headers came in but are not trusted (so every client behind that
   * proxy resolves to the proxy). Per-client limits must not key on it (nor on a missing address).
   */
  sharedAddress?: true;
}

export function resolveClientIp(
  headers: Pick<Headers, 'get'>,
  remoteAddress: string | undefined,
  settings: NetworkSecuritySettings = DEFAULT_NETWORK_SECURITY_SETTINGS
): ClientIpResolution {
  const resolution = resolveConfiguredClientIp(headers, remoteAddress, settings);
  // A fallback to the peer with a warning means proxy headers were present and ignored.
  if (resolution.source === 'remote' && resolution.warning) return { ...resolution, sharedAddress: true };
  // Reverse proxy without trusted proxies (stored by an earlier release) believes forwarded headers from any peer, as
  // it always did; the settings page recommends adding the proxy's ranges.
  if (isReverseProxyWithoutTrustedProxies(settings) && !resolution.warning) {
    return { ...resolution, warning: REVERSE_PROXY_WITHOUT_PROXIES_WARNING };
  }
  return resolution;
}

function resolveConfiguredClientIp(
  headers: Pick<Headers, 'get'>,
  remoteAddress: string | undefined,
  settings: NetworkSecuritySettings
): ClientIpResolution {
  const remote = normalizeIp(remoteAddress);
  const cfIp = normalizeIp(headers.get('cf-connecting-ip'));
  const xRealIp = normalizeIp(headers.get('x-real-ip'));
  const forwardedIp = clientFromForwardedFor(headers.get('x-forwarded-for'), settings.trustedProxyCidrs);
  const remoteIsTrustedProxy = remote ? ipInAnyCidr(remote, settings.trustedProxyCidrs) : false;
  // The same edge ranges the ingress trusts, kept current by CloudflareIpRangesService.
  const remoteIsCloudflare = remote ? ipInAnyCidr(remote, currentCloudflareCidrList()) : false;
  const configuredProxyRequired = settings.trustedProxyCidrs.length > 0;
  const explicitProxyTrusted = configuredProxyRequired ? remoteIsTrustedProxy : true;

  if (settings.clientIpSource === 'direct') {
    return remote
      ? { ipAddress: remote, remoteAddress: remote, source: 'remote' }
      : { remoteAddress: remote, source: 'unknown' };
  }

  if (settings.clientIpSource === 'cloudflare') {
    if (cfIp && (settings.trustCloudflareHeaders || remoteIsCloudflare || remoteIsTrustedProxy)) {
      return { ipAddress: cfIp, remoteAddress: remote, source: 'cloudflare' };
    }
    return fallbackRemote(
      remote,
      cfIp || forwardedIp || xRealIp ? 'Cloudflare headers are present but not trusted for this request' : undefined
    );
  }

  if (settings.clientIpSource === 'reverse_proxy') {
    if (xRealIp && explicitProxyTrusted) {
      return { ipAddress: xRealIp, remoteAddress: remote, source: 'real-ip' };
    }
    if (forwardedIp && explicitProxyTrusted) {
      return { ipAddress: forwardedIp, remoteAddress: remote, source: 'forwarded' };
    }
    return fallbackRemote(
      remote,
      forwardedIp || xRealIp ? 'Forwarded headers are present but not trusted for this request' : undefined
    );
  }

  if (cfIp && (remoteIsCloudflare || settings.trustCloudflareHeaders)) {
    return { ipAddress: cfIp, remoteAddress: remote, source: 'cloudflare' };
  }
  if (xRealIp && remoteIsTrustedProxy) {
    return { ipAddress: xRealIp, remoteAddress: remote, source: 'real-ip' };
  }
  if (forwardedIp && remoteIsTrustedProxy) {
    return { ipAddress: forwardedIp, remoteAddress: remote, source: 'forwarded' };
  }

  return fallbackRemote(
    remote,
    forwardedIp || xRealIp || cfIp ? 'Proxy headers are present but ignored in auto mode' : undefined
  );
}

export async function resolveClientIpForContext(c: Context<AppEnv>): Promise<ClientIpResolution> {
  const settings = await getNetworkSettings();
  return resolveClientIp(c.req.raw.headers, getRemoteAddress(c), settings);
}

export async function getClientIpForContext(c: Context<AppEnv>): Promise<string | undefined> {
  return (await resolveClientIpForContext(c)).ipAddress;
}

/** The client address when it tells clients apart (see ClientIpResolution.sharedAddress), otherwise undefined. */
export async function getDistinctClientIpForContext(c: Context<AppEnv>): Promise<string | undefined> {
  const resolution = await resolveClientIpForContext(c);
  return resolution.sharedAddress ? undefined : resolution.ipAddress;
}

export function getRemoteAddress(c: Context<AppEnv>): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

async function getNetworkSettings(): Promise<NetworkSecuritySettings> {
  try {
    return await container.resolve(NetworkSettingsService).getConfig();
  } catch {
    return DEFAULT_NETWORK_SECURITY_SETTINGS;
  }
}

function fallbackRemote(remote: string | undefined, warning?: string): ClientIpResolution {
  return remote
    ? { ipAddress: remote, remoteAddress: remote, source: 'remote', warning }
    : { source: 'unknown', warning };
}

/**
 * Each proxy appends the peer it saw, so only the right end of X-Forwarded-For is
 * trustworthy. Walk from the right past our own trusted proxies and take the first
 * hop they did not vouch for; anything further left is client-controlled.
 */
function clientFromForwardedFor(value: string | null, trustedProxyCidrs: string[]): string | undefined {
  const hops = (value?.split(',') ?? [])
    .map((part) => normalizeIp(part.trim()))
    .filter((part): part is string => Boolean(part));
  for (let index = hops.length - 1; index >= 0; index--) {
    const hop = hops[index]!;
    if (trustedProxyCidrs.length === 0 || !ipInAnyCidr(hop, trustedProxyCidrs)) return hop;
  }
  return hops[0];
}
