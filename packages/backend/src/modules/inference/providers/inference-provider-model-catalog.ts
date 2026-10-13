import { longContextOtherUnitPrices } from '../inference-pricing.js';
import type { InferenceProviderModelPricing } from './inference-provider.types.js';

export interface KnownInferenceProviderModel {
  displayName: string;
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens?: number;
  autoCompactTokenLimit: number;
  modalities: string[];
  capabilities: Record<string, boolean>;
  reasoningEfforts: string[];
  pricing: InferenceProviderModelPricing;
  catalogVersion: string;
  sourceUrl: string;
}

const OPENAI_VERSION = 'openai-api-2026-07-27';
const OPENAI_GPT_5_6_VERSION = 'openai-api-2026-08-06';
const ANTHROPIC_VERSION = 'anthropic-api-2026-07-27';
const MOONSHOT_VERSION = 'moonshot-api-2026-07-27';
const OPENAI_SOURCE = 'https://developers.openai.com/api/docs/models';
const ANTHROPIC_SOURCE = 'https://platform.claude.com/docs/en/about-claude/models/overview';
const MOONSHOT_SOURCE = 'https://platform.kimi.ai/docs/pricing';

const OPENAI_REASONING = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
const OPENAI_REASONING_MAX = [...OPENAI_REASONING, 'max'] as const;
const CLAUDE_REASONING = ['low', 'medium', 'high', 'max'] as const;
const GPT_5_6_PRICING = {
  version: OPENAI_GPT_5_6_VERSION,
  cacheWriteInputMultiplier: 1.25,
  longContextThresholdTokens: 272_000,
};

const OPENAI_MODELS: Record<string, KnownInferenceProviderModel> = {
  'gpt-6-astra': openAiModel(
    'GPT-6 Astra',
    'gpt-6-astra',
    1_050_000,
    128_000,
    10,
    50,
    1,
    ['low', 'medium', 'high', 'xhigh', 'max'],
    true,
    { version: 'openai-api-2026-09-05', cacheWriteInputMultiplier: 1.25, longContextThresholdTokens: 272_000 }
  ),
  'chat-latest': openAiModel('Chat Latest', 'chat-latest', 400_000, 128_000, 5, 30, 0.5),
  'gpt-5.6': openAiModel(
    'GPT-5.6 Sol',
    'gpt-5.6-sol',
    1_050_000,
    128_000,
    5,
    30,
    0.5,
    OPENAI_REASONING_MAX,
    true,
    GPT_5_6_PRICING
  ),
  'gpt-5.6-sol': openAiModel(
    'GPT-5.6 Sol',
    'gpt-5.6-sol',
    1_050_000,
    128_000,
    5,
    30,
    0.5,
    OPENAI_REASONING_MAX,
    true,
    GPT_5_6_PRICING
  ),
  'gpt-5.6-terra': openAiModel(
    'GPT-5.6 Terra',
    'gpt-5.6-terra',
    1_050_000,
    128_000,
    2,
    12,
    0.2,
    OPENAI_REASONING_MAX,
    true,
    GPT_5_6_PRICING
  ),
  'gpt-5.6-luna': openAiModel(
    'GPT-5.6 Luna',
    'gpt-5.6-luna',
    1_050_000,
    128_000,
    0.2,
    1.2,
    0.02,
    OPENAI_REASONING_MAX,
    true,
    GPT_5_6_PRICING
  ),
  'gpt-5.5': openAiModel('GPT-5.5', 'gpt-5.5', 1_050_000, 128_000, 5, 30, 0.5, OPENAI_REASONING),
  'gpt-5.5-pro': openAiModel('GPT-5.5 Pro', 'gpt-5.5-pro', 1_050_000, 128_000, 30, 180, undefined, [
    'medium',
    'high',
    'xhigh',
  ]),
  'gpt-5.4': openAiModel('GPT-5.4', 'gpt-5.4', 1_050_000, 128_000, 2.5, 15, 0.25, OPENAI_REASONING),
  'gpt-5.4-pro': openAiModel('GPT-5.4 Pro', 'gpt-5.4-pro', 1_050_000, 128_000, 30, 180, undefined, [
    'medium',
    'high',
    'xhigh',
  ]),
  'gpt-5.4-mini': openAiModel('GPT-5.4 mini', 'gpt-5.4-mini', 400_000, 128_000, 0.75, 4.5, 0.075, OPENAI_REASONING),
  'gpt-5.4-nano': openAiModel('GPT-5.4 nano', 'gpt-5.4-nano', 400_000, 128_000, 0.2, 1.25, 0.02, OPENAI_REASONING),
  'gpt-5.2': openAiModel('GPT-5.2', 'gpt-5.2', 400_000, 128_000, 1.75, 14, 0.175, [
    'none',
    'low',
    'medium',
    'high',
    'xhigh',
  ]),
  'gpt-5.2-pro': openAiModel('GPT-5.2 Pro', 'gpt-5.2-pro', 400_000, 128_000, 21, 168, undefined, [
    'medium',
    'high',
    'xhigh',
  ]),
  'gpt-5.1': openAiModel('GPT-5.1', 'gpt-5.1', 400_000, 128_000, 1.25, 10, 0.125, ['none', 'low', 'medium', 'high']),
  'gpt-5.1-chat-latest': openAiModel('GPT-5.1 Chat', 'gpt-5.1-chat-latest', 128_000, 16_384, 1.25, 10, 0.125),
  'gpt-5.1-codex': openAiModel('GPT-5.1-Codex', 'gpt-5.1-codex', 400_000, 128_000, 1.25, 10, 0.125, [
    'low',
    'medium',
    'high',
  ]),
  'gpt-5.1-codex-max': openAiModel('GPT-5.1-Codex-Max', 'gpt-5.1-codex-max', 400_000, 128_000, 1.25, 10, 0.125, [
    'low',
    'medium',
    'high',
    'xhigh',
  ]),
  'gpt-5.1-codex-mini': openAiModel('GPT-5.1-Codex mini', 'gpt-5.1-codex-mini', 400_000, 128_000, 0.25, 2, 0.025, [
    'low',
    'medium',
    'high',
  ]),
  'gpt-5': openAiModel('GPT-5', 'gpt-5', 400_000, 128_000, 1.25, 10, 0.125, ['minimal', 'low', 'medium', 'high']),
  'gpt-5-chat-latest': openAiModel('GPT-5 Chat', 'gpt-5-chat-latest', 128_000, 16_384, 1.25, 10, 0.125),
  'gpt-5-pro': openAiModel('GPT-5 Pro', 'gpt-5-pro', 400_000, 272_000, 15, 120, undefined, ['high']),
  'gpt-5-mini': openAiModel('GPT-5 mini', 'gpt-5-mini', 400_000, 128_000, 0.25, 2, 0.025, [
    'minimal',
    'low',
    'medium',
    'high',
  ]),
  'gpt-5-nano': openAiModel('GPT-5 nano', 'gpt-5-nano', 400_000, 128_000, 0.05, 0.4, 0.005, [
    'minimal',
    'low',
    'medium',
    'high',
  ]),
  'gpt-5-codex': openAiModel('GPT-5-Codex', 'gpt-5-codex', 400_000, 128_000, 1.25, 10, 0.125, [
    'minimal',
    'low',
    'medium',
    'high',
  ]),
  'codex-mini-latest': openAiModel('Codex mini', 'codex-mini-latest', 200_000, 100_000, 1.5, 6, 0.375, [
    'low',
    'medium',
    'high',
  ]),
  'gpt-4.1': openAiModel('GPT-4.1', 'gpt-4.1', 1_047_576, 32_768, 2, 8, 0.5),
  'gpt-4.1-mini': openAiModel('GPT-4.1 mini', 'gpt-4.1-mini', 1_047_576, 32_768, 0.4, 1.6, 0.1),
  'gpt-4.1-nano': openAiModel('GPT-4.1 nano', 'gpt-4.1-nano', 1_047_576, 32_768, 0.1, 0.4, 0.025),
  'gpt-4o': openAiModel('GPT-4o', 'gpt-4o', 128_000, 16_384, 2.5, 10, 1.25),
  'gpt-4o-2024-05-13': openAiModel('GPT-4o (2024-05-13)', 'gpt-4o', 128_000, 4_096, 5, 15),
  'gpt-4o-mini': openAiModel('GPT-4o mini', 'gpt-4o-mini', 128_000, 16_384, 0.15, 0.6, 0.075),
  'gpt-4.5-preview': openAiModel('GPT-4.5 Preview', 'gpt-4.5-preview', 128_000, 16_384, 75, 150, 37.5),
  'gpt-4-turbo': openAiModel('GPT-4 Turbo', 'gpt-4-turbo', 128_000, 4_096, 10, 30),
  'gpt-4-0125-preview': openAiModel('GPT-4 Turbo Preview', 'gpt-4-turbo-preview', 128_000, 4_096, 10, 30),
  'gpt-4-1106-preview': openAiModel('GPT-4 Turbo Preview', 'gpt-4-turbo-preview', 128_000, 4_096, 10, 30),
  'gpt-4-1106-vision-preview': openAiModel('GPT-4 Turbo Vision Preview', 'gpt-4-turbo-preview', 128_000, 4_096, 10, 30),
  'gpt-4': openAiModel('GPT-4', 'gpt-4', 8_192, 8_192, 30, 60, undefined, [], false),
  'gpt-4-32k': openAiModel('GPT-4 32K', 'gpt-4', 32_768, 8_192, 60, 120, undefined, [], false),
  'gpt-3.5-turbo': openAiModel('GPT-3.5 Turbo', 'gpt-3.5-turbo', 16_385, 4_096, 0.5, 1.5, undefined, [], false),
  'gpt-3.5-turbo-0125': openAiModel(
    'GPT-3.5 Turbo (0125)',
    'gpt-3.5-turbo',
    16_385,
    4_096,
    0.5,
    1.5,
    undefined,
    [],
    false
  ),
  'gpt-3.5-turbo-1106': openAiModel('GPT-3.5 Turbo (1106)', 'gpt-3.5-turbo', 16_385, 4_096, 1, 2, undefined, [], false),
  o1: openAiModel('o1', 'o1', 200_000, 100_000, 15, 60, 7.5, ['low', 'medium', 'high']),
  'o1-pro': openAiModel('o1-pro', 'o1-pro', 200_000, 100_000, 150, 600, undefined, ['high']),
  'o1-mini': openAiModel('o1-mini', 'o1-mini', 128_000, 65_536, 1.1, 4.4, 0.55, ['medium'], false),
  o3: openAiModel('o3', 'o3', 200_000, 100_000, 2, 8, 0.5, ['low', 'medium', 'high']),
  'o3-pro': openAiModel('o3-pro', 'o3-pro', 200_000, 100_000, 20, 80, undefined, ['high']),
  'o3-mini': openAiModel('o3-mini', 'o3-mini', 200_000, 100_000, 1.1, 4.4, 0.55, ['low', 'medium', 'high'], false),
  'o4-mini': openAiModel('o4-mini', 'o4-mini', 200_000, 100_000, 1.1, 4.4, 0.275, ['low', 'medium', 'high']),
};

const ANTHROPIC_MODELS: Record<string, KnownInferenceProviderModel> = {
  'claude-fable-5-1': claudeModel('Claude Fable 5.1', 1_000_000, 128_000, 10, 50, 0.25),
  'claude-mythos-5-1': claudeModel('Claude Mythos 5.1', 1_000_000, 128_000, 10, 50, 0.25),
  'claude-fable-5': claudeModel('Claude Fable 5', 1_000_000, 128_000, 10, 50),
  'claude-mythos-5': claudeModel('Claude Mythos 5', 1_000_000, 128_000, 10, 50),
  'claude-opus-5-5': claudeModel('Claude Opus 5.5', 1_000_000, 128_000, 5, 25),
  'claude-opus-5': claudeModel('Claude Opus 5', 1_000_000, 128_000, 5, 25),
  'claude-sonnet-5': claudeModel('Claude Sonnet 5', 1_000_000, 128_000, 2, 10),
  'claude-opus-4-8': claudeModel('Claude Opus 4.8', 1_000_000, 128_000, 5, 25),
  'claude-opus-4-7': claudeModel('Claude Opus 4.7', 1_000_000, 128_000, 5, 25),
  'claude-opus-4-6': claudeModel('Claude Opus 4.6', 1_000_000, 128_000, 5, 25),
  'claude-opus-4-5': claudeModel('Claude Opus 4.5', 200_000, 64_000, 5, 25),
  'claude-opus-4-5-20251101': claudeModel('Claude Opus 4.5', 200_000, 64_000, 5, 25),
  'claude-opus-4-1': claudeModel('Claude Opus 4.1', 200_000, 32_000, 15, 75),
  'claude-opus-4-1-20250805': claudeModel('Claude Opus 4.1', 200_000, 32_000, 15, 75),
  'claude-sonnet-4-6': claudeModel('Claude Sonnet 4.6', 1_000_000, 64_000, 3, 15),
  'claude-sonnet-4-5': claudeModel('Claude Sonnet 4.5', 200_000, 64_000, 3, 15),
  'claude-sonnet-4-5-20250929': claudeModel('Claude Sonnet 4.5', 200_000, 64_000, 3, 15),
  'claude-haiku-4-5': claudeModel('Claude Haiku 4.5', 200_000, 64_000, 1, 5),
  'claude-haiku-4-5-20251001': claudeModel('Claude Haiku 4.5', 200_000, 64_000, 1, 5),
};

const KIMI_K3 = kimiModel('Kimi K3', 'chat-k3', 1_048_576, 3, 15, 0.3, ['low', 'high', 'max']);
const KIMI_K3_256K = kimiModel('Kimi K3 256K', 'chat-k3', 262_144, 3, 15, 0.3, ['low', 'high', 'max'], 32_768);
const MOONSHOT_MODELS: Record<string, KnownInferenceProviderModel> = {
  k3: KIMI_K3,
  'kimi-k3': KIMI_K3,
  'k3-256k': KIMI_K3_256K,
  'kimi-for-coding': KIMI_K3_256K,
  'kimi-for-coding-highspeed': KIMI_K3_256K,
  'kimi-k2.7-code': kimiModel('Kimi K2.7 Code', 'chat-k27-code', 262_144, 0.95, 4, 0.19, ['high']),
  'kimi-k2.7-code-highspeed': kimiModel('Kimi K2.7 Code HighSpeed', 'chat-k27-code', 262_144, 1.9, 8, 0.38, ['high']),
  'kimi-k2.6': kimiModel('Kimi K2.6', 'chat-k26', 262_144, 0.95, 4, 0.16, ['none', 'high']),
  'kimi-k2.5': kimiModel('Kimi K2.5', 'chat-k25', 262_144, 0.6, 3, 0.1, ['none', 'high']),
  'moonshot-v1-8k': moonshotV1('Moonshot V1 8K', 8_192, 0.2, 2),
  'moonshot-v1-32k': moonshotV1('Moonshot V1 32K', 32_768, 1, 3),
  'moonshot-v1-128k': moonshotV1('Moonshot V1 128K', 131_072, 2, 5),
  'moonshot-v1-8k-vision-preview': moonshotV1('Moonshot V1 8K Vision', 8_192, 0.2, 2, true),
  'moonshot-v1-32k-vision-preview': moonshotV1('Moonshot V1 32K Vision', 32_768, 1, 3, true),
  'moonshot-v1-128k-vision-preview': moonshotV1('Moonshot V1 128K Vision', 131_072, 2, 5, true),
};

const CATALOGS: Record<string, Record<string, KnownInferenceProviderModel>> = {
  openai: OPENAI_MODELS,
  'openai-apikey': OPENAI_MODELS,
  anthropic: ANTHROPIC_MODELS,
  'anthropic-apikey': ANTHROPIC_MODELS,
  kimi: MOONSHOT_MODELS,
  moonshot: MOONSHOT_MODELS,
};

export function knownProviderModel(providerId: string, modelId: string): KnownInferenceProviderModel | undefined {
  const catalog = CATALOGS[providerId];
  const normalized = modelId.toLowerCase();
  const undated = normalized.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{4}$/, '');
  return catalog?.[normalized] ?? catalog?.[undated];
}

export function pricingFromDiscoveredMetadata(
  metadata: Record<string, unknown> | null | undefined
): InferenceProviderModelPricing | undefined {
  const candidate = object(metadata?.opfieldPricing);
  if (!candidate || candidate.source !== 'provider' || typeof candidate.version !== 'string') return undefined;
  const input = safeInteger(candidate.inputMicrodollarsPerMillion);
  const output = safeInteger(candidate.outputMicrodollarsPerMillion);
  if (input === undefined || output === undefined) return undefined;
  return {
    version: candidate.version,
    inputMicrodollarsPerMillion: input,
    cachedInputMicrodollarsPerMillion: nullableSafeInteger(candidate.cachedInputMicrodollarsPerMillion),
    cacheWriteMicrodollarsPerMillion: nullableSafeInteger(candidate.cacheWriteMicrodollarsPerMillion),
    outputMicrodollarsPerMillion: output,
    reasoningMicrodollarsPerMillion: nullableSafeInteger(candidate.reasoningMicrodollarsPerMillion),
    otherUnitPrices: safeIntegerRecord(candidate.otherUnitPrices),
    source: 'provider',
  };
}

function openAiModel(
  displayName: string,
  slug: string,
  contextWindow: number,
  maxOutputTokens: number,
  inputPrice: number,
  outputPrice: number,
  cachedInputPrice?: number,
  reasoningEfforts: readonly string[] = [],
  vision = true,
  pricingOptions?: { version: string; cacheWriteInputMultiplier: number; longContextThresholdTokens?: number }
): KnownInferenceProviderModel {
  const maxInputTokens = contextWindow > maxOutputTokens ? contextWindow - maxOutputTokens : contextWindow;
  const pricingVersion = pricingOptions?.version ?? OPENAI_VERSION;
  return {
    displayName,
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
    autoCompactTokenLimit: compactLimit(maxInputTokens),
    modalities: ['text', ...(vision ? ['image'] : [])],
    capabilities: { reasoning: reasoningEfforts.length > 0, tools: true, vision },
    reasoningEfforts: [...reasoningEfforts],
    pricing: tokenPricing(
      pricingVersion,
      inputPrice,
      outputPrice,
      cachedInputPrice,
      pricingOptions ? inputPrice * pricingOptions.cacheWriteInputMultiplier : undefined,
      pricingOptions?.longContextThresholdTokens
    ),
    catalogVersion: pricingVersion,
    sourceUrl: `${OPENAI_SOURCE}/${slug}`,
  };
}

function claudeModel(
  displayName: string,
  maxInputTokens: number,
  maxOutputTokens: number,
  inputPrice: number,
  outputPrice: number,
  cachedInputPrice = inputPrice * 0.1
): KnownInferenceProviderModel {
  return {
    displayName,
    contextWindow: maxInputTokens,
    maxInputTokens,
    maxOutputTokens,
    autoCompactTokenLimit: compactLimit(maxInputTokens),
    modalities: ['text', 'image'],
    capabilities: { reasoning: true, tools: true, vision: true },
    reasoningEfforts: [...CLAUDE_REASONING],
    pricing: tokenPricing(ANTHROPIC_VERSION, inputPrice, outputPrice, cachedInputPrice, inputPrice * 1.25),
    catalogVersion: ANTHROPIC_VERSION,
    sourceUrl: ANTHROPIC_SOURCE,
  };
}

function kimiModel(
  displayName: string,
  sourceSlug: string,
  maxInputTokens: number,
  inputPrice: number,
  outputPrice: number,
  cachedInputPrice: number,
  reasoningEfforts: readonly string[],
  maxOutputTokens?: number
): KnownInferenceProviderModel {
  return {
    displayName,
    contextWindow: maxInputTokens,
    maxInputTokens,
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    autoCompactTokenLimit: compactLimit(maxInputTokens),
    modalities: ['text', 'image', 'video'],
    capabilities: { reasoning: true, tools: true, vision: true },
    reasoningEfforts: [...reasoningEfforts],
    pricing: tokenPricing(MOONSHOT_VERSION, inputPrice, outputPrice, cachedInputPrice),
    catalogVersion: MOONSHOT_VERSION,
    sourceUrl: `${MOONSHOT_SOURCE}/${sourceSlug}`,
  };
}

function moonshotV1(
  displayName: string,
  maxInputTokens: number,
  inputPrice: number,
  outputPrice: number,
  vision = false
): KnownInferenceProviderModel {
  return {
    displayName,
    contextWindow: maxInputTokens,
    maxInputTokens,
    autoCompactTokenLimit: compactLimit(maxInputTokens),
    modalities: ['text', ...(vision ? ['image'] : [])],
    capabilities: { reasoning: false, tools: true, vision },
    reasoningEfforts: [],
    pricing: tokenPricing(MOONSHOT_VERSION, inputPrice, outputPrice),
    catalogVersion: MOONSHOT_VERSION,
    sourceUrl: 'https://platform.kimi.ai/docs/pricing/chat-v1',
  };
}

function tokenPricing(
  version: string,
  inputPrice: number,
  outputPrice: number,
  cachedInputPrice?: number,
  cacheWritePrice?: number,
  longContextThresholdTokens?: number
): InferenceProviderModelPricing {
  const inputMicrodollarsPerMillion = microdollars(inputPrice);
  const cachedInputMicrodollarsPerMillion = cachedInputPrice === undefined ? undefined : microdollars(cachedInputPrice);
  const cacheWriteMicrodollarsPerMillion = cacheWritePrice === undefined ? undefined : microdollars(cacheWritePrice);
  const outputMicrodollarsPerMillion = microdollars(outputPrice);
  return {
    version,
    inputMicrodollarsPerMillion,
    ...(cachedInputMicrodollarsPerMillion === undefined ? {} : { cachedInputMicrodollarsPerMillion }),
    ...(cacheWriteMicrodollarsPerMillion === undefined ? {} : { cacheWriteMicrodollarsPerMillion }),
    outputMicrodollarsPerMillion,
    ...(longContextThresholdTokens === undefined ||
    cachedInputMicrodollarsPerMillion === undefined ||
    cacheWriteMicrodollarsPerMillion === undefined
      ? {}
      : {
          otherUnitPrices: longContextOtherUnitPrices(longContextThresholdTokens, {
            inputMicrodollarsPerMillion,
            cachedInputMicrodollarsPerMillion,
            cacheWriteMicrodollarsPerMillion,
            outputMicrodollarsPerMillion,
          }),
        }),
    source: 'provider',
  };
}

function microdollars(dollars: number) {
  return Math.round(dollars * 1_000_000);
}

function compactLimit(maxInputTokens: number) {
  return Math.floor(maxInputTokens * 0.9);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nullableSafeInteger(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return value;
  return safeInteger(value);
}

function safeIntegerRecord(value: unknown): Record<string, number> {
  const candidate = object(value);
  if (!candidate) return {};
  return Object.fromEntries(
    Object.entries(candidate).filter((entry): entry is [string, number] => safeInteger(entry[1]) !== undefined)
  );
}
