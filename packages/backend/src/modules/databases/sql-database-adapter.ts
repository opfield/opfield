import type { DatabaseType } from './database-error-mapping.js';

export type SqlDatabaseType = Extract<DatabaseType, 'postgres' | 'clickhouse'>;
export type DatabaseQueryIntent = 'read' | 'write' | 'admin';

export interface SqlProviderCapabilities {
  sqlConsole: true;
  catalogExplorer: true;
  rowInsert: boolean;
  rowUpdate: boolean;
  rowDelete: boolean;
  schemaMutation: boolean;
  exactRowCount: boolean;
}

export interface SqlNamespace {
  name: string;
  system: boolean;
}

export interface SqlObjectSummary {
  name: string;
  type: 'table' | 'view' | 'materialized-view' | 'dictionary' | 'other';
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
  provider: SqlDatabaseType;
  namespace: string;
  table: string;
  objectType: SqlObjectSummary['type'];
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
  totalKind: 'exact' | 'approximate' | 'unavailable';
  truncated: boolean;
}

export interface SqlStatementResult {
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
}

export interface SqlExecutionResult {
  results: SqlStatementResult[];
  truncated: boolean;
  resultLimit: number;
}

export interface SqlExecutionOptions {
  maxRows?: number;
  /** Absolute Opfield deadline shared by every statement in this console run. */
  deadlineMs?: number;
  /** Cancels the active database operation when the HTTP client disconnects. */
  signal?: AbortSignal;
  /**
   * Access level that authorized this request. `read` runs in a read-only
   * transaction as a non-owner principal when the provider supports one.
   * Omitted means the caller already holds administrative query access.
   */
  queryAccess?: 'read' | 'write' | 'admin';
}

export interface SqlRowMutationResult {
  success: true;
  affectedRows: number;
  queryId?: string;
}

export interface SqlDatabaseAdapter {
  readonly type: SqlDatabaseType;
  readonly capabilities: SqlProviderCapabilities;
  inferIntent(sql: string): DatabaseQueryIntent;
  listNamespaces(id: string): Promise<SqlNamespace[]>;
  listObjects(id: string, namespace: string): Promise<SqlObjectSummary[]>;
  getTableMetadata(id: string, namespace: string, table: string): Promise<SqlTableMetadata>;
  browseRows(
    id: string,
    namespace: string,
    table: string,
    page: number,
    limit: number,
    options?: {
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      search?: {
        column: string;
        operation: 'like' | 'equals' | 'notEquals' | 'greaterThan' | 'lessThan';
        value: string;
      };
    }
  ): Promise<SqlBrowseResult>;
  insertRow(
    id: string,
    namespace: string,
    table: string,
    values: Record<string, unknown>,
    userId: string
  ): Promise<SqlRowMutationResult>;
  updateRow(
    id: string,
    namespace: string,
    table: string,
    locator: Record<string, unknown>,
    values: Record<string, unknown>,
    userId: string
  ): Promise<SqlRowMutationResult>;
  deleteRow(
    id: string,
    namespace: string,
    table: string,
    locator: Record<string, unknown>,
    userId: string
  ): Promise<SqlRowMutationResult>;
  executeSql(id: string, sql: string, userId: string, options?: SqlExecutionOptions): Promise<SqlExecutionResult>;
}
