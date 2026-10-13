import { z } from '@hono/zod-openapi';

export const CreateInferenceTokenSchema = z.object({
  name: z.string().trim().min(1).max(255),
});

export const CreateInferenceProviderConnectionSchema = z.object({
  providerId: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(255),
  authType: z.enum(['api_key', 'local']).default('api_key'),
  apiKey: z.string().trim().min(1).max(16_384).optional(),
  baseUrl: z.string().trim().max(2048).optional(),
  allowPrivateNetwork: z.boolean().default(false),
});

export const StartInferenceOAuthSchema = z.object({
  providerId: z.string().trim().min(1).max(80),
  connectionName: z.string().trim().min(1).max(255),
  acceptTerms: z.boolean(),
  termsVersion: z.string().trim().max(80).optional(),
});

export const CompleteInferenceOAuthSchema = z.object({
  callback: z.string().trim().max(8192).optional(),
});

export const UpdateInferenceProviderConnectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().trim().min(1).max(255).optional(),
    routingOrder: z.number().int().min(0).max(100_000).optional(),
    minimumRemainingPercent: z.number().int().min(1).max(100).optional(),
    apiMonthlyLimitMicrodollars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const UpdateInferenceProviderRoutingSchema = z.object({
  routingStrategy: z.enum(['even', 'balanced', 'sequential']),
});

const InferenceModelFieldsSchema = z.object({
  publicId: z.string().trim().min(1).max(255),
  displayName: z.string().trim().min(1).max(255),
  contextWindow: z.number().int().positive(),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().nullable().default(null),
  autoCompactTokenLimit: z.number().int().positive(),
  modalities: z.array(z.string().trim().min(1).max(64)).min(1),
  capabilities: z.record(z.boolean()),
  reasoningEfforts: z.array(z.string().trim().min(1).max(32)),
  defaultReasoningEffort: z.string().trim().min(1).max(32).nullable().optional(),
  systemPrompt: z.string().max(32_000).nullable().optional(),
  systemPromptMode: z.enum(['append', 'replace']).optional(),
  defaultAccessAllowed: z.boolean(),
  subscriptionMultiplier: z.number().positive().max(10_000),
});

export const CreateInferenceModelSchema = InferenceModelFieldsSchema;

export const UpdateInferenceModelSchema = InferenceModelFieldsSchema.partial()
  .extend({ enabled: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const ReorderInferenceModelsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        sortOrder: z.number().int().min(0).max(100_000),
      })
    )
    .min(1),
});

export const InferencePricingSchema = z.object({
  version: z.string().trim().min(1).max(80),
  inputMicrodollarsPerMillion: z.number().int().nonnegative(),
  cachedInputMicrodollarsPerMillion: z.number().int().nonnegative().nullable().optional(),
  cacheWriteMicrodollarsPerMillion: z.number().int().nonnegative().nullable().optional(),
  outputMicrodollarsPerMillion: z.number().int().nonnegative(),
  reasoningMicrodollarsPerMillion: z.number().int().nonnegative().nullable().optional(),
  otherUnitPrices: z.record(z.number().int().nonnegative()).optional(),
  source: z.enum(['provider', 'manual']),
});

export const CreateInferenceModelSourceSchema = z.object({
  connectionId: z.string().uuid(),
  discoveredModelId: z.string().uuid().optional(),
  upstreamModelId: z.string().trim().min(1).max(1024).optional(),
  enabled: z.boolean().optional(),
  subscriptionMultiplierOverride: z.number().positive().max(10_000).nullable().optional(),
  reasoningEffortMap: z.record(z.string().trim().min(1).max(64)),
  capabilitiesOverride: z.record(z.boolean()).nullable().optional(),
  manualMetadata: z
    .object({
      contextWindow: z.number().int().positive().optional(),
      maxInputTokens: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      autoCompactTokenLimit: z.number().int().positive().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, 'At least one metadata field is required')
    .optional(),
  pricing: InferencePricingSchema.optional(),
});

export const UpdateInferenceModelSourceSchema = z
  .object({
    enabled: z.boolean().optional(),
    reasoningEffortMap: z.record(z.string().trim().min(1).max(64)).optional(),
    capabilitiesOverride: z.record(z.boolean()).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const InferenceModelAccessConfigSchema = z.object({
  mode: z.enum(['everyone', 'selected', 'disabled']),
  subjects: z
    .array(
      z.object({
        subjectType: z.enum(['group', 'user']),
        subjectId: z.string().uuid(),
      })
    )
    .default([]),
});

export const InferenceModelConfigurationSchema = z.object({
  model: InferenceModelFieldsSchema,
  sources: z.array(CreateInferenceModelSourceSchema).min(1),
  access: InferenceModelAccessConfigSchema,
});

export const InferenceAdminModelResponseSchema = z.record(z.unknown());

export const InferencePublicModelsResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(
    z.object({
      id: z.string(),
      object: z.literal('model'),
      created: z.number().int(),
      owned_by: z.literal('opfield'),
      display_name: z.string(),
      context_window: z.number().int(),
      max_input_tokens: z.number().int(),
      max_output_tokens: z.number().int().optional(),
      auto_compact_token_limit: z.number().int(),
      input_modalities: z.array(z.string()),
      capabilities: z.record(z.boolean()),
      supported_reasoning_efforts: z.array(z.string()),
      default_reasoning_effort: z.string().nullable(),
      system_prompt: z.object({ text: z.string(), mode: z.enum(['append', 'replace']) }).optional(),
    })
  ),
});

export const InferenceLimitPolicyInputSchema = z.object({
  enabled: z.boolean(),
  credits5hEnabled: z.boolean(),
  credits5h: z.number().nonnegative(),
  credits7dEnabled: z.boolean(),
  credits7d: z.number().nonnegative(),
  credits30dEnabled: z.boolean(),
  credits30d: z.number().nonnegative(),
  apiMonthlyMicrodollars: z.number().int().nonnegative(),
  billingTimezone: z.string().trim().min(1).max(64),
});

export const InferenceActivityQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().trim().max(255).optional(),
  status: z.enum(['reserved', 'running', 'completed', 'failed', 'cancelled']).optional(),
  userId: z.string().uuid().optional(),
  model: z.string().trim().max(255).optional(),
});

const PercentageWindowSchema = z.object({
  active: z.boolean().optional(),
  percentage: z.number().min(0).max(100),
  recoveryAt: z.string().datetime(),
});
const ConfiguredPercentageWindowSchema = PercentageWindowSchema.extend({
  configured: z.boolean(),
});

export const InferenceSelfUsageResponseSchema = z.object({
  measuredAt: z.string().datetime().optional(),
  enabled: z.boolean(),
  api: ConfiguredPercentageWindowSchema,
  subscription: z.object({
    '5h': ConfiguredPercentageWindowSchema,
    '7d': ConfiguredPercentageWindowSchema,
    '30d': ConfiguredPercentageWindowSchema,
  }),
});

export const InferenceUsageOverviewResponseSchema = z.object({
  windowDays: z.number().int().positive(),
  requestTotals: z.array(
    z.object({
      status: z.string(),
      requests: z.number().int().nonnegative(),
      credits: z.string(),
      apiMicrodollars: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
    })
  ),
  ledgerTotals: z.array(
    z.object({
      budgetType: z.string(),
      credits: z.string(),
      apiMicrodollars: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
    })
  ),
  dailyUsage: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      requests: z.number().int().nonnegative(),
      credits: z.number().nonnegative(),
      apiMicrodollars: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
    })
  ),
});

export const InferenceDataPlaneUsageResponseSchema = InferenceSelfUsageResponseSchema.extend({
  tokens: z.object({
    lifetime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    daily: z.array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
    ),
  }),
});

export const InferenceProviderIdParamSchema = z.object({ providerId: z.string().trim().min(1).max(80) });

export const InferenceProviderCatalogSchema = z.object({
  id: z.string(),
  label: z.string(),
  family: z.enum(['openai', 'anthropic', 'kimi', 'google', 'custom']),
  wireProtocol: z.enum(['openai-responses', 'openai-chat', 'anthropic-messages', 'google-gemini']),
  baseUrl: z.string(),
  authTypes: z.array(z.enum(['oauth', 'api_key', 'local'])),
  subscription: z.boolean(),
  featured: z.boolean(),
  allowBaseUrlOverride: z.boolean().optional(),
  privateNetworkByDefault: z.boolean().optional(),
  supportedOperations: z.array(z.enum(['inference', 'images', 'search', 'realtime'])).optional(),
  modelsPath: z.string().optional(),
  quotaKind: z.enum(['chatgpt-wham', 'anthropic-oauth', 'kimi-usage']).optional(),
  termsVersion: z.string().optional(),
  oauthFlow: z.enum(['redirect', 'device']).nullable(),
  completionMode: z.enum(['paste_callback', 'device_poll']).nullable(),
});

export const InferenceOAuthSessionResponseSchema = z.object({
  id: z.string().uuid(),
  providerId: z.string(),
  status: z.enum(['pending', 'complete', 'error', 'expired', 'cancelled']),
  authorizationUrl: z.string(),
  completionMode: z.string(),
  userCode: z.string().nullable().optional(),
  pollIntervalSeconds: z.number().int().nullable().optional(),
  connectionId: z.string().uuid().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  expiresAt: z.string().datetime(),
});

export const InferenceProviderConnectionResponseSchema = z.object({
  id: z.string().uuid(),
  providerId: z.string(),
  name: z.string(),
  authType: z.enum(['oauth', 'api_key', 'local']),
  baseUrl: z.string(),
  accountExternalId: z.string().nullable(),
  accountLabel: z.string().nullable(),
  enabled: z.boolean(),
  routingOrder: z.number().int(),
  minimumRemainingPercent: z.number().int().min(1).max(100),
  apiMonthlyLimitMicrodollars: z.number().int().nonnegative().nullable(),
  apiMonthlySpentMicrodollars: z.number().int().nonnegative(),
  status: z.enum([
    'pending',
    'healthy',
    'quota_hot',
    'cooldown',
    'stale',
    'reauth_required',
    'unavailable',
    'disabled',
  ]),
  healthReason: z.string().nullable(),
  syncStatus: z.enum(['never', 'running', 'success', 'error']),
  syncLastError: z.string().nullable(),
  lastSyncedAt: z.string().datetime().nullable(),
  nextSyncAt: z.string().datetime().nullable(),
  metadata: z.record(z.unknown()),
  createdBy: z.string().uuid().nullable(),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  credential: z
    .object({
      connectionId: z.string().uuid(),
      kind: z.string(),
      last4: z.string().nullable(),
      expiresAt: z.coerce.date().nullable(),
    })
    .nullable(),
  discoveredModels: z.array(z.record(z.unknown())),
  quota: z.array(z.record(z.unknown())),
});

export const InferenceTokenResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  tokenPrefix: z.string(),
  status: z.enum(['active', 'revoked']),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const CreateInferenceTokenResponseSchema = InferenceTokenResponseSchema.extend({
  token: z.string().startsWith('opfi_'),
});

export type CreateInferenceTokenInput = z.infer<typeof CreateInferenceTokenSchema>;
export type InferenceTokenResponse = z.infer<typeof InferenceTokenResponseSchema>;
export type CreateInferenceTokenResponse = z.infer<typeof CreateInferenceTokenResponseSchema>;
