import { sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import type { AvailabilityLeaseReport, OpfieldCommand } from '@/grpc/generated/types.js';
import { loadLeaseUpdateView } from '@/services/daemon-update-lease-gate.js';
import { AvailabilityLeaseService } from './availability-lease.service.js';
import {
  goldenId as id,
  identityOf,
  KEY_ID,
  LOCAL_RELAY,
  MEMBER_LINK,
  NEXT_KEY_ID,
  NGINX,
  NODES,
  normalizeGolden as normalize,
  POLICY,
  PROJECTION,
  REMOTE_RELAY,
  seededEd25519,
  seedGoldenDatabase,
  T0,
} from './availability-lease-golden.fixture.js';
import { encodeLeaseKeyRotation, encodeLeaseSignedBlock } from './lease-codec.js';
import { leaseLaneNodeIds, leaseLaneRelays } from './lease-relay-lanes.js';

// Bootstrap ids are random in production; the golden run pins them so manifests are byte-comparable.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: () => 424_242 };
});

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const goldenPath = fileURLToPath(new URL('./availability-lease.golden.json', import.meta.url));

vi.setConfig({ testTimeout: 300_000 });

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): pins every output of the Availability lease host over one long
 * scenario (bootstrap, failover, handoff, relay view, key rotation, joint voter change, partition mode switch,
 * exclusion, close, surge, legacy request). Signed manifests, key chains, daemon distributions, relay gate fields,
 * lease lanes, update topology, API views, controller callbacks, audit entries and events must stay byte-identical
 * when the lease host changes shape. Regenerate only for an intended output change: UPDATE_LEASE_GOLDEN=1.
 */
describe.skipIf(!url)('availability lease host golden outputs', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let service: AvailabilityLeaseService;
  const policyKey = seededEd25519(7);
  const nextKey = seededEd25519(9);
  const signers = new Map([
    [KEY_ID, policyKey],
    [NEXT_KEY_ID, nextKey],
  ]);
  const sent: Array<{ nodeId: string; command: Partial<OpfieldCommand> }> = [];
  const audit = { log: vi.fn(async (_entry: unknown) => true) };
  const events = { publish: vi.fn() };
  const modeChanges: unknown[] = [];
  const holderChanges: unknown[] = [];
  let publishes = 0;
  const connected = [...NODES.map((nodeId) => ({ nodeId, type: 'docker' })), { nodeId: NGINX, type: 'nginx' }].map(
    ({ nodeId, type }) => ({
      nodeId,
      connectionId: `c-${nodeId}`,
      type,
      capabilities: new Set(['availability_lease_v2']),
      connectedAt: new Date(T0 - 3_600_000),
    })
  );
  const registry = {
    getNode: (nodeId: string) => connected.find((node) => node.nodeId === nodeId),
    getAllNodes: () => connected,
    hasCapability: (nodeId: string, capability: string) =>
      connected.find((node) => node.nodeId === nodeId)?.capabilities.has(capability) ?? false,
    sendCommand: vi.fn(async (nodeId: string, command: Partial<OpfieldCommand>) => {
      sent.push({ nodeId, command });
      return { commandId: 'c', success: true, error: '', detail: '', data: Buffer.alloc(0) };
    }),
  };
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let now = T0;
  const advance = (ms: number) => {
    now += ms;
    vi.setSystemTime(now);
  };
  const report = (memberId: string, extra: Partial<AvailabilityLeaseReport> = {}): AvailabilityLeaseReport => ({
    memberId,
    identityPublicKey: identityOf(memberId),
    incarnation: '1',
    epoch: '0',
    trustedPolicyKeyIds: [KEY_ID],
    manifests: [],
    held: [],
    acceptor: [],
    acceptorAbstaining: false,
    watchdogReady: true,
    events: [],
    leaseRevision: '0',
    ...extra,
  });
  const nginxReport = (): AvailabilityLeaseReport => ({
    ...report(NGINX),
    memberId: '',
    identityPublicKey: Buffer.alloc(0),
    incarnation: '0',
    trustedPolicyKeyIds: [],
    watchdogReady: false,
    leaseRevision: '1',
  });
  const ackAll = async (extra: Partial<AvailabilityLeaseReport> = {}) => {
    for (const nodeId of NODES) await service.ingestDaemonReport(nodeId, 'docker', report(nodeId, extra));
    await service.ingestDaemonReport(NGINX, 'nginx', nginxReport());
    for (const relayId of [LOCAL_RELAY, REMOTE_RELAY]) await service.ingestRelayReport(relayId, report(relayId, extra));
  };
  const holding = (nodeId: string, round: number, role = 'holding') =>
    report(nodeId, {
      epoch: '1',
      held: [
        {
          policyId: POLICY,
          slot: 0,
          role,
          ballot: { round: String(round), incarnation: '1', proposerId: nodeId },
          epoch: '1',
          manifestVersion: '1',
          placementId: '',
          placementGeneration: '1',
        },
      ],
    });
  const gateOwners = {
    endpoints: [
      { id: 'endpoint-member', ownerKind: 'proxy_host_secure_link', ownerId: MEMBER_LINK },
      { id: 'endpoint-other', ownerKind: 'proxy_host_secure_link', ownerId: id(49) },
    ],
    routes: [{ id: 'route-projection', ownerKind: 'managed_database_binding', ownerId: PROJECTION }],
  };
  const steps: unknown[] = [];

  const snapshot = async (label: string) => {
    const fields = await service.relayPolicyFields();
    const gate = await service.relayLeasePolicyIds(gateOwners.endpoints, gateOwners.routes);
    const topology = (await loadLeaseUpdateView(db, registry as never)).topology;
    const syncs = sent.splice(0).flatMap(({ nodeId, command }) => {
      const sync = command.syncAvailabilityLease;
      return sync
        ? [
            {
              nodeId,
              revision: sync.revision,
              memberId: sync.memberId,
              manifests: sync.manifests,
              keyRotations: sync.keyRotations,
              policyKeys: sync.policyKeys,
              voterConfig: sync.voterConfig,
            },
          ]
        : [];
    });
    steps.push(
      normalize({
        label,
        view: await service.getPolicyLease(POLICY),
        reactive: await service.isReactive(POLICY),
        relayBlocks: fields.leaseBlocks.map((block) => encodeLeaseSignedBlock(block)),
        relayRotations: fields.leaseKeyRotations.map((link) => encodeLeaseKeyRotation(link)),
        retainedSigningKeys: await service.retainedSigningKeyIds(),
        gate,
        lanes: { nodes: await leaseLaneNodeIds(db), relaysOfNode1: await leaseLaneRelays(db, NODES[1]) },
        updateTopology: topology,
        syncs,
        modeChanges: modeChanges.splice(0),
        holderChanges: holderChanges.splice(0),
        audit: audit.log.mock.calls.splice(0).map(([entry]) => entry),
        events: events.publish.mock.calls.splice(0),
        publishes,
      })
    );
  };

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'lease_golden');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    await seedGoldenDatabase(q, policyKey.publicKey);
    service = new AvailabilityLeaseService(db, registry as never, audit, events as never, {
      signPayload: async (payload: Buffer, signer?: string) => {
        const key = signers.get(signer ?? '');
        if (!key) throw new Error(`unexpected signer ${signer}`);
        return { signingKeyId: signer!, signature: sign(null, payload, key.privateKey) };
      },
    });
    service.setRelayPublisher({
      publishAvailabilityLeaseChange: async () => {
        publishes += 1;
      },
    });
    service.attachController({
      leaseModeSupported: () => true,
      leaseModeChanged: async (change) => {
        modeChanges.push(change);
      },
      leaseHolderChanged: async (change) => {
        holderChanges.push(change);
      },
    });
  }, 300_000);

  afterAll(async () => {
    vi.useRealTimers();
    await database?.drop();
  }, 60_000);

  it('produces the pinned manifests, distributions, gates, views and callbacks', async () => {
    await service.reconcile();
    await snapshot('initial');

    await ackAll();
    await service.reconcile();
    await snapshot('reports');

    advance(121_000);
    await service.reconcile();
    await snapshot('bootstrapping');
    expect((await service.getPolicyLease(POLICY)).mode).toBe('bootstrapping');

    advance(1_000);
    await service.ingestDaemonReport(NODES[0], 'docker', holding(NODES[0], 3));
    await service.reconcile();
    await snapshot('bootstrap-held');

    advance(25_000);
    await service.reconcile();
    await snapshot('lease');
    expect((await service.getPolicyLease(POLICY)).mode).toBe('lease');

    advance(1_000);
    await service.ingestDaemonReport(NODES[0], 'docker', report(NODES[0], { epoch: '1' }));
    await service.ingestDaemonReport(NODES[1], 'docker', holding(NODES[1], 7));
    await snapshot('failover');

    advance(1_000);
    await service.registerPlannedHandoff(POLICY, { slot: 0, fromHolderId: NODES[1], toHolderId: NODES[2] });
    await service.ingestDaemonReport(NODES[1], 'docker', report(NODES[1], { epoch: '1' }));
    await service.ingestDaemonReport(NODES[2], 'docker', holding(NODES[2], 9));
    await snapshot('handoff');

    advance(1_000);
    await service.ingestRelayReport(LOCAL_RELAY, {
      ...report(LOCAL_RELAY, { epoch: '1' }),
      connectedMemberIds: [NODES[0], NODES[1], NODES[2]],
      acceptor: [
        {
          policyId: POLICY,
          slot: 0,
          state: 'held',
          holderId: NODES[2],
          reservedFor: '',
          promised: { round: '12', incarnation: '1', proposerId: NODES[2] },
          committed: { round: '12', incarnation: '1', proposerId: NODES[2] },
          epoch: '1',
          manifestVersion: '1',
          gateOpen: true,
          gateHolderId: NODES[2],
          gateBallot: { round: '12', incarnation: '1', proposerId: NODES[2] },
          holderSinceUnixMs: String(now - 5_000),
        },
      ],
    } as AvailabilityLeaseReport);
    await service.ingestRelayReport(REMOTE_RELAY, {
      ...report(REMOTE_RELAY, { epoch: '1' }),
      connectedMemberIds: [NODES[0], NODES[2]],
    } as AvailabilityLeaseReport);
    await service.reconcile();
    await snapshot('relay-view');

    advance(1_000);
    await q(`update relay_policy_signing_keys set status = 'verification_only' where key_id = $1`, [KEY_ID]);
    await q(
      `insert into relay_policy_signing_keys (key_id, public_key, public_key_fingerprint, encrypted_private_key,
         encrypted_dek, status, activated_at, created_at) values ($1, $2, 'sha256:next', 'held', 'held', 'active', $3, $3)`,
      [NEXT_KEY_ID, nextKey.publicKey.toString('base64'), new Date(T0 - 3_600_000)]
    );
    await service.reconcile();
    await snapshot('rotation-linked');

    advance(1_000);
    await ackAll({ epoch: '1', trustedPolicyKeyIds: [KEY_ID, NEXT_KEY_ID] });
    await service.reconcile();
    await snapshot('rotation-trusted');

    advance(1_000);
    await q(`update docker_availability_placements set desired_state = 'removed' where id = $1`, [id(52)]);
    await service.reconcile();
    await snapshot('joint');
    const joint = await service.getPolicyLease(POLICY);
    expect(joint.voterMargin?.joint).toBe(true);

    advance(1_000);
    const jointAcks = [
      {
        policyId: POLICY,
        manifestVersion: String(joint.manifestVersion),
        closed: false,
        voterEpoch: String(joint.epoch),
        voter: true,
        member: true,
      },
    ];
    await ackAll({ epoch: '1', trustedPolicyKeyIds: [KEY_ID, NEXT_KEY_ID], manifests: jointAcks });
    await service.reconcile();
    await snapshot('joint-acked');

    advance(61_000);
    await service.reconcile();
    await snapshot('joint-settled');
    await q(`update docker_availability_placements set desired_state = 'standby' where id = $1`, [id(52)]);
    await service.reconcile();
    await snapshot('candidate-back');

    advance(1_000);
    await service.setPartitionMode(POLICY, 'available');
    await snapshot('available');

    advance(1_000);
    await service.ingestDaemonReport(NODES[2], 'docker', holding(NODES[2], 13));
    await service.setPartitionMode(POLICY, 'strict');
    await snapshot('strict-requested');

    advance(25_000);
    await service.ingestDaemonReport(NODES[2], 'docker', holding(NODES[2], 13));
    await service.reconcile();
    advance(25_000);
    await service.reconcile();
    await snapshot('strict-active');

    advance(1_000);
    await service.ingestDaemonReport(NODES[1], 'docker', report(NODES[1], { epoch: '1', watchdogReady: false }));
    await service.reconcile();
    await snapshot('watchdog-missing');
    await service.ingestDaemonReport(NODES[1], 'docker', report(NODES[1], { epoch: '1' }));

    const nginx = connected.find(({ nodeId }) => nodeId === NGINX)!;
    nginx.capabilities = new Set(['availability_lease_v1']);
    advance(1_000);
    await service.reconcile();
    await snapshot('ingress-outdated');

    advance(121_000);
    await service.reconcile();
    await snapshot('closing');
    const closing = await service.getPolicyLease(POLICY);
    expect(closing.mode).toBe('closing');

    advance(1_000);
    const closed = [{ policyId: POLICY, manifestVersion: String(closing.manifestVersion), closed: true }];
    // Graceful close: the holder keeps its copy as the close's named retained holder; the others released.
    for (const nodeId of NODES)
      await service.ingestDaemonReport(
        nodeId,
        'docker',
        nodeId === NODES[2]
          ? { ...holding(nodeId, 13, 'retained'), manifests: closed }
          : report(nodeId, { epoch: '1', manifests: closed })
      );
    await service.reconcile();
    await snapshot('closed');
    expect((await service.getPolicyLease(POLICY)).mode).toBe('legacy');

    nginx.capabilities = new Set(['availability_lease_v2']);
    await q(
      `update docker_availability_policies set mode = 'replicated', desired_replica_count = 2,
         rollout_policy = '{"maxUnavailable":0,"maxSurge":1,"drainSeconds":30}' where id = $1`,
      [POLICY]
    );
    for (let round = 0; round < 6 && (await service.getPolicyLease(POLICY)).mode === 'legacy'; round++) {
      advance(61_000);
      await ackAll({ epoch: '1', trustedPolicyKeyIds: [KEY_ID, NEXT_KEY_ID] });
      await service.reconcile();
    }
    await snapshot('replicated-bootstrapping');

    advance(1_000);
    await service.setSurgeSlots(POLICY, 1);
    await snapshot('surge');
    advance(1_000);
    await service.setSurgeSlots(POLICY, 0);
    await snapshot('surge-removed');

    advance(1_000);
    await service.reissueBootstrap(POLICY, [{ slot: 0, holderNodeId: NODES[1] }]);
    await snapshot('bootstrap-reissued');

    advance(1_000);
    await service.setLegacyRequested(POLICY, true);
    await snapshot('legacy-requested');

    if (process.env.UPDATE_LEASE_GOLDEN === '1' || !existsSync(goldenPath)) {
      writeFileSync(goldenPath, `${JSON.stringify(steps, null, 1)}\n`);
      if (process.env.UPDATE_LEASE_GOLDEN !== '1') throw new Error('Golden file was missing; it has been written');
      return;
    }
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as unknown[];
    expect(steps.map((step) => (step as { label: string }).label)).toEqual(
      golden.map((step) => (step as { label: string }).label)
    );
    for (const [index, step] of steps.entries()) expect(step).toEqual(golden[index]);
  });
});
