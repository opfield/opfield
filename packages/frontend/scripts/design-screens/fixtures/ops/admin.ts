/**
 * Administration: permission groups, users, deleted users, a slice of the audit
 * log and the resource lists the group editor's pickers preload. Seeds 64400–64599.
 */
import type {
  AuditLogEntry,
  CA,
  DatabaseConnection,
  DeletedUser,
  PermissionGroup,
  ProxyHost,
  User,
} from "@/types";
import { TOKEN_SCOPES } from "@/types/scope-token-catalog";
import { databases, people, routes } from "../catalog";
import { adminUser } from "../identity";
import { edgeNode } from "../nodes";
import { ago, uuid } from "../time";

// ── Scopes per group ────────────────────────────────────────────────

const ALL_SCOPES = Array.from(
  new Set([...TOKEN_SCOPES.map((scope) => scope.value), "admin:system"])
);

const ADMIN_SCOPES = ALL_SCOPES.filter(
  (scope) => scope !== "admin:system" && scope !== "admin:users:impersonate"
);

const VIEWER_SCOPES = ALL_SCOPES.filter(
  (scope) =>
    /:(view|read|details)$/.test(scope) &&
    !scope.startsWith("admin:") &&
    !scope.startsWith("settings:") &&
    !scope.includes("credentials") &&
    !scope.startsWith("storage:objects") &&
    !scope.startsWith("databases:query") &&
    !scope.includes(":files:")
);

const OPERATOR_SCOPES = ALL_SCOPES.filter(
  (scope) =>
    !/^(admin|settings|license|integrations|hosting|inference|ai|mcp|feat|housekeeping|audit):/.test(
      scope
    ) &&
    !/:(delete|revoke:root|revoke:intermediate|create:root|reveal|admin|unrestricted|raw:write)$/.test(
      scope
    ) &&
    !scope.endsWith(":folders:manage")
);

const DEVELOPER_SCOPES = [
  "docker:containers:edit",
  "docker:containers:manage",
  "docker:containers:console",
  "docker:containers:environment",
  "docker:compose:manage",
  "docker:images:pull",
  "databases:query:read",
  "pages:create",
  "pages:edit",
  "pages:deploy",
  "integrations:git:use",
  "feat:ai:use",
  "ai:workspace:use",
  "logs:tokens:view",
];

const AUDITOR_SCOPES = [
  "admin:audit",
  "audit:siem:view",
  "logs:read",
  "logs:environments:view",
  "notifications:alerts:view",
  "notifications:webhooks:view",
  "nodes:details",
  "proxy:view",
  "ssl:cert:view",
  "pki:ca:view",
  "pki:cert:view",
  "databases:backups:view",
  "license:view",
];

const ON_CALL_SCOPES = [
  "nodes:console",
  "nodes:logs",
  "docker:containers:console",
  "docker:containers:manage",
  "proxy:maintenance:bypass",
  "databases:query:write",
  "notifications:alerts:manage",
  "status-page:incidents:create",
  "status-page:incidents:update",
  "status-page:incidents:resolve",
];

// ── Groups ──────────────────────────────────────────────────────────

function group(
  overrides: Partial<PermissionGroup> & Pick<PermissionGroup, "id" | "name" | "scopes">
): PermissionGroup {
  return {
    description: null,
    isBuiltin: false,
    parentId: null,
    folderId: null,
    sortOrder: 0,
    require2fa: false,
    memberCount: 0,
    createdAt: ago(412, "d"),
    updatedAt: ago(412, "d"),
    ...overrides,
  };
}

export const groupIds = {
  systemAdmin: adminUser.groupId,
  admin: "group-admin",
  operator: "group-operator",
  viewer: "group-viewer",
  guest: "group-guest",
  developers: uuid(64401),
  auditors: uuid(64402),
  onCall: uuid(64403),
} as const;

export const groups: PermissionGroup[] = [
  group({
    id: groupIds.systemAdmin,
    name: "system-admin",
    description: "System administrator — full access, protected from non-system-admins",
    isBuiltin: true,
    scopes: ALL_SCOPES,
    require2fa: true,
    memberCount: 2,
  }),
  group({
    id: groupIds.admin,
    name: "admin",
    description: "Full access to all features except system protection",
    isBuiltin: true,
    scopes: ADMIN_SCOPES,
    require2fa: true,
    memberCount: 1,
  }),
  group({
    id: groupIds.operator,
    name: "operator",
    description: "Operational access — manage certificates, proxies, and SSL",
    isBuiltin: true,
    scopes: OPERATOR_SCOPES,
    memberCount: 1,
  }),
  group({
    id: groupIds.viewer,
    name: "viewer",
    description: "Read-only access to all resources",
    isBuiltin: true,
    scopes: VIEWER_SCOPES,
    memberCount: 1,
  }),
  group({
    id: groupIds.guest,
    name: "guest",
    description: "Account access only — no infrastructure permissions",
    isBuiltin: true,
    scopes: [],
    memberCount: 0,
  }),
  group({
    id: groupIds.developers,
    name: "developers",
    description: "Ship and debug application services; read-only elsewhere",
    parentId: groupIds.viewer,
    scopes: DEVELOPER_SCOPES,
    inheritedScopes: VIEWER_SCOPES,
    memberCount: 2,
    sortOrder: 0,
    createdAt: ago(240, "d"),
    updatedAt: ago(18, "d"),
  }),
  group({
    id: groupIds.onCall,
    name: "on-call",
    description: "Break-glass console and incident access for the on-call rotation",
    scopes: ON_CALL_SCOPES,
    require2fa: true,
    memberCount: 1,
    sortOrder: 1,
    createdAt: ago(190, "d"),
    updatedAt: ago(6, "d"),
  }),
  group({
    id: groupIds.auditors,
    name: "auditors",
    description: "Audit log, SIEM export and certificate inventory review",
    scopes: AUDITOR_SCOPES,
    require2fa: true,
    memberCount: 1,
    sortOrder: 2,
    createdAt: ago(75, "d"),
    updatedAt: ago(75, "d"),
  }),
];

const groupById = (id: string) => groups.find((item) => item.id === id)!;

// ── Users ───────────────────────────────────────────────────────────

function member(
  overrides: Partial<User> & Pick<User, "id" | "email" | "name">,
  groupIdsForUser: string[]
): User {
  const memberGroups = groupIdsForUser.map(groupById);
  const scopes = Array.from(
    new Set(memberGroups.flatMap((item) => [...item.scopes, ...(item.inheritedScopes ?? [])]))
  );
  return {
    oidcSubject: `oidc-${overrides.id.replace(/^user-/, "")}`,
    authMethod: "oidc",
    avatarUrl: null,
    groupId: memberGroups[0].id,
    groupIds: memberGroups.map((item) => item.id),
    groupName: memberGroups[0].name,
    groupNames: memberGroups.map((item) => item.name),
    groupScopes: scopes,
    additionalScopes: [],
    scopes,
    isBlocked: false,
    aiApprovalMode: "normal",
    folderId: null,
    ...overrides,
  };
}

const [maya, omar, lena, sam] = people;

export const users: User[] = [
  member(
    {
      id: "00000000-0000-0000-0000-000000000000",
      oidcSubject: "system:opfield-setup",
      email: "system@opfield.local",
      name: "Opfield System",
      sortOrder: 0,
    },
    [groupIds.systemAdmin]
  ),
  { ...adminUser, groupScopes: ALL_SCOPES, additionalScopes: [], folderId: null, sortOrder: 1 },
  member({ id: omar.id, email: omar.email, name: omar.name, sortOrder: 2 }, [groupIds.admin]),
  member({ id: lena.id, email: lena.email, name: lena.name, sortOrder: 3 }, [
    groupIds.operator,
    groupIds.onCall,
  ]),
  member(
    {
      id: sam.id,
      email: sam.email,
      name: sam.name,
      sortOrder: 4,
      additionalScopes: ["databases:query:write", "docker:containers:files:read"],
    },
    [groupIds.developers]
  ),
  // Pre-created by an administrator; signs in with a password for the first time this week.
  member(
    {
      id: "user-priya",
      oidcSubject: "manual:priya.raman@example.com",
      authMethod: "password",
      email: "priya.raman@example.com",
      name: "Priya Raman",
      sortOrder: 5,
    },
    [groupIds.developers]
  ),
  member(
    {
      id: "user-jonas",
      oidcSubject: "manual:jonas.weber@example.org",
      authMethod: "email_otp",
      email: "jonas.weber@example.org",
      name: "Jonas Weber",
      sortOrder: 6,
    },
    [groupIds.auditors]
  ),
  member(
    {
      id: "user-alex",
      email: "alex.morgan@example.com",
      name: "Alex Morgan",
      isBlocked: true,
      sortOrder: 7,
    },
    [groupIds.viewer]
  ),
];

export const deletedUsers: DeletedUser[] = [
  {
    id: "user-rafael",
    email: "rafael.costa@example.net",
    name: "Rafael Costa",
    avatarUrl: null,
    deletedAt: ago(41, "d"),
    deletedByUserId: maya.id,
    deletedFromGroupId: groupIds.developers,
    originalGroupExists: true,
  },
];

// ── Audit log (the Audit Log tab is preloaded next to Users and Groups) ─

export const auditEntries: AuditLogEntry[] = [
  ["user.group.update", "user", "user-priya", "Priya Raman", maya, 22],
  ["group.update", "group", groupIds.onCall, "on-call", maya, 95],
  ["proxy.update", "proxy_host", routes[1].id, routes[1].domains[0], omar, 140],
  ["ssl.cert.renew", "ssl_certificate", uuid(8001), "grafana.example.com", null, 410],
  ["user.block", "user", "user-alex", "Alex Morgan", omar, 1_520],
  ["docker.container.restart", "docker_container", "c0ffee03a1b2", "worker", lena, 2_210],
  ["database.backup.run", "database", databases[0].id, databases[0].name, maya, 2_880],
  [
    "notification.alert_rule.update",
    "alert_rule",
    uuid(64013),
    "Container restart loop",
    lena,
    3_950,
  ],
].map(([action, resourceType, resourceId, resourceName, actor, minutes], index) => {
  const person = actor as (typeof people)[number] | null;
  return {
    id: uuid(64450 + index),
    userId: person?.id ?? null,
    action: String(action),
    resourceType: String(resourceType),
    resourceId: String(resourceId),
    resourceName: String(resourceName),
    details: null,
    ipAddress: person ? "198.51.100.24" : null,
    userAgent: person ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/131.0" : null,
    createdAt: ago(Number(minutes), "m"),
    userName: person?.name ?? null,
    userEmail: person?.email ?? null,
  };
});

// ── Resource lists the group editor's scope pickers preload ─────────

export const proxyHosts: ProxyHost[] = routes.map(
  (route, index) =>
    ({
      id: route.id,
      slug: route.slug,
      type: "proxy",
      domainNames: [...route.domains],
      enabled: route.enabled,
      maintenanceEnabled: false,
      maintenanceStartedAt: null,
      nodeId: edgeNode.id,
      forwardHost: `10.20.1.${10 + index}`,
      forwardPort: 8080,
      forwardScheme: "http",
      sslEnabled: true,
      sslForced: true,
      http2Support: true,
      sslCertificateId: null,
      internalCertificateId: null,
      websocketSupport: true,
      redirectUrl: null,
      redirectStatusCode: 301,
      customHeaders: [],
      cacheEnabled: false,
      cacheOptions: null,
      rateLimitEnabled: false,
      rateLimitOptions: null,
      customRewrites: [],
      advancedConfig: null,
      rawConfig: null,
      rawConfigEnabled: false,
      accessListId: null,
      folderId: null,
      sortOrder: index,
      nginxTemplateId: null,
      templateVariables: {},
      healthCheckEnabled: true,
      healthCheckUrl: "/healthz",
      healthCheckInterval: 30,
      healthCheckExpectedStatus: 200,
      healthCheckExpectedBody: null,
      healthCheckBodyMatchMode: "includes",
      healthCheckSlowThreshold: 1500,
      healthStatus: route.health,
      lastHealthCheckAt: ago(20, "s"),
      createdById: maya.id,
      createdAt: ago(300 - index * 20, "d"),
      updatedAt: ago(4 + index, "d"),
    }) as unknown as ProxyHost
);

export const databaseConnections: DatabaseConnection[] = databases.map(
  (database, index) =>
    ({
      id: database.id,
      slug: database.slug,
      name: database.name,
      type: database.type,
      description: null,
      tags: [],
      manualSizeLimitMb: null,
      host: `10.20.2.${10 + index}`,
      port: database.type === "redis" ? 6379 : 5432,
      databaseName: database.type === "redis" ? null : database.name.replace(/-/g, "_"),
      username: database.type === "redis" ? null : "gateway",
      tlsEnabled: true,
      healthStatus: "online",
      lastHealthCheckAt: ago(15, "s"),
      lastError: null,
      folderId: null,
      sortOrder: index,
      hasStoredPassword: true,
      config: {},
      createdAt: ago(280 - index * 30, "d"),
      updatedAt: ago(3 + index, "d"),
    }) as unknown as DatabaseConnection
);

export const certificateAuthorities: CA[] = [
  {
    id: uuid(64480),
    parentId: null,
    type: "root",
    status: "active",
    commonName: "Northwind Root CA",
    keyAlgorithm: "ecdsa-p384",
    serialNumber: "3a:91:0c:7e:52:18:44:b0",
    certificatePem: "",
    subjectDn: "CN=Northwind Root CA,O=Northwind",
    issuerDn: null,
    pathLengthConstraint: 1,
    maxValidityDays: 3650,
    notBefore: ago(400, "d"),
    notAfter: ago(-3250, "d"),
    ocspCertPem: null,
    crlNumber: 12,
    lastCrlAt: ago(6, "h"),
    crlDistributionUrl: "https://gateway.example.com/pki/crl/root.crl",
    ocspResponderUrl: null,
    caIssuersUrl: null,
    createdById: maya.id,
    createdAt: ago(400, "d"),
    updatedAt: ago(6, "h"),
    revokedAt: null,
    revocationReason: null,
    certCount: 1,
  },
  {
    id: uuid(64481),
    parentId: uuid(64480),
    type: "intermediate",
    status: "active",
    commonName: "Northwind Services CA",
    keyAlgorithm: "ecdsa-p256",
    serialNumber: "5d:02:a7:e1:9c:33:0f:61",
    certificatePem: "",
    subjectDn: "CN=Northwind Services CA,O=Northwind",
    issuerDn: "CN=Northwind Root CA,O=Northwind",
    pathLengthConstraint: 0,
    maxValidityDays: 397,
    notBefore: ago(399, "d"),
    notAfter: ago(-1426, "d"),
    ocspCertPem: null,
    crlNumber: 48,
    lastCrlAt: ago(2, "h"),
    crlDistributionUrl: "https://gateway.example.com/pki/crl/services.crl",
    ocspResponderUrl: "https://gateway.example.com/pki/ocsp",
    caIssuersUrl: null,
    createdById: maya.id,
    createdAt: ago(399, "d"),
    updatedAt: ago(2, "h"),
    revokedAt: null,
    revocationReason: null,
    certCount: 14,
  },
] as unknown as CA[];
