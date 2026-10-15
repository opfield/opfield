export type {
  ClickHouseConnectionConfig,
  DatabaseConnectionConfig,
  DatabaseConnectionView,
  DatabaseHealthStatus,
  PostgresConnectionConfig,
  RedisConnectionConfig,
} from './database-connection-view.js';
export type { DatabaseOperation, DatabaseType } from './database-error-mapping.js';
export type PostgresRowSearchOperation = 'like' | 'equals' | 'notEquals' | 'greaterThan' | 'lessThan';
export type SqlQueryAccess = 'read' | 'write' | 'admin';
export interface PostgresRowSearchFilter {
  column: string;
  operation: PostgresRowSearchOperation;
  value: string;
}
