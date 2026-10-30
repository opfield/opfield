import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  accessIdentityProviders,
  accessLists,
  pageDeployments,
  pageProjects,
  pageRouteTargets,
  pageTags,
  pageWildcardProfiles,
  proxyHostDomains,
  proxyHosts,
  users,
} from '@/db/schema/index.js';
import { isAccessHostName, normalizeAccessHost } from './access-token.js';

export type AccessListRow = typeof accessLists.$inferSelect;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OpfieldAccessUser {
  id: string;
  email: string;
  name: string;
  /** Permission group ids (primary and additional). */
  groups: string[];
}

/** The records the sign-in flow reads. */
export interface AccessSignInDirectory {
  getList(id: string): Promise<AccessListRow | null>;
  /**
   * How the host is served when the node serves it as a route or Pages preview protected by the list; null for any
   * other host or node (no token is ever issued for it).
   */
  hostOfList(listId: string, host: string, nodeId: string): Promise<{ secure: boolean } | null>;
  /** An active Opfield user (not blocked, not deleted), else null. */
  getOpfieldUser(id: string): Promise<OpfieldAccessUser | null>;
  providerNames(ids: string[]): Promise<Map<string, string>>;
}

/** A route domain matches the host exactly, or as `*.parent` one label above it. */
export function domainServesHost(domain: string, host: string): boolean {
  const name = normalizeAccessHost(domain);
  const target = normalizeAccessHost(host);
  if (!name || !target || !isAccessHostName(target)) return false;
  if (name === target) return true;
  if (!name.startsWith('*.')) return false;
  const parent = name.slice(1);
  if (!target.endsWith(parent)) return false;
  const label = target.slice(0, target.length - parent.length);
  return label.length > 0 && !label.includes('.');
}

export class DrizzleAccessSignInDirectory implements AccessSignInDirectory {
  constructor(private readonly db: DrizzleClient) {}

  async getList(id: string): Promise<AccessListRow | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const [row] = await this.db.select().from(accessLists).where(eq(accessLists.id, id)).limit(1);
    return row ?? null;
  }

  async hostOfList(listId: string, host: string, nodeId: string): Promise<{ secure: boolean } | null> {
    const target = normalizeAccessHost(host);
    if (!target || !UUID_PATTERN.test(nodeId)) return null;
    const projects = this.db
      .select({ id: pageProjects.id })
      .from(pageProjects)
      .where(eq(pageProjects.accessListId, listId));
    // A route serving a Pages project is protected by the project's list.
    const pageRouteHosts = this.db
      .select({ id: pageRouteTargets.proxyHostId })
      .from(pageRouteTargets)
      .where(inArray(pageRouteTargets.projectId, projects));
    const [routes, previews] = await Promise.all([
      // The names this node serves (one row per ingress group member), of enabled routes the list protects.
      this.db
        .select({ domain: proxyHostDomains.domain, sslEnabled: proxyHosts.sslEnabled })
        .from(proxyHostDomains)
        .innerJoin(proxyHosts, eq(proxyHosts.id, proxyHostDomains.proxyHostId))
        .where(
          and(
            eq(proxyHostDomains.nodeId, nodeId),
            eq(proxyHostDomains.enabled, true),
            eq(proxyHosts.enabled, true),
            or(eq(proxyHosts.accessListId, listId), inArray(proxyHosts.id, pageRouteHosts))
          )
        ),
      this.previewOnNode(listId, target, nodeId),
    ]);
    for (const route of routes) {
      if (domainServesHost(route.domain, target)) return { secure: route.sslEnabled };
    }
    // Pages preview hosts are served over HTTPS (the Pages wildcard certificate).
    return previews ? { secure: true } : null;
  }

  /** Whether the host is a preview of a Pages project the list protects, served by this node. */
  private async previewOnNode(listId: string, target: string, nodeId: string): Promise<boolean> {
    const [deployment, tag] = await Promise.all([
      this.db
        .select({ projectId: pageDeployments.projectId })
        .from(pageDeployments)
        .where(and(eq(pageDeployments.previewHostname, target), isNull(pageDeployments.deletedAt)))
        .limit(1),
      this.db
        .select({ projectId: pageTags.projectId })
        .from(pageTags)
        .where(eq(pageTags.previewHostname, target))
        .limit(1),
    ]);
    const projectId = deployment[0]?.projectId ?? tag[0]?.projectId;
    if (!projectId) return false;
    const [project] = await this.db
      .select({
        accessListId: pageProjects.accessListId,
        nodeId: pageProjects.nodeId,
        migrationSourceNodeId: pageProjects.migrationSourceNodeId,
        migrationTargetNodeId: pageProjects.migrationTargetNodeId,
      })
      .from(pageProjects)
      .where(eq(pageProjects.id, projectId))
      .limit(1);
    if (!project || project.accessListId !== listId) return false;
    if ([project.nodeId, project.migrationSourceNodeId, project.migrationTargetNodeId].includes(nodeId)) return true;
    // Previews are served on the node of the Pages wildcard profile.
    const [profile] = await this.db
      .select({ id: pageWildcardProfiles.id })
      .from(pageWildcardProfiles)
      .where(eq(pageWildcardProfiles.nodeId, nodeId))
      .limit(1);
    return !!profile;
  }

  async getOpfieldUser(id: string): Promise<OpfieldAccessUser | null> {
    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        groupId: users.groupId,
        additionalGroupIds: users.additionalGroupIds,
        isBlocked: users.isBlocked,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!row || row.isBlocked || row.deletedAt) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      groups: [...new Set([row.groupId, ...(row.additionalGroupIds ?? [])])],
    };
  }

  async providerNames(ids: string[]): Promise<Map<string, string>> {
    const valid = ids.filter((id) => UUID_PATTERN.test(id));
    if (valid.length === 0) return new Map();
    const rows = await this.db
      .select({ id: accessIdentityProviders.id, name: accessIdentityProviders.name })
      .from(accessIdentityProviders)
      .where(inArray(accessIdentityProviders.id, valid));
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}
