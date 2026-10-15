import { canCreateInFolder, scopeMatches } from "@/lib/scope-utils";

/** Any folder tree node shape (resource folders, proxy route folders). */
export interface CreationFolderTreeNode {
  id: string;
  name: string;
  children?: readonly CreationFolderTreeNode[];
}

export interface CreationFolderOption {
  id: string;
  name: string;
  depth: number;
}

export interface CreationFolderChoices {
  /** The caller may create at the root ("No folder"). */
  allowRoot: boolean;
  /** Folders the caller may create in, in tree order. */
  folders: CreationFolderOption[];
  /** Initial picker value: root when allowed, else the only top-most allowed folder, else unset. */
  defaultFolderId: string;
}

export function flattenCreationFolders(
  nodes: readonly CreationFolderTreeNode[],
  depth = 0
): CreationFolderOption[] {
  return nodes.flatMap((node) => [
    { id: node.id, name: node.name, depth },
    ...flattenCreationFolders(node.children ?? [], depth + 1),
  ]);
}

/**
 * Destinations a creation picker may offer. Mirrors the backend `hasScopeForCreation`:
 * a broad grant, a grant on the destination node, or a grant on the destination folder.
 */
export function creationFolderChoices(
  scopes: readonly string[],
  baseScope: string,
  folders: readonly CreationFolderOption[],
  nodeId?: string
): CreationFolderChoices {
  const allowRoot = canCreateInFolder(scopes, baseScope, null, nodeId || undefined);
  const allowed = folders.filter((folder) =>
    canCreateInFolder(scopes, baseScope, folder.id, nodeId || undefined)
  );
  // Without the root, the picker starts at the caller's top-most folder (as their lists do).
  const topDepth = allowRoot ? 0 : Math.min(...allowed.map((folder) => folder.depth));
  // One top-most folder (the caller's root, with its subfolders below) is the default destination.
  const topFolderIds = allowed
    .filter((folder) => folder.depth === topDepth)
    .map((folder) => folder.id);
  return {
    allowRoot,
    folders:
      topDepth > 0 && Number.isFinite(topDepth)
        ? allowed.map((folder) => ({ ...folder, depth: folder.depth - topDepth }))
        : allowed,
    defaultFolderId: !allowRoot && topFolderIds.length === 1 ? topFolderIds[0]! : "",
  };
}

/** Keeps a picked folder only while it is still an allowed destination. */
export function allowedCreationFolderId(choices: CreationFolderChoices, folderId: string): string {
  if (folderId && choices.folders.some((folder) => folder.id === folderId)) return folderId;
  return choices.defaultFolderId;
}

/**
 * The caller holds a creation grant for some destination (broad, folder or node).
 * Unlike `hasScopeBase`, per-resource grants of a creation scope that doubles as a
 * resource action (for example `ssl:cert:issue:<certId>`) do not count. `nodeGrants`: node-bound
 * creation (Docker, routes, domains), where a bare `<base>:<nodeId>` grant names a node.
 */
export function hasCreationDestination(
  scopes: readonly string[],
  baseScope: string,
  { nodeGrants = false }: { nodeGrants?: boolean } = {}
): boolean {
  return (
    scopeMatches(scopes, baseScope) ||
    scopes.some(
      (scope) =>
        scope.startsWith(`${baseScope}:folder/`) ||
        scope.startsWith(`${baseScope}:node/`) ||
        (nodeGrants &&
          scope.startsWith(`${baseScope}:`) &&
          !scope.slice(baseScope.length + 1).includes("/"))
    )
  );
}

/**
 * Destinations for resources whose creation needs no folder right (the create scope is broad or names
 * another resource) while placing them in a folder needs the move rule of their folder family:
 * the root is always offered, a folder only when `canPlace` allows it.
 */
export function placementFolderChoices(
  folders: readonly CreationFolderOption[],
  canPlace: (folderId: string) => boolean
): CreationFolderChoices {
  return {
    allowRoot: true,
    folders: folders.filter((folder) => canPlace(folder.id)),
    defaultFolderId: "",
  };
}
