import { OpenAPIHono } from '@hono/zod-openapi';
import { commercialModuleUnavailableHandler } from '@/edition/unavailable.js';
import { authMiddleware } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';

/** Mounted after commercial routes to report an absent module explicitly. */
export const databaseRoutes = new OpenAPIHono<AppEnv>();
databaseRoutes.use('*', authMiddleware);
databaseRoutes.all('*', commercialModuleUnavailableHandler);
