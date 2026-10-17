import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/settings.js';
import { isPrivateUrl } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { AIUserSkillRecord } from './ai.skills.js';
import type {
  AIConfig,
  AIEndpointMode,
  AIProviderType,
  EncryptedValue,
  MaxTokensField,
  ReasoningEffort,
  WebSearchProvider,
} from './ai.types.js';

const AI_SETTINGS_DEFAULTS: Record<string, unknown> = {
  'ai:enabled': false,
  'ai:provider_type': 'openai_compatible',
  'ai:provider_url': '',
  'ai:endpoint_mode': 'auto',
  'ai:supports_images': false,
  'ai:api_key_encrypted': null,
  'ai:model': '',
  'ai:opfield_inference_model': '',
  'ai:opfield_inference_allow_user_model_selection': true,
  'ai:allow_user_reasoning_effort_selection': false,
  'ai:max_completion_tokens': 8192,
  'ai:max_tokens_field': 'max_completion_tokens',
  'ai:reasoning_effort': 'none',
  'ai:custom_system_prompt': '',
  'ai:rate_limit_max': 10,
  'ai:rate_limit_window_seconds': 60,
  'ai:max_tool_rounds': 20,
  'ai:max_context_tokens': 56000,
  'ai:disabled_tools': [],
  'ai:web_search_api_key_encrypted': null,
  'ai:web_search_provider': 'tavily',
  'ai:web_search_base_url': '',
  'ai:sandbox_enabled': false,
  'ai:sandbox_default_tier': 'low',
  'ai:user_skills': [],
};

export class AISettingsService {
  private inferenceFeatureEnabled: () => Promise<boolean> = async () => false;
  private opfieldInferenceModelAvailable: (model: string) => Promise<boolean> = async () => false;
  private cloudConnected: (config: AIConfig) => Promise<boolean> = async () => false;

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService
  ) {}

  setInferenceFeatureResolver(resolver: () => Promise<boolean>): void {
    this.inferenceFeatureEnabled = resolver;
  }

  setOpfieldInferenceModelValidator(validator: (model: string) => Promise<boolean>): void {
    this.opfieldInferenceModelAvailable = validator;
  }

  /** Whether the Opfield Cloud AI add-on runs AI Workspace directly (its URL, key and model are the account's). */
  setCloudConnectionResolver(resolver: (config: AIConfig) => Promise<boolean>): void {
    this.cloudConnected = resolver;
  }

  async getConfig(): Promise<AIConfig> {
    const rows = await this.db.select().from(settings).where(eq(settings.key, settings.key)); // get all

    // Filter to ai: prefixed keys
    const aiRows = rows.filter((r) => r.key.startsWith('ai:'));
    const map = new Map(aiRows.map((r) => [r.key, r.value]));

    const getValue = <T>(key: string): T => {
      const val = map.get(key);
      return (val !== undefined ? val : AI_SETTINGS_DEFAULTS[key]) as T;
    };

    const webSearchEncrypted = getValue<EncryptedValue | null>('ai:web_search_api_key_encrypted');

    return {
      enabled: getValue<boolean>('ai:enabled'),
      providerType: getValue<AIProviderType>('ai:provider_type'),
      providerUrl: getValue<string>('ai:provider_url'),
      endpointMode: getValue<AIEndpointMode>('ai:endpoint_mode'),
      supportsImages: getValue<boolean>('ai:supports_images'),
      model: getValue<string>('ai:model'),
      opfieldInferenceModel: getValue<string>('ai:opfield_inference_model'),
      opfieldInferenceAllowUserModelSelection: getValue<boolean>('ai:opfield_inference_allow_user_model_selection'),
      allowUserReasoningEffortSelection: getValue<boolean>('ai:allow_user_reasoning_effort_selection'),
      maxCompletionTokens: getValue<number>('ai:max_completion_tokens'),
      maxTokensField: getValue<MaxTokensField>('ai:max_tokens_field'),
      reasoningEffort: getValue<ReasoningEffort>('ai:reasoning_effort'),
      customSystemPrompt: getValue<string>('ai:custom_system_prompt'),
      rateLimitMax: getValue<number>('ai:rate_limit_max'),
      rateLimitWindowSeconds: getValue<number>('ai:rate_limit_window_seconds'),
      maxToolRounds: getValue<number>('ai:max_tool_rounds'),
      maxContextTokens: getValue<number>('ai:max_context_tokens'),
      disabledTools: getValue<string[]>('ai:disabled_tools'),
      webSearchProvider: getValue<WebSearchProvider>('ai:web_search_provider'),
      webSearchBaseUrl: getValue<string>('ai:web_search_base_url'),
      sandboxEnabled: getValue<boolean>('ai:sandbox_enabled'),
      sandboxDefaultTier: getValue<'low' | 'medium' | 'high'>('ai:sandbox_default_tier'),
      webSearchEnabled:
        getValue<WebSearchProvider>('ai:web_search_provider') === 'searxng'
          ? !!getValue<string>('ai:web_search_base_url')
          : !!webSearchEncrypted,
    };
  }

  /**
   * Returns the config with masked API key info for admin display.
   */
  async getConfigForAdmin(): Promise<
    AIConfig & {
      hasApiKey: boolean;
      apiKeyLast4: string;
      hasWebSearchKey: boolean;
      webSearchApiKeyLast4: string;
      cloudConnected: boolean;
    }
  > {
    const config = await this.getConfig();
    const encrypted = await this.getSetting<EncryptedValue | null>('ai:api_key_encrypted');
    const webSearchEncrypted = await this.getSetting<EncryptedValue | null>('ai:web_search_api_key_encrypted');

    let apiKeyLast4 = '';
    if (encrypted) {
      try {
        const key = this.cryptoService.decryptString(encrypted);
        apiKeyLast4 = key.slice(-4);
      } catch {
        // corrupted key
      }
    }

    let webSearchApiKeyLast4 = '';
    if (webSearchEncrypted) {
      try {
        const key = this.cryptoService.decryptString(webSearchEncrypted);
        webSearchApiKeyLast4 = key.slice(-4);
      } catch {
        // corrupted key
      }
    }

    return {
      ...config,
      hasApiKey: !!encrypted,
      apiKeyLast4,
      hasWebSearchKey: !!webSearchEncrypted,
      webSearchApiKeyLast4,
      cloudConnected: await this.cloudConnected(config).catch(() => false),
    };
  }

  async updateConfig(updates: Record<string, unknown>): Promise<AIConfig> {
    if (Object.hasOwn(updates, 'providerType') || Object.hasOwn(updates, 'opfieldInferenceModel')) {
      const current = await this.getConfig();
      const providerType = (updates.providerType ?? current.providerType) as AIProviderType;
      const opfieldInferenceModel = String(updates.opfieldInferenceModel ?? current.opfieldInferenceModel).trim();

      if (providerType === 'opfield_inference') {
        if (!(await this.inferenceFeatureEnabled())) {
          throw new AppError(
            400,
            'AI_INFERENCE_DISABLED',
            'Opfield Inference must be enabled before it can be used by AI Workspace'
          );
        }
        if (!opfieldInferenceModel) {
          throw new AppError(400, 'AI_INFERENCE_MODEL_REQUIRED', 'Select a default Opfield Inference model');
        }
        if (!(await this.opfieldInferenceModelAvailable(opfieldInferenceModel))) {
          throw new AppError(
            400,
            'AI_INFERENCE_MODEL_UNAVAILABLE',
            'The selected Opfield Inference model is not available'
          );
        }
        updates.opfieldInferenceModel = opfieldInferenceModel;
      }
    }

    const keyMap: Record<string, string> = {
      enabled: 'ai:enabled',
      providerType: 'ai:provider_type',
      providerUrl: 'ai:provider_url',
      endpointMode: 'ai:endpoint_mode',
      supportsImages: 'ai:supports_images',
      model: 'ai:model',
      opfieldInferenceModel: 'ai:opfield_inference_model',
      opfieldInferenceAllowUserModelSelection: 'ai:opfield_inference_allow_user_model_selection',
      allowUserReasoningEffortSelection: 'ai:allow_user_reasoning_effort_selection',
      customSystemPrompt: 'ai:custom_system_prompt',
      rateLimitMax: 'ai:rate_limit_max',
      rateLimitWindowSeconds: 'ai:rate_limit_window_seconds',
      maxToolRounds: 'ai:max_tool_rounds',
      maxContextTokens: 'ai:max_context_tokens',
      maxCompletionTokens: 'ai:max_completion_tokens',
      maxTokensField: 'ai:max_tokens_field',
      reasoningEffort: 'ai:reasoning_effort',
      disabledTools: 'ai:disabled_tools',
      webSearchProvider: 'ai:web_search_provider',
      webSearchBaseUrl: 'ai:web_search_base_url',
      sandboxEnabled: 'ai:sandbox_enabled',
      sandboxDefaultTier: 'ai:sandbox_default_tier',
    };

    for (const [field, value] of Object.entries(updates)) {
      if (value === undefined) continue;

      // Block private/internal URLs for SSRF prevention
      if ((field === 'providerUrl' || field === 'webSearchBaseUrl') && typeof value === 'string' && value !== '') {
        if (isPrivateUrl(value)) {
          throw new Error(`${field} cannot point to a private or internal address`);
        }
      }

      // Handle API key encryption
      if (field === 'apiKey') {
        const plainKey = value as string;
        if (plainKey === '') {
          await this.deleteSetting('ai:api_key_encrypted');
        } else {
          const encrypted = this.cryptoService.encryptString(plainKey);
          await this.setSetting('ai:api_key_encrypted', encrypted);
        }
        continue;
      }

      // Handle web search API key encryption
      if (field === 'webSearchApiKey') {
        const plainKey = value as string;
        if (plainKey === '') {
          await this.deleteSetting('ai:web_search_api_key_encrypted');
        } else {
          const encrypted = this.cryptoService.encryptString(plainKey);
          await this.setSetting('ai:web_search_api_key_encrypted', encrypted);
        }
        continue;
      }

      const settingsKey = keyMap[field];
      if (settingsKey) {
        await this.setSetting(settingsKey, value);
      }
    }

    return this.getConfig();
  }

  async isEnabled(): Promise<boolean> {
    const val = await this.getSetting<boolean>('ai:enabled');
    if (!val) return false;
    const providerType = await this.getSetting<AIProviderType>('ai:provider_type');
    if (providerType === 'opfield_inference') {
      const model = await this.getSetting<string>('ai:opfield_inference_model');
      return Boolean(model && (await this.inferenceFeatureEnabled()));
    }
    const apiKey = await this.getSetting<EncryptedValue | null>('ai:api_key_encrypted');
    return !!apiKey;
  }

  async handleInferenceDisabled(): Promise<void> {
    const providerType = await this.getSetting<AIProviderType>('ai:provider_type');
    if (providerType !== 'opfield_inference') return;

    await this.setSetting('ai:provider_type', 'openai_compatible');
    const apiKey = await this.getSetting<EncryptedValue | null>('ai:api_key_encrypted');
    if (!apiKey) await this.setSetting('ai:enabled', false);
  }

  async handleOpfieldInferenceModelRemoved(removedModel: string, replacementModel: string | null): Promise<void> {
    const current = await this.getSetting<string>('ai:opfield_inference_model');
    if (current !== removedModel) return;
    await this.setSetting('ai:opfield_inference_model', replacementModel ?? '');
  }

  async getDecryptedApiKey(): Promise<string | null> {
    const encrypted = await this.getSetting<EncryptedValue | null>('ai:api_key_encrypted');
    if (!encrypted) return null;
    try {
      return this.cryptoService.decryptString(encrypted);
    } catch {
      return null;
    }
  }

  async getDecryptedWebSearchKey(): Promise<string | null> {
    const encrypted = await this.getSetting<EncryptedValue | null>('ai:web_search_api_key_encrypted');
    if (!encrypted) return null;
    try {
      return this.cryptoService.decryptString(encrypted);
    } catch {
      return null;
    }
  }

  async getUserSkills(): Promise<AIUserSkillRecord[]> {
    const value = await this.getSetting<unknown>('ai:user_skills');
    return Array.isArray(value) ? (value as AIUserSkillRecord[]) : [];
  }

  async setUserSkills(skills: AIUserSkillRecord[]): Promise<void> {
    await this.setSetting('ai:user_skills', skills);
  }

  // ── Internal helpers ──

  private async getSetting<T>(key: string): Promise<T> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return (row?.value !== undefined ? row.value : AI_SETTINGS_DEFAULTS[key]) as T;
  }

  private async setSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  private async deleteSetting(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }
}
