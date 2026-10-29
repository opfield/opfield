import { z } from 'zod';
import { hasScope } from '@/lib/permissions.js';
import { extractBaseScope } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';

/**
 * Internal registry access of an API token: what `docker login` with the token may pull or push from outside
 * Opfield. It belongs to the token, not to a user scope. `all` covers every repository and needs the broad
 * (unqualified) workload or image scope; a list narrows the token to exactly those repository names (no prefix match)
 * and needs, per repository, view (pull) or edit/manage (push) on a workload whose images live there
 * (token-registry-workloads.ts). Every request rechecks that against the owner's current permissions, so tokens
 * created under the earlier, looser rule are bounded too. An absent action is not granted.
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

/** What lets the owner give a token each action on every repository, held unqualified, besides the legacy scopes. */
const REGISTRY_ACCESS_BASIS: Record<RegistryAction, readonly string[]> = {
  pull: ['docker:containers:view', 'docker:compose:view', 'docker:images:view'],
  push: ['docker:containers:edit', 'docker:containers:manage', 'docker:compose:manage'],
};

/**
 * A workload whose images live in an internal registry repository: a container or deployment (`containers`) or a
 * Compose project (`compose`), with its access resource id (null: a container without one, only node-wide grants
 * reach it).
 */
export interface RegistryRepositoryWorkload {
  kind: 'containers' | 'compose';
  nodeId: string;
  resourceId: string | null;
}

/** The workloads using a repository (RegistryRepositoryWorkloadService). */
export type RegistryRepositoryWorkloads = (repository: string) => Promise<RegistryRepositoryWorkload[]>;

/** What lets the owner give a token each action on a workload's repositories. */
const WORKLOAD_REGISTRY_SCOPES: Record<
  RegistryAction,
  Record<RegistryRepositoryWorkload['kind'], readonly string[]>
> = {
  pull: { containers: ['docker:containers:view'], compose: ['docker:compose:view'] },
  push: { containers: ['docker:containers:edit', 'docker:containers:manage'], compose: ['docker:compose:manage'] },
};

function ownerCoversWorkload(
  ownerScopes: readonly string[],
  action: RegistryAction,
  workload: RegistryRepositoryWorkload
): boolean {
  // The images of the workload's node include the ones it pulled from the repository.
  if (action === 'pull' && hasScope(ownerScopes, `docker:images:view:${workload.nodeId}`)) return true;
  const qualifier = workload.resourceId ? `${workload.nodeId}/${workload.resourceId}` : workload.nodeId;
  return WORKLOAD_REGISTRY_SCOPES[action][workload.kind].some((scope) =>
    hasScope(ownerScopes, `${scope}:${qualifier}`)
  );
}

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

/**
 * Whether the owner's scopes let their tokens run this registry action on every repository (no `repository`) or on
 * one. Every repository needs the broad workload or image scope or the unqualified legacy scope; one repository is
 * also covered by view (pull) or edit/manage (push) on one of `workloads` (the workloads using it), or by the legacy
 * scope for that repository.
 */
export function ownerMayUseRegistry(
  ownerScopes: readonly string[],
  action: RegistryAction,
  repository?: string,
  workloads: readonly RegistryRepositoryWorkload[] = []
): boolean {
  if (REGISTRY_ACCESS_BASIS[action].some((scope) => hasScope(ownerScopes, scope))) return true;
  const legacy = LEGACY_REGISTRY_SCOPES[action];
  if (!repository) return hasScope(ownerScopes, legacy);
  if (workloads.some((workload) => ownerCoversWorkload(ownerScopes, action, workload))) return true;
  return hasScope(ownerScopes, `${legacy}:${repository}`);
}

/** The workloads of the listed repositories the owner's broad or legacy scopes do not cover already. */
export async function registryAccessWorkloads(
  access: TokenRegistryAccess,
  ownerScopes: readonly string[],
  workloadsOf: RegistryRepositoryWorkloads
): Promise<Map<string, RegistryRepositoryWorkload[]>> {
  const workloads = new Map<string, RegistryRepositoryWorkload[]>();
  for (const action of REGISTRY_ACTIONS) {
    const repositories = access[action];
    if (repositories === undefined || repositories === 'all') continue;
    for (const repository of repositories) {
      if (workloads.has(repository) || ownerMayUseRegistry(ownerScopes, action, repository)) continue;
      workloads.set(repository, await workloadsOf(repository));
    }
  }
  return workloads;
}

/**
 * Refuse registry access the owner cannot give a token (ownerMayUseRegistry). `workloads` are the workloads of the
 * listed repositories (registryAccessWorkloads); without them a listed repository needs the broad or legacy scope.
 */
export function assertTokenRegistryAccessAllowed(
  access: TokenRegistryAccess,
  ownerScopes: readonly string[],
  workloads: ReadonlyMap<string, readonly RegistryRepositoryWorkload[]> = new Map()
): void {
  const denied: string[] = [];
  for (const action of REGISTRY_ACTIONS) {
    const repositories = access[action];
    if (repositories === undefined) continue;
    if (repositories === 'all') {
      if (!ownerMayUseRegistry(ownerScopes, action)) denied.push(action);
      continue;
    }
    for (const repository of repositories) {
      if (!ownerMayUseRegistry(ownerScopes, action, repository, workloads.get(repository))) {
        denied.push(`${action} ${repository}`);
      }
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

/**
 * Whether a token may run a registry action on a repository now, bounded by its owner's current scopes by the same
 * rule as at creation (tokens created under the earlier, looser rule included). The repository's workloads are
 * looked up only when the owner's broad or legacy scopes do not decide.
 */
export async function tokenAllowsRegistryAction(
  access: TokenRegistryAccess,
  ownerScopes: readonly string[],
  action: RegistryAction,
  repository: string,
  workloadsOf: RegistryRepositoryWorkloads
): Promise<boolean> {
  const repositories = access[action];
  if (repositories === undefined) return false;
  if (repositories !== 'all' && !repositories.includes(repository)) return false;
  if (ownerMayUseRegistry(ownerScopes, action, repository)) return true;
  return ownerMayUseRegistry(ownerScopes, action, repository, await workloadsOf(repository));
}
