import { and, asc, eq, inArray } from 'drizzle-orm';
import { container } from '@/container.js';
import {
  type AIRun,
  aiRunCredentialChallenges,
  aiRunQuestions,
  aiRunToolCalls,
  aiRunToolRounds,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import { type AIContextCompactionTrigger, AIService } from './ai.service.js';
import type { ChatMessage, WSServerMessage } from './ai.types.js';
import type { AssistantLiveDraft } from './ai-live-draft-store.js';
import { AIPlanService } from './ai-plan.service.js';
import { AIRunExecutorRuntime } from './ai-run-executor.runtime.js';
import {
  type ApprovalContinuationInput,
  type CredentialContinuationInput,
  getClientAction,
  getOwnedConversation,
  getSetupInteractionKind,
  isPlanPauseBoundaryError,
  logger,
  type QuestionContinuationInput,
  type ResumeInput,
  type SetupContinuationInput,
  STEER_DEBOUNCE_MS,
  STEER_MAX_WAIT_MS,
  waitFor,
} from './ai-run-executor.shared.js';
import { isAIContinuationCommand, toPageContext } from './ai-run-runtime.helpers.js';

export * from './ai-run-executor.shared.js';

export class AIRunExecutor extends AIRunExecutorRuntime {
  startRunExecution(user: User, runId: string): void {
    if (this.executingRuns.has(runId)) return;
    this.executingRuns.add(runId);
    void this.executeRun(user, runId).catch((error) => {
      this.logExecutionError(runId, error);
    });
  }

  startPendingInputExecution(user: User, conversationId: string): void {
    if (this.pendingInputDispatches.has(conversationId)) {
      this.pendingInputRedispatches.add(conversationId);
      return;
    }
    this.pendingInputDispatches.add(conversationId);
    void this.dispatchNextPendingInput(user, conversationId)
      .catch((error) => this.logExecutionError(`pending-input:${conversationId}`, error))
      .finally(() => {
        this.pendingInputDispatches.delete(conversationId);
        if (this.pendingInputRedispatches.delete(conversationId)) {
          this.startPendingInputExecution(user, conversationId);
        }
      });
  }

  startApprovalContinuation(user: User, input: ApprovalContinuationInput): void {
    if (this.executingRuns.has(input.runId)) return;
    this.executingRuns.add(input.runId);
    void this.executeApprovalContinuation(user, input).catch((error) => {
      this.logExecutionError(input.runId, error);
    });
  }

  startToolRoundContinuation(user: User, input: { conversationId: string; runId: string; roundId: string }): void {
    if (this.executingRuns.has(input.runId)) return;
    this.executingRuns.add(input.runId);
    void this.executeToolRoundContinuation(user, input).catch((error) => {
      this.executingRuns.delete(input.runId);
      this.logExecutionError(input.runId, error);
    });
  }

  startQuestionContinuation(user: User, input: QuestionContinuationInput): void {
    if (this.executingRuns.has(input.runId)) return;
    this.executingRuns.add(input.runId);
    void this.executeQuestionContinuation(user, input).catch((error) => {
      this.logExecutionError(input.runId, error);
    });
  }

  startCredentialContinuation(user: User, input: CredentialContinuationInput): void {
    if (this.executingRuns.has(input.runId)) return;
    this.executingRuns.add(input.runId);
    void this.executeCredentialContinuation(user, input).catch((error) => {
      this.executingRuns.delete(input.runId);
      this.logExecutionError(input.runId, error);
    });
  }

  startSetupContinuation(user: User, input: SetupContinuationInput): void {
    if (this.executingRuns.has(input.runId)) return;
    this.executingRuns.add(input.runId);
    void this.executeSetupContinuation(user, input).catch((error) => {
      this.executingRuns.delete(input.runId);
      this.logExecutionError(input.runId, error);
    });
  }

  startContextCompaction(user: User, runId: string, trigger: AIContextCompactionTrigger): void {
    if (this.executingRuns.has(runId)) return;
    this.executingRuns.add(runId);
    void this.executeContextCompaction(user, runId, trigger).catch((error) => {
      this.logExecutionError(runId, error);
    });
  }

  abortRun(runId: string): void {
    this.abortControllers.get(runId)?.abort();
    this.abortControllers.delete(runId);
    this.executingRuns.delete(runId);
    this.toolBoundaryMessageIds.delete(runId);
    void this.releaseLease(runId);
  }

  async waitForIdle(deadline: number): Promise<void> {
    while ((this.executingRuns.size > 0 || this.pendingInputDispatches.size > 0) && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now())));
        timer.unref?.();
      });
    }
  }

  getAssistantDraft(runId: string): AssistantLiveDraft | null {
    return this.assistantLiveDrafts.get(runId);
  }

  async flushAssistantDraftToMessage(
    userId: string,
    conversationId: string,
    runId: string,
    fallbackContent?: string | null
  ): Promise<string | null> {
    const content = this.assistantLiveDrafts.getContent(runId, fallbackContent);
    const assistantMessageId = await this.persistAssistantMessageIfNeeded(userId, conversationId, runId, content);
    if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(runId, assistantMessageId);
    this.assistantLiveDrafts.forget(runId);
    await this.clearAssistantDraft(runId);
    return assistantMessageId;
  }

  protected async executeRun(user: User, runId: string): Promise<void> {
    const run = await this.getOwnedRun(user.id, runId);
    if (!run) throw new AppError(404, 'AI_RUN_NOT_FOUND', 'AI run not found');
    if (run.status !== 'queued') return;

    const conversation = await getOwnedConversation(this.db, user.id, run.conversationId);
    if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');

    if (!(await this.claimRun(run, ['queued']))) return;
    const abortController = new AbortController();
    this.abortControllers.set(run.id, abortController);
    this.publishConversationChanged(user.id, run.conversationId);

    const pageContext = toPageContext(conversation.lastContext);
    const aiService = container.resolve(AIService);
    const messages = await this.loadConversationMessages(run.conversationId, {
      includeHistoricalToolOutcomes: true,
    });
    if (isAIContinuationCommand(run.clientCommandId)) {
      messages.push({
        role: 'user',
        content:
          'Continue the interrupted task from the current durable state. Do not repeat successful side effects. Verify uncertain effects before acting, then complete the task and provide the final response.',
      });
    }
    let assistantContent = '';
    let assistantMessageWritten = false;

    try {
      for await (const event of aiService.streamChat(
        user,
        messages,
        pageContext,
        abortController.signal,
        run.id,
        run.conversationId,
        (currentMessages) => this.maybeAutoCompactContext(user, run, currentMessages, pageContext, abortController),
        run.model ?? undefined,
        run.reasoningEffort ?? undefined,
        (currentMessages) => this.receivePendingSteers(user, run, currentMessages, abortController.signal)
      )) {
        if (abortController.signal.aborted) return;

        const result = await this.applyRuntimeEvent({
          user,
          run,
          event,
          assistantContent,
          assistantMessageWritten,
        });
        assistantContent = result.assistantContent;
        assistantMessageWritten = result.assistantMessageWritten;
        if (result.done) return;
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (isPlanPauseBoundaryError(error)) {
        const assistantMessageId = await this.persistAssistantBoundary(
          user.id,
          run.conversationId,
          run.id,
          assistantContent
        );
        if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(run.id, assistantMessageId);
        await this.updateRunStatus(run.id, 'stopped');
        this.forgetAssistantDraftState(run.id);
        this.publishConversationChanged(user.id, run.conversationId);
        return;
      }
      const assistantMessageId = await this.persistAssistantBoundary(
        user.id,
        run.conversationId,
        run.id,
        assistantContent
      );
      if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(run.id, assistantMessageId);
      const errorMessage = error instanceof Error ? error.message : 'AI run failed';
      await this.updateRunStatus(run.id, 'failed', errorMessage);
      await this.returnPendingSteersToQueue(run.id);
      await this.persistRunErrorMessage(user.id, run.conversationId, run.id, errorMessage);
      await this.notifyFailedRun(user, run, errorMessage);
      this.forgetAssistantDraftState(run.id);
      this.publishConversationChanged(user.id, run.conversationId);
    } finally {
      this.abortControllers.delete(run.id);
      this.executingRuns.delete(run.id);
      this.toolBoundaryMessageIds.delete(run.id);
      await this.releaseLease(run.id);
    }
  }

  protected async executeApprovalContinuation(user: User, input: ApprovalContinuationInput): Promise<void> {
    const checkpoint = await this.loadCheckpoint(user.id, input.conversationId);
    const pendingApproval =
      checkpoint.pendingApproval?.id === input.toolCall.toolCallId &&
      checkpoint.pendingApproval.name === input.toolCall.toolName
        ? checkpoint.pendingApproval
        : null;
    await this.executeResume(user, {
      conversationId: input.conversationId,
      runId: input.runId,
      toolCallId: input.toolCall.toolCallId,
      toolName: input.toolCall.toolName,
      toolArgs: pendingApproval?.arguments ?? input.toolCall.toolArgs,
      approved: input.approved,
      pendingMessages: checkpoint.pendingMessages,
      queuedApprovals: checkpoint.queuedApprovals,
    });
  }

  protected async executeToolRoundContinuation(
    user: User,
    input: { conversationId: string; runId: string; roundId: string }
  ): Promise<void> {
    const [round] = await this.db
      .select()
      .from(aiRunToolRounds)
      .where(
        and(
          eq(aiRunToolRounds.id, input.roundId),
          eq(aiRunToolRounds.runId, input.runId),
          eq(aiRunToolRounds.conversationId, input.conversationId)
        )
      )
      .limit(1);
    if (!round || round.status !== 'ready') {
      this.executingRuns.delete(input.runId);
      return;
    }
    const calls = await this.db
      .select()
      .from(aiRunToolCalls)
      .where(eq(aiRunToolCalls.roundId, input.roundId))
      .orderBy(asc(aiRunToolCalls.position));
    const questions = await this.db
      .select()
      .from(aiRunQuestions)
      .where(eq(aiRunQuestions.roundId, input.roundId))
      .orderBy(asc(aiRunQuestions.position));
    const credentialChallenges = await this.db
      .select()
      .from(aiRunCredentialChallenges)
      .where(eq(aiRunCredentialChallenges.roundId, input.roundId));
    const answers = Object.fromEntries(
      questions.map((question) => [question.toolCallId, question.answer ?? 'No answer provided'])
    );
    const terminalStatuses = new Set(['completed', 'failed', 'stopped', 'effect_unknown']);
    const remainingCalls = calls.filter((call) => !terminalStatuses.has(call.status));
    const firstQuestion = questions.find((question) => question.status === 'answered');
    const firstCall = firstQuestion
      ? remainingCalls.find((call) => call.toolCallId === firstQuestion.toolCallId)
      : remainingCalls[0];
    const credentialDecisions = new Map(
      credentialChallenges.map((challenge) => [challenge.toolCallId, challenge.status === 'authorized'])
    );
    const approvalDecisions = Object.fromEntries(
      remainingCalls.map((call) => [
        call.toolCallId,
        call.status === 'rejected'
          ? false
          : credentialDecisions.has(call.toolCallId)
            ? credentialDecisions.get(call.toolCallId) === true
            : true,
      ])
    );
    const first = firstQuestion
      ? {
          id: firstQuestion.toolCallId,
          name: 'ask_question',
          args: firstCall?.toolArgs ?? {
            question: firstQuestion.question,
          },
          approved: true,
        }
      : firstCall
        ? {
            id: firstCall.toolCallId,
            name: firstCall.toolName,
            args: firstCall.toolArgs,
            approved: approvalDecisions[firstCall.toolCallId] !== false,
          }
        : null;
    if (!first) {
      this.executingRuns.delete(input.runId);
      return;
    }
    const queuedApprovals = remainingCalls
      .filter((call) => call.toolCallId !== first.id && call.toolName !== 'ask_question')
      .map((call) => ({ id: call.toolCallId, name: call.toolName, arguments: call.toolArgs }));
    await this.db
      .update(aiRunToolRounds)
      .set({ status: 'executing', startedAt: round.startedAt ?? new Date(), updatedAt: new Date() })
      .where(and(eq(aiRunToolRounds.id, input.roundId), eq(aiRunToolRounds.status, 'ready')));
    await this.executeResume(user, {
      conversationId: input.conversationId,
      runId: input.runId,
      toolCallId: first.id,
      toolName: first.name,
      toolArgs: first.args,
      approved: first.approved,
      pendingMessages: round.providerMessages,
      answers: firstQuestion ? answers : undefined,
      queuedApprovals,
      approvalDecisions,
    });
  }

  protected async executeQuestionContinuation(user: User, input: QuestionContinuationInput): Promise<void> {
    const checkpoint = await this.loadCheckpoint(user.id, input.conversationId);
    const answeredQuestions = await this.listAnsweredQuestions(input.runId);
    const answers = Object.fromEntries(
      answeredQuestions.map((question) => [question.toolCallId, question.answer ?? 'No answer provided'])
    );
    if (!answers[input.question.toolCallId]) {
      answers[input.question.toolCallId] = input.question.answer ?? 'No answer provided';
    }
    const firstQuestion = checkpoint.allQuestions[0] ?? {
      id: input.question.toolCallId,
      args: { question: input.question.question },
    };
    await this.executeResume(user, {
      conversationId: input.conversationId,
      runId: input.runId,
      toolCallId: firstQuestion.id,
      toolName: 'ask_question',
      toolArgs: firstQuestion.args,
      approved: true,
      pendingMessages: checkpoint.pendingMessages,
      answers,
      queuedApprovals: checkpoint.queuedApprovals,
    });
  }

  protected async executeCredentialContinuation(user: User, input: CredentialContinuationInput): Promise<void> {
    const checkpoint = await this.loadCheckpoint(user.id, input.conversationId);
    const pending = checkpoint.pendingCredential;
    if (
      !pending ||
      pending.id !== input.challenge.toolCallId ||
      pending.name !== input.challenge.toolName ||
      pending.connectorId !== input.challenge.connectorId
    ) {
      throw new AppError(409, 'AI_CREDENTIAL_CHECKPOINT_MISMATCH', 'Credential challenge is no longer active');
    }
    const decidedApprovals = await this.db
      .select({ toolCallId: aiRunToolCalls.toolCallId, status: aiRunToolCalls.status })
      .from(aiRunToolCalls)
      .where(and(eq(aiRunToolCalls.runId, input.runId), inArray(aiRunToolCalls.status, ['approved', 'rejected'])));
    await this.executeResume(user, {
      conversationId: input.conversationId,
      runId: input.runId,
      toolCallId: pending.id,
      toolName: pending.name,
      toolArgs: pending.arguments,
      approved: input.authorized,
      pendingMessages: checkpoint.pendingMessages,
      queuedApprovals: checkpoint.queuedApprovals,
      approvalDecisions: Object.fromEntries(
        decidedApprovals.map((call) => [call.toolCallId, call.status === 'approved'])
      ),
      rejectionError: input.authorized
        ? undefined
        : 'GITLAB_AUTHORIZATION_REJECTED: User rejected GitLab authorization.',
    });
  }

  protected async executeSetupContinuation(user: User, input: SetupContinuationInput): Promise<void> {
    if (input.interaction.status !== 'configured' && input.interaction.status !== 'cancelled') {
      this.executingRuns.delete(input.runId);
      return;
    }
    if (!input.interaction.roundId) {
      this.executingRuns.delete(input.runId);
      throw new AppError(409, 'AI_SETUP_CHECKPOINT_MISSING', 'Setup interaction continuation is unavailable');
    }

    const [round] = await this.db
      .select()
      .from(aiRunToolRounds)
      .where(
        and(
          eq(aiRunToolRounds.id, input.interaction.roundId),
          eq(aiRunToolRounds.runId, input.runId),
          eq(aiRunToolRounds.conversationId, input.conversationId)
        )
      )
      .limit(1);
    if (!round) {
      this.executingRuns.delete(input.runId);
      throw new AppError(409, 'AI_SETUP_CHECKPOINT_MISSING', 'Setup interaction continuation is unavailable');
    }

    const calls = await this.db
      .select()
      .from(aiRunToolCalls)
      .where(eq(aiRunToolCalls.roundId, round.id))
      .orderBy(asc(aiRunToolCalls.position));
    const terminalStatuses = new Set(['completed', 'failed', 'rejected', 'stopped', 'effect_unknown']);
    const remainingCalls = calls.filter(
      (call) => call.toolCallId !== input.interaction.toolCallId && !terminalStatuses.has(call.status)
    );
    const approvalDecisions = Object.fromEntries(
      remainingCalls.flatMap((call) => {
        if (
          call.toolName !== 'ask_question' &&
          (call.approvalPolicy === 'auto_approved' || call.approvalPolicy === 'system_skipped')
        ) {
          return [[call.toolCallId, true] as const];
        }
        if (call.status === 'approved' || call.status === 'rejected') {
          return [[call.toolCallId, call.status === 'approved'] as const];
        }
        return [];
      })
    );
    const result = {
      status: input.interaction.status,
      ...(input.interaction.result ?? {}),
      message:
        input.interaction.status === 'configured'
          ? 'Setup completed. Re-check the prerequisite before continuing.'
          : 'Setup was cancelled. Offer the next viable path without treating missing setup as a terminal blocker.',
    };

    await this.executeResume(user, {
      conversationId: input.conversationId,
      runId: input.runId,
      toolCallId: input.interaction.toolCallId,
      toolName: input.interaction.toolName,
      toolArgs: input.interaction.payload,
      approved: true,
      pendingMessages: round.providerMessages,
      queuedApprovals: remainingCalls.map((call) => ({
        id: call.toolCallId,
        name: call.toolName,
        arguments: call.toolArgs,
      })),
      approvalDecisions,
      precomputedResult: { result },
    });
  }

  protected async executeResume(user: User, input: ResumeInput): Promise<void> {
    const run = await this.getOwnedRun(user.id, input.runId);
    if (!run) throw new AppError(404, 'AI_RUN_NOT_FOUND', 'AI run not found');
    if (
      run.status !== 'waiting_for_approval' &&
      run.status !== 'waiting_for_answer' &&
      run.status !== 'waiting_for_credential' &&
      run.status !== 'waiting_for_setup'
    ) {
      return;
    }

    const conversation = await getOwnedConversation(this.db, user.id, input.conversationId);
    if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');

    if (
      !(await this.claimRun(run, [
        'waiting_for_approval',
        'waiting_for_answer',
        'waiting_for_credential',
        'waiting_for_setup',
        'queued',
      ]))
    ) {
      return;
    }
    const abortController = new AbortController();
    this.abortControllers.set(input.runId, abortController);
    this.publishConversationChanged(user.id, input.conversationId);

    const aiService = container.resolve(AIService);
    const pageContext = toPageContext(conversation.lastContext);
    let assistantContent = '';
    let assistantMessageWritten = false;

    try {
      for await (const event of aiService.resumeAfterApproval(
        user,
        input.toolCallId,
        input.toolName,
        input.toolArgs,
        input.approved,
        input.pendingMessages,
        pageContext,
        abortController.signal,
        input.runId,
        undefined,
        input.answers,
        input.queuedApprovals,
        input.conversationId,
        (currentMessages) => this.maybeAutoCompactContext(user, run, currentMessages, pageContext, abortController),
        input.rejectionError,
        run.model ?? undefined,
        run.reasoningEffort ?? undefined,
        input.approvalDecisions,
        (currentMessages) => this.receivePendingSteers(user, run, currentMessages, abortController.signal),
        input.precomputedResult
      )) {
        if (abortController.signal.aborted) return;

        const result = await this.applyRuntimeEvent({
          user,
          run,
          event,
          assistantContent,
          assistantMessageWritten,
        });
        assistantContent = result.assistantContent;
        assistantMessageWritten = result.assistantMessageWritten;
        if (result.done) return;
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (isPlanPauseBoundaryError(error)) {
        const assistantMessageId = await this.persistAssistantBoundary(
          user.id,
          input.conversationId,
          input.runId,
          assistantContent
        );
        if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(input.runId, assistantMessageId);
        await this.updateRunStatus(input.runId, 'stopped');
        this.forgetAssistantDraftState(input.runId);
        this.publishConversationChanged(user.id, input.conversationId);
        return;
      }
      const assistantMessageId = await this.persistAssistantBoundary(
        user.id,
        input.conversationId,
        input.runId,
        assistantContent
      );
      if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(input.runId, assistantMessageId);
      const errorMessage = error instanceof Error ? error.message : 'AI run failed';
      await this.updateRunStatus(input.runId, 'failed', errorMessage);
      await this.returnPendingSteersToQueue(input.runId);
      await this.persistRunErrorMessage(user.id, input.conversationId, input.runId, errorMessage);
      await this.notifyFailedRun(user, run, errorMessage);
      this.forgetAssistantDraftState(input.runId);
      this.publishConversationChanged(user.id, input.conversationId);
    } finally {
      this.abortControllers.delete(input.runId);
      this.executingRuns.delete(input.runId);
      this.toolBoundaryMessageIds.delete(input.runId);
      await this.releaseLease(input.runId);
    }
  }

  protected async executeContextCompaction(
    user: User,
    runId: string,
    trigger: AIContextCompactionTrigger
  ): Promise<void> {
    const run = await this.getOwnedRun(user.id, runId);
    if (!run) throw new AppError(404, 'AI_RUN_NOT_FOUND', 'AI run not found');
    if (run.status !== 'queued') return;

    const conversation = await getOwnedConversation(this.db, user.id, run.conversationId);
    if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');

    if (!(await this.claimRun(run, ['queued']))) return;
    const abortController = new AbortController();
    this.abortControllers.set(run.id, abortController);
    this.publishConversationChanged(user.id, run.conversationId);

    try {
      const messages = await this.loadConversationMessages(run.conversationId, {
        includeHistoricalToolOutcomes: true,
      });
      const pageContext = toPageContext(conversation.lastContext);
      await this.performContextCompaction(user, run, messages, pageContext, abortController, trigger, true);
      await this.updateRunStatus(run.id, 'completed');
      await this.setConversationCheckpoint(run.conversationId, null);
      this.publishConversationChanged(user.id, run.conversationId);
    } catch (error) {
      if (abortController.signal.aborted) return;
      const errorMessage = error instanceof Error ? error.message : 'Context compaction failed';
      await this.updateRunStatus(run.id, 'failed', errorMessage);
      await this.persistRunErrorMessage(user.id, run.conversationId, run.id, errorMessage);
      this.publishConversationChanged(user.id, run.conversationId);
    } finally {
      this.abortControllers.delete(run.id);
      this.executingRuns.delete(run.id);
      this.toolBoundaryMessageIds.delete(run.id);
      await this.releaseLease(run.id);
    }
  }

  protected async applyRuntimeEvent(input: {
    user: User;
    run: AIRun;
    event: WSServerMessage;
    assistantContent: string;
    assistantMessageWritten: boolean;
  }): Promise<{ assistantContent: string; assistantMessageWritten: boolean; done: boolean }> {
    let { assistantContent, assistantMessageWritten } = input;
    const { user, run, event } = input;

    if (event.type === 'text_delta') {
      assistantContent += event.content;
      const draft = this.appendAssistantDraft(run.id, run.conversationId, event.content);
      this.publishAssistantDelta(user.id, run.conversationId, run.id, event.content, draft.version);
      return { assistantContent, assistantMessageWritten, done: false };
    }

    if (event.type === 'text_reset') {
      if (!event.comment) {
        assistantContent = assistantContent.slice(0, Math.max(0, assistantContent.length - event.discardedChars));
      }
      const draft = this.assistantLiveDrafts.truncate(run.id, event.discardedChars);
      if (draft) {
        if (event.comment) {
          this.publishAssistantCommentDelta(user.id, run.conversationId, run.id, draft.content, draft.version, true);
        } else {
          this.publishAssistantDelta(user.id, run.conversationId, run.id, draft.content, draft.version, true);
        }
      }
      return { assistantContent, assistantMessageWritten, done: false };
    }

    if (event.type === 'assistant_comment_delta') {
      const draft = this.appendAssistantDraft(run.id, run.conversationId, event.content);
      this.publishAssistantCommentDelta(user.id, run.conversationId, run.id, event.content, draft.version);
      return { assistantContent, assistantMessageWritten, done: false };
    }

    if (event.type === 'assistant_comment') {
      if (!this.assistantLiveDrafts.get(run.id)) {
        const draft = this.appendAssistantDraft(run.id, run.conversationId, event.content);
        this.publishAssistantCommentDelta(user.id, run.conversationId, run.id, event.content, draft.version);
      }
      await this.persistAssistantBoundary(user.id, run.conversationId, run.id, event.content);
      this.toolBoundaryMessageIds.delete(run.id);
      this.publishAssistantCommentDone(user.id, run.conversationId, run.id);
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent: '', assistantMessageWritten: false, done: false };
    }

    if (event.type === 'tool_round_start') {
      await this.persistToolRound(run, event);
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: false };
    }

    if (event.type === 'tool_call_start') {
      if (assistantContent.trim()) {
        await this.persistAssistantBoundary(user.id, run.conversationId, run.id, assistantContent);
        assistantContent = '';
        this.toolBoundaryMessageIds.delete(run.id);
      }
      const assistantMessageId = await this.getOrCreateToolBoundaryMessage(run.conversationId, run.id);
      await this.recordToolCall({
        runId: run.id,
        conversationId: run.conversationId,
        assistantMessageId,
        toolCallId: event.id,
        toolName: event.name,
        toolArgs: event.arguments,
        status: 'running',
      });
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: false };
    }

    if (event.type === 'tool_result') {
      const clientAction = event.clientAction ?? getClientAction(event.result);
      const setupKind = getSetupInteractionKind(clientAction);
      if (clientAction && setupKind) {
        await this.persistAssistantBoundary(user.id, run.conversationId, run.id, assistantContent);
        await this.persistSetupInteraction(run, user.id, event, setupKind, clientAction);
        await this.updateRunStatus(run.id, 'waiting_for_setup');
        this.publishConversationChanged(user.id, run.conversationId);
        return { assistantContent: '', assistantMessageWritten: true, done: true };
      }
      await this.finishToolCall(
        run.id,
        event.id,
        event.name,
        event.result,
        event.error ?? null,
        event.rejected === true,
        event.resourceReferences ?? []
      );
      if (clientAction) this.publishClientAction?.(user.id, run.conversationId, run.id, clientAction);
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: false };
    }

    if (event.type === 'invalidate_stores') {
      this.publishConversationChanged(user.id, run.conversationId, event.stores);
      return { assistantContent, assistantMessageWritten, done: false };
    }

    if (event.type === 'tool_approval_required') {
      const assistantMessageId = await this.persistAssistantBoundary(
        user.id,
        run.conversationId,
        run.id,
        assistantContent
      );
      assistantMessageWritten = true;
      await this.persistPendingInteraction(run, event, assistantMessageId);
      this.conversationSearchService?.rebuildConversationIndexBestEffort(user.id, run.conversationId);
      const roundId = event.roundId ?? (await this.findToolCallRoundId(run.id, event.id));
      if (!roundId) await this.setConversationCheckpoint(run.conversationId, event);
      await this.updateRunStatus(run.id, event.name === 'ask_question' ? 'waiting_for_answer' : 'waiting_for_approval');
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: true };
    }

    if (event.type === 'credential_authorization_required') {
      const assistantMessageId = await this.persistAssistantBoundary(
        user.id,
        run.conversationId,
        run.id,
        assistantContent
      );
      assistantMessageWritten = true;
      const challenge = await this.persistCredentialChallenge(run, user.id, event);
      if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(run.id, assistantMessageId);
      if (!challenge.roundId) await this.setConversationCheckpoint(run.conversationId, event);
      await this.updateRunStatus(run.id, 'waiting_for_credential');
      this.publishCredentialChallenge?.(user.id, run.conversationId, run.id, challenge);
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: true };
    }

    if (event.type === 'error' || event.type === 'context_blocked') {
      const assistantMessageId = await this.persistAssistantBoundary(
        user.id,
        run.conversationId,
        run.id,
        assistantContent
      );
      assistantMessageWritten = true;
      if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(run.id, assistantMessageId);
      if (event.type === 'context_blocked') {
        await this.persistConversationStatus(run.conversationId, 'context_blocked', event.reason);
      }
      const errorMessage = event.type === 'error' ? event.message : event.reason;
      await this.updateRunStatus(run.id, 'failed', errorMessage);
      await this.returnPendingSteersToQueue(run.id);
      if (event.type === 'error') {
        await this.persistRunErrorMessage(user.id, run.conversationId, run.id, errorMessage);
      }
      await this.notifyFailedRun(user, run, errorMessage);
      this.forgetAssistantDraftState(run.id);
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: true };
    }

    if (event.type === 'conversation_ended') {
      const assistantMessageId = await this.persistAssistantBoundary(
        user.id,
        run.conversationId,
        run.id,
        assistantContent
      );
      assistantMessageWritten = true;
      if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(run.id, assistantMessageId);
      await this.persistConversationStatus(run.conversationId, 'ended', event.reason);
    }

    if (event.type === 'done') {
      if (!assistantMessageWritten) {
        const assistantMessageId = await this.persistAssistantBoundary(
          user.id,
          run.conversationId,
          run.id,
          assistantContent,
          true
        );
        if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(run.id, assistantMessageId);
      } else {
        await this.clearAssistantDraftState(run.id);
      }
      await this.updateRunStatus(run.id, 'completed');
      await this.setConversationCheckpoint(run.conversationId, null);
      this.forgetAssistantDraftState(run.id);
      this.publishConversationChanged(user.id, run.conversationId);
      let handledByPlan = false;
      if (this.handleCompletedRun) {
        try {
          handledByPlan = await this.handleCompletedRun(user, run);
        } catch (error) {
          logger.error('Failed to continue completed AI plan run', {
            runId: run.id,
            conversationId: run.conversationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // The plan hook can finish or pause the plan after the snapshot above went out.
        this.publishConversationChanged(user.id, run.conversationId);
      }
      if (!handledByPlan) this.startPendingInputExecution(user, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: true };
    }

    return { assistantContent, assistantMessageWritten, done: false };
  }

  protected async notifyFailedRun(user: User, run: AIRun, error: string): Promise<void> {
    if (!this.handleFailedRun) return;
    try {
      await this.handleFailedRun(user, run, error);
    } catch (failureError) {
      logger.error('Failed to pause failed AI plan run', {
        runId: run.id,
        conversationId: run.conversationId,
        error: failureError instanceof Error ? failureError.message : String(failureError),
      });
    }
  }

  protected async maybeAutoCompactContext(
    user: User,
    run: AIRun,
    messages: ChatMessage[],
    pageContext: ReturnType<typeof toPageContext>,
    abortController: AbortController
  ): Promise<ChatMessage[]> {
    if (run.planId && container.isRegistered(AIPlanService)) {
      const planService = container.resolve(AIPlanService);
      const plan = await planService.getActivePlanSnapshot(user.id, run.conversationId);
      if (plan?.id === run.planId && plan.status === 'pause_requested') {
        await planService.completePauseRequest(user.id, run.conversationId);
        this.publishConversationChanged(user.id, run.conversationId);
        throw new AppError(409, 'AI_PLAN_PAUSE_BOUNDARY', 'Plan paused at the tool-round boundary');
      }
    }
    const aiService = container.resolve(AIService);
    const shouldCompact = await aiService.shouldAutoCompactContext(
      user,
      messages,
      pageContext,
      run.conversationId,
      run.model ?? undefined,
      run.reasoningEffort ?? undefined
    );
    if (!shouldCompact) return messages;
    return this.performContextCompaction(user, run, messages, pageContext, abortController, 'auto', false);
  }

  protected async receivePendingSteers(
    user: User,
    run: AIRun,
    messages: ChatMessage[],
    signal: AbortSignal
  ): Promise<ChatMessage[]> {
    let pending = await this.listPendingSteers(run.id);
    if (pending.length === 0 || signal.aborted) return messages;

    const firstSeenAt = Math.min(...pending.map((item) => item.updatedAt.getTime()));
    while (!signal.aborted) {
      const latestUpdateAt = Math.max(...pending.map((item) => item.updatedAt.getTime()));
      const wakeAt = Math.min(latestUpdateAt + STEER_DEBOUNCE_MS, firstSeenAt + STEER_MAX_WAIT_MS);
      const remaining = wakeAt - Date.now();
      if (remaining <= 0) break;
      await waitFor(Math.min(remaining, 200), signal);
      pending = await this.listPendingSteers(run.id);
      if (pending.length === 0) return messages;
    }
    if (signal.aborted) return messages;

    const consumed = await this.consumePendingSteers(user.id, run.conversationId, run.id);
    if (consumed.length === 0) return messages;
    // The accepted steer closes the current tool group: later calls open a new boundary below it.
    this.toolBoundaryMessageIds.delete(run.id);
    this.publishConversationChanged(user.id, run.conversationId);
    this.conversationSearchService?.rebuildConversationIndexBestEffort(user.id, run.conversationId);
    return [...messages, ...consumed];
  }
}
