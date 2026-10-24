import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import {
  hostingNodeBindings,
  hostingOperations,
  hostingResources,
  integrationConnectors,
  nodes,
  permissionGroups,
  users,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { computeEffectiveUserAccess } from '@/modules/auth/live-session-user.js';
import type { HostingConnectorRow } from './hosting-connectors.service.js';
import type { HostingOperationRow } from './hosting-operations.service.js';
import { assertHostingResourceAction, assertHostingScope } from './hosting-permissions.js';
import type { HostingSettings } from './hosting-provider.types.js';
import { withoutProxmoxLimits } from './proxmox-quota.js';

export interface HostingDeletionTarget {
  operation: HostingOperationRow;
  connector: HostingConnectorRow;
  resource: typeof hostingResources.$inferSelect;
  nodeIds: string[];
}

const INSTALL_ACTIONS: Array<HostingOperationRow['action']> = ['create', 'install'];

/**
 * Nodes reserved by this VM's create or install operations that never enrolled (status pending, no
 * certificate, no host identity, no binding), for example after a failed installation. They belong
 * to nothing else and are removed together with the VM instead of staying pending forever.
 */
export async function unenrolledHostingNodeIds(
  executor: DrizzleClient | DrizzleTransaction,
  resourceId: string
): Promise<string[]> {
  const rows = await executor
    .select({ nodeId: nodes.id })
    .from(hostingOperations)
    .innerJoin(nodes, eq(nodes.id, hostingOperations.nodeId))
    .leftJoin(hostingNodeBindings, eq(hostingNodeBindings.nodeId, nodes.id))
    .where(
      and(
        eq(hostingOperations.resourceId, resourceId),
        inArray(hostingOperations.action, INSTALL_ACTIONS),
        eq(nodes.status, 'pending'),
        isNull(nodes.certificateFingerprint),
        isNull(nodes.hostIdentityId),
        isNull(hostingNodeBindings.nodeId)
      )
    );
  return [...new Set(rows.map((row) => row.nodeId))];
}

/**
 * Used inside node/certificate deletion and the final missing-state transaction, never around provider I/O.
 * `unenrolled` removes a node of this VM's installation that never enrolled and so has no binding to verify.
 */
export async function lockHostingDeletion(
  tx: DrizzleTransaction,
  target: HostingDeletionTarget,
  nodeId?: string,
  unenrolled = false
) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hosting-inventory'))`);
  const [connector] = await tx
    .select()
    .from(integrationConnectors)
    .where(eq(integrationConnectors.id, target.connector.id))
    .for('update');
  if (
    !connector?.enabled ||
    connector.updatedAt.getTime() !== target.connector.updatedAt.getTime() ||
    connector.encryptedToken !== target.connector.encryptedToken ||
    connector.baseUrl !== target.connector.baseUrl ||
    // A resource limit change (it keeps updatedAt) does not change which VM or account is deleted.
    JSON.stringify(withoutProxmoxLimits(connector.settings as HostingSettings)) !==
      JSON.stringify(withoutProxmoxLimits(target.connector.settings as HostingSettings))
  )
    throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'The hosting connection changed during deletion');
  const [resource] = await tx
    .select()
    .from(hostingResources)
    .where(eq(hostingResources.id, target.resource.id))
    .for('update');
  if (
    !resource ||
    resource.connectorId !== connector.id ||
    resource.remoteId !== target.resource.remoteId ||
    resource.authority !== target.resource.authority ||
    resource.incarnation !== target.resource.incarnation ||
    resource.snapshot.incarnation !== target.resource.incarnation ||
    resource.managedHostIdentity !== target.resource.managedHostIdentity
  )
    throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'The deletion target changed');
  if (
    resource.observedAt.getTime() !== target.resource.observedAt.getTime() ||
    resource.snapshot.observedAt !== target.resource.snapshot.observedAt
  )
    throw new AppError(409, 'HOSTING_RESOURCE_OBSERVATION_CHANGED', 'Provider inventory changed; rechecking VM state');
  // Match adoption's resource -> node -> binding order. Node deletion takes the same row lock again.
  if (nodeId) {
    const [node] = await tx.select().from(nodes).where(eq(nodes.id, nodeId)).for('update');
    if (!node) throw new AppError(404, 'NOT_FOUND', 'Node not found');
    const [binding] = await tx
      .select()
      .from(hostingNodeBindings)
      .where(eq(hostingNodeBindings.nodeId, nodeId))
      .for('update');
    if (unenrolled) {
      const owners = await tx
        .select({ id: hostingOperations.id })
        .from(hostingOperations)
        .where(
          and(
            eq(hostingOperations.nodeId, nodeId),
            eq(hostingOperations.resourceId, resource.id),
            inArray(hostingOperations.action, INSTALL_ACTIONS)
          )
        );
      if (
        !target.nodeIds.includes(nodeId) ||
        binding ||
        !owners.length ||
        node.status !== 'pending' ||
        node.certificateFingerprint ||
        node.hostIdentityId
      )
        throw new AppError(409, 'HOSTING_NODE_BINDING_CHANGED', 'A node enrolled or changed during destruction');
    } else if (
      !target.nodeIds.includes(nodeId) ||
      !binding ||
      binding.resourceId !== resource.id ||
      binding.hostIdentityId !== resource.managedHostIdentity ||
      node.hostIdentityId !== binding.hostIdentityId
    )
      throw new AppError(409, 'HOSTING_NODE_BINDING_CHANGED', 'A node binding changed during destruction');
  } else {
    const bindings = await tx.select().from(hostingNodeBindings).where(eq(hostingNodeBindings.resourceId, resource.id));
    if (bindings.length)
      throw new AppError(409, 'HOSTING_NODE_BINDING_CHANGED', 'The deleted VM still has Opfield node bindings');
  }
  const [operation] = await tx
    .select()
    .from(hostingOperations)
    .where(eq(hostingOperations.id, target.operation.id))
    .for('update');
  if (
    !operation ||
    operation.action !== 'delete' ||
    operation.resourceId !== resource.id ||
    operation.actorId !== target.operation.actorId ||
    operation.generation !== target.operation.generation ||
    !operation.leaseOwner ||
    operation.leaseOwner !== target.operation.leaseOwner ||
    !operation.leaseExpiresAt ||
    operation.leaseExpiresAt.getTime() <= Date.now() ||
    ['ready', 'failed'].includes(operation.phase)
  )
    throw new AppError(409, 'HOSTING_OPERATION_LEASE_LOST', 'Hosting operation ownership changed');
  if (!operation.actorId) throw new AppError(403, 'HOSTING_ACTOR_REVOKED', 'VM operation owner no longer has access');
  // Serialize revocation with this destructive transaction; use the canonical effective-scope computation.
  const [actor] = await tx.select().from(users).where(eq(users.id, operation.actorId)).for('share');
  if (!actor || actor.isBlocked || actor.deletedAt)
    throw new AppError(403, 'HOSTING_ACTOR_REVOKED', 'VM operation owner no longer has access');
  const groups = await tx.select().from(permissionGroups).orderBy(permissionGroups.id).for('share');
  const access = computeEffectiveUserAccess(
    actor.groupId,
    new Map(groups.map((group) => [group.id, group])),
    actor.additionalScopes,
    actor.additionalGroupIds
  );
  assertHostingScope(access.scopes, 'integrations:hosting:view', connector.id);
  assertHostingResourceAction(access.scopes, resource.id, 'delete', target.nodeIds);
}
