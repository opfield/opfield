import type { AIConversationFolder, AIConversationSummary } from "@/services/ai-conversations";
import type { AIWebSocketClient } from "@/services/ai-websocket";
import { api } from "@/services/api";
import type {
  AIConfig,
  AIConversationInput,
  AIConversationStatus,
  AICredentialChallenge,
  AIMessage,
  AIPlanRuntimeSnapshot,
  AIProviderStatus,
  AIResourceReference,
  AIScenario,
  AISetupInteraction,
  AIToolCall,
  ChatMessage,
  PageContext,
  WSServerMessage,
} from "@/types/ai";

export const DEFAULT_CONTEXT_TOKEN_LIMIT = 56000;
export const DEFAULT_REASONING_EFFORT: AIConfig["reasoningEffort"] = "none";
export const CONTEXT_ESTIMATE_CACHE_TTL_MS = 30_000;
export const AI_MODEL_STORAGE_KEY = "opfield:ai:selected-model";
export const AI_REASONING_STORAGE_PREFIX = "opfield:ai:reasoning-effort:";

export function loadStoredAIModel(): string | null {
  try {
    return window.localStorage.getItem(AI_MODEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeAIModel(model: string | null): void {
  try {
    if (model) window.localStorage.setItem(AI_MODEL_STORAGE_KEY, model);
    else window.localStorage.removeItem(AI_MODEL_STORAGE_KEY);
  } catch {
    // Local preferences are best-effort.
  }
}

export function loadStoredAIReasoningEffort(model: string | null): string | null {
  if (!model) return null;
  try {
    return window.localStorage.getItem(`${AI_REASONING_STORAGE_PREFIX}${model}`);
  } catch {
    return null;
  }
}

export function storeAIReasoningEffort(model: string, effort: string | null): void {
  try {
    if (effort) window.localStorage.setItem(`${AI_REASONING_STORAGE_PREFIX}${model}`, effort);
    else window.localStorage.removeItem(`${AI_REASONING_STORAGE_PREFIX}${model}`);
  } catch {
    // Local preferences are best-effort.
  }
}

export function resolveReasoningEffort(
  status: AIProviderStatus | null,
  model: string | null
): string | null {
  const option = status?.models.find((candidate) => candidate.id === model);
  const stored = loadStoredAIReasoningEffort(model);
  return option?.reasoningEfforts.includes(stored ?? "")
    ? stored
    : option?.defaultReasoningEffort || option?.reasoningEfforts[0] || null;
}

export function resolveDraftProviderSelection(
  status: AIProviderStatus | null
): Pick<AIState, "selectedModel" | "selectedReasoningEffort"> {
  if (status?.providerType === "openai_compatible") {
    const stored = loadStoredAIReasoningEffort(status.defaultModel);
    return {
      selectedModel: null,
      selectedReasoningEffort:
        status.allowUserReasoningEffortSelection &&
        (status.reasoningEfforts ?? []).includes(stored ?? "")
          ? stored
          : status.allowUserReasoningEffortSelection
            ? (status.defaultReasoningEffort ?? null)
            : null,
    };
  }
  if (status?.providerType !== "opfield_inference" || status.models.length === 0) {
    return { selectedModel: null, selectedReasoningEffort: null };
  }
  const storedModel = loadStoredAIModel();
  const selectedModel =
    status.allowUserModelSelection && status.models.some((model) => model.id === storedModel)
      ? storedModel
      : status.defaultModel || status.models[0]?.id || null;
  return {
    selectedModel,
    selectedReasoningEffort: resolveReasoningEffort(status, selectedModel),
  };
}

export function canSendSelectedReasoningEffort(status: AIProviderStatus | null): boolean {
  return (
    status?.providerType === "opfield_inference" ||
    (status?.providerType === "openai_compatible" &&
      status.allowUserReasoningEffortSelection === true)
  );
}

export interface AIContextOverheadEstimate {
  chatTokens: number;
  messageCount: number;
  systemTokens: number;
  toolsTokens: number;
  overheadTokens: number;
  limit: number;
  source: "server" | "settings" | "fallback";
  reasoningEffort: string;
  toolCount: number;
  systemBreakdown: Array<{
    label: string;
    chars: number;
    tokens: number;
  }>;
  toolBreakdown: Array<{
    label: string;
    chars: number;
    tokens: number;
  }>;
}

export const aiContextEstimateState: {
  cache: {
    key: string;
    expiresAt: number;
    estimate: AIContextOverheadEstimate;
  } | null;
} = { cache: null };
export const contextEstimateRequests = new Map<string, Promise<AIContextOverheadEstimate>>();

export async function resolveContextSettings(): Promise<{
  limit: number;
  source: "settings" | "fallback";
  reasoningEffort: string;
}> {
  const cached = api.getCached<AIConfig>("settings:ai-config");
  if (cached?.maxContextTokens) {
    return {
      limit: cached.maxContextTokens,
      source: "settings",
      reasoningEffort: cached.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    };
  }

  try {
    const config = (await api.getAIConfig()) as unknown as AIConfig;
    api.setCache("settings:ai-config", config);
    if (config.maxContextTokens) {
      return {
        limit: config.maxContextTokens,
        source: "settings",
        reasoningEffort: config.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      };
    }
  } catch {
    // Fall through to the legacy estimate when settings are unavailable.
  }

  return {
    limit: DEFAULT_CONTEXT_TOKEN_LIMIT,
    source: "fallback",
    reasoningEffort: DEFAULT_REASONING_EFFORT,
  };
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function generateUuid(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
      const value = (Math.random() * 16) | 0;
      return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
    })
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function compactToolResultForModel(toolName: string, value: unknown): unknown {
  if (value == null) return value;
  if (toolName === "send_artifact" && typeof value === "object" && value !== null) {
    const { artifactId, filename, mediaType, sizeBytes, sourcePath, downloadUrl } = value as Record<
      string,
      unknown
    >;
    return { artifactId, filename, mediaType, sizeBytes, sourcePath, downloadUrl };
  }
  return value;
}

export interface AIState {
  messages: AIMessage[];
  queuedInputs: AIConversationInput[];
  resourceReferences: AIResourceReference[];
  recentConversations: AIConversationSummary[];
  conversationFolders: AIConversationFolder[];
  isLoadingRecentConversations: boolean;
  isLoadingConversationFolders: boolean;
  isStreaming: boolean;
  isStartingConversation: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  connectionError: string | null;
  isEnabled: boolean | null;
  retryAfter: number | null;
  /** The user message a Retry is resending right now. */
  retryingMessageId: string | null;
  savedName: string | null;
  activeConversationId: string | null;
  sidebarActiveConversationId: string | null;
  activeRunId: string | null;
  activePlan: AIPlanRuntimeSnapshot | null;
  plans: AIPlanRuntimeSnapshot[];
  dismissedPlanDecisionKey: string | null;
  devPlanProgressPreview: AIPlanRuntimeSnapshot | null;
  workMode: "normal" | "plan";
  canContinueConversation: boolean;
  isCompactingContext: boolean;
  lastContext: PageContext | null;
  pendingApprovalToolCallId: string | null;
  pendingCredentialChallenge: AICredentialChallenge | null;
  pendingSetupInteraction: AISetupInteraction | null;
  providerStatus: AIProviderStatus | null;
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  contextUsageDialog: AIContextUsage | null;

  // Actions
  connect: () => Promise<boolean>;
  disconnect: () => void;
  sendMessage: (
    content: string,
    context?: PageContext,
    attachments?: AIMessage["attachments"],
    options?: SendMessageOptions
  ) => void;
  startScenario: (scenario: AIScenario, context?: PageContext) => void;
  queueMessage: (
    content: string,
    context?: PageContext,
    attachments?: AIMessage["attachments"]
  ) => void;
  steerQueuedMessage: (inputId: string) => void;
  cancelQueuedMessage: (inputId: string) => void;
  continueConversation: (context?: PageContext) => void;
  approveTool: (toolCallId: string) => void;
  rejectTool: (toolCallId: string) => void;
  answerQuestion: (toolCallId: string, answer: string) => void;
  resolveCredentialChallenge: (decision: "authorized" | "rejected") => void;
  resolveSetupInteraction: (
    status: "configured" | "cancelled",
    result?: Record<string, unknown>
  ) => void;
  stopStreaming: () => void;
  setWorkMode: (mode: "normal" | "plan") => void;
  abandonPlanning: () => void;
  decidePlan: (decision: "implement" | "refine" | "custom", customInstruction?: string) => void;
  pausePlan: () => void;
  resumePlan: () => void;
  cancelPlan: () => void;
  clearMessages: () => void;
  fetchRecentConversations: () => Promise<void>;
  fetchConversationFolders: () => Promise<void>;
  createConversationFolder: (input: {
    name: string;
    description?: string;
  }) => Promise<AIConversationFolder | null>;
  updateConversationFolder: (
    id: string,
    input: { name?: string; description?: string }
  ) => Promise<AIConversationFolder | null>;
  deleteConversationFolder: (id: string) => Promise<void>;
  reorderConversationFolders: (folderIds: string[]) => Promise<void>;
  moveConversationsToFolder: (conversationIds: string[], folderId: string | null) => Promise<void>;
  loadConversation: (conversationId: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  rollbackToMessage: (messageId: string) => Promise<AIMessage | null>;
  retryMessage: (messageId: string) => Promise<void>;
  setEnabled: (enabled: boolean) => void;
  setProviderStatus: (status: AIProviderStatus) => void;
  refreshProviderStatus: () => Promise<void>;
  setSelectedModel: (model: string) => Promise<void>;
  setSelectedReasoningEffort: (effort: string) => Promise<void>;
  handleSlashCommand: (input: string) => Promise<boolean>;
  closeContextUsageDialog: () => void;
  setMessages: (messages: AIMessage[]) => void;
}

export const aiWebSocketState = { client: null as AIWebSocketClient | null };
export const aiConversationLoadState = { generation: 0 };
export const pendingToolCommands = new Map<
  string,
  {
    toolCallId: string;
    previousStatus: AIToolCall["status"];
    previousResult?: unknown;
    decision: "approval" | "question";
    approvalDecision?: "approved" | "rejected";
  }
>();
export const answeredQuestionTombstones = new Map<
  string,
  { conversationId: string; runId: string; expiresAt: number }
>();
export const ANSWERED_QUESTION_TOMBSTONE_TTL_MS = 30_000;
export const pendingInputCommands = new Map<
  string,
  {
    kind: "queue" | "steer" | "cancel";
    input: AIConversationInput;
  }
>();
export const observedPlanStatuses = new Map<string, AIPlanRuntimeSnapshot["status"]>();
export const cancelledPlanTombstones = new Map<
  string,
  { planId: string; clientCommandId: string }
>();
export const pendingPlanCancellationCommands = new Map<
  string,
  { conversationId: string; plan: AIPlanRuntimeSnapshot }
>();
export const pendingSetupCommands = new Map<string, AISetupInteraction>();

declare global {
  interface Window {
    opfieldDev?: {
      showApprovalBlock?: () => void;
      hideApprovalBlock?: () => void;
      showChangedResources?: () => void;
      hideChangedResources?: () => void;
      showPlanProgress?: () => void;
      hidePlanProgress?: () => void;
      [key: string]: unknown;
    };
  }
}

export function updateToolCallById(
  messages: AIMessage[],
  toolCallId: string,
  update: (toolCall: AIToolCall) => AIToolCall
): AIMessage[] {
  return messages.map((msg) => ({
    ...msg,
    toolCalls: msg.toolCalls?.map((tc) => (tc.id === toolCallId ? update(tc) : tc)),
  }));
}

export function appendLocalAssistantError(messages: AIMessage[], content: string): AIMessage[] {
  if (!content.trim()) return messages;
  return [
    ...messages,
    {
      id: generateId(),
      role: "assistant",
      content,
      createdAt: nowIso(),
      localOnly: true,
    },
  ];
}

export function appendPendingSteerMessage(
  messages: AIMessage[],
  input: AIConversationInput
): AIMessage[] {
  const id = `steer:${input.id}`;
  if (messages.some((message) => message.id === id)) return messages;
  return [
    ...messages,
    {
      id,
      role: "user",
      content: input.content,
      attachments: input.attachments,
      createdAt: input.createdAt,
      localOnly: true,
      steer: true,
      steerPending: true,
    },
  ];
}

export function appendPendingSteerMessages(
  messages: AIMessage[],
  inputs: AIConversationInput[]
): AIMessage[] {
  return inputs
    .filter((input) => input.mode === "steer" && input.status === "pending")
    .reduce(appendPendingSteerMessage, messages);
}

export function startingAssistantMessageId(clientCommandId: string): string {
  return `starting:${clientCommandId}:assistant`;
}

export function removeStartingAssistantMessage(
  messages: AIMessage[],
  clientCommandId?: string
): AIMessage[] {
  const exactId = clientCommandId ? startingAssistantMessageId(clientCommandId) : null;
  return messages.filter(
    (message) =>
      message.id !== exactId &&
      !(exactId === null && message.id.startsWith("starting:") && message.id.endsWith(":assistant"))
  );
}

export function sendWSMessage(msg: Parameters<AIWebSocketClient["send"]>[0]): void {
  if (!aiWebSocketState.client) throw new Error("AI connection is not open");
  aiWebSocketState.client.send(msg);
}

export function trySendWSMessage(msg: Parameters<AIWebSocketClient["send"]>[0]): boolean {
  try {
    sendWSMessage(msg);
    return true;
  } catch {
    return false;
  }
}
export const assistantDraftVersions = new Map<string, number>();
export const completedAssistantCommentVersions = new Map<string, number>();
export const terminalAssistantRuns = new Set<string>();
export const appliedConversationRevisions = new Map<string, number>();
export const assistantDeltaBuffers = new Map<
  string,
  {
    kind: "assistant" | "comment";
    content: string;
    version: number;
    message: Extract<WSServerMessage, { type: "assistant.delta" | "assistant.comment_delta" }>;
    timer: ReturnType<typeof setTimeout>;
  }
>();
export const ASSISTANT_DELTA_BATCH_MS = 50;
export const ASSISTANT_DELTA_BATCH_WORDS = 3;

export function acceptConversationRevision(
  conversationId: string,
  revision: number | undefined
): boolean {
  if (typeof revision !== "number") return true;
  const appliedRevision = appliedConversationRevisions.get(conversationId);
  if (appliedRevision !== undefined && revision < appliedRevision) return false;
  appliedConversationRevisions.set(conversationId, revision);
  return true;
}

export function upsertTimelinePlan(
  plans: AIPlanRuntimeSnapshot[],
  plan: AIPlanRuntimeSnapshot
): AIPlanRuntimeSnapshot[] {
  if (!plan.revisionId || !plan.publishedAt) return plans;
  return [...plans.filter((candidate) => candidate.revisionId !== plan.revisionId), plan].sort(
    (left, right) =>
      new Date(left.timelineAnchorAt ?? left.publishedAt ?? left.createdAt).getTime() -
      new Date(right.timelineAnchorAt ?? right.publishedAt ?? right.createdAt).getTime()
  );
}

export interface AIConversationBlock {
  status: Exclude<AIConversationStatus, "active">;
  reason: string;
}

export function getConversationBlock(messages: AIMessage[]): AIConversationBlock | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.compactMarker) return null;
    if (message.conversationStatus) {
      return {
        status: message.conversationStatus,
        reason: message.blockReason || "This conversation cannot continue.",
      };
    }
  }
  return null;
}

export function activeModelMessages(messages: AIMessage[]): AIMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].compactMarker) {
      if (messages[i].compactVersion === 2 && messages[i].compactBoundaryMessageId) {
        const boundaryIndex = messages.findIndex(
          (message) => message.id === messages[i].compactBoundaryMessageId
        );
        if (boundaryIndex >= 0 && boundaryIndex < i) {
          return [messages[i], ...messages.slice(boundaryIndex + 1, i), ...messages.slice(i + 1)];
        }
      }
      const tailCount = Math.max(0, Math.trunc(messages[i].compactTailMessageCount ?? 0));
      const tailStart = Math.max(0, i - tailCount);
      return [messages[i], ...messages.slice(tailStart, i), ...messages.slice(i + 1)];
    }
  }
  return messages;
}

export function buildChatMessages(messages: AIMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const msg of activeModelMessages(messages)) {
    if (msg.localOnly || msg.conversationStatus) continue;
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content, attachments: msg.attachments });
    } else if (msg.role === "assistant") {
      const chatMsg: ChatMessage = { role: "assistant", content: msg.content || null };

      // Build tool_calls from rawToolCalls or reconstruct from toolCalls
      if (msg.rawToolCalls?.length) {
        chatMsg.tool_calls = msg.rawToolCalls as ChatMessage["tool_calls"];
      } else if (msg.toolCalls?.length) {
        chatMsg.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }

      result.push(chatMsg);

      // Add tool results after the assistant message
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.status === "completed" || tc.status === "failed" || tc.status === "rejected") {
            const content = tc.error
              ? JSON.stringify({ error: tc.error })
              : tc.result !== undefined
                ? JSON.stringify(compactToolResultForModel(tc.name, tc.result))
                : "{}";
            result.push({
              role: "tool",
              tool_call_id: tc.id,
              content,
              name: tc.name,
            });
          }
        }
      }
    }
  }
  return result;
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateChatMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === "string") total += estimateTextTokens(message.content);
    if (message.attachments?.length) {
      for (const attachment of message.attachments) {
        total += Math.ceil(attachment.sizeBytes / 3);
      }
    }
    if (message.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        total += estimateTextTokens(toolCall.function.arguments || "");
        total += 20;
      }
    }
    total += 4;
  }
  return total;
}

export function contextEstimateCacheKey(
  messages: ChatMessage[],
  context?: PageContext,
  conversationId?: string | null,
  model?: string | null,
  reasoningEffort?: string | null
): string {
  return JSON.stringify({
    messages: chatMessagesFingerprint(messages),
    conversationId: conversationId ?? null,
    model: model ?? null,
    reasoningEffort: reasoningEffort ?? null,
    route: context?.route ?? null,
    resourceType: context?.resourceType ?? null,
    resourceId: context?.resourceId ?? null,
  });
}

export function chatMessagesFingerprint(messages: ChatMessage[]): string {
  let hash = 2166136261;
  const value = JSON.stringify(messages);
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${messages.length}:${hash >>> 0}`;
}

export async function resolveContextOverhead(
  messages: ChatMessage[],
  context?: PageContext,
  conversationId?: string | null,
  model?: string | null,
  reasoningEffort?: string | null
): Promise<AIContextOverheadEstimate> {
  const key = contextEstimateCacheKey(messages, context, conversationId, model, reasoningEffort);
  const now = Date.now();
  if (aiContextEstimateState.cache?.key === key && aiContextEstimateState.cache.expiresAt > now) {
    return aiContextEstimateState.cache.estimate;
  }

  const existingRequest = contextEstimateRequests.get(key);
  if (existingRequest) return existingRequest;

  const request = (async () => {
    try {
      const estimate = await api.getAIContextEstimate({
        messages,
        context,
        conversationId,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
      const result: AIContextOverheadEstimate = {
        chatTokens: estimate.chatTokens,
        messageCount: estimate.messageCount,
        systemTokens: estimate.systemTokens,
        toolsTokens: estimate.toolsTokens,
        overheadTokens: estimate.totalOverhead,
        limit: estimate.limit,
        source: "server",
        reasoningEffort: estimate.reasoningEffort,
        toolCount: estimate.toolCount,
        systemBreakdown: estimate.systemBreakdown ?? [],
        toolBreakdown: estimate.toolBreakdown ?? [],
      };
      aiContextEstimateState.cache = {
        key,
        expiresAt: Date.now() + CONTEXT_ESTIMATE_CACHE_TTL_MS,
        estimate: result,
      };
      return result;
    } catch {
      const { limit, source, reasoningEffort } = await resolveContextSettings();
      const result: AIContextOverheadEstimate = {
        chatTokens: estimateChatMessagesTokens(messages),
        messageCount: messages.length,
        systemTokens: 0,
        toolsTokens: 0,
        overheadTokens: 0,
        limit,
        source,
        reasoningEffort,
        toolCount: 0,
        systemBreakdown: [],
        toolBreakdown: [],
      };
      aiContextEstimateState.cache = {
        key,
        expiresAt: Date.now() + CONTEXT_ESTIMATE_CACHE_TTL_MS,
        estimate: result,
      };
      return result;
    } finally {
      contextEstimateRequests.delete(key);
    }
  })();
  contextEstimateRequests.set(key, request);
  return request;
}

export interface AIContextUsage {
  messageCount: number;
  estimatedTokens: number;
  limit: number;
  percent: number;
  chatTokens: number;
  systemTokens: number;
  toolsTokens: number;
  overheadTokens: number;
  toolCount: number;
  systemBreakdown: Array<{
    label: string;
    chars: number;
    tokens: number;
  }>;
  toolBreakdown: Array<{
    label: string;
    chars: number;
    tokens: number;
  }>;
  source: "server" | "settings" | "fallback";
  reasoningEffort: string;
}

export interface SendMessageOptions {
  startNewConversation?: boolean;
}

export async function getAIContextUsage(
  messages: AIMessage[],
  context?: PageContext,
  conversationId?: string | null,
  model?: string | null,
  reasoningEffort?: string | null
): Promise<AIContextUsage> {
  const chatMessages = buildChatMessages(messages);
  const overhead = await resolveContextOverhead(
    chatMessages,
    context,
    conversationId,
    model,
    reasoningEffort
  );
  const overheadTokens = overhead.overheadTokens;
  const chatTokens = overhead.chatTokens;
  const estimatedTokens = chatTokens + overheadTokens;

  return {
    messageCount: overhead.messageCount,
    estimatedTokens,
    limit: overhead.limit,
    percent: Math.round((estimatedTokens / overhead.limit) * 100),
    chatTokens,
    systemTokens: overhead.systemTokens,
    toolsTokens: overhead.toolsTokens,
    overheadTokens,
    toolCount: overhead.toolCount,
    systemBreakdown: overhead.systemBreakdown,
    toolBreakdown: overhead.toolBreakdown,
    source: overhead.source,
    reasoningEffort: overhead.reasoningEffort,
  };
}
