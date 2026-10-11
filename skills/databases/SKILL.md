---
name: databases
description: Provision and operate managed PostgreSQL, key-value stores (Redis clients), and ClickHouse on Opfield, bind them privately to Containers, Deployments, or Compose services, register external database connections, run SQL queries or Redis commands, and manage native backups and restores. Use when asked to create a database, give an application private database access, run a query, rotate database credentials or certificates, or set up and verify backups. Use after using-opfield has confirmed the Opfield MCP connection.
---

# Databases

Opfield has two database models. Keep them apart:

- **External connections**: an existing database Opfield should operate or observe over operator-supplied connection details. Register one only when Opfield should query, monitor, or back it up.
- **Managed instances**: curated PostgreSQL, key-value store, or ClickHouse that Opfield runs on a `storage` Node (or a legacy `databases` Node). They are private by default, reached through an authenticated relay tunnel, with daemon-managed storage.

Start with `using-opfield` for connection, discovery, and safety rules. Read `read_gateway_documentation({ topic: "databases" })` (also `postgres`, `redis` for key-value stores, `clickhouse`) before an unfamiliar workflow.

A key-value store is `type: "redis"` in the API and tools and works with Redis clients. New stores run Valkey 9.1.2 (with JSON, Bloom and Search); `get` reports `engine` `valkey`, or `redis` for a store created before 2.12 that still runs Redis.

## Give an application a database

Before provisioning, check engine availability, placement, capacity, entitlement, active Tasks, backup and recovery expectations, and existing databases with the same purpose.

1. `manage_managed_database({ operation: "catalog" })` for engines and versions.
2. `{ operation: "create", type: "postgres" | "redis" | "clickhouse", version, nodeId, storageSizeGb, cpuCores?, memoryMb?, ... }` on an online compatible Node. Keep `publishTcp` and `publishNativeTcp` false unless the user explicitly needs TCP access from outside Opfield.
3. Poll `{ operation: "get", databaseId }` until the instance is ready.
4. Resolve the workload through its owning Container, Deployment, or Compose Project, then `{ operation: "create_binding", databaseId, targetType: "container" | "deployment" | "compose_service", targetNodeId, targetResourceId, environment }`. `environment` maps the values to deliver (`connectionUri`, `host`, `port`, `database`, `username`, `password`) to environment variable names; at least one is required. Linking and unlinking need `databases:bind` on the database (`databases:edit` includes it) and the workload's binding scopes.
5. Verify the binding and an application-level connection (below).

Each binding gets its own engine identity, never the owner account: a login role for PostgreSQL, a role-scoped user for ClickHouse, an ACL user with dangerous and admin commands denied for a key-value store. One database with one binding per workload is the intended pattern. Never copy owner credentials into environment variables as a shortcut. If the workload is recreated, confirm the binding is still attached through the owning resource.

The workload need not run. `create_binding` and `delete_binding` on a stopped, crash-looping, failed, or not yet deployed workload save the link and return without waiting; `list_bindings` shows `observedState: "target_applied"` until the workload next starts or finishes its rollout, then `active`. For a Deployment whose first Git build failed, retry the source build; never set its image by hand to force the link. A Git-source Container before its first build is linked by its name, and a Compose service before the first revision (or during a build rollout) by a service name the next revision defines; the link fails with the reason if that revision lacks the service. Rollbacks, slot switches, and older Compose revisions keep the current links. The target Docker Node must be online (`NODE_OFFLINE` otherwise).

For TLS-enabled PostgreSQL, the plain `connectionUri` works: the database Node's daemon (2.11.0 or later) opens TLS to PostgreSQL for a client that connects without it, and a client that requests TLS itself keeps end-to-end TLS.

## Lifecycle is not one operation

Provisioning, `restart`, `pause`, `unpause`, `retry`, `update`, credential rotation, certificate rotation, and `delete` are distinct operations; follow each returned Task and the reported state. `delete_binding` revokes one application's access; `delete` removes the managed database and its storage. A request to disconnect, redeploy, or remove an application never authorizes deleting its database. Delete bindings before deleting a database or workload when possible.

- `list_bindings`, `get_binding_runtime` (link telemetry: `activeStreams` are the link's open connections out of its 64, `throughput`, `throttledTotal` the connections refused at that limit, `connections.lastRejectionReason` why the latest one was refused), and `logs` (`tailLines`) help diagnosis.
- `certificate_status` reads certificate state; `rotate_certificate` reloads in place and needs `allowRestart: true` when the engine cannot hot-reload.

## Move a key-value store to Valkey

Stores created before 2.12 keep running Redis until the user asks to move them; never move one on your own. `{ operation: "move_to_valkey", databaseId }` (`databases:edit`) works on a running store with `engine: "redis"` whose node daemon supports Valkey (`MANAGED_DATABASE_DAEMON_UPDATE_REQUIRED` otherwise). The store is `updating` while every key is copied into Valkey on the same node: writes pause, reads keep working. Poll `get` until it is `ready` and check `engine`. If anything fails, the store goes back to Redis. A store with Bloom or cuckoo filters, time series, vector sets, or search indexes is refused before anything changes; it stays `ready` on Redis and `lastError` names the key types. First run `{ operation: "move_to_valkey_check", databaseId }` and tell the user the key count, `estimatedPauseSeconds` (the write pause) and any `blockers` (the move is refused while there are any). If `pendingStreamEntries` is above 0, the consumer groups move but their pending entries do not: say how many, and pass `acceptPendingStreamLoss: true` only after the user accepted that loss (without it the move is refused).

## Credentials

Credential tools run only on the user's explicit request and are refused during impersonation: `reveal_credentials` and `rotate_credentials` (the direct-access principal of a published instance; `databases:credentials:reveal`, rotation also `databases:edit`) and `reveal_binding_credentials` (also needs the workload's binding scopes). Opfield never returns the internal owner account. Never log a revealed value, repeat it, or copy it into a Compose file, image layer, repository, or Pages runtime configuration.

## Queries and backups

SQL and key-value tools, query scopes, backup policies, runs, and restores: [Queries and backups](references/queries-and-backups.md). A restore is a manual-approval operation that runs only when the user explicitly asks for one.

## Verify

Report the last verified boundary; a healthy database does not prove the application can use it.

1. The database is provisioned and healthy.
2. The binding identity is created and ready, with `observedState: "active"`; `target_applied` means the workload has not run with it yet.
3. The workload received the binding's variable names (report names, never values).
4. The application connected and performed its expected operation. For isolation, an ordinary query succeeds while an admin operation such as creating a role fails.

## Pitfalls

- A managed instance has no published port by default. Never propose direct TCP as a substitute for a binding; publishing is a separate opt-in whose authentication and TLS Opfield does not manage for the client.
- A red relay warning after bounded automatic recovery fails is a critical operator state, not a reason to publish a replacement port.
- `restore` refuses a non-empty target on purpose; never force it onto an existing database.

Further reading: [Databases overview](https://docs.opfield.dev/en/databases/overview/), [Bindings](https://docs.opfield.dev/en/databases/bindings/), [Private database journey](https://docs.opfield.dev/en/journeys/private-database/).
