/**
 * What each node type is for, in the words an agent needs to pick the right tools. A node's `type` decides which
 * tool family accepts it: Docker tools take only `docker` nodes, routes and Pages only `nginx` nodes, managed
 * databases and storage only `storage` (or legacy `databases`) nodes. Database, storage and builder daemons run on
 * Docker internally and report `capabilities.daemonType: "docker"`, which does not make them Docker nodes.
 */

export type NodeRoleType =
  | 'nginx'
  | 'bastion'
  | 'monitoring'
  | 'docker'
  | 'builder'
  | 'databases'
  | 'storage'
  | 'relay';

const NODE_ROLES: Readonly<Record<NodeRoleType, string>> = {
  docker:
    'Docker workloads: containers, deployments, Compose projects, images, volumes and networks (list_docker_*, manage_docker_*).',
  nginx:
    'Ingress: routes, Pages and TLS delivery (list_routes, create_route, manage_pages). Docker tools do not accept it.',
  storage:
    'Managed databases and S3 storage (list_databases, manage_managed_database, list_storage_connections, manage_managed_storage). Docker tools do not accept it.',
  databases:
    'Managed databases and S3 storage, legacy profile (list_databases, manage_managed_database, list_storage_connections, manage_managed_storage). Docker tools do not accept it.',
  builder:
    'Git builds into the internal registry (list_docker_builds, manage_docker_build). Docker tools do not accept it.',
  relay: 'Relay Pool member for Secure Links (manage_relay_pool). Docker tools do not accept it.',
  monitoring: 'Host metrics, console and files only (get_node, manage_node_file). Docker tools do not accept it.',
  bastion: 'Host console and files only (get_node, manage_node_file). Docker tools do not accept it.',
};

/** The one-line role of a node type, or null for an unknown type. */
export function nodeRole(type: string | null | undefined): string | null {
  return type && type in NODE_ROLES ? NODE_ROLES[type as NodeRoleType] : null;
}

/** Shown once per list_nodes result so the misleading daemonType of storage-profile nodes is not read as a role. */
export const NODE_LIST_ROLE_NOTE =
  'type decides which tools accept a node (usedFor says which): Docker tools take only type docker nodes. capabilities.daemonType is the daemon build, not the role: storage, databases and builder nodes report "docker" there and are still not Docker nodes.';

/** The node types a family of tools accepts, with the family's label for messages. */
export interface NodeFamily {
  label: string;
  types: readonly NodeRoleType[];
  /** The list_nodes call that returns the accepted nodes. */
  listHint: string;
}

export const DOCKER_NODE_FAMILY: NodeFamily = {
  label: 'Docker',
  types: ['docker'],
  listHint: 'list_nodes({ type: "docker" })',
};

export const NGINX_NODE_FAMILY: NodeFamily = {
  label: 'nginx',
  types: ['nginx'],
  listHint: 'list_nodes({ type: "nginx" })',
};

export const STORAGE_NODE_FAMILY: NodeFamily = {
  label: 'storage',
  types: ['storage', 'databases'],
  listHint: 'list_nodes({ type: "storage" }) or list_nodes({ type: "databases" })',
};

/**
 * The node family a node-type refusal names: NOT_DOCKER and NOT_NGINX from the services, NODE_TYPE_MISMATCH from
 * node dispatch (Docker, managed database or managed storage operations).
 */
export function nodeFamilyForRefusal(code: string | undefined, message: string): NodeFamily | null {
  if (code === 'NOT_DOCKER') return DOCKER_NODE_FAMILY;
  if (code === 'NOT_NGINX') return NGINX_NODE_FAMILY;
  if (code === 'NODE_TYPE_MISMATCH') {
    if (/docker/i.test(message)) return DOCKER_NODE_FAMILY;
    if (/database|storage/i.test(message)) return STORAGE_NODE_FAMILY;
  }
  return null;
}
