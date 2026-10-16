import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
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
import {
  CORE_MANAGED_METADATA_KEY,
  CORE_MODEL_METADATA_KEY,
  coreProviderRef,
} from '../core/inference-core-provider-map.js';
import type { InferenceCatalogEventsService } from '../inference-catalog-events.service.js';
import type { InferenceProviderRegistry } from '../providers/inference-provider.registry.js';
import { knownProviderModel, pricingFromDiscoveredMetadata } from '../providers/inference-provider-model-catalog.js';
import type { InferenceModelService } from './inference-model.service.js';
import type {
  InferenceModelConfigurationInput,
  InferenceModelInput,
  InferenceModelSourceInput,
  InferencePricingInput,
} from './inference-model.types.js';
import {
  manualSourceAllowed,
  manualSourceRefusal,
  normalizePublicId,
  validateDefaultEffort,
  validateModelInput,
  validatePricing,
  validateSourceCompatibility,
} from './inference-model.validation.js';
import type { InferenceModelAccessService } from './inference-model-access.service.js';
import { normalizeReasoningEfforts, validateReasoningMap } from './inference-reasoning.service.js';

interface PreparedSource {
  connectionId: string;
  discoveredModelId: string | null;
  upstreamModelId: string;
  coreAccountId: string | null;
  coreModelId: string | null;
  providerId: string;
  sourceType: 'subscription' | 'api';
  enabled: boolean;
  subscriptionMultiplierOverride: string | null;
  reasoningEffortMap: Record<string, string>;
  capabilitiesOverride: Record<string, boolean> | null;
  metadata: Record<string, unknown>;
  pricing?: InferencePricingInput;
  safeContextWindow: number;
  safeMaxInputTokens: number;
  safeAutoCompactTokenLimit: number;
  modalities: string[];
  capabilities: Record<string, boolean>;
}

@injectable()
export class InferenceModelConfigurationService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly registry: InferenceProviderRegistry,
    private readonly models: InferenceModelService,
    private readonly access: InferenceModelAccessService,
    private readonly audit: AuditService,
    private readonly catalogEvents?: InferenceCatalogEventsService
  ) {}

  async save(userId: string, modelId: string | null, input: InferenceModelConfigurationInput) {
    const model = normalizedModel(input.model);
    validateAccess(input.access);
    const uniqueSubjects = new Map(
      input.access.subjects.map((subject) => [`${subject.subjectType}:${subject.subjectId}`, subject])
    );

    const savedId = await this.db.transaction(async (tx) => {
      const existing = modelId
        ? (await tx.select().from(inferenceModels).where(eq(inferenceModels.id, modelId)).limit(1))[0]
        : null;
      if (modelId && !existing) {
        throw new AppError(404, 'INFERENCE_MODEL_NOT_FOUND', 'Inference model not found');
      }

      const sources = await this.prepareSources(tx, model, input.sources);
      validatePublishableConfiguration(model, sources, input.access.mode);
      const enabled = input.access.mode !== 'disabled';
      const values = {
        ...model,
        publicId: normalizePublicId(model.publicId),
        displayName: model.displayName.trim(),
        subscriptionMultiplier: String(model.subscriptionMultiplier),
        enabled,
        defaultAccessAllowed: input.access.mode === 'everyone',
        updatedAt: new Date(),
      };

      let id = modelId;
      if (id) {
        await tx.update(inferenceModels).set(values).where(eq(inferenceModels.id, id));
        await tx.delete(inferenceModelAccessRules).where(eq(inferenceModelAccessRules.modelId, id));
        await tx.delete(inferenceModelSources).where(eq(inferenceModelSources.modelId, id));
      } else {
        const [lastModel] = await tx
          .select({ sortOrder: inferenceModels.sortOrder })
          .from(inferenceModels)
          .orderBy(desc(inferenceModels.sortOrder))
          .limit(1);
        const [created] = await tx
          .insert(inferenceModels)
          .values({ ...values, sortOrder: (lastModel?.sortOrder ?? -1) + 1, createdBy: userId })
          .returning({ id: inferenceModels.id });
        id = created!.id;
      }

      for (const source of sources) {
        const [created] = await tx
          .insert(inferenceModelSources)
          .values({
            modelId: id,
            connectionId: source.connectionId,
            discoveredModelId: source.discoveredModelId,
            upstreamModelId: source.upstreamModelId,
            coreAccountId: source.coreAccountId,
            coreModelId: source.coreModelId,
            sourceType: source.sourceType,
            enabled: source.enabled,
            priority: 0,
            subscriptionMultiplierOverride: source.subscriptionMultiplierOverride,
            reasoningEffortMap: source.reasoningEffortMap,
            capabilitiesOverride: source.capabilitiesOverride,
            metadata: source.metadata,
          })
          .returning({ id: inferenceModelSources.id });
        if (source.pricing) await insertPricing(tx, created!.id, userId, source.pricing);
      }

      if (input.access.mode === 'selected') {
        await tx.insert(inferenceModelAccessRules).values(
          [...uniqueSubjects.values()].map((subject) => ({
            modelId: id!,
            subjectType: subject.subjectType,
            groupId: subject.subjectType === 'group' ? subject.subjectId : null,
            userId: subject.subjectType === 'user' ? subject.subjectId : null,
            effect: 'allow' as const,
            createdBy: userId,
          }))
        );
      }
      return id;
    });

    await this.access.invalidate();
    await this.audit.log({
      userId,
      action: modelId ? 'inference.model.configuration.replace' : 'inference.model.configuration.create',
      resourceType: 'inference_model',
      resourceId: savedId,
      details: { sourceCount: input.sources.length, accessMode: input.access.mode },
    });
    this.catalogEvents?.publishCatalogChanged();
    return this.models.getAdmin(savedId);
  }

  private async prepareSources(
    db: DrizzleExecutor,
    model: InferenceModelInput,
    inputs: InferenceModelSourceInput[]
  ): Promise<PreparedSource[]> {
    const connectionIds = [...new Set(inputs.map((source) => source.connectionId))];
    if (connectionIds.length !== inputs.length) {
      throw new AppError(400, 'INFERENCE_MODEL_SOURCE_DUPLICATE', 'Each provider connection may be bound only once');
    }
    const connections = await db
      .select()
      .from(inferenceProviderConnections)
      .where(
        and(inArray(inferenceProviderConnections.id, connectionIds), isNull(inferenceProviderConnections.deletedAt))
      );
    const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
    const discoveredIds = inputs.flatMap((source) => (source.discoveredModelId ? [source.discoveredModelId] : []));
    const discovered = discoveredIds.length
      ? await db.select().from(inferenceDiscoveredModels).where(inArray(inferenceDiscoveredModels.id, discoveredIds))
      : [];
    const discoveredById = new Map(discovered.map((item) => [item.id, item]));

    // A source without a discovered model is refused with the ids the connection discovered.
    for (const input of inputs) {
      const connection = connectionById.get(input.connectionId);
      if (!connection || input.discoveredModelId) continue;
      const { modelsPath } = this.registry.require(connection.providerId);
      if (!manualSourceAllowed(connection.syncStatus, modelsPath, input.manualMetadata)) {
        throw await manualSourceRefusal(db, connection, modelsPath, input.upstreamModelId);
      }
    }

    return inputs.map((input) => {
      const connection = connectionById.get(input.connectionId);
      if (!connection) throw new AppError(404, 'INFERENCE_PROVIDER_NOT_FOUND', 'Provider connection not found');
      const provider = this.registry.require(connection.providerId);
      const discoveredModel = input.discoveredModelId ? discoveredById.get(input.discoveredModelId) : undefined;
      if (input.discoveredModelId && discoveredModel?.connectionId !== connection.id) {
        throw new AppError(
          400,
          'INFERENCE_DISCOVERED_MODEL_INVALID',
          'Discovered model does not belong to the connection'
        );
      }
      const upstreamModelId = discoveredModel?.remoteModelId ?? input.upstreamModelId?.trim();
      if (!upstreamModelId) {
        throw new AppError(400, 'INFERENCE_UPSTREAM_MODEL_REQUIRED', 'Upstream model ID is required');
      }
      const enabled = input.enabled !== false;
      assertEnabledSourceAvailable(enabled, connection.enabled, discoveredModel?.available);
      if (enabled) validateReasoningMap(model.reasoningEfforts, input.reasoningEffortMap);
      const coreReferences = coreSourceReferences(connection, upstreamModelId, discoveredModel?.metadata);
      const sourceType = provider.subscription ? 'subscription' : 'api';
      const known = knownProviderModel(provider.id, upstreamModelId);
      const pricing =
        sourceType === 'api'
          ? (pricingFromDiscoveredMetadata(discoveredModel?.metadata) ?? known?.pricing ?? input.pricing)
          : input.pricing;
      // An API source may go without a price: it then serves requests with an unknown cost (see docs/inference.md).
      if (sourceType === 'api' && pricing) validatePricing(pricing);
      const technical = input.manualMetadata;
      return {
        connectionId: connection.id,
        discoveredModelId: discoveredModel?.id ?? null,
        upstreamModelId,
        ...coreReferences,
        providerId: connection.providerId,
        sourceType,
        enabled,
        subscriptionMultiplierOverride:
          input.subscriptionMultiplierOverride === undefined || input.subscriptionMultiplierOverride === null
            ? null
            : String(input.subscriptionMultiplierOverride),
        reasoningEffortMap: input.reasoningEffortMap,
        capabilitiesOverride: input.capabilitiesOverride ?? null,
        metadata: {
          origin: discoveredModel ? ('discovery' as const) : ('manual' as const),
          providerFamily: provider.family,
          ...(technical ? { technical } : {}),
        },
        ...(pricing ? { pricing } : {}),
        safeContextWindow: technical?.contextWindow ?? discoveredModel?.contextWindow ?? model.contextWindow,
        safeMaxInputTokens: technical?.maxInputTokens ?? discoveredModel?.maxInputTokens ?? model.maxInputTokens,
        safeAutoCompactTokenLimit:
          technical?.autoCompactTokenLimit ?? discoveredModel?.autoCompactTokenLimit ?? model.autoCompactTokenLimit,
        modalities: discoveredModel?.modalities ?? known?.modalities ?? ['text'],
        capabilities: input.capabilitiesOverride ?? discoveredModel?.capabilities ?? known?.capabilities ?? {},
      };
    });
  }
}

function normalizedModel(input: InferenceModelInput): InferenceModelInput {
  validateModelInput(input);
  const reasoningEfforts = normalizeReasoningEfforts(input.reasoningEfforts);
  validateDefaultEffort(reasoningEfforts, input.defaultReasoningEffort);
  return { ...input, reasoningEfforts, defaultReasoningEffort: input.defaultReasoningEffort ?? null };
}

function validateAccess(input: InferenceModelConfigurationInput['access']): void {
  if (input.mode === 'selected' && input.subjects.length === 0) {
    throw new AppError(400, 'INFERENCE_MODEL_ACCESS_EMPTY', 'Selected access requires at least one user or group');
  }
}

function validatePublishableConfiguration(
  model: InferenceModelInput,
  sources: PreparedSource[],
  accessMode: InferenceModelConfigurationInput['access']['mode']
): void {
  const enabled = sources.filter((source) => source.enabled);
  if (accessMode !== 'disabled' && enabled.length === 0) {
    throw new AppError(400, 'INFERENCE_MODEL_SOURCE_REQUIRED', 'Published model needs an enabled source');
  }
  for (const source of enabled) {
    validateSourceCompatibility(model, source);
    if (
      model.contextWindow > source.safeContextWindow ||
      model.maxInputTokens > source.safeMaxInputTokens ||
      model.autoCompactTokenLimit > Math.min(source.safeAutoCompactTokenLimit, source.safeMaxInputTokens)
    ) {
      throw new AppError(400, 'INFERENCE_MODEL_LIMIT_UNSAFE', 'Published limits exceed an enabled source safe limit');
    }
  }
}

type PricingExecutor = Pick<DrizzleExecutor, 'insert'>;

async function insertPricing(
  db: PricingExecutor,
  sourceId: string,
  userId: string,
  input: InferencePricingInput
): Promise<void> {
  validatePricing(input);
  await db.insert(inferencePricingSnapshots).values({
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

function assertEnabledSourceAvailable(
  enabled: boolean,
  connectionEnabled: boolean,
  discoveredAvailable?: boolean
): void {
  if (!enabled) return;
  if (!connectionEnabled) {
    throw new AppError(
      409,
      'INFERENCE_PROVIDER_DISABLED',
      'Enabled model sources require an enabled provider connection'
    );
  }
  if (discoveredAvailable === false) {
    throw new AppError(
      409,
      'INFERENCE_DISCOVERED_MODEL_UNAVAILABLE',
      'Enabled model sources require an available discovered model'
    );
  }
}

function coreSourceReferences(
  connection: Pick<typeof inferenceProviderConnections.$inferSelect, 'id' | 'providerId' | 'authType' | 'metadata'>,
  upstreamModelId: string,
  discoveredMetadata?: Record<string, unknown>
): { coreAccountId: string | null; coreModelId: string | null } {
  if (connection.metadata[CORE_MANAGED_METADATA_KEY] !== true) {
    return { coreAccountId: null, coreModelId: null };
  }
  const providerRef = coreProviderRef(connection);
  const discoveredCoreModelId = discoveredMetadata?.[CORE_MODEL_METADATA_KEY];
  return {
    coreAccountId: providerRef,
    coreModelId:
      typeof discoveredCoreModelId === 'string' && discoveredCoreModelId.trim()
        ? discoveredCoreModelId.trim()
        : connection.authType === 'oauth' || upstreamModelId.startsWith(`${providerRef}/`)
          ? upstreamModelId
          : `${providerRef}/${upstreamModelId}`,
  };
}

export const __testOnly = { assertEnabledSourceAvailable, coreSourceReferences, validatePublishableConfiguration };
