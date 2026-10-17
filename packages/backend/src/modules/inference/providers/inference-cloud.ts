import { and, eq, isNull } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { inferenceModelSources, inferenceProviderConnections } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { CLOUD_ADDON_SETTING_KEYS, readCloudSetting } from '@/modules/cloud-link/cloud-link-settings.js';
import { CryptoService } from '@/services/crypto.service.js';
import type { DiscoveredInferenceModel } from './inference-provider.types.js';

const logger = createChildLogger('InferenceCloud');

/** Metadata marker of the "Opfield Cloud" provider connection the Opfield account manages. */
export const CLOUD_MANAGED_METADATA_KEY = 'cloudManaged';
export const CLOUD_MANAGED_INFERENCE_MESSAGE = 'Managed by your Opfield account';
export const CLOUD_INFERENCE_CONNECTION_NAME = 'Opfield Cloud';
const USAGE_CACHE_MS = 60_000;
const USAGE_TIMEOUT_MS = 4_000;

export type CloudInferenceState = 'installing' | 'ready' | 'failed' | 'removed';
/**
 * How the add-on runs: `core` (the inference core is installed: a connection and published models) or `direct` (no
 * core: AI Workspace talks to the account's endpoint itself).
 */
export type CloudInferenceMode = 'core' | 'direct';

/** One model of the add-on, as the account describes it (inference-cloud `models`). */
export interface CloudInferenceModel {
  publicId: string;
  displayName: string;
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number | null;
  modalities: string[];
  capabilities: Record<string, boolean>;
  reasoningEfforts: string[];
  /** Customer price in USD per million tokens; null from an account that sends none (then free here). */
  pricing: { inputPerMUsd: number; outputPerMUsd: number; cacheReadPerMUsd: number } | null;
}

/** The add-on as the account set it (settings `cloud:inference`); the key is stored encrypted. */
export interface StoredCloudInference {
  enabled: boolean;
  baseUrl: string | null;
  apiKey: { encryptedKey: string; encryptedDek: string } | null;
  /** SHA-256 of the key: tells a new key apart without decrypting. */
  keyHash: string | null;
  models: CloudInferenceModel[];
  state: CloudInferenceState;
  error: string | null;
  updatedAt: string;
  /** The key and base URL the connection was last configured with. */
  appliedKeyHash?: string | null;
  appliedBaseUrl?: string | null;
  /** When the add-on last started a core install (one at a time, retried at most every 10 minutes). */
  coreInstallAt?: string | null;
  /** The tier's monthly price in USD as the account sends it; null from an older account. */
  tierMonthlyUsd?: number | null;
  /** The default API budget was checked when the add-on first became ready (once per enabling). */
  budgetChecked?: boolean;
  /** The mode the add-on runs in; absent in a state written before modes (then `core`). */
  mode?: CloudInferenceMode;
  /** AI Workspace was switched to the add-on since it was enabled or its mode changed (once, so later choices hold). */
  workspaceApplied?: boolean;
  /** The base URL direct mode wrote into AI Workspace; null when it wrote none. */
  workspaceBaseUrl?: string | null;
}

/** Usage of the add-on as the account's endpoint reports it (`GET {baseUrl}/usage`). */
export interface CloudInferenceUsage {
  plan: string | null;
  windows: Array<{ window: string; usedPercent: number; resetsAt: string | null }>;
}

export function isCloudManagedConnection(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.[CLOUD_MANAGED_METADATA_KEY] === true;
}

function cloudManagedError(): AppError {
  return new AppError(409, 'CLOUD_MANAGED', CLOUD_MANAGED_INFERENCE_MESSAGE);
}

/**
 * The lock holds while the account manages this installation, or while a linked installation has the add-on on (a
 * restored copy or an ended link has no owner).
 */
export async function lockedByCloud(): Promise<boolean> {
  // Loaded on use: the cloud link module is not part of the inference services' import graph.
  const { isCloudLinked, isCloudManaged } = await import('@/modules/cloud-link/cloud-link-managed-locks.js');
  if (await isCloudManaged()) return true;
  if (!(await isCloudLinked())) return false;
  return (await readStoredCloudInference(inferenceCloudDb()).catch(() => null))?.enabled === true;
}

/** AI Workspace still uses the endpoint direct mode wrote into it (an administrator may have moved it elsewhere). */
export function workspaceOnCloudEndpoint(
  stored: Pick<StoredCloudInference, 'workspaceBaseUrl'> | null,
  config: { providerType: string; providerUrl: string }
): boolean {
  return (
    Boolean(stored?.workspaceBaseUrl) &&
    config.providerType === 'openai_compatible' &&
    config.providerUrl === stored?.workspaceBaseUrl
  );
}

/** AI Workspace runs on the add-on in direct mode: its URL, key and model are the account's (read-only in Settings). */
export async function workspaceConnectedToCloud(
  db: DrizzleClient,
  config: { providerType: string; providerUrl: string }
): Promise<boolean> {
  const stored = await readStoredCloudInference(db).catch(() => null);
  if (!stored?.enabled || stored.mode !== 'direct' || !workspaceOnCloudEndpoint(stored, config)) return false;
  return lockedByCloud();
}

/** 409 CLOUD_MANAGED for the Opfield Cloud connection (people and agents; the cloud link uses the services). */
export async function assertConnectionNotCloudManaged(db: DrizzleClient, connectionId: string): Promise<void> {
  if (!(await lockedByCloud())) return;
  const [connection] = await db
    .select({ metadata: inferenceProviderConnections.metadata })
    .from(inferenceProviderConnections)
    .where(and(eq(inferenceProviderConnections.id, connectionId), isNull(inferenceProviderConnections.deletedAt)))
    .limit(1);
  if (connection && isCloudManagedConnection(connection.metadata)) throw cloudManagedError();
}

/** Whether a model is one the add-on published (a source on the Opfield Cloud connection). */
export async function isCloudManagedModel(db: DrizzleClient, modelId: string): Promise<boolean> {
  const sources = await db
    .select({ metadata: inferenceProviderConnections.metadata })
    .from(inferenceModelSources)
    .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
    .where(eq(inferenceModelSources.modelId, modelId));
  return sources.some((source) => isCloudManagedConnection(source.metadata));
}

/** 409 CLOUD_MANAGED when a person or agent changes or deletes a model of the add-on. */
export async function assertModelNotCloudManaged(db: DrizzleClient, modelId: string | null): Promise<void> {
  if (modelId && (await isCloudManagedModel(db, modelId)) && (await lockedByCloud())) throw cloudManagedError();
}

/** The connection update a person may still make on the Opfield Cloud connection: its place in the order. */
export function isRoutingOrderOnly(input: Record<string, unknown>): boolean {
  const fields = Object.keys(input).filter((key) => input[key] !== undefined);
  return fields.length > 0 && fields.every((key) => key === 'routingOrder');
}

export function readStoredCloudInference(db: DrizzleClient): Promise<StoredCloudInference | null> {
  return readCloudSetting<StoredCloudInference>(db, CLOUD_ADDON_SETTING_KEYS.inference);
}

/** Discovered fields the account's description replaces (not labelled as provider-reported in the admin UI). */
const CLOUD_DESCRIBED_FIELDS = [
  'displayName',
  'contextWindow',
  'maxInputTokens',
  'maxOutputTokens',
  'autoCompactTokenLimit',
  'reasoningEfforts',
  'modalities',
  'capabilities',
];

/**
 * The account's description of its models is the metadata of the Opfield Cloud connection's models, not discovery:
 * the endpoint's model list states no modalities or limits, so the core would discover text only and guess the rest.
 */
export async function withCloudModelMetadata(
  db: DrizzleClient,
  connection: { metadata: Record<string, unknown> | null },
  models: DiscoveredInferenceModel[]
): Promise<DiscoveredInferenceModel[]> {
  if (!isCloudManagedConnection(connection.metadata)) return models;
  const stored = await readStoredCloudInference(db).catch(() => null);
  if (!stored?.enabled || !stored.models.length) return models;
  const described = new Map(stored.models.map((model) => [model.publicId, model]));
  return models.map((model) => {
    const account = described.get(model.id);
    if (!account) return model;
    const fieldSources =
      model.metadata.field_sources && typeof model.metadata.field_sources === 'object'
        ? Object.fromEntries(
            Object.entries(model.metadata.field_sources as Record<string, unknown>).filter(
              ([field]) => !CLOUD_DESCRIBED_FIELDS.includes(field)
            )
          )
        : {};
    return {
      ...model,
      displayName: account.displayName,
      contextWindow: account.contextWindow,
      maxInputTokens: account.maxInputTokens,
      ...(account.maxOutputTokens ? { maxOutputTokens: account.maxOutputTokens } : {}),
      autoCompactTokenLimit: Math.max(1, Math.floor(account.maxInputTokens * 0.9)),
      modalities: [...account.modalities],
      capabilities: { ...model.capabilities, ...account.capabilities },
      reasoningEfforts: [...account.reasoningEfforts],
      metadata: { ...model.metadata, field_sources: fieldSources },
    };
  });
}

let usageCache: { at: number; key: string; value: CloudInferenceUsage | null } | null = null;

function parseUsage(body: unknown): CloudInferenceUsage | null {
  if (!body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  const windows = Array.isArray(value.windows) ? value.windows : [];
  return {
    plan: typeof value.plan === 'string' ? value.plan.slice(0, 32) : null,
    windows: windows.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const { window, usedPercent, resetsAt } = item as Record<string, unknown>;
      if (typeof window !== 'string' || typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return [];
      return [
        {
          window: window.slice(0, 16),
          usedPercent: Math.max(0, Math.min(100, usedPercent)),
          resetsAt: typeof resetsAt === 'string' && !Number.isNaN(Date.parse(resetsAt)) ? resetsAt : null,
        },
      ];
    }),
  };
}

/**
 * The add-on's usage for the provider card: fetched by the backend with the stored key (the key never reaches the
 * browser), cached for a minute; null while it cannot be read.
 */
export async function readCloudInferenceUsage(db: DrizzleClient): Promise<CloudInferenceUsage | null> {
  const stored = await readStoredCloudInference(db);
  if (!stored?.enabled || !stored.baseUrl || !stored.apiKey) return null;
  const cacheKey = `${stored.baseUrl}|${stored.keyHash ?? ''}`;
  if (usageCache && usageCache.key === cacheKey && Date.now() - usageCache.at < USAGE_CACHE_MS) {
    return usageCache.value;
  }
  let value: CloudInferenceUsage | null = null;
  try {
    const apiKey = container.resolve(CryptoService).decryptString(stored.apiKey);
    const response = await fetch(`${stored.baseUrl.replace(/\/+$/, '')}/usage`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
    value = response.ok ? parseUsage(await response.json()) : null;
    if (!response.ok) logger.debug('Opfield Cloud AI usage is not available', { status: response.status });
  } catch (error) {
    logger.debug('Could not read the Opfield Cloud AI usage', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  usageCache = { at: Date.now(), key: cacheKey, value };
  return value;
}

/** The database client, for the route and tool guards. */
export function inferenceCloudDb(): DrizzleClient {
  return container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
}
