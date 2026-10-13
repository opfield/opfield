import { and, eq } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { proxyAdditionalRoutes, proxyAdditionalSecureLinks, proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

async function findLinkedProxyHost(
  db: DrizzleExecutor,
  where: ReturnType<typeof and>
): Promise<{ id: string; domainNames: string[] } | undefined> {
  const [host] = await db
    .select({ id: proxyHosts.id, domainNames: proxyHosts.domainNames })
    .from(proxyHosts)
    .where(where)
    .limit(1);
  return host && Array.isArray(host.domainNames) ? host : undefined;
}

async function findLinkedAdditionalRoute(
  db: DrizzleExecutor,
  where: ReturnType<typeof and>
): Promise<{ id: string; domainNames: string[] } | undefined> {
  const [route] = await db
    .select({ id: proxyHosts.id, domainNames: proxyHosts.domainNames })
    .from(proxyAdditionalRoutes)
    .innerJoin(proxyHosts, eq(proxyAdditionalRoutes.proxyHostId, proxyHosts.id))
    .where(where)
    .limit(1);
  return route && Array.isArray(route.domainNames) ? route : undefined;
}

async function findLinkedAdditionalSecureLink(
  db: DrizzleExecutor,
  where: ReturnType<typeof and>
): Promise<{ id: string; domainNames: string[] } | undefined> {
  const [link] = await db
    .select({ id: proxyHosts.id, domainNames: proxyHosts.domainNames })
    .from(proxyAdditionalSecureLinks)
    .innerJoin(proxyHosts, eq(proxyAdditionalSecureLinks.proxyHostId, proxyHosts.id))
    .where(where)
    .limit(1);
  return link && Array.isArray(link.domainNames) ? link : undefined;
}

function inUseError(host: { id: string; domainNames: string[] }) {
  const label = host.domainNames[0] ?? host.id;
  return new AppError(
    409,
    'PROXY_UPSTREAM_IN_USE',
    `Resource is used by route "${label}". Change or delete the route first.`
  );
}

export async function assertContainerNotUsedByProxy(db: DrizzleClient, nodeId: string, containerName: string) {
  const host = await findLinkedProxyHost(
    db,
    and(
      eq(proxyHosts.upstreamKind, 'docker_container'),
      eq(proxyHosts.dockerNodeId, nodeId),
      eq(proxyHosts.dockerContainerName, containerName)
    )
  );
  if (host) throw inUseError(host);

  const routeHost = await findLinkedAdditionalRoute(
    db,
    and(
      eq(proxyAdditionalRoutes.targetKind, 'docker_container'),
      eq(proxyAdditionalRoutes.dockerNodeId, nodeId),
      eq(proxyAdditionalRoutes.dockerContainerName, containerName)
    )
  );
  if (routeHost) throw inUseError(routeHost);
}

export async function assertDeploymentNotUsedByProxy(db: DrizzleClient, deploymentId: string) {
  const host = await findLinkedProxyHost(
    db,
    and(eq(proxyHosts.upstreamKind, 'docker_deployment'), eq(proxyHosts.dockerDeploymentId, deploymentId))
  );
  if (host) throw inUseError(host);

  const routeHost = await findLinkedAdditionalRoute(
    db,
    and(
      eq(proxyAdditionalRoutes.targetKind, 'docker_deployment'),
      eq(proxyAdditionalRoutes.dockerDeploymentId, deploymentId)
    )
  );
  if (routeHost) throw inUseError(routeHost);
}

/**
 * A Compose project a Route reaches (its upstream, an additional route or an additional Secure Link) cannot be
 * deleted: checked before the deletion removes anything, like a container's.
 */
export async function assertComposeProjectNotUsedByProxy(db: DrizzleExecutor, projectId: string) {
  const host = await findLinkedProxyHost(db, and(eq(proxyHosts.dockerComposeProjectId, projectId)));
  if (host) throw inUseError(host);

  const routeHost = await findLinkedAdditionalRoute(
    db,
    and(eq(proxyAdditionalRoutes.dockerComposeProjectId, projectId))
  );
  if (routeHost) throw inUseError(routeHost);

  const secureLinkHost = await findLinkedAdditionalSecureLink(
    db,
    and(eq(proxyAdditionalSecureLinks.dockerComposeProjectId, projectId))
  );
  if (secureLinkHost) throw inUseError(secureLinkHost);
}
