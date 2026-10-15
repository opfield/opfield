import { and, eq, getTableName, inArray, or, type SQL, sql } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  appEnvironments,
  apps,
  databaseConnections,
  dockerComposeProjects,
  dockerContainerFolderAssignments,
  dockerDeployments,
  domains,
  loggingEnvironments,
  objectStorageConnections,
  pageProjects,
  proxyHosts,
  sslCertificates,
} from '@/db/schema/index.js';
import { type AppFamily, type AppMemberType, familyOfMemberType } from './app-families.js';
import type { AppFolderRef, AppFolderService } from './app-folders.service.js';

/** The `app` field every resource list and detail carries (null outside apps). */
export interface AppMemberRef {
  id: string;
  slug: string;
  name: string;
  environmentId: string | null;
  environmentName: string | null;
  environmentSlug: string | null;
}

/** A member as the API names it: containers by node and name, deployments and the rest by id. */
export interface AppMemberKey {
  type: AppMemberType;
  id: string;
  nodeId?: string | null;
}

/** List filters of every foldered list: `appId` (members of one app) wins over `excludeAppMembers`. */
export interface AppListFilter {
  excludeAppMembers?: boolean;
  appId?: string | null;
}

const NAMES_TTL_MS = 10_000;

export function memberKey(member: AppMemberKey): string {
  return member.type === 'container' ? `container:${member.nodeId ?? ''}:${member.id}` : `${member.type}:${member.id}`;
}

/** Parse `excludeAppMembers` / `appId` from a query object (REST query strings and MCP arguments). */
export function parseAppListFilter(query: Record<string, unknown> | undefined | null): AppListFilter {
  const raw = query?.excludeAppMembers;
  const appId = typeof query?.appId === 'string' && query.appId.trim() ? query.appId.trim() : null;
  return { excludeAppMembers: raw === true || raw === 'true' || raw === '1', appId };
}

/**
 * SQL for a list filter on a resource table whose rows sit in folders of `folderTable` (undefined: no filter):
 * `appId` keeps the members of that app, `excludeAppMembers` drops every app member.
 *
 * The folder subquery names its table and columns as plain identifiers under its own alias: the relational query
 * builder (`db.query.<table>.findMany`) rewrites every column object in a where clause to the outer table's alias,
 * which turned `proxy_host_folders.app_id` into `"proxyHosts"."app_id"`.
 */
export function appMemberFolderCondition(folderColumn: any, folderTable: any, filter: AppListFilter): SQL | undefined {
  if (!filter.appId && !filter.excludeAppMembers) return undefined;
  const alias = sql.identifier('app_member_folders');
  const folderIds = sql`select ${alias}.${sql.identifier(folderTable.id.name)} from ${sql.identifier(getTableName(folderTable))} ${alias}`;
  const folderAppId = sql`${alias}.${sql.identifier(folderTable.appId.name)}`;
  if (filter.appId) {
    return sql`${folderColumn} in (${folderIds} where ${folderAppId} = ${filter.appId})`;
  }
  return sql`(${folderColumn} is null or ${folderColumn} not in (${folderIds} where ${folderAppId} is not null))`;
}

/** Query-string boolean (`true`/`1`); zod's coerce turns "false" into true. */
export function queryFlag(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return value === true || value === 'true' || value === '1';
}

export function hasAppListFilter(filter: AppListFilter): boolean {
  return !!filter.appId || !!filter.excludeAppMembers;
}

/**
 * Which app and environment a resource belongs to, read from where it sits (a hidden folder of its family). Used by
 * list and detail serializers (`app` field and the `excludeAppMembers`/`appId` filters), search and audit tagging.
 * Lookups go through cached folder and name indexes (10 s, dropped on every app change): never use them to authorize.
 */
export class AppMembershipService {
  private names: {
    at: number;
    apps: Map<string, { slug: string; name: string }>;
    envs: Map<string, { name: string; slug: string }>;
  } | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly folders: AppFolderService
  ) {}

  invalidate(): void {
    this.names = null;
    this.folders.invalidate();
  }

  /** The app of a folder of `family` (an app root counts with environmentId null), or null for user folders. */
  async refForFolder(family: AppFamily, folderId: string | null | undefined): Promise<AppMemberRef | null> {
    if (!folderId) return null;
    const ref = (await this.folders.folderIndex()).get(folderId);
    return ref && ref.family === family ? this.toRef(ref) : null;
  }

  /** `app` for each row of a folder-based family list. */
  async annotate<T extends Record<string, any>>(
    family: AppFamily,
    rows: T[],
    folderIdOf: (row: T) => string | null | undefined = (row) => row.folderId
  ): Promise<Array<T & { app: AppMemberRef | null }>> {
    const index = await this.folders.folderIndex();
    const result: Array<T & { app: AppMemberRef | null }> = [];
    for (const row of rows) {
      const folderId = folderIdOf(row);
      const ref = folderId ? index.get(folderId) : undefined;
      result.push({ ...row, app: ref && ref.family === family ? await this.toRef(ref) : null });
    }
    return result;
  }

  /** Apply a list filter to rows already carrying `app`. */
  filterRows<T extends { app: AppMemberRef | null }>(rows: T[], filter: AppListFilter): T[] {
    if (filter.appId) return rows.filter((row) => row.app?.id === filter.appId);
    if (filter.excludeAppMembers) return rows.filter((row) => !row.app);
    return rows;
  }

  /** Annotate then filter (the usual list path). */
  async annotateAndFilter<T extends Record<string, any>>(
    family: AppFamily,
    rows: T[],
    filter: AppListFilter,
    folderIdOf?: (row: T) => string | null | undefined
  ): Promise<Array<T & { app: AppMemberRef | null }>> {
    return this.filterRows(await this.annotate(family, rows, folderIdOf), filter);
  }

  /** Hidden folder ids of a family: every app's, or one app's. */
  async hiddenFolderIds(family: AppFamily, appId?: string | null): Promise<string[]> {
    return [...(await this.folders.folderIndex()).values()]
      .filter((ref) => ref.family === family && (!appId || ref.appId === appId))
      .map((ref) => ref.folderId);
  }

  /** Docker placements (`container` keyed by name, `compose` by project id) to their folder, by `<nodeId>:<key>`. */
  async dockerFolderIds(
    resourceType: 'container' | 'compose',
    refs: ReadonlyArray<{ nodeId: string; resourceKey: string }>
  ): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    if (refs.length === 0) return result;
    const byNode = new Map<string, string[]>();
    for (const ref of refs) byNode.set(ref.nodeId, [...(byNode.get(ref.nodeId) ?? []), ref.resourceKey]);
    const conditions = [...byNode].map(([nodeId, keys]) =>
      and(
        eq(dockerContainerFolderAssignments.nodeId, nodeId),
        inArray(dockerContainerFolderAssignments.resourceKey, [...new Set(keys)])
      )
    );
    const rows = await this.db
      .select({
        nodeId: dockerContainerFolderAssignments.nodeId,
        resourceKey: dockerContainerFolderAssignments.resourceKey,
        folderId: dockerContainerFolderAssignments.folderId,
      })
      .from(dockerContainerFolderAssignments)
      .where(and(eq(dockerContainerFolderAssignments.resourceType, resourceType), or(...conditions)));
    for (const row of rows) result.set(`${row.nodeId}:${row.resourceKey}`, row.folderId ?? null);
    return result;
  }

  /** `app` of Docker rows keyed by node and placement key. */
  async annotateDocker<T extends Record<string, any>>(
    resourceType: 'container' | 'compose',
    rows: T[],
    keyOf: (row: T) => { nodeId: string; resourceKey: string } | null
  ): Promise<Array<T & { app: AppMemberRef | null }>> {
    const keys = rows.map(keyOf);
    const folderIds = await this.dockerFolderIds(
      resourceType,
      keys.filter((key): key is { nodeId: string; resourceKey: string } => !!key)
    );
    const family: AppFamily = resourceType === 'compose' ? 'compose' : 'containers';
    return this.annotate(family, rows, (row) => {
      const key = keyOf(row);
      return key ? (folderIds.get(`${key.nodeId}:${key.resourceKey}`) ?? null) : null;
    });
  }

  /**
   * The current folder of each member (null: not placed anywhere, unknown: left out). Resolves deployments to their
   * node and name and containers to their placement row.
   */
  async memberFolders(
    members: readonly AppMemberKey[]
  ): Promise<Map<string, { folderId: string | null; nodeIds: string[]; name: string | null }>> {
    const result = new Map<string, { folderId: string | null; nodeIds: string[]; name: string | null }>();
    const ofType = (type: AppMemberType) => members.filter((member) => member.type === type);
    const ids = (type: AppMemberType) => [...new Set(ofType(type).map((member) => member.id))];

    const routeIds = ids('route');
    if (routeIds.length) {
      const rows = await this.db
        .select({
          id: proxyHosts.id,
          folderId: proxyHosts.folderId,
          nodeId: proxyHosts.nodeId,
          domainNames: proxyHosts.domainNames,
        })
        .from(proxyHosts)
        .where(inArray(proxyHosts.id, routeIds));
      for (const row of rows) {
        result.set(memberKey({ type: 'route', id: row.id }), {
          folderId: row.folderId ?? null,
          nodeIds: row.nodeId ? [row.nodeId] : [],
          name: Array.isArray(row.domainNames) ? (row.domainNames[0] ?? null) : null,
        });
      }
    }
    const databaseIds = ids('database');
    if (databaseIds.length) {
      const rows = await this.db
        .select({ id: databaseConnections.id, folderId: databaseConnections.folderId, name: databaseConnections.name })
        .from(databaseConnections)
        .where(inArray(databaseConnections.id, databaseIds));
      for (const row of rows) {
        result.set(memberKey({ type: 'database', id: row.id }), {
          folderId: row.folderId ?? null,
          nodeIds: [],
          name: row.name,
        });
      }
    }
    const storageIds = ids('storage');
    if (storageIds.length) {
      const rows = await this.db
        .select({
          id: objectStorageConnections.id,
          folderId: objectStorageConnections.folderId,
          name: objectStorageConnections.name,
        })
        .from(objectStorageConnections)
        .where(inArray(objectStorageConnections.id, storageIds));
      for (const row of rows) {
        result.set(memberKey({ type: 'storage', id: row.id }), {
          folderId: row.folderId ?? null,
          nodeIds: [],
          name: row.name,
        });
      }
    }
    const pageIds = ids('pages');
    if (pageIds.length) {
      const rows = await this.db
        .select({
          id: pageProjects.id,
          folderId: pageProjects.folderId,
          name: pageProjects.name,
          nodeId: pageProjects.nodeId,
        })
        .from(pageProjects)
        .where(inArray(pageProjects.id, pageIds));
      for (const row of rows) {
        result.set(memberKey({ type: 'pages', id: row.id }), {
          folderId: row.folderId ?? null,
          nodeIds: row.nodeId ? [row.nodeId] : [],
          name: row.name,
        });
      }
    }
    // Certificates and logging environments run on no node.
    const certificateIds = ids('certificate');
    if (certificateIds.length) {
      const rows = await this.db
        .select({ id: sslCertificates.id, folderId: sslCertificates.folderId, name: sslCertificates.name })
        .from(sslCertificates)
        .where(inArray(sslCertificates.id, certificateIds));
      for (const row of rows) {
        result.set(memberKey({ type: 'certificate', id: row.id }), {
          folderId: row.folderId ?? null,
          nodeIds: [],
          name: row.name,
        });
      }
    }
    const domainIds = ids('domain');
    if (domainIds.length) {
      const rows = await this.db
        .select({
          id: domains.id,
          folderId: domains.folderId,
          name: domains.domain,
          nodeId: domains.nginxNodeId,
        })
        .from(domains)
        .where(inArray(domains.id, domainIds));
      for (const row of rows) {
        result.set(memberKey({ type: 'domain', id: row.id }), {
          folderId: row.folderId ?? null,
          nodeIds: row.nodeId ? [row.nodeId] : [],
          name: row.name,
        });
      }
    }
    const loggingIds = ids('logging');
    if (loggingIds.length) {
      const rows = await this.db
        .select({ id: loggingEnvironments.id, folderId: loggingEnvironments.folderId, name: loggingEnvironments.name })
        .from(loggingEnvironments)
        .where(inArray(loggingEnvironments.id, loggingIds));
      for (const row of rows) {
        result.set(memberKey({ type: 'logging', id: row.id }), {
          folderId: row.folderId ?? null,
          nodeIds: [],
          name: row.name,
        });
      }
    }
    const composeIds = ids('compose');
    if (composeIds.length) {
      const projects = await this.db
        .select({
          id: dockerComposeProjects.id,
          nodeId: dockerComposeProjects.nodeId,
          name: dockerComposeProjects.name,
        })
        .from(dockerComposeProjects)
        .where(inArray(dockerComposeProjects.id, composeIds));
      const folders = await this.dockerFolderIds(
        'compose',
        projects.map((project) => ({ nodeId: project.nodeId, resourceKey: project.id }))
      );
      for (const project of projects) {
        result.set(memberKey({ type: 'compose', id: project.id }), {
          folderId: folders.get(`${project.nodeId}:${project.id}`) ?? null,
          nodeIds: [project.nodeId],
          name: project.name,
        });
      }
    }
    const deploymentIds = ids('deployment');
    if (deploymentIds.length) {
      const deployments = await this.db
        .select({ id: dockerDeployments.id, nodeId: dockerDeployments.nodeId, name: dockerDeployments.name })
        .from(dockerDeployments)
        .where(inArray(dockerDeployments.id, deploymentIds));
      const folders = await this.dockerFolderIds(
        'container',
        deployments.map((deployment) => ({ nodeId: deployment.nodeId, resourceKey: deployment.name }))
      );
      for (const deployment of deployments) {
        result.set(memberKey({ type: 'deployment', id: deployment.id }), {
          folderId: folders.get(`${deployment.nodeId}:${deployment.name}`) ?? null,
          nodeIds: [deployment.nodeId],
          name: deployment.name,
        });
      }
    }
    const containers = ofType('container').filter((member) => !!member.nodeId);
    if (containers.length) {
      const folders = await this.dockerFolderIds(
        'container',
        containers.map((member) => ({ nodeId: member.nodeId!, resourceKey: member.id }))
      );
      for (const member of containers) {
        result.set(memberKey(member), {
          folderId: folders.get(`${member.nodeId}:${member.id}`) ?? null,
          nodeIds: [member.nodeId!],
          name: member.id,
        });
      }
    }
    return result;
  }

  /** `app` of each member (null outside apps; unknown members left out). */
  async refsForMembers(members: readonly AppMemberKey[]): Promise<Map<string, AppMemberRef | null>> {
    const folders = await this.memberFolders(members);
    const result = new Map<string, AppMemberRef | null>();
    for (const member of members) {
      const key = memberKey(member);
      const entry = folders.get(key);
      if (!entry) continue;
      result.set(key, await this.refForFolder(familyOfMemberType(member.type), entry.folderId));
    }
    return result;
  }

  async toRef(folder: AppFolderRef): Promise<AppMemberRef | null> {
    let names = await this.loadNames();
    // An app or environment created after the names were cached: reload once instead of labelling it as no app.
    if (!names.apps.has(folder.appId) || (folder.environmentId && !names.envs.has(folder.environmentId))) {
      this.names = null;
      names = await this.loadNames();
    }
    const app = names.apps.get(folder.appId);
    if (!app) return null;
    return {
      id: folder.appId,
      slug: app.slug,
      name: app.name,
      environmentId: folder.environmentId,
      environmentName: folder.environmentId ? (names.envs.get(folder.environmentId)?.name ?? null) : null,
      environmentSlug: folder.environmentId ? (names.envs.get(folder.environmentId)?.slug ?? null) : null,
    };
  }

  private async loadNames() {
    if (this.names && Date.now() - this.names.at < NAMES_TTL_MS) return this.names;
    const appRows = await this.db.select({ id: apps.id, slug: apps.slug, name: apps.name }).from(apps);
    const envRows = await this.db
      .select({ id: appEnvironments.id, name: appEnvironments.name, slug: appEnvironments.slug })
      .from(appEnvironments);
    this.names = {
      at: Date.now(),
      apps: new Map(appRows.map((row) => [row.id, { slug: row.slug, name: row.name }])),
      envs: new Map(envRows.map((row) => [row.id, { name: row.name, slug: row.slug }])),
    };
    return this.names;
  }
}

function membership(): AppMembershipService | null {
  return container.isRegistered(AppMembershipService) ? container.resolve(AppMembershipService) : null;
}

/** `app` on rows of a folder-based list, then the list filter (no-op when apps are not wired, e.g. in unit tests). */
export async function withAppMembers<T extends Record<string, any>>(
  family: AppFamily,
  rows: T[],
  filter: AppListFilter = {},
  folderIdOf?: (row: T) => string | null | undefined
): Promise<Array<T & { app: AppMemberRef | null }>> {
  const service = membership();
  if (!service) return rows.map((row) => ({ ...row, app: null }));
  return service.annotateAndFilter(family, rows, filter, folderIdOf);
}

/** `app` on Docker rows keyed by node and placement key (container/deployment name, Compose project id). */
export async function withDockerAppMembers<T extends Record<string, any>>(
  resourceType: 'container' | 'compose',
  rows: T[],
  keyOf: (row: T) => { nodeId: string; resourceKey: string } | null,
  filter: AppListFilter = {}
): Promise<Array<T & { app: AppMemberRef | null }>> {
  const service = membership();
  if (!service) return rows.map((row) => ({ ...row, app: null }));
  return service.filterRows(await service.annotateDocker(resourceType, rows, keyOf), filter);
}

/** `app` of one member (detail responses); null outside apps or when apps are not wired. */
export async function appForMember(member: AppMemberKey): Promise<AppMemberRef | null> {
  const service = membership();
  if (!service) return null;
  return (await service.refsForMembers([member])).get(memberKey(member)) ?? null;
}
