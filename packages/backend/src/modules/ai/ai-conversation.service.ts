import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type AIPlanStatus,
  type AIRunStatus,
  aiConversationMessages,
  aiConversations,
  aiPlans,
  aiRunQuestions,
  aiRuns,
  aiRunToolCalls,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AISandboxService } from './ai.sandbox.service.js';
import type { AISandboxArtifactService } from './ai.sandbox-artifact.service.js';
import { AI_TOOLS } from './ai.tools.js';
import type { AIConversationStatus, AIToolHistoryRetention, PageContext } from './ai.types.js';
import type { AIConversationSearchService } from './ai-conversation-search.service.js';
import { toClientCheckpoint } from './ai-run-runtime.helpers.js';
import { redactOneTimeSecretToolResult } from './ai-secret-result-redaction.js';

const RETAIN_FULL_TOOL_OUTPUT_COUNT = 10;
const DEFAULT_PERSISTENT_TOOL_OUTPUT_MAX_BYTES = 16000;
const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether an id can name a stored conversation message (client-side placeholder ids cannot). */
export function isConversationMessageId(value: string): boolean {
  return MESSAGE_ID_RE.test(value);
}
const ACTIVE_RUN_STATUSES = [
  'queued',
  'running',
  'waiting_for_approval',
  'waiting_for_answer',
  'waiting_for_credential',
  'waiting_for_setup',
] as const;
const DEFAULT_TOOL_HISTORY_RETENTION: AIToolHistoryRetention = { mode: 'recent_full' };
const TOOL_HISTORY_RETENTION_BY_NAME = new Map(
  AI_TOOLS.map((tool) => [tool.name, tool.historyRetention ?? DEFAULT_TOOL_HISTORY_RETENTION])
);

interface LoadedConversationMessage {
  id: string;
  sequence: number;
  role: string;
  uiMessage: Record<string, unknown>;
  createdAt: Date;
}

export interface AIConversationSummary {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  folderId: string | null;
  lastUserMessageAt: Date | null;
  messageCount: number;
  status: AIConversationStatus;
  blockReason: string | null;
  activeRunStatus: AIRunStatus | null;
  planStatus: AIPlanStatus | null;
}

export interface AIConversationDetail extends AIConversationSummary {
  messages: unknown[];
  model: string | null;
  reasoningEffort: string | null;
  lastContext: Record<string, unknown> | null;
  discoveredToolsets: string[];
  checkpoint: Record<string, unknown> | null;
}

export interface SaveAIConversationInput {
  title: string;
  messages: unknown[];
  lastContext?: PageContext | Record<string, unknown> | null;
  createNew?: boolean;
}

export interface AIConversationRuntimeStateInput {
  lastContext?: PageContext | Record<string, unknown> | null;
  discoveredToolsets?: string[];
  checkpoint?: Record<string, unknown> | null;
}

export class AIConversationService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly cleanup?: {
      artifacts: AISandboxArtifactService;
      sandbox: AISandboxService;
    },
    private readonly searchService?: AIConversationSearchService
  ) {}

  async listConversations(userId: string): Promise<AIConversationSummary[]> {
    const rows = await this.db
      .select()
      .from(aiConversations)
      .where(eq(aiConversations.userId, userId))
      .orderBy(desc(aiConversations.createdAt));

    const [messageRowsByRow, activeRuns, plans] = await Promise.all([
      Promise.all(rows.map((row) => this.loadMessageRows(row.id))),
      rows.length > 0
        ? this.db
            .select()
            .from(aiRuns)
            .where(
              and(
                eq(aiRuns.userId, userId),
                inArray(
                  aiRuns.conversationId,
                  rows.map((row) => row.id)
                ),
                inArray(aiRuns.status, ACTIVE_RUN_STATUSES)
              )
            )
        : Promise.resolve([]),
      rows.length > 0
        ? this.db
            .select({ conversationId: aiPlans.conversationId, status: aiPlans.status, createdAt: aiPlans.createdAt })
            .from(aiPlans)
            .where(
              and(
                eq(aiPlans.userId, userId),
                inArray(
                  aiPlans.conversationId,
                  rows.map((row) => row.id)
                )
              )
            )
            .orderBy(desc(aiPlans.createdAt))
        : Promise.resolve([]),
    ]);
    const activeRunStatusByConversation = new Map(activeRuns.map((run) => [run.conversationId, run.status]));
    const planStatusByConversation = new Map<string, AIPlanStatus>();
    for (const plan of plans) {
      if (!planStatusByConversation.has(plan.conversationId)) {
        planStatusByConversation.set(plan.conversationId, plan.status);
      }
    }
    return sortConversationSummariesByLastUserMessage(
      rows.map((row, index) => {
        const messageRows = messageRowsByRow[index];
        const messages = messageRows.map((message) => message.uiMessage);
        return {
          id: row.id,
          title: row.title,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          folderId: row.folderId,
          lastUserMessageAt: getLastUserMessageAt(messageRows),
          messageCount: countVisibleMessages(messages),
          ...deriveConversationStatus(messages),
          activeRunStatus: activeRunStatusByConversation.get(row.id) ?? null,
          planStatus: planStatusByConversation.get(row.id) ?? null,
        };
      })
    );
  }

  async getConversation(userId: string, conversationId: string): Promise<AIConversationDetail | null> {
    const row = await this.getOwnedConversation(userId, conversationId);
    if (!row) return null;
    const [messageRows, activeRuns, plans] = await Promise.all([
      this.loadMessageRows(row.id),
      this.db
        .select()
        .from(aiRuns)
        .where(
          and(eq(aiRuns.userId, userId), eq(aiRuns.conversationId, row.id), inArray(aiRuns.status, ACTIVE_RUN_STATUSES))
        )
        .limit(1),
      this.db
        .select({ status: aiPlans.status })
        .from(aiPlans)
        .where(and(eq(aiPlans.userId, userId), eq(aiPlans.conversationId, row.id)))
        .orderBy(desc(aiPlans.createdAt))
        .limit(1),
    ]);
    const allMessages = messageRows.map((message) => message.uiMessage);
    // Messages carry their row id, as in the live snapshot: rollback and edit address a message by it.
    const messages = messageRows
      .filter((message) => !isHiddenSystemMessage(message.uiMessage))
      .map((message) => ({ ...message.uiMessage, id: message.id, sequence: message.sequence }));
    return {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      folderId: row.folderId,
      lastUserMessageAt: getLastUserMessageAt(messageRows),
      messageCount: countVisibleMessages(allMessages),
      ...deriveConversationStatus(allMessages),
      activeRunStatus: activeRuns[0]?.status ?? null,
      planStatus: plans[0]?.status ?? null,
      messages,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      lastContext: row.lastContext,
      discoveredToolsets: row.discoveredToolsets,
      checkpoint: toClientCheckpoint(row.checkpoint),
    };
  }

  async listConversationTitles(userId: string, conversationIds: string[]): Promise<Record<string, string>> {
    const ids = [...new Set(conversationIds.filter(Boolean))];
    if (ids.length === 0) return {};
    const rows = await this.db
      .select({ id: aiConversations.id, title: aiConversations.title })
      .from(aiConversations)
      .where(and(eq(aiConversations.userId, userId), inArray(aiConversations.id, ids)));
    return Object.fromEntries(rows.map((row) => [row.id, row.title]));
  }

  async renameConversation(
    userId: string,
    conversationId: string,
    title: string
  ): Promise<AIConversationDetail | null> {
    const existing = await this.getOwnedConversation(userId, conversationId);
    if (!existing) return null;

    const normalizedTitle = normalizeTitle(title);
    if (normalizedTitle !== existing.title) {
      const duplicate = await this.db.query.aiConversations.findFirst({
        where: and(eq(aiConversations.userId, userId), eq(aiConversations.title, normalizedTitle)),
      });
      if (duplicate && duplicate.id !== existing.id) {
        throw new AppError(409, 'AI_CONVERSATION_TITLE_EXISTS', 'AI conversation title already exists');
      }
    }

    await this.db
      .update(aiConversations)
      .set({ title: normalizedTitle, updatedAt: new Date() })
      .where(and(eq(aiConversations.id, existing.id), eq(aiConversations.userId, userId)));
    this.searchService?.rebuildConversationIndexBestEffort(userId, existing.id);

    return this.getConversation(userId, existing.id);
  }

  async saveConversation(userId: string, input: SaveAIConversationInput): Promise<AIConversationDetail> {
    let title = normalizeTitle(input.title);
    const now = new Date();
    const lastContext = normalizeContext(input.lastContext);
    const messages = sanitizeConversationMessagesForStorage(input.messages);

    if (input.createNew) {
      title = await this.resolveUniqueTitle(userId, title);
    }

    const existing = input.createNew
      ? null
      : await this.db.query.aiConversations.findFirst({
          where: and(eq(aiConversations.userId, userId), eq(aiConversations.title, title)),
        });

    let conversationId = existing?.id;
    await this.db.transaction(async (tx) => {
      if (conversationId) {
        await tx
          .update(aiConversations)
          .set({ lastContext: lastContext ?? existing?.lastContext ?? null, updatedAt: now })
          .where(eq(aiConversations.id, conversationId));
      } else {
        const [created] = await tx
          .insert(aiConversations)
          .values({
            userId,
            title,
            lastContext,
            discoveredToolsets: [],
            updatedAt: now,
          })
          .returning({ id: aiConversations.id });
        conversationId = created.id;
      }

      await tx.delete(aiConversationMessages).where(eq(aiConversationMessages.conversationId, conversationId!));
      if (messages.length > 0) {
        await tx
          .insert(aiConversationMessages)
          .values(messages.map((message, index) => toConversationMessage(conversationId!, message, index)));
      }
    });

    await this.attachArtifactsFromMessages(userId, conversationId!, messages);
    this.searchService?.rebuildConversationIndexBestEffort(userId, conversationId!);
    const saved = await this.getConversation(userId, conversationId!);
    if (!saved) throw new Error('Failed to save conversation');
    return saved;
  }

  private async resolveUniqueTitle(userId: string, title: string): Promise<string> {
    let candidate = title;
    for (let copy = 2; ; copy += 1) {
      const existing = await this.db.query.aiConversations.findFirst({
        where: and(eq(aiConversations.userId, userId), eq(aiConversations.title, candidate)),
      });
      if (!existing) return candidate;

      const suffix = ` (${copy})`;
      candidate = `${title.slice(0, 255 - suffix.length)}${suffix}`;
    }
  }

  async updateConversation(
    userId: string,
    conversationId: string,
    input: Partial<SaveAIConversationInput> & AIConversationRuntimeStateInput
  ): Promise<AIConversationDetail | null> {
    const existing = await this.getOwnedConversation(userId, conversationId);
    if (!existing) return null;
    const now = new Date();
    const lastContext = normalizeContext(input.lastContext);

    await this.db.transaction(async (tx) => {
      await tx
        .update(aiConversations)
        .set({
          title: input.title ? normalizeTitle(input.title) : existing.title,
          lastContext: input.lastContext !== undefined ? lastContext : existing.lastContext,
          discoveredToolsets:
            input.discoveredToolsets !== undefined
              ? normalizeToolsets(input.discoveredToolsets).slice(0, 3)
              : existing.discoveredToolsets,
          checkpoint: input.checkpoint !== undefined ? input.checkpoint : existing.checkpoint,
          updatedAt: now,
        })
        .where(eq(aiConversations.id, existing.id));

      if (input.messages) {
        const messages = sanitizeConversationMessagesForStorage(input.messages);
        await tx.delete(aiConversationMessages).where(eq(aiConversationMessages.conversationId, existing.id));
        if (messages.length > 0) {
          await tx
            .insert(aiConversationMessages)
            .values(messages.map((message, index) => toConversationMessage(existing.id, message, index)));
        }
      }
    });

    if (input.messages) {
      await this.attachArtifactsFromMessages(
        userId,
        conversationId,
        sanitizeConversationMessagesForStorage(input.messages)
      );
      this.searchService?.rebuildConversationIndexBestEffort(userId, conversationId);
    }
    return this.getConversation(userId, conversationId);
  }

  async updateRuntimeState(
    userId: string,
    conversationId: string,
    input: AIConversationRuntimeStateInput
  ): Promise<AIConversationDetail | null> {
    const existing = await this.getOwnedConversation(userId, conversationId);
    if (!existing) return null;

    const discoveredToolsets =
      input.discoveredToolsets === undefined
        ? existing.discoveredToolsets
        : normalizeToolsets(input.discoveredToolsets).slice(0, 3);

    await this.db
      .update(aiConversations)
      .set({
        lastContext: input.lastContext !== undefined ? normalizeContext(input.lastContext) : existing.lastContext,
        discoveredToolsets,
        checkpoint: input.checkpoint !== undefined ? input.checkpoint : existing.checkpoint,
        updatedAt: new Date(),
      })
      .where(eq(aiConversations.id, existing.id));

    return this.getConversation(userId, conversationId);
  }

  async rollbackToMessage(
    userId: string,
    conversationId: string,
    messageId: string
  ): Promise<{ message: unknown; conversation: AIConversationDetail } | null> {
    // Only stored messages can be returned to; a client-side id is not one (and not a uuid).
    if (!isConversationMessageId(messageId)) return null;
    const existing = await this.getOwnedConversation(userId, conversationId);
    if (!existing) return null;

    const [activeRun] = await this.db
      .select({ id: aiRuns.id })
      .from(aiRuns)
      .where(and(eq(aiRuns.conversationId, conversationId), inArray(aiRuns.status, [...ACTIVE_RUN_STATUSES])))
      .limit(1);
    if (activeRun) {
      throw new AppError(409, 'AI_RUN_ACTIVE', 'The assistant is still working in this chat. Stop it and try again.');
    }

    const [target] = await this.db
      .select({
        id: aiConversationMessages.id,
        sequence: aiConversationMessages.sequence,
        role: aiConversationMessages.role,
        uiMessage: aiConversationMessages.uiMessage,
      })
      .from(aiConversationMessages)
      .where(and(eq(aiConversationMessages.conversationId, conversationId), eq(aiConversationMessages.id, messageId)))
      .limit(1);

    if (!target || target.role !== 'user') return null;

    await this.db.transaction(async (tx) => {
      const deletedMessages = await tx
        .select({ id: aiConversationMessages.id })
        .from(aiConversationMessages)
        .where(
          and(
            eq(aiConversationMessages.conversationId, conversationId),
            gte(aiConversationMessages.sequence, target.sequence)
          )
        );
      const deletedMessageIds = deletedMessages.map((message) => message.id);

      const deletedRuns =
        deletedMessageIds.length > 0
          ? await tx
              .select({ id: aiRuns.id })
              .from(aiRuns)
              .where(and(eq(aiRuns.conversationId, conversationId), inArray(aiRuns.activeMessageId, deletedMessageIds)))
          : [];
      const deletedToolCallRuns =
        deletedMessageIds.length > 0
          ? await tx
              .select({ id: aiRunToolCalls.runId })
              .from(aiRunToolCalls)
              .where(
                and(
                  eq(aiRunToolCalls.conversationId, conversationId),
                  inArray(aiRunToolCalls.assistantMessageId, deletedMessageIds)
                )
              )
          : [];
      const deletedRunIds = Array.from(new Set([...deletedRuns, ...deletedToolCallRuns].map((run) => run.id)));

      if (deletedRunIds.length > 0) {
        await tx.delete(aiRunQuestions).where(inArray(aiRunQuestions.runId, deletedRunIds));
        await tx.delete(aiRunToolCalls).where(inArray(aiRunToolCalls.runId, deletedRunIds));
        await tx.delete(aiRuns).where(inArray(aiRuns.id, deletedRunIds));
      }
      if (deletedMessageIds.length > 0) {
        await tx.delete(aiRunToolCalls).where(inArray(aiRunToolCalls.assistantMessageId, deletedMessageIds));
        await tx.delete(aiConversationMessages).where(inArray(aiConversationMessages.id, deletedMessageIds));
      }
      await tx
        .update(aiConversations)
        .set({ checkpoint: null, updatedAt: new Date() })
        .where(eq(aiConversations.id, conversationId));
    });
    this.searchService?.rebuildConversationIndexBestEffort(userId, conversationId);

    const conversation = await this.getConversation(userId, conversationId);
    if (!conversation) return null;
    return { message: target.uiMessage, conversation };
  }

  async deleteConversation(userId: string, conversationId: string): Promise<boolean> {
    const existing = await this.getOwnedConversation(userId, conversationId);
    if (!existing) return false;
    await this.cleanupConversationResources(userId, existing.id);
    const [deleted] = await this.db
      .delete(aiConversations)
      .where(and(eq(aiConversations.id, existing.id), eq(aiConversations.userId, userId)))
      .returning({ id: aiConversations.id });
    return !!deleted;
  }

  async deleteConversationByTitle(userId: string, title: string): Promise<boolean> {
    const existing = await this.db.query.aiConversations.findFirst({
      where: and(eq(aiConversations.userId, userId), eq(aiConversations.title, normalizeTitle(title))),
    });
    if (!existing) return false;
    await this.cleanupConversationResources(userId, existing.id);
    const [deleted] = await this.db
      .delete(aiConversations)
      .where(and(eq(aiConversations.userId, userId), eq(aiConversations.id, existing.id)))
      .returning({ id: aiConversations.id });
    return !!deleted;
  }

  private async getOwnedConversation(userId: string, conversationId: string) {
    return this.db.query.aiConversations.findFirst({
      where: and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, userId)),
    });
  }

  private async loadMessageRows(conversationId: string): Promise<LoadedConversationMessage[]> {
    const rows = await this.db
      .select({
        id: aiConversationMessages.id,
        sequence: aiConversationMessages.sequence,
        role: aiConversationMessages.role,
        uiMessage: aiConversationMessages.uiMessage,
        createdAt: aiConversationMessages.createdAt,
      })
      .from(aiConversationMessages)
      .where(eq(aiConversationMessages.conversationId, conversationId))
      .orderBy(asc(aiConversationMessages.sequence));
    return rows;
  }

  private async cleanupConversationResources(userId: string, conversationId: string): Promise<void> {
    if (!this.cleanup) return;
    await Promise.all([
      this.cleanup.artifacts.deleteForConversation(userId, conversationId),
      this.cleanup.sandbox.killConversationJobs(userId, conversationId),
    ]);
  }

  private async attachArtifactsFromMessages(
    userId: string,
    conversationId: string,
    messages: unknown[]
  ): Promise<void> {
    if (!this.cleanup) return;
    const artifactIds = collectConversationArtifactIds(messages);
    await this.cleanup.artifacts.syncConversationArtifacts(userId, artifactIds, conversationId);
  }
}

function normalizeTitle(title: string): string {
  const normalized = title.trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error('Conversation title is required');
  return normalized.slice(0, 255);
}

function normalizeContext(context: SaveAIConversationInput['lastContext']): Record<string, unknown> | null {
  if (!context) return null;
  return { ...context };
}

function normalizeToolsets(toolsets: string[]): string[] {
  return [...new Set(toolsets.map((toolset) => toolset.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function sanitizeConversationMessagesForStorage(messages: unknown[]): unknown[] {
  const retainedToolCallIds = collectRetainedToolCallIds(messages);
  return messages.map((message) => sanitizeConversationMessage(message, retainedToolCallIds));
}

function collectRetainedToolCallIds(messages: unknown[]): Set<string> {
  const toolCallIds: string[] = [];
  for (const message of messages) {
    const record = toRecord(message);
    if (!record || !Array.isArray(record.toolCalls)) continue;
    for (const toolCall of record.toolCalls) {
      const toolRecord = toRecord(toolCall);
      if (!toolRecord || toolRecord.name === 'ask_question' || typeof toolRecord.id !== 'string') continue;
      if (getToolHistoryRetention(typeof toolRecord.name === 'string' ? toolRecord.name : '').mode !== 'recent_full') {
        continue;
      }
      toolCallIds.push(toolRecord.id);
    }
  }
  return new Set(toolCallIds.slice(-RETAIN_FULL_TOOL_OUTPUT_COUNT));
}

function sanitizeConversationMessage(message: unknown, retainedToolCallIds: Set<string>): unknown {
  const record = toRecord(message);
  if (!record || !Array.isArray(record.toolCalls)) return message;
  return {
    ...record,
    toolCalls: record.toolCalls.map((toolCall) => sanitizeToolCall(toolCall, retainedToolCallIds)),
  };
}

function sanitizeToolCall(toolCall: unknown, retainedToolCallIds: Set<string>): unknown {
  const record = toRecord(toolCall);
  if (!record || record.name === 'ask_question' || typeof record.id !== 'string') return toolCall;
  const toolName = typeof record.name === 'string' ? record.name : '';
  const result = Object.hasOwn(record, 'result') ? redactOneTimeSecretToolResult(toolName, record.result) : undefined;
  const toolCallWithRedactedSecrets = result !== record.result ? { ...record, result } : record;
  if (!Object.hasOwn(record, 'result')) return toolCallWithRedactedSecrets;

  const retention = getToolHistoryRetention(toolName);
  if (retention.mode === 'never_full' || retention.mode === 'summary_only') {
    return {
      ...toolCallWithRedactedSecrets,
      result: createOmittedToolResult(toolName, result, retention.mode),
    };
  }

  if (retention.mode === 'persistent_context') {
    return {
      ...toolCallWithRedactedSecrets,
      result: compactPersistentToolResult(toolName, result, retention.maxBytes),
    };
  }

  if (retainedToolCallIds.has(record.id)) return toolCallWithRedactedSecrets;
  return {
    ...toolCallWithRedactedSecrets,
    result: createOmittedToolResult(toolName, result, 'recent_full'),
  };
}

function getToolHistoryRetention(toolName: string): AIToolHistoryRetention {
  return TOOL_HISTORY_RETENTION_BY_NAME.get(toolName) ?? DEFAULT_TOOL_HISTORY_RETENTION;
}

function compactPersistentToolResult(toolName: string, result: unknown, maxBytes?: number): unknown {
  const limit = maxBytes ?? DEFAULT_PERSISTENT_TOOL_OUTPUT_MAX_BYTES;
  const serialized = serializeToolResultForSize(result);
  if (serialized.byteLength <= limit) return result;
  return {
    ...createOmittedToolResult(toolName, result, 'persistent_context'),
    summary: `Tool output exceeded the ${limit} byte persistent context retention limit.`,
    retainedBytesLimit: limit,
  };
}

function createOmittedToolResult(
  toolName: string,
  result: unknown,
  mode: AIToolHistoryRetention['mode']
): Record<string, unknown> {
  const omittedResult: Record<string, unknown> = {
    summary:
      mode === 'recent_full'
        ? 'Tool output omitted from saved conversation after the latest 10 recent-full tool calls.'
        : 'Tool output omitted from saved conversation by tool history retention policy.',
    fullOutputOmitted: true,
    historyRetention: mode,
    toolName,
    resultType: Array.isArray(result) ? 'array' : typeof result,
  };
  if (mode !== 'never_full') {
    omittedResult.resultBytes = serializeToolResultForSize(result).byteLength;
  }
  return omittedResult;
}

function serializeToolResultForSize(result: unknown): { byteLength: number } {
  try {
    return { byteLength: Buffer.byteLength(JSON.stringify(result) ?? '', 'utf8') };
  } catch {
    return { byteLength: Buffer.byteLength(String(result), 'utf8') };
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function deriveConversationStatus(messages: unknown[]): {
  status: AIConversationStatus;
  blockReason: string | null;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const record = toRecord(messages[i]);
    if (!record) continue;
    if (record.compactMarker === true) return { status: 'active', blockReason: null };
    if (typeof record.conversationStatus !== 'string') continue;
    if (record.conversationStatus === 'ended' || record.conversationStatus === 'context_blocked') {
      return {
        status: record.conversationStatus,
        blockReason: typeof record.blockReason === 'string' ? record.blockReason : null,
      };
    }
  }
  return { status: 'active', blockReason: null };
}

export function countVisibleMessages(messages: unknown[]): number {
  return messages.filter((message) => {
    const record = toRecord(message);
    return !record?.conversationStatus && !record?.modelChange && !isHiddenSystemMessage(record);
  }).length;
}

export function isHiddenSystemMessage(message: unknown): boolean {
  const record = toRecord(message);
  return record?.role === 'system' && record.hiddenSystemEvent === true;
}

function collectConversationArtifactIds(messages: unknown[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    const record = toRecord(message);
    if (!record) continue;
    if (Array.isArray(record.attachments)) {
      for (const attachment of record.attachments) {
        const attachmentRecord = toRecord(attachment);
        if (typeof attachmentRecord?.artifactId === 'string') ids.push(attachmentRecord.artifactId);
      }
    }
    if (Array.isArray(record.toolCalls)) {
      for (const toolCall of record.toolCalls) {
        const toolRecord = toRecord(toolCall);
        const result = toRecord(toolRecord?.result);
        if (
          typeof result?.artifactId === 'string' &&
          (toolRecord?.name === 'send_artifact' || result.outputOffloaded === true)
        ) {
          ids.push(result.artifactId);
        }
      }
    }
  }
  return ids;
}

function toConversationMessage(conversationId: string, message: unknown, index: number) {
  const record = typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {};
  const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : null;
  return {
    conversationId,
    sequence: index,
    role: typeof record.role === 'string' ? record.role : 'assistant',
    content: typeof record.content === 'string' ? record.content : '',
    uiMessage: record,
    toolCalls,
    toolCallId: typeof record.toolCallId === 'string' ? record.toolCallId : null,
    toolName: typeof record.toolName === 'string' ? record.toolName : null,
    toolArgsCompact: null,
    toolResultRaw: extractToolResults(toolCalls),
    toolResultCompact: null,
    toolResultSizeBytes: estimateJsonSize(toolCalls),
    isSensitive: false,
  };
}

function extractToolResults(toolCalls: unknown[] | null): unknown {
  if (!toolCalls) return null;
  return toolCalls.map((toolCall) => {
    if (!toolCall || typeof toolCall !== 'object') return null;
    const record = toolCall as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    return {
      id: record.id,
      name: record.name,
      result: redactOneTimeSecretToolResult(name, record.result),
      error: record.error,
    };
  });
}

export function getLastUserMessageAt(
  messages: Array<Pick<LoadedConversationMessage, 'role' | 'uiMessage' | 'createdAt'>>
): Date | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') return message.createdAt;
  }
  return null;
}

export function sortConversationSummariesByLastUserMessage<
  T extends { createdAt: Date; lastUserMessageAt: Date | null },
>(conversations: T[]): T[] {
  return [...conversations].sort((left, right) => {
    const rightTime = (right.lastUserMessageAt ?? right.createdAt).getTime();
    const leftTime = (left.lastUserMessageAt ?? left.createdAt).getTime();
    return rightTime - leftTime;
  });
}

function estimateJsonSize(value: unknown): number {
  if (value == null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}
