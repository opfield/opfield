import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { migrateDatabase, tolerateDatabaseDrop } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import {
  nodes,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayInstances,
  relayPools,
} from '@/db/schema/index.js';
import { RelayPoolService } from './relay-pool.service.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/**
 * Stand rc.8, F-2 and O-7, on a real database. The Relay Pool update drained UK at 20:51:25 and placed endpoint
 * 15046c02 on generation 149 `local:primary, nl:fallback`; UK was ready again at 20:51:36, generation 149 was
 * activated at 20:51:37 anyway, and the local relay drained at 20:51:38 onto it, so the endpoint's traffic ran over
 * the 300-ms NL relay until generation 150 (`uk:primary, nl:fallback`) was active at 20:51:48. During the local
 * relay's restart NL and UK were listed offline although they served.
 * Opt-in: point OPFIELD_MIGRATION_TEST_DATABASE_URL at a disposable database named opfield_migration_test_*.
 */
describe.skipIf(!url)('Relay Pool update placement (stand rc.8, F-2, O-7)', () => {
  let pool: pg.Pool;
  let db: DrizzleClient;

  beforeAll(async () => {
    if (!new URL(url!).pathname.startsWith('/opfield_migration_test_')) {
      throw new Error('OPFIELD_MIGRATION_TEST_DATABASE_URL must name a disposable opfield_migration_test_* database');
    }
    pool = tolerateDatabaseDrop(new pg.Pool({ connectionString: url }));
    await pool.query(
      'drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public'
    );
    await migrateDatabase(pool);
    db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    await db.insert(relayPools).values({ id: 'system' }).onConflictDoNothing();
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function relay(
    name: string,
    kind: 'local' | 'remote',
    values: Partial<typeof relayInstances.$inferInsert> = {}
  ) {
    const nodeId =
      kind === 'remote'
        ? (
            await db
              .insert(nodes)
              .values({ type: 'relay', hostname: name, slug: `${name}-${randomUUID().slice(0, 8)}` })
              .returning()
          )[0]!.id
        : null;
    const [instance] = await db
      .insert(relayInstances)
      .values({
        poolId: 'system',
        kind,
        nodeId,
        faultDomainId: randomUUID(),
        displayName: name,
        state: 'ready',
        lastSeenAt: new Date(),
        health: { admissionState: 'ready' } as never,
        ...(kind === 'remote'
          ? { certificateIdentity: `relay-${name}`, certificateFingerprint: `sha256:${name}` }
          : {}),
        ...values,
      })
      .returning();
    return instance!;
  }

  async function generation(
    endpointId: string,
    number: number,
    state: 'active' | 'staging',
    createdAt: Date,
    relays: Array<[string, 'primary' | 'fallback']>
  ) {
    const [row] = await db
      .insert(relayEndpointAssignmentGenerations)
      .values({ endpointId, generation: number, state, desiredRedundancy: relays.length, createdAt })
      .returning();
    await db.insert(relayEndpointAssignments).values(
      relays.map(([relayInstanceId, role]) => ({
        assignmentGenerationId: row!.id,
        relayInstanceId,
        role,
        targetRegistrationState: 'ready' as const,
      }))
    );
    return row!;
  }

  function service() {
    const policy = {
      reconcileAndSync: vi.fn(async () => undefined),
      syncRemoteInstancePolicy: vi.fn(async () => undefined),
      setRemoteInstanceDrain: vi.fn(async () => undefined),
      isRemoteInstanceConnected: vi.fn(() => true),
      opfieldAssignmentsChanged: vi.fn(),
    };
    const pool = new RelayPoolService(
      db,
      policy as never,
      { publish: vi.fn() } as never,
      { log: vi.fn(async () => undefined) } as never,
      {} as never
    );
    // Planning again after a rolled-back generation is not under test here.
    if ('replanSoon' in pool) {
      vi.spyOn(pool as unknown as { replanSoon(id: string): void }, 'replanSoon').mockImplementation(() => undefined);
    }
    vi.spyOn(pool as unknown as { evacuateInstance(id: string): Promise<void> }, 'evacuateInstance').mockResolvedValue(
      undefined
    );
    const tryActivate = (id: string) =>
      (pool as unknown as { tryActivate(id: string): Promise<boolean> }).tryActivate(id);
    return { pool, policy, tryActivate };
  }

  it('does not activate a generation planned while UK drained once UK serves again', async () => {
    const local = await relay('local', 'local');
    const uk = await relay('uk', 'remote', { state: 'draining' });
    const nl = await relay('nl', 'remote');
    const [endpoint] = await db
      .insert(relayEndpoints)
      .values({
        ownerKind: 'managed_storage',
        ownerId: randomUUID(),
        subjectKind: 'daemon',
        subjectId: randomUUID(),
        certificateSha256: `sha256:${'a'.repeat(64)}`,
      })
      .returning();
    const now = Date.now();
    const active = await generation(endpoint!.id, 148, 'active', new Date(now - 60_000), [
      [local.id, 'primary'],
      [uk.id, 'fallback'],
    ]);
    // Planned while UK drained for its update (20:51:25).
    const planned = await generation(endpoint!.id, 149, 'staging', new Date(now - 12_000), [
      [local.id, 'primary'],
      [nl.id, 'fallback'],
    ]);
    const t = service();
    // The update resumes UK (20:51:36), one second before the staged generation's registrations are all ready.
    await t.pool.drainInstance(uk.id, null, false, { manual: false });
    const [resumed] = await db.select().from(relayInstances).where(eq(relayInstances.id, uk.id));
    expect(resumed?.state).toBe('ready');

    expect(await t.tryActivate(planned.id)).toBe(false);
    const rows = await db
      .select()
      .from(relayEndpointAssignmentGenerations)
      .where(eq(relayEndpointAssignmentGenerations.endpointId, endpoint!.id));
    const byNumber = new Map(rows.map((row) => [row.generation, row]));
    expect(byNumber.get(148)?.state).toBe('active');
    expect(byNumber.get(149)?.state).toBe('retired');
    expect(byNumber.get(149)?.activatedAt).toBeNull();
    expect(active.id).toBe(byNumber.get(148)?.id);

    // A generation planned after UK came back is activated as usual (20:51:40, generation 150).
    const current = await generation(endpoint!.id, 150, 'staging', new Date(), [
      [uk.id, 'primary'],
      [nl.id, 'fallback'],
    ]);
    expect(await t.tryActivate(current.id)).toBe(true);
    expect(t.policy.opfieldAssignmentsChanged).toHaveBeenCalled();
  });

  it('lists the remote relays as ready and reconnecting, not offline, while the local relay restarts', async () => {
    await db.delete(relayEndpoints);
    await db.delete(relayInstances);
    const since = Date.now() - 6_000;
    await relay('local', 'local', { state: 'offline' });
    const uk = await relay('uk', 'remote', { state: 'offline', lastSeenAt: new Date(since - 2_000) });
    const t = service();
    t.pool.setLocalRelayOutage({ latestOutage: () => ({ since, servingAgainAt: null, planned: true }) });
    vi.spyOn(t.pool as unknown as { getRecentAttempts(): unknown }, 'getRecentAttempts').mockResolvedValue([]);
    const settings = { getConfig: async () => ({ relay: { assignmentSpread: { mode: 'fixed', count: 2 } } }) };
    (t.pool as unknown as { settings: unknown }).settings = settings;
    const snapshot = await t.pool.getSnapshot();
    const listed = snapshot.instances.find(({ id }) => id === uk.id);
    expect(snapshot.state).toBe('local_relay_restarting');
    expect(listed).toMatchObject({ state: 'ready', reconnecting: true });
  });

  it("lists a remote relay as ready and reconnecting during its supervisor's planned control reconnect", async () => {
    await db.delete(relayEndpoints);
    await db.delete(relayInstances);
    await relay('local', 'local');
    // Stand rc.9: the relay supervisor reconnects the control stream ~45 s after the relay's update; UK and NL were
    // listed offline for 1-4 s while they served. The control stream ended a moment ago, the node is expected back.
    const uk = await relay('uk', 'remote');
    const nl = await relay('nl', 'remote');
    const t = service();
    t.pool.setLocalRelayOutage(
      { latestOutage: () => null },
      { isAwaitingLocalRelay: () => false, isReconnecting: (nodeId: string) => nodeId === uk.nodeId }
    );
    vi.spyOn(t.pool as unknown as { getRecentAttempts(): unknown }, 'getRecentAttempts').mockResolvedValue([]);
    const settings = { getConfig: async () => ({ relay: { assignmentSpread: { mode: 'fixed', count: 2 } } }) };
    (t.pool as unknown as { settings: unknown }).settings = settings;
    const snapshot = await t.pool.getSnapshot();
    expect(snapshot.state).not.toBe('degraded');
    expect(snapshot.instances.find(({ id }) => id === uk.id)).toMatchObject({ state: 'ready', reconnecting: true });
    expect(snapshot.instances.find(({ id }) => id === nl.id)).toMatchObject({ state: 'ready', reconnecting: false });
  });
});
