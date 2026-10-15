import { and, eq, isNotNull } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { appEnvironments, apps } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { effectiveDomainPatterns, isDomainAllowed } from './app-domain-patterns.js';
import { APP_FAMILY_TABLES } from './app-families.js';

/** The domain allowlist that applies inside one environment (app-wide entries joined with the environment's own). */
export interface EnvironmentDomainPolicy {
  appId: string;
  appName: string;
  environmentId: string;
  environmentName: string;
  /** Empty: every name is allowed. */
  patterns: string[];
}

export async function environmentDomainPolicy(
  db: DrizzleExecutor,
  environmentId: string
): Promise<EnvironmentDomainPolicy | null> {
  const [row] = await db
    .select({
      appId: apps.id,
      appName: apps.name,
      appPatterns: apps.domainPatterns,
      environmentId: appEnvironments.id,
      environmentName: appEnvironments.name,
      envPatterns: appEnvironments.domainPatterns,
    })
    .from(appEnvironments)
    .innerJoin(apps, eq(apps.id, appEnvironments.appId))
    .where(eq(appEnvironments.id, environmentId))
    .limit(1);
  if (!row) return null;
  return {
    appId: row.appId,
    appName: row.appName,
    environmentId: row.environmentId,
    environmentName: row.environmentName,
    patterns: effectiveDomainPatterns(row.appPatterns ?? [], row.envPatterns ?? []),
  };
}

/** The policy of the environment a route or domain folder belongs to; null for a user folder or no folder. */
export async function domainPolicyForFolder(
  db: DrizzleExecutor,
  family: 'routes' | 'domains',
  folderId: string | null | undefined
): Promise<EnvironmentDomainPolicy | null> {
  if (!folderId) return null;
  const { table } = APP_FAMILY_TABLES[family];
  const [folder] = (await (db as any)
    .select({ environmentId: table.appEnvironmentId })
    .from(table)
    .where(and(eq(table.id, folderId), isNotNull(table.appId)))
    .limit(1)) as Array<{ environmentId: string | null }>;
  if (!folder?.environmentId) return null;
  return environmentDomainPolicy(db, folder.environmentId);
}

/** The names a policy refuses (none when there is no policy or its list is empty). */
export function refusedDomainNames(policy: EnvironmentDomainPolicy | null, names: readonly string[]): string[] {
  if (!policy || policy.patterns.length === 0) return [];
  return [...new Set(names.filter((name) => !isDomainAllowed(name, policy.patterns)))];
}

export function domainNotAllowedError(policy: EnvironmentDomainPolicy, refused: readonly string[]): AppError {
  return new AppError(
    422,
    'APP_DOMAIN_NOT_ALLOWED',
    `${refused.join(', ')} ${refused.length === 1 ? 'is' : 'are'} not allowed in ${policy.appName} · ${policy.environmentName}. Allowed domains: ${policy.patterns.join(', ')}`,
    {
      appId: policy.appId,
      environmentId: policy.environmentId,
      domains: [...refused],
      allowedPatterns: policy.patterns,
    }
  );
}

export function assertDomainNamesAllowed(policy: EnvironmentDomainPolicy | null, names: readonly string[]): void {
  const refused = refusedDomainNames(policy, names);
  if (policy && refused.length > 0) throw domainNotAllowedError(policy, refused);
}

/**
 * 422 APP_DOMAIN_NOT_ALLOWED when a route or domain lands in an app environment folder whose allowlist (app-wide
 * entries joined with the environment's own) does not cover every name. No-op outside apps or with empty lists.
 */
export async function assertFolderDomainsAllowed(
  db: DrizzleExecutor,
  family: 'routes' | 'domains',
  folderId: string | null | undefined,
  names: readonly string[]
): Promise<void> {
  if (!folderId || names.length === 0) return;
  assertDomainNamesAllowed(await domainPolicyForFolder(db, family, folderId), names);
}
