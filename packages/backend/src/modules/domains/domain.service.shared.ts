import type { DnsRecords } from '@/db/schema/domains.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CloudflareClient, CloudflareDnsRecordInput } from '@/modules/integrations/cloudflare-client.js';
import { LEGACY_DNS_RECORD_COMMENT_PREFIX } from '@/lib/legacy-compat.js';
export const logger = createChildLogger('DomainsService');

/** Comment on the Cloudflare address records Opfield creates for a domain; it recovers them when their ids are lost. */
export function domainRecordComment(domainId: string): string {
  return `opfield:domain:${domainId}`;
}

// legacy-name: the pre-2.12.1 DNS record comment — records created before 2.12.1 carry it until the
// next reconcile rewrites it; remove once no Cloudflare record carries it.
export function legacyDomainRecordComment(domainId: string): string {
  return `${LEGACY_DNS_RECORD_COMMENT_PREFIX}${domainId}`;
}

export interface DomainUsage {
  proxyHosts: Array<{
    id: string;
    slug: string;
    domainNames: string[];
    enabled: boolean;
    nodeId: string | null;
    ingressGroupId?: string | null;
    folderId?: string | null;
  }>;
  sslCertificates: Array<{ id: string; domainNames: string[]; status: string; notAfter: Date | null }>;
}

export interface EligibleNginxNode {
  id: string;
  slug: string;
  hostname: string;
  displayName: string | null;
  appearanceColor: string | null;
  effectiveAddress: string;
  effectiveAddresses?: string[];
}

export interface NginxNodeOptions {
  eligibleNodes: EligibleNginxNode[];
  unconfiguredNodes: Array<{
    id: string;
    slug: string;
    hostname: string;
    displayName: string | null;
    appearanceColor: string | null;
  }>;
  totalNginxNodes: number;
  unconfiguredNginxNodes: number;
}

export function selectBackfillNginxNode(
  eligibleNodes: EligibleNginxNode[],
  usedNodeIds: Array<string | null>
): EligibleNginxNode | undefined {
  if (usedNodeIds.some((nodeId) => !nodeId)) return undefined;
  const distinctUsedNodeIds = [...new Set(usedNodeIds)];
  if (distinctUsedNodeIds.length === 0) return eligibleNodes[0];
  if (distinctUsedNodeIds.length !== 1) return undefined;
  return eligibleNodes.find((node) => node.id === distinctUsedNodeIds[0]);
}

export type CloudflareAddressRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean | null;
  comment?: string | null;
};

/** Where a domain is served: one node, or an ingress group (nginxNode = its first active member). */
export type DomainIngressPlacement = {
  nginxNode: EligibleNginxNode;
  ingressGroupId: string | null;
  /** Addresses Opfield publishes: the node's first effective address, or one per active group member. */
  targetIps: string[];
  /** Addresses existing records may already use: every ingress address of the node or of each serving member. */
  allowedIps: string[];
};

export type DomainCloudflarePlan = {
  domainName: string;
  nginxNode: EligibleNginxNode;
  ingressGroupId: string | null;
  /** The placement's publication target (the full member union for a group), which targetIps may be a subset of. */
  placementTargetIps: string[];
  targetIps: string[];
  ttl: number;
  proxied: boolean;
  context: {
    connector: { id: string };
    zone: { remoteId: string; name: string };
    settings: { defaultTtl: number; defaultProxied: boolean };
    client: CloudflareClient;
  };
  addressRecords: CloudflareAddressRecord[];
  blockingRecords: CloudflareAddressRecord[];
  currentIps: string[];
  desiredIps: string[];
  currentMatches: boolean;
  desiredRecords: CloudflareDnsRecordInput[];
};

export type DomainExternalPlan = {
  domainName: string;
  nginxNode: EligibleNginxNode;
  ingressGroupId: string | null;
  targetIps: string[];
  queryName: string;
  dnsRecords: DnsRecords;
  status: 'valid' | 'invalid' | 'pending' | 'unknown';
};
