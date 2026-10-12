import { randomUUID } from 'node:crypto';
import { and, asc, count as countFn, desc, eq, gte, inArray, isNull, lte, notInArray, or } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  accessLists,
  apiTokens,
  auditLog,
  certificateAuthorities,
  certificates,
  databaseConnectionFolders,
  databaseConnections,
  dockerContainerFolders,
  dockerDeployments,
  dockerRegistries,
  domains,
  nginxTemplates,
  nodeFolders,
  nodes,
  notificationAlertRules,
  notificationWebhooks,
  permissionGroups,
  proxyHostFolders,
  proxyHosts,
  sslCertificates,
  users,
} from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere } from '@/lib/utils.js';
import {
  CLOUD_AUDIT_RESOURCE_TYPE,
  cloudAuditResourceName,
  cloudAuditSummary,
} from '@/modules/cloud-link/cloud-link-audit-format.js';
import { INTERNAL_DOCKER_REGISTRY_ID } from '@/modules/docker/docker-registry-internal.service.js';
import { backgroundWrites } from '@/services/background-writes.js';
import type { PaginatedResponse } from '@/types.js';
import { getAuditRequestContext, markAuditEmitted } from './audit-request-context.js';
import {
  finishSpooledAuditBatch,
  isAuditDatabaseUnavailable,
  type SpooledAuditBatch,
  type SpooledAuditRow,
  spoolAuditRow,
  takeSpooledAuditBatches,
} from './audit-spool.js';
import type { SiemAuditOutboxService } from './siem-outbox.service.js';

const logger = createChildLogger('AuditService');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Any value Postgres accepts for the uuid actor column. */
const ACTOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditEntry {
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  /**
   * When the audited event happened, for events Gateway learns about afterwards (an autonomous lease failover while
   * it was down). Defaults to now; a future time is ignored.
   */
  occurredAt?: Date;
}

interface AuditLogOptions {
  markRequest?: boolean;
}

export interface AuditLogFilters {
  action?: string;
  actions?: string[];
  resourceType?: string;
  resourceTypes?: string[];
  resourceId?: string;
  userId?: string;
  userIds?: string[];
  excludedActions?: string[];
  excludedResourceTypes?: string[];
  from?: Date;
  to?: Date;
  /** Rows tagged with this app (app activity). */
  appId?: string;
  /** With appId: only rows of these environments or of the whole app (no environment). */
  appEnvironmentIds?: string[];
  /** With appId: only rows of these members or of no member; undefined = every member. */
  appMemberIds?: string[];
}

/** Tags a row with the app, environment and member it concerns (apps module); null leaves it untagged. */
export interface AuditAppTagger {
  tag(entry: AuditEntry): Promise<{
    appId: string;
    appEnvironmentId: string | null;
    appMemberType: string | null;
    appMemberId: string | null;
  } | null>;
}

interface AuditLogRow {
  id: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  resourceName: string | null;
  /** A plain line describing the entry, for actions that have one (the cloud link's). */
  summary: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  appId?: string | null;
  appEnvironmentId?: string | null;
  appMemberType?: string | null;
  appMemberId?: string | null;
  userName: string | null;
  userEmail: string | null;
  userAvatarUrl: string | null;
}

@injectable()
export class AuditService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly siemOutboxService?: SiemAuditOutboxService
  ) {}
  private eventBus?: import('@/services/event-bus.service.js').EventBusService;

  setEventBus(eventBus: import('@/services/event-bus.service.js').EventBusService): void {
    this.eventBus = eventBus;
  }

  private appTagger?: AuditAppTagger;

  setAppTagger(tagger: AuditAppTagger): void {
    this.appTagger = tagger;
  }

  /**
   * Writes one audit row. Every write is tracked for shutdown, which waits for it before closing
   * the database pool: rows events produce while Gateway stops (node.disconnected) are not lost.
   */
  log(entry: AuditEntry, options: AuditLogOptions = {}): Promise<boolean> {
    return backgroundWrites.track(this.writeEntry(entry, options));
  }

  private async writeEntry(entry: AuditEntry, options: AuditLogOptions): Promise<boolean> {
    let unstored: SpooledAuditRow | null = null;
    try {
      const requestContext = getAuditRequestContext();
      const impersonation = requestContext?.impersonation;
      const requestedActorId = impersonation?.actorUserId ?? entry.userId;
      // System actions are rows without a user (userId null). One that names its actor instead ('system', a job
      // name) must not lose its row to the uuid column (22P02, N-26): it is stored as a system action and the name
      // kept in details.
      const invalidActorId =
        typeof requestedActorId === 'string' && !ACTOR_ID_RE.test(requestedActorId) ? requestedActorId : null;
      const actorUserId = invalidActorId === null ? requestedActorId : null;
      const entryDetails = invalidActorId === null ? entry.details : { ...entry.details, actor: invalidActorId };
      const id = randomUUID();
      const now = new Date();
      const createdAt =
        entry.occurredAt instanceof Date &&
        Number.isFinite(entry.occurredAt.getTime()) &&
        entry.occurredAt.getTime() <= now.getTime()
          ? entry.occurredAt
          : now;
      const ipAddress = entry.ipAddress ?? requestContext?.ipAddress ?? null;
      const mcpDetails = requestContext?.mcp
        ? {
            source: 'mcp',
            toolName: requestContext.mcp.toolName,
            category: requestContext.mcp.category,
            arguments: requestContext.mcp.arguments,
            tokenId: requestContext.mcp.tokenId,
            tokenPrefix: requestContext.mcp.tokenPrefix,
            authType: requestContext.mcp.authType,
            clientId: requestContext.mcp.clientId,
          }
        : undefined;
      // App activity: tagged when written (a container's audit id changes on recreate). A failed lookup leaves the
      // row untagged, never unwritten.
      const appTag = this.appTagger ? await this.appTagger.tag(entry).catch(() => null) : null;
      const values = {
        id,
        ...(appTag
          ? {
              appId: appTag.appId,
              appEnvironmentId: appTag.appEnvironmentId,
              appMemberType: appTag.appMemberType,
              appMemberId: appTag.appMemberId,
            }
          : {}),
        userId: actorUserId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        details:
          mcpDetails || impersonation
            ? {
                ...entryDetails,
                ...mcpDetails,
                ...(impersonation
                  ? {
                      impersonatedUserId: impersonation.subjectUserId,
                      impersonatedUserEmail: impersonation.subjectEmail,
                      impersonatedUserName: impersonation.subjectName,
                    }
                  : {}),
              }
            : entryDetails,
        ipAddress,
        userAgent: entry.userAgent ?? requestContext?.userAgent,
        createdAt,
      };
      unstored = {
        id,
        userId: actorUserId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        details: values.details ?? null,
        ipAddress,
        userAgent: values.userAgent ?? null,
        createdAt: createdAt.toISOString(),
      };
      const siemEvent = await this.buildSiemEvent(
        id,
        createdAt,
        actorUserId,
        entry.action,
        entry.resourceType,
        entry.resourceId ?? null,
        ipAddress
      );
      const siemOutbox = siemEvent ? this.siemOutboxService : undefined;
      if (siemEvent && siemOutbox) {
        // The row and its SIEM event commit together.
        await this.inTransaction(async (writer) => {
          await writer.insert(auditLog).values(values);
          await siemOutbox.enqueue(writer, id, siemEvent, createdAt);
        });
      } else {
        // A single insert is atomic on its own: no BEGIN/COMMIT round trips on every audited request.
        await this.db.insert(auditLog).values(values);
      }
      this.eventBus?.publish('audit.changed', {});
      if (options.markRequest ?? true) {
        markAuditEmitted();
      }
      return true;
    } catch (error) {
      // The database is already gone (a host shutdown stops postgres with the app, M-7): keep the row locally and
      // store it at the next start instead of losing it.
      if (unstored && isAuditDatabaseUnavailable(error)) {
        const spooled = await spoolAuditRow(unstored).then(
          () => true,
          (spoolError: unknown) => {
            logger.warn('Audit row could not be kept locally either', { error: spoolError });
            return false;
          }
        );
        if (spooled) {
          logger.warn('Audit log kept locally until the database is back', {
            action: entry.action,
            resourceType: entry.resourceType,
            resourceId: entry.resourceId,
            error: error instanceof Error ? error.message : String(error),
          });
          if (options.markRequest ?? true) {
            markAuditEmitted();
          }
          return true;
        }
      }
      logger.error('Failed to write audit log', {
        error,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
      });
      return false;
    }
  }

  private async buildSiemEvent(
    auditLogId: string,
    createdAt: Date,
    actorId: string | null,
    action: string,
    resourceType: string,
    resourceId: string | null,
    sourceIp: string | null
  ) {
    const siemEnabled = this.siemOutboxService ? await this.siemOutboxService.isEnabled() : false;
    if (!siemEnabled || !this.siemOutboxService) return null;
    const actorEmail = await this.getActorEmail(actorId);
    return this.siemOutboxService.buildEvent({
      auditLogId,
      createdAt,
      action,
      actorId,
      actorEmail,
      resourceType,
      resourceId,
      sourceIp,
    });
  }

  private async inTransaction(
    work: (writer: Pick<DrizzleClient, 'select' | 'insert'>) => Promise<void>
  ): Promise<void> {
    const transactionalDb = this.db as DrizzleClient & {
      transaction?: (callback: (tx: Pick<DrizzleClient, 'select' | 'insert'>) => Promise<void>) => Promise<void>;
    };
    if (transactionalDb.transaction) {
      await transactionalDb.transaction((tx) => work(tx));
    } else {
      await work(this.db);
    }
  }

  /**
   * Stores the audit rows kept locally while the database was gone (M-7). Runs once at start; a row stored before
   * (a start that stopped halfway) is not added twice. Rows that still cannot be stored wait for the next start.
   */
  async replaySpooledRows(): Promise<void> {
    let batches: SpooledAuditBatch[];
    try {
      batches = await takeSpooledAuditBatches();
    } catch (error) {
      logger.warn('Audit rows kept locally could not be read', { error });
      return;
    }
    let stored = 0;
    for (const batch of batches) {
      for (const row of batch.rows) {
        try {
          if (await this.storeSpooledRow(row)) stored += 1;
        } catch (error) {
          logger.warn('Audit rows kept locally wait for the next start', { error, file: batch.file });
          return;
        }
      }
      if (batch.malformed)
        logger.warn('Dropped audit rows cut by a crash', { count: batch.malformed, file: batch.file });
      await finishSpooledAuditBatch(batch);
    }
    if (stored) {
      logger.info('Stored the audit rows kept while the database was gone', { count: stored });
      this.eventBus?.publish('audit.changed', {});
    }
  }

  private async storeSpooledRow(row: SpooledAuditRow): Promise<boolean> {
    const createdAt = new Date(row.createdAt);
    const siemEvent = await this.buildSiemEvent(
      row.id,
      createdAt,
      row.userId,
      row.action,
      row.resourceType,
      row.resourceId,
      row.ipAddress
    );
    let inserted = false;
    await this.inTransaction(async (writer) => {
      const written = await writer
        .insert(auditLog)
        .values({
          id: row.id,
          userId: row.userId,
          action: row.action,
          resourceType: row.resourceType,
          resourceId: row.resourceId ?? undefined,
          details: row.details ?? undefined,
          ipAddress: row.ipAddress,
          userAgent: row.userAgent ?? undefined,
          createdAt,
        })
        .onConflictDoNothing({ target: auditLog.id })
        .returning({ id: auditLog.id });
      inserted = written.length > 0;
      if (inserted && siemEvent && this.siemOutboxService) {
        await this.siemOutboxService.enqueue(writer, row.id, siemEvent, createdAt);
      }
    });
    return inserted;
  }

  private async getActorEmail(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    try {
      const [actor] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
      return actor?.email ?? null;
    } catch (error) {
      // Exporting an optional actor e-mail must never make the local audit
      // record unavailable. The stable actor ID remains in the SIEM event.
      logger.warn('Unable to resolve audit actor email for SIEM export', {
        userId,
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      return null;
    }
  }

  async getAuditLog(
    params: AuditLogFilters & { page: number; limit: number }
  ): Promise<PaginatedResponse<AuditLogRow>> {
    const conditions = [];
    const actions = uniqueDefined([...(params.actions ?? []), params.action]);
    const resourceTypes = uniqueDefined([...(params.resourceTypes ?? []), params.resourceType]);
    const userIds = uniqueDefined([...(params.userIds ?? []), params.userId]);

    if (actions.length === 1) conditions.push(eq(auditLog.action, actions[0]!));
    else if (actions.length > 1) conditions.push(inArray(auditLog.action, actions));
    if (resourceTypes.length === 1) conditions.push(eq(auditLog.resourceType, resourceTypes[0]!));
    else if (resourceTypes.length > 1) conditions.push(inArray(auditLog.resourceType, resourceTypes));
    if (params.resourceId) conditions.push(eq(auditLog.resourceId, params.resourceId));
    if (userIds.length) {
      const concreteUserIds = userIds.filter((id) => id !== 'system');
      const includesSystem = concreteUserIds.length !== userIds.length;
      if (includesSystem && concreteUserIds.length)
        conditions.push(or(isNull(auditLog.userId), inArray(auditLog.userId, concreteUserIds)));
      else if (includesSystem) conditions.push(isNull(auditLog.userId));
      else if (concreteUserIds.length === 1) conditions.push(eq(auditLog.userId, concreteUserIds[0]!));
      else conditions.push(inArray(auditLog.userId, concreteUserIds));
    }
    if (params.excludedActions?.length) conditions.push(notInArray(auditLog.action, params.excludedActions));
    if (params.excludedResourceTypes?.length)
      conditions.push(notInArray(auditLog.resourceType, params.excludedResourceTypes));
    if (params.from) conditions.push(gte(auditLog.createdAt, params.from));
    if (params.to) conditions.push(lte(auditLog.createdAt, params.to));
    if (params.appId) {
      conditions.push(eq(auditLog.appId, params.appId));
      if (params.appEnvironmentIds) {
        conditions.push(
          params.appEnvironmentIds.length
            ? or(isNull(auditLog.appEnvironmentId), inArray(auditLog.appEnvironmentId, params.appEnvironmentIds))!
            : isNull(auditLog.appEnvironmentId)
        );
      }
      if (params.appMemberIds) {
        conditions.push(
          params.appMemberIds.length
            ? or(isNull(auditLog.appMemberId), inArray(auditLog.appMemberId, params.appMemberIds))!
            : isNull(auditLog.appMemberId)
        );
      }
    }

    const where = buildWhere(conditions);

    const [entries, [{ count: totalCount }]] = await Promise.all([
      this.db
        .select({
          id: auditLog.id,
          userId: auditLog.userId,
          action: auditLog.action,
          resourceType: auditLog.resourceType,
          resourceId: auditLog.resourceId,
          details: auditLog.details,
          ipAddress: auditLog.ipAddress,
          userAgent: auditLog.userAgent,
          createdAt: auditLog.createdAt,
          appId: auditLog.appId,
          appEnvironmentId: auditLog.appEnvironmentId,
          appMemberType: auditLog.appMemberType,
          appMemberId: auditLog.appMemberId,
          userName: users.name,
          userEmail: users.email,
          userAvatarUrl: users.avatarUrl,
        })
        .from(auditLog)
        .leftJoin(users, eq(auditLog.userId, users.id))
        .where(where)
        .orderBy(desc(auditLog.createdAt))
        .limit(params.limit)
        .offset((params.page - 1) * params.limit),
      this.db.select({ count: countFn() }).from(auditLog).where(where),
    ]);

    const resourceNames = await this.resolveResourceNames(entries);
    const data = entries.map((entry) => {
      if (entry.resourceType === CLOUD_AUDIT_RESOURCE_TYPE) {
        // The Opfield account, never the agent id; and what the account did, in plain words.
        const accountEmail = (entry.details as { accountEmail?: unknown } | null)?.accountEmail;
        return {
          ...entry,
          resourceName:
            resourceNames.get(resourceKey(entry.resourceType, entry.resourceId)) ??
            cloudAuditResourceName(typeof accountEmail === 'string' ? accountEmail : null),
          summary: cloudAuditSummary(entry.action, entry.details),
        };
      }
      return {
        ...entry,
        resourceName:
          getResourceNameFromDetails(entry.details) ??
          resourceNames.get(resourceKey(entry.resourceType, entry.resourceId)) ??
          null,
        summary: null,
      };
    });
    const total = Number(totalCount);

    return {
      data,
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    };
  }

  async getAuditExport(_filters: AuditLogFilters): Promise<AuditLogRow[]> {
    return commercialModuleUnavailable();
  }

  async getAuditUsers(): Promise<Array<{ userId: string | null; userName: string | null; userEmail: string | null }>> {
    return this.db
      .selectDistinct({
        userId: auditLog.userId,
        userName: users.name,
        userEmail: users.email,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.userId, users.id))
      .orderBy(asc(users.name), asc(users.email), asc(auditLog.userId));
  }

  private async resolveResourceNames(
    entries: Array<{ resourceType: string; resourceId: string | null }>
  ): Promise<Map<string, string>> {
    const idsByType = new Map<string, Set<string>>();
    for (const entry of entries) {
      if (!entry.resourceId) continue;
      const ids = idsByType.get(entry.resourceType) ?? new Set<string>();
      ids.add(entry.resourceId);
      idsByType.set(entry.resourceType, ids);
    }

    const names = new Map<string, string>();
    const ids = (type: string) => [...(idsByType.get(type) ?? [])];

    const add = (type: string, id: string | null | undefined, name: string | null | undefined) => {
      if (id && name) names.set(resourceKey(type, id), name);
    };

    const nodeIds = ids('node');
    if (nodeIds.length) {
      const rows = await this.db
        .select({ id: nodes.id, displayName: nodes.displayName, hostname: nodes.hostname })
        .from(nodes)
        .where(inArray(nodes.id, nodeIds));
      for (const row of rows) add('node', row.id, row.displayName || row.hostname);
    }

    const nodeFolderIds = ids('node_folder');
    if (nodeFolderIds.length) {
      const rows = await this.db
        .select({ id: nodeFolders.id, name: nodeFolders.name })
        .from(nodeFolders)
        .where(inArray(nodeFolders.id, nodeFolderIds));
      for (const row of rows) add('node_folder', row.id, row.name);
    }

    const dockerFolderIds = ids('docker_folder');
    if (dockerFolderIds.length) {
      const rows = await this.db
        .select({ id: dockerContainerFolders.id, name: dockerContainerFolders.name })
        .from(dockerContainerFolders)
        .where(inArray(dockerContainerFolders.id, dockerFolderIds));
      for (const row of rows) add('docker_folder', row.id, row.name);
    }

    const proxyHostIds = ids('proxy_host');
    if (proxyHostIds.length) {
      const rows = await this.db
        .select({ id: proxyHosts.id, domainNames: proxyHosts.domainNames })
        .from(proxyHosts)
        .where(inArray(proxyHosts.id, proxyHostIds));
      for (const row of rows) add('proxy_host', row.id, row.domainNames?.join(', '));
    }

    const proxyFolderIds = ids('proxy_host_folder');
    if (proxyFolderIds.length) {
      const rows = await this.db
        .select({ id: proxyHostFolders.id, name: proxyHostFolders.name })
        .from(proxyHostFolders)
        .where(inArray(proxyHostFolders.id, proxyFolderIds));
      for (const row of rows) add('proxy_host_folder', row.id, row.name);
    }

    const caIds = ids('ca');
    if (caIds.length) {
      const rows = await this.db
        .select({ id: certificateAuthorities.id, commonName: certificateAuthorities.commonName })
        .from(certificateAuthorities)
        .where(inArray(certificateAuthorities.id, caIds));
      for (const row of rows) add('ca', row.id, row.commonName);
    }

    const certificateIds = ids('certificate');
    if (certificateIds.length) {
      const rows = await this.db
        .select({ id: certificates.id, commonName: certificates.commonName })
        .from(certificates)
        .where(inArray(certificates.id, certificateIds));
      for (const row of rows) add('certificate', row.id, row.commonName);
    }

    const sslIds = ids('ssl_certificate');
    if (sslIds.length) {
      const rows = await this.db
        .select({ id: sslCertificates.id, name: sslCertificates.name })
        .from(sslCertificates)
        .where(inArray(sslCertificates.id, sslIds));
      for (const row of rows) add('ssl_certificate', row.id, row.name);
    }

    const domainIds = ids('domain');
    if (domainIds.length) {
      const rows = await this.db
        .select({ id: domains.id, domain: domains.domain })
        .from(domains)
        .where(inArray(domains.id, domainIds));
      for (const row of rows) add('domain', row.id, row.domain);
    }

    const databaseIds = ids('database');
    if (databaseIds.length) {
      const rows = await this.db
        .select({ id: databaseConnections.id, name: databaseConnections.name })
        .from(databaseConnections)
        .where(inArray(databaseConnections.id, databaseIds));
      for (const row of rows) add('database', row.id, row.name);
    }

    const databaseFolderIds = ids('database_connection_folder');
    if (databaseFolderIds.length) {
      const rows = await this.db
        .select({ id: databaseConnectionFolders.id, name: databaseConnectionFolders.name })
        .from(databaseConnectionFolders)
        .where(inArray(databaseConnectionFolders.id, databaseFolderIds));
      for (const row of rows) add('database_connection_folder', row.id, row.name);
    }

    const accessListIds = ids('access_list');
    if (accessListIds.length) {
      const rows = await this.db
        .select({ id: accessLists.id, name: accessLists.name })
        .from(accessLists)
        .where(inArray(accessLists.id, accessListIds));
      for (const row of rows) add('access_list', row.id, row.name);
    }

    const registryIds = ids('docker-registry');
    if (registryIds.includes(INTERNAL_DOCKER_REGISTRY_ID)) {
      add('docker-registry', INTERNAL_DOCKER_REGISTRY_ID, 'Internal Registry');
    }
    const persistedRegistryIds = registryIds.filter((id) => UUID_RE.test(id));
    if (persistedRegistryIds.length) {
      const rows = await this.db
        .select({ id: dockerRegistries.id, name: dockerRegistries.name })
        .from(dockerRegistries)
        .where(inArray(dockerRegistries.id, persistedRegistryIds));
      for (const row of rows) add('docker-registry', row.id, row.name);
    }

    const deploymentIds = ids('docker-deployment');
    if (deploymentIds.length) {
      const rows = await this.db
        .select({ id: dockerDeployments.id, name: dockerDeployments.name })
        .from(dockerDeployments)
        .where(inArray(dockerDeployments.id, deploymentIds));
      for (const row of rows) add('docker-deployment', row.id, row.name);
    }

    const templateIds = ids('nginx_template');
    if (templateIds.length) {
      const rows = await this.db
        .select({ id: nginxTemplates.id, name: nginxTemplates.name })
        .from(nginxTemplates)
        .where(inArray(nginxTemplates.id, templateIds));
      for (const row of rows) add('nginx_template', row.id, row.name);
    }

    const tokenIds = ids('api-token');
    if (tokenIds.length) {
      const rows = await this.db
        .select({ id: apiTokens.id, name: apiTokens.name })
        .from(apiTokens)
        .where(inArray(apiTokens.id, tokenIds));
      for (const row of rows) add('api-token', row.id, row.name);
    }

    const groupIds = ids('permission_group');
    if (groupIds.length) {
      const rows = await this.db
        .select({ id: permissionGroups.id, name: permissionGroups.name })
        .from(permissionGroups)
        .where(inArray(permissionGroups.id, groupIds));
      for (const row of rows) add('permission_group', row.id, row.name);
    }

    const webhookIds = ids('notification_webhook');
    if (webhookIds.length) {
      const rows = await this.db
        .select({ id: notificationWebhooks.id, name: notificationWebhooks.name })
        .from(notificationWebhooks)
        .where(inArray(notificationWebhooks.id, webhookIds));
      for (const row of rows) add('notification_webhook', row.id, row.name);
    }

    const ruleIds = ids('notification_alert_rule');
    if (ruleIds.length) {
      const rows = await this.db
        .select({ id: notificationAlertRules.id, name: notificationAlertRules.name })
        .from(notificationAlertRules)
        .where(inArray(notificationAlertRules.id, ruleIds));
      for (const row of rows) add('notification_alert_rule', row.id, row.name);
    }

    const userIds = ids('user');
    if (userIds.length) {
      const rows = await this.db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, userIds));
      for (const row of rows) add('user', row.id, row.name || row.email);
    }

    // The cloud link's resource id is its agent id: named after the Opfield account it connected to.
    const cloudAgentIds = ids(CLOUD_AUDIT_RESOURCE_TYPE);
    if (cloudAgentIds.length) {
      const rows = await this.db
        .select({ id: auditLog.resourceId, details: auditLog.details })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.resourceType, CLOUD_AUDIT_RESOURCE_TYPE),
            eq(auditLog.action, 'cloud.connect'),
            inArray(auditLog.resourceId, cloudAgentIds)
          )
        );
      const emails = new Map<string, string>();
      for (const row of rows) {
        const email = (row.details as { accountEmail?: unknown } | null)?.accountEmail;
        if (row.id && typeof email === 'string' && email.trim()) emails.set(row.id, email);
      }
      for (const id of cloudAgentIds) add(CLOUD_AUDIT_RESOURCE_TYPE, id, cloudAuditResourceName(emails.get(id)));
    }

    return names;
  }
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value))];
}

function resourceKey(type: string, id: string | null | undefined): string {
  return `${type}:${id ?? ''}`;
}

function getResourceNameFromDetails(details: Record<string, unknown> | null): string | null {
  if (!details) return null;
  for (const key of [
    'newName',
    'name',
    'displayName',
    'hostname',
    'commonName',
    'cn',
    'domain',
    'containerName',
    'imageRef',
    'key',
  ]) {
    const value = details[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  for (const key of ['domainNames', 'domains']) {
    const value = details[key];
    if (Array.isArray(value)) {
      const names = value.filter((item): item is string => typeof item === 'string' && !!item.trim());
      if (names.length) return names.join(', ');
    }
  }
  return null;
}
