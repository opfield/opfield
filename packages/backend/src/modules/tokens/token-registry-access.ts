import { z } from 'zod';
import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { extractBaseScope } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';

/**
 * Internal registry access of an API token: what `docker login` with the token may pull or push from outside
 * Opfield. It belongs to the token, not to a user scope. The owner may give a token pull when they can view a
 * Docker workload or image anywhere, and push when they can change a workload; every request rechecks that against
 * the owner's current permissions. `all` covers every repository; a list narrows the token to exactly those
 * repository names (no prefix match), like the per-repository registry scopes did. An absent action is not granted.
 *
 * Tokens created before this attribute carry `docker:registries:internal:pull|push[:<repository>]` in their scopes,
 * and scripts may still send those names: both read as registry access. The two scopes stay in the catalog as legacy
 * user grants, so their holders keep giving tokens registry access for the repositories they cover.
 */
export const REGISTRY_ACTIONS = ['pull', 'push'] as const;
export type RegistryAction = (typeof REGISTRY_ACTIONS)[number];
export type RegistryRepositories = 'all' | string[];
export type TokenRegistryAccess = Partial<Record<RegistryAction, RegistryRepositories>>;

export const REGISTRY_REPOSITORY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const MAX_REGISTRY_REPOSITORIES = 100;

const RegistryRepositoriesSchema = z.union([
  z.literal('all'),
  z
    .array(z.string().trim().max(255).regex(REGISTRY_REPOSITORY_PATTERN, 'Invalid registry repository name'))
    .min(1)
    .max(MAX_REGISTRY_REPOSITORIES),
]);

export const TokenRegistryAccessSchema = z
  .object({ pull: RegistryRepositoriesSchema.optional(), push: RegistryRepositoriesSchema.optional() })
  .strict()
  .describe(
    'Internal registry access of the token: pull and push each "all" or a list of repository names; omit an action to deny it.'
  );

const LEGACY_REGISTRY_SCOPES: Record<RegistryAction, string> = {
  pull: 'docker:registries:internal:pull',
  push: 'docker:registries:internal:push',
};

/** What lets the owner give a token each action, besides the legacy registry scopes. */
const REGISTRY_ACCESS_BASIS: Record<RegistryAction, readonly string[]> = {
  pull: ['docker:containers:view', 'docker:compose:view', 'docker:images:view'],
  push: ['docker:containers:edit', 'docker:containers:manage', 'docker:compose:manage'],
};

export function isLegacyRegistryScope(scope: string): boolean {
  const base = extractBaseScope(scope);
  return base === LEGACY_REGISTRY_SCOPES.pull || base === LEGACY_REGISTRY_SCOPES.push;
}

export function hasRegistryAccess(access: TokenRegistryAccess | null | undefined): boolean {
  return !!access && REGISTRY_ACTIONS.some((action) => access[action] !== undefined);
}

/** Every action once, lists deduplicated and sorted, empty lists dropped. */
export function mergeRegistryAccess(...accesses: Array<TokenRegistryAccess | null | undefined>): TokenRegistryAccess {
  const merged: TokenRegistryAccess = {};
  for (const action of REGISTRY_ACTIONS) {
    const granted = accesses.map((access) => access?.[action]).filter((value) => value !== undefined);
    if (granted.some((value) => value === 'all')) {
      merged[action] = 'all';
      continue;
    }
    const repositories = [...new Set((granted as string[][]).flat())].sort();
    if (repositories.length > 0) merged[action] = repositories;
  }
  return merged;
}

/** Legacy registry scopes in a token's scope list, read as registry access. */
function registryAccessFromScopes(scopes: readonly string[]): TokenRegistryAccess {
  const access: TokenRegistryAccess = {};
  for (const action of REGISTRY_ACTIONS) {
    const base = LEGACY_REGISTRY_SCOPES[action];
    for (const scope of scopes) {
      if (scope === base) access[action] = 'all';
      else if (scope.startsWith(`${base}:`) && access[action] !== 'all') {
        access[action] = [...((access[action] as string[] | undefined) ?? []), scope.slice(base.length + 1)];
      }
    }
  }
  return mergeRegistryAccess(access);
}

/** A client scope list without the legacy registry scopes, and the registry access those scopes asked for. */
export function splitRegistryScopes(scopes: readonly string[]): {
  scopes: string[];
  registryAccess: TokenRegistryAccess;
} {
  return {
    scopes: scopes.filter((scope) => !isLegacyRegistryScope(scope)),
    registryAccess: registryAccessFromScopes(scopes.filter(isLegacyRegistryScope)),
  };
}

/** A stored token's registry access: its attribute plus the legacy registry scopes it was created with. */
export function tokenRegistryAccess(token: {
  registryAccess?: TokenRegistryAccess | null;
  scopes?: readonly string[] | null;
}): TokenRegistryAccess {
  return mergeRegistryAccess(token.registryAccess, registryAccessFromScopes(token.scopes ?? []));
}

/** Whether the owner's scopes let their tokens run this registry action (on this repository). */
export function ownerMayUseRegistry(ownerScopes: string[], action: RegistryAction, repository?: string): boolean {
  if (REGISTRY_ACCESS_BASIS[action].some((scope) => hasScopeBase(ownerScopes, scope))) return true;
  const legacy = LEGACY_REGISTRY_SCOPES[action];
  return repository ? hasScope(ownerScopes, `${legacy}:${repository}`) : hasScopeBase(ownerScopes, legacy);
}

/**
 * Refuse registry access the owner cannot give a token: pull needs view access to a Docker workload or image
 * (or the legacy pull scope), push the right to change a workload (or the legacy push scope).
 */
export function assertTokenRegistryAccessAllowed(access: TokenRegistryAccess, ownerScopes: string[]): void {
  const denied: string[] = [];
  for (const action of REGISTRY_ACTIONS) {
    const repositories = access[action];
    if (repositories === undefined) continue;
    if (repositories === 'all') {
      if (!ownerMayUseRegistry(ownerScopes, action)) denied.push(action);
      continue;
    }
    for (const repository of repositories) {
      if (!ownerMayUseRegistry(ownerScopes, action, repository)) denied.push(`${action} ${repository}`);
    }
  }
  if (denied.length > 0) {
    throw new AppError(
      403,
      'REGISTRY_ACCESS_NOT_ALLOWED',
      `Your permissions cannot give a token internal registry access: ${denied.join(', ')}`
    );
  }
}

/** Whether a token may run a registry action on a repository now, bounded by its owner's current scopes. */
export function tokenAllowsRegistryAction(
  access: TokenRegistryAccess,
  ownerScopes: string[],
  action: RegistryAction,
  repository: string
): boolean {
  const repositories = access[action];
  if (repositories === undefined) return false;
  if (repositories !== 'all' && !repositories.includes(repository)) return false;
  return ownerMayUseRegistry(ownerScopes, action, repository);
}
