import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerDeployments } from '@/db/schema/docker-deployments.js';
import { pageProjects, pageRouteTargets, pageTags, proxyAdditionalSecureLinks } from '@/db/schema/index.js';
import { nodes } from '@/db/schema/nodes.js';

export interface PageUpstreamDisplayTarget {
  projectId: string;
  projectName: string;
  projectSlug: string;
  projectAppearanceColor: string | null;
  tagId: string;
  tagName: string;
  deploymentId: string | null;
  status: string;
  generation: number;
  lastErrorCode: string | null;
}

export type WithDockerUpstreamDisplay<T> = T & {
  dockerDeploymentName: string | null;
  dockerNodeSlug: string | null;
  dockerNodeAppearanceColor: string | null;
  secureLinkActive: boolean;
  /** Secure Links of the route besides its own: user-managed ones and the ones of additional routes. */
  additionalSecureLinkCount: number;
  pageTarget: PageUpstreamDisplayTarget | null;
};

export async function attachDockerUpstreamDisplay<
  T extends {
    id?: string;
    upstreamKind?: string;
    dockerDeploymentId: string | null;
    dockerNodeId: string | null;
  },
>(db: DrizzleClient, hosts: T[]): Promise<Array<WithDockerUpstreamDisplay<T>>> {
  const deploymentIds = [
    ...new Set(hosts.flatMap((host) => (host.dockerDeploymentId ? [host.dockerDeploymentId] : []))),
  ];
  const nodeIds = [...new Set(hosts.flatMap((host) => (host.dockerNodeId ? [host.dockerNodeId] : [])))];
  const pageHostIds = [
    ...new Set(hosts.flatMap((host) => (host.upstreamKind === 'pages' && host.id ? [host.id] : []))),
  ];

  const hostIds = [...new Set(hosts.flatMap((host) => (host.id ? [host.id] : [])))];

  const [deployments, dockerNodes, pagesTargets, additionalLinkRows] = await Promise.all([
    deploymentIds.length > 0
      ? db
          .select({ id: dockerDeployments.id, name: dockerDeployments.name })
          .from(dockerDeployments)
          .where(inArray(dockerDeployments.id, deploymentIds))
      : [],
    nodeIds.length > 0
      ? db
          .select({ id: nodes.id, slug: nodes.slug, appearanceColor: nodes.appearanceColor })
          .from(nodes)
          .where(inArray(nodes.id, nodeIds))
      : [],
    pageHostIds.length > 0
      ? db
          .select({
            proxyHostId: pageRouteTargets.proxyHostId,
            projectId: pageRouteTargets.projectId,
            projectName: pageProjects.name,
            projectSlug: pageProjects.slug,
            projectAppearanceColor: pageProjects.appearanceColor,
            tagId: pageRouteTargets.tagId,
            tagName: pageTags.name,
            deploymentId: pageRouteTargets.activeDeploymentId,
            status: pageRouteTargets.status,
            generation: pageRouteTargets.generation,
            lastErrorCode: pageRouteTargets.lastErrorCode,
          })
          .from(pageRouteTargets)
          .innerJoin(pageProjects, eq(pageProjects.id, pageRouteTargets.projectId))
          .innerJoin(pageTags, eq(pageTags.id, pageRouteTargets.tagId))
          .where(inArray(pageRouteTargets.proxyHostId, pageHostIds))
      : [],
    // Availability members are internal to Availability and never shown as Secure Links of the route.
    hostIds.length > 0
      ? db
          .select({ proxyHostId: proxyAdditionalSecureLinks.proxyHostId })
          .from(proxyAdditionalSecureLinks)
          .where(
            and(
              inArray(proxyAdditionalSecureLinks.proxyHostId, hostIds),
              inArray(proxyAdditionalSecureLinks.purpose, ['user_managed', 'additional_route'])
            )
          )
      : [],
  ]);
  const additionalCounts = new Map<string, number>();
  for (const { proxyHostId } of additionalLinkRows) {
    additionalCounts.set(proxyHostId, (additionalCounts.get(proxyHostId) ?? 0) + 1);
  }
  const names = new Map(deployments.map((deployment) => [deployment.id, deployment.name]));
  const slugs = new Map(dockerNodes.map((node) => [node.id, node.slug]));
  const colors = new Map(dockerNodes.map((node) => [node.id, node.appearanceColor]));
  const pageTargets = new Map(pagesTargets.map(({ proxyHostId, ...target }) => [proxyHostId, target]));
  return hosts.map((host) => {
    const visible = { ...host } as Record<string, unknown>;
    const secureLinkActive = visible.secureLinkStatus === 'active';
    if ((visible.upstreamKind as string | undefined)?.startsWith('docker_')) {
      visible.forwardHost = null;
      visible.forwardPort = null;
      visible.dockerHostPort = null;
    }
    for (const key of [
      'secureLinkGeneration',
      'secureLinkStatus',
      'secureLinkLastError',
      'secureLinkTargetNetwork',
      'secureLinkTargetContainer',
      'secureLinkTargetHost',
      'secureLinkListenerPort',
      'secureLinkConnectorPort',
      'secureLinkMigratedAt',
    ]) {
      delete visible[key];
    }
    return {
      ...visible,
      secureLinkActive,
      additionalSecureLinkCount: host.id ? (additionalCounts.get(host.id) ?? 0) : 0,
      dockerDeploymentName: host.dockerDeploymentId ? (names.get(host.dockerDeploymentId) ?? null) : null,
      dockerNodeSlug: host.dockerNodeId ? (slugs.get(host.dockerNodeId) ?? null) : null,
      dockerNodeAppearanceColor: host.dockerNodeId ? (colors.get(host.dockerNodeId) ?? null) : null,
      pageTarget: host.id ? (pageTargets.get(host.id) ?? null) : null,
    } as WithDockerUpstreamDisplay<T>;
  });
}
