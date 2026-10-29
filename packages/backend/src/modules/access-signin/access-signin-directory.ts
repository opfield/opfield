import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  accessIdentityProviders,
  accessLists,
  pageDeployments,
  pageProjects,
  pageRouteTargets,
  pageTags,
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
   * How the host is served when it is a route or Pages host protected by the list; null for any other host (no
   * token is ever issued for it).
   */
  hostOfList(listId: string, host: string): Promise<{ secure: boolean } | null>;
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

  async hostOfList(listId: string, host: string): Promise<{ secure: boolean } | null> {
    const target = normalizeAccessHost(host);
    if (!target) return null;
    const projects = this.db
      .select({ id: pageProjects.id })
      .from(pageProjects)
      .where(eq(pageProjects.accessListId, listId));
    const [routes, pageRoutes, previews] = await Promise.all([
      this.db
        .select({ domainNames: proxyHosts.domainNames, sslEnabled: proxyHosts.sslEnabled })
        .from(proxyHosts)
        .where(and(eq(proxyHosts.accessListId, listId), eq(proxyHosts.enabled, true))),
      // A route serving a Pages project is protected by the project's list.
      this.db
        .select({ domainNames: proxyHosts.domainNames, sslEnabled: proxyHosts.sslEnabled })
        .from(pageRouteTargets)
        .innerJoin(proxyHosts, eq(proxyHosts.id, pageRouteTargets.proxyHostId))
        .where(and(inArray(pageRouteTargets.projectId, projects), eq(proxyHosts.enabled, true))),
      Promise.all([
        this.db
          .select({ id: pageDeployments.id })
          .from(pageDeployments)
          .where(
            and(
              inArray(pageDeployments.projectId, projects),
              eq(pageDeployments.previewHostname, target),
              isNull(pageDeployments.deletedAt)
            )
          )
          .limit(1),
        this.db
          .select({ id: pageTags.id })
          .from(pageTags)
          .where(and(inArray(pageTags.projectId, projects), eq(pageTags.previewHostname, target)))
          .limit(1),
      ]),
    ]);
    for (const route of [...routes, ...pageRoutes]) {
      if ((route.domainNames ?? []).some((domain) => domainServesHost(domain, target))) {
        return { secure: route.sslEnabled };
      }
    }
    // Pages preview hosts are served over HTTPS (the Pages wildcard certificate).
    if (previews[0].length > 0 || previews[1].length > 0) return { secure: true };
    return null;
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
