import { and, asc, desc, eq, inArray, isNull, lte, ne } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  inferenceDiscoveredModels,
  inferenceModelSources,
  inferenceModels,
  inferencePricingSnapshots,
  inferenceProviderConnections,
  inferenceProviderCredentials,
  inferenceProviderSettings,
  inferenceQuotaSnapshots,
} from '@/db/schema/index.js';
import type { InferenceConnectionStatus } from '@/db/schema/inference-providers.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { providerApiMonthlySpend } from '../accounting/inference-provider-budget.js';
import { InferenceCoreClientError } from '../core/inference-core.client.js';
import type { InferenceCoreBridgeService } from '../core/inference-core-bridge.service.js';
import {
  buildCoreProviderConfig,
  CORE_ACCOUNT_METADATA_KEY,
  CORE_MANAGED_METADATA_KEY,
  CORE_MODEL_METADATA_KEY,
  coreKeyProviderName,
  coreModelCapabilities,
  coreModelPricing,
  coreOAuthTarget,
  coreProviderRef,
  coreQuotaToWindows,
  parseCoreModelRows,
  parseCoreQuotaReports,
} from '../core/inference-core-provider-map.js';
import type { InferenceCatalogEventsService } from '../inference-catalog-events.service.js';
import type { InferenceDestinationPolicy } from './inference-destination-policy.js';
import type { InferenceProviderRegistry } from './inference-provider.registry.js';
import {
  assertApiMonthlyLimitAllowed,
  assertMinimumRemainingAllowed,
  classifyStatus,
  connectionDisableBlockers,
  consistentTokenLimits,
  derivedSource,
  type InferenceModelMetadataSource,
  inheritFamilyMetadata,
  isRecentCoreQuotaReading,
  latestQuota,
  latestValidQuota,
  nextRoutingOrder,
  redactedError,
  serializeConnection,
  serializeModel,
  serializeQuota,
  validateBaseUrl,
} from './inference-provider.service.helpers.js';
import type {
  DiscoveredInferenceModel,
  InferenceProviderDefinition,
  InferenceQuotaWindow,
} from './inference-provider.types.js';
import { knownProviderModel } from './inference-provider-model-catalog.js';

const SYNC_FRESH_MS = 5 * 60_000;
const SYNC_RETRY_MS = 60_000;
const LAST_GOOD_MS = 30 * 60_000;
const SYNC_RUNNING_RECOVERY_MS = 2 * SYNC_FRESH_MS;

@injectable()
export class InferenceProviderService {
  private timer: NodeJS.Timeout | null = null;
  private activeSync: Promise<void> | null = null;
  private readonly connectionSyncs = new Map<
    string,
    Promise<Awaited<ReturnType<InferenceProviderService['getConnection']>>>
  >();

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly registry: InferenceProviderRegistry,
    private readonly audit: AuditService,
    private readonly destinations: InferenceDestinationPolicy,
    private readonly coreBridge?: InferenceCoreBridgeService,
    private readonly catalogEvents?: InferenceCatalogEventsService
  ) {}

  /** Management delegates to the core as soon as it is installed and ready. */
  private async coreReady(): Promise<boolean> {
    return this.coreBridge ? this.coreBridge.coreReady() : false;
  }

  listCatalog() {
    return this.registry.listConnectable().map(({ oauth, ...provider }) => ({
      ...provider,
      oauthFlow: oauth?.flow ?? null,
      completionMode: oauth ? (oauth.flow === 'redirect' ? 'paste_callback' : 'device_poll') : null,
    }));
  }

  async listConnections() {
    const connections = await this.db
      .select()
      .from(inferenceProviderConnections)
      .where(isNull(inferenceProviderConnections.deletedAt))
      .orderBy(
        asc(inferenceProviderConnections.routingOrder),
        asc(inferenceProviderConnections.providerId),
        asc(inferenceProviderConnections.createdAt)
      );
    if (connections.length === 0) return [];
    const ids = connections.map((connection) => connection.id);
    const [credentials, models, quotas, settings, apiSpend] = await Promise.all([
      this.db
        .select({
          connectionId: inferenceProviderCredentials.connectionId,
          kind: inferenceProviderCredentials.credentialKind,
          last4: inferenceProviderCredentials.secretLast4,
          expiresAt: inferenceProviderCredentials.expiresAt,
        })
        .from(inferenceProviderCredentials)
        .where(inArray(inferenceProviderCredentials.connectionId, ids)),
      this.db
        .select()
        .from(inferenceDiscoveredModels)
        .where(
          and(inArray(inferenceDiscoveredModels.connectionId, ids), eq(inferenceDiscoveredModels.available, true))
        ),
      this.db
        .select()
        .from(inferenceQuotaSnapshots)
        .where(inArray(inferenceQuotaSnapshots.connectionId, ids))
        .orderBy(desc(inferenceQuotaSnapshots.fetchedAt)),
      this.db.select().from(inferenceProviderSettings),
      providerApiMonthlySpend(this.db, ids),
    ]);

    return connections.map((connection) => ({
      ...serializeConnection(connection),
      credential:
        credentials.find((credential) => credential.connectionId === connection.id) ??
        // Core-managed rows never hold an Opfield credential; surface a presence
        // indicator so the UI does not render them as missing-key legacy rows.
        (connection.metadata[CORE_MANAGED_METADATA_KEY] === true
          ? {
              connectionId: connection.id,
              kind: connection.authType,
              last4: null,
              expiresAt: null,
            }
          : null),
      routingStrategy:
        settings.find((setting) => setting.providerId === connection.providerId)?.routingStrategy ?? 'balanced',
      discoveredModels: models
        .filter((model) => model.connectionId === connection.id)
        .map((model) => serializeModel(model, connection.providerId)),
      quota: latestQuota(quotas.filter((quota) => quota.connectionId === connection.id)).map(serializeQuota),
      apiMonthlySpentMicrodollars: apiSpend.get(connection.id) ?? 0,
    }));
  }

  async createKeyConnection(
    userId: string,
    input: {
      providerId: string;
      name: string;
      apiKey?: string;
      baseUrl?: string;
      authType?: 'api_key' | 'local';
      allowPrivateNetwork?: boolean;
    }
  ) {
    let provider: InferenceProviderDefinition;
    try {
      provider = this.registry.requireConnectable(input.providerId);
    } catch {
      throw new AppError(400, 'INFERENCE_PROVIDER_NOT_CONNECTABLE', 'Provider is not available for new connections');
    }
    const authType = input.authType ?? 'api_key';
    if (!provider.authTypes.includes(authType)) {
      throw new AppError(
        400,
        'INFERENCE_PROVIDER_AUTH_UNSUPPORTED',
        'Provider does not support this authentication type'
      );
    }
    if (authType === 'api_key' && !input.apiKey?.trim()) {
      throw new AppError(400, 'INFERENCE_PROVIDER_KEY_REQUIRED', 'API key is required');
    }
    const requestedBaseUrl = input.baseUrl?.trim();
    if (requestedBaseUrl && requestedBaseUrl !== provider.baseUrl && !provider.allowBaseUrlOverride) {
      throw new AppError(400, 'INFERENCE_PROVIDER_BASE_URL_FIXED', 'This provider uses a fixed upstream base URL');
    }
    const baseUrl = validateBaseUrl(
      requestedBaseUrl || provider.baseUrl,
      provider.allowBaseUrlOverride === true || input.providerId === 'openai-compatible'
    );
    await this.destinations.assertAllowed(baseUrl, input.allowPrivateNetwork === true);
    if (!(await this.coreReady())) {
      throw new AppError(409, 'INFERENCE_CORE_NOT_READY', 'Install the inference core before connecting providers');
    }
    return this.createCoreKeyConnection(userId, provider, input, authType, baseUrl);
  }

  async getConnection(connectionId: string) {
    const rows = await this.listConnections();
    const connection = rows.find((row) => row.id === connectionId);
    if (!connection) throw new AppError(404, 'INFERENCE_PROVIDER_NOT_FOUND', 'Provider connection not found');
    return connection;
  }

  async syncConnection(connectionId: string, force = false) {
    const existing = this.connectionSyncs.get(connectionId);
    if (existing) return existing;
    const sync = this.syncConnectionInternal(connectionId, force);
    this.connectionSyncs.set(connectionId, sync);
    try {
      return await sync;
    } finally {
      if (this.connectionSyncs.get(connectionId) === sync) this.connectionSyncs.delete(connectionId);
    }
  }

  private async syncConnectionInternal(connectionId: string, force = false) {
    const connection = await this.requireConnection(connectionId);
    if (!force && connection.lastSyncedAt && connection.lastSyncedAt.getTime() + SYNC_FRESH_MS > Date.now()) {
      return this.getConnection(connectionId);
    }
    if (connection.metadata[CORE_MANAGED_METADATA_KEY] === true) {
      return this.syncCoreConnection(connectionId);
    }
    // Legacy rows survive only as historical metadata after the engine
    // removal: there is no wire connector to sync them with anymore.
    const failureStatus = syncFailureStatus(connection.status, {
      hasLastSyncedAt: Boolean(connection.lastSyncedAt),
      hasQuotaHistory: false,
      hasCurrentQuotaExhaustion: false,
      hasHardUnknownReason: connection.status === 'unavailable' && connection.healthReason !== null,
    });
    await this.db
      .update(inferenceProviderConnections)
      .set({
        status: failureStatus,
        healthReason: shouldPreserveSyncBarrier(connection.status, failureStatus)
          ? connection.healthReason
          : 'Reconnect this provider through the inference core',
        syncStatus: 'error',
        syncLastError: 'Reconnect this provider through the inference core',
        nextSyncAt: new Date(Date.now() + SYNC_RETRY_MS),
        updatedAt: new Date(),
      })
      .where(eq(inferenceProviderConnections.id, connectionId));
    const result = await this.getConnection(connectionId);
    this.catalogEvents?.publishCatalogChanged();
    return result;
  }

  async updateConnection(
    userId: string,
    connectionId: string,
    input: {
      enabled?: boolean;
      name?: string;
      routingOrder?: number;
      minimumRemainingPercent?: number;
      apiMonthlyLimitMicrodollars?: number | null;
    }
  ) {
    const connection = await this.requireConnection(connectionId);
    const provider = this.registry.require(connection.providerId);
    if (input.enabled === false && connection.enabled) await this.assertConnectionCanDisable(connectionId);
    if (input.minimumRemainingPercent !== undefined) {
      assertMinimumRemainingAllowed(provider, input.minimumRemainingPercent);
    }
    assertApiMonthlyLimitAllowed(provider, input.apiMonthlyLimitMicrodollars);
    if (
      connection.metadata[CORE_MANAGED_METADATA_KEY] === true &&
      input.enabled !== undefined &&
      input.enabled !== connection.enabled
    ) {
      await this.mirrorCoreConnectionEnabled(connection, input.enabled);
    }
    await this.db
      .update(inferenceProviderConnections)
      .set({
        ...(input.enabled !== undefined && input.enabled !== connection.enabled
          ? { enabled: input.enabled, status: input.enabled ? 'pending' : 'disabled' }
          : {}),
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.routingOrder !== undefined ? { routingOrder: input.routingOrder } : {}),
        ...(input.minimumRemainingPercent !== undefined
          ? { minimumRemainingPercent: input.minimumRemainingPercent }
          : {}),
        ...(input.apiMonthlyLimitMicrodollars !== undefined
          ? { apiMonthlyLimitMicrodollars: input.apiMonthlyLimitMicrodollars }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(inferenceProviderConnections.id, connectionId));
    await this.audit.log({
      userId,
      action: 'inference.provider.update',
      resourceType: 'inference_provider_connection',
      resourceId: connectionId,
      details: { fields: Object.keys(input) },
    });
    const result = await this.getConnection(connectionId);
    this.catalogEvents?.publishCatalogChanged();
    return result;
  }

  async setRoutingStrategy(userId: string, providerId: string, routingStrategy: 'even' | 'balanced' | 'sequential') {
    this.registry.require(providerId);
    await this.db
      .insert(inferenceProviderSettings)
      .values({ providerId, routingStrategy })
      .onConflictDoUpdate({
        target: inferenceProviderSettings.providerId,
        set: { routingStrategy, updatedAt: new Date() },
      });
    await this.audit.log({
      userId,
      action: 'inference.provider.routing.update',
      resourceType: 'inference_provider',
      resourceId: providerId,
      details: { routingStrategy },
    });
    this.catalogEvents?.publishCatalogChanged();
    return { providerId, routingStrategy };
  }

  async disconnect(userId: string, connectionId: string): Promise<void> {
    const connection = await this.requireConnection(connectionId);
    await this.assertConnectionCanDisable(connectionId);
    if (connection.metadata[CORE_MANAGED_METADATA_KEY] === true) {
      await this.removeCoreConnectionArtifacts(connection);
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(inferenceModelSources).where(eq(inferenceModelSources.connectionId, connectionId));
      await tx.delete(inferenceProviderCredentials).where(eq(inferenceProviderCredentials.connectionId, connectionId));
      await tx
        .update(inferenceProviderConnections)
        .set({ enabled: false, status: 'disabled', deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(inferenceProviderConnections.id, connectionId));
    });
    await this.audit.log({
      userId,
      action: 'inference.provider.disconnect',
      resourceType: 'inference_provider_connection',
      resourceId: connectionId,
    });
    this.catalogEvents?.publishCatalogChanged();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.runDueSync(), 60_000);
    this.timer.unref();
    this.runDueSync();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.activeSync;
  }

  async syncDue(now = new Date()): Promise<void> {
    const due = await this.db
      .select({
        id: inferenceProviderConnections.id,
        syncStatus: inferenceProviderConnections.syncStatus,
        updatedAt: inferenceProviderConnections.updatedAt,
      })
      .from(inferenceProviderConnections)
      .where(
        and(
          eq(inferenceProviderConnections.enabled, true),
          isNull(inferenceProviderConnections.deletedAt),
          lte(inferenceProviderConnections.nextSyncAt, now)
        )
      );
    await Promise.allSettled(
      due
        .filter(
          (connection) =>
            connection.syncStatus !== 'running' ||
            connection.updatedAt.getTime() <= now.getTime() - SYNC_RUNNING_RECOVERY_MS
        )
        .map((connection) => this.syncConnection(connection.id, true))
    );
  }

  private runDueSync(): void {
    if (this.activeSync) return;
    const active = this.syncDue()
      .catch(() => undefined)
      .finally(() => {
        if (this.activeSync === active) this.activeSync = null;
      });
    this.activeSync = active;
  }

  // ----------------------------------------------------- core-managed paths
  // Core-managed variants: credentials and routing live in the managed core,
  // Opfield rows stay the browser-facing record (plan T4). No dual writes:
  // these paths replace the legacy credential store instead of mirroring it.

  private async createCoreKeyConnection(
    userId: string,
    provider: InferenceProviderDefinition,
    input: { name: string; apiKey?: string; allowPrivateNetwork?: boolean },
    authType: 'api_key' | 'local',
    baseUrl: string
  ) {
    const client = await this.coreBridge!.requireClient();
    const [lastConnection] = await this.db
      .select({ routingOrder: inferenceProviderConnections.routingOrder })
      .from(inferenceProviderConnections)
      .where(isNull(inferenceProviderConnections.deletedAt))
      .orderBy(desc(inferenceProviderConnections.routingOrder))
      .limit(1);
    const [connection] = await this.db
      .insert(inferenceProviderConnections)
      .values({
        providerId: provider.id,
        name: input.name.trim(),
        authType,
        baseUrl,
        routingOrder: nextRoutingOrder(lastConnection?.routingOrder),
        metadata: {
          allowPrivateNetwork: input.allowPrivateNetwork === true,
          [CORE_MANAGED_METADATA_KEY]: true,
        },
        createdBy: userId,
      })
      .returning();
    try {
      await client.createCoreProvider(
        coreKeyProviderName(connection.id),
        buildCoreProviderConfig({
          definition: provider,
          baseUrl,
          authType,
          ...(input.apiKey ? { apiKey: input.apiKey.trim() } : {}),
          allowPrivateNetwork: input.allowPrivateNetwork === true,
        })
      );
    } catch (error) {
      // The row never went live; remove it so a rejected connect leaves no orphan.
      await this.db.delete(inferenceProviderConnections).where(eq(inferenceProviderConnections.id, connection.id));
      throw asCoreManagementError(error, 'Core rejected the provider configuration');
    }
    await this.audit.log({
      userId,
      action: 'inference.provider.connect',
      resourceType: 'inference_provider_connection',
      resourceId: connection.id,
      details: { providerId: provider.id, authType, coreManaged: true },
    });
    return this.syncConnection(connection.id, true);
  }

  private async syncCoreConnection(connectionId: string) {
    await this.db
      .update(inferenceProviderConnections)
      .set({ syncStatus: 'running', syncLastError: null, updatedAt: new Date() })
      .where(eq(inferenceProviderConnections.id, connectionId));
    try {
      const connection = await this.requireConnection(connectionId);
      const client = await this.coreBridge!.requireClient();
      const providerRef = coreProviderRef(connection);
      const definition = this.registry.require(connection.providerId);
      if (definition.liveModels !== undefined && connection.authType !== 'oauth') {
        await client.patchCoreProvider(providerRef, { liveModels: definition.liveModels });
      }
      // Discovery refreshes the core catalog. Read model metadata only after it
      // completes so a newly discovered id is included in this same sync.
      // null is reserved for providers where live discovery is explicitly not
      // applicable. Transport/protocol failures throw from the client so this
      // sync cannot silently promote a stale catalog to success.
      const liveModels = await client.coreProviderLiveModels(providerRef);
      const liveModelIds = liveModels?.map((model) => model.id) ?? null;
      const liveById = new Map((liveModels ?? []).map((model) => [model.id, model] as const));
      const [providers, modelsBody, quotasBody] = await Promise.all([
        client.listCoreProviders(),
        client.listCoreModels(),
        client.coreProviderQuotas(),
      ]);
      const coreProvider = providers?.find((candidate) => candidate.name === providerRef);
      if (!coreProvider) {
        throw new AppError(
          502,
          'INFERENCE_CORE_PROVIDER_MISSING',
          'The inference core lost this provider configuration'
        );
      }
      const rowsById = new Map(
        parseCoreModelRows(modelsBody)
          .filter((row) => row.provider === providerRef)
          .map((row) => [row.id, row] as const)
      );
      for (const live of liveModels ?? []) {
        const existing = rowsById.get(live.id);
        // A model that only the live roster reports is published for subscriptions alone.
        // API-key providers keep core's exposure filters, so there live metadata only
        // describes rows core already returned.
        if (!existing && connection.authType !== 'oauth') continue;
        // Core rows already carry the live answer plus operator overrides and context caps, so
        // their values win; the live roster fills only what core did not return.
        rowsById.set(live.id, {
          ...(live.displayName ? { displayName: live.displayName } : {}),
          ...(live.contextWindow !== undefined ? { contextWindow: live.contextWindow } : {}),
          ...(live.maxInputTokens !== undefined ? { maxInputTokens: live.maxInputTokens } : {}),
          ...(live.maxOutputTokens !== undefined ? { maxOutputTokens: live.maxOutputTokens } : {}),
          ...(live.reasoningEfforts !== undefined ? { reasoningEfforts: live.reasoningEfforts } : {}),
          ...(live.inputModalities !== undefined ? { inputModalities: live.inputModalities } : {}),
          ...(live.capabilities !== undefined ? { capabilities: live.capabilities } : {}),
          ...definedFields(existing),
          provider: providerRef,
          id: live.id,
          // Core routes a subscription model through its provider namespace, like its own rows.
          namespaced: existing?.namespaced ?? `${providerRef}/${live.id}`,
          // Core may label a model with its id; the provider's own name is better.
          ...(live.displayName && idLikeName(existing?.displayName, live.id) && !idLikeName(live.displayName, live.id)
            ? { displayName: live.displayName }
            : {}),
        });
      }
      const models = [...rowsById.values()].filter(
        (row) => row.disabled !== true && (liveModelIds === null || liveModelIds.includes(row.id))
      );
      // OpenRouter-style rosters list each model's capabilities, so a model without "tools" there
      // does not accept them. Other providers publish none at all, and the core sends tools to
      // every model it routes: for them a missing list says nothing about tool support.
      const rosterListsCapabilities = (liveModels ?? []).some((model) => model.capabilities !== undefined);
      await this.persistModels(
        connectionId,
        inheritFamilyMetadata(
          models.map((row) => {
            const known = knownProviderModel(connection.providerId, row.id);
            const live = liveById.get(row.id);
            // Record where every technical value came from so the admin UI can tell a live
            // provider answer apart from a built-in fallback value or an Opfield calculation.
            const coreSource = (field: string) => row.metadataSources?.[field] ?? (liveModels ? 'fallback' : undefined);
            // A value equal to the live answer is provider-reported. A core value that differs from
            // it was changed by operator configuration, so it is left unlabeled.
            const sourceOf = (
              field: string,
              liveValue: unknown,
              rowValue: unknown,
              knownValue: unknown
            ): InferenceModelMetadataSource | undefined =>
              rowValue !== undefined
                ? liveValue !== undefined
                  ? sameMetadataValue(liveValue, rowValue)
                    ? 'provider'
                    : undefined
                  : coreSource(field)
                : knownValue !== undefined
                  ? 'fallback'
                  : undefined;
            const coreAutoCompact =
              row.autoCompactTokenLimit ??
              (row.maxInputTokens !== undefined ? Math.floor(row.maxInputTokens * 0.9) : undefined);
            const limits = consistentTokenLimits({
              contextWindow: row.contextWindow ?? known?.contextWindow,
              maxInputTokens: row.maxInputTokens ?? known?.maxInputTokens,
              autoCompactTokenLimit: coreAutoCompact ?? known?.autoCompactTokenLimit,
            });
            const contextWindowSource = sourceOf(
              'contextWindow',
              live?.contextWindow,
              row.contextWindow,
              known?.contextWindow
            );
            const maxInputSource = limits.maxInputFromContextWindow
              ? derivedSource(contextWindowSource)
              : sourceOf('maxInputTokens', live?.maxInputTokens, row.maxInputTokens, known?.maxInputTokens);
            const isIdLike = (name: string | undefined) =>
              name !== undefined && (name === row.id || name.endsWith(`/${row.id}`));
            const fieldSources = Object.fromEntries(
              Object.entries({
                // An id-like provider name is replaced by the catalog name, so the shown value is the catalog's.
                displayName:
                  isIdLike(row.displayName) && known
                    ? 'fallback'
                    : sourceOf('displayName', live?.displayName, row.displayName, known?.displayName),
                contextWindow: contextWindowSource,
                maxInputTokens: maxInputSource,
                maxOutputTokens: sourceOf(
                  'maxOutputTokens',
                  live?.maxOutputTokens,
                  row.maxOutputTokens,
                  known?.maxOutputTokens
                ),
                autoCompactTokenLimit:
                  limits.autoCompactFromMaxInput || coreAutoCompact !== undefined
                    ? derivedSource(maxInputSource)
                    : known
                      ? 'fallback'
                      : undefined,
                reasoningEfforts: sourceOf(
                  'reasoningEfforts',
                  live?.reasoningEfforts,
                  row.reasoningEfforts,
                  known?.reasoningEfforts
                ),
                modalities: sourceOf('inputModalities', live?.inputModalities, row.inputModalities, known?.modalities),
                capabilities: sourceOf('capabilities', live?.capabilities, row.capabilities, known?.capabilities),
              }).filter((entry): entry is [string, InferenceModelMetadataSource] => entry[1] !== undefined)
            );
            const displayName = isIdLike(row.displayName)
              ? (known?.displayName ?? row.id)
              : (row.displayName ?? known?.displayName);
            const modalities = row.inputModalities ?? known?.modalities ?? ['text'];
            const reportedCapabilities = coreModelCapabilities(row);
            const capabilities = {
              ...reportedCapabilities,
              ...(row.capabilities === undefined && known ? { tools: known.capabilities.tools === true } : {}),
              ...(row.capabilities === undefined && !known && !rosterListsCapabilities ? { tools: true } : {}),
              ...(row.reasoningEfforts === undefined && known
                ? { reasoning: known.capabilities.reasoning === true }
                : {}),
              ...(row.inputModalities === undefined && known ? { vision: known.capabilities.vision === true } : {}),
            };
            const pricing = coreModelPricing(row);
            return {
              // Opfield owns the provider/account selection. Keep the upstream
              // model id account-agnostic so identical models from multiple
              // connections pool together and no core provider name leaks into
              // the admin UI or public model ids.
              id: row.id,
              ...(displayName ? { displayName } : {}),
              ...(limits.contextWindow !== null ? { contextWindow: limits.contextWindow } : {}),
              ...(limits.maxInputTokens !== null ? { maxInputTokens: limits.maxInputTokens } : {}),
              ...(row.maxOutputTokens !== undefined ? { maxOutputTokens: row.maxOutputTokens } : {}),
              ...(limits.autoCompactTokenLimit !== null ? { autoCompactTokenLimit: limits.autoCompactTokenLimit } : {}),
              modalities,
              capabilities,
              reasoningEfforts: row.reasoningEfforts ?? known?.reasoningEfforts ?? [],
              ...(pricing ? { pricing } : {}),
              metadata: {
                source: 'opencodex',
                [CORE_MODEL_METADATA_KEY]: row.namespaced,
                ...(row.inputModalities !== undefined ? { input_modalities: row.inputModalities } : {}),
                ...(row.capabilities !== undefined ? { capabilities: row.capabilities } : {}),
                ...(pricing ? { opfieldPricing: pricing } : {}),
                ...(row.defaultReasoningEffort ? { default_reasoning_effort: row.defaultReasoningEffort } : {}),
                ...(row.supportsReasoningSummaries !== undefined
                  ? { supports_reasoning_summaries: row.supportsReasoningSummaries }
                  : {}),
                ...(Object.keys(fieldSources).length ? { field_sources: fieldSources } : {}),
              },
            };
          })
        )
      );
      const sourceType = definition.subscription ? 'subscription' : 'api';
      await this.db
        .update(inferenceModelSources)
        .set({ sourceType, updatedAt: new Date() })
        .where(eq(inferenceModelSources.connectionId, connectionId));
      const windows = await this.coreConnectionQuotaWindows(client, connection, parseCoreQuotaReports(quotasBody));
      await this.persistQuota(connectionId, windows);
      const quotaStatus = classifyStatus(windows, connection.minimumRemainingPercent / 100);
      await this.db
        .update(inferenceProviderConnections)
        .set({
          status: syncSuccessStatus(connection.status, quotaStatus),
          healthReason: isStrongSyncBlockStatus(connection.status) ? connection.healthReason : null,
          syncStatus: 'success',
          syncLastError: null,
          lastSyncedAt: new Date(),
          nextSyncAt: new Date(Date.now() + SYNC_FRESH_MS),
          updatedAt: new Date(),
        })
        .where(eq(inferenceProviderConnections.id, connectionId));
    } catch (error) {
      const connection = await this.requireConnection(connectionId);
      const quotaState =
        connection.status === 'unavailable' && connection.healthReason === null
          ? await this.currentQuotaState(connection).catch(() => ({
              hasQuotaHistory: false,
              hasCurrentQuotaExhaustion: false,
            }))
          : { hasQuotaHistory: false, hasCurrentQuotaExhaustion: false };
      const failureStatus = syncFailureStatus(connection.status, {
        hasLastSyncedAt: Boolean(connection.lastSyncedAt),
        hasQuotaHistory: quotaState.hasQuotaHistory,
        hasCurrentQuotaExhaustion: quotaState.hasCurrentQuotaExhaustion,
        hasHardUnknownReason: connection.status === 'unavailable' && connection.healthReason !== null,
      });
      await this.db
        .update(inferenceProviderConnections)
        .set({
          status: failureStatus,
          healthReason: shouldPreserveSyncBarrier(connection.status, failureStatus)
            ? connection.healthReason
            : redactedError(error),
          syncStatus: 'error',
          syncLastError: redactedError(error),
          nextSyncAt: new Date(Date.now() + SYNC_RETRY_MS),
          updatedAt: new Date(),
        })
        .where(eq(inferenceProviderConnections.id, connectionId));
    }
    const result = await this.getConnection(connectionId);
    this.catalogEvents?.publishCatalogChanged();
    return result;
  }

  /**
   * Quota for one core-managed connection. ChatGPT pool accounts have
   * per-account quota readings; everything else uses the core's aggregate
   * report for the provider entry the connection routes through.
   */
  private async coreConnectionQuotaWindows(
    client: import('../core/inference-core.client.js').InferenceCoreClient,
    connection: typeof inferenceProviderConnections.$inferSelect,
    reports: ReturnType<typeof parseCoreQuotaReports>
  ): Promise<ReturnType<typeof coreQuotaToWindows>> {
    const providerRef = coreProviderRef(connection);
    if (connection.providerId === 'openai' && connection.authType === 'oauth') {
      const accountId = connection.metadata[CORE_ACCOUNT_METADATA_KEY];
      if (typeof accountId === 'string' && accountId) {
        const quotas = await client.coreCodexQuota();
        const raw = quotas?.[accountId];
        if (raw && typeof raw === 'object') {
          const quota = raw as Record<string, unknown>;
          return coreQuotaToWindows({
            provider: providerRef,
            quota: {
              ...(typeof quota.shortPercent === 'number' ? { fiveHourPercent: quota.shortPercent } : {}),
              ...(typeof quota.shortResetAt === 'number' ? { fiveHourResetAt: quota.shortResetAt } : {}),
              ...(typeof quota.weeklyPercent === 'number' ? { weeklyPercent: quota.weeklyPercent } : {}),
              ...(typeof quota.weeklyResetAt === 'number' ? { weeklyResetAt: quota.weeklyResetAt } : {}),
              ...(typeof quota.monthlyPercent === 'number' ? { monthlyPercent: quota.monthlyPercent } : {}),
              ...(typeof quota.monthlyResetAt === 'number' ? { monthlyResetAt: quota.monthlyResetAt } : {}),
            },
          });
        }
      }
    }
    const report = reports.find((candidate) => candidate.provider === providerRef);
    const target = connection.authType === 'oauth' ? coreOAuthTarget(connection.providerId) : null;
    const accountId = connection.metadata[CORE_ACCOUNT_METADATA_KEY];
    if (target?.kind === 'core-oauth' && typeof accountId === 'string' && accountId) {
      // The provider report describes the core's active account only. With several accounts of one provider it
      // would stamp that account's usage on every connection, so each connection reads its own account row.
      const accounts = await client.coreOauthAccountQuotas(target.oauthProvider);
      // A failed token refresh leaves the account parked in the core until it is signed in again.
      // Its last reading can still look healthy, so the core's verdict wins over any cached quota.
      if (accounts?.reauthRequired.has(accountId)) {
        throw new InferenceCoreClientError(
          'The inference core could not refresh this account sign-in. Reconnect the account to resume sync and routing'
        );
      }
      if (accounts && accounts.quotas.size > 0) {
        const ownQuota = accounts.quotas.get(accountId);
        // The core tried and failed to read this account. Its last reading may come back with the
        // failure; storing an old one would put it on screen and in routing as if it were current.
        const failure = accounts.failures.get(accountId);
        if (failure && !isRecentCoreQuotaReading(ownQuota)) {
          throw new InferenceCoreClientError(`The inference core could not read this account's quota (${failure})`);
        }
        const [own] = parseCoreQuotaReports({
          reports: [{ provider: providerRef, quota: ownQuota }],
        });
        if (own) return coreQuotaToWindows(own);
        if (failure) {
          throw new InferenceCoreClientError(`The inference core could not read this account's quota (${failure})`);
        }
        const describesThisAccount = accounts.quotas.size === 1 || accounts.activeAccountId === accountId;
        if (!describesThisAccount) return [];
      }
    }
    return report ? coreQuotaToWindows(report) : [];
  }

  private async currentQuotaState(
    connection: typeof inferenceProviderConnections.$inferSelect
  ): Promise<{ hasQuotaHistory: boolean; hasCurrentQuotaExhaustion: boolean }> {
    const quotas = await this.db.query.inferenceQuotaSnapshots.findMany({
      where: and(eq(inferenceQuotaSnapshots.connectionId, connection.id), eq(inferenceQuotaSnapshots.status, 'fresh')),
      orderBy: [desc(inferenceQuotaSnapshots.fetchedAt)],
    });
    return {
      hasQuotaHistory: quotas.length > 0,
      hasCurrentQuotaExhaustion: latestValidQuota(quotas).some(
        (quota) =>
          // Model-scoped windows gate only their own models, never the whole connection.
          !quota.modelBucket &&
          quota.remainingFraction !== null &&
          quota.remainingFraction !== undefined &&
          Number(quota.remainingFraction) <= connection.minimumRemainingPercent / 100
      ),
    };
  }

  private async mirrorCoreConnectionEnabled(
    connection: typeof inferenceProviderConnections.$inferSelect,
    enabled: boolean
  ) {
    const client = await this.coreBridge!.requireClient();
    if (connection.authType === 'oauth') {
      // OAuth accounts share the canonical core provider entry; per-account
      // pausing exists only for the ChatGPT pool. Other providers keep core
      // state untouched — the Opfield data plane never routes disabled
      // connections, and account selection stays core-internal.
      if (connection.providerId === 'openai') {
        const accountId = connection.metadata[CORE_ACCOUNT_METADATA_KEY];
        if (typeof accountId === 'string' && accountId) {
          await client.setCoreCodexAccountPaused(accountId, !enabled).catch((error) => {
            throw asCoreManagementError(error, 'Core rejected the account pause update');
          });
        }
      }
      return;
    }
    await client.patchCoreProvider(coreKeyProviderName(connection.id), { disabled: !enabled }).catch((error) => {
      throw asCoreManagementError(error, 'Core rejected the provider update');
    });
  }

  private async removeCoreConnectionArtifacts(connection: typeof inferenceProviderConnections.$inferSelect) {
    let client: import('../core/inference-core.client.js').InferenceCoreClient;
    try {
      client = await this.coreBridge!.requireClient();
    } catch (error) {
      // An unreachable core must not trap administrator cleanup; the leftover
      // entry is inert without Opfield traffic and repair owns orphans.
      if (error instanceof AppError) return;
      throw error;
    }
    try {
      if (connection.authType === 'oauth') {
        const target = coreOAuthTarget(connection.providerId);
        const accountId = connection.metadata[CORE_ACCOUNT_METADATA_KEY];
        if (target && typeof accountId === 'string' && accountId) {
          if (target.kind === 'codex-pool') await client.deleteCoreCodexAccount(accountId);
          else await client.deleteCoreOauthAccount(target.oauthProvider, accountId);
        }
        return;
      }
      await client.deleteCoreProvider(coreKeyProviderName(connection.id));
    } catch (error) {
      throw asCoreManagementError(error, 'Core rejected the disconnect');
    }
  }

  private async persistModels(connectionId: string, models: DiscoveredInferenceModel[]) {
    const connection = await this.requireConnection(connectionId);
    const provider = this.registry.require(connection.providerId);
    await this.db.transaction(async (tx) => {
      await tx
        .update(inferenceDiscoveredModels)
        .set({ available: false, updatedAt: new Date() })
        .where(eq(inferenceDiscoveredModels.connectionId, connectionId));
      const poolSourcesByUpstreamModel = new Map<string, Map<string, typeof inferenceModelSources.$inferSelect>>();
      if (provider.subscription && connection.enabled) {
        const existingPoolSources = await tx
          .select({ source: inferenceModelSources })
          .from(inferenceModelSources)
          .innerJoin(
            inferenceProviderConnections,
            eq(inferenceModelSources.connectionId, inferenceProviderConnections.id)
          )
          .where(
            and(
              eq(inferenceProviderConnections.providerId, connection.providerId),
              eq(inferenceProviderConnections.enabled, true),
              isNull(inferenceProviderConnections.deletedAt),
              ne(inferenceModelSources.connectionId, connectionId),
              eq(inferenceModelSources.sourceType, 'subscription'),
              eq(inferenceModelSources.enabled, true)
            )
          );
        for (const { source } of existingPoolSources) {
          const sourcesForUpstream = poolSourcesByUpstreamModel.get(source.upstreamModelId) ?? new Map();
          sourcesForUpstream.set(source.modelId, source);
          poolSourcesByUpstreamModel.set(source.upstreamModelId, sourcesForUpstream);
        }
      }
      for (const model of models) {
        const [persisted] = await tx
          .insert(inferenceDiscoveredModels)
          .values({
            connectionId,
            remoteModelId: model.id,
            displayName: model.displayName,
            contextWindow: model.contextWindow,
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
            autoCompactTokenLimit: model.autoCompactTokenLimit,
            modalities: model.modalities,
            capabilities: model.capabilities,
            reasoningEfforts: model.reasoningEfforts,
            metadata: model.metadata,
          })
          .onConflictDoUpdate({
            target: [inferenceDiscoveredModels.connectionId, inferenceDiscoveredModels.remoteModelId],
            set: {
              displayName: model.displayName,
              contextWindow: model.contextWindow,
              maxInputTokens: model.maxInputTokens,
              maxOutputTokens: model.maxOutputTokens,
              autoCompactTokenLimit: model.autoCompactTokenLimit,
              modalities: model.modalities,
              capabilities: model.capabilities,
              reasoningEfforts: model.reasoningEfforts,
              metadata: model.metadata,
              available: true,
              lastSeenAt: new Date(),
              updatedAt: new Date(),
            },
          })
          .returning({ id: inferenceDiscoveredModels.id });
        if (!persisted) continue;
        const coreModelId = model.metadata[CORE_MODEL_METADATA_KEY];
        if (typeof coreModelId === 'string' && coreModelId && coreModelId !== model.id) {
          await tx
            .update(inferenceModelSources)
            .set({
              discoveredModelId: persisted.id,
              upstreamModelId: model.id,
              coreModelId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(inferenceModelSources.connectionId, connectionId),
                eq(inferenceModelSources.upstreamModelId, coreModelId)
              )
            );
        }
        const sourceByModel = poolSourcesByUpstreamModel.get(model.id);
        if (sourceByModel?.size) {
          const providerRef = coreProviderRef(connection);
          const discoveredCoreModelId = model.metadata[CORE_MODEL_METADATA_KEY];
          const pooledCoreModelId =
            typeof discoveredCoreModelId === 'string' && discoveredCoreModelId.trim()
              ? discoveredCoreModelId.trim()
              : connection.authType === 'oauth' || model.id.startsWith(`${providerRef}/`)
                ? model.id
                : `${providerRef}/${model.id}`;
          await tx
            .insert(inferenceModelSources)
            .values(
              [...sourceByModel.values()].map((source) => ({
                modelId: source.modelId,
                connectionId,
                discoveredModelId: persisted.id,
                upstreamModelId: model.id,
                coreAccountId: providerRef,
                coreModelId: pooledCoreModelId,
                sourceType: 'subscription' as const,
                enabled: true,
                priority: source.priority,
                subscriptionMultiplierOverride: source.subscriptionMultiplierOverride,
                reasoningEffortMap: source.reasoningEffortMap,
                capabilitiesOverride: source.capabilitiesOverride,
                metadata: { ...source.metadata, origin: 'discovery' },
              }))
            )
            .onConflictDoNothing();
        }
        if (!model.pricing) continue;
        const sources = await tx
          .select({ id: inferenceModelSources.id })
          .from(inferenceModelSources)
          .where(eq(inferenceModelSources.discoveredModelId, persisted.id));
        if (!sources.length) continue;
        await tx
          .insert(inferencePricingSnapshots)
          .values(
            sources.map(({ id }) => ({
              sourceId: id,
              version: model.pricing!.version,
              inputMicrodollarsPerMillion: model.pricing!.inputMicrodollarsPerMillion,
              cachedInputMicrodollarsPerMillion: model.pricing!.cachedInputMicrodollarsPerMillion,
              cacheWriteMicrodollarsPerMillion: model.pricing!.cacheWriteMicrodollarsPerMillion,
              outputMicrodollarsPerMillion: model.pricing!.outputMicrodollarsPerMillion,
              reasoningMicrodollarsPerMillion: model.pricing!.reasoningMicrodollarsPerMillion,
              otherUnitPrices: model.pricing!.otherUnitPrices ?? {},
              source: 'provider' as const,
            }))
          )
          .onConflictDoNothing();
      }
    });
  }

  private async persistQuota(connectionId: string, windows: InferenceQuotaWindow[]) {
    const fetchedAt = new Date();
    const validUntil = new Date(fetchedAt.getTime() + LAST_GOOD_MS);
    if (windows.length === 0) return;
    await this.db.insert(inferenceQuotaSnapshots).values(
      windows.map((window) => ({
        connectionId,
        dimension: window.dimension,
        modelBucket: window.modelBucket,
        status: 'fresh' as const,
        remainingFraction: window.remainingFraction === undefined ? null : String(window.remainingFraction),
        remainingValue: window.remainingValue,
        limitValue: window.limitValue,
        resetAt: window.resetAt,
        fetchedAt,
        validUntil,
        metadata: window.metadata ?? {},
      }))
    );
  }

  private async requireConnection(connectionId: string) {
    const connection = await this.db.query.inferenceProviderConnections.findFirst({
      where: and(eq(inferenceProviderConnections.id, connectionId), isNull(inferenceProviderConnections.deletedAt)),
    });
    if (!connection) throw new AppError(404, 'INFERENCE_PROVIDER_NOT_FOUND', 'Provider connection not found');
    return connection;
  }

  private async assertConnectionCanDisable(connectionId: string): Promise<void> {
    const affected = await this.db
      .select({ id: inferenceModels.id, displayName: inferenceModels.displayName })
      .from(inferenceModelSources)
      .innerJoin(inferenceModels, eq(inferenceModelSources.modelId, inferenceModels.id))
      .where(
        and(
          eq(inferenceModelSources.connectionId, connectionId),
          eq(inferenceModelSources.enabled, true),
          eq(inferenceModels.enabled, true)
        )
      );
    if (!affected.length) return;
    const remaining = await this.db
      .select({ modelId: inferenceModelSources.modelId })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .where(
        and(
          inArray(
            inferenceModelSources.modelId,
            affected.map((model) => model.id)
          ),
          ne(inferenceModelSources.connectionId, connectionId),
          eq(inferenceModelSources.enabled, true),
          eq(inferenceProviderConnections.enabled, true),
          isNull(inferenceProviderConnections.deletedAt)
        )
      );
    const blocked = connectionDisableBlockers(
      affected,
      remaining.map((source) => source.modelId)
    );
    if (blocked.length) {
      throw new AppError(
        409,
        'INFERENCE_PROVIDER_IN_USE',
        `Disable or rebind published models before disconnecting this provider: ${blocked
          .map((model) => model.displayName)
          .join(', ')}`
      );
    }
  }
}

export { __testOnly } from './inference-provider.service.helpers.js';

/** Copy only the fields a core row actually set, so absent fields do not erase live values. */
function definedFields<T extends object>(row: T | undefined): Partial<T> {
  if (!row) return {};
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function idLikeName(name: string | undefined, id: string): boolean {
  return name !== undefined && (name === id || name.endsWith(`/${id}`));
}

/** Compare a live metadata value with core's; lists compare as sets. */
function sameMetadataValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value) => right.includes(value));
  }
  return left === right;
}

function isStrongSyncBlockStatus(status: InferenceConnectionStatus): boolean {
  return ['disabled', 'reauth_required', 'cooldown'].includes(status);
}

function syncFailureStatus(
  status: InferenceConnectionStatus,
  input: {
    hasLastSyncedAt: boolean;
    hasQuotaHistory: boolean;
    hasCurrentQuotaExhaustion: boolean;
    hasHardUnknownReason: boolean;
  }
): InferenceConnectionStatus {
  if (isStrongSyncBlockStatus(status)) return status;
  if (status === 'unavailable') {
    if (input.hasCurrentQuotaExhaustion || input.hasHardUnknownReason || !input.hasQuotaHistory) return status;
    return 'stale';
  }
  return input.hasLastSyncedAt || input.hasQuotaHistory ? 'stale' : 'unavailable';
}

function syncSuccessStatus(
  status: InferenceConnectionStatus,
  quotaStatus: InferenceConnectionStatus
): InferenceConnectionStatus {
  return isStrongSyncBlockStatus(status) ? status : quotaStatus;
}

function shouldPreserveSyncBarrier(
  previousStatus: InferenceConnectionStatus,
  nextStatus: InferenceConnectionStatus
): boolean {
  return isStrongSyncBlockStatus(previousStatus) || (previousStatus === 'unavailable' && nextStatus === 'unavailable');
}

/** Core management rejections surface their message; transport failures stay generic. */
function asCoreManagementError(error: unknown, fallback: string): Error {
  if (error instanceof AppError) return error;
  if (error instanceof InferenceCoreClientError) {
    const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
    return new AppError(status, 'INFERENCE_CORE_MANAGEMENT_FAILED', error.message.slice(0, 500));
  }
  return new AppError(502, 'INFERENCE_CORE_MANAGEMENT_FAILED', fallback);
}
