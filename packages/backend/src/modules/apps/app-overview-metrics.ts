/**
 * The metrics the app overview reads from the commercial core's overview series (one sample per 2.5 minutes, kept a
 * day). The core's writer stores exactly these names (its contract test compares both lists), so a card never reads
 * a metric nobody writes.
 */
export const APP_OVERVIEW_DATABASE_METRICS = [
  // Disk: PostgreSQL and ClickHouse data size, the key-value store's persisted (AOF) size.
  'database_size_bytes',
  // Connections: PostgreSQL connections, key-value clients, ClickHouse running queries.
  'total_connections',
  'connected_clients',
  'running_queries',
  'max_connections',
  // Throughput: PostgreSQL transactions, key-value operations, ClickHouse queries per second.
  'transaction_rate',
  'instantaneous_ops_per_sec',
  'query_rate',
  // Reads served from memory: shared buffers, keyspace hits, the mark cache.
  'cache_hit_ratio',
  // CPU of a managed database's container.
  'managed_cpu_percent',
] as const;

export type AppOverviewDatabaseMetric = (typeof APP_OVERVIEW_DATABASE_METRICS)[number];

export const APP_OVERVIEW_STORAGE_METRICS = [
  'bucket_count',
  'disk_used_bytes',
  'disk_total_bytes',
  'object_count',
  'network_rx_bytes',
  'network_tx_bytes',
] as const;

export type AppOverviewStorageMetric = (typeof APP_OVERVIEW_STORAGE_METRICS)[number];
