import { hasScope } from './permissions.js';
import { FOLDER_CREATION_SCOPES, FOLDER_ONLY_SCOPABLE, RESOURCE_SCOPABLE } from './scopes.js';

export type CreatedResourceFamily =
  | 'apps'
  | 'nodes'
  | 'proxy'
  | 'pages'
  | 'databases'
  | 'storage'
  | 'domains'
  | 'ssl:cert'
  | 'logs:environments'
  | 'logs:schemas'
  | 'docker:containers'
  | 'docker:compose'
  | 'docker:images'
  | 'docker:volumes'
  | 'docker:networks'
  | 'hosting:resources'
  | 'admin:users'
  | 'admin:groups'
  | 'integrations:hosting';

/** Where a new resource was created: its folder and, for node-bound resources, its node. */
export interface CreatedResourceDestination {
  folderId?: string | null;
  nodeId?: string | null;
}

// Ownership never grants global settings, creation elsewhere, or security-validation bypasses, nor
// scopes only a folder can qualify (folder management).
const excluded = new Set<string>([
  ...FOLDER_CREATION_SCOPES,
  ...FOLDER_ONLY_SCOPABLE,
  'proxy:unrestricted',
  'hosting:resources:create',
]);
export function createdResourceScopes(family: CreatedResourceFamily, resourceId: string): string[] {
  if (
    !resourceId ||
    resourceId.startsWith('folder/') ||
    (resourceId.startsWith('node/') && family !== 'hosting:resources') ||
    resourceId.startsWith('provider/')
  )
    throw new Error('A concrete created resource is required');
  const bases = RESOURCE_SCOPABLE.filter(
    (base) =>
      base.startsWith(`${family}:`) &&
      !base.startsWith('proxy:templates:') &&
      !base.endsWith(':bypass') &&
      !excluded.has(base)
  );
  if (family === 'admin:users' || family === 'admin:groups') return [`${family}:${resourceId}`];
  if (family === 'docker:containers') bases.push('docker:availability:manage');
  if (family === 'ssl:cert') bases.push('ssl:cert:issue');
  if (family === 'logs:environments')
    bases.push('logs:read', 'logs:tokens:view', 'logs:tokens:create', 'logs:tokens:delete');
  if (family === 'hosting:resources')
    bases.push(
      'hosting:snapshots:view',
      'hosting:snapshots:create',
      'hosting:snapshots:delete',
      'hosting:snapshots:restore',
      'hosting:snapshots:folders:manage'
    );
  return [...new Set(bases)].map((base) => `${base}:${resourceId}`);
}

const BARE_NODE_FAMILIES = new Set<CreatedResourceFamily>([
  'docker:containers',
  'docker:compose',
  'docker:images',
  'docker:volumes',
  'docker:networks',
  'proxy',
  'domains',
]);

function dockerNodeId(family: CreatedResourceFamily, resourceId: string): string | null {
  if (!family.startsWith('docker:')) return null;
  const separator = resourceId.indexOf('/');
  return separator > 0 ? resourceId.slice(0, separator) : null;
}

/** The per-resource scope that lets the creator see the resource they created. */
export function createdResourceViewScope(family: CreatedResourceFamily): string {
  if (family === 'nodes') return 'nodes:details';
  if (family === 'admin:users' || family === 'admin:groups') return family;
  return `${family}:view`;
}

/**
 * The per-resource grants a creator keeps for a resource they just created: always the view of
 * that resource (creation never reveals existing resources, but a creator keeps sight of what they
 * made), plus only the other scopes the creator already holds for it, broadly, on the destination
 * folder or node, or through a grant that already covers the new resource. Creating a resource never
 * adds capabilities the creator did not have (a folder `create` grant does not turn into console or
 * secret access).
 *
 * `creatorScopes` must be the creator's live scopes with folder and node grants expanded
 * (`expandFolderScopes`), read after the resource exists in its destination.
 */
export function createdResourceScopesForCreator(
  family: CreatedResourceFamily,
  resourceId: string,
  creatorScopes: readonly string[],
  destination: CreatedResourceDestination = {}
): string[] {
  const scopes = [...creatorScopes];
  const nodeId = destination.nodeId ?? dockerNodeId(family, resourceId);
  const folderId = destination.folderId && !destination.folderId.includes('/') ? destination.folderId : null;
  const holdsAtDestination = (base: string) =>
    hasScope(scopes, base) ||
    (!!folderId && hasScope(scopes, `${base}:folder/${folderId}`)) ||
    (!!nodeId && !nodeId.includes('/') && hasScope(scopes, `${base}:node/${nodeId}`)) ||
    // Docker node grants and legacy bare `proxy:create:<nodeId>` / `domains:create:<nodeId>` name the node directly.
    (!!nodeId && !nodeId.includes('/') && BARE_NODE_FAMILIES.has(family) && hasScope(scopes, `${base}:${nodeId}`));
  const view = createdResourceViewScope(family);
  return createdResourceScopes(family, resourceId).filter((grant) => {
    const base = grant.slice(0, grant.length - resourceId.length - 1);
    return base === view || hasScope(scopes, grant) || holdsAtDestination(base);
  });
}
