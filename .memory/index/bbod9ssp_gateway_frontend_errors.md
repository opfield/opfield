---
{
  "id": "bbod9ssp",
  "file_name": "bbod9ssp_gateway_frontend_errors",
  "tags": [
    "api",
    "backend",
    "docker",
    "frontend",
    "opfield"
  ],
  "layer": "lite",
  "ref": "37llsl1w",
  "source": "model_inferred",
  "confidence": 0.5,
  "importance": 0.5,
  "created_at": 1781735767839,
  "updated_at": 1791852045071
}
---
[→ 37llsl1w] Root cause: Some backend routes return legacy error bodies as { error: string } instead of the standard { code, message }. This caused UI to surface blank to...
