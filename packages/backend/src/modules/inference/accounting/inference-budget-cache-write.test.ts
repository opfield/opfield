import { describe, expect, it } from 'vitest';
import { apiMicrodollars } from './inference-budget-policy.js';

const pricing = {
  inputMicrodollarsPerMillion: 4_000_000,
  cachedInputMicrodollarsPerMillion: 200_000,
  cacheWriteMicrodollarsPerMillion: 5_000_000,
  outputMicrodollarsPerMillion: 20_000_000,
  reasoningMicrodollarsPerMillion: null,
};
const writes = {
  inputTokens: 1_000_000,
  cachedInputTokens: 0,
  cacheWriteTokens: 1_000_000,
  outputTokens: 0,
  reasoningTokens: 0,
};

describe('apiMicrodollars', () => {
  it('prices five-minute cache writes at the write rate', () => {
    expect(apiMicrodollars(writes, pricing)).toBe(5_000_000);
  });

  it('prices one-hour cache writes at twice the input price', () => {
    expect(apiMicrodollars({ ...writes, cacheWrite1hTokens: 1_000_000 }, pricing)).toBe(8_000_000);
    expect(apiMicrodollars({ ...writes, cacheWrite1hTokens: 250_000 }, pricing)).toBe(5_750_000);
  });

  it('never counts more one-hour tokens than cache writes', () => {
    expect(apiMicrodollars({ ...writes, cacheWrite1hTokens: 9_000_000 }, pricing)).toBe(8_000_000);
  });

  it('charges each search at the snapshot price, or the published price without one', () => {
    const usage = { ...writes, cacheWriteTokens: 0, inputTokens: 0, webSearchRequests: 3 };
    expect(apiMicrodollars(usage, pricing)).toBe(30_000);
    expect(apiMicrodollars(usage, { ...pricing, otherUnitPrices: { web_search_query: 12_000 } })).toBe(36_000);
  });
});
