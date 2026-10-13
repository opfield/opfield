---
{
  "id": "hc1xhdcx",
  "file_name": "hc1xhdcx_anthropic_claude_code",
  "tags": [
    "anthropic",
    "claude-code",
    "credentials",
    "gateway-cli",
    "inference"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.88,
  "created_at": 1785451683980,
  "updated_at": 1791851604077
}
---
Opfield supports Claude Code CLI through `npx -y @sqgateway/inference@latest setup claude-code`; Claude Code 2.1.129 or newer is required.

- Setup issues a dedicated `gwi_` runtime token, validates Opfield model discovery and native Anthropic streaming, and stores the credential in the operating-system credential store.
- Claude settings receive package-owned `ANTHROPIC_BASE_URL`, Opfield model discovery, and an `apiKeyHelper`; the token itself is never written to the settings file.
- Opfield models use stable `claude-gateway-*` aliases accepted by Claude Code. Default Opus, Sonnet, and Haiku selections map to available Opfield models, while users may select any discovered alias.
- Merge settings atomically, preserve unrelated values, restore exact previous values on removal, and stop if a package-owned value was subsequently edited.
- The interactive manager reports, diagnoses, repairs, and removes Codex and Claude Code integrations independently.
- This integration configures Claude Code CLI only. Claude Desktop and the VS Code extension have separate configuration surfaces and are not modified automatically.
