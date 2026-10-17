/**
 * Settings tabs beyond General: registries, environment limits, the relay
 * pool, internal registry, Pages and status page profiles, housekeeping,
 * integrations, inference and the AI workspace. Seeds 65100–65299.
 */

import type {
  DashboardRelaySnapshot,
  DockerInternalRegistryState,
  DockerRegistry,
  EnvironmentSettings,
  ExternalSshConnector,
  GitConnector,
  GitLabConnector,
  HousekeepingConfig,
  HousekeepingStats,
  InferenceActivity,
  InferenceLimitPolicy,
  InferenceModel,
  InferenceProviderCatalogItem,
  InferenceProviderConnection,
  InferenceUserUsage,
  PageProfile,
  PageProfileOptions,
  StatusPageProxyTemplateOption,
} from "@/types";
import type { AIAgentSkill, AISandboxArtifact, AISandboxStatus } from "@/types/ai";
import type { HostingConnector } from "@/types/hosting";
import type { InferenceCoreStatus } from "@/types/inference-core";
import { people } from "../catalog";
import { sslCertificates } from "../edge/ssl";
import { pagesProfileConfigured, pagesProfileOptions } from "../ingress/pages-profile";
import { edgeNode, nodeBySlug } from "../nodes";
import { ago, agoMs, ahead, uuid } from "../time";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const apps1 = nodeBySlug("apps-1")!;
const edgeAms = nodeBySlug("edge-ams-1")!;

export const dockerRegistries: DockerRegistry[] = [
  {
    id: uuid(65101),
    name: "Northwind registry",
    url: "registry.example.com",
    username: "opfield-pull",
    scope: "global",
    source: "manual",
    createdAt: ago(190, "d"),
    updatedAt: ago(40, "d"),
  },
  {
    id: uuid(65102),
    name: "GitLab · northwind/storefront",
    url: "gitlab.example.com:5050",
    username: "gitlab-ci-token",
    scope: "global",
    source: "integration",
    provider: "gitlab",
    readOnly: true,
    integration: {
      provider: "gitlab",
      connectorId: uuid(65140),
      connectorName: "Northwind GitLab",
      connectorBaseUrl: "https://gitlab.example.com",
      projectRemoteId: "418",
      projectFullPath: "northwind/storefront",
      remoteRegistryId: "77",
      status: "available",
      lastSeenAt: ago(12, "m"),
    },
    createdAt: ago(120, "d"),
    updatedAt: ago(12, "m"),
  },
  {
    id: uuid(65103),
    name: "Docker Hub mirror (apps-1)",
    url: "mirror.example.net",
    username: "northwind",
    scope: "node",
    nodeId: apps1.id,
    source: "manual",
    createdAt: ago(75, "d"),
    updatedAt: ago(75, "d"),
  },
];

const environmentDefaults: EnvironmentSettings = {
  rateLimits: {
    windowMs: 60_000,
    maxRequests: 1_000,
    sessionMaxRequests: 6_000,
    authMaxRequests: 60,
    authLoginMaxRequests: 10,
    authCallbackMaxRequests: 30,
    setupMaxRequests: 10,
    publicStatusMaxRequests: 120,
    publicWebhookMaxRequests: 60,
    pkiMaxRequests: 300,
    streamMaxRequests: 120,
    aiWebSocketMaxRequests: 30,
    inferenceMaxRequests: 600,
  },
  loggingIngest: {
    maxBodyBytes: 5 * MiB,
    maxBatchSize: 500,
    maxMessageBytes: 16_384,
    maxLabels: 32,
    maxFields: 64,
    maxKeyLength: 128,
    maxValueBytes: 8_192,
    maxJsonDepth: 8,
    rateLimitWindowSeconds: 60,
    globalRequestsPerWindow: 6_000,
    globalEventsPerWindow: 600_000,
    tokenRequestsPerWindow: 600,
    tokenEventsPerWindow: 60_000,
  },
  requestLimits: {
    requestBodyMaxBytes: 10 * MiB,
    oauthBodyMaxBytes: 64 * 1024,
    inferenceHttpBodyMaxBytes: 32 * MiB,
    inferenceWebSocketMaxPayloadBytes: 32 * MiB,
    inferenceMaxConcurrentRequestsPerToken: 8,
    inferenceConcurrencyLeaseSeconds: 900,
  },
  sessions: { expirySeconds: 7 * 24 * 3600 },
  pkiDefaults: { crlValidityHours: 24, expiryWarningDays: 30, expiryCriticalDays: 7 },
};

export const environmentSettings = {
  data: {
    ...environmentDefaults,
    rateLimits: {
      ...environmentDefaults.rateLimits,
      maxRequests: 2_000,
      publicStatusMaxRequests: 300,
    },
    sessions: { expirySeconds: 12 * 3600 },
  },
  defaults: environmentDefaults,
};

export const relaySnapshot: DashboardRelaySnapshot = {
  state: "healthy",
  impact: null,
  attempt: 0,
  maxAttempts: 3,
  lastHealthyAt: ago(20, "s"),
  lastProbeAt: ago(20, "s"),
  relayBuildVersion: "2.14.0",
  protocolMajor: 3,
  registeredEndpoints: 14,
  activeTunnels: 41,
  activeProxyTunnels: 33,
  activeDatabaseTunnels: 8,
  throttledProxyTotal: 0,
  throttledDatabaseTotal: 0,
  pressurePercent: 22,
  cpuPressurePercent: 18,
  memoryPressurePercent: 22,
  fdPressurePercent: 6,
  admissionState: "normal",
  memoryRssBytes: 182 * MiB,
  heapInUseBytes: 96 * MiB,
  memoryLimitBytes: 1 * GiB,
  openFileDescriptors: 612,
  fileDescriptorLimit: 65_536,
  canRetry: false,
  poolId: uuid(65110),
  rebalanceAvailable: false,
  worstPressurePercent: 31,
  endpointCount: 14,
  instances: [
    {
      id: uuid(65111),
      kind: "local",
      nodeId: null,
      faultDomainId: "opfield",
      displayName: "Opfield relay",
      advertisedAddresses: ["10.0.20.2"],
      servicePort: 7443,
      state: "ready",
      buildVersion: "2.14.0",
      protocolMajor: 3,
      appliedPolicyRevision: 58,
      policyExpiresAt: ahead(26, "d"),
      lastSeenAt: ago(5, "s"),
      activeAssignments: 9,
      health: { activeTunnels: 27, registeredEndpoints: 9, pressurePercent: 22 },
      policyTrust: null,
      certificate: null,
    },
    {
      id: uuid(65112),
      kind: "remote",
      nodeId: edgeAms.id,
      faultDomainId: "ams",
      displayName: "edge-ams-1 relay",
      advertisedAddresses: ["10.0.21.12"],
      servicePort: 7443,
      state: "ready",
      buildVersion: "2.14.0",
      protocolMajor: 3,
      appliedPolicyRevision: 58,
      policyExpiresAt: ahead(26, "d"),
      lastSeenAt: ago(7, "s"),
      activeAssignments: 5,
      health: { activeTunnels: 14, registeredEndpoints: 5, pressurePercent: 31 },
      policyTrust: null,
      certificate: null,
    },
  ],
  staging: [],
  failures: [],
  blockers: [],
  automaticRebalancePaused: false,
  update: null,
};

export const internalRegistryState: DockerInternalRegistryState = {
  status: "ready",
  writable: true,
  storageBackend: "filesystem",
  storageUsedBytes: 18.4 * GiB,
  storageCapacityBytes: 120 * GiB,
  externalAccessEnabled: true,
  externalHostname: "registry.example.com",
  externalNginxNodeId: edgeNode.id,
  externalCertificateId: null,
  maintenancePhase: "idle",
  lastGcAt: ago(20, "h"),
  nextGcAt: ahead(4, "h"),
  lastError: null,
};

const statusCert = sslCertificates.find((cert) => cert.name === "status.example.com");

/** The Pages profile the Pages screens use: previews under pages.example.com, the shared parent acknowledged. */
export const pageProfile: PageProfile = pagesProfileConfigured;

export const pageProfileOptions: PageProfileOptions = pagesProfileOptions;

export const statusPageCertificateId = statusCert?.id ?? null;

export const statusPageProxyTemplates: StatusPageProxyTemplateOption[] = [
  { id: uuid(65125), name: "Hardened public site" },
  { id: uuid(65126), name: "Cache static assets" },
];

export const housekeepingConfig: HousekeepingConfig = {
  enabled: true,
  cronExpression: "30 3 * * *",
  nginxLogs: { enabled: true, retentionDays: 14 },
  auditLog: { enabled: true, retentionDays: 365 },
  dismissedAlerts: { enabled: true, retentionDays: 30 },
  deliveryLog: { enabled: true, retentionDays: 30 },
  structuredLogs: { enabled: true, maxRows: 50_000_000, maxSizeBytes: 40 * GiB },
  clickHouseInternals: { enabled: true, maxSizeBytes: 2 * GiB },
  orphanedAIArtifacts: { enabled: true },
  internalRegistry: { enabled: true, retentionSuccessfulArtifacts: 3 },
  orphanedVolumes: { enabled: false, retentionDays: 14 },
  dockerPrune: { enabled: true },
  orphanedCerts: { enabled: true },
  acmeCleanup: { enabled: true },
  operationHistory: { enabled: true, retentionDays: 90 },
  oauthCleanup: { enabled: true },
  expiredTokens: { enabled: true, retentionDays: 7 },
};

export const housekeepingStats: HousekeepingStats = {
  nginxLogs: {
    totalSizeBytes: 3.1 * GiB,
    fileCount: 214,
    oldestFile: ago(14, "d"),
    nodeCount: 2,
    reportingNodeCount: 2,
  },
  auditLog: { totalRows: 184_302, oldestEntry: ago(362, "d") },
  dismissedAlerts: { count: 38, oldestAlert: ago(29, "d") },
  deliveryLog: { total: 1_284, success: 1_271, failed: 9, retrying: 4 },
  structuredLogs: { totalRows: 21_480_112, totalSizeBytes: 17.2 * GiB, status: "ok" },
  clickHouseInternals: {
    totalRows: 3_920_441,
    totalSizeBytes: 1.1 * GiB,
    status: "ok",
    capBytes: 2 * GiB,
  },
  orphanedAIArtifacts: { count: 6, totalSizeBytes: 48 * MiB },
  internalRegistry: {
    totalSizeBytes: 18.4 * GiB,
    capacityBytes: 120 * GiB,
    status: "ready",
    lastGcAt: ago(20, "h"),
  },
  orphanedVolumes: { count: 3, reclaimableBytes: 2.4 * GiB },
  orphanedCerts: { count: 2, certIds: [], currentCount: 0, supersededCount: 2, unknownCount: 0 },
  acmeChallenges: { fileCount: 4, totalSizeBytes: 3_072 },
  dockerImages: { oldImageCount: 7, reclaimableBytes: 5.6 * GiB },
  operationHistory: { count: 1_902 },
  oauthCleanup: { count: 41 },
  expiredTokens: { count: 2 },
  lastRun: {
    startedAt: ago(20, "h"),
    completedAt: ago(1_196, "m"),
    trigger: "scheduled",
    totalDurationMs: 238_000,
    categories: [],
    overallSuccess: true,
  },
  isRunning: false,
};

export const gitlabConnectors: GitLabConnector[] = [
  {
    id: uuid(65140),
    provider: "gitlab",
    name: "Northwind GitLab",
    baseUrl: "https://gitlab.example.com",
    enabled: true,
    allowlistMode: "selected",
    settings: {
      autoSyncEnabled: true,
      autoSyncIntervalSeconds: 900,
      cloneShallow: true,
      cloneDepth: 1,
      cloneLfs: false,
      cloneSubmodules: true,
      cloneMaxSizeMb: 2_048,
      cloneTimeoutSeconds: 600,
    },
    capabilities: {},
    syncStatus: "success",
    syncLastError: null,
    syncFailureCount: 0,
    syncStartedAt: ago(12, "m"),
    syncFinishedAt: ago(12, "m"),
    testedAt: ago(20, "d"),
    createdAt: ago(150, "d"),
    updatedAt: ago(12, "m"),
    hasToken: true,
    tokenMasked: "glpat-…3kQa",
    allowlistEntries: [
      { entryType: "group", remoteId: "12", fullPath: "northwind", name: "Northwind" },
    ],
  },
];

function gitConnector(
  seed: number,
  overrides: Partial<GitConnector> & Pick<GitConnector, "provider" | "name" | "baseUrl">
): GitConnector {
  return {
    id: uuid(65150 + seed),
    enabled: true,
    authMode: "token",
    username: null,
    allowlistMode: "selected",
    capabilities: {},
    settings: {
      repositoryMode: "multi_repository",
      autoSyncEnabled: true,
      autoSyncIntervalSeconds: 900,
    },
    syncStatus: "success",
    syncLastError: null,
    syncFinishedAt: ago(15 + seed, "m"),
    testedAt: ago(30, "d"),
    createdAt: ago(100 - seed * 10, "d"),
    updatedAt: ago(15 + seed, "m"),
    tokenMasked: "…9fQ2",
    hasToken: true,
    allowlistEntries: [],
    ...overrides,
  };
}

export const githubConnectors: GitConnector[] = [
  gitConnector(1, {
    provider: "github",
    name: "Northwind on GitHub",
    baseUrl: "https://github.example.com",
    authMode: "oauth",
    username: "northwind-bot",
  }),
];

export const gitConnectors: GitConnector[] = [
  gitConnector(2, {
    provider: "git",
    name: "Docs repository",
    baseUrl: "https://git.example.org/northwind/docs.git",
    username: "deploy",
    settings: {
      repositoryMode: "single_repository",
      autoSyncEnabled: true,
      autoSyncIntervalSeconds: 1_800,
    },
    syncStatus: "error",
    syncLastError: "authentication failed: token expired",
  }),
];

export const sshConnectors: ExternalSshConnector[] = [
  {
    id: uuid(65160),
    name: "Build bastion",
    host: "bastion.example.com",
    port: 22,
    username: "opfield",
    authMethod: "private_key",
    hostFingerprint: "SHA256:Qm9ydGh3aW5kLWJhc3Rpb24tZXhhbXBsZS1rZXk",
    jumpConnectorId: null,
    enabled: true,
    testStatus: "success",
    testLastError: null,
    testedAt: ago(3, "d"),
  },
  {
    id: uuid(65161),
    name: "Legacy CRM host",
    host: "10.0.40.12",
    port: 2222,
    username: "export",
    authMethod: "password",
    hostFingerprint: "SHA256:TGVnYWN5LWNybS1ob3N0LWV4YW1wbGUta2V5",
    jumpConnectorId: uuid(65160),
    enabled: true,
    testStatus: "error",
    testLastError: "dial tcp 10.0.40.12:2222: i/o timeout",
    testedAt: ago(40, "m"),
  },
];

export const hostingConnectors: HostingConnector[] = [
  {
    id: uuid(65170),
    provider: "hetzner",
    name: "Hetzner Cloud",
    baseUrl: "https://api.hetzner.example.com",
    enabled: true,
    tokenLast4: "Zt4x",
    settings: {
      kind: "hosting",
      autoSyncEnabled: true,
      autoSyncIntervalSeconds: 900,
      resourceIds: [],
      adoptionNodeIds: [],
      adoptionEnabled: true,
      defaultLocation: "fsn1",
      defaultSize: "cx32",
      defaultImage: "ubuntu-24.04",
    },
    hasCustomCa: false,
    certificateFingerprint: null,
    capabilities: {},
    syncStatus: "success",
    syncLastError: null,
    testedAt: ago(12, "d"),
    syncedAt: ago(8, "m"),
    createdAt: ago(80, "d"),
  },
  {
    id: uuid(65171),
    provider: "proxmox",
    name: "Lab Proxmox",
    baseUrl: "https://10.0.9.10:8006",
    enabled: true,
    tokenLast4: "p9Lm",
    settings: {
      kind: "hosting",
      autoSyncEnabled: true,
      autoSyncIntervalSeconds: 1_800,
      resourceIds: [],
      adoptionNodeIds: [],
      adoptionEnabled: false,
      proxmox: {
        nodes: ["pve-1"],
        storage: "local-lvm",
        bridge: "vmbr0",
        network: "dhcp",
      },
    },
    hasCustomCa: true,
    certificateFingerprint: "SHA256:UHJveG1veC1sYWItZXhhbXBsZS1jZXJ0",
    capabilities: {},
    syncStatus: "success",
    syncLastError: null,
    testedAt: ago(5, "d"),
    syncedAt: ago(21, "m"),
    createdAt: ago(45, "d"),
  },
];

const userLimits = {
  enabled: true,
  credits5hEnabled: true,
  credits5h: 40,
  credits7dEnabled: true,
  credits7d: 300,
  credits30dEnabled: false,
  credits30d: 1_000,
  apiMonthlyMicrodollars: 0,
  billingTimezone: "UTC",
};

export const inferenceUsers: InferenceUserUsage[] = people.map((person, index) => ({
  id: person.id,
  email: person.email,
  name: person.name,
  avatarUrl: null,
  limits: userLimits,
  usage: {
    credits5h: [6.2, 14.8, 1.4, 31.5][index],
    credits7d: [88, 142, 12, 261][index],
    credits30d: [310, 402, 40, 690][index],
    apiMonthlyMicrodollars: 0,
    active: { "5h": true, "7d": true },
    recoveryAt: { "5h": ahead(3, "h"), "7d": ahead(4, "d") },
  },
}));

export const inferenceLimits: InferenceLimitPolicy[] = [
  {
    id: uuid(65180),
    policyType: "default",
    userId: null,
    enabled: true,
    credits5hEnabled: true,
    credits5h: "40",
    credits7dEnabled: true,
    credits7d: "300",
    credits30dEnabled: false,
    credits30d: "1000",
    apiMonthlyMicrodollars: 0,
    billingTimezone: "UTC",
  },
];

const ACTIVITY: Array<[number, number, string, string, number, number, number]> = [
  [0, 2, "opfield-large", "completed", 0.42, 18_400, 1_220],
  [1, 6, "opfield-large", "completed", 0.31, 12_900, 840],
  [3, 11, "opfield-small", "completed", 0.04, 3_100, 410],
  [0, 18, "opfield-large", "failed", 0, 22_000, 0],
  [1, 27, "opfield-large", "completed", 0.56, 24_800, 1_690],
  [2, 41, "opfield-small", "completed", 0.03, 2_400, 300],
];

export const inferenceActivity: InferenceActivity[] = ACTIVITY.map(
  ([personIndex, minutesAgo, model, status, credits, input, output], index) => {
    const person = people[personIndex];
    return {
      id: uuid(65190 + index),
      userId: person.id,
      userName: person.name,
      userEmail: person.email,
      userAvatarUrl: null,
      protocol: "openai",
      operation: "chat.completions",
      publicModelId: model,
      reasoningEffort: model === "opfield-large" ? "medium" : null,
      providerConnectionName: "Primary provider",
      providerAccountLabel: "northwind-prod",
      budgetType: "subscription",
      status,
      credits,
      apiMicrodollars: 0,
      uncachedInputTokens: input,
      cachedInputTokens: Math.round(input * 0.4),
      cacheWriteTokens: 0,
      outputTokens: output,
      reasoningTokens: Math.round(output * 0.3),
      errorCode: status === "failed" ? "upstream_timeout" : null,
      startedAt: new Date(agoMs(minutesAgo, "m")).toISOString(),
      completedAt: new Date(agoMs(minutesAgo - 0.2, "m")).toISOString(),
    };
  }
);

export const inferenceCoreStatus: InferenceCoreStatus = {
  state: "ready",
  installed: {
    version: "1.9.2",
    digest: "sha256:4f1c9a2e77b3",
    imageRef: "registry.example.com/opfield/inference-core:1.9.2",
  },
  latest: {
    version: "1.9.2",
    digest: "sha256:4f1c9a2e77b3",
    sizeBytes: 212 * MiB,
    releaseNotesUrl: null,
  },
  compatibility: "compatible",
  health: {
    status: "healthy",
    version: "1.9.2",
    coreProtocolMajor: 2,
    stateSchemaVersion: 7,
    checkedAt: ago(30, "s"),
  },
  operation: null,
  lastError: null,
};

export const aiConfig = {
  enabled: true,
  providerType: "opfield_inference",
  providerUrl: "",
  endpointMode: "chat_completions",
  supportsImages: true,
  model: "",
  opfieldInferenceModel: "opfield-large",
  opfieldInferenceAllowUserModelSelection: true,
  allowUserReasoningEffortSelection: true,
  opfieldInferenceModels: [
    {
      id: "opfield-large",
      displayName: "Opfield Large",
      supportsImages: true,
      maxContextTokens: 200_000,
      maxOutputTokens: 32_000,
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "opfield-small",
      displayName: "Opfield Small",
      supportsImages: false,
      maxContextTokens: 64_000,
      maxOutputTokens: 8_000,
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    },
  ],
  maxCompletionTokens: 16_000,
  maxTokensField: "max_completion_tokens",
  reasoningEffort: "medium",
  customSystemPrompt: "Answer as the Northwind platform assistant. Prefer read-only checks first.",
  rateLimitMax: 30,
  rateLimitWindowSeconds: 60,
  maxToolRounds: 40,
  maxContextTokens: 200_000,
  disabledTools: [],
  hasApiKey: false,
  apiKeyLast4: "",
  hasWebSearchKey: true,
  webSearchApiKeyLast4: "X2a9",
  webSearchProvider: "brave",
  webSearchBaseUrl: "",
  sandboxEnabled: true,
  sandboxDefaultTier: "medium",
};

export const inferenceProviderCatalog: InferenceProviderCatalogItem[] = [
  {
    id: "openai-compatible",
    label: "OpenAI-compatible API",
    family: "openai",
    wireProtocol: "openai",
    baseUrl: "https://llm.example.com/v1",
    authTypes: ["api_key"],
    subscription: false,
    featured: true,
    oauthFlow: null,
    completionMode: null,
    supportedOperations: ["inference"],
    allowBaseUrlOverride: true,
  },
  {
    id: "local-runtime",
    label: "Local runtime",
    family: "custom",
    wireProtocol: "openai",
    baseUrl: "http://10.0.30.5:8080/v1",
    authTypes: ["local"],
    subscription: false,
    featured: false,
    oauthFlow: null,
    completionMode: null,
    supportedOperations: ["inference"],
    allowBaseUrlOverride: true,
  },
];

const primaryConnectionId = uuid(65220);
const localConnectionId = uuid(65221);

function discovered(
  connectionId: string,
  seed: number,
  remoteModelId: string,
  contextWindow: number
) {
  return {
    id: uuid(65230 + seed),
    connectionId,
    remoteModelId,
    displayName: remoteModelId,
    contextWindow,
    maxInputTokens: contextWindow,
    maxOutputTokens: 32_000,
    autoCompactTokenLimit: null,
    modalities: ["text"],
    capabilities: { tools: true },
    reasoningEfforts: [],
    pricing: null,
    available: true,
  };
}

export const inferenceConnections: InferenceProviderConnection[] = [
  {
    id: primaryConnectionId,
    providerId: "openai-compatible",
    name: "Primary provider",
    authType: "api_key",
    baseUrl: "https://llm.example.com/v1",
    accountLabel: "northwind-prod",
    enabled: true,
    routingOrder: 0,
    minimumRemainingPercent: 5,
    apiMonthlyLimitMicrodollars: 250_000_000,
    apiMonthlySpentMicrodollars: 61_400_000,
    routingStrategy: "balanced",
    status: "healthy",
    healthReason: null,
    syncStatus: "success",
    syncLastError: null,
    lastSyncedAt: ago(14, "m"),
    credential: {
      connectionId: primaryConnectionId,
      kind: "api_key",
      last4: "9QeX",
      expiresAt: null,
    },
    quota: [],
    discoveredModels: [
      discovered(primaryConnectionId, 1, "large-2026-08", 200_000),
      discovered(primaryConnectionId, 2, "small-2026-06", 64_000),
    ],
  },
  {
    id: localConnectionId,
    providerId: "local-runtime",
    name: "GPU box (apps-2)",
    authType: "local",
    baseUrl: "http://10.0.30.5:8080/v1",
    accountLabel: null,
    enabled: true,
    routingOrder: 1,
    minimumRemainingPercent: 0,
    apiMonthlyLimitMicrodollars: null,
    apiMonthlySpentMicrodollars: 0,
    routingStrategy: "sequential",
    status: "degraded",
    healthReason: "Queue depth above 20 for 6 minutes",
    syncStatus: "success",
    syncLastError: null,
    lastSyncedAt: ago(9, "m"),
    credential: null,
    quota: [],
    discoveredModels: [discovered(localConnectionId, 3, "open-weights-32b", 32_000)],
  },
];

function modelSource(
  seed: number,
  connection: InferenceProviderConnection,
  upstreamModelId: string
) {
  return {
    id: uuid(65240 + seed),
    connectionId: connection.id,
    discoveredModelId: null,
    providerId: connection.providerId,
    connectionName: connection.name,
    upstreamModelId,
    sourceType: "api" as const,
    enabled: true,
    priority: seed,
    subscriptionMultiplierOverride: null,
    reasoningEffortMap: {},
    reasoningEfforts: [],
    capabilities: { tools: true },
    contextWindow: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    autoCompactTokenLimit: null,
    modalities: ["text"],
    capabilitiesOverride: null,
    metadata: {},
    pricing: null,
  };
}

export const inferenceModels: InferenceModel[] = [
  {
    id: uuid(65250),
    publicId: "opfield-large",
    displayName: "Opfield Large",
    sortOrder: 0,
    enabled: true,
    contextWindow: 200_000,
    maxInputTokens: 200_000,
    maxOutputTokens: 32_000,
    autoCompactTokenLimit: 180_000,
    modalities: ["text", "image"],
    capabilities: { tools: true, images: true },
    configuredCapabilities: {},
    capabilityLimitations: {},
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    defaultAccessAllowed: true,
    accessMode: "everyone",
    accessSubjects: [],
    subscriptionMultiplier: 1,
    sources: [modelSource(0, inferenceConnections[0], "large-2026-08")],
    accessRules: [],
  },
  {
    id: uuid(65251),
    publicId: "opfield-small",
    displayName: "Opfield Small",
    sortOrder: 1,
    enabled: true,
    contextWindow: 64_000,
    maxInputTokens: 64_000,
    maxOutputTokens: 8_000,
    autoCompactTokenLimit: 56_000,
    modalities: ["text"],
    capabilities: { tools: true },
    configuredCapabilities: {},
    capabilityLimitations: {},
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    defaultAccessAllowed: true,
    accessMode: "everyone",
    accessSubjects: [],
    subscriptionMultiplier: 0.25,
    sources: [
      modelSource(1, inferenceConnections[0], "small-2026-06"),
      modelSource(2, inferenceConnections[1], "open-weights-32b"),
    ],
    accessRules: [],
  },
];

export const aiSkills: AIAgentSkill[] = [
  {
    id: uuid(65260),
    name: "incident-triage",
    description: "Collect route health, recent deploys and error logs before proposing a fix",
    instructions: "Start with read-only checks. Summarize findings before any change.",
    source: "user",
    enabled: true,
    createdAt: ago(40, "d"),
    updatedAt: ago(8, "d"),
  },
  {
    id: uuid(65261),
    name: "certificate-rotation",
    description: "Rotate expiring certificates and verify the new chain on every route",
    instructions: "List certificates expiring within 14 days, rotate, then re-test each route.",
    source: "user",
    enabled: true,
    createdAt: ago(22, "d"),
    updatedAt: ago(22, "d"),
  },
  {
    id: uuid(65262),
    name: "opfield-operations",
    description: "Built-in guidance for Opfield resources and safe operations",
    instructions: "",
    source: "system",
    enabled: true,
    createdAt: null,
    updatedAt: null,
  },
];

export const aiSandboxStatus: AISandboxStatus = { state: "running", pid: 4_182 };

export const aiSandboxArtifacts: AISandboxArtifact[] = [
  ["orders-by-status.csv", "text/csv", 18_402, 3],
  ["route-latency-report.md", "text/markdown", 6_190, 26],
  ["backup-sizes.png", "image/png", 84_211, 70],
].map(([filename, mediaType, sizeBytes, hoursAgo], index) => ({
  id: uuid(65270 + index),
  userId: people[index % 2].id,
  conversationId: uuid(65280 + index),
  conversationTitle: ["Weekly order stats", "Route latency review", "Backup growth"][index],
  sourceProcessId: uuid(65290 + index),
  sourcePath: `/workspace/${filename}`,
  filename: String(filename),
  mediaType: String(mediaType),
  sizeBytes: Number(sizeBytes),
  createdAt: ago(Number(hoursAgo), "h"),
  downloadUrl: `/api/ai/sandbox/artifacts/${uuid(65270 + index)}/download`,
}));
