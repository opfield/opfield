import { createHash } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  inferenceDiscoveredModels,
  inferenceModelSources,
  inferenceModels,
  inferenceProviderConnections,
  permissionGroups,
  users,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AISettingsService } from '@/modules/ai/ai.settings.service.js';
import { InferenceCoreBridgeService } from '@/modules/inference/core/inference-core-bridge.service.js';
import { INFERENCE_CORE_CHANGED_CHANNEL } from '@/modules/inference/core/inference-core-operation.service.js';
import { coreKeyProviderName } from '@/modules/inference/core/inference-core-provider-map.js';
import { InferenceCoreRuntimeService } from '@/modules/inference/core/inference-core-runtime.service.js';
import { InferenceModelService } from '@/modules/inference/models/inference-model.service.js';
import type { InferenceModelConfigurationInput } from '@/modules/inference/models/inference-model.types.js';
import { InferenceModelConfigurationService } from '@/modules/inference/models/inference-model-configuration.service.js';
import {
  CLOUD_INFERENCE_CONNECTION_NAME,
  CLOUD_MANAGED_METADATA_KEY,
  type CloudInferenceMode,
  type CloudInferenceModel,
  type CloudInferenceState,
  isCloudManagedConnection,
  readStoredCloudInference,
  type StoredCloudInference,
  workspaceOnCloudEndpoint,
} from '@/modules/inference/providers/inference-cloud.js';
import { InferenceProviderService } from '@/modules/inference/providers/inference-provider.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { ensureCloudDefaultApiBudget } from './cloud-link-inference-budget.js';
import { CLOUD_ADDON_SETTING_KEYS, writeCloudSetting } from './cloud-link-settings.js';

const logger = createChildLogger('CloudInference');

/** The answer waits this long for the work to settle; slower work continues and the account asks again. */
const ANSWER_WAIT_MS = 9_000;
/** While the core installs, the state is checked again this often. */
const RECHECK_MS = 15_000;
/** A failed core install is started again at most this often. */
const CORE_INSTALL_RETRY_MS = 10 * 60_000;
const CORE_BUSY_STATES = new Set(['resolving', 'pulling', 'installing', 'starting', 'updating', 'rolling_back']);
/** Direct mode reads the endpoint's model list this long at most. */
const MODELS_TIMEOUT_MS = 10_000;
/** The bounds AI Workspace settings accept (AIConfigUpdateSchema). */
const WORKSPACE_CONTEXT_TOKENS = { min: 4_000, max: 1_000_000 };
const WORKSPACE_COMPLETION_TOKENS = { min: 256, max: 128_000 };
/**
 * The model's price as the account states it (USD per million tokens, the customer price), so per-user API budgets
 * here count Opfield Cloud usage. An account that sends no price leaves the model free here.
 */
function cloudPricing(pricing: CloudInferenceModel['pricing']) {
  const micro = (usd: number) => Math.round(usd * 1_000_000);
  return {
    version: 'opfield-cloud',
    inputMicrodollarsPerMillion: pricing ? micro(pricing.inputPerMUsd) : 0,
    outputMicrodollarsPerMillion: pricing ? micro(pricing.outputPerMUsd) : 0,
    ...(pricing ? { cachedInputMicrodollarsPerMillion: micro(pricing.cacheReadPerMUsd) } : {}),
    source: 'manual' as const,
  };
}

export type CloudInferenceInput =
  | { enabled: true; baseUrl: string; apiKey: string; models: CloudInferenceModel[]; tierMonthlyUsd?: number | null }
  | { enabled: false };

export interface CloudInferenceAnswer {
  state: CloudInferenceState;
  error?: string;
}

function keyHash(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/** The mode a state runs in; a state written before modes ran in core mode once it was configured. */
function modeOf(stored: StoredCloudInference): CloudInferenceMode | null {
  return stored.mode ?? (stored.appliedKeyHash ? 'core' : null);
}

/** Whether AI Workspace was already switched to the add-on (a ready state from before modes counts as switched). */
function workspaceAppliedOf(stored: StoredCloudInference): boolean {
  return stored.workspaceApplied ?? (stored.mode === undefined && Boolean(stored.appliedKeyHash));
}

/** AI Workspace on the account's endpoint, the way an administrator would set up an OpenAI-compatible provider. */
function directWorkspaceSettings(baseUrl: string, apiKey: string, model: CloudInferenceModel): Record<string, unknown> {
  return {
    providerType: 'openai_compatible',
    providerUrl: baseUrl,
    apiKey,
    model: model.publicId,
    endpointMode: 'chat_completions',
    maxContextTokens: clamp(model.maxInputTokens, WORKSPACE_CONTEXT_TOKENS),
    ...(model.maxOutputTokens
      ? { maxCompletionTokens: clamp(model.maxOutputTokens, WORKSPACE_COMPLETION_TOKENS) }
      : {}),
    supportsImages: model.modalities.includes('image'),
  };
}

function answerOf(stored: StoredCloudInference | null): CloudInferenceAnswer {
  if (!stored) return { state: 'removed' };
  return { state: stored.state, ...(stored.state === 'failed' && stored.error ? { error: stored.error } : {}) };
}

/**
 * The "Opfield Cloud" AI add-on of a linked installation (cloud link inference-cloud), the way an administrator would
 * set it up. With the inference core installed (core mode): inference on, an OpenAI-compatible connection "Opfield
 * Cloud" with the account's key, synced, its models published to everyone, and AI Workspace on the first model. The
 * connection and models are the account's: people and agents cannot change them (CLOUD_MANAGED). Without the core
 * (direct mode, the core is never installed for it): AI Workspace talks to the account's endpoint with the key. AI
 * Workspace is switched once per enabling or mode change, so an administrator's later choice holds. Turning the add-on
 * off removes the models and the connection, or takes the key out of AI Workspace.
 */
export class CloudInference {
  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;
  private recheck: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly db: DrizzleClient) {}

  /**
   * After a restart: carries on with an add-on that was still being set up or removed, or whose mode no longer matches
   * the core. Then follows the core: an install that completes moves direct mode to core mode, a core that is gone
   * moves core mode to direct mode. The core's status event is the hook (not the recheck): the recheck only runs while
   * the add-on is installing, and a ready direct-mode add-on would otherwise need a poll for an install it cannot see.
   */
  async start(): Promise<void> {
    container.resolve(EventBusService).subscribe(INFERENCE_CORE_CHANGED_CHANNEL, (status) => {
      void this.onCoreChanged(status).catch((error) =>
        logger.warn('Opfield Cloud AI could not follow the inference core', { error: errorMessage(error) })
      );
    });
    const stored = await readStoredCloudInference(this.db).catch(() => null);
    if (stored && (stored.state === 'installing' || (await this.modeChanged(stored)))) void this.kick();
  }

  private async onCoreChanged(status: unknown): Promise<void> {
    const installed = Boolean((status as { installed?: unknown } | null)?.installed);
    const stored = await readStoredCloudInference(this.db);
    if (!stored?.enabled) return;
    const mode = modeOf(stored);
    if ((mode === 'direct' && installed) || (mode === 'core' && !installed)) void this.kick();
  }

  /** An enabled add-on whose mode is not the one the core asks for now. */
  private async modeChanged(stored: StoredCloudInference): Promise<boolean> {
    if (!stored.enabled) return false;
    return modeOf(stored) !== ((await this.coreInstalled()) ? 'core' : 'direct');
  }

  /** The core is installed (a version is recorded), whether ready, busy, degraded or failed after an update. */
  private async coreInstalled(): Promise<boolean> {
    const status = await container.resolve(InferenceCoreRuntimeService).getStatus();
    return status.installed !== null;
  }

  /** inference-cloud: stores what the account asks for (idempotent) and answers the state reached within ~9 s. */
  async apply(input: CloudInferenceInput): Promise<CloudInferenceAnswer> {
    const stored = await readStoredCloudInference(this.db);
    const now = new Date().toISOString();
    if (input.enabled) {
      const hash = keyHash(input.apiKey);
      const unchanged =
        stored?.enabled === true &&
        stored.keyHash === hash &&
        stored.baseUrl === input.baseUrl &&
        JSON.stringify(stored.models) === JSON.stringify(input.models);
      if (!unchanged || stored?.state === 'failed' || stored?.state === 'removed') {
        await this.save({
          enabled: true,
          baseUrl: input.baseUrl,
          apiKey: container.resolve(CryptoService).encryptString(input.apiKey),
          keyHash: hash,
          models: input.models,
          state: unchanged && stored?.state === 'ready' ? 'ready' : 'installing',
          error: null,
          updatedAt: now,
          appliedKeyHash: stored?.appliedKeyHash ?? null,
          appliedBaseUrl: stored?.appliedBaseUrl ?? null,
          coreInstallAt: stored?.coreInstallAt ?? null,
          tierMonthlyUsd: input.tierMonthlyUsd ?? null,
          budgetChecked: stored?.enabled === true && stored.budgetChecked === true,
          // A new enabling switches AI Workspace again; a new key or model list does not.
          ...(stored?.mode ? { mode: stored.mode } : {}),
          workspaceApplied: stored?.enabled === true ? workspaceAppliedOf(stored) : false,
          workspaceBaseUrl: stored?.workspaceBaseUrl ?? null,
        });
      } else if ((stored.tierMonthlyUsd ?? null) !== (input.tierMonthlyUsd ?? null)) {
        await this.update({ tierMonthlyUsd: input.tierMonthlyUsd ?? null });
      }
    } else if (stored?.enabled || (stored && stored.state !== 'removed')) {
      await this.save({
        ...stored,
        enabled: false,
        apiKey: null,
        state: 'installing',
        error: null,
        updatedAt: now,
        budgetChecked: false,
      });
    } else if (!stored) {
      return { state: 'removed' };
    }
    await Promise.race([this.kick(), new Promise((resolve) => setTimeout(resolve, ANSWER_WAIT_MS).unref?.())]);
    return answerOf(await readStoredCloudInference(this.db));
  }

  private async save(next: StoredCloudInference): Promise<void> {
    await writeCloudSetting(this.db, CLOUD_ADDON_SETTING_KEYS.inference, next);
  }

  private async update(patch: Partial<StoredCloudInference>): Promise<void> {
    const stored = await readStoredCloudInference(this.db);
    if (stored) await this.save({ ...stored, ...patch, updatedAt: new Date().toISOString() });
  }

  /** Runs one reconciliation after the one in progress (one waits at most). */
  private kick(): Promise<void> {
    if (this.queued) return this.queued;
    const run = this.chain.then(async () => {
      this.queued = null;
      await this.reconcile();
    });
    this.queued = run;
    this.chain = run.catch((error) => {
      logger.warn('Opfield Cloud AI reconciliation failed', { error: errorMessage(error) });
    });
    return this.chain;
  }

  private scheduleRecheck(): void {
    if (this.recheck) return;
    this.recheck = setTimeout(() => {
      this.recheck = null;
      void this.kick();
    }, RECHECK_MS);
    this.recheck.unref?.();
  }

  private async reconcile(): Promise<void> {
    const stored = await readStoredCloudInference(this.db);
    if (!stored) return;
    let secret: string | null = null;
    try {
      if (!stored.enabled) {
        await this.remove();
        await this.releaseWorkspace(stored);
        await this.update({
          state: 'removed',
          error: null,
          appliedKeyHash: null,
          appliedBaseUrl: null,
          workspaceApplied: false,
          workspaceBaseUrl: null,
        });
        return;
      }
      if (!stored.apiKey || !stored.baseUrl) throw new Error('The add-on has no key');
      secret = container.resolve(CryptoService).decryptString(stored.apiKey);
      const mode: CloudInferenceMode = (await this.coreInstalled()) ? 'core' : 'direct';
      if (modeOf(stored) !== mode) {
        // Core gone: its connection and models go (best effort, the core may not answer). Direct mode left: AI
        // Workspace keeps the endpoint until core mode switches it.
        if (modeOf(stored) === 'core') {
          await this.remove().catch((error) =>
            logger.warn('Opfield Cloud AI could not remove the core connection', { error: errorMessage(error) })
          );
        }
        await this.update({ mode, workspaceApplied: false, appliedKeyHash: null, appliedBaseUrl: null });
        logger.info('Opfield Cloud AI changes mode', { from: modeOf(stored), to: mode });
        return this.reconcile();
      }
      if (mode === 'direct') {
        const workspaceBaseUrl = await this.applyDirect(stored, secret);
        await this.update({
          state: 'ready',
          error: null,
          appliedKeyHash: stored.keyHash,
          appliedBaseUrl: stored.baseUrl,
          workspaceApplied: true,
          workspaceBaseUrl,
        });
        logger.info('Opfield Cloud AI is ready in AI Workspace', { model: stored.models[0]?.publicId });
        return;
      }
      if (!(await this.coreReady(stored))) return;
      const adminId = await this.firstSystemAdmin();
      const connectionId = await this.ensureConnection(stored, secret, adminId);
      await this.requireSynced(connectionId);
      await this.publishModels(stored, connectionId, adminId);
      await this.requirePublished(stored, connectionId);
      // Ready only now: the connection read the endpoint's models and both models are published.
      if (!stored.budgetChecked) await ensureCloudDefaultApiBudget(this.db, adminId, stored.tierMonthlyUsd);
      if (!workspaceAppliedOf(stored)) await this.switchWorkspaceToCore(stored);
      await this.update({
        state: 'ready',
        error: null,
        appliedKeyHash: stored.keyHash,
        appliedBaseUrl: stored.baseUrl,
        budgetChecked: true,
        mode: 'core',
        workspaceApplied: true,
        workspaceBaseUrl: workspaceAppliedOf(stored) ? (stored.workspaceBaseUrl ?? null) : null,
      });
      logger.info('Opfield Cloud AI is ready', { connectionId, models: stored.models.map((model) => model.publicId) });
    } catch (error) {
      const message = secret ? errorMessage(error).replaceAll(secret, '[REDACTED]') : errorMessage(error);
      logger.warn('Opfield Cloud AI could not be set up', { error: message });
      await this.update({ state: 'failed', error: message.slice(0, 500) });
    }
  }

  /**
   * Direct mode: the endpoint lists the first model with the key, then AI Workspace uses it (all settings once per
   * enabling; afterwards a new key or URL, or a model the account dropped, only while AI Workspace still uses the
   * endpoint). Answers the base URL AI Workspace now uses from the add-on.
   */
  private async applyDirect(stored: StoredCloudInference, apiKey: string): Promise<string | null> {
    const baseUrl = stored.baseUrl ?? '';
    const [model] = stored.models;
    if (!model) throw new Error('The add-on has no models');
    await this.requireListed(baseUrl, apiKey, model.publicId);
    const workspace = container.resolve(AISettingsService);
    if (!workspaceAppliedOf(stored)) {
      await workspace.updateConfig({ enabled: true, ...directWorkspaceSettings(baseUrl, apiKey, model) });
      return baseUrl;
    }
    const config = await workspace.getConfig();
    if (!workspaceOnCloudEndpoint(stored, config)) return stored.workspaceBaseUrl ?? null;
    if (!stored.models.some((candidate) => candidate.publicId === config.model)) {
      await workspace.updateConfig(directWorkspaceSettings(baseUrl, apiKey, model));
    } else if (stored.appliedKeyHash !== stored.keyHash || stored.appliedBaseUrl !== baseUrl) {
      await workspace.updateConfig({ providerUrl: baseUrl, apiKey });
    }
    return baseUrl;
  }

  /** `GET {baseUrl}/models` with the key lists the model; otherwise the add-on is failed with the reason. */
  private async requireListed(baseUrl: string, apiKey: string, modelId: string): Promise<void> {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`The Opfield Cloud endpoint answered HTTP ${response.status} to the model list`);
    const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
    const listed = Array.isArray(body?.data)
      ? body.data.some((item) => (item as { id?: unknown } | null)?.id === modelId)
      : false;
    if (!listed) throw new Error(`The Opfield Cloud endpoint does not list ${modelId}`);
  }

  /** Core mode is ready: AI Workspace on Opfield Inference with the account's default model (its first). */
  private async switchWorkspaceToCore(stored: StoredCloudInference): Promise<void> {
    const workspace = container.resolve(AISettingsService);
    const config = await workspace.getConfig();
    await workspace.updateConfig({
      enabled: true,
      providerType: 'opfield_inference',
      opfieldInferenceModel: stored.models[0]?.publicId ?? '',
      // The endpoint and key direct mode left behind go with it.
      ...(workspaceOnCloudEndpoint(stored, config) ? { providerUrl: '', apiKey: '' } : {}),
    });
  }

  /** The add-on is off: AI Workspace still on the endpoint direct mode wrote loses the key and turns off. */
  private async releaseWorkspace(stored: StoredCloudInference): Promise<void> {
    const workspace = container.resolve(AISettingsService);
    if (!workspaceOnCloudEndpoint(stored, await workspace.getConfig())) return;
    await workspace.updateConfig({ apiKey: '', enabled: false });
  }

  /** Inference on and the core ready; otherwise starts (or waits for) the core install and keeps `installing`. */
  private async coreReady(stored: StoredCloudInference): Promise<boolean> {
    const generalSettings = container.resolve(GeneralSettingsService);
    if (!(await generalSettings.isFeatureEnabled('inferenceEnabled'))) {
      await generalSettings.updateConfig({ features: { inferenceEnabled: true } });
    }
    if (await container.resolve(InferenceCoreBridgeService).coreReady()) return true;
    const runtime = container.resolve(InferenceCoreRuntimeService);
    const status = await runtime.getStatus();
    if (!status.operation && !CORE_BUSY_STATES.has(status.state)) {
      const last = stored.coreInstallAt ? Date.parse(stored.coreInstallAt) : 0;
      if (status.state === 'failed' && Date.now() - last < CORE_INSTALL_RETRY_MS) {
        throw new Error(`The inference core could not be installed: ${status.lastError ?? 'unknown error'}`);
      }
      if (status.state === 'degraded') await runtime.repair();
      else await runtime.install();
      await this.update({ coreInstallAt: new Date().toISOString(), state: 'installing', error: null });
      logger.info('Opfield Cloud AI installs the inference core', { from: status.state });
    }
    this.scheduleRecheck();
    return false;
  }

  /** The Opfield Cloud connection with the account's key; created by the first system administrator. */
  private async ensureConnection(stored: StoredCloudInference, apiKey: string, adminId: string): Promise<string> {
    const providers = container.resolve(InferenceProviderService);
    const existing = await this.cloudConnection();
    if (!existing) {
      const created = await providers.createKeyConnection(
        adminId,
        {
          providerId: 'openai-compatible',
          name: CLOUD_INFERENCE_CONNECTION_NAME,
          apiKey,
          baseUrl: stored.baseUrl ?? '',
          authType: 'api_key',
        },
        { metadata: { [CLOUD_MANAGED_METADATA_KEY]: true } }
      );
      return created.id;
    }
    if (stored.appliedKeyHash !== stored.keyHash || stored.appliedBaseUrl !== stored.baseUrl) {
      // A new key (or endpoint) from the account: the core provider takes it, the row keeps its id and models.
      const client = await container.resolve(InferenceCoreBridgeService).requireClient();
      const providerRef = coreKeyProviderName(existing.id);
      if (stored.appliedBaseUrl !== stored.baseUrl) {
        await client.patchCoreProvider(providerRef, { baseUrl: stored.baseUrl });
      }
      if (stored.appliedKeyHash !== stored.keyHash) await client.replaceCoreProviderKey(providerRef, apiKey);
      await this.db
        .update(inferenceProviderConnections)
        .set({ baseUrl: stored.baseUrl ?? existing.baseUrl, updatedAt: new Date() })
        .where(eq(inferenceProviderConnections.id, existing.id));
    }
    // Every pass reads the endpoint's models again: readiness stands on a sync that worked now.
    await providers.syncConnection(existing.id, true);
    return existing.id;
  }

  /** The connection's last sync worked; otherwise the add-on is failed with the sync error (retried on a re-send). */
  private async requireSynced(connectionId: string): Promise<void> {
    const [row] = await this.db
      .select({
        syncStatus: inferenceProviderConnections.syncStatus,
        syncLastError: inferenceProviderConnections.syncLastError,
      })
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, connectionId))
      .limit(1);
    if (row?.syncStatus !== 'success') {
      throw new Error(
        `The Opfield Cloud connection could not read the models of the endpoint: ${row?.syncLastError ?? 'unknown error'}`
      );
    }
  }

  /** Every model of the add-on is published (enabled) with an enabled source on the connection. */
  private async requirePublished(stored: StoredCloudInference, connectionId: string): Promise<void> {
    for (const model of stored.models) {
      const [row] = await this.db
        .select({ id: inferenceModels.id })
        .from(inferenceModels)
        .innerJoin(inferenceModelSources, eq(inferenceModelSources.modelId, inferenceModels.id))
        .where(
          and(
            eq(inferenceModels.publicId, model.publicId.toLowerCase()),
            eq(inferenceModels.enabled, true),
            eq(inferenceModelSources.connectionId, connectionId),
            eq(inferenceModelSources.enabled, true)
          )
        )
        .limit(1);
      if (!row) throw new Error(`${model.displayName} (${model.publicId}) could not be published`);
    }
  }

  private async cloudConnection() {
    const rows = await this.db
      .select()
      .from(inferenceProviderConnections)
      .where(isNull(inferenceProviderConnections.deletedAt));
    return rows.find((row) => isCloudManagedConnection(row.metadata)) ?? null;
  }

  /** Both models published to everyone, each bound to the connection's model of the same id. */
  private async publishModels(stored: StoredCloudInference, connectionId: string, adminId: string): Promise<void> {
    const configuration = container.resolve(InferenceModelConfigurationService);
    const discovered = await this.db
      .select()
      .from(inferenceDiscoveredModels)
      .where(
        and(eq(inferenceDiscoveredModels.connectionId, connectionId), eq(inferenceDiscoveredModels.available, true))
      );
    for (const model of stored.models) {
      const upstream = discovered.find((row) => row.remoteModelId === model.publicId);
      if (!upstream) throw new Error(`The Opfield Cloud endpoint does not list ${model.publicId}`);
      const [existing] = await this.db
        .select({ id: inferenceModels.id })
        .from(inferenceModels)
        .where(eq(inferenceModels.publicId, model.publicId.toLowerCase()))
        .limit(1);
      await configuration.save(adminId, existing?.id ?? null, cloudModelConfiguration(model, connectionId, upstream));
    }
  }

  /** Turning the add-on off: its models, then the connection. */
  private async remove(): Promise<void> {
    const connection = await this.cloudConnection();
    if (!connection) return;
    const adminId = await this.firstSystemAdmin();
    const modelIds = await this.db
      .selectDistinct({ id: inferenceModelSources.modelId, publicId: inferenceModels.publicId })
      .from(inferenceModelSources)
      .innerJoin(inferenceModels, eq(inferenceModels.id, inferenceModelSources.modelId))
      .where(eq(inferenceModelSources.connectionId, connection.id));
    const workspace = container.resolve(AISettingsService);
    const config = await workspace.getConfig();
    const workspaceOnRemoved =
      config.providerType === 'opfield_inference' &&
      modelIds.some((model) => model.publicId === config.opfieldInferenceModel);
    const models = container.resolve(InferenceModelService);
    for (const { id } of modelIds) await models.remove(adminId, id);
    await container.resolve(InferenceProviderService).disconnect(adminId, connection.id);
    // AI Workspace on one of those models falls back as when inference is turned off.
    if (workspaceOnRemoved) await workspace.handleInferenceDisabled();
    logger.info('Opfield Cloud AI removed', { connectionId: connection.id, models: modelIds.length });
  }

  private async firstSystemAdmin(): Promise<string> {
    const [admin] = await this.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(permissionGroups, eq(users.groupId, permissionGroups.id))
      .where(and(eq(permissionGroups.name, 'system-admin'), isNull(users.deletedAt), eq(users.isBlocked, false)))
      .orderBy(asc(users.createdAt))
      .limit(1);
    if (!admin) throw new Error('This installation has no system administrator yet');
    return admin.id;
  }
}

/**
 * The published model of one add-on model: metadata as the account states it (the endpoint's model list states no
 * modalities, and discovery takes the account's values for this connection too), access for everyone.
 */
export function cloudModelConfiguration(
  model: CloudInferenceModel,
  connectionId: string,
  upstream?: { id: string }
): InferenceModelConfigurationInput {
  const efforts = [...new Set(model.reasoningEfforts.map((effort) => effort.trim().toLowerCase()).filter(Boolean))];
  const modalities = model.modalities;
  const autoCompactTokenLimit = Math.max(1, Math.floor(model.maxInputTokens * 0.9));
  return {
    model: {
      publicId: model.publicId,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      autoCompactTokenLimit,
      modalities: modalities.length ? modalities : ['text'],
      capabilities: model.capabilities,
      reasoningEfforts: efforts,
      defaultReasoningEffort: null,
      defaultAccessAllowed: true,
      subscriptionMultiplier: 1,
    },
    sources: [
      {
        connectionId,
        ...(upstream ? { discoveredModelId: upstream.id } : { upstreamModelId: model.publicId }),
        reasoningEffortMap: Object.fromEntries(efforts.map((effort) => [effort, effort])),
        capabilitiesOverride: model.capabilities,
        manualMetadata: {
          contextWindow: model.contextWindow,
          maxInputTokens: model.maxInputTokens,
          ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
          autoCompactTokenLimit,
        },
        pricing: cloudPricing(model.pricing),
      },
    ],
    access: { mode: 'everyone', subjects: [] },
  };
}
