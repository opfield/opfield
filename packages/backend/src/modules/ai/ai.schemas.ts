import { z } from 'zod';

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable(),
  attachments: z
    .array(
      z.object({
        artifactId: z.string(),
        filename: z.string(),
        mediaType: z.string(),
        sizeBytes: z.number(),
        downloadUrl: z.string(),
        kind: z.literal('image'),
      })
    )
    .optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      })
    )
    .optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

export const PageContextSchema = z.object({
  route: z.string().max(200),
  resourceType: z.string().max(50).optional(),
  resourceId: z.string().max(100).optional(),
  label: z.string().max(200).optional(),
  nodeId: z.string().max(100).optional(),
});

export const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  context: PageContextSchema.optional(),
});

export const AIContextEstimateRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).optional(),
  context: PageContextSchema.optional(),
  conversationId: z.string().uuid().optional().nullable(),
  model: z.string().trim().max(255).optional(),
  reasoningEffort: z.string().trim().max(64).optional(),
});

export const AIConfigUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  providerType: z.enum(['openai_compatible', 'opfield_inference']).optional(),
  providerUrl: z.union([z.string().url(), z.literal('')]).optional(),
  endpointMode: z.enum(['auto', 'chat_completions', 'responses']).optional(),
  supportsImages: z.boolean().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  opfieldInferenceModel: z.string().trim().max(255).optional(),
  opfieldInferenceAllowUserModelSelection: z.boolean().optional(),
  allowUserReasoningEffortSelection: z.boolean().optional(),
  customSystemPrompt: z.string().optional(),
  rateLimitMax: z.number().int().min(1).max(1000).optional(),
  rateLimitWindowSeconds: z.number().int().min(10).max(3600).optional(),
  maxToolRounds: z.number().int().min(1).max(50).optional(),
  maxContextTokens: z.number().int().min(4000).max(1000000).optional(),
  maxCompletionTokens: z.number().int().min(256).max(128000).optional(),
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'none']).optional(),
  disabledTools: z.array(z.string()).optional(),
  webSearchApiKey: z.string().optional(),
  webSearchProvider: z.enum(['tavily', 'brave', 'serper', 'searxng', 'exa']).optional(),
  webSearchBaseUrl: z.union([z.string().url(), z.literal('')]).optional(),
  sandboxEnabled: z.boolean().optional(),
  sandboxDefaultTier: z.enum(['low', 'medium', 'high']).optional(),
});

export const AIUserSkillCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(20_000),
  enabled: z.boolean().optional(),
});

export const AIUserSkillUpdateSchema = AIUserSkillCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one skill field is required' }
);
