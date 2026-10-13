import { z } from '@hono/zod-openapi';
import { appRoute, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import { AIConfigUpdateSchema } from './ai.schemas.js';

export const aiStatusRoute = appRoute({
  method: 'get',
  path: '/status',
  tags: ['AI'],
  summary: 'Get AI feature status',
  responses: okJson(
    z.object({
      enabled: z.boolean(),
      providerType: z.enum(['openai_compatible', 'opfield_inference']),
      defaultModel: z.string(),
      allowUserModelSelection: z.boolean(),
      allowUserReasoningEffortSelection: z.boolean(),
      reasoningEfforts: z.array(z.string()),
      defaultReasoningEffort: z.string().nullable(),
      supportsImages: z.boolean(),
      models: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          supportsImages: z.boolean(),
          maxContextTokens: z.number(),
          maxOutputTokens: z.number().nullable(),
          reasoningEfforts: z.array(z.string()),
          defaultReasoningEffort: z.string().nullable(),
        })
      ),
    })
  ),
});

export const getAiConfigRoute = appRoute({
  method: 'get',
  path: '/config',
  tags: ['AI'],
  summary: 'Get AI configuration',
  responses: okJson(UnknownDataResponseSchema),
});

export const updateAiConfigRoute = appRoute({
  method: 'put',
  path: '/config',
  tags: ['AI'],
  summary: 'Update AI configuration',
  request: jsonBody(AIConfigUpdateSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const listAiToolsRoute = appRoute({
  method: 'get',
  path: '/tools',
  tags: ['AI'],
  summary: 'List AI tool definitions',
  responses: okJson(UnknownDataResponseSchema),
});
