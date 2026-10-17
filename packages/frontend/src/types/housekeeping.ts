// Housekeeping
export interface HousekeepingConfig {
  enabled: boolean;
  cronExpression: string;
  nginxLogs: { enabled: boolean; retentionDays: number };
  auditLog: { enabled: boolean; retentionDays: number };
  dismissedAlerts: { enabled: boolean; retentionDays: number };
  deliveryLog: { enabled: boolean; retentionDays: number };
  structuredLogs: { enabled: boolean; maxRows: number; maxSizeBytes: number };
  clickHouseInternals: { enabled: boolean; maxSizeBytes: number };
  orphanedAIArtifacts: { enabled: boolean };
  internalRegistry: { enabled: true; retentionSuccessfulArtifacts: number };
  orphanedVolumes: { enabled: boolean; retentionDays: number };
  dockerPrune: { enabled: boolean };
  orphanedCerts: { enabled: boolean };
  acmeCleanup: { enabled: boolean };
  operationHistory: { enabled: boolean; retentionDays: number };
  oauthCleanup: { enabled: boolean };
  /** Expired API and inference tokens, removed `retentionDays` after they expired (0: at once). */
  expiredTokens: { enabled: boolean; retentionDays: number };
  /** Settled inference requests with their attempts and usage records (35 days at least). */
  inferenceUsage: { enabled: boolean; retentionDays: number };
  /** Logs of finished builds, by age and by the total size of all build logs. */
  buildLogs: { enabled: boolean; retentionDays: number; maxSizeBytes: number };
  /** Leftovers of interrupted work on the Opfield host. */
  hostFiles: { enabled: boolean };
}

/** One filesystem of the Opfield host that holds Opfield data. */
export interface OpfieldHostDisk {
  holds: string[];
  filesystem: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
}

/** What Opfield's own data takes on the Opfield host. */
export interface OpfieldDiskUsage {
  disks: OpfieldHostDisk[];
  postgres: { databaseBytes: number; largestTables: Array<{ name: string; bytes: number }> } | null;
  redis: {
    memoryBytes: number;
    aofBytes: number | null;
    rdbChangesSinceSave: number | null;
  } | null;
  containerLogs: {
    totalBytes: number;
    largest: Array<{ name: string; bytes: number }>;
    measuredAt: string;
  } | null;
}

export interface HousekeepingCategoryResult {
  category: string;
  success: boolean;
  itemsCleaned: number;
  spaceFreedBytes?: number;
  error?: string;
  durationMs: number;
}

export interface HousekeepingRunResult {
  startedAt: string;
  completedAt: string;
  /** low-disk: started because an Opfield host disk was almost full. */
  trigger: "scheduled" | "manual" | "low-disk";
  triggeredBy?: string;
  totalDurationMs: number;
  categories: HousekeepingCategoryResult[];
  overallSuccess: boolean;
}

export interface HousekeepingStats {
  /** Every nginx node's logs as its daemon reports them; reportingNodeCount < nodeCount: daemons to update. */
  nginxLogs: {
    totalSizeBytes: number;
    fileCount: number;
    oldestFile: string | null;
    nodeCount?: number;
    reportingNodeCount?: number;
  };
  auditLog: { totalRows: number; oldestEntry: string | null };
  dismissedAlerts: { count: number; oldestAlert: string | null };
  deliveryLog: { total: number; success: number; failed: number; retrying: number };
  structuredLogs: { totalRows: number; totalSizeBytes: number; status: string };
  clickHouseInternals: {
    totalRows: number;
    totalSizeBytes: number;
    status: string;
    capBytes: number;
  };
  orphanedAIArtifacts: {
    count: number;
    totalSizeBytes: number;
    allCount?: number;
    allSizeBytes?: number;
    capBytes?: number;
  };
  internalRegistry: {
    totalSizeBytes: number;
    capacityBytes: number | null;
    status: string;
    lastGcAt: string | null;
  };
  orphanedVolumes: {
    count: number;
    reclaimableBytes: number;
    /** Unused volumes Opfield did not create: never removed automatically, only shown. */
    unownedCount?: number;
    unownedBytes?: number;
    /** Volumes counted here whose size is unknown (their node's daemon cannot measure them yet). */
    unmeasuredCount?: number;
  };
  orphanedCerts: {
    count: number;
    certIds: string[];
    currentCount: number;
    supersededCount: number;
    unknownCount: number;
  };
  acmeChallenges: { fileCount: number; totalSizeBytes: number };
  /**
   * oldImageCount/reclaimableBytes = opfieldHost + connectors + every node's removableNow and waiting. A run removes
   * all but `waiting`, which goes at a later run once its unused time is over.
   */
  dockerImages: {
    oldImageCount: number;
    reclaimableBytes: number;
    opfieldHost?: { count: number; bytes: number };
    connectors?: { count: number; bytes: number };
    nodes?: HousekeepingDockerImageNode[];
  };
  operationHistory?: { count: number };
  oauthCleanup?: { count: number };
  expiredTokens?: { count: number };
  inferenceUsage?: { count: number; totalSizeBytes: number };
  buildLogs?: { totalSizeBytes: number; expiredBuilds: number; capBytes: number };
  hostFiles?: { count: number; sizeBytes: number };
  diskUsage?: OpfieldDiskUsage | null;
  lastRun: HousekeepingRunResult | null;
  lastSuccessAt?: string | null;
  /** No successful run for two days. */
  stale?: boolean;
  isRunning: boolean;
}

/** One Docker node's old images by the image cleanup rules. */
export interface HousekeepingDockerImageNode {
  nodeId: string;
  nodeName: string;
  removableNow: { count: number; bytes: number };
  waiting: { count: number; bytes: number; nextRemovableAt: string | null };
  danglingWaiting?: { count: number; bytes: number };
  error?: string;
}
