import { and, eq, sql } from 'drizzle-orm';
import { domains, ingressGroupMembers, ingressGroups, proxyHosts } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertGroupRoutesAllowNode } from '@/modules/apps/app-placement-guard.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import { rethrowProxyHostDomainConflict } from '@/modules/proxy/proxy-domain-overlap.js';
import { ingressGroupLockKey, proxyNodeLockKey, withProxyLocks } from '@/modules/proxy/proxy-host-lock.js';
import type {
  AddIngressGroupMemberInput,
  CreateIngressGroupInput,
  RemoveIngressGroupMemberInput,
  UpdateIngressGroupInput,
} from './ingress-group.schemas.js';
import { IngressGroupServiceBase } from './ingress-group.service.base.js';
import type { IngressGroupView } from './ingress-group-views.js';
import { ingressGroupMemberRows } from './ingress-nodes.js';

export type { IngressGroupServiceDeps } from './ingress-group.service.base.js';

const logger = createChildLogger('IngressGroupService');
const GROUP_SLUG_CONSTRAINT = 'ingress_groups_slug_unique';

/** Creating, changing and deleting ingress groups and their membership (reads and shared helpers in the base). */
export class IngressGroupService extends IngressGroupServiceBase {
  async create(input: CreateIngressGroupInput, userId: string): Promise<IngressGroupView> {
    for (const nodeId of input.nodeIds) await this.requireMemberCandidate(nodeId);
    const group = await writeWithAllocatedSlug({
      source: input.name,
      fallback: 'ingress-group',
      reserved: ['new'],
      constraint: GROUP_SLUG_CONSTRAINT,
      write: (slug) =>
        this.db.transaction(async (tx) => {
          const [created] = await tx
            .insert(ingressGroups)
            .values({
              name: input.name,
              slug,
              description: input.description ?? null,
              folderId: input.folderId ?? null,
              createdById: userId,
            })
            .returning();
          await tx.insert(ingressGroupMembers).values(
            input.nodeIds.map((nodeId, priority) => ({
              groupId: created!.id,
              nodeId,
              priority,
              state: 'active' as const,
            }))
          );
          return created!;
        }),
    });
    await this.auditService.log({
      userId,
      action: 'ingress_group.create',
      resourceType: 'ingress_group',
      resourceId: group.id,
      details: { name: group.name, nodeIds: input.nodeIds, folderId: group.folderId },
    });
    this.emit(group.id, 'created');
    return this.getSummary(group.id);
  }

  async update(id: string, input: UpdateIngressGroupInput, userId: string): Promise<IngressGroupView> {
    const existing = await this.requireGroup(id);
    const nameChanged = input.name !== undefined && input.name !== existing.name;
    const write = async (slug?: string) => {
      const [updated] = await this.db
        .update(ingressGroups)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
          ...(input.dnsFailoverMode !== undefined ? { dnsFailoverMode: input.dnsFailoverMode } : {}),
          ...(slug ? { slug } : {}),
          updatedAt: new Date(),
        })
        .where(eq(ingressGroups.id, id))
        .returning();
      return updated!;
    };
    if (nameChanged) {
      await writeWithAllocatedSlug({
        source: input.name!,
        fallback: 'ingress-group',
        reserved: ['new'],
        constraint: GROUP_SLUG_CONSTRAINT,
        write,
      });
    } else {
      await write();
    }
    await this.auditService.log({
      userId,
      action: 'ingress_group.update',
      resourceType: 'ingress_group',
      resourceId: id,
      details: { changes: Object.keys(input) },
    });
    this.emit(id, 'updated');
    return this.getSummary(id);
  }

  async delete(id: string, userId: string): Promise<void> {
    const group = await this.requireGroup(id);
    const [[routes], [domainCount]] = await Promise.all([
      this.db.select({ total: sql<number>`count(*)::int` }).from(proxyHosts).where(eq(proxyHosts.ingressGroupId, id)),
      this.db.select({ total: sql<number>`count(*)::int` }).from(domains).where(eq(domains.ingressGroupId, id)),
    ]);
    if ((routes?.total ?? 0) > 0 || (domainCount?.total ?? 0) > 0) {
      throw new AppError(
        409,
        'INGRESS_GROUP_IN_USE',
        'Move the routes and domains of this ingress group to one node (or delete them) before deleting the group',
        { routeCount: routes?.total ?? 0, domainCount: domainCount?.total ?? 0 }
      );
    }
    await this.db.delete(ingressGroups).where(eq(ingressGroups.id, id));
    await this.auditService.log({
      userId,
      action: 'ingress_group.delete',
      resourceType: 'ingress_group',
      resourceId: id,
      details: { name: group.name },
    });
    this.emit(id, 'deleted');
  }

  /**
   * Adds a member without downtime: its row starts `joining` (served routes, no DNS), every route of the group is
   * delivered to it (secure-link sources, Pages artifacts, config, certificates), and only then is it promoted to
   * `active` and published in DNS. An offline node, or a route that did not reach it, keeps it joining; the
   * convergence reconciler retries and promotes it once it caught up.
   */
  async addMember(id: string, input: AddIngressGroupMemberInput, userId: string): Promise<IngressGroupView> {
    await this.requireGroup(id);
    await this.requireMemberCandidate(input.nodeId);
    await assertNodeAllowsServiceCreation(this.db, input.nodeId, 'nginx');
    const hostIds = await this.groupHostIds(id);
    // Every app environment whose routes use the group must allow the new member.
    await assertGroupRoutesAllowNode(this.db, hostIds, input.nodeId);
    await withProxyLocks([ingressGroupLockKey(id), proxyNodeLockKey(input.nodeId)], async () => {
      const members = await ingressGroupMemberRows(this.db, id);
      if (members.some((member) => member.nodeId === input.nodeId)) {
        throw new AppError(409, 'INGRESS_GROUP_MEMBER_EXISTS', 'The node is already a member of this ingress group');
      }
      const position = Math.min(input.position ?? members.length, members.length);
      await this.db
        .transaction(async (tx) => {
          // Renumber so the new member takes `position` in the site-preference order.
          const ordered = [...members];
          for (const [index, member] of ordered.entries()) {
            const priority = index < position ? index : index + 1;
            if (member.priority !== priority) {
              await tx
                .update(ingressGroupMembers)
                .set({ priority, updatedAt: new Date() })
                .where(and(eq(ingressGroupMembers.groupId, id), eq(ingressGroupMembers.nodeId, member.nodeId)));
            }
          }
          // The domain trigger refuses a name another enabled route already serves on this node.
          await tx
            .insert(ingressGroupMembers)
            .values({ groupId: id, nodeId: input.nodeId, priority: position, state: 'joining' });
        })
        .catch((error) => rethrowProxyHostDomainConflict(this.db, error));
    });
    await this.auditService.log({
      userId,
      action: 'ingress_group.member_add',
      resourceType: 'ingress_group',
      resourceId: id,
      details: { nodeId: input.nodeId, position: input.position ?? null, routeCount: hostIds.length },
    });
    await this.completeJoin(id, input.nodeId);
    this.emit(id, 'member_added');
    return this.getSummary(id);
  }

  /**
   * Delivers every route of the group to a joining member and promotes it when all of them reached it. Returns
   * whether the member is active now. Used by addMember and by the convergence reconciler.
   */
  async completeJoin(groupId: string, nodeId: string): Promise<boolean> {
    const proxy = this.requireProxy();
    const errors: string[] = [];
    if (!this.deps.isNodeConnected(nodeId)) {
      errors.push('The node is offline; it joins when it reconnects');
    } else {
      for (const hostId of await this.groupHostIds(groupId)) {
        try {
          await proxy.applyIngressMemberJoin(hostId, nodeId);
        } catch (error) {
          errors.push(`${hostId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return withProxyLocks([ingressGroupLockKey(groupId)], async () => {
      const [member] = await this.db
        .select()
        .from(ingressGroupMembers)
        .where(and(eq(ingressGroupMembers.groupId, groupId), eq(ingressGroupMembers.nodeId, nodeId)))
        .limit(1);
      if (!member || member.state !== 'joining') return member?.state === 'active';
      if (errors.length > 0) {
        await this.db
          .update(ingressGroupMembers)
          .set({ lastError: errors.join('; ').slice(0, 2000), updatedAt: new Date() })
          .where(and(eq(ingressGroupMembers.groupId, groupId), eq(ingressGroupMembers.nodeId, nodeId)));
        return false;
      }
      await this.db
        .update(ingressGroupMembers)
        .set({ state: 'active', lastError: null, updatedAt: new Date() })
        .where(and(eq(ingressGroupMembers.groupId, groupId), eq(ingressGroupMembers.nodeId, nodeId)));
      await this.syncPrimaryMirrors(groupId);
      // Only now is the member's address published.
      await this.requireDomains()
        .reconcileIngressGroupDns(groupId)
        .catch((error) =>
          logger.warn('DNS of the ingress group is updated on the next reconciliation', {
            groupId,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      await this.auditService.log({
        userId: null,
        action: 'ingress_group.member_active',
        resourceType: 'ingress_group',
        resourceId: groupId,
        details: { nodeId },
      });
      this.emit(groupId, 'member_active');
      return true;
    });
  }

  /**
   * Removes a member without downtime: DNS first (the member is `draining`: it keeps serving, but is no longer
   * published), then its config, certificates, secure-link sources and Pages artifacts once no public name resolves
   * to it (the convergence reconciler finishes the drain; at most 24 hours). `force` finishes at once. A joining
   * member was never published and is removed at once.
   */
  async removeMember(
    id: string,
    nodeId: string,
    input: RemoveIngressGroupMemberInput,
    userId: string
  ): Promise<IngressGroupView> {
    await this.requireGroup(id);
    const finishNow = await withProxyLocks([ingressGroupLockKey(id)], async () => {
      const members = await ingressGroupMemberRows(this.db, id);
      const member = members.find((candidate) => candidate.nodeId === nodeId);
      if (!member) throw new AppError(404, 'INGRESS_GROUP_MEMBER_NOT_FOUND', 'The node is not a member of this group');
      const remainingActive = members.filter(
        (candidate) => candidate.nodeId !== nodeId && candidate.state === 'active'
      );
      const hostIds = await this.groupHostIds(id);
      const [domainRow] = await this.db
        .select({ id: domains.id })
        .from(domains)
        .where(eq(domains.ingressGroupId, id))
        .limit(1);
      if (remainingActive.length === 0 && (hostIds.length > 0 || domainRow)) {
        throw new AppError(
          409,
          'INGRESS_GROUP_LAST_MEMBER',
          'This is the last active member of a group that still serves routes or domains: add another member first, or move them to one node'
        );
      }
      if (member.state === 'draining' && !input.force) return false;
      await this.db
        .update(ingressGroupMembers)
        .set({
          state: 'draining',
          drainStartedAt: sql`coalesce(${ingressGroupMembers.drainStartedAt}, now())`,
          updatedAt: new Date(),
        })
        .where(and(eq(ingressGroupMembers.groupId, id), eq(ingressGroupMembers.nodeId, nodeId)));
      await this.syncPrimaryMirrors(id);
      return input.force === true || member.state === 'joining';
    });
    await this.auditService.log({
      userId,
      action: 'ingress_group.member_remove',
      resourceType: 'ingress_group',
      resourceId: id,
      details: { nodeId, force: input.force === true },
    });
    // DNS first: the member's address leaves every Cloudflare-managed domain of the group.
    const dns = await this.requireDomains().reconcileIngressGroupDns(id);
    if (finishNow) {
      await this.finishDrain(id, nodeId, { reason: input.force ? 'forced' : 'joining' });
    } else if (!dns.settled) {
      await this.recordMemberError(id, nodeId, 'Waiting for DNS of the group’s domains to stop listing this member');
    }
    this.emit(id, 'member_draining');
    return this.getSummary(id);
  }

  /**
   * The end of a drain: the member row goes (its domain rows with it), then every route of the group leaves the
   * node. Idempotent; a failure on an unreachable node is repaired by its reconnect resync.
   */
  async finishDrain(groupId: string, nodeId: string, details: Record<string, unknown> = {}): Promise<void> {
    const proxy = this.requireProxy();
    const hostIds = await this.groupHostIds(groupId);
    await withProxyLocks([ingressGroupLockKey(groupId)], async () => {
      await this.db
        .delete(ingressGroupMembers)
        .where(
          and(
            eq(ingressGroupMembers.groupId, groupId),
            eq(ingressGroupMembers.nodeId, nodeId),
            eq(ingressGroupMembers.state, 'draining')
          )
        );
      await this.syncPrimaryMirrors(groupId);
    });
    const failures: string[] = [];
    for (const hostId of hostIds) {
      try {
        await proxy.applyIngressMemberLeave(hostId, nodeId);
      } catch (error) {
        failures.push(`${hostId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.auditService.log({
      userId: null,
      action: 'ingress_group.member_removed',
      resourceType: 'ingress_group',
      resourceId: groupId,
      details: { nodeId, ...details, cleanupFailures: failures },
    });
    if (failures.length > 0) {
      logger.warn('A removed ingress group member keeps some route configs until its reconnect resync', {
        groupId,
        nodeId,
        failures,
      });
    }
    this.emit(groupId, 'member_removed');
  }

  /** New site-preference order; the first active member becomes the primary mirrored into routes and domains. */
  async reorder(id: string, nodeIds: string[], userId: string): Promise<IngressGroupView> {
    await this.requireGroup(id);
    await withProxyLocks([ingressGroupLockKey(id)], async () => {
      const members = await ingressGroupMemberRows(this.db, id);
      const current = members.map((member) => member.nodeId).sort();
      if (current.length !== nodeIds.length || [...nodeIds].sort().some((nodeId, index) => nodeId !== current[index])) {
        throw new AppError(400, 'INGRESS_GROUP_ORDER_INVALID', 'Pass every member of the group exactly once');
      }
      await this.db.transaction(async (tx) => {
        for (const [priority, nodeId] of nodeIds.entries()) {
          await tx
            .update(ingressGroupMembers)
            .set({ priority, updatedAt: new Date() })
            .where(and(eq(ingressGroupMembers.groupId, id), eq(ingressGroupMembers.nodeId, nodeId)));
        }
      });
      await this.syncPrimaryMirrors(id);
    });
    await this.auditService.log({
      userId,
      action: 'ingress_group.reorder',
      resourceType: 'ingress_group',
      resourceId: id,
      details: { nodeIds },
    });
    this.emit(id, 'reordered');
    return this.getSummary(id);
  }
}
