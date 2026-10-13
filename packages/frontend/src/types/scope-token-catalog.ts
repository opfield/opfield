import { CORE_TOKEN_SCOPES } from "./scope-token-core";
import { INFRASTRUCTURE_TOKEN_SCOPES } from "./scope-token-infrastructure";
import { PLATFORM_TOKEN_SCOPES } from "./scope-token-platform";

export const TOKEN_SCOPES = [
  ...CORE_TOKEN_SCOPES,
  ...PLATFORM_TOKEN_SCOPES,
  ...INFRASTRUCTURE_TOKEN_SCOPES,
] as const;

// Mirrors backend PROGRAMMATIC_DENIED_BASE_SCOPES: only browser/identity-bound scopes stay user-only.
const PROGRAMMATIC_DENIED_SCOPE_VALUES = new Set<string>([
  "ai:workspace:use",
  "feat:ai:configure",
  "ai:skills:manage",
  "ai:sandbox:use",
  "ai:sandbox:tier:medium",
  "ai:sandbox:tier:high",
  "ai:sandbox:manage",
  "mcp:use",
  "admin:users:impersonate",
  "integrations:gitlab:sandbox:clone",
]);

export const API_TOKEN_SCOPES = TOKEN_SCOPES.filter(
  (scope) => !PROGRAMMATIC_DENIED_SCOPE_VALUES.has(scope.value)
);

// Gateway MCP delegates exactly the API token scopes.
export const MCP_TOKEN_SCOPES = API_TOKEN_SCOPES.filter((scope) => scope.value !== "mcp:use");

export const GROUP_ASSIGNABLE_SCOPES = TOKEN_SCOPES.filter(
  (scope) => scope.value !== "admin:system"
);
