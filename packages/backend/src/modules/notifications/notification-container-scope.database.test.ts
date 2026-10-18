import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { containerScopeByName } from './notification-container-scope.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const RUNTIME_ID = 'f3a1c9d2e4b5a6978877665544332211f3a1c9d2e4b5a6978877665544332211';

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): container rules are scoped by container name (stand 2.12.6-rc.2, O-8).
 * Migration 0274 rewrites rules scoped by a runtime id to the container name, and a new scope given by runtime id is
 * stored by name.
 */
describe.skipIf(!url)('Container rule scope by name on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'container_scope');
    pool = database.pool;
    await migrateDatabase(pool, '0273_notification_and_access_list_folders');
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('rewrites rules scoped by a runtime id to the container name and keeps everything else', async () => {
    const node = (
      await q(`insert into nodes (type, hostname, slug) values ('docker', 'scope-1', 'scope-1') returning id`)
    ).rows[0].id;
    await q(
      `insert into docker_access_resources (node_id, resource_type, resource_key, runtime_id) values ($1, 'container', 'web', $2)`,
      [node, RUNTIME_ID]
    );
    const rule = async (name: string, category: string, ids: string[]) =>
      (
        await q(
          `insert into notification_alert_rules (name, type, category, event_pattern, resource_ids)
           values ($1, 'event', $2, 'started', $3) returning id`,
          [name, category, JSON.stringify(ids)]
        )
      ).rows[0].id as string;
    const full = await rule('by full id', 'container', [RUNTIME_ID]);
    const short = await rule('by short id and name', 'container', [RUNTIME_ID.slice(0, 12), 'worker']);
    const unknown = await rule('unknown id', 'container', ['0123456789abcdef']);
    const node_ = await rule('node rule', 'node', [RUNTIME_ID]);

    await migrateDatabase(pool);
    const scope = async (id: string) =>
      (await q('select resource_ids from notification_alert_rules where id = $1', [id])).rows[0].resource_ids;
    expect(await scope(full)).toEqual(['web']);
    expect([...(await scope(short))].sort()).toEqual(['web', 'worker']);
    expect(await scope(unknown)).toEqual(['0123456789abcdef']);
    expect(await scope(node_)).toEqual([RUNTIME_ID]);

    expect(await containerScopeByName(db, [RUNTIME_ID, RUNTIME_ID.slice(0, 12), 'web', 'api'])).toEqual(['web', 'api']);
  });
});
