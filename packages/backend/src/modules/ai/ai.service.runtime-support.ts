import fs from 'node:fs/promises';
import { container } from '@/container.js';
import { hasScope, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import { findResource } from './ai.resource-search.js';
import { AIServiceCore } from './ai.service.core.js';
import {
  ensureProviderLanguageLock,
  ensureRuntimeLanguageLock,
  isToolNameAllowedForPlanState,
  logger,
  type PendingToolCall,
  SEND_COMMENT_EMPTY_ERROR,
  SEND_COMMENT_MIXED_ERROR,
  SEND_COMMENT_TOOL_NAME,
  type ToolRuntimeContext,
} from './ai.service.runtime-helpers.js';
import {
  boolArg,
  commentMessageFromArgs,
  discoveredToolsetsFromResult,
  estimateToolBreakdown,
  inferDiscoveredToolsetsFromMessages,
  mergeToolsets,
  rankToolCategories,
  stringArg,
} from './ai.service.tool-helpers.js';
import type { SystemPromptBreakdownItem } from './ai.system-prompt.js';
import { AI_TOOLS, getOpenAITools, isBaseAIToolName } from './ai.tools.js';
import type {
  AIMessageAttachment,
  ChatMessage,
  PageContext,
  ToolExecutionOptions,
  WSServerMessage,
} from './ai.types.js';
import { directProviderContextLimits } from './ai-context-limits.js';
import { AIConversationService } from './ai-conversation.service.js';
import { estimateProviderMessagesTokens, estimateTextTokens, estimateToolSchemaTokens } from './ai-token-estimator.js';

export abstract class AIServiceRuntimeSupport extends AIServiceCore {
  protected abstract executeToolInternal(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext?: ToolRuntimeContext
  ): Promise<unknown>;

  async searchResources(
    user: User,
    args: Record<string, unknown>,
    runtimeContext: { pageContext?: PageContext; conversationId?: string } = {}
  ) {
    return findResource(
      {
        executeToolInternal: (executionUser, delegatedToolName, delegatedArgs) =>
          this.executeToolInternal(executionUser, delegatedToolName, delegatedArgs, runtimeContext),
        nodesService: this.nodesService,
        dockerService: this.dockerService,
        dockerSnapshotService: this.dockerSnapshotService,
      },
      user,
      args
    );
  }

  protected async discoverTools(user: User, args: Record<string, unknown>, conversationId?: string) {
    const config = await this.settingsService.getConfig();
    const activePlan = conversationId ? await this.planService?.getActivePlanSnapshot(user.id, conversationId) : null;
    const callableNames = new Set(
      getOpenAITools(config.disabledTools, user.scopes, config.webSearchEnabled, {
        sandboxEnabled: config.sandboxEnabled,
        planningMode:
          activePlan?.status === 'drafting' ||
          activePlan?.status === 'validating' ||
          activePlan?.status === 'verifying',
      })
        .filter((tool) => isToolNameAllowedForPlanState(tool.function.name, activePlan?.status ?? null))
        .map((tool) => tool.function.name)
    );
    const requestedCategories = [
      ...(Array.isArray(args.categories)
        ? args.categories.filter((category): category is string => typeof category === 'string')
        : []),
      ...(stringArg(args.category) ? [stringArg(args.category)!] : []),
    ];
    const normalizedRequestedCategories = [
      ...new Set(requestedCategories.map((category) => category.trim()).filter(Boolean)),
    ];
    if (normalizedRequestedCategories.length > 3) {
      throw new AppError(400, 'AI_TOOL_DISCOVERY_TOO_BROAD', 'Activate at most three tool categories at a time');
    }
    const query = stringArg(args.query)?.toLowerCase();
    const includeTools = boolArg(args.includeTools);

    const callableTools = AI_TOOLS.filter((tool) => callableNames.has(tool.name) && !isBaseAIToolName(tool.name));
    const categoryMap = new Map<string, { toolCount: number; destructiveCount: number }>();

    for (const tool of callableTools) {
      const current = categoryMap.get(tool.category) ?? { toolCount: 0, destructiveCount: 0 };
      current.toolCount += 1;
      if (tool.destructive) current.destructiveCount += 1;
      categoryMap.set(tool.category, current);
    }

    const categories = [...categoryMap.entries()]
      .map(([name, summary]) => ({ name, ...summary }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const categoryNames = new Map(categories.map((category) => [category.name.toLowerCase(), category.name]));
    const explicitCategories = normalizedRequestedCategories.map((category) => {
      const matched = categoryNames.get(category.toLowerCase());
      if (!matched)
        throw new AppError(400, 'AI_TOOL_CATEGORY_UNKNOWN', `Unknown or unavailable tool category: ${category}`);
      return matched;
    });
    if (includeTools && explicitCategories.length === 0) {
      return {
        categories,
        recommendedToolsets: rankToolCategories(callableTools, query).slice(0, 3),
        totalCallableTools: callableTools.length,
        nextStep:
          'Choose one to three recommended category names, then call discover_tools with categories and includeTools:true.',
      };
    }

    const recommendedToolsets = query ? rankToolCategories(callableTools, query).slice(0, 3) : [];

    const tools = includeTools
      ? callableTools
          .filter((tool) => explicitCategories.includes(tool.category))
          .map((tool) => ({
            name: tool.name,
            category: tool.category,
            description: tool.description,
            destructive: tool.destructive,
            requiredScope: tool.requiredScope,
            invalidateStores: tool.invalidateStores,
          }))
      : undefined;

    return {
      categories:
        explicitCategories.length > 0
          ? categories.filter((category) => explicitCategories.includes(category.name))
          : categories,
      tools,
      recommendedToolsets,
      ...(includeTools ? { discoveredToolsets: explicitCategories } : {}),
      totalCallableTools: callableTools.length,
      nextStep: includeTools
        ? 'Use a visible tool for the current step. When the task moves to another step, call discover_tools again to replace this working set.'
        : query
          ? 'Choose one to three recommended category names, then call discover_tools with categories and includeTools:true.'
          : 'Use a visible base tool directly. If the category is unclear, call discover_tools with a targeted query.',
    };
  }

  protected async getConversationDiscoveredToolsets(user: User, conversationId?: string): Promise<string[]> {
    if (!conversationId) return [];
    try {
      const conversation = await container.resolve(AIConversationService).getConversation(user.id, conversationId);
      return conversation?.discoveredToolsets ?? [];
    } catch (error) {
      logger.warn('Failed to load AI conversation discovered toolsets', {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  protected async buildModelTools(
    config: { disabledTools: string[]; webSearchEnabled: boolean; sandboxEnabled: boolean },
    user: User,
    discoveredToolsets: string[],
    conversationId?: string
  ) {
    const activePlan = conversationId ? await this.planService?.getActivePlanSnapshot(user.id, conversationId) : null;
    return getOpenAITools(config.disabledTools, user.scopes, config.webSearchEnabled, {
      discoveredToolsets,
      sandboxEnabled: config.sandboxEnabled,
      planningMode:
        activePlan?.status === 'drafting' || activePlan?.status === 'validating' || activePlan?.status === 'verifying',
    }).filter((tool) => isToolNameAllowedForPlanState(tool.function.name, activePlan?.status ?? null));
  }

  protected processCommentToolCalls(input: {
    parsedToolCalls: PendingToolCall[];
    messages: Record<string, unknown>[];
    runtimeMessages: ChatMessage[];
    requestId: string;
  }): { accepted: boolean; events: WSServerMessage[] } {
    let acceptedComment = '';
    const events: WSServerMessage[] = [];

    for (const tc of input.parsedToolCalls) {
      let content: string;
      if (tc.name === SEND_COMMENT_TOOL_NAME) {
        const comment = commentMessageFromArgs(tc.parsedArgs);
        if (comment && !acceptedComment) {
          acceptedComment = comment;
          content = JSON.stringify({ ok: true, delivered: true });
        } else {
          content = JSON.stringify(
            comment ? 'Only one send_comment call is allowed at a time.' : SEND_COMMENT_EMPTY_ERROR
          );
        }
      } else {
        content = JSON.stringify(SEND_COMMENT_MIXED_ERROR);
      }

      input.messages.push({ role: 'tool', tool_call_id: tc.id, content });
      input.runtimeMessages.push({ role: 'tool', tool_call_id: tc.id, content });
    }

    if (acceptedComment) {
      input.runtimeMessages.push({ role: 'assistant', content: acceptedComment });
      input.messages = ensureProviderLanguageLock(input.messages);
      ensureRuntimeLanguageLock(input.runtimeMessages);
      events.push({ type: 'assistant_comment', requestId: input.requestId, content: acceptedComment });
    }

    return { accepted: !!acceptedComment, events };
  }

  protected async persistToolRuntimeState(
    user: User,
    options: ToolExecutionOptions,
    toolName: string,
    result: unknown
  ): Promise<void> {
    if (!options.conversationId) return;
    const discoveredToolsets = toolName === 'discover_tools' ? discoveredToolsetsFromResult(result) : undefined;

    if (!options.pageContext && discoveredToolsets === undefined) return;

    try {
      await container.resolve(AIConversationService).updateRuntimeState(user.id, options.conversationId, {
        lastContext: options.pageContext,
        discoveredToolsets,
      });
    } catch (error) {
      logger.warn('Failed to persist AI conversation runtime state', {
        conversationId: options.conversationId,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  protected async persistInferredToolsets(
    user: User,
    conversationId: string | undefined,
    discoveredToolsets: string[]
  ): Promise<void> {
    if (!conversationId) return;
    try {
      await container.resolve(AIConversationService).updateRuntimeState(user.id, conversationId, {
        discoveredToolsets,
      });
    } catch (error) {
      logger.warn('Failed to persist inferred AI conversation toolsets', {
        conversationId,
        discoveredToolsets,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  protected ensureToolScope(user: User, scope: string) {
    if (!hasScope(user.scopes, scope)) {
      throw new Error(`PERMISSION_DENIED: Missing required scope ${scope}`);
    }
  }

  protected ensureToolScopeForResource(user: User, baseScope: string, resourceId: string) {
    if (!hasScopeForResource(user.scopes, baseScope, resourceId)) {
      throw new Error(`PERMISSION_DENIED: Missing required scope ${baseScope}:${resourceId}`);
    }
  }

  protected async toProviderMessage(user: User, message: ChatMessage, config: { supportsImages: boolean }) {
    const steerPrefix = message.steer
      ? 'User clarification received while you were working. Apply it to the remaining work without stopping unless explicitly requested:\n\n'
      : '';
    const msg: Record<string, unknown> = {
      role: message.role,
      content: message.steer ? `${steerPrefix}${message.content ?? ''}` : message.content,
    };
    if (message.role === 'user' && config.supportsImages && message.attachments?.length && this.artifactService) {
      const parts: Array<Record<string, unknown>> = [];
      if (message.content || message.steer) {
        parts.push({ type: 'text', text: `${steerPrefix}${message.content ?? ''}` });
      }
      const imageParts: Array<Record<string, unknown> | null> = await Promise.all(
        message.attachments
          .filter((attachment) => attachment.kind === 'image')
          .map((attachment) => this.attachmentToImagePart(user.id, attachment))
      );
      parts.push(...imageParts.filter((part): part is Record<string, unknown> => part !== null));
      if (parts.length > 0) msg.content = parts;
    }
    if (message.tool_calls) msg.tool_calls = message.tool_calls;
    if (message.tool_call_id) msg.tool_call_id = message.tool_call_id;
    if (message.name) msg.name = message.name;
    return msg;
  }

  protected async attachmentToImagePart(
    userId: string,
    attachment: AIMessageAttachment
  ): Promise<Record<string, unknown> | null> {
    if (!attachment.mediaType.startsWith('image/')) return null;
    try {
      const artifact = await this.artifactService?.getDownload(userId, attachment.artifactId);
      if (!artifact) return null;
      const buffer = await fs.readFile(artifact.filePath);
      const dataUrl = `data:${artifact.metadata.mediaType};base64,${buffer.toString('base64')}`;
      return { type: 'image_url', image_url: { url: dataUrl } };
    } catch (error) {
      logger.warn('Failed to attach AI message image artifact', {
        artifactId: attachment.artifactId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async shouldAutoCompactContext(
    user: User,
    clientMessages: ChatMessage[],
    pageContext: PageContext | undefined,
    conversationId?: string,
    selectedModel?: string,
    selectedReasoningEffort?: string
  ): Promise<boolean> {
    const provider = await this.resolveProviderSession(user, {
      requestId: `context-estimate:${conversationId ?? 'new'}`,
      conversationId,
      requestedModel: selectedModel,
      requestedReasoningEffort: selectedReasoningEffort,
      signal: new AbortController().signal,
    });
    const { config } = provider;
    const systemPrompt = await this.buildSystemPrompt(user, pageContext, conversationId);
    const discoveredToolsets = mergeToolsets(
      (await this.getConversationDiscoveredToolsets(user, conversationId)) ?? [],
      inferDiscoveredToolsetsFromMessages(clientMessages)
    );
    const tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);
    const providerMessages = [
      { role: 'system', content: systemPrompt },
      ...(await Promise.all(clientMessages.map((message) => this.toProviderMessage(user, message, config)))),
    ];
    const toolsTokens = estimateToolSchemaTokens(tools);
    const totalTokens = estimateProviderMessagesTokens(providerMessages) + toolsTokens;
    return totalTokens >= provider.contextLimits.autoCompactTokenLimit;
  }

  async getContextEstimate(
    user: User,
    pageContext?: PageContext,
    conversationId?: string,
    selectedModel?: string,
    selectedReasoningEffort?: string,
    clientMessages: ChatMessage[] = []
  ): Promise<{
    chatTokens: number;
    messageCount: number;
    systemTokens: number;
    toolsTokens: number;
    totalOverhead: number;
    limit: number;
    reasoningEffort: string;
    toolCount: number;
    systemBreakdown: SystemPromptBreakdownItem[];
    toolBreakdown: Array<{ label: string; chars: number; tokens: number }>;
  }> {
    const storedConfig = await this.settingsService.getConfig();
    let config = storedConfig;
    let reasoningEffort: string = storedConfig.reasoningEffort;
    let contextLimits = directProviderContextLimits(storedConfig.maxContextTokens, storedConfig.maxCompletionTokens);
    if (storedConfig.providerType === 'opfield_inference') {
      const provider = await this.resolveProviderSession(user, {
        requestId: `context-estimate:${conversationId ?? 'new'}`,
        conversationId,
        requestedModel: selectedModel,
        requestedReasoningEffort: selectedReasoningEffort,
        signal: new AbortController().signal,
      });
      config = provider.config;
      contextLimits = provider.contextLimits;
      reasoningEffort = provider.reasoningEffort ?? 'none';
    }
    const { prompt, breakdown } = await this.buildSystemPromptDetailed(user, pageContext, conversationId);
    const discoveredToolsets = mergeToolsets(
      (await this.getConversationDiscoveredToolsets(user, conversationId)) ?? [],
      inferDiscoveredToolsetsFromMessages(clientMessages)
    );
    const tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);
    const providerMessages = await Promise.all(
      clientMessages.map((message) => this.toProviderMessage(user, message, config))
    );
    const chatTokens = estimateProviderMessagesTokens(providerMessages);
    const systemTokens = estimateTextTokens(prompt);
    const toolsTokens = estimateToolSchemaTokens(tools);
    const totalOverhead = systemTokens + toolsTokens;
    const toolBreakdown = estimateToolBreakdown(tools);

    return {
      chatTokens,
      messageCount: clientMessages.length,
      systemTokens,
      toolsTokens,
      totalOverhead,
      limit: contextLimits.autoCompactTokenLimit,
      reasoningEffort,
      toolCount: tools.length,
      systemBreakdown: breakdown,
      toolBreakdown,
    };
  }
}
