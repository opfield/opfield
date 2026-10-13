import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disposableDatabase, migrateDatabase, rejection } from './migration-database.test-helpers.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): the ingress group migration. A route on an ingress group owns one
 * proxy_host_domains row per member, so a name is unique across every member; member changes rebuild the rows;
 * proxy Secure Link routes may have one relay route per source while every other owner keeps one route. Storage links
 * (one route per Availability placement node, a later migration) follow the Secure Link rule.
 */
describe.skipIf(!url)('ingress group migration on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  const user = randomUUID();
  const [nodeA, nodeB, nodeC] = [randomUUID(), randomUUID(), randomUUID()];
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);

  const insertGroup = async (members: string[]) => {
    const id = randomUUID();
    await q('insert into ingress_groups (id, name, slug, created_by_id) values ($1, $2, $3, $4)', [
      id,
      `group-${id}`,
      id.slice(0, 30),
      user,
    ]);
    for (const [priority, nodeId] of members.entries()) {
      await q('insert into ingress_group_members (group_id, node_id, priority) values ($1, $2, $3)', [
        id,
        nodeId,
        priority,
      ]);
    }
    return id;
  };
  const insertHost = async (placement: { nodeId: string; groupId?: string }, domains: string[], enabled = true) => {
    const id = randomUUID();
    await q(
      `insert into proxy_hosts (id, node_id, ingress_group_id, domain_names, slug, enabled, created_by_id)
       values ($1, $2, $3, $4::jsonb, gen_random_uuid()::text, $5, $6)`,
      [id, placement.nodeId, placement.groupId ?? null, JSON.stringify(domains), enabled, user]
    );
    return id;
  };
  const rows = async (hostId: string) =>
    (
      await q(
        'select node_id, domain, enabled from proxy_host_domains where proxy_host_id = $1 order by node_id, domain',
        [hostId]
      )
    ).rows.map((row) => [row.node_id, row.domain, row.enabled]);

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'ingress');
    pool = database.pool;
    await migrateDatabase(pool);
    const group = randomUUID();
    await q('insert into permission_groups (id, name) values ($1, $2)', [group, `ingress-${group}`]);
    await q('insert into users (id, group_id, email, name) values ($1, $2, $3, $4)', [
      user,
      group,
      `${user}@ingress.test`,
      'Ingress test',
    ]);
    for (const nodeId of [nodeA, nodeB, nodeC]) {
      await q(
        `insert into nodes (id, type, hostname, slug) values ($1, 'nginx', gen_random_uuid()::text, gen_random_uuid()::text)`,
        [nodeId]
      );
    }
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('keeps one row per name for a single-node route', async () => {
    const host = await insertHost({ nodeId: nodeA }, ['Single.Example.com']);
    expect(await rows(host)).toEqual([[nodeA, 'single.example.com', true]]);
  });

  it('gives a group route one row per member and name', async () => {
    const groupId = await insertGroup([nodeA, nodeB]);
    const host = await insertHost({ nodeId: nodeA, groupId }, ['app.example.com', 'www.example.com']);
    expect(await rows(host)).toEqual(
      [
        [nodeA, 'app.example.com', true],
        [nodeA, 'www.example.com', true],
        [nodeB, 'app.example.com', true],
        [nodeB, 'www.example.com', true],
      ].sort((left, right) => `${left[0]}${left[1]}`.localeCompare(`${right[0]}${right[1]}`))
    );
  });

  it('refuses a name another enabled route already serves on any member', async () => {
    await insertHost({ nodeId: nodeB }, ['taken.example.com']);
    const groupId = await insertGroup([nodeA, nodeB]);
    expect(await rejection(insertHost({ nodeId: nodeA, groupId }, ['taken.example.com']))).toMatchObject({
      code: '23505',
      constraint: 'proxy_host_domains_node_domain_unique',
    });
  });

  it('adds and drops rows when a member joins or leaves', async () => {
    const groupId = await insertGroup([nodeA]);
    const host = await insertHost({ nodeId: nodeA, groupId }, ['member.example.com']);
    await q('insert into ingress_group_members (group_id, node_id, priority, state) values ($1, $2, 1, $3)', [
      groupId,
      nodeC,
      'joining',
    ]);
    expect((await rows(host)).map((row) => row[0]).sort()).toEqual([nodeA, nodeC].sort());
    await q('delete from ingress_group_members where group_id = $1 and node_id = $2', [groupId, nodeC]);
    expect(await rows(host)).toEqual([[nodeA, 'member.example.com', true]]);
  });

  it('refuses a new member that already serves one of the group names', async () => {
    const groupId = await insertGroup([nodeA]);
    await insertHost({ nodeId: nodeA, groupId }, ['clash.example.com']);
    await insertHost({ nodeId: nodeC }, ['clash.example.com']);
    expect(
      await rejection(
        q('insert into ingress_group_members (group_id, node_id, priority) values ($1, $2, 1)', [groupId, nodeC])
      )
    ).toMatchObject({ code: '23505', constraint: 'proxy_host_domains_node_domain_unique' });
  });

  it('moves rows when a route changes between a node and a group', async () => {
    const groupId = await insertGroup([nodeA, nodeB]);
    const host = await insertHost({ nodeId: nodeA }, ['move.example.com']);
    await q('update proxy_hosts set ingress_group_id = $2 where id = $1', [host, groupId]);
    expect((await rows(host)).map((row) => row[0]).sort()).toEqual([nodeA, nodeB].sort());
    await q('update proxy_hosts set ingress_group_id = null, node_id = $2 where id = $1', [host, nodeB]);
    expect(await rows(host)).toEqual([[nodeB, 'move.example.com', true]]);
  });

  it('checks member states and drain consistency', async () => {
    const groupId = await insertGroup([nodeA]);
    expect(
      await rejection(
        q(`update ingress_group_members set state = 'draining' where group_id = $1 and node_id = $2`, [groupId, nodeA])
      )
    ).toMatchObject({ code: '23514', constraint: 'ingress_group_members_drain_consistent' });
    await q(
      `update ingress_group_members set state = 'draining', drain_started_at = now() where group_id = $1 and node_id = $2`,
      [groupId, nodeA]
    );
    expect(
      await rejection(q(`update ingress_groups set dns_failover_mode = 'weighted' where id = $1`, [groupId]))
    ).toMatchObject({ code: '23514', constraint: 'ingress_groups_dns_failover_mode_valid' });
  });

  it('allows one proxy Secure Link or storage link route per source and one route per owner otherwise', async () => {
    const endpoint = randomUUID();
    await q(
      `insert into relay_endpoints (id, owner_kind, owner_id, subject_kind, subject_id, certificate_sha256)
       values ($1, 'proxy_host_secure_link', $2, 'daemon', $3, 'sha256:x')`,
      [endpoint, randomUUID(), nodeC]
    );
    const link = randomUUID();
    const route = (ownerKind: string, ownerId: string, sourceId: string) =>
      q(
        `insert into relay_routes (owner_kind, owner_id, source_kind, source_id, source_certificate_sha256, target_endpoint_id)
         values ($1, $2, 'daemon', $3, 'sha256:y', $4)`,
        [ownerKind, ownerId, sourceId, endpoint]
      );
    await route('proxy_host_secure_link', link, nodeA);
    await route('proxy_host_secure_link', link, nodeB);
    expect(await rejection(route('proxy_host_secure_link', link, nodeB))).toMatchObject({
      code: '23505',
      constraint: 'relay_routes_proxy_link_source_unique',
    });
    const storageLink = randomUUID();
    await route('managed_storage_binding', storageLink, nodeA);
    await route('managed_storage_binding', storageLink, nodeB);
    expect(await rejection(route('managed_storage_binding', storageLink, nodeB))).toMatchObject({
      code: '23505',
      constraint: 'relay_routes_storage_link_source_unique',
    });
    const binding = randomUUID();
    await route('managed_database_binding', binding, nodeA);
    expect(await rejection(route('managed_database_binding', binding, nodeB))).toMatchObject({
      code: '23505',
      constraint: 'relay_routes_owner_unique',
    });
  });
});
