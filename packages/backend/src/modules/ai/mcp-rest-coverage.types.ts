/**
 * Why a REST operation has no MCP tool. The product rule: an MCP or API agent can do everything a person can do with
 * resources; only these are left out.
 * - impersonation: acting as another user.
 * - own-auth: the caller's own sign-in, session, MFA, passkeys, profile and the first-run setup that creates the
 *   first account (no MCP token can exist before it).
 * - token-minting: issuing Opfield credentials (API tokens, OAuth grants) to the caller.
 * - chat-internals: the embedded AI chat itself (conversations, skills, sandbox, the chat socket).
 * - oauth-protocol: OAuth 2.1 / discovery protocol endpoints a client library talks to.
 * - machine: health, docs and OpenAPI, the console's realtime event socket, and endpoints machines call with their
 *   own credential (webhook receivers, registry token service, inference data plane, log ingest, public PKI).
 */
export const MCP_REST_EXCLUSION_CATEGORIES = [
  'impersonation',
  'own-auth',
  'token-minting',
  'chat-internals',
  'oauth-protocol',
  'machine',
] as const;

export type McpRestExclusionCategory = (typeof MCP_REST_EXCLUSION_CATEGORIES)[number];

/**
 * `mcp`: the MCP tools that do what the operation does, as `tool` or `tool:operation` (the value of the tool's
 * `operation` or `action` argument). `excluded`: no MCP tool, by product rule.
 */
export type McpRestCoverage =
  | { readonly mcp: readonly string[] }
  | { readonly excluded: McpRestExclusionCategory; readonly reason: string };

/** `METHOD /path` (OpenAPI `{param}` segments) to its MCP coverage. */
export type McpRestCoverageMap = Readonly<Record<string, McpRestCoverage>>;

export const mcp = (...tools: string[]): McpRestCoverage => ({ mcp: tools });
export const excluded = (category: McpRestExclusionCategory, reason: string): McpRestCoverage => ({
  excluded: category,
  reason,
});
