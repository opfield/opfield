import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { APP_FAMILIES, APP_FAMILY_TABLES, type AppFamily, familyRecord } from './app-families.js';

/** A hidden folder: an app root (`environmentId` null) or an environment folder. */
export interface AppFolderRef {
  family: AppFamily;
  folderId: string;
  appId: string;
  environmentId: string | null;
}

const INDEX_TTL_MS = 10_000;

function familyWhere(family: AppFamily, ...conditions: any[]) {
  const { table, dockerResourceType } = APP_FAMILY_TABLES[family];
  return and(dockerResourceType ? eq(table.resourceType, dockerResourceType) : undefined, ...conditions);
}

/**
 * The hidden folders of apps: one root per family and app, one folder per family and environment below it. Members
 * of an environment sit in its folders, so membership, moves and folder grants are the folder mechanics of each
 * family. Only this service creates, renames and deletes these rows, under the advisory locks the folder services
 * take, so a concurrent folder move never sees a half-built app.
 */
export class AppFolderService {
  private index: { at: number; byFolder: Map<string, AppFolderRef> } | null = null;

  constructor(private readonly db: DrizzleClient) {}

  /** Take every family's tree lock, always in the same order (no deadlock with a second app change). */
  async lockFamilies(tx: DrizzleExecutor): Promise<void> {
    const keys = [...new Set(APP_FAMILIES.map((family) => APP_FAMILY_TABLES[family].lockKey))].sort();
    for (const key of keys) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
  }

  invalidate(): void {
    this.index = null;
  }

  /** One root folder per family, named like the app. Call inside the app-create transaction after lockFamilies. */
  async createAppFolders(tx: DrizzleExecutor, appId: string, appName: string, userId: string): Promise<void> {
    for (const family of APP_FAMILIES) {
      const { table, dockerResourceType } = APP_FAMILY_TABLES[family];
      await (tx as any).insert(table).values({
        name: appName,
        parentId: null,
        depth: 0,
        sortOrder: 0,
        appId,
        appEnvironmentId: null,
        createdById: userId,
        ...(dockerResourceType ? { resourceType: dockerResourceType } : {}),
      });
    }
    this.invalidate();
  }

  /** One folder per family under the app roots, named like the environment. */
  async createEnvFolders(
    tx: DrizzleExecutor,
    appId: string,
    environmentId: string,
    environmentName: string,
    userId: string
  ): Promise<void> {
    for (const family of APP_FAMILIES) {
      const { table, dockerResourceType } = APP_FAMILY_TABLES[family];
      const [root] = (await (tx as any)
        .select({ id: table.id })
        .from(table)
        .where(familyWhere(family, eq(table.appId, appId), isNull(table.appEnvironmentId)))
        .limit(1)) as Array<{ id: string }>;
      if (!root) throw new Error(`App ${appId} has no ${family} root folder`);
      await (tx as any).insert(table).values({
        name: environmentName,
        parentId: root.id,
        depth: 1,
        sortOrder: 0,
        appId,
        appEnvironmentId: environmentId,
        createdById: userId,
        ...(dockerResourceType ? { resourceType: dockerResourceType } : {}),
      });
    }
    this.invalidate();
  }

  async renameAppFolders(tx: DrizzleExecutor, appId: string, name: string): Promise<void> {
    for (const table of this.distinctTables()) {
      await (tx as any)
        .update(table)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(table.appId, appId), isNull(table.appEnvironmentId)));
    }
  }

  async renameEnvFolders(tx: DrizzleExecutor, environmentId: string, name: string): Promise<void> {
    for (const table of this.distinctTables()) {
      await (tx as any)
        .update(table)
        .set({ name, updatedAt: new Date() })
        .where(eq(table.appEnvironmentId, environmentId));
    }
  }

  /**
   * Delete an environment's folders. Members stay where they run and become ungrouped at the top level of their
   * lists (the resource and Docker placement foreign keys set the folder to null). The caller removes the grants that
   * named these folders (removeDanglingResourceScopes) in the same transaction.
   */
  async deleteEnvFolders(tx: DrizzleExecutor, environmentId: string): Promise<void> {
    for (const table of this.distinctTables()) {
      await (tx as any).delete(table).where(eq(table.appEnvironmentId, environmentId));
    }
    this.invalidate();
  }

  /** Delete every folder of an app (roots cascade to their environment folders). */
  async deleteAppFolders(tx: DrizzleExecutor, appId: string): Promise<void> {
    for (const table of this.distinctTables()) {
      await (tx as any).delete(table).where(and(eq(table.appId, appId), isNotNull(table.appEnvironmentId)));
      await (tx as any).delete(table).where(eq(table.appId, appId));
    }
    this.invalidate();
  }

  /** The environment folder of a family, or null when the environment has none (deleted). */
  async envFolderFor(family: AppFamily, environmentId: string, db: DrizzleExecutor = this.db): Promise<string | null> {
    const { table } = APP_FAMILY_TABLES[family];
    const [row] = (await (db as any)
      .select({ id: table.id })
      .from(table)
      .where(familyWhere(family, eq(table.appEnvironmentId, environmentId)))
      .limit(1)) as Array<{ id: string }>;
    return row?.id ?? null;
  }

  /** Environment folder ids of every family for the given environments: envId -> family -> folderId. */
  async envFolders(
    environmentIds: readonly string[],
    db: DrizzleExecutor = this.db
  ): Promise<Map<string, Record<AppFamily, string | null>>> {
    const result = new Map<string, Record<AppFamily, string | null>>();
    for (const id of environmentIds) {
      result.set(
        id,
        familyRecord(() => null)
      );
    }
    if (environmentIds.length === 0) return result;
    for (const family of APP_FAMILIES) {
      const { table } = APP_FAMILY_TABLES[family];
      const rows = (await (db as any)
        .select({ id: table.id, environmentId: table.appEnvironmentId })
        .from(table)
        .where(familyWhere(family, inArray(table.appEnvironmentId, [...environmentIds])))) as Array<{
        id: string;
        environmentId: string;
      }>;
      for (const row of rows) {
        const entry = result.get(row.environmentId);
        if (entry) entry[family] = row.id;
      }
    }
    return result;
  }

  /** App-root folder ids per family of an app. */
  async appRootFolders(appId: string, db: DrizzleExecutor = this.db): Promise<Record<AppFamily, string | null>> {
    const result = familyRecord<string | null>(() => null);
    for (const family of APP_FAMILIES) {
      const { table } = APP_FAMILY_TABLES[family];
      const [row] = (await (db as any)
        .select({ id: table.id })
        .from(table)
        .where(familyWhere(family, eq(table.appId, appId), isNull(table.appEnvironmentId)))
        .limit(1)) as Array<{ id: string }>;
      result[family] = row?.id ?? null;
    }
    return result;
  }

  /**
   * The hidden folder a folder id names in a family, read from the database (authoritative: used by guards and
   * moves). Null for a user folder, an unknown id or a folder of another family.
   */
  async resolveFolder(
    family: AppFamily,
    folderId: string | null | undefined,
    db: DrizzleExecutor = this.db
  ): Promise<AppFolderRef | null> {
    if (!folderId) return null;
    const { table } = APP_FAMILY_TABLES[family];
    const [row] = (await (db as any)
      .select({ id: table.id, appId: table.appId, environmentId: table.appEnvironmentId })
      .from(table)
      .where(familyWhere(family, eq(table.id, folderId), isNotNull(table.appId)))
      .limit(1)) as Array<{ id: string; appId: string; environmentId: string | null }>;
    return row ? { family, folderId: row.id, appId: row.appId, environmentId: row.environmentId } : null;
  }

  /** Every hidden folder by id, cached for 10 s (list annotation and audit tagging; never for authorization). */
  async folderIndex(): Promise<Map<string, AppFolderRef>> {
    if (this.index && Date.now() - this.index.at < INDEX_TTL_MS) return this.index.byFolder;
    const byFolder = new Map<string, AppFolderRef>();
    for (const family of APP_FAMILIES) {
      const { table } = APP_FAMILY_TABLES[family];
      const rows = (await (this.db as any)
        .select({ id: table.id, appId: table.appId, environmentId: table.appEnvironmentId })
        .from(table)
        .where(familyWhere(family, isNotNull(table.appId)))) as Array<{
        id: string;
        appId: string;
        environmentId: string | null;
      }>;
      for (const row of rows) {
        byFolder.set(row.id, { family, folderId: row.id, appId: row.appId, environmentId: row.environmentId });
      }
    }
    this.index = { at: Date.now(), byFolder };
    return byFolder;
  }

  /** Every folder table once (the Docker table holds two families). */
  private distinctTables(): any[] {
    return [...new Set(APP_FAMILIES.map((family) => APP_FAMILY_TABLES[family].table))];
  }
}
