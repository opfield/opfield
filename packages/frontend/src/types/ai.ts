// ── AI Tool Call ──

export interface AIToolCall {
  id: string;
  runId?: string;
  roundId?: string | null;
  position?: number;
  name: string;
  arguments: Record<string, unknown>;
  status: "running" | "completed" | "failed" | "awaiting_approval" | "rejected";
  approvalPolicy?: string;
  assistantMessageId?: string | null;
  result?: unknown;
  error?: string;
  /** Client-only state while an approval decision is awaiting websocket acknowledgement. */
  approvalDecisionPending?: boolean;
}

export type AIConversationStatus = "active" | "ended" | "context_blocked";

// ── AI Message ──

export type AIResourceReferenceType =
  | "node"
  | "proxy_host"
  | "proxy_template"
  | "ssl_certificate"
  | "domain"
  | "access_list"
  | "ca"
  | "pki_certificate"
  | "pki_template"
  | "docker_container"
  | "docker_deployment"
  | "docker_compose_project"
  | "docker_build"
  | "docker_image"
  | "docker_volume"
  | "docker_network"
  | "docker_registry"
  | "database"
  | "page_project"
  | "logging_environment"
  | "logging_schema"
  | "status_page_service"
  | "status_page_incident"
  | "notification_rule"
  | "notification_webhook";

export interface AIResourceReference {
  refId: string;
  type: AIResourceReferenceType;
  resourceId: string;
  label: string;
  relation: "read" | "created" | "updated" | "deleted" | "verified";
  nodeId?: string;
  nodeSlug?: string;
  slug?: string;
  appearanceColor?: "blue" | "red" | "green" | "yellow" | "purple" | "pink" | "orange";
  uiHref?: string;
  workspaceEmbeddable?: boolean;
}

export interface AIMessage {
  id: string;
  /** The stored message id when `id` is a client-side key kept for rendering (an optimistic send). */
  serverId?: string;
  role: "user" | "assistant";
  content: string;
  sequence?: number;
  attachments?: AIMessageAttachment[];
  createdAt?: string;
  toolCalls?: AIToolCall[];
  isStreaming?: boolean;
  localOnly?: boolean;
  runError?: boolean;
  runId?: string;
  clientCommandId?: string;
  streamingChunk?: string;
  steer?: boolean;
  steerPending?: boolean;
  resourceReferences?: AIResourceReference[];
  changedResourceReferences?: AIResourceReference[];
  compactMarker?: boolean;
  compactVersion?: number;
  compactEpoch?: number;
  compactBoundaryMessageId?: string;
  compactedMessageCount?: number;
  sourceTokenEstimate?: number;
  resultTokenEstimate?: number;
  compactTrigger?: "automatic" | "manual";
  compactTailMessageCount?: number;
  conversationStatus?: Exclude<AIConversationStatus, "active">;
  blockReason?: string;
  modelChange?: {
    fromModel: string;
    toModel: string;
    fromDisplayName?: string;
    toDisplayName?: string;
  };
  scenario?: AIScenario;
  rawToolCalls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

export type AIScenarioCategory =
  | "deploy_release"
  | "migrate_recover"
  | "infrastructure_access"
  | "data_storage"
  | "security_pki"
  | "observe_operate";

export interface AIScenario {
  id: string;
  category: AIScenarioCategory;
  title: string;
  description: string;
  icon: "rocket" | "refresh" | "server" | "database" | "shield" | "activity";
}

// ── AI Configuration ──

export type WebSearchProvider = "tavily" | "brave" | "serper" | "searxng" | "exa";
export type AIEndpointMode = "auto" | "chat_completions" | "responses";
export type AIProviderType = "openai_compatible" | "opfield_inference";

export interface AIInferenceModelOption {
  id: string;
  displayName: string;
  supportsImages: boolean;
  maxContextTokens: number;
  maxOutputTokens: number | null;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}

export interface AIProviderStatus {
  enabled: boolean;
  providerType: AIProviderType;
  defaultModel: string;
  allowUserModelSelection: boolean;
  allowUserReasoningEffortSelection?: boolean;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string | null;
  supportsImages: boolean;
  models: AIInferenceModelOption[];
}

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
  opfieldInferenceModels: AIInferenceModelOption[];
  maxCompletionTokens: number;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  reasoningEffort: "low" | "medium" | "high" | "none";
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
  sandboxDefaultTier: "low" | "medium" | "high";
  hasApiKey: boolean;
  apiKeyLast4: string;
  hasWebSearchKey: boolean;
  webSearchApiKeyLast4: string;
}

export interface AIAgentSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  source: "system" | "user";
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AIUserSkillInput {
  name: string;
  description: string;
  instructions: string;
  enabled?: boolean;
}

export interface AIContextEstimate {
  chatTokens: number;
  messageCount: number;
  systemTokens: number;
  toolsTokens: number;
  totalOverhead: number;
  limit: number;
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

export interface AISandboxStatus {
  state: "stopped" | "starting" | "running" | "unavailable";
  socketPath?: string;
  pid?: number;
  lastError?: string;
}

export interface AISandboxJob {
  id: string;
  userId: string;
  conversationId: string | null;
  kind: "script" | "process";
  runtime: "alpine" | "node" | "python";
  resourceTier: "low" | "medium" | "high";
  requestedTtlSeconds: number;
  effectiveTtlSeconds: number;
  requiredScopes: string[];
  status: "queued" | "running" | "exited" | "killed" | "timeout" | "failed" | "revoked" | "expired";
  containerId: string | null;
  exitCode: number | null;
  outputBytes: number;
  workspaceReservationBytes: number;
  workspaceUsageBytes: number;
  workspaceReservationReleasedAt: string | null;
  revocationReason: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
}

export interface AISandboxOutput {
  processId: string;
  output: string;
  outputBytes: number;
}

export interface AISandboxArtifact {
  id: string;
  userId: string;
  conversationId: string | null;
  conversationTitle: string | null;
  sourceProcessId: string;
  sourcePath: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
  downloadUrl: string;
}

export interface AISandboxArtifactPage {
  data: AISandboxArtifact[];
  nextPage: number | null;
}

// ── Page Context ──

export interface PageContext {
  route: string;
  resourceType?: string;
  resourceId?: string;
  label?: string;
  nodeId?: string;
}

// ── Quick Action ──

export interface QuickAction {
  label: string;
  prompt: string;
}

// ── Chat Message (for API) ──

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  attachments?: AIMessageAttachment[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface AIMessageAttachment {
  artifactId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  downloadUrl: string;
  kind: "image";
}

export interface AIComposerLocalImageAttachment {
  localId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  dataUrl: string;
  previewUrl: string;
  kind: "image";
}

export type AIComposerAttachment = AIMessageAttachment | AIComposerLocalImageAttachment;

export interface AIConversationInput {
  id: string;
  conversationId: string;
  targetRunId: string | null;
  userId: string;
  clientCommandId: string;
  mode: "queued" | "steer";
  status: "pending" | "consumed" | "cancelled";
  content: string;
  attachments: AIMessageAttachment[];
  context: PageContext | null;
  consumedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Backend-owned AI Runtime ──

export type AIRunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_answer"
  | "waiting_for_credential"
  | "waiting_for_setup"
  | "completed"
  | "failed"
  | "stopped";

export interface AIRun {
  id: string;
  conversationId: string;
  userId: string;
  planId?: string | null;
  planRevisionId?: string | null;
  purpose?: "direct" | "plan_draft" | "plan_validation" | "plan_execution" | "plan_verification";
  status: AIRunStatus;
  activeMessageId: string | null;
  clientCommandId: string;
  assistantDraftContent: string | null;
  executionEpoch?: number;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AIPlanStatus =
  | "drafting"
  | "validating"
  | "awaiting_decision"
  | "executing"
  | "pause_requested"
  | "paused"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed";

export type AIPlanStepStatus = "pending" | "in_progress" | "completed" | "blocked" | "skipped";

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
  revisionStatus:
    | "draft"
    | "validating"
    | "published"
    | "accepted"
    | "superseded"
    | "rejected"
    | null;
  publishedAt: string | null;
  timelineAnchorAt: string | null;
  acceptedAt: string | null;
  goal: string | null;
  scope: string[];
  assumptions: string[];
  research: Array<{ title: string; summary: string; resourceReferenceIds?: string[] }>;
  intentReview: { verdict: "pass" | "revise"; summary: string; findings: string[] } | null;
  securityReview: { verdict: "pass" | "revise"; summary: string; findings: string[] } | null;
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

export type AIRunToolCallStatus =
  | "created"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "running"
  | "completed"
  | "failed"
  | "effect_unknown"
  | "stopped";

export type AIToolRoundStatus =
  | "collecting"
  | "waiting_questions"
  | "waiting_approvals"
  | "ready"
  | "executing"
  | "completed"
  | "failed"
  | "stopped";

export interface AIRunToolRound {
  id: string;
  runId: string;
  roundId?: string | null;
  conversationId: string;
  sequence: number;
  status: AIToolRoundStatus;
  providerMessages: Record<string, unknown>[];
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AIRunToolCall {
  id: string;
  runId: string;
  roundId?: string | null;
  position?: number;
  conversationId: string;
  assistantMessageId: string | null;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  classification: string;
  approvalPolicy: string;
  requiredScopes: string[];
  status: AIRunToolCallStatus;
  decision: "approved" | "rejected" | null;
  result: unknown | null;
  error: string | null;
}

export interface AIRunQuestion {
  id: string;
  runId: string;
  roundId?: string | null;
  position?: number;
  conversationId: string;
  toolCallId: string;
  question: string;
  status: "pending" | "answered" | "stopped";
  answer: string | null;
}

export interface AICredentialChallenge {
  id: string;
  runId: string;
  roundId?: string | null;
  conversationId: string;
  userId: string;
  provider: "gitlab" | "github" | "git" | "cloudflare" | "ssh";
  connectorId: string;
  toolCallId: string;
  toolName: string;
  status: "pending" | "authorized" | "rejected" | "stopped";
  decisionClientCommandId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AISetupInteraction {
  id: string;
  runId: string;
  roundId: string | null;
  conversationId: string;
  userId: string;
  toolCallId: string;
  toolName: string;
  kind: "connector_setup" | "node_enrollment";
  payload: Record<string, unknown>;
  status: "pending" | "configured" | "cancelled" | "stopped";
  result: Record<string, unknown> | null;
  resolveClientCommandId: string | null;
  expiresAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AIRuntimeSnapshot {
  activeRun: AIRun | null;
  activePlan?: AIPlanRuntimeSnapshot | null;
  plans?: AIPlanRuntimeSnapshot[];
  canContinue?: boolean;
  assistantDraftContent?: string | null;
  assistantDraftVersion?: number | null;
  pendingApprovals: AIRunToolCall[];
  pendingQuestion: AIRunQuestion | null;
  pendingQuestions: AIRunQuestion[];
  pendingCredentialChallenge?: AICredentialChallenge | null;
  pendingSetupInteraction?: AISetupInteraction | null;
  toolCalls: AIRunToolCall[];
  toolRounds?: AIRunToolRound[];
  pendingInputs?: AIConversationInput[];
}

export interface AIConversationRuntimeSnapshot {
  revision?: number;
  resourceReferences?: AIResourceReference[];
  conversation: {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    folderId?: string | null;
    lastUserMessageAt?: string | null;
    messageCount?: number;
    status?: AIConversationStatus;
    blockReason?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    lastContext: PageContext | null;
    discoveredToolsets: string[];
    checkpoint: Record<string, unknown> | null;
  };
  messages: unknown[];
  runtime: AIRuntimeSnapshot;
}

// ── WebSocket Messages ──

export type WSClientMessage =
  | { type: "conversation.subscribe"; conversationId: string; clientCommandId?: string }
  | { type: "conversation.unsubscribe"; conversationId: string }
  | { type: "conversation.sync"; conversationId: string; clientCommandId?: string }
  | {
      type: "conversation.compact";
      conversationId: string;
      clientCommandId: string;
      context?: PageContext;
      model?: string;
      reasoningEffort?: string;
    }
  | {
      type: "conversation.send_message";
      clientCommandId: string;
      conversationId?: string;
      content: string;
      attachments?: AIMessageAttachment[];
      context?: PageContext;
      model?: string;
      reasoningEffort?: string;
      workMode?: "normal" | "plan";
    }
  | {
      type: "conversation.start_scenario";
      clientCommandId: string;
      scenarioId: string;
      context?: PageContext;
      model?: string;
      reasoningEffort?: string;
    }
  | {
      type: "conversation.continue";
      conversationId: string;
      clientCommandId: string;
      context?: PageContext;
      model?: string;
      reasoningEffort?: string;
    }
  | {
      type: "conversation.queue_message";
      conversationId: string;
      inputId: string;
      clientCommandId: string;
      content: string;
      attachments?: AIMessageAttachment[];
      context?: PageContext;
    }
  | {
      type: "conversation.steer_message";
      conversationId: string;
      inputId: string;
      clientCommandId: string;
    }
  | {
      type: "conversation.cancel_queued_message";
      conversationId: string;
      inputId: string;
      clientCommandId: string;
    }
  | { type: "run.stop"; conversationId: string; runId: string; clientCommandId: string }
  | {
      type: "plan.decide";
      conversationId: string;
      planId: string;
      revisionId: string;
      decision: "implement" | "refine" | "custom";
      customInstruction?: string;
      clientCommandId: string;
    }
  | { type: "plan.pause"; conversationId: string; planId: string; clientCommandId: string }
  | { type: "plan.resume"; conversationId: string; planId: string; clientCommandId: string }
  | { type: "plan.cancel"; conversationId: string; planId: string; clientCommandId: string }
  | { type: "conversation.abandon_planning"; conversationId: string; clientCommandId: string }
  | {
      type: "approval.decide";
      conversationId: string;
      runId: string;
      approvalId: string;
      decision: "approved" | "rejected";
      clientCommandId: string;
    }
  | {
      type: "question.answer";
      conversationId: string;
      runId: string;
      questionId: string;
      answer: string;
      clientCommandId: string;
    }
  | {
      type: "credential.resolve";
      conversationId: string;
      runId: string;
      challengeId: string;
      decision: "authorized" | "rejected";
      clientCommandId: string;
    }
  | {
      type: "setup.resolve";
      conversationId: string;
      runId: string;
      interactionId: string;
      status: "configured" | "cancelled";
      result?: Record<string, unknown>;
      clientCommandId: string;
    }
  | { type: "ping" };

export type WSServerMessage =
  | { type: "auth_ok"; userId: string }
  | { type: "auth_error"; message: string }
  | {
      type: "command.ack";
      commandType: WSClientMessage["type"];
      clientCommandId?: string;
      conversationId?: string;
      runId?: string;
      duplicate?: boolean;
    }
  | {
      type: "command.error";
      commandType?: WSClientMessage["type"] | string;
      clientCommandId?: string;
      conversationId?: string;
      runId?: string;
      code: string;
      message: string;
      statusCode?: number;
      /** Structured details, sent only for license denials. */
      details?: unknown;
    }
  | {
      type: "conversation.snapshot";
      conversationId: string;
      snapshot: AIConversationRuntimeSnapshot;
    }
  | {
      type: "plan.status_changed";
      conversationId: string;
      plan: AIPlanRuntimeSnapshot;
      revision?: number;
    }
  | {
      type: "assistant.delta";
      conversationId: string;
      runId: string;
      content: string;
      version: number;
      /** The content is the whole draft, replacing what was streamed (a retried model call). */
      replace?: boolean;
    }
  | {
      type: "assistant.comment_delta";
      conversationId: string;
      runId: string;
      content: string;
      version: number;
      /** The content is the whole draft, replacing what was streamed (a retried model call). */
      replace?: boolean;
    }
  | {
      type: "assistant.comment_done";
      conversationId: string;
      runId: string;
    }
  | {
      type: "credential.required";
      conversationId: string;
      runId: string;
      challenge: AICredentialChallenge;
      revision?: number;
    }
  | {
      type: "client.action";
      conversationId: string;
      runId: string;
      action: Record<string, unknown>;
    }
  | { type: "run.status_changed"; conversationId: string; run: AIRun | null; revision?: number }
  | { type: "stores.invalidated"; conversationId: string; stores: string[]; revision?: number }
  | {
      type: "approval.updated";
      conversationId: string;
      runId: string;
      approval: AIRunToolCall;
      duplicate: boolean;
      revision?: number;
    }
  | {
      type: "question.answered";
      conversationId: string;
      runId: string;
      question: AIRunQuestion;
      duplicate: boolean;
      revision?: number;
    }
  | {
      type: "credential.updated";
      conversationId: string;
      runId: string;
      challenge: AICredentialChallenge;
      duplicate: boolean;
      revision?: number;
    }
  | { type: "pong" };

// ── Tool definition (from admin API) ──

export interface AIToolDef {
  name: string;
  description: string;
  destructive: boolean;
  requiredRole: string;
}
