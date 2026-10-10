import type { AuditLogEntry } from "./pki";

// Apps: an application as its own resource, with environments that hold its members.
// Contract: plan §1.4 (REST under /api/apps). Members sit in hidden per-environment folders;
// normal lists hide them (`excludeAppMembers`) and every resource carries `app` when it is a member.

/** Health of an environment (and of the app: its Production environment). */
export type AppHealth = "healthy" | "degraded" | "failing" | "unknown";

/** Shutdown / kill switch state (Phase 2 fills it; Phase 1 is always "none"). */
export type AppIncidentState = "none" | "stopped" | "isolated" | "partial";

/** The resource families an environment holds (one hidden folder each). */
export type AppMemberFamily =
  | "containers"
  | "compose"
  | "routes"
  | "databases"
  | "storage"
  | "pages";

export type AppMemberType =
  | "container"
  | "deployment"
  | "compose"
  | "database"
  | "storage"
  | "route"
  | "pages";

/** The `app` field of a resource in normal lists and detail responses. */
export interface AppMembershipRef {
  id: string;
  slug: string;
  name: string;
  environmentId: string;
  environmentName: string;
}

export interface AppSummaryEnvironment {
  id: string;
  name: string;
  isProduction: boolean;
  health: AppHealth;
}

export interface AppSummary {
  id: string;
  slug: string;
  name: string;
  environments: AppSummaryEnvironment[];
  /** The Production environment's health. */
  health: AppHealth;
  incident: AppIncidentState;
  /** Production environment totals. */
  cpuPercent: number | null;
  memoryBytes: number | null;
  running: number;
  failing: number;
  degraded: number;
}

export type AppMemberCounts = Partial<Record<AppMemberFamily, number>>;

export type AppPlacementFolderIds = Record<AppMemberFamily, string | null>;

export interface AppEnvironmentDetail {
  id: string;
  slug: string;
  name: string;
  isProduction: boolean;
  maintenanceEnabled: boolean;
  health: AppHealth;
  memberCounts: AppMemberCounts;
  /** Hidden env folder per family: pass as `folderId` to create inside the environment. */
  placementFolderIds: AppPlacementFolderIds;
  allowedNodeIds: string[];
  /** Phase 2. */
  incidents?: unknown[];
}

export interface AppPermissions {
  edit: boolean;
  delete: boolean;
  operate: boolean;
  envManage: Record<string, boolean>;
  promote: Record<string, boolean>;
}

export interface AppDetail {
  id: string;
  slug: string;
  name: string;
  maintenanceOverride: boolean;
  environments: AppEnvironmentDetail[];
  permissions: AppPermissions;
}

export interface AppUpdateInput {
  name?: string;
  maintenanceOverride?: boolean;
}

export interface AppEnvironmentUpdateInput {
  name?: string;
  isProduction?: true;
  maintenanceEnabled?: boolean;
}

/* Members ------------------------------------------------------------------------------------ */

export interface AppMember {
  type: AppMemberType;
  id: string;
  name: string;
  environmentId: string;
  nodeIds: string[];
}

export interface AppPlaceMemberInput {
  type: AppMemberType;
  id?: string;
  nodeId?: string;
  resourceKey?: string;
}

export interface AppPlaceInput {
  /** `null`: take the members out of their app. */
  target: { appId: string; environmentId: string } | null;
  members: AppPlaceMemberInput[];
}

export interface AppPlaceRefusal {
  member: AppPlaceMemberInput;
  code: string;
  message: string;
}

export interface AppPlaceResult {
  placed: number;
  refused: AppPlaceRefusal[];
}

/* Variables and secrets ---------------------------------------------------------------------- */

export interface AppPendingWorkload {
  kind: "container" | "deployment" | "compose";
  /** Container name, deployment id or compose project id. */
  id: string;
  nodeId?: string | null;
  name: string;
}

export interface AppVariables {
  variables: Array<{ key: string; value: string }>;
  secrets: Array<{ key: string; updatedAt: string }>;
  /** Workloads that have not received the current values yet (next recreate or deploy). */
  pendingWorkloads: AppPendingWorkload[];
}

export interface AppSecretsPatch {
  set: Record<string, string>;
  delete: string[];
}

/* Allowed nodes ------------------------------------------------------------------------------ */

export type AppNodeUsage = Partial<Record<AppMemberFamily, number>>;

export interface AppAllowedNode {
  nodeId: string;
  usedBy: AppNodeUsage;
}

export interface AppAllowedNodes {
  nodes: AppAllowedNode[];
}

/* Maintenance access code -------------------------------------------------------------------- */

export interface AppMaintenanceAccessCode {
  code: string;
  expiresAt: string;
  routeCount: number;
}

/* Overview ----------------------------------------------------------------------------------- */

export type AppOverviewRange = "1h" | "24h";

export interface AppOverviewIssue {
  family: AppMemberFamily;
  state: "failing" | "degraded";
  count: number;
}

export interface AppOverviewAlert {
  tone: "destructive" | "warning";
  title: string;
  detail: string;
  /** Console path the alert's action opens. */
  href?: string | null;
  actionLabel?: string | null;
}

export interface AppOverviewContainers {
  total: number;
  healthy: number;
  cpuPercent: number;
  cpuHistory: number[];
  memoryBytes: number;
  memoryLimitBytes: number | null;
  memoryHistory: number[];
  restarts: number;
  restartsHistory: number[];
  /** Names of containers that are not healthy. */
  unhealthy: string[];
}

export interface AppOverviewDatabase {
  id: string;
  slug: string;
  name: string;
  diskBytes: number | null;
  diskPercent: number | null;
  diskHistory: number[];
  connections: number | null;
  maxConnections: number | null;
  connectionsHistory: number[];
  transactionsPerSecond: number | null;
}

export interface AppOverviewStorage {
  id: string;
  slug: string;
  name: string;
  diskBytes: number | null;
  diskPercent: number | null;
  diskHistory: number[];
  objects: number | null;
  objectsHistory: number[];
  buckets: number | null;
  rxBytesPerSecond: number | null;
  rxHistory: number[];
  txBytesPerSecond: number | null;
  txHistory: number[];
}

export interface AppOverviewRoutes {
  total: number;
  requestsPerSecond: number;
  requestsHistory: number[];
  errorsPerSecond: number;
  errorsHistory: number[];
  latencyMs: number | null;
  latencyHistory: number[];
  trafficBytesPerSecond: number;
  trafficHistory: number[];
}

export interface AppOverviewPage {
  id: string;
  slug: string;
  name: string;
  activeDeployment: { id: string; createdAt: string } | null;
  requestsPerSecond: number | null;
  requestsHistory: number[];
}

export interface AppOverviewEnvironment {
  environmentId: string;
  health: AppHealth;
  members: number;
  issues: AppOverviewIssue[];
  alerts: AppOverviewAlert[];
  containers: AppOverviewContainers;
  databases: AppOverviewDatabase[];
  storage: AppOverviewStorage[];
  routes: AppOverviewRoutes;
  pages: AppOverviewPage[];
  nodeIds: string[];
}

export interface AppOverview {
  range: AppOverviewRange;
  measuredAt: string;
  environments: AppOverviewEnvironment[];
}

/* Activity --------------------------------------------------------------------------------- */

export interface AppActivityPage {
  data: AuditLogEntry[];
  total: number;
  page: number;
  limit: number;
}

/* Realtime ----------------------------------------------------------------------------------- */

export const APPS_REALTIME_CHANNEL = "apps";

export interface AppsChangedPayload {
  appId: string;
  action: string;
}
