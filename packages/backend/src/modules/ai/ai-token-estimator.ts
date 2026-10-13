import { AppError } from '@/middleware/error-handler.js';
import type { AIContextLimits } from './ai.types.js';

const MESSAGE_OVERHEAD_TOKENS = 4;
const TOOL_CALL_OVERHEAD_TOKENS = 20;
const IMAGE_BASE_TOKENS = 85;
const IMAGE_BYTES_PER_TOKEN = 512;
const TEXT_BYTES_PER_TOKEN = 3;

export function estimateTextTokens(value: string): number {
  // Tool-heavy conversations contain JSON, source code, paths, and identifiers,
  // which tokenize materially denser than natural-language prose. A 4-byte
  // estimate allowed the provider context to cross the configured compaction
  // threshold before Opfield initiated compaction.
  return Math.max(0, Math.ceil(Buffer.byteLength(value, 'utf8') / TEXT_BYTES_PER_TOKEN));
}

export function estimateProviderMessagesTokens(messages: Record<string, unknown>[]): number {
  return messages.reduce((total, message) => total + estimateProviderMessageTokens(message), 0);
}

export function estimateToolSchemaTokens(tools: unknown[]): number {
  return estimateTextTokens(safeSerialize(tools));
}

export function estimateProviderInputTokens(messages: Record<string, unknown>[], tools: unknown[]): number {
  return estimateProviderMessagesTokens(messages) + estimateToolSchemaTokens(tools);
}

export function assertProviderInputWithinLimits(
  messages: Record<string, unknown>[],
  tools: unknown[],
  limits: AIContextLimits
): number {
  const estimatedTokens = estimateProviderInputTokens(messages, tools);
  if (estimatedTokens > limits.maxInputTokens) {
    throw new AppError(
      409,
      'AI_CONTEXT_TOO_LARGE',
      `The provider input is estimated at ${estimatedTokens} tokens, above the ${limits.maxInputTokens} token hard limit`
    );
  }
  return estimatedTokens;
}

function estimateProviderMessageTokens(message: Record<string, unknown>): number {
  let total = MESSAGE_OVERHEAD_TOKENS;
  total += estimateContentTokens(message.content);

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    total += TOOL_CALL_OVERHEAD_TOKENS + estimateTextTokens(safeSerialize(toolCall));
  }
  if (typeof message.name === 'string') total += estimateTextTokens(message.name);
  if (typeof message.tool_call_id === 'string') total += estimateTextTokens(message.tool_call_id);
  return total;
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTextTokens(content);
  if (!Array.isArray(content)) return content == null ? 0 : estimateTextTokens(safeSerialize(content));

  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      total += estimateTextTokens(String(part ?? ''));
      continue;
    }
    const record = part as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      total += estimateTextTokens(record.text);
      continue;
    }
    if (record.type === 'image_url') {
      total += estimateImageTokens(record.image_url);
      continue;
    }
    total += estimateTextTokens(safeSerialize(record));
  }
  return total;
}

function estimateImageTokens(value: unknown): number {
  if (!value || typeof value !== 'object') return IMAGE_BASE_TOKENS;
  const url = (value as Record<string, unknown>).url;
  if (typeof url !== 'string') return IMAGE_BASE_TOKENS;
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma < 0) return IMAGE_BASE_TOKENS;
  const base64Length = Math.max(0, url.length - comma - 1);
  const decodedBytes = Math.floor((base64Length * 3) / 4);
  return IMAGE_BASE_TOKENS + Math.ceil(decodedBytes / IMAGE_BYTES_PER_TOKEN);
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value ?? '');
  }
}
