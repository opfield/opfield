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
  trigger: "scheduled" | "manual";
  triggeredBy?: string;
  totalDurationMs: number;
  categories: HousekeepingCategoryResult[];
  overallSuccess: boolean;
}

export interface HousekeepingStats {
  nginxLogs: { totalSizeBytes: number; fileCount: number; oldestFile: string | null };
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
  orphanedAIArtifacts: { count: number; totalSizeBytes: number };
  internalRegistry: {
    totalSizeBytes: number;
    capacityBytes: number | null;
    status: string;
    lastGcAt: string | null;
  };
  orphanedVolumes: { count: number; reclaimableBytes: number };
  orphanedCerts: {
    count: number;
    certIds: string[];
    currentCount: number;
    supersededCount: number;
    unknownCount: number;
  };
  acmeChallenges: { fileCount: number; totalSizeBytes: number };
  dockerImages: { oldImageCount: number; reclaimableBytes: number };
  operationHistory?: { count: number };
  oauthCleanup?: { count: number };
  expiredTokens?: { count: number };
  lastRun: HousekeepingRunResult | null;
  isRunning: boolean;
}
