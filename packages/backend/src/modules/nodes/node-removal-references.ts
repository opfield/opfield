import { and, count, eq, inArray, notInArray, or, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DrizzleTransaction } from '@/db/client.js';
import {
  backupPolicies,
  backupRuns,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerMigrations,
  managedDatabaseBindingPlacements,
  managedDatabaseBindings,
  managedStorageBindings,
  managedStorageClusterMembers,
  managedStorageClusters,
  pageDeploymentReplicas,
  pageIngressMigrations,
  pageProjects,
  pageWildcardProfiles,
  proxyAdditionalRoutes,
  proxyAdditionalSecureLinks,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

/**
 * Tables whose foreign keys to nodes.id restrict deletion and are real, user-visible ownership (not stale delivery
 * state). Each one surfaces as a typed 409 instead of the raw foreign key violation.
 */
interface NodeReferenceBlocker {
  code: string;
  table: PgTable;
  where: (nodeId: string) => SQL | undefined;
  message: (total: number) => string;
}

const anyOf = (nodeId: string, ...columns: PgColumn[]) => or(...columns.map((column) => eq(column, nodeId)));

const ACTIVE_DOCKER_MIGRATION = notInArray(dockerMigrations.status, ['completed', 'failed', 'cancelled']);
const ACTIVE_PAGE_INGRESS_MIGRATION = notInArray(pageIngressMigrations.status, ['complete', 'failed']);
const ACTIVE_PAGE_PROJECT_MIGRATION = inArray(pageProjects.migrationStatus, ['staging', 'cleanup_pending']);

export const NODE_REFERENCE_BLOCKERS: NodeReferenceBlocker[] = [
  {
    code: 'NODE_HAS_PAGE_PROJECTS',
    table: pageProjects,
    where: (id) =>
      or(
        eq(pageProjects.nodeId, id),
        and(
          anyOf(id, pageProjects.migrationSourceNodeId, pageProjects.migrationTargetNodeId),
          ACTIVE_PAGE_PROJECT_MIGRATION
        )
      ),
    message: (n) => `Cannot delete a node that hosts ${n} Pages project(s). Move them to another node first.`,
  },
  {
    code: 'NODE_HAS_PAGE_WILDCARD_PROFILE',
    table: pageWildcardProfiles,
    where: (id) => eq(pageWildcardProfiles.nodeId, id),
    message: () => 'Cannot delete the node that serves the Pages wildcard profile. Move or disable the profile first.',
  },
  {
    code: 'NODE_HAS_PAGE_MIGRATIONS',
    table: pageIngressMigrations,
    where: (id) =>
      and(
        anyOf(id, pageIngressMigrations.sourceNodeId, pageIngressMigrations.targetNodeId),
        ACTIVE_PAGE_INGRESS_MIGRATION
      ),
    message: (n) => `Cannot delete a node with ${n} Pages ingress migration(s) in progress. Wait for them to finish.`,
  },
  {
    code: 'NODE_HAS_DOCKER_MIGRATIONS',
    table: dockerMigrations,
    where: (id) =>
      and(anyOf(id, dockerMigrations.sourceNodeId, dockerMigrations.targetNodeId), ACTIVE_DOCKER_MIGRATION),
    message: (n) => `Cannot delete a node with ${n} Docker migration(s) in progress. Wait for them to finish.`,
  },
  {
    code: 'NODE_HAS_AVAILABILITY_POLICIES',
    table: dockerAvailabilityPolicies,
    where: (id) => anyOf(id, dockerAvailabilityPolicies.originNodeId, dockerAvailabilityPolicies.sourceNodeId),
    message: (n) => `Cannot delete a node used by ${n} availability policy(ies). Remove the availability first.`,
  },
  {
    code: 'NODE_HAS_AVAILABILITY_PLACEMENTS',
    table: dockerAvailabilityPlacements,
    where: (id) => eq(dockerAvailabilityPlacements.nodeId, id),
    message: (n) => `Cannot delete a node with ${n} availability placement(s). Remove the availability first.`,
  },
  {
    code: 'NODE_HAS_MANAGED_STORAGE',
    table: managedStorageClusters,
    where: (id) => eq(managedStorageClusters.nodeId, id),
    message: (n) => `Cannot delete a node with ${n} managed storage cluster(s). Delete or move them first.`,
  },
  {
    code: 'NODE_HAS_MANAGED_STORAGE',
    table: managedStorageClusterMembers,
    where: (id) => eq(managedStorageClusterMembers.nodeId, id),
    message: (n) =>
      `Cannot delete a node that is a member of ${n} managed storage cluster(s). Remove it from them first.`,
  },
  {
    code: 'NODE_HAS_MANAGED_STORAGE',
    table: managedStorageBindings,
    where: (id) => eq(managedStorageBindings.targetNodeId, id),
    message: (n) => `Cannot delete a node with ${n} managed storage binding(s). Remove the bindings first.`,
  },
  {
    code: 'NODE_HAS_MANAGED_DATABASE_BINDINGS',
    table: managedDatabaseBindings,
    where: (id) => eq(managedDatabaseBindings.targetNodeId, id),
    message: (n) => `Cannot delete a node with ${n} managed database binding(s). Remove the bindings first.`,
  },
  {
    code: 'NODE_HAS_MANAGED_DATABASE_BINDINGS',
    table: managedDatabaseBindingPlacements,
    where: (id) => eq(managedDatabaseBindingPlacements.nodeId, id),
    message: (n) => `Cannot delete a node with ${n} managed database binding placement(s). Remove the bindings first.`,
  },
  {
    code: 'NODE_HAS_BACKUPS',
    table: backupPolicies,
    where: (id) => eq(backupPolicies.executorNodeId, id),
    message: (n) => `Cannot delete a node that runs ${n} backup policy(ies). Change their executor node first.`,
  },
  {
    code: 'NODE_HAS_BACKUPS',
    table: backupRuns,
    // Finished runs stay as history and lose the executor reference (ON DELETE SET NULL).
    where: (id) => and(eq(backupRuns.executorNodeId, id), inArray(backupRuns.status, ['queued', 'running'])),
    message: (n) =>
      `Cannot delete a node that is executing ${n} backup run(s). Wait for them to finish or cancel them.`,
  },
  {
    code: 'NODE_HAS_PROXY_UPSTREAMS',
    table: proxyAdditionalRoutes,
    where: (id) =>
      anyOf(
        id,
        proxyAdditionalRoutes.dockerNodeId,
        proxyAdditionalRoutes.migrationSourceNodeId,
        proxyAdditionalRoutes.migrationTargetNodeId
      ),
    message: (n) => `Cannot delete node with ${n} linked additional route(s). Change or delete them first.`,
  },
  {
    code: 'NODE_HAS_PROXY_UPSTREAMS',
    table: proxyAdditionalSecureLinks,
    where: (id) => anyOf(id, proxyAdditionalSecureLinks.sourceNodeId, proxyAdditionalSecureLinks.dockerNodeId),
    message: (n) => `Cannot delete node with ${n} linked Secure Link upstream(s). Change or delete them first.`,
  },
];

/**
 * Runs inside the node deletion transaction. Refuses deletion with a typed 409 when real resources still point at the
 * node, and removes stale per-node state that would otherwise trip a foreign key: delivery replicas of Pages
 * deployments (a finished ingress migration leaves its revoked rows behind), finished migration history, and the
 * migration pointers of projects whose migration is no longer running.
 */
export async function prepareNodeRemoval(tx: DrizzleTransaction, nodeId: string): Promise<void> {
  for (const blocker of NODE_REFERENCE_BLOCKERS) {
    const [row] = await tx.select({ count: count() }).from(blocker.table).where(blocker.where(nodeId));
    const total = Number(row?.count ?? 0);
    if (total > 0) throw new AppError(409, blocker.code, blocker.message(total), { count: total });
  }

  await tx.delete(pageDeploymentReplicas).where(eq(pageDeploymentReplicas.nodeId, nodeId));
  await tx
    .delete(pageIngressMigrations)
    .where(anyOf(nodeId, pageIngressMigrations.sourceNodeId, pageIngressMigrations.targetNodeId));
  await tx.delete(dockerMigrations).where(anyOf(nodeId, dockerMigrations.sourceNodeId, dockerMigrations.targetNodeId));
  await tx
    .update(pageProjects)
    .set({ migrationSourceNodeId: null })
    .where(eq(pageProjects.migrationSourceNodeId, nodeId));
  await tx
    .update(pageProjects)
    .set({ migrationTargetNodeId: null })
    .where(eq(pageProjects.migrationTargetNodeId, nodeId));
}

interface PostgresErrorLike {
  code?: unknown;
  table?: unknown;
  cause?: unknown;
}

/** A foreign key violation that still slips through becomes a readable 409; any other error is returned unchanged. */
export function mapNodeForeignKeyViolation(error: unknown): unknown {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object' && !seen.has(current); depth += 1) {
    seen.add(current);
    const candidate = current as PostgresErrorLike;
    if (candidate.code === '23503' || candidate.code === '23001') {
      const table = typeof candidate.table === 'string' ? candidate.table : undefined;
      return new AppError(
        409,
        'NODE_IN_USE',
        `Cannot delete this node: it is still referenced by ${table ? table.replaceAll('_', ' ') : 'other resources'}. Remove or reassign those first.`,
        { table }
      );
    }
    current = candidate.cause;
  }
  return error;
}
