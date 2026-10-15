import type { ManagedPostgresExtensionChange } from '@/db/schema/databases.js';
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
/** A row status of a curated PostgreSQL extension, as the node reports it. */
export type ManagedPostgresExtensionStatus =
  | 'enabled'
  | 'update_available'
  | 'available'
  | 'needs_bundle'
  | 'needs_image_update'
  | 'unavailable';
/** One curated PostgreSQL extension of a managed database (the Extensions tab, the API and MCP). */
export interface ManagedPostgresExtensionView {
  name: string;
  category: string;
  description: string;
  /** contrib = in the official image, baked = in Opfield's image, bundle = downloaded into the database volume. */
  delivery: 'contrib' | 'baked' | 'bundle';
  bundle: string | null;
  preloadLibraries: string[];
  notes: string;
  /** null while the node's daemon cannot report it. */
  status: ManagedPostgresExtensionStatus | null;
  availableVersion: string | null;
  installedVersion: string | null;
  /** Download size when it needs a bundle on this node (0 otherwise). */
  bundleSizeBytes: number;
  restartToEnable: boolean;
  restartToDisable: boolean;
}
export interface ManagedPostgresExtensionsView {
  managedDatabaseId: string;
  version: string;
  /** The node's daemon predates extensions: no status is reported and nothing can change. */
  daemonUpdateRequired: boolean;
  imageKind: 'opfield' | 'official' | 'other';
  /** Opfield's image of this version is published and the database still runs the official one. */
  imageUpdateAvailable: boolean;
  volume: { freeBytes: number; totalBytes: number } | null;
  sharedPreloadLibraries: string[];
  pending: ManagedPostgresExtensionChange | null;
  lastError: (ManagedPostgresExtensionChange & { message: string; failedAt: string }) | null;
  extensions: ManagedPostgresExtensionView[];
}
