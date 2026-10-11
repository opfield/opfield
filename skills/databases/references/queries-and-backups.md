# Queries and backups

## Query tools

- **PostgreSQL:** `manage_postgres_data` explores schemas and tables (row editing needs a primary key; tables without one are browse-only). `query_postgres_read` runs read queries and `execute_postgres_sql` runs one or more statements. Extensions: `list_extensions` (query read), `enable_extension` and `disable_extension` (query admin).
- **Key-value (`redis`):** `manage_redis_data` browses keys with `SCAN` (never `KEYS`) and edits string, hash, list, set, and zset values; streams are browse-only in the visual explorer. `browse_redis_keys`, `get_redis_key`, `set_redis_key`, and `execute_redis_command` cover the console.
- **ClickHouse and provider-neutral SQL:** the `manage_postgres_data` `sql_*` operations (namespaces, objects, table metadata, rows, console). The required query scope follows the statement's intent.
- Scopes: `databases:query:read`, `databases:query:write`, `databases:query:admin`. Each also grants view of that connection and can be restricted to one database ID. All three are OAuth manual-approval scopes.

Diagnosis and inventory requests stay read-only: use read queries and never run writes or DDL without the user's explicit intent. Query and command text is sanitized and truncated in the audit log, but still never embed secrets in a statement.

## Backup policies and runs

`manage_database_backups({ action, databaseId, policyId?, runId?, config? })`:

- `list_policies`; `create_policy` and `update_policy` with `config`: `destinationId` (a Storage connection, see `storage`), `bucket`, `prefix`, optional staging target, `executorNodeId`, `schedule` (cron, or `null` for manual only), `timezone`, `retentionCount`, `limits` (`workspaceBytes`, `timeoutSeconds`, `cpuCores`, `memoryMb`), `enabled`; a policy requires `timezone`, `retentionCount` and all four limits. `delete_policy`.
- `run` starts a backup now; `cancel` stops one (`config.force` ends a run whose executor cannot confirm); `list_runs`.
- `delete_run`: when files remain, `config.artifacts: "delete"` removes them first (the entry stays if that fails) and `"forget"` removes only the history entry, leaving files in storage. Ask the user which before calling.

Native PostgreSQL, key-value, and ClickHouse backups use the immutable runner bundled with the Opfield release. The executor must be a Storage node that runs backup jobs (`list_nodes` with type `storage`; its capabilities include `database_backups_v1`); Opfield refuses any other node. It needs `nodes:backups:execute`.

## Restore

`restore` creates a **new** managed database by default and refuses a non-empty target. It needs `config.executorNodeId` plus `newManagedDatabaseName` or `restoreTargetConnectionId`, which must be another connection than the source database. For a new managed database, `config.storageSizeGb`, `cpuCores`, `memoryMb` and `swapMb` set its size with the limits of create; each defaults to the source managed database. A key-value backup restores only into the engine it was taken from: a Redis backup into a store that runs Redis or into a new store (which then runs the backup's Redis version), a Valkey backup only into Valkey; a mismatch fails before the target is touched. An external key-value restore requires the target to reach the executor's service address for temporary replication. `databases:backups:restore` is an OAuth manual-approval scope; run a restore only when the user explicitly asks for one.

## Verify backups

Wait for a terminal run status before claiming a backup completed. Before trusting a backup for an incident, restore it into a disposable target and check its data.

## Scopes

`databases:view|create|edit|delete|folders:manage`, `databases:query:read|write|admin`, `databases:credentials:reveal`, `databases:backups:view|manage|run|restore`, and `nodes:backups:execute` for the executor. Full table: [Scopes reference](https://docs.opfield.dev/en/identity/scopes-reference/).
