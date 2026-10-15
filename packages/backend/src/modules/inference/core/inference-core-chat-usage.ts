import type { InferenceCoreUsage } from './inference-core.contract.js';

type Rec = Record<string, unknown>;

/** The core's own output fallback when a Chat request states no limit. */
const FALLBACK_MAX_OUTPUT_TOKENS = 16_384;
/** Characters an image/audio/file part counts as, matching the Opfield input estimate. */
const MEDIA_PART_CHARACTERS = 4_000;

function rec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/**
 * Chat Completions `usage` in the settlement shape, split the way the core
 * splits its own attempts: cached and cache-write tokens leave the uncached
 * input, reasoning tokens leave the output.
 */
export function chatCompletionUsage(value: unknown): InferenceCoreUsage | null {
  const usage = rec(value);
  if (!usage) return null;
  const prompt = count(usage.prompt_tokens);
  const completion = count(usage.completion_tokens);
  if (prompt === undefined && completion === undefined) return null;
  const promptDetails = rec(usage.prompt_tokens_details);
  const completionDetails = rec(usage.completion_tokens_details);
  const cached = count(promptDetails?.cached_tokens) ?? count(usage.prompt_cache_hit_tokens) ?? 0;
  const cacheWrite = count(promptDetails?.cache_write_tokens) ?? 0;
  const reasoning = count(completionDetails?.reasoning_tokens) ?? 0;
  return {
    uncachedInputTokens: Math.max(0, (prompt ?? 0) - cached - cacheWrite),
    cachedInputTokens: cached,
    cacheWriteTokens: cacheWrite,
    outputTokens: Math.max(0, (completion ?? 0) - reasoning),
    reasoningTokens: reasoning,
  };
}

export interface ChatRequestEstimate {
  inputTokens: number;
  requestedMaxOutputTokens: number | null;
}

function partCharacters(part: unknown): number {
  if (typeof part === 'string') return part.length;
  const value = rec(part);
  if (!value) return 0;
  if (typeof value.text === 'string') return value.text.length;
  if (typeof value.refusal === 'string') return value.refusal.length;
  return value.type === 'image_url' || value.type === 'input_audio' || value.type === 'file'
    ? MEDIA_PART_CHARACTERS
    : 0;
}

/** Admission estimate of a Chat Completions body: text characters / 3, media at a fixed size. */
export function chatRequestEstimate(body: Rec): ChatRequestEstimate {
  let characters = 0;
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const entry = rec(message);
    if (!entry) continue;
    if (Array.isArray(entry.content)) for (const part of entry.content) characters += partCharacters(part);
    else characters += partCharacters(entry.content);
    for (const call of Array.isArray(entry.tool_calls) ? entry.tool_calls : []) {
      const fn = rec(rec(call)?.function);
      characters += (typeof fn?.name === 'string' ? fn.name.length : 0) + partCharacters(fn?.arguments);
    }
  }
  if (Array.isArray(body.tools)) characters += JSON.stringify(body.tools).length;
  const requested = count(body.max_completion_tokens) ?? count(body.max_tokens);
  return {
    inputTokens: Math.max(1, Math.ceil(characters / 3)),
    requestedMaxOutputTokens: requested && requested > 0 ? requested : null,
  };
}

/** The admission estimate the core would send: the client's limit, else the fallback, within the model ceiling. */
export function chatAdmissionEstimate(
  estimate: ChatRequestEstimate,
  modelMaxOutputTokens: number | null
): { inputTokens: number; maxOutputTokens: number } {
  const wanted = estimate.requestedMaxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS;
  const ceiling = modelMaxOutputTokens && modelMaxOutputTokens > 0 ? modelMaxOutputTokens : wanted;
  return { inputTokens: estimate.inputTokens, maxOutputTokens: Math.max(1, Math.min(wanted, ceiling)) };
}
