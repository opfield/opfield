import { createHash } from 'node:crypto';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { container } from '@/container.js';
import type { AppEnv } from '@/types.js';
import { InferenceUsageService } from './accounting/inference-usage.service.js';
import { type CoreProxyOperation, InferenceCoreProxyService } from './core/inference-core-proxy.service.js';
import { inferenceDataPlaneUsageRoute } from './inference.docs.js';
import { inferenceAuthMiddleware } from './inference-auth.middleware.js';
import { codexCatalogEntries, codexModelsResponse } from './inference-codex-models.js';
import { inferenceErrorResponse } from './inference-error.js';
import { inferenceConcurrencyMiddleware, inferenceRateLimitMiddleware } from './inference-limit.middleware.js';
import { InferenceModelService } from './models/inference-model.service.js';
import { inferenceProtocolError } from './protocol/inference-protocol.error.js';

/**
 * The single stable public data plane (plan T5): /api/inference/v1 with the
 * standard route set. Opfield middleware keeps auth/limits; handlers proxy to
 * the managed core verbatim. Harness-specific prefixes are gone; /codex/models
 * is the one client-specific catalog, for Codex connected directly.
 */
export const inferenceDataPlaneRoutes = new OpenAPIHono<AppEnv>();

inferenceDataPlaneRoutes.onError((error, c) => {
  const protocolError = inferenceProtocolError(error);
  return inferenceErrorResponse(
    c,
    protocolError.status,
    protocolError.code,
    protocolError.message,
    protocolError.details
  );
});
inferenceDataPlaneRoutes.use('*', inferenceAuthMiddleware);
inferenceDataPlaneRoutes.use('*', async (c, next) => {
  c.header('X-Accel-Buffering', 'no');
  c.header(
    'Cache-Control',
    c.req.method === 'GET' && c.req.path.endsWith('/models') ? 'private, no-cache' : 'no-store'
  );
  await next();
});

inferenceDataPlaneRoutes.openapi(inferenceDataPlaneUsageRoute, async (c) => {
  const user = c.get('user');
  if (!user) return inferenceErrorResponse(c, 401, 'invalid_api_key', 'Authentication required');
  return c.json(await container.resolve(InferenceUsageService).clientUsage(user));
});

inferenceDataPlaneRoutes.use('*', inferenceRateLimitMiddleware);
inferenceDataPlaneRoutes.use('*', inferenceConcurrencyMiddleware);

inferenceDataPlaneRoutes.get('/models', async (c) => {
  const user = c.get('user');
  if (!user) return inferenceErrorResponse(c, 401, 'invalid_api_key', 'Authentication required');
  return c.json(await container.resolve(InferenceModelService).listForUser(user));
});

// The Codex catalog behind `model_catalog_url`: same models as /models, in the shape Codex reads.
inferenceDataPlaneRoutes.get('/codex/models', async (c) => {
  const user = c.get('user');
  if (!user) return inferenceErrorResponse(c, 401, 'invalid_api_key', 'Authentication required');
  const clientVersion = c.req.query('client_version');
  const [models, catalog] = await Promise.all([
    container.resolve(InferenceModelService).listCodexModelsForUser(user),
    container.resolve(InferenceCoreProxyService).coreCodexCatalog(clientVersion),
  ]);
  const body = codexModelsResponse(models, catalog ? codexCatalogEntries(catalog) : [], clientVersion);
  const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url')}"`;
  c.header('ETag', etag);
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
  return c.json(body);
});

const PROXY_PATHS: ReadonlyArray<{ path: string; operation: CoreProxyOperation }> = [
  { path: '/responses', operation: 'responses' },
  { path: '/responses/compact', operation: 'responses/compact' },
  { path: '/chat/completions', operation: 'chat/completions' },
  { path: '/messages', operation: 'messages' },
  { path: '/messages/count_tokens', operation: 'messages/count_tokens' },
  { path: '/images/generations', operation: 'images/generations' },
  { path: '/images/edits', operation: 'images/edits' },
  { path: '/alpha/search', operation: 'alpha/search' },
  { path: '/live', operation: 'live' },
  { path: '/realtime/calls', operation: 'realtime/calls' },
];

for (const { path, operation } of PROXY_PATHS) {
  inferenceDataPlaneRoutes.post(path, (c) => container.resolve(InferenceCoreProxyService).proxy(c, operation));
}

/** The data plane's own 404 for paths it does not serve; not an operation (mcp-rest-coverage-fallbacks.ts). */
export const inferenceEndpointNotFoundHandler = (c: Context<AppEnv>) =>
  inferenceErrorResponse(c, 404, 'not_found', 'Inference endpoint not found');
inferenceDataPlaneRoutes.all('*', inferenceEndpointNotFoundHandler);
