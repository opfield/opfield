import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_GUC_HOST_PORT_CONFLICTS, LEGACY_LOCK_MIGRATIONS } from '@/lib/legacy-compat.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

/** The migrations up to and including `lastTag`, in a folder drizzle's migrator can read. */
function migrationsThrough(lastTag: string): string {
  const folder = mkdtempSync(join(tmpdir(), `${LEGACY_LOCK_MIGRATIONS}-`));
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  const entries = journal.entries.slice(0, last + 1);
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const file of readdirSync(migrationsFolder).filter((name) => name.endsWith('.sql'))) {
    if (entries.some((entry) => `${entry.tag}.sql` === file))
      copyFileSync(join(migrationsFolder, file), join(folder, file));
  }
  return folder;
}

function pgError(error: unknown): { code?: string; constraint?: string; detail?: string } {
  const candidate = error as { code?: string; cause?: unknown };
  return (candidate?.code ? candidate : candidate?.cause) as { code?: string; constraint?: string; detail?: string };
}

async function expectViolation(promise: Promise<unknown>, code: string | string[], constraint: string) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error, `expected ${code} on ${constraint}`).toBeDefined();
  const actual = pgError(error);
  expect(actual).toMatchObject({ constraint });
  expect([code].flat()).toContain(actual.code);
}

/**
 * Opt-in: point OPFIELD_MIGRATION_TEST_DATABASE_URL at a disposable local database named opfield_migration_test_*.
 * The test drops and recreates its schema, migrates to 0206, seeds the collisions 0207 must survive, then migrates.
 */
describe.skipIf(!url)('migration 0207 uniqueness guarantees on disposable PostgreSQL', () => {
  let pool: pg.Pool;
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const id = {
    group: randomUUID(),
    user: randomUUID(),
    node1: randomUUID(),
    node2: randomUUID(),
    deployment1: randomUUID(),
    deployment2: randomUUID(),
    storage1: randomUUID(),
    storage2: randomUUID(),
    storage3: randomUUID(),
    storageDeleting: randomUUID(),
    storageFtp: randomUUID(),
    storageConnection2: randomUUID(),
    database1: randomUUID(),
    database2: randomUUID(),
    host1: randomUUID(),
    host2: randomUUID(),
    host3: randomUUID(),
    host4: randomUUID(),
    cert: randomUUID(),
    connection: randomUUID(),
    destination: randomUUID(),
    policy: randomUUID(),
    run1: randomUUID(),
    run2: randomUUID(),
    run3: randomUUID(),
    restore1: randomUUID(),
    restore2: randomUUID(),
    restore3: randomUUID(),
  };

  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const insertDeployment = (deploymentId: string, nodeId: string, name: string, createdAt: string) =>
    q(
      `insert into docker_deployments (id, node_id, name, desired_config, router_name, network_name, health_config, created_at)
       values ($1, $2, $3, '{"image":"nginx"}', $3 || '-router', $3 || '-net', '{}', $4)`,
      [deploymentId, nodeId, name, createdAt]
    );
  const insertRoute = (deploymentId: string, hostPort: number) =>
    q('insert into docker_deployment_routes (deployment_id, host_port, container_port) values ($1, $2, 80)', [
      deploymentId,
      hostPort,
    ]);
  const insertStorage = (
    clusterId: string,
    nodeId: string,
    name: string,
    port: number,
    createdAt: string,
    extra: { status?: string; publishS3?: boolean; connectionId?: string | null } = {}
  ) =>
    q(
      `insert into managed_storage_clusters (id, node_id, name, slug, version, image_ref, encrypted_root_credentials,
         storage_size_bytes, published_port, publish_s3, status, object_storage_connection_id, created_by_id, created_at)
       values ($1, $2, $3, gen_random_uuid()::text, '1', 'img', 'x', 1, $4, $5, $6, $7, $8, $9)`,
      [
        clusterId,
        nodeId,
        name,
        port,
        extra.publishS3 ?? true,
        extra.status ?? 'ready',
        extra.connectionId ?? null,
        id.user,
        createdAt,
      ]
    );
  const insertDatabase = (databaseId: string, nodeId: string, port: number | null, createdAt: string) =>
    q(
      `insert into managed_database_instances (id, node_id, name, slug, type, version, image_ref, engine_config,
         encrypted_owner_credentials, storage_size_bytes, published_port, created_by_id, created_at)
       values ($1, $2, gen_random_uuid()::text, gen_random_uuid()::text, 'postgres', '17', 'img', '{}', 'x', 1, $3, $4, $5)`,
      [databaseId, nodeId, port, id.user, createdAt]
    );
  const insertHost = (
    hostId: string,
    nodeId: string,
    domains: string[],
    enabled: boolean,
    createdAt: string,
    certificateId: string | null = null
  ) =>
    q(
      `insert into proxy_hosts (id, node_id, domain_names, slug, enabled, ssl_certificate_id, created_by_id, created_at)
       values ($1, $2, $3::jsonb, gen_random_uuid()::text, $4, $5, $6, $7)`,
      [hostId, nodeId, JSON.stringify(domains), enabled, certificateId, id.user, createdAt]
    );
  const insertRun = (
    runId: string,
    direction: 'backup' | 'restore',
    status: string,
    createdAt: string,
    restoreTarget: Record<string, unknown> | null = null
  ) =>
    q(
      `insert into backup_runs (id, policy_id, database_connection_id, destination_id, destination_bucket,
         destination_prefix, timezone, executor_node_id, direction, engine, status, request_fingerprint, restore_target,
         created_at)
       values ($1, $2, $3, $4, 'b', 'p', 'UTC', $5, $6, 'postgres', $7, gen_random_uuid()::text, $8::jsonb, $9)`,
      [
        runId,
        direction === 'backup' ? id.policy : null,
        id.connection,
        id.destination,
        id.node1,
        direction,
        status,
        restoreTarget ? JSON.stringify(restoreTarget) : null,
        createdAt,
      ]
    );
  const reservations = async (ownerId: string) =>
    (
      await q(
        'select node_id, host_port, conflict from node_host_port_reservations where owner_id = $1 order by host_port',
        [ownerId]
      )
    ).rows.map((row) => ({ nodeId: row.node_id, port: row.host_port, conflict: row.conflict }));

  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !['127.0.0.1', 'localhost'].includes(target.hostname) ||
      !/^\/opfield_migration_test_[a-z0-9_]+$/.test(target.pathname)
    ) {
      throw new Error('Migration DB tests require a local, dedicated opfield_migration_test_* database');
    }
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await q('drop schema if exists drizzle cascade');
    await q('drop schema public cascade');
    await q('create schema public');
    const db = drizzle(pool);
    const before = migrationsThrough('0206_pages_preview_links');
    try {
      await migrate(db, { migrationsFolder: before });
    } finally {
      rmSync(before, { recursive: true, force: true });
    }

    await q('insert into permission_groups (id, name) values ($1, $2)', [id.group, `migration-${id.group}`]);
    await q('insert into users (id, group_id, email, name) values ($1, $2, $3, $4)', [
      id.user,
      id.group,
      `${id.user}@migration.test`,
      'Migration test',
    ]);
    for (const nodeId of [id.node1, id.node2]) {
      await q('insert into nodes (id, hostname, slug) values ($1, gen_random_uuid()::text, gen_random_uuid()::text)', [
        nodeId,
      ]);
    }
    // Two deployments already route host port 8080 on node 1.
    await insertDeployment(id.deployment1, id.node1, 'web', at(0));
    await insertRoute(id.deployment1, 8080);
    await insertRoute(id.deployment1, 8081);
    await insertDeployment(id.deployment2, id.node1, 'api', at(1));
    await insertRoute(id.deployment2, 8080);
    // Three clusters named "artifacts" on node 1 (one deleting), and an "artifacts-2" already taken.
    await q(
      `insert into object_storage_connections (id, name, slug, provider, encrypted_config, created_by_id)
       values ($1, 'artifacts', gen_random_uuid()::text, 'seaweedfs', 'x', $2)`,
      [id.storageConnection2, id.user]
    );
    await insertStorage(id.storage1, id.node1, 'artifacts', 9000, at(2));
    await insertStorage(id.storage2, id.node1, 'artifacts', 9001, at(3), { connectionId: id.storageConnection2 });
    await insertStorage(id.storage3, id.node1, 'artifacts-2', 9002, at(4));
    await insertStorage(id.storageDeleting, id.node1, 'artifacts', 9003, at(5), { status: 'deleting' });
    // An unpublished S3 port is not bound; FTP control and passive ports are.
    await insertStorage(id.storageFtp, id.node1, 'files', 8081, at(6), { publishS3: false });
    await q(
      `update managed_storage_clusters set ftp_enabled = true, ftp_port = 2121, ftp_passive_port_start = 30000,
         ftp_passive_port_count = 3 where id = $1`,
      [id.storageFtp]
    );
    // A managed database created later on the storage's S3 port.
    await insertDatabase(id.database1, id.node1, 9000, at(7));
    await insertDatabase(id.database2, id.node1, null, at(8));
    // Two enabled hosts serve app.example.com on node 1; a disabled one and one on node 2 do not collide.
    await q(`insert into ssl_certificates (id, name, type, created_by_id) values ($1, 'app', 'upload', $2)`, [
      id.cert,
      id.user,
    ]);
    await insertHost(id.host1, id.node1, ['App.example.com', 'www.example.com'], true, at(0), id.cert);
    await insertHost(id.host2, id.node1, [' app.example.com '], true, at(1));
    await insertHost(id.host3, id.node1, ['app.example.com'], false, at(2));
    await insertHost(id.host4, id.node2, ['app.example.com'], true, at(3));
    // Three active backups of one policy and two active restores into one new database name.
    await q(
      `insert into database_connections (id, name, slug, type, host, port, encrypted_config, created_by_id)
       values ($1, 'orders', gen_random_uuid()::text, 'postgres', 'db', 5432, 'x', $2)`,
      [id.connection, id.user]
    );
    await q(
      `insert into object_storage_connections (id, name, slug, provider, encrypted_config, created_by_id)
       values ($1, 'backups', gen_random_uuid()::text, 'aws', 'x', $2)`,
      [id.destination, id.user]
    );
    await q(
      `insert into backup_policies (id, database_connection_id, destination_id, bucket, prefix, executor_node_id, limits)
       values ($1, $2, $3, 'b', 'p', $4, '{}')`,
      [id.policy, id.connection, id.destination, id.node1]
    );
    await insertRun(id.run1, 'backup', 'queued', at(0));
    await insertRun(id.run2, 'backup', 'running', at(1));
    await insertRun(id.run3, 'backup', 'queued', at(2));
    await q(
      `insert into backup_run_node_leases (executor_node_id, run_id, expires_at) values ($1, $2, now() + interval '1 hour')`,
      [id.node1, id.run2]
    );
    await insertRun(id.restore1, 'restore', 'queued', at(0), { newManagedDatabaseName: 'copy' });
    await insertRun(id.restore2, 'restore', 'running', at(1), { newManagedDatabaseName: 'copy' });
    await insertRun(id.restore3, 'restore', 'queued', at(2), { newManagedDatabaseName: 'other' });

    await migrate(db, { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  describe('backfill', () => {
    it('reserves every workload port and flags later owners of a shared port as conflicting', async () => {
      expect(await reservations(id.deployment1)).toEqual([
        { nodeId: id.node1, port: 8080, conflict: false },
        { nodeId: id.node1, port: 8081, conflict: false },
      ]);
      expect(await reservations(id.deployment2)).toEqual([{ nodeId: id.node1, port: 8080, conflict: true }]);
      expect(await reservations(id.storage1)).toEqual([{ nodeId: id.node1, port: 9000, conflict: false }]);
      expect(await reservations(id.database1)).toEqual([{ nodeId: id.node1, port: 9000, conflict: true }]);
      // A cluster being deleted can still have a container bound to its port.
      expect(await reservations(id.storageDeleting)).toEqual([{ nodeId: id.node1, port: 9003, conflict: false }]);
      expect((await reservations(id.storageFtp)).map((row) => row.port)).toEqual([2121, 30000, 30001, 30002]);
      expect(await reservations(id.database2)).toEqual([]);
      const audit = await q(
        "select details from audit_log where action = 'node.host_port_conflict' order by details->>'hostPort'"
      );
      expect(audit.rows.map((row) => [row.details.hostPort, row.details.ownerId, row.details.heldById])).toEqual([
        [8080, id.deployment2, id.deployment1],
        [9000, id.database1, id.storage1],
      ]);
    });

    it('records normalized proxy host domains and flags later enabled duplicates as legacy conflicts', async () => {
      const rows = await q(
        'select proxy_host_id, node_id, domain, enabled, legacy_conflict from proxy_host_domains order by proxy_host_id, domain'
      );
      const byHost = (hostId: string) =>
        rows.rows
          .filter((row) => row.proxy_host_id === hostId)
          .map((row) => [row.domain, row.enabled, row.legacy_conflict]);
      expect(byHost(id.host1)).toEqual([
        ['app.example.com', true, false],
        ['www.example.com', true, false],
      ]);
      expect(byHost(id.host2)).toEqual([['app.example.com', true, true]]);
      expect(byHost(id.host3)).toEqual([['app.example.com', false, false]]);
      expect(byHost(id.host4)).toEqual([['app.example.com', true, false]]);
      const audit = await q("select resource_id, details from audit_log where action = 'proxy_host.domain_conflict'");
      expect(audit.rows).toEqual([
        {
          resource_id: id.host2,
          details: expect.objectContaining({ domain: 'app.example.com', servedByProxyHostId: id.host1 }),
        },
      ]);
    });

    it('keeps the running (else newest) active backup and restore and fails the others with a clear message', async () => {
      const runs = await q('select id, status, phase, sanitized_error, runtime_cleanup_pending from backup_runs');
      const run = (runId: string) => runs.rows.find((row) => row.id === runId);
      // run2 is running: it is kept over the newer queued run3, whose runner never started.
      for (const superseded of [id.run1, id.run3, id.restore1]) {
        expect(run(superseded)).toMatchObject({
          status: 'failed',
          phase: 'superseded',
          sanitized_error: expect.stringContaining('already queued or running'),
          runtime_cleanup_pending: true,
        });
      }
      expect(run(id.run2)).toMatchObject({ status: 'running' });
      expect(run(id.restore2)).toMatchObject({ status: 'running' });
      expect(run(id.restore3)).toMatchObject({ status: 'queued' });
      // The kept running run keeps its executor lease.
      expect((await q('select run_id from backup_run_node_leases')).rows).toEqual([{ run_id: id.run2 }]);
      expect(
        (await q("select count(*)::int as count from audit_log where action = 'database.backup.superseded'")).rows[0]
      ).toEqual({ count: 3 });
    });

    it('suffixes later same-name storage clusters past names already in use, with their connection', async () => {
      const clusters = await q('select id, name from managed_storage_clusters');
      const name = (clusterId: string) => clusters.rows.find((row) => row.id === clusterId)?.name;
      expect(name(id.storage1)).toBe('artifacts');
      expect(name(id.storage2)).toBe('artifacts-3');
      expect(name(id.storage3)).toBe('artifacts-2');
      expect(name(id.storageDeleting)).toBe('artifacts');
      expect(
        (await q('select name from object_storage_connections where id = $1', [id.storageConnection2])).rows[0]
      ).toEqual({ name: 'artifacts-3' });
      const audit = await q(
        "select resource_id, details from audit_log where action = 'storage.managed.renamed_duplicate'"
      );
      expect(audit.rows).toEqual([
        {
          resource_id: id.storage2,
          details: expect.objectContaining({ previousName: 'artifacts', name: 'artifacts-3' }),
        },
      ]);
    });
  });

  describe('host port reservations', () => {
    it('refuses a port another workload holds with a unique violation, and reserves free ports', async () => {
      const deploymentId = randomUUID();
      await insertDeployment(deploymentId, id.node1, `dep-${deploymentId}`, at(20));
      await expectViolation(insertRoute(deploymentId, 9001), '23505', 'node_host_port_reservations_port_unique');
      await insertRoute(deploymentId, 7000);
      expect(await reservations(deploymentId)).toEqual([{ nodeId: id.node1, port: 7000, conflict: false }]);
      // The same port on another node is free.
      await insertDatabase(randomUUID(), id.node2, 7000, at(21));
    });

    it('still refuses a port whose only holder is a conflicting legacy reservation', async () => {
      const clusterId = randomUUID();
      // 8080: deployment 1 holds it, deployment 2 is the legacy conflict. Once deployment 1 releases it,
      // deployment 2 still binds it, so it is not free.
      await q('delete from docker_deployment_routes where deployment_id = $1 and host_port = 8080', [id.deployment1]);
      expect(await reservations(id.deployment1)).toEqual([{ nodeId: id.node1, port: 8081, conflict: false }]);
      await expectViolation(
        insertStorage(clusterId, id.node1, `legacy-${clusterId}`, 8080, at(22)),
        '23505',
        'node_host_port_reservations_port_unique'
      );
    });

    it('lets only one of two concurrent reservations of a port commit', async () => {
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        const deploymentId = randomUUID();
        const databaseId = randomUUID();
        await first.query('begin');
        await first.query(
          `insert into docker_deployments (id, node_id, name, desired_config, router_name, network_name, health_config)
           values ($1, $2, gen_random_uuid()::text, '{}', 'r', 'n', '{}')`,
          [deploymentId, id.node1]
        );
        await first.query(
          'insert into docker_deployment_routes (deployment_id, host_port, container_port) values ($1, 7100, 80)',
          [deploymentId]
        );
        await second.query('begin');
        const racing = second.query(
          `insert into managed_database_instances (id, node_id, name, slug, type, version, image_ref, engine_config,
             encrypted_owner_credentials, storage_size_bytes, published_port, created_by_id)
           values ($1, $2, gen_random_uuid()::text, gen_random_uuid()::text, 'postgres', '17', 'img', '{}', 'x', 1, 7100, $3)`,
          [databaseId, id.node1, id.user]
        );
        const settled = racing.then(
          () => 'inserted',
          (error: unknown) => error
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        await first.query('commit');
        const outcome = await settled;
        expect(pgError(outcome)).toMatchObject({
          code: '23505',
          constraint: 'node_host_port_reservations_port_unique',
        });
        await second.query('rollback');
        expect(await reservations(deploymentId)).toEqual([{ nodeId: id.node1, port: 7100, conflict: false }]);
      } finally {
        first.release();
        second.release();
      }
    });

    it('reserves a route change before the router moves and releases it when the change is abandoned', async () => {
      const deploymentId = randomUUID();
      await insertDeployment(deploymentId, id.node1, `route-${deploymentId}`, at(23));
      await insertRoute(deploymentId, 7200);
      await q("select docker_deployment_host_ports_sync($1, '{7201}')", [deploymentId]);
      expect((await reservations(deploymentId)).map((row) => row.port)).toEqual([7200, 7201]);
      await expectViolation(
        insertDatabase(randomUUID(), id.node1, 7201, at(24)),
        '23505',
        'node_host_port_reservations_port_unique'
      );
      // The router refused the change: the routes still name 7200 only.
      await q('select docker_deployment_host_ports_sync($1)', [deploymentId]);
      expect((await reservations(deploymentId)).map((row) => row.port)).toEqual([7200]);
      // The router moved: the routes are rewritten in one transaction and the reservations follow them.
      await q("select docker_deployment_host_ports_sync($1, '{7201}')", [deploymentId]);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('delete from docker_deployment_routes where deployment_id = $1', [deploymentId]);
        await client.query(
          'insert into docker_deployment_routes (deployment_id, host_port, container_port) values ($1, 7201, 80), ($1, 7202, 81)',
          [deploymentId]
        );
        await client.query('commit');
      } finally {
        client.release();
      }
      expect((await reservations(deploymentId)).map((row) => row.port)).toEqual([7201, 7202]);
    });

    it('records a port the daemon already bound as conflicting in record mode instead of failing', async () => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query("select set_config($1, 'record', true)", [LEGACY_GUC_HOST_PORT_CONFLICTS]);
        await client.query('update managed_database_instances set published_port = 8081 where id = $1', [id.database2]);
        await client.query('commit');
      } finally {
        client.release();
      }
      expect(await reservations(id.database2)).toEqual([{ nodeId: id.node1, port: 8081, conflict: true }]);
      // Without record mode the same write is refused.
      const databaseId = randomUUID();
      await insertDatabase(databaseId, id.node1, null, at(25));
      await expectViolation(
        q('update managed_database_instances set published_port = 8081 where id = $1', [databaseId]),
        '23505',
        'node_host_port_reservations_port_unique'
      );
    });

    it('moves a migrated deployment to its new node and releases ports on port changes and deletes', async () => {
      const deploymentId = randomUUID();
      await insertDeployment(deploymentId, id.node1, `move-${deploymentId}`, at(26));
      await insertRoute(deploymentId, 7300);
      await insertDatabase(randomUUID(), id.node2, 7300, at(27));
      await q('update docker_deployments set node_id = $2 where id = $1', [deploymentId, id.node2]);
      expect(await reservations(deploymentId)).toEqual([{ nodeId: id.node2, port: 7300, conflict: true }]);
      await q('delete from docker_deployments where id = $1', [deploymentId]);
      expect(await reservations(deploymentId)).toEqual([]);

      await q('update managed_storage_clusters set publish_s3 = false where id = $1', [id.storage2]);
      expect(await reservations(id.storage2)).toEqual([]);
      await q('delete from managed_storage_clusters where id = $1', [id.storage3]);
      expect(await reservations(id.storage3)).toEqual([]);
    });
  });

  describe('proxy host domains', () => {
    const domains = async (hostId: string) =>
      (
        await q(
          'select node_id, domain, enabled, legacy_conflict from proxy_host_domains where proxy_host_id = $1 order by domain',
          [hostId]
        )
      ).rows.map((row) => [row.node_id, row.domain, row.enabled, row.legacy_conflict]);

    it('refuses a second enabled host for a name on a node, on create, enable and node moves', async () => {
      await expectViolation(
        insertHost(randomUUID(), id.node1, ['WWW.example.com'], true, at(30)),
        '23505',
        'proxy_host_domains_node_domain_unique'
      );
      const disabled = randomUUID();
      await insertHost(disabled, id.node1, ['www.example.com'], false, at(31));
      await expectViolation(
        q('update proxy_hosts set enabled = true where id = $1', [disabled]),
        '23505',
        'proxy_host_domains_node_domain_unique'
      );
      await expectViolation(
        q('update proxy_hosts set node_id = $2 where id = $1', [id.host4, id.node1]),
        '23505',
        'proxy_host_domains_node_domain_unique'
      );
    });

    it('keeps a legacy duplicate until its domains change, and follows disables and deletes', async () => {
      await q("update proxy_hosts set forward_host = 'upstream' where id = $1", [id.host2]);
      expect(await domains(id.host2)).toEqual([[id.node1, 'app.example.com', true, true]]);
      await expectViolation(
        q(`update proxy_hosts set domain_names = '["app.example.com","api.example.com"]' where id = $1`, [id.host2]),
        '23505',
        'proxy_host_domains_node_domain_unique'
      );
      await q('update proxy_hosts set enabled = false where id = $1', [id.host1]);
      expect(await domains(id.host1)).toEqual([
        [id.node1, 'app.example.com', false, false],
        [id.node1, 'www.example.com', false, false],
      ]);
      const moved = randomUUID();
      await insertHost(moved, id.node2, ['moved.example.com'], true, at(32));
      await q('update proxy_hosts set node_id = $2 where id = $1', [moved, id.node1]);
      expect(await domains(moved)).toEqual([[id.node1, 'moved.example.com', true, false]]);
      await q('update proxy_hosts set node_id = null where id = $1', [moved]);
      expect(await domains(moved)).toEqual([]);
      await q('delete from proxy_hosts where id = $1', [id.host3]);
      expect(await domains(id.host3)).toEqual([]);
    });
  });

  describe('active runs, storage names and certificate references', () => {
    it('allows one queued or running backup per policy and one restore per new database name', async () => {
      await expectViolation(
        insertRun(randomUUID(), 'backup', 'queued', at(40)),
        '23505',
        'backup_runs_policy_active_unique'
      );
      await insertRun(randomUUID(), 'backup', 'completed', at(41));
      await expectViolation(
        insertRun(randomUUID(), 'restore', 'queued', at(42), { newManagedDatabaseName: 'copy' }),
        '23505',
        'backup_runs_restore_new_database_active_unique'
      );
      await insertRun(randomUUID(), 'restore', 'queued', at(43), { restoreTargetConnectionId: randomUUID() });
    });

    it('allows one cluster per name on a node while a deleting cluster releases its name', async () => {
      await expectViolation(
        insertStorage(randomUUID(), id.node1, 'artifacts', 9100, at(44)),
        '23505',
        'managed_storage_clusters_node_name_active_unique'
      );
      await insertStorage(randomUUID(), id.node2, 'artifacts', 9101, at(45));
      await insertStorage(randomUUID(), id.node1, 'artifacts', 9102, at(46), { status: 'deleting' });
    });

    it('refuses to delete a certificate a proxy host still references', async () => {
      await expectViolation(
        q('delete from ssl_certificates where id = $1', [id.cert]),
        // ON DELETE RESTRICT: restrict_violation on PostgreSQL 18, foreign_key_violation before.
        ['23001', '23503'],
        'proxy_hosts_ssl_certificate_id_ssl_certificates_id_fk'
      );
    });
  });
});
