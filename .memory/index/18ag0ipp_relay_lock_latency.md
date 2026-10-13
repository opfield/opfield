---
{
  "id": "18ag0ipp",
  "file_name": "18ag0ipp_relay_lock_latency",
  "tags": [
    "docker-daemon",
    "latency",
    "locking",
    "managed-database",
    "relay"
  ],
  "layer": "lite",
  "ref": "l2g94u2b",
  "source": "model_inferred",
  "confidence": 0.5,
  "importance": 0.5,
  "created_at": 1790522295535,
  "updated_at": 1791851707441
}
---
[→ l2g94u2b] Root cause of ~2 s new-connection latency to managed databases through the relay (docker daemon up to v2.11.0-rc.16): `managedDatabaseManager.handle()` held ...
