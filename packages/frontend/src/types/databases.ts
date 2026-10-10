import type { AppMembershipRef } from "./apps";
// Databases
export type DatabaseType = "postgres" | "redis" | "clickhouse";
export type DatabaseHealthStatus = "online" | "offline" | "degraded" | "unknown";
export type ManagedDatabaseStatus =
  | "creating"
  | "updating"
  | "ready"
  | "paused"
  | "stopped"
  | "error"
  | "deleting";

/** A database provisioned on a dedicated Gateway databases node. Credentials are never returned here. */
export interface ManagedDatabase {
  id: string;
  databaseConnectionId: string;
  slug: string;
  name: string;
  type: DatabaseType;
  version: string;
  nodeId: string;
  storageSizeBytes: string | number;
  runtimeConfig: { cpuCores: number; memoryMb: number; swapMb: number };
  publishedPort: number | null;
  publishedNativePort: number | null;
  tlsEnabled: boolean;
  status: ManagedDatabaseStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedDatabaseCatalogEntry {
  type: DatabaseType;
  versions: string[];
}

export type ManagedRedisEvictionPolicy =
  | "noeviction"
  | "allkeys-lru"
  | "allkeys-lfu"
  | "allkeys-random"
  | "volatile-lru"
  | "volatile-lfu"
  | "volatile-random"
  | "volatile-ttl";

export interface ManagedRedisConfig {
  maxmemoryPercent: number;
  maxmemoryPolicy: ManagedRedisEvictionPolicy;
  appendOnly: boolean;
  appendFsync: "always" | "everysec" | "no";
  rdbSnapshotsEnabled: boolean;
  rdbSaveSeconds: number;
  rdbSaveChanges: number;
  autoAofRewritePercentage: number;
  autoAofRewriteMinSizeMb: number;
  maxclients: number;
  timeoutSeconds: number;
  tcpKeepaliveSeconds: number;
  slowlogThresholdMicroseconds: number;
  slowlogMaxLen: number;
  activeDefrag: boolean;
}

export const DEFAULT_MANAGED_REDIS_CONFIG: ManagedRedisConfig = {
  maxmemoryPercent: 75,
  maxmemoryPolicy: "noeviction",
  appendOnly: true,
  appendFsync: "everysec",
  rdbSnapshotsEnabled: true,
  rdbSaveSeconds: 3600,
  rdbSaveChanges: 1,
  autoAofRewritePercentage: 100,
  autoAofRewriteMinSizeMb: 64,
  maxclients: 10_000,
  timeoutSeconds: 0,
  tcpKeepaliveSeconds: 300,
  slowlogThresholdMicroseconds: 10_000,
  slowlogMaxLen: 128,
  activeDefrag: false,
};

export interface ManagedPostgresConfig {
  maxConnections: number;
}

export const MANAGED_POSTGRES_MIN_CONNECTIONS = 20;
export const MANAGED_POSTGRES_MAX_CONNECTIONS = 10_000;
export const DEFAULT_MANAGED_POSTGRES_CONFIG: ManagedPostgresConfig = { maxConnections: 100 };

export interface ManagedDatabaseCreateInput {
  name: string;
  folderId?: string | null;
  type: DatabaseType;
  version: string;
  nodeId: string;
  storageSizeGb: number;
  cpuCores: number;
  memoryMb: number;
  swapMb: number;
  tags?: string[];
  publishTcp: boolean;
  publishNativeTcp?: boolean;
  publishedPort?: number;
  publishedNativePort?: number;
  tlsEnabled?: boolean;
  clickhouseConfigXml?: string;
  redisConfig?: ManagedRedisConfig;
  postgresConfig?: ManagedPostgresConfig;
}

export type ManagedDatabaseBindingTargetType = "container" | "deployment" | "compose_service";

export interface ManagedDatabaseBindingEnvironment {
  connectionUri?: string;
  host?: string;
  port?: string;
  database?: string;
  username?: string;
  password?: string;
}

export interface ManagedDatabaseBinding {
  id: string;
  managedDatabaseId: string;
  targetNodeId: string;
  targetType: ManagedDatabaseBindingTargetType;
  targetResourceId: string;
  environment: ManagedDatabaseBindingEnvironment;
  status: "creating" | "ready" | "error" | "deleting";
  observedState?:
    | "legacy"
    | "preparing"
    | "principal_ready"
    | "target_applied"
    | "active"
    | "disabled"
    | "absent"
    | "error";
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A managed link's connections as the node running its workloads reports them. The node holds the link at its
 * capacity whichever relay of the pool carries a connection.
 */
export interface ManagedLinkConnections {
  active: number;
  limit: number;
  /** Connections the node refused at the link's or the node's limit; part of throttledTotal. */
  rejectedTotal: string;
  lastRejectionReason: string | null;
  lastRejectedAt: string | null;
  /** Sessions and bytes the link carried through the node; the runtime's openedTotal and byte counters. */
  openedTotal: string;
  sourceToTargetBytes: string;
  targetToSourceBytes: string;
  reportedAt: string;
}

export interface ManagedDatabaseBindingRuntime {
  routeId: string;
  activeStreams: number;
  openedTotal: string;
  completedTotal: string;
  failedTotal: string;
  throttledTotal: string;
  sourceToTargetBytes: string;
  targetToSourceBytes: string;
  setupLatencyP95Ms: number;
  averageDurationMs: number;
  lastActivityAt: string | null;
  metricsSince: string;
  /** Null while the node running the workload does not report its links (an older daemon). */
  connections?: ManagedLinkConnections | null;
  /**
   * False when a relay that holds the link's routes did not answer: failures, setup p95, duration and admission
   * rejects are unknown, and so are the stream and byte counters without `connections`.
   */
  relayCountersComplete?: boolean;
}

export interface ManagedDatabaseBindingRuntimeStatus {
  binding: ManagedDatabaseBinding;
  runtime: ManagedDatabaseBindingRuntime | null;
}

export interface ManagedDatabaseBindingCreateInput {
  targetNodeId: string;
  targetType: ManagedDatabaseBindingTargetType;
  targetResourceId: string;
  environment: ManagedDatabaseBindingEnvironment;
  /** Explicit acknowledgement that colliding ordinary env/secrets are replaced. */
  replaceExistingEnvironment?: boolean;
  /** Full ordinary environment draft saved with the binding update. */
  targetEnvironment?: Record<string, string>;
}

export interface ManagedDatabaseBindingDeleteInput {
  /** Full ordinary environment draft saved with the binding removal. */
  targetEnvironment?: Record<string, string>;
}

export interface DatabaseHealthEntry {
  ts: string;
  status: DatabaseHealthStatus;
  responseMs?: number;
  slow?: boolean;
}

export interface PostgresDatabaseConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslEnabled: boolean;
}

export interface RedisDatabaseConfig {
  host: string;
  port: number;
  username: string | null;
  password: string;
  db: number;
  tlsEnabled: boolean;
}

export interface ClickHouseDatabaseConfig {
  url: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tlsEnabled: boolean;
}

export interface DatabaseCapabilities {
  sqlConsole: boolean;
  commandConsole: boolean;
  catalogExplorer: boolean;
  rowInsert: boolean;
  rowUpdate: boolean;
  rowDelete: boolean;
  schemaMutation: boolean;
  exactRowCount: boolean;
}

export interface DatabaseConnection {
  /** Set when the resource is a member of an app environment. */
  app?: AppMembershipRef | null;
  id: string;
  slug: string;
  name: string;
  type: DatabaseType;
  description: string | null;
  tags: string[];
  manualSizeLimitMb: number | null;
  interactiveQueryBudgetSeconds?: number;
  host: string;
  port: number;
  databaseName: string | null;
  username: string | null;
  tlsEnabled: boolean;
  /** Server certificate verification when TLS is used. False is an explicit, insecure opt-out. */
  tlsVerifyCertificate?: boolean;
  /** PEM CA bundle trusted instead of the public CA bundle. */
  tlsCaCertificate?: string | null;
  healthStatus: DatabaseHealthStatus;
  lastHealthCheckAt: string | null;
  lastError: string | null;
  healthHistory?: DatabaseHealthEntry[];
  folderId?: string | null;
  sortOrder?: number;
  hasStoredPassword: boolean;
  config: PostgresDatabaseConfig | RedisDatabaseConfig | ClickHouseDatabaseConfig;
  capabilities?: DatabaseCapabilities;
  managed?: {
    id: string;
    nodeId: string;
    nodeAvailable?: boolean;
    version: string;
    storageSizeBytes: number;
    runtimeConfig: { cpuCores: number; memoryMb: number; swapMb: number };
    publishedPort: number | null;
    publishedNativePort: number | null;
    publishTcp?: boolean;
    publishNativeTcp?: boolean;
    tlsEnabled: boolean;
    endpointHost: string | null;
    status: ManagedDatabaseStatus;
    lastError: string | null;
    clickhouseConfigXml?: string;
    redisConfig?: ManagedRedisConfig;
    postgresConfig?: ManagedPostgresConfig;
  };
  createdById: string;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseMetricSnapshot {
  timestamp: string;
  databaseId: string;
  type: DatabaseType;
  name: string;
  status: DatabaseHealthStatus;
  responseMs: number;
  metrics: Record<string, number | null>;
}

export interface ManagedPostgresExtension {
  name: string;
  defaultVersion: string;
  installedVersion: string | null;
  comment: string | null;
}

export interface PostgresTableColumn {
  name: string;
  dataType: string;
  udtName: string;
  udtSchema: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  hasDefault: boolean;
}

export interface PostgresTableMetadata {
  schema: string;
  table: string;
  columns: PostgresTableColumn[];
  primaryKey: string[];
  hasPrimaryKey: boolean;
}

export interface SqlNamespace {
  name: string;
  system: boolean;
}

export interface SqlObjectSummary {
  name: string;
  type: "table" | "view" | "materialized-view" | "dictionary" | "other";
  engine?: string;
  estimatedRows?: number | null;
  estimatedBytes?: number | null;
}

export interface SqlColumnMetadata {
  name: string;
  dataType: string;
  nativeTypeName?: string;
  nativeTypeNamespace?: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isSortingKey?: boolean;
  isPartitionKey?: boolean;
  hasDefault: boolean;
  defaultExpression?: string | null;
  comment?: string | null;
}

export interface SqlTableMutationCapabilities {
  rowInsert: boolean;
  rowUpdate: boolean;
  rowDelete: boolean;
  identityColumns: string[];
  immutableColumns: string[];
  reason?: string;
}

export interface SqlTableMetadata {
  provider: "postgres" | "clickhouse";
  namespace: string;
  table: string;
  objectType: SqlObjectSummary["type"];
  engine?: string;
  columns: SqlColumnMetadata[];
  primaryKey: string[];
  hasPrimaryKey: boolean;
  sortingKey?: string | null;
  partitionKey?: string | null;
  providerMetadata?: Record<string, unknown>;
  mutations: SqlTableMutationCapabilities;
}

export interface SqlBrowseResult {
  metadata: SqlTableMetadata;
  rows: Record<string, unknown>[];
  page: number;
  limit: number;
  total: number | null;
  totalKind: "exact" | "approximate" | "unavailable";
  truncated: boolean;
}

export interface SqlExecutionResult {
  results: Array<{
    command: string;
    queryId?: string;
    rowCount: number;
    durationMs: number;
    fields: string[];
    columns: Array<{ name: string; type: string }>;
    rows: Record<string, unknown>[];
    truncated: boolean;
    maxRows: number;
    statistics?: Record<string, number>;
  }>;
  truncated: boolean;
  resultLimit: number;
}

export interface SqlRowMutationResult {
  success: true;
  affectedRows: number;
  queryId?: string;
}

export interface RedisKeyRecord {
  key: string;
  type: string;
  ttlSeconds: number;
}
