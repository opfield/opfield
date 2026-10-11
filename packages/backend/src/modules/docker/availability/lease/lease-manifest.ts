import type { dockerAvailabilityLeaseObservations, dockerAvailabilityLeaseState } from '@/db/schema/index.js';
import {
  decodeLeaseSignedBlock,
  encodeLeaseManifest,
  encodeLeaseSignedBlock,
  type LeaseManifestContent,
  type LeaseRetainedSlot,
  type LeaseSigner,
  leaseManifestCandidateIds,
  leaseManifestDigest,
  signLeaseBlock,
} from './lease-codec.js';
import { LEASE_TERM_MS } from './lease-constants.js';
import { type LeaseParticipants, manifestCandidateAllowed } from './lease-participants.js';
import type { LeasePolicyDescriptor } from './lease-policy-source.js';
import { planPolicyVoters } from './lease-policy-voters.js';
import type { LeaseClusterRow, LeaseMemberRow, LeaseStateRow } from './lease-store.js';
import type { PolicyVoterSelection } from './lease-voters.js';

type ObservationRow = typeof dockerAvailabilityLeaseObservations.$inferSelect;
export type LeaseStateUpdates = Partial<typeof dockerAvailabilityLeaseState.$inferInsert>;

/** Nodes that hold, run or are reserved for a slot right now: a per-node exclusion never cuts them (D3). */
export function activeLeaseNodeIds(observations: ObservationRow[], state: LeaseStateRow): Set<string> {
  const ids = new Set<string>();
  for (const observation of observations) {
    if (observation.holderId) ids.add(observation.holderId);
    for (const claimant of Object.keys(observation.claimants ?? {})) ids.add(claimant);
  }
  if (state.mode === 'bootstrapping') for (const entry of state.bootstrap) ids.add(entry.holderId);
  return ids;
}

/** A live holder: observed holding within two lease terms. */
function liveHolder(observation: ObservationRow, now: Date): boolean {
  return Boolean(observation.holderId) && now.getTime() - observation.observedAt.getTime() <= 2 * LEASE_TERM_MS;
}

/**
 * Builds, signs and versions the manifest of one lease policy (D4, A4, A16, A18). Voters change only through the
 * per-policy joint consensus; a stateful policy's joint epoch settles only through a live holder's renewal under it
 * (AS1). An unchanged manifest is re-signed with a newly trusted policy key without a new version (A16).
 */
export async function publishLeaseManifest(input: {
  descriptor: LeasePolicyDescriptor;
  state: LeaseStateRow;
  slots: number;
  observations: ObservationRow[];
  participants: LeaseParticipants;
  members: Map<string, LeaseMemberRow>;
  cluster: LeaseClusterRow;
  ranked: string[];
  selection: PolicyVoterSelection | null;
  /** Graceful close: the retained holders a closed manifest names (closing only). */
  retained?: LeaseRetainedSlot[];
  sign: LeaseSigner;
  now: Date;
}): Promise<{ updates: LeaseStateUpdates; published: boolean }> {
  const { descriptor, state, slots, observations, participants, ranked, selection, now } = input;
  const none = { updates: {}, published: false };
  const signingKeyId = input.cluster.signingKeyId;
  if (!signingKeyId) return none;
  const closed = state.mode === 'closing';
  const policyId = descriptor.leasePolicyId;
  // D3: a node that runs an outdated daemon (or has no identity) is no manifest candidate, so it never acquires. A
  // node already listed keeps its place through the 2-minute grace, and a node that holds or runs a copy is never
  // cut (removal from the manifest fences it). Offline and watchdog-less nodes stay: the data plane keeps them from
  // holding by itself, and taking them out would only churn the manifest.
  const active = activeLeaseNodeIds(observations, state);
  const listed = new Set(leaseManifestCandidateIds(state.manifestBlock));
  const candidates = ranked.flatMap((nodeId) => {
    const participant = participants.byId.get(nodeId);
    const publicKey = participant?.publicKey;
    if (
      !publicKey ||
      !manifestCandidateAllowed(participant, { active: active.has(nodeId), listed: listed.has(nodeId) })
    )
      return [];
    return [{ id: nodeId, publicKey: Buffer.from(publicKey, 'base64') }];
  });
  if (candidates.length === 0 && !closed) return none;
  const currentVoters = state.quorumSets.at(-1) ?? [];
  // A closing lease keeps its voters as they are, joint or not: the close needs a majority of the sets it names.
  const plan = closed
    ? { next: state, jointStarted: false }
    : planPolicyVoters({
        state,
        desired: selection ? selection.voterIds : currentVoters,
        memberOf: (id) => {
          const participant = participants.byId.get(id);
          return participant?.publicKey ? { id, role: participant.role, publicKey: participant.publicKey } : null;
        },
        ackedEpoch: (memberId) => {
          const ack = input.members.get(memberId)?.manifestAcks[policyId];
          if (!ack) return 0;
          if (ack.voterEpoch) return ack.voterEpoch;
          return state.jointVersion > 0 && ack.version >= state.jointVersion ? state.voterEpoch : 0;
        },
        activeLeaseEpochs: observations
          .filter((observation) => liveHolder(observation, now))
          .map((observation) => observation.epoch),
        ...(descriptor.stateful
          ? {
              liveHolderEpochs: {
                slots,
                bySlot: new Map(
                  observations
                    .filter((observation) => liveHolder(observation, now))
                    .map((observation) => [observation.slot, observation.epoch])
                ),
              },
            }
          : {}),
        now,
      });
  const voters = plan.next;
  const updates: LeaseStateUpdates = {};
  if (selection && JSON.stringify(selection.witnesses) !== JSON.stringify(state.witnesses))
    updates.witnesses = selection.witnesses;
  if (selection && selection.warning !== state.witnessWarning) updates.witnessWarning = selection.warning;
  if (voters.jointAckedAt !== state.jointAckedAt) updates.jointAckedAt = voters.jointAckedAt;
  // Members (A18): the voters of every quorum set, plus every capable relay as a non-voting member so its data-path
  // gate keeps shadow accepts for this policy (A11, A15). nginx daemons are observers and never members. For a
  // policy that requires more (stateful: v3) the participants are already restricted to relays that advertise it.
  const voterIds = new Set(voters.quorumSets.flat());
  const members = [
    ...voters.voterMembers.filter((member) => voterIds.has(member.id)),
    ...participants.relays
      .filter((relay) => relay.voterCapable && relay.publicKey && !voterIds.has(relay.id))
      .map((relay) => ({ id: relay.id, role: 'relay' as const, publicKey: relay.publicKey! })),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const known = new Set(candidates.map((candidate) => candidate.id));
  const content: LeaseManifestContent = {
    policyId,
    mode: descriptor.mode,
    partitionMode: descriptor.partitionMode,
    slots,
    candidates,
    specFingerprint: descriptor.specFingerprint ?? '',
    voterEpoch: voters.voterEpoch,
    closed,
    bootstrapId: state.bootstrap.length > 0 ? state.bootstrapId : 0,
    // A bootstrap holder must be a candidate; one that is not stays unreserved (rank-based acquisition).
    bootstrap: state.bootstrap.filter((entry) => entry.slot < slots && known.has(entry.holderId)),
    members: members.map((member) => ({ ...member, publicKey: Buffer.from(member.publicKey, 'base64') })),
    quorumSets: voters.quorumSets,
    // Graceful close: a retained holder must be a candidate of the same manifest (acceptors check it by its key).
    ...(closed
      ? { retained: (input.retained ?? []).filter((entry) => entry.slot < slots && known.has(entry.holderId)) }
      : {}),
    ...(descriptor.stateful ? { stateful: true } : {}),
  };
  const digest = leaseManifestDigest(content);
  if (digest === state.manifestDigest && state.manifestBlock) {
    // A16: once voters trust a new policy key the current manifest is signed again with it, same payload.
    const current = decodeLeaseSignedBlock(Buffer.from(state.manifestBlock, 'base64'));
    if (current.signingKeyId === signingKeyId) return { updates, published: false };
    const resigned = await signLeaseBlock(current.kind, current.payload, signingKeyId, input.sign);
    return {
      updates: { ...updates, manifestBlock: encodeLeaseSignedBlock(resigned).toString('base64') },
      published: true,
    };
  }
  const manifestVersion = state.manifestVersion + 1;
  const block = await signLeaseBlock(
    'LEASE_BLOCK_KIND_MANIFEST',
    encodeLeaseManifest(content, manifestVersion),
    signingKeyId,
    input.sign
  );
  return {
    updates: {
      ...updates,
      manifestVersion,
      voterEpoch: voters.voterEpoch,
      quorumSets: voters.quorumSets,
      voterMembers: voters.voterMembers,
      jointVersion: plan.jointStarted ? manifestVersion : voters.jointVersion,
      jointAckedAt: voters.jointAckedAt,
      manifestDigest: digest,
      manifestBlock: encodeLeaseSignedBlock(block).toString('base64'),
      publishedPartitionMode: descriptor.partitionMode,
    },
    published: true,
  };
}
