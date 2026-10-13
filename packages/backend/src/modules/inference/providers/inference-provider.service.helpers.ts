import type {
  inferenceDiscoveredModels,
  inferenceProviderConnections,
  inferenceQuotaSnapshots,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { InferenceCoreClientError } from '../core/inference-core.client.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import type {
  DiscoveredInferenceModel,
  InferenceProviderDefinition,
  InferenceQuotaWindow,
} from './inference-provider.types.js';
import { knownProviderModel, pricingFromDiscoveredMetadata } from './inference-provider-model-catalog.js';

export function validateBaseUrl(value: string, required: boolean): string {
  if (required && !value.trim())
    throw new AppError(400, 'INFERENCE_PROVIDER_BASE_URL_REQUIRED', 'Base URL is required');
  try {
    if (/[{}]/.test(value)) throw new Error('placeholder');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid');
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new AppError(
      400,
      'INFERENCE_PROVIDER_BASE_URL_INVALID',
      'Base URL must be an HTTP(S) URL without credentials'
    );
  }
}

/**
 * Whether a quota window constrains requests for one upstream model. Account-wide windows
 * always do; a model-scoped window (for example Anthropic's weekly Fable bucket) constrains
 * only models of that family, so an exhausted bucket never blocks the account's other models.
 */
export function quotaAppliesToModel(window: { modelBucket?: string | null }, upstreamModelId?: string | null): boolean {
  if (!window.modelBucket) return true;
  if (!upstreamModelId) return false;
  return upstreamModelId.toLowerCase().includes(window.modelBucket.toLowerCase());
}

export function classifyStatus(windows: InferenceQuotaWindow[], minimumRemainingFraction = 0.01) {
  // Connection health is account-wide; model-scoped windows gate only their own models.
  const fractions = windows.flatMap((window) =>
    window.remainingFraction === undefined || window.modelBucket ? [] : [window.remainingFraction]
  );
  if (fractions.length === 0) return 'healthy' as const;
  const minimum = Math.min(...fractions);
  if (minimum <= minimumRemainingFraction) return 'unavailable' as const;
  if (minimum < 0.1) return 'quota_hot' as const;
  return 'healthy' as const;
}

export function preferSyncError(first: unknown, second: unknown): unknown {
  if (isReauthError(first)) return first;
  return second ?? first;
}

export function redactedError(error: unknown): string {
  // Core client messages are the core's own management errors and never carry credentials.
  if (error instanceof InferenceProtocolError || error instanceof AppError || error instanceof InferenceCoreClientError)
    return error.message.slice(0, 500);
  return 'Provider synchronization failed';
}

/** How old a reading may be when the core returns it alongside a failed probe. */
const CORE_FAILED_PROBE_QUOTA_MAX_AGE_MS = 10 * 60_000;

/**
 * A failed core probe still returns the account's last reading. Only a recent one (for example
 * observed on the account's own response headers) may be stored as current; an older one would
 * get a fresh fetchedAt here and keep routing on numbers that no longer hold.
 */
export function isRecentCoreQuotaReading(quota: unknown, now = Date.now()): boolean {
  if (!quota || typeof quota !== 'object') return false;
  const updatedAt = (quota as { updatedAt?: unknown }).updatedAt;
  return (
    typeof updatedAt === 'number' &&
    Number.isFinite(updatedAt) &&
    updatedAt <= now + 60_000 &&
    now - updatedAt <= CORE_FAILED_PROBE_QUOTA_MAX_AGE_MS
  );
}

export function latestQuota(rows: Array<typeof inferenceQuotaSnapshots.$inferSelect>) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.dimension}:${row.modelBucket ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function latestValidQuota(rows: Array<typeof inferenceQuotaSnapshots.$inferSelect>, now = Date.now()) {
  const seen = new Set<string>();
  return [...rows]
    .sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())
    .filter((row) => {
      const key = `${row.dimension}:${row.modelBucket ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return (
        row.validUntil.getTime() > now &&
        (row.resetAt === null || row.resetAt === undefined || row.resetAt.getTime() > now)
      );
    });
}

export function assertMinimumRemainingAllowed(
  provider: InferenceProviderDefinition,
  minimumRemainingPercent: number | undefined
) {
  if (minimumRemainingPercent !== undefined && !provider.subscription) {
    throw new AppError(
      400,
      'INFERENCE_PROVIDER_RESERVE_SUBSCRIPTION_ONLY',
      'Minimum remaining quota is available only for subscription providers'
    );
  }
}

export function assertApiMonthlyLimitAllowed(
  provider: InferenceProviderDefinition,
  apiMonthlyLimitMicrodollars: number | null | undefined
) {
  if (apiMonthlyLimitMicrodollars !== undefined && provider.subscription) {
    throw new AppError(
      400,
      'INFERENCE_PROVIDER_API_LIMIT_API_ONLY',
      'Monthly API limits are available only for API providers'
    );
  }
}

export function nextRoutingOrder(currentMaximum: number | undefined): number {
  return (currentMaximum ?? -1) + 1;
}

export function connectionDisableBlockers<T extends { id: string }>(affected: T[], remainingModelIds: string[]): T[] {
  const routable = new Set(remainingModelIds);
  return affected.filter((model) => !routable.has(model.id));
}

export function serializeConnection(connection: typeof inferenceProviderConnections.$inferSelect) {
  return {
    ...connection,
    lastSyncedAt: connection.lastSyncedAt?.toISOString() ?? null,
    nextSyncAt: connection.nextSyncAt?.toISOString() ?? null,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
    deletedAt: connection.deletedAt?.toISOString() ?? null,
  };
}

export function serializeModel(model: typeof inferenceDiscoveredModels.$inferSelect, providerId?: string) {
  const known = providerId ? knownProviderModel(providerId, model.remoteModelId) : undefined;
  const limits = consistentTokenLimits({
    contextWindow: model.contextWindow ?? known?.contextWindow,
    maxInputTokens: model.maxInputTokens ?? known?.maxInputTokens,
    autoCompactTokenLimit: model.autoCompactTokenLimit ?? known?.autoCompactTokenLimit,
  });
  const { maxInputTokens, autoCompactTokenLimit } = limits;
  const reportedModalities = hasAny(model.metadata, [
    'input_modalities',
    'architecture',
    'supports_image_in',
    'supports_video_in',
  ]);
  const reportedCapabilities = hasAny(model.metadata, [
    'reasoning',
    'supports_reasoning',
    'think_efforts',
    'supported_parameters',
    'tools',
    'input_modalities',
    'architecture',
    'supports_image_in',
  ]);
  const storedSources = storedFieldSources(model.metadata);
  const valueSource = (field: string, stored: unknown, fallback: unknown) =>
    stored !== null && stored !== undefined
      ? storedSources[field]
      : fallback !== null && fallback !== undefined
        ? 'fallback'
        : undefined;
  const usesKnownModalities = Boolean(known && !reportedModalities);
  const usesKnownCapabilities = Boolean(known && !reportedCapabilities);
  const contextWindowSource = valueSource('contextWindow', model.contextWindow, known?.contextWindow);
  const maxInputSource = limits.maxInputFromContextWindow
    ? derivedSource(contextWindowSource)
    : valueSource('maxInputTokens', model.maxInputTokens, known?.maxInputTokens);
  const metadataSources = Object.fromEntries(
    Object.entries({
      displayName: valueSource('displayName', model.displayName, known?.displayName),
      contextWindow: contextWindowSource,
      maxInputTokens: maxInputSource,
      maxOutputTokens: valueSource('maxOutputTokens', model.maxOutputTokens, known?.maxOutputTokens),
      autoCompactTokenLimit: limits.autoCompactFromMaxInput
        ? derivedSource(maxInputSource)
        : valueSource('autoCompactTokenLimit', model.autoCompactTokenLimit, known?.autoCompactTokenLimit),
      reasoningEfforts: model.reasoningEfforts.length
        ? storedSources.reasoningEfforts
        : known?.reasoningEfforts.length
          ? 'fallback'
          : undefined,
      modalities: usesKnownModalities ? 'fallback' : storedSources.modalities,
      capabilities: usesKnownCapabilities ? 'fallback' : storedSources.capabilities,
    }).filter((entry): entry is [string, InferenceModelMetadataSource] => entry[1] !== undefined)
  );
  return {
    ...model,
    displayName: model.displayName ?? known?.displayName ?? null,
    contextWindow: limits.contextWindow,
    maxInputTokens,
    maxOutputTokens: model.maxOutputTokens ?? known?.maxOutputTokens ?? null,
    autoCompactTokenLimit,
    modalities: usesKnownModalities && known ? known.modalities : model.modalities,
    capabilities: usesKnownCapabilities && known ? known.capabilities : model.capabilities,
    reasoningEfforts: model.reasoningEfforts.length ? model.reasoningEfforts : (known?.reasoningEfforts ?? []),
    metadataSources,
    pricing: pricingFromDiscoveredMetadata(model.metadata) ?? known?.pricing ?? null,
    lastSeenAt: model.lastSeenAt.toISOString(),
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}

function hasAny(metadata: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => metadata[key] !== undefined);
}

/**
 * Make one model's token limits agree with each other. Values can come from different places
 * (a live context window next to a built-in long-context input ceiling), so the input limit
 * never exceeds the window and the compaction threshold is recomputed when it no longer fits.
 */
export function consistentTokenLimits(input: {
  contextWindow?: number | null;
  maxInputTokens?: number | null;
  autoCompactTokenLimit?: number | null;
}) {
  const contextWindow = input.contextWindow ?? null;
  let maxInputTokens = input.maxInputTokens ?? null;
  const maxInputFromContextWindow =
    contextWindow !== null && (maxInputTokens === null || maxInputTokens > contextWindow);
  if (maxInputFromContextWindow) maxInputTokens = contextWindow;
  let autoCompactTokenLimit = input.autoCompactTokenLimit ?? null;
  const autoCompactFromMaxInput =
    maxInputTokens !== null && (autoCompactTokenLimit === null || autoCompactTokenLimit > maxInputTokens);
  if (autoCompactFromMaxInput && maxInputTokens !== null) {
    autoCompactTokenLimit = Math.floor(maxInputTokens * 0.9);
  }
  return { contextWindow, maxInputTokens, autoCompactTokenLimit, maxInputFromContextWindow, autoCompactFromMaxInput };
}

/**
 * Where a model's technical value came from: the provider's live API, the built-in catalog,
 * or an Opfield calculation from provider-reported limits (for example 90% of the input limit).
 */
export type InferenceModelMetadataSource = 'provider' | 'fallback' | 'derived';

/** A value calculated from provider data is `derived`; one calculated from catalog data stays `fallback`. */
export function derivedSource(
  base: InferenceModelMetadataSource | undefined
): InferenceModelMetadataSource | undefined {
  return base === 'fallback' ? 'fallback' : base === undefined ? undefined : 'derived';
}

function storedFieldSources(metadata: Record<string, unknown>): Partial<Record<string, InferenceModelMetadataSource>> {
  const value = metadata.field_sources;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, InferenceModelMetadataSource] =>
        entry[1] === 'provider' || entry[1] === 'fallback' || entry[1] === 'derived'
    )
  );
}

/** `<family><major>.<minor>` with nothing after the version, such as grok-4.7 or glm-5.3. */
const VERSIONED_MODEL_ID = /^(.*?\D)(\d+)\.(\d+)$/;

function modelVersion(id: string): { family: string; minor: number } | null {
  const match = VERSIONED_MODEL_ID.exec(id);
  if (!match) return null;
  return { family: `${match[1]!.toLowerCase()}${match[2]}`, minor: Number(match[3]) };
}

/**
 * A provider can list a new version of a model family by id and name alone: xAI's subscription
 * roster reported grok-4.7 that way, so Opfield published it without reasoning or image input.
 * Such a model takes its input modalities and reasoning levels from the newest earlier version
 * of the same family on the same account. Only the fields the model has no source for are filled,
 * a variant id such as grok-4.7-build-fast never matches, and the copied values stay labelled as
 * fallback with the model they came from, so an operator can still override them.
 */
export function inheritFamilyMetadata(models: DiscoveredInferenceModel[]): DiscoveredInferenceModel[] {
  return models.map((model) => {
    const version = modelVersion(model.id);
    if (!version) return model;
    const own = storedFieldSources(model.metadata);
    const needsModalities = own.modalities === undefined;
    const needsEfforts = model.reasoningEfforts.length === 0 && own.reasoningEfforts === undefined;
    if (!needsModalities && !needsEfforts) return model;
    let donor: { model: DiscoveredInferenceModel; minor: number } | undefined;
    for (const candidate of models) {
      const candidateVersion = modelVersion(candidate.id);
      if (candidateVersion?.family !== version.family || candidateVersion.minor >= version.minor) continue;
      const sources = storedFieldSources(candidate.metadata);
      if (sources.modalities === undefined && sources.reasoningEfforts === undefined) continue;
      if (!donor || candidateVersion.minor > donor.minor) donor = { model: candidate, minor: candidateVersion.minor };
    }
    if (!donor) return model;
    const from = donor.model;
    const fromSources = storedFieldSources(from.metadata);
    const takeModalities = needsModalities && fromSources.modalities !== undefined;
    const takeEfforts = needsEfforts && fromSources.reasoningEfforts !== undefined && from.reasoningEfforts.length > 0;
    if (!takeModalities && !takeEfforts) return model;
    const existingSources = (model.metadata.field_sources ?? {}) as Record<string, unknown>;
    return {
      ...model,
      ...(takeModalities ? { modalities: [...from.modalities] } : {}),
      ...(takeEfforts ? { reasoningEfforts: [...from.reasoningEfforts] } : {}),
      capabilities: {
        ...model.capabilities,
        ...(takeModalities ? { vision: from.modalities.includes('image') } : {}),
        ...(takeEfforts ? { reasoning: true } : {}),
      },
      metadata: {
        ...model.metadata,
        ...(takeEfforts && typeof from.metadata.default_reasoning_effort === 'string'
          ? { default_reasoning_effort: from.metadata.default_reasoning_effort }
          : {}),
        inherited_from: from.id,
        field_sources: {
          ...existingSources,
          ...(takeModalities ? { modalities: 'fallback' } : {}),
          ...(takeEfforts ? { reasoningEfforts: 'fallback' } : {}),
        },
      },
    };
  });
}

export function serializeQuota(quota: typeof inferenceQuotaSnapshots.$inferSelect) {
  return {
    ...quota,
    fetchedAt: quota.fetchedAt.toISOString(),
    validUntil: quota.validUntil.toISOString(),
    resetAt: quota.resetAt?.toISOString() ?? null,
    stale: quota.validUntil.getTime() <= Date.now(),
  };
}

export function isReauthError(error: unknown): boolean {
  return (
    (error instanceof InferenceProtocolError && error.status === 401) ||
    (error instanceof AppError && error.statusCode === 401)
  );
}

export const __testOnly = {
  classifyStatus,
  validateBaseUrl,
  latestQuota,
  latestValidQuota,
  redactedError,
  assertApiMonthlyLimitAllowed,
  assertMinimumRemainingAllowed,
  nextRoutingOrder,
  connectionDisableBlockers,
};
