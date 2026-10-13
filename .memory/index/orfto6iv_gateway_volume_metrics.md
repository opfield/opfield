---
{
  "id": "orfto6iv",
  "file_name": "orfto6iv_gateway_volume_metrics",
  "tags": [
    "docker",
    "metrics",
    "opfield",
    "snapshots",
    "stale-while-revalidate",
    "volumes"
  ],
  "layer": "lite",
  "ref": "iv7hhye3",
  "source": "model_inferred",
  "confidence": 0.5,
  "importance": 0.5,
  "created_at": 1787590590176,
  "updated_at": 1791851684128
}
---
[→ iv7hhye3] # Opfield Docker volume metrics snapshot contract

- Volume usage metrics must not be collected synchronously in the HTTP request path. The `GET /api/docker/...
