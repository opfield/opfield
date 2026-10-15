import { ALL_SCOPES } from './scopes-base.js';

/**
 * Scope names retired by the v2.11 catalog cleanup, mapped to their replacements.
 *
 * Migration 0200_scope_catalog_cleanup added the replacements to stored grants and kept the retired
 * names next to them, so a release before v2.11 that an updater rolls back to still reads its own
 * names (`withRetiredScopeReplacements`). Clients, scripts, and MCP agents keep sending the old names
 * for a while, so inbound scope lists (OAuth authorize, API token create/update, group create/update,
 * user additional scopes, OAuth authorization edits) are canonicalized with this table before
 * validation. The mapping preserves resource, folder, and node qualifiers: `old:<suffix>` becomes
 * `new:<suffix>`. An empty replacement list drops the scope.
 *
 * Never consult this table while checking permissions: `hasScope` stays on the canonical catalog and
 * a stored retired name grants nothing (`isValidBaseScope` rejects it). Remove the table, and the
 * retired names from stored grants, two releases after v2.11.
 */
export const RETIRED_SCOPE_REPLACEMENTS: Readonly<Record<string, readonly string[]>> = {
  // Never enforced.
  'ssl:cert:revoke': [],
  'ssl:cert:export': [],
  // Notifications use one view and one manage scope per area.
  'notifications:view': ['notifications:alerts:view', 'notifications:webhooks:view'],
  'notifications:manage': ['notifications:alerts:manage', 'notifications:webhooks:manage'],
  'notifications:alerts:create': ['notifications:alerts:manage'],
  'notifications:alerts:edit': ['notifications:alerts:manage'],
  'notifications:alerts:delete': ['notifications:alerts:manage'],
  'notifications:webhooks:create': ['notifications:webhooks:manage'],
  'notifications:webhooks:edit': ['notifications:webhooks:manage'],
  'notifications:webhooks:delete': ['notifications:webhooks:manage'],
  'notifications:deliveries:view': ['notifications:webhooks:view'],
  // The logging catch-all expands to every logging scope.
  'logs:manage': ALL_SCOPES.filter((scope) => scope.startsWith('logs:')),
  // Duplicate and recreate require environment and secrets; node addresses require nodes:manage.
  'docker:containers:config': [],
  // General node control: nginx config, secure runtime, service address, hosting power and restore.
  'nodes:config:edit': ['nodes:manage'],
  // One CA view scope, qualifiable by CA ID.
  'pki:ca:view:root': ['pki:ca:view'],
  'pki:ca:view:intermediate': ['pki:ca:view'],
  // Git providers share view, manage, use, repo:read, and repo:write.
  'integrations:gitlab:sync': ['integrations:gitlab:manage'],
  'integrations:gitlab:system': ['integrations:gitlab:use'],
  // Listing projects is connector metadata; repository content, pipelines, and variable keys are repo:read.
  'integrations:gitlab:projects:view': ['integrations:gitlab:view'],
  'integrations:gitlab:ci:view': ['integrations:gitlab:repo:read'],
  // Variable values are secrets and now need repo:write; variables:view holders deliberately lose them.
  'integrations:gitlab:variables:view': ['integrations:gitlab:repo:read'],
  'integrations:gitlab:ci:edit': ['integrations:gitlab:repo:write'],
  'integrations:gitlab:variables:edit': ['integrations:gitlab:repo:write'],
  'integrations:gitlab:variables:delete': ['integrations:gitlab:repo:write'],
  'integrations:gitlab:webhooks:manage': ['integrations:gitlab:repo:write'],
  'integrations:gitlab:registry:manage': ['integrations:gitlab:repo:write'],
  'integrations:github:sync': ['integrations:github:manage'],
  'integrations:github:system': ['integrations:github:use'],
  'integrations:git:sync': ['integrations:git:manage'],
  'integrations:git:system': ['integrations:git:use'],
  // Proxy: raw toggling is part of raw writes; both bypasses are one unrestricted scope.
  'proxy:raw:toggle': [],
  'proxy:advanced:bypass': ['proxy:unrestricted'],
  'proxy:raw:bypass': ['proxy:unrestricted'],
  'proxy:templates:create': ['proxy:templates:manage'],
  'proxy:templates:edit': ['proxy:templates:manage'],
  'proxy:templates:delete': ['proxy:templates:manage'],
  // Docker folders cover every Docker resource type, not only containers.
  'docker:containers:folders:manage': ['docker:folders:manage'],
  // Hosting top-up invoices were removed in 2.12 (the endpoint answers 410); stored grants of it grant nothing.
  'hosting:billing:topup': [],
};

/**
 * Additional grants migration 0200 gave holders of a still-canonical scope so nobody lost access
 * that used to hide behind it (see `scopeCleanupAdditions` for qualifier handling). New API tokens and
 * OAuth requests receive them too, limited to what the requester holds, so older scripts that mint a
 * token with `integrations:github:manage` keep repository writes.
 */
export const SCOPE_CLEANUP_MIGRATION_ADDITIONS: Readonly<Record<string, readonly string[]>> = {
  // CA key export and CA edits used to require pki:ca:create:root.
  'pki:ca:create:root': ['pki:ca:edit', 'pki:ca:export'],
  // GitHub and generic Git repository reads used to require view, and writes manage.
  'integrations:github:view': ['integrations:github:repo:read'],
  'integrations:github:manage': ['integrations:github:repo:read', 'integrations:github:repo:write'],
  'integrations:git:view': ['integrations:git:repo:read'],
  'integrations:git:manage': ['integrations:git:repo:read', 'integrations:git:repo:write'],
  // Volume resize and adoption used to require the create scope (broad or on the volume's node).
  'docker:volumes:create': ['docker:volumes:edit'],
};

/**
 * The additions for one scope. An unqualified trigger adds unqualified scopes; a qualified trigger
 * passes its qualifier on only when it names a resource or a bare Docker node ID. Folder and `node/`
 * destinations never receive additions: a destination-only creation grant must not turn into access to
 * the resources already there.
 */
export function scopeCleanupAdditions(scope: string): string[] {
  for (const [trigger, additions] of Object.entries(SCOPE_CLEANUP_MIGRATION_ADDITIONS)) {
    if (scope === trigger) return [...additions];
    if (!scope.startsWith(`${trigger}:`)) continue;
    const qualifier = scope.slice(trigger.length + 1);
    if (!qualifier || qualifier.startsWith('folder/') || qualifier.startsWith('node/')) return [];
    return additions.map((addition) => `${addition}:${qualifier}`);
  }
  return [];
}

const RETIRED_SCOPES_BY_LENGTH = Object.keys(RETIRED_SCOPE_REPLACEMENTS).sort((a, b) => b.length - a.length);

/** The retired scope name a scope string starts with, if any (longest match, qualifier-aware). */
export function retiredScopeBase(scope: string): string | null {
  for (const retired of RETIRED_SCOPES_BY_LENGTH) {
    if (scope === retired || scope.startsWith(`${retired}:`)) return retired;
  }
  return null;
}

/** Rewrite retired scope names to their replacements, preserving qualifiers. Unknown scopes pass through. */
export function replaceRetiredScopes(scopes: readonly string[]): string[] {
  const result: string[] = [];
  for (const rawScope of scopes) {
    const scope = rawScope.trim();
    const retired = retiredScopeBase(scope);
    if (!retired) {
      result.push(scope);
      continue;
    }
    const suffix = scope.slice(retired.length);
    for (const replacement of RETIRED_SCOPE_REPLACEMENTS[retired]) result.push(`${replacement}${suffix}`);
  }
  return [...new Set(result)];
}

/**
 * What migration 0200 does to a stored scope list: retired names stay and gain their replacements
 * (qualifiers preserved), and scopes whose capabilities moved gain their additions. Nothing is removed,
 * so a release before v2.11 still finds its own names after a rollback, and a second run changes nothing.
 */
export function withRetiredScopeReplacements(scopes: readonly string[]): string[] {
  const current = replaceRetiredScopes(scopes);
  return [...new Set([...scopes, ...current, ...current.flatMap(scopeCleanupAdditions)])];
}

/**
 * Migration 0197 gave custom groups holding a connector's manage scope its sync scope. 0200 retired the
 * Git providers' sync scopes again, so only Cloudflare's still stands on its own.
 */
export const PLATFORM_HARDENING_GROUP_ADDITIONS: Readonly<Record<string, string>> = {
  'integrations:cloudflare:manage': 'integrations:cloudflare:sync',
};
