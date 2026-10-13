import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireOpfieldFeature } from '@/middleware/feature-flags.js';
import { authMiddleware, requireAnyScope } from '@/modules/auth/auth.middleware.js';
import {
  createSiemDestinationRoute,
  deleteSiemDestinationRoute,
  getSiemDeliveryRoute,
  getSiemDestinationRoute,
  listSiemDeliveriesRoute,
  listSiemDestinationsRoute,
  requeueSiemDeliveryRoute,
  testSiemDestinationRoute,
  updateSiemDestinationRoute,
} from './siem.docs.js';
import {
  CreateSiemDestinationSchema,
  SiemDeliveryListQuerySchema,
  SiemDestinationListQuerySchema,
  UpdateSiemDestinationSchema,
} from './siem.schemas.js';
import { SiemDeliveryService } from './siem-delivery.service.js';
import { SiemDestinationService } from './siem-destination.service.js';
export const siemRouteRuntime = {
  OpenAPIHono,
  container,
  openApiValidationHook,
  AppError,
  requireOpfieldFeature,
  authMiddleware,
  requireAnyScope,
  createSiemDestinationRoute,
  deleteSiemDestinationRoute,
  getSiemDeliveryRoute,
  getSiemDestinationRoute,
  listSiemDeliveriesRoute,
  listSiemDestinationsRoute,
  requeueSiemDeliveryRoute,
  testSiemDestinationRoute,
  updateSiemDestinationRoute,
  CreateSiemDestinationSchema,
  SiemDeliveryListQuerySchema,
  SiemDestinationListQuerySchema,
  UpdateSiemDestinationSchema,
  SiemDeliveryService,
  SiemDestinationService,
};
