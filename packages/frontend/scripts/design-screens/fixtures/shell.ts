import type { UIBootstrapShell } from "@/types";
import { adminUser } from "./identity";
import { dockerNodes, nodes } from "./nodes";
import { ago, ahead } from "./time";

export const LICENSE_FEATURES = [
  "storage-connections",
  "external-database-connections",
  "gitlab",
  "ai-plan-mode",
  "ai-scenarios",
  "ai-sandboxes",
  "container-export",
  "blue-green",
  "cross-node-migration",
  "managed-storage",
  "managed-databases",
  "status-pages",
  "registry-discovery",
  "pages",
  "secure-runtime",
  "structured-logging",
  "audit-export",
  "git-push-to-deploy",
  "multi-node-availability",
  "compose-applications",
  "internal-pki",
  "siem-export",
];

export const systemConfig = {
  publicUrl: "https://opfield.example.com",
  fileUploadMaxBytes: 100 * 1024 ** 2,
  fileOpenMaxBytes: 10 * 1024 ** 2,
  grpcPublicTarget: "opfield.example.com:9443",
  grpcLocalIp: "10.20.0.2",
  relayAutoRecovery: true,
  features: {
    pkiEnabled: true,
    domainsEnabled: true,
    siemEnabled: true,
    loggingEnabled: true,
    inferenceEnabled: true,
  },
};

export const aiStatus = {
  enabled: true,
  providerType: "opfield_inference" as const,
  defaultModel: "opfield-large",
  allowUserModelSelection: true,
  allowUserReasoningEffortSelection: true,
  reasoningEfforts: ["low", "medium", "high"],
  defaultReasoningEffort: "medium",
  supportsImages: true,
  models: [
    {
      id: "opfield-large",
      displayName: "Opfield Large",
      supportsImages: true,
      maxContextTokens: 200_000,
      maxOutputTokens: 32_000,
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    },
  ],
};

export const updateStatus = {
  currentVersion: "2.14.0",
  latestVersion: "2.14.0",
  updateAvailable: false,
  releaseNotes: null,
  releaseUrl: null,
  lastCheckedAt: ago(40, "m"),
  relay: {
    currentVersion: "2.14.0",
    latestVersion: "2.14.0",
    updateAvailable: false,
    releaseNotes: null,
    releaseUrl: null,
    operation: null,
  },
  opfieldOperation: null,
};

export const uiBootstrap: UIBootstrapShell = {
  access: { fingerprint: "design-fixture", scopes: adminUser.scopes },
  systemConfig,
  navigation: {
    hasNginxNodes: true,
    hasCloudflareIntegration: true,
    statusPageEnabled: true,
    pagesEnabled: true,
    dockerNodes,
    nodes: {
      data: nodes,
      revision: 42,
      observedAt: ago(10, "s"),
      lastAttemptAt: ago(10, "s"),
      lastError: null,
      refreshStatus: "success",
      availability: "available",
    },
  },
  update: updateStatus as UIBootstrapShell["update"],
  aiStatus,
  aiWorkspace: { configured: true, installationOwner: true },
  license: {
    status: "valid",
    plan: "enterprise",
    licensed: true,
    expiresAt: ahead(240, "d"),
    graceUntil: null,
    offlineGraceUntil: null,
    entitlementsVersion: 3,
    entitlements: {
      managedNodes: null,
      users: null,
      customPermissionGroups: null,
      supportLevel: "priority",
      features: LICENSE_FEATURES,
    },
  },
  commercialModule: "ready",
};
