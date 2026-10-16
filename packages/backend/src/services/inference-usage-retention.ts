import { sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Inference request, attempt and usage records kept by default. */
export const DEFAULT_INFERENCE_USAGE_RETENTION_DAYS = 90;
/**
 * The shortest allowed period: every usage limit and report reads at most the last 30 days or the current calendar
 * month, so a shorter period would forget usage a limit still counts.
 */
export const MIN_INFERENCE_USAGE_RETENTION_DAYS = 35;
/** Requests removed per transaction. */
const REQUEST_BATCH = 500;
/** Upper bound of batches per run; the rest waits for the next run. */
const MAX_BATCHES = 400;
/** Quota readings only matter while they are valid (30 minutes); older ones are kept this long. */
export const QUOTA_SNAPSHOT_KEEP_MS = 2 * 60 * 60 * 1000;
const QUOTA_DELETE_BATCH = 5000;

type Executor = Pick<DrizzleClient, 'execute'>;
type TransactionalExecutor = Executor & Pick<DrizzleClient, 'transaction'>;

function rowCount(result: unknown): number {
  return Number((result as { rowCount?: number | null } | null)?.rowCount ?? 0);
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

export function inferenceUsageCutoff(retentionDays: number, now = new Date()): Date {
  const days = Math.max(MIN_INFERENCE_USAGE_RETENTION_DAYS, Math.floor(retentionDays));
  return new Date(now.getTime() - days * DAY_MS);
}

/** Settled requests older than the cutoff. Requests still reserved or running are never selected. */
function expiredRequestIds(cutoff: Date) {
  return sql`SELECT "id" FROM "inference_requests"
    WHERE "status" IN ('completed', 'failed', 'cancelled') AND "started_at" < ${cutoff}
    ORDER BY "started_at" LIMIT ${REQUEST_BATCH}`;
}

/**
 * Remove settled inference requests older than the retention period with their attempts and usage records, in
 * batches. Before a user's usage records go, their totals are added to the user's lifetime totals, so the lifetime
 * figure never shrinks. Every limit window and usage report covers at most the last 30 days or the current month,
 * which the minimum period (35 days) always keeps.
 */
export async function cleanInferenceUsage(
  db: TransactionalExecutor,
  retentionDays: number,
  now = new Date()
): Promise<{ requests: number; ledgerEntries: number }> {
  const cutoff = inferenceUsageCutoff(retentionDays, now);
  let requests = 0;
  let ledgerEntries = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const removed = await db.transaction(async (tx) => {
      const ids = rowsOf<{ id: string }>(
        await tx.execute(sql`${expiredRequestIds(cutoff)} FOR UPDATE SKIP LOCKED`)
      ).map((row) => row.id);
      if (ids.length === 0) return { requests: 0, ledgerEntries: 0 };
      const idList = sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `
      );
      await tx.execute(sql`
        INSERT INTO "inference_usage_lifetime_totals" ("user_id", "tokens", "credits", "api_microdollars", "updated_at")
        SELECT "ledger"."user_id",
          sum("ledger"."uncached_input_tokens" + "ledger"."cached_input_tokens" + "ledger"."cache_write_tokens" + "ledger"."output_tokens" + "ledger"."reasoning_tokens"),
          sum("ledger"."credits"),
          sum("ledger"."api_microdollars"),
          now()
        FROM "inference_usage_ledger" "ledger"
        WHERE "ledger"."request_id" IN (${idList}) AND "ledger"."user_id" IS NOT NULL
          AND EXISTS (SELECT 1 FROM "users" WHERE "users"."id" = "ledger"."user_id")
        GROUP BY "ledger"."user_id"
        ON CONFLICT ("user_id") DO UPDATE SET
          "tokens" = "inference_usage_lifetime_totals"."tokens" + excluded."tokens",
          "credits" = "inference_usage_lifetime_totals"."credits" + excluded."credits",
          "api_microdollars" = "inference_usage_lifetime_totals"."api_microdollars" + excluded."api_microdollars",
          "updated_at" = now()`);
      // The ledger refers to requests and attempts with on delete restrict: it goes first. Attempts go with their
      // request (on delete cascade).
      const ledger = rowCount(
        await tx.execute(sql`DELETE FROM "inference_usage_ledger" WHERE "request_id" IN (${idList})`)
      );
      const deleted = rowCount(await tx.execute(sql`DELETE FROM "inference_requests" WHERE "id" IN (${idList})`));
      return { requests: deleted, ledgerEntries: ledger };
    });
    requests += removed.requests;
    ledgerEntries += removed.ledgerEntries;
    if (removed.requests < REQUEST_BATCH) break;
  }
  return { requests, ledgerEntries };
}

export async function countExpiredInferenceUsage(db: Executor, retentionDays: number, now = new Date()) {
  const cutoff = inferenceUsageCutoff(retentionDays, now);
  const [row] = rowsOf<{ value: number | string }>(
    await db.execute(
      sql`SELECT count(*) AS "value" FROM "inference_requests" WHERE "status" IN ('completed', 'failed', 'cancelled') AND "started_at" < ${cutoff}`
    )
  );
  return Number(row?.value ?? 0);
}

/**
 * Provider quota readings: every reader uses only the newest reading of a connection (a reading is valid for 30
 * minutes), but every synchronization added rows that were never removed, and readers loaded all of them. Removes
 * readings older than two hours except the newest batch of each connection, and the readings of deleted connections.
 * Pass a connection id to prune only that connection (after it synchronized).
 */
export async function pruneInferenceQuotaSnapshots(
  db: Executor,
  options: { connectionId?: string; now?: Date } = {}
): Promise<number> {
  const before = new Date((options.now ?? new Date()).getTime() - QUOTA_SNAPSHOT_KEEP_MS);
  const scope = options.connectionId ? sql`AND "snapshot"."connection_id" = ${options.connectionId}` : sql``;
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const removed = rowCount(
      await db.execute(sql`DELETE FROM "inference_quota_snapshots" WHERE "id" IN (
        SELECT "snapshot"."id" FROM "inference_quota_snapshots" "snapshot"
        WHERE "snapshot"."fetched_at" < ${before} ${scope}
          AND ("snapshot"."connection_id" IS NULL OR "snapshot"."fetched_at" < (
            SELECT max("latest"."fetched_at") FROM "inference_quota_snapshots" "latest"
            WHERE "latest"."connection_id" = "snapshot"."connection_id"
          ))
        LIMIT ${QUOTA_DELETE_BATCH})`)
    );
    total += removed;
    if (removed < QUOTA_DELETE_BATCH) break;
  }
  return total;
}

/**
 * API price versions that nothing refers to any more: older than the cutoff, not used by a remaining request or
 * attempt, and replaced by a newer version of the same source that is already in effect.
 */
export async function pruneInferencePricingSnapshots(db: Executor, cutoff: Date, now = new Date()): Promise<number> {
  return rowCount(
    await db.execute(sql`DELETE FROM "inference_pricing_snapshots" "pricing"
      WHERE "pricing"."effective_at" < ${cutoff}
        AND EXISTS (
          SELECT 1 FROM "inference_pricing_snapshots" "newer"
          WHERE "newer"."source_id" = "pricing"."source_id"
            AND "newer"."effective_at" > "pricing"."effective_at"
            AND "newer"."effective_at" <= ${now}
        )
        AND NOT EXISTS (SELECT 1 FROM "inference_requests" "request" WHERE "request"."pricing_snapshot_id" = "pricing"."id")
        AND NOT EXISTS (SELECT 1 FROM "inference_request_attempts" "attempt" WHERE "attempt"."pricing_snapshot_id" = "pricing"."id")`)
  );
}

/** Upper bound of quota readings one connection read loads: far more than the newest batch ever holds. */
export const QUOTA_READ_LIMIT = 500;
