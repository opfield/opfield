import type { InferenceDiscoveredModel, InferenceModelSource, InferenceProviderConnection } from '@/db/schema/index.js';
import { knownProviderModel } from '../providers/inference-provider-model-catalog.js';
import type { InferenceModelInput, InferenceModelSourceInput } from './inference-model.types.js';

interface CapabilitySourceRow {
  source: InferenceModelSource;
  connection: InferenceProviderConnection;
  discovered: InferenceDiscoveredModel | null;
}

export function detectedCapabilityState(configured: Record<string, boolean>, rows: CapabilitySourceRow[]) {
  const sources = rows.filter(({ source }) => source.enabled);
  if (!sources.length) return { effective: configured, limitations: {} as Record<string, string[]> };
  const keys = new Set(Object.keys(configured));
  for (const source of sources) {
    for (const key of Object.keys(effectiveSourceContract(source).capabilities)) keys.add(key);
  }
  const effective: Record<string, boolean> = {};
  const limitations: Record<string, string[]> = {};
  for (const key of [...keys].sort()) {
    const missing = sources.filter((source) => effectiveSourceContract(source).capabilities[key] !== true);
    effective[key] = missing.length === 0;
    if (missing.length) {
      limitations[key] = missing.map(({ source, connection }) => `${connection.name} · ${source.upstreamModelId}`);
    }
  }
  return { effective, limitations };
}

export function effectiveSourceContract(row: CapabilitySourceRow) {
  const known = knownProviderModel(row.connection.providerId, row.source.upstreamModelId);
  return {
    known,
    modalities: row.discovered?.modalities ?? known?.modalities ?? ['text'],
    capabilities: row.source.capabilitiesOverride ?? row.discovered?.capabilities ?? known?.capabilities ?? {},
  };
}

export function supportsFastServiceTier(rows: CapabilitySourceRow[]): boolean {
  const sources = rows.filter(({ source }) => source.enabled);
  return (
    sources.length > 0 &&
    sources.every(({ source, connection, discovered }) => {
      if (source.sourceType !== 'subscription' || connection.providerId !== 'openai' || !discovered) return false;
      const serviceTiers = Array.isArray(discovered.metadata.service_tiers) ? discovered.metadata.service_tiers : [];
      const additionalSpeedTiers = Array.isArray(discovered.metadata.additional_speed_tiers)
        ? discovered.metadata.additional_speed_tiers
        : [];
      return (
        discovered.capabilities.serviceTier === true ||
        serviceTiers.some(
          (tier) =>
            tier && typeof tier === 'object' && !Array.isArray(tier) && (tier as { id?: unknown }).id === 'priority'
        ) ||
        additionalSpeedTiers.includes('fast')
      );
    })
  );
}

export function sourceOriginMetadata(
  providerFamily: string,
  discovered: boolean,
  technical?: InferenceModelSourceInput['manualMetadata']
) {
  return {
    origin: discovered ? ('discovery' as const) : ('manual' as const),
    providerFamily,
    ...(technical ? { technical } : {}),
  };
}

export function filterModelIdsByApiBudget(
  modelIds: readonly string[],
  subscriptionSourceModelIds: readonly string[],
  apiMonthlyMicrodollars: number
): string[] {
  if (apiMonthlyMicrodollars > 0) return [...modelIds];
  const subscriptionModels = new Set(subscriptionSourceModelIds);
  return modelIds.filter((modelId) => subscriptionModels.has(modelId));
}

export function filterSourcesByApiUsage<T extends { sourceType: string }>(
  sources: readonly T[],
  apiUsageEnabled: boolean
): T[] {
  return apiUsageEnabled ? [...sources] : sources.filter((source) => source.sourceType === 'subscription');
}

type TechnicalLimits = Pick<
  InferenceModelInput,
  'contextWindow' | 'maxInputTokens' | 'maxOutputTokens' | 'autoCompactTokenLimit'
>;

export function effectiveTechnicalLimits(sources: TechnicalLimits[], fallback: TechnicalLimits) {
  const effective = sources.length ? sources : [fallback];
  const outputLimits = effective.map((row) => row.maxOutputTokens).filter((value): value is number => value !== null);
  const contextWindow = Math.min(...effective.map((row) => row.contextWindow));
  const maxInputTokens = Math.min(...effective.map((row) => row.maxInputTokens));
  return {
    contextWindow,
    maxInputTokens,
    maxOutputTokens: outputLimits.length ? Math.min(...outputLimits) : null,
    autoCompactTokenLimit: Math.min(maxInputTokens, ...effective.map((row) => row.autoCompactTokenLimit)),
  };
}
