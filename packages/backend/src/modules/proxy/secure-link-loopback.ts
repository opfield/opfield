import { inArray } from 'drizzle-orm';
import { getEnv } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { proxyAdditionalSecureLinks } from '@/db/schema/proxy-additional-secure-links.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';

/**
 * Route Secure Link over loopback TCP (2.11.4). nginx reached a link's nginx daemon over a Unix socket, which has no
 * reset: when a stream was really cut (the daemon crashed, the node rebooted, every relay stayed away) nginx read a
 * clean end, and a response without Content-Length or chunked framing reached the client truncated without an error.
 * Over loopback TCP the daemon resets a cut stream, so nginx reports an upstream error and aborts the response.
 *
 * Every link listens on its own loopback address, 127.64.0.0 onwards from a slot unique across both link tables, on
 * one port (SECURE_LINK_LOOPBACK_PORT): the address names the link, so one rendered config fits every node of an
 * ingress group. The daemon also keeps the link's Unix socket, so configs rendered before (and a rollback) still work.
 */
export const NGINX_SECURE_LINK_LOOPBACK_CAPABILITY = 'nginx_secure_link_loopback_tcp_v1';

// legacy-name: the legacy secure links runtime directory of configs stored before 2.12.1 — remove once every node reports none
const SECURE_LINK_SOCKET_SERVER =
  /(\bserver\s+)unix:\/run\/(?:opfield|gateway)-secure-links\/([0-9a-fA-F-]{36})\.sock\b/g;

/** The loopback endpoint of the link with this slot ("127.a.b.c:port"); undefined without a slot. */
export function secureLinkLoopbackAddress(slot: number | null | undefined, port?: number): string | undefined {
  if (!Number.isInteger(slot) || (slot as number) < 1 || (slot as number) >= 192 * 65536) return undefined;
  const value = slot as number;
  return `127.${64 + (value >> 16)}.${(value >> 8) & 255}.${value & 255}:${port ?? getEnv().SECURE_LINK_LOOPBACK_PORT}`;
}

/** The Secure Link ids whose Unix socket an upstream server directive of config names. */
export function referencedSecureLinkIds(config: string): string[] {
  return [...new Set([...config.matchAll(SECURE_LINK_SOCKET_SERVER)].map((match) => match[2]!.toLowerCase()))];
}

/**
 * Points every upstream server directive at a link's Unix socket to the link's loopback endpoint instead, for the
 * links addresses has. Templates (built-in and custom) keep rendering socket paths; only the server directives the
 * daemon serves on loopback change, so a config never names an endpoint without its link behind it.
 */
export function withSecureLinkLoopbackUpstreams(config: string, addresses: ReadonlyMap<string, string>): string {
  if (addresses.size === 0) return config;
  return config.replace(SECURE_LINK_SOCKET_SERVER, (whole, prefix: string, id: string) => {
    const address = addresses.get(id.toLowerCase());
    return address ? `${prefix}${address}` : whole;
  });
}

/** The loopback endpoints of the links config references. */
export async function secureLinkLoopbackAddresses(db: DrizzleClient, config: string): Promise<Map<string, string>> {
  const ids = referencedSecureLinkIds(config);
  const addresses = new Map<string, string>();
  if (ids.length === 0) return addresses;
  const [hosts, additional] = await Promise.all([
    db
      .select({ id: proxyHosts.id, slot: proxyHosts.secureLinkLoopbackSlot })
      .from(proxyHosts)
      .where(inArray(proxyHosts.id, ids)),
    db
      .select({ id: proxyAdditionalSecureLinks.id, slot: proxyAdditionalSecureLinks.loopbackSlot })
      .from(proxyAdditionalSecureLinks)
      .where(inArray(proxyAdditionalSecureLinks.id, ids)),
  ]);
  for (const row of [...hosts, ...additional]) {
    const address = secureLinkLoopbackAddress(row.slot);
    if (address) addresses.set(row.id.toLowerCase(), address);
  }
  return addresses;
}
