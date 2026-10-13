---
{
  "id": "xg6y81q3",
  "file_name": "xg6y81q3_gateway_mcp_scope",
  "tags": [
    "compatibility",
    "list-changed",
    "mcp",
    "oauth",
    "opfield",
    "tool-discovery"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1780944066594,
  "updated_at": 1791851966995
}
---
Opfield assistant/MCP tool exposure and discovery contract:
- AI_TOOLS is the shared definition registry. The embedded assistant uses the current user's Opfield scopes; remote MCP lists and executes eligible definitions through the MCP OAuth token's delegated scopes.
- Assistant-only coordination tools use AIToolDefinition.exposure = "assistant". MCP eligibility is filtered centrally by isEligibleMcpTool; do not special-case assistant-only tools into MCP always-visible lists.
- Aggregate manage_* tools may be visible when the actor has any related delegated scope, but AIService must enforce the exact operation-specific scope before calling the service. Database query tools additionally require direct databases:view for the same database before read/write/admin query scopes are useful.
- discover_tools activation is keyed by authentication type, token id/prefix, and OAuth client id, never by arbitrary client-provided MCP session ids. The same client may use multiple transport sessions; different clients must remain isolated.
- Opfield declares tools.listChanged and, after a real toolset activation, sends notifications/tools/list_changed on the related Streamable HTTP response. With @modelcontextprotocol/sdk 1.29, enableJsonResponse:true drops related notifications because JSON mode only resolves result/error messages; Opfield must use SSE response mode and extra.sendNotification for this path.
- MCP setting mcp:extended_compatibility is global and opt-out: an absent persisted value is true, while stored false remains an explicit administrator choice. When true, tools/list eagerly returns every MCP-eligible tool allowed by OAuth scopes and omits discover_tools. When false, tools/list exposes the core inventory plus discover_tools, and newly activated toolsets are ordered first in paginated results. Call authorization and operation-specific scope checks remain unchanged.
- Extended compatibility is administrator-controlled through Settings > Opfield > OAuth and MCP access and the existing get_gateway_settings/update_gateway_settings contracts. There is no User-Agent-based Codex special case. Disable it only for harnesses that inject all tool schemas into context and exhaust it; clients that cache an initial catalog still need a new MCP connection after the toggle changes.
- Regression coverage must include MCP list/call scope filtering, cross-session same-client sharing, different-client isolation, SSE tools/list_changed after discover_tools, opt-out eager listing/default behavior, explicit disabled discovery behavior, settings persistence/API projection, and the frontend toggle.
