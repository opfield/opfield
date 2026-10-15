import type { AppMembershipRef } from "./apps";

// ── Domains ───────────────────────────────────────────────────────

export type DnsStatus = "valid" | "invalid" | "pending" | "unknown";
export type DomainDnsProvider = "legacy" | "cloudflare";
export type DomainDnsOwnership = "legacy" | "created" | "matched_existing" | "overwritten";
export type DomainCloudflareMigrationStatus =
  | "pending"
  | "migrated"
  | "zone_unavailable"
  | "zone_ambiguous"
  | "ingress_unavailable"
  | "dns_conflict"
  | "ignored"
  | "error";

export interface DnsRecords {
  a: string[];
  aaaa: string[];
  cname: string[];
  caa: Array<{ critical: number; issue?: string; issuewild?: string }>;
  mx: Array<{ exchange: string; priority: number }>;
  txt: string[][];
}

export interface Domain {
  /** Set when the domain is a member of an app environment. */
  app?: AppMembershipRef | null;
  id: string;
  domain: string;
  description: string | null;
  dnsStatus: DnsStatus;
  lastDnsCheckAt: string | null;
  dnsRecords: DnsRecords | null;
  dnsProvider: DomainDnsProvider;
  dnsOwnership: DomainDnsOwnership;
  integrationConnectorId: string | null;
  providerZoneId: string | null;
  providerZoneName: string | null;
  providerRecordIds: string[];
  dnsRecordType: string | null;
  dnsTargetIps: string[];
  dnsTtl: number | null;
  dnsProxied: boolean | null;
  cloudflareMigrationStatus: DomainCloudflareMigrationStatus | null;
  cloudflareMigrationCheckedAt: string | null;
  nginxNodeId: string | null;
  /** Set when the domain (and its routes) is served by every member of an ingress group. */
  ingressGroupId?: string | null;
  ingressMigrationId?: string | null;
  ingressMigrationSourceNodeId?: string | null;
  ingressMigrationStatus?: string | null;
  ingressMigrationError?: string | null;
  isSystem?: boolean;
  folderId?: string | null;
  sortOrder?: number;
  sslCertCount?: number;
  proxyHostCount?: number;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface DomainUsage {
  proxyHosts: Array<{
    id: string;
    slug: string;
    domainNames: string[];
    enabled: boolean;
    nodeId: string | null;
  }>;
  sslCertificates: Array<{
    id: string;
    domainNames: string[];
    status: string;
    notAfter: string | null;
  }>;
}

export interface DomainWithUsage extends Domain {
  nginxNode: DomainNginxNode | null;
  ingressGroup?: DomainIngressGroupSummary | null;
  usage: DomainUsage;
}

/** The ingress group of a domain: its members and the addresses DNS publishes for them. */
export interface DomainIngressGroupSummary {
  id: string;
  name: string;
  slug: string;
  dnsFailoverMode: string;
  targetIps: string[];
  unpublishedNodeIds: string[];
  members: Array<{
    nodeId: string;
    state: "joining" | "active" | "draining";
    priority: number;
    node: (DomainNginxNode & { effectiveAddress?: string }) | null;
    addresses: string[];
  }>;
}

export interface DomainNginxNode {
  id: string;
  slug: string;
  hostname: string;
  displayName: string | null;
  appearanceColor: string | null;
  effectiveAddress?: string;
}

export interface DomainNginxNodeOptions {
  eligibleNodes: Array<DomainNginxNode & { effectiveAddress: string }>;
  unconfiguredNodes: DomainNginxNode[];
  /** Ingress groups a new domain may use (every member eligible and open to the caller). */
  ingressGroups?: import("./ingress-groups").DomainIngressGroupOption[];
  totalNginxNodes: number;
  unconfiguredNginxNodes: number;
}

export interface DomainIngressMigrationImpact {
  status: "ready" | "waiting_dns" | "cleanup_pending" | "completed";
  sourceNode: DomainNginxNode & { effectiveAddress: string };
  targetNode: DomainNginxNode & { effectiveAddress: string };
  domains: Array<{
    id: string;
    domain: string;
    dnsProvider: "cloudflare" | "external";
    dnsStatus: DnsStatus;
  }>;
  proxyHosts: Array<{
    id: string;
    slug: string;
    domainNames: string[];
    enabled: boolean;
  }>;
  targetIps: string[];
  requiresExternalDnsBeforeMove: boolean;
}

export type ResolveCloudflareMigrationRequest =
  | { action: "retry" }
  | { action: "keep_external" }
  | { action: "update_dns"; nginxNodeId: string };

export interface DomainSearchResult {
  id: string;
  domain: string;
  dnsStatus: DnsStatus;
  dnsProvider: DomainDnsProvider;
  nginxNodeId: string | null;
  /** Set when the domain is served by an ingress group (a route on it goes to the group). */
  ingressGroupId?: string | null;
}

export interface CreateDomainRequest {
  domain: string;
  dnsProvider: "cloudflare" | "external";
  description?: string;
  folderId?: string | null;
  ttl?: number;
  proxied?: boolean;
  overwriteDns?: boolean;
  nginxNodeId?: string;
  /** Serve the domain (and its routes) from every member of this ingress group instead of one node. */
  ingressGroupId?: string;
}

export interface DeleteDomainRequest {
  deleteDns?: boolean;
}

export interface DomainDnsRecordPreview {
  id?: string;
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean | null;
}

export interface DomainDnsConflictDetails {
  domain?: string;
  zoneName?: string;
  currentRecords?: DomainDnsRecordPreview[];
  desiredRecords?: DomainDnsRecordPreview[];
  canOverwrite?: boolean;
  recordIds?: string[];
}

export interface CloudflareDomainPreview {
  dnsProvider: "cloudflare";
  domain: string;
  zoneName: string;
  connectorId: string;
  nginxNode: DomainNginxNode & { effectiveAddress: string };
  targetIps: string[];
  ttl: number;
  proxied: boolean;
  desiredRecords: DomainDnsRecordPreview[];
  currentRecords: DomainDnsRecordPreview[];
  status: "ready" | "matched" | "mismatch" | "blocked";
  canOverwrite: boolean;
}

export interface ExternalDomainPreview {
  dnsProvider: "external";
  domain: string;
  nginxNode: DomainNginxNode & { effectiveAddress: string };
  targetIps: string[];
  queryName: string;
  dnsRecords: DnsRecords;
  status: DnsStatus;
}

export type DomainPreview = CloudflareDomainPreview | ExternalDomainPreview;

export interface UpdateDomainRequest {
  description?: string | null;
  proxied?: boolean;
}
