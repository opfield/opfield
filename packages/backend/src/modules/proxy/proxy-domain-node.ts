import { inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { domains } from '@/db/schema/domains.js';
import { AppError } from '@/middleware/error-handler.js';

export function getRegisteredDomainCandidates(domainNames: string[]): string[] {
  return [
    ...new Set(
      domainNames.flatMap((domain) => {
        const normalized = domain.trim().toLowerCase();
        if (!normalized) return [];
        const base = normalized.startsWith('*.') ? normalized.slice(2) : normalized;
        const labels = base.split('.');
        return [base, ...labels.slice(0, -1).map((_, index) => `*.${labels.slice(index).join('.')}`)];
      })
    ),
  ];
}

export interface RegisteredDomainNode {
  domain: string;
  nginxNodeId: string | null;
  /** Set when the domain is served by an ingress group (nginxNodeId is then the group's first member). */
  ingressGroupId?: string | null;
}

/** Where a route or domain is served: one node, or an ingress group (nodeId = its first member). */
export interface IngressPlacement {
  nodeId: string;
  ingressGroupId: string | null;
}

/** Registered Opfield domains (exact or covering wildcard) that apply to these route domain names. */
export async function findRegisteredDomainNodes(
  db: DrizzleClient,
  domainNames: string[]
): Promise<RegisteredDomainNode[]> {
  const registeredDomainNames = getRegisteredDomainCandidates(domainNames);
  if (registeredDomainNames.length === 0) return [];
  return db
    .select({ domain: domains.domain, nginxNodeId: domains.nginxNodeId, ingressGroupId: domains.ingressGroupId })
    .from(domains)
    .where(inArray(sql`lower(${domains.domain})`, registeredDomainNames));
}

export async function assertRegisteredDomainsUseNode(
  db: DrizzleClient,
  domainNames: string[],
  nodeId: string
): Promise<void> {
  await assertRegisteredDomainsUseTarget(db, domainNames, { nodeId, ingressGroupId: null });
}

/**
 * Every registered Opfield domain of a route must be served where the route is: the same ingress group, or the same
 * node when neither is on a group.
 */
export async function assertRegisteredDomainsUseTarget(
  db: DrizzleClient,
  domainNames: string[],
  target: IngressPlacement
): Promise<void> {
  const registered = await findRegisteredDomainNodes(db, domainNames);
  const mismatch = registered.find((domain) =>
    target.ingressGroupId
      ? (domain.ingressGroupId ?? null) !== target.ingressGroupId
      : (domain.ingressGroupId ?? null) !== null || domain.nginxNodeId !== target.nodeId
  );
  if (!mismatch) return;
  if (mismatch.ingressGroupId || target.ingressGroupId) {
    throw new AppError(
      409,
      'DOMAIN_INGRESS_TARGET_MISMATCH',
      mismatch.ingressGroupId
        ? target.ingressGroupId
          ? 'The registered domain is served by a different ingress group'
          : 'The registered domain is served by an ingress group; place the route on that group'
        : 'The registered domain is served by a single Nginx node; convert the domain to the ingress group first',
      {
        domain: mismatch.domain,
        domainNginxNodeId: mismatch.nginxNodeId,
        domainIngressGroupId: mismatch.ingressGroupId ?? null,
        proxyHostNodeId: target.nodeId,
        proxyHostIngressGroupId: target.ingressGroupId,
      }
    );
  }
  throw new AppError(
    409,
    'DOMAIN_NGINX_NODE_MISMATCH',
    mismatch.nginxNodeId
      ? 'The registered domain is assigned to a different Nginx node'
      : 'The registered domain has no resolved Nginx node assignment',
    { domain: mismatch.domain, domainNginxNodeId: mismatch.nginxNodeId, proxyHostNodeId: target.nodeId }
  );
}

/**
 * The ingress node the registered domains of a new route pin, or null when none of its names is a
 * registered Opfield domain. Every registered domain must name the same resolved node, as
 * {@link assertRegisteredDomainsUseNode} requires for an explicit node.
 */
export function registeredDomainsIngressNodeId(registered: readonly RegisteredDomainNode[]): string | null {
  return registeredDomainsIngressPlacement(registered)?.nodeId ?? null;
}

/**
 * The placement (node or ingress group) the registered domains of a new route pin, or null when none of its names is
 * a registered Opfield domain. Every registered domain must name the same placement.
 */
export function registeredDomainsIngressPlacement(
  registered: readonly RegisteredDomainNode[]
): IngressPlacement | null {
  if (registered.length === 0) return null;
  const unresolved = registered.find((domain) => !domain.nginxNodeId);
  if (unresolved) {
    throw new AppError(
      409,
      'DOMAIN_NGINX_NODE_MISMATCH',
      `The registered domain ${unresolved.domain} has no resolved Nginx node assignment`,
      { domain: unresolved.domain, domainNginxNodeId: null, proxyHostNodeId: null }
    );
  }
  const placements = [
    ...new Set(registered.map((domain) => domain.ingressGroupId ?? `node:${domain.nginxNodeId as string}`)),
  ];
  if (placements.length > 1) {
    throw new AppError(
      409,
      'DOMAIN_NGINX_NODE_MISMATCH',
      `The registered domains of this route are served by different ingress nodes or groups (${registered
        .map((domain) =>
          domain.ingressGroupId
            ? `${domain.domain} on ingress group ${domain.ingressGroupId}`
            : `${domain.domain} on ${domain.nginxNodeId}`
        )
        .join(', ')}); one route serves domains of one ingress node or group`,
      {
        domains: registered.map(({ domain, nginxNodeId, ingressGroupId }) => ({
          domain,
          nginxNodeId,
          ingressGroupId: ingressGroupId ?? null,
        })),
        proxyHostNodeId: null,
      }
    );
  }
  const first = registered[0]!;
  return { nodeId: first.nginxNodeId as string, ingressGroupId: first.ingressGroupId ?? null };
}
