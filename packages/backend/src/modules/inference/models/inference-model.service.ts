import { and, asc, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  inferenceDiscoveredModels,
  inferenceModelAccessRules,
  inferenceModelSources,
  inferenceModels,
  inferencePricingSnapshots,
  inferenceProviderConnections,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { User } from '@/types.js';
import {
  hasSpendableSubscriptionBudget,
  subscriptionBudgetRecovery,
} from '../accounting/inference-accounting.helpers.js';
import { subscriptionBudgetExhausted } from '../accounting/inference-admission-denial.js';
import type { InferenceBudgetPolicyService } from '../accounting/inference-budget-policy.js';
import type { InferenceCoreBridgeService } from '../core/inference-core-bridge.service.js';
import {
  CORE_MANAGED_METADATA_KEY,
  CORE_MODEL_METADATA_KEY,
  coreProviderRef,
} from '../core/inference-core-provider-map.js';
import type { InferenceCatalogEventsService } from '../inference-catalog-events.service.js';
import { hasTokenPrices, INFERENCE_PRICE_MISSING_WARNING } from '../inference-pricing.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import type { InferenceProviderRegistry } from '../providers/inference-provider.registry.js';
import { knownProviderModel, pricingFromDiscoveredMetadata } from '../providers/inference-provider-model-catalog.js';
import {
  detectedCapabilityState,
  effectiveSourceContract,
  effectiveTechnicalLimits,
  filterModelIdsByApiBudget,
  filterSourcesByApiUsage,
  sourceOriginMetadata,
  sourcesWithinBudgets,
  supportsFastServiceTier,
} from './inference-model.helpers.js';
import type { InferenceModelInput, InferenceModelSourceInput, InferencePricingInput } from './inference-model.types.js';
import {
  latestPricing,
  manualSourceAllowed,
  manualSourceRefusal,
  normalizePublicId,
  normalizeSystemPrompt,
  serializeDiscovered,
  validateDefaultEffort,
  validateModelInput,
  validatePricing,
  validateSourceCompatibility,
} from './inference-model.validation.js';
import type { InferenceModelAccessService } from './inference-model-access.service.js';
import { normalizeReasoningEfforts, validateReasoningMap } from './inference-reasoning.service.js';

export type { InferenceModelInput, InferenceModelSourceInput, InferencePricingInput };

@injectable()
export class InferenceModelService {
  private modelRemovedHandler?: (removedPublicId: string, replacementPublicId: string | null) => Promise<void>;

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly registry: InferenceProviderRegistry,
    private readonly access: InferenceModelAccessService,
    private readonly audit: AuditService,
    private readonly budgetPolicies: InferenceBudgetPolicyService,
    private readonly catalogEvents?: InferenceCatalogEventsService,
    private readonly coreBridge?: InferenceCoreBridgeService
  ) {}

  private async coreReady(): Promise<boolean> {
    return this.coreBridge ? this.coreBridge.coreReady() : false;
  }

  setModelRemovedHandler(
    handler: (removedPublicId: string, replacementPublicId: string | null) => Promise<void>
  ): void {
    this.modelRemovedHandler = handler;
  }

  async listAdmin() {
    const models = await this.db
      .select()
      .from(inferenceModels)
      .orderBy(asc(inferenceModels.sortOrder), asc(inferenceModels.publicId));
    return Promise.all(models.map((model) => this.serializeModel(model)));
  }

  async getAdmin(modelId: string) {
    return this.serializeModel(await this.requireModel(modelId));
  }

  async create(userId: string, input: InferenceModelInput) {
    validateModelInput(input);
    const efforts = normalizeReasoningEfforts(input.reasoningEfforts);
    validateDefaultEffort(efforts, input.defaultReasoningEffort);
    const [lastModel] = await this.db
      .select({ sortOrder: inferenceModels.sortOrder })
      .from(inferenceModels)
      .orderBy(desc(inferenceModels.sortOrder))
      .limit(1);
    const [model] = await this.db
      .insert(inferenceModels)
      .values({
        ...input,
        publicId: normalizePublicId(input.publicId),
        displayName: input.displayName.trim(),
        reasoningEfforts: efforts,
        defaultReasoningEffort: input.defaultReasoningEffort ?? null,
        systemPrompt: normalizeSystemPrompt(input.systemPrompt),
        systemPromptMode: input.systemPromptMode ?? 'append',
        sortOrder: (lastModel?.sortOrder ?? -1) + 1,
        subscriptionMultiplier: String(input.subscriptionMultiplier),
        enabled: false,
        createdBy: userId,
      })
      .returning();
    await this.changed(userId, 'inference.model.create', model.id, { publicId: model.publicId });
    return this.serializeModel(model);
  }

  async update(userId: string, modelId: string, input: Partial<InferenceModelInput> & { enabled?: boolean }) {
    const model = await this.requireModel(modelId);
    const next: InferenceModelInput = {
      publicId: input.publicId ?? model.publicId,
      displayName: input.displayName ?? model.displayName,
      contextWindow: input.contextWindow ?? model.contextWindow,
      maxInputTokens: input.maxInputTokens ?? model.maxInputTokens,
      maxOutputTokens: input.maxOutputTokens === undefined ? model.maxOutputTokens : input.maxOutputTokens,
      autoCompactTokenLimit: input.autoCompactTokenLimit ?? model.autoCompactTokenLimit,
      modalities: input.modalities ?? model.modalities,
      capabilities: input.capabilities ?? model.capabilities,
      reasoningEfforts: input.reasoningEfforts ?? model.reasoningEfforts,
      defaultReasoningEffort:
        input.defaultReasoningEffort === undefined ? model.defaultReasoningEffort : input.defaultReasoningEffort,
      systemPrompt: input.systemPrompt === undefined ? model.systemPrompt : normalizeSystemPrompt(input.systemPrompt),
      systemPromptMode: input.systemPromptMode ?? (model.systemPromptMode as 'append' | 'replace'),
      defaultAccessAllowed: input.defaultAccessAllowed ?? model.defaultAccessAllowed,
      subscriptionMultiplier: input.subscriptionMultiplier ?? Number(model.subscriptionMultiplier),
    };
    validateModelInput(next);
    next.reasoningEfforts = normalizeReasoningEfforts(next.reasoningEfforts);
    validateDefaultEffort(next.reasoningEfforts, next.defaultReasoningEffort);
    if (input.enabled === true) await this.validatePublish(modelId, next);
    await this.db
      .update(inferenceModels)
      .set({
        ...next,
        publicId: normalizePublicId(next.publicId),
        displayName: next.displayName.trim(),
        subscriptionMultiplier: String(next.subscriptionMultiplier),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(inferenceModels.id, modelId));
    await this.access.invalidate();
    await this.changed(userId, 'inference.model.update', modelId, { fields: Object.keys(input) });
    return this.serializeModel(await this.requireModel(modelId));
  }

  async remove(userId: string, modelId: string): Promise<void> {
    const model = await this.requireModel(modelId);
    if (this.modelRemovedHandler) {
      const [replacement] = await this.db
        .select({ publicId: inferenceModels.publicId })
        .from(inferenceModels)
        .where(and(eq(inferenceModels.enabled, true), ne(inferenceModels.id, modelId)))
        .orderBy(asc(inferenceModels.sortOrder), asc(inferenceModels.publicId))
        .limit(1);
      await this.modelRemovedHandler(model.publicId, replacement?.publicId ?? null);
    }
    await this.db.delete(inferenceModels).where(eq(inferenceModels.id, modelId));
    await this.access.invalidate();
    await this.changed(userId, 'inference.model.delete', modelId, { publicId: model.publicId });
  }

  async reorder(userId: string, items: Array<{ id: string; sortOrder: number }>): Promise<void> {
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length || new Set(items.map((item) => item.sortOrder)).size !== items.length) {
      throw new AppError(400, 'INFERENCE_MODEL_ORDER_INVALID', 'Model IDs and sort positions must be unique');
    }
    await this.db.transaction(async (tx) => {
      const existing = await tx.select({ id: inferenceModels.id }).from(inferenceModels);
      if (existing.length !== ids.length || existing.some((model) => !ids.includes(model.id))) {
        throw new AppError(409, 'INFERENCE_MODEL_ORDER_STALE', 'Model order is stale; reload models and try again');
      }
      for (const item of items) {
        await tx
          .update(inferenceModels)
          .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
          .where(eq(inferenceModels.id, item.id));
      }
    });
    await this.changed(userId, 'inference.model.reorder', 'inference-models', { count: items.length });
  }

  async addSource(userId: string, modelId: string, input: InferenceModelSourceInput) {
    const [model, connection] = await Promise.all([
      this.requireModel(modelId),
      this.db.query.inferenceProviderConnections.findFirst({
        where: and(
          eq(inferenceProviderConnections.id, input.connectionId),
          isNull(inferenceProviderConnections.deletedAt)
        ),
      }),
    ]);
    if (!connection) throw new AppError(404, 'INFERENCE_PROVIDER_NOT_FOUND', 'Provider connection not found');
    const provider = this.registry.require(connection.providerId);
    const discovered = input.discoveredModelId
      ? await this.db.query.inferenceDiscoveredModels.findFirst({
          where: and(
            eq(inferenceDiscoveredModels.id, input.discoveredModelId),
            eq(inferenceDiscoveredModels.connectionId, connection.id)
          ),
        })
      : null;
    if (input.discoveredModelId && !discovered) {
      throw new AppError(
        400,
        'INFERENCE_DISCOVERED_MODEL_INVALID',
        'Discovered model does not belong to the connection'
      );
    }
    if (!discovered && !manualSourceAllowed(connection.syncStatus, provider.modelsPath, input.manualMetadata)) {
      throw await manualSourceRefusal(this.db, connection, provider.modelsPath, input.upstreamModelId);
    }
    const upstreamModelId = discovered?.remoteModelId ?? input.upstreamModelId?.trim();
    if (!upstreamModelId) throw new AppError(400, 'INFERENCE_UPSTREAM_MODEL_REQUIRED', 'Upstream model ID is required');
    const coreManaged = connection.metadata[CORE_MANAGED_METADATA_KEY] === true;
    if (!coreManaged && (await this.coreReady())) {
      throw new AppError(
        409,
        'INFERENCE_CORE_SOURCE_REQUIRED',
        'Reconnect the provider through the inference core before publishing models'
      );
    }
    if (input.enabled !== false) validateReasoningMap(model.reasoningEfforts, input.reasoningEffortMap);
    const sourceType = provider.subscription ? 'subscription' : 'api';
    const known = knownProviderModel(provider.id, upstreamModelId);
    if (input.enabled !== false) {
      validateSourceCompatibility(model, {
        modalities: discovered?.modalities ?? known?.modalities ?? ['text'],
        capabilities: input.capabilitiesOverride ?? discovered?.capabilities ?? known?.capabilities ?? {},
      });
    }
    const pricing =
      sourceType === 'api'
        ? (pricingFromDiscoveredMetadata(discovered?.metadata) ?? known?.pricing ?? input.pricing)
        : input.pricing;
    if (sourceType === 'api' && input.enabled !== false) validatePricing(pricing);
    const originMetadata = sourceOriginMetadata(provider.family, Boolean(discovered), input.manualMetadata);
    const metadata = originMetadata;

    const source = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(inferenceModelSources)
        .values({
          modelId,
          connectionId: connection.id,
          discoveredModelId: discovered?.id,
          upstreamModelId,
          ...(coreManaged
            ? {
                coreAccountId: coreProviderRef(connection),
                coreModelId: coreModelId(connection, upstreamModelId, discovered?.metadata),
              }
            : {}),
          sourceType,
          enabled: input.enabled ?? true,
          priority: 0,
          subscriptionMultiplierOverride:
            input.subscriptionMultiplierOverride === undefined || input.subscriptionMultiplierOverride === null
              ? null
              : String(input.subscriptionMultiplierOverride),
          reasoningEffortMap: input.reasoningEffortMap,
          capabilitiesOverride: input.capabilitiesOverride,
          metadata,
        })
        .returning();
      if (pricing) await insertPricing(tx, created.id, userId, pricing);
      return created;
    });
    await this.changed(userId, 'inference.model.source.create', source.id, { modelId, connectionId: connection.id });
    return this.serializeModel(await this.requireModel(modelId));
  }

  async updateSource(
    userId: string,
    sourceId: string,
    input: Partial<Pick<InferenceModelSourceInput, 'enabled' | 'reasoningEffortMap' | 'capabilitiesOverride'>>
  ) {
    const source = await this.requireSource(sourceId);
    const model = await this.requireModel(source.modelId);
    const enabled = input.enabled ?? source.enabled;
    if (enabled) {
      const connection = await this.db.query.inferenceProviderConnections.findFirst({
        where: eq(inferenceProviderConnections.id, source.connectionId),
      });
      if (!connection) throw new AppError(404, 'INFERENCE_PROVIDER_NOT_FOUND', 'Provider connection not found');
      const discovered = source.discoveredModelId
        ? await this.db.query.inferenceDiscoveredModels.findFirst({
            where: eq(inferenceDiscoveredModels.id, source.discoveredModelId),
          })
        : null;
      const known = knownProviderModel(connection.providerId, source.upstreamModelId);
      validateSourceCompatibility(model, {
        modalities: discovered?.modalities ?? known?.modalities ?? ['text'],
        capabilities:
          input.capabilitiesOverride ??
          source.capabilitiesOverride ??
          discovered?.capabilities ??
          known?.capabilities ??
          {},
      });
      validateReasoningMap(model.reasoningEfforts, input.reasoningEffortMap ?? source.reasoningEffortMap);
    }
    await this.db
      .update(inferenceModelSources)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(inferenceModelSources.id, sourceId));
    if (model.enabled) await this.validatePublish(model.id);
    await this.changed(userId, 'inference.model.source.update', sourceId, { fields: Object.keys(input) });
    return this.serializeModel(await this.requireModel(source.modelId));
  }

  async removeSource(userId: string, sourceId: string): Promise<void> {
    const source = await this.requireSource(sourceId);
    const model = await this.requireModel(source.modelId);
    if (model.enabled && source.enabled) {
      const siblings = await this.db.query.inferenceModelSources.findMany({
        where: eq(inferenceModelSources.modelId, source.modelId),
      });
      const hasAnotherPrimary = siblings.some((candidate) => candidate.id !== source.id && candidate.enabled);
      if (!hasAnotherPrimary) {
        throw new AppError(
          400,
          'INFERENCE_MODEL_SOURCE_REQUIRED',
          'A published model must keep at least one enabled primary source'
        );
      }
    }
    await this.db.delete(inferenceModelSources).where(eq(inferenceModelSources.id, sourceId));
    await this.changed(userId, 'inference.model.source.delete', sourceId, { modelId: source.modelId });
  }

  async addPricing(userId: string, sourceId: string, input: InferencePricingInput) {
    const source = await this.requireSource(sourceId);
    validatePricing(input);
    await insertPricing(this.db, sourceId, userId, input);
    await this.changed(userId, 'inference.model.pricing.create', sourceId, { version: input.version });
    return this.serializeModel(await this.requireModel(source.modelId));
  }

  async setAccess(
    userId: string,
    modelId: string,
    input: {
      mode: 'everyone' | 'selected' | 'disabled';
      subjects: Array<{ subjectType: 'group' | 'user'; subjectId: string }>;
    }
  ) {
    await this.requireModel(modelId);
    if (input.mode === 'selected' && input.subjects.length === 0) {
      throw new AppError(400, 'INFERENCE_MODEL_ACCESS_EMPTY', 'Selected access requires at least one user or group');
    }
    if (input.mode !== 'disabled') await this.validatePublish(modelId);
    const unique = new Map(input.subjects.map((subject) => [`${subject.subjectType}:${subject.subjectId}`, subject]));
    await this.db.transaction(async (tx) => {
      await tx.delete(inferenceModelAccessRules).where(eq(inferenceModelAccessRules.modelId, modelId));
      if (input.mode === 'selected') {
        await tx.insert(inferenceModelAccessRules).values(
          [...unique.values()].map((subject) => ({
            modelId,
            subjectType: subject.subjectType,
            groupId: subject.subjectType === 'group' ? subject.subjectId : null,
            userId: subject.subjectType === 'user' ? subject.subjectId : null,
            effect: 'allow' as const,
            createdBy: userId,
          }))
        );
      }
      await tx
        .update(inferenceModels)
        .set({
          enabled: input.mode !== 'disabled',
          defaultAccessAllowed: input.mode === 'everyone',
          updatedAt: new Date(),
        })
        .where(eq(inferenceModels.id, modelId));
    });
    await this.access.invalidate();
    await this.changed(userId, 'inference.model.access.update', modelId, {
      mode: input.mode,
      subjectCount: unique.size,
    });
    return this.serializeModel(await this.requireModel(modelId));
  }

  async suggestions(modelId: string) {
    const sources = await this.db
      .select({
        source: inferenceModelSources,
        connection: inferenceProviderConnections,
        discovered: inferenceDiscoveredModels,
      })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .leftJoin(inferenceDiscoveredModels, eq(inferenceModelSources.discoveredModelId, inferenceDiscoveredModels.id))
      .where(and(eq(inferenceModelSources.modelId, modelId), isNull(inferenceProviderConnections.deletedAt)));
    if (!sources.length) return [];
    const providerId = sources[0]!.connection.providerId;
    const upstreamModelId = sources[0]!.source.upstreamModelId;
    const attached = new Set(sources.map(({ source }) => `${source.connectionId}:${source.upstreamModelId}`));
    const connections = await this.db
      .select()
      .from(inferenceProviderConnections)
      .where(and(eq(inferenceProviderConnections.enabled, true), isNull(inferenceProviderConnections.deletedAt)));
    const compatibleIds = connections
      .filter((connection) => connection.providerId === providerId)
      .map((connection) => connection.id);
    if (!compatibleIds.length) return [];
    const models = await this.db
      .select()
      .from(inferenceDiscoveredModels)
      .where(
        and(
          inArray(inferenceDiscoveredModels.connectionId, compatibleIds),
          eq(inferenceDiscoveredModels.available, true)
        )
      );
    return models
      .filter(
        (model) =>
          model.remoteModelId === upstreamModelId && !attached.has(`${model.connectionId}:${model.remoteModelId}`)
      )
      .map(serializeDiscovered);
  }

  async listForUser(user: User) {
    const allowed = await this.access.allowedModelIds(user);
    if (!allowed.size) return { object: 'list', data: [] };
    const availability = await this.modelAvailabilityForUser(user.id, [...allowed]);
    if (!availability.modelIds.length) return { object: 'list', data: [] };
    const models = await this.db
      .select()
      .from(inferenceModels)
      .where(and(eq(inferenceModels.enabled, true), inArray(inferenceModels.id, availability.modelIds)))
      .orderBy(asc(inferenceModels.sortOrder), asc(inferenceModels.publicId));
    const data = await Promise.all(models.map((model) => this.publicModel(model, availability.apiUsageEnabled)));
    return { object: 'list', data };
  }

  async resolveForUser(user: User, publicId: string) {
    const model = await this.db.query.inferenceModels.findFirst({ where: eq(inferenceModels.publicId, publicId) });
    if (!model?.enabled || !(await this.access.canAccess(user, model.id))) {
      throw new InferenceProtocolError(404, 'model_not_found', `Model "${publicId}" is not available`);
    }
    const availability = await this.modelAvailabilityForUser(user.id, [model.id]);
    if (!availability.modelIds.length) {
      throw new InferenceProtocolError(404, 'model_not_found', `Model "${publicId}" is not available`);
    }
    const full = await this.serializeModel(model);
    const sources = filterSourcesByApiUsage(full.sources, availability.apiUsageEnabled);
    // Each budget gates only its own kind of source: a spent monthly API budget the API-priced ones, an overspent
    // subscription credit window the subscriptions. The request routes to what remains and is refused only when
    // nothing does (the same refusal the reservation gives).
    const limits = await this.budgetPolicies.effective(user.id);
    const usage = await this.budgetPolicies.usage(user.id, limits);
    const spent = {
      api: availability.apiUsageEnabled && usage.apiMonthlyMicrodollars >= limits.apiMonthlyMicrodollars,
      subscription: !hasSpendableSubscriptionBudget(limits, usage),
    };
    if (!spent.api && !spent.subscription) return { model, sources };
    const enabled = sources.filter((source) => source.enabled);
    const remaining = sourcesWithinBudgets(enabled, spent);
    if (remaining) return { model, sources: remaining };
    if (spent.api && enabled.some((source) => source.sourceType === 'api' && !source.priceMissing)) {
      throw new InferenceProtocolError(429, 'api_budget_exhausted', 'Inference budget exhausted', {
        recoveryAt: usage.recoveryAt.apiMonthly.toISOString(),
        dimension: 'monthly',
      });
    }
    const recovery = subscriptionBudgetRecovery(limits, usage);
    throw subscriptionBudgetExhausted(recovery?.recoveryAt ?? null, recovery?.dimension ?? null);
  }

  private async modelAvailabilityForUser(
    userId: string,
    modelIds: string[]
  ): Promise<{ modelIds: string[]; apiUsageEnabled: boolean }> {
    if (!modelIds.length) return { modelIds: [], apiUsageEnabled: false };
    const limits = await this.budgetPolicies.effective(userId);
    if (!limits.enabled) return { modelIds: [], apiUsageEnabled: false };
    const availableSources = await this.db
      .select({ modelId: inferenceModelSources.modelId, sourceType: inferenceModelSources.sourceType })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .leftJoin(inferenceDiscoveredModels, eq(inferenceModelSources.discoveredModelId, inferenceDiscoveredModels.id))
      .where(
        and(
          inArray(inferenceModelSources.modelId, modelIds),
          eq(inferenceModelSources.enabled, true),
          eq(inferenceProviderConnections.enabled, true),
          isNull(inferenceProviderConnections.deletedAt),
          or(isNull(inferenceModelSources.discoveredModelId), eq(inferenceDiscoveredModels.available, true))
        )
      );
    const availableModelIds = [...new Set(availableSources.map((source) => source.modelId))];
    if (limits.apiMonthlyMicrodollars > 0) {
      return { modelIds: availableModelIds, apiUsageEnabled: true };
    }

    return {
      modelIds: filterModelIdsByApiBudget(
        availableModelIds,
        availableSources.filter((source) => source.sourceType === 'subscription').map((source) => source.modelId),
        limits.apiMonthlyMicrodollars
      ),
      apiUsageEnabled: false,
    };
  }

  private async validatePublish(modelId: string, candidate?: InferenceModelInput) {
    const model = candidate ?? (await this.requireModel(modelId));
    const sources = await this.db
      .select({
        source: inferenceModelSources,
        connection: inferenceProviderConnections,
        discovered: inferenceDiscoveredModels,
      })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .leftJoin(inferenceDiscoveredModels, eq(inferenceModelSources.discoveredModelId, inferenceDiscoveredModels.id))
      .where(
        and(
          eq(inferenceModelSources.modelId, modelId),
          eq(inferenceModelSources.enabled, true),
          isNull(inferenceProviderConnections.deletedAt)
        )
      );
    if (!sources.length)
      throw new AppError(400, 'INFERENCE_MODEL_SOURCE_REQUIRED', 'Published model needs an enabled source');
    for (const { source, connection, discovered } of sources) {
      const known = knownProviderModel(connection.providerId, source.upstreamModelId);
      validateSourceCompatibility(model, {
        modalities: discovered?.modalities ?? known?.modalities ?? ['text'],
        capabilities: source.capabilitiesOverride ?? discovered?.capabilities ?? known?.capabilities ?? {},
      });
      validateReasoningMap(model.reasoningEfforts, source.reasoningEffortMap);
    }
    const limits = await this.safeLimits(modelId, model);
    if (model.contextWindow > limits.contextWindow || model.maxInputTokens > limits.maxInputTokens) {
      throw new AppError(400, 'INFERENCE_MODEL_LIMIT_UNSAFE', 'Published limits exceed an enabled source safe limit');
    }
  }

  private async safeLimits(
    modelId: string,
    model: Pick<InferenceModelInput, 'contextWindow' | 'maxInputTokens' | 'maxOutputTokens' | 'autoCompactTokenLimit'>,
    apiUsageEnabled = true
  ) {
    const conditions = [eq(inferenceModelSources.modelId, modelId), eq(inferenceModelSources.enabled, true)];
    if (!apiUsageEnabled) conditions.push(eq(inferenceModelSources.sourceType, 'subscription'));
    const sources = await this.db
      .select({ source: inferenceModelSources, discovered: inferenceDiscoveredModels })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .leftJoin(inferenceDiscoveredModels, eq(inferenceModelSources.discoveredModelId, inferenceDiscoveredModels.id))
      .where(and(...conditions, isNull(inferenceProviderConnections.deletedAt)));
    const technical = sources.map(({ source, discovered }) => {
      const manual = source.metadata.technical as Partial<typeof model> | undefined;
      return {
        contextWindow: manual?.contextWindow ?? discovered?.contextWindow ?? model.contextWindow,
        maxInputTokens: manual?.maxInputTokens ?? discovered?.maxInputTokens ?? model.maxInputTokens,
        maxOutputTokens: manual?.maxOutputTokens ?? discovered?.maxOutputTokens ?? model.maxOutputTokens,
        autoCompactTokenLimit:
          manual?.autoCompactTokenLimit ?? discovered?.autoCompactTokenLimit ?? model.autoCompactTokenLimit,
      };
    });
    return effectiveTechnicalLimits(technical, model);
  }

  private async publicModel(model: typeof inferenceModels.$inferSelect, apiUsageEnabled = true) {
    const [limits, sourceState] = await Promise.all([
      this.safeLimits(model.id, model, apiUsageEnabled),
      this.sourceState(model.id, model.capabilities, apiUsageEnabled),
    ]);
    return {
      id: model.publicId,
      object: 'model',
      created: Math.floor(model.createdAt.getTime() / 1000),
      owned_by: 'opfield',
      display_name: model.displayName,
      context_window: limits.contextWindow,
      max_input_tokens: limits.maxInputTokens,
      ...(limits.maxOutputTokens === null ? {} : { max_output_tokens: limits.maxOutputTokens }),
      auto_compact_token_limit: limits.autoCompactTokenLimit,
      input_modalities: model.modalities,
      capabilities: sourceState.capabilities.effective,
      supported_reasoning_efforts: model.reasoningEfforts,
      default_reasoning_effort: model.defaultReasoningEffort,
      ...(model.systemPrompt
        ? { system_prompt: { text: model.systemPrompt, mode: model.systemPromptMode as 'append' | 'replace' } }
        : {}),
      supported_service_tiers: sourceState.supportsFast ? ['priority'] : [],
    };
  }

  private async serializeModel(model: typeof inferenceModels.$inferSelect) {
    const limits = await this.safeLimits(model.id, model);
    const sources = await this.db
      .select({
        source: inferenceModelSources,
        connection: inferenceProviderConnections,
        discovered: inferenceDiscoveredModels,
      })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .leftJoin(inferenceDiscoveredModels, eq(inferenceModelSources.discoveredModelId, inferenceDiscoveredModels.id))
      .where(and(eq(inferenceModelSources.modelId, model.id), isNull(inferenceProviderConnections.deletedAt)))
      .orderBy(asc(inferenceModelSources.priority));
    const pricing = sources.length
      ? await this.db
          .select()
          .from(inferencePricingSnapshots)
          .where(
            inArray(
              inferencePricingSnapshots.sourceId,
              sources.map(({ source }) => source.id)
            )
          )
          .orderBy(desc(inferencePricingSnapshots.effectiveAt))
      : [];
    const rules = await this.db
      .select()
      .from(inferenceModelAccessRules)
      .where(eq(inferenceModelAccessRules.modelId, model.id));
    const capabilityState = detectedCapabilityState(model.capabilities, sources);
    const sourcePriceMissing = (source: typeof inferenceModelSources.$inferSelect) =>
      source.sourceType === 'api' && !hasTokenPrices(pricing.find((row) => row.sourceId === source.id));
    const unpricedSources = sources.filter(({ source }) => source.enabled && sourcePriceMissing(source)).length;
    return {
      ...model,
      // Enabled API sources with no input/output price: their requests run with an unknown cost.
      unpricedSources,
      priceWarning: unpricedSources > 0 ? INFERENCE_PRICE_MISSING_WARNING : null,
      ...limits,
      configuredCapabilities: model.capabilities,
      capabilities: capabilityState.effective,
      capabilityLimitations: capabilityState.limitations,
      accessMode: !model.enabled ? 'disabled' : model.defaultAccessAllowed ? 'everyone' : 'selected',
      accessSubjects: rules
        .filter((rule) => rule.effect === 'allow')
        .map((rule) => ({
          subjectType: rule.subjectType,
          subjectId: rule.subjectType === 'group' ? rule.groupId : rule.userId,
        }))
        .filter((subject): subject is { subjectType: 'group' | 'user'; subjectId: string } =>
          Boolean(subject.subjectId)
        ),
      subscriptionMultiplier: Number(model.subscriptionMultiplier),
      createdAt: model.createdAt.toISOString(),
      updatedAt: model.updatedAt.toISOString(),
      sources: sources.map((row) => {
        const { source, connection, discovered } = row;
        const contract = effectiveSourceContract(row);
        return {
          ...source,
          subscriptionMultiplierOverride: source.subscriptionMultiplierOverride
            ? Number(source.subscriptionMultiplierOverride)
            : null,
          providerId: connection.providerId,
          connectionName: connection.name,
          capabilities: contract.capabilities,
          reasoningEfforts: discovered?.reasoningEfforts ?? contract.known?.reasoningEfforts ?? [],
          contextWindow: discovered?.contextWindow ?? contract.known?.contextWindow ?? null,
          maxInputTokens: discovered?.maxInputTokens ?? contract.known?.maxInputTokens ?? null,
          maxOutputTokens: discovered?.maxOutputTokens ?? contract.known?.maxOutputTokens ?? null,
          autoCompactTokenLimit: discovered?.autoCompactTokenLimit ?? contract.known?.autoCompactTokenLimit ?? null,
          modalities: contract.modalities,
          pricing: latestPricing(pricing.filter((row) => row.sourceId === source.id)),
          priceMissing: sourcePriceMissing(source),
          createdAt: source.createdAt.toISOString(),
          updatedAt: source.updatedAt.toISOString(),
        };
      }),
      accessRules: rules,
    };
  }

  private async sourceState(modelId: string, configured: Record<string, boolean>, apiUsageEnabled = true) {
    const conditions = [eq(inferenceModelSources.modelId, modelId)];
    if (!apiUsageEnabled) conditions.push(eq(inferenceModelSources.sourceType, 'subscription'));
    const sources = await this.db
      .select({
        source: inferenceModelSources,
        connection: inferenceProviderConnections,
        discovered: inferenceDiscoveredModels,
      })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .leftJoin(inferenceDiscoveredModels, eq(inferenceModelSources.discoveredModelId, inferenceDiscoveredModels.id))
      .where(and(...conditions, isNull(inferenceProviderConnections.deletedAt)));
    return {
      capabilities: detectedCapabilityState(configured, sources),
      supportsFast: supportsFastServiceTier(sources),
    };
  }

  private async requireModel(modelId: string) {
    const model = await this.db.query.inferenceModels.findFirst({ where: eq(inferenceModels.id, modelId) });
    if (!model) throw new AppError(404, 'INFERENCE_MODEL_NOT_FOUND', 'Inference model not found');
    return model;
  }

  private async requireSource(sourceId: string) {
    const source = await this.db.query.inferenceModelSources.findFirst({
      where: eq(inferenceModelSources.id, sourceId),
    });
    if (!source) throw new AppError(404, 'INFERENCE_MODEL_SOURCE_NOT_FOUND', 'Inference model source not found');
    return source;
  }

  private async changed(userId: string, action: string, resourceId: string, details?: Record<string, unknown>) {
    await this.audit.log({ userId, action, resourceType: 'inference_model', resourceId, details });
    this.catalogEvents?.publishCatalogChanged();
  }
}

function coreModelId(
  connection: Pick<typeof inferenceProviderConnections.$inferSelect, 'id' | 'providerId' | 'authType'>,
  upstreamModelId: string,
  metadata?: Record<string, unknown>
): string {
  const discovered = metadata?.[CORE_MODEL_METADATA_KEY];
  if (typeof discovered === 'string' && discovered.trim()) return discovered.trim();
  if (connection.authType === 'oauth') return upstreamModelId;
  const providerRef = coreProviderRef(connection);
  return upstreamModelId.startsWith(`${providerRef}/`) ? upstreamModelId : `${providerRef}/${upstreamModelId}`;
}

type TransactionLike = Pick<DrizzleClient, 'insert'>;

async function insertPricing(tx: TransactionLike, sourceId: string, userId: string, input: InferencePricingInput) {
  validatePricing(input);
  await tx.insert(inferencePricingSnapshots).values({
    sourceId,
    version: input.version.trim(),
    inputMicrodollarsPerMillion: input.inputMicrodollarsPerMillion,
    cachedInputMicrodollarsPerMillion: input.cachedInputMicrodollarsPerMillion,
    cacheWriteMicrodollarsPerMillion: input.cacheWriteMicrodollarsPerMillion,
    outputMicrodollarsPerMillion: input.outputMicrodollarsPerMillion,
    reasoningMicrodollarsPerMillion: input.reasoningMicrodollarsPerMillion,
    otherUnitPrices: input.otherUnitPrices ?? {},
    source: input.source,
    createdBy: userId,
  });
}

export const __testOnly = {
  normalizePublicId,
  validateModelInput,
  validatePricing,
  manualSourceAllowed,
  detectedCapabilityState,
  effectiveSourceContract,
  supportsFastServiceTier,
  sourceOriginMetadata,
  filterModelIdsByApiBudget,
  filterSourcesByApiUsage,
  effectiveTechnicalLimits,
};
