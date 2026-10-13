---
{
  "id": "iois3ul4",
  "file_name": "iois3ul4_managed_database_relay",
  "tags": [
    "database-tunnel",
    "docker-daemon",
    "e2e",
    "gateway-relay",
    "installer",
    "loop-device",
    "managed-databases",
    "migration"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.94,
  "created_at": 1786111914144,
  "updated_at": 1791851663704
}
---
# Managed-database relay migration, storage and connector contract

Relay architecture (public port ownership, multiplexed process-lifetime tunnels, admission and telemetry) is kept in the relay/Secure Link admission memory. This memory covers supervision, migration, storage and connectors.

## Supervision

- Opfield supervises relay health with bounded automatic recovery; failed recovery produces a critical Dashboard notice linked to shared-shell details.

## Stateful migration

- Relay migration must preserve PostgreSQL, Redis, managed-database data, node identities, authenticated application state, and existing workload behavior.
- Long-lived database sessions should survive app-only replacement where the relay remains stable; new binding sessions must remain available while the app is unavailable.
- Stable daemon tunnel v1 is incompatible with standalone relay v2 lanes. Every participating daemon endpoint must be upgraded during migration, with temporary tunnel interruption treated as expected.
- The target-image foundation migrator owns reversible host configuration changes and rollback preparation.
- Release acceptance must use the exact signed candidate and explicitly verify each supported managed engine rather than extrapolating from local worktree builds.

## Fixed-size storage and installer gate

- Managed database capacity remains a hard fixed-size loop-backed ext4 image, never a Docker volume or soft quota.
- Database-profile installation validates Docker before enrollment and exercises command checks, loop allocation, non-sparse image creation, ext4 formatting, attach/mount, write probe, grow/resize, unmount, detach, and cleanup.
- Every preflight path uses cleanup traps and leaves no image, mount, or loop attachment after success or failure.
- Unsupported container environments fail before enrollment with actionable host passthrough guidance and no unbounded fallback.

## Connector socket lifecycle

- Direct socket-file mounts pin connector sidecars to a stale inode after daemon restart.
- The daemon owns a dedicated socket directory; connector sidecars mount that directory read-only.
- On daemon initialization, exact first-party managed-database connector containers are reconciled once from the legacy socket-file bind to the directory bind.
- Migration recognizes both bind and structured-mount representations, requires the exact legacy source/target relationship, preserves container configuration and network aliases, remains idempotent, and fails initialization when a required migration cannot complete.
