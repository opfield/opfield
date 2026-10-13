import { randomUUID } from 'node:crypto';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import type {
  InferenceContentPart,
  InferenceMessagePhase,
  InferenceRequest,
  InferenceStreamEvent,
  InferenceTool,
  InferenceUsage,
} from '../protocol/inference-protocol.types.js';
import { unwrapAntigravityPayload } from './inference-antigravity.js';
import type { InferenceProviderDefinition } from './inference-provider.types.js';
import { normalizeAnthropicUsage, normalizeOpenAiUsage, wireExtensions } from './inference-provider-fields.js';

type JsonObject = Record<string, unknown>;
const SAFE_UPSTREAM_ERROR_MESSAGE = 'Upstream inference request failed';
const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_CUSTOM_TOOL_PREFIX = 'custom_';
const CLAUDE_BUILTIN_TOOLS = new Set(['web_search', 'code_execution', 'text_editor', 'computer']);
const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;
const ANTHROPIC_REASONING_MAX_TOKENS = 32_000;
const ANTHROPIC_OUTPUT_HEADROOM = 4096;

export function providerRequestBody(
  definition: InferenceProviderDefinition,
  upstreamModel: string,
  request: InferenceRequest
): JsonObject {
  const extensions = { ...request.extensions };
  if (definition.wireProtocol !== 'anthropic-messages') delete extensions.context_management;
  if (definition.wireProtocol !== 'anthropic-messages') assertNoAnthropicCacheControl(request);
  if (definition.wireProtocol !== 'openai-responses' && request.tools.some((tool) => tool.type === 'hosted')) {
    throw new InferenceProtocolError(
      400,
      'unsupported_hosted_tool',
      'Hosted tools require a native Responses provider'
    );
  }
  if (definition.wireProtocol === 'google-gemini') {
    const extra = wireExtensions(extensions, ['temperature', 'top_p', 'top_k', 'stop', 'stop_sequences']);
    const system = request.messages
      .filter((message) => message.role === 'system' || message.role === 'developer')
      .flatMap((message) => message.content)
      .map(partText)
      .join('\n\n');
    return {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: request.messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: message.content.map(googlePart),
        })),
      ...(request.tools.length
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: providerToolName(tool),
                  description: tool.description,
                  parameters: tool.inputSchema ?? { type: 'object', properties: {} },
                })),
              },
            ],
          }
        : {}),
      generationConfig: {
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
        ...(request.reasoningEffort ? { thinkingConfig: googleThinking(request.reasoningEffort) } : {}),
        ...(extra.temperature !== undefined ? { temperature: extra.temperature } : {}),
        ...(extra.top_p !== undefined ? { topP: extra.top_p } : {}),
        ...(extra.top_k !== undefined ? { topK: extra.top_k } : {}),
        ...(extra.stop !== undefined ? { stopSequences: extra.stop } : {}),
        ...(extra.stop_sequences !== undefined ? { stopSequences: extra.stop_sequences } : {}),
      },
    };
  }
  if (definition.wireProtocol === 'anthropic-messages') {
    const extra = wireExtensions(extensions, [
      'temperature',
      'top_p',
      'top_k',
      'stop_sequences',
      'metadata',
      'service_tier',
      'output_config',
      'context_management',
    ]);
    const system = request.messages
      .filter((message) => message.role === 'system' || message.role === 'developer')
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'text')
      .map((part) => anthropicPart(part, false));
    const oauth = definition.id === 'anthropic';
    const thinking = anthropicThinking(upstreamModel, request);
    const outputConfig =
      request.protocol === 'messages' && object(extra.output_config)
        ? extra.output_config
        : thinking?.type === 'adaptive' && request.reasoningEffort
          ? { effort: anthropicAdaptiveEffort(request.reasoningEffort) }
          : undefined;
    delete extra.output_config;
    const body: JsonObject = {
      model: upstreamModel,
      max_tokens: anthropicMaxTokens(request, thinking),
      stream: true,
      ...(oauth
        ? {
            system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM_INSTRUCTION }, ...system],
          }
        : system.length
          ? { system }
          : {}),
      messages: request.messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({
          role: message.role,
          content: message.content.map((part) => anthropicPart(part, oauth)),
        })),
      ...(request.tools.length
        ? {
            tools: request.tools.map((tool) => anthropicTool(tool, oauth, request.protocol === 'messages')),
          }
        : {}),
      ...(request.toolChoice !== undefined
        ? { tool_choice: anthropicToolChoice(request.toolChoice, (name) => claudeToolName(name, oauth)) }
        : {}),
      ...(thinking ? { thinking } : {}),
      ...(outputConfig ? { output_config: outputConfig } : {}),
      ...extra,
    };
    if (thinking && thinking.type !== 'disabled') {
      delete body.temperature;
      delete body.top_p;
    }
    return body;
  }
  if (definition.wireProtocol === 'openai-chat') {
    const extra = wireExtensions(extensions, [
      'temperature',
      'top_p',
      'stop',
      'frequency_penalty',
      'presence_penalty',
      'seed',
      'response_format',
      'logprobs',
      'top_logprobs',
      'n',
      'service_tier',
      'store',
      'metadata',
      'stream_options',
      'user',
    ]);
    const streamOptions = object(extra.stream_options);
    delete extra.stream_options;
    return {
      model: upstreamModel,
      stream: true,
      stream_options: { ...streamOptions, include_usage: true },
      messages: chatMessages(request.messages),
      ...(request.tools.length
        ? {
            tools: request.tools.map(openAiChatTool),
          }
        : {}),
      ...(request.toolChoice !== undefined ? { tool_choice: openAiChatToolChoice(request.toolChoice) } : {}),
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
      ...(request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
      ...extra,
    };
  }
  const extra = wireExtensions(extensions, [
    'temperature',
    'top_p',
    'service_tier',
    'truncation',
    'store',
    'metadata',
    'max_tool_calls',
    'safety_identifier',
    'prompt_cache_retention',
    'text',
    'include',
    'client_metadata',
  ]);
  const codexSubscription = definition.id === 'openai';
  const instructionsField = codexSubscription || definition.id === 'opfield-core';
  const instructions = request.messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .flatMap((message) => message.content)
    .map(partText)
    .join('\n\n');
  const inputMessages = instructionsField
    ? request.messages.filter((message) => message.role === 'user' || message.role === 'assistant')
    : request.messages;
  return {
    model: upstreamModel,
    stream: true,
    ...(instructionsField && instructions ? { instructions } : {}),
    input: openAiInputItems(inputMessages),
    ...(request.tools.length ? { tools: request.tools.map(openAiTool) } : {}),
    ...(request.toolChoice !== undefined ? { tool_choice: openAiToolChoice(request.toolChoice) } : {}),
    ...(!codexSubscription && request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
    ...(request.reasoningConfig || request.reasoningEffort
      ? {
          reasoning: {
            ...(request.reasoningConfig ?? {}),
            ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
          },
        }
      : {}),
    ...(request.promptCacheKey ? { prompt_cache_key: request.promptCacheKey } : {}),
    parallel_tool_calls: request.parallelToolCalls,
    ...extra,
    ...(codexSubscription ? { store: false } : {}),
  };
}

export function providerInferencePath(definition: InferenceProviderDefinition, upstreamModel?: string): string {
  if (definition.wireProtocol === 'google-gemini') {
    return `/v1beta/models/${encodeURIComponent(upstreamModel ?? '')}:streamGenerateContent?alt=sse`;
  }
  if (definition.wireProtocol === 'anthropic-messages') return '/v1/messages';
  if (definition.wireProtocol === 'openai-chat') return '/chat/completions';
  return '/responses';
}

export function parseProviderEvent(
  definition: InferenceProviderDefinition,
  payload: JsonObject,
  state: ProviderStreamState
): InferenceStreamEvent[] {
  if (definition.id === 'google-antigravity') payload = unwrapAntigravityPayload(payload);
  if (definition.wireProtocol === 'anthropic-messages') return anthropicEvents(definition, payload, state);
  if (definition.wireProtocol === 'openai-chat') return chatEvents(payload, state);
  if (definition.wireProtocol === 'google-gemini') return googleEvents(payload, state);
  return responsesEvents(payload, state);
}

export interface ProviderStreamState {
  responseId: string;
  model: string;
  usage: Partial<InferenceUsage>;
  toolCalls: Map<
    number,
    { itemId: string; callId: string; name: string; namespace?: string; arguments: string; custom: boolean }
  >;
  blocks: Map<
    number,
    {
      itemId: string;
      callId?: string;
      name?: string;
      namespace?: string;
      type: string;
      arguments?: string;
      custom?: boolean;
      text?: string;
      signature?: string;
    }
  >;
  customToolNames: Set<string>;
  toolNames: Map<string, { name: string; namespace?: string }>;
  completedToolCalls: Set<number>;
  messagePhases: Map<string, InferenceMessagePhase>;
  activeMessage?: { itemId: string; text: string };
  activeReasoning?: { itemId: string; text: string };
  finishReason?: string;
  completed: boolean;
}

export function createProviderStreamState(model: string, tools: InferenceTool[] = []): ProviderStreamState {
  return {
    responseId: `resp_${randomUUID()}`,
    model,
    usage: {},
    toolCalls: new Map(),
    blocks: new Map(),
    customToolNames: new Set(tools.filter((tool) => tool.type === 'custom').map(providerToolName)),
    toolNames: new Map(
      tools
        .filter((tool) => tool.type !== 'hosted')
        .map((tool) => [
          providerToolName(tool),
          { name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}) },
        ])
    ),
    completedToolCalls: new Set(),
    messagePhases: new Map(),
    completed: false,
  };
}

function providerToolName(tool: { name: string; namespace?: string }): string {
  return tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
}

function resolveProviderToolName(state: ProviderStreamState, name: string): { name: string; namespace?: string } {
  return state.toolNames.get(name) ?? { name };
}

function responsesEvents(payload: JsonObject, state: ProviderStreamState): InferenceStreamEvent[] {
  const type = string(payload.type);
  const response = object(payload.response);
  if (response) {
    state.responseId = string(response.id) ?? state.responseId;
    state.model = string(response.model) ?? state.model;
  }
  if (type === 'response.output_item.added') {
    const item = object(payload.item);
    const index = number(payload.output_index) ?? 0;
    if (item?.type === 'message') {
      const itemId = string(item.id);
      const phase = inferenceMessagePhase(item.phase);
      if (itemId && phase) state.messagePhases.set(itemId, phase);
    }
    if (item && (item.type === 'function_call' || item.type === 'custom_tool_call')) {
      const toolName = resolveProviderToolName(state, string(item.name) ?? 'tool');
      state.blocks.set(index, {
        itemId: string(item.id) ?? `call_${randomUUID()}`,
        callId: string(item.call_id) ?? string(item.id),
        name: toolName.name,
        ...(toolName.namespace ? { namespace: toolName.namespace } : {}),
        type: string(item.type) ?? 'function_call',
        custom: item.type === 'custom_tool_call',
      });
    }
    return [];
  }
  if (type === 'response.output_text.delta') {
    const itemId = string(payload.item_id) ?? `msg_${randomUUID()}`;
    const phase = state.messagePhases.get(itemId);
    return [
      {
        type: 'output_text.delta',
        itemId,
        delta: string(payload.delta) ?? '',
        ...(phase ? { phase } : {}),
      },
    ];
  }
  if (type?.includes('reasoning') && type.endsWith('.delta')) {
    return [
      {
        type: 'reasoning.delta',
        itemId: string(payload.item_id) ?? `rsn_${randomUUID()}`,
        delta: string(payload.delta) ?? '',
      },
    ];
  }
  if (type === 'response.function_call_arguments.delta' || type === 'response.custom_tool_call_input.delta') {
    const index = number(payload.output_index) ?? 0;
    const block = state.blocks.get(index);
    return [
      {
        type: 'tool_call.delta',
        itemId: string(payload.item_id) ?? block?.itemId ?? `call_${randomUUID()}`,
        callId: block?.callId ?? string(payload.item_id) ?? `call_${randomUUID()}`,
        name: block?.name ?? 'tool',
        ...(block?.namespace ? { namespace: block.namespace } : {}),
        delta: string(payload.delta) ?? '',
        ...(type === 'response.custom_tool_call_input.delta' || block?.custom ? { custom: true } : {}),
      },
    ];
  }
  if (type === 'response.output_item.done') {
    const item = object(payload.item);
    if (!item) return [];
    if (item.type === 'message') {
      const itemId = string(item.id) ?? `msg_${randomUUID()}`;
      const phase = inferenceMessagePhase(item.phase) ?? state.messagePhases.get(itemId);
      const content = responseMessageContent(item);
      return [
        {
          type: 'item.done',
          item: {
            type: 'message',
            id: itemId,
            role: 'assistant',
            text: content.text,
            ...(content.annotations.length ? { annotations: content.annotations } : {}),
            ...(content.refusal ? { refusal: content.refusal } : {}),
            raw: item,
            ...(phase ? { phase } : {}),
          },
        },
      ];
    }
    if (item.type === 'reasoning') {
      return [
        {
          type: 'item.done',
          item: {
            type: 'reasoning',
            id: string(item.id) ?? `rsn_${randomUUID()}`,
            text: reasoningSummaryText(item),
            ...(string(item.encrypted_content) ? { signature: string(item.encrypted_content) } : {}),
          },
        },
      ];
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const toolName = resolveProviderToolName(state, string(item.name) ?? 'tool');
      return [
        {
          type: 'item.done',
          item: {
            type: 'function_call',
            id: string(item.id) ?? `call_${randomUUID()}`,
            callId: string(item.call_id) ?? string(item.id) ?? `call_${randomUUID()}`,
            name: toolName.name,
            ...(toolName.namespace ? { namespace: toolName.namespace } : {}),
            arguments: string(item.input) ?? string(item.arguments) ?? '',
            ...(item.type === 'custom_tool_call' ? { custom: true } : {}),
          },
        },
      ];
    }
    const itemId = string(item.id) ?? `${string(item.type) ?? 'hosted'}_${randomUUID()}`;
    return [{ type: 'item.done', item: { type: 'hosted', id: itemId, raw: { ...item, id: itemId } } }];
  }
  if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.cancelled') {
    state.usage = normalizeOpenAiUsage(object(response?.usage ?? payload.usage));
    state.completed = true;
    const incompleteReason = string(object(response?.incomplete_details)?.reason);
    return [
      {
        type: 'completed',
        usage: state.usage,
        finishReason: incompleteReason ?? (type === 'response.cancelled' ? 'cancelled' : 'stop'),
        status:
          type === 'response.incomplete' ? 'incomplete' : type === 'response.cancelled' ? 'cancelled' : 'completed',
        ...(incompleteReason ? { incompleteReason } : {}),
      },
    ];
  }
  if (type === 'response.failed' || type === 'error') {
    return [
      {
        type: 'error',
        code: safeUpstreamErrorCode(object(response?.error) ?? object(payload.error)),
        message: SAFE_UPSTREAM_ERROR_MESSAGE,
      },
    ];
  }
  return [];
}

/**
 * The machine code of a failed upstream response (for example upstream_server_error or server_is_overloaded),
 * so callers can tell a transient provider failure from a request error. The upstream text is never kept.
 */
function safeUpstreamErrorCode(error: JsonObject | null): string {
  const code = string(error?.code) ?? string(error?.type);
  return code && /^[a-z][a-z0-9_.-]{0,63}$/i.test(code) ? code.toLowerCase() : 'upstream_error';
}

function chatEvents(payload: JsonObject, state: ProviderStreamState): InferenceStreamEvent[] {
  state.responseId = string(payload.id) ?? state.responseId;
  state.model = string(payload.model) ?? state.model;
  const usage = object(payload.usage);
  if (usage) state.usage = normalizeOpenAiUsage(usage);
  const choice = Array.isArray(payload.choices) ? object(payload.choices[0]) : null;
  if (!choice) {
    if (!usage || state.completed) return [];
    state.completed = true;
    return [{ type: 'completed', usage: state.usage, finishReason: state.finishReason ?? 'stop' }];
  }
  const delta = object(choice.delta);
  const events: InferenceStreamEvent[] = [];
  const reasoning = string(delta?.reasoning_content ?? delta?.reasoning);
  if (reasoning) {
    closeChatMessage(state, events);
    state.activeReasoning ??= { itemId: `rs_${randomUUID()}`, text: '' };
    state.activeReasoning.text += reasoning;
    events.push({ type: 'reasoning.delta', itemId: state.activeReasoning.itemId, delta: reasoning });
  }
  const content = string(delta?.content);
  if (content) {
    closeChatReasoning(state, events);
    state.activeMessage ??= { itemId: `msg_${randomUUID()}`, text: '' };
    state.activeMessage.text += content;
    events.push({ type: 'output_text.delta', itemId: state.activeMessage.itemId, delta: content });
  }
  const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
  if (toolCalls.length > 0) {
    closeChatReasoning(state, events);
    closeChatMessage(state, events, 'commentary');
  }
  for (const raw of toolCalls) {
    const call = object(raw);
    const fn = object(call?.function);
    const index = number(call?.index) ?? 0;
    const existing = state.toolCalls.get(index);
    const upstreamName = string(fn?.name);
    const toolName = upstreamName ? resolveProviderToolName(state, upstreamName) : undefined;
    const name = toolName?.name ?? existing?.name ?? 'tool';
    const namespace = toolName?.namespace ?? existing?.namespace;
    const custom = existing?.custom ?? (upstreamName ? state.customToolNames.has(upstreamName) : false);
    const previous = existing ?? {
      itemId: `${custom ? 'ctc' : 'fc'}_${randomUUID()}`,
      callId: string(call?.id) ?? `call_${randomUUID()}`,
      name,
      ...(namespace ? { namespace } : {}),
      arguments: '',
      custom,
    };
    const delta = string(fn?.arguments) ?? '';
    const updated = {
      ...previous,
      ...(string(call?.id) ? { callId: string(call?.id)! } : {}),
      ...(upstreamName
        ? {
            name,
            ...(namespace ? { namespace } : {}),
            custom: state.customToolNames.has(upstreamName),
          }
        : {}),
      arguments: previous.arguments + delta,
    };
    state.toolCalls.set(index, updated);
    if (!updated.custom) {
      events.push({
        type: 'tool_call.delta',
        itemId: updated.itemId,
        callId: updated.callId,
        name: updated.name,
        ...(updated.namespace ? { namespace: updated.namespace } : {}),
        delta,
      });
    }
  }
  if (choice.finish_reason) {
    state.finishReason = string(choice.finish_reason) ?? 'stop';
    closeChatReasoning(state, events);
    closeChatMessage(state, events, state.finishReason === 'tool_calls' ? 'commentary' : 'final_answer');
    for (const [index, call] of state.toolCalls) {
      if (state.completedToolCalls.has(index)) continue;
      state.completedToolCalls.add(index);
      events.push({
        type: 'item.done',
        item: {
          type: 'function_call',
          id: call.itemId,
          callId: call.callId,
          name: call.name,
          ...(call.namespace ? { namespace: call.namespace } : {}),
          arguments: call.custom ? customToolInput(call.arguments) : call.arguments,
          ...(call.custom ? { custom: true } : {}),
        },
      });
    }
  }
  if (choice.finish_reason && usage && !state.completed) {
    state.completed = true;
    events.push({ type: 'completed', usage: state.usage, finishReason: state.finishReason });
  }
  return events;
}

function closeChatMessage(
  state: ProviderStreamState,
  events: InferenceStreamEvent[],
  phase?: InferenceMessagePhase
): void {
  if (!state.activeMessage) return;
  events.push({
    type: 'item.done',
    item: {
      type: 'message',
      id: state.activeMessage.itemId,
      role: 'assistant',
      text: state.activeMessage.text,
      ...(phase ? { phase } : {}),
    },
  });
  state.activeMessage = undefined;
}

function closeChatReasoning(state: ProviderStreamState, events: InferenceStreamEvent[]): void {
  if (!state.activeReasoning) return;
  events.push({
    type: 'item.done',
    item: {
      type: 'reasoning',
      id: state.activeReasoning.itemId,
      text: state.activeReasoning.text,
    },
  });
  state.activeReasoning = undefined;
}

function anthropicEvents(
  definition: InferenceProviderDefinition,
  payload: JsonObject,
  state: ProviderStreamState
): InferenceStreamEvent[] {
  const type = string(payload.type);
  const message = object(payload.message);
  if (message) {
    state.responseId = string(message.id) ?? state.responseId;
    state.model = string(message.model) ?? state.model;
    state.usage = normalizeAnthropicUsage(object(message.usage));
  }
  const index = number(payload.index) ?? 0;
  if (type === 'content_block_start') {
    const block = object(payload.content_block);
    const blockType = string(block?.type) ?? 'text';
    const upstreamName = stripClaudeToolName(string(block?.name), definition.id === 'anthropic');
    const toolName = resolveProviderToolName(state, upstreamName ?? 'tool');
    const name = toolName.name;
    const custom = state.customToolNames.has(upstreamName ?? '');
    const itemId =
      blockType === 'text'
        ? `msg_${randomUUID()}`
        : blockType === 'thinking' || blockType === 'reasoning' || blockType === 'redacted_thinking'
          ? `rs_${randomUUID()}`
          : `${custom ? 'ctc' : 'fc'}_${randomUUID()}`;
    state.blocks.set(index, {
      itemId,
      callId: string(block?.id),
      name,
      ...(toolName.namespace ? { namespace: toolName.namespace } : {}),
      type: blockType,
      custom,
      text:
        blockType === 'thinking' || blockType === 'reasoning'
          ? (string(block?.thinking ?? block?.reasoning) ?? '')
          : blockType === 'text'
            ? (string(block?.text) ?? '')
            : undefined,
      arguments: blockType === 'tool_use' && block?.input ? JSON.stringify(block.input) : '',
    });
    if (blockType === 'redacted_thinking' && string(block?.data)) {
      return [
        {
          type: 'item.done',
          item: {
            type: 'reasoning',
            id: itemId,
            text: '',
            redactedData: string(block?.data),
          },
        },
      ];
    }
    return [];
  }
  if (type === 'content_block_delta') {
    const delta = object(payload.delta);
    const block = state.blocks.get(index) ?? { itemId: `${state.responseId}:block:${index}`, type: 'text' };
    if (delta?.type === 'text_delta') {
      const text = string(delta.text) ?? '';
      block.text = (block.text ?? '') + text;
      state.blocks.set(index, block);
      return [{ type: 'output_text.delta', itemId: block.itemId, delta: text }];
    }
    if (delta?.type === 'thinking_delta' || delta?.type === 'reasoning_delta') {
      const text = string(delta.thinking ?? delta.reasoning) ?? '';
      block.text = (block.text ?? '') + text;
      state.blocks.set(index, block);
      return [{ type: 'reasoning.delta', itemId: block.itemId, delta: text }];
    }
    if (delta?.type === 'signature_delta') {
      block.signature = string(delta.signature);
      state.blocks.set(index, block);
      return [
        {
          type: 'reasoning.delta',
          itemId: block.itemId,
          delta: '',
          signature: block.signature,
        },
      ];
    }
    if (delta?.type === 'input_json_delta') {
      const partial = string(delta.partial_json) ?? '';
      block.arguments = (block.arguments ?? '') + partial;
      state.blocks.set(index, block);
      if (block.custom) {
        return [];
      }
      return [
        {
          type: 'tool_call.delta',
          itemId: block.itemId,
          callId: block.callId ?? block.itemId,
          name: block.name ?? 'tool',
          ...(block.namespace ? { namespace: block.namespace } : {}),
          delta: partial,
        },
      ];
    }
  }
  if (type === 'content_block_stop') {
    const block = state.blocks.get(index);
    if (!block || block.type === 'redacted_thinking') return [];
    if (block.type === 'text')
      return [
        {
          type: 'item.done',
          item: { type: 'message', id: block.itemId, role: 'assistant', text: block.text ?? '' },
        },
      ];
    if (block.type === 'thinking' || block.type === 'reasoning')
      return [
        {
          type: 'item.done',
          item: {
            type: 'reasoning',
            id: block.itemId,
            text: block.text ?? '',
            ...(block.signature ? { signature: block.signature } : {}),
          },
        },
      ];
    if (block.type === 'tool_use')
      return [
        {
          type: 'item.done',
          item: {
            type: 'function_call',
            id: block.itemId,
            callId: block.callId ?? block.itemId,
            name: block.name ?? 'tool',
            ...(block.namespace ? { namespace: block.namespace } : {}),
            arguments: block.custom ? customToolInput(block.arguments ?? '') : (block.arguments ?? ''),
            ...(block.custom ? { custom: true } : {}),
          },
        },
      ];
  }
  if (type === 'message_delta') {
    state.usage = mergeAnthropicUsage(state.usage, normalizeAnthropicUsage(object(payload.usage)));
    const delta = object(payload.delta);
    if (delta?.stop_reason) {
      const stopSequence = string(delta.stop_sequence);
      return [
        {
          type: 'completed',
          usage: state.usage,
          finishReason: string(delta.stop_reason) ?? 'stop',
          ...(stopSequence ? { stopSequence } : {}),
        },
      ];
    }
  }
  if (type === 'error') {
    return [
      {
        type: 'error',
        code: safeUpstreamErrorCode(object(payload.error)),
        message: SAFE_UPSTREAM_ERROR_MESSAGE,
      },
    ];
  }
  return [];
}

function googleEvents(payload: JsonObject, state: ProviderStreamState): InferenceStreamEvent[] {
  const candidate = Array.isArray(payload.candidates) ? object(payload.candidates[0]) : null;
  const content = object(candidate?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const events: InferenceStreamEvent[] = [];
  for (const raw of parts) {
    const part = object(raw);
    if (!part) continue;
    const text = string(part.text);
    if (text) {
      events.push(
        part.thought === true
          ? { type: 'reasoning.delta', itemId: `${state.responseId}:reasoning`, delta: text }
          : { type: 'output_text.delta', itemId: `${state.responseId}:message`, delta: text }
      );
    }
    const fn = object(part.functionCall);
    if (fn) {
      const id = string(fn.id) ?? `call_${randomUUID()}`;
      const toolName = resolveProviderToolName(state, string(fn.name) ?? 'tool');
      events.push({
        type: 'item.done',
        item: {
          type: 'function_call',
          id,
          callId: id,
          name: toolName.name,
          ...(toolName.namespace ? { namespace: toolName.namespace } : {}),
          arguments: JSON.stringify(fn.args ?? {}),
        },
      });
    }
  }
  const usage = object(payload.usageMetadata);
  if (usage) {
    const inputTokens = number(usage.promptTokenCount) ?? 0;
    const outputTokens = number(usage.candidatesTokenCount) ?? 0;
    const reasoningTokens = number(usage.thoughtsTokenCount) ?? 0;
    state.usage = {
      inputTokens,
      cachedInputTokens: number(usage.cachedContentTokenCount) ?? 0,
      outputTokens,
      reasoningTokens,
      totalTokens: number(usage.totalTokenCount) ?? inputTokens + outputTokens + reasoningTokens,
      estimated: false,
    };
  }
  if (candidate?.finishReason) {
    events.push({ type: 'completed', usage: state.usage, finishReason: string(candidate.finishReason) ?? 'stop' });
  }
  return events;
}

function openAiInputItems(messages: InferenceRequest['messages']): JsonObject[] {
  return messages.flatMap((message) => {
    const content = message.content.flatMap((part) =>
      part.type === 'tool_call' ||
      part.type === 'tool_result' ||
      part.type === 'compaction' ||
      part.type === 'reasoning' ||
      part.type === 'hosted'
        ? []
        : [openAiPart(part, message.role)]
    );
    const items: JsonObject[] = content.length
      ? [{ type: 'message', role: message.role, content, ...(message.phase ? { phase: message.phase } : {}) }]
      : [];
    for (const part of message.content) {
      if (part.type === 'tool_call') {
        items.push({
          type: part.custom ? 'custom_tool_call' : 'function_call',
          ...(isOpenAiFunctionItemId(part.id) ? { id: part.id } : {}),
          call_id: part.callId,
          name: providerToolName(part),
          ...(part.custom ? { input: part.arguments } : { arguments: part.arguments }),
        });
      } else if (part.type === 'tool_result') {
        items.push({
          type: part.custom ? 'custom_tool_call_output' : 'function_call_output',
          call_id: part.callId,
          output: part.output,
        });
      } else if (part.type === 'reasoning') {
        items.push({
          type: 'reasoning',
          ...(part.id ? { id: part.id } : {}),
          summary: part.text ? [{ type: 'summary_text', text: part.text }] : [],
          ...(part.signature || part.redactedData ? { encrypted_content: part.signature ?? part.redactedData } : {}),
        });
      } else if (part.type === 'compaction') {
        items.push({ type: 'compaction', encrypted_content: part.encryptedContent });
      } else if (part.type === 'hosted') {
        items.push(part.raw);
      }
    }
    return items;
  });
}

function isOpenAiFunctionItemId(value: string): boolean {
  return value.startsWith('fc');
}

function openAiPart(part: InferenceContentPart, role: InferenceRequest['messages'][number]['role']): JsonObject {
  if (part.type === 'text') return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
  if (part.type === 'image') return openAiImagePart(part.source);
  if (part.type === 'file') return openAiFilePart(part.source);
  return { type: 'input_text', text: partText(part) };
}

function openAiFilePart(source: JsonObject): JsonObject {
  if (source.type !== 'document') return source;
  const documentSource = object(source.source);
  if (!documentSource) return source;
  if (documentSource.type === 'base64' && typeof documentSource.data === 'string') {
    const mediaType = string(documentSource.media_type) ?? 'application/pdf';
    return {
      type: 'input_file',
      filename: string(source.title) ?? 'document.pdf',
      file_data: `data:${mediaType};base64,${documentSource.data}`,
    };
  }
  if (documentSource.type === 'url' && typeof documentSource.url === 'string') {
    return { type: 'input_file', file_url: documentSource.url };
  }
  throw new InferenceProtocolError(400, 'unsupported_file_input', 'This document source cannot be sent to OpenAI');
}

function openAiImagePart(source: JsonObject): JsonObject {
  if (source.type === 'image_url') {
    const imageUrl = object(source.image_url);
    const url = string(imageUrl?.url) ?? string(source.image_url);
    if (url) {
      const detail = string(imageUrl?.detail) ?? string(source.detail);
      return { type: 'input_image', image_url: url, ...(detail ? { detail } : {}) };
    }
  }
  return source;
}

function openAiTool(tool: InferenceRequest['tools'][number]): JsonObject {
  if (tool.type === 'hosted') return tool.raw;
  if (tool.type === 'custom') return { ...tool.raw, name: providerToolName(tool) };
  const rawFunction = object(tool.raw.function);
  return {
    type: 'function',
    name: providerToolName(tool),
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.inputSchema ?? {},
    ...(typeof rawFunction?.strict === 'boolean'
      ? { strict: rawFunction.strict }
      : typeof tool.raw.strict === 'boolean'
        ? { strict: tool.raw.strict }
        : {}),
  };
}

function openAiChatTool(tool: InferenceTool): JsonObject {
  if (tool.type !== 'custom') {
    return {
      type: 'function',
      function: {
        name: providerToolName(tool),
        description: tool.description,
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      },
    };
  }
  return {
    type: 'function',
    function: {
      name: providerToolName(tool),
      description: customToolDescription(tool),
      parameters: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'The complete freeform tool input, encoded exactly as required by the format above.',
          },
        },
        required: ['input'],
        additionalProperties: false,
      },
    },
  };
}

function anthropicTool(tool: InferenceTool, oauth: boolean, preserveRaw = false): JsonObject {
  const raw = preserveRaw ? tool.raw : {};
  return {
    ...raw,
    name: claudeToolName(providerToolName(tool), oauth),
    description: tool.type === 'custom' ? customToolDescription(tool) : tool.description,
    input_schema:
      tool.type === 'custom'
        ? {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: 'The complete freeform tool input, encoded exactly as required by the format above.',
              },
            },
            required: ['input'],
            additionalProperties: false,
          }
        : (tool.inputSchema ?? { type: 'object', properties: {} }),
    ...(tool.raw.cache_control !== undefined ? { cache_control: tool.raw.cache_control } : {}),
  };
}

function customToolDescription(tool: InferenceTool): string {
  const format = object(tool.raw.format);
  const syntax = string(format?.syntax);
  const definition = string(format?.definition);
  const formatGuide = [syntax ? `Syntax: ${syntax}` : '', definition ? `Format:\n${definition}` : '']
    .filter(Boolean)
    .join('\n');
  return [tool.description ?? '', 'Pass the complete custom tool payload in the input string.', formatGuide]
    .filter(Boolean)
    .join('\n\n');
}

function customToolInput(argumentsText: string): string {
  const parsed = parseJson(argumentsText);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const input = (parsed as JsonObject).input;
    if (typeof input === 'string') return input;
  }
  return argumentsText;
}

function openAiToolChoice(value: unknown): unknown {
  const choice = object(value);
  if (!choice || choice.type !== 'function') return value;
  const fn = object(choice.function);
  const name = typeof choice.name === 'string' ? choice.name : typeof fn?.name === 'string' ? fn.name : undefined;
  return name ? { type: 'function', name } : value;
}

function openAiChatToolChoice(value: unknown): unknown {
  if (typeof value === 'string') return value === 'any' ? 'required' : value;
  const choice = object(value);
  if (!choice) return value;
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } };
  }
  if (choice.type === 'function') {
    const fn = object(choice.function);
    const name = string(fn?.name) ?? string(choice.name);
    return name ? { type: 'function', function: { name } } : value;
  }
  return value;
}

function anthropicToolChoice(value: unknown, transformName: (name: string) => string): unknown {
  if (typeof value === 'string') {
    if (value === 'required') return { type: 'any' };
    return { type: value === 'any' ? 'any' : value };
  }
  const choice = object(value);
  if (!choice) return value;
  if (choice.type === 'function') {
    const fn = object(choice.function);
    const name = string(fn?.name) ?? string(choice.name);
    return name ? { type: 'tool', name: transformName(name) } : value;
  }
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { ...choice, name: transformName(choice.name) };
  }
  if (choice.type === 'required') return { type: 'any' };
  return value;
}

function anthropicPart(part: InferenceContentPart, oauth: boolean): JsonObject {
  if (part.type === 'text')
    return {
      type: 'text',
      text: part.text,
      ...(part.cacheControl !== undefined ? { cache_control: part.cacheControl } : {}),
    };
  if (part.type === 'image') return part.source;
  if (part.type === 'file') return anthropicFilePart(part);
  if (part.type === 'tool_call')
    return {
      type: 'tool_use',
      id: part.callId,
      name: claudeToolName(providerToolName(part), oauth),
      input: part.custom ? { input: part.arguments } : parseJson(part.arguments),
      ...(part.cacheControl !== undefined ? { cache_control: part.cacheControl } : {}),
    };
  if (part.type === 'tool_result')
    return {
      type: 'tool_result',
      tool_use_id: part.callId,
      content: part.output,
      is_error: part.isError,
      ...(part.cacheControl !== undefined ? { cache_control: part.cacheControl } : {}),
    };
  if (part.type === 'reasoning') {
    if (part.redactedData) return { type: 'redacted_thinking', data: part.redactedData };
    return {
      type: 'thinking',
      thinking: part.text,
      ...(part.signature ? { signature: part.signature } : {}),
      ...(part.cacheControl !== undefined ? { cache_control: part.cacheControl } : {}),
    };
  }
  if (part.type === 'hosted') return part.raw;
  return { type: 'text', text: part.encryptedContent };
}

function anthropicFilePart(part: Extract<InferenceContentPart, { type: 'file' }>): JsonObject {
  if (part.source.type === 'document') return part.source;
  const fileData = string(part.source.file_data);
  if (fileData) {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(fileData);
    if (match) {
      return {
        type: 'document',
        source: { type: 'base64', media_type: match[1], data: match[2] },
        ...(part.cacheControl !== undefined ? { cache_control: part.cacheControl } : {}),
      };
    }
  }
  const fileUrl = string(part.source.file_url);
  if (fileUrl) {
    return {
      type: 'document',
      source: { type: 'url', url: fileUrl },
      ...(part.cacheControl !== undefined ? { cache_control: part.cacheControl } : {}),
    };
  }
  throw new InferenceProtocolError(
    400,
    'unsupported_file_input',
    'Anthropic requires inline base64 or URL document content'
  );
}

function googlePart(part: InferenceContentPart): JsonObject {
  if (part.type === 'text') return { text: part.text };
  if (part.type === 'image') return part.source;
  if (part.type === 'file' || part.type === 'hosted') {
    throw new InferenceProtocolError(
      400,
      'unsupported_file_input',
      'This content is unsupported by the Google adapter'
    );
  }
  if (part.type === 'tool_call')
    return { functionCall: { id: part.callId, name: providerToolName(part), args: parseJson(part.arguments) } };
  if (part.type === 'tool_result')
    return { functionResponse: { name: part.callId, response: { output: part.output } } };
  if (part.type === 'reasoning') return { text: part.text, thought: true, thoughtSignature: part.signature };
  return { text: part.encryptedContent };
}

function chatMessages(messages: InferenceRequest['messages']): JsonObject[] {
  return messages.flatMap((message) => {
    const toolResults = message.content.filter((part) => part.type === 'tool_result');
    const resultMessages = toolResults.map((part) => ({
      role: 'tool',
      tool_call_id: part.type === 'tool_result' ? part.callId : '',
      content: part.type === 'tool_result' ? part.output : '',
    }));
    const visible = message.content.filter(
      (part) => part.type !== 'tool_result' && part.type !== 'tool_call' && part.type !== 'reasoning'
    );
    const toolCalls = message.content.filter((part) => part.type === 'tool_call');
    const reasoning = message.content
      .filter((part) => part.type === 'reasoning')
      .map((part) => (part.type === 'reasoning' ? part.text : ''))
      .join('');
    const primary =
      visible.length > 0 || toolCalls.length > 0 || reasoning
        ? [
            {
              role: message.role === 'developer' ? 'system' : message.role,
              content: visible.length > 0 ? chatContent(visible) : null,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
              ...(toolCalls.length
                ? {
                    tool_calls: toolCalls.map((part) =>
                      part.type === 'tool_call'
                        ? {
                            id: part.callId,
                            type: 'function',
                            function: {
                              name: providerToolName(part),
                              arguments: part.custom ? JSON.stringify({ input: part.arguments }) : part.arguments,
                            },
                          }
                        : null
                    ),
                  }
                : {}),
            },
          ]
        : [];
    return [...resultMessages, ...primary];
  });
}

function chatContent(parts: InferenceContentPart[]): string | JsonObject[] {
  if (parts.some((part) => part.type === 'file' || part.type === 'hosted')) {
    throw new InferenceProtocolError(400, 'unsupported_file_input', 'Chat Completions does not support this content');
  }
  if (parts.every((part) => part.type === 'text'))
    return parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  return parts.map((part) =>
    part.type === 'image' ? chatImagePart(part.source) : { type: 'text', text: partText(part) }
  );
}

function chatImagePart(source: JsonObject): JsonObject {
  if (source.type === 'input_image') {
    const url = string(source.image_url);
    return url
      ? { type: 'image_url', image_url: { url, ...(source.detail ? { detail: source.detail } : {}) } }
      : source;
  }
  return source;
}

function partText(part: InferenceContentPart): string {
  if (part.type === 'text' || part.type === 'reasoning') return part.text;
  if (part.type === 'tool_call') return `${part.name}(${part.arguments})`;
  if (part.type === 'tool_result') return part.output;
  if (part.type === 'compaction') return part.encryptedContent;
  if (part.type === 'file') return '[file]';
  if (part.type === 'hosted') return JSON.stringify(part.raw);
  return '[image]';
}

function assertNoAnthropicCacheControl(request: InferenceRequest): void {
  const contentHasCacheControl = request.messages.some((message) =>
    message.content.some((part) => 'cacheControl' in part && part.cacheControl !== undefined)
  );
  const toolHasCacheControl = request.tools.some((tool) => tool.raw.cache_control !== undefined);
  if (contentHasCacheControl || toolHasCacheControl) {
    throw new InferenceProtocolError(
      400,
      'unsupported_cache_control',
      'Anthropic cache_control cannot be represented by the selected provider'
    );
  }
}

function anthropicThinking(upstreamModel: string, request: InferenceRequest): JsonObject | undefined {
  if (request.protocol === 'messages' && request.reasoningConfig) return request.reasoningConfig;
  if (!request.reasoningEffort || request.reasoningEffort === 'none') return undefined;
  if (usesAdaptiveAnthropicThinking(upstreamModel)) return { type: 'adaptive' };
  return { type: 'enabled', budget_tokens: reasoningBudget(request.reasoningEffort) };
}

function anthropicMaxTokens(request: InferenceRequest, thinking: JsonObject | undefined): number {
  const requested = request.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
  if (!thinking || request.protocol === 'messages') return requested;
  const desiredBudget = reasoningBudget(request.reasoningEffort ?? 'medium');
  if (thinking.type === 'adaptive') {
    return request.maxOutputTokens ?? Math.min(40_192, Math.max(requested, desiredBudget + 8192));
  }
  const maxTokens = Math.min(
    ANTHROPIC_REASONING_MAX_TOKENS,
    Math.max(requested, desiredBudget + ANTHROPIC_OUTPUT_HEADROOM)
  );
  thinking.budget_tokens = Math.max(1024, Math.min(desiredBudget, maxTokens - ANTHROPIC_OUTPUT_HEADROOM));
  return maxTokens;
}

function usesAdaptiveAnthropicThinking(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    /claude-(?:opus-|sonnet-)?4-(?:6|7|8)(?:\b|-)/.test(normalized) ||
    /claude-(?:fable|mythos|sonnet|opus)-5(?:\b|-)/.test(normalized) ||
    normalized.includes('mythos-preview')
  );
}

function anthropicAdaptiveEffort(effort: string): string {
  if (effort === 'minimal' || effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  if (effort === 'high') return 'high';
  return 'max';
}

function claudeToolName(name: string, oauth: boolean): string {
  const normalized = name.toLowerCase();
  if (!oauth || CLAUDE_BUILTIN_TOOLS.has(normalized) || normalized.startsWith(CLAUDE_CUSTOM_TOOL_PREFIX)) return name;
  return `${CLAUDE_CUSTOM_TOOL_PREFIX}${name}`;
}

function stripClaudeToolName(name: string | undefined, oauth: boolean): string | undefined {
  if (!oauth || !name?.startsWith(CLAUDE_CUSTOM_TOOL_PREFIX)) return name;
  return name.slice(CLAUDE_CUSTOM_TOOL_PREFIX.length);
}

function reasoningSummaryText(item: JsonObject): string {
  const rows = Array.isArray(item.summary) ? item.summary : Array.isArray(item.content) ? item.content : [];
  return rows
    .map((row) => string(object(row)?.text) ?? '')
    .filter(Boolean)
    .join('');
}

function inferenceMessagePhase(value: unknown): InferenceMessagePhase | undefined {
  return value === 'commentary' || value === 'final_answer' ? value : undefined;
}

function responseMessageContent(item: JsonObject): { text: string; annotations: unknown[]; refusal?: string } {
  const rows = Array.isArray(item.content) ? item.content : [];
  let text = '';
  let refusal = '';
  const annotations: unknown[] = [];
  for (const row of rows) {
    const part = object(row);
    if (part?.type === 'output_text') {
      text += string(part.text) ?? '';
      if (Array.isArray(part.annotations)) annotations.push(...part.annotations);
    } else if (part?.type === 'refusal') {
      refusal += string(part.refusal) ?? '';
    }
  }
  return { text, annotations, ...(refusal ? { refusal } : {}) };
}

function mergeAnthropicUsage(current: Partial<InferenceUsage>, next: Partial<InferenceUsage>): Partial<InferenceUsage> {
  const merged = { ...current, ...next };
  if (merged.inputTokens !== undefined && merged.outputTokens !== undefined) {
    merged.totalTokens = merged.inputTokens + merged.outputTokens + (merged.reasoningTokens ?? 0);
  }
  return merged;
}

function reasoningBudget(effort: string): number {
  return (
    (
      { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, ultra: 32_000, max: 32_000 } as Record<
        string,
        number
      >
    )[effort] ?? 4096
  );
}

function googleThinking(effort: string): JsonObject {
  const level = effort === 'minimal' ? 'MINIMAL' : effort === 'low' ? 'LOW' : effort === 'medium' ? 'MEDIUM' : 'HIGH';
  return effort === 'none'
    ? { includeThoughts: false, thinkingBudget: 0 }
    : { includeThoughts: true, thinkingLevel: level };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
