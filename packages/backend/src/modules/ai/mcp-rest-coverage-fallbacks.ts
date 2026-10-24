import { unknownApiPathHandler } from '@/app.js';
import { commercialModuleUnavailableHandler } from '@/edition/unavailable.js';
import { retiredHostingFinanceHandler } from '@/modules/hosting/hosting.routes.js';
import { inferenceEndpointNotFoundHandler } from '@/modules/inference/inference-data-plane.routes.js';

/**
 * `app.all()` handlers that are not operations: they only answer that nothing is there. Every other ALL handler that
 * does not take `next` (middleware) is an operation the coverage manifests must list.
 */
export const REST_NOT_OPERATION_HANDLERS: ReadonlySet<unknown> = new Set<unknown>([
  // The routes that stand in for the commercial module while it is absent (503 COMMERCIAL_MODULE_UNAVAILABLE).
  commercialModuleUnavailableHandler,
  // The JSON 404 for API, auth and /.well-known/ paths no route serves.
  unknownApiPathHandler,
  // The inference data plane's OpenAI-style 404 for paths it does not serve.
  inferenceEndpointNotFoundHandler,
  // 410 for the retired hosting finance and payment APIs.
  retiredHostingFinanceHandler,
]);
