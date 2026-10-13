import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { migrateDatabase, tolerateDatabaseDrop } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import {
  nodes,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayInstances,
  relayPolicyState,
  relayRoutes,
} from '@/db/schema/index.js';
import {
  DRAIN_KEEPS_LOCAL_SERVICES_CAPABILITY,
  RELAY_STREAM_RESUME_CAPABILITY,
  RESUME_KEY_ROTATION_MS,
  RelayStreamResumeService,
  relayInstanceFullyResumable,
} from './relay-stream-resume.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/** Envelope encryption stand-in: the tests only need the secret to round-trip. */
const crypto = {
  encryptPrivateKey: (value: string) => ({
    encryptedPrivateKey: Buffer.from(value).toString('base64'),
    encryptedDek: 'dek',
    dekIv: '',
  }),
  decryptPrivateKey: ({ encryptedPrivateKey }: { encryptedPrivateKey: string }) =>
    Buffer.from(encryptedPrivateKey, 'base64').toString(),
};

/**
 * RSv1 state in the database: the migration, the ordered enable/rotate/disable sequence and the drain grace rule.
 * Opt-in: point OPFIELD_MIGRATION_TEST_DATABASE_URL at a disposable opfield_migration_test_* database.
 */
describe.skipIf(!url)('resumable relay streams', () => {
  let pool: pg.Pool;
  let db: DrizzleClient;

  beforeAll(async () => {
    if (!new URL(url!).pathname.startsWith('/opfield_migration_test_')) {
      throw new Error('OPFIELD_MIGRATION_TEST_DATABASE_URL must name a disposable opfield_migration_test_* database');
    }
    pool = tolerateDatabaseDrop(new pg.Pool({ connectionString: url }));
    // A database at the release before resumable streams, with a route, then upgraded: what the migration test checks
    // and what every other test here runs on. Migrating takes longer than one test may on a slower database host.
    await pool.query(
      'drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public'
    );
    await migrateDatabase(pool, '0226_relay_pool_update_step_skipped');
    const nodeId = randomUUID();
    const endpointId = randomUUID();
    await pool.query(`insert into relay_policy_state (id, gateway_instance_id, revision) values ('current', $1, 7)`, [
      randomUUID(),
    ]);
    await pool.query(`insert into nodes (id, type, hostname, slug) values ($1, 'docker', 'n', $2)`, [
      nodeId,
      `n-${nodeId.slice(0, 8)}`,
    ]);
    await pool.query(
      `insert into relay_endpoints (id, owner_kind, owner_id, subject_kind, subject_id, certificate_sha256)
       values ($1, 'managed_database', 'db', 'daemon', $2, 'sha256:x')`,
      [endpointId, nodeId]
    );
    await pool.query(
      `insert into relay_routes (owner_kind, owner_id, source_kind, source_id, source_certificate_sha256, target_endpoint_id)
       values ('managed_database_binding', 'b', 'daemon', $1, 'sha256:x', $2)`,
      [nodeId, endpointId]
    );
    await migrateDatabase(pool);
    db = drizzle(pool, { schema }) as unknown as DrizzleClient;
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  describe('migration', () => {
    it('keeps existing routes raw until their daemons support resumable streams', async () => {
      const route = await pool.query(
        'select resume_state, key_version, prev_key_version, key_rotated_at from relay_routes'
      );
      expect(route.rows).toEqual([
        { resume_state: 'off', key_version: '1', prev_key_version: null, key_rotated_at: null },
      ]);
      const state = await pool.query('select revision, resume_secret_encrypted from relay_policy_state');
      expect(state.rows).toEqual([{ revision: '7', resume_secret_encrypted: null }]);
      const instance = await pool.query(
        `select column_name from information_schema.columns where table_name = 'relay_instances' and column_name = 'drain_deadline_at'`
      );
      expect(instance.rowCount).toBe(1);
    });
  });

  describe('ordered capability changes', () => {
    let sourceId: string;
    let targetId: string;
    let routeId: string;
    let syncs: Array<{ nodeId: string; state: string; keyVersion: number; prevKeyVersion: number | null }>;
    let failing: Set<string>;
    let service: RelayStreamResumeService;

    const capabilities = (capable: boolean) => ({
      capabilities: capable ? ['relay_pool_v1', RELAY_STREAM_RESUME_CAPABILITY] : ['relay_pool_v1'],
    });

    const routeState = async () => {
      const [row] = await db.select().from(relayRoutes).where(eq(relayRoutes.id, routeId));
      return row!;
    };

    beforeEach(async () => {
      await db.delete(relayRoutes);
      await db.delete(relayEndpoints);
      await db.delete(nodes);
      const [source] = await db
        .insert(nodes)
        .values({
          type: 'docker',
          hostname: 's',
          slug: `s-${randomUUID().slice(0, 8)}`,
          capabilities: capabilities(true) as never,
        })
        .returning();
      const [target] = await db
        .insert(nodes)
        .values({
          type: 'docker',
          hostname: 't',
          slug: `t-${randomUUID().slice(0, 8)}`,
          capabilities: capabilities(true) as never,
        })
        .returning();
      sourceId = source!.id;
      targetId = target!.id;
      const [endpoint] = await db
        .insert(relayEndpoints)
        .values({
          ownerKind: 'managed_database',
          ownerId: randomUUID(),
          subjectKind: 'daemon',
          subjectId: targetId,
          certificateSha256: 'sha256:t',
        })
        .returning();
      const [route] = await db
        .insert(relayRoutes)
        .values({
          ownerKind: 'managed_database_binding',
          ownerId: randomUUID(),
          sourceKind: 'daemon',
          sourceId,
          sourceCertificateSha256: 'sha256:s',
          targetEndpointId: endpoint!.id,
        })
        .returning();
      routeId = route!.id;
      syncs = [];
      failing = new Set();
      service = new RelayStreamResumeService(db, crypto, {
        syncNodeGrants: async (nodeId) => {
          const row = await routeState();
          syncs.push({
            nodeId,
            state: row.resumeState,
            keyVersion: row.keyVersion,
            prevKeyVersion: row.prevKeyVersion,
          });
          if (failing.has(nodeId)) throw new Error('not acknowledged');
        },
      });
      await service.ensureInitialized();
    });

    it('creates the secret once', async () => {
      const [first] = await db.select().from(relayPolicyState);
      await new RelayStreamResumeService(db, crypto, { syncNodeGrants: async () => {} }).ensureInitialized();
      const [second] = await db.select().from(relayPolicyState);
      expect(first?.resumeSecretEncrypted).toBeTruthy();
      expect(second?.resumeSecretEncrypted).toBe(first?.resumeSecretEncrypted);
      expect((await service.secret())?.length).toBe(32);
    });

    it('enables the target first, then the source', async () => {
      await service.reconcile();
      expect(syncs).toEqual([
        { nodeId: targetId, state: 'enabling', keyVersion: 2, prevKeyVersion: null },
        { nodeId: sourceId, state: 'on', keyVersion: 2, prevKeyVersion: null },
      ]);
      syncs = [];
      await service.reconcile();
      expect(syncs).toEqual([]);
    });

    it('keeps the source raw until the target took the key', async () => {
      failing.add(targetId);
      await service.reconcile();
      expect(syncs.map(({ nodeId }) => nodeId)).toEqual([targetId]);
      expect((await routeState()).resumeState).toBe('enabling');
      failing.clear();
      syncs = [];
      await service.reconcile();
      expect(syncs.map(({ nodeId, state }) => [nodeId, state])).toEqual([
        [targetId, 'enabling'],
        [sourceId, 'on'],
      ]);
    });

    it('disables the source first, then the target, when a daemon loses the capability', async () => {
      await service.reconcile();
      await db
        .update(nodes)
        .set({ capabilities: capabilities(false) as never })
        .where(eq(nodes.id, targetId));
      syncs = [];
      await service.reconcile();
      expect(syncs).toEqual([
        { nodeId: sourceId, state: 'disabling', keyVersion: 2, prevKeyVersion: null },
        { nodeId: targetId, state: 'off', keyVersion: 2, prevKeyVersion: null },
      ]);
    });

    it('gives a route turned on again a key its source never had', async () => {
      await service.reconcile();
      await db
        .update(nodes)
        .set({ capabilities: capabilities(false) as never })
        .where(eq(nodes.id, targetId));
      await service.reconcile();
      expect((await routeState()).resumeState).toBe('off');
      await db
        .update(nodes)
        .set({ capabilities: capabilities(true) as never })
        .where(eq(nodes.id, targetId));
      syncs = [];
      await service.reconcile();
      expect(syncs).toEqual([
        { nodeId: targetId, state: 'enabling', keyVersion: 3, prevKeyVersion: null },
        { nodeId: sourceId, state: 'on', keyVersion: 3, prevKeyVersion: null },
      ]);
      // A retried enable keeps the key it started with.
      await db.update(relayRoutes).set({ resumeState: 'enabling' }).where(eq(relayRoutes.id, routeId));
      await service.reconcile();
      expect((await routeState()).keyVersion).toBe(3);
    });

    it('keeps the target accepting until the source dropped the key', async () => {
      await service.reconcile();
      await db
        .update(nodes)
        .set({ capabilities: capabilities(false) as never })
        .where(eq(nodes.id, sourceId));
      failing.add(sourceId);
      syncs = [];
      await service.reconcile();
      expect(syncs.map(({ nodeId }) => nodeId)).toEqual([sourceId]);
      expect((await routeState()).resumeState).toBe('disabling');
    });

    it('rotates a key on the target first; the source keeps the old one until then', async () => {
      await service.reconcile();
      await db
        .update(relayRoutes)
        .set({ keyRotatedAt: new Date(Date.now() - RESUME_KEY_ROTATION_MS - 1000) })
        .where(eq(relayRoutes.id, routeId));
      syncs = [];
      await service.reconcile();
      expect(syncs).toEqual([
        { nodeId: targetId, state: 'rotating', keyVersion: 3, prevKeyVersion: 2 },
        { nodeId: sourceId, state: 'on', keyVersion: 3, prevKeyVersion: 2 },
      ]);
    });

    it('makes a new route resumable before its source gets it: the target takes the key first', async () => {
      await service.enableBeforeSourceSync({ sourceNodeId: sourceId });
      expect(syncs).toEqual([{ nodeId: targetId, state: 'enabling', keyVersion: 2, prevKeyVersion: null }]);
      expect((await routeState()).resumeState).toBe('on');
      // Nothing left to do for the next delivery to this source.
      syncs = [];
      await service.enableBeforeSourceSync({ sourceNodeId: sourceId });
      expect(syncs).toEqual([]);
    });

    it('leaves a new route raw while its target has not taken the key', async () => {
      failing.add(targetId);
      await service.enableBeforeSourceSync({ sourceNodeId: sourceId });
      expect((await routeState()).resumeState).toBe('enabling');
    });

    it('leaves a new route raw when one of its ends does not support resumable streams', async () => {
      await db
        .update(nodes)
        .set({ capabilities: capabilities(false) as never })
        .where(eq(nodes.id, sourceId));
      await service.enableBeforeSourceSync({ sourceNodeId: sourceId });
      expect(syncs).toEqual([]);
      expect((await routeState()).resumeState).toBe('off');
    });

    it('makes a new Opfield route resumable before Opfield opens it', async () => {
      await db
        .update(relayRoutes)
        .set({ sourceKind: 'gateway', sourceId: 'gateway' })
        .where(eq(relayRoutes.id, routeId));
      await service.enableBeforeSourceSync({ routeIds: [routeId] });
      expect(syncs.map(({ nodeId, state }) => [nodeId, state])).toEqual([[targetId, 'enabling']]);
      expect((await routeState()).resumeState).toBe('on');
    });

    it('needs no delivery for an Opfield source', async () => {
      await db
        .update(relayRoutes)
        .set({ sourceKind: 'gateway', sourceId: 'gateway' })
        .where(eq(relayRoutes.id, routeId));
      await service.reconcile();
      expect(syncs.map(({ nodeId, state }) => [nodeId, state])).toEqual([[targetId, 'enabling']]);
      expect((await routeState()).resumeState).toBe('on');
    });
  });

  describe('drain grace', () => {
    it('is short only when every route through the relay is resumable', async () => {
      await db.execute(sql`insert into relay_pools (id) values ('system') on conflict do nothing`);
      const [instance] = await db
        .insert(relayInstances)
        .values({ poolId: 'system', kind: 'remote', faultDomainId: randomUUID(), displayName: 'r', state: 'ready' })
        .returning();
      expect(await relayInstanceFullyResumable(db, instance!.id)).toBe(true);
      const [route] = await db.select().from(relayRoutes).limit(1);
      const [generation] = await db
        .insert(relayEndpointAssignmentGenerations)
        .values({ endpointId: route!.targetEndpointId, generation: 1, state: 'active' })
        .returning();
      await db
        .insert(relayEndpointAssignments)
        .values({ assignmentGenerationId: generation!.id, relayInstanceId: instance!.id, role: 'active' });
      await db.update(relayRoutes).set({ resumeState: 'enabling' });
      expect(await relayInstanceFullyResumable(db, instance!.id)).toBe(false);
      await db.update(relayRoutes).set({ resumeState: 'on' });
      expect(await relayInstanceFullyResumable(db, instance!.id)).toBe(true);
      // Raw streams the daemons still report through the relay keep today's grace.
      expect(await relayInstanceFullyResumable(db, instance!.id, 1)).toBe(false);
    });

    it("leaves the local relay's registry streams out: it keeps serving them through the drain", async () => {
      const [registry] = await db
        .insert(relayEndpoints)
        .values({
          ownerKind: 'internal_registry',
          ownerId: randomUUID(),
          subjectKind: 'local_service',
          subjectId: 'registry',
          certificateSha256: 'sha256:r',
        })
        .returning();
      const health = { assignmentTunnels: [{ endpointId: registry!.id, assignmentGeneration: 1, activeTunnels: 3 }] };
      const [local] = await db
        .insert(relayInstances)
        .values({
          poolId: 'system',
          kind: 'local',
          faultDomainId: randomUUID(),
          displayName: 'local',
          state: 'ready',
          capabilities: { features: ['relay_pool_v1', DRAIN_KEEPS_LOCAL_SERVICES_CAPABILITY] } as never,
          health: health as never,
        })
        .returning();
      // Three raw streams, all of them the registry's: the local relay drains in 2 minutes.
      expect(await relayInstanceFullyResumable(db, local!.id, 3)).toBe(true);
      // A fourth raw stream is a workload's.
      expect(await relayInstanceFullyResumable(db, local!.id, 4)).toBe(false);
      // A relay that refuses its local services while it drains keeps today's grace for them.
      await db
        .update(relayInstances)
        .set({ capabilities: { features: ['relay_pool_v1'] } as never })
        .where(eq(relayInstances.id, local!.id));
      expect(await relayInstanceFullyResumable(db, local!.id, 3)).toBe(false);
    });
  });
});
