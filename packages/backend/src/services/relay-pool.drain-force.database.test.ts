import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { migrateDatabase, tolerateDatabaseDrop } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { nodes, relayInstances } from '@/db/schema/index.js';
import { RelayPoolService } from './relay-pool.service.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/**
 * A manual drain started with now() keeps microseconds that the Date read back does not carry. The forced
 * disconnect after the drain timeout must still be recorded, so it is not repeated on every pass.
 * Opt-in: point OPFIELD_MIGRATION_TEST_DATABASE_URL at a disposable database named opfield_migration_test_*.
 */
describe.skipIf(!url)('relay manual drain force', () => {
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
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('records drainForcedAt once and does not force again', async () => {
    const [node] = await db
      .insert(nodes)
      .values({ type: 'relay', hostname: 'relay-test', slug: `relay-${randomUUID().slice(0, 8)}` })
      .returning();
    const [instance] = await db
      .insert(relayInstances)
      .values({
        poolId: 'system',
        kind: 'remote',
        nodeId: node!.id,
        faultDomainId: randomUUID(),
        displayName: 'relay-test',
        state: 'draining',
        manualDrainStartedAt: sql`now() - interval '11 minutes'`,
        health: { admissionState: 'draining', activeTunnels: 0 } as never,
      })
      .returning();
    const setRemoteInstanceDrain = vi.fn(async () => undefined);
    const service = new RelayPoolService(
      db,
      { setRemoteInstanceDrain, isRemoteInstanceConnected: () => true } as never,
      {} as never,
      {} as never,
      {} as never
    );

    await service.reconcileManualDrains();
    const [forced] = await db.select().from(relayInstances).where(eq(relayInstances.id, instance!.id));
    expect(setRemoteInstanceDrain).toHaveBeenCalledWith(node!.id, true, true);
    expect(forced?.drainForcedAt).toBeInstanceOf(Date);

    await service.reconcileManualDrains();
    expect(setRemoteInstanceDrain).toHaveBeenCalledTimes(1);
  });
});
