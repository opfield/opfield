export const LONG_CONTEXT_PRICING_KEYS = {
  thresholdTokens: 'long_context_threshold_tokens',
  inputMicrodollarsPerMillion: 'long_context_input_microdollars_per_million',
  cachedInputMicrodollarsPerMillion: 'long_context_cached_input_microdollars_per_million',
  cacheWriteMicrodollarsPerMillion: 'long_context_cache_write_microdollars_per_million',
  outputMicrodollarsPerMillion: 'long_context_output_microdollars_per_million',
} as const;

export interface TokenPricingRates {
  inputMicrodollarsPerMillion: number | null;
  cachedInputMicrodollarsPerMillion: number | null;
  cacheWriteMicrodollarsPerMillion: number | null;
  outputMicrodollarsPerMillion: number | null;
  reasoningMicrodollarsPerMillion: number | null;
  otherUnitPrices?: Record<string, number>;
}

/**
 * Applies a provider's long-context tariff when the provider defines a complete
 * alternate tier. The threshold is exclusive because OpenAI bills prompts with
 * more than 272K input tokens at the long-context rate.
 */
export function tokenPricingForInputTokens(inputTokens: number, pricing: TokenPricingRates): TokenPricingRates {
  const other = pricing.otherUnitPrices;
  const threshold = other?.[LONG_CONTEXT_PRICING_KEYS.thresholdTokens];
  if (threshold === undefined || inputTokens <= threshold) return pricing;

  const longInput = other?.[LONG_CONTEXT_PRICING_KEYS.inputMicrodollarsPerMillion];
  const longCachedInput = other?.[LONG_CONTEXT_PRICING_KEYS.cachedInputMicrodollarsPerMillion];
  const longCacheWrite = other?.[LONG_CONTEXT_PRICING_KEYS.cacheWriteMicrodollarsPerMillion];
  const longOutput = other?.[LONG_CONTEXT_PRICING_KEYS.outputMicrodollarsPerMillion];
  if (
    longInput === undefined ||
    longCachedInput === undefined ||
    longCacheWrite === undefined ||
    longOutput === undefined
  ) {
    return pricing;
  }

  return {
    ...pricing,
    inputMicrodollarsPerMillion: longInput,
    cachedInputMicrodollarsPerMillion: longCachedInput,
    cacheWriteMicrodollarsPerMillion: longCacheWrite,
    outputMicrodollarsPerMillion: longOutput,
    reasoningMicrodollarsPerMillion: longOutput,
  };
}

export function longContextOtherUnitPrices(
  thresholdTokens: number,
  shortRates: {
    inputMicrodollarsPerMillion: number;
    cachedInputMicrodollarsPerMillion: number;
    cacheWriteMicrodollarsPerMillion: number;
    outputMicrodollarsPerMillion: number;
  }
): Record<string, number> {
  return {
    [LONG_CONTEXT_PRICING_KEYS.thresholdTokens]: thresholdTokens,
    [LONG_CONTEXT_PRICING_KEYS.inputMicrodollarsPerMillion]: shortRates.inputMicrodollarsPerMillion * 2,
    [LONG_CONTEXT_PRICING_KEYS.cachedInputMicrodollarsPerMillion]: shortRates.cachedInputMicrodollarsPerMillion * 2,
    [LONG_CONTEXT_PRICING_KEYS.cacheWriteMicrodollarsPerMillion]: shortRates.cacheWriteMicrodollarsPerMillion * 2,
    [LONG_CONTEXT_PRICING_KEYS.outputMicrodollarsPerMillion]: shortRates.outputMicrodollarsPerMillion * 1.5,
  };
}

/** Shown wherever an API source has no price: its requests run, with tokens recorded and the cost unknown. */
export const INFERENCE_PRICE_MISSING_WARNING = 'No price set: requests are not charged to API budgets';

/** Token metering needs both an input and an output price. */
export function hasTokenPrices(
  pricing:
    | { inputMicrodollarsPerMillion: number | null; outputMicrodollarsPerMillion: number | null }
    | null
    | undefined
): boolean {
  return Boolean(
    pricing && pricing.inputMicrodollarsPerMillion !== null && pricing.outputMicrodollarsPerMillion !== null
  );
}
