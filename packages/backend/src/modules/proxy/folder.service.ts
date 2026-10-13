import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor, DrizzleTransaction } from '@/db/client.js';
import { proxyHostFolders } from '@/db/schema/proxy-host-folders.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';
import { createChildLogger } from '@/lib/logger.js';
import { announceResourceScopeChanges, removeDanglingResourceScopes } from '@/lib/resource-scope-cleanup.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import { appMemberFolderCondition, withAppMembers } from '@/modules/apps/app-membership.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import {
  assertFolderMoveAccess,
  type FolderMoveAccess,
  folderNameKey,
  resourceInAppError,
} from '@/modules/resource-folders/resource-folder.service.js';
import { assertFolderManage, type FolderManageAccess } from '@/modules/resource-folders/resource-folder-access.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type {
  CreateFolderInput,
  GroupedHostsQuery,
  MoveFolderInput,
  MoveHostsToFolderInput,
  ReorderFoldersInput,
  ReorderHostsInput,
  UpdateFolderInput,
} from './folder.schemas.js';
import type { PageUpstreamDisplayTarget } from './proxy-upstream-display.js';
import { attachDockerUpstreamDisplay } from './proxy-upstream-display.js';

const logger = createChildLogger('FolderService');

const MAX_DEPTH = 2; // 0, 1, 2 = three levels

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FolderRow = typeof proxyHostFolders.$inferSelect;

/** User folders: every folder surface here leaves out the hidden folders apps own. */
const USER_FOLDERS = isNull(proxyHostFolders.appId);
type ProxyHostRow = typeof proxyHosts.$inferSelect;

/** Compute effective health status and return a plain object (Drizzle rows are class instances) */
function toPlainHost(
  host: ProxyHostRow & {
    dockerDeploymentName?: string | null;
    dockerNodeSlug?: string | null;
    dockerNodeAppearanceColor?: string | null;
    pageTarget?: PageUpstreamDisplayTarget | null;
  }
): Record<string, unknown> {
  const plain: Record<string, unknown> = {};
  for (const key of Object.keys(proxyHosts) as Array<keyof typeof proxyHosts>) {
    if (key in host) plain[key] = (host as any)[key];
  }

  delete plain.healthHistory;
  plain.dockerDeploymentName = host.dockerDeploymentName;
  plain.dockerNodeSlug = host.dockerNodeSlug;
  plain.dockerNodeAppearanceColor = host.dockerNodeAppearanceColor;
  plain.pageTarget = host.pageTarget ?? null;
  let effectiveStatus = host.rawConfigEnabled ? 'disabled' : (host.healthStatus as string);
  if (
    !host.rawConfigEnabled &&
    host.healthStatus === 'online' &&
    Array.isArray(host.healthHistory) &&
    host.healthHistory.length > 0
  ) {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const recent = (host.healthHistory as Array<{ ts?: string; status: string }>).filter(
      (h) => h.ts && new Date(h.ts).getTime() >= fiveMinAgo
    );
    if (recent.some((h) => h.status === 'offline' || h.status === 'degraded')) {
      effectiveStatus = 'recovering';
    }
  }
  plain.effectiveHealthStatus = effectiveStatus;
  return plain;
}

export interface FolderTreeNode extends FolderRow {
  children: FolderTreeNode[];
  hosts: ProxyHostRow[];
}

export interface GroupedHostsResponse {
  folders: FolderTreeNode[];
  ungroupedHosts: ProxyHostRow[];
  totalHosts: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FolderService {
  private eventBus?: EventBusService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  private emitLayoutChanged(action: string, folderId?: string | null) {
    this.eventBus?.publish('proxy.host.changed', { action, folderId });
  }

  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  async createFolder(input: CreateFolderInput, userId: string) {
    const folder = await this.withTreeLock(async (tx) => {
      let depth = 0;
      if (input.parentId) {
        const parent = await this.findFolder(input.parentId, tx);
        if (!parent) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Parent folder not found');
        if (parent.depth >= MAX_DEPTH) {
          throw new AppError(400, 'MAX_DEPTH_EXCEEDED', `Maximum folder nesting depth is ${MAX_DEPTH + 1} levels`);
        }
        depth = parent.depth + 1;
      }

      const [created] = await tx
        .insert(proxyHostFolders)
        .values({
          name: input.name,
          parentId: input.parentId ?? null,
          sortOrder: await this.nextSortOrder(input.parentId ?? null, tx),
          depth,
          createdById: userId,
        })
        .returning();
      return created;
    });

    await this.auditService.log({
      userId,
      action: 'proxy_host_folder.create',
      resourceType: 'proxy_host_folder',
      resourceId: folder.id,
      details: { name: folder.name, parentId: folder.parentId },
    });

    logger.info('Created folder', { folderId: folder.id, name: folder.name });
    this.emitLayoutChanged('folder_created', folder.id);
    return folder;
  }

  /**
   * Folder create, move and delete run one at a time, in one transaction under an advisory lock, like
   * FolderedResourceService. Two concurrent moves (A under B, B under A) would otherwise both pass the descendant
   * check and commit a parent cycle, and depth bookkeeping would drift.
   */
  private withTreeLock<T>(fn: (tx: DrizzleTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'resource-folders:proxy_host_folder'}))`);
      return fn(tx);
    });
  }

  /** A user folder; hidden app folders are managed by the apps module only. */
  private async findFolder(id: string, db: DrizzleExecutor = this.db) {
    const [folder] = await db
      .select()
      .from(proxyHostFolders)
      .where(and(USER_FOLDERS, eq(proxyHostFolders.id, id)))
      .limit(1);
    return folder;
  }

  /**
   * A Route update that changes its folder: a user folder only, and never out of an app (members leave an app only
   * through Move to App).
   */
  async assertFolderChange(fromId: string | null, toId: string | null): Promise<void> {
    if ((await this.hiddenFolderIds([fromId, toId])).size > 0) throw resourceInAppError();
    if (toId && !(await this.findFolder(toId))) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
  }

  /** IDs of the hidden app folders among `ids` (Routes there are app members). */
  async hiddenFolderIds(ids: ReadonlyArray<string | null>): Promise<Set<string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Set();
    const rows = await this.db
      .select({ id: proxyHostFolders.id })
      .from(proxyHostFolders)
      .where(and(inArray(proxyHostFolders.id, unique), isNotNull(proxyHostFolders.appId)));
    return new Set(rows.map((row) => row.id));
  }

  private async nextSortOrder(parentId: string | null, db: DrizzleExecutor = this.db): Promise<number> {
    const siblings = await db
      .select({ sortOrder: proxyHostFolders.sortOrder })
      .from(proxyHostFolders)
      .where(and(USER_FOLDERS, parentId ? eq(proxyHostFolders.parentId, parentId) : isNull(proxyHostFolders.parentId)))
      .orderBy(desc(proxyHostFolders.sortOrder))
      .limit(1);
    return siblings.length > 0 ? siblings[0].sortOrder + 1 : 0;
  }

  /**
   * Destination check of create paths: a user folder, or the hidden folder of an app environment (a create from an
   * app passes the environment's placement folder). An app root folder is never a destination.
   */
  async assertFolderExists(id: string | null | undefined): Promise<void> {
    if (!id) return;
    const folder = await this.db.query.proxyHostFolders.findFirst({ where: eq(proxyHostFolders.id, id) });
    if (!folder || (folder.appId && !folder.appEnvironmentId)) {
      throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
    }
  }

  // -----------------------------------------------------------------------
  // Update (rename)
  // -----------------------------------------------------------------------

  async updateFolder(id: string, input: UpdateFolderInput, userId: string) {
    const existing = await this.findFolder(id);
    if (!existing) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');

    const [updated] = await this.db
      .update(proxyHostFolders)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(proxyHostFolders.id, id))
      .returning();

    await this.auditService.log({
      userId,
      action: 'proxy_host_folder.update',
      resourceType: 'proxy_host_folder',
      resourceId: id,
      details: { oldName: existing.name, newName: input.name },
    });

    logger.info('Renamed folder', { folderId: id, name: input.name });
    this.emitLayoutChanged('folder_updated', id);
    return updated;
  }

  // -----------------------------------------------------------------------
  // Move folder to new parent
  // -----------------------------------------------------------------------

  async moveFolder(
    id: string,
    input: MoveFolderInput,
    userId: string,
    access: FolderMoveAccess,
    manage?: FolderManageAccess
  ) {
    const result = await this.withTreeLock(async (tx) => {
      // Read inside the lock: a concurrent move has either committed or not started.
      const folder = await this.findFolder(id, tx);
      if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
      if (folder.parentId === input.parentId) return { folder, moved: false as const };
      // A folder-scoped manager must manage both the place the folder leaves and the place it goes.
      if (manage) {
        assertFolderManage(manage.scopes, manage.manageScope, folder.parentId);
        assertFolderManage(manage.scopes, manage.manageScope, input.parentId);
      }

      const descendants = await this.getDescendantIds(id, tx);
      let newDepth = 0;
      if (input.parentId) {
        if (input.parentId === id || descendants.includes(input.parentId)) {
          throw new AppError(400, 'CIRCULAR_REFERENCE', 'Cannot move folder into its own descendant');
        }
        const newParent = await this.findFolder(input.parentId, tx);
        if (!newParent) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Target parent folder not found');
        newDepth = newParent.depth + 1;
      }

      const siblings = await tx
        .select({ id: proxyHostFolders.id, name: proxyHostFolders.name })
        .from(proxyHostFolders)
        .where(
          and(
            USER_FOLDERS,
            input.parentId ? eq(proxyHostFolders.parentId, input.parentId) : isNull(proxyHostFolders.parentId)
          )
        );
      const nameKey = folderNameKey(folder.name);
      if (siblings.some((sibling) => sibling.id !== id && folderNameKey(sibling.name ?? '') === nameKey)) {
        throw new AppError(
          409,
          'FOLDER_NAME_CONFLICT',
          `A folder named "${folder.name.trim()}" already exists in the destination`
        );
      }

      // Check depth constraints for the entire subtree
      const subtreeHeight = (await this.getMaxSubtreeDepth(id, descendants, tx)) - folder.depth;
      if (newDepth + subtreeHeight > MAX_DEPTH) {
        throw new AppError(
          400,
          'MAX_DEPTH_EXCEEDED',
          `Moving this folder would exceed the maximum nesting depth of ${MAX_DEPTH + 1} levels`
        );
      }

      const movedHosts = await tx
        .select({ id: proxyHosts.id })
        .from(proxyHosts)
        .where(inArray(proxyHosts.folderId, [id, ...descendants]));
      assertFolderMoveAccess(
        access,
        movedHosts.map((host) => host.id),
        input.parentId
      );

      const [updated] = await tx
        .update(proxyHostFolders)
        .set({
          parentId: input.parentId,
          depth: newDepth,
          sortOrder: await this.nextSortOrder(input.parentId, tx),
          updatedAt: new Date(),
        })
        .where(eq(proxyHostFolders.id, id))
        .returning();

      const depthDelta = newDepth - folder.depth;
      if (depthDelta !== 0 && descendants.length > 0) {
        await tx
          .update(proxyHostFolders)
          .set({ depth: sql`${proxyHostFolders.depth} + ${depthDelta}`, updatedAt: new Date() })
          .where(inArray(proxyHostFolders.id, descendants));
      }
      return { folder, moved: true as const, updated };
    });
    if (!result.moved) return result.folder;

    await this.auditService.log({
      userId,
      action: 'proxy_host_folder.move',
      resourceType: 'proxy_host_folder',
      resourceId: id,
      details: { oldParentId: result.folder.parentId, newParentId: input.parentId },
    });

    logger.info('Moved folder', { folderId: id, newParentId: input.parentId });
    this.emitLayoutChanged('folder_updated', id);
    return result.updated;
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  /** Parent of each folder (null: top level); 404 when one does not exist. */
  async getFolderParentIds(ids: readonly string[]): Promise<Map<string, string | null>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ id: proxyHostFolders.id, parentId: proxyHostFolders.parentId })
      .from(proxyHostFolders)
      .where(and(USER_FOLDERS, inArray(proxyHostFolders.id, unique)));
    if (rows.length !== unique.length) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
    return new Map(rows.map((row) => [row.id, row.parentId ?? null]));
  }

  /** Current folder of each Route (null: ungrouped). Unknown IDs are left out. */
  async getResourceFolderIds(ids: readonly string[]): Promise<Map<string, string | null>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ id: proxyHosts.id, folderId: proxyHosts.folderId })
      .from(proxyHosts)
      .where(inArray(proxyHosts.id, unique));
    return new Map(rows.map((row) => [row.id, row.folderId ?? null]));
  }

  async deleteFolder(id: string, userId: string) {
    const { folder, descendantIds, affectedHosts, scopeChanges } = await this.withTreeLock(async (tx) => {
      const folder = await this.findFolder(id, tx);
      if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');

      // Count affected items for audit log
      const descendantIds = await this.getDescendantIds(id, tx);
      const affectedHosts = await tx
        .select({ id: proxyHosts.id })
        .from(proxyHosts)
        .where(inArray(proxyHosts.folderId, [id, ...descendantIds]));

      // CASCADE deletes subfolders, SET NULL ungroups hosts; grants on the deleted folders go with them.
      await tx.delete(proxyHostFolders).where(eq(proxyHostFolders.id, id));
      return { folder, descendantIds, affectedHosts, scopeChanges: await removeDanglingResourceScopes(tx) };
    });
    await announceResourceScopeChanges(scopeChanges);

    await this.auditService.log({
      userId,
      action: 'proxy_host_folder.delete',
      resourceType: 'proxy_host_folder',
      resourceId: id,
      details: {
        name: folder.name,
        subfoldersDeleted: descendantIds.length,
        hostsUngrouped: affectedHosts.length,
      },
    });

    logger.info('Deleted folder', {
      folderId: id,
      subfoldersDeleted: descendantIds.length,
      hostsUngrouped: affectedHosts.length,
    });

    this.emitLayoutChanged('folder_deleted', id);
  }

  // -----------------------------------------------------------------------
  // Reorder
  // -----------------------------------------------------------------------

  async reorderFolders(input: ReorderFoldersInput) {
    for (const item of input.items) {
      await this.db
        .update(proxyHostFolders)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(and(USER_FOLDERS, eq(proxyHostFolders.id, item.id)));
    }

    this.emitLayoutChanged('folders_reordered');
  }

  // -----------------------------------------------------------------------
  // Get folder tree
  // -----------------------------------------------------------------------

  async getFolderTree(options?: {
    allowedHostIds?: string[];
    allowedFolderIds?: string[];
    includeAllFolders?: boolean;
  }): Promise<FolderTreeNode[]> {
    const allFolders = await this.db
      .select()
      .from(proxyHostFolders)
      .where(USER_FOLDERS)
      .orderBy(asc(proxyHostFolders.depth), asc(proxyHostFolders.sortOrder));

    if (options?.includeAllFolders) return this.buildTree(allFolders, []);
    if (options?.allowedHostIds || options?.allowedFolderIds) {
      const visibleHosts =
        options.allowedHostIds && options.allowedHostIds.length > 0
          ? await this.db.select().from(proxyHosts).where(inArray(proxyHosts.id, options.allowedHostIds))
          : [];
      return this.pruneFolderTree(this.buildTree(allFolders, visibleHosts), new Set(options.allowedFolderIds ?? []));
    }

    return this.buildTree(allFolders, []);
  }

  // -----------------------------------------------------------------------
  // Get grouped hosts (main endpoint for the proxy hosts page)
  // -----------------------------------------------------------------------

  async getGroupedHosts(
    query: GroupedHostsQuery,
    options?: { allowedHostIds?: string[]; allowedFolderIds?: string[]; includeAllFolders?: boolean }
  ): Promise<GroupedHostsResponse> {
    // 1. Fetch all folders
    const allFolders = await this.db
      .select()
      .from(proxyHostFolders)
      .where(USER_FOLDERS)
      .orderBy(asc(proxyHostFolders.depth), asc(proxyHostFolders.sortOrder));
    const allowedFolderIds = new Set(options?.allowedFolderIds ?? []);

    // 2. Fetch all hosts (with optional filters)
    const conditions = [eq(proxyHosts.isSystem, false)];
    if (options?.allowedHostIds) {
      if (options.allowedHostIds.length === 0) {
        if (query.appId) return { folders: [], ungroupedHosts: [], totalHosts: 0 };
        const emptyTree = this.buildTree(allFolders, []);
        return {
          folders: options.includeAllFolders
            ? emptyTree
            : allowedFolderIds.size > 0
              ? this.mapGroupedTree(this.pruneFolderTree(emptyTree, allowedFolderIds))
              : [],
          ungroupedHosts: [],
          totalHosts: 0,
        };
      }
      conditions.push(inArray(proxyHosts.id, options.allowedHostIds));
    }
    if (query.type) {
      conditions.push(eq(proxyHosts.type, query.type));
    }
    if (query.enabled !== undefined) {
      conditions.push(eq(proxyHosts.enabled, query.enabled));
    }
    if (query.healthStatus) {
      conditions.push(
        query.healthStatus === 'disabled'
          ? or(eq(proxyHosts.healthStatus, 'disabled'), eq(proxyHosts.rawConfigEnabled, true))!
          : and(eq(proxyHosts.healthStatus, query.healthStatus), eq(proxyHosts.rawConfigEnabled, false))!
      );
    }
    if (query.search) {
      conditions.push(ilike(sql`${proxyHosts.domainNames}::text`, `%${query.search}%`));
    }

    // Without `appId`, app members are not listed here (they appear on their app's page). With `appId`, only that
    // app's routes: they sit in the app's hidden folders, so they come back flat in `ungroupedHosts` with their `app`.
    const appFilter = appMemberFolderCondition(
      proxyHosts.folderId,
      proxyHostFolders,
      query.appId ? { appId: query.appId } : { excludeAppMembers: true }
    );
    if (appFilter) conditions.push(appFilter);
    const where = buildWhere(conditions);

    const hostRows = await this.db
      .select()
      .from(proxyHosts)
      .where(where)
      .orderBy(asc(proxyHosts.sortOrder), desc(proxyHosts.createdAt));
    const allHosts = await attachDockerUpstreamDisplay(this.db, hostRows);
    if (query.appId) {
      const members = await withAppMembers('routes', allHosts.map(toPlainHost), { appId: query.appId });
      return { folders: [], ungroupedHosts: members as any, totalHosts: members.length };
    }

    // 3. Group hosts by folderId
    const hostsByFolder = new Map<string | null, ProxyHostRow[]>();
    for (const host of allHosts) {
      const key = host.folderId;
      if (!hostsByFolder.has(key)) hostsByFolder.set(key, []);
      hostsByFolder.get(key)!.push(host);
    }

    // 4. Build tree with hosts attached
    const tree = this.buildTree(allFolders, allHosts);

    // 5. Ungrouped hosts (folderId = null)
    const ungroupedHosts = hostsByFolder.get(null) ?? [];

    // 6. Convert to plain objects with effectiveHealthStatus
    const visibleTree = options?.includeAllFolders
      ? tree
      : allowedFolderIds.size > 0
        ? this.pruneFolderTree(tree, allowedFolderIds)
        : this.pruneEmptyBranches(tree);

    return {
      folders: this.mapGroupedTree(visibleTree),
      ungroupedHosts: ungroupedHosts.map(toPlainHost) as any,
      totalHosts: allHosts.length,
    };
  }

  // -----------------------------------------------------------------------
  // Move hosts to folder (batch)
  // -----------------------------------------------------------------------

  async moveHostsToFolder(input: MoveHostsToFolderInput, userId: string) {
    // Validate folder exists if not null
    if (input.folderId) {
      const folder = await this.findFolder(input.folderId);
      if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Target folder not found');
    }

    const selectedHosts = await this.db
      .select({ id: proxyHosts.id, isSystem: proxyHosts.isSystem, folderId: proxyHosts.folderId })
      .from(proxyHosts)
      .where(inArray(proxyHosts.id, input.hostIds));
    if (selectedHosts.some((host) => host.isSystem)) {
      throw new AppError(403, 'SYSTEM_HOST', 'System routes cannot be moved');
    }
    if ((await this.hiddenFolderIds(selectedHosts.map((host) => host.folderId))).size > 0) throw resourceInAppError();

    await this.db
      .update(proxyHosts)
      .set({ folderId: input.folderId, updatedAt: new Date() })
      .where(inArray(proxyHosts.id, input.hostIds));

    await this.auditService.log({
      userId,
      action: 'proxy_host.move_to_folder',
      resourceType: 'proxy_host',
      details: { hostIds: input.hostIds, folderId: input.folderId },
    });

    logger.info('Moved hosts to folder', {
      hostCount: input.hostIds.length,
      folderId: input.folderId,
    });

    this.emitLayoutChanged('hosts_moved', input.folderId);
  }

  // -----------------------------------------------------------------------
  // Reorder hosts within a folder
  // -----------------------------------------------------------------------

  async reorderHosts(input: ReorderHostsInput) {
    const selectedHosts = await this.db
      .select({ id: proxyHosts.id, isSystem: proxyHosts.isSystem })
      .from(proxyHosts)
      .where(
        inArray(
          proxyHosts.id,
          input.items.map((item) => item.id)
        )
      );
    if (selectedHosts.some((host) => host.isSystem)) {
      throw new AppError(403, 'SYSTEM_HOST', 'System routes cannot be reordered');
    }

    for (const item of input.items) {
      await this.db
        .update(proxyHosts)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(eq(proxyHosts.id, item.id));
    }

    this.emitLayoutChanged('hosts_reordered');
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private buildTree(folders: FolderRow[], hosts: ProxyHostRow[]): FolderTreeNode[] {
    // Group hosts by folderId
    const hostsByFolder = new Map<string, ProxyHostRow[]>();
    for (const host of hosts) {
      if (host.folderId) {
        if (!hostsByFolder.has(host.folderId)) hostsByFolder.set(host.folderId, []);
        hostsByFolder.get(host.folderId)!.push(host);
      }
    }

    // Build nodes
    const nodeMap = new Map<string, FolderTreeNode>();
    for (const folder of folders) {
      nodeMap.set(folder.id, {
        ...folder,
        children: [],
        hosts: hostsByFolder.get(folder.id) ?? [],
      });
    }

    // Build tree
    const roots: FolderTreeNode[] = [];
    for (const node of nodeMap.values()) {
      if (node.parentId && nodeMap.has(node.parentId)) {
        nodeMap.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  private pruneEmptyBranches(nodes: FolderTreeNode[]): FolderTreeNode[] {
    return nodes
      .map((node) => ({ ...node, children: this.pruneEmptyBranches(node.children) }))
      .filter((node) => node.hosts.length > 0 || node.children.length > 0);
  }

  private mapGroupedTree(nodes: FolderTreeNode[]): any[] {
    return nodes.map((node) => ({
      ...node,
      hosts: node.hosts.map(toPlainHost),
      children: this.mapGroupedTree(node.children),
    }));
  }

  private pruneFolderTree(nodes: FolderTreeNode[], allowedFolderIds: Set<string>): FolderTreeNode[] {
    return nodes
      .map((node) => ({ ...node, children: this.pruneFolderTree(node.children, allowedFolderIds) }))
      .filter((node) => allowedFolderIds.has(node.id) || node.hosts.length > 0 || node.children.length > 0);
  }

  /**
   * Every folder below `folderId`. The visited set keeps this finite even if the stored tree already contains a
   * parent cycle (written before moves were serialized).
   */
  private async getDescendantIds(folderId: string, db: DrizzleExecutor = this.db): Promise<string[]> {
    const visited = new Set<string>([folderId]);
    const descendants: string[] = [];
    let currentLevel = [folderId];
    while (currentLevel.length > 0) {
      const children = await db
        .select({ id: proxyHostFolders.id })
        .from(proxyHostFolders)
        .where(inArray(proxyHostFolders.parentId, currentLevel));
      const nextLevel: string[] = [];
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        descendants.push(child.id);
        nextLevel.push(child.id);
      }
      currentLevel = nextLevel;
    }
    return descendants;
  }

  private async getMaxSubtreeDepth(
    folderId: string,
    descendantIds: readonly string[],
    db: DrizzleExecutor = this.db
  ): Promise<number> {
    const [result] = await db
      .select({ maxDepth: sql<number>`max(${proxyHostFolders.depth})` })
      .from(proxyHostFolders)
      .where(inArray(proxyHostFolders.id, [folderId, ...descendantIds]));
    return result?.maxDepth ?? 0;
  }
}
