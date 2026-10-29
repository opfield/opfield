import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';

const logger = createChildLogger('AccessListCredentials');

/**
 * Removes a list's htpasswd file once no route config references it (the list no longer checks with basic
 * authentication on nodes without the access socket, or it was deleted) from every connected Nginx node: a node keeps
 * it from routes that moved away or dropped the list earlier, so the routes using the list now do not name every node
 * that holds it. A node that is not connected drops it in its reconnect sync, which removes the credentials no config
 * of the node references. The file is written by the route apply (ProxyServiceCore.deployAccessListCredentials).
 */
export async function removeAccessListHtpasswd(
  db: DrizzleClient,
  nodeDispatch: NodeDispatchService,
  accessListId: string
): Promise<void> {
  // Pages previews render the same htpasswd file on their Project's node(s); removing it there would break a
  // protected preview.
  const pagesUsingList = await db.query.pageProjects.findMany({
    where: (projects, { eq: equals }) => equals(projects.accessListId, accessListId),
    columns: { nodeId: true, migrationTargetNodeId: true },
  });
  const pagesNodeIds = new Set(
    pagesUsingList.flatMap((project) => [project.nodeId, project.migrationTargetNodeId]).filter(Boolean)
  );

  const nginxNodes = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.type, 'nginx'));
  const nodeIds = nginxNodes
    .map((node) => node.id)
    .filter((nodeId) => !pagesNodeIds.has(nodeId) && nodeDispatch.isNodeConnected(nodeId));

  for (const nodeId of nodeIds) {
    try {
      const result = await nodeDispatch.removeHtpasswd(nodeId, accessListId);
      if (!result.success) {
        logger.warn('Failed to remove stale htpasswd file from node', { accessListId, nodeId, error: result.error });
      }
    } catch (error) {
      logger.warn('Failed to remove stale htpasswd file from node', { accessListId, nodeId, error });
    }
  }
  logger.debug('Htpasswd removed from nodes', { accessListId });
}
