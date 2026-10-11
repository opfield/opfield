# Legacy MinIO to SeaweedFS migration

Only run this on explicit user request. There is no migration button — it is done with tools, one step at a time. Report each step's result. Ask before the cutover (it starts a write-restriction window) and before retiring the old cluster.

**IDs**: `manage_managed_storage` takes managed-storage IDs (`managedStorageId`, `targetStorageId`, `config.sourceStorageId` — the `id` from that tool's `list`/`get`). `copy_data_*` on `manage_storage_connection`, `manage_storage_objects`, and backup policies take **storage connection** IDs (`objectStorageConnectionId` from `get`). Never mix the two ID spaces.

## Rules

- Never `restart`, `update`, or `retry` the MinIO cluster, and never change its publication — each recreates its container, and the MinIO image may be gone from the node (`MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE`, unrecoverable). If the cluster isn't running, Opfield can't copy its data — stop and tell the user.
- SeaweedFS serves S3 only. If the source has `ftpEnabled` or `sftpEnabled`, stop and explain those clients need another path first.
- Never repeat root credentials or key secrets in chat. `import_access_keys` and `move_binding` keep secrets server-side.
- Never claim a copy finished before `copy_data_status` shows `completed`. Only the final sync after `freeze_writes` must end with `report.clean: true` before anything is switched over.

## 1. Preflight (read-only; present the plan and ask to proceed)

1. `manage_managed_storage get` the source: confirm `status: "ready"`, `engine: "minio"`; note `nodeId`, `publishS3`, `publishedPort`, `relayEnabled`, `tlsEnabled`, `sftpEnabled`, `ftpEnabled`, `writesFrozenAt`, `objectStorageConnectionId`.
2. Inventory: `manage_storage_objects list_buckets`; used bytes from `manage_storage_connection monitoring`; `list_access_keys` (keys with `expiresAt` will get new IDs); `list_bindings`; Additional Secure Links with `upstreamKind: "managed_storage"` and this `managedStorageId` (`manage_additional_secure_link list` per Route); backup policies/history whose destination or staging is the source connection (`manage_database_backups list_policies`/`list_runs` per database).
3. Pick a target node and size: at least 1.2× the used bytes, with enough free disk on that node for both copies simultaneously. Its daemon must support SeaweedFS (`STORAGE_ENGINE_UNAVAILABLE` means update the node daemon first — updating a daemon does not recreate the MinIO container). `freeze_writes` later also needs a current daemon on the MinIO node.

## 2. Build the target

1. `catalog`, then `create` a SeaweedFS cluster (≥512 MiB memory). To keep clients using the root credentials working, pass the source root keys from `reveal_credentials` as `config.accessKey`/`config.secretKey` — only if the user wants that, and never print them. Keep the default private relay. Publish S3 only if the source is published: same node → a temporary port (source still holds its port); another node → the same port. Poll `get` until `ready`.
2. Buckets: `copy_data_start` creates missing buckets when allowed (`createBuckets`), or use `manage_storage_objects create_bucket`. Every bucket a workload link uses must exist on the target before `move_binding`. Bucket versioning, lifecycle rules, and bucket policies are **not** copied — tell the user.

## 3. Bulk copy (online; MinIO keeps serving writes)

`manage_storage_connection copy_data_start` with `config: { sourceStorageId, destinationStorageId, buckets: "all", mode: "copy" }`; poll `copy_data_status({ config: { jobId } })` until terminal. Clients keep writing during these passes so the report may show differences — rerun until only a few recent objects differ (reruns copy only what changed). A clean report is required only for the final sync.

## 4. Cutover (tell the user the write window starts; reads keep working)

1. **Backups first**: move every backup policy that writes to the source (destination or staging) to the target connection with `manage_database_backups update_policy` (same bucket/prefix), or pause it (`enabled: false`). Check with `list_runs` that no backup/restore run using the source is queued or running; wait or cancel — `freeze_writes` refuses while such runs are active.
2. `freeze_writes` on the source: every Opfield-issued access key and workload-link key becomes read-only (including ones issued later); root credentials keep writing so the copy still works, but Opfield itself stops writing there — uploads/deletes/bucket changes through Opfield (object browser, tools, MCP uploads) fail with `STORAGE_WRITES_FROZEN`, and backup/restore runs that would write there are refused and recorded failed; copy jobs keep working. `unmanagedKeys` in the result lists keys Opfield didn't issue — they, and root-credential clients, still write; ask the user to stop them. `unmanagedKeys: null` means the storage server couldn't be listed — say unmanaged keys are *unknown*, never that there are none. `backupPoliciesStillUsingStorage` above 0 means step 1 is incomplete. Retry on `MANAGED_STORAGE_FREEZE_INCOMPLETE`; `get` shows `writesFrozenAt` once done.
3. Final pass: `copy_data_start` with `mode: "sync"` (also deletes target objects the source lacks) and wait for `report.clean: true` — counts/bytes equal, nothing missing or differing. If not clean, rerun; do not proceed.
4. `import_access_keys({ config: { sourceStorageId, targetStorageId } })`: operator keys keep their ID and secret (clients only change the endpoint, or nothing — see step 8). Tell the user which keys are in `needsNewId` (expiring, or an ID SeaweedFS won't accept); create replacements with `create_access_key` (same access/buckets/expiry) only if asked — a new secret is shown once.
5. `move_binding({ managedStorageId: <source>, bindingId, targetStorageId })` per link. The workload is **not** recreated — it keeps its alias, variables, and key; only the private route (and, if TLS differs, the connector) changes. Refuses with `MANAGED_STORAGE_BINDING_BUCKETS_MISSING` if a link's bucket is missing on the target. Then check the workload is running with clean logs. A failed move is normally rolled back to the source automatically; if the error says it couldn't switch back, it now uses the target and is marked failed — tell the user, check the workload, offer to delete and recreate the link.
6. Additional Secure Links: `manage_additional_secure_link retarget({ routeId, bindingId, upstreamKind: "managed_storage", managedStorageId: <target> })`. Keeps its ID/name; the Route config is reapplied when the scheme changes, and rolls back to the old cluster automatically if the target doesn't answer or the config can't be applied.
7. Backup check: `run` one backup of each moved policy and wait for completion; re-enable any paused policies.
8. Published endpoint: clients using the source's `host:port` get it back only after the source is deleted (retire), then `update` the target's `publishedPort`. Until then they can use the target's temporary port.
9. Tell the user to re-grant resource-scoped `storage:*` permissions and folder placement on the new connection.

## Rollback (before retire)

1. Backups first, mirroring cutover step 1, but back to the source connection; wait for/cancel runs using the target — `freeze_writes` on the target refuses while active.
2. `freeze_writes` the target.
3. Copy back what changed after cutover: `copy_data_start` target→source with `mode: "sync"` (frozen source still accepts the copy), repeated until `report.clean: true`.
4. `move_binding` every link back to the source and `retarget` the Secure Links back.
5. For backups made on the target during the failed cutover: once their files are back on the source (step 3 copies them), `rehome_backup_history({ managedStorageId: <target>, targetStorageId: <source> })` points them at the source; `blocked` runs stay on the target.
6. `unfreeze_writes` the source. Note: legacy MinIO operator keys created before Opfield attached a per-key policy inherited full root access; after a freeze/unfreeze cycle they get the Opfield read-write policy (read/write their buckets, no admin/bucket creation) — tell the user; a client needing more must use root credentials or a new key.

## Retire (only after the user confirms applications are healthy)

1. Backup history on the source: `rehome_backup_history({ managedStorageId: <source>, targetStorageId })` (try `config.dryRun: true` first) points finished runs at the target once every artifact is found there with its manifest size; refuses while backup runs are active, never changes policies, and `blocked` runs stay on the source (copy their files again, or ask the user). Alternatively keep the MinIO cluster while its history is needed. `config.backupHistory: "forget"` makes those backups unrestorable and deletes the files in the cluster with it — irreversible, confirm explicitly.
2. `delete` the source — refused while Secure Links, backup policies, or backup history still use it. Then move the published port if needed and `remove_access_key` any temporary keys. If the migration is abandoned instead and the source is unfrozen, the legacy key policy change from Rollback step 6 applies.
