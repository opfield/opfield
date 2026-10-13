import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { relayLeasePolicyIds } from '@/modules/docker/availability/lease/lease-relay-gate.js';
import {
  memberRouteOwnerId,
  peerEndpointOwnerId,
  peerRouteOwnerId,
  reconcileSetRelayPaths,
  releaseSetRelayPaths,
} from './relay-managed-availability.js';
import { completeSetGrants } from './relay-managed-availability-grants.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): relay paths of an availability set. The resource's endpoint stays the
 * origin member's (same id and generation, no tunnel cut), every other member gets a client endpoint, every route to
 * the resource gets a member route per other member, the members get the peer mesh, lease mode gates the client and
 * primary peer endpoints, bundles carry the lease group, and turning the set off on another member converts that
 * member's paths back in place.
 */
describe.skipIf(!url)('availability set relay paths on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const [nodeA, nodeB, consumer] = [randomUUID(), randomUUID(), randomUUID()];
  const databaseId = randomUUID();
  const setId = randomUUID();
  const [memberA, memberB] = [randomUUID(), randomUUID()];
  const leasePolicyId = randomUUID();
  let anchorId = '';
  let bindingRouteId = '';
  let opfieldRouteId = '';
  const reconcile = () => db.transaction((tx) => reconcileSetRelayPaths(tx));
  const endpoint = async (ownerKind: string, ownerId: string) =>
    (
      await q(
        'select id, subject_id, status, generation from relay_endpoints where owner_kind = $1 and owner_id = $2',
        [ownerKind, ownerId]
      )
    ).rows[0];
  const route = async (ownerKind: string, ownerId: string) =>
    (
      await q(
        `select id, source_id, target_endpoint_id, parent_route_id, generation from relay_routes
         where owner_kind = $1 and owner_id = $2`,
        [ownerKind, ownerId]
      )
    ).rows[0];

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'set_relay_paths');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    for (const [index, [id, type]] of (
      [
        [nodeA, 'databases'],
        [nodeB, 'databases'],
        [consumer, 'docker'],
      ] as const
    ).entries()) {
      await q(
        `insert into nodes (id, type, hostname, slug, status, certificate_fingerprint) values ($1, $2, $3, $3, 'online', $4)`,
        [id, type, `paths-node-${index}`, `sha256:node-${index}`]
      );
    }
    const group = randomUUID();
    const user = randomUUID();
    await q('insert into permission_groups (id, name) values ($1, $2)', [group, `paths-${group}`]);
    await q('insert into users (id, group_id, email, name) values ($1, $2, $3, $4)', [
      user,
      group,
      `${user}@paths.test`,
      'Paths',
    ]);
    await q(
      `insert into managed_database_instances (id, node_id, name, slug, type, version, image_ref, engine_config,
         encrypted_owner_credentials, storage_size_bytes, published_port, status, created_by_id)
       values ($1, $2, 'orders', 'orders', 'postgres', '17', 'img', '{}', 'x', 1, null, 'ready', $3)`,
      [databaseId, nodeA, user]
    );
    anchorId = (
      await q(
        `insert into relay_endpoints (owner_kind, owner_id, subject_kind, subject_id, certificate_sha256)
         values ('managed_database', $1, 'daemon', $2, 'sha256:node-0') returning id`,
        [databaseId, nodeA]
      )
    ).rows[0].id;
    const bindingId = randomUUID();
    bindingRouteId = (
      await q(
        `insert into relay_routes (owner_kind, owner_id, source_kind, source_id, source_certificate_sha256,
           target_endpoint_id, managed_database_listener)
         values ('managed_database_binding', $1, 'daemon', $2, 'sha256:node-2', $3, $4) returning id`,
        [
          bindingId,
          consumer,
          anchorId,
          JSON.stringify({
            networkName: 'gateway-db-x',
            listenAddress: '172.30.0.1',
            listenPort: 5432,
            allowedSources: ['a'],
          }),
        ]
      )
    ).rows[0].id;
    opfieldRouteId = (
      await q(
        `insert into relay_routes (owner_kind, owner_id, source_kind, source_id, source_certificate_sha256,
           target_endpoint_id) values ('managed_database_gateway', $1, 'gateway', 'gw', 'sha256:app', $2) returning id`,
        [databaseId, anchorId]
      )
    ).rows[0].id;
    await q(
      `insert into managed_availability_sets (id, owner_kind, owner_id, managed_database_id, engine, mode, durability,
         state, primary_member_id) values ($1, 'managed_database', $2, $2, 'postgres', 'automatic', 'synchronous',
         'healthy', null)`,
      [setId, databaseId]
    );
    await q(
      `insert into managed_availability_members (id, set_id, node_id, member_index) values ($1, $2, $3, 0), ($4, $2, $5, 1)`,
      [memberA, setId, nodeA, memberB, nodeB]
    );
    await q('update managed_availability_sets set primary_member_id = $2 where id = $1', [setId, memberA]);
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('keeps the resource endpoint as the origin member, adds the other member and the peer mesh', async () => {
    expect(await reconcile()).toBe(true);
    expect(await endpoint('managed_database', databaseId)).toMatchObject({
      id: anchorId,
      subject_id: nodeA,
      status: 'active',
      generation: '1',
    });
    const clientB = await endpoint('managed_availability_member', memberB);
    expect(clientB).toMatchObject({ subject_id: nodeB, status: 'active' });
    expect(await endpoint('managed_availability_member', memberA)).toBeUndefined();
    const peerA = await endpoint('managed_availability_peer', peerEndpointOwnerId(memberA, 'pg-repl'));
    const peerB = await endpoint('managed_availability_peer', peerEndpointOwnerId(memberB, 'pg-repl'));
    expect(peerA).toMatchObject({ subject_id: nodeA });
    expect(peerB).toMatchObject({ subject_id: nodeB });
    expect(await route('managed_member_peer', peerRouteOwnerId(memberA, memberB, 'pg-repl'))).toMatchObject({
      source_id: nodeA,
      target_endpoint_id: peerB.id,
    });
    expect(await route('managed_member_peer', peerRouteOwnerId(memberB, memberA, 'pg-repl'))).toMatchObject({
      source_id: nodeB,
      target_endpoint_id: peerA.id,
    });
    const controlB = await endpoint('managed_availability_peer', peerEndpointOwnerId(memberB, 'member-control'));
    expect(await route('managed_member_peer', peerRouteOwnerId(memberA, memberB, 'member-control'))).toMatchObject({
      source_id: nodeA,
      target_endpoint_id: controlB.id,
    });
    // Backups from a copy: every member serves its engine on db-backup (never gated), with no member-to-member routes.
    expect(await endpoint('managed_availability_peer', peerEndpointOwnerId(memberB, 'db-backup'))).toMatchObject({
      subject_id: nodeB,
      status: 'active',
    });
    expect(await route('managed_member_peer', peerRouteOwnerId(memberA, memberB, 'db-backup'))).toBeUndefined();
    // Every route to the resource is repeated toward member B with the same source.
    expect(
      await route('set_member:managed_database_binding', memberRouteOwnerId(bindingRouteId, memberB))
    ).toMatchObject({ source_id: consumer, target_endpoint_id: clientB.id, parent_route_id: bindingRouteId });
    expect(
      await route('set_member:managed_database_gateway', memberRouteOwnerId(opfieldRouteId, memberB))
    ).toMatchObject({
      source_id: 'gw',
      target_endpoint_id: clientB.id,
    });
    expect(
      await route(
        'managed_database_binding',
        (await q('select owner_id from relay_routes where id = $1', [bindingRouteId])).rows[0].owner_id
      )
    ).toMatchObject({
      id: bindingRouteId,
      generation: '1',
    });
    expect(
      (await q('select relay_endpoint_id from managed_availability_members where id = $1', [memberA])).rows
    ).toEqual([{ relay_endpoint_id: anchorId }]);
    expect(await reconcile()).toBe(false);
  });

  it('gates the client and primary peer endpoints in lease mode', async () => {
    await q(
      `insert into lease_policies (id, kind, resource_id, stateful, managed_availability_set_id)
       values ($1, 'managed_availability_set', $2, true, $2)`,
      [leasePolicyId, setId]
    );
    await q(`insert into docker_availability_lease_state (policy_id, mode) values ($1, 'lease')`, [leasePolicyId]);
    await q('update managed_availability_sets set lease_policy_id = $2 where id = $1', [setId, leasePolicyId]);
    const clientB = await endpoint('managed_availability_member', memberB);
    const peerA = await endpoint('managed_availability_peer', peerEndpointOwnerId(memberA, 'pg-repl'));
    const controlA = await endpoint('managed_availability_peer', peerEndpointOwnerId(memberA, 'member-control'));
    const gate = await relayLeasePolicyIds(
      db,
      [
        { id: anchorId, ownerKind: 'managed_database', ownerId: databaseId },
        { id: clientB.id, ownerKind: 'managed_availability_member', ownerId: memberB },
        { id: peerA.id, ownerKind: 'managed_availability_peer', ownerId: peerEndpointOwnerId(memberA, 'pg-repl') },
        {
          id: controlA.id,
          ownerKind: 'managed_availability_peer',
          ownerId: peerEndpointOwnerId(memberA, 'member-control'),
        },
      ],
      []
    );
    expect(Object.fromEntries(gate.endpoints)).toEqual({
      [anchorId]: leasePolicyId,
      [clientB.id]: leasePolicyId,
      [peerA.id]: leasePolicyId,
    });
  });

  it('hands the consumer one lease group for the binding, holder candidates named, member B second', async () => {
    const routes = await db.select().from(schema.relayRoutes);
    const endpoints = await db.select().from(schema.relayEndpoints);
    const memberRoute = await route('set_member:managed_database_binding', memberRouteOwnerId(bindingRouteId, memberB));
    const grants = [
      {
        role: 'connect',
        ownerKind: 'managed_database_binding',
        ownerId: 'b',
        routeId: bindingRouteId,
        targetEndpointId: anchorId,
        grant: 'g-a',
      },
      {
        role: 'connect',
        ownerKind: 'set_member:managed_database_binding',
        ownerId: memberRouteOwnerId(bindingRouteId, memberB),
        routeId: memberRoute.id,
        targetEndpointId: memberRoute.target_endpoint_id,
        grant: 'g-b',
      },
    ];
    const completed = await completeSetGrants(
      db,
      grants,
      routes.filter((entry) => entry.sourceId === consumer),
      endpoints
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      ownerKind: 'managed_database_binding',
      routeId: bindingRouteId,
      leaseGroup: [
        { routeId: bindingRouteId, target: { memberId: memberA, candidateId: nodeA, rank: 0, leasePolicyId } },
        { routeId: memberRoute.id, target: { memberId: memberB, candidateId: nodeB, rank: 1, leasePolicyId } },
      ],
    });
  });

  it('opens only the primary endpoint of a manual pair', async () => {
    await q(`update managed_availability_sets set mode = 'manual', primary_member_id = $2 where id = $1`, [
      setId,
      memberB,
    ]);
    await reconcile();
    expect((await endpoint('managed_database', databaseId)).status).toBe('inactive');
    expect((await endpoint('managed_availability_member', memberB)).status).toBe('active');
    await q(`update managed_availability_sets set mode = 'automatic', primary_member_id = $2 where id = $1`, [
      setId,
      memberA,
    ]);
    await reconcile();
    expect((await endpoint('managed_database', databaseId)).status).toBe('active');
  });

  it('turns the set off on member B: its endpoint and member routes become the resource paths in place', async () => {
    const clientB = await endpoint('managed_availability_member', memberB);
    const memberRoute = await route('set_member:managed_database_binding', memberRouteOwnerId(bindingRouteId, memberB));
    const bindingOwner = (await q('select owner_id from relay_routes where id = $1', [bindingRouteId])).rows[0]
      .owner_id;
    expect(await db.transaction((tx) => releaseSetRelayPaths(tx, setId, memberB))).toBe(true);
    expect(await endpoint('managed_database', databaseId)).toMatchObject({ id: clientB.id, subject_id: nodeB });
    expect(await route('managed_database_binding', bindingOwner)).toMatchObject({
      id: memberRoute.id,
      parent_route_id: null,
      target_endpoint_id: clientB.id,
    });
    expect(
      (await q(`select count(*)::int as n from relay_endpoints where owner_kind like 'managed_availability_%'`)).rows[0]
        .n
    ).toBe(0);
    expect(
      (
        await q(
          `select count(*)::int as n from relay_routes where owner_kind like 'set_member:%' or owner_kind = 'managed_member_peer'`
        )
      ).rows[0].n
    ).toBe(0);
  });

  it('connects a ClickHouse pair with its Keeper witness on a relay: relay-local endpoint and routes both ways', async () => {
    const chDatabase = randomUUID();
    const chSet = randomUUID();
    const [chA, chB] = [randomUUID(), randomUUID()];
    const relay = randomUUID();
    const witness = randomUUID();
    const user = (await q('select id from users limit 1')).rows[0].id;
    await q(
      `insert into managed_database_instances (id, node_id, name, slug, type, version, image_ref, engine_config,
         encrypted_owner_credentials, storage_size_bytes, published_port, status, created_by_id)
       values ($1, $2, 'events', 'events', 'clickhouse', '25.3', 'img', '{}', 'x', 1, null, 'ready', $3)`,
      [chDatabase, nodeA, user]
    );
    await q(
      `insert into managed_availability_sets (id, owner_kind, owner_id, managed_database_id, engine, mode, durability,
         state) values ($1, 'managed_database', $2, $2, 'clickhouse', 'automatic', 'asynchronous', 'healthy')`,
      [chSet, chDatabase]
    );
    await q(
      `insert into managed_availability_members (id, set_id, node_id, member_index) values ($1, $2, $3, 0), ($4, $2, $5, 1)`,
      [chA, chSet, nodeA, chB, nodeB]
    );
    await q(
      `insert into relay_instances (id, pool_id, kind, fault_domain_id, display_name, state)
       values ($1, 'system', 'remote', gen_random_uuid(), 'witness relay', 'ready')`,
      [relay]
    );
    await q(
      `insert into managed_availability_witnesses (id, set_id, purpose, host_kind, relay_instance_id, keeper_server_id,
         relay_local_port) values ($1, $2, 'keeper', 'relay', $3, 3, 39401)`,
      [witness, chSet, relay]
    );
    await reconcile();
    const witnessEndpoint = (
      await q(
        `select id, subject_kind, subject_id, relay_local_port, certificate_sha256 from relay_endpoints
         where owner_kind = 'managed_availability_witness' and owner_id = $1`,
        [witness]
      )
    ).rows[0];
    expect(witnessEndpoint).toMatchObject({
      subject_kind: 'relay_instance',
      subject_id: relay,
      relay_local_port: 39401,
      certificate_sha256: 'relay-local',
    });
    const placed = await q(
      `select a.relay_instance_id from relay_endpoint_assignments a
       join relay_endpoint_assignment_generations g on g.id = a.assignment_generation_id
       where g.endpoint_id = $1 and g.state = 'active'`,
      [witnessEndpoint.id]
    );
    expect(placed.rows).toEqual([{ relay_instance_id: relay }]);
    const keeperB = await endpoint('managed_availability_peer', peerEndpointOwnerId(chB, 'ch-keeper'));
    expect(await route('managed_witness_peer', `${chA}>${witness}`)).toMatchObject({
      source_id: nodeA,
      target_endpoint_id: witnessEndpoint.id,
    });
    const fromWitness = (
      await q(
        `select source_kind, source_id, source_certificate_sha256, target_endpoint_id from relay_routes
         where owner_kind = 'managed_witness_peer' and owner_id = $1`,
        [`${witness}>${chB}`]
      )
    ).rows[0];
    expect(fromWitness).toEqual({
      source_kind: 'relay_instance',
      source_id: relay,
      source_certificate_sha256: 'relay-local',
      target_endpoint_id: keeperB.id,
    });
    for (const port of ['ch-interserver', 'ch-keeper']) {
      expect(await route('managed_member_peer', peerRouteOwnerId(chA, chB, port))).toBeDefined();
    }
    // Neither ClickHouse port is a primary port: never lease-gated.
    const gate = await relayLeasePolicyIds(
      db,
      [{ id: keeperB.id, ownerKind: 'managed_availability_peer', ownerId: peerEndpointOwnerId(chB, 'ch-keeper') }],
      []
    );
    expect(gate.endpoints.size).toBe(0);
    // A retired witness keeps its paths until the holder's Keeper dropped it (the orchestrator deletes the row):
    // the holder can only remove it while it reaches it.
    await q(`update managed_availability_witnesses set desired_state = 'removed' where id = $1`, [witness]);
    await reconcile();
    expect(
      (await q(`select count(*)::int as n from relay_routes where owner_kind = 'managed_witness_peer'`)).rows[0].n
    ).toBeGreaterThan(0);
    // A dropped witness takes its endpoint and routes along.
    await q(`delete from managed_availability_witnesses where id = $1`, [witness]);
    await reconcile();
    expect(
      (await q(`select count(*)::int as n from relay_routes where owner_kind = 'managed_witness_peer'`)).rows[0].n
    ).toBe(0);
    expect(
      (await q(`select count(*)::int as n from relay_endpoints where owner_kind = 'managed_availability_witness'`))
        .rows[0].n
    ).toBe(0);
  });
});
