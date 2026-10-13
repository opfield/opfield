import type { managedDatabaseInstances } from '@/db/schema/index.js';
export type ManagedDatabaseRow = typeof managedDatabaseInstances.$inferSelect;
export type ManagedDatabaseType = ManagedDatabaseRow['type'];
export interface OwnerCredentials {
  username: string;
  password: string;
  databaseName?: string;
}
export interface ManagedDatabaseRuntimeStats {
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  swapUsageBytes: number;
  swapLimitBytes: number;
  pids: number;
  /** The data image's filesystem (used, and used plus available); null when the daemon does not report it. */
  diskUsedBytes?: number | null;
  diskTotalBytes?: number | null;
}
export interface ManagedDatabaseLogTarget {
  managedDatabaseId: string;
  nodeId: string;
  containerId: string;
}
export interface ManagedDatabaseLogOptions {
  tailLines?: number;
  follow?: boolean;
  timestamps?: boolean;
  since?: string;
  until?: string;
}
export type ManagedDatabaseOperation = NonNullable<ManagedDatabaseRow['pendingOperation']>;
export interface DaemonManagedDatabaseState {
  status: 'ready' | 'paused' | 'stopped' | 'missing';
  operationId?: string;
}
