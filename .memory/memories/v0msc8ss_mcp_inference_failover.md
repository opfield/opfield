---
{
  "id": "v0msc8ss",
  "file_name": "v0msc8ss_mcp_inference_failover",
  "tags": [
    "diagnostics",
    "failover",
    "inference",
    "mcp",
    "oauth"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1790818827392,
  "updated_at": 1791851888959
}
---
Diagnosing Opfield inference failures through the Opfield MCP (read-only), learned on a production install 2026-09-30:

- Request a read-only OAuth scope set for diagnostics instead of the default (an MCP client without explicit scopes asks for every Opfield scope, including destructive ones). Enough for inference: nodes:details, nodes:logs, docker:containers:view, docker:compose:view, logs:environments:view, logs:schemas:view, logs:read, inference:providers:view, inference:usage:view, admin:audit, settings:gateway:view.
- Opfield backend and inference-core logs are not shipped to Opfield structured logging, and the Opfield app is usually not a container on a managed node. The useful evidence is `manage_inference_provider` {operation: list_connections} (status, syncLastError, per-connection quota snapshots with fetchedAt/validUntil/stale) and `manage_inference_usage` {operation: activity, status: failed} (per-request connection, model, errorCode, timings; paginate with page). Responses contain user names and emails: aggregate them, never report raw rows.
- Very fast failed requests (tens of ms) with errorCode provider_capacity_unavailable mean the chosen account failed before reaching the provider and failover found no usable alternative. Since fix 984d029f the provider error is reported instead of being hidden behind the failover error.
- A core OAuth connection whose quota snapshots stop advancing (fetchedAt frozen, stale) while sync still reports success means the core returned no quota for that account; Opfield writes a snapshot for any non-null core quota, including last-good.
- In inference-core, an Anthropic token refresh that fails without an HTTP answer (30 s timeout, connection reset, DNS) keeps the refresh-intent file, and the next refresh attempt marks the account needsReauth permanently (refreshAnthropicAccountWithLock); only a re-login clears it. The core's per-account OAuth state is not exposed through Opfield MCP. Since fix cf197563 Opfield sync fails with a reconnect message when the core reports needsReauth.

Where the production MCP endpoint lives and how the client stores its token: global memory (user's production Opfield installs).
