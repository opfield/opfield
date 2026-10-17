import { LEGACY_PROVIDER_CLIENT_ID } from '@/lib/legacy-compat.js';
import type { InferenceProviderDefinition } from './inference-provider.types.js';

const SUBSCRIPTION_TERMS_VERSION = 'opencodex-unofficial-connectors-2026-07';

const CONNECTABLE_PROVIDER_IDS = new Set([
  'openai',
  'openai-apikey',
  'anthropic',
  'anthropic-apikey',
  'kimi',
  'moonshot',
  'xai',
  'xai-apikey',
  'openrouter',
  'opencode-go',
  'zai',
  'alibaba-token-plan-intl',
  'openai-compatible',
]);

const DEFINITIONS: readonly InferenceProviderDefinition[] = [
  {
    id: 'openai',
    label: 'ChatGPT subscription',
    family: 'openai',
    wireProtocol: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    authTypes: ['oauth'],
    subscription: true,
    featured: true,
    modelsPath: '/models',
    supportedOperations: ['inference'],
    quotaKind: 'chatgpt-wham',
    termsVersion: SUBSCRIPTION_TERMS_VERSION,
    oauth: {
      flow: 'codex_device',
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      userCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
      deviceTokenUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
      verificationUrl: 'https://auth.openai.com/codex/device',
      tokenUrl: 'https://auth.openai.com/oauth/token',
      redirectUri: 'https://auth.openai.com/deviceauth/callback',
    },
  },
  {
    id: 'openai-apikey',
    label: 'OpenAI API',
    family: 'openai',
    wireProtocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    authTypes: ['api_key'],
    subscription: false,
    featured: true,
    modelsPath: '/models',
    supportedOperations: ['inference', 'images', 'search', 'realtime'],
  },
  {
    id: 'xai',
    label: 'xAI Grok subscription',
    family: 'custom',
    wireProtocol: 'openai-chat',
    baseUrl: 'https://cli-chat-proxy.grok.com/v1',
    authTypes: ['oauth'],
    subscription: true,
    featured: true,
    modelsPath: '/models',
    termsVersion: SUBSCRIPTION_TERMS_VERSION,
    quotaKind: 'xai-billing',
    staticHeaders: {
      'x-grok-client-identifier': 'opencodex',
      'x-grok-client-version': '0.2.93',
      'x-xai-token-auth': 'xai-grok-cli',
      'x-authenticateresponse': 'authenticate-response',
      'User-Agent': 'opencodex-grok/0.2.93',
    },
    supportedOperations: ['inference'],
    oauth: {
      flow: 'redirect',
      clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
      authorizeUrl: 'https://auth.x.ai/oauth2/authorize',
      tokenUrl: 'https://auth.x.ai/oauth2/token',
      scopes: 'openid profile email offline_access grok-cli:access api:access',
      redirectUri: 'http://127.0.0.1:56121/callback',
      tokenEncoding: 'form',
    },
  },
  {
    id: 'xai-apikey',
    label: 'xAI API',
    family: 'custom',
    wireProtocol: 'openai-chat',
    baseUrl: 'https://api.x.ai/v1',
    authTypes: ['api_key'],
    subscription: false,
    featured: true,
    modelsPath: '/models',
    staticHeaders: { 'x-grok-client-identifier': LEGACY_PROVIDER_CLIENT_ID },
    supportedOperations: ['inference'],
  },
  {
    id: 'anthropic',
    label: 'Claude subscription',
    family: 'anthropic',
    wireProtocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    authTypes: ['oauth'],
    subscription: true,
    featured: true,
    modelsPath: '/v1/models',
    quotaKind: 'anthropic-oauth',
    termsVersion: SUBSCRIPTION_TERMS_VERSION,
    oauth: {
      flow: 'redirect',
      clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      authorizeUrl: 'https://claude.ai/oauth/authorize',
      tokenUrl: 'https://api.anthropic.com/v1/oauth/token',
      scopes: 'org:create_api_key user:profile user:inference',
      redirectUri: 'http://localhost:54545/callback',
      tokenEncoding: 'json',
      extraAuthorizeParams: { code: 'true' },
    },
  },
  {
    id: 'anthropic-apikey',
    label: 'Anthropic API',
    family: 'anthropic',
    wireProtocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    authTypes: ['api_key'],
    subscription: false,
    featured: true,
    modelsPath: '/v1/models',
  },
  {
    id: 'kimi',
    label: 'Kimi subscription',
    family: 'kimi',
    wireProtocol: 'openai-chat',
    baseUrl: 'https://api.kimi.com/coding/v1',
    authTypes: ['oauth'],
    subscription: true,
    featured: true,
    modelsPath: '/models',
    quotaKind: 'kimi-usage',
    termsVersion: SUBSCRIPTION_TERMS_VERSION,
    oauth: {
      flow: 'device',
      clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
      deviceAuthorizationUrl: 'https://auth.kimi.com/api/oauth/device_authorization',
      tokenUrl: 'https://auth.kimi.com/api/oauth/token',
    },
  },
  {
    id: 'moonshot',
    label: 'Moonshot / Kimi API',
    family: 'kimi',
    wireProtocol: 'openai-chat',
    baseUrl: 'https://api.moonshot.ai/v1',
    authTypes: ['api_key'],
    subscription: false,
    featured: true,
    modelsPath: '/models',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible API',
    family: 'custom',
    wireProtocol: 'openai-chat',
    baseUrl: '',
    authTypes: ['api_key', 'local'],
    subscription: false,
    featured: false,
    allowBaseUrlOverride: true,
    modelsPath: '/models',
  },
  chatProvider('orcarouter', 'OrcaRouter', 'https://api.orcarouter.ai/v1', {
    models: ['openai/gpt-5.5', 'anthropic/claude-opus-4.8', 'google/gemini-3.5-flash', 'orcarouter/auto'],
  }),
  chatProvider('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1'),
  chatProvider('groq', 'Groq', 'https://api.groq.com/openai/v1'),
  chatProvider('cerebras', 'Cerebras', 'https://api.cerebras.ai/v1'),
  chatProvider('together', 'Together', 'https://api.together.xyz/v1'),
  chatProvider('huggingface', 'Hugging Face', 'https://router.huggingface.co/v1'),
  chatProvider('mistral', 'Mistral', 'https://api.mistral.ai/v1'),
  chatProvider('opencode-go', 'opencode go', 'https://opencode.ai/zen/go/v1', {
    subscription: true,
  }),
  chatProvider('opencode-free', 'OpenCode Free', 'https://opencode.ai/zen/v1', {
    authTypes: ['local'],
    keyOptional: true,
    staticHeaders: { 'x-opencode-client': 'desktop' },
  }),
  chatProvider('neuralwatt', 'NeuralWatt Cloud', 'https://api.neuralwatt.com/v1'),
  chatProvider('deepseek', 'DeepSeek', 'https://api.deepseek.com', {
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro', 'deepseek-v4-flash'],
  }),
  chatProvider('firepass', 'Fire Pass (Fireworks Kimi)', 'https://api.fireworks.ai/inference/v1'),
  chatProvider('nvidia', 'NVIDIA NIM', 'https://integrate.api.nvidia.com/v1'),
  chatProvider('zai', 'Z.AI GLM Coding Plan', 'https://api.z.ai/api/coding/paas/v4', {
    models: ['glm-5.3', 'glm-5.3-flash'],
    subscription: true,
    // The core lists the plan's models from Z.AI's own catalog, so a new GLM release appears
    // without an Opfield or core update.
    liveModels: true,
  }),
  chatProvider('siliconflow', 'SiliconFlow', 'https://api.siliconflow.cn/v1'),
  chatProvider('qwen-cloud', 'Qwen Cloud', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', {
    allowBaseUrlOverride: true,
  }),
  chatProvider('tencent-coding-plan', 'Tencent Cloud Coding Plan', 'https://api.lkeap.cloud.tencent.com/coding/v3', {
    models: ['tc-code-latest', 'glm-5', 'kimi-k2.5', 'minimax-m2.5'],
  }),
  chatProvider('alibaba', 'Alibaba Coding Plan', 'https://coding-intl.dashscope.aliyuncs.com/v1'),
  chatProvider(
    'alibaba-token-plan',
    'Alibaba Token Plan (Beijing)',
    'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
  ),
  chatProvider(
    'alibaba-token-plan-intl',
    'Alibaba Token Plan (International)',
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    {
      allowBaseUrlOverride: true,
      subscription: true,
      liveModels: true,
    }
  ),
  chatProvider('zenmux', 'ZenMux', 'https://zenmux.ai/api/v1', {
    models: ['moonshotai/kimi-k3-free', 'moonshotai/kimi-k3'],
  }),
  chatProvider('ollama-cloud', 'Ollama Cloud', 'https://ollama.com/v1', {
    models: ['glm-5.2', 'deepseek-v4-pro', 'gpt-oss:120b', 'kimi-k2.6', 'minimax-m3'],
  }),
  chatProvider('minimax', 'MiniMax Coding Plan', 'https://api.minimax.io/v1', {
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1'],
  }),
  chatProvider('minimax-cn', 'MiniMax Coding Plan (CN)', 'https://api.minimaxi.com/v1', {
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1'],
  }),
  chatProvider('kimi-code', 'Kimi Code key', 'https://api.kimi.com/coding/v1', {
    models: ['k3', 'k3[1m]', 'kimi-k2.7-code', 'kimi-k2.6'],
  }),
  chatProvider('cloudflare-workers-ai', 'Cloudflare Workers AI', '', {
    allowBaseUrlOverride: true,
    models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/qwen/qwq-32b'],
  }),
  chatProvider('litellm', 'LiteLLM (local deployment)', 'http://localhost:4000/v1', {
    allowBaseUrlOverride: true,
    authTypes: ['api_key', 'local'],
    keyOptional: true,
    privateNetworkByDefault: true,
  }),
  chatProvider('ollama', 'Ollama (local)', 'http://localhost:11434/v1', {
    allowBaseUrlOverride: true,
    authTypes: ['local'],
    keyOptional: true,
    privateNetworkByDefault: true,
  }),
  chatProvider('vllm', 'vLLM (local)', 'http://localhost:8000/v1', {
    allowBaseUrlOverride: true,
    authTypes: ['api_key', 'local'],
    keyOptional: true,
    privateNetworkByDefault: true,
  }),
  chatProvider('lm-studio', 'LM Studio (local)', 'http://localhost:1234/v1', {
    allowBaseUrlOverride: true,
    authTypes: ['local'],
    keyOptional: true,
    privateNetworkByDefault: true,
  }),
  {
    id: 'umans',
    label: 'UManS AI Coding Plan',
    family: 'anthropic',
    wireProtocol: 'anthropic-messages',
    baseUrl: 'https://api.code.umans.ai',
    authTypes: ['api_key'],
    subscription: true,
    featured: false,
    modelsPath: '/v1/models',
    supportedOperations: ['inference'],
  },
  {
    id: 'mimo-free',
    label: 'MiMo Free',
    family: 'custom',
    wireProtocol: 'openai-chat',
    baseUrl: 'https://api.xiaomimimo.com/api/free-ai/openai',
    authTypes: ['local'],
    keyOptional: true,
    subscription: true,
    featured: false,
    staticModels: ['mimo-auto'],
    supportedOperations: ['inference'],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    family: 'google',
    wireProtocol: 'google-gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    authTypes: ['api_key'],
    authHeader: 'x-goog-api-key',
    subscription: false,
    featured: true,
    modelsPath: '/v1beta/models',
    supportedOperations: ['inference'],
  },
  {
    id: 'google-vertex',
    label: 'Google Vertex AI',
    family: 'google',
    wireProtocol: 'google-gemini',
    baseUrl: '',
    authTypes: ['api_key'],
    subscription: false,
    featured: false,
    allowBaseUrlOverride: true,
    supportedOperations: ['inference'],
  },
  {
    id: 'google-antigravity',
    label: 'Google Antigravity subscription',
    family: 'google',
    wireProtocol: 'google-gemini',
    baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
    authTypes: ['oauth'],
    subscription: true,
    featured: false,
    termsVersion: SUBSCRIPTION_TERMS_VERSION,
    staticModels: ['gemini-3.6-flash', 'gemini-3.5-flash'],
    supportedOperations: ['inference'],
    oauth: {
      flow: 'redirect',
      clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
      clientSecret: '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',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs',
      ].join(' '),
      redirectUri: 'http://127.0.0.1:51121/callback',
      tokenEncoding: 'form',
      extraAuthorizeParams: { access_type: 'offline', prompt: 'consent select_account' },
    },
  },
  {
    id: 'github-copilot',
    label: 'GitHub Copilot subscription',
    family: 'custom',
    wireProtocol: 'openai-chat',
    baseUrl: 'https://api.githubcopilot.com',
    authTypes: ['oauth'],
    subscription: true,
    featured: false,
    termsVersion: SUBSCRIPTION_TERMS_VERSION,
    staticModels: ['gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'claude-sonnet-4', 'gemini-2.5-pro'],
    staticHeaders: {
      'Editor-Version': `${LEGACY_PROVIDER_CLIENT_ID}/1.0`,
      'Editor-Plugin-Version': `${LEGACY_PROVIDER_CLIENT_ID}/1.0`,
      'Copilot-Integration-Id': 'vscode-chat',
    },
    supportedOperations: ['inference'],
    oauth: {
      flow: 'device',
      clientId: 'Iv1.b507a08c87ecfe98',
      deviceAuthorizationUrl: 'https://github.com/login/device/code',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: 'read:user',
      deviceHeaders: { Accept: 'application/json', 'User-Agent': LEGACY_PROVIDER_CLIENT_ID },
      credentialExchange: 'github-copilot',
    },
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    family: 'openai',
    wireProtocol: 'openai-chat',
    baseUrl: '',
    authTypes: ['api_key'],
    authHeader: 'api-key',
    subscription: false,
    featured: true,
    allowBaseUrlOverride: true,
    supportedOperations: ['inference', 'images', 'realtime'],
  },
] as const;

function chatProvider(
  id: string,
  label: string,
  baseUrl: string,
  options: {
    models?: string[];
    authTypes?: Array<'api_key' | 'local'>;
    keyOptional?: boolean;
    staticHeaders?: Record<string, string>;
    allowBaseUrlOverride?: boolean;
    privateNetworkByDefault?: boolean;
    subscription?: boolean;
    liveModels?: boolean;
  } = {}
): InferenceProviderDefinition {
  return {
    id,
    label,
    family: 'custom',
    wireProtocol: 'openai-chat',
    baseUrl,
    authTypes: options.authTypes ?? ['api_key'],
    subscription: options.subscription ?? false,
    featured: false,
    modelsPath: '/models',
    liveModels: options.liveModels,
    staticModels: options.models,
    keyOptional: options.keyOptional,
    staticHeaders: options.staticHeaders,
    allowBaseUrlOverride: options.allowBaseUrlOverride,
    privateNetworkByDefault: options.privateNetworkByDefault,
    supportedOperations: ['inference'],
  };
}

export class InferenceProviderRegistry {
  private readonly providers = new Map(
    DEFINITIONS.map((provider) => [
      provider.id,
      { ...provider, supportedOperations: provider.supportedOperations ?? (['inference'] as const) },
    ])
  );

  list(): InferenceProviderDefinition[] {
    return [...this.providers.values()];
  }

  listConnectable(): InferenceProviderDefinition[] {
    return this.list().filter((provider) => CONNECTABLE_PROVIDER_IDS.has(provider.id));
  }

  isConnectable(providerId: string): boolean {
    return CONNECTABLE_PROVIDER_IDS.has(providerId);
  }

  get(providerId: string): InferenceProviderDefinition | undefined {
    return this.providers.get(providerId);
  }

  require(providerId: string): InferenceProviderDefinition {
    const provider = this.get(providerId);
    if (!provider) throw new Error(`Unsupported inference provider: ${providerId}`);
    return provider;
  }

  requireConnectable(providerId: string): InferenceProviderDefinition {
    const provider = this.require(providerId);
    if (!this.isConnectable(providerId)) throw new Error(`Inference provider is not connectable: ${providerId}`);
    return provider;
  }
}
