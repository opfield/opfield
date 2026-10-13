---
{
  "id": "o3fs6euy",
  "file_name": "o3fs6euy_state_machine_gotchas",
  "tags": [
    "ai-chat",
    "opfield",
    "production-readiness",
    "providers",
    "recovery",
    "snapshots",
    "websocket"
  ],
  "layer": "lite",
  "ref": "qme9z5oh",
  "source": "model_inferred",
  "confidence": 0.5,
  "importance": 0.5,
  "created_at": 1783631313911,
  "updated_at": 1791851858395
}
---
[→ qme9z5oh] Opfield AI chat state-machine verification contract:

- Snapshot ordering must be monotonic per conversation. Assemble snapshots consistently, serialize or c...
