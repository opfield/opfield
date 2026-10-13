---
{
  "id": "yfhytkcz",
  "file_name": "yfhytkcz_token_selector_fix",
  "tags": [
    "enrollment",
    "grpc",
    "local-smoke",
    "opfield",
    "security",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1782930153895,
  "updated_at": 1791851983826
}
---
Opfield node-enrollment selector contract:

- Issue v2 tokens as `gw_node_v2_<selector>_<secret>`.
- Store an indexed nullable `nodes.enrollment_token_selector`, hash the full token, and resolve v2 enrollment by selector with at most one bcrypt comparison.
- Legacy compatibility accepts only the exact historical `gw_node_<48 hex>` format.
- Reject malformed `gw_node_*` inputs before bcrypt so they cannot trigger a legacy hash scan.
- Successful enrollment clears both the selector and the enrollment-token hash.
- Regression verification must cover malformed-token rejection without bcrypt scanning, successful v2 enrollment, legacy compatibility, selector/hash cleanup, certificate issuance, and final node state.
