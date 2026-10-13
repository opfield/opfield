import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import { AIServiceCompaction } from './ai.service.compaction.js';
import {
  type AutoCompactContextHook,
  conversationEndReason,
  createToolRoundStartEvent,
  ensureRuntimeLanguageLock,
  hasRunLanguageLock,
  isContextWindowError,
  logger,
  type PendingToolCall,
  type ReceivePendingSteersHook,
  SEND_COMMENT_EMPTY_ERROR,
  SEND_COMMENT_REPAIR_LIMIT,
  SEND_COMMENT_TOOL_NAME,
  shouldEndRunAfterPlanTool,
  TOOL_COMMENT_REQUIRED_MESSAGE,
} from './ai.service.runtime-helpers.js';
import {
  approvalDisplayArgs,
  commentToolFrom,
  discoveredToolsetsFromResult,
  inferDiscoveredToolsetsFromMessages,
  latestCompactEpoch,
  mergeToolsets,
  safeStringify,
} from './ai.service.tool-helpers.js';
import { parseAndValidateAIToolArguments } from './ai.tools.js';
import type { ChatMessage, PageContext, WSServerMessage } from './ai.types.js';
import { getAIToolApprovalDecision } from './ai-approval-policy.js';
import { describeModelCallError } from './ai-model-call-retry.js';
import type { AIProviderSession } from './ai-provider-runtime.service.js';
import { assertProviderInputWithinLimits } from './ai-token-estimator.js';

export abstract class AIServiceStreaming extends AIServiceCompaction {
  protected abstract streamFinalTextResponse(input: {
    provider: AIProviderSession;
    messages: Record<string, unknown>[];
    requestId: string;
    signal: AbortSignal;
  }): AsyncGenerator<WSServerMessage>;

  async *streamChat(
    user: User,
    clientMessages: ChatMessage[],
    pageContext: PageContext | undefined,
    signal: AbortSignal,
    requestId: string,
    conversationId?: string,
    autoCompactContext?: AutoCompactContextHook,
    selectedModel?: string,
    selectedReasoningEffort?: string,
    receivePendingSteers?: ReceivePendingSteersHook
  ): AsyncGenerator<WSServerMessage> {
    let provider: AIProviderSession;
    try {
      provider = await this.resolveProviderSession(user, {
        requestId,
        conversationId,
        requestedModel: selectedModel,
        requestedReasoningEffort: selectedReasoningEffort,
        signal,
      });
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

    const systemPrompt = await this.buildSystemPrompt(user, pageContext, conversationId);
    const inferredToolsets = inferDiscoveredToolsetsFromMessages(clientMessages);
    let discoveredToolsets = mergeToolsets([], inferredToolsets);
    await this.persistInferredToolsets(user, conversationId, discoveredToolsets);
    let tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);

    let runtimeMessages = clientMessages.filter(
      (message) => message.role !== 'system' || message.hiddenSystemEvent === true
    );
    const buildProviderMessages = async () => [
      { role: 'system', content: systemPrompt },
      ...(await Promise.all(runtimeMessages.map((message) => this.toProviderMessage(user, message, config)))),
    ];
    let messages: Record<string, unknown>[] = [];

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

      // If no tool calls, we're done
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
        runtimeMessages.push({ role: 'assistant', content: contentBuffer });
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

      messages.push({
        role: 'assistant',
        content: contentBuffer || null,
        tool_calls: rawToolCalls,
      });
      runtimeMessages.push({
        role: 'assistant',
        content: contentBuffer || null,
        tool_calls: rawToolCalls,
      });

      // Parse all tool args first
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

      // Separate questions, tools that require approval, and immediate tools.
      const questionTools: typeof parsedToolCalls = [];
      const approvalTools: typeof parsedToolCalls = [];
      const immediateTools: typeof parsedToolCalls = [];

      for (const tc of parsedToolCalls) {
        if (tc.name === 'ask_question') {
          questionTools.push(tc);
          continue;
        }
        if (getAIToolApprovalDecision(tc.name, approvalMode, tc.parsedArgs).requiresApproval) {
          approvalTools.push(tc);
          continue;
        }
        immediateTools.push(tc);
      }

      for (const tc of immediateTools) {
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
            _queuedApprovals: approvalTools.map((approval) => ({
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

      // Questions take priority over destructive tools — show all questions first
      if (questionTools.length > 0) {
        for (const tc of questionTools) {
          yield { type: 'tool_call_start', requestId, id: tc.id, name: tc.name, arguments: tc.parsedArgs };
        }
        // Pause with the first question; frontend will collect all answers
        const first = questionTools[0];
        yield {
          type: 'tool_approval_required',
          requestId,
          id: first.id,
          name: 'ask_question',
          arguments: first.parsedArgs,
          roundId: toolRound.roundId,
          _pendingMessages: messages,
          _allQuestions: questionTools.map((q) => ({ id: q.id, args: q.parsedArgs })),
          _queuedApprovals: approvalTools.map((approval) => ({
            id: approval.id,
            name: approval.name,
            arguments: approvalDisplayArgs(approval.name, approval.parsedArgs),
            rawArguments: approval.parsedArgs,
          })),
        } as any;
        return;
      }

      // Approval pause. Queue later approval-gated calls instead of returning fake "skipped" tool results.
      if (approvalTools.length > 0) {
        const [approvalTool, ...queued] = approvalTools;
        yield {
          type: 'tool_call_start',
          requestId,
          id: approvalTool.id,
          name: approvalTool.name,
          arguments: approvalDisplayArgs(approvalTool.name, approvalTool.parsedArgs),
        };
        yield {
          type: 'tool_approval_required',
          requestId,
          id: approvalTool.id,
          name: approvalTool.name,
          arguments: approvalDisplayArgs(approvalTool.name, approvalTool.parsedArgs),
          roundId: toolRound.roundId,
          _rawArguments: approvalTool.parsedArgs,
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

      // Continue to next round (LLM will see tool results)
      if (contentBuffer.trim()) {
        ensureRuntimeLanguageLock(runtimeMessages);
        runLanguageLocked = true;
      }
    }
  }

  /**
   * Resume streaming after a destructive tool approval/rejection.
   */
}
