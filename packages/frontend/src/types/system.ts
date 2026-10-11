// System Update
export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseNotes: string | null;
  releaseUrl: string | null;
  lastCheckedAt: string | null;
  relay: RelayUpdateStatus;
  /** Absent on Gateways that predate the update gate. */
  gatewayOperation?: GatewayUpdateOperation | null;
}

/**
 * An accepted Gateway update, waiting for running orchestration operations first,
 * or (`failed`) one that was rolled back or never replaced the running version.
 */
export interface GatewayUpdateOperation {
  status: "waiting_for_operations" | "updating" | "failed";
  targetVersion: string;
  startedAt: string;
  /** When the update proceeds even if operations still run. */
  waitDeadline: string | null;
  operations: { kind: string; label: string; count: number }[];
  /** Why the update did not complete; set only when `failed`. */
  error?: string | null;
}

export interface RelayUpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseNotes: string | null;
  releaseUrl: string | null;
  operation: {
    status: "updating" | "failed";
    targetVersion: string;
    startedAt: string;
    error: string | null;
    /** The run has not finished (running or paused) and can be abandoned. */
    abandonable?: boolean;
    /** Durable Relay Pool run state, e.g. "paused". */
    runState?: string;
    /** When the run or one of its steps last moved. */
    lastProgressAt?: string;
  } | null;
}

export interface SystemConfig {
  publicUrl?: string | null;
  fileUploadMaxBytes: number;
  fileOpenMaxBytes: number;
  gatewayGrpcPublicTarget: string | null;
  gatewayGrpcLocalIp: string | null;
  relayAutoRecovery: boolean;
  features: GatewayFeatureConfig;
}

export interface GatewayFeatureConfig {
  pkiEnabled: boolean;
  domainsEnabled: boolean;
  siemEnabled: boolean;
  loggingEnabled: boolean;
  inferenceEnabled: boolean;
}

export type LicensePlan = "community" | "personal" | "business" | "enterprise";

export type LicenseRegistrationStatus = "registered" | "pending";

export type LicenseStatus =
  | "community"
  | "valid"
  | "expired_grace"
  | "valid_with_warning"
  | "unreachable_grace_expired"
  | "invalid"
  | "expired"
  | "revoked"
  | "replaced"
  | "deactivated";

export interface LicenseEntitlements {
  managedNodes: number | null;
  users: number | null;
  customPermissionGroups: number | null;
  supportLevel: string;
  features: string[];
}

export type CloudLinkState = "not_connected" | "connected" | "disconnected_by_account";
export type CloudSocketState = "connecting" | "online" | "reconnecting";

export interface CloudRequestSummary {
  at: string;
  type: string;
  service: string | null;
  ok: boolean;
  error: string | null;
  resultBytes: number | null;
}

export interface CloudLinkStatusView {
  state: CloudLinkState;
  portalUrl: string;
  accountEmail: string | null;
  connectedSince: string | null;
  socket: { state: CloudSocketState; since: string | null; lastError: string | null } | null;
  disconnectedAt: string | null;
  disconnectedReason: string | null;
  /** The latest requests the cloud account sent over the link, newest first. */
  recentRequests: CloudRequestSummary[];
  /** Set by a disconnect the cloud account could not confirm. */
  warning?: string;
}

export interface LicenseStatusView {
  moduleRestarting?: boolean;
  status: LicenseStatus;
  plan: LicensePlan;
  registrationStatus: LicenseRegistrationStatus;
  paidLicenseStatus: string;
  licensed: boolean;
  hasKey: boolean;
  keyLast4: string | null;
  licenseName: string | null;
  licenseMetadata: Record<string, unknown>;
  installationId: string;
  installationName: string;
  expiresAt: string | null;
  entitlementsVersion: number;
  entitlements: LicenseEntitlements;
  lastCheckedAt: string | null;
  lastValidAt: string | null;
  graceUntil: string | null;
  offlineGraceUntil: string | null;
  activeInstallationId: string | null;
  activeInstallationName: string | null;
  errorMessage: string | null;
  serverUrl: string;
}
