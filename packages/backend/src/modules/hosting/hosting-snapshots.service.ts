import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DrizzleClient } from '@/db/client.js';
import {
  hostingNodeBindings,
  hostingOperations,
  hostingResources,
  hostingSnapshotPlacements,
  nodes,
} from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import {
  CreateResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import type { User } from '@/types.js';
import type { HostingConnectorRow, HostingConnectorsService } from './hosting-connectors.service.js';
import { lockHostingFirewalls } from './hosting-firewall-lock.js';
import { HostingProviderError } from './hosting-http.js';
import { withKnownLocation } from './hosting-location.js';
import { type HostingOperationsService, publicHostingOperation } from './hosting-operations.service.js';
import { assertHostingScope, canViewHostingFinance } from './hosting-permissions.js';
import type { HostingResourceSnapshot } from './hosting-provider.types.js';
import {
  HOSTING_SNAPSHOT_ACTIONS,
  type HostingSnapshotAction,
  type HostingVmSnapshot,
} from './hosting-snapshot.types.js';
import { HostingSnapshotEntities } from './hosting-snapshot-entities.js';
import { snapshotFolderService, snapshotLayoutId, snapshotPlacements } from './hosting-snapshot-folders.js';
import { HostingSnapshotReadModel, snapshotCacheFresh, snapshotCacheMatches } from './hosting-snapshot-read-model.js';

export const HostingSnapshotInputSchema = z
  .object({
    action: z.enum(HOSTING_SNAPSHOT_ACTIONS),
    idempotencyKey: z.string().uuid(),
    expectedIncarnation: z.string().min(1).max(1000),
    name: z.string().trim().min(1).max(100).optional(),
    includeRam: z.boolean().optional(),
    snapshotId: z.string().min(1).max(200).optional(),
    snapshotEntityId: z.string().uuid().optional(),
    snapshotFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    confirmed: z.literal(true),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.includeRam !== undefined && input.action !== 'snapshot_create')
      ctx.addIssue({
        code: 'custom',
        path: ['includeRam'],
        message: 'RAM can only be included when creating a snapshot',
      });
    if (input.action === 'snapshot_create' && !input.name)
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'Enter a snapshot name' });
    if (
      input.action !== 'snapshot_create' &&
      !input.snapshotEntityId &&
      (!input.snapshotId || !input.snapshotFingerprint)
    )
      ctx.addIssue({ code: 'custom', message: 'Select a current VM snapshot' });
  });
export type HostingSnapshotInput = z.infer<typeof HostingSnapshotInputSchema>;
function canRestorePower(provider: HostingConnectorRow['provider'], powerState: HostingResourceSnapshot['powerState']) {
  return powerState === 'stopped' || (provider === 'proxmox' && powerState === 'running');
}
export function assertSnapshotSelection(
  input: HostingSnapshotInput,
  snapshots: HostingVmSnapshot[],
  live: HostingResourceSnapshot,
  provider: HostingConnectorRow['provider']
): HostingVmSnapshot | undefined {
  if (input.action === 'snapshot_create') {
    if (input.includeRam) {
      if (provider !== 'proxmox' || live.kind !== 'vm')
        throw new AppError(400, 'HOSTING_SNAPSHOT_RAM_UNSUPPORTED', 'RAM snapshots are supported only for Proxmox VMs');
      if (live.powerState !== 'running')
        throw new AppError(
          409,
          'HOSTING_SNAPSHOT_RAM_REQUIRES_RUNNING',
          'The VM must be running to include RAM in a snapshot'
        );
    }
    return undefined;
  }
  const snapshot = snapshots.find((x) => x.id === input.snapshotId && x.fingerprint === input.snapshotFingerprint);
  if (!snapshot)
    throw new AppError(409, 'HOSTING_SNAPSHOT_CHANGED', 'Snapshot is missing, changed, or does not belong to this VM');
  if (!snapshot.ready) throw new AppError(409, 'HOSTING_SNAPSHOT_NOT_READY', 'Wait for the snapshot to become ready');
  if (input.action === 'snapshot_restore') {
    if (!canRestorePower(provider, live.powerState))
      throw new AppError(
        409,
        'HOSTING_VM_MUST_STOP',
        provider === 'proxmox'
          ? 'Wait for the VM to reach a stable running or stopped state before restoring a snapshot'
          : 'Shut down the VM before restoring a snapshot'
      );
    if (snapshot.minDiskGb !== null && (live.diskGb === null || live.diskGb < snapshot.minDiskGb))
      throw new AppError(
        409,
        'HOSTING_SNAPSHOT_DISK_TOO_SMALL',
        'The VM disk is smaller than required by this snapshot'
      );
  }
  return snapshot;
}
export class HostingSnapshotsService {
  readonly readModel: HostingSnapshotReadModel;
  readonly entities: HostingSnapshotEntities;
  constructor(
    private readonly db: DrizzleClient,
    private readonly connectors: HostingConnectorsService,
    private readonly operations: HostingOperationsService,
    private readonly auth: Pick<AuthService, 'getUserById'>,
    private readonly audit: Pick<AuditService, 'log'>,
    store?: ResourceSnapshotStore,
    private readonly events?: EventBusService
  ) {
    this.entities = new HostingSnapshotEntities(db);
    this.readModel = new HostingSnapshotReadModel(
      db,
      connectors,
      store,
      (id, user) => this.target(id, user),
      async ({ resource }, snapshots, startedAt) => {
        const before = await this.entities.list(resource.id, resource.incarnation!);
        await this.entities.mergeInventory(resource.id, resource.incarnation!, snapshots, startedAt);
        const after = await this.entities.list(resource.id, resource.incarnation!);
        for (const item of after) {
          if (JSON.stringify(before.find((s) => s.entityId === item.entityId)) !== JSON.stringify(item))
            await this.publishSnapshot(resource.id, resource.incarnation!, item);
        }
        for (const item of before) {
          if (!after.some((s) => s.entityId === item.entityId))
            await this.publishSnapshot(resource.id, resource.incarnation!, {
              ...item,
              status: 'deleted',
              revision: new Date().toISOString(),
            });
        }
      }
    );
  }
  private async publishSnapshot(
    resourceId: string,
    incarnation: string,
    snapshot?: HostingVmSnapshot,
    operation?: ReturnType<typeof publicHostingOperation>
  ) {
    try {
      if (!this.events) return;
      const [resource] = await this.db.select().from(hostingResources).where(eq(hostingResources.id, resourceId));
      if (!resource?.connectorId || resource.incarnation !== incarnation || resource.missingSince) return;
      const bindings = await this.db
        .select()
        .from(hostingNodeBindings)
        .where(eq(hostingNodeBindings.resourceId, resourceId));
      // Do not expose the actor-only job result through a resource-view subscription.
      const publicState = operation
        ? { ...operation, result: undefined, errorCode: null, errorMessage: snapshot?.error ?? null }
        : undefined;
      this.events.publish(snapshot ? 'hosting.snapshot.changed' : 'hosting.snapshot.folder.changed', {
        resourceId,
        incarnation,
        connectorId: resource.connectorId,
        nodeIds: bindings.map((b) => b.nodeId),
        // Billing fields are projected per WebSocket recipient, as in the authorized list GET.
        snapshot,
        operation: publicState,
      });
    } catch {
      // Entity commit owns state. A missed event is recovered by reconnect/list reads.
    }
  }
  private async target(resourceId: string, user: User, action?: HostingSnapshotAction) {
    const [resource] = await this.db.select().from(hostingResources).where(eq(hostingResources.id, resourceId));
    if (!resource) throw new AppError(404, 'HOSTING_RESOURCE_NOT_FOUND', 'Hosting resource not found');
    if (
      !resource?.connectorId ||
      resource.missingSince ||
      resource.origin === 'discovered' ||
      !resource.incarnation ||
      resource.snapshot.incarnation !== resource.incarnation
    )
      throw new AppError(409, 'HOSTING_RESOURCE_UNMANAGED', 'Snapshots require an unchanged managed VM');
    const connector = await this.connectors.get(resource.connectorId, user, true);
    const settings = this.connectors.settings(connector);
    if (settings.resourceIds.length && !settings.resourceIds.includes(resource.remoteId))
      throw new AppError(403, 'HOSTING_RESOURCE_OUT_OF_SCOPE', 'VM is outside the hosting connector scope');
    assertHostingScope(user.scopes, 'hosting:resources:view', resource.id);
    assertHostingScope(user.scopes, 'hosting:snapshots:view', resource.id);
    if (action) assertHostingScope(user.scopes, `hosting:snapshots:${action.slice('snapshot_'.length)}`, resource.id);
    const bindings = await this.db
      .select()
      .from(hostingNodeBindings)
      .where(eq(hostingNodeBindings.resourceId, resource.id));
    if (!bindings.length)
      throw new AppError(409, 'HOSTING_NODE_BINDING_REQUIRED', 'Snapshots require a VM bound to an Opfield node');
    for (const binding of bindings) {
      const [node] = await this.db.select().from(nodes).where(eq(nodes.id, binding.nodeId));
      if (
        !node ||
        node.hostIdentityId !== binding.hostIdentityId ||
        binding.hostIdentityId !== resource.managedHostIdentity
      )
        throw new AppError(409, 'HOSTING_NODE_BINDING_CHANGED', 'Node binding changed');
      if (action && node.status === 'pending')
        throw new AppError(409, 'HOSTING_NODE_NOT_READY', 'Wait for node provisioning to finish');
    }
    // Seeing every bound node is the VM visibility baseline, as in the hosting resource list. Snapshot create,
    // delete and folder layout act on the provider VM only; restoring rewrites the node's disk, which is node control.
    for (const binding of bindings) {
      assertHostingScope(user.scopes, 'nodes:details', binding.nodeId);
      if (action === 'snapshot_restore') assertHostingScope(user.scopes, 'nodes:manage', binding.nodeId);
    }
    return { resource, connector, nodeIds: bindings.map((b) => b.nodeId).sort() };
  }
  async view(resourceId: string, user: User) {
    const { resource, connector, nodeIds } = await this.target(resourceId, user);
    const adapter = this.connectors.adapter(connector);
    const supported = !!adapter.snapshots;
    const cached = await this.readModel.get(resource.id);
    const matches = snapshotCacheMatches(cached, { resource, connector });
    const fresh = connector.enabled && snapshotCacheFresh(cached, { resource, connector });
    const persisted = await this.entities.list(resourceId, resource.incarnation!);
    const visible = persisted;
    const snapshots = canViewHostingFinance(user.scopes, connector.id)
      ? visible
      : visible.map(({ monthlyCost: _cost, storageRate: _rate, ...snapshot }) => snapshot);
    const powerState = resource.snapshot.powerState;
    const [operation] = await this.db
      .select()
      .from(hostingOperations)
      .where(eq(hostingOperations.resourceId, resource.id))
      .orderBy(desc(hostingOperations.createdAt))
      .limit(1);
    const busy = !!operation && !['ready', 'failed'].includes(operation.phase);
    let visibleOperation: ReturnType<typeof publicHostingOperation> | null = null;
    if (operation && (busy || HOSTING_SNAPSHOT_ACTIONS.includes(operation.action as HostingSnapshotAction))) {
      try {
        visibleOperation = await this.operations.get(operation.id, user);
      } catch (error) {
        if (!(error instanceof AppError) || ![403, 404, 410].includes(error.statusCode)) throw error;
      }
    }
    return {
      resourceId: resource.id,
      incarnation: resource.incarnation,
      provider: connector.provider,
      powerState,
      supported,
      busy,
      reason: !supported
        ? 'Snapshots are not supported by this provider integration'
        : !fresh
          ? 'Snapshot information is refreshing or unavailable'
          : null,
      readModel: {
        refreshStatus: cached?.refreshStatus ?? 'never',
        availability: fresh ? 'available' : 'unknown',
        lastError: matches ? (cached?.lastError ?? null) : null,
        observedAt: matches ? (cached?.observedAt ?? null) : null,
      },
      snapshots: await snapshotPlacements(this.db, resourceId, snapshots),
      canManageFolders: hasScope(user.scopes, `hosting:snapshots:folders:manage:${resourceId}`),
      operation: visibleOperation,
      canCreate: supported && hasScope(user.scopes, `hosting:snapshots:create:${resource.id}`),
      canDelete: supported && hasScope(user.scopes, `hosting:snapshots:delete:${resource.id}`),
      canRestore:
        supported &&
        canRestorePower(connector.provider, powerState) &&
        hasScope(user.scopes, `hosting:snapshots:restore:${resource.id}`) &&
        nodeIds.every((n) => hasScope(user.scopes, `nodes:manage:${n}`)),
    };
  }
  async folders(resourceId: string, user: User) {
    await this.target(resourceId, user);
    return snapshotFolderService(this.db, this.audit as AuditService, resourceId).getFolderTree({
      includeAllFolders: true,
    });
  }
  async folderAction(resourceId: string, user: User, operation: string, input: unknown, folderId?: string) {
    const target = await this.target(resourceId, user);
    // Snapshot assignments are catalog metadata, never provider mutations: the snapshot folder scope is enough.
    assertHostingScope(user.scopes, 'hosting:snapshots:folders:manage', resourceId);
    let selected: HostingVmSnapshot[] = [];
    let move: ReturnType<typeof MoveResourcesToFolderSchema.parse> | undefined;
    let reorder: ReturnType<typeof ReorderResourcesSchema.parse> | undefined;
    if (operation === 'move-resources' || operation === 'reorder-resources') {
      const adapter = this.connectors.adapter(target.connector);
      const live = await adapter.getResource(target.resource.remoteId);
      if (!adapter.snapshots || !live || live.incarnation !== target.resource.incarnation)
        throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'Provider VM identity changed');
      const snapshots = await snapshotPlacements(
        this.db,
        resourceId,
        await this.entities.list(resourceId, target.resource.incarnation!)
      );
      const ids =
        operation === 'move-resources'
          ? (move = MoveResourcesToFolderSchema.parse(input)).ids
          : (reorder = ReorderResourcesSchema.parse(input)).items.map((x) => x.id);
      selected = ids.map((id) => {
        const found = snapshots.find((s) => s.layoutId === id);
        if (!found)
          throw new AppError(409, 'HOSTING_SNAPSHOT_CHANGED', 'Snapshot is missing or belongs to a different VM');
        return found;
      });
    }
    const result = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(hostingResources)
        .where(eq(hostingResources.id, resourceId))
        .for('update');
      if (!locked || locked.incarnation !== target.resource.incarnation)
        throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'VM identity changed');
      const folders = snapshotFolderService(tx as unknown as DrizzleClient, this.audit as AuditService, resourceId);
      if (selected.length)
        await tx
          .insert(hostingSnapshotPlacements)
          .values(
            selected.map((s) => ({
              id: s.layoutId ?? s.entityId ?? snapshotLayoutId(resourceId, s.fingerprint),
              resourceId,
              snapshotId: s.id,
              fingerprint: s.fingerprint,
            }))
          )
          .onConflictDoNothing();
      if (operation === 'create') return folders.createFolder(CreateResourceFolderSchema.parse(input), user.id);
      if (operation === 'rename' && folderId)
        return folders.updateFolder(folderId, UpdateResourceFolderSchema.parse(input), user.id);
      if (operation === 'delete' && folderId) return folders.deleteFolder(folderId, user.id);
      if (operation === 'reorder-folders') return folders.reorderFolders(ReorderResourceFoldersSchema.parse(input));
      if (move) return folders.moveResourcesToFolder(move, user.id);
      if (reorder) return folders.reorderResources(reorder);
      throw new AppError(400, 'INVALID_FOLDER_ACTION', 'Unknown snapshot folder action');
    });
    this.connectors.changed(target.connector.id);
    await this.publishSnapshot(resourceId, target.resource.incarnation!);
    return result ?? { success: true };
  }
  async action(resourceId: string, input: HostingSnapshotInput, user: User) {
    const target = await this.target(resourceId, user, input.action);
    if (target.resource.incarnation !== input.expectedIncarnation)
      throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'VM identity changed');
    const adapter = this.connectors.adapter(target.connector);
    if (!adapter.snapshots)
      throw new AppError(409, 'HOSTING_SNAPSHOTS_UNSUPPORTED', 'Snapshots are unavailable for this provider');
    const replay = await this.operations.findIntent({
      connectorId: target.connector.id,
      actorId: user.id,
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      request: { ...input },
    });
    if (replay) return this.operations.get(replay.id, user);
    let selectedEntity = input.snapshotEntityId
      ? await this.entities.get(resourceId, input.expectedIncarnation, input.snapshotEntityId)
      : null;
    if (input.action !== 'snapshot_create' && !selectedEntity) {
      const selected = (await this.entities.list(resourceId, input.expectedIncarnation)).find(
        (s) => s.id === input.snapshotId && s.fingerprint === input.snapshotFingerprint
      );
      if (selected?.entityId)
        selectedEntity = await this.entities.get(resourceId, input.expectedIncarnation, selected.entityId);
    }
    if (input.action !== 'snapshot_create' && !selectedEntity)
      throw new AppError(409, 'HOSTING_SNAPSHOT_CHANGED', 'Snapshot is missing or belongs to another VM');
    if (
      selectedEntity &&
      input.snapshotFingerprint &&
      selectedEntity.fingerprint &&
      input.snapshotFingerprint !== selectedEntity.fingerprint
    )
      throw new AppError(409, 'HOSTING_SNAPSHOT_CHANGED', 'Snapshot changed since confirmation; refresh and try again');
    const localFailedDelete =
      input.action === 'snapshot_delete' && selectedEntity?.status === 'failed' && !selectedEntity.providerSnapshotId;
    const failedSnapshotDelete = input.action === 'snapshot_delete' && selectedEntity?.status === 'failed';
    const [failedCreate] =
      localFailedDelete && selectedEntity?.operationId
        ? await this.db
            .select()
            .from(hostingOperations)
            .where(
              and(eq(hostingOperations.id, selectedEntity.operationId), eq(hostingOperations.resourceId, resourceId))
            )
        : [];
    if (input.action !== 'snapshot_create' && !failedSnapshotDelete && selectedEntity?.status !== 'ready')
      throw new AppError(409, 'HOSTING_SNAPSHOT_NOT_READY', 'Wait for the snapshot operation to finish');
    // Admission is local and fast; live provider validation happens in the durable worker.
    if (input.action === 'snapshot_create')
      assertSnapshotSelection(input, [], target.resource.snapshot, target.connector.provider);
    const accepted = {
      ...input,
      ...(selectedEntity
        ? {
            snapshotEntityId: selectedEntity.id,
            snapshotId: selectedEntity.providerSnapshotId ?? selectedEntity.id,
            snapshotFingerprint: selectedEntity.fingerprint ?? undefined,
          }
        : {}),
    };
    const reserved = await this.operations.reserve(
      {
        connectorId: target.connector.id,
        resourceId,
        actorId: user.id,
        action: input.action,
        idempotencyKey: input.idempotencyKey,
        request: accepted,
        intent: { ...input },
      },
      async (tx, operationId) => {
        await lockHostingFirewalls(tx, [resourceId]);
        const entityId = input.action === 'snapshot_create' ? input.idempotencyKey : selectedEntity!.id;
        if (input.action === 'snapshot_create')
          await this.entities.pending(tx, {
            id: entityId,
            resourceId,
            incarnation: input.expectedIncarnation,
            operationId,
            name: input.name!,
            includeRam: input.includeRam ?? false,
          });
        else
          await new HostingSnapshotEntities(tx as unknown as DrizzleClient).transition(
            resourceId,
            input.expectedIncarnation,
            entityId,
            { ...(input.action === 'snapshot_delete' ? { status: 'deleting' as const } : {}), operationId, error: null }
          );
        return {
          result: {
            snapshotEntityId: entityId,
            localFailedDelete,
            failedSnapshotDelete,
            ...(localFailedDelete
              ? {
                  failedSnapshotName: selectedEntity!.name,
                  failedCreateMarker:
                    failedCreate?.action === 'snapshot_create'
                      ? `gw${failedCreate.id.replaceAll('-', '')}`
                      : failedCreate?.result?.failedSnapshotDelete
                        ? failedCreate.result.failedCreateMarker
                        : null,
                  failedCreateBeforeIds:
                    failedCreate?.action === 'snapshot_create'
                      ? (failedCreate.result?.beforeSnapshotIds ?? null)
                      : failedCreate?.result?.failedSnapshotDelete
                        ? failedCreate.result.failedCreateBeforeIds
                        : null,
                }
              : {}),
            snapshotNodeIds: target.nodeIds,
            connectorRevision: target.connector.updatedAt.toISOString(),
          },
        };
      }
    );
    if (reserved.created)
      await this.audit.log({
        userId: user.id,
        action: `hosting.vm.${input.action}.requested`,
        resourceType: 'hosting-resource',
        resourceId,
        details: { operationId: reserved.operation.id, snapshotId: input.snapshotId },
      });
    this.connectors.changed(target.connector.id);
    const entityId = reserved.operation.result?.snapshotEntityId;
    const entity = (await this.entities.list(resourceId, input.expectedIncarnation)).find(
      (s) => s.entityId === entityId
    );
    if (entity)
      await this.publishSnapshot(
        resourceId,
        input.expectedIncarnation,
        entity,
        publicHostingOperation(reserved.operation)
      );
    // Keep the last-known inventory visible while the durable operation runs.
    // Mutations are locked by the active operation, not by deleting its read model.
    return publicHostingOperation(reserved.operation);
  }
  async reconcileDue() {
    for (const due of await this.operations.due()) {
      if (!HOSTING_SNAPSHOT_ACTIONS.includes(due.action as HostingSnapshotAction)) continue;
      const leased = await this.operations.claim(due.id);
      if (!leased) continue;
      let row = leased;
      let dispatchingNow = false;
      let refreshInventory = false;
      try {
        const input = HostingSnapshotInputSchema.parse(row.request);
        const actor = row.actorId ? await this.auth.getUserById(row.actorId) : null;
        if (!actor || actor.isBlocked || actor.isDeleted)
          throw new AppError(403, 'HOSTING_ACTOR_REVOKED', 'Snapshot operation owner no longer has access');
        if (!row.resourceId) throw new AppError(409, 'HOSTING_RESOURCE_MISSING', 'Snapshot VM is missing');
        const target = await this.target(row.resourceId, actor, input.action);
        if (target.resource.incarnation !== input.expectedIncarnation)
          throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'Snapshot VM identity changed');
        const claimed = row;
        const beforeRequest = async () => {
          const currentActor = claimed.actorId ? await this.auth.getUserById(claimed.actorId) : null;
          if (!currentActor || currentActor.isBlocked || currentActor.isDeleted)
            throw new AppError(403, 'HOSTING_ACTOR_REVOKED', 'Snapshot operation owner no longer has access');
          const current = await this.target(target.resource.id, currentActor, input.action);
          if (
            current.connector.updatedAt.toISOString() !== claimed.result?.connectorRevision ||
            current.resource.incarnation !== input.expectedIncarnation ||
            current.resource.remoteId !== target.resource.remoteId ||
            current.resource.authority !== target.resource.authority ||
            JSON.stringify(current.nodeIds) !== JSON.stringify(claimed.result?.snapshotNodeIds)
          )
            throw new AppError(
              409,
              'HOSTING_SNAPSHOT_TARGET_CHANGED',
              'VM, node bindings, or hosting connection changed; no snapshot mutation will be repeated'
            );
          await this.operations.renew(claimed);
        };
        const adapter = this.connectors.adapter(target.connector, beforeRequest);
        if (!adapter.snapshots)
          throw new AppError(409, 'HOSTING_SNAPSHOTS_UNSUPPORTED', 'Snapshots are unavailable for this provider');
        const snapshots = adapter.snapshots();
        let live = await adapter.getResource(target.resource.remoteId);
        if (!live || live.incarnation !== input.expectedIncarnation)
          throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'Provider VM identity changed');
        if (row.phase === 'pending' && !row.dispatchStartedAt) {
          const listed = await snapshots.list(live);
          // Listing may itself be an asynchronous provider task. Recheck the VM
          // immediately before dispatch rather than relying on its earlier state.
          live = await adapter.getResource(target.resource.remoteId);
          if (!live || live.incarnation !== input.expectedIncarnation)
            throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'Provider VM identity changed');
          if (input.action === 'snapshot_delete' && row.result?.localFailedDelete) {
            const priorIds = row.result.failedCreateBeforeIds;
            const named = listed.filter((s) => s.name === row.result?.failedSnapshotName);
            if (target.connector.provider === 'proxmox' && !row.result.failedCreateMarker && named.length)
              throw new AppError(
                409,
                'HOSTING_SNAPSHOT_CHANGED',
                'Original snapshot marker is unavailable; review the provider snapshots before removing this failed entry'
              );
            const candidates =
              target.connector.provider === 'proxmox'
                ? listed.filter((s) => s.id === row.result?.failedCreateMarker)
                : Array.isArray(priorIds)
                  ? named.filter((s) => !priorIds.includes(s.id))
                  : named;
            if (
              candidates.length > 1 ||
              (candidates.length && target.connector.provider !== 'proxmox' && !Array.isArray(priorIds))
            )
              throw new AppError(
                409,
                'HOSTING_SNAPSHOT_CHANGED',
                'Provider snapshot ownership is ambiguous; remove the confirmed provider snapshot before cleaning up this failed entry'
              );
            if (!candidates.length) {
              await beforeRequest();
              await this.finishWithEntity(row, input, 'ready');
              refreshInventory = true;
              continue;
            }
            input.snapshotId = candidates[0]!.id;
            input.snapshotFingerprint = candidates[0]!.fingerprint;
            row = await this.operations.update(row, { request: { ...input } });
          }
          // A failed create can leave only a marker, or an incomplete provider snapshot.
          // A complete inventory of this unchanged VM decides whether cleanup is local.
          if (input.action === 'snapshot_delete' && !listed.some((s) => s.id === input.snapshotId)) {
            await beforeRequest();
            await this.finishWithEntity(row, input, 'ready');
            refreshInventory = true;
            continue;
          }
          const selected =
            row.result?.failedSnapshotDelete && input.action === 'snapshot_delete'
              ? listed.find((s) => s.id === input.snapshotId)
              : assertSnapshotSelection(input, listed, live, target.connector.provider);
          if (selected && input.snapshotFingerprint && selected.fingerprint !== input.snapshotFingerprint)
            throw new AppError(409, 'HOSTING_SNAPSHOT_CHANGED', 'Provider snapshot identity changed');
          await beforeRequest();
          if (input.action === 'snapshot_create')
            row = await this.operations.update(row, {
              result: { ...row.result, beforeSnapshotIds: listed.map((s) => s.id) },
            });
          if (
            input.action === 'snapshot_create' &&
            row.result?.snapshotEntityId &&
            target.connector.provider === 'proxmox'
          )
            await this.entities.transition(
              target.resource.id,
              input.expectedIncarnation,
              String(row.result.snapshotEntityId),
              { providerSnapshotId: `gw${row.id.replaceAll('-', '')}` }
            );
          row = await this.operations.dispatch(row, 'dispatching');
          dispatchingNow = true;
          const task =
            input.action === 'snapshot_create'
              ? await snapshots.create(live, input.name!, row.id, { includeRam: input.includeRam ?? false })
              : input.action === 'snapshot_delete'
                ? await snapshots.remove(live, selected!)
                : await snapshots.restore(live, selected!);
          row = await this.operations.update(row, {
            phase: 'provisioning',
            providerOperation: task,
            errorCode: null,
            errorMessage: null,
          });
          dispatchingNow = false;
          continue;
        }
        let task = row.providerOperation;
        if (task?.id)
          task = snapshots.operation
            ? await snapshots.operation(task.id, live, input.action)
            : await adapter.operation(task.id, live.remoteId);
        if (task?.resourceId && task.resourceId !== live.remoteId)
          throw new AppError(409, 'HOSTING_SNAPSHOT_TASK_MISMATCH', 'Provider snapshot task belongs to a different VM');
        if (!task?.id && row.dispatchStartedAt && input.action === 'snapshot_delete') {
          const listed = await snapshots.list(live);
          const fresh = await adapter.getResource(target.resource.remoteId);
          if (!fresh || fresh.incarnation !== input.expectedIncarnation)
            throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'Provider VM identity changed');
          if (!listed.some((s) => s.id === input.snapshotId)) {
            await beforeRequest();
            await this.finishWithEntity(row, input, 'ready');
            refreshInventory = true;
            continue;
          }
        }
        if (!task?.id && row.dispatchStartedAt && input.action === 'snapshot_create' && row.result?.snapshotEntityId) {
          const listed = await snapshots.list(live);
          const previousIds = Array.isArray(row.result.beforeSnapshotIds) ? row.result.beforeSnapshotIds : [];
          const marker = `gw${row.id.replaceAll('-', '')}`;
          const candidates = listed.filter(
            (s) =>
              s.ready &&
              (target.connector.provider === 'proxmox'
                ? s.id === marker
                : s.name === input.name && !previousIds.includes(s.id))
          );
          if (candidates.length === 1) {
            await this.finishWithEntity(
              row,
              input,
              'ready',
              { resourceId: target.resource.id },
              undefined,
              candidates[0]
            );
            refreshInventory = true;
            this.connectors.changed(target.connector.id);
            continue;
          }
        }
        if (task?.status === 'failed') {
          await this.finishWithEntity(row, input, 'failed', undefined, {
            code: 'HOSTING_SNAPSHOT_FAILED',
            message: task.error ?? 'Provider snapshot operation failed',
          });
          refreshInventory = true;
          continue;
        }
        if (task?.status === 'succeeded') {
          let createdSnapshot: HostingVmSnapshot | undefined;
          if (input.action === 'snapshot_create' && row.result?.snapshotEntityId) {
            const listed = await snapshots.list(live);
            const previousIds = Array.isArray(row.result.beforeSnapshotIds) ? row.result.beforeSnapshotIds : [];
            const marker = `gw${row.id.replaceAll('-', '')}`;
            const candidates = listed.filter(
              (s) =>
                s.ready &&
                (target.connector.provider === 'proxmox'
                  ? s.id === marker
                  : s.name === input.name && !previousIds.includes(s.id))
            );
            // Do not claim an unrelated snapshot or duplicate a completed provider mutation.
            // Some providers expose the image a little after their task completes.
            if (candidates.length !== 1) continue;
            createdSnapshot = candidates[0];
          }
          await this.db
            .update(hostingResources)
            .set({
              snapshot: withKnownLocation(live, target.resource.snapshot.location),
              observedAt: new Date(live.observedAt),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(hostingResources.id, target.resource.id),
                eq(hostingResources.incarnation, input.expectedIncarnation)
              )
            );
          await this.finishWithEntity(
            row,
            input,
            'ready',
            { snapshotId: input.snapshotId, resourceId: target.resource.id },
            undefined,
            createdSnapshot
          );
          refreshInventory = true;
          this.connectors.changed(target.connector.id);
        } else if (!task?.id) {
          await this.operations.update(row, {
            phase: 'unknown',
            errorCode: 'HOSTING_SNAPSHOT_OUTCOME_UNKNOWN',
            errorMessage:
              'Snapshot operation is not yet confirmed. It will not be repeated automatically; check the provider.',
          });
        }
      } catch (error) {
        if (error instanceof AppError && error.code === 'HOSTING_OPERATION_LEASE_LOST') continue;
        // A definite rejection of this dispatch has no side effect. A later read/poll
        // failure cannot prove that a previously accepted mutation failed.
        const rejected = dispatchingNow && error instanceof HostingProviderError && !error.outcomeUnknown;
        const unknown =
          !rejected && (!!row.dispatchStartedAt || (error instanceof HostingProviderError && error.outcomeUnknown));
        try {
          const details = {
            code: error instanceof AppError ? error.code : 'HOSTING_SNAPSHOT_FAILED',
            message: error instanceof AppError ? error.message : 'Snapshot operation failed',
          };
          if (unknown) {
            row = await this.operations.update(row, {
              phase: 'unknown',
              errorCode: details.code,
              errorMessage: details.message,
            });
            if (row.resourceId && row.result?.snapshotEntityId) {
              const entity = await this.entities.transition(
                row.resourceId,
                String(row.request.expectedIncarnation),
                String(row.result.snapshotEntityId),
                { error: details.message }
              );
              if (entity)
                await this.publishSnapshot(
                  row.resourceId,
                  String(row.request.expectedIncarnation),
                  entity,
                  publicHostingOperation(row)
                );
            }
          } else {
            await this.finishWithEntity(
              row,
              HostingSnapshotInputSchema.parse(row.request),
              'failed',
              undefined,
              details
            );
            refreshInventory = true;
          }
        } catch {
          /* A replacement lease owner reconciles. */
        }
      } finally {
        await this.operations.release(row, row.dispatchStartedAt && !row.providerOperation?.id ? 60000 : 5000);
        // Refresh failures must not change an already terminal provider operation.
        // The read model retains the last good list and records provider read errors;
        // scheduler retries remain available if infrastructure itself is unavailable.
        if (refreshInventory && row.resourceId)
          await this.readModel.refreshAfterOperation(row.resourceId).catch(() => {});
      }
    }
  }
  private async finishWithEntity(
    row: import('./hosting-operations.service.js').HostingOperationRow,
    input: HostingSnapshotInput,
    phase: 'ready' | 'failed',
    result?: Record<string, unknown>,
    error?: { code: string; message: string },
    createdSnapshot?: HostingVmSnapshot
  ) {
    if (!row.resourceId || !row.result?.snapshotEntityId) return this.operations.finish(row, phase, result, error);
    const entityId = String(row.result.snapshotEntityId);
    const status =
      input.action === 'snapshot_create'
        ? phase === 'ready'
          ? 'ready'
          : 'failed'
        : input.action === 'snapshot_delete'
          ? phase === 'ready'
            ? 'deleted'
            : row.result?.failedSnapshotDelete
              ? 'failed'
              : 'ready'
          : 'ready';
    let entity: HostingVmSnapshot | null = null;
    const finished = await this.operations.finish(row, phase, result, error, async (tx) => {
      entity = await new HostingSnapshotEntities(tx as unknown as DrizzleClient).transition(
        row.resourceId!,
        input.expectedIncarnation,
        entityId,
        {
          status,
          error: phase === 'failed' ? (error?.message ?? 'Snapshot operation failed') : null,
          ...(createdSnapshot
            ? {
                providerSnapshotId: createdSnapshot.id,
                fingerprint: createdSnapshot.fingerprint,
                data: createdSnapshot,
              }
            : {}),
          ...(input.action === 'snapshot_create' && phase === 'failed' && !row.providerOperation?.id
            ? { providerSnapshotId: null, fingerprint: null }
            : {}),
        }
      );
      if (!entity) throw new AppError(409, 'HOSTING_SNAPSHOT_CHANGED', 'Snapshot entity disappeared before completion');
    });
    if (entity)
      await this.publishSnapshot(row.resourceId, input.expectedIncarnation, entity, publicHostingOperation(finished));
    return finished;
  }
}
