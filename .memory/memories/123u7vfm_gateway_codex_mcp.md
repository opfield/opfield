---
{
  "id": "123u7vfm",
  "file_name": "123u7vfm_gateway_codex_mcp",
  "tags": [
    "mcp",
    "oauth",
    "opfield",
    "permissions",
    "tokens"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1781686976868,
  "updated_at": 1791851116862
}
---
Opfield OAuth and MCP token contract:
- Opfield remains a first-party HTTP MCP server with backend-owned authentication, resource, scope, and tool semantics.
- Backend OAuth endpoints live under /api/oauth/* (register, authorize, token, revoke, consent API, authorizations API). The browser consent page remains /oauth/consent?request=..., and /.well-known/* metadata advertises the backend endpoints.
- API-resource OAuth access tokens are general programmatic /api credentials and use ordinary expiry plus rotating refresh tokens.
- MCP-resource grants issue long-lived gwo_ access tokens with oauth_access_tokens.expires_at = NULL and no refresh token. Metadata advertises authorization_code only for MCP. Existing MCP tokens are backfilled; a legacy MCP refresh token may be exchanged once for a long-lived token without issuing another refresh token.
- MCP accepts only OAuth access tokens bound to the MCP resource. Browser sessions, gw_ API tokens, logging tokens, and OAuth tokens for another resource are not MCP credentials.
- Remote MCP remains bounded by delegable programmatic Opfield scopes plus the owning user's mcp:use capability. Non-programmatic admin/browser/AI/settings/raw-config scopes are not remotely usable merely because a synthetic test can name them.
- Validation, authorization listing, scope updates, revoke behavior, effective-scope rebinding, resource matching, and mcp:use gating remain backend-enforced.
- When changing this contract, verify OAuth service/routes, MCP routes/auth, revocation, migration/backfill, and legacy one-time exchange.
