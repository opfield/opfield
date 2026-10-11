# Objects and copy jobs

## Object operations

`manage_storage_objects` works on S3 bucket, key, and prefix paths only:

- `list_buckets`, `list_objects`, `head`;
- `create_bucket` and `delete_bucket` (`storage:objects:admin`);
- `create_prefix`, `delete_objects`;
- `presign`: GET by default, PUT needs `storage:objects:write`; private managed storage refuses it unless its S3 endpoint is published, and then the URL points at the published endpoint;
- `read_object`: small objects only (256 KiB by default, 1 MiB decoded at most, returned as base64). Download anything larger with `download_storage_object`.

Deleting objects or buckets is destructive; confirm the exact bucket and keys with the user first.

## Downloading objects through MCP

`download_storage_object` is MCP-only: it takes `storageId`, `bucket` and `key` and needs `storage:objects:read`. It returns a one-time download URL (15 minutes, single use) and a ready `curl -fsS -o <file> <url>` command that streams the object through Opfield, so it works for any size and for private managed storage. A missing bucket or object is refused with `STORAGE_NOT_FOUND` before a link is made. If curl exits non-zero, the file is incomplete: delete it and create a new link.

## Uploading objects through MCP

`upload_storage_object` is MCP-only and chunked: `begin`, `chunk`, `status`, `finalize`, `abort`.

- `begin` takes `storageId`, `bucket`, `key`, the exact `declaredSizeBytes`, and the lowercase `sha256` of the whole object.
- Chunks are base64, at most 1 MiB decoded each.
- Sessions expire after one hour; do not assume a stalled upload survives an Opfield restart. Check `status` before resuming.
- Every byte passes through your context; for large data, prefer a presigned PUT used by a local client or a copy job.

## Copy and sync jobs

`manage_storage_connection` with `copy_data_start` and `config: { sourceStorageId, destinationStorageId, buckets: "all" | [names], mode: "copy" | "sync", dryRun?, createBuckets?, executorNodeId?, limits? }`:

- `mode: "copy"` (default) adds and overwrites, never deletes.
- `mode: "sync"` also **deletes** destination objects the source lacks. Use it only for a final pass after the user agrees. It is refused into a managed cluster whose writes are not frozen while links or writable keys use it; override with `allowLiveDestination: true` only after confirmation.
- `dryRun: true` writes nothing and reports the differences.
- Both connections must be S3 (managed or external); an SFTP or FTP(S) connection is refused with `STORAGE_COPY_PROVIDER_UNSUPPORTED`.
- Scopes: `storage:objects:read` and `storage:credentials:use` on the source; `storage:objects:write` and `storage:credentials:use` on the destination (plus `storage:objects:admin` when buckets must be created); `nodes:backups:execute` on the executor, an online `storage` Node chosen automatically.

Poll `copy_data_status({ config: { jobId } })` until `completed`, `failed`, or `cancelled`; never claim a copy finished before that. A finished job's `report` has per-bucket and `totals` counts and bytes, `missing`, `differing`, and (sync only) `extra` with sample keys, and `clean: true` only when everything matched. `copy_data_list` and `copy_data_cancel` complete the set.

Only one active job may write a storage, and no job may read a storage that another job is writing.
