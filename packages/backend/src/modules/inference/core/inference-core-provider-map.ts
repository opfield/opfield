import { createHash } from 'node:crypto';
import type {
  InferenceProviderDefinition,
  InferenceProviderModelPricing,
} from '../providers/inference-provider.types.js';

/**
 * Deterministic mapping between Opfield provider/connection records and core
 * resources (plan T4). Two families exist:
 *
 * - API-key/local connections map 1:1 to a core provider entry named
 *   `core-<connectionId>`; the entry holds the key, so its lifecycle follows
 *   the connection exactly.
 * - OAuth subscription connections cannot use arbitrary entry names: the core
 *   resolves OAuth tokens by provider entry name and its login flow upserts
 *   the canonical entry. They therefore map to the canonical core provider
 *   (`anthropic`, `kimi`, `xai`) or the ChatGPT account pool behind the
 *   built-in `openai` forward provider, and each Opfield connection row
 *   represents one account inside that core-side set.
 */

/** metadata.coreManaged marks rows whose credentials live in the core. */
export const CORE_MANAGED_METADATA_KEY = 'coreManaged';

/** metadata.coreAccountId stores the account id inside the core account set. */
export const CORE_ACCOUNT_METADATA_KEY = 'coreAccountId';

/** Discovered-model metadata key holding the core-only namespaced route. */
export const CORE_MODEL_METADATA_KEY = 'coreModelId';

export type CoreOAuthTarget =
  | { kind: 'codex-pool'; coreProviderName: 'openai' }
  | { kind: 'core-oauth'; oauthProvider: string; coreProviderName: string };

/** Canonical core OAuth target for an Opfield OAuth provider id, or null. */
export function coreOAuthTarget(providerId: string): CoreOAuthTarget | null {
  switch (providerId) {
    case 'openai':
      return { kind: 'codex-pool', coreProviderName: 'openai' };
    case 'anthropic':
      return { kind: 'core-oauth', oauthProvider: 'anthropic', coreProviderName: 'anthropic' };
    case 'kimi':
      return { kind: 'core-oauth', oauthProvider: 'kimi', coreProviderName: 'kimi' };
    case 'xai':
      return { kind: 'core-oauth', oauthProvider: 'xai', coreProviderName: 'xai' };
    default:
      return null;
  }
}

/** Core provider entry name for an API-key/local connection. */
export function coreKeyProviderName(connectionId: string): string {
  return `core-${connectionId}`;
}

/**
 * The core provider entry a connection's models route through. OAuth
 * connections share the canonical entry; key connections own their entry.
 */
export function coreProviderRef(connection: { id: string; providerId: string; authType: string }): string {
  if (connection.authType === 'oauth') {
    const target = coreOAuthTarget(connection.providerId);
    if (target) return target.coreProviderName;
  }
  return coreKeyProviderName(connection.id);
}

/** Opfield wire-protocol names map onto core adapter names. */
export function coreAdapterForWireProtocol(wireProtocol: string): string {
  switch (wireProtocol) {
    case 'openai-responses':
      return 'openai-responses';
    case 'anthropic-messages':
      return 'anthropic';
    case 'google-gemini':
      return 'google';
    default:
      return 'openai-chat';
  }
}

/**
 * Core provider entry payload for an API-key/local connection. Secrets cross
 * only here — management POST /api/providers over the private network — and
 * are never persisted in Opfield storage.
 */
export function buildCoreProviderConfig(args: {
  definition: InferenceProviderDefinition;
  baseUrl: string;
  authType: 'api_key' | 'local';
  apiKey?: string;
  allowPrivateNetwork?: boolean;
  disabled?: boolean;
}): Record<string, unknown> {
  const { definition, baseUrl, authType, apiKey, allowPrivateNetwork, disabled } = args;
  return {
    ...(definition.id !== 'openai-compatible' ? { templateId: definition.id } : {}),
    adapter: coreAdapterForWireProtocol(definition.wireProtocol),
    baseUrl,
    authMode: authType === 'local' ? 'local' : 'key',
    ...(apiKey ? { apiKey } : {}),
    ...(definition.staticHeaders ? { headers: definition.staticHeaders } : {}),
    ...(definition.liveModels !== undefined ? { liveModels: definition.liveModels } : {}),
    ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
  };
}

/** Narrow a core /api/models row. Other fields are passed through defensively. */
export interface CoreModelRow {
  provider: string;
  id: string;
  namespaced: string;
  displayName?: string;
  disabled?: boolean;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Core's compaction threshold for native rows; it already honors operator overrides. */
  autoCompactTokenLimit?: number;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  inputModalities?: string[];
  capabilities?: string[];
  parallelToolCalls?: boolean;
  supportsReasoningSummaries?: boolean;
  supportsServiceTier?: boolean;
  supportsVerbosity?: boolean;
  metadataSources?: CoreModelMetadataSources;
  pricing?: CoreModelPricing;
}

export type CoreModelMetadataSource = 'provider' | 'fallback';
export type CoreModelMetadataSources = Partial<Record<string, CoreModelMetadataSource>>;

function parseCoreModelMetadataSources(value: unknown): CoreModelMetadataSources | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const sources = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, CoreModelMetadataSource] => entry[1] === 'provider' || entry[1] === 'fallback'
    )
  );
  return Object.keys(sources).length ? sources : undefined;
}

export interface CoreModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
  source: 'opencodex-catalog';
}

function parseCoreModelPricing(value: unknown): CoreModelPricing | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const pricing = value as Record<string, unknown>;
  if (pricing.source !== 'opencodex-catalog') return undefined;
  const values = [
    pricing.inputUsdPerMillion,
    pricing.outputUsdPerMillion,
    pricing.cachedInputUsdPerMillion,
    pricing.cacheWriteUsdPerMillion,
  ];
  if (values.some((candidate) => typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0)) {
    return undefined;
  }
  return {
    inputUsdPerMillion: pricing.inputUsdPerMillion as number,
    outputUsdPerMillion: pricing.outputUsdPerMillion as number,
    cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion as number,
    cacheWriteUsdPerMillion: pricing.cacheWriteUsdPerMillion as number,
    source: 'opencodex-catalog',
  };
}

function usdPerMillionToMicrodollars(value: number): number | undefined {
  const converted = Math.round(value * 1_000_000);
  return Number.isSafeInteger(converted) && converted >= 0 ? converted : undefined;
}

/** Convert the managed-core USD rates into Opfield's exact integer accounting units. */
export function coreModelPricing(row: CoreModelRow): InferenceProviderModelPricing | undefined {
  if (!row.pricing) return undefined;
  const input = usdPerMillionToMicrodollars(row.pricing.inputUsdPerMillion);
  const output = usdPerMillionToMicrodollars(row.pricing.outputUsdPerMillion);
  const cachedInput = usdPerMillionToMicrodollars(row.pricing.cachedInputUsdPerMillion);
  const cacheWrite = usdPerMillionToMicrodollars(row.pricing.cacheWriteUsdPerMillion);
  if (input === undefined || output === undefined || cachedInput === undefined || cacheWrite === undefined) {
    return undefined;
  }
  const rates = [input, output, cachedInput, cacheWrite];
  const digest = createHash('sha256').update(rates.join(':')).digest('hex').slice(0, 24);
  return {
    version: `opencodex-catalog-v1-${digest}`,
    inputMicrodollarsPerMillion: input,
    cachedInputMicrodollarsPerMillion: cachedInput,
    cacheWriteMicrodollarsPerMillion: cacheWrite,
    outputMicrodollarsPerMillion: output,
    source: 'provider',
  };
}

/** Project OpenCodex catalog metadata onto Opfield's boolean capability map. */
export function coreModelCapabilities(row: CoreModelRow): Record<string, boolean> {
  const capabilities = Object.fromEntries((row.capabilities ?? []).map((capability) => [capability, true] as const));
  const modalities = new Set(row.inputModalities ?? []);
  return {
    ...capabilities,
    tools: capabilities.tools === true,
    reasoning: (row.reasoningEfforts?.length ?? 0) > 0,
    vision: modalities.has('image'),
    ...(row.parallelToolCalls !== undefined ? { parallelToolCalls: row.parallelToolCalls } : {}),
    ...(row.supportsReasoningSummaries !== undefined ? { reasoningSummaries: row.supportsReasoningSummaries } : {}),
    ...(row.supportsServiceTier !== undefined ? { serviceTier: row.supportsServiceTier } : {}),
    ...(row.supportsVerbosity !== undefined ? { verbosity: row.supportsVerbosity } : {}),
  };
}

export function parseCoreModelRows(body: unknown): CoreModelRow[] {
  if (!Array.isArray(body)) return [];
  const rows: CoreModelRow[] = [];
  for (const entry of body) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.provider !== 'string' || typeof row.id !== 'string') continue;
    const pricing = parseCoreModelPricing(row.pricing);
    const metadataSources = parseCoreModelMetadataSources(row.metadataSources);
    rows.push({
      provider: row.provider,
      id: row.id,
      namespaced: typeof row.namespaced === 'string' && row.namespaced ? row.namespaced : row.id,
      ...(typeof row.displayName === 'string' && row.displayName.trim() ? { displayName: row.displayName.trim() } : {}),
      ...(row.disabled === true ? { disabled: true } : {}),
      ...(typeof row.contextWindow === 'number' ? { contextWindow: row.contextWindow } : {}),
      ...(typeof row.maxInputTokens === 'number' ? { maxInputTokens: row.maxInputTokens } : {}),
      ...(typeof row.autoCompactTokenLimit === 'number' &&
      Number.isSafeInteger(row.autoCompactTokenLimit) &&
      row.autoCompactTokenLimit > 0
        ? { autoCompactTokenLimit: row.autoCompactTokenLimit }
        : {}),
      ...(typeof row.maxOutputTokens === 'number' ? { maxOutputTokens: row.maxOutputTokens } : {}),
      ...(Array.isArray(row.reasoningEfforts)
        ? { reasoningEfforts: row.reasoningEfforts.filter((effort): effort is string => typeof effort === 'string') }
        : {}),
      ...(typeof row.defaultReasoningEffort === 'string' ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
      ...(Array.isArray(row.inputModalities)
        ? {
            inputModalities: row.inputModalities.filter((modality): modality is string => typeof modality === 'string'),
          }
        : {}),
      ...(Array.isArray(row.capabilities)
        ? {
            capabilities: row.capabilities.filter((capability): capability is string => typeof capability === 'string'),
          }
        : {}),
      ...(typeof row.parallelToolCalls === 'boolean' ? { parallelToolCalls: row.parallelToolCalls } : {}),
      ...(typeof row.supportsReasoningSummaries === 'boolean'
        ? { supportsReasoningSummaries: row.supportsReasoningSummaries }
        : {}),
      ...(typeof row.supportsServiceTier === 'boolean' ? { supportsServiceTier: row.supportsServiceTier } : {}),
      ...(typeof row.supportsVerbosity === 'boolean' ? { supportsVerbosity: row.supportsVerbosity } : {}),
      ...(metadataSources ? { metadataSources } : {}),
      ...(pricing ? { pricing } : {}),
    });
  }
  return rows;
}

/** Narrow one core /api/provider-quotas report. */
export interface CoreQuotaReport {
  provider: string;
  quota: {
    fiveHourPercent?: number;
    fiveHourResetAt?: number;
    weeklyPercent?: number;
    weeklyResetAt?: number;
    monthlyPercent?: number;
    monthlyResetAt?: number;
    creditsUsd?: { remaining?: number; limit?: number };
    /** Extra provider windows, e.g. Anthropic's model-scoped weekly buckets (Fable/Opus/Sonnet). */
    customWindows?: Array<{ label: string; percent: number; resetAt?: number }>;
  };
}

/** Model families a subscription can meter separately from the account-wide weekly window. */
const MODEL_SCOPED_QUOTA_FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'] as const;

function quotaModelScope(label: string): string | null {
  const normalized = label.trim().toLowerCase();
  return MODEL_SCOPED_QUOTA_FAMILIES.find((family) => normalized.includes(family)) ?? null;
}

export function parseCoreQuotaReports(body: unknown): CoreQuotaReport[] {
  if (!body || typeof body !== 'object') return [];
  const reports = (body as { reports?: unknown }).reports;
  if (!Array.isArray(reports)) return [];
  const parsed: CoreQuotaReport[] = [];
  for (const entry of reports) {
    if (!entry || typeof entry !== 'object') continue;
    const report = entry as Record<string, unknown>;
    if (typeof report.provider !== 'string' || !report.quota || typeof report.quota !== 'object') continue;
    const quota = report.quota as Record<string, unknown>;
    const credits =
      quota.creditsUsd && typeof quota.creditsUsd === 'object' ? (quota.creditsUsd as Record<string, unknown>) : null;
    parsed.push({
      provider: report.provider,
      quota: {
        ...(typeof quota.fiveHourPercent === 'number' ? { fiveHourPercent: quota.fiveHourPercent } : {}),
        ...(typeof quota.fiveHourResetAt === 'number' ? { fiveHourResetAt: quota.fiveHourResetAt } : {}),
        ...(typeof quota.weeklyPercent === 'number' ? { weeklyPercent: quota.weeklyPercent } : {}),
        ...(typeof quota.weeklyResetAt === 'number' ? { weeklyResetAt: quota.weeklyResetAt } : {}),
        ...(typeof quota.monthlyPercent === 'number' ? { monthlyPercent: quota.monthlyPercent } : {}),
        ...(typeof quota.monthlyResetAt === 'number' ? { monthlyResetAt: quota.monthlyResetAt } : {}),
        ...(credits
          ? {
              creditsUsd: {
                ...(typeof credits.remaining === 'number' ? { remaining: credits.remaining } : {}),
                ...(typeof credits.limit === 'number' ? { limit: credits.limit } : {}),
              },
            }
          : {}),
        ...(Array.isArray(quota.customWindows)
          ? {
              customWindows: quota.customWindows.flatMap((entry) => {
                if (!entry || typeof entry !== 'object') return [];
                const window = entry as Record<string, unknown>;
                if (typeof window.label !== 'string' || typeof window.percent !== 'number') return [];
                return [
                  {
                    label: window.label,
                    percent: window.percent,
                    ...(typeof window.resetAt === 'number' ? { resetAt: window.resetAt } : {}),
                  },
                ];
              }),
            }
          : {}),
      },
    });
  }
  return parsed;
}

/**
 * Project one core quota report into Opfield quota windows. Core percentages
 * are usage (0-100 used); Opfield windows store the remaining fraction.
 */
export function coreQuotaToWindows(report: CoreQuotaReport): Array<{
  dimension: string;
  modelBucket?: string;
  remainingFraction?: number;
  remainingValue?: string;
  limitValue?: string;
  resetAt?: Date;
  metadata?: Record<string, unknown>;
}> {
  const windows: Array<{
    dimension: string;
    modelBucket?: string;
    remainingFraction?: number;
    remainingValue?: string;
    limitValue?: string;
    resetAt?: Date;
    metadata?: Record<string, unknown>;
  }> = [];
  const resetDate = (value: number | undefined): Date | undefined => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    return Number.isFinite(date.getTime()) ? date : undefined;
  };
  const usage = (percent: number | undefined, resetAt: number | undefined, dimension: string) => {
    if (percent === undefined) return;
    const normalizedResetAt = resetDate(resetAt);
    windows.push({
      dimension,
      remainingFraction: Math.max(0, Math.min(1, 1 - percent / 100)),
      ...(normalizedResetAt ? { resetAt: normalizedResetAt } : {}),
    });
  };
  usage(report.quota.fiveHourPercent, report.quota.fiveHourResetAt, '5h');
  usage(report.quota.weeklyPercent, report.quota.weeklyResetAt, '7d');
  usage(report.quota.monthlyPercent, report.quota.monthlyResetAt, '30d');
  // Only recognised model families are ingested: other providers reuse custom windows for
  // limits whose duration and scope Opfield cannot interpret.
  // A provider can report several windows for one family (Anthropic sends a canonical "Opus"
  // bucket and may add a separately labelled scoped limit). One window is stored per family, so
  // the most constrained one wins: keeping the first would admit turns into an exhausted bucket.
  const mostConstrained = new Map<string, { label: string; percent: number; resetAt?: number }>();
  for (const custom of report.quota.customWindows ?? []) {
    const modelBucket = quotaModelScope(custom.label);
    if (!modelBucket) continue;
    const current = mostConstrained.get(modelBucket);
    if (!current || custom.percent > current.percent) mostConstrained.set(modelBucket, custom);
  }
  for (const [modelBucket, custom] of mostConstrained) {
    const normalizedResetAt = resetDate(custom.resetAt);
    windows.push({
      dimension: '7d',
      modelBucket,
      remainingFraction: Math.max(0, Math.min(1, 1 - custom.percent / 100)),
      ...(normalizedResetAt ? { resetAt: normalizedResetAt } : {}),
      metadata: { label: custom.label },
    });
  }
  if (
    report.quota.creditsUsd &&
    (report.quota.creditsUsd.remaining !== undefined || report.quota.creditsUsd.limit !== undefined)
  ) {
    const remaining = report.quota.creditsUsd.remaining;
    const limit = report.quota.creditsUsd.limit;
    windows.push({
      dimension: 'subscription',
      ...(remaining !== undefined && limit !== undefined && limit >= 0
        ? { remainingFraction: limit === 0 ? 0 : Math.max(0, Math.min(1, remaining / limit)) }
        : {}),
      ...(remaining !== undefined ? { remainingValue: String(remaining) } : {}),
      ...(limit !== undefined ? { limitValue: String(limit) } : {}),
    });
  }
  return windows;
}
