import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { dockerAvailabilityPlacements, dockerAvailabilityPolicies } from './docker-availability.js';
import { managedAvailabilitySets } from './managed-availability.js';
import { nodes } from './nodes.js';
import { relayInstances } from './relay.js';

/**
 * How a policy fails over. legacy: the backend reacts to node loss (today's path). bootstrapping: the first lease
 * manifest reserves each slot for its current serving placement and waits for that holder to acquire (A5). lease:
 * the data-plane lease decides and the backend only plans handoffs. closing: a lease-closed manifest fences the
 * holders before legacy takes over again.
 */
export type DockerAvailabilityLeaseMode = 'legacy' | 'bootstrapping' | 'lease' | 'closing';

/** Why a policy is in its lease mode; null when lease mode runs without reservation. */
export interface DockerAvailabilityLeaseReason {
  code: string;
  message: string;
  nodeIds?: string[];
  /** Relay instances named by the reason (relays_not_capable). */
  relayIds?: string[];
  /**
   * ISO time since which lease mode has been impossible without a break. A lease-mode policy starts closing only once
   * this is 2 minutes old (D3); an explicit request (disable, lifecycle hold) closes at once and carries no time.
   */
  since?: string;
}

/** A lease ballot as reported by the data plane; uint64 parts stay decimal strings. */
export interface DockerAvailabilityLeaseBallot {
  round: string;
  incarnation: string;
  proposerId: string;
}

export interface DockerAvailabilityLeaseBootstrapSlot {
  slot: number;
  holderId: string;
}

/** A handoff the backend asked for, so the resulting holder change is audited as planned (D9). */
export interface DockerAvailabilityLeasePlannedHandoff {
  slot: number;
  fromHolderId: string | null;
  toHolderId: string;
  operationId: string | null;
  expiresAt: string;
}

/** A member of a policy's voter set as published (A18): candidate hosts and witnesses. */
export interface AvailabilityLeaseVoterMember {
  id: string;
  role: 'relay' | 'daemon';
  /** Base64 PKIX DER ECDSA P-256 identity key. */
  publicKey: string;
}

/** A witness voter (A19): a relay or docker node outside the candidates' hosts. */
export interface AvailabilityLeaseWitness {
  memberId: string;
  kind: 'relay' | 'docker';
  /** Chosen automatically (true) or configured on the policy (false). */
  auto: boolean;
  /** Smallest measured round trip to any candidate, when every candidate measured it. */
  minRttMs: number | null;
}

/**
 * What a lease policy protects. docker_availability: an Availability policy (stateless keys, the policy keeps its own
 * id). managed_availability_set: the primary role of a database or storage availability set in one availability
 * period (stateful keys, a fresh id on every enable so accepted state of an earlier period is never adopted, M10).
 */
export type LeasePolicyKind = 'docker_availability' | 'managed_availability_set';

/**
 * The lease policy registry: one row per lease policy of any kind. The id is the policy id of manifests, relay gates,
 * lease state and observations (their policy_id columns reference it). The owner column of each kind ties the row, and
 * with it the lease state, to its resource: deleting the resource deletes its lease policies.
 */
export const leasePolicies = pgTable(
  'lease_policies',
  {
    id: uuid('id').primaryKey(),
    kind: varchar('kind', { length: 32 }).$type<LeasePolicyKind>().notNull(),
    resourceId: uuid('resource_id').notNull(),
    /** Keys carry certified holder state (v3): strict partition mode only, explicit close only (AS8, AS9). */
    stateful: boolean('stateful').notNull().default(false),
    dockerAvailabilityPolicyId: uuid('docker_availability_policy_id').references(() => dockerAvailabilityPolicies.id, {
      onDelete: 'cascade',
    }),
    managedAvailabilitySetId: uuid('managed_availability_set_id').references(() => managedAvailabilitySets.id, {
      onDelete: 'cascade',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('lease_policies_kind_check', sql`${table.kind} IN ('docker_availability', 'managed_availability_set')`),
    check(
      'lease_policies_owner_check',
      sql`(${table.kind} <> 'docker_availability' OR ${table.dockerAvailabilityPolicyId} IS NOT DISTINCT FROM ${table.resourceId}) AND (${table.kind} <> 'managed_availability_set' OR ${table.managedAvailabilitySetId} IS NOT DISTINCT FROM ${table.resourceId})`
    ),
    index('lease_policies_resource_idx').on(table.kind, table.resourceId),
  ]
);

/**
 * Lease state of one lease policy of any kind (policy_id = lease_policies.id): mode, voters, the published manifest and
 * the bootstrap. The table keeps its original name; Availability rows keep their policy id.
 */
export const dockerAvailabilityLeaseState = pgTable(
  'docker_availability_lease_state',
  {
    policyId: uuid('policy_id')
      .primaryKey()
      .references(() => leasePolicies.id, { onDelete: 'cascade' }),
    mode: varchar('mode', { length: 16 }).$type<DockerAvailabilityLeaseMode>().notNull().default('legacy'),
    reason: jsonb('reason').$type<DockerAvailabilityLeaseReason | null>(),
    manifestVersion: bigint('manifest_version', { mode: 'number' }).notNull().default(0),
    /** Per-policy voter epoch (A18) the published manifest carries; never goes back. */
    voterEpoch: bigint('voter_epoch', { mode: 'number' }).notNull().default(0),
    /** Voter quorum sets of the published manifest: one when settled, two (old, new) while joint (A4). */
    quorumSets: jsonb('quorum_sets').$type<string[][]>().notNull().default([]),
    /** Keys and roles of the voters in quorum_sets, kept so a departed voter still signs in the old set. */
    voterMembers: jsonb('voter_members').$type<AvailabilityLeaseVoterMember[]>().notNull().default([]),
    /** Joint epoch bookkeeping: the manifest version that introduced it, and when both majorities acked it. */
    jointVersion: bigint('joint_version', { mode: 'number' }).notNull().default(0),
    jointAckedAt: timestamp('joint_acked_at', { withTimezone: true }),
    /** Witnesses of the current voter set and the witness warning shown to operators (A19). */
    witnesses: jsonb('witnesses').$type<AvailabilityLeaseWitness[]>().notNull().default([]),
    witnessWarning: varchar('witness_warning', { length: 64 }),
    /** Digest of the manifest content without its version; a new digest publishes a new version. */
    manifestDigest: text('manifest_digest'),
    /** Base64 of the serialized relay.v1.LeaseSignedBlock currently published. */
    manifestBlock: text('manifest_block'),
    bootstrapId: bigint('bootstrap_id', { mode: 'number' }).notNull().default(0),
    bootstrap: jsonb('bootstrap').$type<DockerAvailabilityLeaseBootstrapSlot[]>().notNull().default([]),
    /** Partition mode the published manifest carries; available -> strict re-runs bootstrap (A7). */
    publishedPartitionMode: varchar('published_partition_mode', { length: 16 }).$type<'strict' | 'available'>(),
    /** The controller asked for the legacy path (for example before disabling Availability); gating stays closed. */
    legacyRequested: boolean('legacy_requested').notNull().default(false),
    /** D9: temporary extra lease slots during a rollout; published slots = desiredReplicaCount + surgeSlots. */
    surgeSlots: integer('surge_slots').notNull().default(0),
    /** A7: when the policy switched from available to strict; strict is active once bootstrap settled. */
    strictRequestedAt: timestamp('strict_requested_at', { withTimezone: true }),
    /**
     * When the reserved holders first held every slot with no other copy reported running. Bootstrap (and a switch to
     * strict) completes only after the relay gate window passed since then (A5, A7, A16).
     */
    copiesStoppedAt: timestamp('copies_stopped_at', { withTimezone: true }),
    closingStartedAt: timestamp('closing_started_at', { withTimezone: true }),
    /** When a voter majority first persisted the lease-closed manifest (A5). */
    closingAckedAt: timestamp('closing_acked_at', { withTimezone: true }),
    plannedHandoffs: jsonb('planned_handoffs').$type<DockerAvailabilityLeasePlannedHandoff[]>().notNull().default([]),
    /** Candidate member ids of the source's last descriptor in rank order, for the lease view of every kind. */
    candidateMemberIds: jsonb('candidate_member_ids').$type<string[]>().notNull().default([]),
    /** Capabilities the source's last descriptor requires beyond the lease protocol (views name what is missing). */
    requiredCapabilities: jsonb('required_capabilities').$type<string[]>().notNull().default([]),
    modeChangedAt: timestamp('mode_changed_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'docker_availability_lease_state_mode_check',
      sql`${table.mode} IN ('legacy', 'bootstrapping', 'lease', 'closing')`
    ),
    check('docker_availability_lease_state_surge_check', sql`${table.surgeSlots} BETWEEN 0 AND 32`),
    check(
      'docker_availability_lease_state_version_check',
      sql`${table.manifestVersion} >= 0 AND ${table.voterEpoch} >= 0 AND ${table.bootstrapId} >= 0`
    ),
  ]
);

/**
 * The singleton lease signing state. Voters are per policy (A18) and live in each policy's lease state; this row only
 * tracks the key that signs manifests and the distribution revision.
 */
export const availabilityLeaseCluster = pgTable('availability_lease_cluster', {
  id: varchar('id', { length: 32 }).primaryKey(),
  /** Policy key that signs new lease blocks; moves to a new key only after the voters of every policy trust it (A14). */
  signingKeyId: varchar('signing_key_id', { length: 64 }),
  /** Distribution revision, bumped whenever any published block or the key chain changes. */
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A14 rotation links: key_id introduced by previous_key_id, signed by the previous key. */
export const availabilityLeaseKeyRotations = pgTable('availability_lease_key_rotations', {
  keyId: varchar('key_id', { length: 64 }).primaryKey(),
  previousKeyId: varchar('previous_key_id', { length: 64 }).notNull(),
  /** Base64 raw Ed25519 public key. */
  publicKey: text('public_key').notNull(),
  publicKeyFingerprint: varchar('public_key_fingerprint', { length: 71 }).notNull(),
  /** Base64 Ed25519 signature by the previous key. */
  signature: text('signature').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AvailabilityLeaseMemberKind = 'docker' | 'nginx' | 'relay';

/** What each daemon and relay last reported about the lease protocol: identity, capability and persisted acks. */
export const availabilityLeaseMembers = pgTable(
  'availability_lease_members',
  {
    memberId: varchar('member_id', { length: 64 }).primaryKey(),
    kind: varchar('kind', { length: 16 }).$type<AvailabilityLeaseMemberKind>().notNull(),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'cascade' }),
    relayInstanceId: uuid('relay_instance_id').references(() => relayInstances.id, { onDelete: 'cascade' }),
    /** Base64 PKIX DER ECDSA P-256 identity key the member signs frames with. */
    identityPublicKey: text('identity_public_key'),
    /**
     * H3: the key the member signed with before its last identity renewal, and when it changed. Manifests republish
     * with the new key at once; the previous one is kept for a multi-key member entry during the overlap.
     */
    previousIdentityPublicKey: text('previous_identity_public_key'),
    identityRotatedAt: timestamp('identity_rotated_at', { withTimezone: true }),
    watchdogReady: boolean('watchdog_ready').notNull().default(false),
    incarnation: bigint('incarnation', { mode: 'number' }).notNull().default(0),
    epochAck: bigint('epoch_ack', { mode: 'number' }).notNull().default(0),
    trustedKeyIds: text('trusted_key_ids').array().notNull().default([]),
    manifestAcks: jsonb('manifest_acks')
      .$type<Record<string, { version: number; closed: boolean; voterEpoch?: number }>>()
      .notNull()
      .default({}),
    leaseRevision: bigint('lease_revision', { mode: 'number' }).notNull().default(0),
    abstaining: boolean('abstaining').notNull().default(false),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('availability_lease_members_kind_check', sql`${table.kind} IN ('docker', 'nginx', 'relay')`),
    index('availability_lease_members_node_idx').on(table.nodeId),
  ]
);

export type DockerAvailabilityLeaseObservationSource = 'daemon' | 'acceptor' | 'relay';

/** The latest observed holder of each lease key (lease policy, slot), reconciled by the policy's source. */
export const dockerAvailabilityLeaseObservations = pgTable(
  'docker_availability_lease_observations',
  {
    policyId: uuid('policy_id')
      .notNull()
      .references(() => leasePolicies.id, { onDelete: 'cascade' }),
    slot: integer('slot').notNull(),
    /** Candidate id (the daemon's lease identity, its node id) holding the lease; null once it released or fenced. */
    holderId: varchar('holder_id', { length: 64 }),
    /** Availability only: the placement on the holder's node. */
    placementId: uuid('placement_id').references(() => dockerAvailabilityPlacements.id, { onDelete: 'set null' }),
    ballot: jsonb('ballot').$type<DockerAvailabilityLeaseBallot | null>(),
    epoch: bigint('epoch', { mode: 'number' }).notNull().default(0),
    manifestVersion: bigint('manifest_version', { mode: 'number' }).notNull().default(0),
    source: varchar('source', { length: 16 }).$type<DockerAvailabilityLeaseObservationSource>().notNull(),
    sourceId: varchar('source_id', { length: 64 }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    holderSince: timestamp('holder_since', { withTimezone: true }),
    lastHolderId: varchar('last_holder_id', { length: 64 }),
    /**
     * Every daemon that last reported a role for this key in which its copy may run (bootstrapping, recovering,
     * holding, fencing, abandoned, releasing). Bootstrap counts as acked only when no one but the reserved holder is
     * listed (A5, A7).
     */
    claimants: jsonb('claimants').$type<Record<string, { role: string; observedAt: string }>>().notNull().default({}),
    /** Stateful keys (v3): "sha256:<hex>" of the state certified by the observed commit, when a relay reported it. */
    stateHash: varchar('state_hash', { length: 80 }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.policyId, table.slot] }),
    check('docker_availability_lease_observations_slot_check', sql`${table.slot} BETWEEN 0 AND 31`),
    check(
      'docker_availability_lease_observations_source_check',
      sql`${table.source} IN ('daemon', 'acceptor', 'relay')`
    ),
  ]
);
