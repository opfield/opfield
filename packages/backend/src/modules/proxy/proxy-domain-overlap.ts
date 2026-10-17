import { and, eq, ne, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { proxyHostDomains, proxyHosts } from '@/db/schema/index.js';
import { LEGACY_GUC_PROXY_DOMAIN_CONFLICTS } from '@/lib/legacy-compat.js';
import { AppError } from '@/middleware/error-handler.js';
import { proxyHostsServedByNode } from '@/modules/ingress-groups/ingress-nodes.js';

/** Partial unique index on `proxy_host_domains`: one enabled host per name on a node. */
export const PROXY_HOST_DOMAIN_UNIQUE_INDEX = 'proxy_host_domains_node_domain_unique';

/**
 * Two enabled proxy hosts on one node must not serve the same name: nginx keeps
 * one server block and ignores the other ("conflicting server name"), so edits
 * and deletes then act on a host that is not serving. Callers hold the node's
 * proxy lock (`proxyNodeLockKey`) across this check and the write that makes
 * the host serve, so two concurrent creates cannot both pass it.
 */
export async function assertNoProxyDomainOverlap(
  db: DrizzleClient,
  nodeId: string,
  domainNames: string[],
  excludeHostId?: string
): Promise<void> {
  const requested = [...new Set(domainNames.map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
  if (requested.length === 0) return;
  const [conflict] = await db
    .select({ id: proxyHosts.id, domainNames: proxyHosts.domainNames })
    .from(proxyHosts)
    .where(
      and(
        proxyHostsServedByNode(db, nodeId),
        eq(proxyHosts.enabled, true),
        excludeHostId ? ne(proxyHosts.id, excludeHostId) : undefined,
        sql`exists (select 1 from jsonb_array_elements_text(${proxyHosts.domainNames}) as served(name) where lower(served.name) in (${sql.join(
          requested.map((domain) => sql`${domain}`),
          sql`, `
        )}))`
      )
    )
    .limit(1);
  if (!conflict) return;
  const overlapping = (conflict.domainNames ?? []).filter((domain) => requested.includes(domain.toLowerCase()));
  throw new AppError(
    409,
    'PROXY_HOST_DOMAIN_CONFLICT',
    `Another enabled route on this node already serves ${overlapping.join(', ') || 'these domains'}`,
    { proxyHostId: conflict.id, nodeId, domains: overlapping }
  );
}

/** {@link assertNoProxyDomainOverlap} on every node a route serves on (all members of its ingress group). */
export async function assertNoProxyDomainOverlapOnNodes(
  db: DrizzleClient,
  nodeIds: readonly string[],
  domainNames: string[],
  excludeHostId?: string
): Promise<void> {
  for (const nodeId of new Set(nodeIds)) await assertNoProxyDomainOverlap(db, nodeId, domainNames, excludeHostId);
}

/** The node and name of a violation of the per-node domain index, or null for any other error. */
function proxyHostDomainViolation(error: unknown): { nodeId?: string; domain?: string } | null {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object' && !seen.has(current); depth += 1) {
    seen.add(current);
    const candidate = current as { code?: unknown; constraint?: unknown; detail?: unknown; cause?: unknown };
    if (candidate.code === '23505' && candidate.constraint === PROXY_HOST_DOMAIN_UNIQUE_INDEX) {
      // Key (node_id, domain)=(<node>, <domain>) already exists.
      const key =
        typeof candidate.detail === 'string' ? /=\(([^,]+), (.+)\) already exists/.exec(candidate.detail) : null;
      return key ? { nodeId: key[1], domain: key[2] } : {};
    }
    current = candidate.cause;
  }
  return null;
}

/**
 * The database keeps one enabled host per name on a node (`proxy_host_domains`,
 * kept in sync with `proxy_hosts` by a trigger). A write that loses that race,
 * or that no service check covered, gets the same 409 as
 * `assertNoProxyDomainOverlap`; any other error is rethrown unchanged.
 */
export async function rethrowProxyHostDomainConflict(db: DrizzleClient, error: unknown): Promise<never> {
  const violation = proxyHostDomainViolation(error);
  if (!violation) throw error;
  const { nodeId, domain } = violation;
  let proxyHostId: string | undefined;
  if (nodeId && domain) {
    try {
      const [holder] = await db
        .select({ proxyHostId: proxyHostDomains.proxyHostId })
        .from(proxyHostDomains)
        .where(
          and(
            eq(proxyHostDomains.nodeId, nodeId),
            eq(proxyHostDomains.domain, domain),
            eq(proxyHostDomains.enabled, true),
            eq(proxyHostDomains.legacyConflict, false)
          )
        )
        .limit(1);
      proxyHostId = holder?.proxyHostId;
    } catch {
      // The conflict stands without naming the other host.
    }
  }
  throw new AppError(
    409,
    'PROXY_HOST_DOMAIN_CONFLICT',
    `Another enabled route on this node already serves ${domain ?? 'these domains'}`,
    { ...(proxyHostId ? { proxyHostId } : {}), nodeId, domains: domain ? [domain] : [] }
  );
}

/**
 * Runs `write` in a transaction in which the domain trigger records a name another enabled host serves as a legacy
 * conflict (`proxy_host_domains.legacy_conflict`) instead of refusing it (migration 0209). Only for writes that put a
 * host back into the state nginx still serves after a failed apply: refusing them would leave the database and nginx
 * out of step. The overlap check still reports the duplicate on the host's next edit.
 */
export async function restoringProxyHostState<T>(
  db: DrizzleClient,
  write: (executor: DrizzleExecutor) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config(${LEGACY_GUC_PROXY_DOMAIN_CONFLICTS}, 'record', true)`);
    return write(tx);
  });
}
