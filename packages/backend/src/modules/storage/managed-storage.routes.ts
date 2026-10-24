import { OpenAPIHono } from '@hono/zod-openapi';
import { commercialModuleUnavailableHandler } from '@/edition/unavailable.js';
import { authMiddleware } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';

export const managedStorageRoutes = new OpenAPIHono<AppEnv>();
managedStorageRoutes.use('*', authMiddleware);
managedStorageRoutes.all('*', commercialModuleUnavailableHandler);
