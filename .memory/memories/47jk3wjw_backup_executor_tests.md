---
{
  "id": "47jk3wjw",
  "file_name": "47jk3wjw_backup_executor_tests",
  "tags": [
    "backups",
    "gateway-commercial",
    "scopes",
    "testing"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.93,
  "created_at": 1790023724962,
  "updated_at": 1791851229877
}
---
# Backup controller queue contract and local verification

- `gateway-commercial/backend/backups/backups.service.ts`: one run per executor Storage node (lease table). A run admitted while the node is busy stays `status=queued, phase=waiting_for_executor` (no lease, no daemon state); `reconcileActiveRuns` (30 s) dispatches the oldest waiting run per node, newer runs never jump the queue, cancel of a waiting run is immediate. Scheduled ticks (20 s) only enqueue and skip a policy whose previous run is still queued/running. `BACKUP_EXECUTOR_BUSY` / phase `executor_busy` no longer exist. Restore limits for a deferred dispatch are stored in `restore_target.limits`.
- The commercial module may only use drizzle operators re-exported by the Opfield host (`backup-host.js` → `modules/backups/backup-runtime.ts`: and/asc/desc/eq/inArray/sql). Adding `ne`/`lte` would break against an older host — express them with `sql`.
- The daemon must persist a terminal status for every preflight failure (`persistPreflightFailure`), because the controller only trusts persisted runner status; otherwise the run and node lease hang until manual cancel.
- Redis restore staging image = newest catalog release of the dump's major (same release a new managed restore target gets), never the newest Redis overall. Postgres runner uses `/usr/lib/postgresql/<server major>/bin/{pg_dump,pg_restore}` (clients 14–17 installed in the runner image, default 18).
- Controller integration tests (`backups.integration.test.ts`) need `GATEWAY_BACKUP_TEST_DATABASE_URL`. Locally: `initdb` + `pg_ctl` with `listen_addresses=''` and a short unix socket dir (e.g. `/tmp/claude/gwpg/s`, path limit 103 bytes), `DATABASE_URL=postgresql://postgres@/gwtest?host=<dir> pnpm db:migrate` in `packages/backend`, then vitest. The Claude sandbox blocks shmget and unix-socket connect, so these three commands must run unsandboxed.
- Frontend `parseScopesForForm` must treat any complete catalog scope as exact before prefix matching (like `extractBaseScope`): `admin:users:folders:manage` was parsed as `admin:users` + resource `folders:manage`, producing phantom "Additional scopes" chips in the OAuth authorization dialog.
