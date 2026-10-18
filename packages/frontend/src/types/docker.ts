import type { AppMembershipRef } from "./apps";
export type DockerFolderResourceType = "container" | "image" | "network" | "volume" | "compose";

export interface DockerContainerFolder {
  id: string;
  name: string;
  resourceType: DockerFolderResourceType;
  parentId: string | null;
  sortOrder: number;
  depth: number;
  isSystem: boolean;
  nodeId: string | null;
  composeProject: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DockerFolderTreeNode extends DockerContainerFolder {
  children: DockerFolderTreeNode[];
}

// ── Docker Types ──────────────────────────────────────────────────

export interface DockerPort {
  privatePort: number;
  publicPort?: number;
  type: string;
  ip?: string;
}

export interface DockerMount {
  hostPath?: string;
  containerPath: string;
  name?: string;
  readOnly: boolean;
}

export type DockerRuntimeProfile = "default" | "secure";
export type DockerRuntimeStatusState =
  | "healthy"
  | "installable"
  | "unsupported"
  | "unknown"
  | "installing"
  | "failed";
export type DockerRuntimeInstallStep =
  | "preparing"
  | "downloading"
  | "verifying_download"
  | "installing_binaries"
  | "configuring_docker"
  | "restarting_docker"
  | "verifying_runtime";

export interface DockerRuntimeStatus {
  state: DockerRuntimeStatusState;
  installedVersion?: string;
  targetVersion?: string;
  reasonCode?: string;
  message?: string;
  checkedAt: string;
  remoteInstallable: boolean;
  localInstallCommand?: string;
  step?: DockerRuntimeInstallStep;
  progressPercent?: number;
}

/** The Git source an image Opfield built comes from: lists name it instead of the internal registry image. */
export interface DockerImageSource {
  repositoryFullPath: string;
  branch?: string | null;
  commitSha?: string | null;
}

export interface DockerContainer {
  /** Set when the resource is a member of an app environment. */
  app?: AppMembershipRef | null;
  pendingSourceBuild?: boolean;
  /** Git source of an image Opfield built (or of a container awaiting its first build). */
  source?: DockerImageSource | null;
  /** The image an internal Availability mirror or promotion copy was taken from. */
  sourceImage?: string | null;
  id: string;
  /** Stable Opfield authorization identity. Unlike the Docker runtime ID, this survives recreate and migration. */
  scopeResourceId?: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  ports: DockerPort[];
  portsCount?: number;
  portsTruncated?: boolean;
  /** TCP ports the running container listens on, detected by the node; null when unknown. */
  listeningPorts?: number[] | null;
  labels?: Record<string, string>;
  kind?: "container" | "deployment";
  deploymentId?: string;
  activeSlot?: "blue" | "green";
  primaryRoute?: { hostPort: number; containerPort: number } | null;
  activeSlotContainerId?: string | null;
  healthCheckId?: string | null;
  healthCheckEnabled?: boolean;
  healthStatus?: "online" | "offline" | "degraded" | "unknown" | "disabled" | "stopped";
  secureLinkDown?: boolean;
  lastHealthCheckAt?: string | null;
  healthHistory?: Array<{ ts: string; status: string; responseMs?: number; slow?: boolean }>;
  folderId?: string | null;
  folderIsSystem?: boolean;
  folderSortOrder?: number;
  _transition?: string;
  _nodeId?: string;
  _nodeSlug?: string;
  _nodeName?: string;
  _nodeColor?: import("./nodes").NodeAppearanceColor | null;
  /** Snapshot origin. A resource remains present while its node is unavailable. */
  nodeId?: string;
  availability?: "available" | "unavailable";
  availabilityPolicyStatus?:
    | "starting"
    | "stopping"
    | "restarting"
    | "stopped"
    | "online"
    | "offline"
    | "enabling"
    | "healthy"
    | "degraded"
    | "unavailable"
    | "scaling"
    | "rolling_out"
    | "disabling"
    | "failed";
  availabilityHealthStatus?: "online" | "degraded" | "offline" | "stopped";
  availabilityServing?: number;
  availabilityDesired?: number;
  _listTruncated?: boolean;
  _listTotal?: number;
  _listLimit?: number;
  // Stats (from health report, optional)
  cpuPercent?: number;
  memoryUsage?: number;
  memoryLimit?: number;
  networkRx?: number;
  networkTx?: number;
}

export interface DockerHealthRouteOption {
  id: string;
  scheme: "http" | "https";
  hostPort: number;
  containerPort: number;
  label: string;
  isPrimary?: boolean;
}

export interface DockerHealthCheck {
  id: string | null;
  target: "container" | "deployment";
  nodeId: string;
  containerName: string | null;
  deploymentId: string | null;
  enabled: boolean;
  scheme: "http" | "https";
  hostPort: number | null;
  containerPort: number | null;
  path: string;
  statusMin: number;
  statusMax: number;
  expectedBody: string | null;
  bodyMatchMode: "includes" | "exact" | "starts_with" | "ends_with";
  intervalSeconds: number;
  timeoutSeconds: number;
  slowThreshold: number;
  healthStatus: "online" | "offline" | "degraded" | "unknown" | "disabled" | "stopped";
  lastHealthCheckAt: string | null;
  healthHistory: Array<{ ts: string; status: string; responseMs?: number; slow?: boolean }>;
  routeOptions: DockerHealthRouteOption[];
}

export interface DockerDeploymentRoute {
  id: string;
  deploymentId: string;
  hostPort: number;
  containerPort: number;
  isPrimary: boolean;
}

export interface DockerDeploymentDesiredConfig {
  image: string;
  env?: Record<string, string>;
  restartPolicy?: string;
  runtimeProfile?: DockerRuntimeProfile;
  gpu?: { deviceIds: string[] };
  [key: string]: unknown;
}

export interface DockerGpuAttachment {
  mode: "none" | "managed" | "external";
  deviceIds: string[];
  reason?: string;
}

export interface DockerDeploymentSlot {
  id: string;
  deploymentId: string;
  slot: "blue" | "green";
  containerId: string | null;
  containerName: string;
  image: string | null;
  desiredConfig?: DockerDeploymentDesiredConfig | null;
  status: string;
  health: string;
  drainingUntil: string | null;
  updatedAt: string;
}

export interface DockerDeploymentRelease {
  id: string;
  deploymentId: string;
  fromSlot: "blue" | "green" | null;
  toSlot: "blue" | "green" | null;
  image: string | null;
  /** Git source of a release image Opfield built. */
  source?: DockerImageSource | null;
  sourceImage?: string | null;
  triggerSource: string;
  taskId: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DockerDeploymentHealthConfig {
  path: string;
  statusMin: number;
  statusMax: number;
  timeoutSeconds: number;
  intervalSeconds: number;
  successThreshold: number;
  startupGraceSeconds: number;
  deployTimeoutSeconds: number;
}

export interface DockerDeployment {
  /** Set when the resource is a member of an app environment. */
  app?: AppMembershipRef | null;
  /** Per internal image reference of the deployment: the Git source it was built from or the image it copies. */
  imageOrigins?: Record<string, { source: DockerImageSource | null; sourceImage: string | null }>;
  id: string;
  scopeResourceId?: string;
  nodeId: string;
  name: string;
  desiredConfig: DockerDeploymentDesiredConfig;
  activeSlot: "blue" | "green";
  status: string;
  routerName: string;
  routerImage: string;
  networkName: string;
  healthConfig: DockerDeploymentHealthConfig;
  drainSeconds: number;
  routes: DockerDeploymentRoute[];
  routesCount?: number;
  routesTruncated?: boolean;
  slots: DockerDeploymentSlot[];
  releases: DockerDeploymentRelease[];
  webhook?: DockerWebhook | null;
  healthCheck?: DockerHealthCheck | null;
  _transition?: string;
  /** Set while a build rollout owns the deployment; user mutations are refused. */
  _buildRollout?: DockerBuildRolloutOwner | null;
  availability?: "available" | "unavailable";
  _listTruncated?: boolean;
  _listTotal?: number;
  _listLimit?: number;
  createdAt: string;
  updatedAt: string;
}

export type DockerComposeManagementState = "external" | "managed";
export type DockerComposeDesiredState = "running" | "stopped";
export type DockerComposeProjectStatus =
  | "discovered"
  | "validating"
  | "applying"
  | "deleting"
  | "running"
  | "stopped"
  | "degraded"
  | "failed"
  | "missing";
export type DockerComposeAvailability = "available" | "unavailable";
export type DockerComposeOperationAction =
  | "apply"
  | "pull_apply"
  | "start"
  | "stop"
  | "restart"
  | "down"
  | "delete_volumes"
  | "cancel";
/**
 * `reconciling`: the node connection was lost after the operation was sent, so the node may still
 * be applying it; the outcome is unknown until the node reports its actual Compose state.
 */
export type DockerComposeOperationStatus =
  | "pending"
  | "running"
  | "cancelling"
  | "reconciling"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface DockerComposePort {
  target: number;
  published?: number;
  protocol?: "tcp" | "udp";
  hostIp?: string;
}

export interface DockerComposeServiceVolume {
  source: string;
  target: string;
  readOnly?: boolean;
  external?: boolean;
}

export interface DockerComposeServiceConfig {
  image: string;
  cpus?: number;
  cpuShares?: number;
  memoryLimit?: string;
  memoryReservation?: string;
  memorySwapLimit?: string;
  pidsLimit?: number;
  environment?: Record<string, string>;
  command?: string | string[];
  entrypoint?: string | string[];
  workingDir?: string;
  user?: string;
  hostname?: string;
  ports?: DockerComposePort[];
  healthcheck?: Record<string, unknown>;
  dependsOn?: Record<string, { condition?: string }>;
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
  volumes?: DockerComposeServiceVolume[];
  networks?: string[];
  labels?: Record<string, string>;
}

export interface DockerComposeResourceConfig {
  external?: boolean;
  externalName?: string;
  driver?: string;
  labels?: Record<string, string>;
}

export interface DockerComposeNormalizedModel {
  name: string;
  services: Record<string, DockerComposeServiceConfig>;
  volumes?: Record<string, DockerComposeResourceConfig>;
  networks?: Record<string, DockerComposeResourceConfig>;
}

export interface DockerComposeProjectSummary {
  /** Set when the resource is a member of an app environment. */
  app?: AppMembershipRef | null;
  id: string;
  scopeResourceId?: string;
  nodeId: string;
  name: string;
  managementState: DockerComposeManagementState;
  desiredState: DockerComposeDesiredState;
  status: DockerComposeProjectStatus;
  availability: DockerComposeAvailability;
  availabilityPolicyStatus?:
    | "starting"
    | "stopping"
    | "restarting"
    | "stopped"
    | "online"
    | "offline"
    | "enabling"
    | "healthy"
    | "degraded"
    | "unavailable"
    | "scaling"
    | "rolling_out"
    | "disabling"
    | "failed";
  availabilityHealthStatus?: "online" | "degraded" | "offline" | "stopped";
  availabilityServing?: number;
  availabilityDesired?: number;
  activeRevisionId: string | null;
  observedFingerprint: string | null;
  lastSeenAt: string | null;
  serviceCount: number;
  runningServiceCount: number;
  healthyServiceCount: number;
  drifted: boolean;
  lastOperation?: DockerComposeOperation | null;
  folderId?: string | null;
  folderSortOrder?: number;
  _nodeId?: string;
  _nodeSlug?: string;
  _nodeName?: string;
  _nodeColor?: import("./nodes").NodeAppearanceColor | null;
  createdAt: string;
  updatedAt: string;
}

export interface DockerComposeRevision {
  id: string;
  projectId: string;
  revisionNumber: number;
  sourceYaml: string;
  originalYaml: string;
  normalizedModel: DockerComposeNormalizedModel;
  configDigest: string;
  variables: Record<string, string>;
  secretKeys: string[];
  createdById: string | null;
  createdAt: string;
}

export interface DockerComposeOperation {
  id: string;
  projectId: string;
  revisionId: string | null;
  taskId: string | null;
  idempotencyKey: string;
  action: DockerComposeOperationAction;
  status: DockerComposeOperationStatus;
  progress: string | null;
  error: string | null;
  options: { removeOrphans?: boolean; volumeNames?: string[] };
  createdById: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DockerComposeProject extends DockerComposeProjectSummary {
  activeRevision: DockerComposeRevision | null;
  revisions?: DockerComposeRevision[];
  operations?: DockerComposeOperation[];
  services: Array<{
    name: string;
    image: string;
    /** Git source of a service image Opfield built. */
    source?: DockerImageSource | null;
    sourceImage?: string | null;
    state: string;
    health: string;
    containerIds: string[];
  }>;
  volumeNames: string[];
  networkNames: string[];
}

export interface DockerComposeValidationDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface DockerComposeValidationResult {
  valid: boolean;
  projectName: string | null;
  normalizedModel: DockerComposeNormalizedModel | null;
  configDigest: string | null;
  requiredVariables: string[];
  diagnostics: DockerComposeValidationDiagnostic[];
}

/** Why a prune removes an image (dangling, an older image beyond its workload's cleanup setting, or unused). */
export type DockerImagePruneReason = "dangling" | "beyond_cleanup_setting" | "unused";

/** What a prune of a node would remove: `removable` now, `waiting` once their unused time is over. */
export interface DockerImagePrunePreview {
  dryRun: true;
  nodeId: string;
  removable: Array<{
    id: string;
    repository: string | null;
    size: number;
    reason: DockerImagePruneReason;
  }>;
  removableBytes: number;
  waiting: Array<{
    id: string;
    repository: string | null;
    size: number;
    reason: DockerImagePruneReason;
    removableAt?: string;
  }>;
  waitingBytes: number;
}

export interface DockerImage {
  id: string;
  scopeResourceId?: string | null;
  repoTags: string[];
  repoTagsCount?: number;
  repoTagsTruncated?: boolean;
  repoDigests?: string[];
  repoDigestsCount?: number;
  repoDigestsTruncated?: boolean;
  size: number;
  created: number;
  containers?: number;
  _listTruncated?: boolean;
  _listTotal?: number;
  _listLimit?: number;
  folderId?: string | null;
  folderIsSystem?: boolean;
  folderSortOrder?: number;
  _nodeId?: string;
  _nodeSlug?: string;
  _nodeName?: string;
  _nodeColor?: import("./nodes").NodeAppearanceColor | null;
  nodeId?: string;
  availability?: "available" | "unavailable";
}

export interface DockerVolume {
  name: string;
  scopeResourceId?: string | null;
  driver: string;
  mountpoint: string;
  labels?: Record<string, string>;
  options?: Record<string, string>;
  scope: string;
  managementState?: "managed" | "legacy";
  storageKind?: "regular" | "disk-image";
  capacityBytes?: number | null;
  usedBytes?: number | null;
  adoptable?: boolean;
  adoptionReason?: string;
  createdAt?: string;
  usedBy?: string[];
  usedByCount?: number;
  usedByTruncated?: boolean;
  _listTruncated?: boolean;
  _listTotal?: number;
  _listLimit?: number;
  folderId?: string | null;
  folderIsSystem?: boolean;
  folderSortOrder?: number;
  _nodeId?: string;
  _nodeSlug?: string;
  _nodeName?: string;
  _nodeColor?: import("./nodes").NodeAppearanceColor | null;
  nodeId?: string;
  availability?: "available" | "unavailable";
}

export interface DockerVolumeMetrics {
  storageKind: "regular" | "disk-image";
  usedBytes: number | null;
  capacityBytes: number | null;
  availableBytes: number | null;
  usedInodes: number | null;
  totalInodes: number | null;
  runningAttachmentCount: number;
  collectedAt: string;
}

export interface DockerNetwork {
  id: string;
  /** Stable Opfield authorization identity; distinct from the raw Docker network ID. */
  scopeResourceId?: string | null;
  name: string;
  driver: string;
  scope: string;
  ipam?: {
    subnet?: string;
    gateway?: string;
    config?: Array<{ subnet?: string; gateway?: string }>;
  };
  containers?: Record<string, { name?: string }>;
  containersCount?: number;
  containersTruncated?: boolean;
  _listTruncated?: boolean;
  _listTotal?: number;
  _listLimit?: number;
  folderId?: string | null;
  folderIsSystem?: boolean;
  folderSortOrder?: number;
  _nodeId?: string;
  _nodeSlug?: string;
  _nodeName?: string;
  _nodeColor?: import("./nodes").NodeAppearanceColor | null;
  nodeId?: string;
  availability?: "available" | "unavailable";
}

export interface DockerTask {
  id: string;
  nodeId: string;
  containerId?: string;
  containerName?: string;
  type: string;
  status: "pending" | "running" | "succeeded" | "failed";
  progress?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface DockerRegistry {
  id: string;
  name: string;
  url: string;
  username?: string;
  trustedAuthRealm?: string | null;
  source?: "manual" | "integration";
  provider?: "gitlab" | null;
  readOnly?: boolean;
  integration?: {
    provider: "gitlab";
    connectorId: string;
    connectorName: string | null;
    connectorBaseUrl: string | null;
    projectRemoteId: string | null;
    projectFullPath: string | null;
    remoteRegistryId: string | null;
    status: "available" | "inaccessible";
    lastSeenAt: string;
  };
  scope: "global" | "node";
  nodeId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DockerSecret {
  id: string;
  key: string;
  value: string; // masked as "••••••••" unless user has docker:secrets scope
  createdAt: string;
  updatedAt: string;
  system?: boolean;
}

export interface FileEntry {
  name: string;
  size: number;
  permissions: string;
  isDir: boolean;
  modified: string;
  isSymlink?: boolean;
  linkTarget?: string;
  isSpecial?: boolean;
  isWritable?: boolean;
  _listTruncated?: boolean;
  _listTotal?: number;
  _listLimit?: number;
}

export interface ContainerCreateConfig {
  folderId?: string | null;
  image: string;
  registryId?: string;
  name?: string;
  ports?: Array<{ hostPort: number; containerPort: number; protocol?: string; hostIp?: string }>;
  volumes?: Array<{
    hostPath?: string;
    containerPath: string;
    name?: string;
    readOnly?: boolean;
  }>;
  env?: Record<string, string>;
  networks?: string[];
  restartPolicy?: string;
  runtimeProfile?: DockerRuntimeProfile;
  labels?: Record<string, string>;
  command?: string[];
  gpu?: { deviceIds: string[] };
}

export interface DockerWebhook {
  id: string;
  nodeId: string;
  containerName: string;
  token: string;
  enabled: boolean;
  targetType?: "container" | "deployment";
  deploymentId?: string | null;
  /** Who created the webhook, and who last saved it: its calls act with that account's current permissions. */
  createdById?: string | null;
  updatedById?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DockerImageCleanupSettings {
  id: string | null;
  nodeId: string;
  targetType: "container" | "deployment";
  containerName: string | null;
  deploymentId: string | null;
  enabled: boolean;
  retentionCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DaemonNodeUpdateStatus {
  nodeId: string;
  hostname: string;
  currentVersion: string;
  updateAvailable: boolean;
  arch?: string;
  /** Why the last update of the node failed and when (for example a download the node could not make). */
  lastUpdateError?: { message: string; at: string | null; targetVersion: string | null } | null;
}

export interface DaemonUpdateStatus {
  daemonType: "nginx" | "docker" | "monitoring";
  latestVersion: string | null;
  lastCheckedAt: string | null;
  nodes: DaemonNodeUpdateStatus[];
}

/** POST /system/daemon-updates/:nodeId */
export interface DaemonNodeUpdateResult {
  scheduled: boolean;
  targetVersion: string;
  /** The node restarts once the other members of its availability lease settled. */
  leaseSequenced?: boolean;
  /** The update first waits for this many long tasks running on the node (at most 30 minutes). */
  waitingForTasks?: number;
  /** "Update now" ended the wait of an update that was already waiting for tasks. */
  waitSkipped?: boolean;
}

/** A build rollout that owns a container or deployment until it finishes. */
export interface DockerBuildRolloutOwner {
  buildId: string;
  commitSha: string;
}
