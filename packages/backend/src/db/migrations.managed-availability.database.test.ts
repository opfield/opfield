import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureLeaseState } from '@/modules/docker/availability/lease/lease-store.js';
import { disposableDatabase, migrateDatabase, pgError, rejection } from './migration-database.test-helpers.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const fixture = readFileSync(new URL('./fixtures/rc10-upgrade.sql', import.meta.url), 'utf8');

/** The fixed ids of fixtures/rc10-upgrade.sql, plus this suite's own rows. */
const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const node1 = id('11');
const node2 = id('12');
const webPolicy = id('1001');
const ordersDb = id('401');
const eventsDb = id('402');
const storage = id('202');
const relay = id('3001');

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): a 2.11.4 install (schema through 0236) with an Availability policy in
 * lease mode upgraded through 0240_managed_availability.
 */
describe.skipIf(!url)('0240 managed availability on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const violation = async (promise: Promise<unknown>) => pgError(await rejection(promise))?.constraint;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'managed_availability');
    pool = database.pool;
    await migrateDatabase(pool, '0206_pages_preview_links');
    await q(fixture);
    await migrateDatabase(pool, '0236_secure_link_loopback_slot');
    await q(
      `insert into docker_availability_lease_state (policy_id, mode, manifest_version, voter_epoch)
       values ($1, 'lease', 7, 3)`,
      [webPolicy]
    );
    await q(
      `insert into docker_availability_lease_observations (policy_id, slot, holder_id, source, source_id, observed_at)
       values ($1, 0, $2, 'relay', 'relay-a', now())`,
      [webPolicy, node1]
    );
    await q(
      `insert into relay_instances (id, pool_id, kind, fault_domain_id, display_name)
       values ($1, 'system', 'local', $1, 'local relay')`,
      [relay]
    );
    await migrateDatabase(pool);
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('registers every Availability policy under its own id and keeps its lease state and observations', async () => {
    expect(
      (await q('select id, kind, resource_id, stateful, docker_availability_policy_id from lease_policies')).rows
    ).toEqual([
      {
        id: webPolicy,
        kind: 'docker_availability',
        resource_id: webPolicy,
        stateful: false,
        docker_availability_policy_id: webPolicy,
      },
    ]);
    const state = await q(
      'select mode, manifest_version, voter_epoch, candidate_member_ids, required_capabilities from docker_availability_lease_state'
    );
    expect(state.rows).toEqual([
      { mode: 'lease', manifest_version: '7', voter_epoch: '3', candidate_member_ids: [], required_capabilities: [] },
    ]);
    const observations = await q('select policy_id, holder_id, state_hash from docker_availability_lease_observations');
    expect(observations.rows).toEqual([{ policy_id: webPolicy, holder_id: node1, state_hash: null }]);
  });

  it('refuses lease state of an unregistered policy and deletes the lease state with the Availability policy', async () => {
    expect(
      await violation(q('insert into docker_availability_lease_state (policy_id) values ($1)', [id('9999')]))
    ).toBe('docker_availability_lease_state_policy_id_lease_policies_id_fk');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('delete from docker_availability_placements where policy_id = $1', [webPolicy]);
      await client.query('delete from docker_availability_policies where id = $1', [webPolicy]);
      for (const table of [
        'lease_policies',
        'docker_availability_lease_state',
        'docker_availability_lease_observations',
      ]) {
        expect((await client.query(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(0);
      }
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('registers an Availability policy created after the upgrade when its lease state is first used', async () => {
    const apiPolicy = id('1002');
    await q(
      `insert into docker_availability_policies (id, resource_kind, deployment_id, mode, desired_replica_count)
       values ($1, 'deployment', $2, 'failover', 1)`,
      [apiPolicy, id('102')]
    );
    const state = await ensureLeaseState(drizzle(pool) as never, apiPolicy);
    expect(state).toMatchObject({ policyId: apiPolicy, mode: 'legacy' });
    expect((await q('select kind, resource_id from lease_policies where id = $1', [apiPolicy])).rows).toEqual([
      { kind: 'docker_availability', resource_id: apiPolicy },
    ]);
    // Idempotent, and never registers an id that is no Availability policy.
    await ensureLeaseState(drizzle(pool) as never, apiPolicy);
    await expect(ensureLeaseState(drizzle(pool) as never, id('9998'))).rejects.toThrow();
    expect((await q('select count(*)::int as n from lease_policies where id = $1', [id('9998')])).rows[0].n).toBe(0);
  });

  it('starts every relay without witness hosting', async () => {
    const relays = await q(
      'select count(*)::int as n, bool_or(witness_hosting_allowed) as allowed, count(witness_hosting_local)::int as local from relay_instances'
    );
    expect(relays.rows[0].n).toBeGreaterThan(0);
    expect(relays.rows[0]).toMatchObject({ allowed: false, local: 0 });
  });

  it('keeps one set per owner, one member per node and index, and ties the set to its owner', async () => {
    const set = id('4001');
    await q(
      `insert into managed_availability_sets (id, owner_kind, owner_id, managed_database_id, engine, mode, durability)
       values ($1, 'managed_database', $2, $2, 'postgres', 'automatic', 'synchronous')`,
      [set, ordersDb]
    );
    expect(
      await violation(
        q(
          `insert into managed_availability_sets (owner_kind, owner_id, managed_database_id, engine, mode, durability)
           values ('managed_database', $1, $1, 'postgres', 'manual', 'asynchronous')`,
          [ordersDb]
        )
      )
    ).toBe('managed_availability_sets_owner_unique');
    expect(
      await violation(
        q(
          `insert into managed_availability_sets (owner_kind, owner_id, managed_database_id, engine, mode, durability)
           values ('managed_database', $1, $2, 'postgres', 'manual', 'asynchronous')`,
          [eventsDb, ordersDb]
        )
      )
    ).toBe('managed_availability_sets_owner_check');
    expect(
      await violation(
        q(
          `insert into managed_availability_sets (owner_kind, owner_id, managed_storage_cluster_id, engine, mode, durability)
           values ('managed_storage', $1, $1, 'seaweedfs', 'sideways', 'asynchronous')`,
          [storage]
        )
      )
    ).toBe('managed_availability_sets_mode_check');

    await q(`insert into managed_availability_members (set_id, node_id, member_index) values ($1, $2, 0)`, [
      set,
      node1,
    ]);
    expect(
      await violation(
        q(`insert into managed_availability_members (set_id, node_id, member_index) values ($1, $2, 1)`, [set, node1])
      )
    ).toBe('managed_availability_members_set_node_unique');
    expect(
      await violation(
        q(`insert into managed_availability_members (set_id, node_id, member_index) values ($1, $2, 0)`, [set, node2])
      )
    ).toBe('managed_availability_members_set_index_unique');
    await q(`insert into managed_availability_members (set_id, node_id, member_index) values ($1, $2, 1)`, [
      set,
      node2,
    ]);

    expect(
      await violation(
        q(
          `insert into managed_availability_witnesses (set_id, purpose, host_kind, node_id) values ($1, 'lease', 'relay', $2)`,
          [set, node1]
        )
      )
    ).toBe('managed_availability_witnesses_host_check');
    expect(
      await violation(
        q(
          `insert into managed_availability_witnesses (set_id, purpose, host_kind, relay_instance_id) values ($1, 'keeper', 'relay', $2)`,
          [set, relay]
        )
      )
    ).toBe('managed_availability_witnesses_keeper_check');
    await q(
      `insert into managed_availability_witnesses (set_id, purpose, host_kind, relay_instance_id) values ($1, 'lease', 'relay', $2)`,
      [set, relay]
    );

    const leasePolicy = id('5001');
    await q(
      `insert into lease_policies (id, kind, resource_id, stateful, managed_availability_set_id)
       values ($1, 'managed_availability_set', $2, true, $2)`,
      [leasePolicy, set]
    );
    await q('insert into docker_availability_lease_state (policy_id) values ($1)', [leasePolicy]);
    expect(
      await violation(
        q(
          `insert into lease_policies (id, kind, resource_id, managed_availability_set_id)
           values ($1, 'managed_availability_set', $2, $3)`,
          [id('5002'), id('4002'), set]
        )
      )
    ).toBe('lease_policies_owner_check');

    // Deleting the managed database deletes its set, members, witnesses, lease policies and lease state.
    await q('delete from node_host_port_reservations where owner_id = $1', [ordersDb]);
    await q('delete from managed_database_instances where id = $1', [ordersDb]);
    for (const table of [
      'managed_availability_sets',
      'managed_availability_members',
      'managed_availability_witnesses',
      "lease_policies where kind = 'managed_availability_set'",
    ]) {
      expect((await q(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(0);
    }
    expect(
      (await q('select count(*)::int as n from docker_availability_lease_state where policy_id = $1', [leasePolicy]))
        .rows[0].n
    ).toBe(0);
  });
});
