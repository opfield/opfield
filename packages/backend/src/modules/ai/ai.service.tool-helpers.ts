import { redactWebhookHeaders, redactWebhookUrl } from '@/modules/notifications/notification-webhook.service.js';
import { isRecord, type ModelTool, type QueuedApproval, SEND_COMMENT_TOOL_NAME } from './ai.service.runtime-helpers.js';
import { redactToolArgs } from './ai.service-helpers.js';
import { AI_TOOLS, inferDiscoveredToolsetsFromText } from './ai.tools.js';
import type { AIToolDefinition, ChatMessage } from './ai.types.js';
import type { AIChatSearchScope } from './ai-conversation-search.service.js';
import { estimateTextTokens } from './ai-token-estimator.js';

export function clampIntegerValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function commentMessageFromArgs(args: Record<string, unknown>): string {
  const value = args.message;
  return typeof value === 'string' ? value.trim() : '';
}

export function commentToolFrom(tools: ModelTool[]): ModelTool[] {
  return tools.filter((tool) => tool.function.name === SEND_COMMENT_TOOL_NAME);
}

export function boolArg(value: unknown): boolean {
  return value === true;
}

export function getEffectiveGroupScopes(group: { scopes?: string[]; inheritedScopes?: string[] }): string[] {
  return [...new Set([...(group.scopes ?? []), ...(group.inheritedScopes ?? [])])];
}

export const AI_SETTINGS_UPDATE_FIELDS = new Set([
  'enabled',
  'providerType',
  'providerUrl',
  'endpointMode',
  'supportsImages',
  'apiKey',
  'model',
  'gatewayInferenceModel',
  'gatewayInferenceAllowUserModelSelection',
  'allowUserReasoningEffortSelection',
  'customSystemPrompt',
  'rateLimitMax',
  'rateLimitWindowSeconds',
  'maxToolRounds',
  'maxContextTokens',
  'maxCompletionTokens',
  'maxTokensField',
  'reasoningEffort',
  'disabledTools',
  'webSearchProvider',
  'webSearchBaseUrl',
  'webSearchApiKey',
  'sandboxEnabled',
  'sandboxDefaultTier',
]);

export function aiSettingsUpdatesFromArgs(args: Record<string, unknown>): Record<string, unknown> {
  const updatesSource = isRecord(args.updates) ? args.updates : args;
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updatesSource)) {
    if (AI_SETTINGS_UPDATE_FIELDS.has(key)) updates[key] = value;
  }
  return updates;
}

export function mergeToolsets(existing: string[], added: string[]): string[] {
  const source = added.length > 0 ? added : existing;
  return [...new Set(source.map((toolset) => toolset.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 3);
}

export function rankToolCategories(
  tools: AIToolDefinition[],
  query = ''
): Array<{
  name: string;
  toolCount: number;
  matchingTools: string[];
}> {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9:_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  if (tokens.length === 0) return [];
  const byCategory = new Map<string, { score: number; tools: Set<string>; total: number }>();
  for (const tool of tools) {
    const entry = byCategory.get(tool.category) ?? { score: 0, tools: new Set<string>(), total: 0 };
    entry.total += 1;
    const category = tool.category.toLowerCase();
    const name = tool.name.toLowerCase();
    const description = tool.description.toLowerCase();
    const scope = tool.requiredScope.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (category.includes(token)) score += 8;
      if (name.includes(token)) score += 6;
      if (description.includes(token)) score += 2;
      if (scope.includes(token)) score += 1;
    }
    if (score > 0) {
      entry.score += score;
      entry.tools.add(tool.name);
    }
    byCategory.set(tool.category, entry);
  }
  return [...byCategory.entries()]
    .filter(([, value]) => value.score > 0)
    .sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0]))
    .map(([name, value]) => ({
      name,
      toolCount: value.total,
      matchingTools: [...value.tools].sort().slice(0, 5),
    }));
}

export function latestCompactEpoch(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.compactMarker) return messages[index]?.compactEpoch ?? 0;
  }
  return 0;
}

export function discoveredToolsetsFromResult(value: unknown): string[] | undefined {
  return isRecord(value) && Array.isArray(value.discoveredToolsets)
    ? value.discoveredToolsets.filter((toolset): toolset is string => typeof toolset === 'string')
    : undefined;
}

export function inferDiscoveredToolsetsFromMessages(messages: ChatMessage[]): string[] {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  return typeof latestUserMessage?.content === 'string'
    ? inferDiscoveredToolsetsFromText(latestUserMessage.content)
    : [];
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '"[Undefined]"';
  } catch {
    return '"[Unserializable]"';
  }
}

export function estimateToolBreakdown(
  tools: Array<{ function: { name: string } }>
): Array<{ label: string; chars: number; tokens: number }> {
  const toolDefinitionsByName = new Map(AI_TOOLS.map((tool) => [tool.name, tool]));
  const byCategory = new Map<string, { chars: number; tokens: number }>();
  for (const tool of tools) {
    const category = toolDefinitionsByName.get(tool.function.name)?.category ?? 'Other';
    const serialized = safeStringify(tool);
    const current = byCategory.get(category) ?? { chars: 0, tokens: 0 };
    current.chars += serialized.length;
    current.tokens += estimateTextTokens(serialized);
    byCategory.set(category, current);
  }
  return [...byCategory.entries()]
    .map(([label, value]) => ({ label, ...value }))
    .sort((left, right) => right.tokens - left.tokens);
}

export function normalizeSearchScope(value: unknown): AIChatSearchScope | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  if (value.type === 'current_project' || value.type === 'no_project' || value.type === 'all_user_chats') {
    return { type: value.type };
  }
  if (value.type === 'project' && typeof value.projectId === 'string' && value.projectId.trim()) {
    return { type: 'project', projectId: value.projectId.trim() };
  }
  return undefined;
}

export function normalizeReadChatSliceMode(value: unknown): 'latest' | 'first' | 'around_message' | 'after' | 'before' {
  return value === 'first' || value === 'around_message' || value === 'after' || value === 'before' ? value : 'latest';
}

export const GITLAB_TOOL_ARG_SECRET_KEY_RE =
  /^(?:token|secret|password|value|privateKey|private_key|webhookSecret|webhook_secret)$/i;

/** Tools whose plain `value` argument carries a secret value (GitLab variables are covered below). */
const SECRET_VALUE_TOOLS = new Set([
  'manage_docker_container_config',
  'manage_docker_compose',
  'github_upsert_actions_secret',
]);
const WEBHOOK_TOOLS = new Set(['create_webhook', 'update_webhook']);

export function redactArgsForTool(toolName: string, args: Record<string, unknown>): unknown {
  const redacted = redactToolArgs(args);
  if (!isRecord(redacted)) return redacted;
  if (SECRET_VALUE_TOOLS.has(toolName) && redacted.value !== undefined) {
    return { ...redacted, value: '[REDACTED]' };
  }
  if (WEBHOOK_TOOLS.has(toolName)) {
    // Webhook URLs routinely embed bearer tokens (Slack, Discord, Telegram); keep the webhook audit form.
    return {
      ...redacted,
      ...(redacted.url !== undefined
        ? { url: typeof args.url === 'string' ? redactWebhookUrl(args.url) : '[REDACTED]' }
        : {}),
      ...(redacted.headers !== undefined
        ? { headers: isRecord(redacted.headers) ? redactWebhookHeaders(redacted.headers) : '[REDACTED]' }
        : {}),
    };
  }
  // The pasted-back OAuth redirect carries the authorization code.
  if (toolName === 'manage_inference_provider' && redacted.callback !== undefined) {
    return { ...redacted, callback: '[REDACTED]' };
  }
  // The cloud connection code is single use, but it enrols this Gateway until it is used or expires.
  if (toolName === 'manage_cloud' && redacted.code !== undefined) {
    return { ...redacted, code: '[REDACTED]' };
  }
  if (!toolName.startsWith('gitlab_')) return redacted;
  return redactGitLabToolArgs(redacted);
}

/** Argument keys holding the body a tool writes: a file (node, container, volume, repository) or Compose YAML. */
const WRITTEN_CONTENT_KEYS = new Set(['content', 'yaml']);
const AUDIT_ARGUMENTS_MAX_BYTES = 16 * 1024;
const AUDIT_ARGUMENT_TEXT_MAX = 256;
const AUDIT_ARGUMENT_KEYS_MAX = 50;

function summarizeWrittenContent(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => summarizeWrittenContent(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      WRITTEN_CONTENT_KEYS.has(key) && typeof nested === 'string'
        ? { redacted: true, bytes: Buffer.byteLength(nested) }
        : summarizeWrittenContent(nested, depth + 1),
    ])
  );
}

/**
 * Tool arguments as an audit row stores them. Beyond redactArgsForTool, a written file or Compose body is reduced to
 * its size: a `.env` or an inline `environment:` carries secrets that the REST audit of the same write never stores,
 * and every holder of admin:audit reads audit rows. The whole set is bounded, so a large call cannot bloat the log.
 * The approval prompt keeps the full body (approvalDisplayArgs): a person approving a write must see it.
 */
export function redactArgsForAudit(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const redacted = summarizeWrittenContent(redactArgsForTool(toolName, args));
  const summary = isRecord(redacted) ? redacted : {};
  const bytes = Buffer.byteLength(JSON.stringify(summary));
  if (bytes <= AUDIT_ARGUMENTS_MAX_BYTES) return summary;
  const scalars = Object.entries(summary)
    .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, AUDIT_ARGUMENT_KEYS_MAX)
    .map(([key, value]) => [
      key,
      typeof value === 'string' && value.length > AUDIT_ARGUMENT_TEXT_MAX
        ? `${value.slice(0, AUDIT_ARGUMENT_TEXT_MAX)}…`
        : value,
    ]);
  return { ...Object.fromEntries(scalars), argumentsTruncated: true, argumentsBytes: bytes };
}

export function approvalDisplayArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactArgsForTool(toolName, args);
  return isRecord(redacted) ? redacted : {};
}

export function queuedApprovalDisplayArgs(approvals: QueuedApproval[]): QueuedApproval[] {
  return approvals.map((approval) => ({
    ...approval,
    arguments: approvalDisplayArgs(approval.name, approval.arguments),
    rawArguments: approval.arguments,
  }));
}

export function redactGitLabToolArgs(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[REDACTED_DEPTH_LIMIT]';
  if (Array.isArray(value)) return value.map((item) => redactGitLabToolArgs(item, depth + 1));

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = GITLAB_TOOL_ARG_SECRET_KEY_RE.test(key) ? '[REDACTED]' : redactGitLabToolArgs(nested, depth + 1);
  }
  return redacted;
}
