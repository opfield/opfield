import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import { orderLatestToolRoundResults, providerMessagesToClientMessages } from './ai.service.compaction-helpers.js';
import {
  type AutoCompactContextHook,
  conversationEndReason,
  createToolRoundStartEvent,
  ensureProviderLanguageLock,
  ensureRuntimeLanguageLock,
  hasRunLanguageLock,
  isContextWindowError,
  latestToolRoundHasUserVisibleAssistantText,
  logger,
  type PendingToolCall,
  type QueuedApproval,
  type ReceivePendingSteersHook,
  SEND_COMMENT_EMPTY_ERROR,
  SEND_COMMENT_REPAIR_LIMIT,
  SEND_COMMENT_TOOL_NAME,
  shouldEndRunAfterPlanTool,
  TOOL_COMMENT_REQUIRED_MESSAGE,
} from './ai.service.runtime-helpers.js';
import { AIServiceStreaming } from './ai.service.streaming.js';
import {
  approvalDisplayArgs,
  commentToolFrom,
  discoveredToolsetsFromResult,
  latestCompactEpoch,
  mergeToolsets,
  queuedApprovalDisplayArgs,
  safeStringify,
} from './ai.service.tool-helpers.js';
import { parseAndValidateAIToolArguments, validateAIToolArguments } from './ai.tools.js';
import type { PageContext, WSServerMessage } from './ai.types.js';
import { getAIToolApprovalDecision } from './ai-approval-policy.js';
import { describeModelCallError } from './ai-model-call-retry.js';
import type { AIProviderSession } from './ai-provider-runtime.service.js';
import { assertProviderInputWithinLimits } from './ai-token-estimator.js';

export class AIServiceContinuation extends AIServiceStreaming {
  async *resumeAfterApproval(
    user: User,
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    approved: boolean,
    pendingMessages: Record<string, unknown>[],
    pageContext: PageContext | undefined,
    signal: AbortSignal,
    requestId: string,
    answer?: string,
    answers?: Record<string, string>,
    queuedApprovals: QueuedApproval[] = [],
    conversationId?: string,
    autoCompactContext?: AutoCompactContextHook,
    rejectionError?: string,
    selectedModel?: string,
    selectedReasoningEffort?: string,
    approvalDecisions: Record<string, boolean> = {},
    receivePendingSteers?: ReceivePendingSteersHook,
    precomputedResult?: {
      result: Record<string, unknown>;
      error?: string;
      rejected?: boolean;
    }
  ): AsyncGenerator<WSServerMessage> {
    let continuationProvider: AIProviderSession | undefined;
    if (precomputedResult) {
      pendingMessages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: safeStringify(precomputedResult.result),
      });
      yield {
        type: 'tool_result',
        requestId,
        id: toolCallId,
        name: toolName,
        result: precomputedResult.result,
        ...(precomputedResult.error ? { error: precomputedResult.error } : {}),
        ...(precomputedResult.rejected ? { rejected: true } : {}),
      };
    } else if (toolName === 'ask_question') {
      // Batch answers: { toolCallId: answer, ... }
      const allAnswers: Record<string, string> = { ...answers };
      if (answer) allAnswers[toolCallId] = answer;
      // Only inject answers for tool calls that don't already have a response in pendingMessages
      const existingToolResultIds = new Set(
        pendingMessages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id as string)
      );
      for (const [tcId, ans] of Object.entries(allAnswers)) {
        if (existingToolResultIds.has(tcId)) continue; // Already responded in a previous round
        const answerText = ans || 'No answer provided';
        pendingMessages.push({ role: 'tool', tool_call_id: tcId, content: JSON.stringify({ answer: answerText }) });
        yield { type: 'tool_result', requestId, id: tcId, name: 'ask_question', result: { answer: answerText } };
      }
    } else if (!approved) {
      const rejectedMessage = rejectionError ?? 'User rejected this action.';
      pendingMessages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: JSON.stringify({ error: rejectedMessage }),
      });
      yield {
        type: 'tool_result',
        requestId,
        id: toolCallId,
        name: toolName,
        result: undefined,
        error: rejectedMessage,
        rejected: true,
      };
    } else {
      const validation = validateAIToolArguments(toolName, toolArgs);
      if (!validation.ok) {
        pendingMessages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify({ error: validation.error }),
        });
        yield {
          type: 'tool_result',
          requestId,
          id: toolCallId,
          name: toolName,
          result: undefined,
          error: validation.error,
        };
      } else {
        const result = await this.executeTool(user, toolName, validation.arguments, { pageContext, conversationId });
        if (result.credentialChallenge) {
          yield {
            type: 'credential_authorization_required',
            requestId,
            id: toolCallId,
            name: toolName,
            provider: result.credentialChallenge.provider,
            connectorId: result.credentialChallenge.connectorId,
            arguments: approvalDisplayArgs(toolName, validation.arguments),
            _rawArguments: validation.arguments,
            _pendingMessages: pendingMessages,
            _queuedApprovals: queuedApprovalDisplayArgs(queuedApprovals),
          } as any;
          return;
        }
        continuationProvider = await this.resolveProviderSession(user, {
          requestId,
          conversationId,
          requestedModel: selectedModel,
          requestedReasoningEffort: selectedReasoningEffort,
          signal,
        });
        const continuationSystemPrompt = await this.buildSystemPrompt(user, pageContext, conversationId);
        const continuationTools = await this.buildModelTools(
          continuationProvider.config,
          user,
          await this.getConversationDiscoveredToolsets(user, conversationId),
          conversationId
        );
        const resourceReferences = await this.toolResourceReferences(
          toolName,
          validation.arguments,
          result.result,
          result.error
        );
        const prepared = await this.prepareToolOutput({
          userId: user.id,
          conversationId,
          sourceRunId: requestId,
          sourceToolCallId: toolCallId,
          toolName,
          result: result.result,
          error: result.error,
          contextLimits: continuationProvider.contextLimits,
          systemPrompt: continuationSystemPrompt,
          tools: continuationTools,
          resourceReferences,
        });
        pendingMessages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: safeStringify(prepared.modelResult),
        });
        yield {
          type: 'tool_result',
          requestId,
          id: toolCallId,
          name: toolName,
          result: prepared.eventResult,
          error: prepared.error,
          clientAction: prepared.clientAction,
          resourceReferences: prepared.resourceReferences,
        };
        if (result.invalidateStores.length > 0) {
          yield { type: 'invalidate_stores', requestId, stores: result.invalidateStores };
        }
        if (toolName === 'end_conversation' && !result.error) {
          yield {
            type: 'conversation_ended',
            requestId,
            reason: conversationEndReason(result.result, 'This conversation has been ended.'),
          };
          yield { type: 'done', requestId };
          return;
        }
      }
    }

    if (queuedApprovals.length > 0) {
      const [nextApproval, ...remainingApprovals] = queuedApprovals;
      if (Object.hasOwn(approvalDecisions, nextApproval.id)) {
        yield* this.resumeAfterApproval(
          user,
          nextApproval.id,
          nextApproval.name,
          nextApproval.arguments,
          approvalDecisions[nextApproval.id],
          pendingMessages,
          pageContext,
          signal,
          requestId,
          undefined,
          undefined,
          remainingApprovals,
          conversationId,
          autoCompactContext,
          undefined,
          selectedModel,
          selectedReasoningEffort,
          approvalDecisions,
          receivePendingSteers
        );
        return;
      }
      yield {
        type: 'tool_call_start',
        requestId,
        id: nextApproval.id,
        name: nextApproval.name,
        arguments: approvalDisplayArgs(nextApproval.name, nextApproval.arguments),
      };
      yield {
        type: 'tool_approval_required',
        requestId,
        id: nextApproval.id,
        name: nextApproval.name,
        arguments: approvalDisplayArgs(nextApproval.name, nextApproval.arguments),
        _rawArguments: nextApproval.arguments,
        _pendingMessages: pendingMessages,
        _queuedApprovals: queuedApprovalDisplayArgs(remainingApprovals),
      } as any;
      return;
    }

    // Continue streaming with the updated messages
    let provider: AIProviderSession;
    try {
      provider =
        continuationProvider ??
        (await this.resolveProviderSession(user, {
          requestId,
          conversationId,
          requestedModel: selectedModel,
          requestedReasoningEffort: selectedReasoningEffort,
          signal,
        }));
    } catch (error) {
      yield {
        type: 'error',
        requestId,
        message: error instanceof Error ? error.message : 'AI provider is unavailable',
      };
      yield { type: 'done', requestId };
      return;
    }
    const { config } = provider;

    pendingMessages = orderLatestToolRoundResults(pendingMessages);
    if (latestToolRoundHasUserVisibleAssistantText(pendingMessages)) {
      ensureProviderLanguageLock(pendingMessages);
    }
    let discoveredToolsets = await this.getConversationDiscoveredToolsets(user, conversationId);
    let tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);
    let runtimeMessages = providerMessagesToClientMessages(pendingMessages);
    const systemPrompt = await this.buildSystemPrompt(user, pageContext, conversationId);
    const buildProviderMessages = async () => [
      { role: 'system', content: systemPrompt },
      ...(await Promise.all(runtimeMessages.map((message) => this.toProviderMessage(user, message, config)))),
    ];
    let messages = pendingMessages;

    // Continue with remaining rounds
    const maxRounds = config.maxToolRounds;
    let roundsSinceComment = 0;
    let commentRepairAttempts = 0;
    let runLanguageLocked = hasRunLanguageLock(runtimeMessages);
    while (true) {
      if (signal.aborted) return;

      if (receivePendingSteers) runtimeMessages = await receivePendingSteers(runtimeMessages);

      if (autoCompactContext) {
        try {
          const previousCompactEpoch = latestCompactEpoch(runtimeMessages);
          runtimeMessages = await autoCompactContext(runtimeMessages);
          if (latestCompactEpoch(runtimeMessages) > previousCompactEpoch) {
            discoveredToolsets = [];
            tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);
          }
        } catch (error) {
          if (error instanceof AppError && error.code === 'AI_CONTEXT_TOO_LARGE') {
            yield { type: 'context_blocked', requestId, reason: error.message };
            yield { type: 'done', requestId };
            return;
          }
          throw error;
        }
      }
      if (runLanguageLocked) ensureRuntimeLanguageLock(runtimeMessages);
      const commentRequired = roundsSinceComment >= maxRounds;
      const activeTools = commentRequired ? commentToolFrom(tools) : tools;
      if (commentRequired && activeTools.length === 0) {
        messages = await buildProviderMessages();
        messages = [...messages, { role: 'system', content: TOOL_COMMENT_REQUIRED_MESSAGE }];
        assertProviderInputWithinLimits(messages, [], provider.contextLimits);
        yield* this.streamFinalTextResponse({ provider, messages, requestId, signal });
        return;
      }
      messages = await buildProviderMessages();
      messages = commentRequired ? [...messages, { role: 'system', content: TOOL_COMMENT_REQUIRED_MESSAGE }] : messages;
      assertProviderInputWithinLimits(messages, activeTools, provider.contextLimits);

      let contentBuffer = '';
      let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

      try {
        for await (const event of provider.stream(messages, activeTools)) {
          if (event.type === 'text_delta') {
            contentBuffer += event.content;
            yield {
              type: commentRequired ? 'assistant_comment_delta' : 'text_delta',
              requestId,
              content: event.content,
            };
          } else if (event.type === 'text_reset') {
            contentBuffer = contentBuffer.slice(0, Math.max(0, contentBuffer.length - event.discardedChars));
            yield { type: 'text_reset', requestId, discardedChars: event.discardedChars, comment: commentRequired };
          } else {
            contentBuffer = event.response.content;
            toolCalls = event.response.toolCalls;
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        const message = describeModelCallError(err);
        logger.error('AI provider error', { error: err });
        if (isContextWindowError(err)) {
          yield {
            type: 'context_blocked',
            requestId,
            reason:
              'This chat has run out of usable context and could not be compacted automatically. Clear part of the oldest context or start a new chat.',
          };
          yield { type: 'done', requestId };
          return;
        }
        yield { type: 'error', requestId, message };
        yield { type: 'done', requestId };
        return;
      }

      toolCalls = toolCalls.filter((tc) => tc.id && tc.name);
      if (toolCalls.length === 0) {
        if (commentRequired) {
          const comment = contentBuffer.trim();
          if (comment) {
            runtimeMessages.push({ role: 'assistant', content: comment });
            ensureRuntimeLanguageLock(runtimeMessages);
            runLanguageLocked = true;
            yield { type: 'assistant_comment', requestId, content: comment };
            roundsSinceComment = 0;
            commentRepairAttempts = 0;
            continue;
          }
          yield { type: 'error', requestId, message: SEND_COMMENT_EMPTY_ERROR };
          yield { type: 'done', requestId };
          return;
        }
        this.roundInlineTokens.delete(requestId);
        yield { type: 'done', requestId };
        return;
      }

      // Process tool calls
      const rawToolCalls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));

      messages.push({ role: 'assistant', content: contentBuffer || null, tool_calls: rawToolCalls });
      runtimeMessages.push({ role: 'assistant', content: contentBuffer || null, tool_calls: rawToolCalls });

      let parsedToolCalls: PendingToolCall[] = toolCalls.map((tc) => {
        const validation = parseAndValidateAIToolArguments(tc.name, tc.arguments);
        return validation.ok
          ? { ...tc, parsedArgs: validation.arguments }
          : { ...tc, parsedArgs: {}, validationError: validation.error };
      });
      if (parsedToolCalls.some((tc) => tc.name === SEND_COMMENT_TOOL_NAME)) {
        const result = this.processCommentToolCalls({ parsedToolCalls, messages, runtimeMessages, requestId });
        for (const event of result.events) yield event;
        if (result.accepted) {
          runLanguageLocked = true;
          roundsSinceComment = 0;
          commentRepairAttempts = 0;
        } else {
          commentRepairAttempts += 1;
          if (commentRepairAttempts >= SEND_COMMENT_REPAIR_LIMIT) {
            yield { type: 'error', requestId, message: SEND_COMMENT_EMPTY_ERROR };
            yield { type: 'done', requestId };
            return;
          }
        }
        continue;
      }
      this.roundInlineTokens.set(requestId, 0);
      const approvalMode = await this.resolveCurrentApprovalMode(user);
      const toolRound = createToolRoundStartEvent(requestId, parsedToolCalls, approvalMode, messages);
      yield toolRound;

      for (const tc of parsedToolCalls.filter((call) => call.validationError)) {
        const error = tc.validationError!;
        yield { type: 'tool_call_start', requestId, id: tc.id, name: tc.name, arguments: {} };
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error }) });
        runtimeMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error }) });
        yield { type: 'tool_result', requestId, id: tc.id, name: tc.name, result: undefined, error };
      }
      parsedToolCalls = parsedToolCalls.filter((call) => !call.validationError);
      if (parsedToolCalls.length === 0) continue;

      roundsSinceComment += 1;

      const questionTools2: typeof parsedToolCalls = [];
      const approvalTools2: typeof parsedToolCalls = [];
      const immediateTools2: typeof parsedToolCalls = [];

      for (const tc of parsedToolCalls) {
        if (tc.name === 'ask_question') {
          questionTools2.push(tc);
          continue;
        }
        if (getAIToolApprovalDecision(tc.name, approvalMode, tc.parsedArgs).requiresApproval) {
          approvalTools2.push(tc);
          continue;
        }
        immediateTools2.push(tc);
      }

      for (const tc of immediateTools2) {
        yield { type: 'tool_call_start', requestId, id: tc.id, name: tc.name, arguments: tc.parsedArgs };
        const result = await this.executeTool(user, tc.name, tc.parsedArgs, { pageContext, conversationId });
        if (result.credentialChallenge) {
          yield {
            type: 'credential_authorization_required',
            requestId,
            id: tc.id,
            name: tc.name,
            provider: result.credentialChallenge.provider,
            connectorId: result.credentialChallenge.connectorId,
            arguments: tc.parsedArgs,
            roundId: toolRound.roundId,
            _rawArguments: tc.parsedArgs,
            _pendingMessages: messages,
            _queuedApprovals: approvalTools2.map((approval) => ({
              id: approval.id,
              name: approval.name,
              arguments: approvalDisplayArgs(approval.name, approval.parsedArgs),
              rawArguments: approval.parsedArgs,
            })),
          } as any;
          return;
        }
        if (tc.name === 'discover_tools') {
          const activatedToolsets = discoveredToolsetsFromResult(result.result);
          if (activatedToolsets) {
            discoveredToolsets = mergeToolsets([], activatedToolsets);
            tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);
          }
        }
        const resourceReferences = await this.toolResourceReferences(
          tc.name,
          tc.parsedArgs,
          result.result,
          result.error
        );
        const prepared = await this.prepareToolOutput({
          userId: user.id,
          conversationId,
          sourceRunId: requestId,
          sourceToolCallId: tc.id,
          toolName: tc.name,
          result: result.result,
          error: result.error,
          contextLimits: provider.contextLimits,
          systemPrompt,
          tools,
          resourceReferences,
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: safeStringify(prepared.modelResult),
        });
        runtimeMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: safeStringify(prepared.modelResult),
        });
        yield {
          type: 'tool_result',
          requestId,
          id: tc.id,
          name: tc.name,
          result: prepared.eventResult,
          error: prepared.error,
          clientAction: prepared.clientAction,
          resourceReferences: prepared.resourceReferences,
        };
        if (result.invalidateStores.length > 0) {
          yield { type: 'invalidate_stores', requestId, stores: result.invalidateStores };
        }
        if (shouldEndRunAfterPlanTool(tc.name, result.result, result.error)) {
          yield { type: 'done', requestId };
          return;
        }
        if (tc.name === 'end_conversation' && !result.error) {
          yield {
            type: 'conversation_ended',
            requestId,
            reason: conversationEndReason(result.result, 'This conversation has been ended.'),
          };
          yield { type: 'done', requestId };
          return;
        }
      }

      if (questionTools2.length > 0) {
        for (const tc of questionTools2) {
          yield { type: 'tool_call_start', requestId, id: tc.id, name: tc.name, arguments: tc.parsedArgs };
        }
        const first = questionTools2[0];
        yield {
          type: 'tool_approval_required',
          requestId,
          id: first.id,
          name: 'ask_question',
          arguments: first.parsedArgs,
          roundId: toolRound.roundId,
          _pendingMessages: messages,
          _allQuestions: questionTools2.map((q) => ({ id: q.id, args: q.parsedArgs })),
          _queuedApprovals: approvalTools2.map((approval) => ({
            id: approval.id,
            name: approval.name,
            arguments: approvalDisplayArgs(approval.name, approval.parsedArgs),
            rawArguments: approval.parsedArgs,
          })),
        } as any;
        return;
      }

      if (approvalTools2.length > 0) {
        const [approvalTool2, ...queued] = approvalTools2;
        yield {
          type: 'tool_call_start',
          requestId,
          id: approvalTool2.id,
          name: approvalTool2.name,
          arguments: approvalDisplayArgs(approvalTool2.name, approvalTool2.parsedArgs),
        };
        yield {
          type: 'tool_approval_required',
          requestId,
          id: approvalTool2.id,
          name: approvalTool2.name,
          arguments: approvalDisplayArgs(approvalTool2.name, approvalTool2.parsedArgs),
          roundId: toolRound.roundId,
          _rawArguments: approvalTool2.parsedArgs,
          _pendingMessages: messages,
          _queuedApprovals: queued.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: approvalDisplayArgs(tc.name, tc.parsedArgs),
            rawArguments: tc.parsedArgs,
          })),
        } as any;
        return;
      }

      if (contentBuffer.trim()) {
        ensureRuntimeLanguageLock(runtimeMessages);
        runLanguageLocked = true;
      }
    }
  }

  protected async *streamFinalTextResponse(input: {
    provider: AIProviderSession;
    messages: Record<string, unknown>[];
    requestId: string;
    signal: AbortSignal;
  }): AsyncGenerator<WSServerMessage> {
    const { provider, messages, requestId } = input;
    try {
      for await (const event of provider.stream(messages, [])) {
        if (event.type === 'text_delta') {
          yield { type: 'text_delta', requestId, content: event.content };
        } else if (event.type === 'text_reset') {
          yield { type: 'text_reset', requestId, discardedChars: event.discardedChars, comment: false };
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      const message = describeModelCallError(err);
      logger.error('AI provider error', { error: err });
      if (isContextWindowError(err)) {
        yield {
          type: 'context_blocked',
          requestId,
          reason:
            'This chat has run out of usable context and could not be compacted automatically. Clear part of the oldest context or start a new chat.',
        };
        yield { type: 'done', requestId };
        return;
      }
      yield { type: 'error', requestId, message };
      yield { type: 'done', requestId };
      return;
    }

    yield { type: 'done', requestId };
  }

  /**
   * Get context size estimate for /context command.
   */
}
