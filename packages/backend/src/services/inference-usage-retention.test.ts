import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanInferenceUsage,
  inferenceUsageCutoff,
  MIN_INFERENCE_USAGE_RETENTION_DAYS,
  pruneInferencePricingSnapshots,
  pruneInferenceQuotaSnapshots,
} from './inference-usage-retention.js';

const dialect = new PgDialect();
const now = new Date('2030-06-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const compact = (value: string) => value.replace(/\s+/g, ' ');

function executingDb(respond: (query: { sql: string; params: unknown[] }) => unknown = () => undefined) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const execute = vi.fn(async (statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    statements.push(query);
    return respond(query) ?? { rowCount: 0, rows: [] };
  });
  const db = { execute, transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ execute })) };
  return { db, statements };
}

describe('inference usage retention', () => {
  it('never shortens the period below the longest usage window', () => {
    expect(inferenceUsageCutoff(7, now)).toEqual(new Date(now.getTime() - MIN_INFERENCE_USAGE_RETENTION_DAYS * DAY_MS));
    expect(inferenceUsageCutoff(90, now)).toEqual(new Date(now.getTime() - 90 * DAY_MS));
  });

  it('adds removed usage to the lifetime totals, then removes the ledger before the requests', async () => {
    let selects = 0;
    const { db, statements } = executingDb((query) => {
      if (query.sql.startsWith('SELECT "id" FROM "inference_requests"')) {
        selects += 1;
        return { rows: selects === 1 ? [{ id: 'r1' }, { id: 'r2' }] : [] };
      }
      if (query.sql.startsWith('DELETE FROM "inference_usage_ledger"')) return { rowCount: 3 };
      if (query.sql.startsWith('DELETE FROM "inference_requests"')) return { rowCount: 2 };
      return undefined;
    });

    await expect(cleanInferenceUsage(db as never, 90, now)).resolves.toEqual({ requests: 2, ledgerEntries: 3 });

    const order = statements.map((query) => compact(query.sql).trim().slice(0, 50));
    const totals = order.findIndex((line) => line.startsWith('INSERT INTO "inference_usage_lifetime_totals"'));
    const ledger = order.findIndex((line) => line.startsWith('DELETE FROM "inference_usage_ledger"'));
    const requests = order.findIndex((line) => line.startsWith('DELETE FROM "inference_requests"'));
    expect(totals).toBeGreaterThan(-1);
    expect(totals).toBeLessThan(ledger);
    expect(ledger).toBeLessThan(requests);
    const select = compact(statements[0]!.sql).trim();
    // Reserved and running requests are never selected.
    expect(select).toContain(`"status" IN ('completed', 'failed', 'cancelled')`);
    expect(select).toContain('FOR UPDATE SKIP LOCKED');
    expect(statements[0]!.params).toContainEqual(new Date(now.getTime() - 90 * DAY_MS));
  });

  it('keeps the newest quota reading of every connection', async () => {
    const { db, statements } = executingDb();

    await pruneInferenceQuotaSnapshots(db as never, { now });

    const query = compact(statements[0]!.sql);
    expect(query).toContain('SELECT max("latest"."fetched_at")');
    expect(query).toContain('"snapshot"."fetched_at" < (');
  });

  it('keeps price versions still in use or still current', async () => {
    const { db, statements } = executingDb();

    await pruneInferencePricingSnapshots(db as never, new Date(now.getTime() - 90 * DAY_MS), now);

    const query = compact(statements[0]!.sql);
    expect(query).toContain('"newer"."effective_at" > "pricing"."effective_at"');
    expect(query).toContain('NOT EXISTS (SELECT 1 FROM "inference_requests"');
    expect(query).toContain('NOT EXISTS (SELECT 1 FROM "inference_request_attempts"');
  });
});
