import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_GUC_PROXY_DOMAIN_CONFLICTS } from '@/lib/legacy-compat.js';
import { disposableDatabase, migrateDatabase, pgError, rejection } from './migration-database.test-helpers.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL, see migration-database.test-helpers): migration 0209 on its own
 * database: reservation holds, Availability replica reservations, the reconcile, proxy domain record mode, and the
 * managed storage name suffix.
 */
describe.skipIf(!url)('migration 0209 reservation holds on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  const user = randomUUID();
  const node1 = randomUUID();
  const node2 = randomUUID();
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);

  const reservations = async (ownerId: string) =>
    (
      await q(
        `select node_id, host_port, conflict, pending_until is not null as held
         from node_host_port_reservations where owner_id = $1 order by node_id, host_port`,
        [ownerId]
      )
    ).rows.map((row) => ({ node: row.node_id, port: row.host_port, conflict: row.conflict, held: row.held }));
  const ports = async (ownerId: string) => (await reservations(ownerId)).map((row) => row.port);
  const insertDeployment = async (nodeId: string, routes: number[]) => {
    const id = randomUUID();
    await q(
      `insert into docker_deployments (id, node_id, name, desired_config, router_name, network_name, health_config)
       values ($1, $2, gen_random_uuid()::text, '{"image":"nginx"}', 'r', 'n', '{}')`,
      [id, nodeId]
    );
    for (const port of routes) {
      await q('insert into docker_deployment_routes (deployment_id, host_port, container_port) values ($1, $2, 80)', [
        id,
        port,
      ]);
    }
    return id;
  };
  const insertDatabase = async (nodeId: string, port: number | null) => {
    const id = randomUUID();
    await q(
      `insert into managed_database_instances (id, node_id, name, slug, type, version, image_ref, engine_config,
         encrypted_owner_credentials, storage_size_bytes, published_port, created_by_id)
       values ($1, $2, gen_random_uuid()::text, gen_random_uuid()::text, 'postgres', '17', 'img', '{}', 'x', 1, $3, $4)`,
      [id, nodeId, port, user]
    );
    return id;
  };
  const insertStorage = async (nodeId: string, name: string, port: number, status = 'ready', connectionId?: string) => {
    const id = randomUUID();
    await q(
      `insert into managed_storage_clusters (id, node_id, name, slug, version, image_ref, encrypted_root_credentials,
         storage_size_bytes, published_port, publish_s3, status, object_storage_connection_id, created_by_id)
       values ($1, $2, $3, gen_random_uuid()::text, '1', 'img', 'x', 1, $4, true, $5, $6, $7)`,
      [id, nodeId, name, port, status, connectionId ?? null, user]
    );
    return id;
  };
  const insertHost = async (nodeId: string, domains: string[], enabled: boolean) => {
    const id = randomUUID();
    await q(
      `insert into proxy_hosts (id, node_id, domain_names, slug, enabled, created_by_id)
       values ($1, $2, $3::jsonb, gen_random_uuid()::text, $4, $5)`,
      [id, nodeId, JSON.stringify(domains), enabled, user]
    );
    return id;
  };
  const domainRows = async (hostId: string) =>
    (
      await q(
        'select domain, enabled, legacy_conflict from proxy_host_domains where proxy_host_id = $1 order by domain',
        [hostId]
      )
    ).rows.map((row) => [row.domain, row.enabled, row.legacy_conflict]);
  /** Runs statements in one transaction on one connection (for SET LOCAL). */
  const inTransaction = async (statements: Array<[string, unknown[]?]>) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const [text, values] of statements) await client.query(text, values ?? []);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  };

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'holds');
    pool = database.pool;
    await migrateDatabase(pool);
    const group = randomUUID();
    await q('insert into permission_groups (id, name) values ($1, $2)', [group, `holds-${group}`]);
    await q('insert into users (id, group_id, email, name) values ($1, $2, $3, $4)', [
      user,
      group,
      `${user}@holds.test`,
      'Holds test',
    ]);
    for (const nodeId of [node1, node2]) {
      await q('insert into nodes (id, hostname, slug) values ($1, gen_random_uuid()::text, gen_random_uuid()::text)', [
        nodeId,
      ]);
    }
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('has a plain lookup index on (node_id, protocol, host_port)', async () => {
    const index = await q(
      "select indexdef from pg_indexes where indexname = 'node_host_port_reservations_node_port_idx'"
    );
    expect(index.rows[0]?.indexdef).toContain('(node_id, protocol, host_port)');
    expect(index.rows[0]?.indexdef).not.toContain('WHERE');
  });

  describe('holds', () => {
    it('keeps a route change reserved before the router moves, then settles to what the routes name', async () => {
      const deployment = await insertDeployment(node1, [7400]);
      await q(
        "select node_host_port_reservations_hold('deployment', $1, $2, '{7401}', now() + interval '10 minutes')",
        [deployment, node1]
      );
      expect(await reservations(deployment)).toEqual([
        { node: node1, port: 7400, conflict: false, held: false },
        { node: node1, port: 7401, conflict: false, held: true },
      ]);
      // Another workload cannot take the held port.
      expect(pgError(await rejection(insertDatabase(node1, 7401)))).toMatchObject({
        code: '23505',
        constraint: 'node_host_port_reservations_port_unique',
      });
      // The router moved: the routes are rewritten, and the change settles.
      await inTransaction([
        ['delete from docker_deployment_routes where deployment_id = $1', [deployment]],
        [
          'insert into docker_deployment_routes (deployment_id, host_port, container_port) values ($1, 7401, 80)',
          [deployment],
        ],
        ["select node_host_port_reservations_settle('deployment', $1)", [deployment]],
      ]);
      expect(await reservations(deployment)).toEqual([{ node: node1, port: 7401, conflict: false, held: false }]);
    });

    it('gives the held ports back when the router refuses the change', async () => {
      const deployment = await insertDeployment(node1, [7410]);
      await q(
        "select node_host_port_reservations_hold('deployment', $1, $2, '{7411}', now() + interval '10 minutes')",
        [deployment, node1]
      );
      await q("select node_host_port_reservations_settle('deployment', $1)", [deployment]);
      expect(await ports(deployment)).toEqual([7410]);
    });

    it('holds a database move old and new until the daemon answers, and restores the old port on failure', async () => {
      const database = await insertDatabase(node1, 7420);
      // Update claim: the old port is held, the claim writes the new one.
      await inTransaction([
        [
          "select node_host_port_reservations_hold('managed_database', $1, $2, '{7420}', now() + interval '1 hour')",
          [database, node1],
        ],
        ['update managed_database_instances set published_port = 7421 where id = $1', [database]],
      ]);
      expect(await reservations(database)).toEqual([
        { node: node1, port: 7420, conflict: false, held: true },
        { node: node1, port: 7421, conflict: false, held: false },
      ]);
      expect(pgError(await rejection(insertDatabase(node1, 7420)))).toMatchObject({ code: '23505' });
      // The daemon failed: the old port is restored and the change settles.
      await inTransaction([
        ['update managed_database_instances set published_port = 7420 where id = $1', [database]],
        ["select node_host_port_reservations_settle('managed_database', $1)", [database]],
      ]);
      expect(await reservations(database)).toEqual([{ node: node1, port: 7420, conflict: false, held: false }]);

      // A move the daemon confirms settles to the new port only.
      await inTransaction([
        [
          "select node_host_port_reservations_hold('managed_database', $1, $2, '{7420}', now() + interval '1 hour')",
          [database, node1],
        ],
        ['update managed_database_instances set published_port = 7422 where id = $1', [database]],
      ]);
      await q("select node_host_port_reservations_settle('managed_database', $1)", [database]);
      expect(await ports(database)).toEqual([7422]);
    });

    it('releases holds with the owner and on a node the owner left', async () => {
      const deployment = await insertDeployment(node1, [7430]);
      await q("select node_host_port_reservations_hold('deployment', $1, $2, '{7431}', now() + interval '1 hour')", [
        deployment,
        node1,
      ]);
      await q('update docker_deployments set node_id = $2 where id = $1', [deployment, node2]);
      expect(await reservations(deployment)).toEqual([{ node: node2, port: 7430, conflict: false, held: false }]);
      await q('delete from docker_deployments where id = $1', [deployment]);
      expect(await reservations(deployment)).toEqual([]);
    });
  });

  describe('Availability replicas', () => {
    const insertPolicy = async (deploymentId: string) => {
      const id = randomUUID();
      await q(
        `insert into docker_availability_policies (id, resource_kind, deployment_id, mode, desired_replica_count)
         values ($1, 'deployment', $2, 'failover', 1)`,
        [id, deploymentId]
      );
      return id;
    };
    const insertPlacement = async (policyId: string, nodeId: string) => {
      const id = randomUUID();
      await q(
        `insert into docker_availability_placements (id, policy_id, node_id, generation, spec_fingerprint)
         values ($1, $2, $3, 1, 'spec')`,
        [id, policyId, nodeId]
      );
      return id;
    };

    it('reserves the route ports on every placement node but the deployment’s own, and follows route changes', async () => {
      const deployment = await insertDeployment(node1, [7500, 7501]);
      const policy = await insertPolicy(deployment);
      const home = await insertPlacement(policy, node1);
      const replica = await insertPlacement(policy, node2);
      expect(await reservations(home)).toEqual([]);
      expect(await ports(replica)).toEqual([7500, 7501]);
      expect((await reservations(replica)).every((row) => row.node === node2)).toBe(true);
      // A workload on the replica's node can no longer take the port the replica binds on failover.
      expect(pgError(await rejection(insertDatabase(node2, 7500)))).toMatchObject({ code: '23505' });

      await q('delete from docker_deployment_routes where deployment_id = $1 and host_port = 7501', [deployment]);
      expect(await ports(replica)).toEqual([7500]);
      await q('delete from docker_availability_placements where id = $1', [replica]);
      expect(await reservations(replica)).toEqual([]);
    });

    it('records a replica port another workload already holds as a conflict instead of refusing the placement', async () => {
      const deployment = await insertDeployment(node1, [7510]);
      const holder = await insertDatabase(node2, 7510);
      const replica = await insertPlacement(await insertPolicy(deployment), node2);
      expect(await reservations(replica)).toEqual([{ node: node2, port: 7510, conflict: true, held: false }]);
      expect(await reservations(holder)).toEqual([{ node: node2, port: 7510, conflict: false, held: false }]);
    });

    it('drops the replica reservation when the deployment moves onto the replica’s node', async () => {
      const deployment = await insertDeployment(node1, [7520]);
      const replica = await insertPlacement(await insertPolicy(deployment), node2);
      expect(await ports(replica)).toEqual([7520]);
      await q('update docker_deployments set node_id = $2 where id = $1', [deployment, node2]);
      expect(await reservations(replica)).toEqual([]);
      expect(await reservations(deployment)).toEqual([{ node: node2, port: 7520, conflict: false, held: false }]);
    });
  });

  describe('reconcile', () => {
    it('releases orphans, re-records named ports and gives a freed port to its earliest conflicting holder', async () => {
      const orphan = randomUUID();
      await q(
        `insert into node_host_port_reservations (node_id, host_port, owner_kind, owner_id) values ($1, 7600, 'deployment', $2)`,
        [node1, orphan]
      );
      const database = await insertDatabase(node1, 7601);
      await q('delete from node_host_port_reservations where owner_id = $1', [database]);
      // Two conflicting reservations of 7602 whose holder is gone.
      const first = await insertDatabase(node1, null);
      const second = await insertDatabase(node1, null);
      await q(
        `insert into node_host_port_reservations (node_id, host_port, owner_kind, owner_id, conflict, created_at)
         values ($1, 7602, 'managed_database', $2, true, now() - interval '2 minutes'),
                ($1, 7602, 'managed_database', $3, true, now() - interval '1 minute')`,
        [node1, first, second]
      );
      await q('update managed_database_instances set published_port = 7602 where id in ($1, $2)', [first, second]);

      const released = await q('select node_host_port_reservations_reconcile() as released');
      expect(released.rows[0].released).toBeGreaterThanOrEqual(1);
      expect(await reservations(orphan)).toEqual([]);
      expect(await reservations(database)).toEqual([{ node: node1, port: 7601, conflict: false, held: false }]);
      expect(await reservations(first)).toEqual([{ node: node1, port: 7602, conflict: false, held: false }]);
      expect(await reservations(second)).toEqual([{ node: node1, port: 7602, conflict: true, held: false }]);
    });
  });

  describe('proxy host domains', () => {
    it('restores a legacy duplicate in record mode instead of failing the rollback', async () => {
      await insertHost(node1, ['legacy.example.com'], true);
      // A duplicate that predates the index, flagged the way 0207's backfill flags it.
      const legacy = await insertHost(node1, ['legacy.example.com'], false);
      await q('update proxy_host_domains set legacy_conflict = true where proxy_host_id = $1', [legacy]);
      await q('update proxy_hosts set enabled = true where id = $1', [legacy]);
      expect(await domainRows(legacy)).toEqual([['legacy.example.com', true, true]]);

      // Disabling and enabling again keeps the legacy flag: only `enabled` changes.
      await q('update proxy_hosts set enabled = false where id = $1', [legacy]);
      expect(await domainRows(legacy)).toEqual([['legacy.example.com', false, true]]);
      await q('update proxy_hosts set enabled = true where id = $1', [legacy]);
      expect(await domainRows(legacy)).toEqual([['legacy.example.com', true, true]]);

      // A domain change rebuilds the rows and is refused; the rollback restoring them is recorded.
      expect(
        pgError(
          await rejection(
            q(`update proxy_hosts set domain_names = '["LEGACY.example.com", "x.example.com"]' where id = $1`, [legacy])
          )
        )
      ).toMatchObject({ code: '23505', constraint: 'proxy_host_domains_node_domain_unique' });
      await inTransaction([
        ["select set_config($1, 'record', true)", [LEGACY_GUC_PROXY_DOMAIN_CONFLICTS]],
        [`update proxy_hosts set domain_names = '["legacy.example.com", "x.example.com"]' where id = $1`, [legacy]],
      ]);
      expect(await domainRows(legacy)).toEqual([
        ['legacy.example.com', true, true],
        ['x.example.com', true, false],
      ]);
    });

    it('records a name another host took meanwhile when a failed disable is rolled back', async () => {
      const host = await insertHost(node1, ['taken.example.com'], true);
      await q('update proxy_hosts set enabled = false where id = $1', [host]);
      // Another host claims the name the disable freed.
      await insertHost(node1, ['taken.example.com'], true);
      expect(pgError(await rejection(q('update proxy_hosts set enabled = true where id = $1', [host])))).toMatchObject({
        code: '23505',
      });
      await inTransaction([
        ["select set_config($1, 'record', true)", [LEGACY_GUC_PROXY_DOMAIN_CONFLICTS]],
        ['update proxy_hosts set enabled = true where id = $1', [host]],
      ]);
      expect(await domainRows(host)).toEqual([['taken.example.com', true, true]]);
    });
  });

  describe('managed storage names', () => {
    it('gives a cluster leaving deleting the first free suffix, with its connection and an audit entry', async () => {
      const connection = randomUUID();
      await q(
        `insert into object_storage_connections (id, name, slug, provider, encrypted_config, created_by_id)
         values ($1, 'media', gen_random_uuid()::text, 'seaweedfs', 'x', $2)`,
        [connection, user]
      );
      const deleting = await insertStorage(node1, 'media', 7700, 'deleting', connection);
      await insertStorage(node1, 'media', 7701);
      await insertStorage(node1, 'media-2', 7702);
      // The failed delete cannot take its name back.
      expect(
        pgError(await rejection(q("update managed_storage_clusters set status = 'error' where id = $1", [deleting])))
      ).toMatchObject({ code: '23505', constraint: 'managed_storage_clusters_node_name_active_unique' });

      const renamed = await q("select managed_storage_cluster_take_free_name($1, 'delete failed') as name", [deleting]);
      expect(renamed.rows[0].name).toBe('media-3');
      await q("update managed_storage_clusters set status = 'error' where id = $1", [deleting]);
      expect((await q('select name from object_storage_connections where id = $1', [connection])).rows[0].name).toBe(
        'media-3'
      );
      const audit = await q(
        "select details from audit_log where action = 'storage.managed.renamed_duplicate' and resource_id = $1",
        [deleting]
      );
      expect(audit.rows).toEqual([
        { details: expect.objectContaining({ previousName: 'media', name: 'media-3', reason: 'delete failed' }) },
      ]);
    });
  });
});
