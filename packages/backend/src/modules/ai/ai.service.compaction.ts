import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import {
  buildCompactionSystemPrompt,
  buildCompactionUserPrompt,
  selectCompactionBoundary,
  serializeMessagesForCompaction,
} from './ai.service.compaction-helpers.js';
import { AIServiceLifecycleTools } from './ai.service.lifecycle-tools.js';
import type { AIContextCompactionResult, AIContextCompactionTrigger } from './ai.service.runtime-helpers.js';
import { clampIntegerValue, inferDiscoveredToolsetsFromMessages, mergeToolsets } from './ai.service.tool-helpers.js';
import type { ChatMessage, PageContext } from './ai.types.js';
import {
  assertProviderInputWithinLimits,
  estimateProviderMessagesTokens,
  estimateTextTokens,
  estimateToolSchemaTokens,
} from './ai-token-estimator.js';

export class AIServiceCompaction extends AIServiceLifecycleTools {
  async compactConversationContext(
    user: User,
    clientMessages: ChatMessage[],
    pageContext: PageContext | undefined,
    signal: AbortSignal,
    trigger: AIContextCompactionTrigger,
    selectedModel?: string,
    conversationId?: string,
    selectedReasoningEffort?: string
  ): Promise<AIContextCompactionResult> {
    const provider = await this.resolveProviderSession(user, {
      requestId: `compact:${conversationId ?? 'new'}`,
      conversationId,
      requestedModel: selectedModel,
      requestedReasoningEffort: selectedReasoningEffort,
      signal,
      isCompaction: true,
    });
    const { config } = provider;
    const providerConversationMessages = await Promise.all(
      clientMessages.map((message) => this.toProviderMessage(user, message, config))
    );
    const systemPrompt = await this.buildSystemPrompt(user, pageContext, conversationId);
    const discoveredToolsets = mergeToolsets(
      (await this.getConversationDiscoveredToolsets(user, conversationId)) ?? [],
      inferDiscoveredToolsetsFromMessages(clientMessages)
    );
    const tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);
    const systemTokens = estimateProviderMessagesTokens([{ role: 'system', content: systemPrompt }]);
    const toolsTokens = estimateToolSchemaTokens(tools);
    const fixedOverheadTokens = systemTokens + toolsTokens;
    const targetTokens = Math.max(1, Math.floor(provider.contextLimits.maxInputTokens * 0.4));
    const desiredSummaryBudget = clampIntegerValue(Math.floor(targetTokens * 0.05), 512, 12_000);
    const recentBudget = Math.max(0, targetTokens - fixedOverheadTokens - desiredSummaryBudget);
    const selection = selectCompactionBoundary(clientMessages, providerConversationMessages, recentBudget);
    const preCompactionTokens = fixedOverheadTokens + estimateProviderMessagesTokens(providerConversationMessages);
    if (selection.source.length === 0) {
      if (trigger === 'auto' && preCompactionTokens > provider.contextLimits.maxInputTokens) {
        throw new AppError(
          409,
          'AI_CONTEXT_TOO_LARGE',
          'The active context exceeds the model input limit, but its minimal atomic turn cannot be compacted safely'
        );
      }
      return {
        compacted: false,
        summary: 'There is not enough older context to compact yet.',
        compactedMessageCount: 0,
        compactVersion: 2,
        compactEpoch: Math.max(0, ...clientMessages.map((message) => message.compactEpoch ?? 0)),
        compactBoundaryMessageId: null,
        sourceTokenEstimate: 0,
        resultTokenEstimate: 0,
        trigger,
        preCompactionTokens,
        reconstructedTokens: preCompactionTokens,
        targetTokens,
        targetAchieved: preCompactionTokens <= targetTokens,
      };
    }
    const compactBoundaryMessageId = selection.source.at(-1)?.id;
    if (!compactBoundaryMessageId) {
      throw new AppError(
        409,
        'AI_COMPACTION_BOUNDARY_UNKNOWN',
        'The durable compaction boundary could not be identified; reload the conversation and retry'
      );
    }

    const sourceText = serializeMessagesForCompaction(selection.source);
    const messages = [
      { role: 'system', content: buildCompactionSystemPrompt(trigger) },
      {
        role: 'user',
        content: buildCompactionUserPrompt({
          sourceText,
          sourceMessageCount: selection.source.length,
        }),
      },
    ];
    assertProviderInputWithinLimits(messages, [], provider.contextLimits);
    const targetSummaryCapacity = targetTokens - fixedOverheadTokens - selection.recentTokens;
    const softSummaryCapacity =
      provider.contextLimits.autoCompactTokenLimit - fixedOverheadTokens - selection.recentTokens;
    const summaryOutputBudget = Math.max(
      256,
      Math.min(
        desiredSummaryBudget,
        Math.max(256, targetSummaryCapacity >= 256 ? targetSummaryCapacity : softSummaryCapacity)
      )
    );

    let summary = '';
    for await (const event of provider.stream(messages, [], { maxOutputTokens: summaryOutputBudget })) {
      if (event.type === 'text_delta') {
        summary += event.content;
      } else if (event.type === 'text_reset') {
        summary = '';
      } else {
        summary = event.response.content;
      }
    }

    const cleanedSummary =
      summary.trim() || 'Older context was compacted, but the compaction model returned an empty summary.';
    const resultTokenEstimate = estimateTextTokens(cleanedSummary);
    if (resultTokenEstimate > summaryOutputBudget) {
      throw new AppError(
        409,
        'AI_COMPACTION_SUMMARY_TOO_LARGE',
        `Compaction returned ${resultTokenEstimate} estimated tokens, above its ${summaryOutputBudget} token output budget`
      );
    }

    const reconstructedMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'assistant', content: cleanedSummary },
      ...providerConversationMessages.slice(selection.source.length),
    ];
    const reconstructedTokens = estimateProviderMessagesTokens(reconstructedMessages) + estimateToolSchemaTokens(tools);
    assertProviderInputWithinLimits(reconstructedMessages, tools, provider.contextLimits);
    if (reconstructedTokens > provider.contextLimits.autoCompactTokenLimit) {
      throw new AppError(
        409,
        'AI_CONTEXT_TOO_LARGE',
        `Compacted context still requires ${reconstructedTokens} estimated tokens, above the ${provider.contextLimits.autoCompactTokenLimit} token soft limit`
      );
    }

    return {
      compacted: true,
      summary: cleanedSummary,
      compactedMessageCount: selection.source.length,
      compactVersion: 2,
      compactEpoch: Math.max(0, ...clientMessages.map((message) => message.compactEpoch ?? 0)) + 1,
      compactBoundaryMessageId,
      sourceTokenEstimate: selection.sourceTokens,
      resultTokenEstimate,
      trigger,
      preCompactionTokens,
      reconstructedTokens,
      targetTokens,
      targetAchieved: reconstructedTokens <= targetTokens,
    };
  }

  /**
   * Stream a chat completion with tool calling.
   * Yields WSServerMessage events for the WebSocket handler to forward.
   */
}
