import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): deleting a database keeps its backup history (stand e2e 2.12: the
 * backups of a deleted key-value store must stay restorable). The runs keep their files, name and manifest with the
 * database reference cleared; its policies go with it. A restore of such a backup belongs to no database either.
 */
describe.skipIf(!url)('backup history of a deleted database on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const id = {
    group: randomUUID(),
    user: randomUUID(),
    node: randomUUID(),
    destination: randomUUID(),
    connection: randomUUID(),
    policy: randomUUID(),
    backup: randomUUID(),
    restore: randomUUID(),
  };
  const manifest = { engine: 'redis', version: 1, engineVersion: 'valkey 9.1.2', ownedPrefix: 'kv/run' };

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'backup_history');
    pool = database.pool;
    await migrateDatabase(pool);
    await q('insert into permission_groups (id, name) values ($1, $2)', [id.group, `backups-${id.group}`]);
    await q('insert into users (id, group_id, email, name) values ($1, $2, $3, $4)', [
      id.user,
      id.group,
      `${id.user}@backups.test`,
      'Backups test',
    ]);
    await q('insert into nodes (id, hostname, slug) values ($1, gen_random_uuid()::text, gen_random_uuid()::text)', [
      id.node,
    ]);
    await q(
      `insert into object_storage_connections (id, name, slug, provider, encrypted_config, created_by_id)
       values ($1, 'backups', gen_random_uuid()::text, 'aws', 'x', $2)`,
      [id.destination, id.user]
    );
    await q(
      `insert into database_connections (id, name, slug, type, host, port, encrypted_config, created_by_id)
       values ($1, 'old-kv', gen_random_uuid()::text, 'redis', 'kv', 6379, 'x', $2)`,
      [id.connection, id.user]
    );
    await q(
      `insert into backup_policies (id, database_connection_id, destination_id, bucket, prefix, executor_node_id, limits)
       values ($1, $2, $3, 'b', 'kv', $4, '{}')`,
      [id.policy, id.connection, id.destination, id.node]
    );
    await q(
      `insert into backup_runs (id, policy_id, database_connection_id, database_connection_name, destination_id,
         destination_bucket, destination_prefix, timezone, executor_node_id, direction, engine, status,
         request_fingerprint, manifest, created_by_id)
       values ($1, $2, $3, 'old-kv', $4, 'b', 'kv', 'UTC', $5, 'backup', 'redis', 'completed',
         gen_random_uuid()::text, $6::jsonb, $7)`,
      [id.backup, id.policy, id.connection, id.destination, id.node, JSON.stringify(manifest), id.user]
    );
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('keeps the runs of a deleted database with their name and manifest', async () => {
    await q('delete from database_connections where id = $1', [id.connection]);

    const { rows } = await q(
      `select policy_id, database_connection_id, database_connection_name, status, manifest, artifacts_deleted_at
       from backup_runs where id = $1`,
      [id.backup]
    );
    expect(rows).toEqual([
      {
        policy_id: null,
        database_connection_id: null,
        database_connection_name: 'old-kv',
        status: 'completed',
        manifest,
        artifacts_deleted_at: null,
      },
    ]);
    expect((await q('select id from backup_policies where id = $1', [id.policy])).rows).toEqual([]);
  });

  it('accepts a restore of that backup that belongs to no database', async () => {
    await q(
      `insert into backup_runs (id, database_connection_id, database_connection_name, destination_id,
         destination_bucket, destination_prefix, timezone, executor_node_id, direction, engine, status,
         request_fingerprint, restore_target, created_by_id)
       values ($1, null, 'old-kv', $2, 'b', 'kv', 'UTC', $3, 'restore', 'redis', 'queued', gen_random_uuid()::text,
         $4::jsonb, $5)`,
      [
        id.restore,
        id.destination,
        id.node,
        JSON.stringify({ sourceRunId: id.backup, newManagedDatabaseName: 'kv-restored', artifact: manifest }),
        id.user,
      ]
    );

    const { rows } = await q(
      'select id, direction from backup_runs where database_connection_id is null order by created_at, id'
    );
    expect(rows.map((row) => row.id).sort()).toEqual([id.backup, id.restore].sort());
  });
});
