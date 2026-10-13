---
{
  "id": "gpx2fdwu",
  "file_name": "gpx2fdwu_mcp_compatibility",
  "tags": [
    "assistant",
    "compatibility",
    "inference",
    "mcp",
    "opfield",
    "settings"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1786047219057,
  "updated_at": 1791851565032
}
---
Opfield Assistant guidance for Opfield Inference setup:

- For Opfield Inference setup the embedded Assistant reads the internal inference documentation first.
- If `get_gateway_settings` is available, it reports whether `generalSettings.features.inferenceEnabled` is enabled before giving setup instructions. Without `settings:gateway:view` it must not guess the installation state and should tell the user that an administrator must confirm it.
- Setup guidance uses the `@sqgateway/inference` package (`packages/gateway-inference`), discovery, and the single stable `/api/inference/v1` contract; do not reference removed harness-specific endpoint toggles.

The MCP `mcp:extended_compatibility` opt-out setting (absent = enabled, eager `tools/list`) is specified in the MCP tool exposure and discovery memory; keep Settings copy, Assistant documentation and the `update_gateway_settings` tool description synchronized with it.
