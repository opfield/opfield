import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import type { AvailabilityMemberCommand } from '@/grpc/generated/types.js';
import {
  type AvailabilityMemberEventRecord,
  AvailabilityMembersService,
  COPY_NOT_STREAMING,
} from './availability-members.service.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): the member plumbing of availability sets. Gateway configures each
 * member's node, records what the members report, follows the serving primary with the resource's node, hands
 * queued member events to the listeners before acknowledging them (replays skipped), and configures a member again
 * when its node reports an older configuration.
 */
describe.skipIf(!url)('availability members on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const [nodeA, nodeB] = [randomUUID(), randomUUID()];
  const databaseId = randomUUID();
  const setId = randomUUID();
  const [memberA, memberB] = [randomUUID(), randomUUID()];
  const sent: Array<{ nodeId: string; command: AvailabilityMemberCommand }> = [];
  let now = 1_800_000_000_000;
  let service: AvailabilityMembersService;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'availability_members');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    for (const [index, id] of [nodeA, nodeB].entries()) {
      await q(
        `insert into nodes (id, type, hostname, slug, status, certificate_fingerprint) values ($1, 'databases', $2, $2, 'online', $3)`,
        [id, `members-node-${index}`, `sha256:members-${index}`]
      );
    }
    const group = randomUUID();
    const user = randomUUID();
    await q('insert into permission_groups (id, name) values ($1, $2)', [group, `members-${group}`]);
    await q('insert into users (id, group_id, email, name) values ($1, $2, $3, $4)', [
      user,
      group,
      `${user}@members.test`,
      'Members',
    ]);
    await q(
      `insert into managed_database_instances (id, node_id, name, slug, type, version, image_ref, engine_config,
         encrypted_owner_credentials, storage_size_bytes, published_port, status, created_by_id)
       values ($1, $2, 'orders', 'orders', 'postgres', '17', 'img', '{}', 'x', 1, null, 'ready', $3)`,
      [databaseId, nodeA, user]
    );
    await q(
      `insert into managed_availability_sets (id, owner_kind, owner_id, managed_database_id, engine, mode, durability,
         primary_member_id, config_revision, state)
       values ($1, 'managed_database', $2, $2, 'postgres', 'manual', 'synchronous', $3, 3, 'healthy')`,
      [setId, databaseId, memberA]
    );
    await q(
      `insert into managed_availability_members (id, set_id, node_id, member_index, published_port) values
         ($1, $3, $4, 0, 5432), ($2, $3, $5, 1, 5432)`,
      [memberA, memberB, setId, nodeA, nodeB]
    );
    service = new AvailabilityMembersService(
      db,
      {
        sendAvailabilityMember: async (nodeId, command) => {
          sent.push({ nodeId, command });
          return { commandId: '', success: true, error: '', detail: '', data: Buffer.alloc(0) } as never;
        },
      },
      () => now
    );
    service.registerEngineConfig('postgres', (_set, member) => ({ member }));
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('configures every member with the set and the engine configuration', async () => {
    const failed = await service.configureSet(setId);
    expect(failed).toEqual([]);
    const configs = sent.filter((entry) => entry.command.configure).map((entry) => entry.command.configure!);
    expect(configs).toHaveLength(2);
    expect(configs[0]).toMatchObject({
      setId,
      memberId: memberA,
      mode: 'manual',
      configRevision: '3',
      publishedPort: 5432,
    });
    expect(configs[0]!.leasePolicyId).toBeUndefined();
    expect(configs[0]!.members.map((member) => member.memberIndex)).toEqual([0, 1]);
    expect(JSON.parse(configs[1]!.engineConfig!.toString())).toEqual({ member: memberB });
  });

  it('records reports, follows the serving primary and delivers events once', async () => {
    const delivered: AvailabilityMemberEventRecord[][] = [];
    service.onMemberEvents(async (_set, _member, events) => {
      delivered.push(events);
    });
    const moved: string[] = [];
    service.onPrimaryChanged((_set, member, previous) => {
      moved.push(`${previous}->${member.id}`);
    });
    sent.length = 0;
    const event = { sequence: '7', kind: 'promoted', atUnixMs: String(now - 5_000), detail: { generation: '2' } };
    const report = {
      setId,
      memberId: memberB,
      role: 'primary' as const,
      serving: true,
      eligible: true,
      syncState: 'async' as const,
      lagBytes: '12',
      position: { lsn: '0/1' },
      configRevision: '3',
      events: [event],
    };
    await service.ingestReports(nodeB, [report]);
    const [member] = (
      await q(
        'select role, sync_state, lag_bytes, engine_position, status, last_event_at from managed_availability_members where id = $1',
        [memberB]
      )
    ).rows;
    expect(member).toMatchObject({ role: 'primary', sync_state: 'async', status: 'ready' });
    expect(Number(member.lag_bytes)).toBe(12);
    expect(member.engine_position).toEqual({ lsn: '0/1' });
    const [set] = (await q('select primary_member_id from managed_availability_sets where id = $1', [setId])).rows;
    expect(set.primary_member_id).toBe(memberB);
    const [owner] = (await q('select node_id from managed_database_instances where id = $1', [databaseId])).rows;
    expect(owner.node_id).toBe(nodeB);
    expect(moved).toEqual([`${memberA}->${memberB}`]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]![0]).toMatchObject({ sequence: 7, kind: 'promoted', detail: { generation: '2' } });
    expect(sent.find((entry) => entry.command.ackEvents)?.command.ackEvents).toEqual({
      setId,
      memberId: memberB,
      throughSequence: '7',
    });
    // The node replays the event (the ack was lost): no second delivery, acknowledged again.
    sent.length = 0;
    await service.ingestReports(nodeB, [report]);
    expect(delivered).toHaveLength(1);
    expect(sent.some((entry) => entry.command.ackEvents)).toBe(true);
  });

  it('configures a member again when its node reports an older configuration or none', async () => {
    sent.length = 0;
    now += 60_000;
    await service.ingestReports(nodeA, [
      {
        setId,
        memberId: memberA,
        role: 'copy',
        serving: false,
        eligible: false,
        syncState: 'none',
        configRevision: '2',
      },
    ]);
    expect(sent.filter((entry) => entry.command.configure && entry.nodeId === nodeA)).toHaveLength(1);
    // Within the retry interval the same revision is not sent again.
    sent.length = 0;
    await service.ingestReports(nodeA, []);
    expect(sent).toHaveLength(0);
    now += 60_000;
    await service.ingestReports(nodeA, []);
    expect(sent.filter((entry) => entry.command.configure)).toHaveLength(1);
  });

  it('stops the members a run state names, restarts a member and records what the runtime reports of itself', async () => {
    service.registerRunState((_set, member) => ({ stopped: member.id === memberB }));
    sent.length = 0;
    await service.configureSet(setId);
    const configs = sent.filter((entry) => entry.command.configure).map((entry) => entry.command.configure!);
    expect(configs.find((config) => config.memberId === memberB)?.stopped).toBe(true);
    expect(configs.find((config) => config.memberId === memberA)?.stopped).toBeUndefined();

    sent.length = 0;
    await service.restartMember(setId, memberA, nodeA, 'op-1', false);
    expect(sent).toEqual([{ nodeId: nodeA, command: { restart: { setId, memberId: memberA, operationId: 'op-1' } } }]);

    await service.ingestReports(nodeB, [
      {
        setId,
        memberId: memberB,
        role: 'copy' as const,
        serving: false,
        eligible: false,
        syncState: 'none' as const,
        position: { lsn: '0/2' },
        configRevision: '99',
        stopped: true,
        pendingRestartOperationId: 'op-2',
      },
    ]);
    const [member] = (await q('select engine_position from managed_availability_members where id = $1', [memberB]))
      .rows;
    expect(member.engine_position).toEqual({ lsn: '0/2', 'runtime.stopped': 'true', 'runtime.pendingRestart': 'op-2' });
  });

  it('shows a copy that does not stream as an error and asks a manual primary that does not serve to confirm its assignment', async () => {
    service.setAssignmentSigner({
      signPrimaryAssignment: async (input) => ({
        setId: input.setId,
        primaryMemberId: input.primaryMemberId,
        generation: String(input.generation),
        signingKeyId: 'k1',
        signature: Buffer.from('sig'),
      }),
    });
    await q('update managed_availability_sets set primary_member_id = $2, primary_generation = 4 where id = $1', [
      setId,
      memberA,
    ]);
    sent.length = 0;
    now += 60_000;
    // The assigned primary came back read-only (it self-fenced, or its daemon restarted).
    const fenced = {
      setId,
      memberId: memberA,
      role: 'copy' as const,
      serving: false,
      eligible: false,
      syncState: 'none' as const,
      configRevision: '99',
    };
    await service.ingestReports(nodeA, [fenced]);
    const assigned = sent.filter((entry) => entry.command.assignPrimary);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({
      nodeId: nodeA,
      command: { assignPrimary: { primaryMemberId: memberA, generation: '4' } },
    });
    const [row] = (await q('select status, last_error from managed_availability_members where id = $1', [memberA]))
      .rows;
    expect(row).toEqual({ status: 'error', last_error: COPY_NOT_STREAMING });
    // At most every 10 s.
    sent.length = 0;
    await service.ingestReports(nodeA, [fenced]);
    expect(sent.some((entry) => entry.command.assignPrimary)).toBe(false);
    // A planned switch tells one member (the old primary) first.
    sent.length = 0;
    expect(await service.assignPrimary(setId, undefined, memberB)).toEqual([]);
    expect(sent.map((entry) => entry.nodeId)).toEqual([nodeB]);
  });

  it('runs the handoffs before a node with a set member updates, bounded and never failing the update', async () => {
    const handed: string[] = [];
    service.registerNodeUpdateHandoff(async (nodeId) => {
      handed.push(nodeId);
      throw new Error('no copy');
    });
    await service.beforeNodeUpdate(nodeA);
    await service.beforeNodeUpdate(randomUUID());
    expect(handed).toEqual([nodeA]);
  });
});
