import { and, eq } from 'drizzle-orm';
import { parseDocument } from 'yaml';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/index.js';
import type { ManagedStorageEngine } from '@/db/schema/managed-storage.js';
import type { CommandResult, GatewayCommand, ProxyMaintenanceFlag } from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DaemonUpdateService } from './daemon-update.service.js';
import { assertNodeHostFeatureEnabled } from './node-host-access.js';
import type { DispatchedCommand, NodeRegistryService } from './node-registry.service.js';
import type { RelayGrantBundle } from './relay-policy.service.js';

const logger = createChildLogger('NodeDispatch');
const NGINX_SECURE_LINK_SOCKET_ONLY_CAPABILITY = 'nginx_secure_link_socket_only_v1';
// Reported by Storage daemons that can run SeaweedFS clusters (config payload
// version 2 and the SeaweedFS IAM path). Legacy MinIO work needs only the
// base managed-storage capabilities.
const MANAGED_STORAGE_SEAWEEDFS_CAPABILITY = 'managed_storage_seaweedfs_v1';
const MANAGED_STORAGE_IAM_POLICY_CAPABILITY = 'managed_storage_iam_policy_v1';
/** Relay supervisors that answer GetRelayRouteRuntimeCommand. */
const RELAY_ROUTE_RUNTIME_CAPABILITY = 'relay_route_runtime_v1';

// The background collector runs every 10s. Leave scheduler/queue headroom so a
// sample just under ten seconds old is refreshed in the current round instead
// of being deferred to the next one.
const TRAFFIC_STATS_MIN_FRESH_MS = 8_000;

// The database daemon caps its operation and rollback at 14 minutes. Keep this
// controller deadline slightly longer so it always receives the final result
// instead of marking an operation failed while it still changes disk state.
const managedDatabaseCommandTimeoutMs = 15 * 60 * 1000;
const managedStorageCommandTimeoutMs = 15 * 60 * 1000;
const managedBackupCommandTimeoutMs = 25 * 60 * 1000;
// SelfUpdate can spend up to five minutes downloading the binary before it
// acknowledges the command. Leave a small margin for verification and replace.
const daemonUpdateCommandTimeoutMs = 5 * 60 * 1000 + 30_000;
const dockerComposeCommandTimeoutMs = 30 * 60 * 1000;

/**
 * Docker daemons without `compose_logging_v1` reject a Compose service that sets `logging`. Until
 * the node is updated its services keep Docker's log defaults, as before, rather than failing a
 * deploy or an availability failover on that node.
 */
function withoutComposeLogging(composeYaml: Buffer | undefined, normalizedModelJson: string | undefined) {
  let model: { services?: Record<string, { logging?: unknown }> } | undefined;
  try {
    model = normalizedModelJson ? JSON.parse(normalizedModelJson) : undefined;
  } catch {
    return { composeYaml, normalizedModelJson };
  }
  const logged = Object.entries(model?.services ?? {}).filter(([, service]) => service?.logging != null);
  if (!model || logged.length === 0) return { composeYaml, normalizedModelJson };
  for (const [, service] of logged) delete service.logging;
  let yaml = composeYaml;
  if (composeYaml?.length) {
    const document = parseDocument(composeYaml.toString('utf8'));
    for (const [name] of logged) document.deleteIn(['services', name, 'logging']);
    yaml = Buffer.from(document.toString(), 'utf8');
  }
  return { composeYaml: yaml, normalizedModelJson: JSON.stringify(model) };
}

/** The maintenance field of a route apply: sent only when Gateway knows the node keeps maintenance flags. */
export {
  parseRelayGrantEgressStatuses,
  SECURE_LINK_EGRESS_CAPABILITY,
  type SecureLinkEgressStatus,
} from './secure-link-egress-status.js';

function maintenanceFlagField(maintenance: boolean | undefined): { maintenance?: ProxyMaintenanceFlag } {
  if (maintenance === undefined) return {};
  return { maintenance: maintenance ? 'PROXY_MAINTENANCE_FLAG_ON' : 'PROXY_MAINTENANCE_FLAG_OFF' };
}

export class NodeDispatchService {
  private daemonUpdateService?: DaemonUpdateService;

  constructor(
    private registry: NodeRegistryService,
    private db: DrizzleClient
  ) {}

  setDaemonUpdateService(service: DaemonUpdateService) {
    this.daemonUpdateService = service;
  }

  isNodeConnected(nodeId: string | null): boolean {
    return !!nodeId && !!this.registry.getNode(nodeId);
  }

  /** The node is not connected but is expected back: its stream closed moments ago, or Gateway just started. */
  isNodeReconnecting(nodeId: string): boolean {
    return this.registry.isReconnecting(nodeId);
  }

  /** True while a daemon update is replacing this node's daemon. */
  async isNodeUpdateInProgress(nodeId: string): Promise<boolean> {
    if (this.registry.isNodeUpdateInProgress(nodeId)) return true;
    if (!this.daemonUpdateService) return false;
    try {
      return await this.daemonUpdateService.isNodeUpdateInProgress(nodeId);
    } catch {
      return false;
    }
  }

  private async assertNodeMutable(nodeId: string) {
    if (this.daemonUpdateService && (await this.daemonUpdateService.isNodeUpdateInProgress(nodeId))) {
      throw new AppError(409, 'NODE_UPDATING', 'Node daemon update is in progress');
    }
  }

  /** Database-profile docker daemons are not general workload nodes. */
  private async assertGenericDockerNode(nodeId: string) {
    const [node] = await this.db.select({ type: nodes.type }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    if (node.type !== 'docker') {
      throw new AppError(409, 'NODE_TYPE_MISMATCH', 'Generic Docker operations require a Docker node');
    }
  }

  private async assertDatabaseNode(nodeId: string) {
    const [node] = await this.db.select({ type: nodes.type }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    if (node.type !== 'databases' && node.type !== 'storage') {
      throw new AppError(409, 'NODE_TYPE_MISMATCH', 'Managed database operations require a databases node');
    }
  }

  private async assertStorageNodeCapability(
    nodeId: string,
    capability: string,
    engine: ManagedStorageEngine = 'minio'
  ) {
    const [node] = await this.db
      .select({ type: nodes.type, capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    if (node.type !== 'storage' && node.type !== 'databases') {
      throw new AppError(409, 'NODE_TYPE_MISMATCH', 'Managed storage operations require a Storage node');
    }
    const reported = (node.capabilities as Record<string, unknown> | null)?.capabilities;
    if (!Array.isArray(reported) || !reported.includes(capability)) {
      throw new AppError(
        409,
        'STORAGE_CAPABILITY_UNAVAILABLE',
        'The connected Storage node does not support this operation'
      );
    }
    // An older daemon would reject the version 2 payload anyway, but only after
    // the controller had committed to the operation; refuse before sending.
    if (engine === 'seaweedfs' && !reported.includes(MANAGED_STORAGE_SEAWEEDFS_CAPABILITY)) {
      throw new AppError(
        409,
        'STORAGE_ENGINE_UNAVAILABLE',
        'The Storage node daemon is too old to run SeaweedFS managed storage; update the node daemon first'
      );
    }
  }

  private async assertBuilderNode(nodeId: string) {
    const [node] = await this.db
      .select({ type: nodes.type, status: nodes.status, capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    const reported = (node.capabilities as Record<string, unknown> | null)?.capabilities;
    const hasDedicatedRuntime =
      Array.isArray(reported) &&
      (reported.includes('docker_builder_dedicated_runtime_v1') ||
        // Rolling compatibility with the previous gVisor-backed worker profile.
        reported.includes('docker_builder_isolation_v1'));
    if (
      node.type !== 'builder' ||
      node.status !== 'online' ||
      !Array.isArray(reported) ||
      !reported.includes('docker_builder_execution_v1') ||
      !hasDedicatedRuntime
    ) {
      throw new AppError(
        409,
        'BUILDER_NODE_NOT_READY',
        'Builder node must be online with the dedicated BuildKit/containerd runtime ready'
      );
    }
  }

  async sendDockerBuildCommand(
    nodeId: string,
    command: NonNullable<GatewayCommand['dockerBuild']>
  ): Promise<CommandResult> {
    const dispatched = await this.dispatchDockerBuildCommand(nodeId, command);
    void dispatched.accepted.catch(() => {});
    return dispatched.result;
  }

  async dispatchDockerBuildCommand(
    nodeId: string,
    command: NonNullable<GatewayCommand['dockerBuild']>
  ): Promise<DispatchedCommand> {
    await this.assertNodeMutable(nodeId);
    await this.assertBuilderNode(nodeId);
    return this.registry.dispatchCommand(nodeId, { dockerBuild: command }, 30_000);
  }

  async cancelDockerBuild(nodeId: string, buildId: string, reason: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    await this.assertBuilderNode(nodeId);
    return this.registry.sendCommand(nodeId, { dockerBuildCancel: { buildId, reason } }, 30_000);
  }

  async applyConfig(
    nodeId: string,
    hostId: string,
    configContent: string,
    testOnly = false,
    configOwnership = '',
    deferReload = false,
    maintenance?: boolean
  ): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      applyConfig: {
        hostId,
        configContent,
        testOnly,
        configOwnership,
        deferReload,
        ...maintenanceFlagField(maintenance),
      },
    });
  }

  async removeConfig(nodeId: string, hostId: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      removeConfig: { hostId },
    });
  }

  async deployCertificate(
    nodeId: string,
    certId: string,
    certPem: Buffer,
    keyPem: Buffer,
    chainPem?: Buffer
  ): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      deployCert: {
        certId,
        certPem,
        keyPem,
        chainPem: chainPem ?? Buffer.alloc(0),
      },
    });
  }

  async removeCertificate(nodeId: string, certId: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      removeCert: { certId },
    });
  }

  async applyTlsBundle(
    nodeId: string,
    input: {
      hostId: string;
      configContent: string;
      generation: string;
      configOwnership?: string;
      /** Loaded with the reload of its batch (reconnect resync). */
      deferReload?: boolean;
      /** The route's maintenance state on a node that keeps maintenance flags; undefined keeps the flag. */
      maintenance?: boolean;
      certificates: Array<{
        certId: string;
        certPem: Buffer;
        keyPem: Buffer;
        chainPem: Buffer;
        version: string;
        replicaGeneration: string;
      }>;
    }
  ): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        applyTlsBundle: {
          hostId: input.hostId,
          configContent: input.configContent,
          generation: input.generation,
          configOwnership: input.configOwnership ?? '',
          deferReload: input.deferReload ?? false,
          ...maintenanceFlagField(input.maintenance),
          certificates: input.certificates,
        },
      },
      60_000
    );
  }

  async inspectCertificates(nodeId: string, certIds: string[]): Promise<CommandResult> {
    return this.registry.sendCommand(nodeId, { inspectCertificates: { certIds } }, 30_000);
  }

  async exportLegacyCertificates(nodeId: string, certIds: string[]): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, { exportLegacyCertificates: { certIds } }, 60_000);
  }

  async removeCertificateReplica(
    nodeId: string,
    certId: string,
    expectedVersion: string,
    expectedReplicaGeneration: string
  ): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      { removeCertificateReplica: { certId, expectedVersion, expectedReplicaGeneration } },
      30_000
    );
  }

  async deployHtpasswd(nodeId: string, accessListId: string, content: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      deployHtpasswd: { accessListId, content },
    });
  }

  async removeHtpasswd(nodeId: string, accessListId: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      removeHtpasswd: { accessListId },
    });
  }

  async updateGlobalConfig(nodeId: string, content: string, backupContent: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      updateGlobalConfig: { content, backupContent },
    });
  }

  async testConfig(nodeId: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        testConfig: {},
      },
      10000
    );
  }

  async requestHealth(nodeId: string): Promise<CommandResult> {
    return this.registry.sendCommand(
      nodeId,
      {
        requestHealth: {},
      },
      10000
    );
  }

  async requestStats(nodeId: string): Promise<CommandResult> {
    return this.registry.sendCommand(
      nodeId,
      {
        requestStats: {},
      },
      10000
    );
  }

  async deployAcmeChallenge(nodeId: string, token: string, content: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      deployAcmeChallenge: { token, content },
    });
  }

  async removeAcmeChallenge(nodeId: string, token: string): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      removeAcmeChallenge: { token },
    });
  }

  async readGlobalConfig(nodeId: string): Promise<CommandResult> {
    return this.registry.sendCommand(nodeId, { readGlobalConfig: {} }, 10000);
  }

  async requestTrafficStats(
    nodeId: string,
    tailLines = 200,
    options: { hostId?: string; windowSeconds?: number } = {}
  ): Promise<CommandResult> {
    return this.registry.requestTrafficStats(
      nodeId,
      {
        tailLines,
        hostId: options.hostId ?? '',
        windowSeconds: options.windowSeconds ?? 0,
      },
      TRAFFIC_STATS_MIN_FRESH_MS
    );
  }

  async setDaemonLogStream(nodeId: string, enabled: boolean, minLevel = 'info', tailLines = 0): Promise<CommandResult> {
    return this.registry.sendCommand(nodeId, {
      setDaemonLogStream: { enabled, minLevel, tailLines },
    });
  }

  /** Send a pre-built FullSyncCommand to a node */
  async fullSync(
    nodeId: string,
    hosts: { hostId: string; configContent: string; configOwnership?: string; maintenance?: boolean }[],
    certs: { certId: string; certPem: Buffer; keyPem: Buffer; chainPem: Buffer }[],
    globalConfig: string,
    htpasswdFiles: { accessListId: string; content: string }[],
    versionHash: string
  ): Promise<CommandResult> {
    await this.assertNodeMutable(nodeId);
    logger.info('Sending full sync', { nodeId, hostCount: hosts.length, certCount: certs.length });
    return this.registry.sendCommand(
      nodeId,
      {
        fullSync: {
          hosts: hosts.map((h) => ({
            hostId: h.hostId,
            configContent: h.configContent,
            configOwnership: h.configOwnership ?? '',
            ...maintenanceFlagField(h.maintenance),
          })),
          certs: certs.map((c) => ({ certId: c.certId, certPem: c.certPem, keyPem: c.keyPem, chainPem: c.chainPem })),
          globalConfig,
          htpasswdFiles: htpasswdFiles.map((h) => ({ accessListId: h.accessListId, content: h.content })),
          versionHash,
        },
      },
      60000 // 60s timeout for full sync
    );
  }

  // ─── Docker Commands ──────────────────────────────────────────────

  async sendDockerMigrationCommand(
    nodeId: string,
    action: string,
    options: {
      migrationId?: string;
      artifactId?: string;
      artifactType?: string;
      resourceId?: string;
      configJson?: string;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        dockerMigration: { action, ...options } as any,
      },
      timeoutMs
    );
  }

  async sendDockerAvailabilityCommand(
    nodeId: string,
    command: Omit<NonNullable<GatewayCommand['dockerAvailability']>, 'generation'> & {
      generation: number | string;
    },
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    await this.assertNodeMutable(nodeId);
    const disconnected = () =>
      new AppError(503, 'AVAILABILITY_NODE_DISCONNECTED', 'Waiting for the Docker daemon to reconnect', {
        retryable: true,
      });
    if (!this.registry.getNode(nodeId)) throw disconnected();
    if (!this.registry.hasCapability(nodeId, 'docker_availability_v1')) {
      if (!this.registry.getNode(nodeId)) throw disconnected();
      throw new AppError(
        409,
        'AVAILABILITY_CAPABILITY_UNAVAILABLE',
        'The connected Docker daemon does not support workload Availability operations'
      );
    }
    try {
      return await this.registry.sendCommand(
        nodeId,
        {
          dockerAvailability: {
            ...command,
            generation: String(command.generation),
          },
        },
        timeoutMs
      );
    } catch (error) {
      if (
        !this.registry.getNode(nodeId) ||
        (error instanceof Error &&
          (error.message === 'Node disconnected' || error.message === `Node ${nodeId} is not connected`))
      ) {
        throw disconnected();
      }
      throw error;
    }
  }

  /**
   * Send a restricted managed-database lifecycle command. This is a separate
   * proto command so a database node never receives arbitrary Docker commands.
   */
  async sendDockerDatabaseCommand(
    nodeId: string,
    action: string,
    managedDatabaseId: string,
    configJson = '',
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertDatabaseNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      { dockerDatabase: { action, managedDatabaseId, configJson } as any },
      timeoutMs ?? managedDatabaseCommandTimeoutMs
    );
  }

  async sendDockerStorageCommand(
    nodeId: string,
    action: string,
    managedStorageId: string,
    configJson = '',
    timeoutMs?: number,
    engine: ManagedStorageEngine = 'minio'
  ): Promise<CommandResult> {
    await this.assertStorageNodeCapability(nodeId, 'managed_storage_v1', engine);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      { dockerStorage: { action, managedStorageId, configJson } as any },
      timeoutMs ?? managedStorageCommandTimeoutMs
    );
  }

  async sendDockerStorageIamCommand(
    nodeId: string,
    action: 'create_key' | 'list_keys' | 'remove_key' | 'update_policy',
    managedStorageId: string,
    opts: {
      publishedPort: number;
      rootAccessKey: string;
      rootSecretKey: string;
      useTls: boolean;
      caPem?: string;
      serverName?: string;
      targetAccessKey?: string;
      targetSecretKey?: string;
      name?: string;
      policy?: string;
      expiresAt?: string;
      /** Omitted or `minio`: the legacy service-account payload, byte for byte. */
      engine?: ManagedStorageEngine;
      /** SeaweedFS only: the IAM user that owns the key and its policy (`gw-<id>`). */
      principal?: string;
    },
    timeoutMs?: number
  ): Promise<CommandResult> {
    const storageAction = `iam_${action}`;
    const engine = opts.engine ?? 'minio';
    await this.assertStorageNodeCapability(nodeId, 'managed_storage_iam_v1', engine);
    // update_policy (the migration write freeze) replaces a key's policy in
    // place; older daemons only create, list and remove keys.
    if (action === 'update_policy')
      await this.assertStorageNodeCapability(nodeId, MANAGED_STORAGE_IAM_POLICY_CAPABILITY, engine);
    if (engine === 'seaweedfs' && !opts.principal) {
      throw new AppError(400, 'MANAGED_STORAGE_IAM_PRINCIPAL_REQUIRED', 'SeaweedFS access keys require a principal');
    }
    if (action !== 'list_keys') await this.assertNodeMutable(nodeId);
    const iam = {
      action,
      targetAccessKey: opts.targetAccessKey ?? '',
      targetSecretKey: opts.targetSecretKey ?? '',
      name: opts.name ?? '',
      policy: opts.policy ?? '',
      expiresAt: opts.expiresAt ?? '',
    };
    return this.registry.sendCommand(
      nodeId,
      {
        dockerStorage: {
          action: storageAction,
          managedStorageId,
          configJson: JSON.stringify({
            version: 1,
            // SeaweedFS keys belong to their own IAM user: create_key creates the
            // principal, attaches `policy`, then adds `targetAccessKey`/
            // `targetSecretKey` (or, with `expiresAt`, a daemon-generated
            // expiring service account); remove_key deletes the whole principal.
            ...(engine === 'seaweedfs' ? { engine } : {}),
            rootCredentials: { accessKey: opts.rootAccessKey, secretKey: opts.rootSecretKey },
            tls: opts.useTls ? { caPem: opts.caPem ?? '', serverName: opts.serverName ?? '' } : undefined,
            iam: engine === 'seaweedfs' ? { ...iam, principal: opts.principal } : iam,
          }),
        } as any,
      },
      timeoutMs ?? managedStorageCommandTimeoutMs
    );
  }

  async sendDockerBackupCommand(
    nodeId: string,
    action: string,
    runId: string,
    configJson = '',
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertStorageNodeCapability(nodeId, 'database_backups_v1');
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      { dockerBackup: { action, runId, configJson } as any },
      timeoutMs ?? managedBackupCommandTimeoutMs
    );
  }

  async sendManagedDatabaseLogsCommand(
    nodeId: string,
    managedDatabaseId: string,
    options: {
      tailLines?: number;
      follow?: boolean;
      timestamps?: boolean;
      since?: string;
      until?: string;
    } = {}
  ): Promise<CommandResult> {
    await this.assertDatabaseNode(nodeId);
    return this.registry.sendCommand(nodeId, {
      dockerDatabase: {
        action: 'logs',
        managedDatabaseId,
        configJson: JSON.stringify(options),
      } as any,
    });
  }

  async stopManagedDatabaseLogStream(nodeId: string, managedDatabaseId: string): Promise<CommandResult> {
    await this.assertDatabaseNode(nodeId);
    return this.registry.sendCommand(nodeId, {
      dockerDatabase: { action: 'logs_stop', managedDatabaseId, configJson: '{}' } as any,
    });
  }

  async sendRelayGrantBundle(nodeId: string, bundle: RelayGrantBundle, timeoutMs = 30_000): Promise<CommandResult> {
    await this.assertGenericRelayNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        syncRelayGrants: {
          policyRevision: bundle.revision,
          generatedAtUnixMs: bundle.generatedAtUnixMs,
          dataLanes: bundle.dataLanes ?? 4,
          readChunkBytes: bundle.readChunkBytes ?? 32 * 1024,
          grants: bundle.grants.map((assignment) => ({
            role: assignment.role,
            ownerKind: assignment.ownerKind,
            ownerId: assignment.ownerId,
            endpointId: assignment.endpointId,
            routeId: assignment.routeId,
            targetEndpointId: assignment.targetEndpointId,
            grant: assignment.grant,
            schemaVersion: assignment.schemaVersion,
            candidates: assignment.candidates,
            managedDatabaseListener: assignment.managedDatabaseListener,
            secureLinkEgress: assignment.secureLinkEgress,
            streamResume: assignment.streamResume,
            resumeRoutes: assignment.resumeRoutes ?? [],
          })),
          relayLatencyTargets: bundle.relayLatencyTargets ?? [],
          revocationFences: bundle.revocationFences ?? [],
        },
      },
      timeoutMs
    );
  }

  async sendRelayPolicy(
    nodeId: string,
    applySnapshotRequest: Buffer,
    revision: string,
    expiresAtUnix: string,
    timeoutMs = 30_000
  ): Promise<CommandResult> {
    await this.assertRelaySupervisorNode(nodeId);
    return this.registry.sendCommand(
      nodeId,
      { syncRelayPolicy: { applySnapshotRequest, revision, expiresAtUnix } },
      timeoutMs
    );
  }

  async setRelayDrain(
    nodeId: string,
    enabled: boolean,
    forceDisconnect = false,
    timeoutMs = 30_000
  ): Promise<CommandResult> {
    await this.assertRelaySupervisorNode(nodeId);
    return this.registry.sendCommand(nodeId, { setRelayDrain: { enabled, forceDisconnect } }, timeoutMs);
  }

  /**
   * The runtime of relay routes as a remote relay counts them, from its supervisor (relay_route_runtime_v1); null when
   * the node is not connected or its supervisor does not answer it (an older relay daemon).
   */
  async getRelayRouteRuntime(nodeId: string, routeIds: string[], timeoutMs = 2_000): Promise<CommandResult | null> {
    if (!this.registry.hasCapability(nodeId, RELAY_ROUTE_RUNTIME_CAPABILITY)) return null;
    return this.registry.sendCommand(nodeId, { getRelayRouteRuntime: { routeIds } }, timeoutMs);
  }

  /** Installs a renewed relay server certificate on a remote relay supervisor's worker. */
  async renewRelayIdentity(
    nodeId: string,
    renewal: {
      serverCertificate: Buffer;
      serverKey: Buffer;
      serverIdentity: string;
      retainServerFingerprint: string;
    },
    timeoutMs = 90_000
  ): Promise<CommandResult> {
    await this.assertRelaySupervisorNode(nodeId);
    return this.registry.sendCommand(nodeId, { renewRelayIdentity: renewal }, timeoutMs);
  }

  async sendRelayWorkerUpdate(
    nodeId: string,
    downloadUrl: string,
    targetVersion: string,
    checksum: string,
    signedManifest: string
  ): Promise<CommandResult> {
    await this.assertRelaySupervisorNode(nodeId);
    return this.registry.sendCommand(
      nodeId,
      { updateRelayWorker: { downloadUrl, targetVersion, checksum, signedManifest } },
      daemonUpdateCommandTimeoutMs
    );
  }

  async probeRelayCandidate(
    nodeId: string,
    input: {
      probeId: string;
      role: 'source' | 'target';
      endpointId: string;
      routeId?: string;
      assignmentGeneration: string;
      candidate: NonNullable<RelayGrantBundle['grants'][number]['candidates']>[number];
    },
    timeoutMs = 15_000
  ): Promise<CommandResult> {
    await this.assertGenericRelayNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, { probeRelayCandidate: input }, timeoutMs);
  }

  async sendProxySecureLinks(
    nodeId: string,
    bindings: Array<{
      linkId: string;
      role: 'source' | 'target';
      generation: number;
      listenerPort?: number;
      targetNetwork?: string;
      targetContainer?: string;
      targetHost?: string;
      targetPort?: number;
      connectorImage?: string;
      allowNetworkReselection?: boolean;
      sourceConfigManaged?: boolean;
      rotateListener?: boolean;
      socketOnly?: boolean;
      dormant?: boolean;
      availabilityPolicyId?: string;
      availabilityCandidateId?: string;
      loopbackAddress?: string;
    }>,
    timeoutMs = 60_000
  ): Promise<CommandResult> {
    await this.assertProxySecureLinkNode(
      nodeId,
      bindings.some((binding) => binding.role === 'source' && binding.socketOnly === true)
    );
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        syncProxySecureLinks: {
          bindings: bindings.map((binding) => ({ ...binding, generation: String(binding.generation) })),
        },
      },
      timeoutMs
    );
  }

  async sendDockerRegistryBindings(
    nodeId: string,
    bindings: Array<{
      bindingId: string;
      role: 'builder' | 'runtime' | 'mirror';
      generation: number;
      repository: string;
      actions: Array<'pull' | 'push'>;
      localAddress: '127.0.0.1';
      localPort: number;
      relayOwnerKind: 'registry_secure_link';
      relayOwnerId: string;
      authorization: string;
      authorizationExpiresAtUnix: number;
    }>,
    timeoutMs = 30_000
  ): Promise<CommandResult> {
    await this.assertDockerRegistryProxyNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        syncDockerRegistryBindings: {
          bindings: bindings.map((binding) => ({
            ...binding,
            generation: String(binding.generation),
            authorizationExpiresAtUnix: String(binding.authorizationExpiresAtUnix),
          })),
        },
      },
      timeoutMs
    );
  }

  async sendNginxRegistryBindings(
    nodeId: string,
    bindings: Array<{
      bindingId: string;
      role: 'ingress';
      generation: number;
      repository: '*';
      actions: ['pull', 'push'];
      localAddress: '127.0.0.1';
      localPort: number;
      relayOwnerKind: 'registry_ingress';
      relayOwnerId: string;
      authorization: '';
      authorizationExpiresAtUnix: 0;
    }>,
    timeoutMs = 30_000
  ): Promise<CommandResult> {
    await this.assertNginxRegistryIngressNode(nodeId, bindings.length > 0);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        syncDockerRegistryBindings: {
          bindings: bindings.map((binding) => ({
            ...binding,
            generation: String(binding.generation),
            authorizationExpiresAtUnix: '0',
          })),
        },
      },
      timeoutMs
    );
  }

  async probeProxySecureLink(
    nodeId: string,
    input: {
      linkId: string;
      scheme: 'http' | 'https';
      path: string;
      expectedStatus?: number | null;
      expectedBody?: string | null;
      bodyMatchMode?: string | null;
      timeoutSeconds?: number;
    }
  ): Promise<{ ok: boolean; httpStatus?: number; responseMs?: number; error?: string }> {
    await this.assertProxySecureLinkNode(nodeId);
    const result = await this.registry.sendCommand(
      nodeId,
      {
        probeProxySecureLink: {
          linkId: input.linkId,
          scheme: input.scheme,
          path: input.path,
          expectedStatus: input.expectedStatus ?? 0,
          expectedBody: input.expectedBody ?? '',
          bodyMatchMode: input.bodyMatchMode ?? 'includes',
          timeoutSeconds: input.timeoutSeconds ?? 10,
        },
      },
      ((input.timeoutSeconds ?? 10) + 5) * 1000
    );
    if (!result.success) return { ok: false, error: result.error || 'Secure Link probe failed' };
    try {
      return JSON.parse(result.detail || '{}') as { ok: boolean; httpStatus?: number; responseMs?: number };
    } catch {
      return { ok: false, error: 'Nginx daemon returned an invalid Secure Link probe result' };
    }
  }

  async probePagesRoute(
    nodeId: string,
    input: {
      routeId: string;
      domain: string;
      tls: boolean;
      path: string;
      expectedStatus?: number | null;
      expectedBody?: string | null;
      bodyMatchMode?: string | null;
      timeoutSeconds?: number;
    }
  ): Promise<{ ok: boolean; skipped?: boolean; httpStatus?: number; responseMs?: number; error?: string }> {
    const [node] = await this.db
      .select({ type: nodes.type, capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    const reported = (node.capabilities as Record<string, unknown> | null)?.capabilities;
    if (node.type !== 'nginx' || !Array.isArray(reported) || !reported.includes('nginx_pages_route_probe_v1')) {
      return { ok: false, skipped: true, error: 'Pages Route health probe requires an updated Nginx daemon' };
    }
    const result = await this.registry.sendCommand(
      nodeId,
      {
        probePagesRoute: {
          routeId: input.routeId,
          domain: input.domain,
          tls: input.tls,
          path: input.path,
          expectedStatus: input.expectedStatus ?? 0,
          expectedBody: input.expectedBody ?? '',
          bodyMatchMode: input.bodyMatchMode ?? 'includes',
          timeoutSeconds: input.timeoutSeconds ?? 10,
        },
      },
      ((input.timeoutSeconds ?? 10) + 5) * 1000
    );
    if (!result.success) return { ok: false, error: result.error || 'Pages Route probe failed' };
    try {
      const parsed = JSON.parse(result.detail || '{}') as {
        ok?: unknown;
        httpStatus?: number;
        responseMs?: number;
      };
      if (typeof parsed.ok !== 'boolean') throw new Error('missing probe outcome');
      return { ok: parsed.ok, httpStatus: parsed.httpStatus, responseMs: parsed.responseMs };
    } catch {
      return { ok: false, error: 'Nginx daemon returned an invalid Pages Route probe result' };
    }
  }

  private async assertProxySecureLinkNode(nodeId: string, requireSocketOnly = false) {
    const [node] = await this.db
      .select({ capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    const reported = (node.capabilities as Record<string, unknown> | null)?.capabilities;
    if (!Array.isArray(reported) || !reported.includes('proxy_secure_links_v1')) {
      throw new AppError(
        409,
        'PROXY_SECURE_LINK_UPDATE_REQUIRED',
        'Update both Nginx and Docker daemons before creating this Docker proxy link'
      );
    }
    if (requireSocketOnly && !reported.includes(NGINX_SECURE_LINK_SOCKET_ONLY_CAPABILITY)) {
      throw new AppError(
        409,
        'PROXY_SECURE_LINK_UPDATE_REQUIRED',
        'Update the Nginx daemon before enabling socket-only Secure Links'
      );
    }
  }

  private async assertDockerRegistryProxyNode(nodeId: string) {
    const [node] = await this.db
      .select({ capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    const reported = (node.capabilities as Record<string, unknown> | null)?.capabilities;
    if (!Array.isArray(reported) || !reported.includes('docker_registry_proxy_v1')) {
      throw new AppError(
        409,
        'DOCKER_REGISTRY_PROXY_UPDATE_REQUIRED',
        'Update the Docker daemon before enabling internal registry access on this node'
      );
    }
  }

  private async assertNginxRegistryIngressNode(nodeId: string, requireSocketOnly = false) {
    const [node] = await this.db
      .select({ type: nodes.type, capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    const reported = (node.capabilities as Record<string, unknown> | null)?.capabilities;
    if (node.type !== 'nginx' || !Array.isArray(reported) || !reported.includes('nginx_registry_ingress_v1')) {
      throw new AppError(
        409,
        'NGINX_REGISTRY_INGRESS_UPDATE_REQUIRED',
        'Update the selected Nginx daemon before enabling external registry access'
      );
    }
    if (requireSocketOnly && !reported.includes(NGINX_SECURE_LINK_SOCKET_ONLY_CAPABILITY)) {
      throw new AppError(
        409,
        'NGINX_REGISTRY_INGRESS_UPDATE_REQUIRED',
        'Update the selected Nginx daemon before enabling socket-only registry ingress'
      );
    }
  }

  private async assertGenericRelayNode(nodeId: string) {
    const [node] = await this.db
      .select({ capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    const reported = (node.capabilities as Record<string, unknown> | null)?.capabilities;
    if (!Array.isArray(reported) || !reported.includes('generic_relay_tunnel_v1')) {
      throw new AppError(409, 'NODE_CAPABILITY_MISMATCH', 'Node daemon does not support generic relay grants');
    }
  }

  private async assertRelaySupervisorNode(nodeId: string) {
    const [node] = await this.db
      .select({ type: nodes.type, capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    const reported = (node.capabilities as Record<string, unknown> | null)?.capabilities;
    if (node.type !== 'relay' || !Array.isArray(reported) || !reported.includes('relay_pool_v1')) {
      throw new AppError(409, 'NODE_CAPABILITY_MISMATCH', 'Node is not a pool-capable relay supervisor');
    }
  }

  async assertPagesPreviewRevocation(nodeId: string): Promise<void> {
    await this.assertPagesNode(nodeId, 'nginx_pages_preview_revocation_v1');
  }

  async supportsPagesReconciliation(nodeId: string): Promise<boolean> {
    const [node] = await this.db
      .select({ type: nodes.type, status: nodes.status, capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    const reported = (node?.capabilities as Record<string, unknown> | null)?.capabilities;
    return (
      node?.type === 'nginx' &&
      node.status === 'online' &&
      Array.isArray(reported) &&
      reported.includes('nginx_pages_reconcile_v1')
    );
  }

  private async assertPagesNode(nodeId: string, requiredCapability = 'nginx_pages_v1'): Promise<void> {
    const [node] = await this.db
      .select({ type: nodes.type, status: nodes.status, capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    const reported = (node.capabilities as Record<string, unknown> | null)?.capabilities;
    if (
      node.type !== 'nginx' ||
      node.status !== 'online' ||
      !Array.isArray(reported) ||
      !reported.includes(requiredCapability)
    ) {
      throw new AppError(409, 'PAGES_DAEMON_UPDATE_REQUIRED', 'Update the selected Nginx daemon to use Pages');
    }
  }

  async sendPagesCommand<T extends Record<string, unknown> = Record<string, unknown>>(
    nodeId: string,
    command: Partial<GatewayCommand>,
    timeoutMs = 120_000
  ): Promise<T> {
    await this.assertNodeMutable(nodeId);
    await this.assertPagesNode(nodeId);
    const result = await this.registry.sendCommand(nodeId, command, timeoutMs);
    if (!result.success) {
      throw new AppError(502, 'PAGES_DAEMON_COMMAND_FAILED', 'Nginx daemon could not apply the Pages change');
    }
    if (!result.data?.length) return {} as T;
    try {
      return JSON.parse(result.data.toString('utf8')) as T;
    } catch {
      throw new AppError(502, 'PAGES_DAEMON_RESPONSE_INVALID', 'Nginx daemon returned an invalid Pages response');
    }
  }

  async sendPagesRuntimeConfigCommand<T extends Record<string, unknown> = Record<string, unknown>>(
    nodeId: string,
    command: Partial<GatewayCommand>,
    timeoutMs = 120_000
  ): Promise<T> {
    await this.assertNodeMutable(nodeId);
    await this.assertPagesNode(nodeId, 'nginx_pages_config_v1');
    const result = await this.registry.sendCommand(nodeId, command, timeoutMs);
    if (!result.success) {
      throw new AppError(
        502,
        'PAGES_RUNTIME_CONFIG_COMMAND_FAILED',
        'Nginx daemon could not publish runtime configuration'
      );
    }
    if (!result.data?.length) return {} as T;
    try {
      return JSON.parse(result.data.toString('utf8')) as T;
    } catch {
      throw new AppError(502, 'PAGES_DAEMON_RESPONSE_INVALID', 'Nginx daemon returned an invalid Pages response');
    }
  }

  async sendDockerContainerCommand(
    nodeId: string,
    action: string,
    options: {
      containerId?: string;
      configJson?: string;
      timeoutSeconds?: number;
      signal?: string;
      newName?: string;
      force?: boolean;
    } = {},
    timeoutMs?: number,
    /** The command ID to send under (an update's or recreate's task records it to ask the daemon for it later). */
    commandId?: string
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    if (!['list', 'inspect', 'stats', 'top', 'http_probe', 'task_status'].includes(action)) {
      await this.assertNodeMutable(nodeId);
    }
    return this.registry.sendCommand(
      nodeId,
      {
        ...(commandId ? { commandId } : {}),
        dockerContainer: { action, ...options } as any,
      },
      timeoutMs
    );
  }

  /** Disconnects a container from all its networks (docker_network_isolation_v1); Detail lists what was removed. */
  async isolateContainerNetworks(nodeId: string, container: string): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      { dockerContainer: { action: 'network_isolate', containerId: container } as any },
      60_000
    );
  }

  /** Reconnects a container to the endpoints network_isolate removed; Detail reports each network. */
  async restoreContainerNetworks(nodeId: string, container: string, endpoints: unknown[]): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        dockerContainer: {
          action: 'network_restore',
          containerId: container,
          configJson: JSON.stringify({ endpoints }),
        } as any,
      },
      60_000
    );
  }

  async sendDockerImageCommand(
    nodeId: string,
    action: string,
    options: {
      imageRef?: string;
      targetImageRef?: string;
      registryAuthJson?: string;
      force?: boolean;
    } = {},
    timeoutMs?: number,
    /** The command ID to send under (a pull's task records it to learn the pull's outcome later). */
    commandId?: string
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    if (action !== 'list' && action !== 'pull_status') {
      await this.assertNodeMutable(nodeId);
    }
    return this.registry.sendCommand(
      nodeId,
      {
        ...(commandId ? { commandId } : {}),
        dockerImage: { action, ...options } as any,
      },
      timeoutMs
    );
  }

  async sendDockerVolumeCommand(
    nodeId: string,
    action: string,
    options: {
      name?: string;
      labels?: Record<string, string>;
      force?: boolean;
      path?: string;
      maxBytes?: number;
      newName?: string;
      content?: string | Buffer;
      targetPath?: string;
      storageKind?: 'regular' | 'disk-image';
      capacityBytes?: number;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    if (!['list', 'inspect', 'metrics'].includes(action)) {
      await this.assertNodeMutable(nodeId);
    }
    const payload = {
      ...options,
      content: typeof options.content === 'string' ? Buffer.from(options.content) : options.content,
    };
    return this.registry.sendCommand(
      nodeId,
      {
        dockerVolume: { action, ...payload } as any,
      },
      timeoutMs
    );
  }

  async sendDockerRuntimeCommand(
    nodeId: string,
    action: 'preflight' | 'install',
    timeoutMs = action === 'install' ? 30 * 60 * 1000 : 2 * 60 * 1000
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    if (action === 'install') await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, { dockerRuntime: { action, runtime: 'runsc' } as any }, timeoutMs);
  }

  async sendDockerNetworkCommand(
    nodeId: string,
    action: string,
    options: {
      networkId?: string;
      containerId?: string;
      driver?: string;
      subnet?: string;
      gatewayAddr?: string;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    if (action !== 'list') {
      await this.assertNodeMutable(nodeId);
    }
    return this.registry.sendCommand(
      nodeId,
      {
        dockerNetwork: { action, ...options } as any,
      },
      timeoutMs
    );
  }

  async sendDockerDeploymentCommand(
    nodeId: string,
    action: string,
    options: {
      deploymentId?: string;
      slot?: string;
      configJson?: string;
      force?: boolean;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    if (action !== 'inspect') {
      await this.assertNodeMutable(nodeId);
    }
    return this.registry.sendCommand(
      nodeId,
      {
        dockerDeployment: { action, ...options } as any,
      },
      timeoutMs
    );
  }

  async sendDockerComposeCommand(
    nodeId: string,
    action: string,
    options: {
      operationId: string;
      projectId: string;
      projectName: string;
      revisionId?: string;
      configDigest?: string;
      composeYaml?: Buffer;
      normalizedModelJson?: string;
      variables?: Record<string, string>;
      secrets?: Record<string, string>;
      removeOrphans?: boolean;
      volumeNames?: string[];
    },
    timeoutMs = dockerComposeCommandTimeoutMs
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    await this.assertNodeMutable(nodeId);
    if (!this.registry.hasCapability(nodeId, 'docker_compose_v1')) {
      throw new AppError(
        409,
        'COMPOSE_CAPABILITY_UNAVAILABLE',
        'The connected Docker daemon does not support first-class Compose operations'
      );
    }
    const { composeYaml, normalizedModelJson } = this.registry.hasCapability(nodeId, 'compose_logging_v1')
      ? options
      : withoutComposeLogging(options.composeYaml, options.normalizedModelJson);
    return this.registry.sendCommand(
      nodeId,
      {
        dockerCompose: {
          action,
          operationId: options.operationId,
          projectId: options.projectId,
          projectName: options.projectName,
          revisionId: options.revisionId ?? '',
          configDigest: options.configDigest ?? '',
          composeYaml: composeYaml ?? Buffer.alloc(0),
          normalizedModelJson: normalizedModelJson ?? '',
          variables: options.variables ?? {},
          secrets: options.secrets ?? {},
          removeOrphans: options.removeOrphans ?? false,
          volumeNames: options.volumeNames ?? [],
        },
      },
      timeoutMs
    );
  }

  async sendDockerExecCommand(
    nodeId: string,
    action: string,
    options: {
      containerId?: string;
      command?: string[];
      tty?: boolean;
      stdin?: boolean;
      rows?: number;
      cols?: number;
      user?: string;
      sessionKey?: string;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        dockerExec: { action, ...options } as any,
      },
      timeoutMs
    );
  }

  async sendNodeExecCommand(
    nodeId: string,
    action: string,
    options: {
      command?: string[];
      tty?: boolean;
      rows?: number;
      cols?: number;
      sessionKey?: string;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    assertNodeHostFeatureEnabled(this.registry, nodeId, 'console');
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        nodeExec: { action, ...options } as any,
      },
      timeoutMs
    );
  }

  async sendNodeFileCommand(
    nodeId: string,
    action: string,
    options: {
      path?: string;
      targetPath?: string;
      maxBytes?: number;
      content?: string | Buffer;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    // ensure-host-identity is Gateway's own fixed operation, not host file access.
    if (action !== 'ensure-host-identity') assertNodeHostFeatureEnabled(this.registry, nodeId, 'files');
    if (!['list', 'read'].includes(action)) {
      await this.assertNodeMutable(nodeId);
    }
    const { content, ...rest } = options;
    const payload: Record<string, unknown> = { action, ...rest };
    if (Buffer.isBuffer(content)) {
      payload.content = content;
    } else if (content != null) {
      payload.content = Buffer.from(content);
    }
    const command = { nodeFile: payload as any };
    return timeoutMs === undefined
      ? this.registry.sendCommand(nodeId, command)
      : this.registry.sendCommand(nodeId, command, timeoutMs);
  }

  async sendDockerFileCommand(
    nodeId: string,
    action: string,
    options: {
      containerId?: string;
      path?: string;
      targetPath?: string;
      maxBytes?: number;
      content?: string | Buffer;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    if (!['list', 'read'].includes(action)) {
      await this.assertNodeMutable(nodeId);
    }
    const { content, ...rest } = options;
    const payload: Record<string, unknown> = { action, ...rest };
    if (Buffer.isBuffer(content)) {
      payload.content = content;
    } else if (content != null) {
      payload.content = Buffer.from(content);
    }
    const command = { dockerFile: payload as any };
    return timeoutMs === undefined
      ? this.registry.sendCommand(nodeId, command)
      : this.registry.sendCommand(nodeId, command, timeoutMs);
  }

  async sendDockerLogsCommand(
    nodeId: string,
    containerId: string,
    options: {
      tailLines?: number;
      follow?: boolean;
      timestamps?: boolean;
      since?: string;
      until?: string;
    } = {},
    timeoutMs?: number
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    return this.registry.sendCommand(
      nodeId,
      {
        dockerLogs: { containerId, ...options } as any,
      },
      timeoutMs
    );
  }

  async sendDockerConfigPush(
    nodeId: string,
    registries: Array<{ url: string; username: string; password: string }>,
    allowlist: string[]
  ): Promise<CommandResult> {
    await this.assertGenericDockerNode(nodeId);
    await this.assertNodeMutable(nodeId);
    return this.registry.sendCommand(nodeId, {
      dockerConfigPush: { registries, allowlist },
    });
  }

  /** Fire-and-forget exec input (no response expected) */
  sendExecInput(nodeId: string, execId: string, data: Buffer): void {
    try {
      this.registry.sendCommandNoWait(nodeId, {
        execInput: { execId, data },
      });
    } catch {
      /* ignore */
    }
  }

  /** Get the default nginx node ID, or null if none configured */
  /** Get the first online nginx node ID, or null if none available */
  async getFirstNginxNodeId(): Promise<string | null> {
    const [node] = await this.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.type, 'nginx'), eq(nodes.status, 'online')))
      .limit(1);
    return node?.id ?? null;
  }

  /** Resolve the node ID for a proxy host, falling back to default node */
  async sendUpdateDaemonCommand(
    nodeId: string,
    downloadUrl: string,
    targetVersion: string,
    checksum: string,
    signedManifest: string
  ): Promise<DispatchedCommand> {
    if (!this.registry.getNode(nodeId)) {
      throw new AppError(409, 'NODE_NOT_CONNECTED', 'Node is not connected');
    }
    return this.registry.dispatchCommand(
      nodeId,
      { updateDaemon: { downloadUrl, targetVersion, checksum, signedManifest } },
      daemonUpdateCommandTimeoutMs
    );
  }

  async resolveNodeId(proxyHostNodeId: string | null): Promise<string> {
    if (proxyHostNodeId) return proxyHostNodeId;
    throw new Error('No node assigned to this proxy host');
  }
}
