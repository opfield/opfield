---
{
  "id": "mzmjdewo",
  "file_name": "mzmjdewo_codex_gateway_wrapper",
  "tags": [
    "cli",
    "codex",
    "desktop",
    "gateway-inference",
    "usage",
    "wrapper"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1787493437067,
  "updated_at": 1791851770707
}
---
# Opfield Codex companion lifecycle

- `@sqgateway/inference` configures Codex through `setup codex` and never shadows or replaces the system `codex` executable.
- The experimental Desktop/CLI usage wrappers are removed. Current setup cleans package-owned legacy wrapper artifacts automatically.
- `uninstall codex-usage` remains an ownership-aware offline cleanup command for affected historical installations and preserves the base Codex integration, runtime token, catalog, MCP, and proxy.
- Codex usage and quota displays remain native; Opfield limits are shown in Opfield UI.
- Opfield inference uses the stable `/api/inference/v1` prefix, dedicated `gwi_` credentials, and a feature toggle persisted in Opfield settings.
- Codex setup uses the official account login state plus Opfield-owned runtime credentials, installs a private helper/proxy, refreshes the model catalog, and preserves unrelated Codex configuration.
- Catalog validation rejects invalid `web_search_tool_type`, preserves the last-good catalog, and advertises hosted-search capability accurately.
- Companion state is scoped per resolved Codex configuration home. Shared runtime credentials/catalog state are removed only after the final managed home is detached.
- Cleanup, diagnostics, and staging validation must not alter user-owned provider configuration or quota.
