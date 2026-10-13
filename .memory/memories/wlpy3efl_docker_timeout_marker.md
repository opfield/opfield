---
{
  "id": "wlpy3efl",
  "file_name": "wlpy3efl_docker_timeout_marker",
  "tags": [
    "daemon",
    "docker",
    "gotcha",
    "proto3",
    "timeout"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.82,
  "created_at": 1777897421801,
  "updated_at": 1791851928101
}
---
Docker daemon container stop/restart commands use proto3 `timeout_seconds`, which has no presence tracking. Opfield resolves and always sends a timeout, and marks explicit Opfield-provided timeout semantics with `configJson: {"timeoutProvided": true}` so daemon fallback can treat daemon-direct/older omitted `0` as the default while preserving explicit `0` from Opfield as immediate stop.
