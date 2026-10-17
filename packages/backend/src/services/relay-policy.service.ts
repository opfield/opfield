import type { Duplex } from 'node:stream';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  managedDatabaseBindingPlacements,
  managedDatabaseInstances,
  managedStorageClusters,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayGrantSigningKeys,
  relayInstancePolicyState,
  relayInstances,
  relayPolicyState,
  relayPools,
  relayRoutes,
} from '@/db/schema/index.js';
import type { RelayManagedDatabaseListenerConfig, RelaySecureLinkEgressConfig } from '@/db/schema/relay.js';
import {
  LEGACY_RELAY_PATH_ID,
  RELAY_MAX_FRAME_BYTES,
  type RelayControlClient,
  type RelayHealthResponse,
  type RelayPolicySnapshot,
} from '@/grpc/relay-control.client.js';
import { encodeRelayV1Message } from '@/grpc/relay-proto.js';
import { ResumeSessionError } from '@/grpc/relay-resume.js';
import { RelayTunnelHost, type RemotePath } from '@/grpc/tunnel-worker/host.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { leaseLaneNodeIds } from '@/modules/docker/availability/lease/lease-relay-lanes.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import {
  LEGACY_RELAY_POLICY_LEASE_SECONDS,
  LONG_POLICY_LEASE_CAPABILITY,
} from '@/modules/settings/general-settings.service.js';
import { isNodeNotConnectedError } from '@/services/node-connection-errors.js';
import type { CryptoService } from './crypto.service.js';
import type { EventBusService } from './event-bus.service.js';
import type { LocalRelayOutageSignal } from './local-relay-outage.js';
import {
  type ManagedLinkConnections,
  sumManagedLinkReports,
  withManagedLinkConnections,
} from './managed-link-runtime.js';
import type { NodeDispatchService } from './node-dispatch.service.js';
import type { NodeRegistryService } from './node-registry.service.js';
import { OpfieldRelayPaths } from './opfield-relay-paths.js';
import { relayGrantBundleFingerprint } from './relay-grant-bundle-fingerprint.js';
import {
  type RelayGrantBundle,
  RelayGrantIssuerService,
  RelayPolicyNotAcknowledgedError,
} from './relay-grant-issuer.service.js';
import { RelayGrantKeyService } from './relay-grant-key.service.js';
import {
  CONTAINER_LINK_OWNER_KIND,
  RelayLinkRoutes,
  routeTransportRestartRequired,
  secureLinkEgressEqual,
} from './relay-link-routes.js';
import {
  BACKUP_SOURCE_PORT,
  loadSetRelayViews,
  orderedSetRoutes,
  parentKindOfMemberRoute,
  peerEndpointOwnerId,
  reconcileSetRelayPaths as reconcileSetPaths,
  reconcileSetPathsOfEndpoint,
  releaseSetRelayPaths as releaseSetPaths,
  SET_PEER_ENDPOINT_KIND,
  SET_PEER_ROUTE_KIND,
  type SetRelayView,
  setEndpointIds,
  setOfOwner,
  setServingMemberId,
} from './relay-managed-availability.js';
import {
  backfillRelayNodeFingerprints,
  bumpRelayPolicyRevision,
  reconcileManagedDatabaseRelayPolicy,
  reconcileManagedStorageRelayPolicy,
  removeOrphanedRelayState,
  updateManagedDatabaseRelayStatus,
} from './relay-policy-reconciler.js';
import { RelayPolicySigningKeyService, type RelayPolicyTrustAnchor } from './relay-policy-signing-key.service.js';
import { relayPolicySnapshotContent, relayPolicySnapshotKey } from './relay-policy-snapshot-content.js';
import {
  holdsCurrentSnapshot,
  loadInstancePolicyState,
  RELAY_POLICY_REVISION_LOCK,
  recordBuiltSnapshot,
} from './relay-revocation-fence.service.js';
import {
  effectiveRelayMaxConcurrentSessions,
  loadRelaySessionLimits,
  type RelaySessionLimitTarget,
  relaySessionLimitTarget,
} from './relay-session-limits.js';
import {
  candidateDrainDeadline,
  OPFIELD_STREAM_REPORT_SOURCE,
  opfieldStreamReport,
  type RelayStreamReports,
  RelayStreamResumeService,
} from './relay-stream-resume.js';
import type { RelayAssignmentRole } from './relay-topology.js';
import { RelayTopologyService } from './relay-topology.service.js';
import { parseRelayGrantEgressStatuses, type SecureLinkEgressStatus } from './secure-link-egress-status.js';
import { LEGACY_INTERNAL_REGISTRY_ID, LEGACY_LOCK_RELAY_POLICY_RECONCILIATION, LEGACY_MANAGED_DATABASE_OWNER_KIND, LEGACY_MANAGED_STORAGE_OWNER_KIND, LEGACY_RELAY_INSTANCE_CHANGED_ERROR, LEGACY_RELAY_SOURCE_KIND } from '@/lib/legacy-compat.js';

/** The error a relay returns for a snapshot of another Opfield instance (relays before 2.12.1: LEGACY_RELAY_INSTANCE_CHANGED_ERROR). */
const RELAY_INSTANCE_CHANGED_ERROR = 'snapshot Opfield instance changed';

export type { RelayGrantAssignment, RelayGrantBundle, RelayGrantClaims } from './relay-grant-issuer.service.js';

export interface RelayRouteRuntime {
  routeId: string;
  activeStreams: number;
  openedTotal: string;
  completedTotal: string;
  failedTotal: string;
  throttledTotal: string;
  sourceToTargetBytes: string;
  targetToSourceBytes: string;
  setupLatencyP95Ms: number;
  averageDurationMs: number;
  lastActivityAt: string | null;
  metricsSince: string;
  /**
   * Managed links: what the nodes running the link's workloads report. activeStreams, openedTotal and the byte counters
   * are theirs and throttledTotal includes their refusals; null when a node does not report links (an older daemon).
   */
  connections?: ManagedLinkConnections | null;
  /**
   * False when a relay that holds the route did not answer (a relay daemon without relay_route_runtime_v1, a timeout,
   * a relay out of touch with Opfield): failedTotal, setupLatencyP95Ms, averageDurationMs and lastActivityAt then cover
   * only the relays that answered, and so do the other counters the link's nodes do not report.
   */
  relayCountersComplete: boolean;
}

export type ProxyRouteRuntime = RelayRouteRuntime;

/** A link runtime older than this asks the link's nodes for a fresh report (they report every 30 s on their own). */
const MANAGED_LINK_REPORT_FRESH_MS = 5_000;

/** How long a runtime read waits for each remote relay (the local one answers within 2 s); all are asked at once. */
const RELAY_ROUTE_RUNTIME_TIMEOUT_MS = 2_000;
/** A relay's policy route entries hold one of `$ids`, not dropped since (removedAtRevision). */
const HOLDS_ANY_ROUTE = '$[*] ? (@.routeId == $ids[*] && !exists(@.removedAtRevision))';

const logger = createChildLogger('RelayPolicyService');

/**
 * One of Opfield's own connections opened on a relay after the nearer ones in its order did not open: where it went and
 * why, so a stream on a farther relay is accounted for (stand rc.10, F-1).
 */
function logOpfieldPathPastNearer(
  routeId: string,
  relayId: string,
  passed: ReadonlyArray<{ relayId: string; error: string }>
): void {
  logger.info('Opfield relay path opened past a nearer relay', { routeId, relayId, passed });
}

/** What a loopback endpoint of Opfield's own tunnels leads to (see RelayPolicyService.opfieldTunnelEndpoint). */
export type OpfieldTunnelTarget =
  | { kind: 'database'; managedDatabaseId: string; lane?: 'interactive' | 'monitoring' }
  | { kind: 'storage'; clusterId: string };

export interface OpfieldTunnelEndpoint {
  host: '127.0.0.1';
  port: number;
}

/** The tunnel worker's connection for a tunnel closed while the tunnel opened. */
function isOpfieldConnectionGone(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'slot_gone';
}

function opfieldTunnelKey(target: OpfieldTunnelTarget): string {
  if (target.kind === 'storage') return `storage:${target.clusterId}`;
  return target.lane ? `database:${target.managedDatabaseId}:${target.lane}` : `database:${target.managedDatabaseId}`;
}

export interface RelayGrantSyncOptions {
  /** Skip a daemon that recently got a bundle allowing exactly the same (see deliveredRecently). */
  skipUnchanged?: boolean;
  /**
   * Deliver without first turning on the daemon's new resumable routes at their targets (see
   * RelayStreamResumeService.enableBeforeSourceSync). Set for the target deliveries that sequence itself makes.
   */
  skipResumeEnable?: boolean;
}

/**
 * Ensure calls repeat on every reconciliation and link probe with nothing changed. Revocations,
 * identity changes and reconnects always deliver.
 */
const ROUTINE_GRANT_SYNC: RelayGrantSyncOptions = { skipUnchanged: true };
const INTERNAL_REGISTRY_ID = LEGACY_INTERNAL_REGISTRY_ID;
const INTERNAL_REGISTRY_CERTIFICATE_ID = `local:${LEGACY_INTERNAL_REGISTRY_ID}`;
const REGISTRY_ROUTE_OWNER_KINDS = ['registry_secure_link', 'registry_ingress'] as const;
type RegistryRouteOwnerKind = (typeof REGISTRY_ROUTE_OWNER_KINDS)[number];
type RelayOwnerKind =
  | 'database_backup_source'
  | 'database_backup_restore'
  | 'storage_backup_target'
  | 'storage_backup_staging'
  | 'managed_storage'
  | 'managed_storage_binding'
  | typeof LEGACY_MANAGED_STORAGE_OWNER_KIND
  | 'managed_database_binding'
  | typeof LEGACY_MANAGED_DATABASE_OWNER_KIND
  | 'managed_database'
  | 'proxy_host_secure_link'
  | 'container_link'
  | RegistryRouteOwnerKind
  | 'internal_registry';
/** Owner kinds that own relay endpoints as well as routes. */
const ENDPOINT_OWNER_KINDS: ReadonlySet<RelayOwnerKind> = new Set([
  'managed_database',
  'managed_storage',
  'proxy_host_secure_link',
  'container_link',
  'internal_registry',
]);

/**
 * Whether the daemon must open the listener anew: its network, address or port changed. A change of the workloads it
 * admits alone keeps the route's generation, so the relay keeps its tunnels and a daemon updates the listener in place
 * with the connections it holds (an Availability copy adopted as the standalone workload).
 */
export function managedDatabaseListenerRestartRequired(
  current: RelayManagedDatabaseListenerConfig | null | undefined,
  desired: RelayManagedDatabaseListenerConfig | null | undefined
): boolean {
  if (!current || !desired) return !(current == null && desired == null);
  return (
    current.networkName !== desired.networkName ||
    current.listenAddress !== desired.listenAddress ||
    current.listenPort !== desired.listenPort
  );
}

export function managedDatabaseListenerConfigsEqual(
  current: RelayManagedDatabaseListenerConfig | null | undefined,
  desired: RelayManagedDatabaseListenerConfig | null | undefined
): boolean {
  if (!current || !desired) return current == null && desired == null;
  if (
    current.networkName !== desired.networkName ||
    current.listenAddress !== desired.listenAddress ||
    current.listenPort !== desired.listenPort ||
    !Array.isArray(current.allowedSources) ||
    !Array.isArray(desired.allowedSources) ||
    current.allowedSources.length !== desired.allowedSources.length
  ) {
    return false;
  }
  const currentSources = [...current.allowedSources].sort();
  const desiredSources = [...desired.allowedSources].sort();
  return currentSources.every((source, index) => source === desiredSources[index]);
}

/**
 * How a relay treats a route's tunnels. HTTP traffic (proxy Secure Links, storage links) shares the proxy class: no
 * fixed cap, fair share between routes under pressure, and it yields to database traffic first. Workload links keep
 * their pooled connections open however long they idle; Opfield's own short-lived routes keep the idle timeout that
 * reaps leaked sessions. Container links (any protocol, pooled connections) join the registry class, fair-shared
 * without a fixed cap, on relays that report RELAY_REGISTRY_FAIR_SHARE_CAPABILITY; elsewhere they stay in the
 * database class with their cap. Only the class and caps change, never a generation, so open tunnels stay.
 */
function relayRoutePolicy(
  routeOwnerKind: string,
  target?: RelaySessionLimitTarget
): {
  disableIdleTimeout: boolean;
  trafficClass: 'proxy' | 'database' | 'registry';
} {
  // An availability set's member route carries the same traffic as the route it repeats toward another member.
  const ownerKind = parentKindOfMemberRoute(routeOwnerKind) ?? routeOwnerKind;
  // Engine-to-engine replication between set members: long-lived database traffic.
  if (ownerKind === SET_PEER_ROUTE_KIND) return { disableIdleTimeout: true, trafficClass: 'database' };
  if ((REGISTRY_ROUTE_OWNER_KINDS as readonly string[]).includes(ownerKind)) {
    return { disableIdleTimeout: true, trafficClass: 'registry' };
  }
  if (ownerKind === 'proxy_host_secure_link' || ownerKind === 'managed_storage_binding') {
    return { disableIdleTimeout: true, trafficClass: 'proxy' };
  }
  if (ownerKind === 'container_link' && target?.registryFairShare) {
    return { disableIdleTimeout: true, trafficClass: 'registry' };
  }
  if (ownerKind === 'managed_database_binding' || ownerKind === 'container_link') {
    return { disableIdleTimeout: true, trafficClass: 'database' };
  }
  return { disableIdleTimeout: false, trafficClass: 'database' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

function proxyLinkSources(sourceNodeIds: string | readonly string[]): string[] {
  return [...new Set(typeof sourceNodeIds === 'string' ? [sourceNodeIds] : sourceNodeIds)];
}

interface RelayRouteRuntimeReport {
  routeId: string;
  activeTunnels?: unknown;
  openedTotal?: unknown;
  completedTotal?: unknown;
  failedTotal?: unknown;
  throttledTotal?: unknown;
  sourceToTargetBytes?: unknown;
  targetToSourceBytes?: unknown;
  setupLatencyP95Microseconds?: unknown;
  averageDurationMilliseconds?: unknown;
  lastActivityUnixMilliseconds?: unknown;
  metricsSinceUnixMilliseconds?: unknown;
}

/** One route's runtime as the relay reports it. */
function relayRouteRuntime(runtime: RelayRouteRuntimeReport): RelayRouteRuntime {
  const lastActivityMillis = Number(runtime.lastActivityUnixMilliseconds || 0);
  const metricsSinceMillis = Number(runtime.metricsSinceUnixMilliseconds || 0);
  return {
    routeId: runtime.routeId,
    activeStreams: Number(runtime.activeTunnels || 0),
    openedTotal: String(runtime.openedTotal ?? '0'),
    completedTotal: String(runtime.completedTotal ?? '0'),
    failedTotal: String(runtime.failedTotal ?? '0'),
    throttledTotal: String(runtime.throttledTotal ?? '0'),
    sourceToTargetBytes: String(runtime.sourceToTargetBytes ?? '0'),
    targetToSourceBytes: String(runtime.targetToSourceBytes ?? '0'),
    setupLatencyP95Ms: Number(runtime.setupLatencyP95Microseconds || 0) / 1000,
    averageDurationMs: Number(runtime.averageDurationMilliseconds || 0),
    lastActivityAt: lastActivityMillis > 0 ? new Date(lastActivityMillis).toISOString() : null,
    metricsSince: new Date(metricsSinceMillis > 0 ? metricsSinceMillis : Date.now()).toISOString(),
    relayCountersComplete: true,
  };
}

/**
 * The runtime of a link served by several relay routes: a group route's Secure Link (one route per member) or an
 * Availability database link (one route per placement). It is the sum of those routes.
 */
function sumRouteRuntimes(runtimes: RelayRouteRuntimeReport[]): RelayRouteRuntime {
  const total = (pick: (runtime: RelayRouteRuntimeReport) => unknown) =>
    runtimes.reduce((sum, runtime) => sum + Number(pick(runtime) || 0), 0);
  const lastActivityMillis = Math.max(
    0,
    ...runtimes.map((runtime) => Number(runtime.lastActivityUnixMilliseconds || 0))
  );
  const since = runtimes
    .map((runtime) => Number(runtime.metricsSinceUnixMilliseconds || 0))
    .filter((value) => value > 0);
  const opened = total((runtime) => runtime.openedTotal);
  return {
    routeId: runtimes[0]?.routeId ?? '',
    activeStreams: total((runtime) => runtime.activeTunnels),
    openedTotal: String(opened),
    completedTotal: String(total((runtime) => runtime.completedTotal)),
    failedTotal: String(total((runtime) => runtime.failedTotal)),
    throttledTotal: String(total((runtime) => runtime.throttledTotal)),
    sourceToTargetBytes: String(total((runtime) => runtime.sourceToTargetBytes)),
    targetToSourceBytes: String(total((runtime) => runtime.targetToSourceBytes)),
    setupLatencyP95Ms:
      Math.max(0, ...runtimes.map((runtime) => Number(runtime.setupLatencyP95Microseconds || 0))) / 1000,
    averageDurationMs:
      opened > 0
        ? runtimes.reduce(
            (sum, runtime) => sum + Number(runtime.averageDurationMilliseconds || 0) * Number(runtime.openedTotal || 0),
            0
          ) / opened
        : 0,
    lastActivityAt: lastActivityMillis > 0 ? new Date(lastActivityMillis).toISOString() : null,
    metricsSince: new Date(since.length > 0 ? Math.min(...since) : Date.now()).toISOString(),
    relayCountersComplete: true,
  };
}

/**
 * The route runtimes a relay supervisor answered with (GetRelayRouteRuntimeCommand: protojson RouteRuntimeResponse
 * objects in `runtimes`), or null when the answer is not one.
 */
function parseRelayRouteRuntimeAnswer(detail: string | undefined): RelayRouteRuntimeReport[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail ?? '');
  } catch {
    return null;
  }
  const runtimes = (parsed as { runtimes?: unknown } | null)?.runtimes;
  if (!Array.isArray(runtimes)) return null;
  const reports = runtimes.filter(
    (runtime): runtime is RelayRouteRuntimeReport =>
      !!runtime && typeof runtime === 'object' && typeof (runtime as { routeId?: unknown }).routeId === 'string'
  );
  return reports.length === runtimes.length ? reports : null;
}

/** The local relay could not be reached at all, as opposed to refusing what it was sent. */
function isRelayUnavailable(error: unknown): boolean {
  const code = (error as { code?: number } | null)?.code;
  return code === GrpcStatus.UNAVAILABLE || code === GrpcStatus.DEADLINE_EXCEEDED;
}

function isSignedRotationRefusal(error: unknown): boolean {
  return errorMessage(error).includes('require signed rotation');
}

/**
 * A snapshot refusal only a local trust reset repairs. The relay pins the signer but not a
 * window that covers now (its pinned entry aged out, for example after Opfield's database was
 * restored), or it is bound to another Opfield instance (Opfield reinstalled over an existing
 * relay volume). Neither changes by retrying.
 */
function isLocalPolicyLockout(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    (error as { code?: number } | null)?.code === GrpcStatus.FAILED_PRECONDITION &&
    (message.includes('policy envelope signature is invalid') || message.includes(RELAY_INSTANCE_CHANGED_ERROR) || message.includes(LEGACY_RELAY_INSTANCE_CHANGED_ERROR))
  );
}

/** Advertised by local relay builds that implement ResetLocalPolicyTrust. */
export const LOCAL_POLICY_TRUST_RESET_CAPABILITY = 'policy_trust_reset_v1';
/** A trust reset repairs the local relay in one step; repeating it sooner cannot help and would hide a loop. */
export const LOCAL_POLICY_TRUST_RESET_COOLDOWN_MS = 10 * 60 * 1000;
/** A local recovery stays visible this long after it succeeded. */
const LOCAL_POLICY_TRUST_RECOVERED_VISIBLE_MS = 24 * 60 * 60 * 1000;
/** Pushes on the policy-change path must not hold local publication behind a slow remote relay. */
const REMOTE_POLICY_PUSH_TIMEOUT_MS = 10_000;
const REMOTE_POLICY_PUSH_RETRY_MS = 60_000;
/** A relay that lost its policy gets it at most this often from its reports (N-7). */
const REMOTE_POLICY_LOSS_SYNC_INTERVAL_MS = 5_000;
const LOCAL_POLICY_LOSS_SYNC_INTERVAL_MS = 2_000;
/** How long a grant dispatch waits for remote relays to take the policy it depends on. */
const REMOTE_POLICY_PUSH_GRACE_MS = 3_000;
const REVISION_RAISE_INTERVAL_MS = 5 * 60 * 1000;
/** A grant refresh that stays pending the same way is reported again after this long. */
const PENDING_GRANT_REFRESH_REPORT_MS = 5 * 60 * 1000;
/** Largest revision floor a relay report may impose; beyond it JavaScript numbers lose precision. */
const MAX_REVISION_FLOOR = Number.MAX_SAFE_INTEGER - 1_000_000;
/**
 * How far one report may move a revision sequence. A database restore leaves Opfield behind by
 * at most the policy changes and snapshots since the backup, far below this; a relay or daemon,
 * even a compromised one, cannot push the sequence toward the precision limit of its column.
 */
const MAX_REVISION_JUMP = 1_000_000;
/** Refusals without a revision a daemon must repeat before they count as a restore. */
const STALE_REFUSALS_BEFORE_RAISE = 3;

export const LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE =
  'The local relay trusts only policy signing keys Opfield can no longer sign with, and its version cannot reset ' +
  'that trust. Update the Relay Pool to the current release; Opfield then recovers it automatically. To recover ' +
  'by hand, rename relay.db in the relay state volume (keep identity-rotation.json) and run docker restart on the ' +
  'relay container.';

export type RelayPolicyTrustState =
  | 'locked_out'
  | 'recovered'
  | 'recovery_unsupported'
  | 'recovery_failed'
  | 'reenrollment_required';

/** Why a relay refuses Opfield's policy and what repairs it, for health surfaces. */
export interface RelayPolicyTrustStatus {
  state: RelayPolicyTrustState;
  message: string;
  observedAt: string;
  trustedKeyIds: string[];
}

export function remoteRelayReenrollmentMessage(): string {
  return (
    'This relay trusts only policy signing keys Opfield can no longer sign with, so it refuses every policy. ' +
    'Re-enroll it: create a re-enrollment token for this relay and run the relay installer with it on the host. ' +
    'The relay keeps its place in the pool and pins the current key.'
  );
}

export class RelayPolicyService {
  private dispatch?: Pick<
    NodeDispatchService,
    'sendRelayGrantBundle' | 'sendRelayPolicy' | 'setRelayDrain' | 'probeRelayCandidate' | 'isNodeConnected'
  > &
    Partial<Pick<NodeDispatchService, 'getRelayRouteRuntime'>>;
  private lastGrantRefreshAt = 0;
  private lastGrantRefreshRevision = 0;
  /** Daemons whose last grant refresh failed: retried alone until the next full refresh is due. */
  private failedGrantRefreshNodeIds = new Set<string>();
  private readonly grantIssuer: RelayGrantIssuerService;
  private readonly linkRoutes: RelayLinkRoutes;
  private readonly grantKeys: RelayGrantKeyService;
  private readonly policyKeys: RelayPolicySigningKeyService;
  private readonly streamResume: RelayStreamResumeService;
  /** The local relay's instance id, once its identity was checked: Opfield's pre-pool streams run through it. */
  private localRelayInstanceId: string | null = null;
  private relaySettingsSync: Promise<void> = Promise.resolve();
  private snapshotSync: Promise<unknown> = Promise.resolve();
  /** The snapshot sync queued behind the running one and not started yet; see syncSnapshot. */
  private queuedSnapshotSync: Promise<number> | null = null;
  private readonly nodeGrantSyncs = new Map<
    string,
    Promise<Awaited<ReturnType<NodeDispatchService['sendRelayGrantBundle']>>>
  >();
  private readonly lastNodeGrantBundles = new Map<string, RelayGrantBundle>();
  /** Per daemon: what the last delivered bundle allowed, and when it was delivered. */
  private readonly deliveredGrantBundles = new Map<string, { fingerprint: string; at: number }>();
  private readonly nodeGrantEpochs = new Map<string, { valid: boolean; pending: number }>();
  /** Per remote node: builds and deliveries in order, so a relay never sees an older revision after a newer one. */
  private readonly remotePolicySyncs = new Map<string, Promise<unknown>>();
  /** Per remote node: the global policy revision it last acknowledged from the policy-change path. */
  private readonly remotePolicyRevisions = new Map<string, number>();
  private readonly remotePolicyPushFailedAt = new Map<string, number>();
  private remotePush: Promise<void> = Promise.resolve();
  private remotePushRevision = 0;
  private audit?: Pick<AuditService, 'log'>;
  private events?: EventBusService;
  private localPolicyTrust: RelayPolicyTrustStatus | null = null;
  private lastRevisionRaiseAt = 0;
  /** Per daemon: consecutive grant bundle refusals that named no revision. */
  private readonly staleGrantRefusals = new Map<string, number>();
  private lastLocalPolicyTrustResetAt = 0;
  private lastLocalPolicyLossSyncAt = 0;
  /** The pending grant refresh last reported; see reportPendingGrantRefresh. */
  private pendingGrantRefresh: { message: string; reportedAt: number } | null = null;
  private initialAssignmentPlanner?: (
    endpointId: string
  ) => Promise<Array<{ relayInstanceId: string; role: RelayAssignmentRole }> | null>;
  private readonly remotePolicyLossSyncAt = new Map<string, number>();
  /** Availability lease blocks and key chain for PolicyEnvelopePayload fields 40 and 41. */
  private availabilityLeaseSource?: () => Promise<{ leaseBlocks: unknown[]; leaseKeyRotations: unknown[] }>;
  /** Endpoints and routes the relay admits only through its lease gate (EndpointPolicy 10, RoutePolicy 12). */
  private availabilityLeaseGate?: (
    endpoints: Array<{ id: string; ownerKind: string; ownerId: string }>,
    routes: Array<{ id: string; ownerKind: string; ownerId: string }>
  ) => Promise<{ endpoints: Map<string, string>; routes: Map<string, string> }>;
  /** How Opfield's own relayed streams choose relays and return to the nearest (O-1); made on first use. */
  private opfieldRelayPaths?: OpfieldRelayPaths;
  /** The data plane of Opfield's own tunnels (the tunnel worker); set at start-up, made on this thread otherwise. */
  private opfieldTunnelHost?: RelayTunnelHost;
  /** Loopback endpoints in the tunnel worker the database drivers and the S3 client connect to. */
  private readonly opfieldEndpoints = new Map<
    string,
    {
      target: OpfieldTunnelTarget;
      fingerprint: () => string | undefined;
      endpoint: Promise<OpfieldTunnelEndpoint>;
    }
  >();
  private opfieldLocalRelay?: Pick<LocalRelayOutageSignal, 'latestOutage'>;
  /** The client certificate each Opfield route was opened with, to look its candidates up again. */
  private readonly opfieldRouteFingerprints = new Map<string, string>();
  /** What the nodes running managed links' workloads report about the links' connections. */
  private managedLinkReports?: Pick<NodeRegistryService, 'managedLinkReport' | 'requestHealthReport'> &
    Partial<Pick<NodeRegistryService, 'relayStreamReports'>>;

  constructor(
    private readonly db: DrizzleClient,
    cryptoService: CryptoService,
    private readonly settings: GeneralSettingsService,
    private readonly relay: RelayControlClient
  ) {
    this.grantIssuer = new RelayGrantIssuerService(db, cryptoService, settings);
    this.linkRoutes = new RelayLinkRoutes({
      db,
      requireNodeIdentity: (nodeId) => this.grantIssuer.requireNodeIdentity(nodeId),
      syncSnapshot: () => this.syncSnapshot(),
      syncNodeGrants: (nodeId, options) => this.syncNodeGrants(nodeId, options),
      policyNodeIds: () => this.grantIssuer.policyNodeIds(),
      ensureEndpointAssignment: (endpointId) => this.ensureLegacyCompatibleAssignment(endpointId),
    });
    this.grantKeys = new RelayGrantKeyService(db, cryptoService, settings);
    this.policyKeys = new RelayPolicySigningKeyService(db, cryptoService);
    this.streamResume = new RelayStreamResumeService(db, cryptoService, {
      syncNodeGrants: (nodeId) => this.syncNodeGrants(nodeId, { skipResumeEnable: true }),
    });
    this.grantIssuer.setResumeSecretSource(() => this.streamResume.secret());
  }

  /** The local relay's outages (its supervisor): Opfield's own streams leave it meanwhile and return once it is stable. */
  setLocalRelayOutage(signal: Pick<LocalRelayOutageSignal, 'latestOutage'>): void {
    this.opfieldLocalRelay = signal;
    this.opfieldRelayPaths?.setLocalRelay(signal);
  }

  /**
   * Starts measuring Opfield's round trip to every remote relay of the pool, at once and every interval, so its own
   * streams know each relay's distance whenever they move, however long they ran without a new path (F-3).
   */
  measureOpfieldRelayPaths(): void {
    this.opfieldPaths().startMeasuring();
  }

  /** An assignment generation became active: Opfield's own streams judge their relays on it at once. */
  opfieldAssignmentsChanged(): void {
    this.opfieldRelayPaths?.assignmentsChanged();
  }

  /**
   * Hands Opfield's own tunnels to `host` (the tunnel worker). Called once at start-up, before any tunnel opens.
   */
  setOpfieldTunnels(host: RelayTunnelHost): void {
    this.opfieldTunnelHost = host;
    this.wireOpfieldTunnels(host);
  }

  private opfieldTunnels(): RelayTunnelHost {
    if (!this.opfieldTunnelHost) {
      this.opfieldTunnelHost = RelayTunnelHost.inThread(this.relay);
      this.wireOpfieldTunnels(this.opfieldTunnelHost);
    }
    return this.opfieldTunnelHost;
  }

  private wireOpfieldTunnels(host: RelayTunnelHost): void {
    host.onAccept((key, slotId) => this.acceptOpfieldConnection(key, slotId));
    // A restarted worker has none of the endpoints: they are created again on their next use.
    host.onReset(() => this.opfieldEndpoints.clear());
  }

  /**
   * A loopback endpoint (127.0.0.1, any port) for a managed database lane or storage cluster: every connection to it
   * runs through an Opfield relay tunnel opened for that connection, in the tunnel worker, so its bytes never pass this
   * thread. `fingerprint` names the client certificate Opfield presents at the time of each connection.
   */
  opfieldTunnelEndpoint(
    target: OpfieldTunnelTarget,
    fingerprint: () => string | undefined
  ): Promise<OpfieldTunnelEndpoint> {
    const key = opfieldTunnelKey(target);
    const existing = this.opfieldEndpoints.get(key);
    if (existing) {
      existing.fingerprint = fingerprint;
      return existing.endpoint;
    }
    const endpoint = this.opfieldTunnels()
      .createEndpoint(key)
      .then((port): OpfieldTunnelEndpoint => ({ host: '127.0.0.1', port }))
      .catch((error) => {
        if (this.opfieldEndpoints.get(key)?.endpoint === endpoint) this.opfieldEndpoints.delete(key);
        throw error;
      });
    const entry = { target, fingerprint, endpoint };
    this.opfieldEndpoints.set(key, entry);
    return entry.endpoint;
  }

  /** Closes the endpoint(s) of a managed database (every lane, unless one is named) or storage cluster. */
  async disposeOpfieldTunnelEndpoint(target: OpfieldTunnelTarget): Promise<void> {
    const key = opfieldTunnelKey(target);
    const keys =
      target.kind === 'database' && !target.lane
        ? [...this.opfieldEndpoints.keys()].filter((candidate) => candidate.startsWith(`${key}:`))
        : [key];
    await Promise.all(
      keys.map(async (endpointKey) => {
        if (!this.opfieldEndpoints.delete(endpointKey)) return;
        await this.opfieldTunnelHost?.disposeEndpoint(endpointKey);
      })
    );
  }

  /** Stops Opfield's tunnel worker (shutdown): endpoints close, connections and streams end. */
  async closeOpfieldTunnels(): Promise<void> {
    this.opfieldEndpoints.clear();
    await this.opfieldTunnelHost?.close();
  }

  /** A connection to one of the endpoints: open its tunnel, or end it. */
  private acceptOpfieldConnection(key: string, slotId: string): void {
    const tunnels = this.opfieldTunnels();
    const entry = this.opfieldEndpoints.get(key);
    if (!entry) {
      tunnels.failSlot(slotId, 'Opfield tunnel endpoint is closed');
      return;
    }
    const { target } = entry;
    const fingerprint = entry.fingerprint();
    void (async () => {
      if (!fingerprint) throw new Error('Opfield relay is unavailable');
      const routeId =
        target.kind === 'database'
          ? await this.opfieldDatabaseRoute(target.managedDatabaseId, fingerprint)
          : await this.opfieldStorageRoute(target.clusterId, fingerprint);
      await this.openOpfieldRouteTunnelInto(routeId, fingerprint, slotId);
    })().catch((error) => {
      tunnels.failSlot(slotId, errorMessage(error));
      // The client went away while its tunnel opened: nothing failed.
      if (isOpfieldConnectionGone(error)) return;
      // A failed open is a normal transient condition while a node reconnects; the connection just ends.
      if (target.kind === 'storage') {
        logger.warn('Managed storage tunnel failed', {
          managedStorageId: target.clusterId,
          error: errorMessage(error),
        });
      } else {
        logger.debug('Managed database tunnel failed', {
          managedDatabaseId: target.managedDatabaseId,
          error: errorMessage(error),
        });
      }
    });
  }

  private opfieldPaths(): OpfieldRelayPaths {
    if (!this.opfieldRelayPaths) {
      const topology = new RelayTopologyService(this.db);
      this.opfieldRelayPaths = new OpfieldRelayPaths(
        this.opfieldTunnels().streams,
        async (routeId) => {
          const fingerprint = this.opfieldRouteFingerprints.get(routeId);
          if (!fingerprint) return [];
          const assignment = await this.withAcknowledgedPolicy(() =>
            this.grantIssuer.issueOpfieldConnectAssignment(routeId, fingerprint)
          );
          return assignment.candidates;
        },
        { poolRelays: () => topology.remoteLatencyTargets() }
      );
      if (this.opfieldLocalRelay) this.opfieldRelayPaths.setLocalRelay(this.opfieldLocalRelay);
    }
    return this.opfieldRelayPaths;
  }

  setManagedLinkReports(
    reports: Pick<NodeRegistryService, 'managedLinkReport' | 'requestHealthReport'> &
      Partial<Pick<NodeRegistryService, 'relayStreamReports'>>
  ): void {
    this.managedLinkReports = reports;
  }

  /** The relay stream sessions (RSv1) daemons reported recently, plus Opfield's own; empty when none reports them. */
  relayStreamReports(): RelayStreamReports {
    const reports = [...(this.managedLinkReports?.relayStreamReports?.() ?? [])];
    try {
      const stats = this.opfieldTunnelHost?.relayResumeStats();
      if (stats) {
        reports.push({
          nodeId: OPFIELD_STREAM_REPORT_SOURCE,
          report: opfieldStreamReport(stats, this.localRelayInstanceId),
        });
      }
    } catch (error) {
      logger.debug("Opfield's own relay stream counts are unavailable", { error: errorMessage(error) });
    }
    return reports;
  }

  /**
   * Moves Opfield's own resumable streams (database tools, storage browser) off a relay that started draining, paced
   * to its drain deadline. Daemons learn the same from their grant bundles.
   */
  migrateOpfieldStreams(relayInstanceId: string, drainDeadlineAt: Date | null): void {
    try {
      const deadline = drainDeadlineAt ? Number(candidateDrainDeadline(drainDeadlineAt) ?? 0) : 0;
      this.opfieldTunnelHost?.migrateResumableTunnels(relayInstanceId, deadline);
    } catch (error) {
      logger.warn("Moving Opfield's own streams off a draining relay failed", {
        relayInstanceId,
        error: errorMessage(error),
      });
    }
  }

  /**
   * Brings every route's resumable stream state in line with what its source and target support, in order (see
   * RelayStreamResumeService). A node that reconnects with other capabilities is reconciled before its grants go out.
   */
  async reconcileStreamResume(maxWaitMs = 10_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Bounded: a pass waits for other daemons' acknowledgements, and the caller's own delivery must not.
    await Promise.race([
      this.streamResume.reconcile(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, maxWaitMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** The shared secure-link connector image that connector egress assignments name. */
  setSecureLinkConnectorImage(image: string): void {
    this.grantIssuer.setConnectorImage(image);
  }

  setNodeDispatch(
    dispatch: Pick<
      NodeDispatchService,
      'sendRelayGrantBundle' | 'sendRelayPolicy' | 'setRelayDrain' | 'probeRelayCandidate' | 'isNodeConnected'
    > &
      Partial<Pick<NodeDispatchService, 'getRelayRouteRuntime'>>
  ): void {
    this.dispatch = dispatch;
  }

  /**
   * The pool's placement of a new endpoint's first assignment (RelayPoolService.planInitialAssignment), or null for
   * the legacy local shape.
   */
  setInitialAssignmentPlanner(
    planner: (endpointId: string) => Promise<Array<{ relayInstanceId: string; role: RelayAssignmentRole }> | null>
  ): void {
    this.initialAssignmentPlanner = planner;
  }

  setAuditService(audit: Pick<AuditService, 'log'>): void {
    this.audit = audit;
  }

  /**
   * Every relay snapshot carries the signed lease voter config, manifests and policy key chain; the lease service also
   * names the policy key that signs lease blocks so its private half is never destroyed (A14).
   */
  setAvailabilityLeaseSource(source: {
    relayPolicyFields(): Promise<{ leaseBlocks: unknown[]; leaseKeyRotations: unknown[] }>;
    retainedSigningKeyIds(): Promise<string[]>;
    relayLeasePolicyIds?(
      endpoints: Array<{ id: string; ownerKind: string; ownerId: string }>,
      routes: Array<{ id: string; ownerKind: string; ownerId: string }>
    ): Promise<{ endpoints: Map<string, string>; routes: Map<string, string> }>;
  }): void {
    this.availabilityLeaseSource = () => source.relayPolicyFields();
    this.availabilityLeaseGate = source.relayLeasePolicyIds
      ? (endpoints, routes) => source.relayLeasePolicyIds!(endpoints, routes)
      : undefined;
    this.policyKeys.setRetainedKeyIds(() => source.retainedSigningKeyIds());
  }

  /**
   * A managed database accepts a different number of connections: its links and endpoint take the new limit from the
   * next snapshot and grants (relay-session-limits.ts). No route or endpoint row changes, so no generation moves and
   * no open connection is dropped; the database node and the nodes of its links get fresh grants now.
   */
  async publishManagedDatabaseLimits(managedDatabaseId: string): Promise<void> {
    const endpoints = await this.db
      .select({ id: relayEndpoints.id, subjectKind: relayEndpoints.subjectKind, subjectId: relayEndpoints.subjectId })
      .from(relayEndpoints)
      .where(and(eq(relayEndpoints.ownerKind, 'managed_database'), eq(relayEndpoints.ownerId, managedDatabaseId)));
    if (!endpoints.length) return;
    const routes = await this.db
      .select({ sourceKind: relayRoutes.sourceKind, sourceId: relayRoutes.sourceId })
      .from(relayRoutes)
      .where(
        inArray(
          relayRoutes.targetEndpointId,
          endpoints.map(({ id }) => id)
        )
      );
    await this.db.transaction((tx) => bumpRelayPolicyRevision(tx));
    await this.syncSnapshot();
    const nodeIds = new Set([
      ...endpoints.filter(({ subjectKind }) => subjectKind === 'daemon').map(({ subjectId }) => subjectId),
      ...routes.filter(({ sourceKind }) => sourceKind === 'daemon').map(({ sourceId }) => sourceId),
    ]);
    await Promise.allSettled([...nodeIds].map((nodeId) => this.syncNodeGrants(nodeId, ROUTINE_GRANT_SYNC)));
  }

  /** A lease block changed: publish a new revision to the local relay and push it to remote relays. */
  async publishAvailabilityLeaseChange(): Promise<void> {
    await this.db.transaction((tx) => bumpRelayPolicyRevision(tx));
    await this.syncSnapshot();
    // Lease lanes follow the policies' voters and candidates (stand run c1).
    const nodeIds = await leaseLaneNodeIds(this.db).catch(() => []);
    await Promise.allSettled(nodeIds.map((nodeId) => this.syncNodeGrants(nodeId, { skipUnchanged: true })));
  }

  setEventBus(events: EventBusService): void {
    this.events = events;
    events.subscribe('system.relay.health.changed', (payload) => {
      // The local relay answers but holds no policy (it restarted with a fresh relay.db): deliver it now instead of
      // at the next periodic sync, so endpoint registrations are not refused for up to a minute (N-7). The same when
      // it serves again after an outage: grants issued meanwhile went out without its acknowledgement.
      const event = payload as { reason?: unknown; state?: unknown } | null;
      const outage = this.opfieldLocalRelay?.latestOutage() ?? null;
      const servingAgain = event?.state === 'healthy' && (!outage || outage.servingAgainAt !== null);
      if (event?.reason !== 'policy_snapshot_required' && !servingAgain) return;
      this.syncLocalPolicyAfterLoss();
    });
    events.subscribe('system.config.changed', (payload) => {
      if ((payload as { relayChanged?: unknown } | null)?.relayChanged !== true) return;
      this.relaySettingsSync = this.relaySettingsSync
        .then(async () => {
          await this.db.transaction((tx) => bumpRelayPolicyRevision(tx));
          await this.syncSnapshot();
          await this.refreshAllNodeGrantsIfDue(true);
        })
        .catch((error) => {
          logger.warn('Relay runtime settings distribution will be retried', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
    events.subscribe('node.changed', (payload) => {
      const event = payload as { id?: unknown; action?: unknown } | null;
      if (event?.action !== 'deleted' || typeof event.id !== 'string') return;
      void this.revokeNode(event.id).catch((error) => {
        logger.warn('Relay policy node revocation will be retried by snapshot reconciliation', {
          nodeId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    events.subscribe('database.changed', (payload) => {
      const event = payload as {
        resourceKind?: unknown;
        managedDatabaseId?: unknown;
        action?: unknown;
        status?: unknown;
      } | null;
      if (event?.resourceKind !== 'managed_database' || typeof event.managedDatabaseId !== 'string') return;
      if (event.action === 'connection_limit.changed') {
        void this.publishManagedDatabaseLimits(event.managedDatabaseId).catch((error) => {
          logger.warn('Managed database link limits will reach relays and daemons with the next policy sync', {
            managedDatabaseId: event.managedDatabaseId,
            error: errorMessage(error),
          });
        });
        return;
      }
      const operation =
        event.action === 'deleted'
          ? this.revokeOwner('managed_database', event.managedDatabaseId)
          : typeof event.status === 'string'
            ? this.updateManagedDatabaseStatus(event.managedDatabaseId, event.status)
            : null;
      if (!operation) return;
      void operation.catch((error) => {
        logger.warn('Relay policy managed database cleanup will be retried by snapshot reconciliation', {
          managedDatabaseId: event.managedDatabaseId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  /** Throttled: a relay stuck without policy reports it on every probe transition. */
  private syncLocalPolicyAfterLoss(now = Date.now()): void {
    if (now - this.lastLocalPolicyLossSyncAt < LOCAL_POLICY_LOSS_SYNC_INTERVAL_MS) return;
    this.lastLocalPolicyLossSyncAt = now;
    void this.syncSnapshot().catch((error) => {
      logger.info('Local relay policy delivery after a lost snapshot deferred to the next sync', {
        error: errorMessage(error),
      });
    });
  }

  /**
   * A remote relay reported the policy revision it holds. A relay that holds none, or an older one than it held
   * before, lost its state or restarted from an old copy: send its snapshot now, without waiting for the next policy
   * change or lease refresh (N-7). Throttled per relay.
   */
  noteRemoteAppliedRevision(
    nodeId: string,
    reportedRevision: number,
    previousRevision: number,
    now = Date.now()
  ): void {
    if (!this.dispatch) return;
    if (reportedRevision > 0 && reportedRevision >= previousRevision) return;
    if (now - (this.remotePolicyLossSyncAt.get(nodeId) ?? 0) < REMOTE_POLICY_LOSS_SYNC_INTERVAL_MS) return;
    this.remotePolicyLossSyncAt.set(nodeId, now);
    logger.info('Remote relay holds no current policy; delivering its snapshot', {
      nodeId,
      reportedRevision,
      previousRevision,
    });
    void this.syncRemoteInstancePolicy(nodeId, REMOTE_POLICY_PUSH_TIMEOUT_MS, { force: true }).catch((error) => {
      logger.info('Remote relay policy delivery after a lost snapshot deferred to the next refresh', {
        nodeId,
        error: errorMessage(error),
      });
    });
  }

  async ensureInitialized(): Promise<void> {
    await backfillRelayNodeFingerprints(this.db);
    await this.grantKeys.ensureInitialized();
    await this.policyKeys.ensureInitialized();
    await this.streamResume.ensureInitialized();
    await this.reconcileInternalRegistryEndpoint();
    await reconcileManagedDatabaseRelayPolicy(this.db);
    await reconcileManagedStorageRelayPolicy(this.db);
    // Daemons are not connected yet: each gets its bundle without the removed state when it registers.
    await removeOrphanedRelayState(this.db);
    await this.syncSnapshot().catch((error) => {
      logger.warn('Initial relay policy sync deferred until relay is reachable', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async getPolicyEnrollmentTrust() {
    return this.policyKeys.getEnrollmentTrust();
  }

  /**
   * Delivers the relay's policy snapshot. `force` sends it even when Opfield's records say the relay holds it: a
   * relay that (re)connects may have lost its state (relay.db renamed or restored) and would refuse every
   * registration with "policy snapshot is required" until the next policy change or lease refresh (N-7).
   */
  syncRemoteInstancePolicy(nodeId: string, timeoutMs?: number, options: { force?: boolean } = {}): Promise<number> {
    // Build and deliver in order per relay: two concurrent pushes could otherwise arrive
    // newest first, and the relay would refuse the older one as a stale revision.
    const previous = this.remotePolicySyncs.get(nodeId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.syncRemoteInstancePolicyOnce(nodeId, timeoutMs, options.force === true));
    this.remotePolicySyncs.set(nodeId, current);
    const settle = () => {
      if (this.remotePolicySyncs.get(nodeId) === current) this.remotePolicySyncs.delete(nodeId);
    };
    current.then(settle, settle);
    return current;
  }

  private async syncRemoteInstancePolicyOnce(nodeId: string, timeoutMs?: number, force = false): Promise<number> {
    if (!this.dispatch) throw new Error('Relay node dispatch is not configured');
    const [instance] = await this.db
      .select({ id: relayInstances.id })
      .from(relayInstances)
      .where(and(eq(relayInstances.nodeId, nodeId), eq(relayInstances.kind, 'remote')))
      .limit(1);
    if (!instance) throw new Error('Remote relay instance is unavailable');
    const snapshot = await this.buildInstanceSnapshot(instance.id, undefined, 0, { force });
    // A relay that reports the unchanged snapshot needs nothing sent.
    if (snapshot.encodedRequest) {
      const args = [
        nodeId,
        snapshot.encodedRequest,
        String(snapshot.revision),
        String(snapshot.expiresAtUnix),
      ] as const;
      const result = timeoutMs
        ? await this.dispatch.sendRelayPolicy(...args, timeoutMs)
        : await this.dispatch.sendRelayPolicy(...args);
      if (!result.success) throw new Error(result.error || 'Remote relay rejected policy snapshot');
    }
    this.remotePolicyRevisions.set(
      nodeId,
      Math.max(this.remotePolicyRevisions.get(nodeId) ?? 0, snapshot.globalRevision)
    );
    // The relay answers again: pushes of later changes must not wait out an earlier failure's cooldown.
    this.remotePolicyPushFailedAt.delete(nodeId);
    return snapshot.revision;
  }

  /** Whether the relay's supervisor holds its control stream; drain commands reach only such a relay. */
  isRemoteInstanceConnected(nodeId: string): boolean {
    return this.dispatch?.isNodeConnected(nodeId) ?? false;
  }

  async setRemoteInstanceDrain(nodeId: string, enabled: boolean, forceDisconnect = false): Promise<void> {
    if (!this.dispatch) throw new Error('Relay node dispatch is not configured');
    const result = await this.dispatch.setRelayDrain(nodeId, enabled, forceDisconnect);
    if (!result.success) throw new Error(result.error || 'Remote relay drain command failed');
  }

  /** The local relay's drain, which only a Relay Pool update takes while another relay carries its workloads. */
  async setLocalInstanceDrain(enabled: boolean, forceDisconnect = false): Promise<void> {
    await this.relay.setDrain(enabled, forceDisconnect);
  }

  async probeRelayCandidate(
    nodeId: string,
    input: Parameters<NodeDispatchService['probeRelayCandidate']>[1]
  ): Promise<void> {
    if (!this.dispatch) throw new Error('Relay node dispatch is not configured');
    const result = await this.dispatch.probeRelayCandidate(nodeId, input);
    if (!result.success) throw new Error(result.error || 'Relay candidate probe failed');
  }

  async probeManagedDatabaseBindingRoute(nodeId: string, bindingId: string): Promise<void> {
    const bundle = this.lastNodeGrantBundles.get(nodeId) ?? (await this.getNodeGrantBundle(nodeId));
    const assignment = bundle.grants.find(
      (grant) =>
        grant.role === 'connect' && grant.ownerKind === 'managed_database_binding' && grant.ownerId === bindingId
    );
    if (!assignment) throw new Error('Managed database binding relay grant is unavailable');
    if (!assignment.routeId || !assignment.targetEndpointId) {
      throw new Error('Managed database binding relay route is incomplete');
    }
    const candidates = assignment.candidates ?? [];
    if (candidates.length === 0) return;
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        await this.probeRelayCandidate(nodeId, {
          probeId: bindingId,
          role: 'source',
          endpointId: assignment.targetEndpointId,
          routeId: assignment.routeId,
          assignmentGeneration: candidate.assignmentGeneration,
          candidate,
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Managed database binding relay route is unavailable');
  }

  /**
   * Delivers a node's grants until the daemon reports the connector egress of one link route listening for the route's
   * current generation (egressStatuses in the ACK). The daemon answers `pending` while it brings the egress up, so the
   * bundle is re-sent with backoff (1 s doubling to 8 s; an unchanged bundle is cheap) until `timeoutMs`, then this
   * throws with the daemon's last reason, which the caller shows on the link.
   */
  async awaitSecureLinkEgress(
    nodeId: string,
    ownerKind: 'managed_storage_binding' | 'managed_database_binding' | 'container_link',
    ownerId: string,
    options: { timeoutMs?: number; initialDelayMs?: number } = {}
  ): Promise<SecureLinkEgressStatus> {
    const deadline = Date.now() + (options.timeoutMs ?? 90_000);
    let delayMs = options.initialDelayMs ?? 1_000;
    let reason = 'the daemon did not report it';
    // The bundle that brings a new link route to its source already makes it resumable.
    await this.enableResumableRoutesOf(nodeId);
    for (let attempt = 0; attempt === 0 || Date.now() < deadline; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, Math.max(0, deadline - Date.now()))));
        delayMs = Math.min(delayMs * 2, 8_000);
      }
      const [route] = await this.db
        .select({ generation: relayRoutes.generation, egress: relayRoutes.secureLinkEgress })
        .from(relayRoutes)
        .where(
          and(
            eq(relayRoutes.ownerKind, ownerKind),
            eq(relayRoutes.ownerId, ownerId),
            eq(relayRoutes.sourceKind, 'daemon'),
            eq(relayRoutes.sourceId, nodeId)
          )
        )
        .limit(1);
      if (!route?.egress) throw new Error('the link route has no connector egress');
      const result = await this.syncNodeGrantBundle(nodeId);
      if (!result.success) {
        reason = result.error || 'the daemon rejected the relay grants';
        continue;
      }
      const status = parseRelayGrantEgressStatuses(result.detail)[ownerId];
      if (status?.state === 'ready' && status.routeGeneration === route.generation) return status;
      reason = status?.error || (status ? `it is ${status.state}` : 'the daemon did not report it');
    }
    throw new Error(`the secure-link connector is not listening for the link: ${reason}`);
  }

  /**
   * What the node's daemon reports about its connector egress now, by owner id: the ACK of a freshly delivered bundle
   * (egressStatuses). Null when the bundle was not delivered.
   */
  async secureLinkEgressStatuses(nodeId: string): Promise<Record<string, SecureLinkEgressStatus> | null> {
    const result = await this.syncNodeGrantBundle(nodeId);
    return result.success ? parseRelayGrantEgressStatuses(result.detail) : null;
  }

  /** Probes the relay path of one link route from its source node, like a managed database link's. */
  async probeLinkRoute(nodeId: string, ownerKind: string, ownerId: string): Promise<void> {
    const bundle = this.lastNodeGrantBundles.get(nodeId) ?? (await this.getNodeGrantBundle(nodeId));
    const assignment = bundle.grants.find(
      (grant) => grant.role === 'connect' && grant.ownerKind === ownerKind && grant.ownerId === ownerId
    );
    if (!assignment?.routeId || !assignment.targetEndpointId) throw new Error('The link relay grant is unavailable');
    const candidates = assignment.candidates ?? [];
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        await this.probeRelayCandidate(nodeId, {
          probeId: ownerId,
          role: 'source',
          endpointId: assignment.targetEndpointId,
          routeId: assignment.routeId,
          assignmentGeneration: candidate.assignmentGeneration,
          candidate,
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    if (candidates.length)
      throw lastError instanceof Error ? lastError : new Error('The link relay route is unavailable');
  }

  syncSnapshot(): Promise<number> {
    // Publish in build order, and always build after earlier callers finish:
    // joining a running build can hand a policy writer an ACK for a pre-write projection.
    // A build that has not started yet reads the policy when it starts, after every write of
    // the callers that join it, so a burst of callers shares one queued build.
    if (this.queuedSnapshotSync) return this.queuedSnapshotSync;
    const sync: Promise<number> = this.snapshotSync.then(() => {
      if (this.queuedSnapshotSync === sync) this.queuedSnapshotSync = null;
      return this.syncSnapshotOnce();
    });
    this.queuedSnapshotSync = sync;
    this.snapshotSync = sync.catch(() => undefined);
    return sync;
  }

  private async syncSnapshotOnce(): Promise<number> {
    // A transient health RPC failure must not downgrade a pool-capable Relay
    // to the legacy snapshot shape. Doing so removes assignment generations
    // from the live policy and revokes otherwise healthy endpoint streams.
    // Absence of getHealth still identifies a genuinely legacy client.
    const health = this.relay.getHealth ? await this.relay.getHealth() : null;
    if (health?.poolId === 'system' && health.capabilities?.includes('relay_pool_v1')) {
      const [local] = await this.db
        .select({
          id: relayInstances.id,
          buildVersion: relayInstances.buildVersion,
          protocolMajor: relayInstances.protocolMajor,
          capabilities: relayInstances.capabilities,
        })
        .from(relayInstances)
        .where(and(eq(relayInstances.poolId, 'system'), eq(relayInstances.kind, 'local')))
        .limit(1);
      if (!local || health.relayInstanceId !== local.id) {
        throw new Error('Local Relay Pool identity does not match persisted instance identity');
      }
      this.localRelayInstanceId = local.id;
      const liveFeatures = [...new Set(health.capabilities)].sort();
      const persistedFeatures = Array.isArray(local.capabilities?.features)
        ? [...local.capabilities.features].sort()
        : [];
      if (
        local.buildVersion !== health.buildVersion ||
        local.protocolMajor !== health.protocolMajor ||
        local.capabilities?.protocolMajor !== health.protocolMajor ||
        liveFeatures.length !== persistedFeatures.length ||
        liveFeatures.some((feature, index) => feature !== persistedFeatures[index])
      ) {
        await this.db
          .update(relayInstances)
          .set({
            buildVersion: health.buildVersion,
            protocolMajor: health.protocolMajor,
            capabilities: {
              ...local.capabilities,
              protocolMajor: health.protocolMajor,
              features: liveFeatures,
            },
            updatedAt: new Date(),
          })
          .where(eq(relayInstances.id, local.id));
      }
      const trustedKeyIds = await this.ensureLocalPolicyTrust(health);
      // The relay refuses a revision below the one it applied. After Opfield's database was
      // restored from a backup its sequence is behind; continue above the relay's instead.
      const revisionFloor = Number(health.appliedRevision || 0);
      // The live report says what the relay holds now; the stored one may predate a relay that lost its state
      // (relay.db renamed), which then waited for the next policy change (N-7).
      let signed = await this.buildInstanceSnapshot(local.id, trustedKeyIds, revisionFloor, {
        liveAppliedRevision: revisionFloor,
      });
      let response: { appliedRevision: string; unchanged: boolean };
      try {
        response = await this.applyLocalSnapshot(signed);
      } catch (error) {
        if (!isLocalPolicyLockout(error)) throw error;
        const trust = await this.policyKeys.getEnrollmentTrust();
        await this.recoverLocalPolicyTrust(trust, health, error);
        signed = await this.buildInstanceSnapshot(local.id, [trust.keyId], revisionFloor, {
          liveAppliedRevision: revisionFloor,
        });
        try {
          response = await this.applyLocalSnapshot(signed);
        } catch (retryError) {
          if (
            errorMessage(retryError).includes(RELAY_INSTANCE_CHANGED_ERROR) ||
            errorMessage(retryError).includes(LEGACY_RELAY_INSTANCE_CHANGED_ERROR)
          ) {
            // The reset took, but this relay build cannot rebind to this Opfield instance.
            this.setLocalPolicyTrust(
              'recovery_unsupported',
              LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE,
              health.policyKeyIds ?? []
            );
          }
          throw retryError;
        }
      }
      const applied = Number(response.appliedRevision);
      if (!Number.isSafeInteger(applied) || applied !== signed.revision) {
        throw new Error(`Relay acknowledged revision ${response.appliedRevision}, expected ${signed.revision}`);
      }
      // Pool snapshot sequence numbers include lease refreshes and are not the
      // global grant revision. Only acknowledge the projection actually sent.
      this.grantIssuer.acknowledgeRevision(signed.globalRevision);
      this.settleLocalPolicyTrust();
      // Beside the snapshot chain, never inside it: a remote relay that is busy (renewing,
      // updating) must not hold up every local sync, grant issue and tunnel open behind it.
      this.startRemotePush(signed.globalRevision);
      return applied;
    }
    const snapshot = await this.buildSnapshot();
    const response = await this.relay.applySnapshot(snapshot);
    const applied = Number(response.appliedRevision);
    if (!Number.isSafeInteger(applied) || applied !== Number(snapshot.revision)) {
      throw new Error(`Relay acknowledged revision ${response.appliedRevision}, expected ${snapshot.revision}`);
    }
    this.grantIssuer.acknowledgeRevision(applied);
    return applied;
  }

  /** The local relay already holds an unchanged snapshot; applying it again would be a no-op. */
  private applyLocalSnapshot(signed: {
    encodedRequest: Buffer | null;
    revision: number;
  }): Promise<{ appliedRevision: string; unchanged: boolean }> {
    if (!signed.encodedRequest) return Promise.resolve({ appliedRevision: String(signed.revision), unchanged: true });
    return this.relay.applyEncodedSnapshot(signed.encodedRequest);
  }

  /**
   * Pins the active policy key on the local relay and returns the key ids it trusts, which
   * choose the signer of its next snapshot. The local relay refuses an unsigned new key once
   * it trusts any key. If it still trusts an old key whose private half Opfield retains, that
   * key signs a snapshot carrying the active one. If it trusts none that Opfield can sign
   * with, typically because relay.db was restored from a backup older than the active key,
   * the local-only reset re-pins the active key. Remote relays never take that path.
   */
  private async ensureLocalPolicyTrust(health: RelayHealthResponse): Promise<string[]> {
    const reportedKeyIds = health.policyKeyIds ?? [];
    const trust = await this.policyKeys.getEnrollmentTrust();
    try {
      await this.relay.bootstrapPolicyTrust(trust.keyId, trust.publicKey, trust.fingerprint);
      return [trust.keyId];
    } catch (error) {
      if (!isSignedRotationRefusal(error)) throw error;
      const plan = await this.policyKeys.resolveInstancePolicyKeys(
        { kind: 'local', policySigningKeyId: null, health: null },
        new Date(),
        reportedKeyIds
      );
      if (plan.signingKeyId !== trust.keyId) return reportedKeyIds;
      await this.recoverLocalPolicyTrust(trust, health, error);
      return [trust.keyId];
    }
  }

  /**
   * Re-pins the active key on the local relay after it refused Opfield's policy for a reason
   * only a reset repairs. Runs at most once per cooldown, is audited, and never touches a
   * remote relay: the relay itself accepts the call only in local combined mode. A relay
   * build without the call leaves an actionable status instead of a silent sync failure.
   */
  private async recoverLocalPolicyTrust(
    trust: RelayPolicyTrustAnchor,
    health: RelayHealthResponse,
    refusal: unknown
  ): Promise<void> {
    const trustedKeyIds = health.policyKeyIds ?? [];
    const reason = errorMessage(refusal);
    if (typeof this.relay.resetLocalPolicyTrust !== 'function') {
      this.setLocalPolicyTrust('recovery_unsupported', LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE, trustedKeyIds);
      throw refusal;
    }
    // Every relay build with the reset call advertises it, and only such a build can rebind to
    // another Opfield instance. Asking an older build starts no cooldown, so the relay is
    // recovered on the first sync after it is updated, well inside the update's health wait.
    if (!health.capabilities?.includes(LOCAL_POLICY_TRUST_RESET_CAPABILITY)) {
      this.setLocalPolicyTrust('recovery_unsupported', LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE, trustedKeyIds);
      throw new Error(`${LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE} Relay refusal: ${reason}`);
    }
    const now = Date.now();
    const nextAttemptAt = this.lastLocalPolicyTrustResetAt + LOCAL_POLICY_TRUST_RESET_COOLDOWN_MS;
    if (now < nextAttemptAt) {
      const current = this.localPolicyTrust;
      if (current?.state !== 'recovery_unsupported' && current?.state !== 'recovery_failed') {
        this.setLocalPolicyTrust(
          'locked_out',
          `The local relay still refuses Opfield policy after its trust was reset (${reason}). ` +
            `Opfield retries the reset after ${new Date(nextAttemptAt).toISOString()}.`,
          trustedKeyIds
        );
      }
      throw new Error(`Local relay refuses Opfield policy; trust reset retries after the cooldown: ${reason}`);
    }
    let replacedKeyIds: string[];
    try {
      ({ replacedKeyIds } = await this.relay.resetLocalPolicyTrust(trust.keyId, trust.publicKey, trust.fingerprint));
      this.lastLocalPolicyTrustResetAt = now;
    } catch (error) {
      const unimplemented = (error as { code?: number } | null)?.code === GrpcStatus.UNIMPLEMENTED;
      // The cooldown starts only once the relay answered and could reset: an unreachable relay or
      // one without the call was not reset.
      if (!isRelayUnavailable(error) && !unimplemented) this.lastLocalPolicyTrustResetAt = now;
      if (unimplemented) {
        this.setLocalPolicyTrust('recovery_unsupported', LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE, trustedKeyIds);
        logger.error('Local relay refuses Opfield policy and cannot reset its trust', { reason });
        throw new Error(`${LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE} Relay refusal: ${reason}`);
      }
      this.setLocalPolicyTrust(
        'recovery_failed',
        `Opfield could not reset the local relay's policy trust: ${errorMessage(error)}`,
        trustedKeyIds
      );
      throw error;
    }
    logger.warn('Local relay refused Opfield policy; re-pinned the active policy signing key', {
      activeKeyId: trust.keyId,
      replacedKeyIds,
      reason,
    });
    this.setLocalPolicyTrust(
      'recovered',
      `The local relay trusted no policy key Opfield could sign with (${reason}). Opfield re-pinned the active key.`,
      [trust.keyId]
    );
    await this.audit
      ?.log({
        userId: null,
        action: 'relay.policy_trust.reset',
        resourceType: 'relay_instance',
        resourceId: health.relayInstanceId || 'local',
        details: { activeKeyId: trust.keyId, replacedKeyIds, previouslyTrustedKeyIds: trustedKeyIds, reason },
      })
      .catch(() => undefined);
  }

  private setLocalPolicyTrust(state: RelayPolicyTrustState, message: string, trustedKeyIds: string[]): void {
    const changed = this.localPolicyTrust?.state !== state || this.localPolicyTrust?.message !== message;
    this.localPolicyTrust = { state, message, observedAt: new Date().toISOString(), trustedKeyIds };
    if (changed) this.events?.publish('system.relay.health.changed', { poolId: 'system', action: 'policy_trust' });
  }

  /** The local relay accepted a snapshot: an open problem is over; a recovery stays visible for a while. */
  private settleLocalPolicyTrust(): void {
    const current = this.localPolicyTrust;
    if (!current) return;
    if (
      current.state !== 'recovered' ||
      Date.now() - Date.parse(current.observedAt) > LOCAL_POLICY_TRUST_RECOVERED_VISIBLE_MS
    ) {
      this.localPolicyTrust = null;
      this.events?.publish('system.relay.health.changed', { poolId: 'system', action: 'policy_trust' });
    }
  }

  /** The local relay's policy trust problem, or its recent automatic recovery. */
  getLocalPolicyTrustStatus(): RelayPolicyTrustStatus | null {
    return this.localPolicyTrust ? { ...this.localPolicyTrust } : null;
  }

  /**
   * Policy trust status per relay for health surfaces. The local relay reports what automatic
   * recovery saw. A remote relay whose reported trust holds no key Opfield can still sign with
   * is locked out for good: only a re-enrollment repairs it.
   */
  async describePolicyTrust(
    instances: Array<{
      id: string;
      kind: string;
      health: { policySigningKeyIds?: string[] } | null;
      capabilities?: { features?: string[] } | null;
    }>
  ): Promise<Map<string, RelayPolicyTrustStatus>> {
    const result = new Map<string, RelayPolicyTrustStatus>();
    const reported = instances.map(({ health }) => health?.policySigningKeyIds ?? []);
    const signable = await this.policyKeys.assessReportedTrust(reported);
    const observedAt = new Date().toISOString();
    instances.forEach((instance, index) => {
      if (instance.kind === 'local') {
        const local = this.getLocalPolicyTrustStatus();
        if (local) result.set(instance.id, local);
        else if (signable[index] === false) {
          const canReset = instance.capabilities?.features?.includes(LOCAL_POLICY_TRUST_RESET_CAPABILITY) === true;
          result.set(instance.id, {
            state: canReset ? 'locked_out' : 'recovery_unsupported',
            message: canReset
              ? 'The local relay trusts no policy signing key Opfield can sign with. Opfield resets its trust automatically on the next policy sync.'
              : LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE,
            observedAt,
            trustedKeyIds: reported[index] ?? [],
          });
        }
        return;
      }
      if (signable[index] === false) {
        result.set(instance.id, {
          state: 'reenrollment_required',
          message: remoteRelayReenrollmentMessage(),
          observedAt,
          trustedKeyIds: reported[index] ?? [],
        });
      }
    });
    return result;
  }

  /** Queues a push of this revision to remote relays; pushes run one after another. */
  private startRemotePush(revision: number): void {
    if (!this.dispatch || revision <= this.remotePushRevision) return;
    this.remotePushRevision = revision;
    this.remotePush = this.remotePush
      .then(() => this.pushChangedRemotePolicies(revision))
      .catch((error) => {
        logger.warn('Remote relay policy push failed', { revision, error: errorMessage(error) });
      });
  }

  /** Waits for queued remote pushes, but never longer than a short grace. */
  private async waitForRemotePush(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.remotePush,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REMOTE_POLICY_PUSH_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /**
   * Delivers a changed policy to remote relays right after the local relay applied it, before
   * daemons receive grants naming those relays. Otherwise a new route, endpoint generation or
   * grant key reaches the daemons minutes before the remote relays that must verify it. Best
   * effort: a relay that misses this push gets the policy from the periodic lease refresh.
   */
  private async pushChangedRemotePolicies(globalRevision: number): Promise<void> {
    if (!this.dispatch) return;
    const instances = await this.db
      .select({ nodeId: relayInstances.nodeId })
      .from(relayInstances)
      .where(
        and(
          eq(relayInstances.poolId, 'system'),
          eq(relayInstances.kind, 'remote'),
          inArray(relayInstances.state, ['synchronizing', 'ready', 'draining'])
        )
      );
    const now = Date.now();
    const stale = instances.flatMap(({ nodeId }) =>
      nodeId &&
      (this.remotePolicyRevisions.get(nodeId) ?? 0) < globalRevision &&
      now - (this.remotePolicyPushFailedAt.get(nodeId) ?? 0) >= REMOTE_POLICY_PUSH_RETRY_MS
        ? [nodeId]
        : []
    );
    if (!stale.length) return;
    const results = await Promise.allSettled(
      stale.map((nodeId) => this.syncRemoteInstancePolicy(nodeId, REMOTE_POLICY_PUSH_TIMEOUT_MS))
    );
    results.forEach((result, index) => {
      const nodeId = stale[index]!;
      if (result.status === 'fulfilled') {
        this.remotePolicyPushFailedAt.delete(nodeId);
        return;
      }
      if (isNodeNotConnectedError(result.reason)) {
        // A relay that is not connected gets its snapshot when it reconnects (forced push on connect). No cooldown:
        // it would also hold back the pushes of the changes made right after it reconnected, and daemons would
        // present grants the relay does not know yet ("grant does not match policy", B-18).
        logger.debug('Remote relay policy push waits for the relay to reconnect', { nodeId });
        return;
      }
      // An unresponsive relay must not slow every local sync; the lease refresh keeps trying.
      this.remotePolicyPushFailedAt.set(nodeId, Date.now());
      logger.info('Remote relay policy push deferred to the next lease refresh', {
        nodeId,
        error: errorMessage(result.reason),
      });
    });
  }

  async reconcileAndSync(): Promise<number> {
    await backfillRelayNodeFingerprints(this.db);
    await reconcileManagedDatabaseRelayPolicy(this.db);
    await reconcileManagedStorageRelayPolicy(this.db);
    // Availability set endpoints made by the pass above are placed on relays before the snapshot.
    for (const endpointId of await setEndpointIds(this.db).catch(() => [] as string[])) {
      await this.ensureLegacyCompatibleAssignment(endpointId).catch(() => undefined);
    }
    const orphanedNodeIds = await removeOrphanedRelayState(this.db);
    const revision = await this.syncSnapshot();
    await this.refreshAllNodeGrantsIfDue().then(
      () => {
        this.pendingGrantRefresh = null;
      },
      (error) => this.reportPendingGrantRefresh(error)
    );
    await this.withdrawOrphanedState(orphanedNodeIds);
    // Resumable streams only add to raw ones; their state never holds the policy back, and a pass that waits for
    // daemons to acknowledge does not hold up the caller (a drain, a placement) either.
    void this.streamResume.reconcile().catch((error) => {
      logger.warn('Resumable relay stream changes are retried at the next reconcile', { error: errorMessage(error) });
    });
    return revision;
  }

  /**
   * Removes relay endpoints and routes whose owner no longer exists (a Route deleted while its link was being
   * provisioned, or by an earlier release that left them behind) and withdraws them from the daemons they named.
   */
  async removeOrphanedState(): Promise<void> {
    const nodeIds = await removeOrphanedRelayState(this.db);
    if (nodeIds.length === 0) return;
    await this.syncSnapshot();
    await this.withdrawOrphanedState(nodeIds);
  }

  /**
   * A daemon left without any relay state is not among the nodes a grant refresh reaches, and one the refresh just
   * reached is skipped. A daemon that is offline gets its bundle when it reconnects.
   */
  private async withdrawOrphanedState(nodeIds: readonly string[]): Promise<void> {
    await Promise.allSettled(nodeIds.map((nodeId) => this.syncNodeGrants(nodeId, ROUTINE_GRANT_SYNC)));
  }

  /**
   * Every reconcile refreshes the daemons' grants, and every relay rebalance activation reconciles: while one daemon
   * is disconnected each of them failed the same way, and the rc.20 main stand logged this warning every 2 s (B-17).
   * The same pending refresh is reported once per interval; a different one, at once.
   */
  private reportPendingGrantRefresh(error: unknown, now = Date.now()): void {
    const message = error instanceof Error ? error.message : String(error);
    const last = this.pendingGrantRefresh;
    if (last?.message === message && now - last.reportedAt < PENDING_GRANT_REFRESH_REPORT_MS) {
      logger.debug('Relay policy reconciled but some daemon grant bundles remain pending', { error: message });
      return;
    }
    this.pendingGrantRefresh = { message, reportedAt: now };
    logger.info('Relay policy reconciled but some daemon grant bundles remain pending', { error: message });
  }

  async rotateIfDue(now = new Date()): Promise<boolean> {
    const grantRotated = await this.grantKeys.rotateIfDue(
      now,
      () => this.syncSnapshot(),
      () => this.refreshAllNodeGrantsIfDue(true)
    );
    const pendingPolicyKey = await this.policyKeys.beginRotationIfDue(now);
    if (pendingPolicyKey) {
      // The local relay has to receive the pending key in a snapshot signed by the current
      // one, exactly like the remote relays, before that key can be promoted.
      await this.syncSnapshot();
      await this.syncAllRemoteInstancePolicies();
    }
    const policyChanged = await this.finalizePolicySigningKeyRotation(now);
    return grantRotated || Boolean(pendingPolicyKey) || policyChanged;
  }

  async finalizePolicySigningKeyRotation(now = new Date()): Promise<boolean> {
    const promoted = await this.policyKeys.promoteAcknowledgedPending(now);
    const retired = await this.policyKeys.retireExpiredVerificationKeys(now);
    await this.policyKeys.destroyUnneededPrivateKeys(now);
    if (promoted || retired) await this.syncAllRemoteInstancePolicies();
    return promoted || retired;
  }

  private async syncAllRemoteInstancePolicies(): Promise<void> {
    const instances = await this.db
      .select({ nodeId: relayInstances.nodeId })
      .from(relayInstances)
      .where(
        and(
          eq(relayInstances.poolId, 'system'),
          eq(relayInstances.kind, 'remote'),
          inArray(relayInstances.state, ['synchronizing', 'ready', 'draining'])
        )
      );
    const results = await Promise.allSettled(
      instances.flatMap(({ nodeId }) => (nodeId ? [this.syncRemoteInstancePolicy(nodeId)] : []))
    );
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  }

  async ensureManagedDatabaseEndpoint(managedDatabaseId: string, nodeId: string): Promise<string> {
    const set = await setOfOwner(this.db, 'managed_database', managedDatabaseId);
    if (set) return this.ensureSetResourceEndpoint(set);
    const [database] = await this.db
      .select({ nodeId: managedDatabaseInstances.nodeId, status: managedDatabaseInstances.status })
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.id, managedDatabaseId))
      .limit(1);
    if (!database || database.nodeId !== nodeId || (database.status !== 'ready' && database.status !== 'updating')) {
      throw new Error('Managed database relay endpoint is unavailable');
    }
    const node = await this.grantIssuer.requireNodeIdentity(nodeId);
    const endpoint = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(relayEndpoints)
        .where(and(eq(relayEndpoints.ownerKind, 'managed_database'), eq(relayEndpoints.ownerId, managedDatabaseId)))
        .limit(1);
      if (!current) {
        const [created] = await tx
          .insert(relayEndpoints)
          .values({
            ownerKind: 'managed_database',
            ownerId: managedDatabaseId,
            subjectKind: 'daemon',
            subjectId: nodeId,
            certificateSha256: node.certificateFingerprint,
          })
          .returning({ id: relayEndpoints.id });
        await bumpRelayPolicyRevision(tx);
        return { id: created.id, active: true };
      }
      if (current.subjectId !== nodeId || current.certificateSha256 !== node.certificateFingerprint) {
        await tx
          .update(relayEndpoints)
          .set({
            subjectId: nodeId,
            certificateSha256: node.certificateFingerprint,
            generation: sql`${relayEndpoints.generation} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(relayEndpoints.id, current.id));
        await bumpRelayPolicyRevision(tx);
      }
      return { id: current.id, active: current.status === 'active' };
    });
    if (!endpoint.active && !(await this.reconcileInactiveEndpoint('managed_database', managedDatabaseId))) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_RELAY_ENDPOINT_PENDING',
        'The managed database relay endpoint is not active yet; try again in a few seconds'
      );
    }
    await this.ensureLegacyCompatibleAssignment(endpoint.id);
    await this.syncSnapshot();
    return endpoint.id;
  }

  /**
   * An endpoint of a running database or storage that is still inactive: the reconciliation pass that owns endpoint
   * status runs now (after any pass in progress) instead of the caller failing until the next one. A database created
   * just before (a restore into a new database) has its endpoint written as inactive by a pass that read it while it
   * was being created. True when the endpoint is active afterwards.
   */
  private async reconcileInactiveEndpoint(ownerKind: 'managed_database' | 'managed_storage', ownerId: string) {
    if (ownerKind === 'managed_database') await reconcileManagedDatabaseRelayPolicy(this.db);
    else await reconcileManagedStorageRelayPolicy(this.db);
    const [endpoint] = await this.db
      .select({ status: relayEndpoints.status })
      .from(relayEndpoints)
      .where(and(eq(relayEndpoints.ownerKind, ownerKind), eq(relayEndpoints.ownerId, ownerId)))
      .limit(1);
    return endpoint?.status === 'active';
  }

  async ensureManagedStorageEndpoint(clusterId: string, nodeId: string): Promise<string> {
    const set = await setOfOwner(this.db, 'managed_storage', clusterId);
    if (set) return this.ensureSetResourceEndpoint(set);
    const [database] = await this.db
      .select({ nodeId: managedStorageClusters.nodeId, status: managedStorageClusters.status })
      .from(managedStorageClusters)
      .where(eq(managedStorageClusters.id, clusterId))
      .limit(1);
    if (!database || database.nodeId !== nodeId || !['creating', 'ready', 'updating'].includes(database.status)) {
      throw new Error('Managed storage relay endpoint is unavailable');
    }
    const node = await this.grantIssuer.requireNodeIdentity(nodeId);
    const endpoint = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(relayEndpoints)
        .where(and(eq(relayEndpoints.ownerKind, 'managed_storage'), eq(relayEndpoints.ownerId, clusterId)))
        .limit(1);
      if (!current) {
        const [created] = await tx
          .insert(relayEndpoints)
          .values({
            ownerKind: 'managed_storage',
            ownerId: clusterId,
            subjectKind: 'daemon',
            subjectId: nodeId,
            certificateSha256: node.certificateFingerprint,
          })
          .returning({ id: relayEndpoints.id });
        await bumpRelayPolicyRevision(tx);
        return { id: created.id, active: true };
      }
      if (current.subjectId !== nodeId || current.certificateSha256 !== node.certificateFingerprint) {
        await tx
          .update(relayEndpoints)
          .set({
            subjectId: nodeId,
            certificateSha256: node.certificateFingerprint,
            generation: sql`${relayEndpoints.generation} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(relayEndpoints.id, current.id));
        await bumpRelayPolicyRevision(tx);
      }
      return { id: current.id, active: current.status === 'active' };
    });
    if (!endpoint.active && !(await this.reconcileInactiveEndpoint('managed_storage', clusterId))) {
      throw new AppError(
        409,
        'MANAGED_STORAGE_RELAY_ENDPOINT_PENDING',
        'The managed storage relay endpoint is not active yet; try again in a few seconds'
      );
    }
    await this.ensureLegacyCompatibleAssignment(endpoint.id);
    await this.syncSnapshot();
    return endpoint.id;
  }

  async ensureInternalRegistryEndpoint(): Promise<string> {
    const endpointId = await this.reconcileInternalRegistryEndpoint();
    await this.syncSnapshot();
    return endpointId;
  }

  async ensureInternalRegistryRoute(
    bindingId: string,
    sourceNodeId: string,
    ownerKind: RegistryRouteOwnerKind = 'registry_secure_link'
  ): Promise<string> {
    const routeIds = await this.ensureInternalRegistryRoutes([bindingId], sourceNodeId, ownerKind);
    return routeIds.get(bindingId)!;
  }

  /**
   * The registry routes of one node's bindings, published and granted once for all of them. Per binding, a node with
   * a dozen HA repositories rebuilt the policy snapshot and resent its grants a dozen times on every 15-s token
   * refresh; its sync outlived the tokens it carried and blocked image preparation for minutes (stand rc20pre3, N-14).
   */
  async ensureInternalRegistryRoutes(
    bindingIds: readonly string[],
    sourceNodeId: string,
    ownerKind: RegistryRouteOwnerKind = 'registry_secure_link'
  ): Promise<Map<string, string>> {
    if (!(REGISTRY_ROUTE_OWNER_KINDS as readonly string[]).includes(ownerKind)) {
      throw new Error('Unsupported registry relay route owner kind');
    }
    const routeIds = new Map<string, string>();
    if (bindingIds.length === 0) return routeIds;
    const endpointId = await this.reconcileInternalRegistryEndpoint();
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    for (const bindingId of new Set(bindingIds)) {
      routeIds.set(
        bindingId,
        await this.ensureRoute(ownerKind, bindingId, 'daemon', sourceNodeId, source.certificateFingerprint, endpointId)
      );
    }
    await this.syncSnapshot();
    await this.syncNodeGrants(sourceNodeId, ROUTINE_GRANT_SYNC);
    return routeIds;
  }

  async getInternalRegistryRouteRuntime(bindingId: string, ownerKind: RegistryRouteOwnerKind = 'registry_secure_link') {
    const [route] = await this.db
      .select({ id: relayRoutes.id })
      .from(relayRoutes)
      .where(and(eq(relayRoutes.ownerKind, ownerKind), eq(relayRoutes.ownerId, bindingId)))
      .limit(1);
    if (!route) return null;
    return this.relay.getRouteRuntime(route.id);
  }

  async ensureBindingRoute(
    bindingId: string,
    managedDatabaseId: string,
    sourceNodeId: string,
    targetNodeId: string,
    managedDatabaseListener?: RelayManagedDatabaseListenerConfig,
    /** The connector egress of the link's node; undefined keeps the route's. */
    secureLinkEgress?: RelaySecureLinkEgressConfig | null
  ): Promise<string> {
    const endpointId = await this.ensureManagedDatabaseEndpoint(managedDatabaseId, targetNodeId);
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    const routeId = await this.ensureRoute(
      'managed_database_binding',
      bindingId,
      'daemon',
      sourceNodeId,
      source.certificateFingerprint,
      endpointId,
      managedDatabaseListener,
      secureLinkEgress
    );
    await this.syncSnapshot();
    await Promise.all([
      this.syncNodeGrants(sourceNodeId, ROUTINE_GRANT_SYNC),
      this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC),
    ]);
    return routeId;
  }

  async adoptBindingRoute(
    placementBindingId: string,
    bindingId: string,
    managedDatabaseId: string,
    sourceNodeId: string,
    targetNodeId: string,
    managedDatabaseListener: RelayManagedDatabaseListenerConfig | undefined,
    /** The connector egress of the adopted route; undefined keeps the placement route's. */
    secureLinkEgress?: RelaySecureLinkEgressConfig | null
  ): Promise<string> {
    const endpointId = await this.ensureManagedDatabaseEndpoint(managedDatabaseId, targetNodeId);
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    const adoptedRouteId = await this.db.transaction(async (tx) => {
      const [placementRoute] = await tx
        .select()
        .from(relayRoutes)
        .where(and(eq(relayRoutes.ownerKind, 'managed_database_binding'), eq(relayRoutes.ownerId, placementBindingId)))
        .limit(1);
      if (!placementRoute) return null;
      await tx
        .delete(relayRoutes)
        .where(and(eq(relayRoutes.ownerKind, 'managed_database_binding'), eq(relayRoutes.ownerId, bindingId)));
      // Only a changed source, target or listener address moves the generation. A new generation makes
      // the relay close the route's tunnels and the daemon replace its listener; a workload that stays
      // on the same node and network keeps its open connections while the route changes owner.
      const changed =
        placementRoute.sourceKind !== 'daemon' ||
        placementRoute.sourceId !== sourceNodeId ||
        placementRoute.sourceCertificateSha256 !== source.certificateFingerprint ||
        placementRoute.targetEndpointId !== endpointId ||
        routeTransportRestartRequired(
          {
            managedDatabaseListener: placementRoute.managedDatabaseListener ?? null,
            secureLinkEgress: placementRoute.secureLinkEgress ?? null,
          },
          {
            managedDatabaseListener: managedDatabaseListener ?? null,
            secureLinkEgress:
              secureLinkEgress === undefined ? (placementRoute.secureLinkEgress ?? null) : secureLinkEgress,
          }
        );
      await tx
        .update(relayRoutes)
        .set({
          ownerId: bindingId,
          sourceKind: 'daemon',
          sourceId: sourceNodeId,
          sourceCertificateSha256: source.certificateFingerprint,
          targetEndpointId: endpointId,
          managedDatabaseListener: managedDatabaseListener ?? null,
          ...(secureLinkEgress === undefined ? {} : { secureLinkEgress }),
          generation: changed ? placementRoute.generation + 1 : placementRoute.generation,
          updatedAt: new Date(),
        })
        .where(eq(relayRoutes.id, placementRoute.id));
      await bumpRelayPolicyRevision(tx);
      return placementRoute.id;
    });
    const routeId =
      adoptedRouteId ??
      (await this.ensureRoute(
        'managed_database_binding',
        bindingId,
        'daemon',
        sourceNodeId,
        source.certificateFingerprint,
        endpointId,
        managedDatabaseListener,
        secureLinkEgress
      ));
    await this.syncSnapshot();
    await Promise.all([
      this.syncNodeGrants(sourceNodeId, ROUTINE_GRANT_SYNC),
      this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC),
    ]);
    return routeId;
  }

  /** Whether relay policy already carries this Secure Link to the given target node (it may be serving now). */
  async hasProxySecureLinkEndpoint(linkId: string, targetNodeId: string): Promise<boolean> {
    const [endpoint] = await this.db
      .select({ id: relayEndpoints.id })
      .from(relayEndpoints)
      .where(
        and(
          eq(relayEndpoints.ownerKind, 'proxy_host_secure_link'),
          eq(relayEndpoints.ownerId, linkId),
          eq(relayEndpoints.subjectId, targetNodeId),
          eq(relayEndpoints.status, 'active')
        )
      )
      .limit(1);
    return Boolean(endpoint);
  }

  /**
   * The relay endpoint of a proxy Secure Link on its target node and one route per source nginx node. A route on an
   * ingress group has one source per member: every member gets its own route, connect grant and relay transports
   * for the same endpoint, and routes of sources that no longer serve the link are removed. One source keeps today's
   * behaviour: a changed source moves the existing route in place.
   */
  /** The Docker node a Route or Additional Secure Link reaches now: its relay endpoint's subject, if it has one. */
  async proxySecureLinkTargetNodeId(linkId: string): Promise<string | null> {
    const [endpoint] = await this.db
      .select({ subjectId: relayEndpoints.subjectId })
      .from(relayEndpoints)
      .where(
        and(
          eq(relayEndpoints.ownerKind, 'proxy_host_secure_link'),
          eq(relayEndpoints.ownerId, linkId),
          eq(relayEndpoints.subjectKind, 'daemon')
        )
      )
      .limit(1);
    return endpoint?.subjectId ?? null;
  }

  async ensureProxySecureLink(
    linkId: string,
    sourceNodeIds: string | readonly string[],
    targetNodeId: string
  ): Promise<string> {
    const target = await this.grantIssuer.requireNodeIdentity(targetNodeId);
    const { endpointId, formerTargetNodeId } = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(relayEndpoints)
        .where(and(eq(relayEndpoints.ownerKind, 'proxy_host_secure_link'), eq(relayEndpoints.ownerId, linkId)))
        .limit(1);
      if (!current) {
        const [created] = await tx
          .insert(relayEndpoints)
          .values({
            ownerKind: 'proxy_host_secure_link',
            ownerId: linkId,
            subjectKind: 'daemon',
            subjectId: targetNodeId,
            certificateSha256: target.certificateFingerprint,
          })
          .returning({ id: relayEndpoints.id });
        await bumpRelayPolicyRevision(tx);
        return { endpointId: created.id, formerTargetNodeId: null };
      }
      if (current.subjectId !== targetNodeId || current.certificateSha256 !== target.certificateFingerprint) {
        await tx
          .update(relayEndpoints)
          .set({
            subjectId: targetNodeId,
            certificateSha256: target.certificateFingerprint,
            generation: sql`${relayEndpoints.generation} + 1`,
            status: 'active',
            updatedAt: new Date(),
          })
          .where(eq(relayEndpoints.id, current.id));
        await bumpRelayPolicyRevision(tx);
      }
      return {
        endpointId: current.id,
        formerTargetNodeId: current.subjectId !== targetNodeId ? current.subjectId : null,
      };
    });
    // The routes first: whether the first assignment may leave the legacy shape depends on every daemon on the
    // path, its sources included.
    const { routeIds, removedSourceIds } = await this.ensureProxyLinkSourceRoutes(linkId, sourceNodeIds, endpointId);
    await this.ensureLegacyCompatibleAssignment(endpointId);
    await this.syncSnapshot();
    await Promise.all([
      this.syncProxyLinkSourceGrants(sourceNodeIds, removedSourceIds),
      this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC),
      // A link that moved to another node (its container or deployment migrated) leaves its former node without a
      // grant for it once the new node holds one. A former node that is offline gets its bundle when it reconnects.
      formerTargetNodeId
        ? this.syncNodeGrants(formerTargetNodeId, ROUTINE_GRANT_SYNC).catch((error) =>
            logger.warn('A moved Secure Link left grants on its former node until it reconnects', {
              linkId,
              nodeId: formerTargetNodeId,
              error: error instanceof Error ? error.message : String(error),
            })
          )
        : Promise.resolve(),
    ]);
    return routeIds[0]!;
  }

  async ensureManagedStorageProxySecureLink(
    linkId: string,
    clusterId: string,
    sourceNodeIds: string | readonly string[],
    targetNodeId: string
  ): Promise<string> {
    const endpointId = await this.ensureManagedStorageEndpoint(clusterId, targetNodeId);
    const { routeIds, removedSourceIds } = await this.ensureProxyLinkSourceRoutes(linkId, sourceNodeIds, endpointId);
    await this.syncSnapshot();
    await Promise.all([
      this.syncProxyLinkSourceGrants(sourceNodeIds, removedSourceIds),
      this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC),
    ]);
    return routeIds[0]!;
  }

  /**
   * The grants of a link's sources. A member of an ingress group that is not connected, and a former source that is
   * not, get their grant bundle in their reconnect sync: they must not fail the link's change on the members that are
   * online (IG-1). The one source of a single-node link fails as before.
   */
  private async syncProxyLinkSourceGrants(
    sourceNodeIds: string | readonly string[],
    removedSourceIds: readonly string[]
  ): Promise<void> {
    const sources = proxyLinkSources(sourceNodeIds);
    const group = sources.length > 1;
    await Promise.all(
      [...new Set([...sources, ...removedSourceIds])].map(async (nodeId) => {
        try {
          await this.syncNodeGrants(nodeId, ROUTINE_GRANT_SYNC);
        } catch (error) {
          if ((group || !sources.includes(nodeId)) && isNodeNotConnectedError(error)) {
            logger.debug('Relay grants of a Secure Link source wait for its reconnect', { nodeId });
            return;
          }
          throw error;
        }
      })
    );
  }

  /**
   * One `proxy_host_secure_link` route per source daemon for the link endpoint (relay_routes_proxy_link_source_unique).
   * Returns the route ids in source order and the sources whose routes were removed or moved away.
   */
  private async ensureProxyLinkSourceRoutes(
    linkId: string,
    sourceNodeIds: string | readonly string[],
    targetEndpointId: string
  ): Promise<{ routeIds: string[]; removedSourceIds: string[] }> {
    const sources = proxyLinkSources(sourceNodeIds);
    if (sources.length === 0) throw new Error('A proxy Secure Link needs at least one source nginx node');
    const identities = await Promise.all(sources.map((nodeId) => this.grantIssuer.requireNodeIdentity(nodeId)));
    return this.db.transaction(async (tx) => {
      const current = await tx
        .select()
        .from(relayRoutes)
        .where(and(eq(relayRoutes.ownerKind, 'proxy_host_secure_link'), eq(relayRoutes.ownerId, linkId)));
      let changed = false;
      const routeIds: string[] = [];
      const removedSourceIds: string[] = [];
      // A single-source link moving to another node keeps its route (and its runtime metrics) in place.
      const moveInPlace =
        sources.length === 1 && current.length === 1 && current[0]!.sourceId !== sources[0] ? current[0]! : null;
      for (const [index, sourceId] of sources.entries()) {
        const fingerprint = identities[index]!.certificateFingerprint;
        const existing =
          moveInPlace ?? current.find((route) => route.sourceKind === 'daemon' && route.sourceId === sourceId);
        if (!existing) {
          const [created] = await tx
            .insert(relayRoutes)
            .values({
              ownerKind: 'proxy_host_secure_link',
              ownerId: linkId,
              sourceKind: 'daemon',
              sourceId,
              sourceCertificateSha256: fingerprint,
              targetEndpointId,
              maxFrameBytes: RELAY_MAX_FRAME_BYTES,
            })
            .returning({ id: relayRoutes.id });
          routeIds.push(created.id);
          changed = true;
          continue;
        }
        if (
          existing.sourceKind !== 'daemon' ||
          existing.sourceId !== sourceId ||
          existing.sourceCertificateSha256 !== fingerprint ||
          existing.targetEndpointId !== targetEndpointId ||
          existing.managedDatabaseListener != null
        ) {
          if (existing.sourceKind === 'daemon' && existing.sourceId !== sourceId) {
            removedSourceIds.push(existing.sourceId);
          }
          await tx
            .update(relayRoutes)
            .set({
              sourceKind: 'daemon',
              sourceId,
              sourceCertificateSha256: fingerprint,
              targetEndpointId,
              managedDatabaseListener: null,
              generation: existing.generation + 1,
              updatedAt: new Date(),
            })
            .where(eq(relayRoutes.id, existing.id));
          changed = true;
        }
        routeIds.push(existing.id);
      }
      const stale = current.filter((route) => !routeIds.includes(route.id));
      if (stale.length > 0) {
        await tx.delete(relayRoutes).where(
          inArray(
            relayRoutes.id,
            stale.map((route) => route.id)
          )
        );
        for (const route of stale) if (route.sourceKind === 'daemon') removedSourceIds.push(route.sourceId);
        changed = true;
      }
      if (changed) await bumpRelayPolicyRevision(tx);
      return { routeIds, removedSourceIds };
    });
  }

  async getProxyRouteRuntime(linkId: string): Promise<ProxyRouteRuntime | null> {
    const routes = await this.db
      .select({ id: relayRoutes.id })
      .from(relayRoutes)
      .where(and(eq(relayRoutes.ownerKind, 'proxy_host_secure_link'), eq(relayRoutes.ownerId, linkId)));
    // A route on an ingress group has one relay route per member: its runtime is their sum.
    return routes.length ? this.relayRuntime(routes.map((route) => route.id)) : null;
  }

  /**
   * The runtime of relay routes as every relay that holds them counts it, summed: the local relay through its admin
   * API, each remote relay whose current policy holds one of them through its supervisor (relay_route_runtime_v1),
   * all in parallel. A relay that does not hold a route has no share; one that holds it and does not answer leaves
   * relayCountersComplete false. Never fails: with no answer at all the counters are zero and incomplete.
   */
  private async relayRuntime(routeIds: string[]): Promise<RelayRouteRuntime> {
    const [local, remote] = await Promise.all([this.localRouteReports(routeIds), this.remoteRouteReports(routeIds)]);
    const reports = [...local.reports, ...remote.reports];
    const runtime =
      reports.length > 1 ? sumRouteRuntimes(reports) : relayRouteRuntime(reports[0] ?? { routeId: routeIds[0] ?? '' });
    return { ...runtime, relayCountersComplete: local.complete && remote.complete };
  }

  private async localRouteReports(routeIds: string[]) {
    const results = await Promise.allSettled(routeIds.map((routeId) => this.relay.getRouteRuntime(routeId)));
    return {
      reports: results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
      // NOT_FOUND: the local relay's policy does not hold the route (remote relays carry it).
      complete: results.every(
        (result) =>
          result.status === 'fulfilled' || (result.reason as { code?: number } | null)?.code === GrpcStatus.NOT_FOUND
      ),
    };
  }

  /**
   * The nodes of the remote relays whose current policy holds one of the routes. A relay whose policy expired admits
   * nothing, and a route it dropped (removedAtRevision) left its counters with it.
   */
  private remoteRouteHolders(routeIds: string[]): Promise<Array<{ nodeId: string | null }>> {
    const ids = JSON.stringify(routeIds);
    return this.db
      .select({ nodeId: relayInstances.nodeId })
      .from(relayInstances)
      .innerJoin(relayInstancePolicyState, eq(relayInstancePolicyState.instanceId, relayInstances.id))
      .where(
        and(
          eq(relayInstances.kind, 'remote'),
          sql`${relayInstances.policyExpiresAt} > now()`,
          sql`jsonb_path_exists(${relayInstancePolicyState.routes}, ${HOLDS_ANY_ROUTE}::jsonpath, jsonb_build_object('ids', ${ids}::jsonb))`
        )
      );
  }

  private async remoteRouteReports(routeIds: string[]) {
    const holders = await this.remoteRouteHolders(routeIds);
    const answers = await Promise.all(
      holders.map(async ({ nodeId }) => {
        if (!nodeId || !this.dispatch?.getRelayRouteRuntime) return null;
        try {
          const result = await this.dispatch.getRelayRouteRuntime(nodeId, routeIds, RELAY_ROUTE_RUNTIME_TIMEOUT_MS);
          return result?.success ? parseRelayRouteRuntimeAnswer(result.detail) : null;
        } catch {
          return null;
        }
      })
    );
    return {
      reports: answers.flatMap((answer) => answer ?? []),
      complete: answers.every((answer) => answer !== null),
    };
  }

  async getManagedDatabaseBindingRouteRuntime(bindingId: string): Promise<RelayRouteRuntime | null> {
    const own = await this.managedLinkRoutes('managed_database_binding', [bindingId]);
    if (own.length) return this.managedLinkRuntime(own);
    // Availability serves the link through one route per placement and drops the link's own route.
    const placements = await this.db
      .select({ id: managedDatabaseBindingPlacements.id })
      .from(managedDatabaseBindingPlacements)
      .where(eq(managedDatabaseBindingPlacements.bindingId, bindingId));
    if (!placements.length) return null;
    const routes = await this.managedLinkRoutes(
      'managed_database_binding',
      placements.map(({ id }) => id)
    );
    return routes.length ? this.managedLinkRuntime(routes) : null;
  }

  async getManagedStorageBindingRouteRuntime(bindingId: string): Promise<RelayRouteRuntime | null> {
    // An Availability workload runs the link from every placement node, one route each: the runtime is their sum.
    const routes = await this.managedLinkRoutes('managed_storage_binding', [bindingId]);
    return routes.length ? this.managedLinkRuntime(routes) : null;
  }

  /**
   * Sets what the source daemon of one link route serves locally (its connector egress, and for a database link its
   * host listener) without dropping the route's tunnels while one of them keeps serving. Delivering the grants is the
   * caller's: the ACK of `syncNodeGrantBundle` reports the egress (egressStatuses).
   */
  setLinkRouteTransport(
    ownerKind: 'managed_storage_binding' | 'managed_database_binding' | 'container_link',
    ownerId: string,
    sourceNodeId: string,
    change: {
      secureLinkEgress?: RelaySecureLinkEgressConfig | null;
      managedDatabaseListener?: RelayManagedDatabaseListenerConfig | null;
    }
  ): Promise<{ routeId: string; generation: number } | null> {
    return this.linkRoutes.setRouteTransport(ownerKind, ownerId, sourceNodeId, change);
  }

  /** What one link route from a node serves locally now (listener, connector egress), or null without a route. */
  getLinkRouteTransport(
    ownerKind: 'managed_storage_binding' | 'managed_database_binding' | 'container_link',
    ownerId: string,
    sourceNodeId: string
  ) {
    return this.linkRoutes.getRouteTransport(ownerKind, ownerId, sourceNodeId);
  }

  /** The relay endpoint of a container link (or of one target placement) on its target node. */
  async ensureContainerLinkEndpoint(
    ownerId: string,
    targetNodeId: string
  ): Promise<{ endpointId: string; formerTargetNodeId: string | null }> {
    const result = await this.linkRoutes.ensureContainerLinkEndpoint(ownerId, targetNodeId);
    await this.syncSnapshot();
    await this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC);
    return result;
  }

  /** The route of a container link from one source node to the endpoint that serves it for that node. */
  ensureContainerLinkRoute(
    linkId: string,
    sourceNodeId: string,
    endpointOwnerId: string,
    secureLinkEgress: RelaySecureLinkEgressConfig
  ): Promise<{ routeId: string; generation: number; targetNodeId: string }> {
    return this.linkRoutes.ensureContainerLinkRoute(linkId, sourceNodeId, endpointOwnerId, secureLinkEgress);
  }

  revokeContainerLinkRoute(linkId: string, sourceNodeId: string): Promise<void> {
    return this.linkRoutes.revokeContainerLinkRoute(linkId, sourceNodeId);
  }

  /** A container link's relay counters: the sum of its routes (one per source node). */
  /**
   * A container link's runtime: its routes (one per consumer node) and what those nodes report about it, same-node
   * dials that never reach a relay included, as for managed database and storage links.
   */
  async getContainerLinkRouteRuntime(linkId: string): Promise<RelayRouteRuntime | null> {
    const routes = await this.linkRoutes.containerLinkRoutes(linkId);
    return routes.length ? this.managedLinkRuntime(routes) : null;
  }

  /** The source nodes a container link has routes from (its node and Availability placement nodes). */
  async containerLinkSourceNodeIds(linkId: string): Promise<string[]> {
    const routes = await this.linkRoutes.containerLinkRoutes(linkId);
    return routes.filter((route) => route.ownerKind === CONTAINER_LINK_OWNER_KIND).map((route) => route.sourceId);
  }

  private managedLinkRoutes(ownerKind: 'managed_database_binding' | 'managed_storage_binding', ownerIds: string[]) {
    return this.db
      .select({
        id: relayRoutes.id,
        ownerKind: relayRoutes.ownerKind,
        ownerId: relayRoutes.ownerId,
        sourceKind: relayRoutes.sourceKind,
        sourceId: relayRoutes.sourceId,
      })
      .from(relayRoutes)
      .where(and(eq(relayRoutes.ownerKind, ownerKind), inArray(relayRoutes.ownerId, ownerIds)));
  }

  /**
   * A managed link's runtime: its relay routes (one, or one per Availability placement) as every relay that holds
   * them counts it (relayRuntime), and what the nodes running its workloads report. The node holds the link at its
   * capacity whichever relay of the pool carries a connection, so its count is the link's open connections.
   */
  private async managedLinkRuntime(
    routes: Array<{ id: string; ownerKind: string; ownerId: string; sourceKind: string; sourceId: string }>
  ): Promise<RelayRouteRuntime> {
    const relayRuntime = await this.relayRuntime(routes.map((route) => route.id));
    const now = Date.now();
    const reports = routes.map((route) => {
      if (route.sourceKind !== 'daemon' || !this.managedLinkReports) return null;
      const report = this.managedLinkReports.managedLinkReport(route.sourceId, route.ownerKind, route.ownerId);
      if (!report || now - report.reportedAt.getTime() > MANAGED_LINK_REPORT_FRESH_MS) {
        this.managedLinkReports.requestHealthReport(route.sourceId, MANAGED_LINK_REPORT_FRESH_MS);
      }
      return report;
    });
    return withManagedLinkConnections(relayRuntime, sumManagedLinkReports(reports));
  }

  async ensureOpfieldRoute(
    managedDatabaseId: string,
    targetNodeId: string,
    appCertificateFingerprint: string
  ): Promise<string> {
    const endpointId = await this.ensureManagedDatabaseEndpoint(managedDatabaseId, targetNodeId);
    const state = await this.grantIssuer.requireState();
    const routeId = await this.ensureRoute(
      LEGACY_MANAGED_DATABASE_OWNER_KIND,
      managedDatabaseId,
      LEGACY_RELAY_SOURCE_KIND,
      state.opfieldInstanceId,
      appCertificateFingerprint,
      endpointId
    );
    await this.syncSnapshot();
    // Opfield reads its route at every open: turned on at the target here, its streams are resumable from the first.
    await this.streamResume.enableBeforeSourceSync({ routeIds: [routeId] }).catch((error) => {
      logger.warn('Resumable streams for a Opfield relay route deferred to the next reconcile', {
        routeId,
        error: errorMessage(error),
      });
    });
    await this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC);
    return routeId;
  }

  /** A tunnel from Opfield to a managed database; its bytes cross from the tunnel worker (see opfieldTunnelEndpoint). */
  async openOpfieldTunnel(managedDatabaseId: string, appCertificateFingerprint: string): Promise<Duplex> {
    const routeId = await this.opfieldDatabaseRoute(managedDatabaseId, appCertificateFingerprint);
    const set = await setOfOwner(this.db, 'managed_database', managedDatabaseId);
    if (set) return this.openSetRouteTunnel(set, routeId, appCertificateFingerprint);
    return this.openOpfieldRouteTunnel(routeId, appCertificateFingerprint);
  }

  /**
   * A tunnel from Opfield to the member of an availability set that serves now: the resource's Opfield route of
   * `lane` (database tools or the storage browser), tried on the serving member's route first, then on the others by
   * rank (the relays admit only the lease holder; a manual pair's primary is the only serving endpoint).
   */
  async openSetTunnel(setId: string, appCertificateFingerprint: string): Promise<Duplex> {
    const [set] = await loadSetRelayViews(this.db, { setIds: [setId] });
    if (!set) throw new Error('Availability set not found');
    return set.ownerKind === 'managed_database'
      ? this.openOpfieldTunnel(set.ownerId, appCertificateFingerprint)
      : this.openStorageOpfieldTunnel(set.ownerId, appCertificateFingerprint);
  }

  private async openSetRouteTunnel(
    set: SetRelayView,
    parentRouteId: string,
    appCertificateFingerprint: string
  ): Promise<Duplex> {
    const routes = await orderedSetRoutes(this.db, parentRouteId, set, await setServingMemberId(this.db, set));
    let lastError: unknown = new Error('No member of the availability set is reachable');
    for (const { routeId } of routes) {
      try {
        return await this.openOpfieldRouteTunnel(routeId, appCertificateFingerprint);
      } catch (error) {
        if (isOpfieldConnectionGone(error)) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
  }

  /**
   * The relay paths of an availability set now (created or converted, a member added, removed or its node's identity
   * renewed, a manual pair's primary switched): member and peer endpoints placed on relays, member routes and the
   * member mesh, the relay snapshot and the members' grants.
   */
  async reconcileSetRelayPaths(setId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LEGACY_LOCK_RELAY_POLICY_RECONCILIATION}))`);
      if (await reconcileSetPaths(tx, [setId])) await bumpRelayPolicyRevision(tx);
    });
    await this.syncSetPaths([setId]);
  }

  /**
   * Turning a set off (AS9 close): the kept member's paths become the resource's single-node paths in place, every
   * other member path goes, in one policy revision. Call before deleting the set row.
   */
  async releaseSetRelayPaths(setId: string, keepMemberId: string): Promise<void> {
    const [set] = await loadSetRelayViews(this.db, { setIds: [setId] });
    if (!set) return;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LEGACY_LOCK_RELAY_POLICY_RECONCILIATION}))`);
      if (await releaseSetPaths(tx, setId, keepMemberId)) await bumpRelayPolicyRevision(tx);
    });
    await this.syncSnapshot();
    await Promise.allSettled(set.members.map((member) => this.syncNodeGrants(member.nodeId)));
  }

  private async syncSetPaths(setIds?: string[]): Promise<void> {
    for (const endpointId of await setEndpointIds(this.db, setIds)) {
      await this.ensureLegacyCompatibleAssignment(endpointId).catch((error) => {
        logger.warn('Relay placement of an availability set endpoint is retried at the next reconcile', {
          endpointId,
          error: errorMessage(error),
        });
      });
    }
    await this.syncSnapshot();
    const views = await loadSetRelayViews(this.db, setIds ? { setIds } : {});
    await Promise.allSettled(
      [...new Set(views.flatMap((view) => view.members.map((member) => member.nodeId)))].map((nodeId) =>
        this.syncNodeGrants(nodeId, ROUTINE_GRANT_SYNC)
      )
    );
  }

  /** The resource endpoint of a set (the origin member's client endpoint), made with the set's paths if missing. */
  private async ensureSetResourceEndpoint(set: SetRelayView): Promise<string> {
    const kind = set.ownerKind === 'managed_database' ? 'managed_database' : 'managed_storage';
    const find = async () =>
      (
        await this.db
          .select({ id: relayEndpoints.id })
          .from(relayEndpoints)
          .where(and(eq(relayEndpoints.ownerKind, kind), eq(relayEndpoints.ownerId, set.ownerId)))
          .limit(1)
      )[0]?.id;
    let endpointId = await find();
    if (!endpointId) {
      await this.reconcileSetRelayPaths(set.setId);
      endpointId = await find();
    }
    if (!endpointId) throw new Error('The availability set has no relay endpoint yet');
    await this.ensureLegacyCompatibleAssignment(endpointId);
    return endpointId;
  }

  /** The managed database's Opfield route, made on first use; throws while the database is not up. */
  private async opfieldDatabaseRoute(managedDatabaseId: string, appCertificateFingerprint: string): Promise<string> {
    const [database] = await this.db
      .select({ nodeId: managedDatabaseInstances.nodeId, status: managedDatabaseInstances.status })
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.id, managedDatabaseId))
      .limit(1);
    if (!database || (database.status !== 'ready' && database.status !== 'updating')) {
      throw new Error('Managed database is unavailable');
    }
    const routeId =
      (await this.currentOpfieldRoute(
        LEGACY_MANAGED_DATABASE_OWNER_KIND,
        'managed_database',
        managedDatabaseId,
        database.nodeId,
        appCertificateFingerprint
      )) ?? (await this.ensureOpfieldRoute(managedDatabaseId, database.nodeId, appCertificateFingerprint));
    return routeId;
  }

  /**
   * A tunnel from Opfield on its route for a reader on this thread (the managed tunnel proxies of a commercial module
   * from before opfieldTunnelEndpoint): the tunnel runs in the tunnel worker, this end is a loopback connection to it.
   */
  private async openOpfieldRouteTunnel(routeId: string, appCertificateFingerprint: string): Promise<Duplex> {
    const tunnels = this.opfieldTunnels();
    const slotId = await tunnels.createSlot();
    try {
      await this.openOpfieldRouteTunnelInto(routeId, appCertificateFingerprint, slotId);
    } catch (error) {
      tunnels.failSlot(slotId, errorMessage(error));
      throw error;
    }
    return tunnels.connectSlot(slotId);
  }

  /**
   * A tunnel from Opfield itself on its route, for the connection in the tunnel worker's `slotId`. Resumable (RSv1)
   * when the connect assignment carries stream_resume: the stream then moves to another relay (or the same one back)
   * on drain, GOAWAY or path failure, reissuing the assignment for every new path. A target that turns out not to be
   * resume-aware latches the route raw for a while.
   */
  private async openOpfieldRouteTunnelInto(
    routeId: string,
    appCertificateFingerprint: string,
    slotId: string
  ): Promise<void> {
    this.opfieldRouteFingerprints.set(routeId, appCertificateFingerprint);
    const tunnels = this.opfieldTunnels();
    const issue = () =>
      this.withAcknowledgedPolicy(() =>
        this.grantIssuer.issueOpfieldConnectAssignment(routeId, appCertificateFingerprint)
      );
    const assignment = await issue();
    const resume = assignment.streamResume;
    if (resume && !tunnels.isResumeLegacy(routeId, resume.keyId)) {
      let first: typeof assignment | null = assignment;
      const dial = async (avoidRelayId: string | null) => {
        const current = first ?? (await issue());
        first = null;
        const path = await this.openOpfieldResumePath(routeId, current, avoidRelayId);
        const key = current.streamResume;
        return key ? { path, keyId: key.keyId, key: Buffer.from(key.key) } : { path };
      };
      try {
        await tunnels.bindResumable(
          slotId,
          {
            routeId,
            keyId: resume.keyId,
            key: Buffer.from(resume.key),
            halfCloseTimeoutMs: resume.halfCloseTimeoutMs ?? 0,
          },
          dial
        );
        return;
      } catch (error) {
        if (!(error instanceof ResumeSessionError && error.code === 'legacy_peer')) throw error;
        logger.warn('Opfield relay route target is not resume-aware; using raw streams', { routeId });
      }
    }
    const active = assignment.candidates.filter(({ assignmentState }) => assignmentState === 'active');
    await this.opfieldPaths().measure(routeId, active);
    const activeCandidates = this.opfieldPaths().order(routeId, active, null);
    let lastError: unknown;
    const passed: Array<{ relayId: string; error: string }> = [];
    for (const candidate of activeCandidates) {
      try {
        await tunnels.bindRaw(
          slotId,
          candidate.local
            ? { kind: 'local', grant: candidate.grant, relayId: candidate.relayInstanceId }
            : { kind: 'candidate', candidate }
        );
        if (passed.length) logOpfieldPathPastNearer(routeId, candidate.relayInstanceId, passed);
        return;
      } catch (error) {
        if (isOpfieldConnectionGone(error)) throw error;
        lastError = error;
        passed.push({ relayId: candidate.relayInstanceId, error: errorMessage(error) });
      }
    }
    if (!activeCandidates.length) {
      await tunnels.bindRaw(slotId, { kind: 'local', grant: assignment.grant, relayId: LEGACY_RELAY_PATH_ID });
      return;
    }
    throw lastError instanceof Error ? lastError : new Error('Relay pool is unavailable');
  }

  /**
   * One relay path of a resumable Opfield stream: active and staging candidates (a staging one is registered on both
   * ends: when the only active relay drains or was force-disconnected the stream moves there instead of being cut),
   * the relay it leaves last; reachable relays first, then by role and measured distance, an active candidate before a
   * staging one only among equally near ones (orderOpfieldRelayCandidates; O-1, rc.10 F-1). The path opens in the
   * tunnel worker, which hands it to the stream. A path that opens past a nearer relay is logged with the reason.
   */
  private async openOpfieldResumePath(
    routeId: string,
    assignment: Awaited<ReturnType<RelayGrantIssuerService['issueOpfieldConnectAssignment']>>,
    avoidRelayId: string | null
  ): Promise<RemotePath> {
    const tunnels = this.opfieldTunnels();
    const usable = assignment.candidates.filter(
      ({ assignmentState }) => assignmentState === 'active' || assignmentState === 'staging'
    );
    await this.opfieldPaths().measure(routeId, usable);
    const candidates = this.opfieldPaths().order(routeId, usable, avoidRelayId);
    // A pre-pool assignment has only the local relay: a recovering stream comes back to it.
    if (!candidates.length) return tunnels.openLocalResumePath(assignment.grant, LEGACY_RELAY_PATH_ID);
    let lastError: unknown;
    const passed: Array<{ relayId: string; error: string }> = [];
    for (const candidate of candidates) {
      try {
        const path = candidate.local
          ? await tunnels.openLocalResumePath(candidate.grant, candidate.relayInstanceId)
          : await tunnels.openCandidateResumePath(candidate);
        if (passed.length) logOpfieldPathPastNearer(routeId, candidate.relayInstanceId, passed);
        return path;
      } catch (error) {
        lastError = error;
        passed.push({ relayId: candidate.relayInstanceId, error: errorMessage(error) });
      }
    }
    throw lastError instanceof Error ? lastError : new Error('No other relay is available');
  }

  async probeOpfieldRelayCandidate(
    routeId: string,
    appCertificateFingerprint: string,
    relayInstanceId: string,
    assignmentGeneration: string
  ): Promise<void> {
    const assignment = await this.withAcknowledgedPolicy(() =>
      this.grantIssuer.issueOpfieldConnectAssignment(routeId, appCertificateFingerprint)
    );
    const candidate = assignment.candidates.find(
      (item) => item.relayInstanceId === relayInstanceId && item.assignmentGeneration === assignmentGeneration
    );
    if (!candidate) throw new Error('Opfield relay candidate grant is unavailable');
    await this.opfieldTunnels().probe(
      candidate.local
        ? { kind: 'local', grant: candidate.grant, relayId: candidate.relayInstanceId }
        : { kind: 'candidate', candidate }
    );
  }

  async ensureBackupRoute(
    runId: string,
    sourceNodeId: string,
    target: { kind: 'database' | 'storage'; id: string; nodeId: string },
    ownerKind: 'database_backup_source' | 'database_backup_restore' | 'storage_backup_target' | 'storage_backup_staging'
  ): Promise<string> {
    const endpointId =
      target.kind === 'database'
        ? await this.ensureManagedDatabaseEndpoint(target.id, target.nodeId)
        : await this.ensureManagedStorageEndpoint(target.id, target.nodeId);
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    await this.ensureRoute(ownerKind, runId, 'daemon', sourceNodeId, source.certificateFingerprint, endpointId);
    await this.syncSnapshot();
    await this.syncNodeGrants(target.nodeId, ROUTINE_GRANT_SYNC);
    await this.syncNodeGrants(sourceNodeId, ROUTINE_GRANT_SYNC);
    // The daemon resolves an assignment by owner kind and this per-run owner ID.
    return runId;
  }

  /**
   * A backup run's route to one member of a database availability set (P3-T06, backups from a copy): the member's
   * `db-backup` peer endpoint, which its node serves from its own engine whatever its role. The run's executor node
   * is the source; the daemon resolves it by owner kind and run id as for any backup route.
   */
  async ensureMemberBackupRoute(
    runId: string,
    sourceNodeId: string,
    target: { memberId: string; nodeId: string; setId: string },
    ownerKind: 'database_backup_source'
  ): Promise<string> {
    const ownerId = peerEndpointOwnerId(target.memberId, BACKUP_SOURCE_PORT.name);
    const find = async () =>
      (
        await this.db
          .select({ id: relayEndpoints.id, status: relayEndpoints.status })
          .from(relayEndpoints)
          .where(and(eq(relayEndpoints.ownerKind, SET_PEER_ENDPOINT_KIND), eq(relayEndpoints.ownerId, ownerId)))
          .limit(1)
      )[0];
    let endpoint = await find();
    if (!endpoint) {
      await this.reconcileSetRelayPaths(target.setId);
      endpoint = await find();
    }
    if (!endpoint || endpoint.status !== 'active') throw new Error('The member has no backup relay endpoint yet');
    await this.ensureLegacyCompatibleAssignment(endpoint.id);
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    await this.ensureRoute(ownerKind, runId, 'daemon', sourceNodeId, source.certificateFingerprint, endpoint.id);
    await this.syncSnapshot();
    await this.syncNodeGrants(target.nodeId, ROUTINE_GRANT_SYNC);
    await this.syncNodeGrants(sourceNodeId, ROUTINE_GRANT_SYNC);
    return runId;
  }

  async revokeBackupRoutes(runId: string): Promise<void> {
    await this.revokeOwners(
      ['database_backup_source', 'database_backup_restore', 'storage_backup_target', 'storage_backup_staging'],
      runId
    );
  }

  /**
   * The route of a storage link from one workload node (relay_routes_storage_link_source_unique). A link has one route
   * per node that runs its workload: its own node, and every placement node while Availability runs the workload. All
   * of them lead to the link's cluster, so pointing the link at another cluster takes every route along. Returns the
   * route of `sourceNodeId`.
   */
  async ensureStorageBindingRoute(
    bindingId: string,
    clusterId: string,
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<string> {
    const endpointId = await this.ensureManagedStorageEndpoint(clusterId, targetNodeId);
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    const { routeId, retargetedSourceIds } = await this.db.transaction(async (tx) => {
      const routes = await tx
        .select()
        .from(relayRoutes)
        .where(and(eq(relayRoutes.ownerKind, 'managed_storage_binding'), eq(relayRoutes.ownerId, bindingId)));
      let changed = false;
      let routeId: string;
      const own = routes.find((route) => route.sourceKind === 'daemon' && route.sourceId === sourceNodeId);
      if (!own) {
        const [created] = await tx
          .insert(relayRoutes)
          .values({
            ownerKind: 'managed_storage_binding',
            ownerId: bindingId,
            sourceKind: 'daemon',
            sourceId: sourceNodeId,
            sourceCertificateSha256: source.certificateFingerprint,
            targetEndpointId: endpointId,
            maxFrameBytes: RELAY_MAX_FRAME_BYTES,
          })
          .returning({ id: relayRoutes.id });
        routeId = created.id;
        changed = true;
      } else {
        routeId = own.id;
        if (own.sourceCertificateSha256 !== source.certificateFingerprint || own.targetEndpointId !== endpointId) {
          await tx
            .update(relayRoutes)
            .set({
              sourceCertificateSha256: source.certificateFingerprint,
              targetEndpointId: endpointId,
              generation: own.generation + 1,
              updatedAt: new Date(),
            })
            .where(eq(relayRoutes.id, own.id));
          changed = true;
        }
      }
      const retargetedSourceIds: string[] = [];
      for (const route of routes) {
        if (route.id === routeId || route.targetEndpointId === endpointId) continue;
        await tx
          .update(relayRoutes)
          .set({ targetEndpointId: endpointId, generation: route.generation + 1, updatedAt: new Date() })
          .where(eq(relayRoutes.id, route.id));
        if (route.sourceKind === 'daemon') retargetedSourceIds.push(route.sourceId);
        changed = true;
      }
      if (changed) await bumpRelayPolicyRevision(tx);
      return { routeId, retargetedSourceIds };
    });
    await this.syncSnapshot();
    await this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC);
    await this.syncNodeGrants(sourceNodeId, ROUTINE_GRANT_SYNC);
    for (const nodeId of new Set(retargetedSourceIds)) await this.syncNodeGrants(nodeId, ROUTINE_GRANT_SYNC);
    return routeId;
  }

  /** Removes the route of a storage link from one workload node, leaving its other routes in place. */
  async revokeStorageBindingRoute(bindingId: string, sourceNodeId: string): Promise<void> {
    const removed = await this.db.transaction(async (tx) => {
      const routes = await tx
        .delete(relayRoutes)
        .where(
          and(
            eq(relayRoutes.ownerKind, 'managed_storage_binding'),
            eq(relayRoutes.ownerId, bindingId),
            eq(relayRoutes.sourceKind, 'daemon'),
            eq(relayRoutes.sourceId, sourceNodeId)
          )
        )
        .returning({ id: relayRoutes.id });
      if (routes.length) await bumpRelayPolicyRevision(tx);
      return routes.length > 0;
    });
    if (!removed) return;
    await this.syncSnapshot();
    const affectedNodes = new Set([...(await this.grantIssuer.policyNodeIds()), sourceNodeId]);
    await Promise.allSettled([...affectedNodes].map((nodeId) => this.syncNodeGrants(nodeId)));
  }

  async ensureStorageOpfieldRoute(
    clusterId: string,
    targetNodeId: string,
    appCertificateFingerprint: string
  ): Promise<string> {
    const endpointId = await this.ensureManagedStorageEndpoint(clusterId, targetNodeId);
    const state = await this.grantIssuer.requireState();
    const routeId = await this.ensureRoute(
      LEGACY_MANAGED_STORAGE_OWNER_KIND,
      clusterId,
      LEGACY_RELAY_SOURCE_KIND,
      state.opfieldInstanceId,
      appCertificateFingerprint,
      endpointId
    );
    await this.syncSnapshot();
    // Opfield reads its route at every open: turned on at the target here, its streams are resumable from the first.
    await this.streamResume.enableBeforeSourceSync({ routeIds: [routeId] }).catch((error) => {
      logger.warn('Resumable streams for a Opfield relay route deferred to the next reconcile', {
        routeId,
        error: errorMessage(error),
      });
    });
    await this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC);
    return routeId;
  }

  /** A tunnel from Opfield to a managed storage cluster; its bytes cross from the tunnel worker (see opfieldTunnelEndpoint). */
  async openStorageOpfieldTunnel(clusterId: string, appCertificateFingerprint: string): Promise<Duplex> {
    const routeId = await this.opfieldStorageRoute(clusterId, appCertificateFingerprint);
    const set = await setOfOwner(this.db, 'managed_storage', clusterId);
    if (set) return this.openSetRouteTunnel(set, routeId, appCertificateFingerprint);
    return this.openOpfieldRouteTunnel(routeId, appCertificateFingerprint);
  }

  /** The storage cluster's Opfield route, made on first use; throws while the cluster is not up. */
  private async opfieldStorageRoute(clusterId: string, appCertificateFingerprint: string): Promise<string> {
    const [database] = await this.db
      .select({ nodeId: managedStorageClusters.nodeId, status: managedStorageClusters.status })
      .from(managedStorageClusters)
      .where(eq(managedStorageClusters.id, clusterId))
      .limit(1);
    if (!database || (database.status !== 'ready' && database.status !== 'updating')) {
      throw new Error('Managed storage is unavailable');
    }
    const routeId =
      (await this.currentOpfieldRoute(
        LEGACY_MANAGED_STORAGE_OWNER_KIND,
        'managed_storage',
        clusterId,
        database.nodeId,
        appCertificateFingerprint
      )) ?? (await this.ensureStorageOpfieldRoute(clusterId, database.nodeId, appCertificateFingerprint));
    return routeId;
  }

  async revokeOwner(
    ownerKind: RelayOwnerKind,
    ownerId: string,
    options: { allowDeferredSnapshot?: boolean } = {}
  ): Promise<void> {
    await this.revokeOwners([ownerKind], ownerId, options);
  }

  /**
   * Deletes the relay state an owner id holds under any of these kinds and withdraws it. Only daemons whose grants
   * lose something get a new bundle: the subjects of the owned endpoints, the sources of every deleted route (owned
   * or cascaded with an owned endpoint) and the subjects of the endpoints the deleted routes led to, whose bundles
   * carry their inbound routes. Any other change a deletion causes reaches the rest with the routine refresh.
   */
  private async revokeOwners(
    ownerKinds: RelayOwnerKind[],
    ownerId: string,
    options: { allowDeferredSnapshot?: boolean } = {}
  ): Promise<void> {
    const endpointKinds = ownerKinds.filter((kind) => ENDPOINT_OWNER_KINDS.has(kind));
    const affectedNodes = await this.db.transaction(async (tx) => {
      const [ownedRoutes, ownedEndpoints] = await Promise.all([
        tx
          .select({
            sourceKind: relayRoutes.sourceKind,
            sourceId: relayRoutes.sourceId,
            subjectKind: relayEndpoints.subjectKind,
            subjectId: relayEndpoints.subjectId,
          })
          .from(relayRoutes)
          .innerJoin(relayEndpoints, eq(relayRoutes.targetEndpointId, relayEndpoints.id))
          .where(and(inArray(relayRoutes.ownerKind, ownerKinds), eq(relayRoutes.ownerId, ownerId))),
        endpointKinds.length
          ? tx
              .select({
                subjectKind: relayEndpoints.subjectKind,
                subjectId: relayEndpoints.subjectId,
                sourceKind: relayRoutes.sourceKind,
                sourceId: relayRoutes.sourceId,
              })
              .from(relayEndpoints)
              .leftJoin(relayRoutes, eq(relayRoutes.targetEndpointId, relayEndpoints.id))
              .where(and(inArray(relayEndpoints.ownerKind, endpointKinds), eq(relayEndpoints.ownerId, ownerId)))
          : Promise.resolve([]),
      ]);
      const routes = await tx
        .delete(relayRoutes)
        .where(and(inArray(relayRoutes.ownerKind, ownerKinds), eq(relayRoutes.ownerId, ownerId)))
        .returning({ id: relayRoutes.id });
      const endpoints = endpointKinds.length
        ? await tx
            .delete(relayEndpoints)
            .where(and(inArray(relayEndpoints.ownerKind, endpointKinds), eq(relayEndpoints.ownerId, ownerId)))
            .returning({ id: relayEndpoints.id })
        : [];
      if (!routes.length && !endpoints.length) return [];
      await bumpRelayPolicyRevision(tx);
      return [
        ...new Set(
          [...ownedRoutes, ...ownedEndpoints].flatMap((row) => [
            ...(row.subjectKind === 'daemon' ? [row.subjectId] : []),
            ...(row.sourceKind === 'daemon' && row.sourceId ? [row.sourceId] : []),
          ])
        ),
      ];
    });
    // Also when nothing was deleted: a retry after a failed snapshot still publishes the earlier deletion.
    try {
      await this.syncSnapshot();
    } catch (error) {
      if (!options.allowDeferredSnapshot) throw error;
      logger.warn('Relay owner revocation persisted; runtime snapshot update deferred', {
        ownerKind: ownerKinds.join(','),
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await Promise.allSettled(affectedNodes.map((nodeId) => this.syncNodeGrants(nodeId)));
  }

  async refreshNodeIdentity(nodeId: string, certificateSha256: string): Promise<void> {
    const changed = await this.db.transaction(async (tx) => {
      const endpoints = await tx.select().from(relayEndpoints).where(eq(relayEndpoints.subjectId, nodeId));
      const routes = await tx.select().from(relayRoutes).where(eq(relayRoutes.sourceId, nodeId));
      for (const endpoint of endpoints)
        await tx
          .update(relayEndpoints)
          .set({ certificateSha256, generation: sql`${relayEndpoints.generation} + 1`, updatedAt: new Date() })
          .where(eq(relayEndpoints.id, endpoint.id));
      for (const route of routes)
        await tx
          .update(relayRoutes)
          .set({
            sourceCertificateSha256: certificateSha256,
            generation: sql`${relayRoutes.generation} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(relayRoutes.id, route.id));
      if (endpoints.length || routes.length) await bumpRelayPolicyRevision(tx);
      return endpoints.length > 0 || routes.length > 0;
    });
    if (!changed) return;
    await this.syncSnapshot();
    await this.syncNodeGrants(nodeId);
  }

  async revokeNode(nodeId: string): Promise<void> {
    const endpointRows = await this.db
      .select({ id: relayEndpoints.id })
      .from(relayEndpoints)
      .where(eq(relayEndpoints.subjectId, nodeId));
    const endpointIds = endpointRows.map(({ id }) => id);
    const affectedRoutes = endpointIds.length
      ? await this.db
          .select({ nodeId: relayRoutes.sourceId, sourceKind: relayRoutes.sourceKind })
          .from(relayRoutes)
          .where(inArray(relayRoutes.targetEndpointId, endpointIds))
      : [];
    await this.db.transaction(async (tx) => {
      const routes = await tx
        .delete(relayRoutes)
        .where(eq(relayRoutes.sourceId, nodeId))
        .returning({ id: relayRoutes.id });
      const endpoints = await tx
        .delete(relayEndpoints)
        .where(eq(relayEndpoints.subjectId, nodeId))
        .returning({ id: relayEndpoints.id });
      if (routes.length || endpoints.length) await bumpRelayPolicyRevision(tx);
    });
    this.lastNodeGrantBundles.delete(nodeId);
    this.deliveredGrantBundles.delete(nodeId);
    const epoch = this.nodeGrantEpochs.get(nodeId);
    if (epoch) epoch.valid = false;
    this.nodeGrantEpochs.delete(nodeId);
    await this.syncSnapshot();
    await Promise.allSettled(
      affectedRoutes
        .filter(({ sourceKind }) => sourceKind === 'daemon')
        .map(({ nodeId: affectedNodeId }) => this.syncNodeGrants(affectedNodeId))
    );
  }

  /**
   * Delivers the node's grant bundle; resolves with the daemon's ACK, sent once the bundle is applied. A daemon applies
   * grant syncs off its command loop, so a command sent before this ACK may run before the grants: a caller whose next
   * command depends on them (a probe, registry bindings, an egress wait) awaits this first.
   */
  async syncNodeGrantBundle(nodeId: string, options: RelayGrantSyncOptions = {}) {
    if (!this.dispatch) throw new Error('Relay node dispatch is not configured');
    const epoch = this.nodeGrantEpochs.get(nodeId) ?? { valid: true, pending: 0 };
    epoch.pending += 1;
    this.nodeGrantEpochs.set(nodeId, epoch);
    const previous = this.nodeGrantSyncs.get(nodeId) ?? Promise.resolve(undefined);
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        if (!epoch.valid) {
          return {
            commandId: '',
            success: false,
            error: 'Relay grant sync was revoked',
            detail: '',
            data: Buffer.alloc(0),
          };
        }
        // A bundle the daemon holds already depends on no new policy: skip it before waiting for remote pushes,
        // which with a busy pool cost every routine sync the whole grace (stand rc20pre3, N-14). Compared unsigned:
        // the fingerprint ignores signatures, so an unchanged bundle costs no signing.
        if (options.skipUnchanged) {
          const unchanged = await this.getNodeGrantBundle(nodeId, { unsigned: true });
          if (await this.deliveredRecently(nodeId, relayGrantBundleFingerprint(unchanged))) {
            return { commandId: '', success: true, error: '', detail: 'unchanged', data: Buffer.alloc(0) };
          }
        }
        // Give the remote relays a moment to take the policy these grants depend on.
        await this.waitForRemotePush();
        const bundle = await this.getNodeGrantBundle(nodeId);
        const fingerprint = relayGrantBundleFingerprint(bundle);
        if (options.skipUnchanged && (await this.deliveredRecently(nodeId, fingerprint))) {
          return { commandId: '', success: true, error: '', detail: 'unchanged', data: Buffer.alloc(0) };
        }
        if (!epoch.valid) {
          return {
            commandId: '',
            success: false,
            error: 'Relay grant sync was revoked',
            detail: '',
            data: Buffer.alloc(0),
          };
        }
        const result = await this.dispatch!.sendRelayGrantBundle(nodeId, bundle);
        // Queue ownership is not write validity: A's acknowledged bundle stays
        // authoritative even when B is queued and subsequently fails.
        if (result.success && epoch.valid) {
          this.lastNodeGrantBundles.set(nodeId, bundle);
          this.deliveredGrantBundles.set(nodeId, { fingerprint, at: Date.now() });
        }
        return result;
      });
    this.nodeGrantSyncs.set(nodeId, current);
    try {
      return await current;
    } finally {
      if (this.nodeGrantSyncs.get(nodeId) === current) this.nodeGrantSyncs.delete(nodeId);
      epoch.pending -= 1;
      if (epoch.pending === 0 && this.nodeGrantEpochs.get(nodeId) === epoch) this.nodeGrantEpochs.delete(nodeId);
    }
  }

  async syncNodeGrants(nodeId: string, options: RelayGrantSyncOptions = {}): Promise<void> {
    if (!this.dispatch) return;
    if (!options.skipResumeEnable) await this.enableResumableRoutesOf(nodeId);
    let result = await this.syncNodeGrantBundle(nodeId, options);
    if (!result.success && (await this.raiseRevisionAboveDaemon(nodeId, result.error))) {
      result = await this.syncNodeGrantBundle(nodeId, options);
    }
    if (result.success) this.staleGrantRefusals.delete(nodeId);
    if (!result.success) throw new Error(result.error || `Daemon ${nodeId} rejected relay grants`);
  }

  /**
   * A route both of whose ends support resumable streams reaches its source already resumable: its targets get the key
   * first, then the source's own delivery carries it. Runs before the source's queue, so two daemons that are each
   * other's targets never wait on each other.
   */
  private async enableResumableRoutesOf(nodeId: string): Promise<void> {
    await this.streamResume.enableBeforeSourceSync({ sourceNodeId: nodeId }).catch((error) => {
      logger.warn('Resumable streams for new relay routes deferred to the next reconcile', {
        nodeId,
        error: errorMessage(error),
      });
    });
  }

  /**
   * Whether the daemon got a bundle allowing exactly the same within the grant refresh interval.
   * Its grants are then still fresh, and a resend only makes it re-apply and re-renew everything.
   */
  private async deliveredRecently(nodeId: string, fingerprint: string): Promise<boolean> {
    const delivered = this.deliveredGrantBundles.get(nodeId);
    if (delivered?.fingerprint !== fingerprint) return false;
    const intervalMs = ((await this.settings.getConfig()).relayGrantTtlHours * 60 * 60 * 1000) / 4;
    return Date.now() - delivered.at < intervalMs;
  }

  /**
   * A daemon refuses a grant bundle older than the one it holds. That happens after Opfield's
   * database was restored from a backup: its revision sequence went back while daemons kept
   * newer bundles, and no grant could reach them until the sequence caught up. Continue the
   * sequence above the daemon's, then resend. Rate-limited, since every change bumps it anyway.
   */
  private async raiseRevisionAboveDaemon(nodeId: string, error: string | undefined): Promise<boolean> {
    const message = error ?? '';
    const olderRevision = message.match(/relay grant revision \d+ is older than (\d+)/);
    // This daemon names no revision. One such refusal is ordinary out-of-order delivery; only a
    // daemon that keeps refusing every bundle holds a sequence Opfield lost to a restore.
    const staleWithoutRevision = /stale relay grant bundle/.test(message);
    if (!olderRevision && !staleWithoutRevision) {
      this.staleGrantRefusals.delete(nodeId);
      return false;
    }
    const current = Number((await this.grantIssuer.requireState()).revision);
    let floor: number;
    if (olderRevision) {
      const held = Number(olderRevision[1]);
      // At or below Opfield's own revision this is an older bundle delivered late, not a restore.
      if (!Number.isSafeInteger(held) || held <= current) return false;
      floor = Math.min(held, current + MAX_REVISION_JUMP);
    } else {
      const refusals = (this.staleGrantRefusals.get(nodeId) ?? 0) + 1;
      this.staleGrantRefusals.set(nodeId, refusals);
      if (refusals < STALE_REFUSALS_BEFORE_RAISE) return false;
      floor = current + MAX_REVISION_JUMP;
    }
    const now = Date.now();
    if (now - this.lastRevisionRaiseAt < REVISION_RAISE_INTERVAL_MS) return false;
    if (!Number.isSafeInteger(floor) || floor > MAX_REVISION_FLOOR) return false;
    this.lastRevisionRaiseAt = now;
    this.staleGrantRefusals.delete(nodeId);
    await this.db
      .update(relayPolicyState)
      .set({ revision: sql`greatest(${relayPolicyState.revision} + 1, ${floor + 1})`, updatedAt: new Date() })
      .where(eq(relayPolicyState.id, 'current'));
    logger.warn('A daemon holds newer relay grants than Opfield; continued the policy revision above them', {
      nodeId,
      floor,
      refusal: message,
    });
    await this.syncSnapshot();
    return true;
  }

  /**
   * Refreshes every daemon's grants once per revision and interval. The routine refresh skips a daemon that already
   * holds the same grants (deliveredRecently); a forced one (new signing key, relay certificate or runtime settings)
   * resends every bundle. A daemon that is not connected gets its bundle when it reconnects; one whose delivery failed
   * is retried alone by the next pass, so one unreachable daemon no longer makes every pass resend to all of them.
   */
  async refreshAllNodeGrantsIfDue(force = false): Promise<void> {
    const revision = Number((await this.grantIssuer.requireState()).revision);
    const ttlHours = (await this.settings.getConfig()).relayGrantTtlHours;
    const intervalMs = (ttlHours * 60 * 60 * 1000) / 4;
    const due =
      force || revision !== this.lastGrantRefreshRevision || Date.now() - this.lastGrantRefreshAt >= intervalMs;
    if (!due && this.failedGrantRefreshNodeIds.size === 0) return;
    const nodeIds = due ? await this.grantIssuer.policyNodeIds() : [...this.failedGrantRefreshNodeIds];
    const connected = nodeIds.filter((nodeId) => this.dispatch?.isNodeConnected(nodeId));
    const options = force ? {} : ROUTINE_GRANT_SYNC;
    const results = await Promise.allSettled(connected.map((nodeId) => this.syncNodeGrants(nodeId, options)));
    this.failedGrantRefreshNodeIds = new Set(connected.filter((_, index) => results[index]!.status === 'rejected'));
    if (due) {
      this.lastGrantRefreshAt = Date.now();
      this.lastGrantRefreshRevision = revision;
    }
    if (this.failedGrantRefreshNodeIds.size) {
      throw new Error(`Failed to refresh relay grants for ${this.failedGrantRefreshNodeIds.size} daemon(s)`);
    }
  }

  /** `unsigned`: only to compare with a delivered bundle (see RelayGrantIssuerService.getNodeGrantBundle). */
  async getNodeGrantBundle(nodeId: string, options: { unsigned?: boolean } = {}): Promise<RelayGrantBundle> {
    const [bundle, config] = await Promise.all([
      this.withAcknowledgedPolicy(() => this.grantIssuer.getNodeGrantBundle(nodeId, options)),
      this.settings.getConfig(),
    ]);
    return { ...bundle, dataLanes: config.relay.dataLanes, readChunkBytes: config.relay.readChunkBytes };
  }

  async issueOpfieldConnectGrant(routeId: string, appCertificateFingerprint: string) {
    return this.withAcknowledgedPolicy(() =>
      this.grantIssuer.issueOpfieldConnectGrant(routeId, appCertificateFingerprint)
    );
  }

  private async withAcknowledgedPolicy<T>(issue: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await issue();
      } catch (error) {
        if (!(error instanceof RelayPolicyNotAcknowledgedError) || attempt >= 2) throw error;
        try {
          await this.syncSnapshot();
        } catch (syncError) {
          if (!isRelayUnavailable(syncError)) throw syncError;
          // The local relay is down and sees no grants at all, while holding every grant back
          // would also stop the remote relays once their grants expire. Deliver the policy to
          // the remote relays first, then sign for it.
          logger.warn('Local relay is unavailable; issuing relay grants without its acknowledgement', {
            revision: error.revision,
            error: errorMessage(syncError),
          });
          this.startRemotePush(error.revision);
          await this.waitForRemotePush();
          this.grantIssuer.allowUnacknowledgedRevision(error.revision);
          return issue();
        }
      }
    }
  }

  /** Endpoints whose path includes a daemon without Relay Pool support. */
  poolIncapableEndpointIds(endpointIds: string[]): Promise<Set<string>> {
    return this.grantIssuer.poolIncapableEndpointIds(endpointIds);
  }

  /**
   * The Opfield route a tunnel can open through as it is: it names this Opfield and its
   * certificate, and targets the owner's active endpoint on the owner's node with that node's
   * current certificate and a live assignment. Opening a tunnel then only issues a grant,
   * instead of re-ensuring the endpoint and route, pushing policy twice and re-sending the
   * target daemon's whole grant bundle every time.
   */
  private async currentOpfieldRoute(
    ownerKind: typeof LEGACY_MANAGED_DATABASE_OWNER_KIND | typeof LEGACY_MANAGED_STORAGE_OWNER_KIND,
    endpointOwnerKind: 'managed_database' | 'managed_storage',
    ownerId: string,
    nodeId: string,
    appCertificateFingerprint: string
  ): Promise<string | null> {
    const [route] = await this.db
      .select({
        id: relayRoutes.id,
        sourceKind: relayRoutes.sourceKind,
        sourceId: relayRoutes.sourceId,
        sourceCertificateSha256: relayRoutes.sourceCertificateSha256,
        targetEndpointId: relayRoutes.targetEndpointId,
      })
      .from(relayRoutes)
      .where(and(eq(relayRoutes.ownerKind, ownerKind), eq(relayRoutes.ownerId, ownerId)))
      .limit(1);
    if (!route || route.sourceKind !== LEGACY_RELAY_SOURCE_KIND || route.sourceCertificateSha256 !== appCertificateFingerprint) {
      return null;
    }
    const [endpoint] = await this.db
      .select({
        id: relayEndpoints.id,
        ownerKind: relayEndpoints.ownerKind,
        ownerId: relayEndpoints.ownerId,
        subjectId: relayEndpoints.subjectId,
        certificateSha256: relayEndpoints.certificateSha256,
        status: relayEndpoints.status,
      })
      .from(relayEndpoints)
      .where(eq(relayEndpoints.id, route.targetEndpointId))
      .limit(1);
    if (
      !endpoint ||
      endpoint.status !== 'active' ||
      endpoint.ownerKind !== endpointOwnerKind ||
      endpoint.ownerId !== ownerId ||
      endpoint.subjectId !== nodeId
    ) {
      return null;
    }
    const [state, node, [assigned]] = await Promise.all([
      this.grantIssuer.requireState(),
      this.grantIssuer.requireNodeIdentity(nodeId).catch(() => null),
      this.db
        .select({ id: relayEndpointAssignmentGenerations.id })
        .from(relayEndpointAssignmentGenerations)
        .where(
          and(
            eq(relayEndpointAssignmentGenerations.endpointId, endpoint.id),
            eq(relayEndpointAssignmentGenerations.state, 'active')
          )
        )
        .limit(1),
    ]);
    if (route.sourceId !== state.opfieldInstanceId || node?.certificateFingerprint !== endpoint.certificateSha256) {
      return null;
    }
    return assigned ? route.id : null;
  }

  private async ensureRoute(
    ownerKind: string,
    ownerId: string,
    sourceKind: string,
    sourceId: string,
    sourceCertificateSha256: string,
    targetEndpointId: string,
    managedDatabaseListener?: RelayManagedDatabaseListenerConfig,
    /** undefined keeps the route's connector egress. */
    secureLinkEgress?: RelaySecureLinkEgressConfig | null
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(relayRoutes)
        .where(and(eq(relayRoutes.ownerKind, ownerKind), eq(relayRoutes.ownerId, ownerId)))
        .limit(1);
      if (!current) {
        const [created] = await tx
          .insert(relayRoutes)
          .values({
            ownerKind,
            ownerId,
            sourceKind,
            sourceId,
            sourceCertificateSha256,
            targetEndpointId,
            maxFrameBytes: RELAY_MAX_FRAME_BYTES,
            managedDatabaseListener,
            secureLinkEgress: secureLinkEgress ?? null,
          })
          .returning({ id: relayRoutes.id });
        await reconcileSetPathsOfEndpoint(tx, targetEndpointId);
        await bumpRelayPolicyRevision(tx);
        return created.id;
      }
      const desiredEgress = secureLinkEgress === undefined ? (current.secureLinkEgress ?? null) : secureLinkEgress;
      const moved =
        current.sourceId !== sourceId ||
        current.sourceCertificateSha256 !== sourceCertificateSha256 ||
        current.targetEndpointId !== targetEndpointId ||
        routeTransportRestartRequired(
          {
            managedDatabaseListener: current.managedDatabaseListener ?? null,
            secureLinkEgress: current.secureLinkEgress ?? null,
          },
          { managedDatabaseListener: managedDatabaseListener ?? null, secureLinkEgress: desiredEgress }
        );
      if (
        moved ||
        !managedDatabaseListenerConfigsEqual(current.managedDatabaseListener, managedDatabaseListener) ||
        !secureLinkEgressEqual(current.secureLinkEgress, desiredEgress)
      ) {
        await tx
          .update(relayRoutes)
          .set({
            sourceKind,
            sourceId,
            sourceCertificateSha256,
            targetEndpointId,
            managedDatabaseListener: managedDatabaseListener ?? null,
            secureLinkEgress: desiredEgress,
            // Only the admitted workloads changed: the route keeps its tunnels (see managedDatabaseListenerRestartRequired).
            generation: moved ? current.generation + 1 : current.generation,
            updatedAt: new Date(),
          })
          .where(eq(relayRoutes.id, current.id));
        await reconcileSetPathsOfEndpoint(tx, targetEndpointId);
        await bumpRelayPolicyRevision(tx);
      } else if (await reconcileSetPathsOfEndpoint(tx, targetEndpointId)) {
        await bumpRelayPolicyRevision(tx);
      }
      return current.id;
    });
  }

  private async reconcileInternalRegistryEndpoint(): Promise<string> {
    const endpoint = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('${LEGACY_INTERNAL_REGISTRY_ID}-relay-endpoint'))`);
      const [current] = await tx
        .select()
        .from(relayEndpoints)
        .where(and(eq(relayEndpoints.ownerKind, 'internal_registry'), eq(relayEndpoints.ownerId, INTERNAL_REGISTRY_ID)))
        .limit(1);
      if (!current) {
        const [created] = await tx
          .insert(relayEndpoints)
          .values({
            ownerKind: 'internal_registry',
            ownerId: INTERNAL_REGISTRY_ID,
            subjectKind: 'local_service',
            subjectId: INTERNAL_REGISTRY_ID,
            certificateSha256: INTERNAL_REGISTRY_CERTIFICATE_ID,
            maxConcurrentSessions: 128,
          })
          .returning({ id: relayEndpoints.id });
        await bumpRelayPolicyRevision(tx);
        return created.id;
      }
      if (
        current.subjectKind !== 'local_service' ||
        current.subjectId !== INTERNAL_REGISTRY_ID ||
        current.certificateSha256 !== INTERNAL_REGISTRY_CERTIFICATE_ID
      ) {
        throw new Error('Internal registry Relay endpoint ownership or target identity was modified');
      }
      if (current.status !== 'active') {
        await tx
          .update(relayEndpoints)
          .set({ status: 'active', generation: current.generation + 1, updatedAt: new Date() })
          .where(eq(relayEndpoints.id, current.id));
        await bumpRelayPolicyRevision(tx);
      }
      return current.id;
    });
    await this.ensureLegacyCompatibleAssignment(endpoint);
    return endpoint;
  }

  private async buildSnapshot(): Promise<RelayPolicySnapshot> {
    const relaySettings = (await this.settings.getConfig()).relay;
    return this.db.transaction(
      async (tx) => {
        const [[state], keys, endpoints, routes] = await Promise.all([
          tx.select().from(relayPolicyState).where(eq(relayPolicyState.id, 'current')).limit(1),
          tx
            .select()
            .from(relayGrantSigningKeys)
            .where(inArray(relayGrantSigningKeys.status, ['pending', 'active', 'verification_only'])),
          tx.select().from(relayEndpoints),
          tx.select().from(relayRoutes),
        ]);
        if (!state) throw new Error('Relay policy state is not initialized');
        const sessionLimits = await loadRelaySessionLimits(tx, endpoints);
        keys.sort((left, right) => left.keyId.localeCompare(right.keyId));
        endpoints.sort((left, right) => left.id.localeCompare(right.id));
        routes.sort((left, right) => left.id.localeCompare(right.id));
        const activeEndpoints = endpoints.filter(({ status }) => status === 'active');
        const activeEndpointIds = new Set(activeEndpoints.map(({ id }) => id));
        return {
          revision: String(state.revision),
          opfieldInstanceId: state.opfieldInstanceId,
          admissionPolicy: {
            enabled: relaySettings.adaptiveAdmissionEnabled,
            proxyTargetPressurePercent: relaySettings.proxyTargetPressurePercent,
            databaseReservePercent: relaySettings.databaseReservePercent,
            hardPressurePercent: relaySettings.hardPressurePercent,
          },
          publicKeys: keys.map((key) => ({ keyId: key.keyId, publicKey: Buffer.from(key.publicKey, 'base64') })),
          endpoints: activeEndpoints.map((endpoint) => ({
            endpointId: endpoint.id,
            generation: String(endpoint.generation),
            subjectKind: endpoint.subjectKind,
            subjectId: endpoint.subjectId,
            certificateSha256: endpoint.certificateSha256,
            maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(endpoint, sessionLimits),
          })),
          routes: routes
            .filter(({ targetEndpointId }) => activeEndpointIds.has(targetEndpointId))
            .map((route) => ({
              routeId: route.id,
              generation: String(route.generation),
              sourceKind: route.sourceKind,
              sourceId: route.sourceId,
              sourceCertificateSha256: route.sourceCertificateSha256,
              targetEndpointId: route.targetEndpointId,
              maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(route, sessionLimits),
              maxFrameBytes: route.maxFrameBytes,
              ...relayRoutePolicy(route.ownerKind),
            })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' }
    );
  }

  /**
   * Gives an endpoint without an active assignment its first one. That is the local relay alone, the shape legacy
   * grants need, unless the pool planner places it right away: an Availability member whose path runs Relay Pool
   * daemons goes on every ready lease relay from its first generation (D7), so a takeover in its first minute already
   * reaches the successor through every relay. Other endpoints move off the local relay by a staged, probed
   * rebalance.
   */
  private async ensureLegacyCompatibleAssignment(endpointId: string): Promise<void> {
    const [known] = await this.db
      .select({ id: relayEndpointAssignmentGenerations.id })
      .from(relayEndpointAssignmentGenerations)
      .where(
        and(
          eq(relayEndpointAssignmentGenerations.endpointId, endpointId),
          eq(relayEndpointAssignmentGenerations.state, 'active')
        )
      )
      .limit(1);
    if (known) return;
    const planned = this.initialAssignmentPlanner
      ? await this.initialAssignmentPlanner(endpointId).catch((error) => {
          logger.warn('Relay placement of a new endpoint is unavailable; it starts on the local relay', {
            endpointId,
            error: errorMessage(error),
          });
          return null;
        })
      : null;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`relay-endpoint-assignment:${endpointId}`}))`);
      const [existing] = await tx
        .select({ id: relayEndpointAssignmentGenerations.id })
        .from(relayEndpointAssignmentGenerations)
        .where(
          and(
            eq(relayEndpointAssignmentGenerations.endpointId, endpointId),
            eq(relayEndpointAssignmentGenerations.state, 'active')
          )
        )
        .limit(1);
      if (existing) return;
      if (planned?.length) {
        const [latest] = await tx
          .select({ generation: relayEndpointAssignmentGenerations.generation })
          .from(relayEndpointAssignmentGenerations)
          .where(eq(relayEndpointAssignmentGenerations.endpointId, endpointId))
          .orderBy(desc(relayEndpointAssignmentGenerations.generation))
          .limit(1);
        const generation = (latest?.generation ?? 0) + 1;
        const [placed] = await tx
          .insert(relayEndpointAssignmentGenerations)
          .values({
            endpointId,
            generation,
            state: 'active',
            desiredRedundancy: planned.length,
            activatedAt: new Date(),
          })
          .returning({ id: relayEndpointAssignmentGenerations.id });
        await tx.insert(relayEndpointAssignments).values(
          planned.map(({ relayInstanceId, role }) => ({
            assignmentGenerationId: placed.id,
            relayInstanceId,
            role,
            targetRegistrationState: 'ready' as const,
            targetRegisteredAt: new Date(),
          }))
        );
        await tx
          .update(relayEndpoints)
          .set({ activeAssignmentGeneration: generation, updatedAt: new Date() })
          .where(eq(relayEndpoints.id, endpointId));
        await bumpRelayPolicyRevision(tx);
        return;
      }
      const [local] = await tx
        .select({ id: relayInstances.id })
        .from(relayInstances)
        .where(and(eq(relayInstances.poolId, 'system'), eq(relayInstances.kind, 'local')))
        .limit(1);
      if (!local) throw new Error('Local relay instance is unavailable');
      const [generation] = await tx
        .insert(relayEndpointAssignmentGenerations)
        .values({ endpointId, generation: 1, state: 'active', desiredRedundancy: 1, activatedAt: new Date() })
        .returning({ id: relayEndpointAssignmentGenerations.id });
      await tx.insert(relayEndpointAssignments).values({
        assignmentGenerationId: generation.id,
        relayInstanceId: local.id,
        role: 'active',
        targetRegistrationState: 'ready',
        targetRegisteredAt: new Date(),
      });
    });
  }

  private async buildInstanceSnapshot(
    instanceId: string,
    reportedPolicyKeyIds?: string[],
    appliedRevisionFloor = 0,
    /**
     * force: build and send even an unchanged snapshot. liveAppliedRevision: the revision the relay reported just
     * now; an unchanged snapshot is skipped only when the relay holds exactly it.
     */
    delivery: { force?: boolean; liveAppliedRevision?: number } = {}
  ): Promise<{
    /** Null when the relay already holds this content at `revision`: nothing to send. */
    encodedRequest: Buffer | null;
    revision: number;
    globalRevision: number;
    expiresAtUnix: number;
  }> {
    const generalSettings = await this.settings.getConfig();
    const relaySettings = generalSettings.relay;
    const issuedAt = new Date();
    const issuedAtUnix = Math.floor(issuedAt.getTime() / 1000);
    const projection = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${RELAY_POLICY_REVISION_LOCK}))`);
      // Writers bump this row in the same transaction as projection changes.
      // Holding SHARE until the projection is built prevents mixed revisions
      // under READ COMMITTED, while allowing writers to proceed during RPC I/O.
      const [state] = await tx
        .select()
        .from(relayPolicyState)
        .where(eq(relayPolicyState.id, 'current'))
        .limit(1)
        .for('share');
      const [[instance], grantKeys] = await Promise.all([
        tx.select().from(relayInstances).where(eq(relayInstances.id, instanceId)).limit(1),
        tx
          .select()
          .from(relayGrantSigningKeys)
          .where(inArray(relayGrantSigningKeys.status, ['pending', 'active', 'verification_only'])),
      ]);
      if (!instance || !state) throw new Error('Relay instance or policy state is unavailable');

      // The assignment query above cannot reference the separately selected
      // instance alias portably across Drizzle drivers, so constrain it here
      // through an explicit second query with the concrete instance id.
      const selectedAssignments = await tx
        .select({
          endpointId: relayEndpointAssignmentGenerations.endpointId,
          assignmentGeneration: relayEndpointAssignmentGenerations.generation,
          generationState: relayEndpointAssignmentGenerations.state,
        })
        .from(relayEndpointAssignments)
        .innerJoin(
          relayEndpointAssignmentGenerations,
          eq(relayEndpointAssignments.assignmentGenerationId, relayEndpointAssignmentGenerations.id)
        )
        .where(
          and(
            eq(relayEndpointAssignments.relayInstanceId, instance.id),
            inArray(relayEndpointAssignmentGenerations.state, ['active', 'staging', 'draining'])
          )
        );
      const endpointIds = [...new Set(selectedAssignments.map(({ endpointId }) => endpointId))];
      const endpoints = endpointIds.length
        ? await tx.select().from(relayEndpoints).where(inArray(relayEndpoints.id, endpointIds))
        : [];
      const routes = endpointIds.length
        ? await tx.select().from(relayRoutes).where(inArray(relayRoutes.targetEndpointId, endpointIds))
        : [];
      const sessionLimits = await loadRelaySessionLimits(tx, endpoints);
      // A relay refuses any revision below the one it applied, and Opfield's own sequence can
      // fall behind it (a database restored from a backup). Continue above what the relay
      // reports, or has reported, so it is never locked out until the sequence catches up.
      // The floor comes from a relay's report; one report moves the sequence by a bounded jump.
      const reported = Math.min(
        MAX_REVISION_FLOOR,
        Math.max(
          Number.isSafeInteger(instance.appliedPolicyRevision) ? instance.appliedPolicyRevision : 0,
          Number.isSafeInteger(appliedRevisionFloor) ? appliedRevisionFloor : 0
        )
      );

      // An instance that has not reported policy_long_lease_v1 may still be running a relay build
      // that rejects any envelope lease over 15 minutes; keep it on the legacy lease until it upgrades.
      const instanceFeatures = Array.isArray(instance.capabilities?.features) ? instance.capabilities.features : [];
      const leaseSeconds = instanceFeatures.includes(LONG_POLICY_LEASE_CAPABILITY)
        ? generalSettings.relayPolicyLeaseHours * 60 * 60
        : LEGACY_RELAY_POLICY_LEASE_SECONDS;
      const expiresAtUnix = Math.floor((issuedAt.getTime() + leaseSeconds * 1000) / 1000);

      // Everything that decides the envelope content is read before its content key, so an
      // unchanged key means an unchanged envelope. These reads use their own connections and take
      // no locks. The relay's own trust decides the signer: a relay that missed a rotation gets its
      // snapshot signed by an old key it still trusts, and learns the active key from that snapshot.
      const policyKeys = await this.policyKeys.resolveInstancePolicyKeys(instance, issuedAt, reportedPolicyKeyIds);
      const lease = this.availabilityLeaseSource
        ? await this.availabilityLeaseSource().catch((error) => {
            // Relays keep the lease blocks they have; the next snapshot carries them again.
            logger.warn('Relay snapshot is built without availability lease blocks', { error: errorMessage(error) });
            return null;
          })
        : null;
      // Never fail open: without the lease gate ids the relay would admit a lease-mode placement like a legacy one.
      const leaseGate = this.availabilityLeaseGate ? await this.availabilityLeaseGate(endpoints, routes) : null;
      const content = relayPolicySnapshotContent({
        opfieldInstanceId: state.opfieldInstanceId,
        poolId: instance.poolId,
        relayInstanceId: instance.id,
        grantKeys,
        assignments: selectedAssignments,
        endpoints,
        routes,
        admission: relaySettings,
        policyKeys: policyKeys.keys,
        routePolicy: relayRoutePolicy,
        sessionLimits,
        // The same rule as the candidate grants for this instance (RelayGrantIssuerService.issueCandidates).
        limitTarget: relaySessionLimitTarget(instanceFeatures),
        leaseGate,
        lease,
      });
      const key = relayPolicySnapshotKey(content, policyKeys.signingKeyId, leaseSeconds);
      const previous = await loadInstancePolicyState(tx, instance.id);
      // Syncs run on every policy touch; unchanged content must not spend a revision, or the relay
      // re-applies the same policy every few seconds. A lease past half its life is renewed.
      const held = delivery.liveAppliedRevision ?? reported;
      if (!delivery.force && holdsCurrentSnapshot(previous, key, held, issuedAtUnix, leaseSeconds)) {
        return {
          unchanged: true as const,
          state,
          revision: previous!.snapshotRevision!,
          expiresAtUnix: previous!.snapshotExpiresAtUnix!,
        };
      }
      const own = sql`greatest(${relayPools.desiredPolicyRevision}, ${state.revision})`;
      const [poolRevision] = await tx
        .update(relayPools)
        // Legacy snapshots use the global revision as their transport sequence.
        // Keep pool snapshots strictly newer when upgrading from that format.
        .set({
          desiredPolicyRevision: sql`greatest(${own}, least(${reported}, ${own} + ${MAX_REVISION_JUMP})) + 1`,
          updatedAt: issuedAt,
        })
        .where(eq(relayPools.id, instance.poolId))
        .returning({ revision: relayPools.desiredPolicyRevision });
      if (!poolRevision) throw new Error('Relay pool is unavailable');
      // Under the revision lock, so a revocation is always judged against the snapshots built.
      const endpointGenerations = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint.generation]));
      const routesByEndpoint = new Map<string, typeof routes>();
      for (const route of routes) {
        const group = routesByEndpoint.get(route.targetEndpointId) ?? [];
        group.push(route);
        routesByEndpoint.set(route.targetEndpointId, group);
      }
      await recordBuiltSnapshot(
        tx,
        instance.id,
        previous,
        selectedAssignments.flatMap(({ endpointId }) => {
          const endpointGeneration = endpointGenerations.get(endpointId);
          if (endpointGeneration === undefined) return [];
          return (routesByEndpoint.get(endpointId) ?? []).map((route) => ({
            routeId: route.id,
            endpointId,
            routeGeneration: route.generation,
            endpointGeneration,
          }));
        }),
        { key, revision: poolRevision.revision, issuedAtUnix, expiresAtUnix }
      );
      return {
        unchanged: false as const,
        state,
        content,
        signingKeyId: policyKeys.signingKeyId,
        revision: poolRevision.revision,
        expiresAtUnix,
      };
    });
    if (projection.unchanged) {
      return {
        encodedRequest: null,
        revision: projection.revision,
        globalRevision: projection.state.revision,
        expiresAtUnix: projection.expiresAtUnix,
      };
    }
    const payload = encodeRelayV1Message('PolicyEnvelopePayload', {
      ...projection.content,
      revision: String(projection.revision),
      issuedAtUnix: String(issuedAtUnix),
      expiresAtUnix: String(projection.expiresAtUnix),
    });
    const signed = await this.policyKeys.signPayload(payload, projection.signingKeyId);
    return {
      encodedRequest: encodeRelayV1Message('ApplySnapshotRequest', {
        signedEnvelope: { signingKeyId: signed.signingKeyId, payload, signature: signed.signature },
      }),
      revision: projection.revision,
      globalRevision: projection.state.revision,
      expiresAtUnix: projection.expiresAtUnix,
    };
  }

  private async updateManagedDatabaseStatus(managedDatabaseId: string, databaseStatus: string): Promise<void> {
    const changed = await updateManagedDatabaseRelayStatus(this.db, managedDatabaseId, databaseStatus);
    if (!changed) return;
    await this.syncSnapshot();
    await this.refreshAllNodeGrantsIfDue(true).catch(() => undefined);
  }
}
