import { container } from '@/container.js';
import { appRoute, jsonBody, OpfieldOpenAPIHono, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { UpdatePageProfileSchema } from './page-profile.schemas.js';
import { PageProfileService } from './page-profile.service.js';
export const pageProfileRouteRuntime = {
  OpenAPIHono: OpfieldOpenAPIHono,
  container,
  appRoute,
  jsonBody,
  okJson,
  UnknownDataResponseSchema,
  authMiddleware,
  requireScope,
  LicensePolicyService,
  UpdatePageProfileSchema,
  PageProfileService,
};
