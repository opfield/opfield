import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AISettingsService } from '@/modules/ai/ai.settings.service.js';
import { InferenceCoreBridgeService } from '@/modules/inference/core/inference-core-bridge.service.js';
import { INFERENCE_CORE_CHANGED_CHANNEL } from '@/modules/inference/core/inference-core-operation.service.js';
import { InferenceCoreRuntimeService } from '@/modules/inference/core/inference-core-runtime.service.js';
import { InferenceModelService } from '@/modules/inference/models/inference-model.service.js';
import type { CloudInferenceModel, StoredCloudInference } from '@/modules/inference/providers/inference-cloud.js';
import { InferenceProviderService } from '@/modules/inference/providers/inference-provider.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import type { CloudLinkAccess, CloudLinkProbe } from './cloud-link.types.js';
import { answerAddonRequest } from './cloud-link-addon-requests.js';
import { CloudInference, type CloudInferenceInput } from './cloud-link-inference.js';

let stored: StoredCloudInference | null = null;

vi.mock('@/modules/inference/providers/inference-cloud.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readStoredCloudInference: async () => (stored ? structuredClone(stored) : null),
}));
vi.mock('./cloud-link-settings.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  writeCloudSetting: async (_db: unknown, _key: string, value: StoredCloudInference) => {
    stored = structuredClone(value);
  },
}));
vi.mock('./cloud-link-inference-budget.js', () => ({ ensureCloudDefaultApiBudget: vi.fn(async () => {}) }));

const BASE_URL = 'https://ai.opfield.cloud/v1';
const KEY = 'sk-cloud-secret-1';
const swift: CloudInferenceModel = {
  publicId: 'opfield-swift',
  displayName: 'Opfield Swift',
  contextWindow: 200_000,
  maxInputTokens: 180_000,
  maxOutputTokens: 32_000,
  modalities: ['text', 'image'],
  capabilities: { tools: true },
  reasoningEfforts: [],
  pricing: null,
};
const heavy: CloudInferenceModel = { ...swift, publicId: 'opfield-heavy', displayName: 'Opfield Heavy' };
const enabled = (apiKey = KEY): CloudInferenceInput => ({
  enabled: true,
  baseUrl: BASE_URL,
  apiKey,
  models: [swift, heavy],
  tierMonthlyUsd: 10,
});

/** A drizzle stand-in: every chain resolves to the next queued rows. */
function fakeDb(results: unknown[][]): never {
  const chain: object = new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === 'then' ? (resolve: (rows: unknown) => void) => resolve(results.shift() ?? []) : () => chain,
    }
  );
  return chain as never;
}

let workspace: Record<string, unknown>;
let workspaceKey: string;
let core: { installed: object | null; ready: boolean };
let models: string[];
const updates: Record<string, unknown>[] = [];
const install = vi.fn(async () => ({}));
const handleInferenceDisabled = vi.fn(async () => {
  workspace.providerType = 'openai_compatible';
  if (!workspaceKey) workspace.enabled = false;
});
const removeModel = vi.fn(async () => {});
const disconnect = vi.fn(async () => {});
let eventBus: EventBusService;

/** Stubs a private step of CloudInference (the parts that need the database and the core). */
function stub(name: string, value: unknown) {
  const proto = CloudInference.prototype as unknown as Record<string, () => Promise<unknown>>;
  return vi.spyOn(proto, name).mockResolvedValue(value);
}

function stubCorePath() {
  stub('firstSystemAdmin', 'admin-1');
  stub('ensureConnection', 'conn-1');
  stub('requireSynced', undefined);
  stub('publishModels', undefined);
  stub('requirePublished', undefined);
}

beforeEach(() => {
  stored = null;
  workspace = {
    enabled: false,
    providerType: 'openai_compatible',
    providerUrl: '',
    model: '',
    opfieldInferenceModel: '',
  };
  workspaceKey = '';
  core = { installed: null, ready: false };
  models = ['opfield-swift', 'opfield-heavy'];
  updates.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 }))
  );
  eventBus = new EventBusService();
  container.registerInstance(EventBusService, eventBus);
  container.registerInstance(CryptoService, {
    encryptString: (value: string) => ({ encryptedKey: value, encryptedDek: 'dek' }),
    decryptString: (value: { encryptedKey: string }) => value.encryptedKey,
  } as never);
  container.registerInstance(AISettingsService, {
    getConfig: async () => ({ ...workspace }),
    updateConfig: async (patch: Record<string, unknown>) => {
      updates.push(patch);
      const { apiKey, ...rest } = patch;
      if (typeof apiKey === 'string') workspaceKey = apiKey;
      Object.assign(workspace, rest);
      return { ...workspace };
    },
    handleInferenceDisabled,
  } as never);
  container.registerInstance(InferenceCoreRuntimeService, {
    getStatus: async () => ({
      installed: core.installed,
      state: core.ready ? 'ready' : 'not_installed',
      operation: null,
    }),
    install,
    repair: install,
  } as never);
  container.registerInstance(InferenceCoreBridgeService, { coreReady: async () => core.ready } as never);
  container.registerInstance(GeneralSettingsService, {
    isFeatureEnabled: async () => true,
    updateConfig: async () => ({}),
  } as never);
  container.registerInstance(InferenceModelService, { remove: removeModel } as never);
  container.registerInstance(InferenceProviderService, { disconnect } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('inference-cloud gate', () => {
  it('takes inference-cloud on a self-hosted linked installation and keeps the other add-ons managed-only', async () => {
    const access: CloudLinkAccess = { privilegedAllowed: async () => false, managedByCloud: async () => false };
    const inferenceCloud = vi.fn(async () => ({ state: 'ready' as const }));
    const probe = { inferenceCloud, publicAlias: vi.fn() } as unknown as CloudLinkProbe;
    await expect(
      answerAddonRequest(probe, { id: 'a', type: 'inference-cloud', params: { enabled: false } }, access)
    ).resolves.toEqual({ id: 'a', ok: true, data: { state: 'ready' } });
    expect(inferenceCloud).toHaveBeenCalledWith({ enabled: false });
    await expect(
      answerAddonRequest(probe, { id: 'b', type: 'public-alias', params: { domain: null } }, access)
    ).resolves.toMatchObject({ id: 'b', ok: false, code: 'NOT_MANAGED_BY_CLOUD' });
  });
});

describe('CloudInference direct mode (no inference core)', () => {
  it('sets up AI Workspace on the endpoint and never installs the core', async () => {
    const answer = await new CloudInference(fakeDb([])).apply(enabled());
    expect(answer).toEqual({ state: 'ready' });
    expect(install).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/models`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${KEY}` }) })
    );
    expect(updates).toEqual([
      {
        enabled: true,
        providerType: 'openai_compatible',
        providerUrl: BASE_URL,
        apiKey: KEY,
        model: 'opfield-swift',
        endpointMode: 'chat_completions',
        maxContextTokens: 180_000,
        maxCompletionTokens: 32_000,
        supportsImages: true,
      },
    ]);
    expect(stored).toMatchObject({ mode: 'direct', workspaceApplied: true, workspaceBaseUrl: BASE_URL });
  });

  it('fails without touching AI Workspace when the endpoint does not list the model, and never shows the key', async () => {
    models = ['other'];
    const inference = new CloudInference(fakeDb([]));
    await expect(inference.apply(enabled())).resolves.toEqual({
      state: 'failed',
      error: 'The Opfield Cloud endpoint does not list opfield-swift',
    });
    vi.mocked(fetch).mockRejectedValueOnce(new Error(`refused ${KEY}`));
    const answer = await inference.apply(enabled());
    expect(answer.state).toBe('failed');
    expect(answer.error).toBe('refused [REDACTED]');
    expect(updates).toEqual([]);
  });

  it('applies a new key while AI Workspace uses the endpoint and keeps an administrator’s later choices', async () => {
    const inference = new CloudInference(fakeDb([]));
    await inference.apply(enabled());
    updates.length = 0;
    workspace.enabled = false;
    await inference.apply(enabled());
    expect(updates).toEqual([]);
    expect(workspace.enabled).toBe(false);

    await inference.apply(enabled('sk-cloud-secret-2'));
    expect(updates).toEqual([{ providerUrl: BASE_URL, apiKey: 'sk-cloud-secret-2' }]);

    updates.length = 0;
    workspace.providerUrl = 'https://api.example.com/v1';
    await inference.apply(enabled('sk-cloud-secret-3'));
    expect(updates).toEqual([]);
  });

  it('takes the key out of AI Workspace and turns it off when the add-on ends', async () => {
    const inference = new CloudInference(fakeDb([]));
    await inference.apply(enabled());
    updates.length = 0;
    await expect(inference.apply({ enabled: false })).resolves.toEqual({ state: 'removed' });
    expect(updates).toEqual([{ apiKey: '', enabled: false }]);
    expect(workspaceKey).toBe('');
  });
});

describe('CloudInference core mode', () => {
  beforeEach(() => {
    core = { installed: { version: '1.0.0' }, ready: true };
    stubCorePath();
  });

  it('switches AI Workspace to the first model once when the add-on becomes ready', async () => {
    const inference = new CloudInference(fakeDb([]));
    await expect(inference.apply(enabled())).resolves.toEqual({ state: 'ready' });
    expect(updates).toEqual([
      { enabled: true, providerType: 'opfield_inference', opfieldInferenceModel: 'opfield-swift' },
    ]);
    expect(stored).toMatchObject({ mode: 'core', workspaceApplied: true });
    updates.length = 0;
    await inference.apply(enabled());
    await inference.apply(enabled('sk-cloud-secret-2'));
    expect(updates).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('removes the models and falls AI Workspace back when it used one of them', async () => {
    const connection = { id: 'conn-1', metadata: { cloudManaged: true } };
    const inference = new CloudInference(fakeDb([[connection], [{ id: 'm-1', publicId: 'opfield-swift' }]]));
    await inference.apply(enabled());
    expect(workspace.providerType).toBe('opfield_inference');
    await expect(inference.apply({ enabled: false })).resolves.toEqual({ state: 'removed' });
    expect(removeModel).toHaveBeenCalledWith('admin-1', 'm-1');
    expect(disconnect).toHaveBeenCalledWith('admin-1', 'conn-1');
    expect(handleInferenceDisabled).toHaveBeenCalledTimes(1);
    expect(workspace).toMatchObject({ providerType: 'openai_compatible', enabled: false });
  });
});

describe('CloudInference mode switch', () => {
  it('moves to core mode when the core gets installed, and back to direct mode when it is gone', async () => {
    stubCorePath();
    const remove = stub('remove', undefined);
    const inference = new CloudInference(fakeDb([]));
    await inference.start();
    await inference.apply(enabled());
    expect(stored).toMatchObject({ mode: 'direct', state: 'ready' });
    updates.length = 0;

    core = { installed: { version: '1.0.0' }, ready: true };
    eventBus.publish(INFERENCE_CORE_CHANGED_CHANNEL, { installed: core.installed, state: 'ready' });
    await vi.waitFor(() => expect(stored).toMatchObject({ mode: 'core', state: 'ready', workspaceApplied: true }));
    expect(updates).toEqual([
      {
        enabled: true,
        providerType: 'opfield_inference',
        opfieldInferenceModel: 'opfield-swift',
        providerUrl: '',
        apiKey: '',
      },
    ]);
    updates.length = 0;

    core = { installed: null, ready: false };
    eventBus.publish(INFERENCE_CORE_CHANGED_CHANNEL, { installed: null, state: 'degraded' });
    await vi.waitFor(() => expect(stored).toMatchObject({ mode: 'direct', state: 'ready', workspaceApplied: true }));
    expect(remove).toHaveBeenCalled();
    expect(updates).toEqual([expect.objectContaining({ enabled: true, providerUrl: BASE_URL, apiKey: KEY })]);
    expect(install).not.toHaveBeenCalled();
  });
});
