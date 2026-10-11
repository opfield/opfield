import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import type { AvailabilityLeaseReport } from '@/grpc/generated/types.js';
import { decodeRelayV1Message } from '@/grpc/relay-proto.js';
import { AvailabilityLeaseService } from './availability-lease.service.js';
import { MANAGED_AVAILABILITY_MEMBER_ENDPOINT_OWNER } from './lease-policy-relays.js';

interface PublishedManifest {
  policyId: string;
  stateful: boolean;
  closed: boolean;
  partitionMode: string;
  candidates: Array<{ id: string }>;
  members: Array<{ id: string }>;
  retained?: Array<{ slot: number; holderId: string }>;
}

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;
vi.setConfig({ testTimeout: 60_000 });

const V3 = ['availability_lease_v2', 'availability_lease_v3', 'managed_availability_member_v1'];
const RELAY_V3 = ['relay_pool_v1', 'availability_lease_v2', 'availability_lease_v3'];
const identityKey = () =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer;

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): the lease of a database availability set on the lease host, through the
 * set contract (createSetPolicy, updateSetVoters, closeSetPolicy, observeSet). Strict and stateful, v3 everywhere,
 * members on storage-profile nodes, member endpoints gated, joint epochs settle only through a live holder's renewal
 * (AS1), no implicit close on capability loss (AS9: degraded instead), an explicit close retains the holder, and every
 * enable gets a fresh lease policy id (M10).
 */
describe.skipIf(!url)('availability set leases on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let service: AvailabilityLeaseService;
  let leasePolicyId = '';
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  const keyId = randomUUID();
  const localRelay = randomUUID();
  const oldRelay = randomUUID();
  const nodeIds = [randomUUID(), randomUUID(), randomUUID()];
  const databaseId = randomUUID();
  const setId = randomUUID();
  const memberIds = [randomUUID(), randomUUID(), randomUUID()];
  const identities = new Map<string, Buffer>();
  const audit = { log: vi.fn(async (_entry: unknown) => true) };
  const events = { publish: vi.fn() };
  const controller = { holderChanged: vi.fn(), modeChanged: vi.fn(), degradedChanged: vi.fn() };
  const connected = nodeIds.map((nodeId) => ({
    nodeId,
    connectionId: `c-${nodeId}`,
    type: 'databases',
    capabilities: new Set(V3),
  }));
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let now = Date.now();
  const at = async <T>(ms: number, run: () => Promise<T>): Promise<T> => {
    now += ms;
    vi.useFakeTimers({ toFake: ['Date'], now });
    try {
      return await run();
    } finally {
      vi.useRealTimers();
    }
  };
  const report = (memberId: string, extra: Partial<AvailabilityLeaseReport> = {}): AvailabilityLeaseReport => ({
    memberId,
    identityPublicKey: identities.get(memberId)!,
    incarnation: '1',
    epoch: '0',
    trustedPolicyKeyIds: [keyId],
    manifests: [],
    held: [],
    acceptor: [],
    acceptorAbstaining: false,
    watchdogReady: true,
    events: [],
    leaseRevision: '0',
    ...extra,
  });
  const reportAll = async (extra: Partial<AvailabilityLeaseReport> = {}) => {
    for (const id of nodeIds) await service.ingestDaemonReport(id, 'databases', report(id, extra));
    for (const id of [localRelay, oldRelay]) await service.ingestRelayReport(id, report(id, extra));
  };
  const holding = (nodeId: string, round: number, epoch: number, role = 'holding') =>
    report(nodeId, {
      held: [
        {
          policyId: leasePolicyId,
          slot: 0,
          role,
          ballot: { round: String(round), incarnation: '1', proposerId: nodeId },
          epoch: String(epoch),
          manifestVersion: '1',
          placementId: '',
          placementGeneration: '0',
        },
      ],
    });
  const view = () => service.getLeasePolicyView(leasePolicyId, new Date(now));
  const published = async (): Promise<PublishedManifest | null> =>
    (await service.relayPolicyFields()).leaseBlocks
      .map((block) => decodeRelayV1Message('LeaseManifest', block.payload) as PublishedManifest)
      .find((manifest) => manifest.policyId === leasePolicyId) ?? null;
  const gate = async () =>
    Object.fromEntries(
      (
        await service.relayLeasePolicyIds(
          [{ id: 'endpoint-m0', ownerKind: MANAGED_AVAILABILITY_MEMBER_ENDPOINT_OWNER, ownerId: memberIds[0]! }],
          []
        )
      ).endpoints
    );

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'set_leases');
    pool = database.pool;
    await migrateDatabase(pool);
    const db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    await q(
      `insert into relay_policy_signing_keys (key_id, public_key, public_key_fingerprint, encrypted_private_key,
         encrypted_dek, status, activated_at) values ($1, $2, $3, 'held', 'held', 'active', now())`,
      [keyId, rawPublicKey.toString('base64'), `sha256:${createHash('sha256').update(rawPublicKey).digest('hex')}`]
    );
    await q(`insert into relay_pools (id) values ('system') on conflict do nothing`);
    await q(`delete from relay_instances`);
    for (const [id, kind, features] of [
      [localRelay, 'local', RELAY_V3],
      [oldRelay, 'remote', ['relay_pool_v1', 'availability_lease_v2']],
    ] as const) {
      await q(
        `insert into relay_instances (id, pool_id, kind, fault_domain_id, display_name, state, capabilities)
         values ($1, 'system', $2, gen_random_uuid(), $4, 'ready', $3)`,
        [id, kind, JSON.stringify({ protocolMajor: 1, features }), `relay-${kind}`]
      );
    }
    for (const [index, id] of nodeIds.entries()) {
      await q(
        `insert into nodes (id, type, hostname, slug, status, host_identity_id, capabilities, last_seen_at)
         values ($1, 'databases', $2, $2, 'online', gen_random_uuid(), $3, now())`,
        [id, `db-node-${index}`, JSON.stringify({ capabilities: V3 })]
      );
    }
    for (const id of [localRelay, oldRelay, ...nodeIds]) identities.set(id, identityKey());
    const group = randomUUID();
    const user = randomUUID();
    await q('insert into permission_groups (id, name) values ($1, $2)', [group, `sets-${group}`]);
    await q('insert into users (id, group_id, email, name) values ($1, $2, $3, $4)', [
      user,
      group,
      `${user}@lease.test`,
      'Sets',
    ]);
    await q(
      `insert into managed_database_instances (id, node_id, name, slug, type, version, image_ref, engine_config,
         encrypted_owner_credentials, storage_size_bytes, published_port, created_by_id)
       values ($1, $2, 'orders', 'orders', 'postgres', '17', 'img', '{}', 'x', 1, null, $3)`,
      [databaseId, nodeIds[0], user]
    );
    await q(
      `insert into managed_availability_sets (id, owner_kind, owner_id, managed_database_id, engine, mode, durability,
         state) values ($1, 'managed_database', $2, $2, 'postgres', 'automatic', 'synchronous', 'healthy')`,
      [setId, databaseId]
    );
    for (const [index, id] of memberIds.entries()) {
      await q(
        `insert into managed_availability_members (id, set_id, node_id, priority, member_index) values ($1, $2, $3, $4, $5)`,
        [id, setId, nodeIds[index], 10 - index, index]
      );
    }
    await q('update managed_availability_sets set primary_member_id = $2 where id = $1', [setId, memberIds[0]]);
    // Member 0's endpoint is carried by the local relay (v3).
    const endpointId = randomUUID();
    const generationId = randomUUID();
    await q(
      `insert into relay_endpoints (id, owner_kind, owner_id, subject_kind, subject_id, certificate_sha256)
       values ($1, $2, $3, 'node', $4, 'sha256:m0')`,
      [endpointId, MANAGED_AVAILABILITY_MEMBER_ENDPOINT_OWNER, memberIds[0], nodeIds[0]]
    );
    await q(
      `insert into relay_endpoint_assignment_generations (id, endpoint_id, generation, state) values ($1, $2, 1, 'active')`,
      [generationId, endpointId]
    );
    await q(
      `insert into relay_endpoint_assignments (assignment_generation_id, relay_instance_id, role)
       values ($1, $2, 'primary')`,
      [generationId, localRelay]
    );
    service = new AvailabilityLeaseService(
      db,
      {
        getNode: (id: string) => connected.find((node) => node.nodeId === id),
        getAllNodes: () => connected,
        hasCapability: (id: string, capability: string) =>
          connected.find((node) => node.nodeId === id)?.capabilities.has(capability) ?? false,
        sendCommand: vi.fn(async () => ({
          commandId: 'c',
          success: true,
          error: '',
          detail: '',
          data: Buffer.alloc(0),
        })),
      } as never,
      audit,
      events as never,
      { signPayload: async (payload: Buffer) => ({ signingKeyId: keyId, signature: sign(null, payload, privateKey) }) }
    );
    service.attachSetController(controller);
  }, 180_000);

  afterAll(async () => {
    vi.useRealTimers();
    await database?.drop();
  }, 60_000);

  it('starts a fresh stateful lease policy for the set and bootstraps it on the primary member', async () => {
    expect(await service.observeSet(setId)).toMatchObject({ leasePolicyId: null, view: null });
    await at(0, () => reportAll());
    leasePolicyId = (await at(0, () => service.createSetPolicy(setId))).leasePolicyId;
    expect(
      (await q('select kind, resource_id, stateful from lease_policies where id = $1', [leasePolicyId])).rows
    ).toEqual([{ kind: 'managed_availability_set', resource_id: setId, stateful: true }]);
    await at(121_000, () => service.reconcile());
    expect(await view()).toMatchObject({
      kind: 'managed_availability_set',
      resourceId: setId,
      stateful: true,
      mode: 'bootstrapping',
      bootstrap: [{ slot: 0, holderMemberId: nodeIds[0] }],
      candidates: nodeIds,
    });
    const manifest = (await published())!;
    expect(manifest).toMatchObject({ stateful: true, partitionMode: 'LEASE_PARTITION_MODE_STRICT' });
    expect(manifest.candidates.map(({ id }) => id)).toEqual(nodeIds);
    // A relay without v3 keeps no shadow accepts for a stateful key: it is no member.
    expect(manifest.members.map(({ id }) => id)).toContain(localRelay);
    expect(manifest.members.map(({ id }) => id)).not.toContain(oldRelay);
    expect(controller.modeChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ leasePolicyId, leaseKind: 'managed_availability_set', to: 'bootstrapping' })
    );
    expect(events.publish).toHaveBeenCalledWith('availability.set.changed', {
      setId,
      ownerKind: 'managed_database',
      ownerId: databaseId,
      leasePolicyId,
      action: 'lease_bootstrapping',
    });
    expect(await gate()).toEqual({});
    await expect(service.createSetPolicy(setId)).rejects.toMatchObject({ code: 'AVAILABILITY_SET_LEASE_OPEN' });
  });

  it('enters lease mode once the primary holds, then gates the member endpoints', async () => {
    await at(1_000, () => service.ingestDaemonReport(nodeIds[0]!, 'databases', holding(nodeIds[0]!, 3, 1)));
    await at(0, () => service.reconcile());
    await at(25_000, () => service.reconcile());
    expect((await view())?.mode).toBe('lease');
    expect(await gate()).toEqual({ 'endpoint-m0': leasePolicyId });
    expect(await service.observeSet(setId)).toMatchObject({
      leasePolicyId,
      holderMemberId: memberIds[0],
      holderNodeId: nodeIds[0],
    });
  });

  it('audits a failover once on the database, dated at the takeover, and tells the set controller', async () => {
    controller.holderChanged.mockClear();
    // C-4: the members' last reports give the lost-range estimate at takeover.
    const lastPrimaryReport = new Date('2026-10-12T10:00:00.000Z');
    await q('update managed_availability_members set lag_bytes = 4096 where id = $1', [memberIds[1]]);
    await q('update managed_availability_members set last_reported_at = $2 where id = $1', [
      memberIds[0],
      lastPrimaryReport,
    ]);
    await at(1_000, async () => {
      await service.ingestDaemonReport(nodeIds[0]!, 'databases', report(nodeIds[0]!, { epoch: '1' }));
      await service.ingestDaemonReport(nodeIds[1]!, 'databases', holding(nodeIds[1]!, 5, 1));
    });
    expect(controller.holderChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ policyId: leasePolicyId, leaseKind: 'managed_availability_set', resourceId: setId })
    );
    // The audit waits for the takeover time (B-14); a flush writes it.
    await service.flushTakeoverAudits();
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'availability.failover',
        resourceType: 'managed_database',
        resourceId: databaseId,
        details: expect.objectContaining({
          fromNodeId: nodeIds[0],
          toNodeId: nodeIds[1],
          setId,
          leasePolicyId,
          lossBytes: 4096,
          lossSince: lastPrimaryReport.toISOString(),
        }),
      })
    );
    expect(await service.observeSet(setId)).toMatchObject({ holderMemberId: memberIds[1] });
  });

  it('keeps a member removal joint until the live holder renewed under the joint epoch (AS1)', async () => {
    await q(`update managed_availability_members set desired_state = 'removing' where id = $1`, [memberIds[2]]);
    await at(1_000, () => service.updateSetVoters(setId));
    const joint = (await view())!;
    expect(joint.joint).toBe(true);
    const manifests = [
      {
        policyId: leasePolicyId,
        manifestVersion: String(joint.manifestVersion),
        closed: false,
        voterEpoch: String(joint.epoch),
      },
    ];
    const holderReport = (epoch: number) => ({ ...holding(nodeIds[1]!, 5, epoch), manifests });
    await at(1_000, async () => {
      for (const id of [nodeIds[0]!, nodeIds[2]!])
        await service.ingestDaemonReport(id, 'databases', report(id, { manifests }));
      await service.ingestDaemonReport(nodeIds[1]!, 'databases', holderReport(1));
      for (const id of [localRelay, oldRelay]) await service.ingestRelayReport(id, report(id, { manifests }));
      await service.reconcile();
    });
    await at(61_000, async () => {
      await service.ingestDaemonReport(nodeIds[1]!, 'databases', holderReport(1));
      await service.reconcile();
    });
    expect((await view())?.joint).toBe(true);
    await at(1_000, async () => {
      await service.ingestDaemonReport(nodeIds[1]!, 'databases', holderReport(joint.epoch));
      await service.reconcile();
    });
    const settled = (await view())!;
    expect(settled.joint).toBe(false);
    expect(settled.candidates).toEqual(nodeIds.slice(0, 2));
  });

  it('never closes the set lease on capability loss: it reports it as degraded (AS9)', async () => {
    controller.degradedChanged.mockClear();
    await q(`update relay_instances set capabilities = $2 where id = $1`, [
      localRelay,
      JSON.stringify({ protocolMajor: 1, features: ['relay_pool_v1', 'availability_lease_v2'] }),
    ]);
    await at(1_000, () => service.reconcile());
    await at(10 * 60_000, () => service.reconcile());
    expect(await view()).toMatchObject({ mode: 'lease', degraded: true, reason: { code: 'relays_not_capable' } });
    expect(controller.degradedChanged).toHaveBeenCalledTimes(1);
    await q(`update relay_instances set capabilities = $2 where id = $1`, [
      localRelay,
      JSON.stringify({ protocolMajor: 1, features: RELAY_V3 }),
    ]);
    await at(1_000, () => service.reconcile());
    expect(await view()).toMatchObject({ mode: 'lease', degraded: false, reason: null });
    expect(controller.degradedChanged).toHaveBeenLastCalledWith(expect.objectContaining({ reason: null }));
  });

  it('closes only on closeSetPolicy, retaining the holder, and the next enable gets a fresh lease policy', async () => {
    await at(1_000, () => service.closeSetPolicy(setId));
    const closing = (await view())!;
    expect(closing.mode).toBe('closing');
    expect(await published()).toMatchObject({
      closed: true,
      stateful: true,
      retained: [{ slot: 0, holderId: nodeIds[1] }],
    });
    const closed = [{ policyId: leasePolicyId, manifestVersion: String(closing.manifestVersion), closed: true }];
    await at(1_000, async () => {
      for (const id of nodeIds)
        await service.ingestDaemonReport(
          id,
          'databases',
          id === nodeIds[1]
            ? { ...holding(id, 5, closing.epoch, 'retained'), manifests: closed }
            : report(id, { manifests: closed })
        );
      await service.ingestRelayReport(localRelay, report(localRelay, { manifests: closed }));
      await service.reconcile();
    });
    expect((await view())?.mode).toBe('legacy');
    expect(controller.modeChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: 'closing', to: 'legacy', retainedHolders: [{ slot: 0, holderId: nodeIds[1] }] })
    );
    expect(await gate()).toEqual({});
    expect((await service.relayPolicyFields()).leaseBlocks).toHaveLength(0);
    const previous = leasePolicyId;
    const next = await at(1_000, () => service.createSetPolicy(setId));
    expect(next.leasePolicyId).not.toBe(previous);
    expect((await service.observeSet(setId)).leasePolicyId).toBe(next.leasePolicyId);
  });
});
