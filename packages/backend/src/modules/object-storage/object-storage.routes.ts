import { OpenAPIHono } from '@hono/zod-openapi';
import { commercialModuleUnavailableHandler } from '@/edition/unavailable.js';
import { authMiddleware } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';

/** Mounted after commercial routes, preserving an explicit unavailable response. */
export const objectStorageRoutes = new OpenAPIHono<AppEnv>();
objectStorageRoutes.use('*', authMiddleware);
objectStorageRoutes.all('*', commercialModuleUnavailableHandler);
