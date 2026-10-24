import { and, count, eq, inArray, notInArray, or, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DrizzleExecutor, DrizzleTransaction } from '@/db/client.js';
import {
  backupPolicies,
  backupRuns,
  containerLinkPlacements,
  containerLinks,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerDeployments,
  dockerMigrations,
  domains,
  ingressGroupMembers,
  managedAvailabilityMembers,
  managedAvailabilityWitnesses,
  managedDatabaseBindingPlacements,
  managedDatabaseBindings,
  managedDatabaseInstances,
  managedStorageBindings,
  managedStorageClusterMembers,
  managedStorageClusters,
  nodes,
  pageDeploymentReplicas,
  pageIngressMigrations,
  pageProjects,
  pageWildcardProfiles,
  proxyAdditionalRoutes,
  proxyAdditionalSecureLinks,
  proxyHosts,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayInstances,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { parkedDrainedAssignmentIds } from '@/services/relay-topology.js';
import { relayRemovableAfter } from './relay-removal.js';

/**
 * Tables whose foreign keys to nodes.id restrict deletion and are real, user-visible ownership (not stale delivery
 * state). Each one surfaces as a typed 409 instead of the raw foreign key violation.
 */
interface NodeReferenceBlocker {
  code: string;
  table: PgTable;
  /** Every column of `table` that references nodes.id and is covered by `where` (checked by the schema guard test). */
  columns: PgColumn[];
  where: (nodeId: string) => SQL | undefined;
  message: (total: number) => string;
}

const anyOf = (nodeId: string, ...columns: PgColumn[]) => or(...columns.map((column) => eq(column, nodeId)));

const ACTIVE_PAGE_INGRESS_MIGRATION = notInArray(pageIngressMigrations.status, ['complete', 'failed']);
const ACTIVE_PAGE_PROJECT_MIGRATION = inArray(pageProjects.migrationStatus, ['staging', 'cleanup_pending']);

export const NODE_REFERENCE_BLOCKERS: NodeReferenceBlocker[] = [
  {
    code: 'NODE_HAS_PAGE_PROJECTS',
    table: pageProjects,
    columns: [pageProjects.nodeId, pageProjects.migrationSourceNodeId, pageProjects.migrationTargetNodeId],
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
    columns: [pageWildcardProfiles.nodeId],
    where: (id) => eq(pageWildcardProfiles.nodeId, id),
    message: () => 'Cannot delete the node that serves the Pages wildcard profile. Move or disable the profile first.',
  },
  {
    code: 'NODE_HAS_PAGE_MIGRATIONS',
    table: pageIngressMigrations,
    columns: [pageIngressMigrations.sourceNodeId, pageIngressMigrations.targetNodeId],
    where: (id) =>
      and(
        anyOf(id, pageIngressMigrations.sourceNodeId, pageIngressMigrations.targetNodeId),
        ACTIVE_PAGE_INGRESS_MIGRATION
      ),
    message: (n) => `Cannot delete a node with ${n} Pages ingress migration(s) in progress. Wait for them to finish.`,
  },
  {
    code: 'NODE_HAS_AVAILABILITY_POLICIES',
    table: dockerAvailabilityPolicies,
    columns: [dockerAvailabilityPolicies.originNodeId, dockerAvailabilityPolicies.sourceNodeId],
    where: (id) => anyOf(id, dockerAvailabilityPolicies.originNodeId, dockerAvailabilityPolicies.sourceNodeId),
    message: (n) => `Cannot delete a node used by ${n} availability policy(ies). Remove the availability first.`,
  },
  {
    code: 'NODE_HAS_AVAILABILITY_PLACEMENTS',
    table: dockerAvailabilityPlacements,
    columns: [dockerAvailabilityPlacements.nodeId],
    where: (id) => eq(dockerAvailabilityPlacements.nodeId, id),
    message: (n) => `Cannot delete a node with ${n} availability placement(s). Remove the availability first.`,
  },
  {
    code: 'NODE_HAS_MANAGED_STORAGE',
    table: managedStorageClusters,
    columns: [managedStorageClusters.nodeId],
    where: (id) => eq(managedStorageClusters.nodeId, id),
    message: (n) => `Cannot delete a node with ${n} managed storage cluster(s). Delete or move them first.`,
  },
  {
    code: 'NODE_HAS_MANAGED_STORAGE',
    table: managedStorageClusterMembers,
    columns: [managedStorageClusterMembers.nodeId],
    where: (id) => eq(managedStorageClusterMembers.nodeId, id),
    message: (n) =>
      `Cannot delete a node that is a member of ${n} managed storage cluster(s). Remove it from them first.`,
  },
  {
    code: 'NODE_HAS_MANAGED_STORAGE',
    table: managedStorageBindings,
    columns: [managedStorageBindings.targetNodeId],
    where: (id) => eq(managedStorageBindings.targetNodeId, id),
    message: (n) => `Cannot delete a node with ${n} managed storage binding(s). Remove the bindings first.`,
  },
  {
    code: 'NODE_HAS_MANAGED_DATABASE_BINDINGS',
    table: managedDatabaseBindings,
    columns: [managedDatabaseBindings.targetNodeId],
    where: (id) => eq(managedDatabaseBindings.targetNodeId, id),
    message: (n) => `Cannot delete a node with ${n} managed database binding(s). Remove the bindings first.`,
  },
  {
    code: 'NODE_HAS_MANAGED_DATABASE_BINDINGS',
    table: managedDatabaseBindingPlacements,
    columns: [managedDatabaseBindingPlacements.nodeId],
    where: (id) => eq(managedDatabaseBindingPlacements.nodeId, id),
    message: (n) => `Cannot delete a node with ${n} managed database binding placement(s). Remove the bindings first.`,
  },
  {
    code: 'NODE_HAS_BACKUPS',
    table: backupPolicies,
    columns: [backupPolicies.executorNodeId],
    where: (id) => eq(backupPolicies.executorNodeId, id),
    message: (n) => `Cannot delete a node that runs ${n} backup policy(ies). Change their executor node first.`,
  },
  {
    code: 'NODE_HAS_BACKUPS',
    table: backupRuns,
    columns: [backupRuns.executorNodeId],
    // Finished runs stay as history and lose the executor reference (ON DELETE SET NULL).
    where: (id) => and(eq(backupRuns.executorNodeId, id), inArray(backupRuns.status, ['queued', 'running'])),
    message: (n) =>
      `Cannot delete a node that is executing ${n} backup run(s). Wait for them to finish or cancel them.`,
  },
  {
    code: 'NODE_HAS_PROXY_UPSTREAMS',
    table: proxyAdditionalRoutes,
    columns: [
      proxyAdditionalRoutes.dockerNodeId,
      proxyAdditionalRoutes.migrationSourceNodeId,
      proxyAdditionalRoutes.migrationTargetNodeId,
    ],
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
    columns: [proxyAdditionalSecureLinks.sourceNodeId, proxyAdditionalSecureLinks.dockerNodeId],
    where: (id) => anyOf(id, proxyAdditionalSecureLinks.sourceNodeId, proxyAdditionalSecureLinks.dockerNodeId),
    message: (n) => `Cannot delete node with ${n} linked Secure Link upstream(s). Change or delete them first.`,
  },
  {
    code: 'NODE_HAS_CONTAINER_LINKS',
    table: containerLinks,
    columns: [containerLinks.sourceNodeId, containerLinks.targetNodeId],
    where: (id) => anyOf(id, containerLinks.sourceNodeId, containerLinks.targetNodeId),
    message: (n) => `Cannot delete a node with ${n} container link(s). Delete the links first.`,
  },
  {
    code: 'NODE_HAS_CONTAINER_LINKS',
    table: containerLinkPlacements,
    columns: [containerLinkPlacements.nodeId],
    where: (id) => eq(containerLinkPlacements.nodeId, id),
    message: (n) => `Cannot delete a node with ${n} container link placement(s). Delete the links first.`,
  },
  {
    code: 'NODE_HAS_MANAGED_AVAILABILITY',
    table: managedAvailabilityMembers,
    columns: [managedAvailabilityMembers.nodeId],
    where: (id) => eq(managedAvailabilityMembers.nodeId, id),
    message: (n) =>
      `Cannot delete a node that is a member of ${n} managed availability set(s). Remove it from them first.`,
  },
  {
    code: 'NODE_HAS_MANAGED_AVAILABILITY',
    table: managedAvailabilityWitnesses,
    columns: [managedAvailabilityWitnesses.nodeId],
    where: (id) => eq(managedAvailabilityWitnesses.nodeId, id),
    message: (n) => `Cannot delete a node that witnesses ${n} managed availability set(s). Remove the witness first.`,
  },
];

/**
 * Restricting foreign keys to nodes.id that NodesService.remove itself refuses with a typed error before the
 * transaction (proxy hosts, upstreams, managed databases, domains, ingress groups) or removes together with the
 * node (relay instances).
 */
export const NODE_REMOVAL_SERVICE_CHECKED_REFERENCES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'proxy_hosts', column: 'docker_node_id' },
  { table: 'managed_database_instances', column: 'node_id' },
  { table: 'domains', column: 'nginx_node_id' },
  { table: 'ingress_group_members', column: 'node_id' },
  { table: 'relay_instances', column: 'node_id' },
];

/**
 * Foreign keys to nodes.id that prepareNodeRemoval clears itself (stale state): `table` is the SQL table name. Together
 * with NODE_REFERENCE_BLOCKERS this is what node-removal-schema-guard.test.ts checks every restricting FK against.
 */
export const NODE_REMOVAL_CLEANED_REFERENCES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'page_deployment_replicas', column: 'node_id' },
  { table: 'page_ingress_migrations', column: 'target_node_id' },
  { table: 'page_projects', column: 'migration_source_node_id' },
  { table: 'page_projects', column: 'migration_target_node_id' },
];

/**
 * Runs inside the node deletion transaction. Refuses deletion with a typed 409 when real resources still point at the
 * node, and removes stale per-node state that would otherwise trip a foreign key: delivery replicas of Pages
 * deployments (a finished ingress migration leaves its revoked rows behind), finished Pages ingress migration history, and the
 * migration pointers of projects whose migration is no longer running.
 */
export async function prepareNodeRemoval(tx: DrizzleTransaction, nodeId: string): Promise<void> {
  await assertNoNodeReferenceBlockers(tx, nodeId);

  await tx.delete(pageDeploymentReplicas).where(eq(pageDeploymentReplicas.nodeId, nodeId));
  await tx
    .delete(pageIngressMigrations)
    .where(anyOf(nodeId, pageIngressMigrations.sourceNodeId, pageIngressMigrations.targetNodeId));
  await tx
    .update(pageProjects)
    .set({ migrationSourceNodeId: null })
    .where(eq(pageProjects.migrationSourceNodeId, nodeId));
  await tx
    .update(pageProjects)
    .set({ migrationTargetNodeId: null })
    .where(eq(pageProjects.migrationTargetNodeId, nodeId));
}

/** The typed 409 of the first NODE_REFERENCE_BLOCKERS entry that still points at the node. */
export async function assertNoNodeReferenceBlockers(executor: DrizzleExecutor, nodeId: string): Promise<void> {
  for (const blocker of NODE_REFERENCE_BLOCKERS) {
    const [row] = await executor.select({ count: count() }).from(blocker.table).where(blocker.where(nodeId));
    const total = Number(row?.count ?? 0);
    if (total > 0) throw new AppError(409, blocker.code, blocker.message(total), { count: total });
  }
}

/**
 * Read-only preflight of removing a node whose server is about to be destroyed (hosting delete): the typed 409 that
 * NodesService.remove would answer, checked while the server still runs, so nothing is destroyed that leaves a node
 * record behind which can no longer be removed. Routes are not cascaded here: they are moved or deleted first.
 * A relay must be drained (no assignments, no tunnels) while it is still connected: once its server is gone it is
 * offline, and an offline relay may only be removed after its signed policy expired.
 */
export async function assertNodeRemovableBeforeDestroy(executor: DrizzleExecutor, nodeId: string): Promise<void> {
  const [node] = await executor
    .select({ id: nodes.id, type: nodes.type, status: nodes.status, certificateSerial: nodes.certificateSerial })
    .from(nodes)
    .where(eq(nodes.id, nodeId))
    .limit(1);
  if (!node) return;
  const [hosts] = await executor.select({ count: count() }).from(proxyHosts).where(eq(proxyHosts.nodeId, nodeId));
  if (Number(hosts?.count ?? 0) > 0)
    throw new AppError(
      409,
      'NODE_HAS_HOSTS',
      `Cannot delete this server: its node serves ${Number(hosts!.count)} route(s). Move them to another node or delete them first.`,
      { proxyHostCount: Number(hosts!.count) }
    );
  const [upstreams] = await executor
    .select({ count: count() })
    .from(proxyHosts)
    .leftJoin(dockerDeployments, eq(proxyHosts.dockerDeploymentId, dockerDeployments.id))
    .where(or(eq(proxyHosts.dockerNodeId, nodeId), eq(dockerDeployments.nodeId, nodeId)));
  if (Number(upstreams?.count ?? 0) > 0)
    throw new AppError(
      409,
      'NODE_HAS_PROXY_UPSTREAMS',
      `Cannot delete node with ${Number(upstreams!.count)} linked proxy upstream(s). Change or delete them first.`
    );
  const [databases] = await executor
    .select({ count: count() })
    .from(managedDatabaseInstances)
    .where(eq(managedDatabaseInstances.nodeId, nodeId));
  if (Number(databases?.count ?? 0) > 0)
    throw new AppError(
      409,
      'NODE_HAS_MANAGED_DATABASES',
      `Cannot delete node with ${Number(databases!.count)} managed database(s). Reassign or delete them first.`
    );
  const [migration] = await executor
    .select({ id: dockerMigrations.id })
    .from(dockerMigrations)
    .where(
      and(
        or(eq(dockerMigrations.sourceNodeId, nodeId), eq(dockerMigrations.targetNodeId, nodeId)),
        inArray(dockerMigrations.status, ['pending', 'running', 'waiting', 'cancelling'])
      )
    )
    .limit(1);
  if (migration)
    throw new AppError(
      409,
      'NODE_HAS_RUNNING_MIGRATION',
      'Cannot delete a node while a Docker migration from or to it runs. Wait for it to finish or cancel it first.',
      { migrationId: migration.id }
    );
  const [domain] = await executor
    .select({ id: domains.id })
    .from(domains)
    .where(eq(domains.nginxNodeId, nodeId))
    .limit(1);
  if (domain)
    throw new AppError(409, 'NODE_HAS_DOMAINS', 'Cannot delete a node with assigned domains. Reassign them first.');
  const [membership] = await executor
    .select({ groupId: ingressGroupMembers.groupId })
    .from(ingressGroupMembers)
    .where(eq(ingressGroupMembers.nodeId, nodeId))
    .limit(1);
  if (membership)
    throw new AppError(409, 'NODE_IN_INGRESS_GROUP', 'Remove this node from its ingress group first', {
      ingressGroupIds: [membership.groupId],
    });
  await assertNoNodeReferenceBlockers(executor, nodeId);
  if (node.type !== 'relay' || (node.status === 'pending' && !node.certificateSerial)) return;
  const [relay] = await executor.select().from(relayInstances).where(eq(relayInstances.nodeId, nodeId)).limit(1);
  if (!relay) return;
  if (relay.state === 'offline') {
    const removableAfter = relayRemovableAfter(relay);
    if (!removableAfter || removableAfter.getTime() > Date.now())
      throw new AppError(
        409,
        'RELAY_OFFLINE_REMOVAL_UNSAFE',
        removableAfter
          ? `The relay is offline and can be removed after ${removableAfter.toISOString()}, once its signed policy expired; its server is not deleted before that`
          : 'The relay is offline and has no expiring policy; bring it back online and drain it before deleting its server',
        { removableAfter: removableAfter?.toISOString() ?? null }
      );
    return;
  }
  const live = await executor
    .select({
      id: relayEndpointAssignments.id,
      assignmentGenerationId: relayEndpointAssignments.assignmentGenerationId,
      state: relayEndpointAssignmentGenerations.state,
    })
    .from(relayEndpointAssignments)
    .innerJoin(
      relayEndpointAssignmentGenerations,
      eq(relayEndpointAssignments.assignmentGenerationId, relayEndpointAssignmentGenerations.id)
    )
    .where(
      and(
        eq(relayEndpointAssignments.relayInstanceId, relay.id),
        inArray(relayEndpointAssignmentGenerations.state, ['active', 'staging', 'draining'])
      )
    );
  const generationIds = [...new Set(live.map(({ assignmentGenerationId }) => assignmentGenerationId))];
  const parked =
    relay.state === 'draining' && generationIds.length
      ? parkedDrainedAssignmentIds(
          relay,
          await executor
            .select({
              id: relayEndpointAssignments.id,
              assignmentGenerationId: relayEndpointAssignments.assignmentGenerationId,
              relayInstanceId: relayEndpointAssignments.relayInstanceId,
            })
            .from(relayEndpointAssignments)
            .where(inArray(relayEndpointAssignments.assignmentGenerationId, generationIds)),
          live.map(({ assignmentGenerationId, state }) => ({ id: assignmentGenerationId, state }))
        )
      : new Set<string>();
  if (live.some(({ id }) => !parked.has(id)))
    throw new AppError(
      409,
      'RELAY_INSTANCE_ASSIGNED',
      'Drain the relay and let its workloads move to other relays before deleting its server'
    );
  if (!['draining', 'error'].includes(relay.state))
    throw new AppError(409, 'RELAY_INSTANCE_NOT_DRAINED', 'Drain the relay before deleting its server');
  if ((relay.health?.activeTunnels ?? 0) > 0)
    throw new AppError(
      409,
      'RELAY_INSTANCE_HAS_ACTIVE_TUNNELS',
      'The relay still carries tunnels; wait for the drain to finish'
    );
}

/**
 * Container links the user already deleted (desired state `deleted`) whose every node is in `nodeIds`: nodes whose
 * server the provider confirmed destroyed. What their deletion still waited for was cleanup on those servers, which no
 * longer exist, so the rows go (placements cascade). A link with any node outside the set keeps its cleanup there.
 * Returns the removed link IDs.
 */
export async function purgeDeletedContainerLinksOfDestroyedNodes(
  tx: DrizzleTransaction,
  nodeIds: string[]
): Promise<string[]> {
  if (!nodeIds.length) return [];
  const destroyed = new Set(nodeIds);
  const candidates = await tx
    .select({
      id: containerLinks.id,
      sourceNodeId: containerLinks.sourceNodeId,
      targetNodeId: containerLinks.targetNodeId,
    })
    .from(containerLinks)
    .where(
      and(
        eq(containerLinks.desiredState, 'deleted'),
        or(inArray(containerLinks.sourceNodeId, nodeIds), inArray(containerLinks.targetNodeId, nodeIds))
      )
    );
  const ids = candidates
    .filter((link) => destroyed.has(link.sourceNodeId) && destroyed.has(link.targetNodeId))
    .map((link) => link.id);
  if (!ids.length) return [];
  const elsewhere = await tx
    .select({ linkId: containerLinkPlacements.linkId })
    .from(containerLinkPlacements)
    .where(and(inArray(containerLinkPlacements.linkId, ids), notInArray(containerLinkPlacements.nodeId, nodeIds)));
  const purge = ids.filter((id) => !elsewhere.some((placement) => placement.linkId === id));
  if (purge.length) await tx.delete(containerLinks).where(inArray(containerLinks.id, purge));
  return purge;
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
