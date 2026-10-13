---
name: storage
description: Manage Opfield object storage, including external S3, R2, MinIO-compatible, FTP, FTPS, and SFTP connections, Opfield-managed SeaweedFS clusters and legacy managed MinIO, buckets and objects, private workload links and scoped access keys, server-side copy jobs, and the guided legacy MinIO to SeaweedFS migration. Use when asked to connect external storage, provision managed object storage, upload or browse objects, copy or sync data between storages, or migrate off a legacy MinIO cluster. Use after using-opfield has confirmed the Opfield MCP connection.
---

# Storage

Opfield has two kinds of storage:

- **External connections**: AWS S3, R2, MinIO-compatible, FTP, FTPS, or SFTP endpoints Opfield points at. SFTP requires a pinned host-key fingerprint.
- **Managed storage**: clusters Opfield runs on a `storage` Node. New clusters are single-node **SeaweedFS**, S3 API only (no FTP or SFTP), with at least 512 MiB of memory and a Node daemon that advertises SeaweedFS support. Existing **MinIO** clusters (`engine: "minio"`) are legacy: still manageable, but they cannot be created any more. Managed storage is private by default through the authenticated relay; a public S3 listener is an explicit opt-in.

Start with `using-opfield` for connection, discovery, and safety rules. Read `read_opfield_documentation({ topic: "storage" })` before an unfamiliar workflow.

## External connections

`list_storage_connections`, `get_storage_connection`, and `manage_storage_connection` (create, update, test, delete, `health_history`, `monitoring`, `reveal_credentials`). Connection credentials are secrets: never ask for them in chat; let the user enter them in the Opfield Console or pass them from a local source the user named without echoing them. `reveal_credentials` needs `storage:credentials:reveal`, is refused during impersonation, and runs only on an explicit request.

`delete` is refused while backup policies or active backup runs use the connection. When only backup history blocks it, `config.backupHistory: "forget"` removes that history: the files stay in storage but are no longer restorable through Opfield. Pass it only after explicit confirmation.

## Managed storage

`manage_managed_storage({ operation, ... })`:

1. `catalog`, then `create` with `type: "seaweedfs"`, optional size and `memoryMb` (at least 512), and `folderId`. Poll `get` with `managedStorageId` until ready.
2. `list_bindings`, `create_binding`, `delete_binding`: private, bucket-scoped workload links for a Container or Deployment (need `storage:bind`, which `storage:iam` includes, plus permission on the target workload). The workload need not run: a link on a stopped, crash-looping, failed, or not yet deployed workload, or on a Git-source Container before its first build (by its name), is saved without waiting. `list_bindings` shows `observedState: "target_applied"` until the workload runs with the link, then `active`. A Deployment rollback keeps the current links. The target Docker Node must be online. `get_binding_runtime` (`storage:view` plus view access to the workload) shows one link's open connections out of its 64 and the connections refused at that limit.
3. `list_access_keys`, `create_access_key`, `remove_access_key`: scoped IAM keys. `create_access_key` returns its secret exactly once; `list` never returns key or root secrets.
4. `reveal_credentials`: the cluster root keys, only on an explicit request (`storage:credentials:reveal`, refused during impersonation).
5. `ca_certificate`: the public Storage CA (PEM and SHA-256) for S3 clients of a TLS cluster; needs only `storage:view`.
6. `delete`: the same backup-history rule as external connections.

Never repeat root credentials or key secrets in chat, even when a tool returns them.

## Objects and copy jobs

Bucket and object operations, the MCP-only `download_storage_object` link and chunked `upload_storage_object`, and server-side copy and sync jobs with their reports: [Objects and copy jobs](references/objects-and-copy-jobs.md). Paths are S3 bucket, key, and prefix paths, never Node filesystem paths.

## Migrating legacy MinIO to SeaweedFS

Only on the user's explicit request. It is a guided procedure run one tool step at a time, not a button: preflight, build the target, bulk copy, cutover, verify, retire, with a rollback path. Read [MinIO to SeaweedFS migration](references/minio-to-seaweedfs-migration.md) and `read_opfield_documentation({ topic: "storage-migration" })` first. Report each step's result, and ask before the cutover (it opens a write-restriction window) and before retiring the old cluster.

## Verify

- Copy or migration cutover: the only acceptable proof is a `copy_data_status` result with `report.clean: true` on the final sync pass.
- Workload link: the link is `active` and the workload runs with clean logs after the link is created or moved.
- Credential-affecting changes (freeze, unfreeze, key import): a real client request through the new credential or endpoint, not only the API acknowledgment.

## Pitfalls

- Never restart, update, or retry a legacy MinIO cluster casually. Each recreates its container, and the MinIO image may be gone from the Node (`MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE`, unrecoverable).
- SeaweedFS is S3 only. Clients of a source with FTP or SFTP enabled need another path before migrating.
- Managed capacity is the requested size, not the host's free disk. Never promise host-path access to managed data.

Scopes: `storage:view|create|edit|delete|credentials:reveal|credentials:use|iam|bind|objects:read|objects:write|objects:admin|folders:manage`, `databases:backups:*` (backups write to storage), and `nodes:backups:execute` (copy-job executor). `storage:credentials:reveal`, `storage:iam` and `storage:bind` are OAuth manual-approval scopes. Full table: [Scopes reference](https://docs.opfield.dev/en/identity/scopes-reference/).
