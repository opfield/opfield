---
{
  "id": "abg0hmwc",
  "file_name": "abg0hmwc_docker_build_lifecycle",
  "tags": [
    "ack",
    "attempt",
    "docker-build",
    "grpc",
    "lease",
    "recovery",
    "rollout",
    "scheduler"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1788297772805,
  "updated_at": 1791851357659
}
---
Opfield Docker build terminal and rollout contract as of 2026-09-02:

- State-bearing DockerBuildEvent messages are serialized per node/build. Logs and heartbeats bypass the lifecycle tail.
- Build commands/events carry an attempt number. Terminal ACK is attempt-scoped with disposition accepted or obsolete. accepted means durable backend acceptance, not rollout completion. obsolete releases stale/conflicting workers.
- Legacy attempt-zero events are accepted only while the persisted build attempt is exactly 1. This prevents an old pre-attempt worker from mutating a reclaimed attempt.
- The worker cleans its workspace and removes the completed job from local parallelism accounting before terminal ACK retry. It retries every 15 seconds for at most 2 minutes; this bounded transport wait no longer occupies a Build Worker slot. Attempt-guarded cleanup cannot delete replacement job state for the same build ID.
- The default build/rollout lease is 60 seconds. A successful artifact atomically transfers the pushing worker lease to a backend-owned deploying lease and persists deterministic progress.rollout metadata: operationId, attempt, and phase accepted. Before any external rollout, the backend durably changes phase to executing and verifies the current lease/operation identity again.
- Worker heartbeats and delayed failed terminal events cannot renew or terminate a backend-owned deploying lease. Duplicate succeeded events are acknowledged safely.
- Backend rollout heartbeats run every 15 seconds. Recovery runs every scheduler reconciliation, including when no Build Worker is online.
- For container/deployment targets, an expired accepted rollout may resume. Once phase is executing, recovery takes a nonblocking source advisory lock and re-reads source state under the lock. It never blindly replays the external mutation: it reconciles a superseded or durably deployed commit, otherwise terminates with BUILD_ROLLOUT_INTERRUPTED for explicit/manual recovery.
- Compose and Pages may resume executing rollouts because they already have durable idempotency contracts. Legacy deploying rows without rollout metadata receive deterministic metadata during idempotent recovery.
- Normal upgrade order remains backend, relay, then daemons. Old daemons emit attempt zero on first attempt. A new daemon reconnecting to an old backend may keep an ACK retry goroutine for up to 2 minutes, but the completed job no longer consumes worker capacity.
