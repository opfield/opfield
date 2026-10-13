export interface InferenceToken {
  id: string;
  name: string;
  tokenPrefix: string;
  status: "active" | "revoked";
  /** Null: never expires. */
  expiresAt: string | null;
  /** The expiry passed: refused, listed as Expired until housekeeping removes it. */
  expired: boolean;
  /** Empty: any address. */
  allowedIps: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface InferenceUsageWindow {
  active?: boolean;
  percentage: number;
  recoveryAt: string;
}

export interface InferenceConfiguredUsageWindow extends InferenceUsageWindow {
  configured: boolean;
}

export interface InferenceSelfUsage {
  measuredAt?: string;
  enabled: boolean;
  api: InferenceConfiguredUsageWindow;
  subscription: {
    "5h": InferenceConfiguredUsageWindow;
    "7d": InferenceConfiguredUsageWindow;
    "30d": InferenceConfiguredUsageWindow;
  };
}

export interface InferenceUsageOverview {
  windowDays: number;
  requestTotals: Array<{
    status: string;
    requests: number;
    credits: string;
    apiMicrodollars: number;
    tokens: number;
  }>;
  ledgerTotals: Array<{
    budgetType: string;
    credits: string;
    apiMicrodollars: number;
    tokens: number;
  }>;
  dailyUsage: Array<{
    date: string;
    requests: number;
    credits: number;
    apiMicrodollars: number;
    tokens: number;
  }>;
}

export interface InferenceProviderCatalogItem {
  id: string;
  label: string;
  family: "openai" | "anthropic" | "kimi" | "google" | "custom";
  wireProtocol: string;
  baseUrl: string;
  authTypes: Array<"oauth" | "api_key" | "local">;
  subscription: boolean;
  featured: boolean;
  termsVersion?: string;
  oauthFlow: "redirect" | "device" | null;
  completionMode: "paste_callback" | "device_poll" | null;
  supportedOperations?: Array<"inference" | "images" | "search" | "realtime">;
  allowBaseUrlOverride?: boolean;
}

export interface InferenceOAuthSession {
  id: string;
  providerId: string;
  status: "pending" | "complete" | "error" | "expired" | "cancelled";
  authorizationUrl: string;
  completionMode: "paste_callback" | "device_poll";
  userCode?: string | null;
  pollIntervalSeconds?: number | null;
  connectionId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  expiresAt: string;
}

export interface InferenceQuotaWindow {
  dimension: string;
  modelBucket?: string | null;
  status: string;
  remainingFraction?: number | null;
  remainingValue?: string | null;
  limitValue?: string | null;
  resetAt?: string | null;
  fetchedAt?: string;
  stale?: boolean;
}

export interface InferenceDiscoveredModel {
  id: string;
  connectionId: string;
  remoteModelId: string;
  displayName: string | null;
  contextWindow: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  autoCompactTokenLimit: number | null;
  modalities: string[];
  capabilities: Record<string, boolean>;
  reasoningEfforts: string[];
  metadataSources?: Partial<Record<InferenceModelMetadataField, InferenceModelMetadataSource>>;
  pricing?: InferenceProviderModelPricing | null;
  available: boolean;
}

/** provider: live provider API; fallback: built-in catalog; derived: calculated by Opfield from provider limits. */
export type InferenceModelMetadataSource = "provider" | "fallback" | "derived";
export type InferenceModelMetadataField =
  | "displayName"
  | "contextWindow"
  | "maxInputTokens"
  | "maxOutputTokens"
  | "autoCompactTokenLimit"
  | "reasoningEfforts"
  | "modalities"
  | "capabilities";

export interface InferenceProviderModelPricing {
  version: string;
  inputMicrodollarsPerMillion: number;
  cachedInputMicrodollarsPerMillion?: number | null;
  cacheWriteMicrodollarsPerMillion?: number | null;
  outputMicrodollarsPerMillion: number;
  reasoningMicrodollarsPerMillion?: number | null;
  otherUnitPrices?: Record<string, number>;
  source: "provider";
}

export interface InferenceProviderConnection {
  id: string;
  providerId: string;
  name: string;
  authType: "oauth" | "api_key" | "local";
  baseUrl: string;
  accountLabel: string | null;
  accountExternalId?: string | null;
  enabled: boolean;
  routingOrder: number;
  minimumRemainingPercent: number;
  apiMonthlyLimitMicrodollars: number | null;
  apiMonthlySpentMicrodollars: number;
  routingStrategy: "even" | "balanced" | "sequential";
  status: string;
  healthReason: string | null;
  syncStatus: "never" | "running" | "success" | "error";
  syncLastError: string | null;
  lastSyncedAt: string | null;
  nextSyncAt?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  credential?: {
    connectionId: string;
    kind: string;
    last4: string | null;
    expiresAt: string | null;
  } | null;
  quota: InferenceQuotaWindow[];
  discoveredModels: InferenceDiscoveredModel[];
}

export interface InferencePricing {
  id: string;
  version: string;
  inputMicrodollarsPerMillion: number | null;
  cachedInputMicrodollarsPerMillion?: number | null;
  cacheWriteMicrodollarsPerMillion?: number | null;
  outputMicrodollarsPerMillion: number | null;
  reasoningMicrodollarsPerMillion?: number | null;
  otherUnitPrices: Record<string, number>;
  source: "provider" | "manual";
}

export interface InferenceModelSource {
  id: string;
  connectionId: string;
  discoveredModelId: string | null;
  providerId: string;
  connectionName: string;
  upstreamModelId: string;
  sourceType: "subscription" | "api";
  enabled: boolean;
  priority: number;
  subscriptionMultiplierOverride: number | null;
  reasoningEffortMap: Record<string, string>;
  reasoningEfforts: string[];
  capabilities: Record<string, boolean>;
  contextWindow: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  autoCompactTokenLimit: number | null;
  modalities: string[];
  capabilitiesOverride: Record<string, boolean> | null;
  metadata: Record<string, unknown>;
  pricing: InferencePricing | null;
}

export interface InferenceModel {
  id: string;
  publicId: string;
  displayName: string;
  sortOrder: number;
  enabled: boolean;
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number | null;
  autoCompactTokenLimit: number;
  modalities: string[];
  capabilities: Record<string, boolean>;
  configuredCapabilities: Record<string, boolean>;
  capabilityLimitations: Record<string, string[]>;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  systemPrompt?: string | null;
  systemPromptMode?: "append" | "replace";
  defaultAccessAllowed: boolean;
  accessMode: "everyone" | "selected" | "disabled";
  accessSubjects: InferenceAccessSubject[];
  subscriptionMultiplier: number;
  sources: InferenceModelSource[];
  accessRules: Array<Record<string, unknown>>;
}

export interface InferenceAccessSubject {
  subjectType: "group" | "user";
  subjectId: string;
}

export interface InferenceLimitPolicy {
  id: string;
  policyType: "default" | "user";
  userId: string | null;
  enabled: boolean;
  credits5hEnabled: boolean;
  credits5h: string;
  credits7dEnabled: boolean;
  credits7d: string;
  credits30dEnabled: boolean;
  credits30d: string;
  apiMonthlyMicrodollars: number;
  billingTimezone: string;
}

export interface InferenceLimitResetResult {
  resetAt: string;
  usage: NonNullable<InferenceUserUsage["usage"]>;
}

export interface InferenceUserUsage {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  limits: null | {
    enabled: boolean;
    credits5hEnabled: boolean;
    credits5h: number;
    credits7dEnabled: boolean;
    credits7d: number;
    credits30dEnabled: boolean;
    credits30d: number;
    apiMonthlyMicrodollars: number;
    billingTimezone: string;
  };
  usage: null | {
    credits5h: number;
    credits7d: number;
    credits30d: number;
    apiMonthlyMicrodollars: number;
    active?: Record<string, boolean>;
    recoveryAt: Record<string, string>;
  };
}

export interface InferenceActivity {
  id: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  userAvatarUrl: string | null;
  protocol: string;
  operation: string;
  publicModelId: string;
  reasoningEffort: string | null;
  providerConnectionName: string | null;
  providerAccountLabel: string | null;
  budgetType: "subscription" | "api" | null;
  status: string;
  credits: number;
  apiMicrodollars: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  errorCode: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface InferenceActivityPage {
  data: InferenceActivity[];
  nextPage: number | null;
}

export interface InferenceActivityQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: "reserved" | "running" | "completed" | "failed" | "cancelled";
  userId?: string;
  model?: string;
}

export interface InferenceActivityFilters {
  users: Array<{
    id: string;
    name: string | null;
    email: string;
    avatarUrl: string | null;
  }>;
  models: string[];
}

export type InferenceSystemUsage = InferenceUsageOverview;

export interface InferenceLimitInput {
  enabled: boolean;
  credits5hEnabled: boolean;
  credits5h: number;
  credits7dEnabled: boolean;
  credits7d: number;
  credits30dEnabled: boolean;
  credits30d: number;
  apiMonthlyMicrodollars: number;
  billingTimezone: string;
}
