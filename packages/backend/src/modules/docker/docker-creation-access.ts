import { and, eq } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { dockerContainerFolderAssignments, dockerContainerFolders } from '@/db/schema/index.js';
import { withLimitedAccessGuidance } from '@/lib/access-denied.js';
import { hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertAppPlacement } from '@/modules/apps/app-placement-guard.js';
import type { DockerFolderResourceType } from './docker-folder.schemas.js';

export async function assertDockerCreationAccess(
  db: DrizzleClient,
  scopes: readonly string[],
  baseScope: string,
  nodeId: string,
  folderId: unknown,
  resourceType: DockerFolderResourceType = 'container'
): Promise<void> {
  if (folderId !== undefined && folderId !== null && typeof folderId !== 'string') {
    throw new AppError(400, 'INVALID_FOLDER', 'Invalid destination folder');
  }
  if (!hasScopeForCreation(scopes, baseScope, folderId, nodeId)) {
    throw new AppError(403, 'FORBIDDEN', await dockerCreationDeniedMessage(db, scopes, baseScope, folderId));
  }
  if (!folderId) return;
  const [folder] = await db
    .select({
      id: dockerContainerFolders.id,
      isSystem: dockerContainerFolders.isSystem,
      appId: dockerContainerFolders.appId,
      appEnvironmentId: dockerContainerFolders.appEnvironmentId,
    })
    .from(dockerContainerFolders)
    .where(and(eq(dockerContainerFolders.id, folderId), eq(dockerContainerFolders.resourceType, resourceType)))
    .limit(1);
  // A hidden app environment folder is a valid destination (create from an app); an app root folder never is.
  if (!folder || folder.isSystem || (folder.appId && !folder.appEnvironmentId)) {
    throw new AppError(403, 'FOLDER_FORBIDDEN', 'Destination folder is unavailable');
  }
  // Every Docker create, import, duplicate, Git source and migration target passes here: an app environment
  // destination takes only the nodes the environment allows.
  if (folder.appEnvironmentId && (resourceType === 'container' || resourceType === 'compose')) {
    await assertAppPlacement(db, resourceType === 'compose' ? 'compose' : 'containers', folderId, [nodeId]);
  }
}

/**
 * Assign the already-authorized destination before the created entity is published. Placements are keyed
 * by name, so a row left by an earlier resource of that name (removed outside Gateway) is stale: a resource
 * created at the root drops it instead of silently joining that folder and its grants.
 */
export async function placeCreatedDockerResource(
  db: DrizzleExecutor,
  nodeId: string,
  resourceType: DockerFolderResourceType,
  resourceKey: string,
  folderId: string | null | undefined
) {
  if (!folderId) {
    // Compose Projects are keyed by their new id, so nothing stale can exist for them.
    if (resourceType !== 'compose') await clearDockerResourcePlacement(db, nodeId, resourceType, resourceKey);
    return;
  }
  await db
    .insert(dockerContainerFolderAssignments)
    .values({ nodeId, resourceType, resourceKey, folderId })
    .onConflictDoUpdate({
      target: [
        dockerContainerFolderAssignments.nodeId,
        dockerContainerFolderAssignments.resourceType,
        dockerContainerFolderAssignments.resourceKey,
      ],
      set: { folderId },
    });
}

/** Drop the folder placement of a name-keyed Docker resource (the root has no row). */
export async function clearDockerResourcePlacement(
  db: DrizzleExecutor,
  nodeId: string,
  resourceType: DockerFolderResourceType,
  resourceKey: string
) {
  await db
    .delete(dockerContainerFolderAssignments)
    .where(
      and(
        eq(dockerContainerFolderAssignments.nodeId, nodeId),
        eq(dockerContainerFolderAssignments.resourceType, resourceType),
        eq(dockerContainerFolderAssignments.resourceKey, resourceKey)
      )
    );
}

/**
 * The refusal of a create outside the caller's destinations. A caller whose create grant is limited to folders
 * or nodes (a folder-restricted user, API token or MCP grant) is told where it may create and to pass folderId
 * (lib/access-denied.ts builds that guidance for every surface).
 */
export async function dockerCreationDeniedMessage(
  db: Pick<DrizzleClient, 'select'>,
  scopes: readonly string[],
  baseScope: string,
  folderId: string | null | undefined
): Promise<string> {
  const refused = folderId ? `Missing ${baseScope}:folder/${folderId}` : `Missing ${baseScope} at the root (no folder)`;
  return withLimitedAccessGuidance(refused, scopes, db);
}
