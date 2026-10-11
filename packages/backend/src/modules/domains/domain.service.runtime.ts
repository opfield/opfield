import { isIP } from 'node:net';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import type { DnsRecords } from '@/db/schema/domains.js';
import { domains } from '@/db/schema/domains.js';
import { nodes } from '@/db/schema/nodes.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { domainsServedByNode } from '@/modules/ingress-groups/ingress-nodes.js';
import type { CloudflareDnsRecord } from '@/modules/integrations/cloudflare-client.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { getEffectiveNginxIngressAddresses } from '@/modules/nodes/node-service-address.js';
import type { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { type DnsAddressResolution, probeDnsRecords } from './dns.utils.js';
import type { PreviewDomainInput, ResolveCloudflareMigrationInput } from './domain.schemas.js';
import {
  type CloudflareAddressRecord,
  type DomainCloudflarePlan,
  type DomainExternalPlan,
  type DomainIngressPlacement,
  type DomainUsage,
  type EligibleNginxNode,
  logger,
  type NginxNodeOptions,
  selectBackfillNginxNode,
} from './domain.service.shared.js';
import { assertDomainIngressMoveAccess, domainNginxNodeRequiredError } from './domain-creation-access.js';

export abstract class DomainsServiceRuntime {
  protected eventBus?: EventBusService;
  protected integrationsService?: IntegrationsService;
  protected nodeRegistry?: NodeRegistryService;
  protected proxyService?: ProxyService;
  protected pageProfileService?: PageProfileService;
  protected ingressReconcileRunning = false;
  protected ingressReconcileQueued = false;
  protected cloudflareMigrationRunning = false;
  protected cloudflareMigrationQueued = false;

  constructor(
    protected readonly db: DrizzleClient,
    protected readonly auditService: AuditService
  ) {}

  protected abstract getNginxNodeOptions(): Promise<NginxNodeOptions>;

  protected abstract getDomain(id: string): Promise<typeof domains.$inferSelect>;

  protected abstract getUsage(domainName: string): Promise<DomainUsage>;

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
    bus.subscribe('node.service_address.changed', (payload) => {
      this.queueIngressTargetReconciliation((payload as { id?: string })?.id);
    });
    bus.subscribe('node.ingress_addresses.changed', (payload) => {
      this.queueIngressTargetReconciliation((payload as { id?: string })?.id);
    });
    bus.subscribe('integration.connector.changed', (payload) => {
      const event = payload as { provider?: string; action?: string } | undefined;
      if (
        event?.provider === 'cloudflare' &&
        ['created', 'updated', 'token-rotated', 'tested', 'synced', 'deleted'].includes(event.action ?? '')
      ) {
        this.queueCloudflareMigration();
      }
    });
  }

  setIntegrationsService(service: IntegrationsService) {
    this.integrationsService = service;
  }

  setNodeRegistryService(service: NodeRegistryService) {
    this.nodeRegistry = service;
  }

  setProxyService(service: ProxyService) {
    this.proxyService = service;
  }

  setPageProfileService(service: PageProfileService) {
    this.pageProfileService = service;
  }

  startIngressTargetReconciliation() {
    this.queueIngressTargetReconciliation();
  }

  startCloudflareMigration() {
    this.queueCloudflareMigration();
  }

  protected emitDomain(id: string, action: string, domain?: string) {
    this.eventBus?.publish('domain.changed', { id, action, domain });
  }

  async searchDomains(query: string, options?: { allowedIds?: string[] }) {
    const conditions = [ilike(domains.domain, `%${query}%`)];
    if (options?.allowedIds) conditions.push(inArray(domains.id, options.allowedIds));
    return this.db
      .select({
        id: domains.id,
        domain: domains.domain,
        dnsStatus: domains.dnsStatus,
        dnsProvider: domains.dnsProvider,
        nginxNodeId: domains.nginxNodeId,
        ingressGroupId: domains.ingressGroupId,
      })
      .from(domains)
      .where(and(...conditions))
      .orderBy(desc(domains.createdAt), asc(domains.domain))
      .limit(100);
  }

  protected async listNginxNodes() {
    return this.db
      .select({
        id: nodes.id,
        slug: nodes.slug,
        hostname: nodes.hostname,
        displayName: nodes.displayName,
        appearanceColor: nodes.appearanceColor,
        serviceAddresses: nodes.serviceAddresses,
        serviceAddress: nodes.serviceAddress,
        secondaryServiceAddress: nodes.secondaryServiceAddress,
        lastHealthReport: nodes.lastHealthReport,
        createdAt: nodes.createdAt,
      })
      .from(nodes)
      .where(eq(nodes.type, 'nginx'))
      .orderBy(asc(nodes.createdAt), asc(nodes.id));
  }

  protected getNodeEffectiveIngressAddresses(node: {
    id: string;
    serviceAddresses: string[];
    serviceAddress: string | null;
    secondaryServiceAddress: string | null;
    lastHealthReport: (typeof nodes.$inferSelect)['lastHealthReport'];
  }): string[] {
    return getEffectiveNginxIngressAddresses({
      serviceAddresses: node.serviceAddresses,
      serviceAddress: node.serviceAddress,
      secondaryServiceAddress: node.secondaryServiceAddress,
      lastHealthReport: this.nodeRegistry?.getNode(node.id)?.lastHealthReport ?? node.lastHealthReport,
    });
  }

  protected async resolveRequestedNginxNode(nginxNodeId?: string): Promise<EligibleNginxNode> {
    const options = await this.getNginxNodeOptions();
    if (options.totalNginxNodes === 0) {
      throw new AppError(409, 'DOMAIN_NGINX_NODE_MISSING', 'Add an Nginx node before creating a domain');
    }
    if (options.eligibleNodes.length === 0) {
      throw new AppError(
        409,
        'DOMAIN_NGINX_ADDRESS_REQUIRED',
        'Configure a detected public service address in Nginx node Settings before creating a domain'
      );
    }
    if (nginxNodeId) {
      const selected = options.eligibleNodes.find((node) => node.id === nginxNodeId);
      if (!selected) {
        throw new AppError(400, 'DOMAIN_NGINX_NODE_INELIGIBLE', 'Selected Nginx node has no public ingress address');
      }
      return selected;
    }
    if (options.eligibleNodes.length === 1) return options.eligibleNodes[0]!;
    throw domainNginxNodeRequiredError(options.eligibleNodes);
  }

  protected async getNginxNodeSummary(nodeId: string): Promise<EligibleNginxNode | null> {
    const options = await this.getNginxNodeOptions();
    const eligible = options.eligibleNodes.find((node) => node.id === nodeId);
    if (eligible) return eligible;
    const [row] = await this.db
      .select({
        id: nodes.id,
        slug: nodes.slug,
        hostname: nodes.hostname,
        displayName: nodes.displayName,
        appearanceColor: nodes.appearanceColor,
      })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    return row ? { ...row, effectiveAddress: '', effectiveAddresses: [] } : null;
  }

  protected queueIngressTargetReconciliation(nodeId?: string) {
    if (this.ingressReconcileRunning) {
      this.ingressReconcileQueued = true;
      return;
    }
    this.ingressReconcileRunning = true;
    void this.reconcileIngressTargets(nodeId)
      .catch((error) => {
        logger.error('Domain ingress target reconciliation failed', {
          nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.ingressReconcileRunning = false;
        if (this.ingressReconcileQueued) {
          this.ingressReconcileQueued = false;
          this.queueIngressTargetReconciliation();
        }
      });
  }

  protected queueCloudflareMigration() {
    if (this.cloudflareMigrationRunning) {
      this.cloudflareMigrationQueued = true;
      return;
    }
    this.cloudflareMigrationRunning = true;
    void this.migrateExternalDomainsToCloudflare()
      .catch((error) => {
        logger.error('External Domain Cloudflare migration failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.cloudflareMigrationRunning = false;
        if (this.cloudflareMigrationQueued) {
          this.cloudflareMigrationQueued = false;
          this.queueCloudflareMigration();
        }
      });
  }

  async migrateExternalDomainsToCloudflare() {
    if (!this.integrationsService) return;
    if (!(await this.integrationsService.hasEnabledCloudflareConnector())) {
      await this.clearExternalCloudflareMigrationStatuses();
      return;
    }
    await this.backfillNginxNodeAssignments();
    const externalDomains = await this.db.select().from(domains).where(eq(domains.dnsProvider, 'legacy'));
    for (const row of externalDomains) {
      if (row.cloudflareMigrationStatus === 'ignored') continue;
      await this.migrateExternalDomainToCloudflare(row);
    }
  }

  async resolveCloudflareMigration(
    id: string,
    input: ResolveCloudflareMigrationInput,
    userId: string,
    actorScopes: string[] = []
  ) {
    const [row] = await this.db.select().from(domains).where(eq(domains.id, id)).limit(1);
    if (!row) throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found');
    if (row.dnsProvider !== 'legacy') {
      throw new AppError(409, 'DOMAIN_ALREADY_CLOUDFLARE_MANAGED', 'Domain is already managed by Cloudflare');
    }

    if (input.action === 'keep_external') {
      const checkedAt = new Date();
      await this.setCloudflareMigrationStatus(row, 'ignored', checkedAt);
      await this.auditService.log({
        userId,
        action: 'domain.cloudflare_migration.keep_external',
        resourceType: 'domain',
        resourceId: row.id,
        details: { domain: row.domain },
      });
      return this.getDomain(id);
    }

    if (input.action === 'retry') {
      await this.migrateExternalDomainToCloudflare(row);
      return this.getDomain(id);
    }

    if (!this.integrationsService) {
      throw new AppError(409, 'CLOUDFLARE_DNS_NOT_CONFIGURED', 'Cloudflare DNS integration is not configured');
    }
    const nginxNode = await this.resolveRequestedNginxNode(input.nginxNodeId);
    // Re-pointing DNS and the domain's ingress node moves traffic for every
    // covered proxy host, so this needs the same grants as migrateIngress.
    assertDomainIngressMoveAccess(actorScopes, nginxNode.id, (await this.getUsage(row.domain)).proxyHosts);
    const context = await this.integrationsService.resolveCloudflareDnsContext(row.domain);
    const providerRecords = (await context.client.listDnsRecords(context.zone.remoteId, row.domain)).filter(
      (record) => record.name.toLowerCase() === row.domain.toLowerCase()
    );
    const addressRecords = providerRecords.filter((record) => record.type === 'A' || record.type === 'AAAA');
    if (providerRecords.some((record) => record.type === 'CNAME')) {
      throw new AppError(
        409,
        'CLOUDFLARE_DNS_RECORD_CONFLICT',
        'Remove the existing CNAME before Opfield can update this domain'
      );
    }

    const primary = addressRecords[0];
    const ttl = primary?.ttl ?? row.dnsTtl ?? context.settings.defaultTtl;
    const proxied = primary?.proxied ?? row.dnsProxied ?? context.settings.defaultProxied;
    const existingIps = addressRecords.map((record) => record.content).sort();
    const existingMatches = this.isNonEmptySubset(existingIps, this.getAllowedIngressAddresses(nginxNode));
    const desiredType = isIP(nginxNode.effectiveAddress) === 6 ? ('AAAA' as const) : ('A' as const);
    let providerRecordIds: string[];
    let targetIps: string[];
    let ownership: 'matched_existing' | 'overwritten' | 'created';

    if (existingMatches) {
      providerRecordIds = addressRecords.map((record) => record.id);
      targetIps = existingIps;
      ownership = 'matched_existing';
    } else if (primary) {
      const updated = await context.client.updateDnsRecord(context.zone.remoteId, primary.id, {
        type: desiredType,
        name: row.domain,
        content: nginxNode.effectiveAddress,
        ttl,
        proxied,
      });
      providerRecordIds = [updated.id];
      targetIps = [nginxNode.effectiveAddress];
      ownership = 'overwritten';
      for (const extra of addressRecords.slice(1)) {
        await context.client.deleteDnsRecord(context.zone.remoteId, extra.id);
      }
    } else {
      const created = await context.client.createDnsRecord(context.zone.remoteId, {
        type: desiredType,
        name: row.domain,
        content: nginxNode.effectiveAddress,
        ttl,
        proxied,
        comment: `wiolett-gateway:domain:${row.id}`,
      });
      providerRecordIds = [created.id];
      targetIps = [nginxNode.effectiveAddress];
      ownership = 'created';
    }

    const checkedAt = new Date();
    const [migrated] = await this.db
      .update(domains)
      .set({
        dnsProvider: 'cloudflare',
        dnsOwnership: ownership,
        integrationConnectorId: context.connector.id,
        providerZoneId: context.zone.remoteId,
        providerZoneName: context.zone.name,
        providerRecordIds,
        dnsRecordType: this.recordTypeLabel(targetIps),
        dnsTargetIps: targetIps,
        dnsRecords: this.dnsRecordsFromTargetIps(targetIps),
        dnsTtl: ttl,
        dnsProxied: proxied,
        nginxNodeId: nginxNode.id,
        pendingDnsTargetIp: null,
        cloudflareMigrationStatus: 'migrated',
        cloudflareMigrationCheckedAt: checkedAt,
        dnsStatus: 'valid',
        updatedAt: checkedAt,
      })
      .where(and(eq(domains.id, row.id), eq(domains.dnsProvider, 'legacy')))
      .returning();
    if (!migrated) {
      throw new AppError(409, 'DOMAIN_MIGRATION_STATE_CHANGED', 'Domain migration state changed; reload and retry');
    }
    await this.auditService.log({
      userId,
      action: 'domain.cloudflare_migration.resolve_conflict',
      resourceType: 'domain',
      resourceId: row.id,
      details: {
        domain: row.domain,
        nginxNodeId: nginxNode.id,
        targetIps,
        recordIds: providerRecordIds,
        ownership,
      },
    });
    this.emitDomain(row.id, 'updated', row.domain);
    return this.getDomain(id);
  }

  protected async clearExternalCloudflareMigrationStatuses() {
    const resettableMigration = and(
      eq(domains.dnsProvider, 'legacy'),
      isNotNull(domains.cloudflareMigrationStatus),
      sql`${domains.cloudflareMigrationStatus} <> 'ignored'`
    );
    const staleDomains = await this.db
      .select({ id: domains.id, domain: domains.domain })
      .from(domains)
      .where(resettableMigration);
    if (staleDomains.length === 0) return;

    await this.db
      .update(domains)
      .set({ cloudflareMigrationStatus: null, cloudflareMigrationCheckedAt: null, updatedAt: new Date() })
      .where(resettableMigration);
    for (const domain of staleDomains) this.emitDomain(domain.id, 'updated', domain.domain);
  }

  protected async migrateExternalDomainToCloudflare(row: typeof domains.$inferSelect) {
    const checkedAt = new Date();
    await this.setCloudflareMigrationStatus(row, 'pending', checkedAt);
    if (!row.nginxNodeId) {
      await this.setCloudflareMigrationStatus(row, 'ingress_unavailable', checkedAt);
      return;
    }
    const node = await this.getNginxNodeSummary(row.nginxNodeId);
    if (!node?.effectiveAddress) {
      await this.setCloudflareMigrationStatus(row, 'ingress_unavailable', checkedAt);
      return;
    }

    try {
      const context = await this.integrationsService!.resolveCloudflareDnsContext(row.domain);
      const providerRecords = (await context.client.listDnsRecords(context.zone.remoteId, row.domain)).filter(
        (record) => record.name.toLowerCase() === row.domain.toLowerCase()
      );
      const addressRecords = providerRecords.filter((record) => record.type === 'A' || record.type === 'AAAA');
      const blockingRecords = providerRecords.filter((record) => record.type === 'CNAME');
      const providerIps = addressRecords.map((record) => record.content).sort();
      if (blockingRecords.length > 0 || !this.isNonEmptySubset(providerIps, this.getAllowedIngressAddresses(node))) {
        await this.setCloudflareMigrationStatus(row, 'dns_conflict', checkedAt);
        return;
      }
      const targetIps = providerIps;

      const primaryRecord = addressRecords[0]!;
      const [migrated] = await this.db
        .update(domains)
        .set({
          dnsProvider: 'cloudflare',
          dnsOwnership: 'matched_existing',
          integrationConnectorId: context.connector.id,
          providerZoneId: context.zone.remoteId,
          providerZoneName: context.zone.name,
          providerRecordIds: addressRecords.map((record) => record.id),
          dnsRecordType: this.recordTypeLabel(targetIps),
          dnsTargetIps: targetIps,
          dnsTtl: primaryRecord.ttl,
          dnsProxied: primaryRecord.proxied ?? false,
          pendingDnsTargetIp: null,
          cloudflareMigrationStatus: 'migrated',
          cloudflareMigrationCheckedAt: checkedAt,
          dnsStatus: 'valid',
          updatedAt: new Date(),
        })
        .where(and(eq(domains.id, row.id), eq(domains.dnsProvider, 'legacy')))
        .returning();
      if (!migrated) return;
      await this.auditService.log({
        userId: null,
        action: 'domain.cloudflare_migration.migrate',
        resourceType: 'domain',
        resourceId: row.id,
        details: {
          domain: row.domain,
          connectorId: context.connector.id,
          zoneId: context.zone.remoteId,
          recordIds: addressRecords.map((record) => record.id),
          targetIps,
        },
      });
      this.emitDomain(row.id, 'updated', row.domain);
    } catch (error) {
      const code = error instanceof AppError ? error.code : undefined;
      await this.setCloudflareMigrationStatus(
        row,
        code === 'CLOUDFLARE_ZONE_NOT_FOUND'
          ? 'zone_unavailable'
          : code === 'CLOUDFLARE_ZONE_AMBIGUOUS'
            ? 'zone_ambiguous'
            : 'error',
        checkedAt
      );
    }
  }

  protected async setCloudflareMigrationStatus(
    row: typeof domains.$inferSelect,
    status: NonNullable<typeof domains.$inferInsert.cloudflareMigrationStatus>,
    checkedAt: Date
  ) {
    await this.db
      .update(domains)
      .set({ cloudflareMigrationStatus: status, cloudflareMigrationCheckedAt: checkedAt, updatedAt: new Date() })
      .where(and(eq(domains.id, row.id), eq(domains.dnsProvider, 'legacy')));
    if (status !== 'pending') this.emitDomain(row.id, 'updated', row.domain);
  }

  async reconcileIngressTargets(nodeId?: string) {
    await this.backfillNginxNodeAssignments();
    const rows = await this.db
      .select()
      .from(domains)
      .where(nodeId ? domainsServedByNode(this.db, nodeId) : undefined);
    for (const row of rows) {
      if (row.ingressGroupId) {
        // A domain on an ingress group publishes the union of its active members' addresses.
        await this.reconcileIngressGroupDomain(row);
        continue;
      }
      if (!row.nginxNodeId) continue;
      const node = await this.getNginxNodeSummary(row.nginxNodeId);
      if (!node?.effectiveAddress || this.getAllowedIngressAddresses(node).length === 0) {
        if (row.dnsStatus !== 'invalid') {
          await this.db
            .update(domains)
            .set({ dnsStatus: 'invalid', updatedAt: new Date() })
            .where(eq(domains.id, row.id));
          this.emitDomain(row.id, 'updated', row.domain);
        }
        continue;
      }
      if (row.dnsProvider !== 'cloudflare') {
        const probe = await probeDnsRecords(row.domain);
        const dnsStatus = this.externalDnsStatus(
          probe.addressResolution,
          probe.records,
          this.getAllowedIngressAddresses(node)
        );
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
        continue;
      }
      const effectiveTargetChanged = !this.isNonEmptySubset(row.dnsTargetIps, this.getAllowedIngressAddresses(node));
      const hasDurableRetargetApproval = row.pendingDnsTargetIp === node.effectiveAddress;
      let reconciliationRow = row;
      if (effectiveTargetChanged && !hasDurableRetargetApproval) {
        const [approved] = await this.db
          .update(domains)
          .set({ pendingDnsTargetIp: node.effectiveAddress, updatedAt: new Date() })
          .where(
            and(eq(domains.id, row.id), eq(domains.nginxNodeId, row.nginxNodeId), eq(domains.dnsProvider, 'cloudflare'))
          )
          .returning();
        if (!approved) continue;
        reconciliationRow = approved;
      }
      await this.reconcileDomainTarget(
        reconciliationRow,
        effectiveTargetChanged ? node.effectiveAddress : row.dnsTargetIps
      );
    }
  }

  protected async backfillNginxNodeAssignments() {
    const unassigned = await this.db.select().from(domains).where(isNull(domains.nginxNodeId));
    if (unassigned.length === 0) return;
    const options = await this.getNginxNodeOptions();
    if (options.eligibleNodes.length === 0) return;

    for (const row of unassigned) {
      const usage = await this.getUsage(row.domain);
      const usedNodeIds = usage.proxyHosts.map((host) => host.nodeId);
      const selected = selectBackfillNginxNode(options.eligibleNodes, usedNodeIds);
      if (!selected) {
        logger.warn('Domain Nginx node assignment remains unresolved', {
          domainId: row.id,
          reason: usedNodeIds.some((usedNodeId) => !usedNodeId)
            ? 'proxy_host_node_unassigned'
            : new Set(usedNodeIds).size > 1
              ? 'multiple_proxy_host_nodes'
              : 'proxy_host_node_ineligible',
        });
        continue;
      }

      const [assigned] = await this.db
        .update(domains)
        .set({ nginxNodeId: selected.id, pendingDnsTargetIp: null, updatedAt: new Date() })
        .where(sql`${domains.id} = ${row.id} AND ${domains.nginxNodeId} IS NULL`)
        .returning();
      if (!assigned) continue;
      await this.auditService.log({
        userId: null,
        action: 'domain.nginx_node.assign',
        resourceType: 'domain',
        resourceId: row.id,
        details: { nginxNodeId: selected.id, source: usedNodeIds.length === 0 ? 'first_eligible' : 'proxy_host' },
      });
    }
  }

  protected async reconcileDomainTarget(row: typeof domains.$inferSelect, target: string | string[]) {
    const targetIps = Array.from(new Set(Array.isArray(target) ? target : [target]));
    const primaryTarget = targetIps[0];
    if (!primaryTarget) return;
    if (
      row.dnsProvider !== 'cloudflare' ||
      !this.integrationsService ||
      !row.integrationConnectorId ||
      !row.providerZoneId ||
      row.providerRecordIds.length === 0
    ) {
      if (row.dnsProvider === 'cloudflare') {
        await this.db
          .update(domains)
          .set({ dnsStatus: 'invalid', updatedAt: new Date() })
          .where(eq(domains.id, row.id));
      }
      return;
    }

    try {
      const context = await this.integrationsService.getCloudflareDnsContextForRecord(
        row.integrationConnectorId,
        row.providerZoneId
      );
      const records = (await context.client.listDnsRecords(context.zone.remoteId, row.domain)).filter(
        (record) => record.name.toLowerCase() === row.domain.toLowerCase()
      );
      const recordsById = new Map(records.map((record) => [record.id, record]));
      const trackedRecordIds = new Set(row.providerRecordIds);
      const recoveryComment = `wiolett-gateway:domain:${row.id}`;
      const trackedAddressRecords = row.providerRecordIds.flatMap((id) => {
        const record = recordsById.get(id);
        return record && (record.type === 'A' || record.type === 'AAAA') ? [record] : [];
      });
      const recoveredAddressRecords = records.filter(
        (record) =>
          (record.type === 'A' || record.type === 'AAAA') &&
          record.comment === recoveryComment &&
          !trackedRecordIds.has(record.id)
      );
      const ownedAddressRecords = [...trackedAddressRecords, ...recoveredAddressRecords];
      const untrackedConflicts = records.filter(
        (record) =>
          record.type === 'CNAME' ||
          ((record.type === 'A' || record.type === 'AAAA') &&
            !trackedRecordIds.has(record.id) &&
            record.comment !== recoveryComment)
      );
      if (untrackedConflicts.length > 0) {
        throw new AppError(
          409,
          'CLOUDFLARE_DNS_RECORD_CONFLICT',
          'Untracked Cloudflare address records occupy the managed domain'
        );
      }
      const firstOwned = ownedAddressRecords[0];
      const desiredTtl = row.dnsTtl ?? firstOwned?.ttl ?? 1;
      const desiredProxied = row.dnsProxied ?? firstOwned?.proxied ?? false;
      const unusedOwned = [...ownedAddressRecords];
      const providerRecordIds: string[] = [];
      let providerChanged = false;
      for (const targetIp of targetIps) {
        const desiredType = isIP(targetIp) === 6 ? ('AAAA' as const) : ('A' as const);
        let recordIndex = unusedOwned.findIndex((record) => record.type === desiredType && record.content === targetIp);
        if (recordIndex < 0 && unusedOwned.length > 0) recordIndex = 0;
        const record = recordIndex >= 0 ? unusedOwned.splice(recordIndex, 1)[0] : undefined;
        if (!record) {
          const created = await context.client.createDnsRecord(context.zone.remoteId, {
            type: desiredType,
            name: row.domain,
            content: targetIp,
            ttl: desiredTtl,
            proxied: desiredProxied,
            comment: recoveryComment,
          });
          providerRecordIds.push(created.id);
          providerChanged = true;
          continue;
        }
        const matches =
          record.type === desiredType &&
          record.name === row.domain &&
          record.content === targetIp &&
          record.ttl === desiredTtl &&
          (record.proxied ?? false) === desiredProxied;
        if (!matches) {
          await context.client.updateDnsRecord(context.zone.remoteId, record.id, {
            type: desiredType,
            name: row.domain,
            content: targetIp,
            ttl: desiredTtl,
            proxied: desiredProxied,
          });
          providerChanged = true;
        }
        providerRecordIds.push(record.id);
      }
      for (const record of unusedOwned) {
        await context.client.deleteDnsRecord(context.zone.remoteId, record.id);
        providerChanged = true;
      }
      const snapshotMatches =
        this.sameStringSet(row.providerRecordIds, providerRecordIds) &&
        row.dnsRecordType === this.recordTypeLabel(targetIps) &&
        this.sameStringSet(row.dnsTargetIps, targetIps) &&
        row.dnsStatus === 'valid' &&
        row.pendingDnsTargetIp === null;
      if (!providerChanged && snapshotMatches) return;
      await this.persistReconciledDomainTarget(row, targetIps, providerRecordIds);
    } catch (error) {
      await this.db
        .update(domains)
        .set({ dnsStatus: 'invalid', updatedAt: new Date() })
        .where(this.reconciliationTargetCondition(row.id, targetIps));
      await this.auditService.log({
        userId: null,
        action: 'domain.dns_target.reconcile_failed',
        resourceType: 'domain',
        resourceId: row.id,
        details: { nginxNodeId: row.nginxNodeId, targetIps },
      });
      logger.error('Failed to reconcile tracked Cloudflare domain target', {
        domainId: row.id,
        nginxNodeId: row.nginxNodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  protected async persistReconciledDomainTarget(
    row: typeof domains.$inferSelect,
    targetIps: string[],
    providerRecordIds: string[]
  ) {
    await this.db
      .update(domains)
      .set({
        providerRecordIds,
        dnsRecordType: this.recordTypeLabel(targetIps),
        dnsTargetIps: targetIps,
        dnsRecords: this.dnsRecordsFromTargetIps(targetIps),
        dnsStatus: 'valid',
        pendingDnsTargetIp: null,
        updatedAt: new Date(),
      })
      .where(this.reconciliationTargetCondition(row.id, targetIps));
    await this.auditService.log({
      userId: null,
      action: 'domain.dns_target.reconcile',
      resourceType: 'domain',
      resourceId: row.id,
      details: { nginxNodeId: row.nginxNodeId, targetIps, recordIds: providerRecordIds },
    });
    this.emitDomain(row.id, 'updated', row.domain);
  }

  /**
   * Where a new domain is served and which addresses its DNS gets: one node (its first effective address), or an
   * ingress group (overridden by DomainsServiceIngressGroups: the union of the active members' addresses).
   */
  protected async resolveDomainIngressPlacement(
    input: Pick<PreviewDomainInput, 'nginxNodeId' | 'ingressGroupId'>
  ): Promise<DomainIngressPlacement> {
    const nginxNode = await this.resolveRequestedNginxNode(input.nginxNodeId);
    return {
      nginxNode,
      ingressGroupId: null,
      targetIps: [nginxNode.effectiveAddress],
      allowedIps: this.getAllowedIngressAddresses(nginxNode),
    };
  }

  protected async prepareCloudflareDomain(input: PreviewDomainInput): Promise<DomainCloudflarePlan> {
    if (!this.integrationsService) {
      throw new AppError(409, 'CLOUDFLARE_DNS_NOT_CONFIGURED', 'Cloudflare DNS integration is not configured');
    }
    const domainName = input.domain.toLowerCase();
    const placement = await this.resolveDomainIngressPlacement(input);
    const nginxNode = placement.nginxNode;
    const primaryTargetIps = placement.targetIps;
    const context = await this.integrationsService.resolveCloudflareDnsContext(domainName);
    const ttl = input.ttl ?? context.settings.defaultTtl;
    const proxied = input.proxied ?? context.settings.defaultProxied;
    const existingRecords = (await context.client.listDnsRecords(context.zone.remoteId, domainName)).filter(
      (record) => record.name === domainName
    ) as CloudflareAddressRecord[];
    const addressRecords = existingRecords.filter((record) => record.type === 'A' || record.type === 'AAAA');
    const blockingRecords = existingRecords.filter((record) => record.type === 'CNAME');
    const currentIps = addressRecords.map((record) => record.content).sort();
    const currentMatches = this.isNonEmptySubset(currentIps, placement.allowedIps);
    const targetIps = currentMatches ? currentIps : primaryTargetIps;
    const desiredIps = [...targetIps].sort();
    const desiredRecords = this.desiredCloudflareRecords(domainName, desiredIps, ttl, proxied);
    return {
      domainName,
      nginxNode,
      ingressGroupId: placement.ingressGroupId,
      placementTargetIps: placement.targetIps,
      targetIps,
      ttl,
      proxied,
      context,
      addressRecords,
      blockingRecords,
      currentIps,
      desiredIps,
      currentMatches,
      desiredRecords,
    };
  }

  protected async prepareExternalDomain(input: PreviewDomainInput): Promise<DomainExternalPlan> {
    const domainName = input.domain.toLowerCase();
    const placement = await this.resolveDomainIngressPlacement(input);
    const nginxNode = placement.nginxNode;
    const probe = await probeDnsRecords(domainName);
    const status = this.externalDnsStatus(probe.addressResolution, probe.records, placement.allowedIps);
    const resolvedIps = [...probe.records.a, ...probe.records.aaaa].sort();
    const targetIps =
      status === 'valid' ? resolvedIps : placement.ingressGroupId ? placement.targetIps : placement.allowedIps;
    return {
      domainName,
      nginxNode,
      ingressGroupId: placement.ingressGroupId,
      targetIps,
      queryName: probe.queryName,
      dnsRecords: probe.records,
      status,
    };
  }

  protected externalDnsStatus(
    addressResolution: DnsAddressResolution,
    records: DnsRecords,
    allowedIps: string[]
  ): 'valid' | 'invalid' | 'pending' | 'unknown' {
    if (addressResolution === 'error') return 'unknown';
    const resolvedIps = [...records.a, ...records.aaaa].sort();
    if (resolvedIps.length === 0) return 'pending';
    return this.isNonEmptySubset(resolvedIps, allowedIps) ? 'valid' : 'invalid';
  }

  protected async computeDomainDnsStatus(
    row: typeof domains.$inferSelect,
    resolvedRecords: DnsRecords,
    addressResolution: DnsAddressResolution = 'resolved',
    managedCloudflareRecords?: CloudflareDnsRecord[]
  ): Promise<'valid' | 'invalid' | 'pending' | 'unknown'> {
    if (row.dnsProvider === 'cloudflare' && (row.nginxNodeId || row.ingressGroupId)) {
      const allowed = await this.allowedIngressAddressesFor(row);
      if (!allowed?.length || !this.isNonEmptySubset(row.dnsTargetIps, allowed)) {
        return 'invalid';
      }
    }
    if (row.dnsProvider !== 'cloudflare') {
      if (!row.nginxNodeId && !row.ingressGroupId) return 'unknown';
      const allowed = await this.allowedIngressAddressesFor(row);
      if (!allowed?.length) return 'invalid';
      return this.externalDnsStatus(addressResolution, resolvedRecords, allowed);
    }
    const expectedIps = row.dnsTargetIps;
    if (expectedIps.length === 0) return 'unknown';

    if (this.integrationsService && row.integrationConnectorId && row.providerZoneId) {
      const providerRecords = managedCloudflareRecords ?? (await this.getManagedCloudflareDnsRecords(row)) ?? [];
      const addressRecords = providerRecords.filter((record) => record.type === 'A' || record.type === 'AAAA');
      const providerIps = addressRecords.map((record) => record.content).sort();
      if (!this.sameStringSet(providerIps, [...expectedIps].sort())) return 'invalid';
      if (addressRecords.some((record) => record.proxied === true)) return 'valid';
      // A managed non-proxied record is still authoritative when the public
      // resolver itself is unavailable. Do not downgrade a confirmed
      // Cloudflare target to pending because UDP DNS timed out or failed;
      // genuine missing records are reported as `empty` and remain pending.
      if (addressResolution === 'error') return 'valid';
    }

    const resolvedIps = [...resolvedRecords.a, ...resolvedRecords.aaaa].sort();
    if (resolvedIps.length === 0) return 'pending';
    return this.sameStringSet(resolvedIps, [...expectedIps].sort()) ? 'valid' : 'pending';
  }

  protected async getManagedCloudflareDnsRecords(
    row: typeof domains.$inferSelect
  ): Promise<CloudflareDnsRecord[] | undefined> {
    if (
      row.dnsProvider !== 'cloudflare' ||
      !this.integrationsService ||
      !row.integrationConnectorId ||
      !row.providerZoneId
    ) {
      return undefined;
    }
    const context = await this.integrationsService.getCloudflareDnsContextForRecord(
      row.integrationConnectorId,
      row.providerZoneId
    );
    return (await context.client.listDnsRecords(context.zone.remoteId, row.domain)).filter(
      (record) => record.name.toLowerCase() === row.domain.toLowerCase()
    );
  }

  protected dnsRecordsForSnapshot(
    row: typeof domains.$inferSelect,
    resolvedRecords: DnsRecords,
    managedCloudflareRecords?: CloudflareDnsRecord[]
  ): DnsRecords {
    if (row.dnsProvider !== 'cloudflare' || row.dnsProxied !== false || !managedCloudflareRecords) {
      return resolvedRecords;
    }
    return {
      ...resolvedRecords,
      a: managedCloudflareRecords
        .filter((record) => record.type === 'A')
        .map((record) => record.content)
        .sort(),
      aaaa: managedCloudflareRecords
        .filter((record) => record.type === 'AAAA')
        .map((record) => record.content)
        .sort(),
    };
  }

  protected async externalTargetSnapshotUpdate(
    row: typeof domains.$inferSelect,
    dnsStatus: 'valid' | 'invalid' | 'pending' | 'unknown',
    resolvedRecords: DnsRecords
  ): Promise<Partial<typeof domains.$inferInsert>> {
    if (row.dnsProvider === 'cloudflare' || dnsStatus !== 'valid' || (!row.nginxNodeId && !row.ingressGroupId)) {
      return {};
    }
    const allowed = await this.allowedIngressAddressesFor(row);
    if (!allowed?.length) return {};
    const resolvedIps = [...resolvedRecords.a, ...resolvedRecords.aaaa].sort();
    if (!this.isNonEmptySubset(resolvedIps, allowed)) return {};
    if (this.sameStringSet(row.dnsTargetIps, resolvedIps)) return {};
    return {
      dnsTargetIps: resolvedIps,
      dnsRecordType: this.recordTypeLabel(resolvedIps),
      pendingDnsTargetIp: null,
    };
  }

  protected desiredCloudflareRecords(domain: string, ips: string[], ttl: number, proxied: boolean) {
    return ips.map((ip) => ({
      type: isIP(ip) === 6 ? ('AAAA' as const) : ('A' as const),
      name: domain,
      content: ip,
      ttl,
      proxied,
    }));
  }

  protected dnsRecordsFromTargetIps(ips: string[]): DnsRecords {
    return {
      a: ips.filter((ip) => isIP(ip) === 4),
      aaaa: ips.filter((ip) => isIP(ip) === 6),
      cname: [],
      caa: [],
      mx: [],
      txt: [],
    };
  }

  protected sameStringSet(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false;
    const rightSet = new Set(right);
    return left.every((value) => rightSet.has(value));
  }

  protected isNonEmptySubset(values: string[], allowedValues: string[]): boolean {
    if (values.length === 0) return false;
    const allowed = new Set(allowedValues);
    return values.every((value) => allowed.has(value));
  }

  protected getAllowedIngressAddresses(node: Pick<EligibleNginxNode, 'effectiveAddress' | 'effectiveAddresses'>) {
    return node.effectiveAddresses?.length
      ? node.effectiveAddresses
      : node.effectiveAddress
        ? [node.effectiveAddress]
        : [];
  }

  protected reconciliationTargetCondition(domainId: string, targetIps: string[]) {
    const primaryTarget = targetIps[0];
    return and(
      eq(domains.id, domainId),
      or(
        ...(primaryTarget ? [eq(domains.pendingDnsTargetIp, primaryTarget)] : []),
        and(isNull(domains.pendingDnsTargetIp), sql`${domains.dnsTargetIps} = ${JSON.stringify(targetIps)}::jsonb`)
      )
    );
  }

  /**
   * The addresses DNS of a domain may point at: its node's ingress addresses, or for a domain on an ingress group
   * the union over every serving member (see DomainsServiceIngressGroups). Null when the domain has no node.
   */
  protected async allowedIngressAddressesFor(
    row: Pick<typeof domains.$inferSelect, 'nginxNodeId' | 'ingressGroupId'>
  ): Promise<string[] | null> {
    if (!row.nginxNodeId) return null;
    const node = await this.getNginxNodeSummary(row.nginxNodeId);
    if (!node?.effectiveAddress) return null;
    return this.getAllowedIngressAddresses(node);
  }

  /** Brings a domain on an ingress group in line with its members (implemented by DomainsServiceIngressGroups). */
  protected async reconcileIngressGroupDomain(_row: typeof domains.$inferSelect): Promise<void> {}

  protected recordTypeLabel(ips: string[]): string {
    const types = new Set(ips.map((ip) => (isIP(ip) === 6 ? 'AAAA' : 'A')));
    return [...types].sort().join('/');
  }
}
