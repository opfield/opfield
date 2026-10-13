import type {
  AvailabilityLeaseWitness,
  DockerAvailabilityLeaseBallot,
  DockerAvailabilityLeaseMode,
  DockerAvailabilityLeaseObservationSource,
  DockerAvailabilityLeaseReason,
  DockerAvailabilityPartitionMode,
} from '@/db/schema/index.js';
import type {
  LeaseCertifiedStateDetail,
  LeaseHolderChangeNotice,
  LeasePolicyHolderView,
  LeasePolicyKind,
  LeasePolicyMode,
  LeasePolicyReason,
} from './lease-policy-source.js';
import type { LeaseVoterMargin, LeaseWitnessWarning } from './lease-voters.js';

/** A lease mode transition of one policy, delivered to the Availability controller. */
export interface DockerAvailabilityLeaseModeChange {
  policyId: string;
  from: DockerAvailabilityLeaseMode;
  to: DockerAvailabilityLeaseMode;
  reason: DockerAvailabilityLeaseReason | null;
  /** Legacy adopts these as its serving placements (A5): the last observed holder per slot. */
  lastHolders: Array<{ slot: number; holderId: string }>;
  /**
   * Graceful close (closing -> legacy): the slots whose holder reported itself retained under the closed manifest. Its
   * copy never stopped and runs on; legacy adopts it as RUNNING and never restarts it. Every other slot of lastHolders
   * expired (its holder fenced, or may have) and the legacy path starts it again. Empty for any other transition.
   */
  retainedHolders: Array<{ slot: number; holderId: string }>;
}

/** A change of lease holder of one key, delivered to the Availability controller after it was persisted. */
export type DockerAvailabilityLeaseHolderChange = Omit<
  LeaseHolderChangeNotice,
  'leaseKind' | 'resourceId' | 'stateHash'
>;

/**
 * The paid Availability controller (edition contract). Until it reports lease support every policy stays on the
 * legacy backend-driven path. Callbacks run after the host persisted the change; a failure is logged and the
 * controller sees the persisted state on its next reconcile.
 */
export interface DockerAvailabilityLeaseController {
  leaseModeSupported(): boolean;
  leaseModeChanged(change: DockerAvailabilityLeaseModeChange): Promise<void>;
  leaseHolderChanged(change: DockerAvailabilityLeaseHolderChange): Promise<void>;
}

export interface DockerAvailabilityLeaseHolderView {
  slot: number;
  /** Docker node id of the holder; null while the key is free. */
  holderNodeId: string | null;
  placementId: string | null;
  ballot: DockerAvailabilityLeaseBallot | null;
  observedAt: Date;
  holderSince: Date | null;
  source: DockerAvailabilityLeaseObservationSource;
}

/**
 * Why a Docker candidate cannot hold a slot or receive a standby right now (D3). A per-node condition never changes the
 * policy's mode: the node is only left out.
 * - offline: its daemon has no control connection to Opfield;
 * - watchdog_missing: its lease watchdog is not running (or cannot be installed), so the daemon refuses to hold;
 * - daemon_outdated: its daemon does not advertise availability_lease_v2;
 * - identity_pending: its daemon has not reported a lease identity key yet.
 */
export type DockerAvailabilityLeaseExclusionReason =
  | 'offline'
  | 'watchdog_missing'
  | 'daemon_outdated'
  | 'identity_pending';

export interface DockerAvailabilityLeaseExcludedNode {
  nodeId: string;
  reason: DockerAvailabilityLeaseExclusionReason;
}

/** Read-only lease state of a policy for the API, the UI and the controller. */
export interface DockerAvailabilityLeaseView {
  mode: DockerAvailabilityLeaseMode;
  reason: DockerAvailabilityLeaseReason | null;
  manifestVersion: number;
  epoch: number;
  /** Partition mode the published manifest carries; differs from the policy while a change propagates. */
  publishedPartitionMode: DockerAvailabilityPartitionMode | null;
  holders: DockerAvailabilityLeaseHolderView[];
  /** Slots reserved for their current serving placement until it acquires (A5). */
  bootstrap: Array<{ slot: number; holderNodeId: string }>;
  /** D9: temporary extra lease slots of a replicated rollout; the manifest publishes desired + surgeSlots slots. */
  surgeSlots: number;
  /** A7: a switch from available to strict is in progress; strict is not active yet. */
  strictPending: boolean;
  /**
   * When the reserved holders first held with no other copy running. Bootstrap and a strict switch complete once the
   * relay gate window (24 s) passed since then (A16); null while other copies may still run.
   */
  copiesStoppedAt: Date | null;
  /** When the policy entered its current lease mode: a bootstrap that makes no progress is diagnosed from it (B-23). */
  modeChangedAt?: Date | null;
  /**
   * Candidates left out of holding and of standby provisioning right now, with the reason (D3). Voters and manifest
   * candidates follow an outdated or unidentified node only after the condition lasted 2 minutes; offline and
   * watchdog conditions never change them (the data plane itself keeps such a node from holding).
   */
  excludedNodes: DockerAvailabilityLeaseExcludedNode[];
  /**
   * Graceful close, while closing: per slot, the holder the closed manifest lets keep its copy running (retained) and
   * whether it confirmed that (a majority of every quorum set confirmed the close to it). Legacy then adopts a
   * confirmed one as running; one that never confirms fences and legacy starts the slot again after the lease expired.
   */
  retainedHolders: Array<{ slot: number; holderNodeId: string; confirmed: boolean }>;
  /** Per-policy voter reachability margin over its quorum sets (A18). */
  voterMargin: LeaseVoterMargin | null;
  /** Voters of the newest quorum set: candidate hosts in rank order, then witnesses (A18). */
  voters: string[];
  /** The (first) witness and the witness warning (A19); memberId null when none is needed or none is eligible. */
  witness: DockerAvailabilityLeaseWitnessView | null;
  witnesses: AvailabilityLeaseWitness[];
}

export interface DockerAvailabilityLeaseWitnessView {
  memberId: string | null;
  kind: 'relay' | 'docker' | null;
  /** Chosen automatically, or configured on the policy. */
  auto: boolean;
  /** Smallest round trip from any candidate, when every candidate measured it. */
  minRttMs: number | null;
  warning: LeaseWitnessWarning | null;
}

export interface DockerAvailabilityLeaseHandoffInput {
  slot: number;
  /** Docker node id of the successor candidate. */
  successorNodeId: string;
  successorGeneration: number;
  operationId?: string | null;
  timeoutMs?: number;
}

/**
 * Why a candidate of a lease policy cannot hold right now: the Docker reasons (D3), and capability_missing when the
 * policy requires a capability the daemon does not advertise (a stateful policy needs availability_lease_v3 and its
 * application capability).
 */
export type LeasePolicyExclusionReason = DockerAvailabilityLeaseExclusionReason | 'capability_missing';

export interface LeasePolicyExcludedMember {
  memberId: string;
  reason: LeasePolicyExclusionReason;
  /** capability_missing: the required capabilities the member lacks. */
  missingCapabilities?: string[];
}

/** The certified holder state of one stateful key as the lease view shows it. */
export interface LeasePolicyCertifiedStateView {
  slot: number;
  /** Current holder observed for the key. */
  holderMemberId: string | null;
  /** "sha256:<hex>" of the certified state of the observed commit (relays report it, v3). */
  stateHash: string | null;
  observedAt: Date | null;
  /** The source's decoded summary (durability, sync set, floors, forced marker), when it provides one. */
  detail: LeaseCertifiedStateDetail | null;
}

/** Read-only lease state of any lease policy (API, MCP, UI). */
export interface LeasePolicyView {
  leasePolicyId: string;
  kind: LeasePolicyKind;
  resourceId: string;
  stateful: boolean;
  mode: LeasePolicyMode;
  /** Why lease mode is impossible (with since), or for a stateful policy why it runs degraded. */
  reason: LeasePolicyReason | null;
  /** A stateful policy that cannot run as it should: the host keeps it (AS9) and reports the reason instead. */
  degraded: boolean;
  manifestVersion: number;
  epoch: number;
  /** A voter change is in its joint phase (two quorum sets, A4); stateful: until a live holder renewed under it. */
  joint: boolean;
  publishedPartitionMode: 'strict' | 'available' | null;
  holders: LeasePolicyHolderView[];
  bootstrap: Array<{ slot: number; holderMemberId: string }>;
  /** Candidates of the source's last descriptor in rank order. */
  candidates: string[];
  excludedMembers: LeasePolicyExcludedMember[];
  voterMargin: LeaseVoterMargin | null;
  voters: string[];
  quorumSets: string[][];
  witness: DockerAvailabilityLeaseWitnessView | null;
  witnesses: AvailabilityLeaseWitness[];
  /** Stateful policies: per slot, the certified state; null for stateless policies. */
  certifiedState: LeasePolicyCertifiedStateView[] | null;
}
