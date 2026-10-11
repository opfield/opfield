/**
 * Databases of the fictional installation: the three catalog databases (two
 * managed on db-1, one analytics warehouse) plus external connections, with a
 * mix of healthy and attention states.
 */
import type {
  DatabaseCapabilities,
  DatabaseConnection,
  DatabaseHealthEntry,
  DatabaseMetricSnapshot,
  ManagedCertificateStatus,
  ManagedDatabase,
  ManagedPostgresExtension,
  ResourceFolderTreeNode,
} from "@/types";
import { databases as catalogDatabases, people } from "../catalog";
import { nodeBySlug } from "../nodes";
import { ago, agoMs, ahead, uuid } from "../time";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const dbNode = nodeBySlug("db-1")!;

const [ordersCatalog, sessionsCatalog, analyticsCatalog] = catalogDatabases;

const SQL_CAPABILITIES: DatabaseCapabilities = {
  sqlConsole: true,
  commandConsole: false,
  catalogExplorer: true,
  rowInsert: true,
  rowUpdate: true,
  rowDelete: true,
  schemaMutation: true,
  exactRowCount: true,
};

const REDIS_CAPABILITIES: DatabaseCapabilities = {
  sqlConsole: false,
  commandConsole: true,
  catalogExplorer: false,
  rowInsert: false,
  rowUpdate: false,
  rowDelete: false,
  schemaMutation: false,
  exactRowCount: false,
};

const CLICKHOUSE_CAPABILITIES: DatabaseCapabilities = {
  ...SQL_CAPABILITIES,
  rowUpdate: false,
  rowDelete: false,
  exactRowCount: false,
};

/** Health checks every five minutes over the last day, with the given incidents. */
export function databaseHealthHistory(
  incidents: Array<{ from: number; to: number; status: DatabaseHealthEntry["status"] }> = [],
  baseResponseMs = 4
): DatabaseHealthEntry[] {
  const count = 288;
  return Array.from({ length: count }, (_, index) => {
    const minutesAgo = (count - index) * 5;
    const incident = incidents.find((item) => minutesAgo <= item.from && minutesAgo >= item.to);
    const responseMs = baseResponseMs + ((index * 7) % 5);
    return {
      ts: ago(minutesAgo, "m"),
      status: incident?.status ?? "online",
      responseMs: incident?.status === "offline" ? undefined : responseMs,
      ...(incident?.status === "degraded" ? { slow: true } : {}),
    };
  });
}

const managedFolderId = uuid(3101);
const externalFolderId = uuid(3102);

export const databaseFolders: ResourceFolderTreeNode[] = [
  {
    id: managedFolderId,
    name: "Production",
    parentId: null,
    sortOrder: 0,
    depth: 0,
    createdAt: ago(180, "d"),
    updatedAt: ago(30, "d"),
    children: [],
  },
  {
    id: externalFolderId,
    name: "Partners",
    parentId: null,
    sortOrder: 1,
    depth: 0,
    createdAt: ago(120, "d"),
    updatedAt: ago(40, "d"),
    children: [],
  },
];

function base(
  overrides: Partial<DatabaseConnection> &
    Pick<DatabaseConnection, "id" | "slug" | "name" | "type" | "host" | "port" | "config">
): DatabaseConnection {
  return {
    description: null,
    tags: [],
    manualSizeLimitMb: null,
    interactiveQueryBudgetSeconds: 30,
    databaseName: null,
    username: null,
    tlsEnabled: true,
    tlsVerifyCertificate: true,
    tlsCaCertificate: null,
    healthStatus: "online",
    lastHealthCheckAt: ago(40, "s"),
    lastError: null,
    folderId: null,
    sortOrder: 0,
    hasStoredPassword: true,
    capabilities: SQL_CAPABILITIES,
    createdById: people[0].id,
    updatedById: people[1].id,
    createdAt: ago(160, "d"),
    updatedAt: ago(3, "d"),
    ...overrides,
  };
}

export const ordersDb = base({
  id: ordersCatalog.id,
  slug: ordersCatalog.slug,
  name: ordersCatalog.name,
  type: "postgres",
  description: "Order, payment and fulfilment records for the storefront.",
  tags: ["green:production", "blue:orders", "pii"],
  host: "198.51.100.15",
  port: 5433,
  databaseName: "orders",
  username: "orders_app",
  folderId: managedFolderId,
  sortOrder: 0,
  lastHealthCheckAt: ago(25, "s"),
  config: {
    host: "198.51.100.15",
    port: 5433,
    database: "orders",
    username: "orders_app",
    password: "",
    sslEnabled: true,
  },
  managed: {
    id: uuid(3111),
    nodeId: dbNode.id,
    nodeAvailable: true,
    version: "17.8",
    storageSizeBytes: 40 * GiB,
    runtimeConfig: { cpuCores: 2, memoryMb: 4096, swapMb: 1024 },
    publishedPort: 5433,
    publishedNativePort: null,
    publishTcp: true,
    publishNativeTcp: false,
    tlsEnabled: true,
    endpointHost: "198.51.100.15",
    status: "ready",
    lastError: null,
  },
  healthHistory: databaseHealthHistory([{ from: 610, to: 590, status: "degraded" }]),
});

export const sessionsDb = base({
  id: sessionsCatalog.id,
  slug: sessionsCatalog.slug,
  name: sessionsCatalog.name,
  type: "redis",
  description: "Web session and rate-limit store.",
  tags: ["green:production", "cache"],
  host: "gw-db-sessions",
  port: 6379,
  databaseName: "0",
  username: "default",
  folderId: managedFolderId,
  sortOrder: 1,
  lastHealthCheckAt: ago(18, "s"),
  capabilities: REDIS_CAPABILITIES,
  config: {
    host: "gw-db-sessions",
    port: 6379,
    username: "default",
    password: "",
    db: 0,
    tlsEnabled: true,
  },
  managed: {
    id: uuid(3112),
    nodeId: dbNode.id,
    nodeAvailable: true,
    version: "9.1.2",
    engine: "valkey",
    storageSizeBytes: 8 * GiB,
    runtimeConfig: { cpuCores: 1, memoryMb: 2048, swapMb: 0 },
    publishedPort: null,
    publishedNativePort: null,
    publishTcp: false,
    publishNativeTcp: false,
    tlsEnabled: true,
    endpointHost: null,
    status: "ready",
    lastError: null,
  },
});

export const analyticsDb = base({
  id: analyticsCatalog.id,
  slug: analyticsCatalog.slug,
  name: analyticsCatalog.name,
  type: "postgres",
  description: "Nightly reporting warehouse fed from orders-db.",
  tags: ["purple:analytics", "reporting"],
  host: "gw-db-analytics",
  port: 5432,
  databaseName: "analytics",
  username: "analyst",
  folderId: managedFolderId,
  sortOrder: 2,
  healthStatus: "degraded",
  lastHealthCheckAt: ago(1, "m"),
  lastError: "Health check took 1 840 ms (slow threshold 1 000 ms)",
  config: {
    host: "gw-db-analytics",
    port: 5432,
    database: "analytics",
    username: "analyst",
    password: "",
    sslEnabled: true,
  },
  managed: {
    id: uuid(3113),
    nodeId: dbNode.id,
    nodeAvailable: true,
    version: "16.10",
    storageSizeBytes: 120 * GiB,
    runtimeConfig: { cpuCores: 4, memoryMb: 8192, swapMb: 2048 },
    publishedPort: null,
    publishedNativePort: null,
    publishTcp: false,
    publishNativeTcp: false,
    tlsEnabled: true,
    endpointHost: null,
    status: "ready",
    lastError: null,
  },
});

export const eventsDb = base({
  id: uuid(3104),
  slug: "events-warehouse",
  name: "events-warehouse",
  type: "clickhouse",
  description: "Clickstream events from the storefront.",
  tags: ["purple:analytics", "yellow:beta"],
  host: "clickhouse.example.net",
  port: 8443,
  databaseName: "events",
  username: "gateway_reader",
  sortOrder: 3,
  lastHealthCheckAt: ago(2, "m"),
  capabilities: CLICKHOUSE_CAPABILITIES,
  config: {
    url: "https://clickhouse.example.net:8443",
    host: "clickhouse.example.net",
    port: 8443,
    database: "events",
    username: "gateway_reader",
    password: "",
    tlsEnabled: true,
  },
});

export const billingDb = base({
  id: uuid(3105),
  slug: "billing-replica",
  name: "billing-replica",
  type: "postgres",
  description: "Read replica provided by the payments partner.",
  tags: ["orange:external", "billing"],
  host: "pg.billing.example.org",
  port: 5432,
  databaseName: "billing",
  username: "northwind_ro",
  folderId: externalFolderId,
  sortOrder: 0,
  lastHealthCheckAt: ago(4, "m"),
  config: {
    host: "pg.billing.example.org",
    port: 5432,
    database: "billing",
    username: "northwind_ro",
    password: "",
    sslEnabled: true,
  },
});

export const legacyDb = base({
  id: uuid(3106),
  slug: "legacy-crm",
  name: "legacy-crm",
  type: "postgres",
  description: "Old CRM database kept for exports until the migration closes.",
  tags: ["gray:deprecated"],
  host: "203.0.113.52",
  port: 5432,
  databaseName: "crm",
  username: "crm_export",
  folderId: externalFolderId,
  sortOrder: 1,
  tlsEnabled: false,
  healthStatus: "offline",
  lastHealthCheckAt: ago(3, "m"),
  lastError: "connect ECONNREFUSED 203.0.113.52:5432",
  config: {
    host: "203.0.113.52",
    port: 5432,
    database: "crm",
    username: "crm_export",
    password: "",
    sslEnabled: false,
  },
});

export const cacheDb = base({
  id: uuid(3107),
  slug: "rate-limits",
  name: "rate-limits",
  type: "redis",
  tags: ["blue:edge"],
  host: "redis.example.com",
  port: 6380,
  databaseName: "2",
  username: null,
  sortOrder: 4,
  lastHealthCheckAt: ago(35, "s"),
  capabilities: REDIS_CAPABILITIES,
  config: {
    host: "redis.example.com",
    port: 6380,
    username: null,
    password: "",
    db: 2,
    tlsEnabled: true,
  },
});

export const databaseRows: DatabaseConnection[] = [
  ordersDb,
  sessionsDb,
  analyticsDb,
  eventsDb,
  cacheDb,
  billingDb,
  legacyDb,
];

export const databaseById = (id: string) => databaseRows.find((row) => row.id === id);
export const databaseBySlug = (slug: string) => databaseRows.find((row) => row.slug === slug);

export const managedDatabases: ManagedDatabase[] = databaseRows
  .filter((row) => row.managed)
  .map((row) => ({
    id: row.managed!.id,
    databaseConnectionId: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    version: row.managed!.version,
    engine: row.managed!.engine,
    nodeId: row.managed!.nodeId,
    storageSizeBytes: row.managed!.storageSizeBytes,
    runtimeConfig: row.managed!.runtimeConfig,
    publishedPort: row.managed!.publishedPort,
    publishedNativePort: row.managed!.publishedNativePort,
    tlsEnabled: row.managed!.tlsEnabled,
    status: row.managed!.status,
    lastError: row.managed!.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));

export const managedDatabaseCatalog = [
  { type: "postgres" as const, versions: ["18.4", "17.8", "16.10", "15.14"] },
  { type: "redis" as const, versions: ["9.1.2"] },
  { type: "clickhouse" as const, versions: ["26.3.17.56", "25.8.28.1"] },
];

/** One hour of per-minute monitoring samples for the orders database. */
export function ordersMonitoringHistory(): DatabaseMetricSnapshot[] {
  return Array.from({ length: 60 }, (_, index) => {
    const wave = Math.sin(index / 5);
    const drift = Math.cos(index / 11);
    const total = Math.round(38 + wave * 9 + (index % 4));
    return {
      timestamp: new Date(agoMs(60 - index, "m")).toISOString(),
      databaseId: ordersDb.id,
      type: "postgres",
      name: ordersDb.name,
      status: "online",
      responseMs: 3 + (index % 3),
      metrics: {
        latency_ms: 3 + (index % 3) + Math.max(0, wave),
        active_connections: Math.round(6 + wave * 3 + (index % 3)),
        total_connections: total,
        max_connections: 200,
        total_connections_pct: (total / 200) * 100,
        database_size_bytes: 14.2 * GiB + index * 6 * MiB,
        lock_count: Math.round(3 + Math.abs(wave) * 4),
        long_running_queries: index === 47 ? 1 : 0,
        transaction_rate: 182 + wave * 34 + drift * 12,
        cache_hit_ratio: 99.2 + drift * 0.4,
        read_blocks_per_sec: 38 + Math.abs(wave) * 22,
        write_blocks_per_sec: 21 + Math.abs(drift) * 9,
        managed_cpu_percent: 23 + wave * 9 + (index % 5),
        managed_memory_usage_bytes: (2.1 + drift * 0.2) * GiB,
        managed_memory_limit_bytes: 4 * GiB,
        managed_swap_usage_bytes: 36 * MiB,
        managed_swap_limit_bytes: 1024 * MiB,
        managed_pids: 41 + (index % 6),
      },
    };
  });
}

export const ordersCertificate: ManagedCertificateStatus = {
  ownerType: "managed_database",
  ownerId: ordersDb.managed!.id,
  certificate: {
    id: uuid(3121),
    serialNumber: "4f:1c:9a:2e:77:03:b1:5d",
    notBefore: ago(29, "d"),
    notAfter: ahead(61, "d"),
    daysRemaining: 61,
    sans: ["198.51.100.15", "orders-db.db-1.internal"],
  },
  renewal: {
    state: "idle",
    reason: null,
    due: false,
    dueReason: null,
    urgent: false,
    hotReloadSupported: true,
    skipReason: null,
    attempts: 0,
    lastAttemptAt: ago(29, "d"),
    nextAttemptAt: null,
    deliveredAt: ago(29, "d"),
    lastSuccessAt: ago(29, "d"),
    lastError: null,
    lastMethod: "hot_reload",
    lastRestarted: false,
    pendingSerial: null,
  },
};

export const ordersExtensions: ManagedPostgresExtension[] = [
  { name: "plpgsql", defaultVersion: "1.0", installedVersion: "1.0", comment: "PL/pgSQL procedural language" },
  { name: "pg_stat_statements", defaultVersion: "1.11", installedVersion: "1.11", comment: "track planning and execution statistics of all SQL statements executed" },
  { name: "pgcrypto", defaultVersion: "1.3", installedVersion: "1.3", comment: "cryptographic functions" },
  { name: "uuid-ossp", defaultVersion: "1.1", installedVersion: null, comment: "generate universally unique identifiers (UUIDs)" },
  { name: "pg_trgm", defaultVersion: "1.6", installedVersion: "1.6", comment: "text similarity measurement and index searching based on trigrams" },
  { name: "postgis", defaultVersion: "3.5.2", installedVersion: null, comment: "PostGIS geometry and geography spatial types and functions" },
];
