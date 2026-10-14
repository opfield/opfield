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
import { InferenceCoreBridgeService } from '@/modules/inference/core/inference-core-bridge.service.js';
import { coreKeyProviderName } from '@/modules/inference/core/inference-core-provider-map.js';
import { InferenceCoreRuntimeService } from '@/modules/inference/core/inference-core-runtime.service.js';
import { InferenceModelService } from '@/modules/inference/models/inference-model.service.js';
import type { InferenceModelConfigurationInput } from '@/modules/inference/models/inference-model.types.js';
import { InferenceModelConfigurationService } from '@/modules/inference/models/inference-model-configuration.service.js';
import {
  CLOUD_INFERENCE_CONNECTION_NAME,
  CLOUD_MANAGED_METADATA_KEY,
  type CloudInferenceModel,
  type CloudInferenceState,
  isCloudManagedConnection,
  readStoredCloudInference,
  type StoredCloudInference,
} from '@/modules/inference/providers/inference-cloud.js';
import { InferenceProviderService } from '@/modules/inference/providers/inference-provider.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { CLOUD_ADDON_SETTING_KEYS, writeCloudSetting } from './cloud-link-settings.js';

const logger = createChildLogger('CloudInference');

/** The answer waits this long for the work to settle; slower work continues and the account asks again. */
const ANSWER_WAIT_MS = 9_000;
/** While the core installs, the state is checked again this often. */
const RECHECK_MS = 15_000;
/** A failed core install is started again at most this often. */
const CORE_INSTALL_RETRY_MS = 10 * 60_000;
const CORE_BUSY_STATES = new Set(['resolving', 'pulling', 'installing', 'starting', 'updating', 'rolling_back']);
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
  | { enabled: true; baseUrl: string; apiKey: string; models: CloudInferenceModel[] }
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

function answerOf(stored: StoredCloudInference | null): CloudInferenceAnswer {
  if (!stored) return { state: 'removed' };
  return { state: stored.state, ...(stored.state === 'failed' && stored.error ? { error: stored.error } : {}) };
}

/**
 * The "Opfield Cloud" AI add-on of a managed installation (cloud link inference-cloud), the way an administrator would
 * set it up: inference on, the inference core installed, an OpenAI-compatible connection "Opfield Cloud" with the
 * account's key, synced, and its models published to everyone. The connection and models are the account's: people
 * and agents cannot change them (CLOUD_MANAGED). Turning the add-on off removes the models and the connection.
 */
export class CloudInference {
  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;
  private recheck: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly db: DrizzleClient) {}

  /** After a restart: carries on with an add-on that was still being set up or removed. */
  async start(): Promise<void> {
    const stored = await readStoredCloudInference(this.db).catch(() => null);
    if (stored && stored.state === 'installing') void this.kick();
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
        });
      }
    } else if (stored?.enabled || (stored && stored.state !== 'removed')) {
      await this.save({ ...stored, enabled: false, apiKey: null, state: 'installing', error: null, updatedAt: now });
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
        await this.update({ state: 'removed', error: null, appliedKeyHash: null, appliedBaseUrl: null });
        return;
      }
      if (!stored.apiKey || !stored.baseUrl) throw new Error('The add-on has no key');
      secret = container.resolve(CryptoService).decryptString(stored.apiKey);
      if (!(await this.coreReady(stored))) return;
      const adminId = await this.firstSystemAdmin();
      const connectionId = await this.ensureConnection(stored, secret, adminId);
      await this.publishModels(stored, connectionId, adminId);
      await this.update({
        state: 'ready',
        error: null,
        appliedKeyHash: stored.keyHash,
        appliedBaseUrl: stored.baseUrl,
      });
      logger.info('Opfield Cloud AI is ready', { connectionId, models: stored.models.map((model) => model.publicId) });
    } catch (error) {
      const message = secret ? errorMessage(error).replaceAll(secret, '[REDACTED]') : errorMessage(error);
      logger.warn('Opfield Cloud AI could not be set up', { error: message });
      await this.update({ state: 'failed', error: message.slice(0, 500) });
    }
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
      await providers.syncConnection(existing.id, true);
    } else if (!(await this.hasDiscoveredModels(existing.id))) {
      await providers.syncConnection(existing.id, true);
    }
    return existing.id;
  }

  private async cloudConnection() {
    const rows = await this.db
      .select()
      .from(inferenceProviderConnections)
      .where(isNull(inferenceProviderConnections.deletedAt));
    return rows.find((row) => isCloudManagedConnection(row.metadata)) ?? null;
  }

  private async hasDiscoveredModels(connectionId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: inferenceDiscoveredModels.id })
      .from(inferenceDiscoveredModels)
      .where(eq(inferenceDiscoveredModels.connectionId, connectionId))
      .limit(1);
    return Boolean(row);
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
      .selectDistinct({ id: inferenceModelSources.modelId })
      .from(inferenceModelSources)
      .where(eq(inferenceModelSources.connectionId, connection.id));
    const models = container.resolve(InferenceModelService);
    for (const { id } of modelIds) await models.remove(adminId, id);
    await container.resolve(InferenceProviderService).disconnect(adminId, connection.id);
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

/** The published model of one add-on model: limits as the account states them, access for everyone. */
export function cloudModelConfiguration(
  model: CloudInferenceModel,
  connectionId: string,
  upstream?: { id: string; modalities: string[] | null }
): InferenceModelConfigurationInput {
  const efforts = [...new Set(model.reasoningEfforts.map((effort) => effort.trim().toLowerCase()).filter(Boolean))];
  const sourceModalities = upstream?.modalities?.length ? upstream.modalities : ['text'];
  const modalities = model.modalities.filter((modality) => sourceModalities.includes(modality));
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
