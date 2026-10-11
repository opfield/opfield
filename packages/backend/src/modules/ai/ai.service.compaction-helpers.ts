import { type AIContextCompactionTrigger, RUN_LANGUAGE_LOCK_MESSAGE } from './ai.service.runtime-helpers.js';
import { safeStringify } from './ai.service.tool-helpers.js';
import { redactToolArgs } from './ai.service-helpers.js';
import type { ChatMessage } from './ai.types.js';
import { redactOneTimeSecretToolResult } from './ai-secret-result-redaction.js';
import { estimateProviderMessagesTokens } from './ai-token-estimator.js';

export interface CompactionMessageUnit {
  start: number;
  end: number;
}

export function compactionMessageUnits(messages: ChatMessage[]): CompactionMessageUnit[] {
  const units: CompactionMessageUnit[] = [];
  let index = 0;
  while (index < messages.length) {
    const start = index;
    if (messages[index]?.role === 'user') {
      index += 1;
      while (index < messages.length && messages[index]?.role !== 'user') index += 1;
      units.push({ start, end: index });
      continue;
    }
    if (messages[index]?.role === 'assistant' && messages[index]?.tool_calls?.length) {
      const callIds = new Set(messages[index].tool_calls?.map((call) => call.id));
      index += 1;
      while (index < messages.length && messages[index]?.role === 'tool') {
        const callId = messages[index]?.tool_call_id;
        if (callId && !callIds.has(callId)) break;
        index += 1;
      }
      units.push({ start, end: index });
      continue;
    }
    index += 1;
    units.push({ start, end: index });
  }
  return units;
}

export function selectCompactionBoundary(
  messages: ChatMessage[],
  providerMessages: Record<string, unknown>[],
  recentBudget: number
): { source: ChatMessage[]; recent: ChatMessage[]; sourceTokens: number; recentTokens: number } {
  const units = compactionMessageUnits(messages);
  if (units.length <= 1) {
    return {
      source: [],
      recent: messages,
      sourceTokens: 0,
      recentTokens: estimateProviderMessagesTokens(providerMessages),
    };
  }

  let recentStart = units[units.length - 1].start;
  let recentTokens = estimateProviderMessagesTokens(providerMessages.slice(recentStart));
  for (let unitIndex = units.length - 2; unitIndex >= 0; unitIndex -= 1) {
    const candidateStart = units[unitIndex].start;
    const candidateTokens = estimateProviderMessagesTokens(providerMessages.slice(candidateStart));
    if (candidateTokens > recentBudget) break;
    recentStart = candidateStart;
    recentTokens = candidateTokens;
  }

  return {
    source: messages.slice(0, recentStart),
    recent: messages.slice(recentStart),
    sourceTokens: estimateProviderMessagesTokens(providerMessages.slice(0, recentStart)),
    recentTokens,
  };
}

export function providerMessagesToClientMessages(messages: Record<string, unknown>[]): ChatMessage[] {
  return messages.map(providerMessageToClientMessage).filter((message): message is ChatMessage => message !== null);
}

export function orderLatestToolRoundResults(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant' && Array.isArray(messages[index]?.tool_calls)) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return messages;
  const toolCalls = messages[assistantIndex].tool_calls as Array<{ id?: unknown }>;
  const order = toolCalls
    .map((call) => (typeof call.id === 'string' ? call.id : null))
    .filter((id): id is string => id !== null);
  if (order.length === 0) return messages;
  const suffix = messages.slice(assistantIndex + 1);
  const results = new Map(
    suffix
      .filter((message) => message.role === 'tool' && typeof message.tool_call_id === 'string')
      .map((message) => [message.tool_call_id as string, message])
  );
  if (order.some((id) => !results.has(id))) return messages;
  const nonResults = suffix.filter((message) => message.role !== 'tool' || typeof message.tool_call_id !== 'string');
  return [...messages.slice(0, assistantIndex + 1), ...order.map((id) => results.get(id)!), ...nonResults];
}

export function providerMessageToClientMessage(message: Record<string, unknown>): ChatMessage | null {
  const role = message.role;
  if (role === 'system') {
    return message.content === RUN_LANGUAGE_LOCK_MESSAGE
      ? { role: 'system', content: RUN_LANGUAGE_LOCK_MESSAGE, hiddenSystemEvent: true }
      : null;
  }
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return null;
  const content = message.content;
  return {
    role,
    content: typeof content === 'string' ? content : content == null ? null : safeStringify(content),
    tool_calls: Array.isArray(message.tool_calls) ? (message.tool_calls as ChatMessage['tool_calls']) : undefined,
    tool_call_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined,
    name: typeof message.name === 'string' ? message.name : undefined,
  };
}

export function serializeMessagesForCompaction(messages: ChatMessage[]): string {
  return messages
    .map((message, index) => {
      const heading = `#${index + 1} ${message.role}`;
      let content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      if (message.role === 'tool' && message.name) {
        try {
          const parsed = JSON.parse(content) as unknown;
          content = safeStringify(redactToolArgs(redactOneTimeSecretToolResult(message.name, parsed)));
        } catch {
          // Non-JSON legacy tool output has no structured keys to redact.
        }
      }
      const attachments = message.attachments?.length
        ? `\nAttachments: ${message.attachments.map((attachment) => attachment.filename).join(', ')}`
        : '';
      const toolCalls = message.tool_calls?.length
        ? `\nTool calls: ${message.tool_calls
            .map((toolCall) => {
              let args: unknown = {};
              try {
                args = JSON.parse(toolCall.function.arguments || '{}');
              } catch {
                args = {};
              }
              return `${toolCall.function.name}(${safeStringify(redactToolArgs(args))})`;
            })
            .join('\n')}`
        : '';
      return `${heading}\n${content}${attachments}${toolCalls}`;
    })
    .join('\n\n---\n\n');
}

export function buildCompactionSystemPrompt(trigger: AIContextCompactionTrigger): string {
  return [
    'You compact Opfield AI chat history for future assistant turns.',
    'Write the summary in the same language as the conversation, especially the latest user messages.',
    'Preserve user goals, explicit constraints, decisions, accepted designs, current task state, open questions, important IDs, paths, commands, resources, and tool outcomes.',
    'Do not invent facts. Do not include raw one-time secrets, API tokens, passwords, private keys, or credential values; say that secret material was omitted when relevant.',
    trigger === 'auto'
      ? 'This compaction was triggered automatically because the active context was near the model limit.'
      : 'This compaction was triggered manually by the user.',
    'Return only the compacted summary, without prefacing it with meta commentary.',
  ].join('\n');
}

export function buildCompactionUserPrompt(input: { sourceText: string; sourceMessageCount: number }): string {
  return [
    'Summarize all older chat context below. Newer complete turns and tool rounds are retained verbatim outside this request.',
    `Older message count: ${input.sourceMessageCount}.`,
    '',
    input.sourceText,
  ]
    .filter(Boolean)
    .join('\n');
}
