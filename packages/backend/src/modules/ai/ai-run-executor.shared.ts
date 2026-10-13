import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type AICredentialChallenge,
  type AIRun,
  type AIRunQuestion,
  type AIRunToolCall,
  type AISetupInteraction,
  aiConversationMessages,
  aiConversations,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import type { AIContextCompactionResult } from './ai.service.js';
import type { AIResourceReference, ChatMessage, WSServerMessage } from './ai.types.js';
import { formatAIResourceMarker } from './ai-resource-references.js';
import { redactOneTimeSecretToolResult } from './ai-secret-result-redaction.js';
export const logger = createChildLogger('AI-Run-Executor');
export const ACTIVE_RUN_STATUSES: AIRun['status'][] = [
  'queued',
  'running',
  'waiting_for_approval',
  'waiting_for_answer',
  'waiting_for_credential',
  'waiting_for_setup',
];
export const STEER_DEBOUNCE_MS = 1_000;
export const STEER_MAX_WAIT_MS = 3_000;

export function getClientAction(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const action = (result as { clientAction?: unknown }).clientAction;
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  return action as Record<string, unknown>;
}

export function getSetupInteractionKind(action: Record<string, unknown> | null): AISetupInteraction['kind'] | null {
  if (action?.type === 'open_connector_setup') return 'connector_setup';
  if (action?.type === 'open_node_enrollment') return 'node_enrollment';
  return null;
}

export type PublishConversationChanged = (userId: string, conversationId: string, invalidatedStores?: string[]) => void;
export type PublishAssistantDelta = (
  userId: string,
  conversationId: string,
  runId: string,
  content: string,
  version: number,
  /** The content is the whole draft and replaces what was streamed. */
  replace?: boolean
) => void;
export type PublishAssistantCommentDelta = PublishAssistantDelta;
export type PublishAssistantCommentDone = (userId: string, conversationId: string, runId: string) => void;
export type PublishCredentialChallenge = (
  userId: string,
  conversationId: string,
  runId: string,
  challenge: AICredentialChallenge
) => void;
export type PublishClientAction = (
  userId: string,
  conversationId: string,
  runId: string,
  action: Record<string, unknown>
) => void;
export type HandleCompletedRun = (user: User, run: AIRun) => Promise<boolean>;
export type HandleFailedRun = (user: User, run: AIRun, error: string) => Promise<void>;

export interface ApprovalContinuationInput {
  conversationId: string;
  runId: string;
  toolCall: AIRunToolCall;
  approved: boolean;
}

export interface QuestionContinuationInput {
  conversationId: string;
  runId: string;
  question: AIRunQuestion;
}

export interface CredentialContinuationInput {
  conversationId: string;
  runId: string;
  challenge: AICredentialChallenge;
  authorized: boolean;
}

export interface SetupContinuationInput {
  conversationId: string;
  runId: string;
  interaction: AISetupInteraction;
}

export interface ResumeInput {
  conversationId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  approved: boolean;
  pendingMessages: Record<string, unknown>[];
  answers?: Record<string, string>;
  queuedApprovals: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  approvalDecisions?: Record<string, boolean>;
  rejectionError?: string;
  precomputedResult?: {
    result: Record<string, unknown>;
    error?: string;
    rejected?: boolean;
  };
}

export function isPlanPauseBoundaryError(error: unknown): boolean {
  return error instanceof AppError && error.code === 'AI_PLAN_PAUSE_BOUNDARY';
}

export type DbLike = Pick<DrizzleClient, 'select' | 'insert' | 'update'>;

export function findLastCompactMarkerIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (
      message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).compactMarker === true
    ) {
      return i;
    }
  }
  return -1;
}

export function rowsForCompactMarkerBoundary<T extends { id?: string | null; uiMessage: Record<string, unknown> }>(
  rows: T[],
  markerIndex: number
): T[] {
  const marker = rows[markerIndex];
  if (marker.uiMessage.compactVersion === 2 && typeof marker.uiMessage.compactBoundaryMessageId === 'string') {
    const boundaryIndex = rows.findIndex((row) => row.id === marker.uiMessage.compactBoundaryMessageId);
    if (boundaryIndex >= 0 && boundaryIndex < markerIndex) {
      return [marker, ...rows.slice(boundaryIndex + 1, markerIndex), ...rows.slice(markerIndex + 1)];
    }
  }
  const tailCount =
    typeof marker.uiMessage.compactTailMessageCount === 'number' &&
    Number.isFinite(marker.uiMessage.compactTailMessageCount)
      ? Math.max(0, Math.trunc(marker.uiMessage.compactTailMessageCount))
      : 0;
  const tailStart = Math.max(0, markerIndex - tailCount);
  return [marker, ...rows.slice(tailStart, markerIndex), ...rows.slice(markerIndex + 1)];
}

export function compactedRuntimeMessages(messages: ChatMessage[], result: AIContextCompactionResult): ChatMessage[] {
  const boundaryIndex = messages.findIndex((message) => message.id === result.compactBoundaryMessageId);
  if (boundaryIndex < 0) {
    throw new AppError(
      409,
      'AI_COMPACTION_BOUNDARY_UNKNOWN',
      'The compacted message boundary is no longer present in runtime context'
    );
  }
  return [
    {
      role: 'system',
      content: compactLifecycleContent(result),
      hiddenSystemEvent: true,
      lifecycleEvent: { type: 'context_compacted', trigger: result.trigger },
      compactMarker: true,
      compactVersion: 2,
      compactEpoch: result.compactEpoch,
      compactBoundaryMessageId: result.compactBoundaryMessageId ?? undefined,
    },
    ...messages.slice(boundaryIndex + 1),
  ];
}

export function compactLifecycleContent(result: AIContextCompactionResult): string {
  return [
    `Context compaction occurred (${result.trigger}).`,
    'The summary below is lossy. If an exact older detail is needed, use search_compacted_history rather than guessing.',
    '',
    'Compacted summary:',
    result.summary,
  ].join('\n');
}

export function formatHistoricalToolOutcome(toolCall: {
  toolName: string;
  status: string;
  decision: string | null;
  result: unknown;
  resourceReferences: AIResourceReference[];
  error: string | null;
}): string {
  const parts = [`${toolCall.toolName} status=${toolCall.status}`];
  if (toolCall.decision) parts.push(`decision=${toolCall.decision}`);
  if (toolCall.error) {
    parts.push(`error=${safeInlineText(toolCall.error)}`);
  } else if (toolCall.result !== null && toolCall.result !== undefined) {
    const redactedResult = redactOneTimeSecretToolResult(toolCall.toolName, toolCall.result);
    parts.push(`result=${safeJson(redactedResult)}`);
  }
  if (toolCall.resourceReferences.length > 0) {
    parts.push(
      `resources=${toolCall.resourceReferences.map((reference) => formatAIResourceMarker(reference)).join(',')}`
    );
  }
  return `- ${parts.join(' ')}`;
}

export function safeJson(value: unknown): string {
  try {
    return safeInlineText(JSON.stringify(value));
  } catch {
    return safeInlineText(String(value));
  }
}

export function safeInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export async function getOwnedConversation(db: DbLike, userId: string, conversationId: string) {
  const rows = await db
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
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

export function estimateJsonSize(value: unknown): number {
  if (value == null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

export function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function getQuestionBatch(
  event: Extract<WSServerMessage, { type: 'tool_approval_required' }>
): Array<{ id: string; args: Record<string, unknown> }> {
  const payload = event as typeof event & { _allQuestions?: unknown };
  if (Array.isArray(payload._allQuestions)) {
    const questions = payload._allQuestions
      .map((question) => {
        if (!question || typeof question !== 'object') return null;
        const record = question as Record<string, unknown>;
        if (typeof record.id !== 'string') return null;
        const args = record.args && typeof record.args === 'object' && !Array.isArray(record.args) ? record.args : {};
        return { id: record.id, args: args as Record<string, unknown> };
      })
      .filter((question): question is { id: string; args: Record<string, unknown> } => question !== null);
    if (questions.length > 0) return questions;
  }

  return [{ id: event.id, args: event.arguments }];
}
