import type { AIProviderStatus } from "./ai";
import type { Node } from "./nodes";
import type {
  LicenseEntitlements,
  LicensePlan,
  LicenseStatus,
  SystemConfig,
  UpdateStatus,
} from "./system";

export type ReadModelAvailability = "available" | "unavailable" | "unknown";
export type ReadModelRefreshStatus = "never" | "refreshing" | "success" | "error";

export interface ReadModelSnapshot<T> {
  data: T;
  revision: number;
  observedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  refreshStatus: ReadModelRefreshStatus;
  availability: ReadModelAvailability;
}

export interface UIBootstrapShell {
  demo?: {
    ctaUrl: "https://opfield.dev";
  };
  access: {
    fingerprint: string;
    scopes: string[];
  };
  systemConfig: SystemConfig;
  navigation: {
    hasNginxNodes: boolean;
    hasCloudflareIntegration: boolean;
    statusPageEnabled: boolean;
    pagesEnabled: boolean;
    /** No apps:view or apps:create, but some app is visible through members the user can view. */
    appsByMembers?: boolean;
    dockerNodes: Node[];
    nodes: ReadModelSnapshot<Node[]>;
  };
  update: UpdateStatus | null;
  aiStatus: AIProviderStatus | null;
  aiWorkspace: {
    configured: boolean;
    installationOwner: boolean;
  };
  license: {
    status: LicenseStatus;
    plan: LicensePlan;
    licensed: boolean;
    expiresAt: string | null;
    graceUntil: string | null;
    offlineGraceUntil: string | null;
    entitlementsVersion: number;
    entitlements: LicenseEntitlements;
  };
  commercialModule?: "community" | "unavailable" | "ready";
}
