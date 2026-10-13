import type { ManagedPostgresConfig, ManagedRedisConfig } from '@/db/schema/databases.js';
import type { DatabaseHealthEntry } from '@/db/schema/index.js';
import type { DatabaseType } from './database-error-mapping.js';
export type DatabaseHealthStatus = 'online' | 'offline' | 'degraded' | 'unknown';
/**
 * Server certificate verification for a TLS connection. The persisted source
 * of truth is the connection row; absent fields mean the secure default.
 */
export interface DatabaseTlsVerificationConfig {
  /** Verify the certificate chain and hostname. False is an explicit, insecure opt-out. */
  tlsVerifyCertificate?: boolean;
  /** PEM bundle trusted instead of the public CA bundle. */
  tlsCaCertificate?: string | null;
  /**
   * Runtime-only leaf identity that replaces hostname verification for a
   * managed database reached through a loopback tunnel. Never persisted and
   * never accepted from API input.
   */
  tlsServerIdentity?: string;
}
export interface PostgresConnectionConfig extends DatabaseTlsVerificationConfig {
  type: 'postgres';
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslEnabled: boolean;
}
export interface RedisConnectionConfig extends DatabaseTlsVerificationConfig {
  type: 'redis';
  host: string;
  port: number;
  username: string | null;
  password: string;
  db: number;
  tlsEnabled: boolean;
}
export interface ClickHouseConnectionConfig extends DatabaseTlsVerificationConfig {
  type: 'clickhouse';
  url: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tlsEnabled: boolean;
}
export type DatabaseConnectionConfig = PostgresConnectionConfig | RedisConnectionConfig | ClickHouseConnectionConfig;
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
export interface ManagedDatabaseConnectionMetadata {
  id: string;
  nodeId: string;
  nodeAvailable: boolean;
  version: string;
  /** The engine the store runs: for type redis, valkey or (stores created before 2.12) redis. */
  engine: 'postgres' | 'redis' | 'valkey' | 'clickhouse';
  storageSizeBytes: number;
  runtimeConfig: {
    cpuCores: number;
    memoryMb: number;
    swapMb: number;
  };
  publishedPort: number | null;
  publishedNativePort: number | null;
  publishTcp: boolean;
  publishNativeTcp: boolean;
  tlsEnabled: boolean;
  /** Selected database-node address, available only for a published TCP endpoint. */
  endpointHost: string | null;
  status: 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'error' | 'deleting';
  lastError: string | null;
  /**
   * Published ports another Opfield workload on the node also reserves (the node
   * assigned one that was reserved but not bound yet). Both bind only while the
   * other is stopped; move one of them. Empty when there is no such clash.
   */
  hostPortConflicts?: Array<{ port: number; owner: string }>;
  clickhouseConfigXml?: string;
  redisConfig?: ManagedRedisConfig;
  postgresConfig?: ManagedPostgresConfig;
}
export interface DatabaseConnectionView {
  id: string;
  name: string;
  slug: string;
  type: DatabaseType;
  description: string | null;
  tags: string[];
  manualSizeLimitMb: number | null;
  interactiveQueryBudgetSeconds: number;
  host: string;
  port: number;
  databaseName: string | null;
  username: string | null;
  tlsEnabled: boolean;
  tlsVerifyCertificate: boolean;
  tlsCaCertificate: string | null;
  healthStatus: DatabaseHealthStatus;
  lastHealthCheckAt: string | null;
  lastError: string | null;
  healthHistory?: DatabaseHealthEntry[];
  folderId: string | null;
  sortOrder: number;
  hasStoredPassword: boolean;
  config: Record<string, unknown>;
  capabilities: DatabaseCapabilities;
  managed?: ManagedDatabaseConnectionMetadata;
  createdById: string;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
}
