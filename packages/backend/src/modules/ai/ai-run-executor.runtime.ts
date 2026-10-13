import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  type AIConversationInput,
  type AICredentialChallenge,
  type AIRun,
  type AIRunQuestion,
  type AISetupInteraction,
  aiConversationInputs,
  aiConversationMessages,
  aiConversations,
  aiRunCredentialChallenges,
  aiRunQuestions,
  aiRunSetupInteractions,
  aiRuns,
  aiRunToolCalls,
  aiRunToolRounds,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import { type AIContextCompactionResult, type AIContextCompactionTrigger, AIService } from './ai.service.js';
import type { AIResourceReference, ChatMessage, WSServerMessage } from './ai.types.js';
import { classifyAIToolForApproval } from './ai-approval-policy.js';
import type { AIConversationSearchService } from './ai-conversation-search.service.js';
import { type AssistantLiveDraft, AssistantLiveDraftStore } from './ai-live-draft-store.js';
import {
  appendAIResourceReferencesToModelResult,
  mergeAIResourceReference,
  referencedAIResourceIds,
} from './ai-resource-references.js';
import {
  ACTIVE_RUN_STATUSES,
  compactedRuntimeMessages,
  compactLifecycleContent,
  findLastCompactMarkerIndex,
  formatHistoricalToolOutcome,
  getOwnedConversation,
  getQuestionBatch,
  type HandleCompletedRun,
  type HandleFailedRun,
  logger,
  nextMessageSequence,
  type PublishAssistantCommentDelta,
  type PublishAssistantCommentDone,
  type PublishAssistantDelta,
  type PublishClientAction,
  type PublishConversationChanged,
  type PublishCredentialChallenge,
  rowsForCompactMarkerBoundary,
  toConversationMessage,
} from './ai-run-executor.shared.js';
import {
  normalizeCheckpoint,
  questionTextFromArgs,
  toChatMessage,
  toCheckpoint,
  type toPageContext,
} from './ai-run-runtime.helpers.js';
import { redactOneTimeSecretToolResult } from './ai-secret-result-redaction.js';

export abstract class AIRunExecutorRuntime {
  protected readonly leaseOwner = `opfield-ai-${process.pid}-${randomUUID()}`;
  protected readonly abortControllers = new Map<string, AbortController>();
  protected readonly executingRuns = new Set<string>();
  protected readonly executionEpochs = new Map<string, number>();
  protected readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();
  protected readonly assistantLiveDrafts = new AssistantLiveDraftStore();
  protected readonly toolBoundaryMessageIds = new Map<string, string>();
  protected readonly pendingInputDispatches = new Set<string>();
  protected readonly pendingInputRedispatches = new Set<string>();

  constructor(
    protected readonly db: DrizzleClient,
    protected readonly publishConversationChanged: PublishConversationChanged,
    protected readonly publishAssistantDelta: PublishAssistantDelta,
    protected readonly publishAssistantCommentDelta: PublishAssistantCommentDelta,
    protected readonly publishAssistantCommentDone: PublishAssistantCommentDone,
    protected readonly conversationSearchService?: AIConversationSearchService,
    protected readonly publishCredentialChallenge?: PublishCredentialChallenge,
    protected readonly publishClientAction?: PublishClientAction,
    protected readonly handleCompletedRun?: HandleCompletedRun,
    protected readonly handleFailedRun?: HandleFailedRun
  ) {}

  protected abstract startRunExecution(user: User, runId: string): void;

  protected listPendingSteers(runId: string): Promise<AIConversationInput[]> {
    return this.db
      .select()
      .from(aiConversationInputs)
      .where(
        and(
          eq(aiConversationInputs.targetRunId, runId),
          eq(aiConversationInputs.mode, 'steer'),
          eq(aiConversationInputs.status, 'pending')
        )
      )
      .orderBy(asc(aiConversationInputs.createdAt));
  }

  protected async returnPendingSteersToQueue(runId: string): Promise<void> {
    await this.db
      .update(aiConversationInputs)
      .set({ mode: 'queued', targetRunId: null, updatedAt: new Date() })
      .where(
        and(
          eq(aiConversationInputs.targetRunId, runId),
          eq(aiConversationInputs.mode, 'steer'),
          eq(aiConversationInputs.status, 'pending')
        )
      );
  }

  protected async consumePendingSteers(userId: string, conversationId: string, runId: string): Promise<ChatMessage[]> {
    return this.db.transaction(async (tx) => {
      const pending = await tx
        .select()
        .from(aiConversationInputs)
        .where(
          and(
            eq(aiConversationInputs.targetRunId, runId),
            eq(aiConversationInputs.mode, 'steer'),
            eq(aiConversationInputs.status, 'pending')
          )
        )
        .orderBy(asc(aiConversationInputs.createdAt));
      if (pending.length === 0) return [];

      let sequence = await nextMessageSequence(tx, conversationId);
      const values = pending.map((item) =>
        toConversationMessage(
          conversationId,
          {
            role: 'user',
            content: item.content,
            attachments: item.attachments,
            steer: true,
          },
          sequence++
        )
      );
      const inserted = await tx
        .insert(aiConversationMessages)
        .values(values)
        .returning({ id: aiConversationMessages.id, uiMessage: aiConversationMessages.uiMessage });
      const now = new Date();
      await tx
        .update(aiConversationInputs)
        .set({ status: 'consumed', consumedAt: now, updatedAt: now })
        .where(
          inArray(
            aiConversationInputs.id,
            pending.map((item) => item.id)
          )
        );
      await tx
        .update(aiConversations)
        .set({
          lastContext: pending.at(-1)?.context ?? undefined,
          updatedAt: now,
        })
        .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, userId)));
      return inserted
        .map((row) => toChatMessage({ ...row.uiMessage, id: row.id }))
        .filter((message): message is ChatMessage => Boolean(message));
    });
  }

  protected async dispatchNextPendingInput(user: User, conversationId: string): Promise<void> {
    const next = await this.db.transaction(async (tx) => {
      const [activeRun] = await tx
        .select({ id: aiRuns.id })
        .from(aiRuns)
        .where(and(eq(aiRuns.conversationId, conversationId), inArray(aiRuns.status, ACTIVE_RUN_STATUSES)))
        .limit(1);
      if (activeRun) return null;

      const pending = await tx
        .select()
        .from(aiConversationInputs)
        .where(
          and(
            eq(aiConversationInputs.conversationId, conversationId),
            eq(aiConversationInputs.userId, user.id),
            eq(aiConversationInputs.status, 'pending')
          )
        )
        .orderBy(asc(aiConversationInputs.createdAt));
      if (pending.length === 0) return null;

      const steerBatch = pending.filter((item) => item.mode === 'steer');
      const selected = steerBatch.length > 0 ? steerBatch : [pending[0]];
      const conversation = await getOwnedConversation(tx, user.id, conversationId);
      if (!conversation) return null;
      let sequence = await nextMessageSequence(tx, conversationId);
      const inserted = await tx
        .insert(aiConversationMessages)
        .values(
          selected.map((item) =>
            toConversationMessage(
              conversationId,
              {
                role: 'user',
                content: item.content,
                attachments: item.attachments,
                ...(item.mode === 'steer' ? { steer: true } : {}),
              },
              sequence++
            )
          )
        )
        .returning({ id: aiConversationMessages.id });
      const activeMessageId = inserted.at(-1)?.id;
      if (!activeMessageId) return null;
      const now = new Date();
      const [run] = await tx
        .insert(aiRuns)
        .values({
          conversationId,
          userId: user.id,
          clientCommandId: `input:${selected[0].id}`,
          activeMessageId,
          model: conversation.model,
          reasoningEffort: conversation.reasoningEffort,
          status: 'queued',
          updatedAt: now,
        })
        .returning();
      await tx
        .update(aiConversationInputs)
        .set({ status: 'consumed', consumedAt: now, updatedAt: now })
        .where(
          inArray(
            aiConversationInputs.id,
            selected.map((item) => item.id)
          )
        );
      await tx
        .update(aiConversations)
        .set({ lastContext: selected.at(-1)?.context ?? conversation.lastContext, updatedAt: now })
        .where(eq(aiConversations.id, conversationId));
      return run;
    });
    if (!next) return;
    this.publishConversationChanged(user.id, conversationId);
    this.conversationSearchService?.rebuildConversationIndexBestEffort(user.id, conversationId);
    this.startRunExecution(user, next.id);
  }

  protected async performContextCompaction(
    user: User,
    run: AIRun,
    messages: ChatMessage[],
    pageContext: ReturnType<typeof toPageContext>,
    abortController: AbortController,
    trigger: AIContextCompactionTrigger,
    allowNoopResult: boolean
  ): Promise<ChatMessage[]> {
    const toolCallId =
      trigger === 'auto' ? `${trigger}-compact-${run.id}-${Date.now()}` : `${trigger}-compact-${run.id}`;
    await this.recordToolCall({
      runId: run.id,
      conversationId: run.conversationId,
      toolCallId,
      toolName: 'compact_context',
      toolArgs: { trigger },
      status: 'running',
    });
    this.publishConversationChanged(user.id, run.conversationId);

    try {
      const result = await container
        .resolve(AIService)
        .compactConversationContext(
          user,
          messages,
          pageContext,
          abortController.signal,
          trigger,
          run.model ?? undefined,
          run.conversationId,
          run.reasoningEffort ?? undefined
        );
      if (result.compacted) {
        const markerMessageId = await this.persistCompactMarker(user.id, run.conversationId, result);
        await this.linkToolCallToAssistantMessage(run.id, toolCallId, markerMessageId);
      }
      await this.finishToolCall(run.id, toolCallId, 'compact_context', result, null);
      this.publishConversationChanged(user.id, run.conversationId);
      if (!result.compacted && !allowNoopResult) return messages;
      if (!result.compacted) return this.loadConversationMessages(run.conversationId);
      return compactedRuntimeMessages(messages, result);
    } catch (error) {
      if (abortController.signal.aborted) throw error;
      await this.finishToolCall(
        run.id,
        toolCallId,
        'compact_context',
        undefined,
        error instanceof Error ? error.message : 'Context compaction failed'
      );
      this.publishConversationChanged(user.id, run.conversationId);
      throw error;
    }
  }

  protected async getOwnedRun(userId: string, runId: string): Promise<AIRun | null> {
    const rows = await this.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.id, runId), eq(aiRuns.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  protected async loadConversationMessages(
    conversationId: string,
    options: { includeHistoricalToolOutcomes?: boolean } = {}
  ): Promise<ChatMessage[]> {
    const rows = await this.db
      .select({ id: aiConversationMessages.id, uiMessage: aiConversationMessages.uiMessage })
      .from(aiConversationMessages)
      .where(eq(aiConversationMessages.conversationId, conversationId))
      .orderBy(asc(aiConversationMessages.sequence));

    const compactMarkerIndex = findLastCompactMarkerIndex(rows.map((row) => row.uiMessage));
    const activeRows = compactMarkerIndex >= 0 ? rowsForCompactMarkerBoundary(rows, compactMarkerIndex) : rows;
    const messages: Array<{ id: string | null; message: ChatMessage }> = [];
    for (const row of activeRows) {
      const message = toChatMessage(row.uiMessage);
      if (message) messages.push({ id: row.id, message: { ...message, id: row.id } });
    }

    if (!options.includeHistoricalToolOutcomes) return messages.map((entry) => entry.message);
    return this.appendHistoricalToolOutcomes(conversationId, messages);
  }

  protected async persistAssistantMessageIfNeeded(
    userId: string,
    conversationId: string,
    runId: string,
    content: string,
    includeChangedResources = false
  ): Promise<string | null> {
    if (!content.trim() && !includeChangedResources) return null;
    const messageReferences = await this.resolveMessageResourceReferences(
      conversationId,
      runId,
      content,
      includeChangedResources
    );
    if (!content.trim() && messageReferences.changed.length === 0) return null;
    const sequence = await nextMessageSequence(this.db, conversationId);
    const [message] = await this.db
      .insert(aiConversationMessages)
      .values(
        toConversationMessage(
          conversationId,
          {
            role: 'assistant',
            content,
            ...(messageReferences.referenced.length > 0 ? { resourceReferences: messageReferences.referenced } : {}),
            ...(messageReferences.changed.length > 0 ? { changedResourceReferences: messageReferences.changed } : {}),
          },
          sequence
        )
      )
      .returning({ id: aiConversationMessages.id });
    await this.db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversationId));
    this.conversationSearchService?.rebuildConversationIndexBestEffort(userId, conversationId);
    return message?.id ?? null;
  }

  protected async persistRunErrorMessage(
    userId: string,
    conversationId: string,
    runId: string,
    error: string
  ): Promise<void> {
    const content = `**Error:** ${error.trim() || 'AI run failed'}`;
    const sequence = await nextMessageSequence(this.db, conversationId);
    await this.db.insert(aiConversationMessages).values(
      toConversationMessage(
        conversationId,
        {
          role: 'assistant',
          content,
          localOnly: true,
          runError: true,
          runId,
        },
        sequence
      )
    );
    await this.db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversationId));
    this.conversationSearchService?.rebuildConversationIndexBestEffort(userId, conversationId);
  }

  protected async getOrCreateToolBoundaryMessage(conversationId: string, runId: string): Promise<string> {
    const existing = this.toolBoundaryMessageIds.get(runId);
    if (existing) return existing;

    const sequence = await nextMessageSequence(this.db, conversationId);
    const [message] = await this.db
      .insert(aiConversationMessages)
      .values(
        toConversationMessage(
          conversationId,
          {
            role: 'assistant',
            content: '',
            toolGroupBoundary: true,
          },
          sequence
        )
      )
      .returning({ id: aiConversationMessages.id });

    if (!message?.id) {
      throw new AppError(500, 'AI_TOOL_BOUNDARY_NOT_CREATED', 'AI tool call boundary was not created');
    }

    this.toolBoundaryMessageIds.set(runId, message.id);
    await this.db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversationId));
    return message.id;
  }

  protected appendAssistantDraft(runId: string, conversationId: string, delta: string): AssistantLiveDraft {
    return this.assistantLiveDrafts.append(runId, conversationId, delta);
  }

  protected async persistAssistantBoundary(
    userId: string,
    conversationId: string,
    runId: string,
    fallbackContent: string,
    includeChangedResources = false
  ): Promise<string | null> {
    const content = this.assistantLiveDrafts.getContent(runId, fallbackContent);
    const assistantMessageId = await this.persistAssistantMessageIfNeeded(
      userId,
      conversationId,
      runId,
      content,
      includeChangedResources
    );
    await this.clearAssistantDraftState(runId);
    return assistantMessageId;
  }

  protected async persistConversationStatus(
    conversationId: string,
    status: 'ended' | 'context_blocked',
    reason: string
  ): Promise<void> {
    const sequence = await nextMessageSequence(this.db, conversationId);
    await this.db.insert(aiConversationMessages).values(
      toConversationMessage(
        conversationId,
        {
          role: 'assistant',
          content: '',
          conversationStatus: status,
          blockReason: reason,
        },
        sequence
      )
    );
    await this.db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversationId));
  }

  protected async persistCompactMarker(
    userId: string,
    conversationId: string,
    result: AIContextCompactionResult
  ): Promise<string> {
    const sequence = await nextMessageSequence(this.db, conversationId);
    const [message] = await this.db
      .insert(aiConversationMessages)
      .values(
        toConversationMessage(
          conversationId,
          {
            role: 'system',
            content: compactLifecycleContent(result),
            hiddenSystemEvent: true,
            lifecycleEvent: { type: 'context_compacted', trigger: result.trigger },
            compactMarker: true,
            compactVersion: 2,
            compactEpoch: result.compactEpoch,
            compactBoundaryMessageId: result.compactBoundaryMessageId,
            compactedAt: new Date().toISOString(),
            compactedMessageCount: result.compactedMessageCount,
            sourceTokenEstimate: result.sourceTokenEstimate,
            resultTokenEstimate: result.resultTokenEstimate,
            compactTrigger: result.trigger === 'auto' ? 'automatic' : 'manual',
          },
          sequence
        )
      )
      .returning({ id: aiConversationMessages.id });
    await this.db
      .update(aiConversations)
      .set({ discoveredToolsets: [], updatedAt: new Date() })
      .where(eq(aiConversations.id, conversationId));
    this.conversationSearchService?.rebuildConversationIndexBestEffort(userId, conversationId);
    if (!message?.id)
      throw new AppError(500, 'AI_COMPACT_MARKER_NOT_CREATED', 'Context compact marker was not created');
    return message.id;
  }

  protected async clearAssistantDraftState(runId: string): Promise<void> {
    this.assistantLiveDrafts.clearContent(runId);
    await this.clearAssistantDraft(runId);
  }

  protected forgetAssistantDraftState(runId: string): void {
    this.assistantLiveDrafts.forget(runId);
  }

  protected async recordToolCall(input: {
    runId: string;
    conversationId: string;
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    assistantMessageId?: string | null;
    status: 'running' | 'pending_approval';
  }): Promise<void> {
    await this.db
      .insert(aiRunToolCalls)
      .values({
        runId: input.runId,
        conversationId: input.conversationId,
        assistantMessageId: input.assistantMessageId ?? null,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        toolArgs: input.toolArgs,
        classification: classifyAIToolForApproval(input.toolName, input.toolArgs),
        approvalPolicy: input.status === 'pending_approval' ? 'requires_approval' : 'auto_approved',
        requiredScopes: [],
        status: input.status,
      })
      .onConflictDoUpdate({
        target: [aiRunToolCalls.runId, aiRunToolCalls.toolCallId],
        set: {
          toolName: input.toolName,
          toolArgs: input.toolArgs,
          ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
          classification: classifyAIToolForApproval(input.toolName, input.toolArgs),
          approvalPolicy: input.status === 'pending_approval' ? 'requires_approval' : 'auto_approved',
          status: input.status,
          updatedAt: new Date(),
        },
      });
  }

  protected async persistToolRound(
    run: AIRun,
    event: Extract<WSServerMessage, { type: 'tool_round_start' }>
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [latest] = await tx
        .select({ sequence: aiRunToolRounds.sequence })
        .from(aiRunToolRounds)
        .where(eq(aiRunToolRounds.runId, run.id))
        .orderBy(desc(aiRunToolRounds.sequence))
        .limit(1);
      const hasQuestions = event.calls.some((call) => call.gate === 'question');
      const hasApprovals = event.calls.some((call) => call.gate === 'approval');
      await tx.insert(aiRunToolRounds).values({
        id: event.roundId,
        runId: run.id,
        conversationId: run.conversationId,
        sequence: (latest?.sequence ?? -1) + 1,
        status: hasQuestions ? 'waiting_questions' : hasApprovals ? 'waiting_approvals' : 'executing',
        providerMessages: event.providerMessages,
        startedAt: hasQuestions || hasApprovals ? null : new Date(),
      });
      if (event.calls.length > 0) {
        await tx.insert(aiRunToolCalls).values(
          event.calls.map((call) => ({
            runId: run.id,
            roundId: event.roundId,
            position: call.position,
            conversationId: run.conversationId,
            toolCallId: call.id,
            toolName: call.name,
            toolArgs: call.arguments,
            classification: call.classification,
            approvalPolicy: call.approvalPolicy,
            requiredScopes: call.requiredScopes,
            status: call.gate === 'approval' ? ('pending_approval' as const) : ('created' as const),
          }))
        );
      }
      const questions = event.calls.filter((call) => call.gate === 'question');
      if (questions.length > 0) {
        await tx.insert(aiRunQuestions).values(
          questions.map((call) => ({
            runId: run.id,
            roundId: event.roundId,
            position: call.position,
            conversationId: run.conversationId,
            toolCallId: call.id,
            question: questionTextFromArgs(call.arguments),
          }))
        );
      }
    });
  }

  protected async finishToolCall(
    runId: string,
    toolCallId: string,
    toolName: string,
    result: unknown,
    error: string | null,
    rejected = false,
    resourceReferences: AIResourceReference[] = []
  ): Promise<void> {
    const now = new Date();
    const persistedResult = redactOneTimeSecretToolResult(toolName, result);
    await this.db
      .update(aiRunToolCalls)
      .set({
        status: rejected ? 'rejected' : error ? 'failed' : 'completed',
        result: persistedResult,
        resourceReferences,
        error,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(eq(aiRunToolCalls.runId, runId), eq(aiRunToolCalls.toolCallId, toolCallId)));
    await this.updateToolRoundProgress(
      runId,
      toolCallId,
      error ? { error } : appendAIResourceReferencesToModelResult(persistedResult, resourceReferences)
    );
  }

  protected async resolveMessageResourceReferences(
    conversationId: string,
    runId: string,
    content: string,
    includeChangedResources: boolean
  ): Promise<{ referenced: AIResourceReference[]; changed: AIResourceReference[] }> {
    const referencedIds = new Set(referencedAIResourceIds(content));
    if (referencedIds.size === 0 && !includeChangedResources) {
      return { referenced: [], changed: [] };
    }
    const rows = await this.db
      .select({
        runId: aiRunToolCalls.runId,
        status: aiRunToolCalls.status,
        resourceReferences: aiRunToolCalls.resourceReferences,
      })
      .from(aiRunToolCalls)
      .where(eq(aiRunToolCalls.conversationId, conversationId))
      .orderBy(asc(aiRunToolCalls.createdAt));
    const registry = new Map<string, AIResourceReference>();
    const changed = new Map<string, AIResourceReference>();
    const changedNodeIds = new Set<string>();
    for (const row of rows) {
      if (row.status !== 'completed') continue;
      for (const reference of row.resourceReferences ?? []) {
        const resolvedReference = mergeAIResourceReference(registry.get(reference.refId), reference);
        registry.set(reference.refId, resolvedReference);
        if (
          includeChangedResources &&
          row.runId === runId &&
          (reference.relation === 'created' || reference.relation === 'updated' || reference.relation === 'deleted')
        ) {
          changed.set(reference.refId, mergeAIResourceReference(changed.get(reference.refId), resolvedReference));
          if (reference.nodeId) changedNodeIds.add(reference.nodeId);
        }
      }
    }
    if (includeChangedResources && changedNodeIds.size > 0) {
      for (const reference of registry.values()) {
        if (reference.type === 'node' && changedNodeIds.has(reference.resourceId)) {
          changed.set(reference.refId, reference);
        }
      }
    }
    const referenced = [...referencedIds]
      .map((refId) => registry.get(refId))
      .filter((reference): reference is AIResourceReference => Boolean(reference));
    for (const refId of referencedIds) changed.delete(refId);
    return { referenced, changed: [...changed.values()] };
  }

  protected async updateToolRoundProgress(runId: string, toolCallId: string, modelResult: unknown): Promise<void> {
    const [current] = await this.db
      .select({ roundId: aiRunToolCalls.roundId })
      .from(aiRunToolCalls)
      .where(and(eq(aiRunToolCalls.runId, runId), eq(aiRunToolCalls.toolCallId, toolCallId)))
      .limit(1);
    if (!current?.roundId) return;
    const [round] = await this.db
      .select({ providerMessages: aiRunToolRounds.providerMessages })
      .from(aiRunToolRounds)
      .where(eq(aiRunToolRounds.id, current.roundId))
      .limit(1);
    if (round) {
      const alreadyRecorded = round.providerMessages.some(
        (message) => message.role === 'tool' && message.tool_call_id === toolCallId
      );
      if (!alreadyRecorded) {
        await this.db
          .update(aiRunToolRounds)
          .set({
            providerMessages: [
              ...round.providerMessages,
              { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(modelResult ?? null) },
            ],
            updatedAt: new Date(),
          })
          .where(eq(aiRunToolRounds.id, current.roundId));
      }
    }
    const calls = await this.db
      .select({ status: aiRunToolCalls.status })
      .from(aiRunToolCalls)
      .where(eq(aiRunToolCalls.roundId, current.roundId));
    const terminal = new Set(['completed', 'failed', 'rejected', 'stopped', 'effect_unknown']);
    if (!calls.length || calls.some((call) => !terminal.has(call.status))) return;
    const status = calls.some((call) => call.status === 'stopped')
      ? 'stopped'
      : calls.some((call) => call.status === 'failed' || call.status === 'effect_unknown')
        ? 'failed'
        : 'completed';
    const now = new Date();
    await this.db
      .update(aiRunToolRounds)
      .set({ status, completedAt: now, updatedAt: now })
      .where(eq(aiRunToolRounds.id, current.roundId));
  }

  protected async persistPendingInteraction(
    run: AIRun,
    event: Extract<WSServerMessage, { type: 'tool_approval_required' }>,
    assistantMessageId: string | null
  ): Promise<void> {
    if (event.name === 'ask_question') {
      const questions = getQuestionBatch(event);
      await this.db
        .insert(aiRunQuestions)
        .values(
          questions.map((question) => ({
            runId: run.id,
            conversationId: run.conversationId,
            toolCallId: question.id,
            question: questionTextFromArgs(question.args),
          }))
        )
        .onConflictDoNothing({ target: [aiRunQuestions.runId, aiRunQuestions.toolCallId] });
      return;
    }

    await this.recordToolCall({
      runId: run.id,
      conversationId: run.conversationId,
      assistantMessageId,
      toolCallId: event.id,
      toolName: event.name,
      toolArgs: event.arguments,
      status: 'pending_approval',
    });
  }

  protected async persistCredentialChallenge(
    run: AIRun,
    userId: string,
    event: Extract<WSServerMessage, { type: 'credential_authorization_required' }>
  ): Promise<AICredentialChallenge> {
    const roundId = event.roundId ?? (await this.findToolCallRoundId(run.id, event.id));
    const [challenge] = await this.db
      .insert(aiRunCredentialChallenges)
      .values({
        runId: run.id,
        roundId,
        conversationId: run.conversationId,
        userId,
        provider: event.provider,
        connectorId: event.connectorId,
        toolCallId: event.id,
        toolName: event.name,
      })
      .onConflictDoUpdate({
        target: [aiRunCredentialChallenges.runId, aiRunCredentialChallenges.toolCallId],
        set: {
          connectorId: event.connectorId,
          toolName: event.name,
          roundId,
          status: 'pending',
          decisionClientCommandId: null,
          resolvedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!challenge) throw new Error('Failed to persist AI credential challenge');
    return challenge;
  }

  protected async persistSetupInteraction(
    run: AIRun,
    userId: string,
    event: Extract<WSServerMessage, { type: 'tool_result' }>,
    kind: AISetupInteraction['kind'],
    payload: Record<string, unknown>
  ): Promise<AISetupInteraction> {
    const roundId = await this.findToolCallRoundId(run.id, event.id);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const [interaction] = await this.db
      .insert(aiRunSetupInteractions)
      .values({
        runId: run.id,
        roundId,
        conversationId: run.conversationId,
        userId,
        toolCallId: event.id,
        toolName: event.name,
        kind,
        payload,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [aiRunSetupInteractions.runId, aiRunSetupInteractions.toolCallId],
        set: {
          roundId,
          kind,
          payload,
          status: 'pending',
          result: null,
          resolvedByUserId: null,
          resolveClientCommandId: null,
          expiresAt,
          resolvedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!interaction) throw new Error('Failed to persist AI setup interaction');
    if (roundId) {
      await this.db
        .update(aiRunToolRounds)
        .set({ status: 'waiting_setup', updatedAt: new Date() })
        .where(eq(aiRunToolRounds.id, roundId));
    }
    return interaction;
  }

  protected async findToolCallRoundId(runId: string, toolCallId: string): Promise<string | null> {
    const [toolCall] = await this.db
      .select({ roundId: aiRunToolCalls.roundId })
      .from(aiRunToolCalls)
      .where(and(eq(aiRunToolCalls.runId, runId), eq(aiRunToolCalls.toolCallId, toolCallId)))
      .limit(1);
    return toolCall?.roundId ?? null;
  }

  protected async setConversationCheckpoint(conversationId: string, event: WSServerMessage | null): Promise<void> {
    await this.db
      .update(aiConversations)
      .set({
        checkpoint: event ? toCheckpoint(event) : null,
        updatedAt: new Date(),
      })
      .where(eq(aiConversations.id, conversationId));
  }

  protected async clearAssistantDraft(runId: string): Promise<void> {
    await this.db
      .update(aiRuns)
      .set({ assistantDraftContent: null, updatedAt: new Date() })
      .where(eq(aiRuns.id, runId));
  }

  protected async linkRunToolCallsToAssistantMessage(runId: string, assistantMessageId: string): Promise<void> {
    await this.db
      .update(aiRunToolCalls)
      .set({ assistantMessageId, updatedAt: new Date() })
      .where(and(eq(aiRunToolCalls.runId, runId), isNull(aiRunToolCalls.assistantMessageId)));
  }

  protected async linkToolCallToAssistantMessage(
    runId: string,
    toolCallId: string,
    assistantMessageId: string
  ): Promise<void> {
    await this.db
      .update(aiRunToolCalls)
      .set({ assistantMessageId, updatedAt: new Date() })
      .where(and(eq(aiRunToolCalls.runId, runId), eq(aiRunToolCalls.toolCallId, toolCallId)));
  }

  protected async appendHistoricalToolOutcomes(
    conversationId: string,
    entries: Array<{ id: string | null; message: ChatMessage }>
  ): Promise<ChatMessage[]> {
    const assistantMessageIds = entries
      .filter((entry) => entry.id && entry.message.role === 'assistant')
      .map((entry) => entry.id as string);
    if (assistantMessageIds.length === 0) return entries.map((entry) => entry.message);

    const toolCalls = await this.db
      .select({
        assistantMessageId: aiRunToolCalls.assistantMessageId,
        toolName: aiRunToolCalls.toolName,
        status: aiRunToolCalls.status,
        decision: aiRunToolCalls.decision,
        result: aiRunToolCalls.result,
        resourceReferences: aiRunToolCalls.resourceReferences,
        error: aiRunToolCalls.error,
      })
      .from(aiRunToolCalls)
      .where(
        and(
          eq(aiRunToolCalls.conversationId, conversationId),
          inArray(aiRunToolCalls.assistantMessageId, assistantMessageIds)
        )
      )
      .orderBy(asc(aiRunToolCalls.createdAt));

    const summariesByMessageId = new Map<string, string[]>();
    for (const toolCall of toolCalls) {
      if (!toolCall.assistantMessageId) continue;
      const summaries = summariesByMessageId.get(toolCall.assistantMessageId) ?? [];
      summaries.push(formatHistoricalToolOutcome(toolCall));
      summariesByMessageId.set(toolCall.assistantMessageId, summaries);
    }

    return entries.map((entry) => {
      if (!entry.id || entry.message.role !== 'assistant') return entry.message;
      const summaries = summariesByMessageId.get(entry.id);
      if (!summaries?.length) return entry.message;
      return {
        ...entry.message,
        content: `${entry.message.content}\n\n[Historical tool outcomes]\n${summaries.join('\n')}`,
      };
    });
  }

  protected async listAnsweredQuestions(runId: string): Promise<AIRunQuestion[]> {
    return this.db
      .select()
      .from(aiRunQuestions)
      .where(and(eq(aiRunQuestions.runId, runId), eq(aiRunQuestions.status, 'answered')))
      .orderBy(asc(aiRunQuestions.createdAt));
  }

  protected async loadCheckpoint(userId: string, conversationId: string) {
    const conversation = await getOwnedConversation(this.db, userId, conversationId);
    if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');
    return normalizeCheckpoint(conversation.checkpoint);
  }

  protected async updateRunStatus(runId: string, status: AIRun['status'], error?: string | null): Promise<void> {
    const now = new Date();
    const terminal =
      status === 'completed'
        ? { completedAt: now, stoppedAt: null }
        : status === 'stopped'
          ? { completedAt: null, stoppedAt: now }
          : { completedAt: null, stoppedAt: null };
    await this.db
      .update(aiRuns)
      .set({
        status,
        error: error ?? null,
        updatedAt: now,
        startedAt: status === 'running' ? now : undefined,
        ...(status === 'running' ? {} : { leaseOwner: null, leaseExpiresAt: null }),
        ...terminal,
      })
      .where(this.fencedRunWhere(runId));
  }

  protected async claimRun(run: AIRun, allowedStatuses: AIRun['status'][]): Promise<boolean> {
    const now = new Date();
    const epoch = (run.executionEpoch ?? 0) + 1;
    const leaseExpiresAt = new Date(now.getTime() + 30_000);
    const query = this.db
      .update(aiRuns)
      .set({
        status: 'running',
        executionEpoch: sql`${aiRuns.executionEpoch} + 1`,
        leaseOwner: this.leaseOwner,
        leaseExpiresAt,
        startedAt: run.startedAt ?? now,
        completedAt: null,
        stoppedAt: null,
        error: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(aiRuns.id, run.id),
          eq(aiRuns.userId, run.userId),
          eq(aiRuns.executionEpoch, run.executionEpoch ?? 0),
          inArray(aiRuns.status, allowedStatuses),
          or(isNull(aiRuns.leaseExpiresAt), lt(aiRuns.leaseExpiresAt, now), eq(aiRuns.leaseOwner, this.leaseOwner))
        )
      );
    const returning = (query as unknown as { returning?: () => Promise<Array<{ id: string }>> }).returning;
    if (typeof returning === 'function') {
      const claimed = await returning.call(query);
      if (claimed.length === 0) return false;
    } else {
      await query;
    }
    this.executionEpochs.set(run.id, epoch);
    this.startHeartbeat(run.id, epoch);
    return true;
  }

  protected startHeartbeat(runId: string, epoch: number): void {
    this.stopHeartbeat(runId);
    const timer = setInterval(() => {
      void this.db
        .update(aiRuns)
        .set({ leaseExpiresAt: new Date(Date.now() + 30_000), updatedAt: new Date() })
        .where(
          and(
            eq(aiRuns.id, runId),
            eq(aiRuns.executionEpoch, epoch),
            eq(aiRuns.leaseOwner, this.leaseOwner),
            eq(aiRuns.status, 'running')
          )
        );
    }, 10_000);
    timer.unref?.();
    this.heartbeatTimers.set(runId, timer);
  }

  protected stopHeartbeat(runId: string): void {
    const timer = this.heartbeatTimers.get(runId);
    if (timer) clearInterval(timer);
    this.heartbeatTimers.delete(runId);
  }

  protected async releaseLease(runId: string): Promise<void> {
    this.stopHeartbeat(runId);
    const epoch = this.executionEpochs.get(runId);
    this.executionEpochs.delete(runId);
    if (epoch === undefined) return;
    await this.db
      .update(aiRuns)
      .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(aiRuns.id, runId), eq(aiRuns.executionEpoch, epoch), eq(aiRuns.leaseOwner, this.leaseOwner)));
  }

  protected fencedRunWhere(runId: string) {
    const epoch = this.executionEpochs.get(runId);
    return epoch === undefined
      ? eq(aiRuns.id, runId)
      : and(eq(aiRuns.id, runId), eq(aiRuns.executionEpoch, epoch), eq(aiRuns.leaseOwner, this.leaseOwner));
  }

  protected logExecutionError(runId: string, error: unknown): void {
    logger.error('AI run execution failed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
