import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor, DrizzleTransaction } from '@/db/client.js';
import { dockerContainerFolderAssignments, dockerContainerFolders } from '@/db/schema/index.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { resourceInAppError } from '@/modules/resource-folders/resource-folder.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type {
  CreateDockerFolderInput,
  DockerFolderResourceRef,
  DockerFolderResourceType,
  MoveDockerContainersToFolderInput,
  MoveDockerFolderInput,
  MoveDockerResourcesToFolderInput,
  ReorderDockerContainersInput,
  ReorderDockerFoldersInput,
  ReorderDockerResourcesInput,
  UpdateDockerFolderInput,
} from './docker-folder.schemas.js';

const MAX_DEPTH = 2;
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

type FolderRow = typeof dockerContainerFolders.$inferSelect;
type AssignmentRow = typeof dockerContainerFolderAssignments.$inferSelect;

/** User folders: folder management never sees the hidden folders apps own. */
const USER_FOLDERS = isNull(dockerContainerFolders.appId);

type DockerContainerLike = {
  id?: string;
  Id?: string;
  name?: string;
  Name?: string;
  labels?: Record<string, string>;
  Labels?: Record<string, string>;
  [key: string]: unknown;
};

/**
 * Caller authorization for moving a whole folder. A folder move re-homes every resource inside the folder and its
 * subfolders, so the caller must be allowed to move each of them to the destination, exactly as for moving the
 * resources one by one. Receives the resources found inside the tree lock; throws to refuse.
 */
export type DockerFolderMoveAuthorizer = (context: {
  resourceType: DockerFolderResourceType;
  resources: DockerFolderResourceRef[];
  /** Where the folder sits now (null: the top level of its list). */
  sourceParentId: string | null;
  destinationFolderId: string | null;
}) => void | Promise<void>;

export interface DockerFolderTreeNode extends FolderRow {
  children: DockerFolderTreeNode[];
}

function getContainerName(container: DockerContainerLike): string {
  return String(container.name ?? container.Name ?? '').replace(/^\//, '');
}

function getContainerLabels(container: DockerContainerLike): Record<string, string> {
  return (container.labels ?? container.Labels ?? {}) as Record<string, string>;
}

function getComposeProject(container: DockerContainerLike): string | null {
  return getContainerLabels(container)['com.docker.compose.project'] ?? null;
}

function getComposeService(container: DockerContainerLike): string | null {
  return getContainerLabels(container)['com.docker.compose.service'] ?? null;
}

export class DockerFolderService {
  private eventBus?: EventBusService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  private async getAffectedNodeIdsForFolders(folderIds: Array<string | null | undefined>): Promise<string[]> {
    const ids = [...new Set(folderIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return [];

    const allFolders = await this.db.select().from(dockerContainerFolders);
    const affectedFolderIds = new Set(ids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of allFolders) {
        if (folder.parentId && affectedFolderIds.has(folder.parentId) && !affectedFolderIds.has(folder.id)) {
          affectedFolderIds.add(folder.id);
          changed = true;
        }
      }
    }

    const assignments = await this.db
      .select({ nodeId: dockerContainerFolderAssignments.nodeId })
      .from(dockerContainerFolderAssignments)
      .where(inArray(dockerContainerFolderAssignments.folderId, [...affectedFolderIds]));
    return [...new Set(assignments.map((row) => row.nodeId))];
  }

  private emitLayoutChanged(action: string, folderId?: string | null, nodeIds: string[] = []) {
    this.eventBus?.publish('docker.folder.changed', { action, folderId, nodeIds });
  }

  private async getNextSortOrder(
    resourceType: DockerFolderResourceType,
    parentId: string | null,
    db: DrizzleExecutor = this.db
  ): Promise<number> {
    const siblings = await db
      .select({ sortOrder: dockerContainerFolders.sortOrder })
      .from(dockerContainerFolders)
      .where(
        and(
          eq(dockerContainerFolders.resourceType, resourceType),
          parentId ? eq(dockerContainerFolders.parentId, parentId) : isNull(dockerContainerFolders.parentId)
        )
      )
      .orderBy(desc(dockerContainerFolders.sortOrder))
      .limit(1);

    return siblings.length > 0 ? siblings[0].sortOrder + 1 : 0;
  }

  /** A user folder; the hidden folders apps own are managed by the apps module only (404 here). */
  private async getFolderOrThrow(
    id: string,
    resourceType?: DockerFolderResourceType,
    db: DrizzleExecutor = this.db
  ): Promise<FolderRow> {
    const [folder] = await db
      .select()
      .from(dockerContainerFolders)
      .where(and(USER_FOLDERS, eq(dockerContainerFolders.id, id)))
      .limit(1);
    if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
    if (resourceType && folder.resourceType !== resourceType) {
      throw new AppError(400, 'FOLDER_RESOURCE_TYPE_MISMATCH', 'Folder belongs to a different Docker resource type');
    }
    return folder;
  }

  private assertFolderMutable(folder: FolderRow) {
    if (folder.isSystem) {
      throw new AppError(400, 'SYSTEM_FOLDER_LOCKED', 'Protected compose deployment folders cannot be modified');
    }
  }

  async createFolder(input: CreateDockerFolderInput, userId: string) {
    let depth = 0;
    const resourceType = input.resourceType;

    if (input.parentId) {
      const parent = await this.getFolderOrThrow(input.parentId, resourceType);
      this.assertFolderMutable(parent);
      if (parent.depth >= MAX_DEPTH) {
        throw new AppError(400, 'MAX_DEPTH_EXCEEDED', `Maximum folder nesting depth is ${MAX_DEPTH + 1} levels`);
      }
      depth = parent.depth + 1;
    }

    const [folder] = await this.db
      .insert(dockerContainerFolders)
      .values({
        name: input.name,
        resourceType,
        parentId: input.parentId ?? null,
        sortOrder: await this.getNextSortOrder(resourceType, input.parentId ?? null),
        depth,
        createdById: userId,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'docker_folder.create',
      resourceType: 'docker_folder',
      resourceId: folder.id,
      details: { name: folder.name, parentId: folder.parentId, resourceType },
    });

    this.emitLayoutChanged('folder_created', folder.id);
    return folder;
  }

  async updateFolder(id: string, input: UpdateDockerFolderInput, userId: string) {
    const folder = await this.getFolderOrThrow(id);
    this.assertFolderMutable(folder);

    const [updated] = await this.db
      .update(dockerContainerFolders)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(dockerContainerFolders.id, id))
      .returning();

    await this.auditService.log({
      userId,
      action: 'docker_folder.update',
      resourceType: 'docker_folder',
      resourceId: id,
      details: { oldName: folder.name, newName: input.name },
    });

    this.emitLayoutChanged('folder_updated', id, await this.getAffectedNodeIdsForFolders([id]));
    return updated;
  }

  /**
   * Folder moves run one at a time per resource-type tree, in one transaction under an advisory lock. Two concurrent
   * moves (A under B, B under A) would otherwise both pass the descendant check and commit a parent cycle.
   */
  private withTreeLock<T>(
    resourceType: DockerFolderResourceType,
    fn: (tx: DrizzleTransaction) => Promise<T>
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-folders:${resourceType}`}))`);
      return fn(tx);
    });
  }

  /**
   * Move a folder (with its subfolders and the resources inside) under another folder of the same resource type, or to
   * the root. `authorize` is required so no caller can skip the per-resource and destination checks.
   */
  async moveFolder(id: string, input: MoveDockerFolderInput, userId: string, authorize: DockerFolderMoveAuthorizer) {
    const resourceType = (await this.getFolderOrThrow(id)).resourceType as DockerFolderResourceType;
    const newParentId = input.parentId;

    const result = await this.withTreeLock(resourceType, async (tx) => {
      // Read inside the lock: a concurrent move has either committed or not started.
      const folder = await this.getFolderOrThrow(id, resourceType, tx);
      this.assertFolderMutable(folder);
      if ((folder.parentId ?? null) === newParentId) return { folder, moved: false as const };

      const treeFolders = await tx
        .select()
        .from(dockerContainerFolders)
        .where(and(USER_FOLDERS, eq(dockerContainerFolders.resourceType, resourceType)));
      const childrenByParent = new Map<string, FolderRow[]>();
      for (const row of treeFolders) {
        if (!row.parentId) continue;
        childrenByParent.set(row.parentId, [...(childrenByParent.get(row.parentId) ?? []), row]);
      }
      const descendants: FolderRow[] = [];
      const queue = [folder];
      while (queue.length > 0) {
        for (const child of childrenByParent.get(queue.shift()!.id) ?? []) {
          descendants.push(child);
          queue.push(child);
        }
      }
      if (descendants.some((descendant) => descendant.isSystem)) {
        throw new AppError(400, 'SYSTEM_FOLDER_LOCKED', 'Protected compose deployment folders cannot be modified');
      }

      // Access first: a manager limited to a folder is refused because the move leaves or enters a place outside their
      // grant, not for the depth or the name the destination would have (stand rc.10 O-5).
      const resources = await tx
        .select({
          nodeId: dockerContainerFolderAssignments.nodeId,
          resourceKey: dockerContainerFolderAssignments.resourceKey,
        })
        .from(dockerContainerFolderAssignments)
        .where(
          and(
            eq(dockerContainerFolderAssignments.resourceType, resourceType),
            inArray(dockerContainerFolderAssignments.folderId, [id, ...descendants.map((descendant) => descendant.id)])
          )
        );
      await authorize({
        resourceType,
        resources,
        sourceParentId: folder.parentId ?? null,
        destinationFolderId: newParentId,
      });

      let newDepth = 0;
      if (newParentId) {
        if (newParentId === id || descendants.some((descendant) => descendant.id === newParentId)) {
          throw new AppError(400, 'CIRCULAR_REFERENCE', 'Cannot move folder into its own descendant');
        }
        const parent = await this.getFolderOrThrow(newParentId, resourceType, tx);
        this.assertFolderMutable(parent);
        newDepth = parent.depth + 1;
      }

      const subtreeHeight = Math.max(folder.depth, ...descendants.map((descendant) => descendant.depth)) - folder.depth;
      if (newDepth + subtreeHeight > MAX_DEPTH) {
        throw new AppError(
          400,
          'MAX_DEPTH_EXCEEDED',
          `Moving this folder would exceed the maximum nesting depth of ${MAX_DEPTH + 1} levels`
        );
      }

      const normalizedName = folder.name.trim().toLowerCase();
      const conflict = treeFolders.some(
        (sibling) =>
          sibling.id !== id &&
          (sibling.parentId ?? null) === newParentId &&
          sibling.name.trim().toLowerCase() === normalizedName
      );
      if (conflict) {
        throw new AppError(409, 'FOLDER_NAME_CONFLICT', 'A folder with this name already exists in the destination');
      }

      const [updated] = await tx
        .update(dockerContainerFolders)
        .set({
          parentId: newParentId,
          depth: newDepth,
          sortOrder: await this.getNextSortOrder(resourceType, newParentId, tx),
          updatedAt: new Date(),
        })
        .where(eq(dockerContainerFolders.id, id))
        .returning();

      const depthDelta = newDepth - folder.depth;
      if (depthDelta !== 0 && descendants.length > 0) {
        await tx
          .update(dockerContainerFolders)
          .set({ depth: sql`${dockerContainerFolders.depth} + ${depthDelta}`, updatedAt: new Date() })
          .where(
            inArray(
              dockerContainerFolders.id,
              descendants.map((descendant) => descendant.id)
            )
          );
      }
      return { folder, moved: true as const, updated, nodeIds: [...new Set(resources.map((row) => row.nodeId))] };
    });
    if (!result.moved) return result.folder;

    await this.auditService.log({
      userId,
      action: 'docker_folder.move',
      resourceType: 'docker_folder',
      resourceId: id,
      details: { oldParentId: result.folder.parentId, newParentId, name: result.folder.name },
    });
    this.emitLayoutChanged('folder_updated', id, result.nodeIds);
    return result.updated;
  }

  /** Parent of each folder (null: the top level of its list); 404 when one does not exist. */
  async getFolderParentIds(ids: readonly string[]): Promise<Map<string, string | null>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ id: dockerContainerFolders.id, parentId: dockerContainerFolders.parentId })
      .from(dockerContainerFolders)
      .where(and(USER_FOLDERS, inArray(dockerContainerFolders.id, unique)));
    if (rows.length !== unique.length) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
    return new Map(rows.map((row) => [row.id, row.parentId ?? null]));
  }

  async deleteFolder(id: string, userId: string) {
    const folder = await this.getFolderOrThrow(id);
    this.assertFolderMutable(folder);

    const nodeIds = await this.getAffectedNodeIdsForFolders([id]);
    await transactionWithScopeCleanup(this.db, (tx) =>
      tx.delete(dockerContainerFolders).where(eq(dockerContainerFolders.id, id))
    );

    await this.auditService.log({
      userId,
      action: 'docker_folder.delete',
      resourceType: 'docker_folder',
      resourceId: id,
      details: { name: folder.name },
    });

    this.emitLayoutChanged('folder_deleted', id, nodeIds);
  }

  async reorderFolders(input: ReorderDockerFoldersInput, _userId: string) {
    const resourceType = input.resourceType;
    const folders = await this.db
      .select()
      .from(dockerContainerFolders)
      .where(
        and(
          USER_FOLDERS,
          inArray(
            dockerContainerFolders.id,
            input.items.map((item) => item.id)
          )
        )
      );

    if (folders.length !== input.items.length) {
      throw new AppError(404, 'FOLDER_NOT_FOUND', 'One or more folders were not found');
    }
    if (folders.some((folder) => folder.resourceType !== resourceType)) {
      throw new AppError(400, 'FOLDER_RESOURCE_TYPE_MISMATCH', 'Folders belong to a different Docker resource type');
    }

    const parentIds = [...new Set(folders.map((folder) => folder.parentId ?? null))];
    if (parentIds.length > 1) {
      throw new AppError(400, 'INVALID_REORDER', 'Folders can only be reordered within the same parent');
    }

    for (const item of input.items) {
      await this.db
        .update(dockerContainerFolders)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(eq(dockerContainerFolders.id, item.id));
    }

    this.emitLayoutChanged(
      'folders_reordered',
      null,
      await this.getAffectedNodeIdsForFolders(input.items.map((item) => item.id))
    );
  }

  async getFolderTree(options?: {
    resourceType?: DockerFolderResourceType;
    includeAllFolders?: boolean;
    allowedNodeIds?: string[];
    allowedResourceRefs?: DockerFolderResourceRef[];
    allowedFolderIds?: string[];
  }): Promise<DockerFolderTreeNode[]> {
    const resourceType = options?.resourceType ?? 'container';
    const allFolders = await this.db
      .select()
      .from(dockerContainerFolders)
      .where(and(USER_FOLDERS, eq(dockerContainerFolders.resourceType, resourceType)))
      .orderBy(asc(dockerContainerFolders.depth), asc(dockerContainerFolders.sortOrder));

    if (
      !options?.includeAllFolders &&
      (options?.allowedNodeIds || options?.allowedResourceRefs || options?.allowedFolderIds)
    ) {
      const allowedNodeIds = options.allowedNodeIds ?? [];
      const allowedResourceRefs = options.allowedResourceRefs ?? [];
      if (allowedNodeIds.length === 0 && allowedResourceRefs.length === 0 && !options.allowedFolderIds?.length)
        return [];
      const visibilityFilters = [
        allowedNodeIds.length > 0 ? inArray(dockerContainerFolderAssignments.nodeId, allowedNodeIds) : undefined,
        ...allowedResourceRefs.map((resource) =>
          and(
            eq(dockerContainerFolderAssignments.nodeId, resource.nodeId),
            eq(dockerContainerFolderAssignments.resourceKey, resource.resourceKey)
          )
        ),
      ].filter((condition): condition is NonNullable<typeof condition> => !!condition);
      const assignments = !visibilityFilters.length
        ? []
        : await this.db
            .select({ folderId: dockerContainerFolderAssignments.folderId })
            .from(dockerContainerFolderAssignments)
            .where(and(eq(dockerContainerFolderAssignments.resourceType, resourceType), or(...visibilityFilters)));
      // A folder grant covers its subfolders, empty ones included (folders come parents first).
      const grantedSubtree = new Set(options.allowedFolderIds ?? []);
      for (const folder of allFolders) {
        if (folder.parentId && grantedSubtree.has(folder.parentId)) grantedSubtree.add(folder.id);
      }
      const visibleIds = new Set([
        ...assignments.map((row) => row.folderId).filter((id): id is string => !!id),
        ...grantedSubtree,
      ]);
      for (const folder of [...allFolders].sort((a, b) => b.depth - a.depth)) {
        if (visibleIds.has(folder.id) && folder.parentId) visibleIds.add(folder.parentId);
      }
      return this.buildTree(allFolders.filter((folder) => visibleIds.has(folder.id)));
    }

    return this.buildTree(allFolders);
  }

  async assertResourceDestination(
    resourceType: DockerFolderResourceType,
    folderId: string | null | undefined
  ): Promise<void> {
    if (!folderId) return;
    const folder = await this.getFolderOrThrow(folderId, resourceType);
    if (folder.isSystem) {
      throw new AppError(
        400,
        'SYSTEM_FOLDER_LOCKED',
        'Resources cannot be placed into protected compose deployment folders'
      );
    }
  }

  async moveContainersToFolder(input: MoveDockerContainersToFolderInput, userId: string) {
    return this.moveResourcesToFolder(
      {
        resourceType: 'container',
        folderId: input.folderId,
        items: input.items.map((item) => ({ nodeId: item.nodeId, resourceKey: item.containerName })),
      },
      userId
    );
  }

  async moveResourcesToFolder(input: MoveDockerResourcesToFolderInput, userId: string) {
    const resourceType = input.resourceType;
    let targetFolder: FolderRow | null = null;
    if (input.folderId) {
      targetFolder = await this.getFolderOrThrow(input.folderId, resourceType);
      if (targetFolder.isSystem) {
        throw new AppError(
          400,
          'SYSTEM_FOLDER_LOCKED',
          'Resources cannot be moved into protected compose deployment folders'
        );
      }
    }

    const assignmentRows = await this.getAssignmentsForResourceRefs(resourceType, input.items);
    const sourceFolderIds = [...new Set(assignmentRows.map((row) => row.folderId).filter((id): id is string => !!id))];
    if (sourceFolderIds.length > 0) {
      const sourceFolders = await this.db
        .select({
          id: dockerContainerFolders.id,
          isSystem: dockerContainerFolders.isSystem,
          appId: dockerContainerFolders.appId,
        })
        .from(dockerContainerFolders)
        .where(
          and(
            eq(dockerContainerFolders.resourceType, resourceType),
            inArray(dockerContainerFolders.id, sourceFolderIds)
          )
        );
      if (sourceFolders.some((folder) => folder.appId)) throw resourceInAppError();
      if (sourceFolders.some((folder) => folder.isSystem)) {
        throw new AppError(
          400,
          'SYSTEM_FOLDER_LOCKED',
          'Resources cannot be moved out of protected compose deployment folders'
        );
      }
    }

    if (!targetFolder) {
      const byNode = new Map<string, string[]>();
      for (const item of input.items) {
        const current = byNode.get(item.nodeId) ?? [];
        current.push(item.resourceKey);
        byNode.set(item.nodeId, current);
      }

      for (const [nodeId, names] of byNode.entries()) {
        const maxSort = await this.db
          .select({ sortOrder: dockerContainerFolderAssignments.sortOrder })
          .from(dockerContainerFolderAssignments)
          .where(
            and(
              eq(dockerContainerFolderAssignments.nodeId, nodeId),
              eq(dockerContainerFolderAssignments.resourceType, resourceType),
              isNull(dockerContainerFolderAssignments.folderId)
            )
          )
          .orderBy(desc(dockerContainerFolderAssignments.sortOrder))
          .limit(1);
        let nextSortOrder = maxSort.length > 0 ? maxSort[0].sortOrder + 1 : 0;

        for (const resourceKey of names) {
          await this.db
            .insert(dockerContainerFolderAssignments)
            .values({
              nodeId,
              resourceType,
              resourceKey,
              containerName: resourceType === 'container' ? resourceKey : null,
              folderId: null,
              sortOrder: nextSortOrder++,
            })
            .onConflictDoUpdate({
              target: [
                dockerContainerFolderAssignments.nodeId,
                dockerContainerFolderAssignments.resourceType,
                dockerContainerFolderAssignments.resourceKey,
              ],
              set: {
                folderId: null,
                sortOrder: nextSortOrder - 1,
                updatedAt: new Date(),
              },
            });
        }
      }
    } else {
      const maxSort = await this.db
        .select({ sortOrder: dockerContainerFolderAssignments.sortOrder })
        .from(dockerContainerFolderAssignments)
        .where(
          and(
            eq(dockerContainerFolderAssignments.resourceType, resourceType),
            eq(dockerContainerFolderAssignments.folderId, targetFolder.id)
          )
        )
        .orderBy(desc(dockerContainerFolderAssignments.sortOrder))
        .limit(1);
      let nextSortOrder = maxSort.length > 0 ? maxSort[0].sortOrder + 1 : 0;

      for (const item of input.items) {
        await this.db
          .insert(dockerContainerFolderAssignments)
          .values({
            nodeId: item.nodeId,
            resourceType,
            resourceKey: item.resourceKey,
            containerName: resourceType === 'container' ? item.resourceKey : null,
            folderId: targetFolder.id,
            sortOrder: nextSortOrder++,
          })
          .onConflictDoUpdate({
            target: [
              dockerContainerFolderAssignments.nodeId,
              dockerContainerFolderAssignments.resourceType,
              dockerContainerFolderAssignments.resourceKey,
            ],
            set: {
              folderId: targetFolder.id,
              sortOrder: nextSortOrder - 1,
              updatedAt: new Date(),
            },
          });
      }
    }

    await this.auditService.log({
      userId,
      action: resourceType === 'container' ? 'docker_container.move_to_folder' : 'docker_resource.move_to_folder',
      resourceType: 'docker-resource',
      details: { items: input.items, folderId: input.folderId, folderResourceType: resourceType },
    });

    this.emitLayoutChanged('resources_moved', input.folderId, [...new Set(input.items.map((item) => item.nodeId))]);
  }

  async reorderContainers(input: ReorderDockerContainersInput, userId: string) {
    return this.reorderResources(
      {
        resourceType: 'container',
        items: input.items.map((item) => ({
          nodeId: item.nodeId,
          resourceKey: item.containerName,
          sortOrder: item.sortOrder,
        })),
      },
      userId
    );
  }

  async reorderResources(input: ReorderDockerResourcesInput, _userId: string) {
    const resourceType = input.resourceType;
    const assignmentRows = await this.getAssignmentsForResourceRefs(resourceType, input.items);
    if (assignmentRows.length !== input.items.length) {
      throw new AppError(400, 'INVALID_REORDER', 'All resources must have persisted placement before reordering');
    }

    const folderIds = [...new Set(assignmentRows.map((row) => row.folderId ?? null))];
    if (folderIds.length > 1) {
      throw new AppError(400, 'INVALID_REORDER', 'Containers can only be reordered within the same parent section');
    }

    const nonNullFolderIds = folderIds.filter((id): id is string => !!id);
    if (nonNullFolderIds.length > 0) {
      const folders = await this.db
        .select({
          id: dockerContainerFolders.id,
          isSystem: dockerContainerFolders.isSystem,
          appId: dockerContainerFolders.appId,
        })
        .from(dockerContainerFolders)
        .where(
          and(
            eq(dockerContainerFolders.resourceType, resourceType),
            inArray(dockerContainerFolders.id, nonNullFolderIds)
          )
        );

      if (folders.some((folder) => folder.appId)) throw resourceInAppError();
      if (folders.some((folder) => folder.isSystem)) {
        throw new AppError(
          400,
          'SYSTEM_FOLDER_LOCKED',
          'Protected compose deployment folders cannot be reordered manually'
        );
      }
    }

    for (const item of input.items) {
      await this.db
        .update(dockerContainerFolderAssignments)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(
          and(
            eq(dockerContainerFolderAssignments.nodeId, item.nodeId),
            eq(dockerContainerFolderAssignments.resourceType, resourceType),
            eq(dockerContainerFolderAssignments.resourceKey, item.resourceKey)
          )
        );
    }

    this.emitLayoutChanged('resources_reordered', null, [...new Set(input.items.map((item) => item.nodeId))]);
  }

  async getPlacementsForRefs(items: Array<{ nodeId: string; containerName: string }>) {
    const placements = await this.getResourcePlacementsForRefs(
      'container',
      items.map((item) => ({ nodeId: item.nodeId, resourceKey: item.containerName }))
    );
    return placements.map((placement) => ({
      nodeId: placement.nodeId,
      containerName: placement.resourceKey,
      folderId: placement.folderId,
      folderIsSystem: placement.folderIsSystem,
      sortOrder: placement.sortOrder,
    }));
  }

  async getResourcePlacementsForRefs(resourceType: DockerFolderResourceType, items: DockerFolderResourceRef[]) {
    const assignmentRows = await this.getAssignmentsForResourceRefs(resourceType, items);
    if (assignmentRows.length === 0) return [];

    const folderIds = assignmentRows.map((row) => row.folderId).filter((id): id is string => !!id);
    const folders =
      folderIds.length > 0
        ? await this.db
            .select({ id: dockerContainerFolders.id, isSystem: dockerContainerFolders.isSystem })
            .from(dockerContainerFolders)
            .where(
              and(
                eq(dockerContainerFolders.resourceType, resourceType),
                inArray(dockerContainerFolders.id, [...new Set(folderIds)])
              )
            )
        : [];
    const folderById = new Map(folders.map((folder) => [folder.id, folder]));

    return assignmentRows.map((row) => ({
      nodeId: row.nodeId,
      resourceKey: row.resourceKey,
      folderId: row.folderId,
      folderIsSystem: row.folderId ? (folderById.get(row.folderId)?.isSystem ?? false) : false,
      sortOrder: row.sortOrder,
    }));
  }

  async syncNodeContainers(nodeId: string, containers: DockerContainerLike[]) {
    const normalized = containers
      .map((container) => ({
        name: getContainerName(container),
        project: getComposeProject(container),
        service: getComposeService(container),
      }))
      .filter((container) => container.name !== '');

    const composeGroups = new Map<string, Array<{ name: string; service: string | null }>>();
    for (const container of normalized) {
      if (!container.project) continue;
      const group = composeGroups.get(container.project) ?? [];
      group.push({ name: container.name, service: container.service });
      composeGroups.set(container.project, group);
    }

    const existingSystemFolders = await this.db
      .select()
      .from(dockerContainerFolders)
      .where(
        and(
          eq(dockerContainerFolders.nodeId, nodeId),
          eq(dockerContainerFolders.resourceType, 'container'),
          eq(dockerContainerFolders.isSystem, true)
        )
      );

    const activeProjects = [...composeGroups.keys()];
    const systemFoldersByProject = new Map<string, FolderRow>();
    for (const folder of existingSystemFolders) {
      if (folder.composeProject && activeProjects.includes(folder.composeProject)) {
        systemFoldersByProject.set(folder.composeProject, folder);
      }
    }

    for (const project of activeProjects) {
      if (systemFoldersByProject.has(project)) continue;
      const [created] = await this.db
        .insert(dockerContainerFolders)
        .values({
          name: project,
          resourceType: 'container',
          parentId: null,
          sortOrder: await this.getNextSortOrder('container', null),
          depth: 0,
          isSystem: true,
          nodeId,
          composeProject: project,
          createdById: SYSTEM_USER_ID,
        })
        .returning();
      systemFoldersByProject.set(project, created);
    }

    for (const [project, group] of composeGroups.entries()) {
      const folder = systemFoldersByProject.get(project);
      if (!folder) continue;
      const sorted = [...group].sort((a, b) => (a.service ?? a.name).localeCompare(b.service ?? b.name));
      for (const [index, container] of sorted.entries()) {
        await this.db
          .insert(dockerContainerFolderAssignments)
          .values({
            nodeId,
            resourceType: 'container',
            resourceKey: container.name,
            containerName: container.name,
            folderId: folder.id,
            sortOrder: index,
          })
          .onConflictDoUpdate({
            target: [
              dockerContainerFolderAssignments.nodeId,
              dockerContainerFolderAssignments.resourceType,
              dockerContainerFolderAssignments.resourceKey,
            ],
            set: {
              folderId: folder.id,
              sortOrder: index,
              updatedAt: new Date(),
            },
          });
      }
    }

    const staleSystemFolders = existingSystemFolders.filter(
      (folder) => folder.composeProject && !activeProjects.includes(folder.composeProject)
    );
    if (staleSystemFolders.length > 0) {
      const assignmentRows = await this.db
        .select({
          folderId: dockerContainerFolderAssignments.folderId,
        })
        .from(dockerContainerFolderAssignments)
        .where(
          and(
            eq(dockerContainerFolderAssignments.nodeId, nodeId),
            eq(dockerContainerFolderAssignments.resourceType, 'container'),
            inArray(
              dockerContainerFolderAssignments.folderId,
              staleSystemFolders.map((folder) => folder.id)
            )
          )
        );
      const folderIdsWithAssignments = new Set(
        assignmentRows.map((row) => row.folderId).filter((id): id is string => !!id)
      );
      const removableFolderIds = staleSystemFolders
        .filter((folder) => !folderIdsWithAssignments.has(folder.id))
        .map((folder) => folder.id);
      if (removableFolderIds.length > 0) {
        await this.db.delete(dockerContainerFolders).where(inArray(dockerContainerFolders.id, removableFolderIds));
      }
    }

    const folderRows = await this.db
      .select()
      .from(dockerContainerFolders)
      .where(eq(dockerContainerFolders.resourceType, 'container'));
    const folderById = new Map(folderRows.map((folder) => [folder.id, folder]));

    const assignments = await this.db
      .select()
      .from(dockerContainerFolderAssignments)
      .where(
        and(
          eq(dockerContainerFolderAssignments.nodeId, nodeId),
          eq(dockerContainerFolderAssignments.resourceType, 'container')
        )
      );

    const assignmentByName = new Map(assignments.map((assignment) => [assignment.resourceKey, assignment]));

    return normalized.map((container) => {
      const assignment = assignmentByName.get(container.name);
      const folder = assignment?.folderId ? folderById.get(assignment.folderId) : undefined;
      return {
        containerName: container.name,
        folderId: assignment?.folderId ?? null,
        folderIsSystem: folder?.isSystem ?? false,
        sortOrder: assignment?.sortOrder ?? 0,
      };
    });
  }

  async renameContainerAssignment(nodeId: string, oldName: string, newName: string) {
    await this.renameResourceAssignment(nodeId, 'container', oldName, newName);
  }

  async renameResourceAssignment(
    nodeId: string,
    resourceType: DockerFolderResourceType,
    oldName: string,
    newName: string
  ) {
    if (oldName === newName) return;
    const assignment = await this.db.query.dockerContainerFolderAssignments.findFirst({
      where: and(
        eq(dockerContainerFolderAssignments.nodeId, nodeId),
        eq(dockerContainerFolderAssignments.resourceType, resourceType),
        eq(dockerContainerFolderAssignments.resourceKey, oldName)
      ),
    });
    if (!assignment) return;

    await this.db
      .delete(dockerContainerFolderAssignments)
      .where(
        and(
          eq(dockerContainerFolderAssignments.nodeId, nodeId),
          eq(dockerContainerFolderAssignments.resourceType, resourceType),
          eq(dockerContainerFolderAssignments.resourceKey, newName)
        )
      );

    await this.db
      .update(dockerContainerFolderAssignments)
      .set({
        resourceKey: newName,
        containerName: resourceType === 'container' ? newName : null,
        updatedAt: new Date(),
      })
      .where(eq(dockerContainerFolderAssignments.id, assignment.id));
  }

  async deleteContainerAssignment(nodeId: string, containerName: string) {
    await this.deleteResourceAssignment(nodeId, 'container', containerName);
  }

  async deleteResourceAssignment(nodeId: string, resourceType: DockerFolderResourceType, resourceKey: string) {
    await this.db
      .delete(dockerContainerFolderAssignments)
      .where(
        and(
          eq(dockerContainerFolderAssignments.nodeId, nodeId),
          eq(dockerContainerFolderAssignments.resourceType, resourceType),
          eq(dockerContainerFolderAssignments.resourceKey, resourceKey)
        )
      );
  }

  private async getAssignmentsForResourceRefs(
    resourceType: DockerFolderResourceType,
    items: Array<{ nodeId: string; resourceKey: string }>
  ): Promise<AssignmentRow[]> {
    const byNode = new Map<string, string[]>();
    for (const item of items) {
      const list = byNode.get(item.nodeId) ?? [];
      list.push(item.resourceKey);
      byNode.set(item.nodeId, list);
    }

    const rows: AssignmentRow[] = [];
    for (const [nodeId, names] of byNode.entries()) {
      const found = await this.db
        .select()
        .from(dockerContainerFolderAssignments)
        .where(
          and(
            eq(dockerContainerFolderAssignments.nodeId, nodeId),
            eq(dockerContainerFolderAssignments.resourceType, resourceType),
            inArray(dockerContainerFolderAssignments.resourceKey, [...new Set(names)])
          )
        );
      rows.push(...found);
    }
    return rows;
  }

  private buildTree(folders: FolderRow[]): DockerFolderTreeNode[] {
    const nodeMap = new Map<string, DockerFolderTreeNode>();
    for (const folder of folders) {
      nodeMap.set(folder.id, { ...folder, children: [] });
    }

    const roots: DockerFolderTreeNode[] = [];
    for (const folder of folders) {
      const node = nodeMap.get(folder.id)!;
      if (folder.parentId && nodeMap.has(folder.parentId)) {
        nodeMap.get(folder.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }
}
