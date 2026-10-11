import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import {
  type AppIncident,
  type AppIncidentItem,
  type AppIncidentItemStatus,
  type AppIncidentKind,
  type AppIncidentRowState,
  appIncidentItems,
  appIncidents,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

/** Incident states during which the incident is in effect (changes applied or being applied/restored). */
export const OPEN_INCIDENT_STATES: readonly AppIncidentRowState[] = ['applying', 'active', 'releasing'];
/** Item statuses whose change is (or should be) in effect: everything not yet restored or gone. */
export const ITEM_IN_EFFECT_STATUSES: readonly AppIncidentItemStatus[] = [
  'pending',
  'applied',
  'failed',
  'restore_failed',
];

/** Item kinds. Route overlays carry `{routeId, derived}`; the rest name the resource they changed. */
export type AppIncidentItemKind =
  | 'route_overlay'
  | 'route_withdraw'
  | 'container_link'
  | 'database_binding'
  | 'storage_binding'
  | 'secure_link'
  | 'database_publication'
  | 'storage_publication'
  | 'container_network'
  | 'container_stop'
  | 'deployment_stop'
  | 'compose_stop'
  | 'database_pause'
  | 'storage_pause';

export interface NewIncidentItem {
  itemKind: AppIncidentItemKind;
  itemKey: string;
  phase: number;
  ref: Record<string, unknown>;
  priorState?: Record<string, unknown> | null;
}

export interface IncidentWithItems extends AppIncident {
  items: AppIncidentItem[];
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const cause = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return (
    (cause?.code ?? cause?.cause?.code) === '23505' && (cause?.constraint ?? cause?.cause?.constraint) === constraint
  );
}

/** Storage of app incidents (shutdown / kill switch) and the items each changed with their prior state. */
export class AppIncidentsRepo {
  constructor(private readonly db: DrizzleClient) {}

  async create(
    input: { batchId: string; appId: string; environmentId: string; kind: AppIncidentKind; startedById: string | null },
    db: DrizzleExecutor = this.db
  ): Promise<AppIncident> {
    try {
      const [row] = await db
        .insert(appIncidents)
        .values({ ...input, state: 'applying' })
        .returning();
      return row;
    } catch (error) {
      if (isUniqueViolation(error, 'app_incidents_env_kind_open_unique')) {
        throw new AppError(
          409,
          'APP_INCIDENT_ACTIVE',
          input.kind === 'isolation' ? 'This environment is already isolated' : 'This environment is already shut down'
        );
      }
      throw error;
    }
  }

  async get(id: string): Promise<AppIncident | null> {
    const [row] = await this.db.select().from(appIncidents).where(eq(appIncidents.id, id)).limit(1);
    return row ?? null;
  }

  async setState(id: string, state: AppIncidentRowState, patch: Partial<typeof appIncidents.$inferInsert> = {}) {
    const [row] = await this.db
      .update(appIncidents)
      .set({ ...patch, state, updatedAt: new Date() })
      .where(eq(appIncidents.id, id))
      .returning();
    return row ?? null;
  }

  async setLastError(id: string, lastError: string | null) {
    await this.db.update(appIncidents).set({ lastError, updatedAt: new Date() }).where(eq(appIncidents.id, id));
  }

  /** Open incidents (applying, active or releasing), of one app or every app. */
  async open(filter: { appId?: string; environmentIds?: readonly string[]; kind?: AppIncidentKind } = {}) {
    const conditions = [inArray(appIncidents.state, [...OPEN_INCIDENT_STATES])];
    if (filter.appId) conditions.push(eq(appIncidents.appId, filter.appId));
    if (filter.environmentIds) {
      if (filter.environmentIds.length === 0) return [];
      conditions.push(inArray(appIncidents.environmentId, [...filter.environmentIds]));
    }
    if (filter.kind) conditions.push(eq(appIncidents.kind, filter.kind));
    return this.db
      .select()
      .from(appIncidents)
      .where(and(...conditions))
      .orderBy(asc(appIncidents.startedAt));
  }

  async openFor(environmentId: string, kind: AppIncidentKind): Promise<AppIncident | null> {
    const [row] = await this.open({ environmentIds: [environmentId], kind });
    return row ?? null;
  }

  /** Incidents of an app, open ones first, then the most recent released/failed ones. */
  async listForApp(appId: string, limit = 20): Promise<IncidentWithItems[]> {
    const rows = await this.db
      .select()
      .from(appIncidents)
      .where(eq(appIncidents.appId, appId))
      .orderBy(
        sql`case when ${appIncidents.state} in ('applying', 'active', 'releasing') then 0 else 1 end`,
        desc(appIncidents.startedAt)
      )
      .limit(limit);
    return this.withItems(rows);
  }

  async withItems(rows: AppIncident[]): Promise<IncidentWithItems[]> {
    if (rows.length === 0) return [];
    const items = await this.db
      .select()
      .from(appIncidentItems)
      .where(
        inArray(
          appIncidentItems.incidentId,
          rows.map((row) => row.id)
        )
      )
      .orderBy(asc(appIncidentItems.phase), asc(appIncidentItems.createdAt));
    return rows.map((row) => ({ ...row, items: items.filter((item) => item.incidentId === row.id) }));
  }

  /** Adds items (an item key already recorded for the incident is kept as it is). Returns the incident's items. */
  async addItems(incidentId: string, items: readonly NewIncidentItem[], db: DrizzleExecutor = this.db) {
    if (items.length > 0) {
      await db
        .insert(appIncidentItems)
        .values(
          items.map((item) => ({
            incidentId,
            itemKind: item.itemKind,
            itemKey: item.itemKey,
            phase: item.phase,
            ref: item.ref,
            priorState: item.priorState ?? null,
          }))
        )
        .onConflictDoNothing({ target: [appIncidentItems.incidentId, appIncidentItems.itemKey] });
    }
    return this.items(incidentId, db);
  }

  async items(incidentId: string, db: DrizzleExecutor = this.db): Promise<AppIncidentItem[]> {
    return db
      .select()
      .from(appIncidentItems)
      .where(eq(appIncidentItems.incidentId, incidentId))
      .orderBy(asc(appIncidentItems.phase), asc(appIncidentItems.createdAt));
  }

  async updateItem(id: string, patch: Partial<typeof appIncidentItems.$inferInsert>): Promise<void> {
    await this.db
      .update(appIncidentItems)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(appIncidentItems.id, id));
  }

  /**
   * Overlay modes incidents put on routes: an open isolation gives `lockdown`, an open shutdown `maintenance`
   * (lockdown wins). Only items still in effect count, so a restored item drops its route's overlay.
   */
  async routeOverlays(routeIds: readonly string[]): Promise<Map<string, 'maintenance' | 'lockdown'>> {
    const result = new Map<string, 'maintenance' | 'lockdown'>();
    if (routeIds.length === 0) return result;
    const rows = await this.db
      .select({ ref: appIncidentItems.ref, kind: appIncidents.kind })
      .from(appIncidentItems)
      .innerJoin(appIncidents, eq(appIncidents.id, appIncidentItems.incidentId))
      .where(
        and(
          eq(appIncidentItems.itemKind, 'route_overlay'),
          inArray(appIncidentItems.status, [...ITEM_IN_EFFECT_STATUSES]),
          inArray(appIncidents.state, [...OPEN_INCIDENT_STATES]),
          inArray(sql<string>`${appIncidentItems.ref}->>'routeId'`, [...routeIds])
        )
      );
    for (const row of rows) {
      const routeId = String(row.ref.routeId);
      const mode = row.kind === 'isolation' ? 'lockdown' : 'maintenance';
      if (result.get(routeId) !== 'lockdown') result.set(routeId, mode);
    }
    return result;
  }

  /** Route ids an incident (or every open incident) holds an overlay on (startup repair, recompute after release). */
  async overlayRouteIds(incidentId?: string): Promise<string[]> {
    const rows = await this.db
      .select({ routeId: sql<string>`${appIncidentItems.ref}->>'routeId'` })
      .from(appIncidentItems)
      .innerJoin(appIncidents, eq(appIncidents.id, appIncidentItems.incidentId))
      .where(
        and(
          eq(appIncidentItems.itemKind, 'route_overlay'),
          incidentId
            ? eq(appIncidentItems.incidentId, incidentId)
            : inArray(appIncidents.state, [...OPEN_INCIDENT_STATES])
        )
      );
    return [...new Set(rows.map((row) => row.routeId).filter(Boolean))];
  }

  /** Environments with an open isolation (members are frozen). */
  async isolatedEnvironmentIds(environmentIds?: readonly string[]): Promise<Set<string>> {
    const rows = await this.open({ environmentIds, kind: 'isolation' });
    return new Set(rows.map((row) => row.environmentId));
  }

  /** The open incident holding an item of this kind and key, if any (resources an incident owns refuse edits). */
  async openItemFor(itemKind: AppIncidentItemKind, itemKey: string): Promise<AppIncidentItem | null> {
    const [row] = await this.db
      .select({ item: appIncidentItems })
      .from(appIncidentItems)
      .innerJoin(appIncidents, eq(appIncidents.id, appIncidentItems.incidentId))
      .where(
        and(
          eq(appIncidentItems.itemKind, itemKind),
          eq(appIncidentItems.itemKey, itemKey),
          inArray(appIncidentItems.status, [...ITEM_IN_EFFECT_STATUSES]),
          inArray(appIncidents.state, [...OPEN_INCIDENT_STATES])
        )
      )
      .limit(1);
    return row?.item ?? null;
  }
}
