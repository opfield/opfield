import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { migrateDatabase, tolerateDatabaseDrop } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import {
  dockerRegistryNodeBindings,
  nodes,
  relayEndpoints,
  relayPolicyState,
  relayRoutes,
  storageCopyJobs,
} from '@/db/schema/index.js';
import { removeOrphanedRelayState } from './relay-policy-reconciler.js';
import { LEGACY_INSTALL_DIR_NAME, LEGACY_INTERNAL_REGISTRY_ID } from '@/lib/legacy-compat.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const FINGERPRINT = `sha256:${'0'.repeat(64)}`;

/**
 * Relay endpoints and routes of a deleted Route stayed in the policy forever and the daemons kept retrying their
 * tunnels. Opt-in: point OPFIELD_MIGRATION_TEST_DATABASE_URL at a disposable database named opfield_migration_test_*.
 */
describe.skipIf(!url)('relay state whose owner is gone', () => {
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
    await db.insert(relayPolicyState).values({ id: 'current', opfieldInstanceId: randomUUID() }).onConflictDoNothing();
  });

  afterAll(async () => {
    await pool?.end();
  });

  const revision = async () =>
    (await db.select().from(relayPolicyState).where(eq(relayPolicyState.id, 'current')))[0]!.revision;

  const endpoint = async (ownerKind: string, ownerId: string, subjectId: string) =>
    (
      await db
        .insert(relayEndpoints)
        .values({ ownerKind, ownerId, subjectKind: 'daemon', subjectId, certificateSha256: FINGERPRINT })
        .returning()
    )[0]!;

  const route = async (ownerKind: string, ownerId: string, sourceId: string, targetEndpointId: string) =>
    (
      await db
        .insert(relayRoutes)
        .values({
          ownerKind,
          ownerId,
          sourceKind: 'daemon',
          sourceId,
          sourceCertificateSha256: FINGERPRINT,
          targetEndpointId,
        })
        .returning()
    )[0]!;

  it('removes the state of deleted owners of every kind and keeps the rest', async () => {
    const [node] = await db
      .insert(nodes)
      .values({ type: 'docker', hostname: 'docker-live', slug: `docker-${randomUUID().slice(0, 8)}` })
      .returning();
    const [binding] = await db
      .insert(dockerRegistryNodeBindings)
      .values({
        nodeId: node!.id,
        role: 'runtime',
        repository: 'app',
        actions: ['pull'],
        contextKind: 'container',
        contextId: 'app',
      })
      .returning();
    // Fixed owners (the internal registry and its ingress) are not judged by this pass.
    const liveEndpoint = await endpoint('internal_registry', LEGACY_INTERNAL_REGISTRY_ID, `${LEGACY_INSTALL_DIR_NAME}`);
    const liveRoute = await route('registry_secure_link', binding!.id, node!.id, liveEndpoint.id);
    // A storage copy job owns its storage routes under its own id, not a backup run's.
    const [copyJob] = await db
      .insert(storageCopyJobs)
      .values({
        sourceConnectionName: 'minio',
        destinationConnectionName: 'seaweedfs',
        mode: 'copy',
        status: 'running',
        limits: { timeoutSeconds: 3600, cpuCores: 1, memoryMb: 512, transfers: 4 },
      })
      .returning();
    const copySourceRoute = await route('storage_backup_staging', copyJob!.id, 'copy-runner', liveEndpoint.id);
    const copyTargetRoute = await route('storage_backup_target', copyJob!.id, 'copy-runner', liveEndpoint.id);
    const fixedOwnerRoute = await route('registry_ingress', 'opfield-registry-ingress', 'nginx-live', liveEndpoint.id);

    const deletedRoute = randomUUID();
    const orphanEndpoint = await endpoint('proxy_host_secure_link', deletedRoute, 'docker-orphan');
    await route('proxy_host_secure_link', deletedRoute, 'nginx-orphan-a', orphanEndpoint.id);
    await route('proxy_host_secure_link', deletedRoute, 'nginx-orphan-b', orphanEndpoint.id);
    // Routes of a deleted backup run and a deleted registry binding go; the endpoint they lead to stays.
    await route('database_backup_source', randomUUID(), 'backup-runner', liveEndpoint.id);
    await route('registry_secure_link', randomUUID(), 'docker-unbound', liveEndpoint.id);
    const before = await revision();

    const nodeIds = await removeOrphanedRelayState(db);

    expect(new Set(nodeIds)).toEqual(
      new Set(['docker-orphan', 'nginx-orphan-a', 'nginx-orphan-b', 'backup-runner', 'docker-unbound'])
    );
    expect((await db.select().from(relayEndpoints)).map(({ id }) => id)).toEqual([liveEndpoint.id]);
    expect(new Set((await db.select().from(relayRoutes)).map(({ id }) => id))).toEqual(
      new Set([liveRoute.id, fixedOwnerRoute.id, copySourceRoute.id, copyTargetRoute.id])
    );
    expect(await revision()).toBe(before + 1);

    expect(await removeOrphanedRelayState(db)).toEqual([]);
    expect(await revision()).toBe(before + 1);
  });
});
