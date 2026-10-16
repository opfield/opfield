import { OpenAPIHono } from '@hono/zod-openapi';
import { openApiValidationHook } from '@/lib/openapi.js';
import type { AppEnv } from '@/types.js';
import { alertRoutes } from './notification-alert.routes.js';
import { alertRuleRoutes } from './notification-alert-rule.routes.js';
import { deliveryRoutes } from './notification-delivery.routes.js';
import { webhookRoutes } from './notification-webhook.routes.js';

export const notificationRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

notificationRoutes.route('/alert-rules', alertRuleRoutes);
notificationRoutes.route('/alerts', alertRoutes);
notificationRoutes.route('/webhooks', webhookRoutes);
notificationRoutes.route('/deliveries', deliveryRoutes);
