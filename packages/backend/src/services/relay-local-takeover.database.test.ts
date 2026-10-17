import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { migrateDatabase, tolerateDatabaseDrop } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import {
  nodes,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayInstances,
  relayRoutes,
} from '@/db/schema/index.js';
import { RelayGrantIssuerService } from './relay-grant-issuer.service.js';
import {
  LOCAL_RELAY_DRAIN_CAPABILITY,
  localRelayTakeoverBlocker,
  waitForLocalRelayEvacuation,
} from './relay-local-takeover.js';
import { RelayPoolService } from './relay-pool.service.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/**
 * A Relay Pool update drains the local relay only while a remote relay can carry every workload it serves, and only
 * the update drains it. Opt-in: point OPFIELD_MIGRATION_TEST_DATABASE_URL at a disposable opfield_migration_test_*
 * database.
 */
describe.skipIf(!url)('local relay takeover during a Relay Pool update', () => {
  let pool: pg.Pool;
  let db: DrizzleClient;
  let localId: string;
  let remoteNodeId: string;

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
    await db.execute(sql`insert into relay_pools (id) values ('system') on conflict do nothing`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await db.delete(relayRoutes);
    await db.delete(relayEndpoints);
    await db.delete(relayInstances).where(eq(relayInstances.kind, 'remote'));
    const [local] = await db.select().from(relayInstances).where(eq(relayInstances.kind, 'local'));
    localId =
      local?.id ??
      (
        await db
          .insert(relayInstances)
          .values({ poolId: 'system', kind: 'local', faultDomainId: randomUUID(), displayName: 'Local relay' })
          .returning()
      )[0]!.id;
    await db
      .update(relayInstances)
      .set({
        state: 'ready',
        manualDrainStartedAt: null,
        drainForcedAt: null,
        capabilities: { protocolMajor: 1, features: ['relay_pool_v1', LOCAL_RELAY_DRAIN_CAPABILITY] },
      })
      .where(eq(relayInstances.id, localId));
    const [node] = await db
      .insert(nodes)
      .values({ type: 'relay', hostname: 'relay-takeover', slug: `relay-${randomUUID().slice(0, 8)}` })
      .returning();
    remoteNodeId = node!.id;
    await db.insert(relayInstances).values({
      poolId: 'system',
      kind: 'remote',
      nodeId: remoteNodeId,
      faultDomainId: randomUUID(),
      displayName: 'relay-1',
      state: 'ready',
      certificateIdentity: 'relay-1',
      certificateFingerprint: `sha256:${'a'.repeat(64)}`,
      capabilities: { protocolMajor: 1, features: ['relay_pool_v1'] },
      policyExpiresAt: new Date(Date.now() + 3_600_000),
      lastSeenAt: new Date(),
    });
  });

  /** An endpoint whose active generation the local relay serves; `routed` adds a route to it. */
  async function localWorkload(ownerKind: string, routed = true, sourceId: string = randomUUID()) {
    const [endpoint] = await db
      .insert(relayEndpoints)
      .values({
        ownerKind,
        ownerId: randomUUID(),
        subjectKind: ownerKind === 'internal_registry' ? 'local_service' : 'node',
        subjectId: randomUUID(),
        certificateSha256: `sha256:${'b'.repeat(64)}`,
      })
      .returning();
    const [generation] = await db
      .insert(relayEndpointAssignmentGenerations)
      .values({ endpointId: endpoint!.id, generation: 1, state: 'active' })
      .returning();
    await db
      .insert(relayEndpointAssignments)
      .values({ assignmentGenerationId: generation!.id, relayInstanceId: localId, role: 'active' });
    if (routed) {
      await db.insert(relayRoutes).values({
        ownerKind: 'managed_database_binding',
        ownerId: randomUUID(),
        sourceKind: 'daemon',
        sourceId,
        sourceCertificateSha256: `sha256:${'c'.repeat(64)}`,
        targetEndpointId: endpoint!.id,
      });
    }
    return { endpointId: endpoint!.id, generationId: generation!.id };
  }

  const policy = (incapable: string[] = []) => ({
    isRemoteInstanceConnected: (nodeId: string) => nodeId === remoteNodeId,
    poolIncapableEndpointIds: async () => new Set(incapable),
  });
  const blocker = async (incapable: string[] = [], hostOnly: string[] = []) =>
    localRelayTakeoverBlocker(
      db,
      policy(incapable),
      {
        instances: await db.select().from(relayInstances).where(eq(relayInstances.poolId, 'system')),
        opfieldHostOnlyEndpointIds: new Set(hostOnly),
      },
      localId
    );

  it('lets a ready, connected remote relay take over the local relay workloads; the registry stays', async () => {
    await localWorkload('managed_database');
    await localWorkload('internal_registry');

    await expect(blocker()).resolves.toBeNull();
  });

  it('keeps the local relay serving what only it can serve', async () => {
    const { endpointId } = await localWorkload('managed_database');
    await expect(blocker([endpointId])).resolves.toContain('without Relay Pool support');
    await expect(blocker([], [endpointId])).resolves.toContain('reach no relay outside the Opfield host');
  });

  it('does not drain a local relay that would refuse internal registry tunnels while it drains', async () => {
    await localWorkload('managed_database');
    await db
      .update(relayInstances)
      .set({ capabilities: { protocolMajor: 1, features: ['relay_pool_v1'] } })
      .where(eq(relayInstances.id, localId));

    await expect(blocker()).resolves.toContain('cannot keep serving the internal registry while it drains');
  });

  it('finds no takeover without a connected remote relay that holds a valid policy', async () => {
    await localWorkload('managed_database');
    await db
      .update(relayInstances)
      .set({ policyExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(relayInstances.kind, 'remote'));
    await expect(blocker()).resolves.toBe('no other relay was ready to take its workloads over');
  });

  it('waits until the drained local relay no longer carries a workload with a route', async () => {
    await localWorkload('internal_registry');
    const { generationId } = await localWorkload('managed_database');
    await expect(waitForLocalRelayEvacuation(db, localId, 0, () => undefined)).resolves.toBe(false);
    await db
      .update(relayEndpointAssignmentGenerations)
      .set({ state: 'draining' })
      .where(eq(relayEndpointAssignmentGenerations.id, generationId));
    await expect(waitForLocalRelayEvacuation(db, localId, 0, () => undefined)).resolves.toBe(true);
  });

  function poolService() {
    const relayPolicy = {
      setLocalInstanceDrain: vi.fn(async () => undefined),
      reconcileAndSync: vi.fn(async () => 0),
      isRemoteInstanceConnected: () => true,
    };
    const audit = { log: vi.fn(async () => true) };
    const service = new RelayPoolService(
      db,
      relayPolicy as never,
      { publish: vi.fn() } as never,
      audit as never,
      {} as never
    );
    return { service, relayPolicy, audit };
  }

  it('drains, force-disconnects and resumes the local relay for an update, never for an operator', async () => {
    const { service, relayPolicy, audit } = poolService();

    await expect(service.drainInstance(localId, 'admin-1', true)).rejects.toMatchObject({
      code: 'LOCAL_RELAY_DRAIN_UNSUPPORTED',
    });
    await service.drainInstance(localId, 'admin-1', true, { manual: false });
    expect(relayPolicy.setLocalInstanceDrain).toHaveBeenLastCalledWith(true);
    const [drained] = await db.select().from(relayInstances).where(eq(relayInstances.id, localId));
    expect(drained?.state).toBe('draining');

    await service.forceDisconnectInstance(localId, 'admin-1');
    expect(relayPolicy.setLocalInstanceDrain).toHaveBeenLastCalledWith(true, true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'relay.instance.force_disconnect', resourceId: localId })
    );

    await service.drainInstance(localId, 'admin-1', false, { manual: false });
    expect(relayPolicy.setLocalInstanceDrain).toHaveBeenLastCalledWith(false);
    const [resumed] = await db
      .select()
      .from(relayInstances)
      .where(and(eq(relayInstances.id, localId), eq(relayInstances.state, 'ready')));
    expect(resumed?.drainForcedAt).toBeNull();
  });

  it('keeps the internal registry route on the local relay through its update drain; workloads leave it (stand rc.20)', async () => {
    const [source] = await db
      .insert(nodes)
      .values({
        type: 'docker',
        hostname: 'app-node',
        slug: `app-${randomUUID().slice(0, 8)}`,
        certificateFingerprint: `sha256:${'d'.repeat(64)}`,
        capabilities: { capabilities: ['relay_pool_v1'] } as never,
      })
      .returning();
    const registry = await localWorkload('internal_registry', true, source!.id);
    const workload = await localWorkload('managed_database', true, source!.id);
    await db
      .update(relayEndpoints)
      .set({ subjectKind: 'daemon', subjectId: source!.id })
      .where(eq(relayEndpoints.id, workload.endpointId));
    await db
      .insert(schema.relayPolicyState)
      .values({ id: 'current', opfieldInstanceId: randomUUID(), revision: 1 })
      .onConflictDoNothing();
    const { service } = poolService();

    await service.drainInstance(localId, null, true, { manual: false });

    const issuer = new RelayGrantIssuerService(db, {} as never, {} as never) as unknown as {
      signGrant: (claims: unknown) => Promise<unknown>;
      getNodeGrantBundle: RelayGrantIssuerService['getNodeGrantBundle'];
    };
    issuer.signGrant = async (claims) => ({ keyId: 'grant', payload: claims, signature: Buffer.alloc(0) });
    const bundle = await issuer.getNodeGrantBundle(source!.id);
    const candidates = (endpointId: string) =>
      bundle.grants
        .filter((grant) => grant.role === 'connect' && grant.targetEndpointId === endpointId)
        .flatMap((grant) => grant.candidates ?? [])
        .map(({ relayInstanceId, assignmentState }) => ({ relayInstanceId, assignmentState }));
    // The registry route keeps its only relay for new tunnels; a draining candidate would leave pulls no relay.
    expect(candidates(registry.endpointId)).toEqual([{ relayInstanceId: localId, assignmentState: 'active' }]);
    expect(candidates(workload.endpointId)).toEqual([{ relayInstanceId: localId, assignmentState: 'draining' }]);
  });

  it('resumes a local relay a finished update left drained', async () => {
    const { service, relayPolicy } = poolService();
    await db.update(relayInstances).set({ state: 'draining' }).where(eq(relayInstances.id, localId));

    await expect(service.releaseOrphanedUpdateDrains()).resolves.toBe(1);
    expect(relayPolicy.setLocalInstanceDrain).toHaveBeenCalledWith(false);
  });
});
