---
{
  "id": "bdpdrell",
  "file_name": "bdpdrell_docker_timeout_proto3",
  "tags": [
    "daemon",
    "docker",
    "gotcha",
    "proto3",
    "timeout"
  ],
  "layer": "lite",
  "ref": "wlpy3efl",
  "source": "model_inferred",
  "confidence": 0.5,
  "importance": 0.5,
  "created_at": 1777897421801,
  "updated_at": 1791851928101
}
---
[→ wlpy3efl] Docker daemon container stop/restart commands use proto3 `timeout_seconds`, which has no presence tracking. Opfield resolves and always sends a timeout, and ...
