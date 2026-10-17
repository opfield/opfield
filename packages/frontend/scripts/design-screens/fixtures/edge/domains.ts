import { http } from "msw";
import type {
  CloudflareConnector,
  DnsStatus,
  Domain,
  DomainNginxNodeOptions,
  ResourceFolderTreeNode,
} from "@/types";
import { people } from "../catalog";
import { nodeBySlug } from "../nodes";
import { ago, uuid } from "../time";
import { ok, wrapped } from "../../handlers";

/** Seeds 41000–41999 belong to the edge group (domains, certificates, node detail). */
const edgeFra = nodeBySlug("edge-fra-1")!;
const edgeAms = nodeBySlug("edge-ams-1")!;

export const CLOUDFLARE_CONNECTOR_ID = uuid(41001);
export const CLOUDFLARE_ZONE_ID = uuid(41002);
export const DOMAIN_FOLDER_STAGING = uuid(41003);

interface DomainSeed {
  seed: number;
  domain: string;
  description: string | null;
  dnsStatus: DnsStatus;
  node: typeof edgeFra;
  cloudflare: boolean;
  ssl: number;
  routes: number;
  addedDaysAgo: number;
  isSystem?: boolean;
  folderId?: string | null;
  proxied?: boolean;
  ownership?: Domain["dnsOwnership"];
}

function domain(seed: DomainSeed): Domain {
  const address = seed.node.serviceAddress ?? "203.0.113.11";
  const resolved = seed.dnsStatus === "invalid" ? ["198.51.100.87"] : [address];
  return {
    id: uuid(41100 + seed.seed),
    domain: seed.domain,
    description: seed.description,
    dnsStatus: seed.dnsStatus,
    lastDnsCheckAt: seed.dnsStatus === "pending" ? null : ago(4 + seed.seed, "m"),
    dnsRecords:
      seed.dnsStatus === "pending"
        ? null
        : { a: resolved, aaaa: [], cname: [], caa: [], mx: [], txt: [] },
    dnsProvider: seed.cloudflare ? "cloudflare" : "legacy",
    dnsOwnership: seed.ownership ?? (seed.cloudflare ? "created" : "legacy"),
    integrationConnectorId: seed.cloudflare ? CLOUDFLARE_CONNECTOR_ID : null,
    providerZoneId: seed.cloudflare ? CLOUDFLARE_ZONE_ID : null,
    providerZoneName: seed.cloudflare ? "example.com" : null,
    providerRecordIds: seed.cloudflare ? [`cf-rec-${41100 + seed.seed}`] : [],
    dnsRecordType: "A",
    dnsTargetIps: [address],
    dnsTtl: seed.cloudflare ? 300 : 3600,
    dnsProxied: seed.cloudflare ? (seed.proxied ?? false) : null,
    cloudflareMigrationStatus: seed.cloudflare ? "migrated" : null,
    cloudflareMigrationCheckedAt: seed.cloudflare ? ago(2, "d") : null,
    nginxNodeId: seed.node.id,
    ingressMigrationId: null,
    ingressMigrationSourceNodeId: null,
    ingressMigrationStatus: null,
    ingressMigrationError: null,
    isSystem: seed.isSystem ?? false,
    folderId: seed.folderId ?? null,
    sortOrder: seed.seed,
    sslCertCount: seed.ssl,
    proxyHostCount: seed.routes,
    createdById: people[seed.seed % people.length].id,
    createdAt: ago(seed.addedDaysAgo, "d"),
    updatedAt: ago(Math.max(1, Math.floor(seed.addedDaysAgo / 3)), "d"),
  };
}

export const domains: Domain[] = [
  domain({
    seed: 1,
    domain: "opfield.example.com",
    description: "Console and node enrollment endpoint",
    dnsStatus: "valid",
    node: edgeFra,
    cloudflare: true,
    ssl: 1,
    routes: 1,
    addedDaysAgo: 212,
    isSystem: true,
  }),
  domain({
    seed: 2,
    domain: "app.example.com",
    description: "Customer web app",
    dnsStatus: "valid",
    node: edgeFra,
    cloudflare: true,
    ssl: 1,
    routes: 1,
    addedDaysAgo: 188,
  }),
  domain({
    seed: 3,
    domain: "api.example.com",
    description: "Public REST API",
    dnsStatus: "valid",
    node: edgeFra,
    cloudflare: true,
    ssl: 1,
    routes: 1,
    addedDaysAgo: 188,
  }),
  domain({
    seed: 4,
    domain: "auth.example.com",
    description: "Single sign-on",
    dnsStatus: "valid",
    node: edgeFra,
    cloudflare: true,
    ssl: 1,
    routes: 1,
    addedDaysAgo: 160,
  }),
  domain({
    seed: 5,
    domain: "status.example.com",
    description: "Public status page",
    dnsStatus: "valid",
    node: edgeAms,
    cloudflare: true,
    ssl: 1,
    routes: 1,
    addedDaysAgo: 131,
    proxied: true,
  }),
  domain({
    seed: 6,
    domain: "grafana.example.com",
    description: "Internal dashboards",
    dnsStatus: "valid",
    node: edgeFra,
    cloudflare: true,
    ssl: 1,
    routes: 1,
    addedDaysAgo: 97,
    ownership: "matched_existing",
  }),
  domain({
    seed: 7,
    domain: "docs.example.org",
    description: "Product documentation",
    dnsStatus: "valid",
    node: edgeAms,
    cloudflare: false,
    ssl: 1,
    routes: 1,
    addedDaysAgo: 74,
  }),
  domain({
    seed: 8,
    domain: "shop.example.net",
    description: "Storefront",
    dnsStatus: "valid",
    node: edgeAms,
    cloudflare: false,
    ssl: 1,
    routes: 1,
    addedDaysAgo: 41,
  }),
  domain({
    seed: 9,
    domain: "legacy-admin.example.com",
    description: "Old admin panel, DNS still points at the retired host",
    dnsStatus: "invalid",
    node: edgeFra,
    cloudflare: false,
    ssl: 0,
    routes: 1,
    addedDaysAgo: 203,
  }),
  domain({
    seed: 10,
    domain: "staging.app.example.com",
    description: "Staging environment",
    dnsStatus: "pending",
    node: edgeFra,
    cloudflare: true,
    ssl: 0,
    routes: 1,
    addedDaysAgo: 2,
    folderId: DOMAIN_FOLDER_STAGING,
  }),
];

export const domainFolders: ResourceFolderTreeNode[] = [
  {
    id: DOMAIN_FOLDER_STAGING,
    name: "Staging",
    parentId: null,
    sortOrder: 0,
    depth: 0,
    createdAt: ago(30, "d"),
    updatedAt: ago(30, "d"),
    children: [],
  },
];

export const cloudflareConnectors: CloudflareConnector[] = [
  {
    id: CLOUDFLARE_CONNECTOR_ID,
    provider: "cloudflare",
    name: "Northwind Cloudflare",
    baseUrl: null,
    enabled: true,
    settings: {
      autoSyncEnabled: true,
      autoSyncIntervalSeconds: 900,
      defaultTtl: 300,
      defaultProxied: false,
    },
    capabilities: {} as CloudflareConnector["capabilities"],
    syncStatus: "success",
    syncLastError: null,
    syncFailureCount: 0,
    syncStartedAt: ago(9, "m"),
    syncFinishedAt: ago(9, "m"),
    testedAt: ago(30, "d"),
    createdAt: ago(200, "d"),
    updatedAt: ago(9, "m"),
    hasToken: true,
    tokenMasked: "cf_…k9Qe",
    zones: [
      {
        id: CLOUDFLARE_ZONE_ID,
        connectorId: CLOUDFLARE_CONNECTOR_ID,
        remoteId: "3f9c2a7e5b1d4c8a9e0f6b2d7a1c4e8f",
        name: "example.com",
        status: "active",
        accountName: "Northwind",
        permissions: ["zone:read", "dns:edit"],
        lastSeenAt: ago(9, "m"),
        createdAt: ago(200, "d"),
        updatedAt: ago(9, "m"),
      },
    ],
  },
];

export const domainNginxNodes: DomainNginxNodeOptions = {
  eligibleNodes: [edgeFra, edgeAms].map((node) => ({
    id: node.id,
    slug: node.slug,
    hostname: node.hostname,
    displayName: node.displayName,
    appearanceColor: node.appearanceColor,
    effectiveAddress: node.serviceAddress ?? "203.0.113.11",
  })),
  unconfiguredNodes: [],
  totalNginxNodes: 2,
  unconfiguredNginxNodes: 0,
};

export function paginate<T>(items: T[], url: URL) {
  const page = Number(url.searchParams.get("page") ?? 1);
  const limit = Number(url.searchParams.get("limit") ?? 25);
  const start = (page - 1) * limit;
  return {
    data: items.slice(start, start + limit),
    pagination: {
      page,
      limit,
      total: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / limit)),
    },
  };
}

/** Answers the domain list the way the server does: search and DNS status filters apply. */
export function domainsHandlers() {
  return [
    http.get("*/api/domains/folders", () => wrapped(domainFolders)),
    http.get("*/api/domains/nginx-nodes", () => wrapped(domainNginxNodes)),
    http.get("*/api/domains", ({ request }) => {
      const url = new URL(request.url);
      const search = url.searchParams.get("search")?.toLowerCase();
      const dnsStatus = url.searchParams.get("dnsStatus");
      const items = domains.filter(
        (item) =>
          (!search || item.domain.includes(search)) && (!dnsStatus || item.dnsStatus === dnsStatus)
      );
      return ok(paginate(items, url));
    }),
    http.get("*/api/integrations/cloudflare/connectors", () => wrapped(cloudflareConnectors)),
  ];
}

