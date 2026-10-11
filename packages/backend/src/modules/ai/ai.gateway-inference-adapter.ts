import type { InferenceRuntimeService } from '@/modules/inference/inference-runtime.service.js';
import { InferenceProtocolError } from '@/modules/inference/protocol/inference-protocol.error.js';
import type {
  InferenceContentPart,
  InferenceMessage,
  InferenceTool,
} from '@/modules/inference/protocol/inference-protocol.types.js';
import type { AIModelTool, ModelProviderEvent, NormalizedToolCall } from './ai.provider-adapter.js';

export interface GatewayInferenceStreamOptions {
  runtime: InferenceRuntimeService;
  userId: string;
  requestId: string;
  conversationId?: string;
  model: string;
  messages: Record<string, unknown>[];
  tools: AIModelTool[];
  maxOutputTokens?: number;
  reasoningEffort?: string;
  signal: AbortSignal;
  isCompaction?: boolean;
}

export async function* streamGatewayInferenceResponse(
  options: GatewayInferenceStreamOptions
): AsyncGenerator<ModelProviderEvent> {
  const execution = await options.runtime.execute(
    {
      protocol: 'responses',
      model: options.model,
      messages: toInferenceMessages(options.messages),
      tools: toInferenceTools(options.tools),
      stream: true,
      maxOutputTokens: options.maxOutputTokens,
      reasoningEffort: options.reasoningEffort,
      parallelToolCalls: true,
      isCompaction: options.isCompaction === true,
      extensions: {},
    },
    {
      requestId: options.requestId,
      userId: options.userId,
      tokenId: null,
      affinityKey: options.conversationId ? `ai:${options.conversationId}` : undefined,
      existingThread: Boolean(options.conversationId),
      signal: options.signal,
    }
  );

  let content = '';
  let completed = false;
  let receivedModelOutput = false;
  const toolCalls = new Map<string, NormalizedToolCall>();

  try {
    for await (const event of execution.events) {
      if (options.signal.aborted) throw abortError();
      if (
        event.type === 'output_text.delta' ||
        event.type === 'reasoning.delta' ||
        event.type === 'tool_call.delta' ||
        event.type === 'item.done'
      ) {
        receivedModelOutput = true;
      }

      if (event.type === 'output_text.delta') {
        content += event.delta;
        yield { type: 'text_delta', content: event.delta };
        continue;
      }
      if (event.type === 'tool_call.delta') {
        const current = toolCalls.get(event.callId) ?? {
          id: event.callId,
          name: event.name,
          arguments: '',
        };
        current.name = event.name || current.name;
        current.arguments += event.delta;
        toolCalls.set(event.callId, current);
        continue;
      }
      if (event.type === 'item.done') {
        if (event.item.type === 'message' && event.item.text) {
          const missingText = event.item.text.startsWith(content)
            ? event.item.text.slice(content.length)
            : content
              ? ''
              : event.item.text;
          if (missingText) {
            content += missingText;
            yield { type: 'text_delta', content: missingText };
          }
        }
        if (event.item.type === 'function_call') {
          toolCalls.set(event.item.callId, {
            id: event.item.callId,
            name: event.item.name,
            arguments: event.item.arguments || '{}',
          });
        }
        continue;
      }
      if (event.type === 'error') {
        throw new InferenceProtocolError(502, event.code, event.message);
      }
      if (event.type === 'completed') {
        if (event.status && event.status !== 'completed') {
          throw new Error(event.incompleteReason || `Opfield Inference ended with status ${event.status}`);
        }
        completed = true;
      }
    }
  } catch (error) {
    throw markGatewayInferenceOutput(error, receivedModelOutput);
  }

  if (!completed) {
    throw new InferenceProtocolError(
      502,
      'upstream_stream_incomplete',
      'Opfield Inference stream ended without a successful terminal event'
    );
  }
  yield {
    type: 'model_response',
    response: {
      content,
      toolCalls: [...toolCalls.values()].filter((toolCall) => toolCall.id && toolCall.name),
    },
  };
}

function markGatewayInferenceOutput(error: unknown, emittedOutput: boolean): unknown {
  if (!emittedOutput || !(error instanceof InferenceProtocolError)) return error;
  return new InferenceProtocolError(error.status, error.code, error.message, {
    ...error.details,
    emittedOutput: true,
  });
}

function toInferenceMessages(messages: Record<string, unknown>[]): InferenceMessage[] {
  const result: InferenceMessage[] = [];
  const availableToolCallIds = new Set<string>();

  for (const message of messages) {
    const role = message.role;
    if (role === 'tool') {
      const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      if (!callId || !availableToolCallIds.has(callId)) continue;
      result.push({
        role: 'user',
        content: [{ type: 'tool_result', callId, output: contentText(message.content) || '{}' }],
      });
      continue;
    }
    if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;

    const content = toInferenceContent(message.content);
    if (role === 'assistant') {
      for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const normalized = normalizeToolCall(toolCall);
        if (!normalized) continue;
        availableToolCallIds.add(normalized.id);
        content.push({
          type: 'tool_call',
          id: normalized.id,
          callId: normalized.id,
          name: normalized.name,
          arguments: normalized.arguments,
        });
      }
    }
    if (content.length === 0) continue;
    result.push({ role, content });
  }
  return result;
}

function toInferenceContent(value: unknown): InferenceContentPart[] {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
  if (!Array.isArray(value)) return [];

  const parts: InferenceContentPart[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const part = item as Record<string, unknown>;
    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url') {
      parts.push({ type: 'image', source: part });
    }
  }
  return parts;
}

function toInferenceTools(tools: AIModelTool[]): InferenceTool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    inputSchema: tool.function.parameters,
    raw: {
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));
}

function normalizeToolCall(value: unknown): NormalizedToolCall | null {
  if (!value || typeof value !== 'object') return null;
  const call = value as {
    id?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  };
  if (typeof call.id !== 'string' || !call.id || typeof call.function?.name !== 'string' || !call.function.name) {
    return null;
  }
  return {
    id: call.id,
    name: call.function.name,
    arguments: typeof call.function.arguments === 'string' ? call.function.arguments : '{}',
  };
}

function contentText(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}
