import { and, asc, desc, eq, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor, DrizzleTransaction } from '@/db/client.js';
import { hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { announceResourceScopeChanges, removeDanglingResourceScopes } from '@/lib/resource-scope-cleanup.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type {
  CreateResourceFolderInput,
  MoveResourceFolderInput,
  MoveResourcesToFolderInput,
  ReorderResourceFoldersInput,
  ReorderResourcesInput,
  UpdateResourceFolderInput,
} from './resource-folder.schemas.js';
import { assertFolderManage, type FolderManageAccess } from './resource-folder-access.js';

const MAX_DEPTH = 2;

/** Caller permissions for moving a whole folder subtree. */
export interface FolderMoveAccess {
  scopes: readonly string[];
  /** Scope that authorizes changing where a resource lives, e.g. `databases:edit`. */
  editScope: string;
}

/**
 * A folder move re-parents every resource inside the folder and its
 * subfolders. Folder-scoped grants on the destination (for example
 * `databases:credentials:reveal:folder/F`) then extend to all of them, so the
 * caller must be allowed to edit every moved resource and to place resources
 * in the destination, exactly as for moving the resources one by one.
 */
export function assertFolderMoveAccess(
  access: FolderMoveAccess,
  resourceIds: readonly string[],
  destinationFolderId: string | null
): void {
  const scopes = [...access.scopes];
  if (!resourceIds.every((resourceId) => hasScopeForResource(scopes, access.editScope, resourceId))) {
    throw new AppError(
      403,
      'FORBIDDEN',
      `Missing ${access.editScope} for one or more resources inside the moved folder`
    );
  }
  if (!hasScopeForCreation(scopes, access.editScope, destinationFolderId)) {
    throw new AppError(403, 'FORBIDDEN', `Missing ${access.editScope} for the move destination`);
  }
}

/** Folder names compare trimmed and case-insensitively, so `Prod` and ` prod ` cannot sit side by side. */
export function folderNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

type FolderRow = {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  depth: number;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
};

export interface ResourceFolderTreeNode extends FolderRow {
  children: ResourceFolderTreeNode[];
}

interface ResourceFolderConfig {
  folderTable: any;
  resourceTable: any;
  resourceName: string;
  resourcePlural: string;
  auditResourceType: string;
  eventName: string;
  folderScope?: SQL;
  resourceScope?: SQL;
  folderDefaults?: Record<string, unknown>;
}

/** 409 for a move of resources that sit in an app: they leave an app only through Move to App. */
export function resourceInAppError(): AppError {
  return new AppError(409, 'RESOURCE_IN_APP', 'This resource is in an app. Use Move to App to take it out of the app');
}

export class FolderedResourceService {
  private eventBus?: EventBusService;
  private readonly config: ResourceFolderConfig;
  /** Folders an app owns (hidden): not null only on folder tables that can hold app folders. */
  private readonly appIdColumn: any;
  /** Scope for create-path destination checks: user folders plus hidden app environment folders. */
  private readonly placementScope?: SQL;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    config: ResourceFolderConfig
  ) {
    this.appIdColumn = config.folderTable.appId ?? null;
    // Every folder management surface sees user folders only; hidden app folders are managed by the apps module.
    this.config = this.appIdColumn
      ? { ...config, folderScope: and(config.folderScope, isNull(this.appIdColumn)) }
      : config;
    this.placementScope = config.folderScope;
  }

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  private emitLayoutChanged(action: string, folderId?: string | null) {
    this.eventBus?.publish(this.config.eventName, { action, folderId });
  }

  /**
   * Folder create, move and delete run one at a time per folder tree, in one
   * transaction under an advisory lock. Two concurrent moves (A under B, B
   * under A) would otherwise both pass the descendant check and commit a
   * parent cycle, and depth bookkeeping would drift.
   */
  private withTreeLock<T>(fn: (tx: DrizzleTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`resource-folders:${this.config.auditResourceType}`}))`
      );
      return fn(tx);
    });
  }

  private async getFolderOrThrow(id: string, db: DrizzleExecutor = this.db): Promise<FolderRow> {
    const [folder] = await db
      .select()
      .from(this.config.folderTable)
      .where(and(this.config.folderScope, eq(this.config.folderTable.id, id)))
      .limit(1);
    if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
    return folder as FolderRow;
  }

  /**
   * Destination check of create paths (and imports): a user folder, or the hidden folder of an app environment (a
   * create from an app passes the environment's placement folder). An app root folder is never a destination.
   */
  async assertFolderExists(id: string | null | undefined): Promise<void> {
    if (id) await this.assertPlacementFolder(id);
  }

  async assertPlacementFolder(id: string): Promise<void> {
    if (!this.appIdColumn) {
      await this.getFolderOrThrow(id);
      return;
    }
    const table = this.config.folderTable;
    const [folder] = (await this.db
      .select({ appId: table.appId, appEnvironmentId: table.appEnvironmentId })
      .from(table)
      .where(and(this.placementScope, eq(table.id, id)))
      .limit(1)) as Array<{ appId: string | null; appEnvironmentId: string | null }>;
    if (!folder || (folder.appId && !folder.appEnvironmentId)) {
      throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
    }
  }

  /** IDs of the hidden app folders among `ids` (resources there are app members). */
  async hiddenFolderIds(ids: ReadonlyArray<string | null>): Promise<Set<string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (!this.appIdColumn || unique.length === 0) return new Set();
    const table = this.config.folderTable;
    const rows = (await this.db
      .select({ id: table.id })
      .from(table)
      .where(and(inArray(table.id, unique), isNotNull(this.appIdColumn)))) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  private async getNextSortOrder(parentId: string | null, db: DrizzleExecutor = this.db): Promise<number> {
    const siblings = await db
      .select({ sortOrder: this.config.folderTable.sortOrder })
      .from(this.config.folderTable)
      .where(
        and(
          this.config.folderScope,
          parentId ? eq(this.config.folderTable.parentId, parentId) : isNull(this.config.folderTable.parentId)
        )
      )
      .orderBy(desc(this.config.folderTable.sortOrder))
      .limit(1);
    return siblings.length > 0 ? siblings[0].sortOrder + 1 : 0;
  }

  async createFolder(input: CreateResourceFolderInput, userId: string) {
    const folder = await this.withTreeLock(async (tx) => {
      let depth = 0;
      if (input.parentId) {
        const parent = await this.getFolderOrThrow(input.parentId, tx);
        if (parent.depth >= MAX_DEPTH) {
          throw new AppError(400, 'MAX_DEPTH_EXCEEDED', `Maximum folder nesting depth is ${MAX_DEPTH + 1} levels`);
        }
        depth = parent.depth + 1;
      }

      const rows = (await tx
        .insert(this.config.folderTable)
        .values({
          ...this.config.folderDefaults,
          name: input.name,
          parentId: input.parentId ?? null,
          sortOrder: await this.getNextSortOrder(input.parentId ?? null, tx),
          depth,
          createdById: userId,
        })
        .returning()) as FolderRow[];
      const created = rows[0];
      if (!created) throw new AppError(500, 'FOLDER_CREATE_FAILED', 'Folder was not created');
      return created;
    });

    await this.auditService.log({
      userId,
      action: `${this.config.auditResourceType}.create`,
      resourceType: this.config.auditResourceType,
      resourceId: folder.id,
      details: { name: folder.name, parentId: folder.parentId },
    });
    this.emitLayoutChanged('folder_created', folder.id);
    return folder;
  }

  async updateFolder(id: string, input: UpdateResourceFolderInput, userId: string) {
    const existing = await this.getFolderOrThrow(id);
    const [folder] = await this.db
      .update(this.config.folderTable)
      .set({ name: input.name, updatedAt: new Date() })
      .where(and(this.config.folderScope, eq(this.config.folderTable.id, id)))
      .returning();

    await this.auditService.log({
      userId,
      action: `${this.config.auditResourceType}.update`,
      resourceType: this.config.auditResourceType,
      resourceId: id,
      details: { oldName: existing.name, newName: input.name },
    });
    this.emitLayoutChanged('folder_updated', id);
    return folder;
  }

  /**
   * `access` is required so no caller can forget the source and destination check; `null` only for a subclass that
   * authorizes the moved resources itself. `manage`, when given, is checked against the folder's current parent and
   * the destination inside the tree lock, so a folder-scoped manager cannot move a folder out of (or into) a place it
   * does not manage.
   */
  async moveFolder(
    id: string,
    input: MoveResourceFolderInput,
    userId: string,
    access: FolderMoveAccess | null,
    manage?: FolderManageAccess
  ) {
    const result = await this.withTreeLock(async (tx) => {
      const folder = await this.getFolderOrThrow(id, tx);
      if (folder.parentId === input.parentId) return { folder, moved: false as const };
      if (manage) {
        assertFolderManage(manage.scopes, manage.manageScope, folder.parentId);
        assertFolderManage(manage.scopes, manage.manageScope, input.parentId);
      }

      // Read inside the lock: a concurrent move has either committed or not started.
      const descendants = await this.getDescendantIds(id, tx);
      let newDepth = 0;
      if (input.parentId) {
        const parent = await this.getFolderOrThrow(input.parentId, tx);
        if (input.parentId === id || descendants.includes(input.parentId)) {
          throw new AppError(400, 'CIRCULAR_REFERENCE', 'Cannot move folder into its own descendant');
        }
        newDepth = parent.depth + 1;
      }

      await this.assertNameFree(folder.name, input.parentId, id, tx);

      const subtreeHeight = (await this.getMaxSubtreeDepth(id, tx)) - folder.depth;
      if (newDepth + subtreeHeight > MAX_DEPTH) {
        throw new AppError(
          400,
          'MAX_DEPTH_EXCEEDED',
          `Moving this folder would exceed the maximum nesting depth of ${MAX_DEPTH + 1} levels`
        );
      }

      if (access) {
        const movedResources = (await tx
          .select({ id: this.config.resourceTable.id })
          .from(this.config.resourceTable)
          .where(
            and(this.config.resourceScope, inArray(this.config.resourceTable.folderId, [id, ...descendants]))
          )) as Array<{ id: string }>;
        assertFolderMoveAccess(
          access,
          movedResources.map((resource) => resource.id),
          input.parentId
        );
      }

      const depthDelta = newDepth - folder.depth;
      const [updated] = await tx
        .update(this.config.folderTable)
        .set({
          parentId: input.parentId,
          depth: newDepth,
          sortOrder: await this.getNextSortOrder(input.parentId, tx),
          updatedAt: new Date(),
        })
        .where(and(this.config.folderScope, eq(this.config.folderTable.id, id)))
        .returning();

      if (depthDelta !== 0 && descendants.length > 0) {
        await tx
          .update(this.config.folderTable)
          .set({
            depth: sql`${this.config.folderTable.depth} + ${depthDelta}`,
            updatedAt: new Date(),
          })
          .where(and(this.config.folderScope, inArray(this.config.folderTable.id, descendants)));
      }
      return { folder, moved: true as const, updated };
    });
    if (!result.moved) return result.folder;

    await this.auditService.log({
      userId,
      action: `${this.config.auditResourceType}.move`,
      resourceType: this.config.auditResourceType,
      resourceId: id,
      details: { oldParentId: result.folder.parentId, newParentId: input.parentId },
    });
    this.emitLayoutChanged('folder_updated', id);
    return result.updated;
  }

  /** 409 when `parentId` (null: the top level) already holds another folder with the same name. */
  private async assertNameFree(
    name: string,
    parentId: string | null,
    exceptId: string,
    db: DrizzleExecutor = this.db
  ): Promise<void> {
    const siblings = (await db
      .select({ id: this.config.folderTable.id, name: this.config.folderTable.name })
      .from(this.config.folderTable)
      .where(
        and(
          this.config.folderScope,
          parentId ? eq(this.config.folderTable.parentId, parentId) : isNull(this.config.folderTable.parentId)
        )
      )) as Array<{ id: string; name: string }>;
    const key = folderNameKey(name);
    if (siblings.some((sibling) => sibling.id !== exceptId && folderNameKey(sibling.name ?? '') === key)) {
      throw new AppError(
        409,
        'FOLDER_NAME_CONFLICT',
        `A folder named "${name.trim()}" already exists in the destination`
      );
    }
  }

  /** Parent of each folder (null: top level); 404 when one does not exist in this tree. */
  async getFolderParentIds(ids: readonly string[]): Promise<Map<string, string | null>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = (await this.db
      .select({ id: this.config.folderTable.id, parentId: this.config.folderTable.parentId })
      .from(this.config.folderTable)
      .where(and(this.config.folderScope, inArray(this.config.folderTable.id, unique)))) as Array<{
      id: string;
      parentId: string | null;
    }>;
    if (rows.length !== unique.length) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
    return new Map(rows.map((row) => [row.id, row.parentId ?? null]));
  }

  /** Current folder of each resource (null: ungrouped). Unknown IDs are left out. */
  async getResourceFolderIds(ids: readonly string[]): Promise<Map<string, string | null>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = (await this.db
      .select({ id: this.config.resourceTable.id, folderId: this.config.resourceTable.folderId })
      .from(this.config.resourceTable)
      .where(and(this.config.resourceScope, inArray(this.config.resourceTable.id, unique)))) as Array<{
      id: string;
      folderId: string | null;
    }>;
    return new Map(rows.map((row) => [row.id, row.folderId ?? null]));
  }

  async deleteFolder(id: string, userId: string) {
    const { folder, descendantIds, affected, scopeChanges } = await this.withTreeLock(async (tx) => {
      const folder = await this.getFolderOrThrow(id, tx);
      const descendantIds = await this.getDescendantIds(id, tx);
      const folderIds = [id, ...descendantIds];
      const affected = await tx
        .select({ id: this.config.resourceTable.id })
        .from(this.config.resourceTable)
        .where(and(this.config.resourceScope, inArray(this.config.resourceTable.folderId, folderIds)));

      await tx.delete(this.config.folderTable).where(and(this.config.folderScope, eq(this.config.folderTable.id, id)));
      // Grants on the folder and its cascaded subfolders go with them.
      return { folder, descendantIds, affected, scopeChanges: await removeDanglingResourceScopes(tx) };
    });
    await announceResourceScopeChanges(scopeChanges);
    await this.auditService.log({
      userId,
      action: `${this.config.auditResourceType}.delete`,
      resourceType: this.config.auditResourceType,
      resourceId: id,
      details: { name: folder.name, subfoldersDeleted: descendantIds.length, resourcesUngrouped: affected.length },
    });
    this.emitLayoutChanged('folder_deleted', id);
  }

  async reorderFolders(input: ReorderResourceFoldersInput) {
    for (const item of input.items) {
      await this.db
        .update(this.config.folderTable)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(and(this.config.folderScope, eq(this.config.folderTable.id, item.id)));
    }
    this.emitLayoutChanged('folders_reordered');
  }

  async getFolderTree(options?: {
    allowedResourceIds?: string[];
    allowedFolderIds?: string[];
    includeAllFolders?: boolean;
  }) {
    const allFolders = await this.db
      .select()
      .from(this.config.folderTable)
      .where(this.config.folderScope)
      .orderBy(asc(this.config.folderTable.depth), asc(this.config.folderTable.sortOrder));

    if (options?.includeAllFolders || (!options?.allowedResourceIds && !options?.allowedFolderIds))
      return this.buildTree(allFolders as FolderRow[]);
    if (!options.allowedResourceIds?.length && !options.allowedFolderIds?.length) return [];

    const visibleResources = !options.allowedResourceIds?.length
      ? []
      : await this.db
          .select({ id: this.config.resourceTable.id, folderId: this.config.resourceTable.folderId })
          .from(this.config.resourceTable)
          .where(and(this.config.resourceScope, inArray(this.config.resourceTable.id, options.allowedResourceIds)));
    return this.pruneEmptyBranches(
      this.buildTree(allFolders as FolderRow[]),
      new Set([...visibleResources.map((item) => item.folderId as string | null), ...(options.allowedFolderIds ?? [])])
    );
  }

  async moveResourcesToFolder(input: MoveResourcesToFolderInput, userId: string) {
    if (input.folderId) await this.getFolderOrThrow(input.folderId);
    const current = await this.getResourceFolderIds(input.ids);
    if ((await this.hiddenFolderIds([...current.values()])).size > 0) throw resourceInAppError();
    await this.db
      .update(this.config.resourceTable)
      .set({ folderId: input.folderId, updatedAt: new Date() })
      .where(and(this.config.resourceScope, inArray(this.config.resourceTable.id, input.ids)));

    await this.auditService.log({
      userId,
      action: `${this.config.resourceName}.move_to_folder`,
      resourceType: this.config.resourceName,
      details: { ids: input.ids, folderId: input.folderId },
    });
    this.emitLayoutChanged(`${this.config.resourcePlural}_moved`, input.folderId);
  }

  async reorderResources(input: ReorderResourcesInput) {
    for (const item of input.items) {
      await this.db
        .update(this.config.resourceTable)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(and(this.config.resourceScope, eq(this.config.resourceTable.id, item.id)));
    }
    this.emitLayoutChanged(`${this.config.resourcePlural}_reordered`);
  }

  private buildTree(folders: FolderRow[]): ResourceFolderTreeNode[] {
    const nodeMap = new Map<string, ResourceFolderTreeNode>();
    for (const folder of folders) nodeMap.set(folder.id, { ...folder, children: [] });
    const roots: ResourceFolderTreeNode[] = [];
    for (const node of nodeMap.values()) {
      if (node.parentId && nodeMap.has(node.parentId)) nodeMap.get(node.parentId)!.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  private pruneEmptyBranches(
    nodes: ResourceFolderTreeNode[],
    folderIdsWithResources: Set<string | null>
  ): ResourceFolderTreeNode[] {
    return nodes
      .map((node) => ({ ...node, children: this.pruneEmptyBranches(node.children, folderIdsWithResources) }))
      .filter((node) => folderIdsWithResources.has(node.id) || node.children.length > 0);
  }

  /**
   * Every folder below `folderId`. The visited set keeps this finite even if
   * the stored tree already contains a parent cycle (written before moves were
   * serialized), instead of walking the cycle forever.
   */
  private async getDescendantIds(folderId: string, db: DrizzleExecutor = this.db): Promise<string[]> {
    const visited = new Set<string>([folderId]);
    const descendants: string[] = [];
    let currentLevel = [folderId];
    while (currentLevel.length > 0) {
      const children = await db
        .select({ id: this.config.folderTable.id })
        .from(this.config.folderTable)
        .where(and(this.config.folderScope, inArray(this.config.folderTable.parentId, currentLevel)));
      const nextLevel: string[] = [];
      for (const child of children as Array<{ id: string }>) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        descendants.push(child.id);
        nextLevel.push(child.id);
      }
      currentLevel = nextLevel;
    }
    return descendants;
  }

  private async getMaxSubtreeDepth(folderId: string, db: DrizzleExecutor = this.db): Promise<number> {
    const descendantIds = await this.getDescendantIds(folderId, db);
    const ids = [folderId, ...descendantIds];
    const [result] = await db
      .select({ maxDepth: sql<number>`max(${this.config.folderTable.depth})` })
      .from(this.config.folderTable)
      .where(and(this.config.folderScope, inArray(this.config.folderTable.id, ids)));
    return result?.maxDepth ?? 0;
  }
}
