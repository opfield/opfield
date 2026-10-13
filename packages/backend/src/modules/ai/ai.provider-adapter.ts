import { inspect } from 'node:util';
import type OpenAI from 'openai';
import type { AIConfig } from './ai.types.js';

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface NormalizedModelResponse {
  content: string;
  toolCalls: NormalizedToolCall[];
}

export interface AIModelTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ModelProviderEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'model_response'; response: NormalizedModelResponse }
  /** A retried model call: drop the text the failed attempt streamed (its last `discardedChars` characters). */
  | { type: 'text_reset'; discardedChars: number };

interface StreamModelOptions {
  client: OpenAI;
  config: AIConfig;
  messages: Record<string, unknown>[];
  tools: AIModelTool[];
  signal: AbortSignal;
}

type ProviderEndpoint = 'chat_completions' | 'responses';
const DEBUG_OPENAI_RESPONSES = process.env.AI_DEBUG_OPENAI_RESPONSES === '1';

export function resolveAIProviderEndpoint(config: AIConfig): ProviderEndpoint {
  if (config.endpointMode === 'chat_completions' || config.endpointMode === 'responses') {
    return config.endpointMode;
  }
  const providerUrl = config.providerUrl.trim();
  if (!providerUrl) return 'responses';
  try {
    const hostname = new URL(providerUrl).hostname.toLowerCase();
    return hostname === 'api.openai.com' || hostname.endsWith('.openai.com') ? 'responses' : 'chat_completions';
  } catch {
    return 'chat_completions';
  }
}

export async function* streamModelResponse(options: StreamModelOptions): AsyncGenerator<ModelProviderEvent> {
  const endpoint = resolveAIProviderEndpoint(options.config);
  if (endpoint === 'responses') {
    yield* streamResponsesModel(options);
    return;
  }
  yield* streamChatCompletionsModel(options);
}

async function* streamChatCompletionsModel({
  client,
  config,
  messages,
  tools,
  signal,
}: StreamModelOptions): AsyncGenerator<ModelProviderEvent> {
  const normalizedMessages = filterOrphanToolMessages(messages);
  const stream = await client.chat.completions.create(
    {
      model: config.model || 'gpt-4o',
      messages: normalizedMessages as unknown as OpenAI.ChatCompletionMessageParam[],
      tools: tools.length > 0 ? (tools as OpenAI.ChatCompletionTool[]) : undefined,
      stream: true,
      ...(config.maxTokensField === 'max_tokens'
        ? { max_tokens: config.maxCompletionTokens }
        : { max_completion_tokens: config.maxCompletionTokens }),
      ...(config.reasoningEffort && config.reasoningEffort !== 'none'
        ? ({ reasoning_effort: config.reasoningEffort } as Record<string, unknown>)
        : {}),
    },
    { signal }
  );

  let content = '';
  const toolCallAccumulators = new Map<number, NormalizedToolCall>();
  let finishReason: string | null = null;

  for await (const chunk of stream) {
    if (signal.aborted) throw abortError();

    const choice = chunk.choices[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      yield { type: 'text_delta', content: delta.content };
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!toolCallAccumulators.has(idx)) {
          toolCallAccumulators.set(idx, { id: tc.id || '', name: tc.function?.name || '', arguments: '' });
        }
        const acc = toolCallAccumulators.get(idx)!;
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
      }
    }
  }

  if (!finishReason) {
    throw providerTerminalError('AI_PROVIDER_STREAM_INCOMPLETE', 'Chat Completions stream ended without a terminal');
  }
  if (finishReason === 'length') {
    throw providerTerminalError('AI_PROVIDER_INCOMPLETE', 'Chat Completions stopped at the output token limit');
  }
  if (!['stop', 'tool_calls', 'function_call'].includes(finishReason)) {
    throw providerTerminalError('AI_PROVIDER_FAILED', `Chat Completions ended with finish reason ${finishReason}`);
  }

  yield { type: 'model_response', response: { content, toolCalls: Array.from(toolCallAccumulators.values()) } };
}

function toResponsesTools(tools: StreamModelOptions['tools']): Array<{
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean | null;
}> {
  return tools.map((tool) => ({
    type: 'function' as const,
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: null,
  }));
}

function splitInstructions(messages: Record<string, unknown>[]): { instructions: string | null; input: unknown[] } {
  const instructions: string[] = [];
  const input: unknown[] = [];

  for (const message of filterOrphanToolMessages(messages)) {
    const role = message.role;
    const content = typeof message.content === 'string' ? message.content : '';

    if (role === 'system') {
      if (content) instructions.push(content);
      continue;
    }

    if (role === 'tool') {
      const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined;
      if (!callId) continue;
      input.push({ type: 'function_call_output', call_id: callId, output: content || '{}' });
      continue;
    }

    if (role === 'assistant') {
      if (content) input.push({ role: 'assistant', content });
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const toolCall of toolCalls) {
        const call = normalizeChatToolCall(toolCall);
        if (!call) continue;
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
      continue;
    }

    if (role === 'user') {
      const userContent = toResponsesUserContent(message.content);
      if (userContent) input.push({ role: 'user', content: userContent });
    }
  }

  return { instructions: instructions.join('\n\n') || null, input };
}

function toResponsesUserContent(content: unknown): string | unknown[] | null {
  if (typeof content === 'string') return content || null;
  if (!Array.isArray(content)) return null;

  const parts: unknown[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string' && record.text) {
      parts.push({ type: 'input_text', text: record.text });
      continue;
    }
    if (record.type === 'image_url' && record.image_url && typeof record.image_url === 'object') {
      const image = record.image_url as Record<string, unknown>;
      if (typeof image.url === 'string' && image.url) {
        parts.push({ type: 'input_image', image_url: image.url });
      }
    }
  }
  return parts.length > 0 ? parts : null;
}

async function* streamResponsesModel({
  client,
  config,
  messages,
  tools,
  signal,
}: StreamModelOptions): AsyncGenerator<ModelProviderEvent> {
  const { instructions, input } = splitInstructions(messages);
  const stream = await client.responses.create(
    {
      model: config.model || 'gpt-4o',
      instructions,
      input: input as any,
      tools: tools.length > 0 ? (toResponsesTools(tools) as any) : undefined,
      stream: true,
      store: false,
      max_output_tokens: config.maxCompletionTokens,
      parallel_tool_calls: true,
      ...(config.reasoningEffort && config.reasoningEffort !== 'none'
        ? ({ reasoning: { effort: config.reasoningEffort } } as Record<string, unknown>)
        : {}),
    },
    { signal }
  );

  let content = '';
  const byOutputIndex = new Map<number, NormalizedToolCall>();
  let completed = false;

  for await (const event of stream) {
    if (signal.aborted) throw abortError();
    if (DEBUG_OPENAI_RESPONSES) {
      console.log('[AI DEBUG] OpenAI Responses stream event');
      console.log(inspect(event, { depth: null, colors: false, maxArrayLength: null, maxStringLength: null }));
    }

    const rawEvent = event as unknown as Record<string, any>;
    if (rawEvent.type === 'response.completed') {
      completed = true;
      continue;
    }
    if (rawEvent.type === 'response.incomplete') {
      const reason = rawEvent.response?.incomplete_details?.reason;
      throw providerTerminalError(
        'AI_PROVIDER_INCOMPLETE',
        typeof reason === 'string' ? `Responses stream incomplete: ${reason}` : 'Responses stream incomplete'
      );
    }
    if (rawEvent.type === 'response.failed') {
      throw providerTerminalError(
        'AI_PROVIDER_FAILED',
        rawEvent.response?.error?.message || 'Responses provider reported a failed response'
      );
    }
    if (rawEvent.type === 'error') {
      throw providerTerminalError('AI_PROVIDER_FAILED', rawEvent.message || 'Responses provider stream failed');
    }

    if (event.type === 'response.output_text.delta') {
      content += event.delta;
      yield { type: 'text_delta', content: event.delta };
      continue;
    }

    if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
      byOutputIndex.set(event.output_index, {
        id: event.item.call_id,
        name: event.item.name,
        arguments: event.item.arguments || '',
      });
      continue;
    }

    if (event.type === 'response.function_call_arguments.delta') {
      const acc = byOutputIndex.get(event.output_index);
      if (acc) acc.arguments += event.delta;
      continue;
    }

    if (event.type === 'response.function_call_arguments.done') {
      const acc = byOutputIndex.get(event.output_index);
      if (acc) {
        if (typeof event.name === 'string' && event.name) acc.name = event.name;
        acc.arguments = event.arguments;
      } else {
        const eventWithCallId = event as unknown as { call_id?: unknown };
        const callId = typeof eventWithCallId.call_id === 'string' ? eventWithCallId.call_id : event.item_id;
        byOutputIndex.set(event.output_index, {
          id: callId,
          name: typeof event.name === 'string' ? event.name : '',
          arguments: event.arguments,
        });
      }
    }
  }

  if (!completed) {
    throw providerTerminalError('AI_PROVIDER_STREAM_INCOMPLETE', 'Responses stream ended without response.completed');
  }

  yield {
    type: 'model_response',
    response: {
      content,
      toolCalls: Array.from(byOutputIndex.values()).filter((toolCall) => toolCall.id && toolCall.name),
    },
  };
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function providerTerminalError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function filterOrphanToolMessages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const availableToolCallIds = new Set<string>();
  const result: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (message.role === 'assistant') {
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const validToolCalls = toolCalls.filter((toolCall) => normalizeChatToolCall(toolCall) !== null);
      for (const toolCall of validToolCalls) {
        availableToolCallIds.add(normalizeChatToolCall(toolCall)!.id);
      }
      const content = typeof message.content === 'string' ? message.content : '';
      if (!content && validToolCalls.length === 0) continue;
      result.push(validToolCalls.length > 0 ? { ...message, tool_calls: validToolCalls } : message);
      continue;
    }

    if (message.role === 'tool') {
      const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined;
      if (!callId || !availableToolCallIds.has(callId)) continue;
    }

    result.push(message);
  }

  return result;
}

function normalizeChatToolCall(toolCall: unknown): { id: string; name: string; arguments: string } | null {
  if (!toolCall || typeof toolCall !== 'object') return null;
  const call = toolCall as {
    id?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  };
  const id = typeof call.id === 'string' && call.id ? call.id : null;
  const name = typeof call.function?.name === 'string' && call.function.name ? call.function.name : null;
  if (!id || !name) return null;
  return {
    id,
    name,
    arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : '{}',
  };
}
