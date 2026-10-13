---
{
  "id": "iv7hhye3",
  "file_name": "iv7hhye3_gateway_volume_metrics",
  "tags": [
    "docker",
    "metrics",
    "opfield",
    "snapshots",
    "stale-while-revalidate",
    "volumes"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1787590590176,
  "updated_at": 1791851684128
}
---
# Opfield Docker volume metrics snapshot contract

- Volume usage metrics must not be collected synchronously in the HTTP request path. The `GET /api/docker/nodes/:nodeId/volumes/:name/metrics` route reads the latest persisted `volume-metrics` detail snapshot.
- `DockerSnapshotReconciler` owns collection through the daemon `metrics` command, using the same queue, deduplication, retry/backoff, event publication, stale-data retention, and periodic detail refresh flow as other Docker snapshots.
- A missing metrics snapshot is queued urgently and the API returns `503 DOCKER_VOLUME_METRICS_PENDING` immediately; it never holds the request open for the daemon's up-to-60-second collection.
- Metrics snapshots are stored separately from `volume-detail` and are sanitized to the stable fields: storage kind, byte/inode values, running attachment count, and collection timestamp.
- Slow volume metrics run in a separate per-node reconciler lane and are capped at two global concurrent collections so they cannot block or exhaust normal container/image/volume/network snapshot capacity.
- The frontend listens for `docker.snapshot.changed` with kind `volume-metrics`, refetches the cached sample, and appends history only when `collectedAt` changes so polling the same cached sample does not fabricate duplicate points.
- Verification for this contract: targeted snapshot/reconciler/route tests, backend typecheck, frontend production build, scoped Biome, and `git diff --check`.
