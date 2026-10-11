import type { AvailabilityLeaseWitness } from '@/db/schema/index.js';

/** A18: a policy's quorum set never has more voters. Candidates beyond the cap still acquire (proposers need not vote). */
export const MAX_POLICY_VOTERS = 7;

/** A19: a witness closer than this to any candidate probably shares its site. */
export const WITNESS_NEAR_RTT_MS = 2;

export type LeaseWitnessWarning =
  /** The chosen witness is within 2 ms of a candidate, likely on its site. */
  | 'witness_near_candidate'
  /** No eligible witness exists: autonomous failover needs a majority of the candidates. */
  | 'no_eligible_witness'
  /** The configured witness is not eligible right now (a candidate, same host, not capable, unknown); auto is used. */
  | 'configured_witness_unavailable';

/** A candidate docker node of the policy, in manifest rank order. */
export interface LeaseVoterCandidateNode {
  id: string;
  /** Physical host (A20): two daemons, or a daemon and a relay, on one machine share it. */
  hostKey: string;
  /** Fault domains of relays running on the same host, for the witness fallback. */
  faultDomains: readonly string[];
  publicKey: string | null;
  /** May vote (D3: availability_lease_v2 and an identity key, or a current voter within its grace). Default true. */
  voterCapable?: boolean;
}

/** A relay or docker node that may be a witness (A19). nginx daemons are observers only and never listed. */
export interface LeaseWitnessCandidate {
  id: string;
  kind: 'relay' | 'docker';
  hostKey: string;
  faultDomain: string | null;
  capable: boolean;
  /** Gateway's local relay: it stops with Gateway, so it is no witness while a remote relay can be one (N-2). */
  local?: boolean;
  /** Ready to vote now (a relay in state ready); only matters for a new choice. Default true. */
  ready?: boolean;
  publicKey: string | null;
  /** Round trip in ms from a candidate node to this member, when that node measured it. */
  rttFrom(candidateId: string): number | undefined;
}

export interface PolicyVoterSelection {
  /** Candidate voters in rank order (distinct hosts), then witnesses. */
  voterIds: string[];
  witnesses: AvailabilityLeaseWitness[];
  warning: LeaseWitnessWarning | null;
  /**
   * D3: the selection holds at least a quorum of its target size (odd, at least 3). When it does not, lease mode is
   * impossible and the published voters stay as they are.
   */
  viable: boolean;
  /** Candidates that cannot vote (not availability_lease_v2 or no identity key). */
  nonVotingCandidateIds: string[];
}

/** The smallest round trip to all candidates, or null unless every candidate measured this member. */
export function witnessMinRtt(
  member: LeaseWitnessCandidate,
  candidates: readonly LeaseVoterCandidateNode[]
): number | null {
  if (candidates.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const rtt = member.rttFrom(candidate.id);
    if (rtt === undefined || !Number.isFinite(rtt)) return null;
    min = Math.min(min, rtt);
  }
  // Tenths of a millisecond: finer jitter must not rewrite the stored witness on every reconcile.
  return Math.round(min * 10) / 10;
}

function smallestOddAtLeast(value: number): number {
  return value % 2 === 1 ? value : value + 1;
}

/**
 * The voters of one policy (A18, A19, A20, D3): the distinct hosts among its voter-capable candidates in rank order,
 * then witnesses so the count is odd and at least 3, at most 7 in total. A configured witness comes first when
 * eligible. Automatic ones never use Gateway's local relay while another ready relay can witness (it stops with
 * Gateway and does not count for the margin), keep the current witnesses while they stay eligible (no churn), then
 * prefer a member that is ready, the largest minimum round trip to the candidates in whole milliseconds (so jitter
 * between similar relays never changes the choice), a relay in a fault domain no candidate host shares, any relay,
 * then docker nodes, and finally the member id.
 */
export function selectPolicyVoters(input: {
  candidates: readonly LeaseVoterCandidateNode[];
  pool: readonly LeaseWitnessCandidate[];
  configuredWitness: string | null;
  currentAutoWitnesses?: readonly string[];
  /** An odd voter count to reach when enough witnesses are eligible (never ends even); see LeasePolicyDescriptor. */
  preferredVoterCount?: number;
}): PolicyVoterSelection {
  const candidates = input.candidates.filter((candidate) => candidate.publicKey && candidate.voterCapable !== false);
  const nonVotingCandidateIds = input.candidates
    .filter((candidate) => !candidate.publicKey || candidate.voterCapable === false)
    .map((candidate) => candidate.id);
  const candidateIds = new Set(input.candidates.map((candidate) => candidate.id));
  const usedHosts = new Set<string>();
  const candidateVoters: string[] = [];
  for (const candidate of candidates) {
    if (usedHosts.has(candidate.hostKey)) continue;
    usedHosts.add(candidate.hostKey);
    candidateVoters.push(candidate.id);
  }
  const candidateHosts = new Set(input.candidates.map((candidate) => candidate.hostKey));
  const candidateDomains = new Set(input.candidates.flatMap((candidate) => candidate.faultDomains));
  const eligible = (member: LeaseWitnessCandidate) =>
    member.capable && Boolean(member.publicKey) && !candidateIds.has(member.id) && !candidateHosts.has(member.hostKey);
  let warning: LeaseWitnessWarning | null = null;
  const configured = input.configuredWitness
    ? input.pool.find((member) => member.id === input.configuredWitness && eligible(member))
    : undefined;
  if (input.configuredWitness && !configured) warning = 'configured_witness_unavailable';
  const configuredCount = configured ? 1 : 0;
  const cappedCandidates = candidateVoters.slice(0, MAX_POLICY_VOTERS - configuredCount);
  const target = Math.min(
    MAX_POLICY_VOTERS,
    smallestOddAtLeast(Math.max(3, cappedCandidates.length + configuredCount))
  );
  const hosts = new Set(cappedCandidates.map((id) => candidates.find((candidate) => candidate.id === id)!.hostKey));
  const chosen: Array<{ member: LeaseWitnessCandidate; auto: boolean }> = [];
  if (configured) {
    chosen.push({ member: configured, auto: false });
    hosts.add(configured.hostKey);
  }
  const current = new Set(input.currentAutoWitnesses ?? []);
  // D3 / N-2: Gateway's local relay stops with Gateway and does not count for the margin, so it is never the
  // automatic witness while another ready relay can witness, even when it is the current witness.
  const remoteRelayReady = input.pool.some(
    (member) => member.kind === 'relay' && !member.local && member.ready !== false && eligible(member)
  );
  const rank = (member: LeaseWitnessCandidate): number[] => {
    const rtt = witnessMinRtt(member, candidates);
    const separateDomain =
      member.kind === 'relay' && member.faultDomain !== null && !candidateDomains.has(member.faultDomain);
    return [
      member.local && remoteRelayReady ? 1 : 0,
      current.has(member.id) ? 0 : 1,
      member.ready === false ? 1 : 0,
      rtt !== null ? 0 : 1,
      rtt !== null ? -Math.round(rtt) : 0,
      separateDomain ? 0 : 1,
      member.kind === 'relay' ? 0 : 1,
    ];
  };
  const autos = input.pool
    .filter((member) => eligible(member) && member.id !== configured?.id)
    .map((member) => ({ member, rank: rank(member) }))
    .sort((left, right) => {
      for (let index = 0; index < left.rank.length; index++) {
        if (left.rank[index] !== right.rank[index]) return left.rank[index]! - right.rank[index]!;
      }
      return left.member.id.localeCompare(right.member.id);
    });
  const preferred =
    input.preferredVoterCount !== undefined
      ? Math.min(MAX_POLICY_VOTERS, Math.max(target, smallestOddAtLeast(input.preferredVoterCount)))
      : target;
  for (const { member } of autos) {
    if (cappedCandidates.length + chosen.length >= preferred) break;
    if (hosts.has(member.hostKey)) continue;
    hosts.add(member.hostKey);
    chosen.push({ member, auto: true });
  }
  // Beyond the smallest odd count, an even count adds no tolerance: drop the last automatic witness.
  while (cappedCandidates.length + chosen.length > target && (cappedCandidates.length + chosen.length) % 2 === 0) {
    const last = chosen.at(-1);
    if (!last?.auto) break;
    chosen.pop();
  }
  if (cappedCandidates.length + chosen.length < target) {
    warning ??= 'no_eligible_witness';
  }
  const witnesses = chosen.map(({ member, auto }) => ({
    memberId: member.id,
    kind: member.kind,
    auto,
    minRttMs: witnessMinRtt(member, candidates),
  }));
  if (!warning && witnesses.some((witness) => witness.minRttMs !== null && witness.minRttMs < WITNESS_NEAR_RTT_MS)) {
    warning = 'witness_near_candidate';
  }
  const voterIds = [...cappedCandidates, ...witnesses.map((witness) => witness.memberId)];
  return {
    voterIds,
    witnesses,
    warning,
    viable: voterIds.length >= quorumSize({ length: target }),
    nonVotingCandidateIds,
  };
}

/** Majority of one quorum set. */
export function quorumSize(set: { readonly length: number }): number {
  return Math.floor(set.length / 2) + 1;
}

/** Whether ids hold a majority of every quorum set (joint consensus needs both, A4). */
export function holdsEveryMajority(sets: readonly (readonly string[])[], ids: ReadonlySet<string>): boolean {
  if (sets.length === 0) return false;
  return sets.every((set) => set.filter((id) => ids.has(id)).length >= quorumSize(set));
}

export interface LeaseVoterMargin {
  epoch: number;
  joint: boolean;
  /** Voters of the newest quorum set. */
  voters: number;
  /** Voters of the newest quorum set whose recent reports show them up and not abstaining. */
  reachable: number;
  /** Majority of the newest quorum set. */
  required: number;
  /** How many more reachable voters may fail before a quorum is lost; negative when it already is. */
  margin: number;
}

/** Reachability margin of a policy over every quorum set; the smallest one decides (A4). */
export function leaseVoterMargin(
  epoch: number,
  sets: readonly (readonly string[])[],
  reachable: ReadonlySet<string>
): LeaseVoterMargin | null {
  if (sets.length === 0) return null;
  const margins = sets.map((set) => set.filter((id) => reachable.has(id)).length - quorumSize(set));
  const newest = sets[sets.length - 1]!;
  return {
    epoch,
    joint: sets.length > 1,
    voters: newest.length,
    reachable: newest.filter((id) => reachable.has(id)).length,
    required: quorumSize(newest),
    margin: Math.min(...margins),
  };
}

export function sameVoterSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}
