import type { AuditLogEntry, CA, DashboardBootstrap } from "@/types";
import { databases, people, routes, storages } from "./catalog";
import { nodes } from "./nodes";
import { updateStatus } from "./shell";
import { ago, ahead, uuid } from "./time";

export const certificateAuthorities: CA[] = [
  {
    id: uuid(6001),
    parentId: null,
    type: "root",
    status: "active",
    commonName: "Northwind Root CA",
    keyAlgorithm: "ecdsa-p384",
    serialNumber: "4F1A0C9E22B7",
    certificatePem: "",
    subjectDn: "CN=Northwind Root CA,O=Northwind",
    issuerDn: null,
    pathLengthConstraint: 1,
    maxValidityDays: 3650,
    notBefore: ago(300, "d"),
    notAfter: ahead(3350, "d"),
    ocspCertPem: null,
    crlNumber: 14,
    lastCrlAt: ago(6, "h"),
    crlDistributionUrl: "https://opfield.example.com/pki/crl/root.crl",
    ocspResponderUrl: null,
    caIssuersUrl: null,
    createdById: people[0].id,
    createdAt: ago(300, "d"),
    updatedAt: ago(6, "h"),
    revokedAt: null,
    revocationReason: null,
    certCount: 2,
  },
  {
    id: uuid(6002),
    parentId: uuid(6001),
    type: "intermediate",
    status: "active",
    commonName: "Northwind Services CA",
    keyAlgorithm: "ecdsa-p256",
    serialNumber: "7B22D91C0A44",
    certificatePem: "",
    subjectDn: "CN=Northwind Services CA,O=Northwind",
    issuerDn: "CN=Northwind Root CA,O=Northwind",
    pathLengthConstraint: 0,
    maxValidityDays: 825,
    notBefore: ago(300, "d"),
    notAfter: ahead(1500, "d"),
    ocspCertPem: null,
    crlNumber: 31,
    lastCrlAt: ago(2, "h"),
    crlDistributionUrl: "https://opfield.example.com/pki/crl/services.crl",
    ocspResponderUrl: "https://opfield.example.com/pki/ocsp",
    caIssuersUrl: null,
    createdById: people[0].id,
    createdAt: ago(300, "d"),
    updatedAt: ago(2, "h"),
    revokedAt: null,
    revocationReason: null,
    certCount: 18,
  },
] as CA[];

function activity(
  seed: number,
  who: (typeof people)[number] | null,
  action: string,
  resourceType: string,
  resourceName: string,
  when: string
): AuditLogEntry {
  return {
    id: uuid(7000 + seed),
    userId: who?.id ?? null,
    action,
    resourceType,
    resourceId: uuid(7100 + seed),
    resourceName,
    details: null,
    ipAddress: "198.51.100.23",
    userAgent: null,
    createdAt: when,
    userName: who?.name ?? null,
    userEmail: who?.email ?? null,
  };
}

export const recentActivity: AuditLogEntry[] = [
  activity(1, people[1], "docker.deployment.deploy", "docker-deployment", "api", ago(14, "m")),
  activity(2, people[0], "proxy.update", "proxy-host", "app.example.com", ago(52, "m")),
  activity(3, null, "ssl.renew", "ssl-certificate", "api.example.com", ago(3, "h")),
  activity(4, people[2], "database.backup.create", "database", "orders-db", ago(5, "h")),
  activity(5, people[3], "pages.deploy", "pages-project", "marketing-site", ago(9, "h")),
  activity(6, people[0], "user.invite", "user", "sam.patel@example.com", ago(1, "d")),
];

interface PinRequest {
  nodeIds?: string[];
  proxyHostIds?: string[];
  databaseIds?: string[];
  storageIds?: string[];
  dockerResources?: Array<{ id: string }>;
}

export const dashboardBootstrapStats = {
  proxyHosts: { total: 9, enabled: 8, online: 6, offline: 1, degraded: 1 },
  sslCertificates: { total: 11, active: 10, expiringSoon: 1, expired: 0 },
  pkiCertificates: { total: 20, active: 18, revoked: 2, expired: 0 },
  cas: { total: 2, active: 2 },
};

/** Pins the client asked for, answered the way the server does: only what was requested. */
function pinned(request: PinRequest | undefined) {
  const ids = (list?: string[]) => new Set(list ?? []);
  const nodeIds = ids(request?.nodeIds);
  const databaseIds = ids(request?.databaseIds);
  const storageIds = ids(request?.storageIds);
  return {
    storages: storages
      .filter((storage) => storageIds.has(storage.id))
      .map((storage) => ({ ...storage, healthStatus: "online" })),
    nodes: nodes.filter((node) => nodeIds.has(node.id)),
    proxies: [],
    databases: databases
      .filter((database) => databaseIds.has(database.id))
      .map((database) => ({ ...database, healthStatus: "online" })),
    dockerResources: [],
  };
}

export const dashboardBootstrap = (request: {
  pins?: { dashboard?: PinRequest; sidebar?: PinRequest };
}): DashboardBootstrap =>
  ({
    fetchedAt: new Date().toISOString(),
    stats: dashboardBootstrapStats,
    health: routes.map((route) => ({
      id: route.id,
      domainNames: [...route.domains],
      type: "proxy",
      enabled: route.enabled,
      healthStatus: route.enabled ? route.health : "disabled",
      lastHealthCheckAt: ago(30, "s"),
    })),
    requestedPins: {
      dashboard: request.pins?.dashboard ?? {},
      sidebar: request.pins?.sidebar ?? {},
    },
    nodes,
    expiring: [
      { id: uuid(8001), name: "grafana.example.com", type: "ssl", expiresAt: ahead(9, "d") },
      { id: uuid(8002), name: "edge-mtls-client", type: "pki", expiresAt: ahead(21, "d") },
    ],
    cas: certificateAuthorities,
    activity: recentActivity,
    finalizeSetup: null,
    mfa: {
      totpConfigured: true,
      passkeyCount: 1,
      recoveryCodeCount: 8,
      required: false,
      showReminder: false,
      sessionMfaSatisfied: true,
      graceExpiresAt: null,
    },
    update: updateStatus,
    loggingHealth: null,
    inferenceUsage: null,
    inviteUserMethods: { password: true, emailOtp: true },
    relay: null,
    pinned: {
      dashboard: pinned(request.pins?.dashboard),
      sidebar: pinned(request.pins?.sidebar),
    },
    attention: { severity: "warning", notices: [{ id: "node-offline", severity: "warning" }] },
    navigationAttention: {
      nodes: "warning",
      "proxy-hosts": "warning",
      docker: null,
      "status-page": null,
    },
  }) as unknown as DashboardBootstrap;
