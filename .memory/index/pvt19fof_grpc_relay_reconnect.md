---
{
  "id": "pvt19fof",
  "file_name": "pvt19fof_grpc_relay_reconnect",
  "tags": [
    "grpc-js",
    "local-relay-outage",
    "relay",
    "root-cause"
  ],
  "layer": "lite",
  "ref": "cf7jghu8",
  "source": "model_inferred",
  "confidence": 0.5,
  "importance": 0.5,
  "created_at": 1791475480435,
  "updated_at": 1791851471234
}
---
[→ cf7jghu8] Root cause seen in the v2.11.4-rc.5 stand run (F-2, O-2): after the local relay container restarts, Docker may give it another address, and Opfield's grpc-js...
