import type { ServerDuplexStream } from '@grpc/grpc-js';
import { and, eq, sql } from 'drizzle-orm';
import { getEnv } from '@/config/env.js';
import { container } from '@/container.js';
import type { DrizzleExecutor } from '@/db/client.js';
import { nodes, relayInstances } from '@/db/schema/index.js';
import type { NodeGpuDevice } from '@/db/schema/nodes.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { createChildLogger } from '@/lib/logger.js';
import { isMinorCompatible } from '@/lib/semver.js';
import { AppError } from '@/middleware/error-handler.js';
import { syncAccessPolicyToNode } from '@/modules/access-signin/access-policy-sync.js';
import { DockerRuntimeStatusSchema } from '@/modules/docker/docker.schemas.js';
import { DockerBuildService } from '@/modules/docker/docker-build.service.js';
import { DomainsService } from '@/modules/domains/domain.service.js';
import { ingressHealthFromProto } from '@/modules/ingress-groups/ingress-health.js';
import { daemonLogRelay } from '@/modules/monitoring/log-relay.service.js';
import { nginxUpgradeHealth, nginxVersionNotice } from '@/modules/nodes/nginx-minimum-version.js';
import { validateRegisteredDaemonProfile } from '@/modules/nodes/node-daemon-profile.js';
import { installerRelease, secureRuntimeLocalCommand } from '@/modules/nodes/node-installer.js';
import { nodeReportHealthy } from '@/modules/nodes/node-service-helpers.js';
import { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import { NGINX_ACCESS_AUTH_CAPABILITY } from '@/modules/proxy/nginx-access-list.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { backgroundWrites } from '@/services/background-writes.js';
import { NginxCertificateDistributionService } from '@/services/nginx-certificate-distribution.service.js';
import { MANAGED_AVAILABILITY_MEMBER_CAPABILITY } from '@/services/node-dispatch.service.js';
import { nodeHostAccessFlags } from '@/services/node-host-access.js';
import { NODE_CONNECTION_PATTERNS } from '@/services/node-registry.service.js';
import { recordedRelayState } from '@/services/relay-planned-port-changes.js';
import { bumpRelayPolicyRevision } from '@/services/relay-policy-reconciler.js';
import { reportedPolicySigningKeyIds } from '@/services/relay-policy-signing-key.service.js';
import { servedRelayServiceEndpoint } from '@/services/relay-service-endpoint.js';
import type { DaemonMessage, OpfieldCommand } from '../generated/types.js';
import { extractDaemonCertificateIdentity, normalizeCertificateSerial } from '../interceptors/auth.js';
import { matchEnrolledNodeCertificate, promotePendingNodeCertificate } from '../node-certificate.js';
import type { GrpcServerDeps } from '../server.js';
import {
  decodeHealthDiskMounts,
  dockerEngineHealth,
  managedLinkHealth,
  relayLatencyHealth,
  relayStreamHealth,
  sshHostKeyFingerprintsHealth,
  updateConnectionsHealth,
} from './health-report.js';
import { leaseWatchdogVersion } from './lease-watchdog-version.js';
import { legacyNameCounts } from './legacy-names.js';
import { nginxLogUsageHealth } from './nginx-log-usage.js';

const logger = createChildLogger('GrpcControl');

/** A remote relay's supervisor answers, but its relay worker does not listen (yet): it restarts. */
export function isRelayWorkerRestarting(message: string): boolean {
  return /code = Unavailable\b.*(connection refused|connect: )|\bECONNREFUSED\b/i.test(message);
}
/**
 * Command id the daemon treats as a terminal registration rejection. It stops
 * the tight reconnect loop for causes that a retry cannot fix.
 */
export const REGISTRATION_REJECTED_COMMAND_ID = '__registration_rejected__';
// Bound for messages buffered while a Register is being validated.
const MAX_MESSAGES_DURING_REGISTRATION = 1000;
const pendingCommandRegistrations = new Map<string, { token: symbol; sequence: number }>();
let commandRegistrationSequence = 0;

function clearPendingCommandRegistration(nodeId: string, token: symbol): void {
  if (pendingCommandRegistrations.get(nodeId)?.token === token) {
    pendingCommandRegistrations.delete(nodeId);
  }
}

// Throttle health history writes — track last recorded timestamp per node
const lastRecordedTs = new Map<string, number>();
const HEALTH_HISTORY_MIN_INTERVAL_MS = 30_000; // one entry per 30s
/** The legacy policy lease; a gap past this is long enough that the relay served stale policy. */
const RELAY_STALE_POLICY_GAP_MS = 15 * 60 * 1000;

/**
 * A relay whose control stream ended is offline once the node registry gives up on it, not at once: the relay
 * supervisor reconnects the control stream on purpose (after an update, a policy change) while the relay keeps
 * serving, and a relay listed offline for those seconds read as an outage (stand rc.9: UK and NL "offline" for 1-4 s
 * after their updates). The registry marks it offline when the node's reconnect grace ends (markDisconnectedOffline).
 */
async function markRelayInstanceOffline(deps: GrpcServerDeps, nodeId: string): Promise<void> {
  if (deps.registry.getNode(nodeId) || deps.registry.isReconnecting(nodeId)) return;
  const [node] = await deps.db.select({ type: nodes.type }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (node?.type !== 'relay' || deps.registry.getNode(nodeId)) return;
  await deps.db
    .update(relayInstances)
    .set({ state: 'offline', updatedAt: new Date() })
    .where(eq(relayInstances.nodeId, nodeId));
}

/** `daemonVersion`: the node's own daemon version, pinned in the local setup command so it never changes the version. */
export function mapDockerRuntimeStatus(raw: DaemonMessage['dockerRuntimeStatus'], daemonVersion?: string | null) {
  if (!raw) return undefined;
  const checkedAtMs = Number(raw.checkedAtUnixMs);
  const result = DockerRuntimeStatusSchema.safeParse({
    state: raw.state,
    installedVersion: raw.installedVersion || undefined,
    targetVersion: raw.targetVersion || undefined,
    reasonCode: raw.reasonCode || undefined,
    message: raw.message || undefined,
    checkedAt: Number.isFinite(checkedAtMs) ? new Date(checkedAtMs).toISOString() : undefined,
    remoteInstallable: Boolean(raw.remoteInstallable),
    localInstallCommand: raw.localInstallCommand
      ? secureRuntimeLocalCommand(raw.localInstallCommand, installerRelease(getEnv().APP_VERSION), daemonVersion)
      : undefined,
    step: raw.step || undefined,
    progressPercent: raw.step === 'downloading' ? Number(raw.progressPercent) : undefined,
  });
  return result.success ? result.data : undefined;
}

interface DockerContainerStateSnapshot {
  containerId: string;
  name?: string;
  state?: string;
}

export interface DockerContainerStateDiff {
  containerId: string;
  name?: string;
  state: string;
}

function containerStateDiff(containerId: string, state: string, name?: string): DockerContainerStateDiff {
  return name ? { containerId, name, state } : { containerId, state };
}

function hasDockerMetricSample(container: any) {
  const state = String(container.state ?? container.State ?? '').toLowerCase();
  if (state !== 'running') return false;
  return [
    container.memoryUsageBytes ?? container.memory_usage_bytes,
    container.memoryLimitBytes ?? container.memory_limit_bytes,
    container.networkRxBytes ?? container.network_rx_bytes,
    container.networkTxBytes ?? container.network_tx_bytes,
    container.blockReadBytes ?? container.block_read_bytes,
    container.blockWriteBytes ?? container.block_write_bytes,
    container.pids,
  ].some((value) => Number(value ?? 0) > 0);
}

function numberIfReported(device: any, availableMetrics: Set<string>, metric: string, ...fields: string[]) {
  if (!availableMetrics.has(metric)) return undefined;
  const raw = fields.map((field) => device[field]).find((value) => value !== undefined && value !== null);
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function booleanIfReported(device: any, availableMetrics: Set<string>, metric: string, ...fields: string[]) {
  if (!availableMetrics.has(metric)) return undefined;
  const raw = fields.map((field) => device[field]).find((value) => value !== undefined && value !== null);
  return typeof raw === 'boolean' ? raw : undefined;
}

function stringIfReported(device: any, availableMetrics: Set<string>, metric: string, ...fields: string[]) {
  if (!availableMetrics.has(metric)) return undefined;
  const raw = fields.map((field) => device[field]).find((value) => value !== undefined && value !== null);
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * gRPC proto3 scalars default to zero when omitted. GPU metrics are therefore
 * only persisted when their name is explicitly listed in availableMetrics.
 */
export function mapGpuHealthDevices(rawDevices: unknown): NodeGpuDevice[] {
  if (!Array.isArray(rawDevices)) return [];

  return rawDevices.flatMap((rawDevice) => {
    if (!rawDevice || typeof rawDevice !== 'object') return [];
    const device = rawDevice as Record<string, unknown>;
    const id = stringValue(device.id ?? device.Id);
    if (!id) return [];

    const rawAvailableMetrics: unknown[] = Array.isArray(device.availableMetrics)
      ? device.availableMetrics
      : Array.isArray(device.available_metrics)
        ? device.available_metrics
        : [];
    const availableMetrics = new Set<string>(
      rawAvailableMetrics
        .filter((metric): metric is string => typeof metric === 'string' && metric.trim().length > 0)
        .map((metric) => metric.trim())
    );
    const utilizationPercent = numberIfReported(
      device,
      availableMetrics,
      'utilization_percent',
      'utilizationPercent',
      'utilization_percent'
    );
    const memoryTotalBytes = numberIfReported(
      device,
      availableMetrics,
      'memory_total_bytes',
      'memoryTotalBytes',
      'memory_total_bytes'
    );
    const memoryUsedBytes = numberIfReported(
      device,
      availableMetrics,
      'memory_used_bytes',
      'memoryUsedBytes',
      'memory_used_bytes'
    );
    const temperatureCelsius = numberIfReported(
      device,
      availableMetrics,
      'temperature_celsius',
      'temperatureCelsius',
      'temperature_celsius'
    );
    const powerWatts = numberIfReported(device, availableMetrics, 'power_watts', 'powerWatts', 'power_watts');
    const powerLimitWatts = numberIfReported(
      device,
      availableMetrics,
      'power_limit_watts',
      'powerLimitWatts',
      'power_limit_watts'
    );
    const throttled = booleanIfReported(device, availableMetrics, 'throttled', 'throttled');
    const eccCorrectedErrors = numberIfReported(
      device,
      availableMetrics,
      'ecc_corrected_errors',
      'eccCorrectedErrors',
      'ecc_corrected_errors'
    );
    const eccUncorrectedErrors = numberIfReported(
      device,
      availableMetrics,
      'ecc_uncorrected_errors',
      'eccUncorrectedErrors',
      'ecc_uncorrected_errors'
    );
    const health = stringIfReported(device, availableMetrics, 'health', 'health');

    const validatedMetrics = [
      utilizationPercent !== undefined && 'utilization_percent',
      memoryTotalBytes !== undefined && 'memory_total_bytes',
      memoryUsedBytes !== undefined && 'memory_used_bytes',
      temperatureCelsius !== undefined && 'temperature_celsius',
      powerWatts !== undefined && 'power_watts',
      powerLimitWatts !== undefined && 'power_limit_watts',
      throttled !== undefined && 'throttled',
      eccCorrectedErrors !== undefined && 'ecc_corrected_errors',
      eccUncorrectedErrors !== undefined && 'ecc_uncorrected_errors',
      health !== undefined && 'health',
    ].filter((metric): metric is string => typeof metric === 'string');

    return [
      {
        id,
        vendor: stringValue(device.vendor ?? device.Vendor),
        model: stringValue(device.model ?? device.Model),
        pciAddress: stringValue(device.pciAddress ?? device.pci_address ?? device.PciAddress),
        renderNode: stringValue(device.renderNode ?? device.render_node ?? device.RenderNode),
        deviceIndex: Number(device.deviceIndex ?? device.device_index ?? device.DeviceIndex ?? 0),
        attachable: Boolean(device.attachable ?? device.Attachable),
        unavailableReason: stringValue(
          device.unavailableReason ?? device.unavailable_reason ?? device.UnavailableReason
        ),
        partitioned: Boolean(device.partitioned ?? device.Partitioned),
        availableMetrics: validatedMetrics,
        ...(utilizationPercent !== undefined ? { utilizationPercent } : {}),
        ...(memoryTotalBytes !== undefined ? { memoryTotalBytes } : {}),
        ...(memoryUsedBytes !== undefined ? { memoryUsedBytes } : {}),
        ...(temperatureCelsius !== undefined ? { temperatureCelsius } : {}),
        ...(powerWatts !== undefined ? { powerWatts } : {}),
        ...(powerLimitWatts !== undefined ? { powerLimitWatts } : {}),
        ...(throttled !== undefined ? { throttled } : {}),
        ...(eccCorrectedErrors !== undefined ? { eccCorrectedErrors } : {}),
        ...(eccUncorrectedErrors !== undefined ? { eccUncorrectedErrors } : {}),
        ...(health !== undefined ? { health } : {}),
      },
    ];
  });
}

export function diffDockerContainerStateReports(
  previousContainerStats: DockerContainerStateSnapshot[],
  nextContainerStats: DockerContainerStateSnapshot[]
): DockerContainerStateDiff[] {
  const previousById = new Map<string, DockerContainerStateSnapshot>(
    previousContainerStats
      .filter((container) => container.containerId)
      .map((container) => [String(container.containerId), container])
  );
  const nextById = new Map<string, DockerContainerStateSnapshot>(
    nextContainerStats
      .filter((container) => container.containerId)
      .map((container) => [String(container.containerId), container])
  );
  const nextNames = new Set(nextContainerStats.map((container) => container.name).filter(Boolean));
  const changes: DockerContainerStateDiff[] = [];

  for (const [containerId, nextContainer] of nextById) {
    const previousContainer = previousById.get(containerId);
    if (!previousContainer || previousContainer.state !== nextContainer.state) {
      changes.push(containerStateDiff(containerId, nextContainer.state ?? 'unknown', nextContainer.name));
    }
  }

  for (const [containerId, previousContainer] of previousById) {
    if (nextById.has(containerId)) continue;
    if (previousContainer.name && nextNames.has(previousContainer.name)) continue;
    changes.push(containerStateDiff(containerId, 'exited', previousContainer.name));
  }

  return changes;
}

export function preserveDockerContainerStateReport(
  previousContainerStats: DockerContainerStateSnapshot[],
  nextContainerStats: DockerContainerStateSnapshot[],
  containersTotal: number | undefined
): DockerContainerStateSnapshot[] {
  if (nextContainerStats.length === 0 && previousContainerStats.length > 0 && containersTotal !== 0) {
    return previousContainerStats;
  }
  return nextContainerStats;
}

export function createControlHandlers(deps: GrpcServerDeps) {
  type DockerBuildEventDisposition = 'accepted' | 'obsolete' | null;
  const dockerBuildEventTails = new Map<string, Promise<DockerBuildEventDisposition>>();
  const dockerBuildTerminalEvents = new Map<string, Promise<DockerBuildEventDisposition>>();
  const handleDockerBuildEvent = async (
    nodeId: string,
    event: NonNullable<DaemonMessage['dockerBuildEvent']>
  ): Promise<DockerBuildEventDisposition> => {
    try {
      await container.resolve(DockerBuildService).handleDaemonEvent(nodeId, event);
      return 'accepted';
    } catch (error) {
      logger.warn('Rejected Docker builder event', {
        nodeId,
        buildId: event.buildId,
        status: event.status,
        error: (error as Error).message,
      });
      if (
        error instanceof AppError &&
        ['BUILD_EVENT_ATTEMPT_STALE', 'BUILD_EVENT_TERMINAL_CONFLICT', 'BUILD_EVENT_OWNER_MISMATCH'].includes(
          error.code
        )
      ) {
        return 'obsolete';
      }
      return null;
    }
  };
  const dispatchDockerBuildEvent = (
    nodeId: string,
    event: NonNullable<DaemonMessage['dockerBuildEvent']>
  ): Promise<DockerBuildEventDisposition> => {
    // Log chunks are independent inserts and must not delay lifecycle
    // transitions. Heartbeats must also bypass a long terminal rollout so the
    // lease remains live. Serialize state-bearing events per build so the database
    // observes the same checking_out -> building -> scanning -> terminal
    // order as the authenticated gRPC stream.
    if (event.status === 'log' || event.status === 'heartbeat') return handleDockerBuildEvent(nodeId, event);

    const key = `${nodeId}:${event.buildId}`;
    const attempt = Number(event.attempt ?? 0);
    const terminalKey =
      attempt > 0 && (event.status === 'succeeded' || event.status === 'failed')
        ? `${key}:${attempt}:${event.status}`
        : null;
    if (terminalKey) {
      const existing = dockerBuildTerminalEvents.get(terminalKey);
      if (existing) return existing;
    }
    const previous = dockerBuildEventTails.get(key) ?? Promise.resolve<DockerBuildEventDisposition>('accepted');
    const task = previous.then(() => handleDockerBuildEvent(nodeId, event));
    const settled = task.finally(() => {
      if (dockerBuildEventTails.get(key) === settled) dockerBuildEventTails.delete(key);
    });
    dockerBuildEventTails.set(key, settled);
    if (terminalKey) {
      dockerBuildTerminalEvents.set(terminalKey, settled);
      void settled.finally(() => {
        if (dockerBuildTerminalEvents.get(terminalKey) === settled) dockerBuildTerminalEvents.delete(terminalKey);
      });
    }
    return settled;
  };

  return {
    CommandStream(stream: ServerDuplexStream<DaemonMessage, OpfieldCommand>) {
      let nodeId: string | null = null;
      let closed = false;
      let registering = false;
      // Shutdown waits for this stream's close handling (deregistration, relay instance state,
      // the node.disconnected audit row) before it closes the database pool.
      const releaseShutdownSource = backgroundWrites.openSource();
      // A daemon starts streaming (logs, build events, results) right after
      // Register. Those messages are held until the async registration
      // validation finishes and replayed in order; ending the stream instead
      // made every Opfield restart flap the node and fail running builds.
      const messagesDuringRegistration: DaemonMessage[] = [];
      let droppedDuringRegistration = 0;
      const rejectRegistration = (reason: string) => {
        // Terminal causes: tell the daemon to stop reconnecting in a tight loop.
        try {
          stream.write({ commandId: REGISTRATION_REJECTED_COMMAND_ID, applyConfig: { configContent: reason } } as any);
        } catch {
          // The stream may already be closing.
        }
        stream.end();
      };
      const isCurrentCommandStream = () =>
        !!nodeId && !closed && deps.registry.getNode(nodeId)?.commandStream === stream;
      const endStaleStream = async () => {
        closed = true;
        if (nodeId && deps.registry.getNode(nodeId)?.commandStream === stream) {
          await deps.registry.deregister(nodeId, stream as any);
          await markRelayInstanceOffline(deps, nodeId);
        }
        stream.end();
      };
      const failRegisteredStream = async (reason: string, err?: unknown) => {
        closed = true;
        logger.error(reason, {
          nodeId,
          error: err instanceof Error ? err.message : err ? String(err) : undefined,
        });
        if (nodeId) {
          await deps.registry.deregister(nodeId, stream as any);
          await markRelayInstanceOffline(deps, nodeId);
        }
        stream.end();
        (stream as any).destroy?.();
      };
      const isClaimedStreamCurrent = (claimedNodeId: string) =>
        !closed && deps.registry.getNode(claimedNodeId)?.commandStream === stream;
      const relayDaemonLog = (activeNodeId: string, daemonLog: NonNullable<DaemonMessage['daemonLog']>) => {
        daemonLogRelay.emit('log', {
          nodeId: activeNodeId,
          timestamp: daemonLog.timestamp || new Date().toISOString(),
          level: daemonLog.level,
          message: daemonLog.message,
          component: daemonLog.component,
          fields: daemonLog.fields || {},
        });
        logger.debug('Daemon log', {
          nodeId: activeNodeId,
          level: daemonLog.level,
          component: daemonLog.component,
          message: daemonLog.message,
        });
      };

      const handleMessage = async (msg: DaemonMessage) => {
        try {
          if (closed) return;
          // Messages that arrive while the Register is still awaiting
          // database/certificate validation are queued and replayed once the
          // stream has an identity. The Relay supervisor also publishes an
          // immediate runtime snapshot from OnSessionStart; that replaceable
          // snapshot is dropped instead, the next periodic one supersedes it.
          if (registering && !msg.register) {
            if (msg.relayRuntimeStatus) return;
            if (messagesDuringRegistration.length >= MAX_MESSAGES_DURING_REGISTRATION) {
              droppedDuringRegistration += 1;
              return;
            }
            messagesDuringRegistration.push(msg);
            return;
          }
          if (msg.register) {
            const registrationObservedAt = new Date();
            // First message must be RegisterMessage
            if (nodeId || registering) {
              logger.warn('Duplicate node registration message ignored', { nodeId: nodeId ?? msg.register.nodeId });
              await endStaleStream();
              return;
            }
            registering = true;
            const claimedNodeId = msg.register.nodeId;
            const registrationToken = Symbol(claimedNodeId);
            const registrationSequence = ++commandRegistrationSequence;

            // Verify mTLS cert CN and serial match the enrolled node (prevents node impersonation).
            const certIdentity = extractDaemonCertificateIdentity(stream as any);
            if (!certIdentity) {
              logger.error('Node registration rejected: missing or unauthorized mTLS client certificate', {
                claimedNodeId,
              });
              registering = false;
              messagesDuringRegistration.length = 0;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }
            if (certIdentity.nodeId !== claimedNodeId) {
              logger.error('Node ID mismatch: cert CN does not match claimed nodeId', {
                certNodeId: certIdentity.nodeId,
                claimedNodeId,
              });
              registering = false;
              messagesDuringRegistration.length = 0;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }

            // A stream without an authenticated certificate cannot affect the
            // per-node registration race. Once certificate identity matches,
            // preserve arrival order while the enrolled serial is loaded.
            pendingCommandRegistrations.set(claimedNodeId, {
              token: registrationToken,
              sequence: registrationSequence,
            });

            logger.info('Node registering', {
              nodeId: claimedNodeId,
              hostname: msg.register.hostname,
              nginxVersion: msg.register.nginxVersion,
              configVersionHash: msg.register.configVersionHash,
              certVerified: true,
            });

            // Look up node from DB — read stored hash BEFORE updating
            const [node] = await deps.db
              .select({
                type: nodes.type,
                configVersionHash: nodes.configVersionHash,
                certificateSerial: nodes.certificateSerial,
                certificateFingerprint: nodes.certificateFingerprint,
                pendingCertificateSerial: nodes.pendingCertificateSerial,
                pendingCertificateFingerprint: nodes.pendingCertificateFingerprint,
                hostIdentityId: nodes.hostIdentityId,
                status: nodes.status,
              })
              .from(nodes)
              .where(eq(nodes.id, claimedNodeId))
              .limit(1);

            if (!node) {
              // Expected after a node is removed while its daemon still runs: it is refused, not an Opfield fault.
              logger.warn('Unknown node ID during registration', { nodeId: claimedNodeId });
              registering = false;
              messagesDuringRegistration.length = 0;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              rejectRegistration('node is not registered with this Opfield installation (it may have been removed)');
              return;
            }

            if (node.status === 'pending') {
              logger.error('Node registration rejected: enrollment is not complete', { nodeId: claimedNodeId });
              registering = false;
              messagesDuringRegistration.length = 0;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }
            if (!node.certificateSerial) {
              logger.error('Node registration rejected: node has no stored certificate serial', {
                nodeId: claimedNodeId,
              });
              registering = false;
              messagesDuringRegistration.length = 0;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              rejectRegistration('node has no enrolled certificate; re-enroll the daemon');
              return;
            }
            // Accept the current certificate or a staged renewal. The staged
            // one is promoted (and the old leaf revoked) below, only once the
            // daemon has proven it actually holds it.
            const certificateMatch = matchEnrolledNodeCertificate(node, certIdentity);
            if (!certificateMatch) {
              logger.error('Node registration rejected: certificate does not match enrolled node', {
                nodeId: claimedNodeId,
                presentedSerial: certIdentity.serialNumber,
                storedSerial: normalizeCertificateSerial(node.certificateSerial),
              });
              registering = false;
              messagesDuringRegistration.length = 0;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }

            // Only an authenticated, enrolled daemon may supersede an in-flight
            // registration for the same node. Preserve arrival order even when
            // certificate/DB validation finishes out of order.
            const currentRegistration = pendingCommandRegistrations.get(claimedNodeId);
            if (
              closed ||
              currentRegistration?.token !== registrationToken ||
              currentRegistration.sequence !== registrationSequence
            ) {
              registering = false;
              messagesDuringRegistration.length = 0;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }
            const nodeType = node.type as
              | 'nginx'
              | 'monitoring'
              | 'docker'
              | 'builder'
              | 'databases'
              | 'storage'
              | 'relay';
            const profileError = validateRegisteredDaemonProfile(
              nodeType,
              msg.register.daemonType,
              msg.register.capabilities
            );
            if (profileError) {
              logger.error('Node registration profile mismatch', { nodeId: claimedNodeId, error: profileError });
              registering = false;
              messagesDuringRegistration.length = 0;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              rejectRegistration(`daemon profile does not match this node: ${profileError}`);
              return;
            }
            if (nodeType === 'relay') {
              const [relayInstance] = await deps.db
                .select({ id: relayInstances.id, faultDomainId: relayInstances.faultDomainId })
                .from(relayInstances)
                .where(eq(relayInstances.nodeId, claimedNodeId))
                .limit(1);
              if (
                !relayInstance ||
                msg.register.daemonType !== 'relay' ||
                !msg.register.capabilities?.includes('relay_pool_v1') ||
                msg.register.relayInstanceId !== relayInstance.id ||
                !node.hostIdentityId ||
                msg.register.hostIdentityId !== node.hostIdentityId ||
                relayInstance.faultDomainId !== node.hostIdentityId
              ) {
                logger.error('Relay registration identity or capability mismatch', { nodeId: claimedNodeId });
                registering = false;
                messagesDuringRegistration.length = 0;
                clearPendingCommandRegistration(claimedNodeId, registrationToken);
                stream.end();
                return;
              }
            }
            const opfieldHash = node.configVersionHash;

            if (certificateMatch === 'pending') {
              try {
                const promotedFingerprint = await promotePendingNodeCertificate(
                  claimedNodeId,
                  node.pendingCertificateSerial!
                );
                logger.info('Promoted renewed node certificate after first registration with it', {
                  nodeId: claimedNodeId,
                  serial: certIdentity.serialNumber,
                });
                if (deps.relayPolicy && promotedFingerprint) {
                  void deps.relayPolicy.refreshNodeIdentity(claimedNodeId, promotedFingerprint).catch((error) => {
                    logger.warn('Relay policy identity refresh deferred after certificate promotion', {
                      nodeId: claimedNodeId,
                      error: error instanceof Error ? error.message : String(error),
                    });
                  });
                }
              } catch (err) {
                logger.error('Node registration rejected: renewed certificate could not be promoted', {
                  nodeId: claimedNodeId,
                  error: err instanceof Error ? err.message : String(err),
                });
                registering = false;
                messagesDuringRegistration.length = 0;
                clearPendingCommandRegistration(claimedNodeId, registrationToken);
                stream.end();
                return;
              }
            }

            try {
              await deps.registry.register(
                claimedNodeId,
                nodeType,
                msg.register.hostname,
                msg.register.configVersionHash,
                stream as any,
                {
                  isCurrentRegistration: () =>
                    pendingCommandRegistrations.get(claimedNodeId)?.token === registrationToken,
                  capabilities: msg.register.capabilities ?? [],
                  processInstanceId: msg.register.processInstanceId || undefined,
                }
              );
            } catch (err) {
              const reason = (err as Error).message;
              logger.error('Registration rejected', { nodeId: claimedNodeId, error: reason });
              registering = false;
              messagesDuringRegistration.length = 0;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              stream.end();
              return;
            }
            if (closed) {
              await deps.registry.deregister(claimedNodeId, stream as any);
              registering = false;
              messagesDuringRegistration.length = 0;
              clearPendingCommandRegistration(claimedNodeId, registrationToken);
              return;
            }
            nodeId = claimedNodeId;
            registering = false;
            clearPendingCommandRegistration(claimedNodeId, registrationToken);
            if (droppedDuringRegistration > 0) {
              logger.warn('Dropped daemon messages that exceeded the registration buffer', {
                nodeId: claimedNodeId,
                dropped: droppedDuringRegistration,
              });
              droppedDuringRegistration = 0;
            }
            // Replay in arrival order; each handler starts synchronously, so
            // per-build event serialization keeps the original order.
            for (const queued of messagesDuringRegistration.splice(0)) void handleMessage(queued);

            // Update DB with latest info — do NOT overwrite configVersionHash
            // (Opfield's stored hash is authoritative, set by FullSync)
            const { getEnv } = await import('@/config/env.js');
            const appVersion = getEnv().APP_VERSION;
            const versionMismatch =
              appVersion !== 'dev' &&
              msg.register.daemonVersion !== 'dev' &&
              !isMinorCompatible(appVersion, msg.register.daemonVersion);
            if (versionMismatch) {
              logger.warn('Daemon version mismatch', {
                nodeId: claimedNodeId,
                opfieldVersion: appVersion,
                daemonVersion: msg.register.daemonVersion,
              });
            }
            const reportedDockerVersion =
              msg.register.daemonType === 'docker'
                ? (((msg.register as any).dockerVersion as string | undefined) ?? msg.register.nginxVersion)
                : ((msg.register as any).dockerVersion as string | undefined);
            const reportedNginxVersion = msg.register.daemonType === 'docker' ? undefined : msg.register.nginxVersion;
            const reportedRuntimeStatus = mapDockerRuntimeStatus(
              msg.register.dockerRuntimeStatus,
              msg.register.daemonVersion
            );

            try {
              await deps.db
                .update(nodes)
                .set({
                  hostname: msg.register.hostname,
                  daemonVersion: msg.register.daemonVersion,
                  capabilities: {
                    ...(reportedNginxVersion ? { nginxVersion: reportedNginxVersion } : {}),
                    ...(msg.register.daemonType ? { daemonType: msg.register.daemonType } : {}),
                    ...(reportedDockerVersion ? { dockerVersion: reportedDockerVersion } : {}),
                    ...(msg.register.capabilities?.length
                      ? { capabilities: [...new Set(msg.register.capabilities)] }
                      : {}),
                    ...(msg.register.capabilities?.includes('docker_deployments_v1')
                      ? { dockerDeploymentsV1: true }
                      : {}),
                    ...(msg.register.capabilities?.includes('docker_compose_v1') ? { dockerComposeV1: true } : {}),
                    ...(msg.register.capabilities?.includes('docker_gpu_v1') ? { dockerGpuV1: true } : {}),
                    ...(msg.register.capabilities?.includes('docker_migration_v1') ? { dockerMigrationV1: true } : {}),
                    ...nodeHostAccessFlags(msg.register.capabilities),
                    ...(reportedRuntimeStatus ? { dockerRuntimeStatus: reportedRuntimeStatus } : {}),
                    launcherVersion: msg.register.launcherVersion || undefined,
                    cpuModel: msg.register.cpuModel || undefined,
                    cpuCores: msg.register.cpuCores || undefined,
                    architecture: msg.register.architecture || undefined,
                    kernelVersion: msg.register.kernelVersion || undefined,
                    versionMismatch,
                  },
                  lastSeenAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(eq(nodes.id, claimedNodeId));
            } catch (err) {
              await failRegisteredStream('Node registration metadata update failed', err);
              return;
            }
            // Reconciliation consumers must observe the capabilities committed
            // above. Publishing from registry.register() raced this metadata
            // update and could leave legacy Docker links unmigrated after an
            // in-place daemon upgrade.
            deps.registry.publishNodeChanged(claimedNodeId, 'online', msg.register.hostname);

            try {
              const { DaemonUpdateService } = await import('@/services/daemon-update.service.js');
              const daemonUpdateService = container.resolve(DaemonUpdateService);
              await daemonUpdateService.clearNodeUpdateInProgressOnReconnect(
                claimedNodeId,
                msg.register.daemonVersion,
                registrationObservedAt
              );
            } catch (err) {
              logger.warn('Failed to reconcile node update lock on register', {
                nodeId: claimedNodeId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            if (!isClaimedStreamCurrent(claimedNodeId)) return;

            logger.info('Node connected', {
              nodeId: claimedNodeId,
              hostname: msg.register.hostname,
              daemonVersion: msg.register.daemonVersion,
              nginxVersion: msg.register.nginxVersion,
            });

            // Enable daemon log streaming on connect (fire-and-forget via stream)
            try {
              if (!isClaimedStreamCurrent(claimedNodeId)) return;
              stream.write({ commandId: '', setDaemonLogStream: { enabled: true, minLevel: 'info', tailLines: 0 } });
            } catch {
              // stream may not be ready yet
            }

            if (deps.relayPolicy && msg.register.capabilities?.includes('generic_relay_tunnel_v1')) {
              setImmediate(async () => {
                try {
                  if (!isClaimedStreamCurrent(claimedNodeId)) return;
                  // A daemon that came back with other capabilities changes which of its routes are resumable;
                  // that is settled first, so it never gets a resume key its peer would not accept.
                  await deps.relayPolicy!.reconcileStreamResume().catch((error) => {
                    logger.warn('Resumable relay stream changes after a daemon reconnect deferred', {
                      nodeId: claimedNodeId,
                      error: error instanceof Error ? error.message : String(error),
                    });
                  });
                  if (!isClaimedStreamCurrent(claimedNodeId)) return;
                  await deps.relayPolicy!.syncNodeGrants(claimedNodeId);
                } catch (error) {
                  logger.warn('Failed to sync relay grants after daemon reconnect', {
                    nodeId: claimedNodeId,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              });
            }
            if (nodeType === 'nginx' && msg.register.capabilities?.includes(NGINX_ACCESS_AUTH_CAPABILITY)) {
              // The access policy (keys, lists, revocations) the daemon checks requests against: it may have none yet
              // or an old one after being away. Best-effort; the periodic sync delivers it otherwise.
              setImmediate(() => {
                if (!isClaimedStreamCurrent(claimedNodeId)) return;
                void syncAccessPolicyToNode(claimedNodeId).catch((error) =>
                  logger.warn('Failed to sync the access policy after daemon reconnect', {
                    nodeId: claimedNodeId,
                    error: error instanceof Error ? error.message : String(error),
                  })
                );
              });
            }
            if (nodeType === 'docker') {
              // Re-push registry credentials on every connect so private-registry
              // pulls work after a daemon restart, not only after the next tag
              // update. Best-effort and never blocks registration.
              setImmediate(async () => {
                try {
                  if (!isClaimedStreamCurrent(claimedNodeId)) return;
                  const { DockerRegistryService } = await import('@/modules/docker/docker-registry.service.js');
                  await container.resolve(DockerRegistryService).syncRegistriesToNode(claimedNodeId);
                } catch (error) {
                  logger.warn('Failed to sync Docker registries after daemon connect', {
                    nodeId: claimedNodeId,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              });
            }
            if (deps.relayPolicy && nodeType === 'relay') {
              setImmediate(async () => {
                try {
                  if (!isClaimedStreamCurrent(claimedNodeId)) return;
                  // Forced: the relay may have restarted without its state and hold no policy, while
                  // Opfield's records still say it holds the current one (N-7).
                  await deps.relayPolicy!.syncRemoteInstancePolicy(claimedNodeId, undefined, { force: true });
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  // The supervisor reconnected before its relay worker listens again (the worker restarts during
                  // its update): the worker keeps its policy, and the lease refresh or the lost-snapshot check
                  // delivers a newer one (stand rc.10, O-2).
                  if (isRelayWorkerRestarting(message)) {
                    logger.info('Remote relay policy delivery after reconnect waits for its relay to restart', {
                      nodeId: claimedNodeId,
                      error: message,
                    });
                    return;
                  }
                  logger.warn('Failed to synchronize remote relay policy after reconnect', {
                    nodeId: claimedNodeId,
                    error: message,
                  });
                }
              });
            }

            // A v2 Nginx daemon reconciles on every reconnect; an older daemon
            // retains the established hash-mismatch-only resync path, and
            // receives certificates renewed while it was offline through the
            // legacy deployCert retry below.
            const supportsTlsDistribution =
              msg.register.capabilities?.includes('nginx_certificate_distribution_v2') ?? false;
            const configHashMismatch = !!opfieldHash && opfieldHash !== msg.register.configVersionHash;
            if (nodeType === 'nginx' && !supportsTlsDistribution) {
              setImmediate(async () => {
                try {
                  if (!isClaimedStreamCurrent(claimedNodeId)) return;
                  if (configHashMismatch) {
                    await container.resolve(ProxyService).resyncAllHostsOnNode(claimedNodeId);
                  }
                  if (!isClaimedStreamCurrent(claimedNodeId)) return;
                  await container
                    .resolve(NginxCertificateDistributionService)
                    .reconcileIntegrity(claimedNodeId, { reconnect: true });
                } catch (err) {
                  logger.error('Legacy Nginx reconnect reconciliation failed', {
                    nodeId: claimedNodeId,
                    error: (err as Error).message,
                  });
                }
              });
              if (configHashMismatch) {
                logger.info('Config hash mismatch, triggering full resync', {
                  nodeId: claimedNodeId,
                  daemonHash: msg.register.configVersionHash,
                  opfieldHash,
                });
              }
            } else if (nodeType === 'nginx' && (supportsTlsDistribution || configHashMismatch)) {
              logger.info(
                supportsTlsDistribution
                  ? 'TLS distribution reconnect reconciliation'
                  : 'Config hash mismatch, triggering full resync',
                {
                  nodeId: claimedNodeId,
                  daemonHash: msg.register.configVersionHash,
                  opfieldHash,
                }
              );
              // Async reconciliation — never block node registration.
              setImmediate(async () => {
                try {
                  if (!isClaimedStreamCurrent(claimedNodeId)) return;
                  const proxyService = container.resolve(ProxyService);
                  await proxyService.resyncAllHostsOnNode(claimedNodeId);
                  if (supportsTlsDistribution) {
                    const distribution = container.resolve(NginxCertificateDistributionService);
                    await distribution.reconcileIntegrity(claimedNodeId);
                    // Certificates of routes deleted while the node was away leave it now, not at the next pass.
                    await distribution.cleanupDueReplicas(claimedNodeId);
                  }
                } catch (err) {
                  logger.error('Full resync failed', { nodeId: claimedNodeId, error: (err as Error).message });
                }
              });
            }
            // A domain moved away while this node was offline finishes its move now: the routes it still serves for
            // that domain leave it (the move stayed cleanup_pending until it could reach the node).
            if (nodeType === 'nginx') {
              setImmediate(async () => {
                try {
                  if (!isClaimedStreamCurrent(claimedNodeId)) return;
                  await container.resolve(DomainsService).resumeIngressSourceCleanup(claimedNodeId);
                } catch (err) {
                  logger.warn('Pending ingress migration cleanup after reconnect failed', {
                    nodeId: claimedNodeId,
                    error: (err as Error).message,
                  });
                }
              });
            }
          } else {
            const activeNodeId = nodeId;
            if (!activeNodeId || deps.registry.getNode(activeNodeId)?.commandStream !== stream) {
              await endStaleStream();
              return;
            }
            if (msg.relayRuntimeStatus) {
              const runtime = msg.relayRuntimeStatus;
              const [instance] = await deps.db
                .select({
                  id: relayInstances.id,
                  state: relayInstances.state,
                  appliedPolicyRevision: relayInstances.appliedPolicyRevision,
                  health: relayInstances.health,
                  lastSeenAt: relayInstances.lastSeenAt,
                  servicePort: relayInstances.servicePort,
                  advertisedAddresses: relayInstances.advertisedAddresses,
                })
                .from(relayInstances)
                .where(eq(relayInstances.nodeId, activeNodeId))
                .limit(1);
              if (!instance || runtime.relayInstanceId !== instance.id) {
                await failRegisteredStream('Relay runtime status identity mismatch');
                return;
              }
              const nextState = ['joining', 'synchronizing', 'ready', 'draining', 'offline', 'error'].includes(
                runtime.state
              )
                ? (runtime.state as 'joining' | 'synchronizing' | 'ready' | 'draining' | 'offline' | 'error')
                : 'error';
              const reportedRevision = Number(runtime.appliedPolicyRevision || 0);
              // A remote report; the policy service caps how far it may move revisions.
              const appliedPolicyRevision =
                Number.isSafeInteger(reportedRevision) && reportedRevision > 0 ? reportedRevision : 0;
              // The worker's port (and the addresses its installer advertised) are what daemons dial; a relay
              // installed with another --service-port than it was created with, or installed again, moves them.
              // Only a relay that serves moves them: daemons never get a port a worker is still trying (a port
              // change that may roll back, a worker that cannot bind).
              const serviceEndpoint = servedRelayServiceEndpoint(instance, runtime, nextState);
              // A relay whose port change runs restarts on purpose while drained: it stays draining, never offline.
              const recordedState = recordedRelayState(instance.id, nextState);
              const runtimeStateChanged =
                instance.state !== recordedState ||
                Number(instance.appliedPolicyRevision || 0) !== appliedPolicyRevision ||
                serviceEndpoint !== null;
              // A report that raced the stream's replacement must not overwrite the state the
              // close hook (or the heartbeat fence) recorded.
              if (!isCurrentCommandStream()) return;
              const reportedAt = new Date();
              const writeRuntime = (executor: DrizzleExecutor) =>
                executor
                  .update(relayInstances)
                  .set({
                    // Runtime restarts must not silently resume a manually drained member.
                    state:
                      recordedState === 'ready'
                        ? sql`case when ${relayInstances.manualDrainStartedAt} is not null then 'draining'::relay_instance_state else 'ready'::relay_instance_state end`
                        : recordedState,
                    buildVersion: runtime.buildVersion || null,
                    protocolMajor: runtime.protocolMajor || null,
                    capabilities: {
                      protocolMajor: runtime.protocolMajor || 0,
                      features: runtime.capabilities ?? [],
                    },
                    appliedPolicyRevision,
                    policyExpiresAt: Number(runtime.policyExpiresAtUnix || 0)
                      ? new Date(Number(runtime.policyExpiresAtUnix) * 1000)
                      : null,
                    lastSeenAt: reportedAt,
                    health: {
                      activeTunnels: Number(runtime.activeTunnels || 0),
                      registeredEndpoints: Number(runtime.registeredEndpoints || 0),
                      pressurePercent: runtime.pressurePercent || 0,
                      admissionState: runtime.draining ? 'draining' : nextState,
                      policySigningKeyIds: reportedPolicySigningKeyIds(
                        instance.health?.policySigningKeyIds,
                        runtime.policySigningKeyIds,
                        nextState
                      ),
                      assignmentTunnels: (runtime.assignmentTunnels ?? []).map((count) => ({
                        endpointId: count.endpointId,
                        assignmentGeneration: Number(count.assignmentGeneration),
                        activeTunnels: Number(count.activeTunnels),
                      })),
                      // The supervisor's own diagnosis (readiness reason, trust bootstrap
                      // failure) is what an operator needs when the relay is not ready.
                      ...(runtime.error ? { lastError: runtime.error.slice(0, 1000) } : {}),
                    },
                    updatedAt: new Date(),
                    ...(serviceEndpoint ?? {}),
                  })
                  .where(eq(relayInstances.id, instance.id));
              if (serviceEndpoint) {
                // Daemons hold the old target in their grant bundles: a new policy revision and bundles move them.
                await deps.db.transaction(async (tx) => {
                  await writeRuntime(tx);
                  await bumpRelayPolicyRevision(tx);
                });
              } else {
                await writeRuntime(deps.db);
              }
              if (runtimeStateChanged) {
                deps.registry.publishRelayRuntimeChanged(activeNodeId, instance.id);
              }
              if (serviceEndpoint) {
                logger.info('Relay service endpoint follows its runtime status', {
                  nodeId: activeNodeId,
                  relayInstanceId: instance.id,
                  servicePort: serviceEndpoint.servicePort,
                  advertisedAddresses: serviceEndpoint.advertisedAddresses,
                });
                await deps.auditService.log({
                  userId: null,
                  action: 'relay.instance.service_endpoint.change',
                  resourceType: 'relay_instance',
                  resourceId: instance.id,
                  details: {
                    previousServicePort: instance.servicePort,
                    servicePort: serviceEndpoint.servicePort,
                    previousAdvertisedAddresses: instance.advertisedAddresses,
                    advertisedAddresses: serviceEndpoint.advertisedAddresses,
                  },
                });
                void deps.relayPolicy?.refreshAllNodeGrantsIfDue(true).catch((error) => {
                  logger.warn('Relay service endpoint changed; daemon grant bundles follow on the next refresh', {
                    nodeId: activeNodeId,
                    error: error instanceof Error ? error.message : String(error),
                  });
                });
              }
              deps.relayPolicy?.noteRemoteAppliedRevision?.(
                activeNodeId,
                appliedPolicyRevision,
                Number(instance.appliedPolicyRevision || 0)
              );
              // A gap this long means the relay ran unreachable on whatever policy it last
              // held; the audit trail records what it served through, not just that it reconnected.
              if (
                instance.lastSeenAt &&
                reportedAt.getTime() - instance.lastSeenAt.getTime() > RELAY_STALE_POLICY_GAP_MS
              ) {
                await deps.auditService.log({
                  userId: null,
                  action: 'relay.instance.policy.stale_period',
                  resourceType: 'relay_instance',
                  resourceId: instance.id,
                  details: { from: instance.lastSeenAt.toISOString(), to: reportedAt.toISOString() },
                });
              }
              if (runtime.availabilityLease && deps.availabilityLease) {
                void deps.availabilityLease.ingestRelayReport(instance.id, runtime.availabilityLease).catch((error) => {
                  logger.warn('Relay availability lease report was not recorded', {
                    nodeId: activeNodeId,
                    error: (error as Error).message,
                  });
                });
              }
              if (deps.relayWitness) {
                void deps.relayWitness.ingestRuntime(instance.id, runtime).catch((error) => {
                  logger.warn('Relay witness report was not recorded', {
                    nodeId: activeNodeId,
                    error: (error as Error).message,
                  });
                });
              }
            } else if (msg.dockerBuildEvent) {
              const disposition = await dispatchDockerBuildEvent(activeNodeId, msg.dockerBuildEvent);
              const attempt = Number(msg.dockerBuildEvent.attempt ?? 0);
              if (
                disposition &&
                attempt > 0 &&
                (msg.dockerBuildEvent.status === 'succeeded' || msg.dockerBuildEvent.status === 'failed') &&
                isCurrentCommandStream()
              ) {
                try {
                  deps.registry.sendCommandNoWait(activeNodeId, {
                    dockerBuildEventAck: { buildId: msg.dockerBuildEvent.buildId, attempt, disposition },
                  });
                } catch (error) {
                  logger.debug('Docker build terminal acknowledgement was not sent', {
                    nodeId: activeNodeId,
                    buildId: msg.dockerBuildEvent.buildId,
                    attempt,
                    error: (error as Error).message,
                  });
                }
              }
            } else if (msg.dockerRuntimeStatus) {
              const [reporting] = msg.dockerRuntimeStatus.localInstallCommand
                ? await deps.db
                    .select({ daemonVersion: nodes.daemonVersion })
                    .from(nodes)
                    .where(eq(nodes.id, activeNodeId))
                    .limit(1)
                : [];
              const runtimeStatus = mapDockerRuntimeStatus(msg.dockerRuntimeStatus, reporting?.daemonVersion);
              if (!runtimeStatus) {
                logger.warn('Ignored invalid Docker runtime status update', { nodeId: activeNodeId });
                return;
              }
              const [updatedNode] = await deps.db
                .update(nodes)
                .set({
                  capabilities: sql`jsonb_set(
                    coalesce(${nodes.capabilities}, '{}'::jsonb),
                    '{dockerRuntimeStatus}',
                    ${JSON.stringify(runtimeStatus)}::jsonb,
                    true
                  )`,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(nodes.id, activeNodeId),
                    sql`coalesce(${nodes.capabilities}->'dockerRuntimeStatus'->>'checkedAt', '') <= ${runtimeStatus.checkedAt}`
                  )
                )
                .returning({ hostname: nodes.hostname, status: nodes.status });
              if (!isCurrentCommandStream()) return;
              if (updatedNode) {
                deps.registry.publishDockerRuntimeChanged(activeNodeId, runtimeStatus);
              }
            } else if (msg.commandResult) {
              // Intercept traffic stats results (fire-and-forget, not correlated)
              if (
                msg.commandResult.commandId?.startsWith('traffic-') &&
                msg.commandResult.success &&
                msg.commandResult.detail
              ) {
                try {
                  const node = deps.registry.getNode(activeNodeId);
                  if (node) node.lastTrafficStats = JSON.parse(msg.commandResult.detail);
                } catch {
                  /* ignore parse errors */
                }
              } else if (
                msg.commandResult.commandId?.startsWith('log_stream:') &&
                msg.commandResult.success &&
                msg.commandResult.detail
              ) {
                // Route log stream chunks to registered WebSocket handlers
                try {
                  const parsed = JSON.parse(msg.commandResult.detail);
                  if (parsed.type === 'log_stream' && parsed.containerId) {
                    const key = `${activeNodeId}:${parsed.containerId}`;
                    deps.registry.handleLogStream(key, parsed.lines ?? [], !!parsed.ended);
                  }
                } catch {
                  /* ignore parse errors */
                }
              } else {
                deps.registry.handleCommandResult(activeNodeId, msg.commandResult);
              }
            } else if (msg.healthReport) {
              if (
                deps.availabilityMembers &&
                deps.registry.hasCapability(activeNodeId, MANAGED_AVAILABILITY_MEMBER_CAPABILITY)
              ) {
                void deps.availabilityMembers
                  .ingestReports(activeNodeId, msg.healthReport.availabilityMembers ?? [])
                  .catch((error) => {
                    logger.warn('Availability member reports were not recorded', {
                      nodeId: activeNodeId,
                      error: (error as Error).message,
                    });
                  });
              }
              if (msg.healthReport.availabilityLease && deps.availabilityLease) {
                const leaseNodeType = deps.registry.getNode(activeNodeId)?.type ?? '';
                void deps.availabilityLease
                  .ingestDaemonReport(activeNodeId, leaseNodeType, msg.healthReport.availabilityLease, {
                    healthTimestampMs: Number(msg.healthReport.timestamp ?? 0) * 1000,
                    receivedAtMs: Date.now(),
                  })
                  .catch((error) => {
                    logger.warn('Daemon availability lease report was not recorded', {
                      nodeId: activeNodeId,
                      error: (error as Error).message,
                    });
                  });
              }
              const diskHealth = decodeHealthDiskMounts(msg.healthReport.diskMounts);
              const healthData = {
                nginxRunning: msg.healthReport.nginxRunning,
                configValid: msg.healthReport.configValid,
                nginxUptimeSeconds: Number(msg.healthReport.nginxUptimeSeconds),
                workerCount: msg.healthReport.workerCount,
                nginxVersion: msg.healthReport.nginxVersion,
                cpuPercent: msg.healthReport.cpuPercent,
                memoryBytes: Number(msg.healthReport.memoryBytes),
                diskFreeBytes: Number(msg.healthReport.diskFreeBytes),
                timestamp: Number(msg.healthReport.timestamp),
                loadAverage1m: (msg.healthReport as any).loadAverage_1m ?? msg.healthReport.loadAverage1m ?? 0,
                loadAverage5m: (msg.healthReport as any).loadAverage_5m ?? msg.healthReport.loadAverage5m ?? 0,
                loadAverage15m: (msg.healthReport as any).loadAverage_15m ?? msg.healthReport.loadAverage15m ?? 0,
                systemMemoryTotalBytes: Number(msg.healthReport.systemMemoryTotalBytes ?? 0),
                systemMemoryUsedBytes: Number(msg.healthReport.systemMemoryUsedBytes ?? 0),
                systemMemoryAvailableBytes: Number(msg.healthReport.systemMemoryAvailableBytes ?? 0),
                swapTotalBytes: Number(msg.healthReport.swapTotalBytes ?? 0),
                swapUsedBytes: Number(msg.healthReport.swapUsedBytes ?? 0),
                systemUptimeSeconds: Number(msg.healthReport.systemUptimeSeconds ?? 0),
                openFileDescriptors: Number(msg.healthReport.openFileDescriptors ?? 0),
                maxFileDescriptors: Number(msg.healthReport.maxFileDescriptors ?? 0),
                diskMounts: diskHealth.diskMounts,
                ...(diskHealth.managedStorageCapacity
                  ? { managedStorageCapacity: diskHealth.managedStorageCapacity }
                  : {}),
                diskReadBytes: Number(msg.healthReport.diskReadBytes ?? 0),
                diskWriteBytes: Number(msg.healthReport.diskWriteBytes ?? 0),
                networkInterfaces: (msg.healthReport.networkInterfaces ?? []).map((n: any) => ({
                  name: n.name,
                  rxBytes: Number(n.rxBytes ?? 0),
                  txBytes: Number(n.txBytes ?? 0),
                  rxPackets: Number(n.rxPackets ?? 0),
                  txPackets: Number(n.txPackets ?? 0),
                  rxErrors: Number(n.rxErrors ?? 0),
                  txErrors: Number(n.txErrors ?? 0),
                  ipAddresses: (n.ipAddresses ?? []).filter(
                    (address: unknown): address is string => typeof address === 'string' && address.length > 0
                  ),
                })),
                localIpAddresses: (msg.healthReport.localIpAddresses ?? []).filter(
                  (address: unknown): address is string => typeof address === 'string' && address.length > 0
                ),
                publicIpAddresses: (msg.healthReport.publicIpAddresses ?? []).filter(
                  (address: unknown): address is string => typeof address === 'string' && address.length > 0
                ),
                nginxRssBytes: Number(msg.healthReport.nginxRssBytes ?? 0),
                errorRate4xx: (msg.healthReport as any).errorRate_4xx ?? msg.healthReport.errorRate4xx ?? 0,
                errorRate5xx: (msg.healthReport as any).errorRate_5xx ?? msg.healthReport.errorRate5xx ?? 0,
                ...(msg.healthReport.nginxServiceProblem
                  ? { nginxServiceProblem: String(msg.healthReport.nginxServiceProblem) }
                  : {}),
                ...(legacyNameCounts(msg.healthReport.legacyNames)
                  ? { legacyNames: legacyNameCounts(msg.healthReport.legacyNames) as Record<string, number> }
                  : {}),
                ...leaseWatchdogVersion(msg.healthReport),
                ...dockerEngineHealth(msg.healthReport),
                ...nginxLogUsageHealth(msg.healthReport),
                ...nginxUpgradeHealth(msg.healthReport),
                ...nginxVersionNoticeHealth(msg.healthReport),
                // Docker-specific fields
                ...(msg.healthReport.dockerVersion ? { dockerVersion: msg.healthReport.dockerVersion } : {}),
                ...(msg.healthReport.containersRunning != null
                  ? { containersRunning: msg.healthReport.containersRunning }
                  : {}),
                ...(msg.healthReport.containersStopped != null
                  ? { containersStopped: msg.healthReport.containersStopped }
                  : {}),
                ...(msg.healthReport.containersTotal != null
                  ? { containersTotal: msg.healthReport.containersTotal }
                  : {}),
                ...(msg.healthReport.containerStats?.length
                  ? {
                      containerStats: msg.healthReport.containerStats.map((c: any) => ({
                        containerId: c.containerId,
                        name: c.name,
                        image: c.image,
                        state: c.state,
                        cpuPercent: c.cpuPercent ?? 0,
                        memoryUsageBytes: Number(c.memoryUsageBytes ?? 0),
                        memoryLimitBytes: Number(c.memoryLimitBytes ?? 0),
                        networkRxBytes: Number(c.networkRxBytes ?? 0),
                        networkTxBytes: Number(c.networkTxBytes ?? 0),
                        blockReadBytes: Number(c.blockReadBytes ?? 0),
                        blockWriteBytes: Number(c.blockWriteBytes ?? 0),
                        pids: c.pids ?? 0,
                        logBytes: Number(c.logBytes ?? 0),
                        logBytesAvailable: c.logBytesAvailable === true,
                        metricsAvailable: hasDockerMetricSample(c),
                      })),
                    }
                  : {}),
                gpuDevices: mapGpuHealthDevices(msg.healthReport.gpuDevices),
                ...relayLatencyHealth(msg.healthReport.relayLatencies),
                ...managedLinkHealth(msg.healthReport.managedLinks),
                ...relayStreamHealth(msg.healthReport.relayStreams),
                ...updateConnectionsHealth(msg.healthReport.updateConnections),
                ...ingressHealthFromProto((msg.healthReport as { ingressHealth?: unknown }).ingressHealth),
                ...sshHostKeyFingerprintsHealth(msg.healthReport),
              };

              const connectedNode = deps.registry.getNode(activeNodeId);
              const previousContainerStats = Array.isArray((connectedNode?.lastHealthReport as any)?.containerStats)
                ? (((connectedNode?.lastHealthReport as any)?.containerStats as any[]) ?? [])
                : [];
              const nextContainerStats = preserveDockerContainerStateReport(
                previousContainerStats,
                Array.isArray((healthData as any).containerStats)
                  ? (((healthData as any).containerStats as any[]) ?? [])
                  : [],
                healthData.containersTotal
              );
              if (nextContainerStats.length > 0 && !Array.isArray((healthData as any).containerStats)) {
                (healthData as any).containerStats = nextContainerStats;
              }

              if (connectedNode?.type === 'docker') {
                const nextContainerIds = new Set(
                  nextContainerStats.map((container: any) => String(container.containerId))
                );
                for (const change of diffDockerContainerStateReports(previousContainerStats, nextContainerStats)) {
                  deps.registry.publishDockerContainerChanged(
                    activeNodeId,
                    change.containerId,
                    change.name,
                    change.state,
                    {
                      observe: !nextContainerIds.has(change.containerId),
                    }
                  );
                }

                for (const container of nextContainerStats) {
                  if (!container.containerId) continue;
                  deps.registry.observeDockerContainerState(
                    activeNodeId,
                    container.containerId,
                    container.name,
                    container.state
                  );
                }
              }

              deps.registry.updateHealthReport(activeNodeId, healthData);

              // The counts of the daemon's last update land in the node's update result once, not on every report.
              const lastUpdateConnections = healthData.updateConnections?.lastUpdate;
              if (lastUpdateConnections) {
                void import('@/services/daemon-update.service.js')
                  .then(({ DaemonUpdateService }) =>
                    container
                      .resolve(DaemonUpdateService)
                      .recordLastUpdateConnections(activeNodeId, lastUpdateConnections)
                  )
                  .catch((err) => {
                    logger.warn('Failed to record the connections of the last daemon update', {
                      nodeId: activeNodeId,
                      error: err instanceof Error ? err.message : String(err),
                    });
                  });
              }

              // Evaluate notification alert rules (fire-and-forget, don't block health persistence)
              try {
                const evaluator = container.resolve(NotificationEvaluatorService);
                evaluator.evaluateHealthReport(activeNodeId, healthData).catch((err) => {
                  logger.error('Alert evaluation failed', { nodeId: activeNodeId, error: (err as Error).message });
                });
                evaluator
                  .observeStatefulEvent(
                    'node',
                    'online',
                    {
                      type: 'node',
                      id: activeNodeId,
                      name: deps.registry.nodeName?.(activeNodeId) ?? connectedNode?.hostname ?? activeNodeId,
                    },
                    { hostname: deps.registry.nodeName?.(activeNodeId) ?? connectedNode?.hostname ?? activeNodeId },
                    NODE_CONNECTION_PATTERNS
                  )
                  .catch((err) => {
                    logger.error('Stateful event observation failed', {
                      nodeId: activeNodeId,
                      error: (err as Error).message,
                    });
                  });
              } catch (resolveErr) {
                logger.error('Evaluator resolve failed', { error: (resolveErr as Error).message });
              }

              // Persist health report and restore online status if node was marked offline (e.g. after missed reports)
              const [currentRow] = await deps.db
                .select({ status: nodes.status })
                .from(nodes)
                .where(eq(nodes.id, activeNodeId))
                .limit(1);
              if (!isCurrentCommandStream()) {
                await endStaleStream();
                return;
              }

              const updatePayload: Record<string, unknown> = {
                lastHealthReport: healthData,
                lastSeenAt: new Date(),
              };
              if (currentRow?.status === 'offline') {
                updatePayload.status = 'online';
                updatePayload.updatedAt = new Date();
                logger.info('Node resumed health reports, restored to online', { nodeId: activeNodeId });
              }

              await deps.db.update(nodes).set(updatePayload).where(eq(nodes.id, activeNodeId));
              if (!isCurrentCommandStream()) return;

              // Publish status restoration event after DB write
              if (currentRow?.status === 'offline') {
                const connectedNode = deps.registry.getNode(activeNodeId);
                deps.registry.publishNodeChanged(activeNodeId, 'online', connectedNode?.hostname);
              }

              // Record health history entry (same format as proxy health checks)
              const nowMs = Date.now();
              const lastTs = lastRecordedTs.get(activeNodeId) ?? 0;
              if (nowMs - lastTs >= HEALTH_HISTORY_MIN_INTERVAL_MS) {
                // A Docker node whose engine cannot start containers (containerd down) is degraded, not online.
                const isHealthy = nodeReportHealthy(connectedNode?.type, healthData);
                const status = isHealthy ? 'online' : 'degraded';

                try {
                  const [histRow] = await deps.db
                    .select({ healthHistory: nodes.healthHistory })
                    .from(nodes)
                    .where(eq(nodes.id, activeNodeId))
                    .limit(1);
                  if (!isCurrentCommandStream()) return;

                  const history = compactHealthHistory(
                    [
                      ...((histRow?.healthHistory as Array<{ ts: string; status: string }>) ?? []),
                      { ts: new Date(nowMs).toISOString(), status },
                    ],
                    { nowMs }
                  );

                  await deps.db.update(nodes).set({ healthHistory: history }).where(eq(nodes.id, activeNodeId));
                  if (!isCurrentCommandStream()) return;
                  lastRecordedTs.set(activeNodeId, nowMs);
                } catch (err) {
                  logger.warn('Failed to update health history', {
                    nodeId: activeNodeId,
                    error: (err as Error).message,
                  });
                }
              }
            } else if (msg.statsReport) {
              deps.registry.updateStatsReport(activeNodeId, {
                activeConnections: Number(msg.statsReport.activeConnections),
                accepts: Number(msg.statsReport.accepts),
                handled: Number(msg.statsReport.handled),
                requests: Number(msg.statsReport.requests),
                reading: msg.statsReport.reading,
                writing: msg.statsReport.writing,
                waiting: msg.statsReport.waiting,
                timestamp: Number(msg.statsReport.timestamp),
              });

              await deps.db
                .update(nodes)
                .set({
                  lastStatsReport: {
                    activeConnections: Number(msg.statsReport.activeConnections),
                    accepts: Number(msg.statsReport.accepts),
                    handled: Number(msg.statsReport.handled),
                    requests: Number(msg.statsReport.requests),
                    reading: msg.statsReport.reading,
                    writing: msg.statsReport.writing,
                    waiting: msg.statsReport.waiting,
                    timestamp: Number(msg.statsReport.timestamp),
                  },
                  lastSeenAt: new Date(),
                })
                .where(eq(nodes.id, activeNodeId));
              if (!isCurrentCommandStream()) return;
            } else if (msg.daemonLog) {
              relayDaemonLog(activeNodeId, msg.daemonLog);
            } else if (msg.execOutput) {
              // Route exec output to registered WebSocket handler
              deps.registry.handleExecOutput(activeNodeId, msg.execOutput.execId, msg.execOutput);
            }
          }
        } catch (err) {
          logger.error('Error processing daemon message', { nodeId, error: (err as Error).message });
        }
      };

      // Not tracked for shutdown: a message may await a long build rollout, which the orchestration
      // drain already bounds and durable recovery resumes; its periodic state is re-sent on reconnect.
      stream.on('data', (msg: DaemonMessage) => {
        void handleMessage(msg);
      });

      const handleDisconnect = async (details: Record<string, unknown>) => {
        if (!nodeId) return;
        lastRecordedTs.delete(nodeId);
        await deps.registry.deregister(nodeId, stream as any);
        await markRelayInstanceOffline(deps, nodeId);
        // Every node drops when the local relay restarts: recorded only for a node that does not come back.
        if (await deps.registry.holdDisconnectAudit(nodeId, details)) return;
        await deps.auditService.log({
          userId: null,
          action: 'node.disconnected',
          resourceType: 'node',
          resourceId: nodeId,
          details,
        });
      };
      let disconnectTracked = false;
      const trackDisconnect = (details: Record<string, unknown>) => {
        // A stream reports its end once, whichever of end, error or cancelled comes first.
        if (disconnectTracked) return;
        disconnectTracked = true;
        void backgroundWrites
          .track(handleDisconnect(details))
          .catch((error) =>
            logger.warn('Failed to record a node stream disconnect', {
              nodeId,
              error: error instanceof Error ? error.message : String(error),
            })
          )
          .finally(releaseShutdownSource);
      };

      stream.on('end', () => {
        closed = true;
        if (nodeId) logger.info('Node stream ended', { nodeId });
        trackDisconnect({ reason: 'stream_ended' });
      });

      stream.on('error', (err) => {
        closed = true;
        if (nodeId) logger.warn('Node stream error', { nodeId, error: err.message });
        trackDisconnect({ reason: 'error', error: err.message });
      });

      // A stream the gRPC server cut (its force stop at shutdown) is only cancelled and emits neither of the above.
      // The node is gone all the same: commands still waiting for its answer fail now instead of at their timeout,
      // which held the module drains of a stopping Opfield until its hard deadline.
      stream.on('cancelled', () => {
        closed = true;
        if (nodeId) logger.info('Node stream cancelled', { nodeId });
        trackDisconnect({ reason: 'cancelled' });
      });
      // 'end', 'error' and 'cancelled' come before 'close', so their tracked work is registered by the time the
      // source is released.
      stream.on('close', () => setImmediate(releaseShutdownSource));
    },
  };
}

/** The stored notice about an nginx older than NGINX_MINIMUM_VERSION, from the version and upgrade the daemon reports. */
function nginxVersionNoticeHealth(report: { nginxVersion?: unknown; nginxUpgrade?: unknown }): {
  nginxVersionNotice?: string;
} {
  const notice = nginxVersionNotice({ nginxVersion: report.nginxVersion, ...nginxUpgradeHealth(report) });
  return notice ? { nginxVersionNotice: notice } : {};
}
