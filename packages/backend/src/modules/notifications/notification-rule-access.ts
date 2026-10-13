import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { appEnvironments, dockerAccessResources, dockerComposeProjects } from '@/db/schema/index.js';
import { hasScope, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { APP_VIEW_SCOPE, hasAppScope, hasAppWideScope } from '@/modules/apps/app-access.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import { type AlertCategory, CATEGORY_MAP } from './notification-catalog.js';
import { assertHostingAlertAccess } from './notification-hosting-access.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AlertRuleTarget {
  category: string;
  type: string;
  metric?: string | null;
  metricTarget?: string | null;
  thresholdValue?: number | null;
  eventPattern?: string | null;
  resourceIds: string[] | null;
}

/** A scope held broadly or on any resource (`<base>:<id>`). */
function holdsAny(scopes: readonly string[], base: string): boolean {
  return scopes.some((scope) => scope === base || scope.startsWith(`${base}:`));
}

/** Plain resource-scoped view: `<scope>` or `<scope>:<id>`. */
const SIMPLE_VIEW: Partial<Record<AlertCategory, string[]>> = {
  node: ['nodes:details'],
  proxy: ['proxy:view'],
  pages: ['pages:view'],
  logging: ['logs:environments:view'],
  integration: ['integrations:gitlab:view', 'integrations:cloudflare:view'],
  certificate: ['ssl:cert:view'],
  database_postgres: ['databases:view'],
  database_clickhouse: ['databases:view'],
  database_redis: ['databases:view'],
  managed_storage: ['storage:view'],
  backup: ['databases:backups:view'],
  domain: ['domains:view'],
  pki: ['pki:ca:view', 'pki:cert:view'],
  inference: ['inference:providers:view'],
};

/**
 * Picked resources of a rule its author may not view. Ids are what the rule scope holds: resource ids, container
 * names, app or environment ids.
 */
async function hiddenResources(
  getDb: () => DrizzleClient,
  scopes: readonly string[],
  category: AlertCategory,
  ids: readonly string[]
): Promise<string[]> {
  const granted = [...scopes];
  const simple = SIMPLE_VIEW[category];
  if (simple) return ids.filter((id) => !simple.some((base) => hasScopeForResource(granted, base, id)));

  switch (category) {
    case 'container': {
      if (hasScope(granted, 'docker:containers:view')) return [];
      // Container rules name containers; any container of that name the author may view counts.
      const rows = ids.length
        ? await getDb()
            .select({
              id: dockerAccessResources.id,
              nodeId: dockerAccessResources.nodeId,
              name: dockerAccessResources.resourceKey,
            })
            .from(dockerAccessResources)
            .where(
              and(
                eq(dockerAccessResources.resourceType, 'container'),
                inArray(dockerAccessResources.resourceKey, [...ids])
              )
            )
        : [];
      return ids.filter(
        (name) =>
          !rows.some(
            (row) => row.name === name && hasDockerResourceScope(granted, 'docker:containers:view', row.nodeId, row.id)
          )
      );
    }
    case 'compose': {
      if (hasScope(granted, 'docker:compose:view')) return [];
      const known = ids.filter((id) => UUID_PATTERN.test(id));
      const rows = known.length
        ? await getDb()
            .select({ id: dockerComposeProjects.id, nodeId: dockerComposeProjects.nodeId })
            .from(dockerComposeProjects)
            .where(inArray(dockerComposeProjects.id, known))
        : [];
      return ids.filter((id) => {
        const row = rows.find((candidate) => candidate.id === id);
        return !row || !hasDockerResourceScope(granted, 'docker:compose:view', row.nodeId, id);
      });
    }
    case 'app': {
      const known = ids.filter((id) => UUID_PATTERN.test(id));
      const envs = known.length
        ? await getDb()
            .select({ id: appEnvironments.id, appId: appEnvironments.appId })
            .from(appEnvironments)
            .where(inArray(appEnvironments.id, known))
        : [];
      return ids.filter((id) => {
        const env = envs.find((candidate) => candidate.id === id);
        // An environment id: view of it (or its app); an app id covers all its environments: view of the whole app.
        return env
          ? !hasAppScope(granted, APP_VIEW_SCOPE, env.appId, env.id)
          : !hasAppWideScope(granted, APP_VIEW_SCOPE, id);
      });
    }
    case 'build':
      // Build sources are watched by Docker container viewers; per-source grants do not exist.
      return holdsAny(granted, 'docker:containers:view') ? [] : [...ids];
    default: {
      // Families without per-resource grants (Docker Availability, relay pool, Opfield, security): the broad view.
      const views = CATEGORY_MAP.get(category)?.viewScopes ?? [];
      return views.every((scope) => hasScope(granted, scope)) ? [] : [...ids];
    }
  }
}

/**
 * Who may create or edit a rule: one that covers every resource of its category needs the category's broad view
 * (viewScopes); one scoped to picked resources needs view of each. Hosting rules keep their own checks (source and
 * billing access). REST, AI and MCP all create and edit rules through this.
 */
export async function assertAlertRuleAccess(
  /** Read only for containers, Compose projects and app environments (lazily: hosting and plain checks need none). */
  db: DrizzleClient | (() => DrizzleClient),
  scopes: readonly string[],
  rule: AlertRuleTarget
): Promise<void> {
  if (rule.category === 'hosting_account' || rule.category === 'hosting_vm') {
    assertHostingAlertAccess([...scopes], rule);
    return;
  }
  const category = CATEGORY_MAP.get(rule.category as AlertCategory);
  if (!category) return;
  const ids = rule.resourceIds ?? [];
  if (ids.length === 0 || category.scopable === false) {
    const missing = category.viewScopes.filter((scope) => !hasScope([...scopes], scope));
    if (missing.length === 0) return;
    throw new AppError(
      403,
      'FORBIDDEN',
      category.scopable === false
        ? `${category.label} alerts need ${missing.join(' and ')}`
        : `An alert on every one of the ${category.resourceLabel} needs ${missing.join(' and ')}; pick the ${category.resourceLabel} you can view instead`
    );
  }
  const hidden = await hiddenResources(typeof db === 'function' ? db : () => db, scopes, category.id, ids);
  if (hidden.length === 0) return;
  throw new AppError(
    403,
    'FORBIDDEN',
    `You cannot view ${hidden.length === 1 ? 'one of the picked' : `${hidden.length} of the picked`} ${category.resourceLabel}; an alert can only watch what you can view`
  );
}
