import type { AuditLogEntry } from "./pki";

// Apps: an application as its own resource, with environments that hold its members.
// Contract: plan §1.4 (REST under /api/apps). Members sit in hidden per-environment folders;
// normal lists hide them (`excludeAppMembers`) and every resource carries `app` when it is a member.

/** Health of an environment (and of the app: its Production environment). */
export type AppHealth = "healthy" | "degraded" | "failing" | "unknown";

/** Shutdown / kill switch state of the app's visible environments. */
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
  /** Present on newer backends: links open the environment's page. */
  environmentSlug?: string;
}

export interface AppSummaryEnvironment {
  id: string;
  slug?: string;
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

/** Visible members of an environment by type. */
export type AppMemberCounts = Partial<Record<AppMemberType, number>>;

export type AppPlacementFolderIds = Record<AppMemberFamily, string | null>;

export interface AppEnvironmentDetail {
  id: string;
  slug: string;
  name: string;
  isProduction: boolean;
  maintenanceEnabled: boolean;
  maintenanceStartedAt?: string | null;
  /** Effective maintenance state of the environment's routes (T11); shape owned by the backend. */
  maintenance?: Record<string, unknown> | null;
  health: AppHealth;
  memberCounts: AppMemberCounts;
  /** Hidden env folder per family: pass as `folderId` to create inside the environment. */
  placementFolderIds: AppPlacementFolderIds;
  allowedNodeIds: string[];
  /** Open shutdown / kill switch incidents of the environment, with their items. */
  incidents?: AppIncident[];
}

export interface AppPermissions {
  edit: boolean;
  delete: boolean;
  operate: boolean;
  envManage: Record<string, boolean>;
  promote: Record<string, boolean>;
  /** apps:operate on one environment (Phase 2 shutdown / isolation per environment). */
  operateEnv?: Record<string, boolean>;
}

export interface AppDetail {
  id: string;
  slug: string;
  name: string;
  maintenanceOverride: boolean;
  maintenanceOverrideAt?: string | null;
  /** Hidden app-root folder per family ("every environment" access lines grant these). */
  rootFolderIds?: AppPlacementFolderIds;
  /** Shutdown / kill switch state over the visible environments. */
  incident?: AppIncidentState;
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

/** The node's task for a workload recreate; the workload runs the new values once it succeeded. */
export interface AppWorkloadTask {
  id: string;
  type: string;
  status: "pending" | "running" | "succeeded" | "failed";
  progress: string | null;
  error: string | null;
  completedAt: string | null;
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

/* Shutdown and kill switch ------------------------------------------------------------------- */

export type AppIncidentKind = "shutdown" | "isolation";

export type AppIncidentItemStatus =
  | "pending"
  | "applied"
  | "failed"
  | "restored"
  | "restore_failed"
  | "gone";

export interface AppIncidentItem {
  id: string;
  kind: string;
  label: string;
  status: AppIncidentItemStatus;
  attempts: number;
  lastError: string | null;
  /** What a restored or gone item could not put back as it was (a network removed meanwhile, for one). */
  detail?: string | null;
}

export interface AppIncidentPerson {
  id: string;
  name: string | null;
}

export interface AppIncident {
  id: string;
  batchId: string;
  environmentId: string;
  kind: AppIncidentKind;
  state: "applying" | "active" | "releasing" | "released" | "failed";
  startedAt: string;
  startedBy: AppIncidentPerson | null;
  releasedAt: string | null;
  releasedBy: AppIncidentPerson | null;
  lastError: string | null;
  counts: {
    total: number;
    pending: number;
    applied: number;
    failed: number;
    restored: number;
    restoreFailed: number;
    gone: number;
  };
  items: AppIncidentItem[];
  /** Items Start or release did not bring back because their resource is gone (deleted meanwhile). */
  skipped?: Array<{ id: string; kind: string; label: string; detail: string | null }>;
}

export interface AppShutdownSummary {
  containers: number;
  deployments: number;
  composeProjects: number;
  databases: number;
  storages: number;
  routes: number;
  pagesRoutes: number;
}

export interface AppIsolationSummary {
  routes: number;
  links: number;
  bindings: number;
  secureLinks: number;
  publications: number;
  containers: number;
  composeProjects: number;
}

export interface AppIncidentPreview<K extends AppIncidentKind = AppIncidentKind> {
  kind: K;
  environments: Array<{
    environmentId: string;
    summary: K extends "shutdown" ? AppShutdownSummary : AppIsolationSummary;
    alreadyActive: boolean;
  }>;
  summary: K extends "shutdown" ? AppShutdownSummary : AppIsolationSummary;
}

/* Promote ------------------------------------------------------------------------------------ */

export type AppPromotableType = "container" | "deployment" | "compose" | "pages";

export interface AppPromotionPreviewItem {
  pairKey: string;
  type: AppPromotableType;
  sourceId: string;
  sourceName: string;
  sourceNodeId: string | null;
  targetId: string;
  targetName: string;
  targetNodeId: string | null;
  from: string | null;
  to: string;
  fromDigest: string | null;
  toDigest: string | null;
  same: boolean;
  promotable: boolean;
  reason: string | null;
  rollout: string;
  build: { commitSha: string; buildId: string } | null;
  compose?: {
    fromRevision: number | null;
    toRevision: number | null;
    services: Array<{ name: string; from: string | null; to: string | null; changed: boolean }>;
    changes: Array<{ path: string; from: string | null; to: string | null }>;
  };
  pages?: { fromSequence: number | null; toSequence: number | null; artifactSha256: string | null };
}

export interface AppPromotionPreview {
  appId: string;
  sourceEnvironmentId: string;
  targetEnvironmentId: string;
  items: AppPromotionPreviewItem[];
  unchanged: string[];
  unpaired: Array<{
    type: AppPromotableType;
    id: string;
    name: string;
    reason: string;
    message: string;
  }>;
  previewDigest: string;
}

export type AppPromotionItemStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface AppPromotionItem {
  pairKey: string;
  type: AppPromotableType;
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  from: string | null;
  to: string;
  status: AppPromotionItemStatus;
  detail: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AppPromotion {
  id: string;
  appId: string;
  sourceEnvironmentId: string;
  targetEnvironmentId: string;
  status: "running" | "succeeded" | "partial" | "failed";
  startedAt: string;
  finishedAt: string | null;
  startedBy: AppIncidentPerson | null;
  items: AppPromotionItem[];
}

/* Realtime ----------------------------------------------------------------------------------- */

export const APPS_REALTIME_CHANNEL = "apps";

export interface AppsChangedPayload {
  appId: string;
  action: string;
}
