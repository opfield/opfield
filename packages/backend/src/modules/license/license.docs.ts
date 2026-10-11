import { z } from '@hono/zod-openapi';
import { appRoute, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';

export const ActivateLicenseSchema = z.object({
  licenseKey: z.string().min(1),
});

export const licenseStatusRoute = appRoute({
  method: 'get',
  path: '/status',
  tags: ['License'],
  summary: 'Get license status',
  responses: okJson(UnknownDataResponseSchema),
});

export const activateLicenseRoute = appRoute({
  method: 'post',
  path: '/activate',
  tags: ['License'],
  summary: 'Activate a license key',
  request: jsonBody(ActivateLicenseSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const checkLicenseRoute = appRoute({
  method: 'post',
  path: '/check',
  tags: ['License'],
  summary: 'Check license status now',
  responses: okJson(UnknownDataResponseSchema),
});

export const activateLicenseModuleRoute = appRoute({
  method: 'post',
  path: '/module/activate',
  tags: ['License'],
  summary: 'Prepare and activate paid features for the current Opfield version',
  responses: okJson(UnknownDataResponseSchema),
});

export const clearLicenseRoute = appRoute({
  method: 'delete',
  path: '/key',
  tags: ['License'],
  summary: 'Clear the active license key',
  responses: okJson(UnknownDataResponseSchema),
});
