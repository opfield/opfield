import bcrypt from 'bcryptjs';
import { and, count, desc, eq, ilike, inArray, isNull, max } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import type { BasicAuthUser, IPRule } from '@/db/schema/access-lists.js';
import { accessLists, nodes, pageProjects } from '@/db/schema/index.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';
import { createChildLogger } from '@/lib/logger.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { buildWhere, escapeLike } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { resolveIngressNodes, resolveIngressNodesForMany } from '@/modules/ingress-groups/ingress-nodes.js';
import type { NginxTemplateService } from '@/modules/proxy/nginx-template.service.js';
import { accessListLockKey, runOutsideProxyLocks, withProxyLocks } from '@/modules/proxy/proxy-host-lock.js';
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
import { analyzeAccessListIpRules } from './ip-rule-analysis.js';

const logger = createChildLogger('AccessListService');
const BCRYPT_ROUNDS = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AccessListRow = typeof accessLists.$inferSelect;

/**
 * The API shape of a list: usernames only (password hashes never leave the server) and the rules that cannot
 * change the outcome, so a person, an API client and an agent see the same warnings.
 */
function presentAccessList<T extends Pick<AccessListRow, 'ipRules' | 'basicAuthUsers'>>(row: T) {
  return {
    ...row,
    basicAuthUsers: ((row.basicAuthUsers as BasicAuthUser[]) ?? []).map((user) => ({ username: user.username })),
    // API and MCP callers act on the 0-based index (move_rule), so the message names it.
    ipRuleWarnings: analyzeAccessListIpRules((row.ipRules as IPRule[]) ?? [], 'index'),
  };
}

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
    if (input.basicAuthEnabled && input.basicAuthUsers.length === 0) {
      throw new AppError(400, 'BASIC_AUTH_USERS_REQUIRED', 'Add at least one user to enable basic authentication');
    }
    // 1. Hash basic auth passwords before storing
    const hashedUsers = input.basicAuthUsers.length > 0 ? await this.hashPasswords(input.basicAuthUsers) : [];

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
        ipRules: input.ipRules,
        basicAuthEnabled: input.basicAuthEnabled,
        basicAuthUsers: hashedUsers,
        createdById: userId,
      })
      .returning();

    // 3. Write htpasswd file for nginx if basic auth enabled
    if (input.basicAuthEnabled && hashedUsers.length > 0) {
      await this.writeHtpasswd(accessList.id, hashedUsers);
    }

    // 4. Audit log
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

  async update(id: string, input: UpdateAccessListInput, userId: string) {
    // Serialize edits of one list so two updates cannot interleave their
    // re-apply and rollback phases.
    const updated = await withProxyLocks([accessListLockKey(id)], () => this.updateLocked(id, input, userId));
    return presentAccessList(updated);
  }

  /**
   * Moves one IP rule to another position (both 0-based; the rules between shift by one), under the same lock as
   * an update, so the move applies to the rules as they are now and not to a copy a client read earlier. The
   * routes and Pages previews that use the list are re-applied like on any other edit.
   */
  async moveIpRule(id: string, input: MoveAccessListIpRuleInput, userId: string) {
    const updated = await withProxyLocks([accessListLockKey(id)], async () => {
      const existing = await this.db.query.accessLists.findFirst({ where: eq(accessLists.id, id) });
      if (!existing) throw new AppError(404, 'ACCESS_LIST_NOT_FOUND', 'Access list not found');
      const rules = [...((existing.ipRules as IPRule[]) ?? [])];
      const { fromIndex, toIndex } = input;
      if (fromIndex >= rules.length || toIndex >= rules.length) {
        throw new AppError(
          400,
          'IP_RULE_INDEX_OUT_OF_RANGE',
          `The access list has ${rules.length} IP rule(s); fromIndex and toIndex are 0-based positions below that`
        );
      }
      if (fromIndex === toIndex) return existing;
      const [moved] = rules.splice(fromIndex, 1);
      rules.splice(toIndex, 0, moved);
      return this.updateLocked(id, { ipRules: rules }, userId, {
        action: 'access_list.move_ip_rule',
        details: { fromIndex, toIndex, rule: moved },
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
    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) updateData.name = input.name;
    if (input.description !== undefined) updateData.description = input.description?.trim() || null;
    if (input.ipRules !== undefined) updateData.ipRules = input.ipRules;
    if (input.basicAuthEnabled !== undefined) updateData.basicAuthEnabled = input.basicAuthEnabled;

    const existingBasicAuthUsers = (existing.basicAuthUsers as BasicAuthUser[]) ?? [];
    let nextBasicAuthUsers = existingBasicAuthUsers;
    if (input.basicAuthUsers !== undefined) {
      const hashedUsers: BasicAuthUser[] = [];

      for (const user of input.basicAuthUsers) {
        if (user.password) {
          hashedUsers.push({
            username: user.username,
            passwordHash: await bcrypt.hash(user.password, BCRYPT_ROUNDS),
          });
          continue;
        }

        const existingUser = existingBasicAuthUsers.find((candidate) => candidate.username === user.username);
        if (!existingUser) {
          throw new AppError(
            400,
            'BASIC_AUTH_PASSWORD_REQUIRED',
            `Password required for basic auth user "${user.username}"`
          );
        }
        hashedUsers.push(existingUser);
      }

      updateData.basicAuthUsers = hashedUsers;
      nextBasicAuthUsers = hashedUsers;
    }
    const nextBasicAuthEnabled = input.basicAuthEnabled ?? existing.basicAuthEnabled;
    if (nextBasicAuthEnabled && nextBasicAuthUsers.length === 0) {
      throw new AppError(400, 'BASIC_AUTH_USERS_REQUIRED', 'Add at least one user to enable basic authentication');
    }

    const affectedHosts = await this.db.query.proxyHosts.findMany({
      where: and(eq(proxyHosts.accessListId, id), eq(proxyHosts.enabled, true)),
      columns: { id: true, domainNames: true, nodeId: true, ingressGroupId: true },
    });
    if (affectedHosts.length > 0 && !this.hostRuntime) {
      throw new AppError(503, 'PROXY_SERVICE_UNAVAILABLE', 'Route re-apply is unavailable');
    }

    // 3. Commit, then re-apply every enabled host through the normal proxy
    // build/apply path. That path also deploys the list's credentials to the
    // host's node before the config that references them.
    const [updated] = await this.db.update(accessLists).set(updateData).where(eq(accessLists.id, id)).returning();

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
    const basicAuthUsers = updated.basicAuthUsers as BasicAuthUser[];
    if (!(updated.basicAuthEnabled && basicAuthUsers.length > 0)) {
      await this.removeHtpasswd(id);
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
          ipRules: existing.ipRules,
          basicAuthEnabled: existing.basicAuthEnabled,
          basicAuthUsers: existing.basicAuthUsers,
          updatedAt: existing.updatedAt,
        })
        .where(eq(accessLists.id, existing.id));
    } catch (error) {
      logger.error('Failed to roll back access list after apply failure', { accessListId: existing.id, error });
      return;
    }
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
    await this.removeHtpasswd(id);

    // 4. Delete from DB
    await transactionWithScopeCleanup(this.db, (tx) => tx.delete(accessLists).where(eq(accessLists.id, id)));

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

  async list(query: AccessListQuery, options?: { allowedIds?: string[] }): Promise<PaginatedResponse<AccessListRow>> {
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

    const [entries, [{ count: totalCount }]] = await Promise.all([
      this.db.query.accessLists.findMany({
        where: where ? () => where : undefined,
        orderBy: [desc(accessLists.createdAt)],
        limit: query.limit,
        offset: (query.page - 1) * query.limit,
      }),
      this.db.select({ count: count() }).from(accessLists).where(where),
    ]);

    const total = Number(totalCount);

    // Strip password hashes from list responses
    const sanitizedEntries = entries.map(presentAccessList);

    return {
      data: sanitizedEntries as unknown as AccessListRow[],
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  // -----------------------------------------------------------------------
  // Helpers — htpasswd file management
  // -----------------------------------------------------------------------

  /**
   * Write htpasswd file for nginx basic auth.
   * Format: username:$2y$... (bcrypt hash)
   * Writes to: {configPath}/htpasswd/access-list-{id}
   */
  private async writeHtpasswd(accessListId: string, users: BasicAuthUser[]): Promise<void> {
    const content = `${users.map((u) => `${u.username}:${u.passwordHash}`).join('\n')}\n`;

    // Deploy htpasswd to all nodes that have hosts using this access list
    const hostsUsingList = await this.db
      .select({ nodeId: proxyHosts.nodeId, ingressGroupId: proxyHosts.ingressGroupId })
      .from(proxyHosts)
      .where(eq(proxyHosts.accessListId, accessListId));

    // Every serving node, including every member of a route's ingress group.
    const nodeIds = [...new Set([...(await resolveIngressNodesForMany(this.db, hostsUsingList)).values()].flat())];

    for (const nodeId of nodeIds) {
      const result = await this.nodeDispatch.deployHtpasswd(nodeId, accessListId, content);
      if (!result.success) {
        throw new AppError(
          502,
          'HTPASSWD_DEPLOY_FAILED',
          result.error || `Failed to deploy access list credentials to node ${nodeId}`
        );
      }
    }
    logger.debug('Htpasswd deployed to nodes', { accessListId, nodeCount: nodeIds.length });
  }

  /**
   * Remove the list's credentials once no route config references them (basic auth turned off, or the list
   * deleted) from every connected Nginx node: a node keeps them from routes that moved away or dropped the list
   * earlier, so the routes using the list now do not name every node that holds them. A node that is not connected
   * drops them in its reconnect sync, which removes the credentials no config of the node references.
   */
  private async removeHtpasswd(accessListId: string): Promise<void> {
    // Pages previews render the same htpasswd file on their Project's node(s);
    // removing it there would break a protected preview.
    const pagesUsingList = await this.db.query.pageProjects.findMany({
      where: (projects, { eq: equals }) => equals(projects.accessListId, accessListId),
      columns: { nodeId: true, migrationTargetNodeId: true },
    });
    const pagesNodeIds = new Set(
      pagesUsingList.flatMap((project) => [project.nodeId, project.migrationTargetNodeId]).filter(Boolean)
    );

    const nginxNodes = await this.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.type, 'nginx'));
    const nodeIds = nginxNodes
      .map((node) => node.id)
      .filter((nodeId) => !pagesNodeIds.has(nodeId) && this.nodeDispatch.isNodeConnected(nodeId));

    for (const nodeId of nodeIds) {
      try {
        const result = await this.nodeDispatch.removeHtpasswd(nodeId, accessListId);
        if (!result.success) {
          logger.warn('Failed to remove stale htpasswd file from node', {
            accessListId,
            nodeId,
            error: result.error,
          });
        }
      } catch (error) {
        logger.warn('Failed to remove stale htpasswd file from node', { accessListId, nodeId, error });
      }
    }
    logger.debug('Htpasswd removed from nodes', { accessListId });
  }

  // -----------------------------------------------------------------------
  // Helpers — password hashing
  // -----------------------------------------------------------------------

  private async hashPasswords(users: { username: string; password: string }[]): Promise<BasicAuthUser[]> {
    return Promise.all(
      users.map(async (u) => ({
        username: u.username,
        passwordHash: await bcrypt.hash(u.password, BCRYPT_ROUNDS),
      }))
    );
  }
}
