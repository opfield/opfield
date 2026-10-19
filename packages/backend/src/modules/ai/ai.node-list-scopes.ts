import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { getResourceScopedIds, hasScope } from '@/lib/permissions.js';
import { dockerScopedNodeIds } from '@/modules/docker/docker-access-resource.service.js';
import { DOCKER_LIST_FOLDER_BASES, NODE_LIST_FOLDER_BASES } from '@/modules/nodes/node-list-access.js';

/** Broad Docker view scopes that list every Docker node, like GET /nodes?type=docker. */
const BROAD_DOCKER_VIEW_SCOPES = [
  'docker:containers:view',
  'docker:images:view',
  'docker:volumes:view',
  'docker:networks:view',
  'docker:compose:view',
] as const;

/** Docker creation scopes: broad or folder grants may create on every Docker node. */
const DOCKER_CREATION_SCOPES = [
  'docker:containers:create',
  'docker:compose:create',
  'docker:volumes:create',
  'docker:networks:create',
  'docker:images:pull',
] as const;

/** Node- and resource-scoped Docker grants reveal the Docker nodes they target. */
const DOCKER_NODE_DISCOVERY_SCOPES = [
  'docker:compose:view',
  'docker:compose:create',
  'docker:compose:manage',
  'docker:compose:delete',
  'docker:containers:view',
  'docker:containers:create',
  'docker:containers:manage',
  'docker:containers:console',
  'docker:containers:migrate',
  'docker:containers:delete',
  'docker:containers:edit',
  'docker:containers:environment',
  'docker:containers:link',
  'docker:containers:secrets',
  'docker:containers:files:read',
  'docker:containers:files:write',
  'docker:containers:export',
  'docker:containers:webhooks',
  'docker:containers:mounts',
  'docker:images:view',
  'docker:images:pull',
  'docker:images:delete',
  'docker:volumes:view',
  'docker:volumes:create',
  'docker:volumes:delete',
  'docker:volumes:files:read',
  'docker:volumes:files:write',
  'docker:networks:view',
  'docker:networks:create',
  'docker:networks:delete',
  'docker:networks:edit',
] as const;

type NodeListType = 'nginx' | 'monitoring' | 'docker' | 'builder' | 'databases' | 'storage' | 'relay';

/** Creation scopes that let a creator discover the nodes of one type as a destination. */
function creationBasesForNodeType(type: NodeListType | undefined): readonly string[] {
  if (type === 'nginx') return ['proxy:create', 'pages:create'];
  if (type === 'databases' || type === 'storage') return ['databases:create', 'storage:create'];
  return [];
}

/**
 * Any of these scopes makes list_nodes callable; the handler then applies {@link resolveNodeListAccess},
 * which decides per node type what the caller may see.
 */
export const NODE_LIST_TOOL_SCOPES: readonly string[] = [
  'nodes:details',
  'nodes:folders:manage',
  'proxy:create',
  'pages:create',
  'databases:create',
  'storage:create',
  'nodes:backups:execute',
  ...DOCKER_NODE_DISCOVERY_SCOPES,
];

export type NodeListAccess =
  | { allowed: false; requiredScopes: string[] }
  | {
      allowed: true;
      /** Undefined lists every node of the requested type. */
      allowedIds: string[] | undefined;
      /** Callers without nodes:details only receive the destination summary of each node. */
      compact: boolean;
    };

function hasFolderTargetGrant(scopes: readonly string[], base: string): boolean {
  return scopes.some((scope) => scope.startsWith(`${base}:folder/`));
}

/**
 * Mirrors GET /api/nodes (nodes.routes.ts): nodes:details or folder management lists nodes, a Docker grant lists
 * the Docker nodes it targets, and route, Pages, database and storage creators discover the nodes they may create
 * on. A granted node folder that is still empty lists nothing instead of failing.
 */
export function resolveNodeListAccess(scopes: string[], type: NodeListType | undefined): NodeListAccess {
  const hasNodeDetails = hasScope(scopes, 'nodes:details');
  const canManageFolders = hasScope(scopes, 'nodes:folders:manage');
  const allowedNodeIds = getResourceScopedIds(scopes, 'nodes:details');
  const hasNodeFolderGrant = getFolderScopedIds(scopes, NODE_LIST_FOLDER_BASES).length > 0;
  const hasDockerFolderGrant = type === 'docker' && getFolderScopedIds(scopes, DOCKER_LIST_FOLDER_BASES).length > 0;

  const allowedDockerNodeIds = type === 'docker' ? dockerScopedNodeIds(scopes, DOCKER_NODE_DISCOVERY_SCOPES) : [];
  const canListAllDockerNodes =
    type === 'docker' &&
    (BROAD_DOCKER_VIEW_SCOPES.some((scope) => hasScope(scopes, scope)) ||
      DOCKER_CREATION_SCOPES.some((base) => hasScope(scopes, base) || hasFolderTargetGrant(scopes, base)));
  const canListDockerNodes = canListAllDockerNodes || allowedDockerNodeIds.length > 0;

  const creationBases = creationBasesForNodeType(type);
  const isStatefulNodeQuery = type === 'databases' || type === 'storage';
  const allowedBackupExecutorNodeIds = isStatefulNodeQuery ? getResourceScopedIds(scopes, 'nodes:backups:execute') : [];
  const canListAllBackupExecutorNodes = isStatefulNodeQuery && hasScope(scopes, 'nodes:backups:execute');
  const canListBackupExecutorNodes = canListAllBackupExecutorNodes || allowedBackupExecutorNodeIds.length > 0;
  const allowedCreationNodeIds = [
    ...new Set(
      creationBases.flatMap((base) =>
        scopes.flatMap((scope) => {
          const prefix = `${base}:`;
          if (!scope.startsWith(prefix)) return [];
          const target = scope.slice(prefix.length);
          if (target.startsWith('node/')) return [target.slice('node/'.length)];
          // Legacy proxy:create UUIDs name nodes; database UUIDs do not.
          return base === 'proxy:create' && !target.includes('/') ? [target] : [];
        })
      )
    ),
  ];
  const canListAllCreationNodes = creationBases.some(
    (base) => hasScope(scopes, base) || hasFolderTargetGrant(scopes, base)
  );
  const canListCreationNodes = canListAllCreationNodes || allowedCreationNodeIds.length > 0;

  if (
    !hasNodeDetails &&
    !canManageFolders &&
    allowedNodeIds.length === 0 &&
    !hasNodeFolderGrant &&
    !hasDockerFolderGrant &&
    !canListDockerNodes &&
    !canListCreationNodes &&
    !canListBackupExecutorNodes
  ) {
    return {
      allowed: false,
      requiredScopes: [
        'nodes:details',
        'nodes:folders:manage',
        ...creationBases,
        ...(isStatefulNodeQuery ? ['nodes:backups:execute'] : []),
        ...(type === 'docker' ? DOCKER_NODE_DISCOVERY_SCOPES : []),
      ],
    };
  }

  const listsEveryNode =
    hasNodeDetails ||
    canManageFolders ||
    canListAllDockerNodes ||
    canListAllCreationNodes ||
    canListAllBackupExecutorNodes;
  const scopedNodeIds =
    type === 'docker'
      ? [...new Set([...allowedNodeIds, ...allowedDockerNodeIds])]
      : creationBases.length > 0
        ? [...new Set([...allowedNodeIds, ...allowedCreationNodeIds, ...allowedBackupExecutorNodeIds])]
        : allowedNodeIds;
  const compact =
    !hasNodeDetails &&
    ((type === 'docker' && (canListDockerNodes || hasDockerFolderGrant)) ||
      (creationBases.length > 0 && (canListCreationNodes || canListBackupExecutorNodes) && !canManageFolders));
  return { allowed: true, allowedIds: listsEveryNode ? undefined : scopedNodeIds, compact };
}
