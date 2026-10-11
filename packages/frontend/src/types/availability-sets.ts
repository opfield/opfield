// Availability of managed databases and managed storage (several servers with a primary and copies).
// Shapes of the commercial core routes `/databases/managed/:id/availability*` and
// `/managed-storage/:id/availability*` (plan db-ha §1.4).

/** The resource an availability set belongs to. */
export type AvailabilityOwner = { kind: "database"; id: string } | { kind: "storage"; id: string };

export type AvailabilityMode = "automatic" | "manual";
export type AvailabilityDurability = "synchronous" | "asynchronous";
export type AvailabilitySetState =
  | "converting"
  | "healthy"
  | "degraded"
  | "no_failover"
  | "failing_over"
  | "closing"
  | "error";
export type AvailabilityMemberRole = "primary" | "copy" | "rebuilding" | "fenced" | "unknown";
export type AvailabilityMemberStatus = "creating" | "ready" | "error" | "removing";
export type AvailabilitySyncState = "sync" | "async" | "none";

export interface AvailabilityWitnessChoice {
  relayIds?: string[];
  nodeId?: string;
}

export interface AvailabilityPreflightInput {
  /** Every member node, the resource's own node first. */
  nodeIds: string[];
  witness?: AvailabilityWitnessChoice | null;
  durability?: AvailabilityDurability | null;
}

export interface AvailabilityEnableInput extends AvailabilityPreflightInput {
  priorityMode?: boolean;
}

export interface AvailabilityWitnessPick {
  kind: "relay" | "node";
  id: string;
  name: string;
}

export interface AvailabilityPreflightResult {
  mode: AvailabilityMode;
  voters: string[];
  witnesses: AvailabilityWitnessPick[];
  rttP50Ms: number | null;
  defaultDurability: AvailabilityDurability;
  durability: AvailabilityDurability;
  lossWindowText: string;
  restartNeeded: boolean;
  policyLeaseHours: number | null;
  missingForAutomatic: string | null;
  blockers: Array<{ code: string; message: string }>;
  warnings: string[];
  /** Every eligible witness (not only the picked ones), when the backend reports it. */
  candidates?: AvailabilityWitnessPick[];
  /** The engine replicates only this way, when the backend reports it. */
  durabilityFixed?: AvailabilityDurability | null;
}

export interface AvailabilityMember {
  id: string;
  nodeId: string;
  nodeName: string | null;
  priority: number;
  role: AvailabilityMemberRole;
  eligible: boolean;
  eligibilityReason: string | null;
  lagBytes: number | null;
  lagSeconds: number | null;
  syncState: AvailabilitySyncState;
  status: AvailabilityMemberStatus;
  desiredState: "member" | "removing";
  publishedPort: number | null;
  lastError: string | null;
  lastReportedAt: string | null;
  /** The member's report is recent enough to describe it. */
  reporting: boolean;
}

export interface AvailabilityWitness {
  id: string;
  purpose: "lease" | "keeper";
  hostKind: "relay" | "node";
  relayInstanceId: string | null;
  nodeId: string | null;
  role: "active" | "standby";
  status: string;
}

export interface AvailabilityOperation {
  id: string;
  kind: string;
  step: string;
  startedAt: string;
  lastError: string | null;
}

export interface AvailabilityView {
  setId: string;
  mode: AvailabilityMode;
  state: AvailabilitySetState;
  stateReason: { code?: string; message?: string } | null;
  durability: AvailabilityDurability;
  durabilitySource: "auto" | "admin";
  lossWindowText: string;
  maxLagBytes: number;
  syncDegradeAfterSeconds: number;
  priorityMode: boolean;
  failbackDelaySeconds: number;
  rttP50Ms: number | null;
  rttMeasuredAt: string | null;
  primaryMemberId: string | null;
  primarySince: string | null;
  primaryGeneration: number;
  members: AvailabilityMember[];
  voters: string[];
  witnesses: AvailabilityWitness[];
  /** What automatic failover needs and lacks (manual pairs); null when it runs. */
  missingForAutomatic: string | null;
  /** Servers the set can lose without losing its primary role (null for manual pairs). */
  canLose: number | null;
  lease: {
    mode: string;
    degraded: boolean;
    reason: string | null;
    joint: boolean;
    holderNodeId: string | null;
  } | null;
  policyLeaseHours: number | null;
  operation: AvailabilityOperation | null;
  connection: {
    multiHostUri: string | null;
    hosts: Array<{ memberId: string; host: string; port: number }>;
  } | null;
}

export interface AvailabilitySettingsInput {
  durability?: AvailabilityDurability;
  priorityMode?: boolean;
  failbackDelaySeconds?: number;
  syncDegradeAfterSeconds?: number;
  maxLagBytes?: number;
}

/** An availability event: an audit row `availability.<event>` of the resource. */
export interface AvailabilityEvent {
  id: string;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: string;
  userId?: string | null;
}

/** Whether a relay may host availability witnesses (admin flag and the relay's local state). */
export type RelayWitnessHosting =
  | "allowed"
  | "protected_needs_opt_in"
  | "not_reported"
  | "disabled";

/** A witness process a relay hosts for an availability set. */
export interface RelayWitnessProcess {
  id: string;
  setId: string;
  ownerKind: string;
  ownerId: string;
  ownerName: string | null;
  kind: string;
  role: string;
  state: string;
  version: string | null;
  error: string | null;
}
