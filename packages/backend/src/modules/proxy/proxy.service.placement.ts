import { eq } from 'drizzle-orm';
import { proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertAppPlacement } from '@/modules/apps/app-placement-guard.js';
import { requireRoutableIngressGroup } from '@/modules/ingress-groups/ingress-group-routing.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { UpdateProxyHostInput } from './proxy.schemas.js';
import { logger, type ProxyHostRow } from './proxy.service.core.js';
import { ProxyServiceDelivery } from './proxy.service.delivery.js';
import type { ProxyValidationOptions } from './proxy.service-helpers.js';
import { assertRegisteredDomainsUseTarget } from './proxy-domain-node.js';
import {
  assertNoProxyDomainOverlapOnNodes,
  restoringProxyHostState,
  rethrowProxyHostDomainConflict,
} from './proxy-domain-overlap.js';
import { proxyHostLockKey, proxyNodeLockKey, withProxyLocks } from './proxy-host-lock.js';
import { forgetIngressMemberDeliveries } from './proxy-ingress-delivery.js';

/** A requested change between one node and an ingress group (or between groups). */
export interface RoutePlacementChange {
  /** The target group, or null to serve the route from one node. */
  ingressGroupId: string | null;
  /** With `ingressGroupId: null`: the node that keeps serving (a current member). */
  nodeId: string | null;
}

/**
 * Whether an update request changes a route's placement between a node and an ingress group. A plain node move of a
 * single-node route is not a placement change (the ingress migration path handles it). A group route refuses a
 * different `nodeId` without `ingressGroupId: null`: its node is the group's primary member, maintained by Opfield.
 */
export function requestedPlacementChange(
  existing: Pick<ProxyHostRow, 'nodeId' | 'ingressGroupId'>,
  input: Pick<UpdateProxyHostInput, 'nodeId' | 'ingressGroupId'>
): RoutePlacementChange | null {
  if (input.ingressGroupId !== undefined) {
    if (input.ingressGroupId && input.ingressGroupId !== existing.ingressGroupId) {
      return { ingressGroupId: input.ingressGroupId, nodeId: null };
    }
    if (input.ingressGroupId === null && existing.ingressGroupId) {
      return { ingressGroupId: null, nodeId: input.nodeId ?? existing.nodeId };
    }
  }
  if (existing.ingressGroupId && input.nodeId && input.nodeId !== existing.nodeId) {
    throw new AppError(
      400,
      'INGRESS_GROUP_ROUTE_NODE_CHANGE',
      'This route is served by an ingress group; pass ingressGroupId: null together with nodeId to serve it from one node, or change the group members'
    );
  }
  return null;
}

/**
 * Planned placement changes of a route without downtime: a node that serves the route now keeps serving it until the
 * new placement is fully applied. New members get secure-link sources, Pages artifacts, config and certificates
 * first; members that leave lose them only afterwards. DNS of registered domains is the domain's concern and is moved
 * by the domain conversion before (joining) or after (leaving) its routes.
 */
export abstract class ProxyServicePlacement extends ProxyServiceDelivery {
  async changeRoutePlacement(
    id: string,
    change: RoutePlacementChange,
    userId: string,
    options: Pick<ProxyValidationOptions, 'skipDomainNodeValidation' | 'allowSystemNodeMove'> = {}
  ): Promise<ProxyHostRow> {
    return withProxyLocks([proxyHostLockKey(id)], async () => {
      const existing = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) });
      if (!existing) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
      return this.changeRoutePlacementLocked(existing, change, userId, options);
    });
  }

  protected async changeRoutePlacementLocked(
    existing: ProxyHostRow,
    change: RoutePlacementChange,
    userId: string,
    options: Pick<ProxyValidationOptions, 'skipDomainNodeValidation' | 'allowSystemNodeMove'> = {}
  ): Promise<ProxyHostRow> {
    if (existing.isSystem && !options.allowSystemNodeMove) {
      throw new AppError(403, 'SYSTEM_HOST', 'System proxy hosts cannot be edited');
    }
    const before = await this.ingressNodesOf(existing);
    let target: { nodeId: string; ingressGroupId: string | null; servingNodeIds: string[] };
    if (change.ingressGroupId) {
      if (change.ingressGroupId === existing.ingressGroupId) return existing;
      const group = await requireRoutableIngressGroup(this.db, change.ingressGroupId);
      target = { nodeId: group.primaryNodeId, ingressGroupId: group.group.id, servingNodeIds: group.memberNodeIds };
    } else {
      if (!existing.ingressGroupId) return existing;
      const nodeId = change.nodeId;
      if (!nodeId || !before.includes(nodeId)) {
        throw new AppError(
          409,
          'INGRESS_PLACEMENT_NODE_NOT_SERVING',
          'Choose a member of the route’s ingress group as the node that keeps serving it',
          { nodeId, servingNodeIds: before }
        );
      }
      target = { nodeId, ingressGroupId: null, servingNodeIds: [nodeId] };
    }
    const kept = before.filter((nodeId) => target.servingNodeIds.includes(nodeId));
    if (existing.enabled && kept.length === 0) {
      throw new AppError(
        409,
        'INGRESS_PLACEMENT_WOULD_INTERRUPT',
        'At least one node that serves this route now must keep serving it: add the route’s current node to the ingress group first, or move the route to a member node first',
        { servingNodeIds: before, targetNodeIds: target.servingNodeIds }
      );
    }
    const added = target.servingNodeIds.filter((nodeId) => !before.includes(nodeId));
    const removed = before.filter((nodeId) => !target.servingNodeIds.includes(nodeId));
    for (const nodeId of added) await assertNodeAllowsServiceCreation(this.db, nodeId, 'nginx');
    // A route of an app environment is served only by nodes the environment allows.
    await assertAppPlacement(this.db, 'routes', existing.folderId, added);
    if (!options.skipDomainNodeValidation) {
      await assertRegisteredDomainsUseTarget(this.db, existing.domainNames, target);
    }

    return withProxyLocks([...new Set([...before, ...target.servingNodeIds])].map(proxyNodeLockKey), async () => {
      if (existing.enabled) {
        await assertNoProxyDomainOverlapOnNodes(this.db, added, existing.domainNames, existing.id);
      }
      // 1. The new placement (the domain trigger refuses a name another enabled route serves on a new member).
      const [moved] = await this.db
        .update(proxyHosts)
        .set({ nodeId: target.nodeId, ingressGroupId: target.ingressGroupId, updatedAt: new Date() })
        .where(eq(proxyHosts.id, existing.id))
        .returning()
        .catch((error) => rethrowProxyHostDomainConflict(this.db, error));
      if (!moved) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
      try {
        // 2. Secure-link sources, Pages artifacts, config and certificates on every serving node.
        await this.secureLinks?.syncHostSources(moved, before);
        if (moved.upstreamKind === 'pages') await this.syncPagesServingNodes(moved, added, []);
        await this.additionalRoutes?.syncServingNodes(moved, added, []);
        if (moved.enabled) {
          await this.deliverHost(moved, { certOptions: { preserveLegacyOnUnsupported: true } });
        }
      } catch (error) {
        await this.rollBackPlacement(existing, moved, before, added);
        throw error;
      }
      // 3. Only now retire the nodes that no longer serve the route.
      if (removed.length > 0) {
        try {
          await this.withdrawHost(moved, { nodeIds: removed });
        } catch (error) {
          // Configs left on an unreachable node are removed by the full sync after its reconnect resync.
          logger.warn('A former ingress node kept the route config after a placement change; it is cleaned up later', {
            hostId: moved.id,
            nodeIds: removed,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await Promise.all([
          moved.upstreamKind === 'pages' ? this.syncPagesServingNodes(moved, [], removed) : undefined,
          this.additionalRoutes?.syncServingNodes(moved, [], removed),
        ]).catch((error) =>
          logger.warn('Pages bindings of former ingress nodes are removed on the next Pages reconciliation', {
            hostId: moved.id,
            error: error instanceof Error ? error.message : String(error),
          })
        );
        await this.secureLinks?.syncHostSources(moved, before).catch((error) =>
          logger.warn('Secure Link sources of former ingress nodes are removed on the next reconciliation', {
            hostId: moved.id,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
      if (!moved.ingressGroupId) await forgetIngressMemberDeliveries(this.db, moved.id);
      await this.auditService.log({
        userId,
        action: 'proxy_host.ingress_placement_change',
        resourceType: 'proxy_host',
        resourceId: moved.id,
        details: {
          from: { nodeId: existing.nodeId, ingressGroupId: existing.ingressGroupId, servingNodeIds: before },
          to: { nodeId: moved.nodeId, ingressGroupId: moved.ingressGroupId, servingNodeIds: target.servingNodeIds },
        },
      });
      this.emitHost(moved.id, 'updated', moved.domainNames?.[0]);
      return moved;
    });
  }

  /**
   * A node joined the ingress group of a route (its member row exists): secure-link sources, Pages artifacts, config
   * and certificates of the route on that node. The other members are untouched.
   */
  async applyIngressMemberJoin(hostId: string, nodeId: string): Promise<void> {
    await withProxyLocks([proxyHostLockKey(hostId), proxyNodeLockKey(nodeId)], async () => {
      const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
      if (!host?.ingressGroupId) return;
      const members = await this.ingressNodesOf(host);
      if (!members.includes(nodeId)) return;
      await this.secureLinks?.syncHostSources(
        host,
        members.filter((member) => member !== nodeId)
      );
      if (host.upstreamKind === 'pages') await this.syncPagesServingNodes(host, [nodeId], []);
      await this.additionalRoutes?.syncServingNodes(host, [nodeId], []);
      if (host.enabled) {
        await this.deliverHost(host, { certOptions: { preserveLegacyOnUnsupported: true }, nodeIds: [nodeId] });
      }
    });
  }

  /**
   * A node left the ingress group of a route (its member row is gone): the route's config, certificate deployment,
   * secure-link sources and Pages artifacts leave that node. An offline node drops its stale config in the full sync
   * that follows its reconnect resync.
   */
  async applyIngressMemberLeave(hostId: string, nodeId: string): Promise<void> {
    await withProxyLocks([proxyHostLockKey(hostId), proxyNodeLockKey(nodeId)], async () => {
      const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
      if (!host) return;
      const members = await this.ingressNodesOf(host);
      if (members.includes(nodeId)) return;
      await this.withdrawHost(host, { nodeIds: [nodeId] });
      await this.secureLinks?.syncHostSources(host, [...members, nodeId]);
      if (host.upstreamKind === 'pages') await this.syncPagesServingNodes(host, [], [nodeId]);
      await this.additionalRoutes?.syncServingNodes(host, [], [nodeId]);
    });
  }

  /**
   * Delivers a group route to one member again (a member that missed a change while offline, a failed push, a
   * certificate version that did not reach it). Nothing happens when the node no longer serves the route.
   */
  async redeliverIngressMember(hostId: string, nodeId: string): Promise<void> {
    await withProxyLocks([proxyHostLockKey(hostId)], async () => {
      const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
      if (!host?.ingressGroupId || !host.enabled) return;
      if (!(await this.ingressNodesOf(host)).includes(nodeId)) return;
      await this.deliverHost(host, { certOptions: { preserveLegacyOnUnsupported: true }, nodeIds: [nodeId] });
    });
  }

  /** Pages artifacts of a Pages route on nodes that start or stop serving it. */
  protected async syncPagesServingNodes(host: ProxyHostRow, added: string[], removed: string[]): Promise<void> {
    if (added.length === 0 && removed.length === 0) return;
    if (!this.pageRoutes) throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Route service is unavailable');
    await this.pageRoutes.syncServingNodes(host.id, added, removed);
  }

  private async rollBackPlacement(
    existing: ProxyHostRow,
    moved: ProxyHostRow,
    before: string[],
    added: string[]
  ): Promise<void> {
    try {
      await restoringProxyHostState(this.db, (tx) =>
        tx
          .update(proxyHosts)
          .set({ nodeId: existing.nodeId, ingressGroupId: existing.ingressGroupId, updatedAt: existing.updatedAt })
          .where(eq(proxyHosts.id, existing.id))
      );
      if (added.length > 0) {
        await this.withdrawHost(moved, { nodeIds: added }).catch(() => undefined);
        if (moved.upstreamKind === 'pages') await this.syncPagesServingNodes(moved, [], added).catch(() => undefined);
        await this.additionalRoutes?.syncServingNodes(moved, [], added).catch(() => undefined);
      }
      await this.secureLinks?.syncHostSources(existing, [...before, ...added]);
      if (existing.enabled) {
        await this.deliverHost(existing, { certOptions: { preserveLegacyOnUnsupported: true } });
      }
      if (!existing.ingressGroupId) await forgetIngressMemberDeliveries(this.db, existing.id);
    } catch (rollbackError) {
      logger.error('Failed to roll back a route placement change; reconciliation repairs the members', {
        hostId: existing.id,
        rollbackError,
      });
    }
  }
}
