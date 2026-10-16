import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import {
  BUILD_LOGS_KEPT_PER_SOURCE,
  cleanBuildLogs,
  cleanOperationHistory,
  countExpiredOAuthGrants,
  countOperationHistory,
  EXPIRED_OPERATION_LEASE_GRACE_MS,
  OPERATION_HISTORY_KEEP_PER_OWNER,
  purgeExpiredOAuthGrants,
  RETENTION_DELETE_BATCH,
} from './operation-history-retention.js';

const dialect = new PgDialect();
const now = new Date('2030-06-01T00:00:00.000Z');

type Responder = (query: { sql: string; params: unknown[] }) => { rowCount?: number; rows?: unknown[] } | undefined;

function executingDb(respond: Responder = () => undefined) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    execute: vi.fn(async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      statements.push(query);
      return respond(query) ?? { rowCount: 0, rows: [] };
    }),
  };
  return { db, statements };
}

const compact = (value: string) => value.replace(/\s+/g, ' ');

describe('operation history retention', () => {
  it('removes operation leases that expired over an hour ago, in batches, without counting them as history', async () => {
    let leaseBatches = 0;
    const { db, statements } = executingDb((query) => {
      if (!query.sql.startsWith('DELETE FROM "operation_leases"')) return undefined;
      leaseBatches += 1;
      return { rowCount: leaseBatches === 1 ? RETENTION_DELETE_BATCH : 2 };
    });

    const result = await cleanOperationHistory(db as never, 90, now);

    expect(leaseBatches).toBe(2);
    expect(result.removed['expired operation leases']).toBe(RETENTION_DELETE_BATCH + 2);
    expect(result.total).toBe(0);
    const lease = statements.find((query) => query.sql.startsWith('DELETE FROM "operation_leases"'))!;
    // Judged by the database clock, which lease expiry is written on, not by `now`.
    expect(compact(lease.sql)).toContain(
      'WHERE "key" IN (SELECT "key" FROM "operation_leases" WHERE "expires_at" < statement_timestamp() - ($1::double precision * interval \'1 millisecond\')'
    );
    expect(lease.params).toContainEqual(EXPIRED_OPERATION_LEASE_GRACE_MS);
    expect(lease.params).not.toContainEqual(new Date(now.getTime() - EXPIRED_OPERATION_LEASE_GRACE_MS));
  });

  it('deletes each kind of finished history in batches', async () => {
    let composeBatches = 0;
    const { db, statements } = executingDb((query) => {
      if (query.sql.startsWith('DELETE FROM "docker_compose_operations"')) {
        composeBatches += 1;
        return { rowCount: composeBatches === 1 ? RETENTION_DELETE_BATCH : 3 };
      }
      if (query.sql.startsWith('DELETE FROM "hosting_operations"')) return { rowCount: 2 };
      return undefined;
    });

    const result = await cleanOperationHistory(db as never, 90, now);

    expect(composeBatches).toBe(2);
    expect(result.removed).toMatchObject({
      'docker compose operations': RETENTION_DELETE_BATCH + 3,
      'hosting operations': 2,
    });
    expect(result.total).toBe(RETENTION_DELETE_BATCH + 5);
    const deletes = statements.filter((query) => query.sql.startsWith('DELETE FROM'));
    for (const query of deletes.filter((statement) => !statement.sql.includes('"docker_build'))) {
      expect(query.sql).toContain(' IN (SELECT ');
      expect(query.params).toContain(RETENTION_DELETE_BATCH);
    }
    const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(deletes.find((query) => query.sql.startsWith('DELETE FROM "hosting_operations"'))!.params).toContainEqual(
      cutoff
    );
  });

  it('removes build log chunks in batches before the builds that own them', async () => {
    const buildIds = ['build-1', 'build-2'];
    let chunkBatches = 0;
    const { db, statements } = executingDb((query) => {
      if (query.sql.startsWith('SELECT "id" FROM "docker_builds" WHERE "batch_id" IS NULL')) {
        return { rows: buildIds.map((id) => ({ id })) };
      }
      if (query.sql.startsWith('DELETE FROM "docker_build_log_chunks"')) {
        chunkBatches += 1;
        return { rowCount: chunkBatches === 1 ? RETENTION_DELETE_BATCH : 10 };
      }
      if (query.sql.startsWith('DELETE FROM "docker_builds"')) return { rowCount: 2 };
      return undefined;
    });

    const result = await cleanOperationHistory(db as never, 30, now);

    const order = statements.map((query) => query.sql.slice(0, 40));
    const lastChunkDelete = order.lastIndexOf(order.find((line) => line.includes('docker_build_log_chunks'))!);
    const buildDelete = order.findIndex((line) => line.startsWith('DELETE FROM "docker_builds"'));
    expect(lastChunkDelete).toBeLessThan(buildDelete);
    expect(chunkBatches).toBe(2);
    expect(result.removed).toMatchObject({
      'docker builds': 2,
      'docker build log chunks': RETENTION_DELETE_BATCH + 10,
    });
    expect(result.total).toBe(2);
  });

  it('keeps what later work still depends on', async () => {
    const { db, statements } = executingDb();

    await cleanOperationHistory(db as never, 30, now);

    const find = (prefix: string) => compact(statements.find((query) => query.sql.startsWith(prefix))!.sql);
    const singleBuilds = find('SELECT "id" FROM "docker_builds"');
    // A build that owns a live artifact would cascade into the registry-managed artifact.
    expect(singleBuilds).toContain('NOT EXISTS (SELECT 1 FROM "docker_build_artifacts"');
    // The latest runs are counted per build group, so a Compose batch is never split.
    expect(singleBuilds).toContain('coalesce("batch_id", "id") AS "group_key"');
    expect(singleBuilds).toContain(`"rn" <= ${OPERATION_HISTORY_KEEP_PER_OWNER}`);
    const batches = find('SELECT "id" FROM "docker_build_batches"');
    expect(batches).toContain('"build"."status" NOT IN');
    const availability = find('DELETE FROM "docker_availability_operations"');
    expect(availability).toContain('PARTITION BY "policy_id", "type"');
    expect(availability).toContain('"docker_availability_placements"');
    const hosting = find('DELETE FROM "hosting_operations"');
    expect(hosting).toContain(`"action" NOT IN ('create', 'install')`);
    expect(hosting).toContain('"hosting_snapshot_entities"');
  });

  it('counts eligible rows for the housekeeping stats', async () => {
    const { db } = executingDb((query) =>
      query.sql.startsWith('SELECT count(*)') && query.sql.includes('FROM "docker_compose_operations"')
        ? { rows: [{ value: '4' }] }
        : { rows: [{ value: 1 }] }
    );

    await expect(countOperationHistory(db as never, 90, now)).resolves.toBe(4 + 17);
  });
});

describe('run records that only grew', () => {
  it("removes only finished records, keeps each owner's newest and anything still holding something", async () => {
    const { db, statements } = executingDb();

    await cleanOperationHistory(db as never, 90, now);

    const find = (table: string) =>
      compact(statements.find((query) => query.sql.startsWith(`DELETE FROM "${table}"`))!.sql);
    expect(find('docker_registry_maintenance_runs')).toContain(`"status" <> 'running'`);
    expect(find('relay_pool_update_runs')).toContain(`"state" IN ('complete', 'failed')`);
    expect(find('relay_pool_update_runs')).toContain('PARTITION BY "pool_id"');
    expect(find('docker_deployment_releases')).toContain('PARTITION BY "deployment_id"');
    expect(find('docker_migrations')).toContain('NOT EXISTS (SELECT 1 FROM "docker_migration_node_locks"');
    expect(find('docker_migrations')).toContain(`"status" IN ('completed', 'failed', 'cancelled')`);
    expect(find('sandbox_jobs')).toContain('"workspace_reservation_released_at" IS NOT NULL');
    expect(find('inference_core_operations')).toContain(`"status" <> 'running'`);
    expect(find('app_promotions')).toContain('PARTITION BY "app_id"');
    expect(find('app_incidents')).toContain(`"state" IN ('released', 'failed')`);
    expect(find('nginx_proxy_host_deployments')).toContain('PARTITION BY "host_id"');
    const artifacts = find('docker_build_artifacts');
    expect(artifacts).toContain(`"owner_kind" <> 'build'`);
    expect(artifacts).toContain('NOT EXISTS (SELECT 1 FROM "docker_artifact_pins"');
    for (const table of ['relay_pool_update_runs', 'docker_deployment_releases', 'app_promotions']) {
      expect(find(table)).toContain(`"rn" <= ${OPERATION_HISTORY_KEEP_PER_OWNER}`);
    }
  });
});

describe('build log retention', () => {
  it("removes the logs of old finished builds but never of a source's newest builds", async () => {
    let aged = 0;
    const { db, statements } = executingDb((query) => {
      if (query.sql.includes('SELECT "build"."id"') && query.sql.includes('< $')) {
        aged += 1;
        return { rows: aged === 1 ? [{ id: 'old-1', bytes: '100' }] : [] };
      }
      if (query.sql.startsWith('SELECT coalesce(sum("byte_length")')) return { rows: [{ value: 10 }] };
      if (query.sql.startsWith('DELETE FROM "docker_build_log_chunks"')) return { rowCount: 3 };
      return undefined;
    });

    const result = await cleanBuildLogs(db as never, { retentionDays: 30, maxSizeBytes: 1000 }, now);

    expect(result).toEqual({ builds: 1, chunks: 3, bytes: 100 });
    const select = compact(statements.find((query) => query.sql.includes('SELECT "build"."id"'))!.sql);
    expect(select).toContain(`"build"."status" IN ('succeeded', 'failed', 'cancelled', 'superseded')`);
    expect(select).toContain(`"ranked"."rn" <= ${BUILD_LOGS_KEPT_PER_SOURCE}`);
    // Under the size cap: nothing more goes.
    expect(statements.filter((query) => query.sql.includes('"build"."id" ASC'))).toHaveLength(0);
  });

  it('removes the oldest finished logs while all logs together are over the size cap', async () => {
    const { db, statements } = executingDb((query) => {
      if (query.sql.includes('SELECT "build"."id"') && query.sql.includes('"build"."id" ASC')) {
        return {
          rows: [
            { id: 'a', bytes: 600 },
            { id: 'b', bytes: 600 },
            { id: 'c', bytes: 600 },
          ],
        };
      }
      if (query.sql.startsWith('SELECT coalesce(sum("byte_length")')) return { rows: [{ value: 2000 }] };
      if (query.sql.startsWith('DELETE FROM "docker_build_log_chunks"')) return { rowCount: 1 };
      return undefined;
    });

    const result = await cleanBuildLogs(db as never, { retentionDays: 30, maxSizeBytes: 1000 }, now);

    // 2000 bytes against a 1000-byte cap: the two oldest (1200 bytes) go, the third stays.
    expect(result.builds).toBe(2);
    const deleted = statements.filter((query) => query.sql.startsWith('DELETE FROM "docker_build_log_chunks"'));
    expect(deleted.flatMap((query) => query.params)).toEqual(expect.arrayContaining(['a', 'b']));
    expect(deleted.flatMap((query) => query.params)).not.toContain('c');
  });
});

describe('expired OAuth grant purge', () => {
  it('purges expired grants but never a client that was ever granted', async () => {
    const { db, statements } = executingDb((query) =>
      query.sql.startsWith('DELETE FROM "oauth_access_tokens"') ? { rowCount: 7 } : undefined
    );

    const result = await purgeExpiredOAuthGrants(db as never, now);

    expect(result.total).toBe(7);
    const find = (prefix: string) => compact(statements.find((query) => query.sql.startsWith(prefix))!.sql);
    // Refresh tokens go only once expired, so a revoked one still trips reuse detection until then.
    expect(find('DELETE FROM "oauth_refresh_tokens"')).toContain('"expires_at" <');
    const clients = find('DELETE FROM "oauth_clients"');
    expect(clients).toContain('"last_grant_at" IS NULL');
    expect(clients).toContain('NOT EXISTS (SELECT 1 FROM "oauth_refresh_tokens"');
    expect(clients).toContain('NOT EXISTS (SELECT 1 FROM "oauth_access_tokens"');
    expect(clients).toContain('NOT EXISTS (SELECT 1 FROM "oauth_authorization_codes"');
    const clientParams = statements.find((query) => query.sql.startsWith('DELETE FROM "oauth_clients"'))!.params;
    expect(clientParams).toContainEqual(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  });

  it('counts purgeable grants', async () => {
    const { db } = executingDb(() => ({ rows: [{ value: 2 }] }));

    await expect(countExpiredOAuthGrants(db as never, now)).resolves.toBe(8);
  });
});
