import { inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { domains, nodes, proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { resolveIngressNodes } from '@/modules/ingress-groups/ingress-nodes.js';
import { getEffectiveNginxIngressAddress } from '@/modules/nodes/node-service-address.js';

export type Http01IngressResolution = {
  domain: string;
  /** The first node that receives the token (the only one for a single-node domain). */
  nodeId: string;
  /**
   * Every online node that receives the token: all online members of the domain's ingress group (DNS may send the
   * validation request to any of them), or the domain's one node.
   */
  nodeIds: string[];
  /** Serving members that are offline and do not receive the token (group domains only). */
  offlineNodeIds: string[];
  ingressGroupId: string | null;
  source: 'domain' | 'proxy_host';
};

function normalizeHttp01Domain(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  if (normalized.startsWith('*.')) {
    throw new AppError(400, 'HTTP01_WILDCARD_UNSUPPORTED', 'HTTP-01 cannot validate wildcard domains');
  }
  return normalized;
}

/**
 * Resolve the Nginx ingress that will receive an HTTP-01 validation request. Registered Domain affinity is
 * authoritative; a domain on an ingress group resolves to every online member. Existing Proxy Hosts are only a
 * compatibility source for certificates created before Domain registration was required; there is intentionally no
 * default-node or all-node fallback.
 */
export async function resolveHttp01Ingress(
  db: DrizzleClient,
  requestedDomain: string
): Promise<Http01IngressResolution> {
  const domain = normalizeHttp01Domain(requestedDomain);
  const registered = await db.query.domains.findFirst({
    where: sql`lower(${domains.domain}) = ${domain}`,
    columns: { domain: true, nginxNodeId: true, ingressGroupId: true },
  });

  let servingNodeIds: string[] = [];
  let ingressGroupId: string | null = null;
  let source: Http01IngressResolution['source'] = 'domain';

  if (registered) {
    if (!registered.nginxNodeId && !registered.ingressGroupId) {
      throw new AppError(409, 'HTTP01_INGRESS_UNASSIGNED', 'The registered domain has no Nginx ingress assignment', {
        domain,
      });
    }
    ingressGroupId = registered.ingressGroupId ?? null;
    servingNodeIds = await resolveIngressNodes(db, { nodeId: registered.nginxNodeId, ingressGroupId });
  } else {
    const legacyHosts = await db.query.proxyHosts.findMany({
      where: sql`EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(${proxyHosts.domainNames}) AS proxy_domain(value)
        WHERE lower(proxy_domain.value) = ${domain}
      )`,
      columns: { nodeId: true, ingressGroupId: true },
    });
    const placements = [
      ...new Set(
        legacyHosts
          .filter((host) => host.nodeId || host.ingressGroupId)
          .map((host) => host.ingressGroupId ?? `node:${host.nodeId}`)
      ),
    ];
    if (placements.length === 0) {
      throw new AppError(
        409,
        'HTTP01_DOMAIN_NOT_REGISTERED',
        'Register the domain and assign its Nginx ingress before using HTTP-01',
        { domain }
      );
    }
    if (placements.length > 1) {
      throw new AppError(
        409,
        'HTTP01_INGRESS_AMBIGUOUS',
        'Existing Routes for this domain use different Nginx nodes; register the domain before using HTTP-01',
        { domain, nodeIds: legacyHosts.map((host) => host.nodeId).filter((id): id is string => !!id) }
      );
    }
    const host = legacyHosts.find((candidate) => candidate.nodeId || candidate.ingressGroupId)!;
    ingressGroupId = host.ingressGroupId ?? null;
    servingNodeIds = await resolveIngressNodes(db, host);
    source = 'proxy_host';
  }

  if (servingNodeIds.length === 0) {
    throw new AppError(409, 'HTTP01_INGRESS_UNASSIGNED', 'The domain has no Nginx ingress assignment', { domain });
  }

  const rows = await db.query.nodes.findMany({
    where: inArray(nodes.id, servingNodeIds),
    columns: { id: true, type: true, status: true, serviceAddresses: true, lastHealthReport: true },
  });
  const online = servingNodeIds.filter((nodeId) => {
    const node = rows.find((row) => row.id === nodeId);
    return node?.type === 'nginx' && node.status === 'online';
  });
  if (online.length === 0) {
    throw new AppError(
      409,
      'HTTP01_INGRESS_UNAVAILABLE',
      ingressGroupId
        ? 'No member of the ingress group serving this domain is online'
        : 'The Nginx ingress assigned to this domain is not online',
      { domain, nodeId: servingNodeIds[0], nodeIds: servingNodeIds }
    );
  }
  const withAddress = online.filter((nodeId) => {
    const node = rows.find((row) => row.id === nodeId)!;
    return Boolean(getEffectiveNginxIngressAddress(node));
  });
  if (withAddress.length === 0) {
    throw new AppError(
      409,
      'HTTP01_INGRESS_ADDRESS_REQUIRED',
      'The assigned Nginx ingress has no detected public service address',
      { domain, nodeId: online[0] }
    );
  }

  return {
    domain,
    nodeId: online[0]!,
    // Every online member gets the token, even one without a detected public address: DNS may still reach it.
    nodeIds: online,
    offlineNodeIds: servingNodeIds.filter((nodeId) => !online.includes(nodeId)),
    ingressGroupId,
    source,
  };
}
