import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type AIConversationInput,
  type AICredentialChallenge,
  type AIPlan,
  type AIRun,
  type AIRunQuestion,
  type AIRunStatus,
  type AIRunToolCall,
  type AIRunToolRound,
  type AISetupInteraction,
  type AIToolApprovalClass,
  type AIToolApprovalPolicy,
  type AIToolCallStatus,
  aiConversationMessages,
  aiConversations,
  aiRunQuestions,
  aiRuns,
  aiRunToolCalls,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AIPlanRuntimeSnapshot, AIResourceReference } from './ai.types.js';
import { deriveConversationStatus } from './ai-conversation.service.js';
import { mergeAIResourceReference } from './ai-resource-references.js';
export const ACTIVE_RUN_STATUSES: AIRunStatus[] = [
  'queued',
  'running',
  'waiting_for_approval',
  'waiting_for_answer',
  'waiting_for_credential',
  'waiting_for_setup',
];

export const ACTIVE_PLAN_STATUSES: AIPlan['status'][] = [
  'drafting',
  'validating',
  'awaiting_decision',
  'executing',
  'pause_requested',
  'paused',
  'verifying',
];

export const PRE_EXECUTION_PLAN_STATUSES: AIPlan['status'][] = ['drafting', 'validating', 'awaiting_decision'];

export function aiUserConversationsChangedChannel(userId: string): string {
  return `ai.conversations.changed.${userId}`;
}

export interface AIConversationChangedEvent {
  userId: string;
  conversationId: string;
  invalidatedStores?: string[];
}

export interface AIAssistantDeltaEvent {
  type: 'assistant.delta';
  userId: string;
  conversationId: string;
  runId: string;
  content: string;
  version: number;
  replace?: true;
}

export interface AIAssistantCommentDeltaEvent {
  type: 'assistant.comment_delta';
  userId: string;
  conversationId: string;
  runId: string;
  content: string;
  version: number;
  replace?: true;
}

export interface AIAssistantCommentDoneEvent {
  type: 'assistant.comment_done';
  userId: string;
  conversationId: string;
  runId: string;
}

export interface AICredentialRequiredEvent {
  type: 'credential.required';
  userId: string;
  conversationId: string;
  runId: string;
  challenge: AICredentialChallenge;
}

export interface AIClientActionEvent {
  type: 'client.action';
  userId: string;
  conversationId: string;
  runId: string;
  action: Record<string, unknown>;
}

export interface CreateAIRunInput {
  conversationId: string;
  userId: string;
  clientCommandId: string;
  activeMessageId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface StartUserRunInput {
  conversationId?: string | null;
  userId: string;
  title: string;
  userMessage: Record<string, unknown>;
  clientCommandId: string;
  lastContext?: Record<string, unknown> | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface StartContextCompactionInput {
  conversationId: string;
  userId: string;
  clientCommandId: string;
  lastContext?: Record<string, unknown> | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface StartContinuationRunInput {
  conversationId: string;
  userId: string;
  clientCommandId: string;
  lastContext?: Record<string, unknown> | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface StartUserRunResult {
  conversationId: string;
  userMessageId: string | null;
  run: AIRun;
  duplicate: boolean;
}

export interface QueueConversationInputResult {
  input: AIConversationInput;
  duplicate: boolean;
  executionStarted: boolean;
}

export interface RecordToolCallInput {
  runId: string;
  conversationId: string;
  assistantMessageId?: string | null;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  classification: AIToolApprovalClass;
  approvalPolicy: AIToolApprovalPolicy;
  requiredScopes?: string[];
  status?: AIToolCallStatus;
}

export interface RuntimeSnapshot {
  activeRun: AIRun | null;
  canContinue: boolean;
  assistantDraftContent: string | null;
  assistantDraftVersion: number | null;
  pendingApprovals: AIRunToolCall[];
  pendingQuestion: AIRunQuestion | null;
  pendingQuestions: AIRunQuestion[];
  pendingCredentialChallenge: AICredentialChallenge | null;
  pendingSetupInteraction: AISetupInteraction | null;
  toolCalls: AIRunToolCall[];
  toolRounds: AIRunToolRound[];
  pendingInputs: AIConversationInput[];
  activePlan: AIPlanRuntimeSnapshot | null;
  plans: AIPlanRuntimeSnapshot[];
}

export interface AIConversationRuntimeSnapshot {
  revision: number;
  resourceReferences: AIResourceReference[];
  conversation: {
    id: string;
    title: string;
    createdAt: Date;
    updatedAt: Date;
    folderId: string | null;
    lastUserMessageAt: Date | null;
    messageCount: number;
    status: 'active' | 'ended' | 'context_blocked';
    blockReason: string | null;
    model: string | null;
    reasoningEffort: string | null;
    lastContext: Record<string, unknown> | null;
    discoveredToolsets: string[];
    checkpoint: Record<string, unknown> | null;
  };
  messages: unknown[];
  runtime: RuntimeSnapshot;
}

export type DbLike = Pick<DrizzleClient, 'select' | 'insert' | 'update'>;

export function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function toolCallIdentityWhere(value: string) {
  return isUuidLike(value)
    ? or(eq(aiRunToolCalls.id, value), eq(aiRunToolCalls.toolCallId, value))
    : eq(aiRunToolCalls.toolCallId, value);
}

export function questionIdentityWhere(value: string) {
  return isUuidLike(value)
    ? or(eq(aiRunQuestions.id, value), eq(aiRunQuestions.toolCallId, value))
    : eq(aiRunQuestions.toolCallId, value);
}

export function normalizeConversationTitle(title: string): string {
  const normalized = title.trim().replace(/\s+/g, ' ');
  if (!normalized) throw new AppError(400, 'AI_CONVERSATION_TITLE_REQUIRED', 'Conversation title is required');
  return normalized.slice(0, 255);
}

export async function getOwnedConversation(db: DbLike, userId: string, conversationId: string) {
  const rows = await db
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function assertOwnedConversation(db: DbLike, userId: string, conversationId: string): Promise<void> {
  const conversation = await getOwnedConversation(db, userId, conversationId);
  if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');
}

export async function createConversation(
  db: DbLike,
  input: {
    userId: string;
    title: string;
    lastContext: Record<string, unknown> | null;
    model: string | null;
    reasoningEffort: string | null;
  }
) {
  const [conversation] = await db
    .insert(aiConversations)
    .values({
      userId: input.userId,
      title: input.title,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      lastContext: input.lastContext,
      discoveredToolsets: [],
      updatedAt: new Date(),
    })
    .returning();
  return conversation;
}

export function normalizeOptionalString(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

export async function resolveUniqueTitle(db: DbLike, userId: string, title: string): Promise<string> {
  let candidate = title;
  for (let copy = 2; ; copy += 1) {
    const rows = await db
      .select({ id: aiConversations.id })
      .from(aiConversations)
      .where(and(eq(aiConversations.userId, userId), eq(aiConversations.title, candidate)))
      .limit(1);
    if (rows.length === 0) return candidate;

    const suffix = ` (${copy})`;
    candidate = `${title.slice(0, 255 - suffix.length)}${suffix}`;
  }
}

export async function findRunByCommand(
  db: DbLike,
  userId: string,
  conversationId: string,
  clientCommandId: string
): Promise<AIRun | null> {
  const rows = await db
    .select()
    .from(aiRuns)
    .where(
      and(
        eq(aiRuns.userId, userId),
        eq(aiRuns.conversationId, conversationId),
        eq(aiRuns.clientCommandId, clientCommandId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findRunByUserCommand(db: DbLike, userId: string, clientCommandId: string): Promise<AIRun | null> {
  const rows = await db
    .select()
    .from(aiRuns)
    .where(and(eq(aiRuns.userId, userId), eq(aiRuns.clientCommandId, clientCommandId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getActiveRunForUpdate(db: DbLike, conversationId: string): Promise<AIRun | null> {
  const rows = await db
    .select()
    .from(aiRuns)
    .where(and(eq(aiRuns.conversationId, conversationId), inArray(aiRuns.status, ACTIVE_RUN_STATUSES)))
    .orderBy(desc(aiRuns.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export function collectResourceReferences(toolCalls: AIRunToolCall[]): AIResourceReference[] {
  const references = new Map<string, AIResourceReference>();
  for (const toolCall of toolCalls) {
    if (toolCall.status !== 'completed') continue;
    for (const reference of toolCall.resourceReferences ?? []) {
      references.set(reference.refId, mergeAIResourceReference(references.get(reference.refId), reference));
    }
  }
  return [...references.values()].slice(-128);
}

export async function assertConversationCanAcceptUserTurn(db: DbLike, conversationId: string): Promise<void> {
  const rows = await db
    .select({ uiMessage: aiConversationMessages.uiMessage })
    .from(aiConversationMessages)
    .where(eq(aiConversationMessages.conversationId, conversationId))
    .orderBy(desc(aiConversationMessages.sequence))
    .limit(50);
  const status = deriveConversationStatus(rows.map((row) => row.uiMessage));
  if (status.status === 'ended') {
    throw new AppError(409, 'AI_CONVERSATION_ENDED', status.blockReason ?? 'This conversation has ended');
  }
  if (status.status === 'context_blocked') {
    throw new AppError(409, 'AI_CONVERSATION_CONTEXT_BLOCKED', status.blockReason ?? 'This conversation is blocked');
  }
}

export async function assertConversationCanCompact(db: DbLike, conversationId: string): Promise<void> {
  const rows = await db
    .select({ uiMessage: aiConversationMessages.uiMessage })
    .from(aiConversationMessages)
    .where(eq(aiConversationMessages.conversationId, conversationId))
    .orderBy(desc(aiConversationMessages.sequence))
    .limit(50);
  const status = deriveConversationStatus(rows.map((row) => row.uiMessage));
  if (status.status === 'ended') {
    throw new AppError(409, 'AI_CONVERSATION_ENDED', status.blockReason ?? 'This conversation has ended');
  }
}

export async function nextMessageSequence(db: DbLike, conversationId: string): Promise<number> {
  const rows = await db
    .select({ sequence: aiConversationMessages.sequence })
    .from(aiConversationMessages)
    .where(eq(aiConversationMessages.conversationId, conversationId))
    .orderBy(desc(aiConversationMessages.sequence))
    .limit(1);
  return (rows[0]?.sequence ?? -1) + 1;
}

export function toConversationMessage(conversationId: string, message: Record<string, unknown>, sequence: number) {
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : null;
  return {
    conversationId,
    sequence,
    role: typeof message.role === 'string' ? message.role : 'user',
    content: typeof message.content === 'string' ? message.content : '',
    uiMessage: { ...message, role: typeof message.role === 'string' ? message.role : 'user' },
    toolCalls,
    toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : null,
    toolName: typeof message.toolName === 'string' ? message.toolName : null,
    toolArgsCompact: null,
    toolResultRaw: null,
    toolResultCompact: null,
    toolResultSizeBytes: estimateJsonSize(toolCalls),
    isSensitive: false,
  };
}

export function toSnapshotMessage(
  id: string,
  sequence: number,
  uiMessage: unknown,
  createdAt: Date
): Record<string, unknown> {
  if (!uiMessage || typeof uiMessage !== 'object' || Array.isArray(uiMessage)) {
    return { id, sequence, content: String(uiMessage ?? ''), createdAt: createdAt.toISOString() };
  }
  return {
    ...(uiMessage as Record<string, unknown>),
    id,
    sequence,
    createdAt: createdAt.toISOString(),
  };
}

export function readMessageRole(uiMessage: unknown): string {
  if (!uiMessage || typeof uiMessage !== 'object' || Array.isArray(uiMessage)) return '';
  const role = (uiMessage as Record<string, unknown>).role;
  return typeof role === 'string' ? role : '';
}

export function withAssistantDraftMessage(
  messages: Record<string, unknown>[],
  activeRun: AIRun | null,
  assistantDraftContent: string | null
): Record<string, unknown>[] {
  const content = assistantDraftContent;
  if (!content || !activeRun) return messages;
  const sequence =
    messages.reduce(
      (max, message, index) => Math.max(max, typeof message.sequence === 'number' ? message.sequence : index),
      -1
    ) + 1;
  return [
    ...messages,
    {
      id: `${activeRun.id}:draft`,
      sequence,
      role: 'assistant',
      content,
      createdAt: activeRun.updatedAt.toISOString(),
      isStreaming: true,
    },
  ];
}

export function estimateJsonSize(value: unknown): number {
  if (value == null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}
