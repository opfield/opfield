import { OpenAPIHono } from '@hono/zod-openapi';
import { authMiddleware } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { commercialModuleUnavailableHandler } from './unavailable.js';

/**
 * Console and API prefixes only the commercial module serves. Mounted only while the module is
 * not ready, so without it they answer COMMERCIAL_MODULE_UNAVAILABLE, which opens the paywall,
 * instead of 404; with it, what its routes do not serve answers 404. Endpoints for ingest and
 * deploy tokens and the public PKI and status page endpoints keep answering 404.
 */
export const COMMERCIAL_ONLY_ROUTE_PREFIXES = [
  '/api/cas',
  '/api/certificates',
  '/api/templates',
  '/api/audit/siem',
  '/api/audit/export',
  '/api/pages',
  '/api/logging/environments',
  '/api/logging/environment-folders',
  '/api/logging/schemas',
  '/api/logging/schema-folders',
  '/api/logging/health',
  '/api/status-page',
  '/api/storage/copy-jobs',
] as const;

export const commercialUnavailableRoutes = new OpenAPIHono<AppEnv>();
commercialUnavailableRoutes.use('*', authMiddleware);
commercialUnavailableRoutes.all('*', commercialModuleUnavailableHandler);
