import { createHash, X509Certificate } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  backupRuns,
  certificates,
  containerLinkPlacements,
  containerLinks,
  dockerAvailabilityPolicies,
  dockerRegistryNodeBindings,
  managedAvailabilityMembers,
  managedAvailabilitySets,
  managedAvailabilityWitnesses,
  managedDatabaseBindingPlacements,
  managedDatabaseBindings,
  managedDatabaseInstances,
  managedStorageBindings,
  managedStorageClusters,
  nodes,
  proxyAdditionalSecureLinks,
  proxyHosts,
  relayEndpoints,
  relayPolicyState,
  relayRoutes,
  storageCopyJobs,
} from '@/db/schema/index.js';
import { RELAY_MAX_FRAME_BYTES } from '@/grpc/relay-control.client.js';
import {
  reconcileSetRelayPaths,
  SET_CLIENT_ENDPOINT_KIND,
  SET_WITNESS_ENDPOINT_KIND,
} from './relay-managed-availability.js';

const POLICY_ID = 'current';

function fingerprint(certificatePem: string): string {
  const certificate = new X509Certificate(certificatePem);
  return `sha256:${createHash('sha256').update(certificate.raw).digest('hex')}`;
}

export async function bumpRelayPolicyRevision(tx: any): Promise<void> {
  await tx
    .update(relayPolicyState)
    .set({ revision: sql`${relayPolicyState.revision} + 1`, updatedAt: new Date() })
    .where(eq(relayPolicyState.id, POLICY_ID));
}

export async function backfillRelayNodeFingerprints(db: DrizzleClient): Promise<void> {
  const rows = await db
    .select({ id: nodes.id, certificateSerial: nodes.certificateSerial })
    .from(nodes)
    .where(and(isNull(nodes.certificateFingerprint), isNotNull(nodes.certificateSerial)));
  for (const node of rows) {
    const [certificate] = await db
      .select({ certificatePem: certificates.certificatePem })
      .from(certificates)
      .where(eq(certificates.serialNumber, node.certificateSerial!))
      .limit(1);
    if (certificate) {
      await db
        .update(nodes)
        .set({ certificateFingerprint: fingerprint(certificate.certificatePem), updatedAt: new Date() })
        .where(eq(nodes.id, node.id));
    }
  }
}

export async function updateManagedDatabaseRelayStatus(
  db: DrizzleClient,
  managedDatabaseId: string,
  databaseStatus: string
): Promise<boolean> {
  const status = databaseStatus === 'ready' || databaseStatus === 'updating' ? 'active' : 'inactive';
  return db.transaction(async (tx) => {
    // After a reconciliation pass that is running: a pass that read the database before it became ready commits its
    // endpoint as inactive, and a status change that ran beside it would not see that endpoint and leave it so.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-policy-reconciliation'))`);
    // A database served by an availability set: its endpoints follow the set (reconcileSetRelayPaths).
    const [set] = await tx
      .select({ id: managedAvailabilitySets.id })
      .from(managedAvailabilitySets)
      .where(eq(managedAvailabilitySets.managedDatabaseId, managedDatabaseId))
      .limit(1);
    if (set) {
      const changed = await reconcileSetRelayPaths(tx, [set.id]);
      if (changed) await bumpRelayPolicyRevision(tx);
      return changed;
    }
    const [endpoint] = await tx
      .select()
      .from(relayEndpoints)
      .where(and(eq(relayEndpoints.ownerKind, 'managed_database'), eq(relayEndpoints.ownerId, managedDatabaseId)))
      .limit(1);
    if (!endpoint || endpoint.status === status) return false;
    await tx
      .update(relayEndpoints)
      .set({ status, generation: sql`${relayEndpoints.generation} + 1`, updatedAt: new Date() })
      .where(eq(relayEndpoints.id, endpoint.id));
    await bumpRelayPolicyRevision(tx);
    return true;
  });
}

export async function reconcileManagedDatabaseRelayPolicy(db: DrizzleClient): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-policy-reconciliation'))`);
    // Everything is read under the lock, relay state first: an endpoint or route created while another pass held the
    // lock must not be judged by data read before it existed (it would be deleted, with every route to it). Every
    // database and link row is committed before its relay state, so the owner of every row read here is visible below.
    const existingEndpoints = await tx
      .select()
      .from(relayEndpoints)
      .where(eq(relayEndpoints.ownerKind, 'managed_database'));
    const existingRoutes = await tx
      .select()
      .from(relayRoutes)
      .where(eq(relayRoutes.ownerKind, 'managed_database_binding'));
    const [databases, bindings, bindingPlacements, availabilityPolicies, identities, setOwners] = await Promise.all([
      tx
        .select({
          id: managedDatabaseInstances.id,
          nodeId: managedDatabaseInstances.nodeId,
          status: managedDatabaseInstances.status,
        })
        .from(managedDatabaseInstances),
      tx
        .select({
          id: managedDatabaseBindings.id,
          managedDatabaseId: managedDatabaseBindings.managedDatabaseId,
          sourceNodeId: managedDatabaseBindings.targetNodeId,
          targetType: managedDatabaseBindings.targetType,
          targetResourceId: managedDatabaseBindings.targetResourceId,
          desiredState: managedDatabaseBindings.desiredState,
          status: managedDatabaseBindings.status,
        })
        .from(managedDatabaseBindings),
      tx
        .select({
          id: managedDatabaseBindingPlacements.id,
          bindingId: managedDatabaseBindingPlacements.bindingId,
          availabilityPlacementId: managedDatabaseBindingPlacements.availabilityPlacementId,
          sourceNodeId: managedDatabaseBindingPlacements.nodeId,
          desiredState: managedDatabaseBindingPlacements.desiredState,
          status: managedDatabaseBindingPlacements.status,
        })
        .from(managedDatabaseBindingPlacements),
      tx
        .select({
          mode: dockerAvailabilityPolicies.mode,
          status: dockerAvailabilityPolicies.status,
          resourceKind: dockerAvailabilityPolicies.resourceKind,
          sourceNodeId: dockerAvailabilityPolicies.sourceNodeId,
          containerName: dockerAvailabilityPolicies.containerName,
          deploymentId: dockerAvailabilityPolicies.deploymentId,
          composeProjectId: dockerAvailabilityPolicies.composeProjectId,
        })
        .from(dockerAvailabilityPolicies),
      tx.select({ id: nodes.id, certificateFingerprint: nodes.certificateFingerprint }).from(nodes),
      tx
        .select({ id: managedAvailabilitySets.managedDatabaseId })
        .from(managedAvailabilitySets)
        .where(isNotNull(managedAvailabilitySets.managedDatabaseId)),
    ]);
    // Databases an availability set serves: their endpoint is the origin member's and follows the set (below).
    const setDatabaseIds = new Set(setOwners.flatMap(({ id }) => (id ? [id] : [])));
    const fingerprints = new Map(
      identities
        .filter(({ certificateFingerprint }) => Boolean(certificateFingerprint))
        .map(({ id, certificateFingerprint }) => [id, certificateFingerprint!])
    );
    const activeAvailabilityPolicies = availabilityPolicies.filter(
      ({ mode, status }) => mode !== 'single' && status !== 'disabling'
    );
    const availabilityManagedBindingIds = new Set(
      bindings
        .filter((binding) =>
          activeAvailabilityPolicies.some((policy) => {
            if (binding.targetType === 'container') {
              return (
                policy.resourceKind === 'container' &&
                policy.sourceNodeId === binding.sourceNodeId &&
                policy.containerName === binding.targetResourceId
              );
            }
            if (binding.targetType === 'deployment') {
              return policy.resourceKind === 'deployment' && policy.deploymentId === binding.targetResourceId;
            }
            return (
              policy.resourceKind === 'compose' && policy.composeProjectId === binding.targetResourceId.split(':', 1)[0]
            );
          })
        )
        .map(({ id }) => id)
    );
    const parentBindings = new Map(bindings.map((binding) => [binding.id, binding]));
    const relayBindings = [
      ...bindings.filter(({ id }) => !availabilityManagedBindingIds.has(id)),
      ...bindingPlacements.flatMap((placement) => {
        if (!placement.availabilityPlacementId) return [];
        const parent = parentBindings.get(placement.bindingId);
        return parent
          ? [
              {
                id: placement.id,
                managedDatabaseId: parent.managedDatabaseId,
                sourceNodeId: placement.sourceNodeId,
                desiredState: placement.desiredState,
                status: placement.status,
              },
            ]
          : [];
      }),
    ];

    let changed = false;
    const databaseIds = new Set(
      databases.filter(({ id, nodeId }) => setDatabaseIds.has(id) || fingerprints.has(nodeId)).map(({ id }) => id)
    );
    for (const endpoint of existingEndpoints) {
      if (databaseIds.has(endpoint.ownerId)) continue;
      await tx.delete(relayEndpoints).where(eq(relayEndpoints.id, endpoint.id));
      changed = true;
    }
    for (const database of databases) {
      if (setDatabaseIds.has(database.id)) continue;
      const certificateSha256 = fingerprints.get(database.nodeId);
      if (!certificateSha256) continue;
      const status = database.status === 'ready' || database.status === 'updating' ? 'active' : 'inactive';
      const current = existingEndpoints.find(({ ownerId }) => ownerId === database.id);
      if (!current) {
        await tx.insert(relayEndpoints).values({
          ownerKind: 'managed_database',
          ownerId: database.id,
          subjectKind: 'daemon',
          subjectId: database.nodeId,
          certificateSha256,
          status,
        });
        changed = true;
      } else if (
        current.subjectId !== database.nodeId ||
        current.certificateSha256 !== certificateSha256 ||
        current.status !== status
      ) {
        await tx
          .update(relayEndpoints)
          .set({
            subjectId: database.nodeId,
            certificateSha256,
            status,
            generation: sql`${relayEndpoints.generation} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(relayEndpoints.id, current.id));
        changed = true;
      }
    }

    const endpoints = await tx.select().from(relayEndpoints).where(eq(relayEndpoints.ownerKind, 'managed_database'));
    const endpointByDatabase = new Map(endpoints.map((endpoint) => [endpoint.ownerId, endpoint]));
    // A link keeps its route from creation until it is deleted. Creation starts the workload with
    // the link before the link is 'ready', and a failed reconcile marks a working link 'error';
    // dropping the route in either state closes the listener the workload connects through.
    const desiredBindings = relayBindings.filter(
      ({ desiredState, status, managedDatabaseId, sourceNodeId }) =>
        desiredState === 'active' &&
        status !== 'deleting' &&
        endpointByDatabase.has(managedDatabaseId) &&
        fingerprints.has(sourceNodeId)
    );
    const desiredBindingIds = new Set(desiredBindings.map(({ id }) => id));
    for (const route of existingRoutes) {
      if (desiredBindingIds.has(route.ownerId)) continue;
      await tx.delete(relayRoutes).where(eq(relayRoutes.id, route.id));
      changed = true;
    }
    for (const binding of desiredBindings) {
      const endpoint = endpointByDatabase.get(binding.managedDatabaseId)!;
      const sourceCertificateSha256 = fingerprints.get(binding.sourceNodeId)!;
      const current = existingRoutes.find(({ ownerId }) => ownerId === binding.id);
      if (!current) {
        await tx.insert(relayRoutes).values({
          ownerKind: 'managed_database_binding',
          ownerId: binding.id,
          sourceKind: 'daemon',
          sourceId: binding.sourceNodeId,
          sourceCertificateSha256,
          targetEndpointId: endpoint.id,
          maxFrameBytes: RELAY_MAX_FRAME_BYTES,
        });
        changed = true;
      } else if (
        current.sourceId !== binding.sourceNodeId ||
        current.sourceCertificateSha256 !== sourceCertificateSha256 ||
        current.targetEndpointId !== endpoint.id
      ) {
        await tx
          .update(relayRoutes)
          .set({
            sourceId: binding.sourceNodeId,
            sourceCertificateSha256,
            targetEndpointId: endpoint.id,
            generation: sql`${relayRoutes.generation} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(relayRoutes.id, current.id));
        changed = true;
      }
    }
    // Availability sets: member endpoints, member routes of every route above and the member mesh.
    changed = (await reconcileSetRelayPaths(tx)) || changed;
    if (changed) await bumpRelayPolicyRevision(tx);
  });
}

/**
 * Removes storage link routes whose link no longer exists. Storage links create and revoke their
 * routes inline; a crash between the two (or a failed revoke) would otherwise leave a route that
 * lets the source node reach the storage without a link.
 */
export async function reconcileManagedStorageRelayPolicy(db: DrizzleClient): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-policy-reconciliation'))`);
    // Routes first: a link row is committed before its route is created, so every link whose
    // route this read sees is visible to the read below.
    const routes = await tx
      .select({ id: relayRoutes.id, ownerId: relayRoutes.ownerId })
      .from(relayRoutes)
      .where(eq(relayRoutes.ownerKind, 'managed_storage_binding'));
    if (routes.length === 0) return;
    const bindings = await tx.select({ id: managedStorageBindings.id }).from(managedStorageBindings);
    const bindingIds = new Set(bindings.map(({ id }) => id));
    let changed = false;
    for (const route of routes) {
      if (bindingIds.has(route.ownerId)) continue;
      await tx.delete(relayRoutes).where(eq(relayRoutes.id, route.id));
      changed = true;
    }
    if (changed) await bumpRelayPolicyRevision(tx);
  });
}

/** `live`: the condition an owner row must meet to keep its relay state; absent, existing is enough. */
type OwnerTable = { table: any; id: any; live?: SQL };

const PROXY_SECURE_LINK_OWNERS: OwnerTable[] = [
  { table: proxyHosts, id: proxyHosts.id },
  { table: proxyAdditionalSecureLinks, id: proxyAdditionalSecureLinks.id },
];
const MANAGED_STORAGE_OWNERS: OwnerTable[] = [{ table: managedStorageClusters, id: managedStorageClusters.id }];
const BACKUP_RUN_OWNERS: OwnerTable[] = [{ table: backupRuns, id: backupRuns.id }];
// Storage routes are also created per storage copy job, under the job's id.
const STORAGE_RUN_OWNERS: OwnerTable[] = [...BACKUP_RUN_OWNERS, { table: storageCopyJobs, id: storageCopyJobs.id }];
const CONTAINER_LINK_OWNERS: OwnerTable[] = [{ table: containerLinks, id: containerLinks.id }];

/**
 * The rows that own relay state, per owner kind. Managed database endpoints and database and storage link routes
 * are reconciled by the passes above; the internal registry and its ingress have fixed owners.
 */
const ENDPOINT_OWNERS: Record<string, OwnerTable[]> = {
  proxy_host_secure_link: PROXY_SECURE_LINK_OWNERS,
  [SET_CLIENT_ENDPOINT_KIND]: [{ table: managedAvailabilityMembers, id: managedAvailabilityMembers.id }],
  [SET_WITNESS_ENDPOINT_KIND]: [{ table: managedAvailabilityWitnesses, id: managedAvailabilityWitnesses.id }],
  managed_storage: MANAGED_STORAGE_OWNERS,
  // A container link's own endpoint, or the endpoint of one target placement of it.
  container_link: [...CONTAINER_LINK_OWNERS, { table: containerLinkPlacements, id: containerLinkPlacements.id }],
};
const ROUTE_OWNERS: Record<string, OwnerTable[]> = {
  container_link: CONTAINER_LINK_OWNERS,
  proxy_host_secure_link: PROXY_SECURE_LINK_OWNERS,
  managed_storage_gateway: MANAGED_STORAGE_OWNERS,
  managed_database_gateway: [{ table: managedDatabaseInstances, id: managedDatabaseInstances.id }],
  database_backup_source: BACKUP_RUN_OWNERS,
  database_backup_restore: BACKUP_RUN_OWNERS,
  storage_backup_target: STORAGE_RUN_OWNERS,
  storage_backup_staging: STORAGE_RUN_OWNERS,
  // Revoked bindings are kept as history; their routes go with the revocation, or here if that failed.
  registry_secure_link: [
    {
      table: dockerRegistryNodeBindings,
      id: dockerRegistryNodeBindings.id,
      live: eq(dockerRegistryNodeBindings.status, 'active'),
    },
  ],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Removes relay endpoints and routes whose owner no longer exists (or, for a registry binding, is no longer active).
 * Every owner revokes its relay state when it is
 * deleted, but a revocation that failed, raced the owner's last provisioning step or was skipped by an earlier
 * release left state behind: the daemons it names kept their grants and retried its tunnels forever. Returns the
 * daemons whose grants lost something.
 */
export async function removeOrphanedRelayState(db: DrizzleClient): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-policy-reconciliation'))`);
    // Relay state first: every owner row is committed before its relay state is created, so the owner of every row
    // read here is visible to the reads below unless it is gone.
    const endpoints = await tx
      .select({
        id: relayEndpoints.id,
        ownerKind: relayEndpoints.ownerKind,
        ownerId: relayEndpoints.ownerId,
        subjectKind: relayEndpoints.subjectKind,
        subjectId: relayEndpoints.subjectId,
      })
      .from(relayEndpoints)
      .where(inArray(relayEndpoints.ownerKind, Object.keys(ENDPOINT_OWNERS)));
    const routes = await tx
      .select({
        id: relayRoutes.id,
        ownerKind: relayRoutes.ownerKind,
        ownerId: relayRoutes.ownerId,
        sourceKind: relayRoutes.sourceKind,
        sourceId: relayRoutes.sourceId,
      })
      .from(relayRoutes)
      .where(inArray(relayRoutes.ownerKind, Object.keys(ROUTE_OWNERS)));
    if (endpoints.length === 0 && routes.length === 0) return [];

    const existing = new Set<string>();
    const candidates = new Map<OwnerTable, Set<string>>();
    const collect = (owners: OwnerTable[] | undefined, ownerId: string) => {
      if (!UUID.test(ownerId)) return;
      for (const owner of owners ?? []) {
        const ids = candidates.get(owner) ?? new Set<string>();
        ids.add(ownerId);
        candidates.set(owner, ids);
      }
    };
    for (const endpoint of endpoints) collect(ENDPOINT_OWNERS[endpoint.ownerKind], endpoint.ownerId);
    for (const route of routes) collect(ROUTE_OWNERS[route.ownerKind], route.ownerId);
    for (const [owner, ids] of candidates) {
      const rows: Array<{ id: string }> = await tx
        .select({ id: owner.id })
        .from(owner.table)
        .where(owner.live ? and(inArray(owner.id, [...ids]), owner.live) : inArray(owner.id, [...ids]));
      for (const { id } of rows) existing.add(id);
    }

    const orphanEndpoints = endpoints.filter(({ ownerId }) => !existing.has(ownerId));
    const orphanRoutes = routes.filter(({ ownerId }) => !existing.has(ownerId));
    if (orphanEndpoints.length === 0 && orphanRoutes.length === 0) return [];
    const orphanEndpointIds = orphanEndpoints.map(({ id }) => id);
    // Routes of any owner that lead to a removed endpoint go with it (on delete cascade): their sources lose a grant.
    const cascadedRoutes = orphanEndpointIds.length
      ? await tx
          .select({ sourceKind: relayRoutes.sourceKind, sourceId: relayRoutes.sourceId })
          .from(relayRoutes)
          .where(inArray(relayRoutes.targetEndpointId, orphanEndpointIds))
      : [];
    if (orphanRoutes.length) {
      await tx.delete(relayRoutes).where(
        inArray(
          relayRoutes.id,
          orphanRoutes.map(({ id }) => id)
        )
      );
    }
    if (orphanEndpointIds.length) await tx.delete(relayEndpoints).where(inArray(relayEndpoints.id, orphanEndpointIds));
    await bumpRelayPolicyRevision(tx);
    return [
      ...new Set([
        ...orphanEndpoints.filter(({ subjectKind }) => subjectKind === 'daemon').map(({ subjectId }) => subjectId),
        ...[...orphanRoutes, ...cascadedRoutes]
          .filter(({ sourceKind }) => sourceKind === 'daemon')
          .map(({ sourceId }) => sourceId),
      ]),
    ];
  });
}
