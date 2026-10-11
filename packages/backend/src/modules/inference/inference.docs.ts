import { z } from '@hono/zod-openapi';
import { appRoute, createdJson, IdParamSchema, jsonBody, okJson } from '@/lib/openapi.js';
import {
  CompleteInferenceOAuthSchema,
  CreateInferenceProviderConnectionSchema,
  CreateInferenceTokenResponseSchema,
  CreateInferenceTokenSchema,
  InferenceActivityQuerySchema,
  InferenceAdminModelResponseSchema,
  InferenceDataPlaneUsageResponseSchema,
  InferenceLimitPolicyInputSchema,
  InferenceModelConfigurationSchema,
  InferenceOAuthSessionResponseSchema,
  InferenceProviderCatalogSchema,
  InferenceProviderConnectionResponseSchema,
  InferenceProviderIdParamSchema,
  InferenceSelfUsageResponseSchema,
  InferenceTokenResponseSchema,
  InferenceUsageOverviewResponseSchema,
  ReorderInferenceModelsSchema,
  StartInferenceOAuthSchema,
  UpdateInferenceProviderConnectionSchema,
  UpdateInferenceProviderRoutingSchema,
} from './inference.schemas.js';

export const inferenceDataPlaneUsageRoute = appRoute({
  method: 'get',
  path: '/usage',
  tags: ['Inference'],
  summary: 'Get current-user Opfield quota percentages and raw token totals for inference clients',
  responses: okJson(InferenceDataPlaneUsageResponseSchema),
});

export const listInferenceTokensRoute = appRoute({
  method: 'get',
  path: '/tokens',
  tags: ['Inference'],
  summary: 'List inference tokens for the current user',
  responses: okJson(z.array(InferenceTokenResponseSchema)),
});

export const createInferenceTokenRoute = appRoute({
  method: 'post',
  path: '/tokens',
  tags: ['Inference'],
  summary: 'Create a copy-once inference token',
  request: jsonBody(CreateInferenceTokenSchema),
  responses: createdJson(CreateInferenceTokenResponseSchema),
});

export const revokeInferenceTokenRoute = appRoute({
  method: 'delete',
  path: '/tokens/{id}',
  tags: ['Inference'],
  summary: 'Revoke an inference token',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});

export const listInferenceProviderCatalogRoute = appRoute({
  method: 'get',
  path: '/providers/catalog',
  tags: ['Inference Providers'],
  summary: 'List supported inference provider connectors',
  responses: okJson(z.array(InferenceProviderCatalogSchema)),
});

export const listInferenceProviderConnectionsRoute = appRoute({
  method: 'get',
  path: '/providers/connections',
  tags: ['Inference Providers'],
  summary: 'List inference provider connections without secrets',
  responses: okJson(z.array(InferenceProviderConnectionResponseSchema)),
});

export const createInferenceProviderConnectionRoute = appRoute({
  method: 'post',
  path: '/providers/connections',
  tags: ['Inference Providers'],
  summary: 'Connect an API-key or local inference provider',
  request: jsonBody(CreateInferenceProviderConnectionSchema),
  responses: createdJson(InferenceProviderConnectionResponseSchema),
});

export const startInferenceOAuthRoute = appRoute({
  method: 'post',
  path: '/providers/oauth/start',
  tags: ['Inference Providers'],
  summary: 'Start a provider OAuth or device flow',
  request: jsonBody(StartInferenceOAuthSchema),
  responses: createdJson(InferenceOAuthSessionResponseSchema),
});

export const inferenceOAuthStatusRoute = appRoute({
  method: 'get',
  path: '/providers/oauth/{id}',
  tags: ['Inference Providers'],
  summary: 'Read an OAuth session owned by the current administrator',
  request: { params: IdParamSchema },
  responses: okJson(InferenceOAuthSessionResponseSchema),
});

export const completeInferenceOAuthRoute = appRoute({
  method: 'post',
  path: '/providers/oauth/{id}/complete',
  tags: ['Inference Providers'],
  summary: 'Complete or poll a provider OAuth session',
  request: { params: IdParamSchema, ...jsonBody(CompleteInferenceOAuthSchema) },
  responses: okJson(InferenceOAuthSessionResponseSchema),
});

export const cancelInferenceOAuthRoute = appRoute({
  method: 'post',
  path: '/providers/oauth/{id}/cancel',
  tags: ['Inference Providers'],
  summary: 'Cancel a pending provider OAuth session',
  request: { params: IdParamSchema },
  responses: okJson(InferenceOAuthSessionResponseSchema),
});

export const syncInferenceProviderConnectionRoute = appRoute({
  method: 'post',
  path: '/providers/connections/{id}/sync',
  tags: ['Inference Providers'],
  summary: 'Synchronize models, quota, and health for a provider connection',
  request: { params: IdParamSchema },
  responses: okJson(InferenceProviderConnectionResponseSchema),
});

export const updateInferenceProviderConnectionRoute = appRoute({
  method: 'patch',
  path: '/providers/connections/{id}',
  tags: ['Inference Providers'],
  summary: 'Update a provider connection',
  request: { params: IdParamSchema, ...jsonBody(UpdateInferenceProviderConnectionSchema) },
  responses: okJson(InferenceProviderConnectionResponseSchema),
});

export const disconnectInferenceProviderConnectionRoute = appRoute({
  method: 'delete',
  path: '/providers/connections/{id}',
  tags: ['Inference Providers'],
  summary: 'Disconnect a provider and destroy its stored credential',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});

export const updateInferenceProviderRoutingRoute = appRoute({
  method: 'patch',
  path: '/providers/{providerId}/routing',
  tags: ['Inference Providers'],
  summary: 'Set implicit routing strategy for a provider',
  request: {
    params: InferenceProviderIdParamSchema,
    ...jsonBody(UpdateInferenceProviderRoutingSchema),
  },
  responses: okJson(z.object({ providerId: z.string(), routingStrategy: z.enum(['balanced', 'sequential']) })),
});

export const listInferenceModelsAdminRoute = appRoute({
  method: 'get',
  path: '/models',
  tags: ['Inference Models'],
  summary: 'List published inference models with sources and admin metadata',
  responses: okJson(z.array(InferenceAdminModelResponseSchema)),
});

export const reorderInferenceModelsRoute = appRoute({
  method: 'put',
  path: '/models/reorder',
  tags: ['Inference Models'],
  summary: 'Persist the display and client manifest order of inference models',
  request: jsonBody(ReorderInferenceModelsSchema),
  responses: okJson(z.object({ success: z.literal(true) })),
});

export const createInferenceModelConfigurationRoute = appRoute({
  method: 'post',
  path: '/models/configuration',
  tags: ['Inference Models'],
  summary: 'Create a logical model, provider bindings, pricing, and access atomically',
  request: jsonBody(InferenceModelConfigurationSchema),
  responses: createdJson(InferenceAdminModelResponseSchema),
});

export const replaceInferenceModelConfigurationRoute = appRoute({
  method: 'put',
  path: '/models/{id}/configuration',
  tags: ['Inference Models'],
  summary: 'Replace model metadata, provider bindings, pricing, and access atomically',
  request: { params: IdParamSchema, ...jsonBody(InferenceModelConfigurationSchema) },
  responses: okJson(InferenceAdminModelResponseSchema),
});

export const deleteInferenceModelRoute = appRoute({
  method: 'delete',
  path: '/models/{id}',
  tags: ['Inference Models'],
  summary: 'Delete a logical inference model',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});

export const inferenceModelSuggestionsRoute = appRoute({
  method: 'get',
  path: '/models/{id}/suggestions',
  tags: ['Inference Models'],
  summary: 'Suggest matching accounts from the selected provider model',
  request: { params: IdParamSchema },
  responses: okJson(z.array(z.record(z.unknown()))),
});

export const inferenceSelfUsageRoute = appRoute({
  method: 'get',
  path: '/usage/self',
  tags: ['Inference Usage'],
  summary: 'Get only user-visible usage percentages and recovery times',
  responses: okJson(InferenceSelfUsageResponseSchema),
});

export const inferenceSelfUsageOverviewRoute = appRoute({
  method: 'get',
  path: '/usage/self/overview',
  tags: ['Inference Usage'],
  summary: 'Get 30-day inference usage totals for the current user',
  responses: okJson(InferenceUsageOverviewResponseSchema),
});

export const inferenceSystemUsageRoute = appRoute({
  method: 'get',
  path: '/usage/system',
  tags: ['Inference Usage'],
  summary: 'Get raw system usage and upstream quota for administrators',
  responses: okJson(InferenceUsageOverviewResponseSchema),
});

export const inferenceUsersUsageRoute = appRoute({
  method: 'get',
  path: '/usage/users',
  tags: ['Inference Usage'],
  summary: 'Get raw per-user usage and limits for administrators',
  responses: okJson(z.array(z.record(z.unknown()))),
});

export const inferenceActivityRoute = appRoute({
  method: 'get',
  path: '/usage/activity',
  tags: ['Inference Usage'],
  summary: 'List metadata-only inference activity for administrators',
  request: {
    query: InferenceActivityQuerySchema,
  },
  responses: okJson(
    z.object({
      data: z.array(z.record(z.unknown())),
      nextPage: z.number().int().nullable(),
    })
  ),
});

export const inferenceActivityFiltersRoute = appRoute({
  method: 'get',
  path: '/usage/activity/filters',
  tags: ['Inference Usage'],
  summary: 'List available users and models for inference activity filters',
  responses: okJson(
    z.object({
      users: z.array(
        z.object({
          id: z.string().uuid(),
          name: z.string().nullable(),
          email: z.string(),
          avatarUrl: z.string().nullable(),
        })
      ),
      models: z.array(z.string()),
    })
  ),
});

export const listInferenceLimitsRoute = appRoute({
  method: 'get',
  path: '/limits',
  tags: ['Inference Limits'],
  summary: 'List system default and per-user limit policies',
  responses: okJson(z.array(z.record(z.unknown()))),
});

export const inferenceLimitUsersRoute = appRoute({
  method: 'get',
  path: '/limits/users',
  tags: ['Inference Limits'],
  summary: 'List users and effective policies without system usage data',
  responses: okJson(z.array(z.record(z.unknown()))),
});

export const setInferenceDefaultLimitsRoute = appRoute({
  method: 'put',
  path: '/limits/default',
  tags: ['Inference Limits'],
  summary: 'Set the system default inference limit policy',
  request: jsonBody(InferenceLimitPolicyInputSchema),
  responses: okJson(z.array(z.record(z.unknown()))),
});

export const setInferenceUserLimitsRoute = appRoute({
  method: 'put',
  path: '/limits/users/{id}',
  tags: ['Inference Limits'],
  summary: 'Set a per-user inference limit override',
  request: { params: IdParamSchema, ...jsonBody(InferenceLimitPolicyInputSchema) },
  responses: okJson(z.array(z.record(z.unknown()))),
});

export const deleteInferenceUserLimitsRoute = appRoute({
  method: 'delete',
  path: '/limits/users/{id}',
  tags: ['Inference Limits'],
  summary: 'Remove a per-user inference limit override',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});

export const resetInferenceUserLimitRoute = appRoute({
  method: 'post',
  path: '/limits/users/{id}/reset',
  tags: ['Inference Limits'],
  summary: 'Reset all inference usage limits for a user',
  request: { params: IdParamSchema },
  responses: okJson(z.record(z.unknown())),
});
