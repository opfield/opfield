import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  hostingFirewalls,
  hostingNodeBindings,
  hostingOperations,
  hostingResources,
  nodes,
} from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import type { ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import type { User } from '@/types.js';
import type { HostingConnectorsService } from './hosting-connectors.service.js';
import {
  defaultHostingFirewall,
  type HostingFirewallUpdate,
  HostingFirewallUpdateSchema,
  type HostingFirewallView,
} from './hosting-firewall.types.js';
import { assertHostingScope } from './hosting-permissions.js';

export const HOSTING_FIREWALL_SNAPSHOT = 'hosting-firewall';
const ACTIVE = [
  'pending',
  'dispatching',
  'provisioning',
  'configuring',
  'installing',
  'enrolling',
  'awaiting_payment',
  'reconciling',
  'unknown',
] as const;
type Row = typeof hostingFirewalls.$inferSelect;
type Resource = typeof hostingResources.$inferSelect;

function fail(message: string, code = 'HOSTING_FIREWALL_CONFLICT'): never {
  throw new AppError(409, code, message);
}

export class HostingFirewallService {
  private running = false;
  constructor(
    private readonly db: DrizzleClient,
    private readonly connectors: HostingConnectorsService,
    private readonly snapshots: ResourceSnapshotStore,
    private readonly auth: Pick<AuthService, 'getUserById'>,
    private readonly audit: Pick<AuditService, 'log'>
  ) {}

  private async target(resourceId: string, user: User, edit: boolean) {
    const [resource] = await this.db.select().from(hostingResources).where(eq(hostingResources.id, resourceId));
    if (
      !resource?.connectorId ||
      resource.missingSince ||
      resource.origin === 'discovered' ||
      !['digitalocean', 'cloudblast', 'proxmox'].includes(resource.provider)
    )
      fail('This node has no supported managed VM firewall');
    if (!resource.incarnation || resource.incarnation !== resource.snapshot.incarnation)
      fail('VM identity changed; firewall management is disabled');
    const bound = await this.db
      .select({ id: nodes.id, status: nodes.status })
      .from(hostingNodeBindings)
      .innerJoin(nodes, eq(nodes.id, hostingNodeBindings.nodeId))
      .where(eq(hostingNodeBindings.resourceId, resourceId));
    if (!bound.length) fail('The VM is no longer bound to an Opfield node');
    for (const node of bound) {
      assertHostingScope(user.scopes, 'nodes:details', node.id);
      assertHostingScope(user.scopes, edit ? 'nodes:manage' : 'nodes:config:view', node.id);
      if (edit && node.status === 'pending') fail('Wait for node provisioning to finish');
    }
    const connector = await this.connectors.get(resource.connectorId, user, true);
    const settings = this.connectors.settings(connector);
    if (settings.resourceIds.length && !settings.resourceIds.includes(resource.remoteId))
      fail('VM is outside the connector resource scope');
    if (edit) {
      assertHostingScope(user.scopes, 'integrations:hosting:manage', connector.id);
      const [operation] = await this.db
        .select({ id: hostingOperations.id })
        .from(hostingOperations)
        .where(and(eq(hostingOperations.resourceId, resourceId), inArray(hostingOperations.phase, [...ACTIVE])))
        .limit(1);
      if (operation) fail('Wait for the current VM operation to finish');
    }
    return { resource, connector, bound };
  }

  private async forNode(nodeId: string, user: User, edit = false) {
    assertHostingScope(user.scopes, 'nodes:details', nodeId);
    const [binding] = await this.db.select().from(hostingNodeBindings).where(eq(hostingNodeBindings.nodeId, nodeId));
    if (!binding) fail('This node is not bound to a provider VM');
    return this.target(binding.resourceId, user, edit);
  }

  /** Never performs provider IO, including on a cache miss. */
  async get(nodeId: string, user: User): Promise<HostingFirewallView> {
    const { resource, connector, bound } = await this.forNode(nodeId, user);
    const cached = await this.snapshots.get<HostingFirewallView & { connectorRevision: string }>(
      HOSTING_FIREWALL_SNAPSHOT,
      resource.id
    );
    const canEdit =
      bound.every((node) => node.status !== 'pending' && hasScope(user.scopes, `nodes:manage:${node.id}`)) &&
      hasScope(user.scopes, `integrations:hosting:manage:${connector.id}`);
    if (cached?.data.connectorRevision === connector.updatedAt.toISOString()) {
      const { connectorRevision: _, ...view } = cached.data;
      return { ...view, canEdit };
    }
    return {
      resourceId: resource.id,
      revision: 0,
      config: defaultHostingFirewall(),
      status: 'loading',
      observation: null,
      error: null,
      canEdit,
    };
  }

  private async publish(resource: Resource, row: Row) {
    await this.snapshots.replace(HOSTING_FIREWALL_SNAPSHOT, resource.id, {
      resourceId: resource.id,
      revision: row.revision,
      config: row.config,
      status: row.status,
      observation: row.observation,
      error: row.error,
      canEdit: false,
      connectorRevision: row.connectorRevision,
    });
    if (resource.connectorId) this.connectors.changed(resource.connectorId);
  }

  async update(nodeId: string, raw: HostingFirewallUpdate, user: User): Promise<HostingFirewallView> {
    const input = HostingFirewallUpdateSchema.parse(raw);
    const { resource } = await this.forNode(nodeId, user, true);
    if (input.config.enabled && !input.acknowledgeConnectivityRisk)
      fail('Confirm that applying these rules may interrupt new connections');
    await this.db.transaction(async (tx) => {
      const lock = await tx.execute<{ acquired: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${`hosting-firewall:${resource.id}`})) AS acquired`
      );
      if (!lock.rows[0]?.acquired) fail('Firewall is synchronizing; try again shortly');
      const currentTarget = await this.forNode(nodeId, user, true);
      if (currentTarget.resource.id !== resource.id) fail('Node binding changed');
      const [current] = await tx
        .select()
        .from(hostingFirewalls)
        .where(eq(hostingFirewalls.resourceId, resource.id))
        .for('update');
      if (!current?.observation || current.connectorRevision !== currentTarget.connector.updatedAt.toISOString())
        fail('Wait for the first firewall snapshot');
      if (current.status === 'pending' || current.status === 'applying') fail('Firewall changes are already applying');
      if (current.revision !== input.expectedRevision || current.observation.fingerprint !== input.expectedFingerprint)
        fail('Firewall changed; review the latest rules before saving');
      if (current.observation.applying) fail('Wait for provider firewall changes to finish');
      const blockers = input.config.enabled
        ? current.observation.blockers
        : (current.observation.disableBlockers ?? current.observation.blockers);
      if (blockers.length) fail(blockers.join('; '));
      await tx
        .update(hostingFirewalls)
        .set({
          config: input.config,
          revision: current.revision + 1,
          status: 'pending',
          expectedFingerprint: input.expectedFingerprint,
          actorId: user.id,
          error: null,
          dispatchedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(hostingFirewalls.resourceId, resource.id));
    });
    await this.audit.log({
      userId: user.id,
      action: 'hosting.firewall.update',
      resourceType: 'node',
      resourceId: nodeId,
      details: { resourceId: resource.id, enabled: input.config.enabled, ruleCount: input.config.rules.length },
    });
    // Do not let a late request handler replace the worker's newer ready snapshot with pending.
    await this.db.transaction(async (tx) => {
      const lock = await tx.execute<{ acquired: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${`hosting-firewall:${resource.id}`})) AS acquired`
      );
      if (!lock.rows[0]?.acquired) return; // The current worker owns the next snapshot/event.
      const [row] = await this.db.select().from(hostingFirewalls).where(eq(hostingFirewalls.resourceId, resource.id));
      if (row) await this.publish(resource, row);
    });
    const view = await this.get(nodeId, user);
    if (view.revision <= input.expectedRevision) {
      return { ...view, revision: input.expectedRevision + 1, config: input.config, status: 'pending', error: null };
    }
    return view;
  }

  /** Refresh bound resources only; a lost/ambiguous dispatch is observed, never automatically repeated. */
  async reconcileDue() {
    if (this.running) return;
    this.running = true;
    try {
      const resources = await this.db
        .selectDistinct({ resource: hostingResources })
        .from(hostingResources)
        .leftJoin(hostingNodeBindings, eq(hostingNodeBindings.resourceId, hostingResources.id))
        .leftJoin(hostingFirewalls, eq(hostingFirewalls.resourceId, hostingResources.id))
        .where(
          and(
            inArray(hostingResources.provider, ['digitalocean', 'cloudblast', 'proxmox']),
            or(
              and(isNotNull(hostingNodeBindings.nodeId), isNull(hostingResources.missingSince)),
              inArray(hostingFirewalls.status, ['pending', 'applying'])
            )
          )
        );
      for (const { resource } of resources) {
        try {
          await this.reconcile(resource);
        } catch {
          /* Isolate one revoked/unreachable connector from other nodes. */
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async reconcile(resource: Resource) {
    await this.db.transaction(async (tx) => {
      const lock = await tx.execute<{ acquired: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${`hosting-firewall:${resource.id}`})) AS acquired`
      );
      if (!lock.rows[0]?.acquired) return;
      await this.db
        .insert(hostingFirewalls)
        .values({ resourceId: resource.id, config: defaultHostingFirewall(), connectorRevision: '' })
        .onConflictDoNothing();
      let [row] = await this.db.select().from(hostingFirewalls).where(eq(hostingFirewalls.resourceId, resource.id));
      if (!row) return;
      const active = row.status === 'pending' || row.status === 'applying';
      const accepted = row;
      let revision = row.connectorRevision;
      try {
        if (!resource.connectorId) fail('Hosting connector was removed; firewall changes were not completed');
        const connector = await this.connectors.get(resource.connectorId, undefined, true);
        revision = connector.updatedAt.toISOString();
        if (
          !active &&
          row.connectorRevision === revision &&
          row.observedAt &&
          Date.now() - row.observedAt.getTime() < 60_000
        )
          return;
        if (active && !accepted.actorId) fail('Firewall actor no longer exists');
        const actor = active ? await this.auth.getUserById(accepted.actorId!) : await this.connectors.owner(connector);
        if (!actor || actor.isBlocked || actor.isDeleted) fail('Firewall actor access was revoked');
        const fence = async () => {
          const freshActor = await this.auth.getUserById(actor.id);
          if (!freshActor || freshActor.isBlocked || freshActor.isDeleted) fail('Firewall actor access was revoked');
          const target = await this.target(resource.id, freshActor, active);
          if (
            target.connector.updatedAt.toISOString() !== revision ||
            target.resource.incarnation !== resource.incarnation
          )
            fail('VM or connector changed during firewall synchronization');
          if (active && accepted.connectorRevision !== revision)
            fail('Connector changed after firewall changes were accepted');
        };
        await fence();
        const adapter = this.connectors.adapter(connector, fence);
        if (!adapter.firewall) fail('Provider firewall is unavailable');
        const live = await adapter.getResource(resource.remoteId);
        if (!live || live.incarnation !== resource.incarnation) fail('Provider VM identity changed');
        let observation = await adapter.firewall.read(live, resource.id, row.config);
        if (row.status === 'pending' && !row.dispatchedAt) {
          if (observation.fingerprint !== row.expectedFingerprint)
            fail('Provider firewall changed before applying; review the current state');
          // Saving an unchanged disabled policy is local-only. No remote mutation or prerequisites needed.
          if (!observation.matches) {
            await this.db
              .update(hostingFirewalls)
              .set({ status: 'applying', dispatchedAt: new Date() })
              .where(eq(hostingFirewalls.resourceId, resource.id));
            row = { ...row, status: 'applying', dispatchedAt: new Date() };
            await this.publish(resource, row);
            await adapter.firewall.apply(live, resource.id, row.config, observation);
            observation = await adapter.firewall.read(live, resource.id, row.config);
          }
        }
        const matches = observation.matches && !observation.applying;
        const timedOut = active && Date.now() - (row.dispatchedAt ?? row.updatedAt).getTime() > 10 * 60_000;
        const status = active
          ? matches
            ? 'ready'
            : timedOut
              ? 'failed'
              : 'applying'
          : row.revision > 0 && !matches
            ? 'failed'
            : 'ready';
        const error =
          !matches && status === 'failed'
            ? (row.error ?? 'Firewall application was not confirmed. Review the provider state before saving again.')
            : null;
        const [saved] = await this.db
          .update(hostingFirewalls)
          .set({ observation, status, error, connectorRevision: revision, observedAt: new Date() })
          .where(eq(hostingFirewalls.resourceId, resource.id))
          .returning();
        await this.publish(resource, saved!);
      } catch (error) {
        const [saved] = await this.db
          .update(hostingFirewalls)
          .set({
            status: 'failed',
            error: error instanceof AppError ? error.message : 'Firewall synchronization failed',
            observedAt: new Date(),
            connectorRevision: revision,
          })
          .where(eq(hostingFirewalls.resourceId, resource.id))
          .returning();
        await this.publish(resource, saved!);
      }
    });
  }
}
