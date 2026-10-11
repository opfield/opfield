import { formatBytes } from "@/lib/utils";
import type {
  DatabaseConnection,
  PostgresTableColumn,
  PostgresTableMetadata,
  SqlBrowseResult,
  SqlColumnMetadata,
  SqlTableMetadata,
} from "@/types";

export const HEALTH_BADGE: Record<string, "success" | "secondary" | "warning" | "destructive"> = {
  online: "success",
  degraded: "warning",
  offline: "destructive",
  paused: "warning",
  unknown: "secondary",
};

export const METRIC_COLORS: Record<string, string> = {
  latency_ms: "var(--color-hue-orange)",
  active_connections: "var(--color-hue-cyan)",
  total_connections: "var(--color-hue-cyan)",
  idle_connections: "var(--color-hue-slate)",
  max_connections: "var(--color-hue-slate)",
  active_connections_pct: "var(--color-hue-amber)",
  total_connections_pct: "var(--color-hue-amber)",
  database_size_bytes: "var(--color-hue-blue)",
  lock_count: "var(--color-hue-red)",
  long_running_queries: "var(--color-hue-orange)",
  transaction_rate: "var(--color-hue-green)",
  cache_hit_ratio: "var(--color-hue-blue)",
  read_blocks_per_sec: "var(--color-hue-cyan)",
  write_blocks_per_sec: "var(--color-hue-amber)",
  used_memory_bytes: "var(--color-hue-blue)",
  maxmemory_bytes: "var(--color-hue-slate)",
  memory_pct: "var(--color-hue-amber)",
  connected_clients: "var(--color-hue-cyan)",
  instantaneous_ops_per_sec: "var(--color-hue-green)",
  key_count: "var(--color-hue-green)",
  redis_db: "var(--color-hue-slate)",
  row_count: "var(--color-hue-green)",
  active_parts: "var(--color-hue-cyan)",
  running_queries: "var(--color-hue-orange)",
  query_rate: "var(--color-hue-green)",
  memory_usage_bytes: "var(--color-hue-blue)",
  disk_used_pct: "var(--color-hue-amber)",
  managed_cpu_percent: "var(--color-hue-orange)",
  managed_memory_usage_bytes: "var(--color-hue-blue)",
  managed_swap_usage_bytes: "var(--color-hue-violet)",
  managed_pids: "var(--color-hue-green)",
};

export const SQL_EXPLORER_PAGE_SIZE = 100;
export const VIRTUAL_ROW_HEIGHT = 37;
export const VIRTUAL_RESULT_ROW_HEIGHT = 49;

export function databaseDeleteConfirmation(database: Pick<DatabaseConnection, "name" | "managed">) {
  if (database.managed) {
    return {
      title: "Delete Managed Database",
      description: `Permanently delete managed database "${database.name}"? Its container, network, mounted storage, and disk image will be removed together with the saved connection. All database data will be lost.`,
      successMessage: "Managed database deleted",
    };
  }
  return {
    title: "Delete Database Connection",
    description: `Delete saved connection "${database.name}"? The external database and its data will not be changed.`,
    successMessage: "Database connection deleted",
  };
}

export function formatMetricValue(key: string, value: number | null): string {
  if (value == null) return "-";
  if (key.includes("bytes")) return formatBytes(value);
  if (key.endsWith("_pct")) return `${value.toFixed(1)}%`;
  if (key.endsWith("_ms")) return `${value.toFixed(0)} ms`;
  if (key === "transaction_rate") return `${value.toFixed(1)}/s`;
  if (key === "cache_hit_ratio") return `${value.toFixed(1)}%`;
  if (key === "read_blocks_per_sec" || key === "write_blocks_per_sec") {
    return `${value.toFixed(1)}/s`;
  }
  return `${value}`;
}

export function formatHealthStatusLabel(
  status: DatabaseConnection["healthStatus"] | "paused" | "unknown"
): string {
  if (!status) return "Unknown";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function isNumericColumn(column: PostgresTableColumn | SqlColumnMetadata): boolean {
  const udtName = "udtName" in column ? column.udtName : (column.nativeTypeName ?? "");
  const normalized = `${column.dataType} ${udtName}`.toLowerCase();
  return (
    /(^|\W)u?int(8|16|32|64|128|256)(\W|$)/.test(normalized) ||
    /(^|\W)float(32|64)(\W|$)/.test(normalized) ||
    normalized.includes("smallint") ||
    normalized.includes("integer") ||
    normalized.includes("bigint") ||
    normalized.includes("numeric") ||
    normalized.includes("double") ||
    normalized.includes("real") ||
    normalized.includes("decimal") ||
    normalized.includes("int2") ||
    normalized.includes("int4") ||
    normalized.includes("int8") ||
    normalized.includes("float4") ||
    normalized.includes("float8")
  );
}

export function isBooleanColumn(column: PostgresTableColumn | SqlColumnMetadata): boolean {
  return column.dataType.toLowerCase() === "boolean" || column.dataType === "Bool";
}

export function stringifyCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function isBlankValue(value: unknown): boolean {
  return value == null || value === "";
}

export function isPendingRowValid(
  row: Record<string, unknown>,
  columns: Array<PostgresTableColumn | SqlColumnMetadata>
): boolean {
  const hasAnyValue = columns.some((column) => !isBlankValue(row[column.name]));
  if (!hasAnyValue) return false;

  return columns.every((column) => {
    if (column.nullable || column.hasDefault) return true;
    return !isBlankValue(row[column.name]);
  });
}

export function getPendingRowState(
  row: Record<string, unknown>,
  columns: Array<PostgresTableColumn | SqlColumnMetadata>
): "empty" | "valid" | "invalid" {
  const hasAnyValue = columns.some((column) => !isBlankValue(row[column.name]));
  if (!hasAnyValue) return "empty";
  return isPendingRowValid(row, columns) ? "valid" : "invalid";
}

export function coerceCellInput(
  column: PostgresTableColumn | SqlColumnMetadata,
  raw: string
): unknown {
  if (raw === "") return null;
  if (isBooleanColumn(column)) {
    if (raw.toLowerCase() === "true") return true;
    if (raw.toLowerCase() === "false") return false;
    return raw;
  }
  if (isNumericColumn(column) && !Number.isNaN(Number(raw))) {
    const numeric = Number(raw);
    if (Number.isSafeInteger(numeric)) return numeric;
    if (!Number.isInteger(numeric)) return numeric;
  }
  if (column.dataType === "json" || column.dataType === "jsonb") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function getRowKey(
  metadata: PostgresTableMetadata | SqlTableMetadata,
  row: Record<string, unknown>
): string {
  const identityColumns =
    "mutations" in metadata ? metadata.mutations.identityColumns : metadata.primaryKey;
  if (identityColumns.length > 0) {
    return identityColumns.map((key) => String(row[key] ?? "")).join(":");
  }
  return JSON.stringify(row);
}

export function buildPrimaryKey(metadata: PostgresTableMetadata, row: Record<string, unknown>) {
  return Object.fromEntries(metadata.primaryKey.map((key) => [key, row[key]]));
}

export function buildRowLocator(metadata: SqlTableMetadata, row: Record<string, unknown>) {
  return Object.fromEntries(metadata.mutations.identityColumns.map((key) => [key, row[key]]));
}

export function hasMoreSqlRows(input: {
  loadedRows: number;
  total: number | null;
  totalKind: SqlBrowseResult["totalKind"];
  pageTruncated: boolean;
}): boolean {
  if (input.totalKind === "exact" && input.total != null) {
    return input.loadedRows < input.total;
  }
  return input.pageTruncated;
}
