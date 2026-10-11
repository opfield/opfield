import { isIP } from 'node:net';
import bcrypt from 'bcryptjs';
import { and, asc, count, eq, ilike, inArray, isNotNull, notInArray, or, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor, DrizzleTransaction } from '@/db/client.js';
import {
  dockerDeployments,
  domains,
  hostingNodeBindings,
  hostingOperations,
  hostingResources,
  ingressGroupMembers,
  ingressGroups,
  managedDatabaseInstances,
  nodes,
  proxyHosts,
  relayAssignmentSourceProbes,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayInstances,
  relayPoolUpdateSteps,
} from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { createChildLogger } from '@/lib/logger.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { lockHostingFirewalls } from '@/modules/hosting/hosting-firewall-lock.js';
import { type LicenseQuotaService, requireConfiguredLicenseQuota } from '@/modules/license/license-quota.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { DaemonUpdateService } from '@/services/daemon-update.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { GrpcIdentityService } from '@/services/grpc-identity.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { bumpRelayPolicyRevision } from '@/services/relay-policy-reconciler.js';
import { parkedDrainedAssignmentIds } from '@/services/relay-topology.js';
import type { SystemCertificateLifecycleService } from '@/services/system-certificate-lifecycle.service.js';
import { createNodeEnrollmentToken, nodeEnrollmentTokenExpiresAt } from './node-enrollment-token.js';
import {
  abortNodeFileUpload,
  appendNodeFileUploadChunk,
  completeNodeFileUpload,
  createNodeDirectory,
  createNodeFile,
  deleteNodeFile,
  initNodeFileUpload,
  listNodeFiles,
  moveNodeFile,
  readNodeFile,
  writeNodeFile,
} from './node-file-operations.js';
import {
  getConfiguredNodeServiceAddresses,
  getEffectiveNginxIngressAddress,
  getEffectiveNginxIngressAddresses,
  getEffectiveServiceAddressForNode,
  getReportedPublicNodeAddresses,
  isPubliclyRoutableIp,
} from './node-service-address.js';
import {
  createNodeFileOperationContext,
  isNonEmptyAddressSubset,
  orderedAddressesEqual,
  stripNodeHealthHistory,
} from './node-service-helpers.js';
import type {
  CreateNodeInput,
  NodeListQuery,
  UpdateNodeInput,
  UpdateNodeServiceCreationLockInput,
} from './nodes.schemas.js';
import { validateRelayRemoval } from './relay-removal.js';

const logger = createChildLogger('NodesService');

function activeHostingOperationForNode(id: string) {
  return and(
    notInArray(hostingOperations.phase, ['ready', 'failed']),
    or(
      and(inArray(hostingOperations.action, ['create', 'install']), eq(hostingOperations.nodeId, id)),
      and(
        eq(hostingOperations.action, 'delete'),
        sql`coalesce(${hostingOperations.result}->'destroyNodeIds', '[]'::jsonb) ? ${id}::text`
      )
    )
  );
}

export class NodesService {
  private daemonUpdateService?: DaemonUpdateService;
  private generalSettingsService?: GeneralSettingsService;
  private proxyService?: ProxyService;
  private systemCertificateLifecycle?: SystemCertificateLifecycleService;
  private licenseQuota?: LicenseQuotaService;
  private grpcPort = 9443;

  constructor(
    private db: DrizzleClient,
    private auditService: AuditService,
    private registry: NodeRegistryService,
    private grpcIdentityService: GrpcIdentityService,
    private nodeDispatch: NodeDispatchService
  ) {}

  private eventBus?: EventBusService;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }
  setDaemonUpdateService(service: DaemonUpdateService) {
    this.daemonUpdateService = service;
  }
  setGeneralSettingsService(service: GeneralSettingsService, grpcPort: number) {
    this.generalSettingsService = service;
    this.grpcPort = grpcPort;
  }
  setProxyService(service: ProxyService) {
    this.proxyService = service;
  }
  setSystemCertificateLifecycleService(service: SystemCertificateLifecycleService) {
    this.systemCertificateLifecycle = service;
  }
  setLicenseQuotaService(service: LicenseQuotaService) {
    this.licenseQuota = service;
  }
  private emitNode(id: string, action: 'created' | 'updated' | 'deleted', extra: Record<string, unknown> = {}) {
    this.eventBus?.publish('node.changed', { id, action, ...extra });
  }

  private nodeFileOperationContext() {
    return createNodeFileOperationContext(this.nodeDispatch, this.auditService, this.eventBus);
  }

  private async validateConnectedNode(id: string) {
    const [node] = await this.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, id)).limit(1);
    if (!node) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }
    if (!this.registry.getNode(id)) {
      throw new AppError(502, 'NODE_OFFLINE', 'Node is offline');
    }
  }

  async list(query: NodeListQuery, options?: { allowedIds?: string[] }) {
    const conditions: SQL[] = [];

    if (options?.allowedIds) {
      if (options.allowedIds.length === 0) {
        return {
          data: [],
          total: 0,
          page: query.page,
          limit: query.limit,
          totalPages: 0,
        };
      }
      conditions.push(inArray(nodes.id, options.allowedIds));
    }

    if (query.search) {
      conditions.push(ilike(nodes.hostname, `%${query.search}%`));
    }
    if (query.type) {
      conditions.push(
        query.type === 'storage' || query.type === 'databases'
          ? inArray(nodes.type, ['storage', 'databases'])
          : eq(nodes.type, query.type)
      );
    }
    if (query.status) {
      conditions.push(eq(nodes.status, query.status));
    }
    if (query.hosting === 'unmanaged') {
      conditions.push(
        notInArray(nodes.id, this.db.select({ id: hostingNodeBindings.nodeId }).from(hostingNodeBindings)),
        notInArray(
          nodes.id,
          this.db
            .select({ id: hostingOperations.nodeId })
            .from(hostingOperations)
            .where(and(isNotNull(hostingOperations.nodeId), isNotNull(hostingOperations.connectorId)))
        )
      );
    } else if (query.hosting) {
      conditions.push(
        or(
          inArray(
            nodes.id,
            this.db
              .select({ id: hostingNodeBindings.nodeId })
              .from(hostingNodeBindings)
              .innerJoin(hostingResources, eq(hostingResources.id, hostingNodeBindings.resourceId))
              .where(eq(hostingResources.connectorId, query.hosting))
          ),
          inArray(
            nodes.id,
            this.db
              .select({ id: hostingOperations.nodeId })
              .from(hostingOperations)
              .where(and(isNotNull(hostingOperations.nodeId), eq(hostingOperations.connectorId, query.hosting)))
          )
        )!
      );
    }

    const where = buildWhere(conditions);

    const [totalResult] = await this.db.select({ count: count() }).from(nodes).where(where);
    const total = totalResult?.count ?? 0;

    const offset = (query.page - 1) * query.limit;
    const rows = await this.db
      .select({
        id: nodes.id,
        type: nodes.type,
        hostname: nodes.hostname,
        displayName: nodes.displayName,
        slug: nodes.slug,
        appearanceColor: nodes.appearanceColor,
        serviceAddresses: nodes.serviceAddresses,
        serviceAddress: nodes.serviceAddress,
        secondaryServiceAddress: nodes.secondaryServiceAddress,
        status: nodes.status,
        serviceCreationLocked: nodes.serviceCreationLocked,
        daemonVersion: nodes.daemonVersion,
        osInfo: nodes.osInfo,
        configVersionHash: nodes.configVersionHash,
        capabilities: nodes.capabilities,
        lastSeenAt: nodes.lastSeenAt,
        lastHealthReport: nodes.lastHealthReport,
        lastStatsReport: nodes.lastStatsReport,
        metadata: nodes.metadata,
        folderId: nodes.folderId,
        sortOrder: nodes.sortOrder,
        createdAt: nodes.createdAt,
        updatedAt: nodes.updatedAt,
      })
      .from(nodes)
      .where(where)
      .orderBy(asc(nodes.sortOrder), asc(nodes.createdAt))
      .limit(query.limit)
      .offset(offset);

    // Enrich with live connection status. The registry is authoritative for
    // command availability; DB status can lag until stale-node cleanup runs.
    const enriched = rows.map((row) => {
      const isConnected = !!this.registry.getNode(row.id);
      return {
        ...row,
        publicServiceAddresses: row.type === 'nginx' ? getReportedPublicNodeAddresses(row) : undefined,
        effectiveServiceAddress: getEffectiveServiceAddressForNode(row),
        ...this.liveStatus(row, isConnected),
        isConnected,
      };
    });

    return {
      data: enriched,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  /** An online node away only because the local relay restarts, or restarted moments ago (local-relay-outage). */
  private awaitsLocalRelay(status: string, nodeId: string): boolean {
    return status === 'online' && this.registry.isAwaitingLocalRelay(nodeId);
  }

  /**
   * The status a node is shown with. A stream that closed moments ago keeps its status through the reconnect grace,
   * as the DB does, and so does a node that has not reconnected yet to a Gateway that started moments ago; a node
   * away for its daemon update stays reconnecting for the whole update, as does one away while the local relay
   * restarts.
   */
  private liveStatus(
    node: { id: string; status: string; metadata?: unknown },
    isConnected: boolean
  ): { status: string; reconnecting: boolean } {
    const awayForUpdate = node.status === 'online' && this.registry.isAwayForUpdate(node.id, node.metadata);
    return {
      status:
        node.status === 'online' && !isConnected && !awayForUpdate && !this.registry.isReconnecting(node.id)
          ? 'offline'
          : node.status,
      reconnecting: awayForUpdate || this.awaitsLocalRelay(node.status, node.id),
    };
  }

  async get(id: string) {
    const [node] = await this.db.select().from(nodes).where(eq(nodes.id, id)).limit(1);

    if (!node) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }

    const connectedNode = this.registry.getNode(id);
    const isConnected = !!connectedNode;
    const { enrollmentTokenHash: _hash, enrollmentTokenSelector: _selector, ...publicNode } = node;

    return {
      ...stripNodeHealthHistory(publicNode),
      publicServiceAddresses:
        node.type === 'nginx'
          ? getReportedPublicNodeAddresses({
              lastHealthReport: connectedNode?.lastHealthReport ?? node.lastHealthReport,
            })
          : undefined,
      effectiveServiceAddress: getEffectiveServiceAddressForNode({
        ...node,
        lastHealthReport: connectedNode?.lastHealthReport ?? node.lastHealthReport,
      }),
      ...this.liveStatus(node, isConnected),
      isConnected,
      liveHealthReport: connectedNode?.lastHealthReport ?? null,
      liveStatsReport: connectedNode?.lastStatsReport ?? null,
    };
  }

  async getBySlug(slug: string) {
    const [node] = await this.db.select().from(nodes).where(eq(nodes.slug, slug)).limit(1);

    if (!node) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }

    const connectedNode = this.registry.getNode(node.id);
    const isConnected = !!connectedNode;
    const { enrollmentTokenHash: _hash, enrollmentTokenSelector: _selector, ...publicNode } = node;

    return {
      ...stripNodeHealthHistory(publicNode),
      publicServiceAddresses:
        node.type === 'nginx'
          ? getReportedPublicNodeAddresses({
              lastHealthReport: connectedNode?.lastHealthReport ?? node.lastHealthReport,
            })
          : undefined,
      effectiveServiceAddress: getEffectiveServiceAddressForNode({
        ...node,
        lastHealthReport: connectedNode?.lastHealthReport ?? node.lastHealthReport,
      }),
      ...this.liveStatus(node, isConnected),
      isConnected,
      liveHealthReport: connectedNode?.lastHealthReport ?? null,
      liveStatsReport: connectedNode?.lastStatsReport ?? null,
    };
  }

  async getHealthHistory(id: string) {
    const [node] = await this.db
      .select({ healthHistory: nodes.healthHistory })
      .from(nodes)
      .where(eq(nodes.id, id))
      .limit(1);

    if (!node) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }

    return node.healthHistory ?? [];
  }

  async create(
    input: CreateNodeInput,
    userId: string,
    transaction?: DrizzleTransaction,
    options: { enrollmentTokenTtlMs?: number } = {}
  ) {
    // Generate enrollment token
    const enrollmentToken = createNodeEnrollmentToken();
    const tokenHash = await bcrypt.hash(enrollmentToken.token, 10);
    const enrollmentTokenExpiresAt = nodeEnrollmentTokenExpiresAt(new Date(), options.enrollmentTokenTtlMs);

    const createNode = (executor: DrizzleExecutor) =>
      writeWithAllocatedSlug({
        source: input.displayName?.trim() || input.hostname,
        fallback: 'node',
        reserved: ['file', 'console'],
        constraint: 'nodes_slug_unique',
        write: async (slug) => {
          const [created] = await executor
            .insert(nodes)
            .values({
              type: input.type,
              hostname: input.hostname,
              displayName: input.displayName,
              folderId: input.folderId ?? null,
              slug,
              enrollmentTokenSelector: enrollmentToken.selector,
              enrollmentTokenHash: tokenHash,
              enrollmentTokenExpiresAt,
              status: 'pending',
              serviceAddresses: input.type === 'relay' ? input.serviceAddresses : [],
              // Lets the creator, and only the creator, re-issue the enrollment token with nodes:create alone.
              // A relay keeps the port it was created with until enrollment records it on its relay instance.
              metadata: {
                createdById: userId,
                ...(input.type === 'relay' && input.servicePort ? { relayServicePort: input.servicePort } : {}),
              },
            })
            .returning();
          return created;
        },
      });
    const quota = requireConfiguredLicenseQuota(this.licenseQuota);
    const countNodes = async (tx: DrizzleTransaction) => {
      const [result] = await tx.select({ count: count() }).from(nodes);
      return Number(result?.count ?? 0);
    };
    const node = transaction
      ? await quota.runInTransaction(transaction, 'managedNodes', countNodes, createNode)
      : await quota.run('managedNodes', countNodes, createNode);

    // Hosting emits/audits only after the enclosing operation transaction commits.
    if (!transaction) await this.announceCreated(node, userId);

    return {
      node,
      enrollmentToken: enrollmentToken.token,
      enrollmentTokenExpiresAt: enrollmentTokenExpiresAt.toISOString(),
      gatewayCertSha256: await this.grpcIdentityService.getGatewayCertSha256(),
      gatewayEnrollmentTargets: await this.getGatewayEnrollmentTargets(),
    };
  }

  /**
   * Replace the enrollment token of a node that has never enrolled. The old
   * token stops working immediately; the new one expires after the default TTL.
   */
  async regenerateEnrollmentToken(id: string, userId: string) {
    const enrollmentToken = createNodeEnrollmentToken();
    const tokenHash = await bcrypt.hash(enrollmentToken.token, 10);
    const expiresAt = nodeEnrollmentTokenExpiresAt();
    const [node] = await this.db
      .update(nodes)
      .set({
        enrollmentTokenSelector: enrollmentToken.selector,
        enrollmentTokenHash: tokenHash,
        enrollmentTokenExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(and(eq(nodes.id, id), eq(nodes.status, 'pending'), sql`${nodes.certificateSerial} is null`))
      .returning();
    if (!node) {
      const [existing] = await this.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, id)).limit(1);
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'Node not found');
      throw new AppError(409, 'NODE_ALREADY_ENROLLED', 'Only a node that has not enrolled yet can get a new token');
    }

    await this.auditService.log({
      userId,
      action: 'node.enrollment_token.regenerate',
      resourceType: 'node',
      resourceId: node.id,
      details: { hostname: node.hostname, type: node.type },
    });
    this.emitNode(node.id, 'updated');

    const { enrollmentTokenHash: _hash, enrollmentTokenSelector: _selector, ...publicNode } = node;
    return {
      node: publicNode,
      enrollmentToken: enrollmentToken.token,
      enrollmentTokenExpiresAt: expiresAt.toISOString(),
      gatewayCertSha256: await this.grpcIdentityService.getGatewayCertSha256(),
      gatewayEnrollmentTargets: await this.getGatewayEnrollmentTargets(),
    };
  }

  async announceCreated(
    node: { id: string; hostname: string; type: string; folderId?: string | null; displayName?: string | null },
    userId: string
  ) {
    // Without a folder in hand, the destination is read from the node row.
    await grantCreatedResourcePermissions(
      userId,
      'nodes',
      node.id,
      node.folderId === undefined ? undefined : { folderId: node.folderId }
    );
    await this.auditService.log({
      userId,
      action: 'node.create',
      resourceType: 'node',
      resourceId: node.id,
      // A pending node's hostname is a placeholder until it enrolls; the name keeps the entry readable after removal.
      details: {
        ...(node.displayName ? { displayName: node.displayName } : {}),
        hostname: node.hostname,
        type: node.type,
      },
    });

    logger.info('Node created', { nodeId: node.id, hostname: node.hostname });
    this.emitNode(node.id, 'created');
  }

  async update(id: string, input: UpdateNodeInput, userId: string) {
    if (this.daemonUpdateService && (await this.daemonUpdateService.isNodeUpdateInProgress(id))) {
      throw new AppError(409, 'NODE_UPDATING', 'Node daemon update is in progress');
    }

    const [existing] = await this.db.select().from(nodes).where(eq(nodes.id, id)).limit(1);

    if (!existing) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }

    const legacyAddressUpdateRequested =
      input.serviceAddress !== undefined || input.secondaryServiceAddress !== undefined;
    const serviceAddressesUpdateRequested = input.serviceAddresses !== undefined || legacyAddressUpdateRequested;
    const currentServiceAddresses = getConfiguredNodeServiceAddresses(existing);
    const nextServiceAddresses =
      input.serviceAddresses !== undefined
        ? input.serviceAddresses
        : legacyAddressUpdateRequested
          ? [
              input.serviceAddress === undefined ? existing.serviceAddress : input.serviceAddress,
              input.secondaryServiceAddress === undefined
                ? existing.secondaryServiceAddress
                : input.secondaryServiceAddress,
              ...currentServiceAddresses.slice(2),
            ].filter((address): address is string => !!address)
          : currentServiceAddresses;

    if (new Set(nextServiceAddresses).size !== nextServiceAddresses.length) {
      throw new AppError(400, 'DUPLICATE_NGINX_SERVICE_ADDRESSES', 'Node service addresses must be different');
    }
    if (
      existing.type === 'nginx' &&
      input.serviceAddresses === undefined &&
      input.secondaryServiceAddress &&
      input.secondaryServiceAddress ===
        getEffectiveNginxIngressAddress({
          serviceAddress: input.serviceAddress === undefined ? existing.serviceAddress : input.serviceAddress,
          lastHealthReport: this.registry.getNode(id)?.lastHealthReport ?? existing.lastHealthReport,
        })
    ) {
      throw new AppError(
        400,
        'DUPLICATE_NGINX_SERVICE_ADDRESSES',
        'Primary and secondary Nginx service addresses must be different'
      );
    }

    if (existing.type === 'nginx' && serviceAddressesUpdateRequested) {
      const invalidAddress = nextServiceAddresses.find((address) => !isPubliclyRoutableIp(address));
      if (invalidAddress) {
        throw new AppError(
          400,
          'INVALID_NGINX_SERVICE_ADDRESS',
          'Every Nginx service address must be a publicly routable IP address',
          { address: invalidAddress }
        );
      }
    }

    if (input.secondaryServiceAddress !== undefined && existing.type !== 'nginx') {
      throw new AppError(
        400,
        'INVALID_SECONDARY_SERVICE_ADDRESS_NODE',
        'Secondary service address is only supported for Nginx nodes'
      );
    }
    let shouldReconcileAssignedDomains = false;
    let approvedDnsTarget: string | null | undefined;
    const ingressAddressChanged =
      existing.type === 'nginx' &&
      serviceAddressesUpdateRequested &&
      !orderedAddressesEqual(currentServiceAddresses, nextServiceAddresses);
    if (existing.type === 'nginx' && ingressAddressChanged) {
      const liveHealthReport = this.registry.getNode(id)?.lastHealthReport ?? existing.lastHealthReport;
      const previousAddresses = getEffectiveNginxIngressAddresses({
        serviceAddresses: currentServiceAddresses,
        serviceAddress: existing.serviceAddress,
        secondaryServiceAddress: existing.secondaryServiceAddress,
        lastHealthReport: liveHealthReport,
      });
      const nextAddresses = getEffectiveNginxIngressAddresses({
        serviceAddresses: nextServiceAddresses,
        lastHealthReport: liveHealthReport,
      });
      const affectedDomains = await this.db
        .select({ id: domains.id, dnsTargetIps: domains.dnsTargetIps })
        .from(domains)
        .where(eq(domains.nginxNodeId, id));
      const domainsWithChangedTarget = affectedDomains.filter(
        (domain) => !isNonEmptyAddressSubset(domain.dnsTargetIps, nextAddresses)
      );
      if (domainsWithChangedTarget.length > 0) {
        if (!input.confirmDomainDnsUpdate) {
          throw new AppError(
            409,
            'NODE_SERVICE_ADDRESS_DOMAINS_AFFECTED',
            'Changing this address will update tracked DNS targets for assigned domains',
            {
              domainCount: domainsWithChangedTarget.length,
              previousAddress: previousAddresses[0] ?? null,
              nextAddress: nextAddresses[0] ?? null,
              previousAddresses,
              nextAddresses,
            }
          );
        }
        shouldReconcileAssignedDomains = true;
        approvedDnsTarget = nextAddresses[0] ?? null;
      }
    }

    const updateData = {
      displayName: input.displayName === undefined ? existing.displayName : input.displayName,
      appearanceColor: input.appearanceColor === undefined ? existing.appearanceColor : input.appearanceColor,
      serviceAddresses: serviceAddressesUpdateRequested ? nextServiceAddresses : existing.serviceAddresses,
      serviceAddress: serviceAddressesUpdateRequested ? (nextServiceAddresses[0] ?? null) : existing.serviceAddress,
      secondaryServiceAddress: serviceAddressesUpdateRequested
        ? (nextServiceAddresses[1] ?? null)
        : existing.secondaryServiceAddress,
      // Merged in the database: writing back the metadata read above would erase an update that started meanwhile.
      ...(input.builderSettings === undefined
        ? {}
        : {
            metadata: sql`COALESCE(${nodes.metadata}, '{}'::jsonb) || jsonb_build_object('builderSettings', ${JSON.stringify(input.builderSettings)}::jsonb)`,
          }),
      updatedAt: new Date(),
    };
    const updateNode = async (slug?: string) => {
      const write = async (db: DrizzleExecutor) => {
        const [updated] = await db
          .update(nodes)
          .set({ ...updateData, ...(slug === undefined ? {} : { slug }) })
          .where(eq(nodes.id, id))
          .returning();
        if (shouldReconcileAssignedDomains && approvedDnsTarget !== undefined) {
          await db
            .update(domains)
            .set({ pendingDnsTargetIp: approvedDnsTarget, updatedAt: new Date() })
            .where(eq(domains.nginxNodeId, id));
        }
        return updated;
      };
      return shouldReconcileAssignedDomains ? this.db.transaction(write) : write(this.db);
    };
    const displayNameChanged = input.displayName !== undefined && input.displayName !== existing.displayName;
    const updated = !displayNameChanged
      ? await updateNode()
      : await writeWithAllocatedSlug({
          source: input.displayName?.trim() || existing.hostname,
          fallback: 'node',
          reserved: ['file', 'console'],
          constraint: 'nodes_slug_unique',
          write: updateNode,
        });

    await this.auditService.log({
      userId,
      action: 'node.update',
      resourceType: 'node',
      resourceId: id,
      details: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.appearanceColor !== undefined ? { appearanceColor: input.appearanceColor } : {}),
        ...(serviceAddressesUpdateRequested ? { serviceAddresses: nextServiceAddresses } : {}),
        ...(input.builderSettings !== undefined ? { builderSettings: input.builderSettings } : {}),
      },
    });
    const slugChange = updated.slug === existing.slug ? {} : { oldSlug: existing.slug, slug: updated.slug };
    this.emitNode(id, 'updated', slugChange);
    if (updated.slug !== existing.slug) {
      this.eventBus?.publish('node.slug.changed', { id, oldSlug: existing.slug, slug: updated.slug });
    }
    if (ingressAddressChanged || shouldReconcileAssignedDomains) {
      this.eventBus?.publish('node.service_address.changed', {
        id,
        serviceAddresses: updated.serviceAddresses,
        serviceAddress: updated.serviceAddress,
        secondaryServiceAddress: updated.secondaryServiceAddress,
        effectiveServiceAddress: getEffectiveServiceAddressForNode(updated),
        reconcileAssignedDomains: shouldReconcileAssignedDomains,
      });
    }

    const { enrollmentTokenHash: _hash, enrollmentTokenSelector: _selector, ...publicNode } = updated;
    return publicNode;
  }

  async updateServiceCreationLock(id: string, input: UpdateNodeServiceCreationLockInput, userId: string) {
    const [existing] = await this.db.select().from(nodes).where(eq(nodes.id, id)).limit(1);

    if (!existing) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }
    if (existing.type !== 'nginx' && existing.type !== 'docker') {
      throw new AppError(
        400,
        'NODE_LOCK_UNSUPPORTED',
        'Only nginx and Docker nodes can be locked for service creation'
      );
    }

    await this.db
      .update(nodes)
      .set({
        serviceCreationLocked: input.serviceCreationLocked,
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, id));

    await this.auditService.log({
      userId,
      action: 'node.service_creation_lock',
      resourceType: 'node',
      resourceId: id,
      details: { serviceCreationLocked: input.serviceCreationLocked },
    });
    this.emitNode(id, 'updated');

    return this.get(id);
  }

  async remove(
    id: string,
    userId: string,
    options: {
      cascadeOfflineProxyHosts?: boolean;
      /** Internal hosting worker only: validate identity, binding, permissions and lease under deletion locks. */
      hostingDelete?: { operationId: string; guard: (tx: DrizzleTransaction) => Promise<void> };
    } = {}
  ) {
    if (this.daemonUpdateService && (await this.daemonUpdateService.isNodeUpdateInProgress(id))) {
      throw new AppError(409, 'NODE_UPDATING', 'Node daemon update is in progress');
    }

    const [node] = await this.db.select().from(nodes).where(eq(nodes.id, id)).limit(1);

    if (!node) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }

    const [activeHostingOperation] = await this.db
      .select({ id: hostingOperations.id, action: hostingOperations.action })
      .from(hostingOperations)
      .where(activeHostingOperationForNode(id))
      .limit(1);
    const ownDelete = (operation: { id: string; action: string }) =>
      operation.action === 'delete' && operation.id === options.hostingDelete?.operationId;
    if (activeHostingOperation && node.status !== 'pending' && !ownDelete(activeHostingOperation)) {
      throw new AppError(
        409,
        'NODE_HOSTING_OPERATION_ACTIVE',
        `Cannot delete this node while hosting ${activeHostingOperation.action} is still in progress`,
        { hostingOperationId: activeHostingOperation.id, action: activeHostingOperation.action }
      );
    }

    let relayInstance: typeof relayInstances.$inferSelect | undefined;
    if (node.type === 'relay') {
      [relayInstance] = await this.db.select().from(relayInstances).where(eq(relayInstances.nodeId, id)).limit(1);
      if (relayInstance) {
        const liveAssignments = await this.db
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
              eq(relayEndpointAssignments.relayInstanceId, relayInstance.id),
              inArray(relayEndpointAssignmentGenerations.state, ['active', 'staging', 'draining'])
            )
          );
        // A drained relay's assignments next to other relays in active generations go with it (validateRelayRemoval).
        const generationIds = [...new Set(liveAssignments.map(({ assignmentGenerationId }) => assignmentGenerationId))];
        const parked =
          relayInstance.state === 'draining' && generationIds.length
            ? parkedDrainedAssignmentIds(
                relayInstance,
                await this.db
                  .select({
                    id: relayEndpointAssignments.id,
                    assignmentGenerationId: relayEndpointAssignments.assignmentGenerationId,
                    relayInstanceId: relayEndpointAssignments.relayInstanceId,
                  })
                  .from(relayEndpointAssignments)
                  .where(inArray(relayEndpointAssignments.assignmentGenerationId, generationIds)),
                liveAssignments.map(({ assignmentGenerationId, state }) => ({ id: assignmentGenerationId, state }))
              )
            : new Set<string>();
        const activeAssignments = liveAssignments.filter(({ id }) => !parked.has(id));
        const disconnectedOfflineRelay =
          node.status === 'offline' && relayInstance.state === 'offline' && !this.registry.getNode(id);
        if (activeAssignments.length && !disconnectedOfflineRelay) {
          throw new AppError(
            409,
            'RELAY_INSTANCE_ASSIGNED',
            'Rebalance relay endpoints away from this instance before removal'
          );
        }
        const pendingRelayEnrollment = node.status === 'pending' && !node.certificateSerial;
        if (
          !pendingRelayEnrollment &&
          !disconnectedOfflineRelay &&
          !['draining', 'offline', 'error'].includes(relayInstance.state)
        ) {
          throw new AppError(409, 'RELAY_INSTANCE_NOT_DRAINED', 'Drain the relay instance before removal');
        }
        if (!disconnectedOfflineRelay && (relayInstance.health?.activeTunnels ?? 0) > 0) {
          throw new AppError(409, 'RELAY_INSTANCE_HAS_ACTIVE_TUNNELS', 'Relay instance still has active tunnels');
        }
      }
    }

    const assignedHosts = await this.db.select({ id: proxyHosts.id }).from(proxyHosts).where(eq(proxyHosts.nodeId, id));
    const cascadeOfflineProxyHosts = options.cascadeOfflineProxyHosts === true;
    if (assignedHosts.length > 0) {
      if (!cascadeOfflineProxyHosts) {
        const offlineNginxNode = node.type === 'nginx' && !this.registry.getNode(id);
        throw new AppError(
          offlineNginxNode ? 409 : 400,
          offlineNginxNode ? 'OFFLINE_NGINX_NODE_HAS_HOSTS' : 'NODE_HAS_HOSTS',
          offlineNginxNode
            ? `Offline Nginx node has ${assignedHosts.length} assigned proxy host(s). Confirm cascade removal to continue.`
            : `Cannot delete node with ${assignedHosts.length} assigned proxy host(s). Reassign or delete them first.`,
          { proxyHostCount: assignedHosts.length }
        );
      }
      if (node.type !== 'nginx') {
        throw new AppError(
          409,
          'PROXY_HOST_CASCADE_NOT_ALLOWED',
          'Proxy hosts can only be cascaded with an offline Nginx node'
        );
      }
      if (this.registry.getNode(id)) {
        throw new AppError(409, 'NODE_CONNECTED', 'Disconnect the Nginx node before cascading its proxy hosts');
      }
      if (!this.proxyService) {
        throw new AppError(503, 'PROXY_SERVICE_UNAVAILABLE', 'Proxy host cleanup is unavailable');
      }
    }

    const [upstreamCount] = await this.db
      .select({ count: count() })
      .from(proxyHosts)
      .leftJoin(dockerDeployments, eq(proxyHosts.dockerDeploymentId, dockerDeployments.id))
      .where(or(eq(proxyHosts.dockerNodeId, id), eq(dockerDeployments.nodeId, id)));
    if (upstreamCount && upstreamCount.count > 0) {
      throw new AppError(
        409,
        'NODE_HAS_PROXY_UPSTREAMS',
        `Cannot delete node with ${upstreamCount.count} linked proxy upstream(s). Change or delete them first.`
      );
    }

    const [managedDatabaseCount] = await this.db
      .select({ count: count() })
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.nodeId, id));
    if (managedDatabaseCount && managedDatabaseCount.count > 0) {
      throw new AppError(
        409,
        'NODE_HAS_MANAGED_DATABASES',
        `Cannot delete node with ${managedDatabaseCount.count} managed database(s). Reassign or delete them first.`
      );
    }

    const assignedDomains = await this.db.select({ id: domains.id }).from(domains).where(eq(domains.nginxNodeId, id));
    if (assignedDomains.length > 0) {
      throw new AppError(409, 'NODE_HAS_DOMAINS', 'Cannot delete a node with assigned domains. Reassign them first.', {
        domainCount: assignedDomains.length,
      });
    }

    // A member of an ingress group is removed from the group first (DNS first, then cleanup); cascading its hosts
    // here would delete group routes it is the primary of.
    const groupMemberships =
      (await this.db
        .select({ groupId: ingressGroupMembers.groupId })
        .from(ingressGroupMembers)
        .where(eq(ingressGroupMembers.nodeId, id))) ?? [];
    if (groupMemberships.length > 0) {
      const groupNames = await this.db
        .select({ name: ingressGroups.name })
        .from(ingressGroups)
        .where(
          inArray(
            ingressGroups.id,
            groupMemberships.map((membership) => membership.groupId)
          )
        );
      throw new AppError(
        409,
        'NODE_IN_INGRESS_GROUP',
        `Remove this node from ingress group ${groupNames.map((group) => group.name).join(', ')} first; its routes keep serving from the other members`,
        { ingressGroupIds: groupMemberships.map((membership) => membership.groupId) }
      );
    }

    if (assignedHosts.length > 0) {
      const proxyService = this.proxyService;
      if (!proxyService) {
        throw new AppError(503, 'PROXY_SERVICE_UNAVAILABLE', 'Proxy host cleanup is unavailable');
      }
      for (const host of assignedHosts) {
        await proxyService.deleteProxyHost(host.id, userId, { abandonOfflineNode: true });
      }
    }

    const connectedNode = this.registry.getNode(id);
    let cancelledHostingConnectors: { connectorId: string | null }[] = [];

    // Retire certificates and delete their owner in one transaction: a failed
    // owner deletion cannot leave a still-active node with a revoked leaf. Grants naming the node (and the
    // Docker resources removed with it) go in the same transaction.
    await transactionWithScopeCleanup(this.db, async (tx) => {
      await options.hostingDelete?.guard(tx);
      const [lockedNode] = await tx
        .select({ id: nodes.id, status: nodes.status })
        .from(nodes)
        .where(eq(nodes.id, id))
        .for('update');
      if (!lockedNode) throw new AppError(404, 'NOT_FOUND', 'Node not found');
      const firewallBindings = await tx
        .select({ resourceId: hostingNodeBindings.resourceId })
        .from(hostingNodeBindings)
        .where(eq(hostingNodeBindings.nodeId, id));
      await lockHostingFirewalls(
        tx,
        firewallBindings.map((binding) => binding.resourceId)
      );
      const [racingHostingOperation] = await tx
        .select({ id: hostingOperations.id, action: hostingOperations.action })
        .from(hostingOperations)
        .where(activeHostingOperationForNode(id))
        .limit(1);
      if (racingHostingOperation && lockedNode.status !== 'pending' && !ownDelete(racingHostingOperation)) {
        throw new AppError(
          409,
          'NODE_HOSTING_OPERATION_ACTIVE',
          `Cannot delete this node while hosting ${racingHostingOperation.action} is still in progress`,
          { hostingOperationId: racingHostingOperation.id, action: racingHostingOperation.action }
        );
      }
      if (lockedNode.status === 'pending') {
        // Remove is local-only. Fence installation workers and keep the provider
        // request identity for audit; do not cancel or destroy anything upstream.
        cancelledHostingConnectors = await tx
          .update(hostingOperations)
          .set({
            phase: 'failed',
            errorCode: 'HOSTING_NODE_REMOVED',
            errorMessage: 'Node removed from Gateway by the user; provider resources were not deleted.',
            encryptedBootstrap: null,
            bootstrapExpiresAt: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            generation: sql`${hostingOperations.generation} + 1`,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(hostingOperations.nodeId, id),
              inArray(hostingOperations.action, ['create', 'install']),
              notInArray(hostingOperations.phase, ['ready', 'failed'])
            )
          )
          .returning({ connectorId: hostingOperations.connectorId });
      }
      if (relayInstance && lockedNode.status !== 'pending') {
        if (!this.systemCertificateLifecycle)
          throw new AppError(
            503,
            'CERTIFICATE_REVOCATION_UNAVAILABLE',
            'Certificate revocation is required for relay removal'
          );
        relayInstance = await validateRelayRemoval(
          tx,
          relayInstance.id,
          () => lockedNode.status === 'offline' && !this.registry.getNode(id)
        );
      }
      if (this.systemCertificateLifecycle) {
        await this.systemCertificateLifecycle.retireOwner({ type: 'node', id }, 'cessationOfOperation', tx);
        if (relayInstance) {
          await this.systemCertificateLifecycle.retireOwner(
            { type: 'relay_node_server', id: relayInstance.id },
            'cessationOfOperation',
            tx
          );
        }
      }
      if (relayInstance) {
        await tx.delete(relayPoolUpdateSteps).where(eq(relayPoolUpdateSteps.relayInstanceId, relayInstance.id));
        await tx
          .delete(relayAssignmentSourceProbes)
          .where(eq(relayAssignmentSourceProbes.relayInstanceId, relayInstance.id));
        await tx.delete(relayEndpointAssignments).where(eq(relayEndpointAssignments.relayInstanceId, relayInstance.id));
        await tx.delete(relayInstances).where(eq(relayInstances.id, relayInstance.id));
        await bumpRelayPolicyRevision(tx);
      }
      await tx.delete(nodes).where(eq(nodes.id, id));
    });
    // A retry-install reservation locks the same node row, so it either commits
    // before the final check above or sees the deleted node. End only after commit:
    // a later certificate/delete failure must not disconnect a node that survived.
    if (connectedNode) {
      connectedNode.commandStream.end();
      await this.registry.deregister(id);
    }
    await this.systemCertificateLifecycle?.retryPendingCRLs();

    await this.auditService.log({
      userId,
      action: 'node.remove',
      resourceType: 'node',
      resourceId: id,
      details: {
        ...(node.displayName ? { displayName: node.displayName } : {}),
        hostname: node.hostname,
        cascadedProxyHostCount: cascadeOfflineProxyHosts ? assignedHosts.length : 0,
      },
    });

    logger.info('Node removed', { nodeId: id, hostname: node.hostname });
    this.emitNode(id, 'deleted');
    for (const connectorId of new Set(cancelledHostingConnectors.map((operation) => operation.connectorId))) {
      if (connectorId)
        this.eventBus?.publish('integration.connector.changed', { id: connectorId, provider: 'hosting' });
    }
  }

  /** `userId`: the reading user, audited; Gateway's own reads pass none. */
  async listFiles(nodeId: string, path: string, userId?: string) {
    await this.validateConnectedNode(nodeId);
    return listNodeFiles(this.nodeFileOperationContext(), nodeId, path, userId);
  }

  /** `userId`: the reading user, audited; Gateway's own reads pass none. */
  async readFile(nodeId: string, path: string, userId?: string) {
    await this.validateConnectedNode(nodeId);
    return readNodeFile(this.nodeFileOperationContext(), nodeId, path, userId);
  }

  async writeFile(nodeId: string, path: string, content: string | Buffer, userId: string) {
    await this.validateConnectedNode(nodeId);
    await writeNodeFile(this.nodeFileOperationContext(), nodeId, path, content, userId);
  }

  async createFile(nodeId: string, path: string, content: string | Buffer | undefined, userId: string) {
    await this.validateConnectedNode(nodeId);
    await createNodeFile(this.nodeFileOperationContext(), nodeId, path, content, userId);
  }

  async initFileUpload(nodeId: string, path: string, totalBytes: number, userId: string) {
    await this.validateConnectedNode(nodeId);
    return initNodeFileUpload(this.nodeFileOperationContext(), nodeId, path, totalBytes, userId);
  }

  async appendFileUploadChunk(nodeId: string, uploadId: string, offset: number, content: Buffer) {
    await this.validateConnectedNode(nodeId);
    return appendNodeFileUploadChunk(this.nodeFileOperationContext(), nodeId, uploadId, offset, content);
  }

  async completeFileUpload(nodeId: string, uploadId: string, path: string, totalBytes: number) {
    await this.validateConnectedNode(nodeId);
    await completeNodeFileUpload(this.nodeFileOperationContext(), nodeId, uploadId, path, totalBytes);
  }

  async abortFileUpload(nodeId: string, uploadId: string) {
    await this.validateConnectedNode(nodeId);
    await abortNodeFileUpload(this.nodeFileOperationContext(), nodeId, uploadId);
  }

  async createDirectory(nodeId: string, path: string, userId: string) {
    await this.validateConnectedNode(nodeId);
    await createNodeDirectory(this.nodeFileOperationContext(), nodeId, path, userId);
  }

  async deleteFile(nodeId: string, path: string, userId: string) {
    await this.validateConnectedNode(nodeId);
    await deleteNodeFile(this.nodeFileOperationContext(), nodeId, path, userId);
  }

  async moveFile(nodeId: string, fromPath: string, toPath: string, userId: string) {
    await this.validateConnectedNode(nodeId);
    await moveNodeFile(this.nodeFileOperationContext(), nodeId, fromPath, toPath, userId);
  }

  async getGatewayEnrollmentTargets() {
    const settings = await this.generalSettingsService?.getGatewayEndpointSettings();
    const publicTarget = this.formatGrpcTarget(settings?.gatewayGrpcPublicTarget ?? null);
    const localTarget = this.formatGrpcTarget(settings?.gatewayGrpcLocalIp ?? null);
    return {
      public: { label: 'Public node', gateway: publicTarget },
      ...(localTarget ? { local: { label: 'Local node', gateway: localTarget } } : {}),
    };
  }

  getGatewayEnrollmentCertificateFingerprint() {
    return this.grpcIdentityService.getGatewayCertSha256();
  }

  private formatGrpcTarget(value: string | null): string | null {
    if (!value) return null;
    if (/^\[[^\]]+]:\d+$/.test(value) || /^[^:]+:\d+$/.test(value)) return value;
    if (/^\[[^\]]+]$/.test(value)) return `${value}:${this.grpcPort}`;
    if (isIP(value) === 6) return `[${value}]:${this.grpcPort}`;
    return `${value}:${this.grpcPort}`;
  }
}
