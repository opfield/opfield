/**
 * Unified scope definitions for group and user-specific permissions.
 * Both session users (via group membership) and API tokens use these scopes.
 *
 * Naming convention: domain:resource:action[:qualifier]
 * Resource-scopable scopes support suffixes: e.g. docker:containers:view:node-uuid
 */

import { RETIRED_SCOPE_REPLACEMENTS, replaceRetiredScopes, retiredScopeBase } from './scopes-aliases.js';
import { ALL_SCOPES, PROGRAMMATIC_DENIED_SCOPE_SET } from './scopes-base.js';
import { gitScopeQualifierIssue, isGitScopeBase } from './scopes-git.js';
import { RESOURCE_SCOPABLE } from './scopes-resource.js';

export * from './scopes-aliases.js';
export * from './scopes-base.js';
export * from './scopes-builtins.js';
export * from './scopes-git.js';
export * from './scopes-implications.js';
export * from './scopes-resource.js';

const ALL_SCOPES_SET = new Set<string>(ALL_SCOPES);
const RESOURCE_SCOPABLE_SET = new Set<string>(RESOURCE_SCOPABLE);
/** The most `:`-separated segments any resource-scopable base has (a qualified scope has more). */
const RESOURCE_SCOPABLE_MAX_SEGMENTS = Math.max(...RESOURCE_SCOPABLE.map((scope) => scope.split(':').length));

export const MANUAL_APPROVAL_SCOPES = [
  'storage:credentials:reveal',
  'storage:iam',
  'databases:backups:restore',
  'pki:ca:create:root',
  'pki:ca:create:intermediate',
  'pki:ca:export',
  'pki:ca:revoke:root',
  'pki:ca:revoke:intermediate',
  'pki:cert:export',
  'ssl:cert:issue',
  'ssl:cert:delete',
  'proxy:raw:write',
  'proxy:unrestricted',
  'proxy:templates:manage',
  'pages:delete',
  'pages:tokens:manage',
  'pages:settings:edit',
  'nodes:manage',
  'nodes:console',
  'nodes:files:read',
  'nodes:files:write',
  'docker:containers:console',
  'docker:containers:files:read',
  'docker:containers:files:write',
  'docker:containers:export',
  'docker:containers:secrets',
  'docker:containers:mounts',
  'docker:containers:migrate',
  'docker:volumes:export',
  'docker:volumes:files:read',
  'docker:volumes:files:write',
  'databases:query:read',
  'databases:query:write',
  'databases:query:admin',
  'databases:credentials:reveal',
  'integrations:gitlab:use',
  'integrations:gitlab:repo:write',
  'integrations:gitlab:sandbox:clone',
  'integrations:github:use',
  'integrations:github:repo:write',
  'integrations:git:use',
  'integrations:git:repo:write',
  'integrations:ssh:use',
  'integrations:hosting:manage',
  'hosting:resources:create',
  'hosting:resources:delete',
  'hosting:snapshots:restore',
  'hosting:billing:topup',
  'logs:tokens:create',
  'feat:ai:use',
  'admin:audit',
  'audit:siem:manage',
  'admin:details:certificates',
  'admin:update',
  'admin:system',
  'admin:users',
  'admin:groups',
  'settings:opfield:edit',
  'storage:bind',
] as const;
export const MANUAL_APPROVAL_SCOPE_SET = new Set<string>(MANUAL_APPROVAL_SCOPES);

/** Extract the base scope from a potentially resource-scoped string */
export function extractBaseScope(scope: string): string {
  if (ALL_SCOPES_SET.has(scope)) return scope;
  // Longest resource-scopable prefix ending at a `:` with a non-empty qualifier after it. Bases have
  // at most RESOURCE_SCOPABLE_MAX_SEGMENTS segments, so only that many separators are tried (hot path).
  const separators: number[] = [];
  for (let index = 0; index < scope.length && separators.length < RESOURCE_SCOPABLE_MAX_SEGMENTS; index += 1) {
    if (scope.charCodeAt(index) === 58) separators.push(index);
  }
  for (let candidate = separators.length - 1; candidate >= 0; candidate -= 1) {
    const end = separators[candidate];
    const base = scope.slice(0, end);
    if (RESOURCE_SCOPABLE_SET.has(base) && scope.length > end + 1) return base;
  }
  return scope;
}

function hasCatalogBase(scope: string): boolean {
  const base = extractBaseScope(scope);
  return ALL_SCOPES_SET.has(base) && (scope === base || RESOURCE_SCOPABLE_SET.has(base));
}

/**
 * Retired names that read as a qualified current scope (`pki:ca:view:root` as `pki:ca:view` on CA "root"). Stored
 * grants keep retired names for older releases (migration 0200), and they must never grant anything here.
 */
const RETIRED_CATALOG_LOOKALIKES = Object.keys(RETIRED_SCOPE_REPLACEMENTS).filter(hasCatalogBase);

/** Check if a scope string has a valid base scope */
export function isValidBaseScope(scope: string): boolean {
  if (!hasCatalogBase(scope)) return false;
  return !RETIRED_CATALOG_LOOKALIKES.some((retired) => scope === retired || scope.startsWith(`${retired}:`));
}

/** Check whether a scope may be delegated to an API token */
export function isApiTokenScope(scope: string): boolean {
  return isValidBaseScope(scope) && !PROGRAMMATIC_DENIED_SCOPE_SET.has(extractBaseScope(scope));
}

/** Gateway MCP grants carry the same delegable scopes as API tokens. */
export function isMcpTokenScope(scope: string): boolean {
  return isApiTokenScope(scope) && extractBaseScope(scope) !== 'mcp:use';
}

/** Check if a scope string is a resource-scoped variant */
export function isResourceScoped(scope: string): boolean {
  const base = extractBaseScope(scope);
  return scope !== base && RESOURCE_SCOPABLE.includes(base);
}

/**
 * Base and validity of stored scope strings, which repeat on every request (a user can hold hundreds of
 * resource grants). Both are pure functions of the string and the built-in catalog. Bounded: long strings are
 * not kept and the map starts over when full.
 */
const SCOPE_CLASS_CACHE_MAX_ENTRIES = 20_000;
const SCOPE_CLASS_CACHE_MAX_LENGTH = 512;
const scopeClassCache = new Map<string, string | null>();

/** The base of a valid scope, or null for an invalid one. */
function validScopeBase(scope: string): string | null {
  const cached = scopeClassCache.get(scope);
  if (cached !== undefined) return cached;
  const base = isValidBaseScope(scope) ? extractBaseScope(scope) : null;
  if (scope.length <= SCOPE_CLASS_CACHE_MAX_LENGTH) {
    if (scopeClassCache.size >= SCOPE_CLASS_CACHE_MAX_ENTRIES) scopeClassCache.clear();
    scopeClassCache.set(scope, base);
  }
  return base;
}

/** Canonicalize valid scopes so broad scopes win over resource-scoped variants. */
export function canonicalizeScopes(scopes: readonly string[]): string[] {
  const exactScopes = new Set<string>();
  const resourceScopedByBase = new Map<string, Set<string>>();

  for (const rawScope of scopes) {
    const scope = rawScope.trim();
    if (!scope) continue;
    const base = validScopeBase(scope);
    if (base === null) continue;
    if (scope === base) {
      exactScopes.add(scope);
      continue;
    }
    if (!resourceScopedByBase.has(base)) resourceScopedByBase.set(base, new Set());
    resourceScopedByBase.get(base)!.add(scope);
  }

  const canonical = new Set<string>(exactScopes);
  for (const [base, scopedVariants] of resourceScopedByBase.entries()) {
    if (exactScopes.has(base)) continue;
    for (const scope of scopedVariants) canonical.add(scope);
  }

  return [...canonical].sort();
}

export function withoutManualApprovalScopes(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => !MANUAL_APPROVAL_SCOPE_SET.has(extractBaseScope(scope)));
}

/** Whether an inbound scope string is a retired name that will be rewritten or dropped. */
export function isRetiredScope(scope: string): boolean {
  return retiredScopeBase(scope.trim()) !== null;
}

/** Stored scopes without the retired names kept there for older releases; they grant nothing in this one. */
export function withoutRetiredScopes(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => !isRetiredScope(scope));
}

/**
 * Accept a scope from a client: a valid canonical scope, or a retired name that canonicalization
 * rewrites (dropped scopes are accepted and then removed).
 */
export function isValidInboundScope(scope: string): boolean {
  const trimmed = scope.trim();
  if (!isRetiredScope(trimmed)) return isValidInboundCanonicalScope(trimmed);
  return replaceRetiredScopes([trimmed]).every(isValidInboundCanonicalScope);
}

/** A valid canonical scope whose Git qualifier, if any, has the connector/group/project/owner/repo shape. */
function isValidInboundCanonicalScope(scope: string): boolean {
  if (!isValidBaseScope(scope)) return false;
  const base = extractBaseScope(scope);
  return scope === base || !isGitScopeBase(base) || gitScopeQualifierIssue(base, scope.slice(base.length + 1)) === null;
}

/**
 * Canonicalize a client-supplied scope list: rewrite retired names (qualifier-preserving), drop
 * removed ones, then canonicalize like stored scopes. Use at every input boundary, never in checks.
 */
export function canonicalizeInboundScopes(scopes: readonly string[]): string[] {
  return canonicalizeScopes(replaceRetiredScopes(scopes));
}
