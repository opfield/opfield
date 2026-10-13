import { and, eq, inArray } from 'drizzle-orm';
import { domains } from '@/db/schema/domains.js';
import { pageWildcardProfiles } from '@/db/schema/pages.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  type IngressGroupDestination,
  loadIngressGroupDestinations,
} from '@/modules/ingress-groups/ingress-group-destinations.js';
import { requireRoutableIngressGroup } from '@/modules/ingress-groups/ingress-group-routing.js';
import { ingressGroupMemberRows } from '@/modules/ingress-groups/ingress-nodes.js';
import { getRegisteredDomainCandidates } from '@/modules/proxy/proxy-domain-node.js';
import { probeDnsRecords } from './dns.utils.js';
import type { DomainIngressPlacementInput, PreviewDomainInput } from './domain.schemas.js';
import { DomainsServiceRuntime } from './domain.service.runtime.js';
import { type DomainIngressPlacement, type EligibleNginxNode, logger } from './domain.service.shared.js';
import { canPickDomainNginxNode } from './domain-creation-access.js';

type DomainRow = typeof domains.$inferSelect;

/** A member of an ingress group offered for a new domain. */
export interface DomainIngressGroupMember {
  id: string;
  hostname: string;
  displayName: string | null;
  effectiveAddress: string;
}

/** The DNS view of an ingress group: what to publish and what DNS may already point at. */
export interface IngressGroupDnsPlan {
  groupId: string;
  /** First active member (mirrored into domains.nginx_node_id). */
  primaryNode: EligibleNginxNode | null;
  /** One address per active member with a public ingress address (round robin, no health in mode `none`). */
  targetIps: string[];
  /** Every ingress address of every serving member (joining and draining members included). */
  allowedIps: string[];
  /** Active members without a detected public ingress address: not published. */
  unpublishedNodeIds: string[];
  /** Addresses of each serving member, for drain checks and views. */
  memberAddresses: Map<string, string[]>;
}

/**
 * Domains on ingress groups. DNS of a Cloudflare-managed group domain in mode `none` is the union of the active
 * members' effective ingress addresses (round robin; Cloudflare does not health-check plain records, so an
 * unreachable member keeps receiving its share until it is removed or a DNS failover mode is chosen). Members that
 * are joining or draining are never published. External DNS is the operator's: Opfield only validates it.
 */
export abstract class DomainsServiceIngressGroups extends DomainsServiceRuntime {
  /**
   * Ingress groups a new domain may be placed on: the caller may view the group (ingress:groups:view), every member
   * has a public ingress address and is open to the caller's domains:create grant, and some member is active. Members
   * in site order, with their state.
   */
  async getIngressGroupOptions(
    scopes: readonly string[],
    options?: { eligibleNodes: EligibleNginxNode[] }
  ): Promise<IngressGroupDestination<DomainIngressGroupMember>[]> {
    const { eligibleNodes } = options ?? (await this.getNginxNodeOptions());
    const usable = eligibleNodes
      .filter((node) => canPickDomainNginxNode([...scopes], node.id))
      .map((node) => ({
        id: node.id,
        hostname: node.hostname,
        displayName: node.displayName,
        effectiveAddress: node.effectiveAddress,
      }));
    return loadIngressGroupDestinations(this.db, usable, scopes);
  }

  async ingressGroupDnsPlan(groupId: string): Promise<IngressGroupDnsPlan> {
    const members = await ingressGroupMemberRows(this.db, groupId);
    const options = await this.getNginxNodeOptions();
    const summary = (nodeId: string) => options.eligibleNodes.find((node) => node.id === nodeId) ?? null;
    const memberAddresses = new Map(
      members.map((member) => {
        const node = summary(member.nodeId);
        return [member.nodeId, node ? this.getAllowedIngressAddresses(node) : []] as const;
      })
    );
    const active = members.filter((member) => member.state === 'active');
    const published = active.flatMap((member) => {
      const node = summary(member.nodeId);
      return node?.effectiveAddress ? [node.effectiveAddress] : [];
    });
    const primaryId = active[0]?.nodeId ?? members[0]?.nodeId ?? null;
    return {
      groupId,
      primaryNode: primaryId ? (summary(primaryId) ?? (await this.getNginxNodeSummary(primaryId))) : null,
      targetIps: [...new Set(published)].sort(),
      allowedIps: [...new Set([...memberAddresses.values()].flat())].sort(),
      unpublishedNodeIds: active.filter((member) => !summary(member.nodeId)?.effectiveAddress).map((m) => m.nodeId),
      memberAddresses,
    };
  }

  protected override async resolveDomainIngressPlacement(
    input: Pick<PreviewDomainInput, 'nginxNodeId' | 'ingressGroupId'>
  ): Promise<DomainIngressPlacement> {
    if (!input.ingressGroupId) return super.resolveDomainIngressPlacement(input);
    const group = await requireRoutableIngressGroup(this.db, input.ingressGroupId);
    if (input.nginxNodeId && !group.memberNodeIds.includes(input.nginxNodeId)) {
      throw new AppError(
        400,
        'INGRESS_TARGET_CONFLICT',
        'Pass either nginxNodeId or ingressGroupId; a domain on an ingress group is served by every member'
      );
    }
    const plan = await this.ingressGroupDnsPlan(group.group.id);
    if (plan.targetIps.length === 0 || !plan.primaryNode) {
      throw new AppError(
        409,
        'DOMAIN_NGINX_ADDRESS_REQUIRED',
        'Configure a detected public service address on the ingress group members before creating a domain on it',
        { ingressGroupId: group.group.id, nodeIds: plan.unpublishedNodeIds }
      );
    }
    return {
      nginxNode: plan.primaryNode,
      ingressGroupId: group.group.id,
      targetIps: plan.targetIps,
      allowedIps: plan.allowedIps,
    };
  }

  protected override async allowedIngressAddressesFor(
    row: Pick<DomainRow, 'nginxNodeId' | 'ingressGroupId'>
  ): Promise<string[] | null> {
    if (!row.ingressGroupId) return super.allowedIngressAddressesFor(row);
    const plan = await this.ingressGroupDnsPlan(row.ingressGroupId);
    return plan.allowedIps.length > 0 ? plan.allowedIps : null;
  }

  /**
   * Brings one group domain in line with its members: Cloudflare-managed records become the union of the active
   * members' addresses; external DNS is checked against every serving member's addresses. Returns whether the
   * domain's DNS matches the members now.
   */
  protected override async reconcileIngressGroupDomain(row: DomainRow): Promise<void> {
    await this.reconcileIngressGroupDomainNow(row);
  }

  async reconcileIngressGroupDomainNow(row: DomainRow): Promise<boolean> {
    if (!row.ingressGroupId) return true;
    const plan = await this.ingressGroupDnsPlan(row.ingressGroupId);
    if (plan.primaryNode && row.nginxNodeId !== plan.primaryNode.id) {
      await this.db
        .update(domains)
        .set({ nginxNodeId: plan.primaryNode.id, updatedAt: new Date() })
        .where(and(eq(domains.id, row.id), eq(domains.ingressGroupId, row.ingressGroupId)));
    }
    if (row.dnsProvider !== 'cloudflare') {
      const probe = await probeDnsRecords(row.domain);
      const dnsStatus = plan.allowedIps.length
        ? this.externalDnsStatus(probe.addressResolution, probe.records, plan.allowedIps)
        : 'invalid';
      const targetUpdate = await this.externalTargetSnapshotUpdate(row, dnsStatus, probe.records);
      await this.db
        .update(domains)
        .set({
          dnsStatus,
          dnsRecords: probe.records,
          ...targetUpdate,
          lastDnsCheckAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(domains.id, row.id));
      this.emitDomain(row.id, 'updated', row.domain);
      return dnsStatus === 'valid';
    }
    if (plan.targetIps.length === 0) {
      await this.db.update(domains).set({ dnsStatus: 'invalid', updatedAt: new Date() }).where(eq(domains.id, row.id));
      this.emitDomain(row.id, 'updated', row.domain);
      return false;
    }
    let reconciliationRow = row;
    if (!this.sameStringSet(row.dnsTargetIps, plan.targetIps) && row.pendingDnsTargetIp !== plan.targetIps[0]) {
      // The member set is the approval: record it durably first, as a single-node retarget does.
      const [approved] = await this.db
        .update(domains)
        .set({ pendingDnsTargetIp: plan.targetIps[0]!, updatedAt: new Date() })
        .where(and(eq(domains.id, row.id), eq(domains.ingressGroupId, row.ingressGroupId)))
        .returning();
      if (!approved) return false;
      reconciliationRow = approved;
    }
    await this.reconcileDomainTarget(reconciliationRow, plan.targetIps);
    const [current] = await this.db.select().from(domains).where(eq(domains.id, row.id)).limit(1);
    return !!current && current.dnsStatus === 'valid' && this.sameStringSet(current.dnsTargetIps, plan.targetIps);
  }

  /** Every domain of a group, reconciled; true when all of them match the members now. */
  async reconcileIngressGroupDns(
    groupId: string
  ): Promise<{ settled: boolean; domains: Array<{ id: string; domain: string; settled: boolean }> }> {
    const rows = await this.db.select().from(domains).where(eq(domains.ingressGroupId, groupId));
    const results = [];
    for (const row of rows) {
      let settled = false;
      try {
        settled = await this.reconcileIngressGroupDomainNow(row);
      } catch (error) {
        logger.warn('Ingress group domain DNS reconciliation failed; it is retried', {
          domainId: row.id,
          ingressGroupId: groupId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      results.push({ id: row.id, domain: row.domain, settled });
    }
    return { settled: results.every((result) => result.settled), domains: results };
  }

  /**
   * Whether DNS of every name a group serves stopped pointing at a node's addresses (a draining member can be
   * cleaned up then). Cloudflare-managed records must not contain them any more (a proxied record takes effect at
   * once; a DNS-only record after its TTL, which the caller waits for); every other name is resolved publicly.
   */
  async ingressNamesStillPointAt(groupId: string, addresses: string[]): Promise<string[]> {
    if (addresses.length === 0) return [];
    const blocked = new Set(addresses);
    const [groupDomains, groupHosts] = await Promise.all([
      this.db.select().from(domains).where(eq(domains.ingressGroupId, groupId)),
      this.db
        .select({ domainNames: proxyHosts.domainNames })
        .from(proxyHosts)
        .where(and(eq(proxyHosts.ingressGroupId, groupId), eq(proxyHosts.enabled, true))),
    ]);
    const stillPointing: string[] = [];
    const managedNames = new Set<string>();
    for (const row of groupDomains) {
      if (row.dnsProvider !== 'cloudflare') continue;
      managedNames.add(row.domain.toLowerCase());
      if (row.dnsTargetIps.some((ip) => blocked.has(ip))) stillPointing.push(row.domain);
    }
    const names = new Set<string>();
    for (const row of groupDomains) if (row.dnsProvider !== 'cloudflare') names.add(row.domain.toLowerCase());
    for (const host of groupHosts) {
      for (const name of host.domainNames) {
        const normalized = name.trim().toLowerCase();
        if (normalized.startsWith('*.') || managedNames.has(normalized)) continue;
        names.add(normalized);
      }
    }
    for (const name of names) {
      const probe = await probeDnsRecords(name).catch(() => null);
      if (!probe || probe.addressResolution === 'error') {
        stillPointing.push(name);
        continue;
      }
      if ([...probe.records.a, ...probe.records.aaaa].some((ip) => blocked.has(ip))) stillPointing.push(name);
    }
    return stillPointing;
  }

  /**
   * Moves a domain, every route on it and every related registered domain (the same closure an ingress migration
   * moves) onto an ingress group, or from a group back to one member node. Joining: config and certificates reach
   * the new members first (the domain's current node, which must be a member, keeps serving), then DNS gets the
   * members' union. Leaving: DNS first, then the routes leave the other members.
   */
  async changeDomainIngressPlacement(id: string, input: DomainIngressPlacementInput, userId: string) {
    if (!this.proxyService) throw new AppError(503, 'PROXY_SERVICE_UNAVAILABLE', 'Route service is unavailable');
    const closure = await this.ingressPlacementClosure(id);
    const root = closure.domains.find((row) => row.id === id)!;
    if (closure.domains.some((row) => row.ingressMigrationId)) {
      throw new AppError(409, 'DOMAIN_INGRESS_MIGRATION_PENDING', 'Finish the pending ingress migration first');
    }
    const [pagesProfile] = await this.db
      .select({ id: pageWildcardProfiles.id })
      .from(pageWildcardProfiles)
      .where(
        and(
          inArray(
            pageWildcardProfiles.domainId,
            closure.domains.map((row) => row.id)
          ),
          eq(pageWildcardProfiles.enabled, true)
        )
      )
      .limit(1);
    if (pagesProfile) {
      throw new AppError(
        409,
        'DOMAIN_INGRESS_GROUP_PAGES_PROFILE',
        'A domain that backs the Pages wildcard profile stays on one ingress node; Pages previews are node-local',
        { pagesProfileId: pagesProfile.id }
      );
    }

    if (input.ingressGroupId) {
      const group = await requireRoutableIngressGroup(this.db, input.ingressGroupId);
      if (root.ingressGroupId === group.group.id) return this.getDomain(id);
      const currentNodes = new Set(
        closure.domains.map((row) => row.nginxNodeId).filter((nodeId): nodeId is string => !!nodeId)
      );
      if (closure.domains.some((row) => row.ingressGroupId)) {
        throw new AppError(
          409,
          'DOMAIN_ALREADY_ON_INGRESS_GROUP',
          'Move the domain back to one node first, or change the members of its group'
        );
      }
      const missing = [...currentNodes].filter((nodeId) => !group.memberNodeIds.includes(nodeId));
      if (missing.length > 0) {
        throw new AppError(
          409,
          'INGRESS_PLACEMENT_WOULD_INTERRUPT',
          'Add the node that serves this domain now to the ingress group first; it keeps serving while the other members are prepared',
          { nodeIds: missing, ingressGroupId: group.group.id }
        );
      }
      const moved: string[] = [];
      try {
        for (const host of closure.hosts) {
          await this.proxyService.changeRoutePlacement(
            host.id,
            { ingressGroupId: group.group.id, nodeId: null },
            userId,
            { skipDomainNodeValidation: true, allowSystemNodeMove: true }
          );
          moved.push(host.id);
        }
      } catch (error) {
        for (const hostId of moved.reverse()) {
          const previous = closure.hosts.find((host) => host.id === hostId)!;
          await this.proxyService
            .changeRoutePlacement(hostId, { ingressGroupId: null, nodeId: previous.nodeId }, userId, {
              skipDomainNodeValidation: true,
              allowSystemNodeMove: true,
            })
            .catch((rollbackError) =>
              logger.error('Failed to move a route back after a failed domain conversion', {
                hostId,
                rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              })
            );
        }
        throw error;
      }
      await this.db
        .update(domains)
        .set({ ingressGroupId: group.group.id, nginxNodeId: group.primaryNodeId, updatedAt: new Date() })
        .where(
          inArray(
            domains.id,
            closure.domains.map((row) => row.id)
          )
        );
      const dns = await this.reconcileIngressGroupDns(group.group.id);
      await this.auditService.log({
        userId,
        action: 'domain.ingress_group_join',
        resourceType: 'domain',
        resourceId: id,
        details: {
          ingressGroupId: group.group.id,
          domainIds: closure.domains.map((row) => row.id),
          proxyHostIds: closure.hosts.map((host) => host.id),
          dnsSettled: dns.settled,
        },
      });
      for (const row of closure.domains) this.emitDomain(row.id, 'updated', row.domain);
      return this.getDomain(id);
    }

    // Leaving the group: DNS first, then the routes.
    if (!root.ingressGroupId) return this.getDomain(id);
    const groupId = root.ingressGroupId;
    const members = await ingressGroupMemberRows(this.db, groupId);
    const nodeId = input.nginxNodeId!;
    if (!members.some((member) => member.nodeId === nodeId)) {
      throw new AppError(409, 'INGRESS_PLACEMENT_NODE_NOT_SERVING', 'Choose a member of the ingress group', {
        nodeId,
      });
    }
    const node = await this.resolveRequestedNginxNode(nodeId);
    for (const row of closure.domains) {
      const [prepared] = await this.db
        .update(domains)
        .set({
          ingressGroupId: null,
          nginxNodeId: node.id,
          pendingDnsTargetIp: row.dnsProvider === 'cloudflare' ? node.effectiveAddress : null,
          updatedAt: new Date(),
        })
        .where(eq(domains.id, row.id))
        .returning();
      if (prepared?.dnsProvider === 'cloudflare') await this.reconcileDomainTarget(prepared, node.effectiveAddress);
    }
    for (const host of closure.hosts) {
      await this.proxyService.changeRoutePlacement(host.id, { ingressGroupId: null, nodeId: node.id }, userId, {
        skipDomainNodeValidation: true,
        allowSystemNodeMove: true,
      });
    }
    await this.auditService.log({
      userId,
      action: 'domain.ingress_group_leave',
      resourceType: 'domain',
      resourceId: id,
      details: {
        ingressGroupId: groupId,
        nginxNodeId: node.id,
        domainIds: closure.domains.map((row) => row.id),
        proxyHostIds: closure.hosts.map((host) => host.id),
      },
    });
    for (const row of closure.domains) this.emitDomain(row.id, 'updated', row.domain);
    return this.getDomain(id);
  }

  /** A domain with every registered domain and route that shares a route with it (they move together). */
  protected async ingressPlacementClosure(id: string) {
    const [allDomains, allHosts] = await Promise.all([
      this.db.select().from(domains),
      this.db
        .select({
          id: proxyHosts.id,
          domainNames: proxyHosts.domainNames,
          nodeId: proxyHosts.nodeId,
          ingressGroupId: proxyHosts.ingressGroupId,
        })
        .from(proxyHosts),
    ]);
    const root = allDomains.find((row) => row.id === id);
    if (!root) throw new AppError(404, 'NOT_FOUND', 'Domain not found');
    const domainsByName = new Map(allDomains.map((row) => [row.domain.toLowerCase(), row]));
    const domainIds = new Set([root.id]);
    const hostIds = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      const registeredNames = new Set(
        allDomains.filter((row) => domainIds.has(row.id)).map((row) => row.domain.trim().toLowerCase())
      );
      for (const host of allHosts) {
        if (hostIds.has(host.id)) continue;
        if (getRegisteredDomainCandidates(host.domainNames).some((candidate) => registeredNames.has(candidate))) {
          hostIds.add(host.id);
          changed = true;
        }
      }
      for (const host of allHosts.filter((candidate) => hostIds.has(candidate.id))) {
        for (const candidate of getRegisteredDomainCandidates(host.domainNames)) {
          const registered = domainsByName.get(candidate);
          if (registered && !domainIds.has(registered.id)) {
            domainIds.add(registered.id);
            changed = true;
          }
        }
      }
    }
    return {
      domains: allDomains.filter((row) => domainIds.has(row.id)),
      hosts: allHosts.filter((host) => hostIds.has(host.id)),
    };
  }
}
