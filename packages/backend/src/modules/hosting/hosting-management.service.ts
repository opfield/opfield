import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { hostingFirewalls, hostingNodeBindings, hostingResources, nodes } from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import type { NodesService } from '@/modules/nodes/nodes.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import type { User } from '@/types.js';
import { type HostingActionInput, HostingActionSchema } from './hosting.schemas.js';
import { shellArgument } from './hosting-bootstrap.js';
import type { HostingConnectorsService } from './hosting-connectors.service.js';
import { compareHostingDecimal } from './hosting-decimal.js';
import { lockHostingDeletion, unenrolledHostingNodeIds } from './hosting-deletion-guard.js';
import { HostingProviderError } from './hosting-http.js';
import { withKnownLocation } from './hosting-location.js';
import { type HostingOperationsService, publicHostingOperation } from './hosting-operations.service.js';
import { assertHostingResourceAction } from './hosting-permissions.js';
import type { HostingAction, HostingProviderAdapter, HostingResourceSnapshot } from './hosting-provider.types.js';
import { isHostedNodeReady } from './hosting-readiness.js';
import { HostingSnapshotsService } from './hosting-snapshots.service.js';
import { reserveProxmoxQuota } from './proxmox-quota.js';

const SERVICES: Record<string, string> = {
  nginx: 'nginx-daemon',
  docker: 'docker-daemon',
  builder: 'docker-daemon',
  databases: 'docker-daemon',
  storage: 'docker-daemon',
  monitoring: 'monitoring-daemon',
  relay: 'opfield-relay-supervisor',
};

// legacy-name: gateway-relay-supervisor unit — a relay installed before 2.12.1 keeps running under it until its next
// start. The new unit refuses to start while the old one is enabled, and a moved relay keeps the old unit file, disabled,
// until its cleanup; remove once every relay reports none.
const LEGACY_SERVICES: Record<string, string> = { 'opfield-relay-supervisor': 'gateway-relay-supervisor' };
export function hostingRecoveryScript(roles: string[]): string {
  const services = [...new Set(roles.map((role) => SERVICES[role]))];
  if (!services.length || services.some((service) => !service))
    throw new AppError(
      409,
      'HOSTING_RECOVERY_UNSUPPORTED',
      'No known service restart is available for these node roles'
    );
  const candidates = services.map((service) => [LEGACY_SERVICES[service as string], service].filter(Boolean).join(':'));
  return `#!/bin/bash
set -eu
unit_exists() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl cat "$1" >/dev/null 2>&1
  else
    [ -e "/etc/init.d/$1" ]
  fi
}
# The old unit still owns the host while it runs or is enabled: the new unit's guard refuses to start then.
unit_in_charge() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl is-active --quiet "$1" || systemctl is-enabled --quiet "$1"
  else
    rc-service "$1" status >/dev/null 2>&1 || ls /etc/runlevels/*/"$1" >/dev/null 2>&1
  fi
}
for names in ${candidates.map(shellArgument).join(' ')}; do
  service=\${names##*:}
  legacy=\${names%%:*}
  if [ "$legacy" != "$service" ] && unit_exists "$legacy" && { unit_in_charge "$legacy" || ! unit_exists "$service"; }; then
    service=$legacy
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart "$service"
  elif command -v rc-service >/dev/null 2>&1; then
    rc-service "$service" restart
  else
    echo 'No supported service manager; refusing VM reboot or reinstall' >&2
    exit 1
  fi
done
`;
}

export function hostingActionFinished(
  action: HostingAction,
  resource: HostingResourceSnapshot | null,
  size?: string
): boolean {
  if (action === 'delete') return resource === null;
  if (!resource) return false;
  if (action === 'start') return resource.powerState === 'running';
  if (action === 'shutdown') return resource.powerState === 'stopped';
  if (action === 'resize') return !!size && resource.sizeId === size;
  // Running VM does not prove reboot or daemon recovery happened.
  return false;
}

export function proxmoxResizeFinished(resource: HostingResourceSnapshot, input: HostingActionInput): boolean {
  return (
    [input.cpu, input.memoryMb, input.diskGb].some((v) => v !== undefined) &&
    (input.cpu === undefined || resource.cpu === input.cpu) &&
    (input.memoryMb === undefined || resource.memoryMb === input.memoryMb) &&
    (input.diskGb === undefined || resource.diskGb === input.diskGb)
  );
}

export class HostingManagementService {
  private snapshotService?: HostingSnapshotsService;
  get snapshots() {
    return (this.snapshotService ??= new HostingSnapshotsService(
      this.db,
      this.connectors,
      this.operations,
      this.auth,
      this.audit,
      this.snapshotStore,
      this.events
    ));
  }
  constructor(
    private readonly db: DrizzleClient,
    private readonly connectors: HostingConnectorsService,
    private readonly operations: HostingOperationsService,
    private readonly auth: Pick<AuthService, 'getUserById'>,
    private readonly dispatch: Pick<NodeDispatchService, 'isNodeConnected'>,
    private readonly audit: Pick<AuditService, 'log'>,
    private readonly nodeService: Pick<NodesService, 'remove'>,
    private readonly snapshotStore?: ResourceSnapshotStore,
    private readonly events?: EventBusService
  ) {}

  private async validateResize(
    adapter: HostingProviderAdapter,
    resource: HostingResourceSnapshot,
    input: HostingActionInput
  ) {
    if (input.action !== 'resize') return;
    if (input.diskGb !== undefined && (resource.diskGb === null || input.diskGb < resource.diskGb))
      throw new AppError(400, 'HOSTING_DISK_SHRINK_UNSUPPORTED', 'Shrinking disks is not supported');
    if (adapter.provider === 'proxmox') {
      if (!input.cpu && !input.memoryMb && !input.diskGb)
        throw new AppError(400, 'HOSTING_RESIZE_RESOURCES_REQUIRED', 'Select CPU, memory or disk resources to change');
      return;
    }
    const size = (await adapter.catalog()).sizes.find((option) => option.id === input.size);
    if (!size || (size.locations?.length && !size.locations.includes(resource.location)))
      throw new AppError(409, 'HOSTING_SIZE_UNAVAILABLE', 'This size is not available in the VM location');
    const price = size.locationPrices?.[resource.location] ?? size.price;
    if (
      !price ||
      !input.confirmedPrice ||
      price.currency !== input.confirmedPrice.currency ||
      compareHostingDecimal(price.amount, input.confirmedPrice.amount) !== 0
    )
      throw new AppError(409, 'HOSTING_PRICE_CHANGED', 'Review the current resize price before confirming');
  }

  private async resource(id: string, user: User, action: HostingAction, allowMissing = false) {
    const [resource] = await this.db.select().from(hostingResources).where(eq(hostingResources.id, id));
    if (!resource?.connectorId || resource.origin === 'discovered' || (resource.missingSince && !allowMissing))
      throw new AppError(
        409,
        'HOSTING_RESOURCE_UNMANAGED',
        'Only a created or automatically adopted VM can be managed'
      );
    const bound = await this.db
      .select({
        nodeId: nodes.id,
        type: nodes.type,
        name: nodes.displayName,
        hostname: nodes.hostname,
        status: nodes.status,
        lastHealthReport: nodes.lastHealthReport,
        capabilities: nodes.capabilities,
      })
      .from(hostingNodeBindings)
      .innerJoin(nodes, eq(nodes.id, hostingNodeBindings.nodeId))
      .where(eq(hostingNodeBindings.resourceId, id));
    assertHostingResourceAction(
      user.scopes,
      id,
      action,
      bound.map((binding) => binding.nodeId)
    );
    const connector = await this.connectors.get(resource.connectorId, user, true);
    return { resource, bound, connector };
  }

  async action(id: string, input: HostingActionInput, user: User) {
    const { resource, connector, bound } = await this.resource(id, user, input.action, input.action === 'delete');
    if (
      !resource.incarnation ||
      resource.incarnation !== input.expectedIncarnation ||
      resource.snapshot.incarnation !== resource.incarnation
    )
      throw new AppError(
        409,
        'HOSTING_RESOURCE_IDENTITY_CONFLICT',
        'The provider VM identity changed; management is disabled'
      );
    if (!resource.snapshot.capabilities[input.action].available)
      throw new AppError(
        409,
        'HOSTING_ACTION_UNSUPPORTED',
        resource.snapshot.capabilities[input.action].reason ?? 'Provider operation is unavailable'
      );
    const replay = await this.operations.findIntent({
      connectorId: connector.id,
      actorId: user.id,
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      request: { ...input },
    });
    if (replay) return this.operations.get(replay.id, user);
    await this.validateResize(this.connectors.adapter(connector), resource.snapshot, input);
    const reserved = await this.operations.reserve(
      {
        connectorId: connector.id,
        resourceId: resource.id,
        actorId: user.id,
        action: input.action,
        idempotencyKey: input.idempotencyKey,
        request: { ...input },
      },
      async (tx) => {
        if (connector.provider === 'proxmox' && input.action === 'resize') {
          const [current] = await tx
            .select()
            .from(hostingResources)
            .where(eq(hostingResources.id, resource.id))
            .for('update');
          if (!current || current.missingSince || current.incarnation !== input.expectedIncarnation)
            throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'The resize target changed');
          await reserveProxmoxQuota(
            tx,
            connector.id,
            {
              cpu: input.cpu ?? current.snapshot.cpu,
              memoryMb: input.memoryMb ?? current.snapshot.memoryMb,
              diskGb: input.diskGb ?? current.snapshot.diskGb,
            },
            resource.id
          );
        }
        if (input.action !== 'delete') return {};
        // Nodes of a failed installation never enrolled; remove them with the VM when the actor may.
        const unenrolled = (await unenrolledHostingNodeIds(tx, resource.id)).filter(
          (nodeId) =>
            !bound.some((binding) => binding.nodeId === nodeId) &&
            hasScope(user.scopes, `nodes:details:${nodeId}`) &&
            hasScope(user.scopes, `nodes:delete:${nodeId}`)
        );
        return {
          result: {
            destroyNodeIds: [...bound.map((binding) => binding.nodeId), ...unenrolled],
            ...(unenrolled.length ? { destroyUnenrolledNodeIds: unenrolled } : {}),
          },
        };
      }
    );
    if (reserved.created)
      await this.audit.log({
        userId: user.id,
        action: `hosting.vm.${input.action}.requested`,
        resourceType: 'hosting-resource',
        resourceId: id,
        details: { operationId: reserved.operation.id },
      });
    this.connectors.changed(connector.id);
    return publicHostingOperation(reserved.operation);
  }

  async reconcileDue() {
    await this.snapshots.reconcileDue();
    const actions = new Set(['start', 'shutdown', 'reboot', 'resize', 'delete', 'recover']);
    for (const due of await this.operations.due()) {
      if (!actions.has(due.action)) continue;
      const leased = await this.operations.claim(due.id);
      if (!leased) continue;
      let row = leased;
      let mutationAttempted = false;
      try {
        const actor = row.actorId ? await this.auth.getUserById(row.actorId) : null;
        if (!actor || actor.isBlocked || actor.isDeleted)
          throw new AppError(403, 'HOSTING_ACTOR_REVOKED', 'VM operation owner no longer has access');
        if (!row.resourceId) throw new AppError(409, 'HOSTING_RESOURCE_MISSING', 'Operation resource is missing');
        const input = HostingActionSchema.parse(row.request);
        const { resource, bound, connector } = await this.resource(
          row.resourceId,
          actor,
          input.action,
          input.action === 'delete'
        );
        // Absence is meaningful only for the exact identity the user asked to destroy.
        if (
          input.action === 'delete' &&
          (!resource.incarnation ||
            resource.incarnation !== input.expectedIncarnation ||
            resource.snapshot.incarnation !== resource.incarnation)
        )
          throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'The provider VM identity changed');
        const claimed = row;
        const adapter = this.connectors.adapter(connector, () => this.operations.renew(claimed));
        const live = await adapter.getResource(resource.remoteId);
        if (!live) {
          if (input.action === 'delete') {
            // Some providers use the same HTTP 404 for a missing VM and a bad route.
            // A successful complete inventory from the unchanged account is required too.
            const settings = this.connectors.settings(connector);
            const account = await adapter.test();
            if (account.authority !== (settings.proxmoxAllocationAuthority ?? settings.authority))
              throw new AppError(409, 'HOSTING_ACCOUNT_CHANGED', 'Provider account identity changed');
            const inventory = await adapter.listResources();
            if (
              !inventory.complete ||
              inventory.resources.some((vm) => vm.remoteId === resource.remoteId && vm.kind === resource.kind)
            )
              throw new AppError(
                409,
                'HOSTING_ABSENCE_UNCONFIRMED',
                'VM absence was not confirmed by complete provider inventory'
              );
            const currentActor = row.actorId ? await this.auth.getUserById(row.actorId) : null;
            if (!currentActor || currentActor.isBlocked || currentActor.isDeleted)
              throw new AppError(403, 'HOSTING_ACTOR_REVOKED', 'VM operation owner no longer has access');
            const current = await this.resource(resource.id, currentActor, 'delete', true);
            if (
              current.resource.connectorId !== resource.connectorId ||
              current.resource.remoteId !== resource.remoteId ||
              current.resource.incarnation !== input.expectedIncarnation ||
              current.resource.snapshot.incarnation !== input.expectedIncarnation
            )
              throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'The deletion target changed');
            const nodeIds = Array.isArray(row.result?.destroyNodeIds)
              ? row.result.destroyNodeIds.filter((id): id is string => typeof id === 'string')
              : bound.map((binding) => binding.nodeId);
            assertHostingResourceAction(currentActor.scopes, resource.id, 'delete', nodeIds);
            if (adapter.firewall?.cleanup) {
              const cleanup = row.result?.firewallCleanup as
                | { status: string; remoteId: string | null; reason?: string }
                | undefined;
              if (!cleanup || cleanup.status === 'dispatching') {
                const [firewall] = await this.db
                  .select()
                  .from(hostingFirewalls)
                  .where(eq(hostingFirewalls.resourceId, resource.id));
                if (cleanup || (firewall && (firewall.revision > 0 || firewall.observation?.remoteId))) {
                  try {
                    const result = await adapter.firewall.cleanup(
                      { ...resource.snapshot, remoteId: resource.remoteId },
                      resource.id,
                      cleanup?.remoteId ?? firewall?.observation?.remoteId ?? null,
                      cleanup?.status === 'dispatching',
                      async (remoteId) => {
                        await this.db.transaction(async (tx) => {
                          const target = { operation: { ...row }, connector, resource, nodeIds };
                          if (!current.bound.length) await lockHostingDeletion(tx, target);
                          for (const binding of current.bound) await lockHostingDeletion(tx, target, binding.nodeId);
                        });
                        row = await this.operations.update(row, {
                          result: { ...row.result, firewallCleanup: { status: 'dispatching', remoteId } },
                        });
                        if (!row.dispatchStartedAt) row = await this.operations.dispatch(row, 'dispatching');
                      }
                    );
                    row = await this.operations.update(row, { result: { ...row.result, firewallCleanup: result } });
                  } catch (error) {
                    if (error instanceof AppError && error.code === 'HOSTING_OPERATION_LEASE_LOST') throw error;
                    throw new AppError(
                      409,
                      'HOSTING_FIREWALL_CLEANUP_PENDING',
                      `VM deleted; firewall cleanup needs reconciliation: ${error instanceof Error ? error.message : 'provider confirmation unavailable'}`
                    );
                  }
                }
              }
            }
            const target = { operation: { ...row }, connector, resource, nodeIds };
            const unenrolled = Array.isArray(row.result?.destroyUnenrolledNodeIds)
              ? row.result.destroyUnenrolledNodeIds.filter((id): id is string => typeof id === 'string')
              : [];
            for (const nodeId of nodeIds) {
              if (!current.bound.some((binding) => binding.nodeId === nodeId) && unenrolled.includes(nodeId)) {
                const [node] = await this.db
                  .select({
                    status: nodes.status,
                    certificateFingerprint: nodes.certificateFingerprint,
                    hostIdentityId: nodes.hostIdentityId,
                  })
                  .from(nodes)
                  .where(eq(nodes.id, nodeId));
                // Already removed, or it enrolled after all: then it is no longer a leftover of this VM.
                if (!node || node.status !== 'pending' || node.certificateFingerprint || node.hostIdentityId) continue;
                try {
                  await this.nodeService.remove(nodeId, currentActor.id, {
                    hostingDelete: {
                      operationId: row.id,
                      guard: (tx) => lockHostingDeletion(tx, target, nodeId, true),
                    },
                  });
                } catch (error) {
                  if (!(error instanceof AppError && error.code === 'NOT_FOUND')) throw error;
                }
                continue;
              }
              if (!current.bound.some((binding) => binding.nodeId === nodeId)) {
                const [existing] = await this.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId));
                if (existing)
                  throw new AppError(
                    409,
                    'HOSTING_NODE_BINDING_CHANGED',
                    'A node binding changed during destruction; refusing to remove the detached node'
                  );
                continue;
              }
              try {
                await this.nodeService.remove(nodeId, currentActor.id, {
                  hostingDelete: { operationId: row.id, guard: (tx) => lockHostingDeletion(tx, target, nodeId) },
                });
              } catch (error) {
                if (!(error instanceof AppError && error.code === 'NOT_FOUND')) throw error;
              }
            }
            await this.db.transaction(async (tx) => {
              await lockHostingDeletion(tx, target);
              await tx
                .update(hostingResources)
                .set({ missingSince: new Date() })
                .where(eq(hostingResources.id, resource.id));
            });
            await this.operations.finish(row, 'ready', {
              ...row.result,
              resourceId: resource.id,
              providerDeleted: true,
              deletedIncarnation: input.expectedIncarnation,
            });
            continue;
          }
          throw new AppError(409, 'HOSTING_RESOURCE_MISSING', 'The provider resource is missing');
        }
        if (
          !live.incarnation ||
          live.incarnation !== input.expectedIncarnation ||
          resource.incarnation !== live.incarnation
        )
          throw new AppError(
            409,
            'HOSTING_RESOURCE_IDENTITY_CONFLICT',
            'Provider VM identity changed; no action was sent'
          );
        // Stop is its own durable stage. A lost shutdown response can be resolved
        // from the observed stopped VM, but a destroy is never repeated blindly.
        if (input.action === 'delete' && row.result?.destroyStage === 'stopping') {
          if (row.providerOperation?.id) {
            const stop = await adapter.operation(row.providerOperation.id, resource.remoteId);
            if (stop.status === 'failed') {
              await this.operations.finish(row, 'failed', undefined, {
                code: 'HOSTING_STOP_FAILED',
                message: stop.error ?? 'VM shutdown failed; nothing was deleted',
              });
              continue;
            }
            if (stop.status !== 'succeeded') continue;
          }
          if (live.powerState !== 'stopped') continue;
          row = await this.operations.update(row, {
            phase: 'pending',
            dispatchStartedAt: null,
            providerOperation: null,
            errorCode: null,
            errorMessage: null,
            result: { ...row.result, destroyStage: 'deleting' },
          });
          continue;
        }
        const proxmoxResize = connector.provider === 'proxmox' && input.action === 'resize';
        const resizeProgress = () => ({
          stage: typeof row.result?.resizeStage === 'string' ? row.result.resizeStage : undefined,
          checkpoint: async (stage: string) => {
            row = await this.operations.update(row, { result: { ...row.result, resizeStage: stage } });
          },
        });
        if (proxmoxResize && row.dispatchStartedAt && !row.providerOperation?.id) {
          if (proxmoxResizeFinished(live, input)) {
            await this.db
              .update(hostingResources)
              .set({
                snapshot: withKnownLocation(live, resource.snapshot.location),
                observedAt: new Date(live.observedAt),
                updatedAt: new Date(),
              })
              .where(eq(hostingResources.id, resource.id));
            await this.operations.finish(row, 'ready', { resourceId: resource.id });
            continue;
          }
          if (['not_started', 'config_dispatching', 'config_applied'].includes(String(row.result?.resizeStage))) {
            // CPU/RAM PUTs are absolute and idempotent. Disk dispatch has its own
            // durable boundary and is never replayed after an uncertain response.
            const task = await adapter.action(live, input, resizeProgress());
            row = await this.operations.update(row, { phase: 'provisioning', providerOperation: task });
            continue;
          }
        }
        if (row.phase === 'pending') {
          await this.validateResize(adapter, live, input);
          if (input.action === 'resize') {
            if (live.powerState !== 'stopped')
              throw new AppError(409, 'HOSTING_VM_MUST_STOP', 'Shut down the VM before resizing');
            if (input.diskGb !== undefined && (live.diskGb === null || input.diskGb < live.diskGb))
              throw new AppError(400, 'HOSTING_DISK_SHRINK_UNSUPPORTED', 'Shrinking disks is not supported');
            if (proxmoxResize)
              row = await this.operations.update(row, { result: { ...row.result, resizeStage: 'not_started' } });
          }
          if (input.action === 'recover') {
            if (!adapter.bootstrap || !live.capabilities.recover.available)
              throw new AppError(
                409,
                'HOSTING_RECOVERY_UNAVAILABLE',
                'No independent daemon recovery channel is available'
              );
            if (live.powerState !== 'running')
              throw new AppError(409, 'HOSTING_VM_STOPPED', 'Start the VM before restarting its daemon');
            if (!bound.length)
              throw new AppError(409, 'HOSTING_NODE_BINDING_REQUIRED', 'No Opfield node is associated with this VM');
            row = await this.operations.update(row, {
              result: {
                ...row.result,
                recoveryHealthBefore: Object.fromEntries(
                  bound.map((binding) => [binding.nodeId, binding.lastHealthReport?.timestamp ?? null])
                ),
              },
            });
          }
          if (input.action === 'delete') {
            const stopping = connector.provider === 'proxmox' && live.powerState !== 'stopped';
            if (stopping && !live.capabilities.shutdown.available)
              throw new AppError(
                403,
                'HOSTING_STOP_UNAVAILABLE',
                live.capabilities.shutdown.reason ?? 'VM shutdown permission is required before destruction'
              );
            row = await this.operations.update(row, {
              result: {
                ...row.result,
                destroyNodeIds: row.result?.destroyNodeIds ?? bound.map((binding) => binding.nodeId),
                destroyStage: stopping ? 'stopping' : 'deleting',
              },
            });
            row = await this.operations.dispatch(row, 'dispatching');
            mutationAttempted = true;
            let task: Awaited<ReturnType<HostingProviderAdapter['action']>>;
            try {
              task = await adapter.action(live, stopping ? { action: 'shutdown' } : input);
            } catch (error) {
              // A racing external deletion may reject shutdown/delete. A 404 alone is
              // not proof: independently read the VM, then use the normal cleanup pass
              // with fresh actor, incarnation and node-binding checks. Never resend delete.
              if (
                !(error instanceof HostingProviderError) ||
                error.outcomeUnknown ||
                error.providerStatus !== 404 ||
                (await adapter.getResource(resource.remoteId)) !== null
              )
                throw error;
              row = await this.operations.update(row, { phase: 'provisioning', providerOperation: null });
              continue;
            }
            row = await this.operations.update(row, { phase: 'provisioning', providerOperation: task });
            continue;
          }
          row = await this.operations.dispatch(row, 'dispatching');
          mutationAttempted = true;
          const task =
            input.action === 'recover'
              ? await adapter.bootstrap!(live, hostingRecoveryScript(bound.map((binding) => binding.type)))
              : await adapter.action(live, input, proxmoxResize ? resizeProgress() : undefined);
          row = await this.operations.update(row, { phase: 'provisioning', providerOperation: task });
          continue;
        }
        let taskSucceeded = row.providerOperation?.status === 'succeeded';
        if (row.providerOperation?.id && !taskSucceeded) {
          const task = await adapter.operation(row.providerOperation.id, resource.remoteId);
          if (task.status === 'failed') {
            await this.operations.finish(row, 'failed', undefined, {
              code: 'HOSTING_PROVIDER_TASK_FAILED',
              message: task.error ?? 'Provider operation failed',
            });
            continue;
          }
          taskSucceeded = task.status === 'succeeded';
          if (taskSucceeded) {
            // QGA exec-status forgets an exited process after returning its result.
            // Persist that one-shot receipt before waiting for fresh Opfield health.
            row = await this.operations.update(row, { providerOperation: task });
          }
        }
        const recoveryHealthBefore = row.result?.recoveryHealthBefore as Record<string, number | null> | undefined;
        const recoveryReady =
          input.action === 'recover' &&
          taskSucceeded &&
          bound.length > 0 &&
          bound.every((binding) => {
            return (
              isHostedNodeReady(binding, this.dispatch.isNodeConnected(binding.nodeId)) &&
              !!binding.lastHealthReport &&
              !!recoveryHealthBefore &&
              binding.lastHealthReport.timestamp !== recoveryHealthBefore[binding.nodeId]
            );
          });
        if (
          recoveryReady ||
          (input.action !== 'recover' && input.action !== 'delete' && !proxmoxResize && taskSucceeded) ||
          hostingActionFinished(input.action, live, input.size)
        ) {
          await this.db
            .update(hostingResources)
            .set({
              snapshot: withKnownLocation(live, resource.snapshot.location),
              observedAt: new Date(live.observedAt),
              updatedAt: new Date(),
            })
            .where(eq(hostingResources.id, resource.id));
          await this.operations.finish(row, 'ready', { resourceId: resource.id });
        } else if (!row.providerOperation?.id && !taskSucceeded) {
          await this.operations.update(row, {
            phase: 'unknown',
            errorCode: row.errorCode ?? 'HOSTING_ACTION_OUTCOME_UNKNOWN',
            errorMessage:
              row.errorMessage ?? 'Waiting for provider confirmation. The action will not be repeated automatically.',
          });
        }
      } catch (error) {
        if (error instanceof AppError && error.code === 'HOSTING_OPERATION_LEASE_LOST') continue;
        try {
          if (error instanceof AppError && error.code === 'HOSTING_RESOURCE_OBSERVATION_CHANGED') {
            // Keep the dispatch boundary intact. The next pass must obtain fresh provider evidence.
            row = await this.operations.update(row, { errorCode: error.code, errorMessage: error.message });
            continue;
          }
          if (error instanceof AppError && error.code === 'HOSTING_FIREWALL_CLEANUP_PENDING') {
            await this.operations.update(row, { phase: 'unknown', errorCode: error.code, errorMessage: error.message });
            continue;
          }
          const rejectedBeforeWrite =
            error instanceof AppError &&
            [
              'HOSTING_VM_MUST_STOP',
              'HOSTING_DISK_SHRINK_UNSUPPORTED',
              'HOSTING_STOP_UNAVAILABLE',
              'HOSTING_RESIZE_REJECTED',
            ].includes(error.code);
          const rejectedByProvider =
            mutationAttempted &&
            ['delete', 'start', 'shutdown', 'reboot'].includes(row.action) &&
            error instanceof HostingProviderError &&
            !error.outcomeUnknown &&
            [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(error.providerStatus);
          if (
            !rejectedBeforeWrite &&
            !rejectedByProvider &&
            (row.dispatchStartedAt || (error instanceof HostingProviderError && error.outcomeUnknown))
          )
            await this.operations.update(row, {
              phase: 'unknown',
              errorCode: error instanceof AppError ? error.code : 'HOSTING_ACTION_FAILED',
              errorMessage: error instanceof AppError ? error.message : 'VM operation needs reconciliation',
            });
          else
            await this.operations.finish(row, 'failed', undefined, {
              code: error instanceof AppError ? error.code : 'HOSTING_ACTION_FAILED',
              message: error instanceof AppError ? error.message : 'VM operation failed',
            });
        } catch {
          /* Current operation owner is responsible for reconciliation. */
        }
      } finally {
        await this.operations.release(row, row.phase === 'unknown' ? 60_000 : 5000);
      }
    }
  }
}
