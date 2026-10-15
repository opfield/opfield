import { and, asc, eq, inArray, max, or, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { appEnvironmentNodes, appEnvironments, appFolders, apps } from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { announceResourceScopeChanges, removeDanglingResourceScopes } from '@/lib/resource-scope-cleanup.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { AvatarStorageService } from '@/modules/auth/avatar-storage.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import {
  APP_CREATE_SCOPE,
  APP_DELETE_SCOPE,
  APP_EDIT_SCOPE,
  APP_ENV_MANAGE_SCOPE,
  APP_OPERATE_SCOPE,
  APP_PROMOTE_SCOPE,
  APP_VIEW_SCOPE,
  assertAppScope,
  assertAppWideScope,
  hasAnyAppMemberViewScope,
  hasAppScope,
  hasAppWideScope,
  visibleEnvironmentIds,
} from './app-access.js';
import { environmentCreateAccess, environmentsWithPlaceGrants } from './app-create-access.js';
import { type AppFamily, type AppMemberType, familyRecord } from './app-families.js';
import type { AppFolderService } from './app-folders.service.js';
import { type AppVisibility, memberKeysByEnvironment } from './app-member-visibility.js';
import {
  type AppMember,
  type AppMemberCounts,
  type AppMembersReader,
  canViewMember,
  emptyMemberCounts,
} from './app-members.service.js';
import type {
  CreateAppEnvironmentInput,
  CreateAppInput,
  UpdateAppEnvironmentInput,
  UpdateAppInput,
} from './apps.schemas.js';

const logger = createChildLogger('AppsService');

export type AppRow = typeof apps.$inferSelect;
export type AppEnvironmentRow = typeof appEnvironments.$inferSelect;
export type AppHealth = 'healthy' | 'degraded' | 'failing' | 'unknown';
export type AppIncidentState = 'none' | 'stopped' | 'isolated' | 'partial';

export interface AppActor {
  userId: string;
  scopes: readonly string[];
}

export interface EnvironmentHealthSummary {
  health: AppHealth;
  running: number;
  failing: number;
  degraded: number;
  /** Members stopped on request: shown, but they do not change the health. */
  stopped: number;
  /** Open warnings (a nearly full disk, 5xx errors): each makes the environment degraded. */
  warnings: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
}

/** Health and maintenance providers filled in by later modules (health aggregation, maintenance overlay). */
export interface AppHealthProvider {
  summarizeEnvironments(
    scopes: readonly string[],
    environmentIds: readonly string[]
  ): Promise<Map<string, EnvironmentHealthSummary>>;
}

export interface AppMaintenanceHooks {
  /** Recompute the overlay of the given app (after app/env changes) — routes of deleted envs included. */
  afterAppChange(appId: string, routeIds?: readonly string[]): Promise<void>;
  /** Route ids that are members of the app or one environment (before a delete ungroups them). */
  memberRouteIds(appId: string, environmentId?: string): Promise<string[]>;
  /** Environment maintenance state for the env detail. */
  environmentMaintenance(
    app: AppRow,
    environments: readonly AppEnvironmentRow[]
  ): Promise<Map<string, Record<string, unknown>>>;
}

/** Hook for incidents (shutdown/isolation): refuse deletes while one is active; open incidents per environment. */
export interface AppIncidentGuard {
  assertNoActiveIncident(appId: string, environmentId?: string): Promise<void>;
  /** `memberKeys`: environments seen only through members, with the keys of those members (items filtered to them). */
  summaries?(
    environmentIds: readonly string[],
    memberKeys?: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<Map<string, Array<{ kind: 'shutdown' | 'isolation' }>>>;
}

/** The app list's incident badge from the open incidents of its visible environments. */
export function appIncidentState(
  environmentIds: readonly string[],
  incidents: ReadonlyMap<string, ReadonlyArray<{ kind: 'shutdown' | 'isolation' }>>
): AppIncidentState {
  if (environmentIds.length === 0) return 'none';
  const isolated = environmentIds.filter((id) => incidents.get(id)?.some((incident) => incident.kind === 'isolation'));
  if (isolated.length > 0) return isolated.length === environmentIds.length ? 'isolated' : 'partial';
  const stopped = environmentIds.filter((id) => incidents.get(id)?.some((incident) => incident.kind === 'shutdown'));
  if (stopped.length > 0) return stopped.length === environmentIds.length ? 'stopped' : 'partial';
  return 'none';
}

const NO_FOLDERS: Record<AppFamily, string | null> = familyRecord(() => null);

const DEFAULT_HEALTH: EnvironmentHealthSummary = {
  health: 'healthy',
  running: 0,
  failing: 0,
  degraded: 0,
  stopped: 0,
  warnings: 0,
  cpuPercent: null,
  memoryBytes: null,
};

export function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** `base`, else `base-2`, `base-3`, ... the first one not taken. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function samePatterns(a: readonly string[], b: readonly string[] | null | undefined): boolean {
  const other = b ?? [];
  return a.length === other.length && a.every((value, index) => value === other[index]);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const cause = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = cause?.code ?? cause?.cause?.code;
  const name = cause?.constraint ?? cause?.cause?.constraint;
  return code === '23505' && name === constraint;
}

/**
 * Apps and their environments. An app is a name plus hidden folders: each environment has one folder per resource
 * family, and its members are what sits in them. New apps start with one environment, `production`, marked as
 * Production; exactly one environment holds the marker. Deleting an environment or an app leaves its members running
 * at the top level of their lists and removes the grants that named its folders or the app.
 */
export class AppsService {
  private eventBus?: EventBusService;
  private health?: AppHealthProvider;
  private maintenance?: AppMaintenanceHooks;
  private incidents?: AppIncidentGuard;
  private logoStorage?: AvatarStorageService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly folders: AppFolderService,
    private readonly members: AppMembersReader
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  setHealthProvider(provider: AppHealthProvider) {
    this.health = provider;
  }

  setMaintenanceHooks(hooks: AppMaintenanceHooks) {
    this.maintenance = hooks;
  }

  setIncidentGuard(guard: AppIncidentGuard) {
    this.incidents = guard;
  }

  /** App logos live in the user avatar storage: same files, same size and type checks. */
  setLogoStorage(storage: AvatarStorageService) {
    this.logoStorage = storage;
  }

  publish(appId: string, action: string) {
    this.eventBus?.publish('apps', { appId, action });
  }

  // ── Reads ──────────────────────────────────────────────────────────

  /**
   * An app by id or slug with how the caller sees it (see AppVisibility), 404 when it does not exist or the caller
   * can view neither the app nor any of its members. Actions still check their own scopes.
   */
  async resolveVisible(
    scopes: readonly string[],
    idOrSlug: string
  ): Promise<{ app: AppRow; envs: AppEnvironmentRow[] } & AppVisibility> {
    const app = await this.findApp(idOrSlug);
    if (!app) throw new AppError(404, 'APP_NOT_FOUND', 'App not found');
    const envs = await this.environmentsOf(app.id);
    const visibility = (await this.visibilities(scopes, [{ app, envs }])).get(app.id);
    if (!visibility) throw new AppError(404, 'APP_NOT_FOUND', 'App not found');
    return { app, envs, ...visibility };
  }

  /**
   * How the caller sees each app (missing: not at all). apps:view on the app or an environment gives `full` access to
   * those environments; every other environment is visible when the caller can view one of its members. Members are
   * read only for environments apps:view does not cover, and only for callers holding a member view scope.
   */
  async visibilities(
    scopes: readonly string[],
    entries: ReadonlyArray<{ app: AppRow; envs: readonly AppEnvironmentRow[] }>
  ): Promise<Map<string, AppVisibility>> {
    const scoped = entries.map(({ app, envs }) => {
      const ids = envs.map((env) => env.id);
      const viewIds = new Set(visibleEnvironmentIds(scopes, app.id, ids));
      return {
        app,
        ids,
        viewIds,
        full: viewIds.size > 0 || hasAppWideScope(scopes, APP_VIEW_SCOPE, app.id),
        rest: ids.filter((id) => !viewIds.has(id)),
      };
    });
    const restIds = scoped.flatMap((entry) => entry.rest);
    const memberEnvIds = new Set(
      restIds.length > 0 && hasAnyAppMemberViewScope(scopes)
        ? (await this.members.listVisibleMembers(scopes, restIds)).map((member) => member.environmentId)
        : []
    );
    // An environment the caller has grants in (its placement folders) stays visible while still empty.
    for (const id of await environmentsWithPlaceGrants(this.folders, scopes, restIds)) memberEnvIds.add(id);
    const result = new Map<string, AppVisibility>();
    for (const entry of scoped) {
      const memberEnvironmentIds = entry.rest.filter((id) => memberEnvIds.has(id));
      if (!entry.full && memberEnvironmentIds.length === 0) continue;
      result.set(entry.app.id, {
        access: entry.full ? 'full' : 'members',
        environmentIds: entry.ids.filter((id) => entry.viewIds.has(id) || memberEnvIds.has(id)),
        memberEnvironmentIds,
      });
    }
    return result;
  }

  /**
   * Whether the caller sees at least one app only through its members (no apps:view or apps:create anywhere): the
   * Apps section is shown for it then.
   */
  async hasAppsByMembers(scopes: readonly string[]): Promise<boolean> {
    if (!hasAnyAppMemberViewScope(scopes)) return false;
    const envRows = await this.db.select({ id: appEnvironments.id }).from(appEnvironments);
    if (envRows.length === 0) return false;
    const envIds = envRows.map((row) => row.id);
    if ((await this.members.listVisibleMembers(scopes, envIds)).length > 0) return true;
    return (await environmentsWithPlaceGrants(this.folders, scopes, envIds)).size > 0;
  }

  async findApp(idOrSlug: string, db: DrizzleExecutor = this.db): Promise<AppRow | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
    const [row] = await db
      .select()
      .from(apps)
      .where(isUuid ? or(eq(apps.id, idOrSlug), eq(apps.slug, idOrSlug)) : eq(apps.slug, idOrSlug))
      .limit(1);
    return row ?? null;
  }

  async environmentsOf(appId: string, db: DrizzleExecutor = this.db): Promise<AppEnvironmentRow[]> {
    return db
      .select()
      .from(appEnvironments)
      .where(eq(appEnvironments.appId, appId))
      .orderBy(asc(appEnvironments.sortOrder), asc(appEnvironments.createdAt));
  }

  async getEnvironment(appId: string, environmentId: string): Promise<AppEnvironmentRow> {
    const [env] = await this.db
      .select()
      .from(appEnvironments)
      .where(and(eq(appEnvironments.appId, appId), eq(appEnvironments.id, environmentId)))
      .limit(1);
    if (!env) throw new AppError(404, 'APP_ENVIRONMENT_NOT_FOUND', 'Environment not found');
    return env;
  }

  /** The app and environment of an environment id (for env-only callers). */
  async environmentById(environmentId: string): Promise<{ app: AppRow; env: AppEnvironmentRow } | null> {
    const [env] = await this.db.select().from(appEnvironments).where(eq(appEnvironments.id, environmentId)).limit(1);
    if (!env) return null;
    const app = await this.findApp(env.appId);
    return app ? { app, env } : null;
  }

  async list(scopes: readonly string[]) {
    const appRows = await this.db.select().from(apps).orderBy(asc(apps.name));
    if (appRows.length === 0) return [];
    const envRows = await this.db
      .select()
      .from(appEnvironments)
      .where(
        inArray(
          appEnvironments.appId,
          appRows.map((app) => app.id)
        )
      )
      .orderBy(asc(appEnvironments.sortOrder), asc(appEnvironments.createdAt));
    const envsByApp = new Map<string, AppEnvironmentRow[]>();
    for (const env of envRows) envsByApp.set(env.appId, [...(envsByApp.get(env.appId) ?? []), env]);

    const visibilities = await this.visibilities(
      scopes,
      appRows.map((app) => ({ app, envs: envsByApp.get(app.id) ?? [] }))
    );
    const visible = appRows.flatMap((app) => {
      const visibility = visibilities.get(app.id);
      if (!visibility) return [];
      const envs = (envsByApp.get(app.id) ?? []).filter((env) => visibility.environmentIds.includes(env.id));
      return [{ app, envs, access: visibility.access }];
    });
    const allEnvIds = visible.flatMap(({ envs }) => envs.map((env) => env.id));
    const [health, incidents] = await Promise.all([
      this.summarize(scopes, allEnvIds),
      this.incidentSummaries(allEnvIds),
    ]);
    return visible.map(({ app, envs, access }) => {
      const production = envs.find((env) => env.isProduction) ?? null;
      const summary = (production && health.get(production.id)) || DEFAULT_HEALTH;
      return {
        id: app.id,
        slug: app.slug,
        name: app.name,
        description: app.description,
        logoUrl: app.logoUrl,
        /** Folder of the Apps list (null at the top level) and the position in it. */
        folderId: app.folderId,
        sortOrder: app.sortOrder,
        /** `members`: visible only through members the caller can view; everything shown is computed from them. */
        access,
        environments: envs.map((env) => ({
          id: env.id,
          slug: env.slug,
          name: env.name,
          isProduction: env.isProduction,
          health: (health.get(env.id) ?? DEFAULT_HEALTH).health,
        })),
        health: summary.health,
        incident: appIncidentState(
          envs.map((env) => env.id),
          incidents
        ),
        cpuPercent: summary.cpuPercent,
        memoryBytes: summary.memoryBytes,
        running: summary.running,
        failing: summary.failing,
        degraded: summary.degraded,
        stopped: summary.stopped,
        warnings: summary.warnings,
      };
    });
  }

  async get(scopes: readonly string[], idOrSlug: string) {
    const { app, envs, ...visibility } = await this.resolveVisible(scopes, idOrSlug);
    return this.detail(scopes, app, envs, visibility);
  }

  /**
   * The app detail for the caller. Environments seen only through members (`access: members`) carry what is computed
   * from those members (counts, health, incident items); their environment settings (allowed nodes, maintenance
   * state, root folders of a members-only app) stay with apps:view.
   */
  async detail(scopes: readonly string[], app: AppRow, allEnvs: AppEnvironmentRow[], known?: AppVisibility) {
    const visibility = known ?? (await this.visibilities(scopes, [{ app, envs: allEnvs }])).get(app.id);
    const envIds = visibility?.environmentIds ?? [];
    const memberEnvIds = new Set(visibility?.memberEnvironmentIds ?? []);
    const access = visibility?.access ?? 'full';
    const envs = allEnvs.filter((env) => envIds.includes(env.id));
    const fullEnvs = envs.filter((env) => !memberEnvIds.has(env.id));
    const allMembers = await this.members.listMembers(envIds);
    const visibleMembers = allMembers.filter((member) => canViewMember(scopes, member));
    const counts = new Map(envIds.map((id) => [id, emptyMemberCounts()]));
    for (const member of visibleMembers) {
      const entry = counts.get(member.environmentId);
      if (entry) entry[member.type] += 1;
    }
    // Types with members the caller cannot view, for apps:view environments only: a members-only view learns nothing
    // about what it does not see.
    const hiddenTypes = new Map<string, Set<AppMemberType>>();
    for (const member of allMembers) {
      if (memberEnvIds.has(member.environmentId) || canViewMember(scopes, member)) continue;
      hiddenTypes.set(member.environmentId, (hiddenTypes.get(member.environmentId) ?? new Set()).add(member.type));
    }
    const [roots, folders, nodes, health, maintenance, incidents] = await Promise.all([
      access === 'full' ? this.folders.appRootFolders(app.id) : Promise.resolve(NO_FOLDERS),
      this.folders.envFolders(envIds),
      this.allowedNodes(envs.map((env) => env.id)),
      this.summarize(scopes, envIds),
      this.maintenance?.environmentMaintenance(app, fullEnvs) ??
        Promise.resolve(new Map<string, Record<string, unknown>>()),
      this.incidentSummaries(envIds, memberKeysByEnvironment(visibleMembers, [...memberEnvIds])),
    ]);
    // What the caller may create in each environment; an environment seen through members shows its allowed nodes
    // only when the caller may create there (the create dialogs place on them).
    const createAccess = new Map(
      envs.map((env) => [env.id, environmentCreateAccess(scopes, folders.get(env.id), nodes.get(env.id) ?? [])])
    );
    const showsNodes = (envId: string) =>
      !memberEnvIds.has(envId) || Object.values(createAccess.get(envId) ?? {}).some(Boolean);
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      description: app.description,
      logoUrl: app.logoUrl,
      folderId: app.folderId,
      /**
       * `full`: apps:view on the app or an environment. `members`: visible only through members the caller can view;
       * app-level blocks (settings, variables, nodes, maintenance, promote) need apps:view and are left out.
       */
      access,
      maintenanceOverride: app.maintenanceOverride,
      maintenanceOverrideAt: app.maintenanceOverrideAt,
      /** Domains every environment may use (joined with each environment's own list); empty: no restriction. */
      domainPatterns: access === 'full' ? app.domainPatterns : [],
      incident: appIncidentState(envIds, incidents),
      /** App-root folder per family: a grant there covers every environment, present and future. */
      rootFolderIds: roots,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      environments: envs.map((env) =>
        this.envDetail(env, {
          access: memberEnvIds.has(env.id) ? 'members' : 'full',
          folders: folders.get(env.id),
          nodeIds: showsNodes(env.id) ? (nodes.get(env.id) ?? []) : [],
          counts: counts.get(env.id) ?? emptyMemberCounts(),
          hiddenTypes: [...(hiddenTypes.get(env.id) ?? [])].sort(),
          health: health.get(env.id) ?? DEFAULT_HEALTH,
          maintenance: maintenance.get(env.id),
          incidents: incidents.get(env.id) ?? [],
        })
      ),
      permissions: {
        edit: hasAppWideScope(scopes, APP_EDIT_SCOPE, app.id),
        delete: hasAppWideScope(scopes, APP_DELETE_SCOPE, app.id),
        operate: hasAppWideScope(scopes, APP_OPERATE_SCOPE, app.id),
        envManage: Object.fromEntries(
          envs.map((env) => [env.id, hasAppScope(scopes, APP_ENV_MANAGE_SCOPE, app.id, env.id)])
        ),
        promote: Object.fromEntries(
          envs.map((env) => [env.id, hasAppScope(scopes, APP_PROMOTE_SCOPE, app.id, env.id)])
        ),
        operateEnv: Object.fromEntries(
          envs.map((env) => [env.id, hasAppScope(scopes, APP_OPERATE_SCOPE, app.id, env.id)])
        ),
        /** Per environment and family: may create a resource of that family there. */
        create: Object.fromEntries(envs.map((env) => [env.id, createAccess.get(env.id) ?? {}])),
      },
    };
  }

  private envDetail(
    env: AppEnvironmentRow,
    extra: {
      access: AppVisibility['access'];
      folders?: Record<AppFamily, string | null>;
      nodeIds: string[];
      counts: AppMemberCounts;
      hiddenTypes: AppMemberType[];
      health: EnvironmentHealthSummary;
      maintenance?: Record<string, unknown>;
      incidents?: unknown[];
    }
  ) {
    return {
      id: env.id,
      slug: env.slug,
      name: env.name,
      isProduction: env.isProduction,
      /** `members`: seen only through members the caller can view (environment settings need apps:view). */
      access: extra.access,
      maintenanceEnabled: env.maintenanceEnabled,
      maintenanceStartedAt: env.maintenanceStartedAt,
      health: extra.health.health,
      memberCounts: extra.counts,
      /** Member types with members the caller cannot view (apps:view environments; empty when seen through members). */
      hiddenMemberTypes: extra.hiddenTypes,
      placementFolderIds: extra.folders ?? NO_FOLDERS,
      allowedNodeIds: extra.nodeIds,
      /** The environment's own allowed domains (the app-wide list applies too); an environment setting. */
      domainPatterns: extra.access === 'full' ? env.domainPatterns : [],
      maintenance: extra.maintenance ?? null,
      /** Open shutdown / kill switch incidents of the environment, with their items. */
      incidents: extra.incidents ?? [],
    };
  }

  /** Members of the visible environments (or one), filtered to what the caller may view. */
  async listMembers(scopes: readonly string[], appId: string, environmentId?: string) {
    const { environmentIds } = await this.resolveVisible(scopes, appId);
    let envIds = environmentIds;
    if (environmentId) {
      if (!envIds.includes(environmentId))
        throw new AppError(404, 'APP_ENVIRONMENT_NOT_FOUND', 'Environment not found');
      envIds = [environmentId];
    }
    return (await this.members.listVisibleMembers(scopes, envIds)).map(
      ({ scopeResourceId: _scope, managedId: _managed, ...member }) => member
    );
  }

  /** Members of these environments the caller may view. */
  visibleMembers(scopes: readonly string[], environmentIds: readonly string[]): Promise<AppMember[]> {
    return this.members.listVisibleMembers(scopes, environmentIds);
  }

  async allowedNodes(environmentIds: readonly string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>(environmentIds.map((id) => [id, []]));
    if (environmentIds.length === 0) return result;
    const rows = await this.db
      .select({ environmentId: appEnvironmentNodes.environmentId, nodeId: appEnvironmentNodes.nodeId })
      .from(appEnvironmentNodes)
      .where(inArray(appEnvironmentNodes.environmentId, [...environmentIds]));
    for (const row of rows) result.get(row.environmentId)?.push(row.nodeId);
    return result;
  }

  private async incidentSummaries(
    environmentIds: readonly string[],
    memberKeys?: ReadonlyMap<string, ReadonlySet<string>>
  ) {
    if (!this.incidents?.summaries || environmentIds.length === 0) {
      return new Map<string, Array<{ kind: 'shutdown' | 'isolation' }>>();
    }
    return this.incidents.summaries(environmentIds, memberKeys);
  }

  private async summarize(scopes: readonly string[], environmentIds: readonly string[]) {
    if (!this.health || environmentIds.length === 0) return new Map<string, EnvironmentHealthSummary>();
    return this.health.summarizeEnvironments(scopes, environmentIds);
  }

  // ── App changes ────────────────────────────────────────────────────

  async create(actor: AppActor, input: CreateAppInput) {
    // Broadly, or as a grant on the Apps list folder the app is created in.
    if (!hasScopeForCreation(actor.scopes, APP_CREATE_SCOPE, input.folderId ?? null)) {
      throw new AppError(403, 'FORBIDDEN', `Missing ${APP_CREATE_SCOPE}`, { requiredScope: APP_CREATE_SCOPE });
    }
    if (input.folderId) {
      const [folder] = await this.db
        .select({ id: appFolders.id })
        .from(appFolders)
        .where(eq(appFolders.id, input.folderId))
        .limit(1);
      if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
    }
    const name = input.name.trim();
    let created: { app: AppRow; env: AppEnvironmentRow };
    try {
      created = await this.db.transaction(async (tx) => {
        await this.folders.lockFamilies(tx);
        const base = slugify(name, 'app');
        const taken = await tx
          .select({ slug: apps.slug })
          .from(apps)
          .where(or(eq(apps.slug, base), sql`${apps.slug} like ${`${base}-%`}`));
        const [app] = await tx
          .insert(apps)
          .values({
            name,
            slug: uniqueSlug(base, new Set(taken.map((row) => row.slug))),
            description: input.description || null,
            folderId: input.folderId ?? null,
            createdById: actor.userId,
          })
          .returning();
        const [env] = await tx
          .insert(appEnvironments)
          .values({
            appId: app.id,
            name: 'production',
            slug: 'production',
            isProduction: true,
            sortOrder: 0,
            createdById: actor.userId,
          })
          .returning();
        await this.folders.createAppFolders(tx, app.id, name, actor.userId);
        await this.folders.createEnvFolders(tx, app.id, env.id, env.name, actor.userId);
        return { app, env };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'apps_name_lower_unique')) {
        throw new AppError(409, 'APP_NAME_TAKEN', `An app named "${name}" already exists`);
      }
      throw error;
    }
    await grantCreatedResourcePermissions(actor.userId, 'apps', created.app.id, {
      folderId: input.folderId ?? null,
      nodeId: null,
    });
    await this.auditService.log({
      userId: actor.userId,
      action: 'app.create',
      resourceType: 'app',
      resourceId: created.app.id,
      details: { name, slug: created.app.slug, environmentId: created.env.id },
    });
    this.publish(created.app.id, 'created');
    // The creator's grants were just extended; read with the scopes they will have.
    const scopes = hasScope(actor.scopes, APP_VIEW_SCOPE)
      ? actor.scopes
      : [...actor.scopes, `${APP_VIEW_SCOPE}:${created.app.id}`, `${APP_EDIT_SCOPE}:${created.app.id}`];
    return this.detail(scopes, created.app, [created.env]);
  }

  async update(actor: AppActor, appId: string, input: UpdateAppInput) {
    const { app } = await this.resolveVisible(actor.scopes, appId);
    if (input.name !== undefined || input.description !== undefined) {
      assertAppWideScope(actor.scopes, APP_EDIT_SCOPE, app.id);
    }
    if (input.maintenanceOverride !== undefined) assertAppWideScope(actor.scopes, APP_OPERATE_SCOPE, app.id);
    if (input.domainPatterns !== undefined) assertAppWideScope(actor.scopes, APP_EDIT_SCOPE, app.id);
    const name = input.name?.trim();
    const changes: Partial<typeof apps.$inferInsert> = { updatedAt: new Date() };
    if (name !== undefined && name !== app.name) changes.name = name;
    const description = input.description === undefined ? undefined : input.description || null;
    const descriptionChanged = description !== undefined && description !== app.description;
    if (descriptionChanged) changes.description = description;
    const domainPatternsChanged =
      input.domainPatterns !== undefined && !samePatterns(input.domainPatterns, app.domainPatterns);
    if (domainPatternsChanged) changes.domainPatterns = input.domainPatterns;
    if (input.maintenanceOverride !== undefined && input.maintenanceOverride !== app.maintenanceOverride) {
      changes.maintenanceOverride = input.maintenanceOverride;
      changes.maintenanceOverrideAt = input.maintenanceOverride ? new Date() : null;
      changes.maintenanceOverrideBy = input.maintenanceOverride ? actor.userId : null;
    }
    try {
      await this.db.transaction(async (tx) => {
        await tx.update(apps).set(changes).where(eq(apps.id, app.id));
        if (changes.name) await this.folders.renameAppFolders(tx, app.id, changes.name);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'apps_name_lower_unique')) {
        throw new AppError(409, 'APP_NAME_TAKEN', `An app named "${name}" already exists`);
      }
      throw error;
    }
    if (changes.name) {
      await this.auditService.log({
        userId: actor.userId,
        action: 'app.update',
        resourceType: 'app',
        resourceId: app.id,
        details: { oldName: app.name, newName: changes.name },
      });
    }
    if (descriptionChanged) {
      await this.auditService.log({
        userId: actor.userId,
        action: 'app.description_update',
        resourceType: 'app',
        resourceId: app.id,
        details: { name: changes.name ?? app.name, cleared: description === null },
      });
    }
    if (domainPatternsChanged) {
      await this.auditService.log({
        userId: actor.userId,
        action: 'app.domain_patterns_update',
        resourceType: 'app',
        resourceId: app.id,
        details: { name: changes.name ?? app.name, from: app.domainPatterns, to: input.domainPatterns },
      });
    }
    if (changes.maintenanceOverride !== undefined) {
      await this.auditService.log({
        userId: actor.userId,
        action: changes.maintenanceOverride ? 'app.maintenance.override_on' : 'app.maintenance.override_off',
        resourceType: 'app',
        resourceId: app.id,
        details: { name: app.name },
      });
      await this.maintenance?.afterAppChange(app.id);
    }
    this.publish(app.id, 'updated');
    return this.get(actor.scopes, app.id);
  }

  async delete(actor: AppActor, appId: string) {
    const { app } = await this.resolveVisible(actor.scopes, appId);
    assertAppWideScope(actor.scopes, APP_DELETE_SCOPE, app.id);
    await this.incidents?.assertNoActiveIncident(app.id);
    const routeIds = (await this.maintenance?.memberRouteIds(app.id)) ?? [];
    const scopeChanges = await this.db.transaction(async (tx) => {
      await this.folders.lockFamilies(tx);
      await this.folders.deleteAppFolders(tx, app.id);
      await tx.delete(apps).where(eq(apps.id, app.id));
      return removeDanglingResourceScopes(tx);
    });
    await announceResourceScopeChanges(scopeChanges);
    await this.auditService.log({
      userId: actor.userId,
      action: 'app.delete',
      resourceType: 'app',
      resourceId: app.id,
      details: { name: app.name, slug: app.slug },
    });
    await this.maintenance?.afterAppChange(app.id, routeIds);
    await this.removeLogoFile(app.id, app.logoUrl);
    this.publish(app.id, 'deleted');
  }

  // ── Logo ───────────────────────────────────────────────────────────

  /** Store a new logo (PNG, JPEG or WebP, up to 1 MiB, cropped square by the client) and drop the replaced one. */
  async uploadLogo(actor: AppActor, appId: string, file: File) {
    const { app } = await this.resolveVisible(actor.scopes, appId);
    assertAppWideScope(actor.scopes, APP_EDIT_SCOPE, app.id);
    if (!this.logoStorage) throw new AppError(503, 'APP_LOGO_STORAGE_UNAVAILABLE', 'Logo storage is unavailable');
    const logoUrl = await this.logoStorage.store(file, 'Logo');
    try {
      await this.db.update(apps).set({ logoUrl, updatedAt: new Date() }).where(eq(apps.id, app.id));
    } catch (error) {
      await this.logoStorage.removeByUrl(logoUrl).catch(() => {});
      throw error;
    }
    await this.removeLogoFile(app.id, app.logoUrl);
    await this.auditService.log({
      userId: actor.userId,
      action: 'app.logo_update',
      resourceType: 'app',
      resourceId: app.id,
      details: { name: app.name, sizeBytes: file.size, mediaType: file.type },
    });
    this.publish(app.id, 'updated');
    return this.get(actor.scopes, app.id);
  }

  async removeLogo(actor: AppActor, appId: string) {
    const { app } = await this.resolveVisible(actor.scopes, appId);
    assertAppWideScope(actor.scopes, APP_EDIT_SCOPE, app.id);
    if (app.logoUrl) {
      await this.db.update(apps).set({ logoUrl: null, updatedAt: new Date() }).where(eq(apps.id, app.id));
      await this.removeLogoFile(app.id, app.logoUrl);
      await this.auditService.log({
        userId: actor.userId,
        action: 'app.logo_remove',
        resourceType: 'app',
        resourceId: app.id,
        details: { name: app.name },
      });
      this.publish(app.id, 'updated');
    }
    return this.get(actor.scopes, app.id);
  }

  private async removeLogoFile(appId: string, logoUrl: string | null) {
    if (!logoUrl) return;
    await this.logoStorage?.removeByUrl(logoUrl).catch((error) => {
      logger.warn('Failed to remove an app logo file', { appId, error });
    });
  }

  // ── Environment changes ────────────────────────────────────────────

  async createEnvironment(actor: AppActor, appId: string, input: CreateAppEnvironmentInput) {
    const { app } = await this.resolveVisible(actor.scopes, appId);
    assertAppWideScope(actor.scopes, APP_EDIT_SCOPE, app.id);
    const name = input.name.trim();
    let env: AppEnvironmentRow;
    try {
      env = await this.db.transaction(async (tx) => {
        await this.folders.lockFamilies(tx);
        const existing = await tx
          .select({ slug: appEnvironments.slug })
          .from(appEnvironments)
          .where(eq(appEnvironments.appId, app.id));
        const [{ order }] = await tx
          .select({ order: max(appEnvironments.sortOrder) })
          .from(appEnvironments)
          .where(eq(appEnvironments.appId, app.id));
        const [row] = await tx
          .insert(appEnvironments)
          .values({
            appId: app.id,
            name,
            slug: uniqueSlug(slugify(name, 'env'), new Set(existing.map((item) => item.slug))),
            sortOrder: (order ?? -1) + 1,
            createdById: actor.userId,
          })
          .returning();
        await this.folders.createEnvFolders(tx, app.id, row.id, row.name, actor.userId);
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'app_environments_name_lower_unique')) {
        throw new AppError(409, 'APP_ENV_NAME_TAKEN', `An environment named "${name}" already exists in this app`);
      }
      throw error;
    }
    await this.auditService.log({
      userId: actor.userId,
      action: 'app.environment.create',
      resourceType: 'app_environment',
      resourceId: env.id,
      details: { appId: app.id, appName: app.name, name: env.name },
    });
    this.publish(app.id, 'environment_created');
    return this.environmentDetail(actor.scopes, app.id, env.id);
  }

  async environmentDetail(scopes: readonly string[], appId: string, environmentId: string) {
    const { app, envs, ...visibility } = await this.resolveVisible(scopes, appId);
    const env = envs.find((item) => item.id === environmentId);
    if (!env || !visibility.environmentIds.includes(env.id)) {
      throw new AppError(404, 'APP_ENVIRONMENT_NOT_FOUND', 'Environment not found');
    }
    const detail = await this.detail(scopes, app, [env], {
      access: visibility.access,
      environmentIds: [env.id],
      memberEnvironmentIds: visibility.memberEnvironmentIds.filter((id) => id === env.id),
    });
    return detail.environments[0];
  }

  async updateEnvironment(actor: AppActor, appId: string, environmentId: string, input: UpdateAppEnvironmentInput) {
    const { app } = await this.resolveVisible(actor.scopes, appId);
    const env = await this.getEnvironment(app.id, environmentId);
    if (input.name !== undefined || input.isProduction !== undefined) {
      assertAppWideScope(actor.scopes, APP_EDIT_SCOPE, app.id);
    }
    if (input.maintenanceEnabled !== undefined || input.domainPatterns !== undefined) {
      assertAppScope(actor.scopes, APP_ENV_MANAGE_SCOPE, app.id, env.id);
    }
    const name = input.name?.trim();
    const renamed = name !== undefined && name !== env.name;
    const markProduction = input.isProduction === true && !env.isProduction;
    const maintenanceChanged =
      input.maintenanceEnabled !== undefined && input.maintenanceEnabled !== env.maintenanceEnabled;
    const domainPatternsChanged =
      input.domainPatterns !== undefined && !samePatterns(input.domainPatterns, env.domainPatterns);
    try {
      await this.db.transaction(async (tx) => {
        if (renamed) {
          const existing = await tx
            .select({ id: appEnvironments.id, slug: appEnvironments.slug })
            .from(appEnvironments)
            .where(eq(appEnvironments.appId, app.id));
          const slug = uniqueSlug(
            slugify(name, 'env'),
            new Set(existing.filter((item) => item.id !== env.id).map((item) => item.slug))
          );
          await tx
            .update(appEnvironments)
            .set({ name, slug, updatedAt: new Date() })
            .where(eq(appEnvironments.id, env.id));
          await this.folders.renameEnvFolders(tx, env.id, name);
        }
        if (markProduction) {
          // The partial unique index allows one marker: clear it first, then set it, in one transaction.
          await tx
            .update(appEnvironments)
            .set({ isProduction: false, updatedAt: new Date() })
            .where(and(eq(appEnvironments.appId, app.id), eq(appEnvironments.isProduction, true)));
          await tx
            .update(appEnvironments)
            .set({ isProduction: true, updatedAt: new Date() })
            .where(eq(appEnvironments.id, env.id));
        }
        if (maintenanceChanged) {
          await tx
            .update(appEnvironments)
            .set({
              maintenanceEnabled: input.maintenanceEnabled,
              maintenanceStartedAt: input.maintenanceEnabled ? new Date() : null,
              updatedAt: new Date(),
            })
            .where(eq(appEnvironments.id, env.id));
        }
        if (domainPatternsChanged) {
          await tx
            .update(appEnvironments)
            .set({ domainPatterns: input.domainPatterns, updatedAt: new Date() })
            .where(eq(appEnvironments.id, env.id));
        }
      });
    } catch (error) {
      if (isUniqueViolation(error, 'app_environments_name_lower_unique')) {
        throw new AppError(409, 'APP_ENV_NAME_TAKEN', `An environment named "${name}" already exists in this app`);
      }
      throw error;
    }
    const audit = (action: string, details: Record<string, unknown>) =>
      this.auditService.log({
        userId: actor.userId,
        action,
        resourceType: 'app_environment',
        resourceId: env.id,
        details: { appId: app.id, appName: app.name, ...details },
      });
    if (renamed) await audit('app.environment.rename', { oldName: env.name, newName: name });
    if (markProduction) await audit('app.environment.mark_production', { name: name ?? env.name });
    if (domainPatternsChanged) {
      await audit('app.environment.domain_patterns_update', {
        name: name ?? env.name,
        from: env.domainPatterns,
        to: input.domainPatterns,
      });
    }
    if (maintenanceChanged) {
      await audit(input.maintenanceEnabled ? 'app.environment.maintenance_on' : 'app.environment.maintenance_off', {
        name: name ?? env.name,
      });
      await this.maintenance?.afterAppChange(app.id);
    }
    this.publish(app.id, 'environment_updated');
    return this.environmentDetail(actor.scopes, app.id, env.id);
  }

  async deleteEnvironment(actor: AppActor, appId: string, environmentId: string) {
    const { app } = await this.resolveVisible(actor.scopes, appId);
    assertAppWideScope(actor.scopes, APP_EDIT_SCOPE, app.id);
    const env = await this.getEnvironment(app.id, environmentId);
    if (env.isProduction) {
      throw new AppError(
        409,
        'APP_ENV_PRODUCTION',
        'The Production environment cannot be deleted. Mark another environment as production first'
      );
    }
    await this.incidents?.assertNoActiveIncident(app.id, env.id);
    const routeIds = (await this.maintenance?.memberRouteIds(app.id, env.id)) ?? [];
    const scopeChanges = await this.db.transaction(async (tx) => {
      await this.folders.lockFamilies(tx);
      await this.folders.deleteEnvFolders(tx, env.id);
      await tx.delete(appEnvironments).where(eq(appEnvironments.id, env.id));
      return removeDanglingResourceScopes(tx);
    });
    await announceResourceScopeChanges(scopeChanges);
    await this.auditService.log({
      userId: actor.userId,
      action: 'app.environment.delete',
      resourceType: 'app_environment',
      resourceId: env.id,
      details: { appId: app.id, appName: app.name, name: env.name },
    });
    await this.maintenance?.afterAppChange(app.id, routeIds);
    this.publish(app.id, 'environment_deleted');
  }
}
