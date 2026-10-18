import type { CA, Node, NodeInstallation, ProxyHost } from "@/types";
import type { RelayWitnessHosting, RelayWitnessProcess } from "@/types/availability-sets";
import type { InferenceSelfUsage } from "@/types/inference";
import type { UpdateStatus } from "@/types/system";

// Dashboard Stats
export interface DashboardStats {
  proxyHosts: {
    total: number;
    enabled: number;
    online: number;
    offline: number;
    degraded: number;
  };
  sslCertificates: {
    total: number;
    active: number;
    expiringSoon: number;
    expired: number;
  };
  pkiCertificates: {
    total: number;
    active: number;
    revoked: number;
    expired: number;
  };
  cas: {
    total: number;
    active: number;
  };
}

export type DashboardAttentionSeverity = "info" | "warning" | "critical";
export type NavigationAttentionSeverity = "warning" | "critical";

export interface DashboardAttentionNotice {
  id: string;
  severity: DashboardAttentionSeverity;
  /**
   * What the notice is about: node ids (`node-capacity`, `node-health`), route ids (`proxy-health`),
   * pinned database ids, pinned Docker keys `kind:nodeId:id`, inference windows (`inference-usage`), or public model ids
   * with requests that ran without a price (`inference-unpriced`).
   */
  ids?: string[];
  /** How many certificates or replicas the notice counts. */
  count?: number;
}

export type RelayLifecycleState =
  | "migration_pending"
  | "maintenance"
  | "healthy"
  | "suspect"
  | "degraded"
  | "recovering"
  | "critical"
  | "unavailable"
  | "rebalancing"
  | "rebalance_available"
  | "local_relay_restarting";

/**
 * The local relay does not serve (`restarting`), or serves again while nodes and relays that
 * dropped with it are still coming back (`reconnecting`). Their control streams run through it,
 * so none of them failed.
 */
export interface RelayLocalOutage {
  phase: "restarting" | "reconnecting";
  since: string;
  servingAgainAt: string | null;
  planned: boolean;
  reconnectingNodes?: number;
  reconnectingRelays?: number;
}

export interface DashboardRelaySnapshot {
  state: RelayLifecycleState;
  impact: string | null;
  attempt: number;
  maxAttempts: 3;
  lastHealthyAt: string | null;
  reason?: string | null;
  lastProbeAt?: string | null;
  attemptHistory?: Array<{
    attempt: number;
    startedAt: string;
    action?: "start" | "restart" | "compose_up";
    result: "running" | "failed" | "healthy";
  }>;
  relayBuildVersion?: string | null;
  protocolMajor?: number | null;
  registeredEndpoints?: number;
  activeTunnels?: number;
  activeProxyTunnels?: number;
  activeDatabaseTunnels?: number;
  throttledProxyTotal?: number;
  throttledDatabaseTotal?: number;
  pressurePercent?: number;
  cpuPressurePercent?: number;
  memoryPressurePercent?: number;
  fdPressurePercent?: number;
  admissionState?: string;
  memoryRssBytes?: number;
  heapInUseBytes?: number;
  memoryLimitBytes?: number;
  openFileDescriptors?: number;
  fileDescriptorLimit?: number;
  expectedService?: string;
  expectedImage?: string | null;
  expectedVersion?: string | null;
  canRetry?: boolean;
  /** The local relay's own view of its last outage, while it lasts. */
  outage?: RelayLocalOutage | null;
  /** The pool's view: the outage with the nodes and relays still coming back. */
  localRelayOutage?: RelayLocalOutage | null;
  poolId?: string;
  rebalanceAvailable?: boolean;
  worstPressurePercent?: number;
  endpointCount?: number;
  instances?: DashboardRelayInstance[];
  staging?: Array<{ id: string; endpointId: string; generation: number; state: string }>;
  failures?: Array<{
    id: string;
    endpointId: string;
    generation: number;
    activationError: string | null;
    updatedAt: string;
  }>;
  attempts?: Array<{
    id: string;
    endpointId: string;
    workload: string;
    generation: number;
    state: "active" | "staging" | "failed" | "draining" | "retired";
    activationError: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  blockers?: string[];
  /**
   * Advisory conditions: links whose node reaches no relay off the Opfield host (the pool stays healthy), relays
   * offline for a day or more that are still availability lease members.
   */
  warnings?: Array<
    | {
        code: "opfield_host_only";
        endpointId: string;
        ownerKind: string;
        ownerId: string;
        nodeId: string | null;
        message: string;
      }
    | {
        code: "offline_lease_member";
        relayInstanceId: string;
        offlineSince: string;
        message: string;
      }
  >;
  automaticRebalancePaused?: boolean;
  automaticRebalanceRetryAt?: string | null;
  update?: { state: string; targetVersion: string; error: string | null } | null;
  local?: DashboardRelaySnapshot | null;
}

export interface RelayRebalanceOutcome {
  id: string;
  state: "active" | "staging" | "failed" | "draining" | "retired";
  error: string | null;
}

export interface DashboardRelayInstance {
  id: string;
  kind: "local" | "remote";
  nodeId: string | null;
  faultDomainId: string;
  displayName: string;
  advertisedAddresses: string[];
  servicePort: number;
  state: "joining" | "synchronizing" | "ready" | "draining" | "offline" | "error";
  buildVersion: string | null;
  protocolMajor: number | null;
  appliedPolicyRevision: number;
  policyExpiresAt: string | null;
  lastSeenAt: string | null;
  activeAssignments: number;
  retainedAssignments?: number;
  /** `error`: what the step could not avoid, or what its streams did; `drainDeadlineAt`: when its drain ends. */
  updateStep?: { state: string; error: string | null; drainDeadlineAt?: string | null } | null;
  /** An offline remote relay: when Opfield allows its removal (policy expired, 90 s silent). */
  removableAfter?: string | null;
  /** Most nodes that measure this relay cannot reach its relay port; it gets no connections meanwhile. */
  dataPlaneFailing?: boolean;
  health?: {
    activeTunnels?: number;
    registeredEndpoints?: number;
    pressurePercent?: number;
    /** The relay's last reported problem, such as why it is not ready. */
    lastError?: string;
  } | null;
  /** Why this relay refuses Opfield policy and what repairs it; null when trust is fine. */
  policyTrust?: RelayPolicyTrustStatus | null;
  /** Certificate expiry or renewal problems; null when the certificate is fine. */
  certificate?: RelayCertificateStatus | null;
  /** Route revocations this relay has not applied; null when it holds none. */
  revocation?: RelayRevocationStatus | null;
  /** Its control stream ended with the local relay and has not come back yet. */
  reconnecting?: boolean;
  /** Its machine owner turned protected mode on: no console, files, commands or host diagnostics from Opfield. */
  protected?: boolean;
  /**
   * Change port: `available`; `update_required` for a relay version without the command; `protected` (the owner sets
   * the port on the host); `unsupported` for the local relay.
   */
  servicePortChange?: "available" | "update_required" | "protected" | "unsupported";
  /** Whether availability witnesses may run here (admin flag and the relay's local state). */
  witnessHosting?: RelayWitnessHosting;
  /** The admin flag alone (newer backends). */
  witnessHostingAllowed?: boolean;
  /** Witness processes the relay hosts (newer backends). */
  witnesses?: RelayWitnessProcess[];
}

/**
 * `stale`: the relay missed the acknowledgement deadline, so daemons refuse the revoked routes
 * through it (its other routes keep working). `pending`: still inside the deadline.
 */
export interface RelayRevocationStatus {
  state: "pending" | "stale";
  message: string;
  staleRoutes: number;
  pendingRoutes: number;
  requiredRevision: number;
  since: string;
}

export interface RelayCertificateStatus {
  state: "expiring" | "expired" | "renewal_failed";
  message: string;
  expiresAt: string | null;
  observedAt: string;
}

export interface RelayPolicyTrustStatus {
  state:
    | "locked_out"
    | "recovered"
    | "recovery_unsupported"
    | "recovery_failed"
    | "reenrollment_required";
  message: string;
  observedAt: string;
  trustedKeyIds: string[];
}

/** A single-use token that re-enrolls an enrolled remote relay through the relay installer. */
export interface RelayReenrollment extends NodeInstallation {
  instanceId: string;
  nodeId: string;
  displayName: string;
  enrollmentToken: string;
  enrollmentTokenExpiresAt: string;
  advertiseAddress: string | null;
  servicePort: number;
  /** The relay release the pool runs; the installer pins it. */
  relayVersion?: string | null;
  opfieldCertSha256: string;
  opfieldEnrollmentTargets?: {
    public?: { label: string; address: string | null };
    local?: { label: string; address: string | null };
  };
}

export interface DashboardPinnedDockerResourceRequest {
  /** The pin key, echoed back: node and name for a container, the ID for a deployment or a Compose project. */
  id: string;
  nodeId: string;
  kind: "container" | "deployment" | "compose";
  scopeResourceId?: string;
  /** A container's name: the server finds the container by it (its Docker ID changes on every recreate). */
  name?: string;
}

export interface DashboardBootstrapRequest {
  showSystemCertificates?: boolean;
  showUpdateNotifications?: boolean;
  pins?: {
    dashboard?: {
      nodeIds?: string[];
      proxyHostIds?: string[];
      databaseIds?: string[];
      storageIds?: string[];
      dockerResources?: DashboardPinnedDockerResourceRequest[];
    };
    sidebar?: {
      nodeIds?: string[];
      proxyHostIds?: string[];
      databaseIds?: string[];
      storageIds?: string[];
      dockerResources?: DashboardPinnedDockerResourceRequest[];
    };
  };
}

export interface DashboardBootstrap {
  fetchedAt: string;
  stats: DashboardStats;
  health: Array<{
    id: string;
    domainNames: string[];
    type: string;
    enabled: boolean;
    healthStatus: string | null;
    lastHealthCheckAt: string | null;
  }>;
  requestedPins: Required<NonNullable<DashboardBootstrapRequest["pins"]>>;
  nodes: Node[];
  expiring: Array<{
    id: string;
    name: string;
    type: "ssl" | "pki" | "ca";
    expiresAt: string;
  }>;
  cas: CA[];
  activity: unknown[];
  finalizeSetup: unknown | null;
  mfa: {
    totpConfigured: boolean;
    passkeyCount: number;
    recoveryCodeCount: number;
    required: boolean;
    showReminder: boolean;
    sessionMfaSatisfied: boolean;
    graceExpiresAt: number | null;
  } | null;
  update: UpdateStatus | null;
  loggingHealth: unknown | null;
  inferenceUsage: InferenceSelfUsage | null;
  inviteUserMethods: { password: boolean; emailOtp: boolean } | null;
  relay: DashboardRelaySnapshot | null;
  /** Managed database and storage certificates that need attention, limited to what the viewer may see. */
  managedCertificates?: DashboardManagedCertificate[];
  /** Databases and storage on several servers that need a look, limited to what the viewer may see. */
  managedAvailability?: DashboardAvailabilityAttention[];
  pinned: {
    dashboard: DashboardBootstrapPinnedResources;
    sidebar: DashboardBootstrapPinnedResources;
  };
  /** Why the sidebar Dashboard dot is on. The Dashboard explains every notice from this list. */
  attention: {
    severity: DashboardAttentionSeverity | null;
    notices: DashboardAttentionNotice[];
  };
  navigationAttention: {
    nodes: NavigationAttentionSeverity | null;
    "proxy-hosts": NavigationAttentionSeverity | null;
    docker: NavigationAttentionSeverity | null;
    "status-page": NavigationAttentionSeverity | null;
  };
}

export interface DashboardAvailabilityAttention {
  kind: "storage" | "database";
  /** The storage or database connection. */
  id: string;
  slug: string;
  name: string;
  reason: "primary_unreachable" | "no_failover" | "witness_lost" | "degraded" | "failover";
  /** The set's own explanation, when it has one. */
  message: string | null;
  /** Since when (the failover's time for `failover`). */
  since: string | null;
}

export interface DashboardManagedCertificate {
  kind: "storage" | "database";
  /** The storage or database connection. */
  id: string;
  slug: string;
  name: string;
  reason: "renewal_failed" | "ca_limited" | "waiting_for_daemon" | "awaiting_reload" | "expiring";
  daysRemaining: number;
  notAfter: string;
}

export interface DashboardBootstrapPinnedResources {
  storages?: Array<{
    id: string;
    slug: string;
    name: string;
    provider: string;
    healthStatus?: string | null;
  }>;
  nodes: Node[];
  proxies: ProxyHost[];
  databases: Array<{
    id: string;
    slug: string;
    name: string;
    type: string;
    healthStatus?: string | null;
  }>;
  dockerResources: Array<{
    id: string;
    nodeId: string;
    nodeSlug: string;
    name: string;
    state?: string;
    kind: "container" | "deployment" | "compose";
    scopeBase: "docker:containers:view" | "docker:compose:view";
    scopeResourceId?: string;
  }>;
}
