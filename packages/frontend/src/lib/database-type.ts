import type { DatabaseType, ManagedDatabaseEngine } from "@/types";

/** Short database type names for lists, tabs, type pickers and badges. */
export const DATABASE_TYPE_LABELS: Record<DatabaseType, string> = {
  postgres: "Postgres",
  clickhouse: "ClickHouse",
  redis: "Key-value",
};

/** The description line shown wherever the key-value type is introduced. */
export const KEY_VALUE_TYPE_DESCRIPTION = "Works with Redis clients.";

export function databaseTypeLabel(type: string): string {
  return DATABASE_TYPE_LABELS[type as DatabaseType] ?? type;
}

/**
 * The version of a managed instance as users see it. A key-value store names its engine
 * ("Valkey 9.1.2", "Redis 8.10.0"); other types show the plain version.
 */
export function managedDatabaseVersionLabel(managed: {
  type: DatabaseType;
  version: string;
  engine?: ManagedDatabaseEngine;
}): string {
  if (managed.type !== "redis") return managed.version;
  if (managed.engine === "valkey") return `Valkey ${managed.version}`;
  if (managed.engine === "redis") return `Redis ${managed.version}`;
  return managed.version;
}
