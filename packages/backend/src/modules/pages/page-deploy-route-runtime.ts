import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { container } from '@/container.js';
import {
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  OpfieldOpenAPIHono,
  okJson,
  optionalJsonBody,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware } from '@/modules/auth/auth.middleware.js';
import { demoRestriction, isDemoMode } from '@/modules/demo/demo-mode.js';
import { requireLicenseFeature } from '@/modules/license/license-policy.middleware.js';
import { CreatePageDeploymentSchema, FinalizePageUploadSchema } from './deployments/page-deployment.schemas.js';
import { PAGE_UPLOAD_CHUNK_MAX_BYTES, PageDeploymentService } from './deployments/page-deployment.service.js';
import { resolvePageDeploymentExpiry } from './deployments/page-deployment-expiry.js';
import { requirePagesEnabledForMutation } from './profile/page-enabled.middleware.js';
import { PagePublicationService } from './tags/page-publication.service.js';
import { PageDeployTokenService } from './tokens/page-deploy-token.service.js';
export const pageDeployRouteRuntime = {
  OpenAPIHono: OpfieldOpenAPIHono,
  HTTPException,
  z,
  container,
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  optionalJsonBody,
  okJson,
  UnknownDataResponseSchema,
  hasScopeForResource,
  AppError,
  authMiddleware,
  demoRestriction,
  isDemoMode,
  requireLicenseFeature,
  CreatePageDeploymentSchema,
  FinalizePageUploadSchema,
  resolvePageDeploymentExpiry,
  PAGE_UPLOAD_CHUNK_MAX_BYTES,
  PageDeploymentService,
  requirePagesEnabledForMutation,
  PagePublicationService,
  PageDeployTokenService,
};
