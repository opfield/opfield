import OpenAI from 'openai';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AccessListService } from '@/modules/access-lists/access-list.service.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import type { DatabaseConnectionService } from '@/modules/databases/databases.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import { inspectUserContainer } from '@/modules/docker/docker-internal-containers.js';
import type { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import type { DomainsService } from '@/modules/domains/domain.service.js';
import type { GroupService } from '@/modules/groups/group.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { MonitoringService } from '@/modules/monitoring/monitoring.service.js';
import type { NodesService } from '@/modules/nodes/nodes.service.js';
import type { CAService } from '@/modules/pki/ca.service.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import type { TemplatesService } from '@/modules/pki/templates.service.js';
import type { FolderService } from '@/modules/proxy/folder.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { SSLService } from '@/modules/ssl/ssl.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import { streamModelResponse } from './ai.provider-adapter.js';
import type { AISandboxService } from './ai.sandbox.service.js';
import type { AISandboxArtifactService } from './ai.sandbox-artifact.service.js';
import {
  buildPlanRuntimePrompt,
  isAIResourceAppearanceColor,
  logger,
  type ModelTool,
  splitToolControlMetadata,
  toolOutputPreview,
} from './ai.service.runtime-helpers.js';
import { safeStringify } from './ai.service.tool-helpers.js';
import type { AISettingsService } from './ai.settings.service.js';
import { buildAISystemPromptDetailed, type SystemPromptBreakdownItem } from './ai.system-prompt.js';
import type { AIConfig, AIContextLimits, AIResourceReference, PageContext } from './ai.types.js';
import type { AIApprovalMode } from './ai-approval-policy.js';
import { directProviderContextLimits, toolOutputInlineLimits } from './ai-context-limits.js';
import { AIConversationSearchService } from './ai-conversation-search.service.js';
import type { AIPlanService } from './ai-plan.service.js';
import type { AIProviderRuntimeService, AIProviderSession } from './ai-provider-runtime.service.js';
import { appendAIResourceReferencesToModelResult, extractAIResourceReferences } from './ai-resource-references.js';
import { estimateTextTokens, estimateToolSchemaTokens } from './ai-token-estimator.js';

export {
  type AIContextCompactionResult,
  type AIContextCompactionTrigger,
  shouldEndRunAfterPlanTool,
} from './ai.service.runtime-helpers.js';
export class AIServiceCore {
  protected readonly roundInlineTokens = new Map<string, number>();
  constructor(
    protected readonly settingsService: AISettingsService,
    protected readonly caService: CAService,
    protected readonly certService: CertService,
    protected readonly templatesService: TemplatesService,
    protected readonly proxyService: ProxyService,
    protected readonly folderService: FolderService,
    protected readonly sslService: SSLService,
    protected readonly domainsService: DomainsService,
    protected readonly accessListService: AccessListService,
    protected readonly authService: AuthService,
    protected readonly auditService: AuditService,
    protected readonly monitoringService: MonitoringService,
    protected readonly nodesService: NodesService,
    protected readonly groupService: GroupService,
    protected readonly databaseService: DatabaseConnectionService,
    protected readonly dockerService: DockerManagementService,
    protected readonly notifRuleService?: import('@/modules/notifications/notification-alert-rule.service.js').NotificationAlertRuleService,
    protected readonly notifWebhookService?: import('@/modules/notifications/notification-webhook.service.js').NotificationWebhookService,
    protected readonly notifDeliveryService?: import('@/modules/notifications/notification-delivery.service.js').NotificationDeliveryService,
    protected readonly notifDispatcherService?: import('@/modules/notifications/notification-dispatcher.service.js').NotificationDispatcherService,
    protected readonly sandboxService?: AISandboxService,
    protected readonly artifactService?: AISandboxArtifactService,
    protected readonly conversationSearchService?: AIConversationSearchService,
    protected readonly providerRuntimeService?: AIProviderRuntimeService,
    protected readonly siemDestinationService?: import('@/modules/audit/siem-destination.service.js').SiemDestinationService,
    protected readonly siemDeliveryService?: import('@/modules/audit/siem-delivery.service.js').SiemDeliveryService,
    protected readonly generalSettingsService?: import('@/modules/settings/general-settings.service.js').GeneralSettingsService,
    protected readonly planService?: AIPlanService,
    protected readonly dockerSnapshotService?: DockerSnapshotService,
    protected readonly licensePolicyService?: LicensePolicyService,
    protected readonly eventBus?: EventBusService
  ) {}

  protected async resolveCurrentApprovalMode(user: User): Promise<AIApprovalMode> {
    const refreshUser = this.authService?.getUserById?.bind(this.authService);
    if (!refreshUser) return user.aiApprovalMode ?? 'normal';

    try {
      const currentUser = await refreshUser(user.id);
      if (!currentUser || currentUser.isBlocked) return 'normal';
      return currentUser.aiApprovalMode ?? 'normal';
    } catch (error) {
      logger.warn('Failed to refresh AI approval mode before tool round; requiring normal approvals', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'normal';
    }
  }

  protected async resolveProviderSession(
    user: User,
    options: Parameters<AIProviderRuntimeService['resolveSession']>[1]
  ): Promise<AIProviderSession> {
    if (this.providerRuntimeService) return this.providerRuntimeService.resolveSession(user, options);

    const config = await this.settingsService.getConfig();
    if (config.providerType === 'opfield_inference') {
      throw new AppError(503, 'AI_INFERENCE_UNAVAILABLE', 'Opfield Inference runtime is unavailable');
    }
    const apiKey = await this.settingsService.getDecryptedApiKey();
    if (!apiKey)
      throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI is not configured. An admin must set up the API key.');
    const requestedReasoningEffort = options.requestedReasoningEffort?.trim();
    if (requestedReasoningEffort && !config.allowUserReasoningEffortSelection) {
      throw new AppError(403, 'AI_REASONING_EFFORT_SELECTION_DISABLED', 'Reasoning effort selection is disabled');
    }
    if (requestedReasoningEffort && !['default', 'low', 'medium', 'high'].includes(requestedReasoningEffort)) {
      throw new AppError(
        400,
        'AI_REASONING_EFFORT_UNAVAILABLE',
        'The selected reasoning effort is unavailable for this provider'
      );
    }
    const effectiveReasoningEffort =
      requestedReasoningEffort && requestedReasoningEffort !== 'default'
        ? (requestedReasoningEffort as AIConfig['reasoningEffort'])
        : config.reasoningEffort;
    const effectiveConfig = options.preferMinimumReasoning
      ? { ...config, reasoningEffort: 'none' as const }
      : { ...config, reasoningEffort: effectiveReasoningEffort };
    const client = new OpenAI({ apiKey, baseURL: config.providerUrl || undefined });
    return {
      config: effectiveConfig,
      contextLimits: directProviderContextLimits(effectiveConfig.maxContextTokens, effectiveConfig.maxCompletionTokens),
      reasoningEffort: effectiveConfig.reasoningEffort === 'none' ? null : effectiveConfig.reasoningEffort,
      stream: (messages, tools, streamOptions) =>
        streamModelResponse({
          client,
          config: streamOptions?.maxOutputTokens
            ? {
                ...effectiveConfig,
                maxCompletionTokens: Math.min(effectiveConfig.maxCompletionTokens, streamOptions.maxOutputTokens),
              }
            : effectiveConfig,
          messages,
          tools,
          signal: options.signal,
        }),
    };
  }

  protected async getAdminInferenceModels() {
    return this.providerRuntimeService ? this.providerRuntimeService.adminModels() : [];
  }

  protected async prepareToolOutput(input: {
    userId: string;
    conversationId?: string;
    sourceRunId: string;
    sourceToolCallId: string;
    toolName: string;
    result: unknown;
    error?: string;
    contextLimits: AIContextLimits;
    systemPrompt: string;
    tools: ModelTool[];
    resourceReferences?: AIResourceReference[];
  }): Promise<{
    modelResult: unknown;
    eventResult: unknown;
    error?: string;
    clientAction?: Record<string, unknown>;
    resourceReferences: AIResourceReference[];
  }> {
    const resourceReferences = input.resourceReferences ?? [];
    if (input.error) {
      const errorResult = { error: input.error };
      return { modelResult: errorResult, eventResult: undefined, error: input.error, resourceReferences: [] };
    }

    const { modelVisible, clientAction } = splitToolControlMetadata(input.toolName, input.result);
    const format: 'json' | 'text' = typeof modelVisible === 'string' ? 'text' : 'json';
    const serialized = format === 'text' ? (modelVisible as string) : safeStringify(modelVisible);
    const estimatedTokens = estimateTextTokens(serialized);
    const limits = toolOutputInlineLimits(
      input.contextLimits,
      estimateTextTokens(input.systemPrompt),
      estimateToolSchemaTokens(input.tools)
    );

    const currentRoundTokens = this.roundInlineTokens.get(input.sourceRunId) ?? 0;
    if (
      estimatedTokens <= limits.perToolInlineLimit &&
      currentRoundTokens + estimatedTokens <= limits.roundInlineLimit
    ) {
      this.roundInlineTokens.set(input.sourceRunId, currentRoundTokens + estimatedTokens);
      return {
        modelResult: appendAIResourceReferencesToModelResult(modelVisible, resourceReferences),
        eventResult: modelVisible,
        clientAction,
        resourceReferences,
      };
    }

    if (input.toolName === 'read_tool_output' || input.toolName === 'search_tool_output') {
      const error = `TOOL_OUTPUT_INLINE_LIMIT_EXCEEDED: This bounded artifact read/search result is ${estimatedTokens} estimated tokens, above the ${limits.perToolInlineLimit} token inline limit. Retry with a smaller limitBytes or maxMatches value.`;
      return { modelResult: { error }, eventResult: undefined, error, clientAction, resourceReferences: [] };
    }

    if (!this.artifactService || !input.conversationId) {
      const error =
        'TOOL_OUTPUT_OFFLOAD_UNAVAILABLE: This result is too large to place in context and no conversation artifact store is available. Retry with pagination or narrower filters.';
      return { modelResult: { error }, eventResult: undefined, error, clientAction, resourceReferences: [] };
    }

    try {
      const descriptor = await this.artifactService.saveToolOutput({
        userId: input.userId,
        conversationId: input.conversationId,
        sourceRunId: input.sourceRunId,
        sourceToolCallId: input.sourceToolCallId,
        format,
        estimatedTokens,
        preview: toolOutputPreview(serialized),
        buffer: Buffer.from(serialized, 'utf8'),
      });
      return {
        modelResult: appendAIResourceReferencesToModelResult(descriptor, resourceReferences),
        eventResult: descriptor,
        clientAction,
        resourceReferences,
      };
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'TOOL_OUTPUT_TOO_LARGE' || error.code === 'TOOL_OUTPUT_ARTIFACT_QUOTA_EXCEEDED')
      ) {
        const message = `${error.code}: ${error.message}`;
        return {
          modelResult: {
            error: {
              code: error.code,
              message: error.message,
              retry: 'Narrow, filter, or paginate the request. Do not repeat the same unbounded call.',
            },
          },
          eventResult: undefined,
          error: message,
          clientAction,
          resourceReferences: [],
        };
      }
      throw error;
    }
  }

  protected async toolResourceReferences(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    error?: string
  ): Promise<AIResourceReference[]> {
    if (error) return [];
    let nodeSlug: string | undefined;
    let nodeLabel: string | undefined;
    let nodeAppearanceColor: AIResourceReference['appearanceColor'];
    const nodeId = typeof args.nodeId === 'string' ? args.nodeId : undefined;
    if (nodeId) {
      try {
        const node = await this.nodesService.get(nodeId);
        nodeSlug = typeof node.slug === 'string' ? node.slug : undefined;
        nodeLabel =
          (typeof node.displayName === 'string' && node.displayName.trim()) ||
          (typeof node.hostname === 'string' && node.hostname.trim()) ||
          nodeSlug;
        nodeAppearanceColor = isAIResourceAppearanceColor(node.appearanceColor) ? node.appearanceColor : undefined;
      } catch {
        // The resource result remains usable even when its parent node can no longer be resolved.
      }
    }
    const references = extractAIResourceReferences(toolName, args, result, {
      nodeSlug,
      nodeLabel,
      nodeAppearanceColor,
    });
    const unresolvedContainer = references.find(
      (reference) =>
        reference.type === 'docker_container' &&
        (reference.label === reference.resourceId || /^[a-f0-9]{12,64}$/i.test(reference.label))
    );
    const containerId = typeof args.containerId === 'string' ? args.containerId : undefined;
    if (!unresolvedContainer || !nodeId || !containerId) return references;
    try {
      const inspected = (await inspectUserContainer(this.dockerService, nodeId, containerId)) as Record<
        string,
        unknown
      >;
      const canonicalName = String(inspected.Name ?? inspected.name ?? '')
        .trim()
        .replace(/^\/+/, '');
      if (!canonicalName) return references;
      return extractAIResourceReferences(toolName, { ...args, containerName: canonicalName }, result, {
        nodeSlug,
        nodeLabel,
        nodeAppearanceColor,
      });
    } catch {
      return references;
    }
  }

  async buildSystemPrompt(user: User, pageContext?: PageContext, conversationId?: string): Promise<string> {
    return (await this.buildSystemPromptDetailed(user, pageContext, conversationId)).prompt;
  }

  protected async buildSystemPromptDetailed(
    user: User,
    pageContext?: PageContext,
    conversationId?: string
  ): Promise<{ prompt: string; breakdown: SystemPromptBreakdownItem[] }> {
    const retrievalPointers = conversationId
      ? await (this.conversationSearchService ?? container.resolve(AIConversationSearchService))
          .getPromptPointers(user.id, conversationId)
          .catch((error) => {
            logger.warn('Failed to build AI conversation retrieval pointers', {
              conversationId,
              error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
          })
      : undefined;
    const base = await buildAISystemPromptDetailed(
      {
        settingsService: this.settingsService,
        monitoringService: this.monitoringService,
        caService: this.caService,
        retrievalPointers,
      },
      user,
      pageContext
    );
    const activePlan = conversationId ? await this.planService?.getActivePlanSnapshot(user.id, conversationId) : null;
    if (!activePlan) return base;
    const planPrompt = buildPlanRuntimePrompt(activePlan);
    return {
      prompt: `${base.prompt}\n\n${planPrompt}`,
      breakdown: [
        ...base.breakdown,
        { label: 'Active plan', chars: planPrompt.length, tokens: estimateTextTokens(planPrompt) },
      ],
    };
  }
}
