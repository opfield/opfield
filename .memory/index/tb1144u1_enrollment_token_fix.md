---
{
  "id": "tb1144u1",
  "file_name": "tb1144u1_enrollment_token_fix",
  "tags": [
    "enrollment",
    "grpc",
    "local-smoke",
    "opfield",
    "security",
    "verification"
  ],
  "layer": "lite",
  "ref": "yfhytkcz",
  "source": "model_inferred",
  "confidence": 0.5,
  "importance": 0.5,
  "created_at": 1782930153895,
  "updated_at": 1791851983826
}
---
[→ yfhytkcz] Opfield node-enrollment selector contract:

- Issue v2 tokens as `gw_node_v2_<selector>_<secret>`.
- Store an indexed nullable `nodes.enrollment_token_select...
