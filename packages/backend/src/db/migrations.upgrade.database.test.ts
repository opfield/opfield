import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disposableDatabase, migrateDatabase } from './migration-database.test-helpers.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const fixture = readFileSync(new URL('./fixtures/rc10-upgrade.sql', import.meta.url), 'utf8');

/** The fixed ids of fixtures/rc10-upgrade.sql. */
const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const node1 = id('11');
const node2 = id('12');

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL, see migration-database.test-helpers): an install at v2.11.0-rc.10
 * (schema through 0206, holding the collisions rc.10 could store) upgraded through 0207-0209 on its own database.
 */
describe.skipIf(!url)('upgrade from v2.11.0-rc.10 data on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const reservations = async () =>
    (
      await q(
        `select owner_kind, owner_id, node_id, host_port, conflict, pending_until is not null as held
         from node_host_port_reservations order by owner_id, node_id, host_port`
      )
    ).rows.map((row) => [row.owner_id, row.node_id, row.host_port, row.conflict, row.held]);

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'upgrade');
    pool = database.pool;
    await migrateDatabase(pool, '0206_pages_preview_links');
    await q(fixture);
    await migrateDatabase(pool);
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('applies every migration after rc.10', async () => {
    const applied = await q('select count(*)::int as count from drizzle.__drizzle_migrations');
    const journal = JSON.parse(readFileSync(new URL('./migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
      entries: unknown[];
    };
    expect(applied.rows[0].count).toBe(journal.entries.length);
  });

  it('reserves every workload port once, flagging the later owner of a shared port', async () => {
    expect(await reservations()).toEqual([
      // web: 8080 and 8081 on node 1; api shares 8080 (later, flagged).
      [id('101'), node1, 8080, false, false],
      [id('101'), node1, 8081, false, false],
      [id('102'), node1, 8080, true, false],
      // Storage clusters, the deleting one included (its container may still be bound).
      [id('201'), node1, 9000, false, false],
      [id('202'), node1, 9001, false, false],
      [id('203'), node1, 9002, false, false],
      [id('204'), node1, 9003, false, false],
      // orders was given the storage cluster's S3 port (later, flagged); cache holds 8081 on node 2.
      [id('401'), node1, 9000, true, false],
      [id('403'), node2, 8081, false, false],
      // web's replica on node 2 binds its route ports there; 8081 is cache's (flagged). None on web's own node.
      [id('1102'), node2, 8080, false, false],
      [id('1102'), node2, 8081, true, false],
    ]);
    const audit = await q(
      "select details->>'ownerId' as owner, (details->>'hostPort')::int as port from audit_log where action = 'node.host_port_conflict' order by 1, 2"
    );
    expect(audit.rows).toEqual([
      { owner: id('102'), port: 8080 },
      { owner: id('401'), port: 9000 },
      { owner: id('1102'), port: 8081 },
    ]);
  });

  it('keeps the reconcile a no-op on the upgraded data', async () => {
    const before = await reservations();
    const released = await q('select node_host_port_reservations_reconcile() as released');
    expect(released.rows[0].released).toBe(0);
    expect(await reservations()).toEqual(before);
  });

  it('records proxy host names per node with the later duplicate as a legacy conflict', async () => {
    const rows = await q(
      'select proxy_host_id, node_id, domain, enabled, legacy_conflict from proxy_host_domains order by 1, 3'
    );
    expect(
      rows.rows.map((row) => [row.proxy_host_id, row.node_id, row.domain, row.enabled, row.legacy_conflict])
    ).toEqual([
      [id('501'), node1, 'app.example.com', true, false],
      [id('501'), node1, 'www.example.com', true, false],
      [id('502'), node1, 'app.example.com', true, true],
      [id('503'), node1, 'app.example.com', false, false],
      [id('504'), node2, 'app.example.com', true, false],
    ]);
  });

  it('keeps the running backup and restore, supersedes the others and keeps the running run’s lease', async () => {
    const runs = await q('select id, status, phase from backup_runs order by id');
    expect(runs.rows).toEqual([
      { id: id('901'), status: 'failed', phase: 'superseded' },
      { id: id('902'), status: 'running', phase: 'queued' },
      { id: id('903'), status: 'failed', phase: 'superseded' },
      { id: id('911'), status: 'failed', phase: 'superseded' },
      { id: id('912'), status: 'running', phase: 'queued' },
    ]);
    expect((await q('select run_id from backup_run_node_leases')).rows).toEqual([{ run_id: id('902') }]);
  });

  it('renames the later same-name storage cluster and its connection, and leaves the deleting one', async () => {
    const clusters = await q('select id, name from managed_storage_clusters order by id');
    expect(clusters.rows).toEqual([
      { id: id('201'), name: 'artifacts' },
      { id: id('202'), name: 'artifacts-3' },
      { id: id('203'), name: 'artifacts-2' },
      { id: id('204'), name: 'artifacts' },
    ]);
    expect((await q('select name from object_storage_connections where id = $1', [id('301')])).rows).toEqual([
      { name: 'artifacts-3' },
    ]);
  });

  it('refuses deleting a certificate a host serves and drops settings-row leases', async () => {
    const refused = await q('delete from ssl_certificates where id = $1', [id('601')]).then(
      () => null,
      (error: { code?: string }) => error.code
    );
    expect(['23001', '23503']).toContain(refused);
    const settings = await q(
      "select key from settings where key like 'operation-lease:%' or key = 'rc10-upgrade-setting'"
    );
    expect(settings.rows).toEqual([{ key: 'rc10-upgrade-setting' }]);
    expect((await q("select to_regclass('public.operation_leases') as name")).rows[0].name).toBe('operation_leases');
  });

  it('enforces the new guarantees for writes after the upgrade', async () => {
    const violation = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: { code?: string; constraint?: string }) => error.constraint
      );
    expect(
      await violation(
        q(
          `insert into managed_database_instances (node_id, name, slug, type, version, image_ref, engine_config,
             encrypted_owner_credentials, storage_size_bytes, published_port, created_by_id)
           values ($1, 'late', 'late', 'postgres', '17', 'img', '{}', 'x', 1, 8081, $2)`,
          [node1, id('2')]
        )
      )
    ).toBe('node_host_port_reservations_port_unique');
    expect(
      await violation(
        q(
          `insert into proxy_hosts (node_id, domain_names, slug, enabled, created_by_id)
           values ($1, '["WWW.example.com"]', 'late-host', true, $2)`,
          [node1, id('2')]
        )
      )
    ).toBe('proxy_host_domains_node_domain_unique');
    expect(
      await violation(
        q(
          `insert into backup_runs (policy_id, destination_id, destination_bucket, destination_prefix, timezone,
             executor_node_id, direction, engine, status, request_fingerprint)
           values ($1, $2, 'b', 'p', 'UTC', $3, 'backup', 'postgres', 'queued', 'late')`,
          [id('801'), id('702'), node1]
        )
      )
    ).toBe('backup_runs_policy_active_unique');
  });
});
