import { hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';

/**
 * What a route creator learns about an ingress node: enough to pick it as a
 * destination, nothing that needs `nodes:details`.
 */
export interface RouteIngressNode {
  id: string;
  displayName: string | null;
  hostname: string;
  /** Availability: `offline` also covers an `online` row whose daemon is not connected right now. */
  status: 'pending' | 'online' | 'offline' | 'error';
}

export interface RouteIngressNodeCandidate extends RouteIngressNode {
  serviceCreationLocked: boolean;
}

/** How the ingress node of a new route was chosen. */
export type RouteIngressNodeSource = 'request' | 'domain' | 'single_eligible';

const LISTED_NODES_IN_MESSAGE = 10;

/** Whether a proxy:create grant covers a new route on this ingress node in this folder (null = root). */
export function canCreateRouteOnIngressNode(
  scopes: readonly string[],
  nodeId: string,
  folderId: string | null | undefined
): boolean {
  return hasScopeForCreation(scopes, 'proxy:create', folderId ?? null, nodeId);
}

/** A `proxy:create:folder/<id>` grant, kept by the auth layer next to its expanded forms. */
function hasFolderRouteCreationGrant(scopes: readonly string[]): boolean {
  const prefix = 'proxy:create:folder/';
  return scopes.some((scope) => scope.startsWith(prefix) && !scope.slice(prefix.length).includes('/'));
}

/**
 * Ingress nodes the caller may create routes on. Nodes locked for new services and pending nodes (their daemon
 * never connected, so a route there could not be applied) are never eligible.
 * - `folderId` given (null = root): the nodes a route in that folder may use: every node for a broad
 *   grant or a grant on that folder, otherwise the nodes of node-qualified grants.
 * - `folderId` omitted: any destination the caller holds: broad and folder grants may place on every
 *   node (folders do not pin nodes), node grants only on their nodes.
 */
export function routeIngressNodesForScopes<T extends RouteIngressNodeCandidate>(
  nodes: readonly T[],
  scopes: readonly string[],
  folderId?: string | null
): T[] {
  const open = nodes.filter((node) => !node.serviceCreationLocked && node.status !== 'pending');
  if (folderId === undefined && (hasScope(scopes, 'proxy:create') || hasFolderRouteCreationGrant(scopes))) {
    return open;
  }
  return open.filter((node) => canCreateRouteOnIngressNode(scopes, node.id, folderId ?? null));
}

export function toRouteIngressNode(node: RouteIngressNode): RouteIngressNode {
  return { id: node.id, displayName: node.displayName, hostname: node.hostname, status: node.status };
}

function describeNode(node: RouteIngressNode): string {
  const name =
    node.displayName && node.displayName !== node.hostname ? `${node.displayName} (${node.hostname})` : node.hostname;
  return `${name}: ${node.id}, ${node.status}`;
}

export interface ResolveRouteIngressNodeInput {
  scopes: readonly string[];
  /** The destination folder of the new route (null or undefined = root). */
  folderId?: string | null;
  /** The node the route's registered domains pin (see registeredDomainsIngressNodeId), or null. */
  pinnedNodeId: string | null;
  /** The domain that pinned the node, for messages. */
  pinnedByDomain?: string;
  candidates: readonly RouteIngressNodeCandidate[];
}

/**
 * Chooses the ingress node of a new route created without `nodeId`: the node its registered domains
 * are assigned to, otherwise the only node the caller may create on at this destination. Refuses
 * with 409 ROUTE_INGRESS_NODE_REQUIRED listing the eligible nodes when several qualify. The caller
 * still runs every create check (node grant, folder, domain affinity, service creation lock) with
 * the returned node.
 */
export function resolveRouteIngressNode(input: ResolveRouteIngressNodeInput): {
  nodeId: string;
  source: Exclude<RouteIngressNodeSource, 'request'>;
} {
  const { scopes, pinnedNodeId } = input;
  const folderId = input.folderId ?? null;
  if (pinnedNodeId) {
    if (!canCreateRouteOnIngressNode(scopes, pinnedNodeId, folderId)) {
      const domainText = input.pinnedByDomain
        ? `the registered domain ${input.pinnedByDomain}`
        : 'its registered domain';
      throw new AppError(
        403,
        'FORBIDDEN',
        `Missing proxy:create permission for this route: ${domainText} is served by Nginx ingress node ${pinnedNodeId}, and creating there needs proxy:create broadly, on that node, or on the route folder`,
        { requiredScope: `proxy:create:node/${pinnedNodeId}`, nodeId: pinnedNodeId }
      );
    }
    return { nodeId: pinnedNodeId, source: 'domain' };
  }

  const eligible = routeIngressNodesForScopes(input.candidates, scopes, folderId).map(toRouteIngressNode);
  // Only a connected node is picked automatically: a route placed on a disconnected node would sit
  // unapplied. The caller may still choose that node explicitly with nodeId.
  if (eligible.length === 1 && eligible[0]!.status === 'online') {
    return { nodeId: eligible[0]!.id, source: 'single_eligible' };
  }

  if (eligible.length === 0) {
    const holdsDestination =
      hasScope(scopes, 'proxy:create') ||
      (!!folderId && hasScope(scopes, `proxy:create:folder/${folderId}`)) ||
      scopes.some((scope) => scope.startsWith('proxy:create:') && !scope.startsWith('proxy:create:folder/'));
    if (!holdsDestination) {
      throw new AppError(403, 'FORBIDDEN', 'Missing proxy:create permission for the selected destination', {
        requiredScope: folderId ? `proxy:create:folder/${folderId}` : 'proxy:create',
      });
    }
    throw new AppError(
      409,
      'ROUTE_INGRESS_NODE_UNAVAILABLE',
      'No Nginx ingress node accepts new routes for this caller and destination (none exists, or every eligible node is locked for new services)',
      { eligibleNodes: [] }
    );
  }

  const listed = eligible.slice(0, LISTED_NODES_IN_MESSAGE).map(describeNode).join('; ');
  const more =
    eligible.length > LISTED_NODES_IN_MESSAGE ? `; and ${eligible.length - LISTED_NODES_IN_MESSAGE} more` : '';
  throw new AppError(
    409,
    'ROUTE_INGRESS_NODE_REQUIRED',
    `nodeId is required: no registered Opfield domain of this route pins an ingress node, and ${eligible.length === 1 ? 'the only Nginx ingress node that accepts new routes here is not connected' : `${eligible.length} Nginx ingress nodes accept new routes here`}. Pass nodeId with one of: ${listed}${more}`,
    { eligibleNodes: eligible }
  );
}
