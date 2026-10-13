import type { AIConversationRuntimeSnapshot } from './ai-run.service.js';

// ── AI Configuration (stored in settings table) ──

export type WebSearchProvider = 'tavily' | 'brave' | 'serper' | 'searxng' | 'exa';

export type MaxTokensField = 'max_tokens' | 'max_completion_tokens';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'none';
export type AIEndpointMode = 'auto' | 'chat_completions' | 'responses';
export type AIProviderType = 'openai_compatible' | 'opfield_inference';

export interface AIConfig {
  enabled: boolean;
  providerType: AIProviderType;
  providerUrl: string;
  endpointMode: AIEndpointMode;
  supportsImages: boolean;
  model: string;
  opfieldInferenceModel: string;
  opfieldInferenceAllowUserModelSelection: boolean;
  allowUserReasoningEffortSelection: boolean;
  maxCompletionTokens: number;
  maxTokensField: MaxTokensField;
  reasoningEffort: ReasoningEffort;
  customSystemPrompt: string;
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
  maxToolRounds: number;
  maxContextTokens: number;
  disabledTools: string[];
  webSearchEnabled: boolean;
  webSearchProvider: WebSearchProvider;
  webSearchBaseUrl: string;
  sandboxEnabled: boolean;
  sandboxDefaultTier: 'low' | 'medium' | 'high';
}

export interface EncryptedValue {
  encryptedKey: string;
  encryptedDek: string;
}

// ── Tool Definitions ──

export interface AIToolHistoryRetention {
  mode: 'persistent_context' | 'recent_full' | 'summary_only' | 'never_full';
  maxBytes?: number;
}

export type AIToolEffect = 'read' | 'write' | 'delete' | 'external';
export type AIToolApprovalClass = 'read' | 'create' | 'update' | 'delete' | 'execute' | 'destructive';

export interface AIToolTargetIdentity {
  resourceType?: string;
  /** Ordered argument names. The first non-empty value is the canonical audit/authorization target. */
  arguments: string[];
}

/** Refines one operation's approval class by a nested argument, e.g. a presigned GET vs PUT. */
export interface AIToolOperationArgumentPolicy {
  /** Argument path below the tool arguments, e.g. ['config', 'operation']. */
  path: string[];
  /**
   * Approval class per string or boolean argument value. An absent argument keeps the operation
   * class; any other value fails closed to `destructive`.
   */
  approvalClasses: Record<string, AIToolApprovalClass>;
}

export interface AIToolOperationPolicy {
  effect: AIToolEffect;
  approvalClass: AIToolApprovalClass;
  argumentPolicy?: AIToolOperationArgumentPolicy;
  requiredScopes?: string[];
  targetIdentity?: AIToolTargetIdentity;
}

export interface AIToolOperationDiscriminator {
  /** Ordered argument names joined with a dot to select an operation policy. */
  arguments: string[];
  operations: Record<string, AIToolOperationPolicy>;
}

export interface AIToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  destructive: boolean;
  category: string;
  requiredScope: string;
  invalidateStores: string[];
  historyRetention?: AIToolHistoryRetention;
  /** Advertise this tool only through authenticated remote MCP, never to the embedded model runtime. */
  mcpOnly?: boolean;
  /** Backend-only policy metadata. Provider adapters intentionally do not expose these fields. */
  effect?: AIToolEffect;
  approvalClass?: AIToolApprovalClass;
  requiredScopes?: string[];
  targetIdentity?: AIToolTargetIdentity;
  operationDiscriminator?: AIToolOperationDiscriminator;
  /** Explicit default-deny permission for model-visible tools while a plan is being drafted or validated. */
  planningAccess?: 'allowed' | 'blocked';
}

export type AIPlanStatus =
  | 'drafting'
  | 'validating'
  | 'awaiting_decision'
  | 'executing'
  | 'pause_requested'
  | 'paused'
  | 'verifying'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type AIPlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped';

export interface AIPlanRuntimeStep {
  id: string;
  ordinal: number;
  title: string;
  description: string;
  verification: string;
  status: AIPlanStepStatus;
  evidence: Array<{ summary: string; resourceReferenceIds?: string[] }>;
  skipReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AIPlanRuntimeSnapshot {
  id: string;
  conversationId: string;
  status: AIPlanStatus;
  title: string | null;
  model: string | null;
  reasoningEffort: string | null;
  revisionId: string | null;
  revision: number | null;
  revisionStatus: 'draft' | 'validating' | 'published' | 'accepted' | 'superseded' | 'rejected' | null;
  publishedAt: string | null;
  timelineAnchorAt: string | null;
  acceptedAt: string | null;
  goal: string | null;
  scope: string[];
  assumptions: string[];
  research: Array<{ title: string; summary: string; resourceReferenceIds?: string[] }>;
  intentReview: { verdict: 'pass' | 'revise'; summary: string; findings: string[] } | null;
  securityReview: { verdict: 'pass' | 'revise'; summary: string; findings: string[] } | null;
  verification: Array<{ title: string; description: string }>;
  changeSummary: { added: string[]; changed: string[]; removed: string[] } | null;
  steps: AIPlanRuntimeStep[];
  noProgressRuns: number;
  activeTimeMs: number;
  activeSince: string | null;
  pauseReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export const AI_RESOURCE_REFERENCE_TYPES = [
  'node',
  'proxy_host',
  'proxy_template',
  'ssl_certificate',
  'domain',
  'access_list',
  'ca',
  'pki_certificate',
  'pki_template',
  'docker_container',
  'docker_deployment',
  'docker_image',
  'docker_volume',
  'docker_network',
  'docker_registry',
  'database',
  'page_project',
  'logging_environment',
  'logging_schema',
  'status_page_service',
  'status_page_incident',
  'notification_rule',
  'notification_webhook',
] as const;

export type AIResourceReferenceType = (typeof AI_RESOURCE_REFERENCE_TYPES)[number];
export type AIResourceReferenceRelation = 'read' | 'created' | 'updated' | 'deleted' | 'verified';
export type AIResourceAppearanceColor = 'blue' | 'red' | 'green' | 'yellow' | 'purple' | 'pink' | 'orange';

/**
 * Server-issued identity for an internal Opfield resource mentioned by the model.
 * The frontend derives href/icon/color from this allowlisted data; the model never supplies an href.
 */
export interface AIResourceReference {
  refId: string;
  type: AIResourceReferenceType;
  resourceId: string;
  label: string;
  relation: AIResourceReferenceRelation;
  nodeId?: string;
  nodeSlug?: string;
  slug?: string;
  appearanceColor?: AIResourceAppearanceColor;
  /** Canonical Opfield route issued by the backend; absent only on legacy stored references. */
  uiHref?: string;
  workspaceEmbeddable?: boolean;
}

// ── Page Context (from frontend) ──

export interface PageContext {
  route: string;
  resourceType?: string;
  resourceId?: string;
  label?: string;
  nodeId?: string;
}

// ── Chat Messages (OpenAI-compatible) ──

export interface ChatMessage {
  /** Durable message id when reconstructed from conversation storage. */
  id?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  attachments?: AIMessageAttachment[];
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
  compactMarker?: boolean;
  compactVersion?: number;
  compactEpoch?: number;
  compactBoundaryMessageId?: string;
  compactTailMessageCount?: number;
  hiddenSystemEvent?: boolean;
  lifecycleEvent?: {
    type: 'planning_cancelled' | 'context_compacted';
    clientCommandId?: string;
    trigger?: 'manual' | 'auto';
  };
  steer?: boolean;
}

export interface AIMessageAttachment {
  artifactId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  downloadUrl: string;
  kind: 'image';
}

export interface AIContextLimits {
  contextWindow: number;
  maxInputTokens: number;
  autoCompactTokenLimit: number;
  outputReserveTokens: number;
}

export type AIConversationStatus = 'active' | 'ended' | 'context_blocked';

// ── WebSocket Protocol ──

export type WSClientMessage =
  | { type: 'conversation.subscribe'; conversationId: string; clientCommandId?: string }
  | { type: 'conversation.unsubscribe'; conversationId: string }
  | { type: 'conversation.sync'; conversationId: string; clientCommandId?: string }
  | {
      type: 'conversation.compact';
      conversationId: string;
      clientCommandId: string;
      context?: PageContext;
      model?: string;
      reasoningEffort?: string;
    }
  | {
      type: 'conversation.send_message';
      clientCommandId: string;
      conversationId?: string;
      content: string;
      attachments?: AIMessageAttachment[];
      context?: PageContext;
      model?: string;
      reasoningEffort?: string;
      workMode?: 'normal' | 'plan';
    }
  | {
      type: 'conversation.start_scenario';
      clientCommandId: string;
      scenarioId: string;
      context?: PageContext;
      model?: string;
      reasoningEffort?: string;
    }
  | {
      type: 'conversation.continue';
      conversationId: string;
      clientCommandId: string;
      context?: PageContext;
      model?: string;
      reasoningEffort?: string;
    }
  | {
      type: 'conversation.queue_message';
      conversationId: string;
      inputId: string;
      clientCommandId: string;
      content: string;
      attachments?: AIMessageAttachment[];
      context?: PageContext;
    }
  | {
      type: 'conversation.steer_message';
      conversationId: string;
      inputId: string;
      clientCommandId: string;
    }
  | {
      type: 'conversation.cancel_queued_message';
      conversationId: string;
      inputId: string;
      clientCommandId: string;
    }
  | { type: 'run.stop'; conversationId: string; runId: string; clientCommandId: string }
  | {
      type: 'plan.decide';
      conversationId: string;
      planId: string;
      revisionId: string;
      decision: 'implement' | 'refine' | 'custom';
      customInstruction?: string;
      clientCommandId: string;
    }
  | { type: 'plan.pause'; conversationId: string; planId: string; clientCommandId: string }
  | { type: 'plan.resume'; conversationId: string; planId: string; clientCommandId: string }
  | { type: 'plan.cancel'; conversationId: string; planId: string; clientCommandId: string }
  | { type: 'conversation.abandon_planning'; conversationId: string; clientCommandId: string }
  | {
      type: 'approval.decide';
      conversationId: string;
      runId: string;
      approvalId: string;
      decision: 'approved' | 'rejected';
      clientCommandId: string;
    }
  | {
      type: 'question.answer';
      conversationId: string;
      runId: string;
      questionId: string;
      answer: string;
      clientCommandId: string;
    }
  | {
      type: 'credential.resolve';
      conversationId: string;
      runId: string;
      challengeId: string;
      decision: 'authorized' | 'rejected';
      clientCommandId: string;
    }
  | {
      type: 'setup.resolve';
      conversationId: string;
      runId: string;
      interactionId: string;
      status: 'configured' | 'cancelled';
      result?: Record<string, unknown>;
      clientCommandId: string;
    }
  | { type: 'ping' };

export type WSServerMessage =
  | { type: 'auth_ok'; userId: string }
  | { type: 'auth_error'; message: string }
  | { type: 'text_delta'; requestId: string; content: string }
  | { type: 'assistant_comment_delta'; requestId: string; content: string }
  | { type: 'assistant_comment'; requestId: string; content: string }
  | {
      type: 'tool_round_start';
      requestId: string;
      roundId: string;
      calls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        position: number;
        gate: 'immediate' | 'question' | 'approval';
        classification: AIToolApprovalClass | 'system-never-ask';
        approvalPolicy: 'system_skipped' | 'auto_approved' | 'requires_approval' | 'blocked';
        requiredScopes: string[];
      }>;
      /** Provider continuation payload, persisted by the executor and never sent to clients. */
      providerMessages: Record<string, unknown>[];
    }
  | { type: 'tool_call_start'; requestId: string; id: string; name: string; arguments: Record<string, unknown> }
  | {
      type: 'tool_approval_required';
      requestId: string;
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      roundId?: string;
    }
  | {
      type: 'tool_result';
      requestId: string;
      id: string;
      name: string;
      result: unknown;
      error?: string;
      /** Internal terminal classification for a user-rejected call. */
      rejected?: boolean;
      /** Internal control payload. Persisted/published separately from model-visible tool output. */
      clientAction?: Record<string, unknown>;
      /** Trusted internal Opfield resource identities derived from this tool result. */
      resourceReferences?: AIResourceReference[];
    }
  | {
      type: 'credential_authorization_required';
      requestId: string;
      id: string;
      name: string;
      provider: 'gitlab' | 'github' | 'git' | 'cloudflare' | 'ssh';
      connectorId: string;
      arguments: Record<string, unknown>;
      roundId?: string;
    }
  | { type: 'invalidate_stores'; requestId: string; stores: string[] }
  | { type: 'conversation_ended'; requestId: string; reason: string }
  | { type: 'context_blocked'; requestId: string; reason: string }
  | { type: 'done'; requestId: string }
  | { type: 'error'; requestId: string; message: string; code?: string }
  | { type: 'rate_limited'; retryAfter: number }
  | {
      type: 'command.ack';
      commandType: WSClientMessage['type'];
      clientCommandId?: string;
      conversationId?: string;
      runId?: string;
      duplicate?: boolean;
    }
  | {
      type: 'command.error';
      commandType?: WSClientMessage['type'] | string;
      clientCommandId?: string;
      conversationId?: string;
      runId?: string;
      code: string;
      message: string;
      statusCode?: number;
      /** Structured details, sent only for license denials so the client can show the paywall. */
      details?: unknown;
    }
  | { type: 'conversation.snapshot'; conversationId: string; snapshot: AIConversationRuntimeSnapshot }
  | {
      type: 'plan.status_changed';
      conversationId: string;
      plan: AIPlanRuntimeSnapshot;
      revision?: number;
    }
  | { type: 'assistant.delta'; conversationId: string; runId: string; content: string; version: number }
  | { type: 'assistant.comment_delta'; conversationId: string; runId: string; content: string; version: number }
  | { type: 'assistant.comment_done'; conversationId: string; runId: string }
  | {
      type: 'credential.required';
      conversationId: string;
      runId: string;
      challenge: NonNullable<AIConversationRuntimeSnapshot['runtime']['pendingCredentialChallenge']>;
      revision?: number;
    }
  | { type: 'client.action'; conversationId: string; runId: string; action: Record<string, unknown> }
  | {
      type: 'run.status_changed';
      conversationId: string;
      run: AIConversationRuntimeSnapshot['runtime']['activeRun'];
      revision?: number;
    }
  | { type: 'stores.invalidated'; conversationId: string; stores: string[]; revision?: number }
  | {
      type: 'approval.updated';
      conversationId: string;
      runId: string;
      approval: AIConversationRuntimeSnapshot['runtime']['toolCalls'][number];
      duplicate: boolean;
      revision?: number;
    }
  | {
      type: 'question.answered';
      conversationId: string;
      runId: string;
      question: NonNullable<AIConversationRuntimeSnapshot['runtime']['pendingQuestion']>;
      duplicate: boolean;
      revision?: number;
    }
  | {
      type: 'credential.updated';
      conversationId: string;
      runId: string;
      challenge: AIConversationRuntimeSnapshot['runtime']['pendingCredentialChallenge'];
      duplicate: boolean;
      revision?: number;
    }
  | { type: 'pong' };

// ── AI Question (ask_question tool) ──

export interface AIQuestionOption {
  label: string;
  description?: string;
}

export interface AIQuestion {
  questionId: string;
  question: string;
  options?: AIQuestionOption[];
  allowFreeText: boolean;
}

// ── Tool Execution Result ──

export interface ToolExecutionResult {
  result?: unknown;
  error?: string;
  credentialChallenge?: {
    provider: 'gitlab' | 'github' | 'git' | 'cloudflare' | 'ssh';
    connectorId: string;
  };
  invalidateStores: string[];
}

export interface ToolExecutionOptions {
  source?: 'ai' | 'mcp';
  pageContext?: PageContext;
  conversationId?: string;
  scopes?: string[];
  tokenId?: string;
  tokenPrefix?: string;
  authType?: 'oauth' | 'api-token';
  clientId?: string;
}
