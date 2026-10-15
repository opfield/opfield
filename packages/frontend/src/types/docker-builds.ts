export type DockerSourceTarget =
  | { kind: "container"; nodeId: string; containerName: string }
  | { kind: "deployment"; nodeId?: string; deploymentId: string }
  | { kind: "compose_project"; nodeId: string; composeProjectId: string }
  | { kind: "pages_project"; nodeId?: string; pageProjectId: string };

export type DockerBuildStatus =
  | "queued"
  | "claimed"
  | "checking_out"
  | "building"
  | "scanning"
  | "pushing"
  | "deploying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded";

export type DockerArtifactPolicyDecision = "pending" | "approved" | "rejected" | "error";

export type DockerVulnerabilityScope =
  | "all"
  | "application"
  | "fixable_application"
  | "fixable_all";

export interface DockerBuildSeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

export interface DockerBuildVulnerability {
  id: string;
  severity: string;
  packageName: string;
  installedVersion: string;
  packageType: string;
  fixedVersions: string[];
  fixState: string;
  namespace: string;
  dataSource: string;
}

export interface DockerSourceBinding {
  id: string;
  target: DockerSourceTarget;
  connectorId: string;
  projectId: string;
  provider: "gitlab" | "github" | "git";
  repositoryRemoteId: string;
  repositoryFullPath: string;
  repositoryCloneUrl: string;
  branch: string;
  dockerfilePath: string;
  contextPath: string;
  composeFilePath: string | null;
  composeVariables: Record<string, string>;
  composeSecretKeys: string[];
  /** Services of the Compose file the source last resolved; null for other targets or before it resolved. */
  composeServiceNames?: string[] | null;
  autoBuild: boolean;
  autoDeploy: boolean;
  buildArgs: Record<string, string>;
  buildSecretNames: string[];
  applicationRoot?: string;
  packageManager?: "npm" | "pnpm" | "yarn" | null;
  packageManagerVersion?: string | null;
  nodeVersion?: "20" | "22" | "24" | null;
  buildScript?: string | null;
  artifactDirectory?: string | null;
  publishTag?: string | null;
  policy: {
    vulnerabilityThreshold?: "critical" | "high" | "medium" | "low" | "none" | "disabled";
    vulnerabilityScope?: DockerVulnerabilityScope;
  };
  desiredCommitSha: string | null;
  deployedCommitSha: string | null;
  lastResolvedAt: string | null;
  lastPollAt: string | null;
  lastPollError: string | null;
  webhookConfiguredAt: string | null;
  lastWebhookAt: string | null;
  lastWebhookError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Answer of a manual repository check (Sync now). */
export interface DockerSourceSyncResult {
  source: DockerSourceBinding;
  /** The branch head moved since the previous check. */
  changed: boolean;
  /** Automatic build queued for the head; null when the source does not build automatically or already built it. */
  build: DockerBuild | null;
}

export interface DockerSourceBindingConfig {
  connectorId: string;
  projectId: string;
  branch: string;
  dockerfilePath: string;
  contextPath: string;
  composeFilePath?: string;
  composeVariables?: Record<string, string>;
  composeSecretKeys?: string[];
  autoBuild: boolean;
  autoDeploy: boolean;
  buildArgs: Record<string, string>;
  buildSecretNames: string[];
  applicationRoot?: string;
  packageManager?: "npm" | "pnpm" | "yarn";
  packageManagerVersion?: string;
  nodeVersion?: "20" | "22" | "24";
  buildScript?: string;
  artifactDirectory?: string;
  publishTag?: string;
  policy?: {
    vulnerabilityThreshold?: "critical" | "high" | "medium" | "low" | "none" | "disabled";
    vulnerabilityScope?: DockerVulnerabilityScope;
  };
}

export interface DockerBuildSecret {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface DockerBuildArtifact {
  id: string;
  buildId: string;
  registryRepository: string;
  digest: string;
  platform: string;
  sizeBytes: number;
  status: "pending" | "ready" | "rejected" | "deleting" | "deleted";
  sbomDigest: string | null;
  provenanceDigest: string | null;
  scanSummary: {
    scanner?: string;
    skipped?: boolean;
    critical: number;
    high: number;
    medium: number;
    low: number;
    unknown: number;
    vulnerabilities?: DockerBuildVulnerability[];
    vulnerabilitiesTruncated?: number;
    osPackages?: DockerBuildSeverityCounts;
    fixable?: DockerBuildSeverityCounts;
    fixableOsPackages?: DockerBuildSeverityCounts;
    policyScope?: DockerVulnerabilityScope;
  } | null;
  policyDecision: DockerArtifactPolicyDecision;
  policyReason: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

export interface DockerBuild {
  id: string;
  sourceBindingId: string;
  batchId: string | null;
  serviceName: string | null;
  provider: "gitlab" | "github" | "git";
  trigger: "manual" | "gitlab_push" | "github_push" | "generic_webhook" | "poll" | "retry";
  repositoryFullPath: string;
  ref: string;
  commitSha: string;
  status: DockerBuildStatus;
  builderNodeId: string | null;
  builderName?: string | null;
  platform: string | null;
  attempt: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  progress: Record<string, unknown>;
  artifact: DockerBuildArtifact | null;
  target:
    | { kind: "container"; nodeId: string; containerName: string; name: string }
    | { kind: "deployment"; nodeId: string; deploymentId: string; name: string }
    | {
        kind: "compose_project";
        nodeId: string;
        composeProjectId: string;
        name: string;
        serviceName: string | null;
      }
    | { kind: "pages_project"; nodeId?: string; pageProjectId: string; name: string };
  createdAt: string;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** A Git connector offered by the source pickers: identity only, readable with the workload's create/edit scope. */
export interface DockerSourceConnector {
  id: string;
  name: string;
  provider: "gitlab" | "github" | "git";
}

export interface DockerBuildSourceRepository {
  connectorId: string;
  connectorName: string;
  projectId: string;
  provider: "gitlab" | "github" | "git";
  remoteId: string;
  fullPath: string;
  name: string;
  webUrl: string | null;
  defaultBranch: string | null;
  archived: boolean;
}

export interface PagesBuildDiscovery {
  commitSha: string;
  packagePath: string;
  scripts: Record<string, string>;
  packageManagers: Array<"npm" | "pnpm" | "yarn">;
  preferredPackageManager: "npm" | "pnpm" | "yarn" | null;
  packageManagerVersion: string | null;
}

export interface DockerBuildLogChunk {
  buildId: string;
  sequence: number;
  content: string;
  byteLength: number;
  createdAt: string;
}

export interface DockerInternalRegistryState {
  status: "starting" | "ready" | "read_only" | "maintenance" | "degraded" | "unhealthy";
  writable: boolean;
  storageBackend: "filesystem";
  storageUsedBytes: number;
  storageCapacityBytes: number | null;
  externalAccessEnabled: boolean;
  externalHostname: string | null;
  externalNginxNodeId: string | null;
  externalCertificateId: string | null;
  maintenancePhase: string;
  lastGcAt: string | null;
  nextGcAt: string | null;
  lastError: string | null;
}

export interface DockerInternalRegistrySettings {
  externalAccessEnabled: boolean;
  externalHostname?: string;
  externalNginxNodeId?: string;
  externalCertificateId?: string;
}

export interface DockerBuildAdmissionStatus {
  ready: boolean;
  code: string | null;
  message: string | null;
}

export type DockerSourceResourceCreateRequest = {
  source: DockerSourceBindingConfig;
  resource:
    | {
        kind: "container";
        folderId?: string | null;
        name: string;
        restartPolicy: "no" | "always" | "unless-stopped" | "on-failure";
        runtimeProfile: "default" | "secure";
      }
    | {
        kind: "deployment";
        folderId?: string | null;
        name: string;
        restartPolicy: "no" | "always" | "unless-stopped" | "on-failure";
        runtimeProfile: "default" | "secure";
        routes: Array<{ hostPort: number; containerPort: number; isPrimary: boolean }>;
        health: {
          path: string;
          statusMin: number;
          statusMax: number;
          timeoutSeconds: number;
          intervalSeconds: number;
          successThreshold: number;
          startupGraceSeconds: number;
          deployTimeoutSeconds: number;
        };
        drainSeconds: number;
      };
};

export interface DockerSourceResourceCreateResult {
  source: DockerSourceBinding;
  build: DockerBuild | null;
  initialBuildError?: { code: string; message: string } | null;
  target: DockerSourceTarget;
}

export interface DockerComposeSourceProjectCreateResult {
  project: { id: string; nodeId: string; name: string };
  source: DockerSourceBinding;
  build: DockerBuild | null;
  initialBuildError?: { code: string; message: string } | null;
  builds: DockerBuild[];
  created: boolean;
}
