/**
 * TypeScript types matching proto/opfield/v1/nginx-daemon.proto
 * These are used with @grpc/proto-loader for runtime loading.
 */

import type { DockerMigrationCommand } from './migration-types.js';

export type * from './migration-types.js';

// ─── Enrollment ─────────────────────────────────────────────────────

export interface EnrollRequest {
  token: string;
  hostname: string;
  nginxVersion: string;
  osInfo: string;
  daemonVersion: string;
  daemonType: string;
  hostIdentityId: string;
}

export interface EnrollResponse {
  nodeId: string;
  caCertificate: Buffer;
  clientCertificate: Buffer;
  clientKey: Buffer;
  certExpiresAt: string; // int64 as string
  hostIdentityId: string;
  relayPoolId: string;
  relayInstanceId: string;
  policySigningKeyId: string;
  policySigningPublicKey: Buffer;
  policySigningPublicKeyFingerprint: string;
  relayServerCertificate: Buffer;
  relayServerKey: Buffer;
  relayServerIdentity: string;
}

export interface RenewCertRequest {
  nodeId: string;
}

export interface RenewCertResponse {
  clientCertificate: Buffer;
  clientKey: Buffer;
  certExpiresAt: string;
  relayServerCertificate?: Buffer;
  relayServerKey?: Buffer;
  relayServerIdentity?: string;
}

export interface MaintenanceAccessRedeemRequest {
  hostId: string;
  code: string;
}

export interface MaintenanceAccessReply {
  allowed: boolean;
  sessionToken: string;
}

// ─── Daemon Messages (daemon → Opfield) ─────────────────────────────

export interface DaemonMessage {
  register?: RegisterMessage;
  commandResult?: CommandResult;
  healthReport?: HealthReport;
  statsReport?: StatsReport;
  daemonLog?: DaemonLogEntry;
  execOutput?: ExecOutput;
  dockerRuntimeStatus?: DockerRuntimeStatus;
  relayRuntimeStatus?: RelayRuntimeStatus;
  dockerBuildEvent?: DockerBuildEvent;
}

export interface DockerBuildEvent {
  buildId: string;
  status: string;
  sequence: string;
  logChunk: Buffer;
  progressJson: string;
  artifactRepository: string;
  artifactDigest: string;
  artifactSizeBytes: string;
  platform: string;
  sbomDigest: string;
  provenanceDigest: string;
  scanSummaryJson: string;
  policyDecision: string;
  errorCode: string;
  errorMessage: string;
  occurredAtUnixMs: string;
  attempt?: number;
}

export interface DaemonLogEntry {
  timestamp: string;
  level: string;
  message: string;
  component: string;
  fields: Record<string, string>;
}

export interface RegisterMessage {
  nodeId: string;
  hostname: string;
  nginxVersion: string;
  configVersionHash: string;
  daemonVersion: string;
  nginxUptimeSeconds: string;
  nginxRunning: boolean;
  cpuModel: string;
  cpuCores: number;
  architecture: string;
  kernelVersion: string;
  daemonType: string;
  capabilities: string[];
  dockerRuntimeStatus?: DockerRuntimeStatus;
  hostIdentityId: string;
  relayInstanceId: string;
  /** Empty for a launcher that predates reporting it. */
  launcherVersion?: string;
}

export interface RelayRuntimeStatus {
  relayInstanceId: string;
  state: string;
  buildVersion: string;
  protocolMajor: number;
  capabilities: string[];
  appliedPolicyRevision: string;
  policyExpiresAtUnix: string;
  registeredEndpoints: string;
  activeTunnels: string;
  pressurePercent: number;
  draining: boolean;
  error: string;
  advertisedAddresses: string[];
  servicePort: number;
  assignmentTunnels: RelayAssignmentTunnelCount[];
  policySigningKeyIds: string[];
  /** The relay's acceptor and gate view; relays advertising availability_lease_v1. */
  availabilityLease?: AvailabilityLeaseReport | null;
  /** Local witness hosting gate (relay_witness_v1): allowed | protected_needs_opt_in | disabled. */
  witnessHosting?: string;
  witnesses?: WitnessStatus[];
  appliedWitnessRevision?: string;
}

export interface RelayAssignmentTunnelCount {
  endpointId: string;
  assignmentGeneration: string;
  activeTunnels: string;
}

export interface CommandResult {
  commandId: string;
  success: boolean;
  error: string;
  detail: string;
  data: Buffer;
}

export interface GpuDevice {
  id: string;
  vendor: string;
  model: string;
  pciAddress: string;
  renderNode: string;
  deviceIndex: number;
  attachable: boolean;
  unavailableReason: string;
  partitioned: boolean;
  utilizationPercent: number;
  memoryTotalBytes: string;
  memoryUsedBytes: string;
  temperatureCelsius: number;
  powerWatts: number;
  powerLimitWatts: number;
  throttled: boolean;
  eccCorrectedErrors: string;
  eccUncorrectedErrors: string;
  health: string;
  availableMetrics: string[];
}

export interface HealthReport {
  nginxRunning: boolean;
  configValid: boolean;
  nginxUptimeSeconds: string;
  workerCount: number;
  nginxVersion: string;
  cpuPercent: number;
  memoryBytes: string;
  diskFreeBytes: string;
  timestamp: string;
  // New fields (add after timestamp)
  loadAverage1m: number;
  loadAverage5m: number;
  loadAverage15m: number;
  systemMemoryTotalBytes: string;
  systemMemoryUsedBytes: string;
  systemMemoryAvailableBytes: string;
  swapTotalBytes: string;
  swapUsedBytes: string;
  systemUptimeSeconds: string;
  openFileDescriptors: string;
  maxFileDescriptors: string;
  diskMounts: Array<{
    mountPoint: string;
    filesystem: string;
    device: string;
    totalBytes: string;
    usedBytes: string;
    freeBytes: string;
    usagePercent: number;
    /** root, docker_root, opfield_state, managed_image or data; empty from daemons before 2.12.3. */
    role?: string;
    /** The filesystem's identity on its host, shared by the nodes enrolled there (field 20); empty before 2.12.3. */
    diskId?: string;
  }>;
  diskReadBytes: string;
  diskWriteBytes: string;
  networkInterfaces: Array<{
    name: string;
    rxBytes: string;
    txBytes: string;
    rxPackets: string;
    txPackets: string;
    rxErrors: string;
    txErrors: string;
    ipAddresses: string[];
  }>;
  localIpAddresses: string[];
  publicIpAddresses: string[];
  nginxRssBytes: string;
  errorRate4xx: number;
  errorRate5xx: number;
  // Docker
  containerStats: ContainerStats[];
  dockerVersion: string;
  containersRunning: number;
  containersStopped: number;
  containersTotal: number;
  gpuDevices: GpuDevice[];
  /** Present when the daemon advertises availability_lease_v1. */
  availabilityLease?: AvailabilityLeaseReport | null;
  relayLatencies?: RelayLatencySample[];
  /** Docker daemons advertising managed_link_runtime_v1: the node's managed links (field 37). */
  managedLinks?: ManagedLinkRuntime[];
  /** Daemons advertising relay_stream_resume_v1: their relay stream sessions (field 41). */
  relayStreams?: RelayStreamStats | null;
  /** Docker and nginx daemons: the connections an update keeps and cuts now, and what the last one did (field 42). */
  updateConnections?: DaemonUpdateConnections | null;
  /** Nginx daemons: a problem of the host's nginx service only root can fix, with the command that fixes it (field 43). */
  nginxServiceProblem?: string;
  /** Daemons of 2.12.1 and later: objects still under their pre-Opfield names, by kind (field 44). */
  legacyNames?: Record<string, number>;
  /** Docker daemons: the build of the node's lease watchdog from its heartbeat; empty when none runs (field 45). */
  leaseWatchdogVersion?: string;
  /** Daemons of 2.12.3 and later: SHA256 fingerprints of the host's SSH host keys; none from a protected relay (field 46). */
  sshHostKeyFingerprints?: string[];
  /** Present when the daemon advertises ingress_group_v1 (field 195). */
  ingressHealth?: IngressHealthReport | null;
  /** Storage-profile docker daemons: their availability set members. */
  availabilityMembers?: AvailabilityMemberReport[];
  /** Nginx daemons advertising nginx_log_budget_v1: the nginx logs their log budget bounds (field 210). */
  nginxLogs?: NginxLogUsage | null;
  /** Docker daemons of 2.12.3 and later (not build workers): whether Docker can start containers (field 215). */
  dockerEngineHealth?: DockerEngineHealth | null;
}

/** Whether a node's Docker Engine can start containers. int64 fields arrive as strings. */
export interface DockerEngineHealth {
  available: boolean;
  component?: string;
  problem?: string;
  checkedAtUnixMs?: string | number;
  unavailableSinceUnixMs?: string | number;
}

/** The nginx logs a daemon bounds (nginx_log_budget_v1). uint64/int64 fields may arrive as strings. */
export interface NginxLogUsage {
  bytes?: number | string;
  files?: number;
  /** Modification time of the oldest file; 0 when there is none. */
  oldestUnix?: number | string;
  budgetBytes?: number | string;
  maxFileBytes?: number | string;
  /** 0: no age limit. */
  retentionDays?: number;
}

/**
 * Connections across an update of the daemon. A daemon advertising daemon_stream_handover_v1 hands its relay stream
 * sessions over to the next daemon process; what it cannot hand over is cut. Cut classes are an open set (raw_stream,
 * postgres_tls, registry, backup, no_handover, service_restart, ...); maps decode to plain objects.
 */
export interface DaemonUpdateConnections {
  handoverAvailable?: boolean;
  kept?: number;
  cut?: Record<string, number>;
  /** Present once the counts of the last update are final. */
  lastUpdate?: DaemonUpdateConnectionReport | null;
}

/** What one update of the daemon did to the connections it carried. */
export interface DaemonUpdateConnectionReport {
  fromVersion?: string;
  toVersion?: string;
  /** int64 as string (proto-loader). */
  startedAtUnixMs?: string;
  /** int64 as string (proto-loader). */
  finishedAtUnixMs?: string;
  handover?: boolean;
  handedOver?: number;
  kept?: number;
  /** Also handshake, over_limit, resume_failed, busy. */
  cut?: Record<string, number>;
  pauseP50Ms?: number;
  pauseP99Ms?: number;
  pauseMaxMs?: number;
}

/** Relay stream sessions of one daemon (RSv1). Totals count since the daemon started. uint64 values may be strings. */
export interface RelayStreamStats {
  resumableSessions?: number | string;
  legacySessions?: number | string;
  suspendedSessions?: number | string;
  migrationsOkTotal?: number | string;
  migrationsFailedTotal?: number | string;
  /** Resumable streams that ended abnormally (no relay, resume refused, timeout). */
  cutTotal?: number | string;
  retransmittedBytesTotal?: number | string;
  unackedBytes?: number | string;
  migrationStallP50Ms?: number;
  migrationStallP95Ms?: number;
  byRelay?: RelayStreamRelaySessions[];
  /** Target side: resumes this daemon refused. */
  resumeRefusedTotal?: number | string;
  /** Relay lane connections replaced because their TCP state collapsed or learned a much shorter round trip. */
  laneRotationsTotal?: number | string;
  /** Resumable streams moved off a replaced lane connection (housekeeping, not counted as migrations). */
  laneMovesTotal?: number | string;
}

export interface RelayStreamRelaySessions {
  relayInstanceId: string;
  resumable?: number | string;
  legacy?: number | string;
}

/** What the reserved /.well-known/gateway-ingress-health endpoint answers on the node right now. */
export interface IngressHealthReport {
  serving: boolean;
  reason: string;
  /** int64 as string (proto-loader). */
  configGeneration: string;
  nginxRunning: boolean;
  configApplied: boolean;
  secureLinkSources: number;
  usableRelayTransports: number;
  /** int64 as string (proto-loader). */
  checkedAtUnixMs: string;
}

export interface RelayLatencySample {
  relayInstanceId: string;
  rttMicros: number;
  /** How long the daemon has failed to reach the relay, in ms; 0 while it reaches it. */
  failingMs?: number;
}

/** One managed database or storage link on the node that runs its workloads. */
export interface ManagedLinkRuntime {
  ownerKind: string;
  ownerId: string;
  activeConnections: number;
  connectionLimit: number;
  /** uint64 as string (proto-loader). */
  rejectedTotal: string;
  lastRejectionReason: string;
  /** int64 as string (proto-loader). */
  lastRejectedAtUnixMs: string;
  /** uint64 as string (proto-loader): sessions and bytes the link carried through the node. */
  openedTotal: string;
  sourceToTargetBytes: string;
  targetToSourceBytes: string;
  /** uint64 as string (proto-loader): the sessions of openedTotal that ended (an active one is not). */
  completedTotal?: string;
}

export interface StatsReport {
  activeConnections: string;
  accepts: string;
  handled: string;
  requests: string;
  reading: number;
  writing: number;
  waiting: number;
  timestamp: string;
}

// ─── Opfield Commands (Opfield → daemon) ────────────────────────────

export interface OpfieldCommand {
  commandId: string;
  /** Optional absolute dispatch deadline (Unix ms, int64 as string). Omitted or zero means no deadline. */
  expiresAtUnixMs?: string;
  /** Optional Opfield send time (Unix ms, int64 as string). Daemons judge expiresAtUnixMs against it. */
  sentAtUnixMs?: string;
  applyConfig?: ApplyConfigCommand;
  removeConfig?: RemoveConfigCommand;
  deployCert?: DeployCertCommand;
  removeCert?: RemoveCertCommand;
  fullSync?: FullSyncCommand;
  updateGlobalConfig?: UpdateGlobalConfigCommand;
  deployHtpasswd?: DeployHtpasswdCommand;
  testConfig?: TestConfigCommand;
  requestHealth?: RequestHealthCommand;
  requestStats?: RequestStatsCommand;
  setDaemonLogStream?: SetDaemonLogStreamCommand;
  removeHtpasswd?: RemoveHtpasswdCommand;
  deployAcmeChallenge?: DeployAcmeChallengeCommand;
  removeAcmeChallenge?: RemoveAcmeChallengeCommand;
  readGlobalConfig?: ReadGlobalConfigCommand;
  requestTrafficStats?: RequestTrafficStatsCommand;
  dockerContainer?: DockerContainerCommand;
  dockerImage?: DockerImageCommand;
  dockerVolume?: DockerVolumeCommand;
  dockerNetwork?: DockerNetworkCommand;
  dockerDeployment?: DockerDeploymentCommand;
  dockerCompose?: DockerComposeCommand;
  dockerRuntime?: DockerRuntimeCommand;
  dockerExec?: DockerExecCommand;
  dockerFile?: DockerFileCommand;
  dockerConfigPush?: DockerConfigPushCommand;
  dockerLogs?: DockerLogsCommand;
  execInput?: ExecInput;
  nodeExec?: NodeExecCommand;
  updateDaemon?: UpdateDaemonCommand;
  nodeFile?: NodeFileCommand;
  syncRelayPolicy?: SyncRelayPolicyCommand;
  setRelayDrain?: SetRelayDrainCommand;
  updateRelayWorker?: UpdateRelayWorkerCommand;
  renewRelayIdentity?: RenewRelayIdentityCommand;
  getRelayRouteRuntime?: GetRelayRouteRuntimeCommand;
  /** Relay supervisor only (relay_witness_v1): the full desired set of witness processes. */
  applyWitnesses?: ApplyWitnessesCommand;
  /** Storage-profile docker daemons (managed_availability_member_v1): this node's member of an availability set. */
  availabilityMember?: AvailabilityMemberCommand;
  syncAvailabilityLease?: SyncAvailabilityLeaseCommand;
  availabilityLeaseHandoff?: AvailabilityLeaseHandoffCommand;
  /** Daemons with gateway_next_address_v1: the address Opfield moves to. */
  setOpfieldNextAddress?: SetOpfieldNextAddressCommand;
  /** Nginx daemons with nginx_log_budget_v1: how long rotated nginx logs are kept (Housekeeping "Nginx Logs"). */
  configureNginxLogs?: ConfigureNginxLogsCommand;
  syncDockerRegistryBindings?: SyncDockerRegistryBindingsCommand;
  dockerBuild?: DockerBuildCommand;
  dockerBuildCancel?: DockerBuildCancelCommand;
  dockerBuildEventAck?: DockerBuildEventAck;
  dockerMigration?: DockerMigrationCommand;
  dockerDatabase?: DockerDatabaseCommand;
  dockerStorage?: DockerStorageCommand;
  dockerBackup?: DockerBackupCommand;
  dockerAvailability?: DockerAvailabilityCommand;
  applyTlsBundle?: ApplyTlsBundleCommand;
  inspectCertificates?: InspectCertificatesCommand;
  exportLegacyCertificates?: ExportLegacyCertificatesCommand;
  removeCertificateReplica?: RemoveCertificateReplicaCommand;
  syncRelayGrants?: SyncRelayGrantsCommand;
  syncProxySecureLinks?: SyncProxySecureLinksCommand;
  probeProxySecureLink?: ProbeProxySecureLinkCommand;
  probePagesRoute?: ProbePagesRouteCommand;
  probeRelayCandidate?: ProbeRelayCandidateCommand;
  pagesUploadInit?: PagesUploadInitCommand;
  pagesUploadChunk?: PagesUploadChunkCommand;
  pagesUploadFinalize?: PagesUploadFinalizeCommand;
  pagesVerifyRelease?: PagesVerifyReleaseCommand;
  pagesMaterializePreview?: PagesMaterializePreviewCommand;
  pagesRemovePreview?: PagesRemovePreviewCommand;
  pagesActivateTagRoute?: PagesActivateTagRouteCommand;
  pagesDeactivateTagRoute?: PagesDeactivateTagRouteCommand;
  pagesCleanupDeployment?: PagesCleanupDeploymentCommand;
  pagesInventory?: PagesInventoryCommand;
  pagesStoragePreflight?: PagesStoragePreflightCommand;
  pagesDeployCertificate?: PagesDeployCertificateCommand;
  pagesStageRuntimeConfig?: PagesStageRuntimeConfigCommand;
  pagesActivateRuntimeConfig?: PagesActivateRuntimeConfigCommand;
  pagesRemoveRuntimeConfig?: PagesRemoveRuntimeConfigCommand;
}

export interface DockerBuildCommand {
  buildId: string;
  repositoryUrl: string;
  repositoryRemoteId: string;
  repositoryFullPath: string;
  ref: string;
  commitSha: string;
  dockerfilePath: string;
  contextPath: string;
  platform: string;
  outputRepository: string;
  outputTag: string;
  buildArgs: Record<string, string>;
  buildSecrets: Record<string, Buffer>;
  checkoutCredential: Buffer;
  allowedDependencies: string[];
  cpuLimitMillis: string;
  memoryLimitBytes: string;
  diskLimitBytes: string;
  timeoutSeconds: number;
  outputKind: string;
  applicationRoot: string;
  packageManager: string;
  packageManagerVersion: string;
  nodeVersion: string;
  buildScript: string;
  artifactDirectory: string;
  workerParallelism?: number;
  skipVulnerabilityScan?: boolean;
  attempt?: number;
}

export interface DockerBuildCancelCommand {
  buildId: string;
  reason: string;
}

export interface DockerBuildEventAck {
  buildId: string;
  attempt: number;
  disposition: string;
}

export interface SyncRelayPolicyCommand {
  applySnapshotRequest: Buffer;
  revision: string;
  expiresAtUnix: string;
}

export interface SetRelayDrainCommand {
  enabled: boolean;
  forceDisconnect: boolean;
}

export interface UpdateRelayWorkerCommand {
  downloadUrl: string;
  targetVersion: string;
  checksum: string;
  signedManifest: string;
}

/** The address Opfield moves to (host:port); empty clears it. */
export interface SetOpfieldNextAddressCommand {
  address: string;
}

export interface ConfigureNginxLogsCommand {
  /** Rotated logs older than this many days are deleted; 0: no age limit. */
  retentionDays: number;
}

export interface RenewRelayIdentityCommand {
  serverCertificate: Buffer;
  serverKey: Buffer;
  serverIdentity: string;
  retainServerFingerprint: string;
}

/** Relay supervisors with relay_route_runtime_v1; the answer is JSON in CommandResult.detail. */
export interface GetRelayRouteRuntimeCommand {
  routeIds: string[];
}

/** The witness processes a relay supervisor runs for availability sets, as the full desired set. */
export interface ApplyWitnessesCommand {
  /** Increases with every push to the relay; the supervisor ignores one not above its applied revision. */
  revision: string;
  witnesses: WitnessSpec[];
}

export interface WitnessSpec {
  id: string;
  setId: string;
  /** 'clickhouse_keeper'. */
  kind: string;
  /** 'active' runs it; 'standby' fetches, verifies and stages it without running. */
  role: string;
  artifact: WitnessArtifact;
  serverId: number;
  /** Loopback ports of the relay-local endpoints (39400-39499): Keeper client and raft. */
  clientPort: number;
  raftPort: number;
  /** Host the raft configuration names for this witness; '127.0.0.1' when empty. */
  raftHost: string;
  peers: WitnessPeer[];
  leasePolicyId: string;
}

export interface WitnessPeer {
  serverId: number;
  /** Loopback address and port (39500-39999) of the local forwarder, as the raft configuration names the peer. */
  host: string;
  port: number;
  routeId: string;
  assignmentGeneration: string;
}

export interface WitnessArtifact {
  version: string;
  downloadUrl: string;
  sha256: string;
  signedManifest: string;
  component: string;
}

export interface WitnessStatus {
  id: string;
  kind: string;
  role: string;
  /** fetching | staged | starting | running | updating | stopped | error | refused */
  state: string;
  version: string;
  artifactSha256: string;
  keeperRole: string;
  lastZxid: string;
  error: string;
  restarts: number;
  sinceUnix: string;
}

export interface SyncDockerRegistryBindingsCommand {
  bindings: DockerRegistryBinding[];
}

export interface DockerRegistryBinding {
  bindingId: string;
  role: 'builder' | 'runtime' | 'mirror' | 'ingress';
  generation: string;
  repository: string;
  actions: Array<'pull' | 'push'>;
  localAddress: string;
  localPort: number;
  relayOwnerKind: string;
  relayOwnerId: string;
  authorization: string;
  authorizationExpiresAtUnix: string;
}

export interface PagesUploadInitCommand {
  uploadId: string;
  deploymentId: string;
  expectedSize: string;
  sha256: string;
}

export interface PagesUploadChunkCommand {
  uploadId: string;
  offset: string;
  content: Buffer;
}

export interface PagesUploadFinalizeCommand {
  uploadId: string;
  deploymentId: string;
}

export interface PagesVerifyReleaseCommand {
  deploymentId: string;
  sha256: string;
}

export interface PagesMaterializePreviewCommand {
  profileId: string;
  deploymentId: string;
  hostname: string;
  certificateId: string;
  certificateVersion: string;
  spaFallback: boolean;
  fallbackUrl: string;
  /** Only sent to daemons advertising nginx_pages_preview_access_v1. */
  access?: PagesPreviewAccess;
  /**
   * Written and tested now, loaded with the reload of its batch (as ApplyConfigCommand.deferReload). Only sent to
   * daemons advertising pages_deferred_reload_v1.
   */
  deferReload?: boolean;
  /** Where nginx takes the visitor's address from; only sent to daemons advertising nginx_pages_preview_client_ip_v1. */
  clientIp?: PagesPreviewClientIp;
}

/** Peers whose client-address header nginx believes (set_real_ip_from), and that header. */
export interface PagesPreviewClientIp {
  trustedProxies: string[];
  header: 'CF-Connecting-IP' | 'X-Forwarded-For' | 'X-Real-IP';
}

export interface PagesPreviewAccess {
  accessListId: string;
  ipRules: PagesPreviewIpRule[];
  basicAuthEnabled: boolean;
}

export interface PagesPreviewIpRule {
  type: 'allow' | 'deny';
  value: string;
}

export interface PagesDeployCertificateCommand {
  certId: string;
  certPem: Buffer;
  keyPem: Buffer;
  chainPem: Buffer;
  version: string;
  replicaGeneration: string;
}

export interface PagesRemovePreviewCommand {
  hostname: string;
}

export interface PagesActivateTagRouteCommand {
  routeId: string;
  deploymentId: string;
  /** As PagesMaterializePreviewCommand.deferReload (pages_deferred_reload_v1). */
  deferReload?: boolean;
}

export interface PagesDeactivateTagRouteCommand {
  routeId: string;
}

export interface PagesCleanupDeploymentCommand {
  deploymentId: string;
}

export interface PagesInventoryCommand {
  expectationsJson?: Buffer;
}

export interface PagesStoragePreflightCommand {
  requiredBytes: string;
}

export type PagesRuntimeConfigBindingKind =
  | 'PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE'
  | 'PAGES_RUNTIME_CONFIG_BINDING_KIND_PREVIEW';

export interface PagesStageRuntimeConfigCommand {
  bindingKind: PagesRuntimeConfigBindingKind;
  bindingId: string;
  generation: string;
  json: Buffer;
}

export interface PagesActivateRuntimeConfigCommand {
  bindingKind: PagesRuntimeConfigBindingKind;
  bindingId: string;
  generation: string;
}

export interface PagesRemoveRuntimeConfigCommand {
  bindingKind: PagesRuntimeConfigBindingKind;
  bindingId: string;
  generation?: string;
}

/** A route's maintenance flag on a daemon that reports proxy_maintenance_flag_v1, see the proto. */
export type ProxyMaintenanceFlag =
  | 'PROXY_MAINTENANCE_FLAG_UNSPECIFIED'
  | 'PROXY_MAINTENANCE_FLAG_OFF'
  | 'PROXY_MAINTENANCE_FLAG_ON';

export interface ApplyConfigCommand {
  hostId: string;
  configContent: string;
  testOnly: boolean;
  configOwnership?: string;
  /** Loaded with the reload of its batch (reconnect resync), see the proto. */
  deferReload?: boolean;
  maintenance?: ProxyMaintenanceFlag;
}

export interface RemoveConfigCommand {
  hostId: string;
}

export interface DeployCertCommand {
  certId: string;
  certPem: Buffer;
  keyPem: Buffer;
  chainPem: Buffer;
}

export interface ApplyTlsBundleCommand {
  hostId: string;
  configContent: string;
  certificates: VersionedCertBundle[];
  generation: string;
  configOwnership?: string;
  deferReload?: boolean;
  maintenance?: ProxyMaintenanceFlag;
}

export interface VersionedCertBundle {
  certId: string;
  certPem: Buffer;
  keyPem: Buffer;
  chainPem: Buffer;
  version: string;
  replicaGeneration: string;
}

export interface InspectCertificatesCommand {
  certIds: string[];
}

export interface ExportLegacyCertificatesCommand {
  certIds: string[];
}

export interface RemoveCertificateReplicaCommand {
  certId: string;
  expectedVersion: string;
  expectedReplicaGeneration: string;
}

export interface RemoveCertCommand {
  certId: string;
}

export interface FullSyncCommand {
  hosts: HostConfig[];
  certs: CertBundle[];
  globalConfig: string;
  htpasswdFiles: HtpasswdFile[];
  versionHash: string;
}

export interface HostConfig {
  hostId: string;
  configContent: string;
  configOwnership?: string;
  maintenance?: ProxyMaintenanceFlag;
}

export interface CertBundle {
  certId: string;
  certPem: Buffer;
  keyPem: Buffer;
  chainPem: Buffer;
}

export interface HtpasswdFile {
  accessListId: string;
  content: string;
}

export interface UpdateGlobalConfigCommand {
  content: string;
  backupContent: string;
}

export interface DeployHtpasswdCommand {
  accessListId: string;
  content: string;
}

export interface RemoveHtpasswdCommand {
  accessListId: string;
}

export type TestConfigCommand = Record<string, never>;
export type RequestHealthCommand = Record<string, never>;
export type RequestStatsCommand = Record<string, never>;
export type ReadGlobalConfigCommand = Record<string, never>;

export interface RequestTrafficStatsCommand {
  tailLines: number;
  hostId?: string;
  windowSeconds?: number;
}

export interface SetDaemonLogStreamCommand {
  enabled: boolean;
  minLevel: string;
  tailLines: number;
}

export interface DeployAcmeChallengeCommand {
  token: string;
  content: string;
}

export interface RemoveAcmeChallengeCommand {
  token: string;
}

// ─── Docker Commands ────────────────────────────────────────────────

export interface DockerContainerCommand {
  action: string;
  containerId: string;
  configJson: string;
  timeoutSeconds: number;
  signal: string;
  newName: string;
  force: boolean;
}

export interface DockerImageCommand {
  action: string;
  imageRef: string;
  registryAuthJson: string;
  force: boolean;
  targetImageRef: string;
}

export interface DockerVolumeCommand {
  action: string;
  name: string;
  labels: Record<string, string>;
  force: boolean;
  path: string;
  maxBytes: number;
  newName: string;
  content: Buffer;
  targetPath: string;
}

export interface DockerNetworkCommand {
  action: string;
  networkId: string;
  containerId: string;
  driver: string;
  subnet: string;
  gatewayAddr: string;
}

export interface DockerDeploymentCommand {
  action: string;
  deploymentId: string;
  slot: string;
  configJson: string;
  force: boolean;
}

export interface DockerComposeCommand {
  action: string;
  operationId: string;
  projectId: string;
  projectName: string;
  revisionId: string;
  configDigest: string;
  composeYaml: Buffer;
  normalizedModelJson: string;
  variables: Record<string, string>;
  secrets: Record<string, string>;
  removeOrphans: boolean;
  volumeNames: string[];
}

export interface DockerRuntimeCommand {
  action: string;
  runtime: string;
}

export interface DockerRuntimeStatus {
  state: string;
  installedVersion: string;
  targetVersion: string;
  reasonCode: string;
  message: string;
  checkedAtUnixMs: string;
  remoteInstallable: boolean;
  localInstallCommand: string;
  step: string;
  progressPercent: number;
}

export interface DockerExecCommand {
  action: string;
  containerId: string;
  command: string[];
  tty: boolean;
  stdin: boolean;
  rows: number;
  cols: number;
  user?: string;
  sessionKey?: string;
}

export interface DockerFileCommand {
  action: string;
  containerId: string;
  path: string;
  targetPath: string;
  maxBytes: number;
  content?: Buffer;
}

export interface DockerConfigPushCommand {
  registries: RegistryConfig[];
  allowlist: string[];
}

export interface RegistryConfig {
  url: string;
  username: string;
  password: string;
}

export interface DockerLogsCommand {
  containerId: string;
  tailLines: number;
  follow: boolean;
  timestamps: boolean;
  since?: string;
  until?: string;
}

/** Restricted lifecycle command accepted only by a database-profile docker daemon. */
export interface DockerDatabaseCommand {
  action: string;
  managedDatabaseId: string;
  configJson: string;
}

/** Restricted lifecycle command accepted only by a storage-profile docker daemon. */
export interface DockerStorageCommand {
  action: string;
  managedStorageId: string;
  configJson: string;
}

/** Typed backup runner command accepted only by a storage-profile docker daemon. */
export interface DockerBackupCommand {
  action: string;
  runId: string;
  configJson: string;
}

/** Generation-fenced workload placement command for independent Docker nodes. */
export interface DockerAvailabilityCommand {
  action: string;
  policyId: string;
  placementId: string;
  generation: string;
  operationId: string;
  idempotencyKey: string;
  resourceKind: string;
  resourceId: string;
  configJson: string;
}

// ─── Availability data-plane lease ───────────────────────────────────

/**
 * Signed lease blocks for one daemon. Blocks and rotation links are serialized relay.v1
 * messages (LeaseSignedBlock, LeasePolicyKeyRotation); the daemon verifies them itself.
 */
export interface SyncAvailabilityLeaseCommand {
  revision: string;
  memberId: string;
  policyKeys: AvailabilityLeasePolicyKey[];
  keyRotations: Buffer[];
  /** Unused since voters travel in each policy manifest (A18); always empty. */
  voterConfig: Buffer;
  manifests: Buffer[];
}

export interface AvailabilityLeasePolicyKey {
  keyId: string;
  publicKey: Buffer;
  publicKeyFingerprint: string;
}

/** Planned handoff: the holder of (policyId, slot) releases to successorId. */
export interface AvailabilityLeaseHandoffCommand {
  policyId: string;
  slot: number;
  successorId: string;
  operationId: string;
  successorGeneration: string;
  manifestVersion: string;
}

export interface AvailabilityLeaseBallot {
  round: string;
  incarnation: string;
  proposerId: string;
}

export interface AvailabilityLeaseReport {
  memberId: string;
  identityPublicKey: Buffer;
  incarnation: string;
  epoch: string;
  trustedPolicyKeyIds: string[];
  manifests: AvailabilityLeaseManifestAck[];
  held: AvailabilityLeaseHeld[];
  acceptor: AvailabilityLeaseKeyView[];
  acceptorAbstaining: boolean;
  watchdogReady: boolean;
  events: AvailabilityLeaseEvent[];
  leaseRevision: string;
  /** Relays only: members with a live Coordinate stream to the relay. */
  connectedMemberIds?: string[];
  /** Docker daemons: their wall clock (Unix ms) when the report was built; '0' when not sent (N-15). */
  reportedAtUnixMs?: string;
}

export interface AvailabilityLeaseManifestAck {
  policyId: string;
  manifestVersion: string;
  closed: boolean;
  /** Per-policy voter epoch persisted with the manifest (A18); '0' when the sender does not report it. */
  voterEpoch?: string;
  voter?: boolean;
  member?: boolean;
}

export interface AvailabilityLeaseHeld {
  policyId: string;
  slot: number;
  role: string;
  ballot?: AvailabilityLeaseBallot | null;
  epoch: string;
  manifestVersion: string;
  placementId: string;
  placementGeneration: string;
  /**
   * Graceful close: this node kept its copy of the slot running after the lease closed; a majority of every quorum set
   * of the closed manifest confirmed it (role "retained"). Adopt the copy as RUNNING.
   */
  retained?: boolean;
  /** Docker daemons: when this node acquired the key for its current holding, Unix ms; '0' when unknown (B-14). */
  heldSinceUnixMs?: string;
}

export interface AvailabilityLeaseKeyView {
  policyId: string;
  slot: number;
  state: string;
  holderId: string;
  reservedFor: string;
  promised?: AvailabilityLeaseBallot | null;
  committed?: AvailabilityLeaseBallot | null;
  epoch: string;
  manifestVersion: string;
  gateOpen: boolean;
  /** Relays only: the holder and committed ballot the open gate admits. */
  gateHolderId?: string;
  gateBallot?: AvailabilityLeaseBallot | null;
  /** Unix ms when this member first stored a commit of the committed ballot's proposer; '0' when unknown. */
  holderSinceUnixMs?: string;
  /**
   * Relays only, stateful policies (availability_lease_v3): whether the relay's memory of the key is KNOWN,
   * the ballot it last accepted, "sha256:<hex>" of that state and of the latest commit's. Never the state.
   */
  stateful?: boolean;
  stateKnown?: boolean;
  stateHash?: string;
  accepted?: AvailabilityLeaseBallot | null;
  committedStateHash?: string;
}

export interface AvailabilityLeaseEvent {
  kind: string;
  policyId: string;
  slot: number;
  ballot?: AvailabilityLeaseBallot | null;
  successorId: string;
  reason: string;
  atUnixMs: string;
}

/** Admission control for a first-party database connector sidecar on a Docker node. */
export interface SyncRelayGrantsCommand {
  policyRevision: string;
  generatedAtUnixMs: string;
  grants: RelayGrantAssignment[];
  dataLanes?: number;
  readChunkBytes?: number;
  revocationFences?: RelayRevocationFence[];
  relayLatencyTargets?: RelayLatencyTarget[];
}

/** A pool relay the daemon measures its round trip to; never a tunnel target. */
export interface RelayLatencyTarget {
  relayInstanceId: string;
  addresses: string[];
  port: number;
}

/** A relay that missed a revoking policy; the endpoint refuses the listed routes through it. */
export interface RelayRevocationFence {
  relayInstanceId: string;
  endpointId: string;
  routes: RelayRevokedRoute[];
}

export interface RelayRevokedRoute {
  routeId: string;
  /** uint64 as string; "0" when the route no longer targets the endpoint. */
  allowedGeneration: string;
}

/** Complete desired set of Proxy Host secure-link listeners or bindings. */
export interface SyncProxySecureLinksCommand {
  bindings: ProxySecureLinkBinding[];
}

export interface ProxySecureLinkBinding {
  linkId: string;
  role: 'source' | 'target' | string;
  generation: string;
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
  /** Availability members: a standby's member; closed until its candidate holds the lease. */
  dormant?: boolean;
  availabilityPolicyId?: string;
  availabilityCandidateId?: string;
  /** Source-only: the loopback TCP endpoint ("127.a.b.c:port") the daemon serves the link on next to its socket. */
  loopbackAddress?: string;
}

export interface ProbeProxySecureLinkCommand {
  linkId: string;
  scheme: string;
  path: string;
  expectedStatus?: number;
  expectedBody?: string;
  bodyMatchMode?: string;
  timeoutSeconds?: number;
}

export interface ProbePagesRouteCommand {
  routeId: string;
  domain: string;
  tls: boolean;
  path: string;
  expectedStatus?: number;
  expectedBody?: string;
  bodyMatchMode?: string;
  timeoutSeconds?: number;
}

export interface RelayGrantAssignment {
  role: string;
  ownerKind: string;
  ownerId: string;
  endpointId?: string;
  routeId?: string;
  targetEndpointId?: string;
  grant: RelaySignedGrant;
  candidates?: RelayDataCandidate[];
  schemaVersion?: number;
  managedDatabaseListener?: ManagedDatabaseListener;
  secureLinkEgress?: SecureLinkEgress;
  /** Connect assignments only: streams of this route are resumable (RSv1). Absent: raw streams. */
  streamResume?: RelayStreamResume;
  /** Endpoint assignments only: routes to this endpoint whose streams may be resumable, with their keys. */
  resumeRoutes?: RelayRouteResume[];
  /** Availability sets: the member (and port) an endpoint serves, or the member a peer route reaches. */
  leaseTarget?: RelayLeaseTarget;
  /** Availability sets: one route per member of the resource's set; the daemon opens the holder's route first. */
  leaseGroup?: RelayLeaseGroupRoute[];
}

/** One member of a database or storage availability set as a relay path sees it. */
export interface RelayLeaseTarget {
  setId: string;
  memberId: string;
  /** The member's lease identity (its node id). */
  candidateId: string;
  /** Empty for a manual pair. */
  leasePolicyId: string;
  rank: number;
  ownerKind: string;
  ownerId: string;
  /** Peer endpoints and routes: the engine port name; empty for client paths. */
  portName?: string;
  primaryPort?: boolean;
  /** Routes to a ClickHouse Keeper witness on a relay: the witness id (memberId is empty). */
  witnessId?: string;
}

/** One route of a lease group. */
export interface RelayLeaseGroupRoute {
  routeId: string;
  targetEndpointId: string;
  grant: RelaySignedGrant;
  candidates?: RelayDataCandidate[];
  streamResume?: RelayStreamResume;
  target: RelayLeaseTarget;
  schemaVersion?: number;
}

/** The source side of a resumable route (RSv1). The key never travels through a relay. */
export interface RelayStreamResume {
  /** 1 */
  version: number;
  /** 1..64 bytes, names the key to the target */
  keyId: string;
  /** 32 bytes: HKDF-SHA256 route resume key */
  key: Buffer;
  /** Proxy routes: reset a stream this long after its target -> source direction finished without traffic. 0: none. */
  halfCloseTimeoutMs?: number;
}

/** The target side of one resumable route (RSv1). The previous key stays valid while a rotation reaches the sources. */
export interface RelayRouteResume {
  routeId: string;
  /** 1 */
  version: number;
  keyId: string;
  key: Buffer;
  prevKeyId?: string;
  prevKey?: Buffer;
}

/**
 * Desired connector egress listener for a consumer-side link (managed storage, managed database or container
 * link), carried with the signed connect assignment so revocation also removes the local entry point.
 */
export interface ManagedDatabaseListener {
  networkName: string;
  listenAddress: string;
  listenPort: number;
  allowedSources: string[];
  /** uint64 */
  routeGeneration: number | string;
}

export interface SecureLinkEgress {
  /** opfield-db-*, opfield-storage-* or opfield-link-* (or a link's earlier name) */
  networkName: string;
  /** DNS alias the connector gets on that network */
  alias: string;
  listenPort: number;
  /** 0 = unlimited */
  maxSessions?: number;
  /** storage only: the connector originates TLS */
  tlsCaPem?: string;
  tlsServerName?: string;
  /** uint64: relay_routes.generation (proto-loader accepts a number or a decimal string) */
  routeGeneration: number | string;
  /** The secure-link connector image, for a node without a proxy secure-link target binding to take it from. */
  connectorImage?: string;
  /**
   * Database links: consumers recreated from now on use the connector alias (no `db-<id>` ExtraHosts entry), while
   * the host listener still serves the consumers not moved yet.
   */
  consumersUseAlias?: boolean;
  /** The connector joins the network and listens, but takes no DNS alias yet (storage cutover, sidecar still up). */
  aliasDisabled?: boolean;
  /**
   * The connector's IPv4 address on the network (taken over from a removed sidecar, for DNS-pinning clients).
   * Empty: the pool's reserved address, else the address the connector already holds.
   */
  connectorAddress?: string;
}

export interface RelayDataCandidate {
  poolId: string;
  relayInstanceId: string;
  assignmentGeneration: string;
  addresses: string[];
  port: number;
  certificateIdentity: string;
  certificateFingerprint: string;
  capabilities: string[];
  grant: RelaySignedGrant;
  assignmentState: string;
  /**
   * int64 unix ms. Draining candidates: resumable streams leave this relay before this time, spread over the time
   * left. 0 or absent: as soon as possible.
   */
  drainDeadlineUnixMs?: number | string;
  topology?: RelayCandidateTopology;
}

export interface RelayCandidateTopology {
  role: string; // "primary" or "standby"
  endpointRttMicros: number; // 0 when unknown
}

export interface ProbeRelayCandidateCommand {
  probeId: string;
  role: string;
  endpointId: string;
  routeId?: string;
  assignmentGeneration: string;
  candidate: RelayDataCandidate;
}

export interface RelaySignedGrant {
  keyId: string;
  payload: Buffer;
  signature: Buffer;
}

export interface NodeExecCommand {
  action: string;
  command: string[];
  tty: boolean;
  rows: number;
  cols: number;
  sessionKey?: string;
  /** "run": how long the command may run, 1-300 s; 0 or absent is 30 s (field 7). */
  timeoutSeconds?: number;
}

export interface NodeFileCommand {
  action: string;
  path: string;
  targetPath: string;
  maxBytes: number;
  content?: Buffer;
}

export interface ExecInput {
  execId: string;
  data: Buffer;
}

export interface ExecOutput {
  execId: string;
  data: Buffer;
  exited: boolean;
  exitCode: number;
}

export interface ContainerStats {
  containerId: string;
  name: string;
  image: string;
  state: string;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
  logBytes: number;
  logBytesAvailable: boolean;
}

// ─── Log Streaming ──────────────────────────────────────────────────

export interface LogStreamMessage {
  subscribeAck?: LogSubscribeAck;
  entry?: LogEntry;
}

export interface LogSubscribeAck {
  hostId: string;
}

export interface LogEntry {
  hostId: string;
  timestamp: string;
  remoteAddr: string;
  method: string;
  path: string;
  status: number;
  bodyBytesSent: string;
  referer: string;
  userAgent: string;
  upstreamResponseTime: string;
  raw: string;
  logType: string;
  level: string;
}

export interface LogStreamControl {
  subscribe?: LogSubscribe;
  unsubscribe?: LogUnsubscribe;
}

export interface LogSubscribe {
  hostId: string;
  tailLines: number;
}

export interface LogUnsubscribe {
  hostId: string;
}

export interface UpdateDaemonCommand {
  downloadUrl: string;
  targetVersion: string;
  checksum: string;
  signedManifest: string;
}

// ─── Availability set members (storage-profile docker daemons) ─────

export interface AvailabilityMemberPeer {
  memberId: string;
  nodeId: string;
  memberIndex: number;
  priority: number;
  removing?: boolean;
}

export interface AvailabilityPrimaryAssignment {
  setId: string;
  primaryMemberId: string;
  generation: string;
  /** Opfield's relay policy key signature (see the proto). */
  signingKeyId?: string;
  signature?: Buffer;
  /** Policy keys the daemon trusts directly (Opfield only). */
  policyKeys?: AvailabilityLeasePolicyKey[];
}

export interface AvailabilityMemberConfig {
  setId: string;
  memberId: string;
  engine: 'postgres' | 'valkey' | 'seaweedfs' | 'clickhouse';
  ownerKind: 'managed_database' | 'managed_storage';
  ownerId: string;
  mode: 'automatic' | 'manual';
  leasePolicyId?: string;
  durability?: 'synchronous' | 'asynchronous';
  syncDegradeAfterSeconds?: number;
  maxLagBytes?: string;
  members: AvailabilityMemberPeer[];
  primary?: AvailabilityPrimaryAssignment;
  configRevision: string;
  /** The engine's own configuration (JSON), opaque to the member runtime. */
  engineConfig?: Buffer;
  publishedPort?: number;
  /** The set is paused: this member's engine stays stopped (copies stop first, the primary keeps its role). */
  stopped?: boolean;
}

export interface AvailabilityMemberCommand {
  configure?: AvailabilityMemberConfig;
  remove?: { setId: string; memberId: string };
  ackEvents?: { setId: string; memberId: string; throughSequence: string };
  assignPrimary?: AvailabilityPrimaryAssignment;
  switchover?: { setId: string; successorMemberId: string; operationId: string };
  /** Restarts the member's engine (every engine); the primary only with allowPrimary. */
  restart?: AvailabilityMemberRestart;
}

export interface AvailabilityMemberRestart {
  setId: string;
  memberId: string;
  operationId: string;
  allowPrimary?: boolean;
}

export interface AvailabilityMemberEvent {
  sequence: string;
  kind: string;
  atUnixMs: string;
  reason?: string;
  operationId?: string;
  detail?: Record<string, string>;
}

export interface AvailabilityMemberReport {
  setId: string;
  memberId: string;
  role: 'primary' | 'copy' | 'rebuilding' | 'fenced' | 'unknown';
  serving: boolean;
  leaseRole?: string;
  eligible: boolean;
  eligibilityReason?: string;
  lagBytes?: string;
  lagSeconds?: number;
  syncState: 'sync' | 'async' | 'none';
  position?: Record<string, string>;
  diskFreeBytes?: string;
  lastError?: string;
  configRevision?: string;
  primaryGeneration?: string;
  events?: AvailabilityMemberEvent[];
  /** The engine is down because the member's configuration asks it (the set is paused). */
  stopped?: boolean;
  /** A requested restart that has not finished (empty when none). */
  pendingRestartOperationId?: string;
}
