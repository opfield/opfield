import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import {
  assertNotImpersonating,
  authMiddleware,
  requireAccountScope,
  requireScope,
} from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { InferenceUsageService } from './accounting/inference-usage.service.js';
import {
  cancelInferenceOAuthRoute,
  completeInferenceOAuthRoute,
  createInferenceModelConfigurationRoute,
  createInferenceProviderConnectionRoute,
  createInferenceTokenRoute,
  deleteInferenceModelRoute,
  deleteInferenceUserLimitsRoute,
  disconnectInferenceProviderConnectionRoute,
  inferenceActivityFiltersRoute,
  inferenceActivityRoute,
  inferenceLimitUsersRoute,
  inferenceModelSuggestionsRoute,
  inferenceOAuthStatusRoute,
  inferenceSelfUsageOverviewRoute,
  inferenceSelfUsageRoute,
  inferenceSystemUsageRoute,
  inferenceUsersUsageRoute,
  listInferenceCatalogRoute,
  listInferenceLimitsRoute,
  listInferenceModelsAdminRoute,
  listInferenceProviderCatalogRoute,
  listInferenceProviderConnectionsRoute,
  listInferenceTokensRoute,
  reorderInferenceModelsRoute,
  replaceInferenceModelConfigurationRoute,
  resetInferenceUserLimitRoute,
  revokeInferenceTokenRoute,
  setInferenceDefaultLimitsRoute,
  setInferenceUserLimitsRoute,
  startInferenceOAuthRoute,
  syncInferenceProviderConnectionRoute,
  updateInferenceProviderConnectionRoute,
  updateInferenceProviderRoutingRoute,
} from './inference.docs.js';
import {
  CompleteInferenceOAuthSchema,
  CreateInferenceProviderConnectionSchema,
  CreateInferenceTokenSchema,
  InferenceActivityQuerySchema,
  InferenceLimitPolicyInputSchema,
  InferenceModelConfigurationSchema,
  ReorderInferenceModelsSchema,
  StartInferenceOAuthSchema,
  UpdateInferenceProviderConnectionSchema,
  UpdateInferenceProviderRoutingSchema,
} from './inference.schemas.js';
import { InferenceTokenService } from './inference-token.service.js';
import { InferenceModelService } from './models/inference-model.service.js';
import { InferenceModelConfigurationService } from './models/inference-model-configuration.service.js';
import { InferenceOAuthService } from './providers/inference-oauth.service.js';
import { InferenceProviderService } from './providers/inference-provider.service.js';

export const inferenceManagementRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

inferenceManagementRoutes.use('*', authMiddleware);
// Personal gwi_ inference keys need feat:ai:use on the caller itself, so a bearer token must hold it.
inferenceManagementRoutes.use('/tokens', requireScope('feat:ai:use'));
inferenceManagementRoutes.use('/tokens/*', requireScope('feat:ai:use'));
inferenceManagementRoutes.use('/catalog', requireScope('feat:ai:use'));
// Administration routes below require their own delegated inference:* scopes; bearer callers may
// satisfy the feat:ai:use baseline through the token owner's live account.
inferenceManagementRoutes.use('*', requireAccountScope('feat:ai:use'));

inferenceManagementRoutes.openapi(listInferenceTokensRoute, async (c) => {
  const user = c.get('user')!;
  const tokens = await container.resolve(InferenceTokenService).listTokens(user.id);
  return c.json(tokens);
});

inferenceManagementRoutes.openapi(listInferenceCatalogRoute, async (c) => {
  return c.json(await container.resolve(InferenceModelService).listForUser(c.get('user')!));
});

inferenceManagementRoutes.openapi(createInferenceTokenRoute, async (c) => {
  assertNotImpersonating(c, 'Inference tokens cannot be created while impersonating');
  const user = c.get('user')!;
  const input = CreateInferenceTokenSchema.parse(await c.req.json());
  const token = await container.resolve(InferenceTokenService).createToken(user.id, input);
  return c.json(token, 201);
});

inferenceManagementRoutes.openapi(revokeInferenceTokenRoute, async (c) => {
  const user = c.get('user')!;
  await container.resolve(InferenceTokenService).revokeToken(user.id, c.req.param('id')!);
  return c.body(null, 204);
});

inferenceManagementRoutes.use('/providers/*', requireScope('inference:providers:view'));

inferenceManagementRoutes.openapi(listInferenceProviderCatalogRoute, (c) => {
  return c.json(container.resolve(InferenceProviderService).listCatalog());
});

inferenceManagementRoutes.openapi(listInferenceProviderConnectionsRoute, async (c) => {
  return c.json(await container.resolve(InferenceProviderService).listConnections());
});

inferenceManagementRoutes.use('/providers/connections', requireScope('inference:providers:manage'));
inferenceManagementRoutes.openapi(createInferenceProviderConnectionRoute, async (c) => {
  const input = CreateInferenceProviderConnectionSchema.parse(await c.req.json());
  const result = await container.resolve(InferenceProviderService).createKeyConnection(c.get('user')!.id, input);
  return c.json(result, 201);
});

inferenceManagementRoutes.use('/providers/oauth/*', requireScope('inference:providers:manage'));
inferenceManagementRoutes.openapi(startInferenceOAuthRoute, async (c) => {
  const input = StartInferenceOAuthSchema.parse(await c.req.json());
  const result = await container.resolve(InferenceOAuthService).start(c.get('user')!.id, input);
  return c.json(result, 201);
});

inferenceManagementRoutes.openapi(inferenceOAuthStatusRoute, async (c) => {
  const result = await container.resolve(InferenceOAuthService).status(c.get('user')!.id, c.req.param('id')!);
  if (result.status === 'complete' && result.connectionId) {
    await container.resolve(InferenceProviderService).syncConnection(result.connectionId, true);
  }
  return c.json(result);
});

inferenceManagementRoutes.openapi(completeInferenceOAuthRoute, async (c) => {
  const input = CompleteInferenceOAuthSchema.parse(await c.req.json());
  const result = await container
    .resolve(InferenceOAuthService)
    .complete(c.get('user')!.id, c.req.param('id')!, input.callback);
  if (result.status === 'complete' && result.connectionId) {
    await container.resolve(InferenceProviderService).syncConnection(result.connectionId, true);
  }
  return c.json(result);
});

inferenceManagementRoutes.openapi(cancelInferenceOAuthRoute, async (c) => {
  const result = await container.resolve(InferenceOAuthService).cancel(c.get('user')!.id, c.req.param('id')!);
  return c.json(result);
});

inferenceManagementRoutes.use('/providers/connections/*', requireScope('inference:providers:manage'));
inferenceManagementRoutes.openapi(syncInferenceProviderConnectionRoute, async (c) => {
  return c.json(await container.resolve(InferenceProviderService).syncConnection(c.req.param('id')!, true));
});

inferenceManagementRoutes.openapi(updateInferenceProviderConnectionRoute, async (c) => {
  const input = UpdateInferenceProviderConnectionSchema.parse(await c.req.json());
  const result = await container
    .resolve(InferenceProviderService)
    .updateConnection(c.get('user')!.id, c.req.param('id')!, input);
  return c.json(result);
});

inferenceManagementRoutes.openapi(disconnectInferenceProviderConnectionRoute, async (c) => {
  await container.resolve(InferenceProviderService).disconnect(c.get('user')!.id, c.req.param('id')!);
  return c.body(null, 204);
});

inferenceManagementRoutes.use('/providers/:providerId/routing', requireScope('inference:providers:manage'));
inferenceManagementRoutes.openapi(updateInferenceProviderRoutingRoute, async (c) => {
  const input = UpdateInferenceProviderRoutingSchema.parse(await c.req.json());
  const result = await container
    .resolve(InferenceProviderService)
    .setRoutingStrategy(c.get('user')!.id, c.req.param('providerId')!, input.routingStrategy);
  return c.json(result);
});

inferenceManagementRoutes.use('/models', requireScope('inference:models:manage'));
inferenceManagementRoutes.use('/models/*', requireScope('inference:models:manage'));

inferenceManagementRoutes.openapi(listInferenceModelsAdminRoute, async (c) => {
  return c.json(await container.resolve(InferenceModelService).listAdmin());
});

inferenceManagementRoutes.openapi(reorderInferenceModelsRoute, async (c) => {
  const input = ReorderInferenceModelsSchema.parse(await c.req.json());
  await container.resolve(InferenceModelService).reorder(c.get('user')!.id, input.items);
  return c.json({ success: true as const });
});

inferenceManagementRoutes.openapi(createInferenceModelConfigurationRoute, async (c) => {
  const input = InferenceModelConfigurationSchema.parse(await c.req.json());
  const result = await container.resolve(InferenceModelConfigurationService).save(c.get('user')!.id, null, input);
  return c.json(result, 201);
});

inferenceManagementRoutes.openapi(replaceInferenceModelConfigurationRoute, async (c) => {
  const input = InferenceModelConfigurationSchema.parse(await c.req.json());
  const result = await container
    .resolve(InferenceModelConfigurationService)
    .save(c.get('user')!.id, c.req.param('id')!, input);
  return c.json(result);
});

inferenceManagementRoutes.openapi(deleteInferenceModelRoute, async (c) => {
  await container.resolve(InferenceModelService).remove(c.get('user')!.id, c.req.param('id')!);
  return c.body(null, 204);
});

inferenceManagementRoutes.openapi(inferenceModelSuggestionsRoute, async (c) => {
  return c.json(await container.resolve(InferenceModelService).suggestions(c.req.param('id')!));
});

inferenceManagementRoutes.use('/usage/self', requireScope('feat:ai:use'));
inferenceManagementRoutes.use('/usage/self/*', requireScope('feat:ai:use'));
inferenceManagementRoutes.openapi(inferenceSelfUsageRoute, async (c) => {
  return c.json(await container.resolve(InferenceUsageService).self(c.get('user')!));
});

inferenceManagementRoutes.openapi(inferenceSelfUsageOverviewRoute, async (c) => {
  return c.json(await container.resolve(InferenceUsageService).selfOverview(c.get('user')!));
});

inferenceManagementRoutes.use('/usage/system', requireScope('inference:usage:view'));
inferenceManagementRoutes.openapi(inferenceSystemUsageRoute, async (c) => {
  return c.json(await container.resolve(InferenceUsageService).adminOverview());
});

inferenceManagementRoutes.use('/usage/users', requireScope('inference:usage:view'));
inferenceManagementRoutes.openapi(inferenceUsersUsageRoute, async (c) => {
  return c.json(await container.resolve(InferenceUsageService).users());
});

inferenceManagementRoutes.use('/usage/activity', requireScope('inference:usage:view'));
inferenceManagementRoutes.use('/usage/activity/*', requireScope('inference:usage:view'));
inferenceManagementRoutes.openapi(inferenceActivityFiltersRoute, async (c) => {
  return c.json(await container.resolve(InferenceUsageService).activityFilters());
});

inferenceManagementRoutes.openapi(inferenceActivityRoute, async (c) => {
  const input = InferenceActivityQuerySchema.parse({
    page: c.req.query('page'),
    limit: c.req.query('limit'),
    search: c.req.query('search'),
    status: c.req.query('status'),
    userId: c.req.query('userId'),
    model: c.req.query('model'),
  });
  return c.json(await container.resolve(InferenceUsageService).activity(input));
});

inferenceManagementRoutes.use('/limits', requireScope('inference:limits:manage'));
inferenceManagementRoutes.use('/limits/*', requireScope('inference:limits:manage'));
inferenceManagementRoutes.openapi(listInferenceLimitsRoute, async (c) => {
  return c.json(await container.resolve(InferenceUsageService).listPolicies());
});

inferenceManagementRoutes.openapi(inferenceLimitUsersRoute, async (c) => {
  return c.json(await container.resolve(InferenceUsageService).limitUsers());
});

inferenceManagementRoutes.openapi(setInferenceDefaultLimitsRoute, async (c) => {
  const input = InferenceLimitPolicyInputSchema.parse(await c.req.json());
  return c.json(await container.resolve(InferenceUsageService).setDefault(c.get('user')!.id, input));
});

inferenceManagementRoutes.openapi(setInferenceUserLimitsRoute, async (c) => {
  const input = InferenceLimitPolicyInputSchema.parse(await c.req.json());
  return c.json(await container.resolve(InferenceUsageService).setUser(c.get('user')!.id, c.req.param('id')!, input));
});

inferenceManagementRoutes.openapi(deleteInferenceUserLimitsRoute, async (c) => {
  await container.resolve(InferenceUsageService).removeUser(c.get('user')!.id, c.req.param('id')!);
  return c.body(null, 204);
});

inferenceManagementRoutes.openapi(resetInferenceUserLimitRoute, async (c) => {
  return c.json(await container.resolve(InferenceUsageService).resetUserLimits(c.get('user')!.id, c.req.param('id')!));
});
