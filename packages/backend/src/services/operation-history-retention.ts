import { type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Finished history kept per owner regardless of age, so every resource still shows its recent runs. */
export const OPERATION_HISTORY_KEEP_PER_OWNER = 10;
/** Rows removed per statement, so a first run after a year of history never holds long locks. */
export const RETENTION_DELETE_BATCH = 1000;
/** Builds (or build batches) handled per step; their log chunks go first, in RETENTION_DELETE_BATCH rows. */
const BUILD_DELETE_BATCH = 100;
/** Upper bound of statements per target and run; the rest waits for the next housekeeping run. */
const MAX_BATCHES_PER_TARGET = 500;
/** Expired OAuth grants are kept this long for troubleshooting before they are purged. */
const OAUTH_EXPIRED_GRACE_MS = DAY_MS;
/** A revoked access token is kept this long (it is rejected either way). */
const OAUTH_REVOKED_ACCESS_GRACE_MS = 7 * DAY_MS;
/** A client registration that never completed authorization is removed after this long. */
export const OAUTH_UNUSED_CLIENT_DAYS = 30;
/** An expired operation lease holds nothing; its row is kept this long for troubleshooting. */
export const EXPIRED_OPERATION_LEASE_GRACE_MS = 60 * 60 * 1000;

const FINISHED_BUILD = sql`('succeeded', 'failed', 'cancelled', 'superseded')`;

type Executor = Pick<DrizzleClient, 'execute'>;

interface KeyedTarget {
  name: string;
  table: string;
  /** Primary key column used to delete in batches. */
  key: string;
  where: SQL;
}

function rowCount(result: unknown): number {
  return Number((result as { rowCount?: number | null } | null)?.rowCount ?? 0);
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

/** Build groups each source keeps: a Compose build batch counts once, like a single build. */
function keptBuildGroups(): SQL {
  return sql.raw(
    `SELECT "ranked"."group_key" FROM (SELECT coalesce("batch_id", "id") AS "group_key", row_number() OVER (PARTITION BY "source_binding_id" ORDER BY max("created_at") DESC) AS "rn" FROM "docker_builds" GROUP BY "source_binding_id", coalesce("batch_id", "id")) "ranked" WHERE "ranked"."rn" <= ${OPERATION_HISTORY_KEEP_PER_OWNER}`
  );
}

/**
 * A finished single build that is old, has no live artifact (deleting the
 * build would cascade to the artifact the registry GC manages) and is not
 * among its source's latest runs.
 */
function singleBuildsWhere(cutoff: Date): SQL {
  return sql`"batch_id" IS NULL
    AND "status" IN ${FINISHED_BUILD}
    AND coalesce("completed_at", "updated_at") < ${cutoff}
    AND NOT EXISTS (SELECT 1 FROM "docker_build_artifacts" "artifact" WHERE "artifact"."build_id" = "docker_builds"."id" AND "artifact"."status" <> 'deleted')
    AND "id" NOT IN (${keptBuildGroups()})`;
}

/**
 * A finished Compose build batch goes as a whole (a batch cascades to its
 * builds) once every build in it is finished, old and without a live artifact.
 */
function buildBatchesWhere(cutoff: Date): SQL {
  return sql`"status" IN ${FINISHED_BUILD}
    AND coalesce("completed_at", "updated_at") < ${cutoff}
    AND "id" NOT IN (${keptBuildGroups()})
    AND NOT EXISTS (
      SELECT 1 FROM "docker_builds" "build"
      WHERE "build"."batch_id" = "docker_build_batches"."id"
        AND (
          "build"."status" NOT IN ${FINISHED_BUILD}
          OR coalesce("build"."completed_at", "build"."updated_at") >= ${cutoff}
          OR EXISTS (SELECT 1 FROM "docker_build_artifacts" "artifact" WHERE "artifact"."build_id" = "build"."id" AND "artifact"."status" <> 'deleted')
        )
    )`;
}

function operationTargets(cutoff: Date): KeyedTarget[] {
  const keep = OPERATION_HISTORY_KEEP_PER_OWNER;
  return [
    {
      name: 'docker source webhook deliveries',
      table: 'docker_source_webhook_deliveries',
      key: 'id',
      where: sql`"received_at" < ${cutoff}`,
    },
    {
      name: 'docker compose operations',
      table: 'docker_compose_operations',
      key: 'id',
      where: sql`"status" IN ('succeeded', 'failed', 'cancelled')
        AND coalesce("completed_at", "created_at") < ${cutoff}
        AND "id" NOT IN (SELECT "ranked"."id" FROM (SELECT "id", row_number() OVER (PARTITION BY "project_id" ORDER BY "created_at" DESC) AS "rn" FROM "docker_compose_operations") "ranked" WHERE "ranked"."rn" <= ${keep})`,
    },
    {
      // A later start or restart replays the latest rollout of its policy, and
      // a placement points at the operation that placed it: both stay.
      name: 'docker availability operations',
      table: 'docker_availability_operations',
      key: 'id',
      where: sql`"status" IN ('completed', 'failed', 'cancelled')
        AND coalesce("completed_at", "updated_at") < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM "docker_availability_placements" "placement" WHERE "placement"."operation_id" = "docker_availability_operations"."id")
        AND "id" NOT IN (SELECT "ranked"."id" FROM (SELECT "id", row_number() OVER (PARTITION BY "policy_id" ORDER BY "created_at" DESC, "id" DESC) AS "rn" FROM "docker_availability_operations") "ranked" WHERE "ranked"."rn" <= ${keep})
        AND "id" NOT IN (SELECT "latest"."id" FROM (SELECT "id", row_number() OVER (PARTITION BY "policy_id", "type" ORDER BY "created_at" DESC, "id" DESC) AS "rn" FROM "docker_availability_operations") "latest" WHERE "latest"."rn" = 1)`,
    },
    {
      // Create/install operations of a node that still exists record which
      // hosting connector owns it, and snapshots point at their operation.
      name: 'hosting operations',
      table: 'hosting_operations',
      key: 'id',
      where: sql`"phase" IN ('ready', 'failed')
        AND coalesce("completed_at", "updated_at") < ${cutoff}
        AND ("action" NOT IN ('create', 'install') OR "node_id" IS NULL)
        AND NOT EXISTS (SELECT 1 FROM "hosting_snapshot_entities" "snapshot" WHERE "snapshot"."operation_id" = "hosting_operations"."id")`,
    },
  ];
}

/**
 * OAuth grants that can never be used again: expired authorization codes,
 * expired refresh tokens (a revoked one is kept until it expires so reuse is
 * still detected), expired or long-revoked access tokens. A registered client
 * is removed only when it never completed an authorization (a client that was
 * ever granted keeps its client_id, or it could never sign in again) and is
 * older than 30 days.
 */
function oauthTargets(now: Date): KeyedTarget[] {
  const expiredBefore = new Date(now.getTime() - OAUTH_EXPIRED_GRACE_MS);
  const revokedBefore = new Date(now.getTime() - OAUTH_REVOKED_ACCESS_GRACE_MS);
  const unusedClientBefore = new Date(now.getTime() - OAUTH_UNUSED_CLIENT_DAYS * DAY_MS);
  return [
    {
      name: 'oauth authorization codes',
      table: 'oauth_authorization_codes',
      key: 'id',
      where: sql`"expires_at" < ${expiredBefore}`,
    },
    {
      name: 'oauth access tokens',
      table: 'oauth_access_tokens',
      key: 'id',
      where: sql`(("expires_at" IS NOT NULL AND "expires_at" < ${expiredBefore}) OR ("grant_expires_at" IS NOT NULL AND "grant_expires_at" < ${expiredBefore}) OR ("revoked_at" IS NOT NULL AND "revoked_at" < ${revokedBefore}))`,
    },
    {
      name: 'oauth refresh tokens',
      table: 'oauth_refresh_tokens',
      key: 'id',
      // A grant's own expiry (set by its owner) ends its refresh chain as well.
      where: sql`("expires_at" < ${expiredBefore} OR ("grant_expires_at" IS NOT NULL AND "grant_expires_at" < ${expiredBefore}))`,
    },
    {
      name: 'oauth clients',
      table: 'oauth_clients',
      key: 'client_id',
      where: sql`"last_grant_at" IS NULL
        AND "created_at" < ${unusedClientBefore}
        AND NOT EXISTS (SELECT 1 FROM "oauth_authorization_codes" "grant" WHERE "grant"."client_id" = "oauth_clients"."client_id")
        AND NOT EXISTS (SELECT 1 FROM "oauth_refresh_tokens" "grant" WHERE "grant"."client_id" = "oauth_clients"."client_id")
        AND NOT EXISTS (SELECT 1 FROM "oauth_access_tokens" "grant" WHERE "grant"."client_id" = "oauth_clients"."client_id")`,
    },
  ];
}

/** Delete a target's rows RETENTION_DELETE_BATCH at a time. */
async function deleteInBatches(db: Executor, target: KeyedTarget): Promise<number> {
  const table = sql.identifier(target.table);
  const key = sql.identifier(target.key);
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_TARGET; batch += 1) {
    const result = await db.execute(
      sql`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${target.where} LIMIT ${RETENTION_DELETE_BATCH})`
    );
    const removed = rowCount(result);
    total += removed;
    if (removed < RETENTION_DELETE_BATCH) break;
  }
  return total;
}

/** Remove the log chunks of these builds in batches, before the builds cascade to them in one statement. */
async function deleteBuildLogChunks(db: Executor, buildIds: string[]): Promise<number> {
  if (buildIds.length === 0) return 0;
  const ids = sql.join(
    buildIds.map((id) => sql`${id}`),
    sql`, `
  );
  let total = 0;
  for (;;) {
    const result = await db.execute(
      sql`DELETE FROM "docker_build_log_chunks" WHERE ctid IN (SELECT ctid FROM "docker_build_log_chunks" WHERE "build_id" IN (${ids}) LIMIT ${RETENTION_DELETE_BATCH})`
    );
    const removed = rowCount(result);
    total += removed;
    if (removed < RETENTION_DELETE_BATCH) return total;
  }
}

async function deleteSingleBuilds(db: Executor, cutoff: Date): Promise<{ builds: number; logChunks: number }> {
  let builds = 0;
  let logChunks = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_TARGET; batch += 1) {
    const selected = rowsOf<{ id: string }>(
      await db.execute(
        sql`SELECT "id" FROM "docker_builds" WHERE ${singleBuildsWhere(cutoff)} LIMIT ${BUILD_DELETE_BATCH}`
      )
    ).map((row) => row.id);
    if (selected.length === 0) break;
    logChunks += await deleteBuildLogChunks(db, selected);
    const ids = sql.join(
      selected.map((id) => sql`${id}`),
      sql`, `
    );
    builds += rowCount(
      await db.execute(sql`DELETE FROM "docker_builds" WHERE "id" IN (${ids}) AND ${singleBuildsWhere(cutoff)}`)
    );
    if (selected.length < BUILD_DELETE_BATCH) break;
  }
  return { builds, logChunks };
}

async function deleteBuildBatches(
  db: Executor,
  cutoff: Date
): Promise<{ batches: number; builds: number; logChunks: number }> {
  let batches = 0;
  let builds = 0;
  let logChunks = 0;
  for (let step = 0; step < MAX_BATCHES_PER_TARGET; step += 1) {
    const selected = rowsOf<{ id: string }>(
      await db.execute(
        sql`SELECT "id" FROM "docker_build_batches" WHERE ${buildBatchesWhere(cutoff)} LIMIT ${BUILD_DELETE_BATCH}`
      )
    ).map((row) => row.id);
    if (selected.length === 0) break;
    const batchIds = sql.join(
      selected.map((id) => sql`${id}`),
      sql`, `
    );
    const memberIds = rowsOf<{ id: string }>(
      await db.execute(sql`SELECT "id" FROM "docker_builds" WHERE "batch_id" IN (${batchIds})`)
    ).map((row) => row.id);
    for (let index = 0; index < memberIds.length; index += BUILD_DELETE_BATCH) {
      const chunk = memberIds.slice(index, index + BUILD_DELETE_BATCH);
      logChunks += await deleteBuildLogChunks(db, chunk);
    }
    batches += rowCount(
      await db.execute(
        sql`DELETE FROM "docker_build_batches" WHERE "id" IN (${batchIds}) AND ${buildBatchesWhere(cutoff)}`
      )
    );
    builds += memberIds.length;
    if (selected.length < BUILD_DELETE_BATCH) break;
  }
  return { batches, builds, logChunks };
}

export function operationHistoryCutoff(retentionDays: number, now = new Date()): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

/**
 * Operation leases (see OperationLeaseStore) that expired more than the grace
 * period ago, by the database clock: lease expiry is written on it, and this
 * process's clock may be off by more than a lease's lifetime.
 */
function expiredOperationLeases(): KeyedTarget {
  return {
    name: 'expired operation leases',
    table: 'operation_leases',
    key: 'key',
    where: sql`"expires_at" < statement_timestamp() - (${EXPIRED_OPERATION_LEASE_GRACE_MS}::double precision * interval '1 millisecond')`,
  };
}

/** Names in `removed` that are detail, not history rows. */
const NOT_HISTORY = new Set(['docker build log chunks', 'expired operation leases']);

/**
 * Remove finished operation history older than the retention period, in
 * batches, and the rows of operation leases that expired a while ago.
 */
export async function cleanOperationHistory(db: Executor, retentionDays: number, now = new Date()) {
  const cutoff = operationHistoryCutoff(retentionDays, now);
  const removed: Record<string, number> = {};
  const single = await deleteSingleBuilds(db, cutoff);
  const grouped = await deleteBuildBatches(db, cutoff);
  removed['docker builds'] = single.builds + grouped.builds;
  removed['docker build batches'] = grouped.batches;
  removed['docker build log chunks'] = single.logChunks + grouped.logChunks;
  for (const target of operationTargets(cutoff)) removed[target.name] = await deleteInBatches(db, target);
  const leases = expiredOperationLeases();
  removed[leases.name] = await deleteInBatches(db, leases);
  // Log chunks and lease rows are counted as detail, not as history rows.
  const total = Object.entries(removed)
    .filter(([name]) => !NOT_HISTORY.has(name))
    .reduce((sum, [, value]) => sum + value, 0);
  return { total, removed };
}

async function countWhere(db: Executor, table: string, where: SQL): Promise<number> {
  const [row] = rowsOf<{ value: number | string }>(
    await db.execute(sql`SELECT count(*) AS "value" FROM ${sql.identifier(table)} WHERE ${where}`)
  );
  return Number(row?.value ?? 0);
}

export async function countOperationHistory(db: Executor, retentionDays: number, now = new Date()) {
  const cutoff = operationHistoryCutoff(retentionDays, now);
  let total = await countWhere(db, 'docker_builds', singleBuildsWhere(cutoff));
  total += await countWhere(db, 'docker_build_batches', buildBatchesWhere(cutoff));
  for (const target of operationTargets(cutoff)) total += await countWhere(db, target.table, target.where);
  return total;
}

export async function purgeExpiredOAuthGrants(db: Executor, now = new Date()) {
  const removed: Record<string, number> = {};
  let total = 0;
  for (const target of oauthTargets(now)) {
    removed[target.name] = await deleteInBatches(db, target);
    total += removed[target.name]!;
  }
  return { total, removed };
}

export async function countExpiredOAuthGrants(db: Executor, now = new Date()) {
  let total = 0;
  for (const target of oauthTargets(now)) total += await countWhere(db, target.table, target.where);
  return total;
}
