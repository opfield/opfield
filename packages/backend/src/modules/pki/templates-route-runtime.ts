import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { requireOpfieldFeature } from '@/middleware/feature-flags.js';
import { requireUuidParam } from '@/middleware/uuid-param.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import { requireLicenseFeature, requireLicenseFeatureForRequest } from '@/modules/license/license-policy.middleware.js';
import { pkiTemplateFolderRouteDocs } from '@/modules/resource-folders/resource-folder.docs.js';
import { registerResourceFolderRoutes } from '@/modules/resource-folders/resource-folder.routes.js';
import { PkiTemplateFolderService } from './pki-folders.service.js';
import {
  createTemplateRoute,
  deleteTemplateRoute,
  getTemplateRoute,
  listTemplatesRoute,
  updateTemplateRoute,
} from './templates.docs.js';
import { CreateTemplateSchema, UpdateTemplateSchema } from './templates.schemas.js';
import { TemplatesService } from './templates.service.js';
export const templateRouteRuntime = {
  OpenAPIHono,
  container,
  openApiValidationHook,
  requireOpfieldFeature,
  authMiddleware,
  requireScope,
  requireLicenseFeature,
  requireLicenseFeatureForRequest,
  createTemplateRoute,
  deleteTemplateRoute,
  getTemplateRoute,
  listTemplatesRoute,
  updateTemplateRoute,
  CreateTemplateSchema,
  UpdateTemplateSchema,
  TemplatesService,
  PkiTemplateFolderService,
  pkiTemplateFolderRouteDocs,
  registerResourceFolderRoutes,
  /** 404 for a non-UUID `/{id}` (a literal segment would otherwise reach the uuid column). */
  requireUuidParam,
};
