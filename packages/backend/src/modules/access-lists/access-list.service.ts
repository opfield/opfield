import { and, count, eq, ilike, inArray, isNull, max, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  accessIdentityProviders,
  accessListFolders,
  accessLists,
  accessSessions,
  pageProjects,
} from '@/db/schema/index.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';
import { createChildLogger } from '@/lib/logger.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { buildWhere, escapeLike } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import { scheduleAccessPolicySync } from '@/modules/access-signin/access-policy-sync.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { resolveIngressNodes } from '@/modules/ingress-groups/ingress-nodes.js';
import { nginxAccessListOf, usesFallbackBasicAuth } from '@/modules/proxy/nginx-access-list.js';
import type { NginxTemplateService } from '@/modules/proxy/nginx-template.service.js';
import { accessListLockKey, runOutsideProxyLocks, withProxyLocks } from '@/modules/proxy/proxy-host-lock.js';
import { folderListOrder, folderTreeOrder } from '@/modules/resource-folders/resource-folder-order.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NginxCertificateDistributionService } from '@/services/nginx-certificate-distribution.service.js';
import type { NginxConfigGenerator } from '@/services/nginx-config-generator.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { PaginatedResponse } from '@/types.js';
import type {
  AccessListQuery,
  CreateAccessListInput,
  MoveAccessListIpRuleInput,
  UpdateAccessListInput,
} from './access-list.schemas.js';
import { removeAccessListHtpasswd } from './access-list-credentials.js';
import { movedLegacyIpRules } from './access-list-legacy.js';
import {
  type AccessListModel,
  accessListModelOf,
  nextAccessListModel,
  type PresentedAccessList,
  presentAccessList,
  revokedSignIns,
} from './access-list-model.js';

const logger = createChildLogger('AccessListService');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AccessListRow = typeof accessLists.$inferSelect;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** The per-host re-apply entry point of ProxyService (see reapplyHostConfig). */
export interface AccessListHostRuntime {
  reapplyHostConfig(hostId: string): Promise<unknown>;
}

export class AccessListService {
  constructor(
    private readonly db: DrizzleClient,
    readonly _configGenerator: NginxConfigGenerator,
    readonly _nginxTemplateService: NginxTemplateService,
    private readonly auditService: AuditService,
    private readonly nodeDispatch: NodeDispatchService,
    readonly _certificateDistribution: NginxCertificateDistributionService
  ) {}

  private hostRuntime?: AccessListHostRuntime;
  setHostRuntime(runtime: AccessListHostRuntime) {
    this.hostRuntime = runtime;
  }

  private eventBus?: EventBusService;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }
  private emitAcl(id: string, action: 'created' | 'updated' | 'deleted') {
    runOutsideProxyLocks(() => this.eventBus?.publish('access-list.changed', { id, action }));
  }

  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  async create(input: CreateAccessListInput, userId: string) {
    // 1. The complete list (passwords hashed), validated before anything is written
    const model = await nextAccessListModel(input, null);
    await this.assertIdentityProviders(model);

    // 2. Insert into DB, at the end of its folder (or of the ungrouped lists)
    const folderId = input.folderId ?? null;
    const [last] = await this.db
      .select({ sortOrder: max(accessLists.sortOrder) })
      .from(accessLists)
      .where(folderId ? eq(accessLists.folderId, folderId) : isNull(accessLists.folderId));
    const [accessList] = await this.db
      .insert(accessLists)
      .values({
        folderId,
        sortOrder: last?.sortOrder == null ? 0 : last.sortOrder + 1,
        name: input.name,
        description: input.description?.trim() || null,
        ...model,
        createdById: userId,
      })
      .returning();
    scheduleAccessPolicySync();

    // 3. Audit log
    await this.auditService.log({
      userId,
      action: 'access_list.create',
      resourceType: 'access_list',
      resourceId: accessList.id,
      details: { name: accessList.name, folderId },
    });

    logger.info('Created access list', { id: accessList.id, name: accessList.name });
    this.emitAcl(accessList.id, 'created');

    return presentAccessList(accessList);
  }

  // -----------------------------------------------------------------------
  // Update
  // -----------------------------------------------------------------------

  async update(id: string, input: UpdateAccessListInput, userId: string): Promise<PresentedAccessList> {
    // Serialize edits of one list so two updates cannot interleave their
    // re-apply and rollback phases.
    const updated = await withProxyLocks([accessListLockKey(id)], () => this.updateLocked(id, input, userId));
    return presentAccessList(updated);
  }

  /** The legacy IP rule move (movedLegacyIpRules), under the same lock as an update. */
  async moveIpRule(id: string, input: MoveAccessListIpRuleInput, userId: string): Promise<PresentedAccessList> {
    const updated = await withProxyLocks([accessListLockKey(id)], async () => {
      const existing = await this.db.query.accessLists.findFirst({ where: eq(accessLists.id, id) });
      if (!existing) throw new AppError(404, 'ACCESS_LIST_NOT_FOUND', 'Access list not found');
      const { moved, ...fields } = movedLegacyIpRules(accessListModelOf(existing), input);
      return this.updateLocked(id, fields, userId, {
        action: 'access_list.move_ip_rule',
        details: { fromIndex: input.fromIndex, toIndex: input.toIndex, rule: moved },
      });
    });
    return presentAccessList(updated);
  }

  private async updateLocked(
    id: string,
    input: UpdateAccessListInput,
    userId: string,
    audit?: { action: string; details: Record<string, unknown> }
  ) {
    // 1. Get existing access list
    const existing = await this.db.query.accessLists.findFirst({
      where: eq(accessLists.id, id),
    });
    if (!existing) throw new AppError(404, 'ACCESS_LIST_NOT_FOUND', 'Access list not found');

    // 2. Build and validate the complete next state before any side effect.
    const model = await nextAccessListModel(input, accessListModelOf(existing));
    await this.assertIdentityProviders(model);
    const updateData: Partial<typeof accessLists.$inferInsert> = { ...model, updatedAt: new Date() };
    if (input.name !== undefined) updateData.name = input.name;
    if (input.description !== undefined) updateData.description = input.description?.trim() || null;

    const affectedHosts = await this.db.query.proxyHosts.findMany({
      where: and(eq(proxyHosts.accessListId, id), eq(proxyHosts.enabled, true)),
      columns: { id: true, domainNames: true, nodeId: true, ingressGroupId: true },
    });
    if (affectedHosts.length > 0 && !this.hostRuntime) {
      throw new AppError(503, 'PROXY_SERVICE_UNAVAILABLE', 'Route re-apply is unavailable');
    }

    // 3. Commit, then re-apply every enabled host through the normal proxy
    // build/apply path. A list of IP rules and basic authentication is rendered
    // natively on every node, and the apply deploys its htpasswd file before the
    // config that references it; any other list is checked at the access socket
    // of a node that has one, from the synced policy.
    const [updated] = await this.db.update(accessLists).set(updateData).where(eq(accessLists.id, id)).returning();
    await this.revokeSignIns(id, revokedSignIns(accessListModelOf(existing), model));
    scheduleAccessPolicySync();

    if (affectedHosts.length > 0) {
      logger.info('Re-applying routes that use the updated access list', {
        accessListId: id,
        hostCount: affectedHosts.length,
      });
      const failures: { id: string; domainNames: string[]; error: string }[] = [];
      const attempted: { id: string }[] = [];
      for (const host of affectedHosts) {
        // A node that is offline or mid daemon update cannot take the config
        // now; its reconnect resync renders from the committed DB state. Only a
        // connected node rejecting the config rolls the change back.
        if (!(await this.isAnyServingNodeReachable(host))) {
          logger.warn('Skipping access list re-apply for host on unavailable node', {
            accessListId: id,
            hostId: host.id,
            nodeId: host.nodeId,
          });
          continue;
        }
        attempted.push(host);
        try {
          await this.hostRuntime!.reapplyHostConfig(host.id);
        } catch (error) {
          if (!(await this.isAnyServingNodeReachable(host))) {
            logger.warn('Node became unavailable during access list re-apply; it resyncs on reconnect', {
              accessListId: id,
              hostId: host.id,
              nodeId: host.nodeId,
              error,
            });
            continue;
          }
          failures.push({
            id: host.id,
            domainNames: host.domainNames as string[],
            error: error instanceof Error ? error.message : 'unknown error',
          });
        }
      }
      if (failures.length > 0) {
        await this.rollbackUpdate(existing, attempted);
        const names = failures.map((failure) => failure.domainNames[0] ?? failure.id).join(', ');
        throw new AppError(
          502,
          'ACCESS_LIST_APPLY_FAILED',
          `Access list was not changed: it could not be applied to ${names}`,
          { failedHosts: failures }
        );
      }
    }

    // Remove credentials only after every affected host config has stopped
    // referencing the file. Removing first creates an avoidable 403 window if
    // config application is delayed or fails.
    if (!usesFallbackBasicAuth(nginxAccessListOf(updated))) {
      await removeAccessListHtpasswd(this.db, this.nodeDispatch, id);
    }

    // 4. Audit log
    await this.auditService.log({
      userId,
      action: audit?.action ?? 'access_list.update',
      resourceType: 'access_list',
      resourceId: id,
      details: audit?.details ?? { changes: Object.keys(input) },
    });

    logger.info('Updated access list', { id });
    this.emitAcl(id, 'updated');

    return updated;
  }

  /**
   * A route on an ingress group is re-applied on its connected members (offline members resync on reconnect), so it
   * counts as reachable while any member is.
   */
  private async isAnyServingNodeReachable(host: { nodeId: string | null; ingressGroupId?: string | null }) {
    for (const nodeId of await resolveIngressNodes(this.db, host)) {
      if (await this.isNodeReachable(nodeId)) return true;
    }
    return false;
  }

  /** Connected and not in a daemon update, so a config apply can be judged. */
  private async isNodeReachable(nodeId: string | null): Promise<boolean> {
    if (!nodeId || !this.nodeDispatch.isNodeConnected(nodeId)) return false;
    return !(await this.nodeDispatch.isNodeUpdateInProgress(nodeId));
  }

  /**
   * Restore the previous list and re-apply it (config and credentials) to every
   * host the failed update touched. Hosts whose apply failed are re-applied too:
   * their node may have accepted the new credentials before the config failed.
   */
  private async rollbackUpdate(existing: AccessListRow, hosts: { id: string }[]): Promise<void> {
    try {
      await this.db
        .update(accessLists)
        .set({
          name: existing.name,
          description: existing.description,
          ...accessListModelOf(existing),
          updatedAt: existing.updatedAt,
        })
        .where(eq(accessLists.id, existing.id));
    } catch (error) {
      logger.error('Failed to roll back access list after apply failure', { accessListId: existing.id, error });
      return;
    }
    scheduleAccessPolicySync();
    for (const host of hosts) {
      try {
        await this.hostRuntime?.reapplyHostConfig(host.id);
      } catch (error) {
        logger.error('Failed to restore route config after access list rollback', {
          accessListId: existing.id,
          hostId: host.id,
          error,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  async delete(id: string, userId: string) {
    // 1. Get existing access list
    const existing = await this.db.query.accessLists.findFirst({
      where: eq(accessLists.id, id),
    });
    if (!existing) throw new AppError(404, 'ACCESS_LIST_NOT_FOUND', 'Access list not found');

    // 2. Check no proxy hosts reference this access list
    const referencingHosts = await this.db.query.proxyHosts.findMany({
      where: eq(proxyHosts.accessListId, id),
    });

    if (referencingHosts.length > 0) {
      const hostNames = referencingHosts.map((h) => (h.domainNames as string[]).join(', '));
      throw new AppError(
        409,
        'ACCESS_LIST_IN_USE',
        `Cannot delete access list: it is referenced by ${referencingHosts.length} route(s)`,
        { proxyHosts: hostNames }
      );
    }

    // Pages previews it protects would otherwise lose their credentials file
    // before the database refuses the delete.
    const referencingProjects = await this.db
      .select({ name: pageProjects.name })
      .from(pageProjects)
      .where(eq(pageProjects.accessListId, id));
    if (referencingProjects.length > 0) {
      throw new AppError(
        409,
        'ACCESS_LIST_IN_USE',
        `Cannot delete access list: it protects the previews of ${referencingProjects.length} Pages project(s)`,
        { pageProjects: referencingProjects.map((project) => project.name) }
      );
    }

    // 3. Remove htpasswd file
    await removeAccessListHtpasswd(this.db, this.nodeDispatch, id);

    // 4. Delete from DB
    await transactionWithScopeCleanup(this.db, (tx) => tx.delete(accessLists).where(eq(accessLists.id, id)));
    scheduleAccessPolicySync();

    // 5. Audit log
    await this.auditService.log({
      userId,
      action: 'access_list.delete',
      resourceType: 'access_list',
      resourceId: id,
      details: { name: existing.name },
    });

    logger.info('Deleted access list', { id, name: existing.name });
    this.emitAcl(id, 'deleted');
  }

  // -----------------------------------------------------------------------
  // Get single
  // -----------------------------------------------------------------------

  async get(id: string) {
    const accessList = await this.db.query.accessLists.findFirst({
      where: eq(accessLists.id, id),
    });
    if (!accessList) throw new AppError(404, 'ACCESS_LIST_NOT_FOUND', 'Access list not found');

    // Count how many proxy hosts reference this access list
    const [{ count: usageCount }] = await this.db
      .select({ count: count() })
      .from(proxyHosts)
      .where(eq(proxyHosts.accessListId, id));

    return {
      ...presentAccessList(accessList),
      proxyHostCount: Number(usageCount),
    };
  }

  // -----------------------------------------------------------------------
  // List
  // -----------------------------------------------------------------------

  async list(
    query: AccessListQuery,
    options?: { allowedIds?: string[] }
  ): Promise<PaginatedResponse<PresentedAccessList>> {
    const conditions = [];

    if (options?.allowedIds) {
      if (options.allowedIds.length === 0) {
        return {
          data: [],
          pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 },
        };
      }
      conditions.push(inArray(accessLists.id, options.allowedIds));
    }

    if (query.search) {
      conditions.push(ilike(accessLists.name, `%${escapeLike(query.search)}%`));
    }
    if (query.folderId) {
      conditions.push(eq(accessLists.folderId, query.folderId));
    }

    const where = buildWhere(conditions);
    // The order of the access list page: the folders as the tree shows them, then ungrouped lists.
    const folderIds = await folderTreeOrder(this.db, accessListFolders);

    const [entries, [{ count: totalCount }]] = await Promise.all([
      this.db
        .select()
        .from(accessLists)
        .where(where)
        .orderBy(...folderListOrder(folderIds, accessLists))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
      this.db.select({ count: count() }).from(accessLists).where(where),
    ]);

    const total = Number(totalCount);

    return {
      // Password hashes never leave the server.
      data: entries.map(presentAccessList),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Ends the sign-ins a changed or removed password no longer backs: the sessions of the list with the shared
   * password, and those of each user by password or basic authentication. The nodes drop them with the next sync.
   */
  private async revokeSignIns(accessListId: string, revoked: { shared: boolean; usernames: string[] }) {
    const ended = [
      ...(revoked.shared ? [eq(accessSessions.method, 'shared')] : []),
      ...(revoked.usernames.length > 0
        ? [
            and(
              inArray(accessSessions.method, ['password', 'basic']),
              inArray(accessSessions.subject, revoked.usernames)
            ),
          ]
        : []),
    ];
    if (ended.length === 0) return;
    await this.db
      .update(accessSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(accessSessions.accessListId, accessListId), isNull(accessSessions.revokedAt), or(...ended)));
  }

  /** A list offers only identity providers that exist (`idp:<id>`). */
  private async assertIdentityProviders(model: AccessListModel): Promise<void> {
    const providerIds = model.signInMethods
      .filter((method) => method.startsWith('idp:'))
      .map((method) => method.slice(4));
    if (providerIds.length === 0) return;
    const found = await this.db
      .select({ id: accessIdentityProviders.id })
      .from(accessIdentityProviders)
      .where(inArray(accessIdentityProviders.id, providerIds));
    const missing = providerIds.filter((providerId) => !found.some((provider) => provider.id === providerId));
    if (missing.length > 0) {
      throw new AppError(
        400,
        'IDENTITY_PROVIDER_NOT_FOUND',
        `Unknown identity provider: ${missing.map((providerId) => `idp:${providerId}`).join(', ')}`,
        { providerIds: missing }
      );
    }
  }
}
