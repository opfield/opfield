import type {
  DockerAvailabilityLeaseBallot,
  DockerAvailabilityLeaseMode,
  DockerAvailabilityLeaseObservationSource,
  DockerAvailabilityLeaseReason,
  LeasePolicyKind,
} from '@/db/schema/index.js';
import type { CommandResult } from '@/grpc/generated/types.js';
import type { LeaseHolderChange, LeaseHolderChangeKind } from './lease-planning.js';
import type { DockerAvailabilityLeaseHandoffInput, LeasePolicyView } from './lease-types.js';

export type { LeasePolicyKind };

/** legacy, bootstrapping, lease or closing (D10, A5); the same state machine for every kind. */
export type LeasePolicyMode = DockerAvailabilityLeaseMode;

/** Why a lease policy cannot run (or, for stateful policies, why it runs degraded); `since` as for Availability. */
export type LeasePolicyReason = DockerAvailabilityLeaseReason;

/**
 * One lease candidate. memberId is the lease identity of the daemon that may hold (its node id: docker daemons sign
 * lease frames as their node); rank orders takeover (D5), lowest first.
 */
export interface LeasePolicyCandidate {
  memberId: string;
  nodeId: string;
  rank: number;
}

/**
 * Everything the host needs to publish one lease policy. The host chooses voters
 * and the witness (A18-A20), runs the epochs and joint consensus (A4, A16, AS1), signs and distributes manifests, gates
 * on capabilities, ingests reports and keeps the relay gates; the source only says what should be published.
 */
export interface LeasePolicyDescriptor {
  leasePolicyId: string;
  kind: LeasePolicyKind;
  resourceId: string;
  resourceName: string;
  mode: 'failover' | 'replicated';
  slots: number;
  /** Stateful policies are strict only (AS8): the host refuses to publish them with available. */
  partitionMode: 'strict' | 'available';
  stateful: boolean;
  candidates: LeasePolicyCandidate[];
  /** A configured witness (relay instance id or docker node id); null chooses one automatically (A19, S3). */
  witnessMemberId: string | null;
  /**
   * Restricts the automatic witness choice (availability sets, decision 7): only these relays may be witnesses (admin
   * flag and local opt-in), and, when nodeIds is given, only these docker nodes. Undefined: every capable relay and
   * docker node (Docker Availability, unchanged).
   */
  witnessFilter?: { relayIds: readonly string[]; nodeIds?: readonly string[] };
  /**
   * An odd voter count to reach with automatic witnesses when enough eligible ones exist (availability sets with 2 data
   * members ask for 5, so one data node and one witness can be lost without Gateway); the count never ends even, and
   * falls back to the smallest odd count (3) when too few witnesses are eligible. Undefined: the smallest odd count.
   */
  preferredVoterCount?: number;
  /** The reservation a bootstrap publishes (A5): the named holder acquires first. */
  bootstrap: Array<{ slot: number; holderMemberId: string }> | null;
  /** Close the lease. For stateful policies this is the only way a lease closes (AS9). */
  closed: boolean;
  /**
   * Capabilities every candidate, the witness, every relay member and every carrying relay must advertise, e.g.
   * ['availability_lease_v3', 'managed_availability_member_v1']. availability_lease_v2 is always required.
   */
  requiredCapabilities: string[];
  specFingerprint?: string;
  /**
   * Host refinements (optional, documented contract extension; the Availability source uses them). A kind that has
   * no such conditions leaves them out.
   * - unavailable: lease mode is not possible for a reason of the source (edition, a hold on the backend path); an
   *   immediate reason closes at once, any other only after it lasted 2 minutes (D3). Stateful policies never close
   *   for it (AS9): they report it as degraded.
   * - observerNodeIds: nginx nodes that route to the members and gate on the lease (must speak the lease protocol).
   * - servingMemberIds: candidates serving right now; entering lease mode needs each of them able to hold, because
   *   the bootstrap reserves them.
   * - entryHold: do not enter lease mode now (an operation changes the runtime).
   * - carryingRelayIds: relays carrying lease-gated traffic besides the ones the host finds from relay endpoints.
   */
  unavailable?: { code: string; message: string; immediate: boolean } | null;
  observerNodeIds?: string[];
  servingMemberIds?: string[];
  entryHold?: boolean;
  carryingRelayIds?: string[];
}

/** A mode transition of one lease policy, delivered to its source after the host persisted it. */
export interface LeaseModeChange {
  leasePolicyId: string;
  leaseKind: LeasePolicyKind;
  resourceId: string;
  from: LeasePolicyMode;
  to: LeasePolicyMode;
  reason: LeasePolicyReason | null;
  /** The last holder per slot (A5); for a stateful close (AS9) the holder of the highest observed commit. */
  lastHolders: Array<{ slot: number; holderId: string }>;
  /**
   * Graceful close (closing -> legacy): the slots whose holder reported itself retained under the closed manifest. Its
   * copy never stopped and runs on; legacy adopts it as RUNNING and never restarts it. Every other slot of lastHolders
   * expired (its holder fenced, or may have) and the legacy path starts it again. Empty for any other transition.
   */
  retainedHolders: Array<{ slot: number; holderId: string }>;
  /** Members that persisted the lease-closed manifest (set when a closing lease hands over to legacy). */
  closeAckedBy: string[];
}

/**
 * A change of holder of one key, delivered to its source after the host persisted it (and audited it, D9). policyId is
 * the lease policy id. leaseKind, resourceId and stateHash are absent on takeover audits a release before 2.12
 * stored (Availability); the Availability controller gets the notice without them.
 */
export interface LeaseHolderChangeNotice extends LeaseHolderChange {
  policyId: string;
  leaseKind?: LeasePolicyKind;
  resourceId?: string;
  slot: number;
  /** failover or handoff; null for the first holder of a key. */
  kind: LeaseHolderChangeKind | null;
  /** Availability only: the placement on the new holder's node. */
  placementId: string | null;
  source: DockerAvailabilityLeaseObservationSource;
  sourceId: string;
  /** When Gateway noticed the change: the report that carried it arrived. */
  noticedAt?: Date;
  /** Stateful keys: "sha256:<hex>" of the certified state of the observed commit, when known. */
  stateHash?: string | null;
  /**
   * Availability set failovers: what the new holder may have missed, by the members' last reports before it took over.
   * bytes is how far it was behind (null when unknown); since is the old holder's last report, writes after it may be lost.
   */
  loss?: { bytes: number | null; since: string | null };
}

/**
 * A stateful lease policy that cannot run as it should (capability, voter or license loss, a missing source entry):
 * the host never closes it (AS9) and reports the reason instead; reason null when it recovered.
 */
export interface LeaseDegradedChange {
  leasePolicyId: string;
  leaseKind: LeasePolicyKind;
  resourceId: string;
  mode: LeasePolicyMode;
  reason: LeasePolicyReason | null;
}

/**
 * Application-level summary of the certified holder state of one stateful key, decoded by the source (the host keeps
 * the state opaque). Everything but slot is optional; the host adds what it observed itself.
 */
export interface LeaseCertifiedStateDetail {
  slot: number;
  /** "sha256:<hex>" of the certified state this detail describes. */
  stateHash: string | null;
  durability?: 'synchronous' | 'asynchronous' | null;
  syncSet?: string[];
  floors?: { eligibilityFloorLsn?: string | null; progressFloorLsn?: string | null };
  forced?: { operationId: string; timeline?: number | null; forkLsn?: string | null } | null;
  timeline?: number | null;
  generation?: number | null;
  pendingPromotion?: boolean | null;
}

/**
 * A kind's source of lease policies (contract section 2). listDesired returns every policy of the kind that should be
 * published, including a closing one until it returned to legacy; the callbacks run after the host persisted the
 * change, and a failure is logged (the source sees the persisted state on its next reconcile).
 *
 * Extensions beyond the contract (optional): degradedChanged (AS9: the host reports instead of closing a stateful
 * policy, the source decides) and certifiedStateDetails (the lease view shows the decoded certified state).
 */
export interface LeasePolicySource {
  kind: LeasePolicyKind;
  listDesired(): Promise<LeasePolicyDescriptor[]>;
  holderChanged(change: LeaseHolderChangeNotice): Promise<void>;
  modeChanged(change: LeaseModeChange): Promise<void>;
  degradedChanged?(change: LeaseDegradedChange): Promise<void>;
  certifiedStateDetails?(leasePolicyId: string): Promise<LeaseCertifiedStateDetail[]>;
}

/**
 * What a source may ask of the lease host (AvailabilityLeaseService): republish after it changed what it lists, read
 * the view, plan a handoff (a switchover, AS11) and repair a stuck bootstrap.
 */
export interface LeaseHostPort {
  republishPolicy(leasePolicyId: string): Promise<void>;
  isReactive(leasePolicyId: string): Promise<boolean>;
  getLeasePolicyView(leasePolicyId: string, now?: Date): Promise<LeasePolicyView | null>;
  requestHandoff(leasePolicyId: string, input: DockerAvailabilityLeaseHandoffInput): Promise<CommandResult>;
  registerPlannedHandoff(
    leasePolicyId: string,
    input: {
      slot: number;
      fromHolderId: string | null;
      toHolderId: string;
      operationId?: string | null;
      ttlMs?: number;
    }
  ): Promise<void>;
  reissueBootstrap(leasePolicyId: string, bootstrap: Array<{ slot: number; holderNodeId: string }>): Promise<void>;
}

/** A holder as the lease view reports it. */
export interface LeasePolicyHolderView {
  slot: number;
  holderMemberId: string | null;
  placementId: string | null;
  ballot: DockerAvailabilityLeaseBallot | null;
  observedAt: Date;
  holderSince: Date | null;
  source: DockerAvailabilityLeaseObservationSource;
  stateHash: string | null;
}
