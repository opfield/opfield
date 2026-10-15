import type { ClickHouseClient } from '@clickhouse/client';
import type Redis from 'ioredis';
import type pg from 'pg';
import type { DrizzleClient } from '@/db/client.js';
import type { DatabaseHealthEntry } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { DatabaseCAService } from '@/services/database-ca.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { PaginatedResponse } from '@/types.js';
import type {
  DatabaseConnectionConfig,
  DatabaseConnectionView,
  DatabaseHealthStatus,
} from './database-connection-view.js';
import type {
  CreateDatabaseConnectionInput,
  DatabaseListQuery,
  UpdateDatabaseConnectionInput,
} from './databases.schemas.js';
import type { PostgresRowSearchFilter, SqlQueryAccess } from './databases.service.shared.js';
import type { ManagedDatabaseTunnelLane, ManagedDatabaseTunnelProxy } from './managed-database-tunnel-proxy.js';
import type { RedisKeyValueType } from './redis-key-operations.js';
import type { SqlExecutionOptions } from './sql-database-adapter.js';

export * from './databases.service.shared.js';
export class DatabaseConnectionService {
  // biome-ignore lint/complexity/noUselessConstructor: Stable commercial service constructor contract.
  constructor(
    _db: DrizzleClient,
    _auditService: AuditService,
    _cryptoService: CryptoService,
    _managedTunnelProxy?: ManagedDatabaseTunnelProxy | undefined
  ) {}
  setEventBus(_bus: EventBusService): void {}
  /** Trust anchor for the TLS endpoints of managed databases Opfield provisions. */
  setDatabaseCA(_databaseCA: Pick<DatabaseCAService, 'getDatabaseCA'>): void {}
  async getDecryptedConfig(
    _id: string,
    _lane?: ManagedDatabaseTunnelLane,
    _queryAccess?: SqlQueryAccess
  ): Promise<DatabaseConnectionConfig> {
    return commercialModuleUnavailable();
  }
  async listAllRows(): Promise<
    {
      id: string;
      name: string;
      slug: string;
      type: 'postgres' | 'redis' | 'clickhouse';
      description: string | null;
      tags: string[];
      host: string;
      port: number;
      databaseName: string | null;
      username: string | null;
      tlsEnabled: boolean;
      tlsVerifyCertificate: boolean;
      tlsCaCertificate: string | null;
      manualSizeLimitMb: number | null;
      interactiveQueryBudgetSeconds: number;
      encryptedConfig: string;
      healthStatus: 'online' | 'offline' | 'degraded' | 'unknown';
      lastHealthCheckAt: Date | null;
      lastError: string | null;
      healthHistory: DatabaseHealthEntry[];
      folderId: string | null;
      sortOrder: number;
      createdById: string;
      updatedById: string | null;
      createdAt: Date;
      updatedAt: Date;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async updateHealth(
    _id: string,
    _patch: {
      status: DatabaseHealthStatus;
      responseMs?: number;
      lastError?: string | null;
      forceHistory?: boolean;
    }
  ): Promise<void> {
    return commercialModuleUnavailable();
  }
  async getPostgresPool(_id: string, _lane?: ManagedDatabaseTunnelLane): Promise<pg.Pool> {
    return commercialModuleUnavailable();
  }
  async getRedisClient(_id: string, _lane?: ManagedDatabaseTunnelLane): Promise<Redis> {
    return commercialModuleUnavailable();
  }
  async getClickHouseClient(
    _id: string,
    _lane?: ManagedDatabaseTunnelLane,
    _queryAccess?: SqlQueryAccess
  ): Promise<ClickHouseClient> {
    return commercialModuleUnavailable();
  }
  async disposeClient(_id: string): Promise<void> {}
  async getSqlCapabilities(
    _id: string,
    _access?: SqlQueryAccess
  ): Promise<import('./sql-database-adapter.js').SqlProviderCapabilities> {
    return commercialModuleUnavailable();
  }
  async inferSqlIntent(_id: string, _sql: string): Promise<import('./sql-database-adapter.js').DatabaseQueryIntent> {
    return commercialModuleUnavailable();
  }
  async listSqlNamespaces(
    _id: string,
    _access?: SqlQueryAccess
  ): Promise<import('./sql-database-adapter.js').SqlNamespace[]> {
    return commercialModuleUnavailable();
  }
  async listSqlObjects(
    _id: string,
    _namespace: string,
    _access?: SqlQueryAccess
  ): Promise<import('./sql-database-adapter.js').SqlObjectSummary[]> {
    return commercialModuleUnavailable();
  }
  async getSqlTableMetadata(
    _id: string,
    _namespace: string,
    _table: string,
    _access?: SqlQueryAccess
  ): Promise<import('./sql-database-adapter.js').SqlTableMetadata> {
    return commercialModuleUnavailable();
  }
  async browseSqlRows(
    _id: string,
    _namespace: string,
    _table: string,
    _page: number,
    _limit: number,
    _options?: {
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      search?: PostgresRowSearchFilter;
    },
    _access?: SqlQueryAccess
  ): Promise<import('./sql-database-adapter.js').SqlBrowseResult> {
    return commercialModuleUnavailable();
  }
  async executeSql(
    _id: string,
    _sql: string,
    _userId: string,
    _options?: SqlExecutionOptions,
    _access?: SqlQueryAccess
  ): Promise<import('./sql-database-adapter.js').SqlExecutionResult> {
    return commercialModuleUnavailable();
  }
  async insertSqlRow(
    _id: string,
    _namespace: string,
    _table: string,
    _values: Record<string, unknown>,
    _userId: string,
    _access?: SqlQueryAccess
  ): Promise<import('./sql-database-adapter.js').SqlRowMutationResult> {
    return commercialModuleUnavailable();
  }
  async updateSqlRow(
    _id: string,
    _namespace: string,
    _table: string,
    _locator: Record<string, unknown>,
    _values: Record<string, unknown>,
    _userId: string,
    _access?: SqlQueryAccess
  ): Promise<import('./sql-database-adapter.js').SqlRowMutationResult> {
    return commercialModuleUnavailable();
  }
  async deleteSqlRow(
    _id: string,
    _namespace: string,
    _table: string,
    _locator: Record<string, unknown>,
    _userId: string,
    _access?: SqlQueryAccess
  ): Promise<import('./sql-database-adapter.js').SqlRowMutationResult> {
    return commercialModuleUnavailable();
  }
  async list(
    _query: DatabaseListQuery,
    _options?: {
      allowedIds?: string[];
    }
  ): Promise<PaginatedResponse<DatabaseConnectionView>> {
    return commercialModuleUnavailable();
  }
  async get(_id: string, _revealCredentials?: boolean): Promise<DatabaseConnectionView> {
    return commercialModuleUnavailable();
  }
  async getBySlug(_slug: string): Promise<DatabaseConnectionView> {
    return commercialModuleUnavailable();
  }
  async getHealthHistory(_id: string): Promise<DatabaseHealthEntry[]> {
    return commercialModuleUnavailable();
  }
  async revealCredentials(_id: string): Promise<Record<string, unknown>> {
    return commercialModuleUnavailable();
  }
  async create(_input: CreateDatabaseConnectionInput, _userId: string): Promise<DatabaseConnectionView> {
    return commercialModuleUnavailable();
  }
  async update(_id: string, _input: UpdateDatabaseConnectionInput, _userId: string): Promise<DatabaseConnectionView> {
    return commercialModuleUnavailable();
  }
  async delete(_id: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async testSavedConnection(
    _id: string,
    _userId: string
  ): Promise<{
    ok: true;
    responseMs: number;
    status: DatabaseHealthStatus;
  }> {
    return commercialModuleUnavailable();
  }
  async listPostgresSchemas(_id: string): Promise<string[]> {
    return commercialModuleUnavailable();
  }
  async listPostgresTables(
    _id: string,
    _schema: string
  ): Promise<
    {
      name: string;
      type: 'view' | 'table';
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async getPostgresTableMetadata(
    _id: string,
    _schema: string,
    _table: string
  ): Promise<import('./postgres-row-operations.js').PostgresTableMetadata> {
    return commercialModuleUnavailable();
  }
  async browsePostgresRows(
    _id: string,
    _schema: string,
    _table: string,
    _page: number,
    _limit: number,
    _sortBy?: string,
    _sortOrder?: 'asc' | 'desc',
    _search?: PostgresRowSearchFilter
  ): Promise<{
    metadata: import('./postgres-row-operations.js').PostgresTableMetadata;
    rows: any[];
    total: number;
    page: number;
    limit: number;
  }> {
    return commercialModuleUnavailable();
  }
  async insertPostgresRow(
    _id: string,
    _schema: string,
    _table: string,
    _values: Record<string, unknown>,
    _userId: string
  ): Promise<any> {
    return commercialModuleUnavailable();
  }
  async updatePostgresRow(
    _id: string,
    _schema: string,
    _table: string,
    _primaryKey: Record<string, unknown>,
    _values: Record<string, unknown>,
    _userId: string
  ): Promise<any> {
    return commercialModuleUnavailable();
  }
  async deletePostgresRow(
    _id: string,
    _schema: string,
    _table: string,
    _primaryKey: Record<string, unknown>,
    _userId: string
  ): Promise<{
    success: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async updatePostgresColumnType(
    _id: string,
    _schema: string,
    _table: string,
    _column: string,
    _dataType: string,
    _userId: string
  ): Promise<import('./postgres-row-operations.js').PostgresTableMetadata> {
    return commercialModuleUnavailable();
  }
  async addPostgresColumn(
    _id: string,
    _schema: string,
    _table: string,
    _column: string,
    _dataType: string,
    _userId: string
  ): Promise<import('./postgres-row-operations.js').PostgresTableMetadata> {
    return commercialModuleUnavailable();
  }
  async deletePostgresColumn(
    _id: string,
    _schema: string,
    _table: string,
    _column: string,
    _userId: string
  ): Promise<import('./postgres-row-operations.js').PostgresTableMetadata> {
    return commercialModuleUnavailable();
  }
  async executePostgresSql(
    _id: string,
    _sqlText: string,
    _userId: string,
    _options?: {
      maxRows?: number;
      queryAccess?: SqlQueryAccess;
    }
  ): Promise<{
    results: {
      command: string;
      rowCount: number;
      durationMs: number;
      fields: string[];
      rows: Record<string, unknown>[];
      truncated: boolean;
      maxRows: number;
    }[];
    truncated: boolean;
    resultLimit: number;
  }> {
    return commercialModuleUnavailable();
  }
  async scanRedisKeys(
    _id: string,
    _cursor: number,
    _limit: number,
    _search?: string,
    _type?: string
  ): Promise<{
    cursor: number;
    done: boolean;
    keys: {
      key: string;
      type: string;
      ttlSeconds: number;
    }[];
  }> {
    return commercialModuleUnavailable();
  }
  async getRedisKey(
    _id: string,
    _key: string,
    _options?: {
      offset?: number;
      limit?: number;
      maxStringBytes?: number;
    }
  ): Promise<{
    key: string;
    type: string;
    ttlSeconds: number;
    value: unknown;
    page: Record<string, unknown> | undefined;
  }> {
    return commercialModuleUnavailable();
  }
  async setRedisKey(
    _id: string,
    _key: string,
    _valueType: RedisKeyValueType,
    _value: unknown,
    _ttlSeconds: number | undefined,
    _userId: string
  ): Promise<{
    key: string;
    type: string;
    ttlSeconds: number;
    value: unknown;
    page: Record<string, unknown> | undefined;
  }> {
    return commercialModuleUnavailable();
  }
  async deleteRedisKey(
    _id: string,
    _key: string,
    _userId: string
  ): Promise<{
    success: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async expireRedisKey(
    _id: string,
    _key: string,
    _ttlSeconds: number,
    _userId: string
  ): Promise<{
    key: string;
    type: string;
    ttlSeconds: number;
    value: unknown;
    page: Record<string, unknown> | undefined;
  }> {
    return commercialModuleUnavailable();
  }
  async executeRedisCommand(
    _id: string,
    _commandText: string,
    _userId: string
  ): Promise<{
    results: {
      command: string;
      result: unknown;
      truncated: boolean;
    }[];
    truncated: boolean;
    commandLimit: number;
  }> {
    return commercialModuleUnavailable();
  }
}
