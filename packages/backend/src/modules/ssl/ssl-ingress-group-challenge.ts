import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { domains } from '@/db/schema/domains.js';
import { getRegisteredDomainCandidates } from '@/modules/proxy/proxy-domain-node.js';

/**
 * Whether certificate names belong to registered Opfield domains that an ingress group serves and whose DNS
 * Opfield manages through Cloudflare. With DNS listing several members, an HTTP-01 validation may reach any of them
 * (including one that is offline); DNS-01 through the Cloudflare connector does not depend on any ingress node, so
 * such certificates are issued and renewed with DNS-01 automatically.
 */
export async function namesOnCloudflareIngressGroups(db: DrizzleClient, names: readonly string[]): Promise<boolean> {
  const candidates = getRegisteredDomainCandidates([...names]);
  if (candidates.length === 0) return false;
  const rows = await db
    .select({ domain: domains.domain })
    .from(domains)
    .where(
      and(
        inArray(sql`lower(${domains.domain})`, candidates),
        isNotNull(domains.ingressGroupId),
        eq(domains.dnsProvider, 'cloudflare')
      )
    )
    .limit(1);
  return rows.length > 0;
}
