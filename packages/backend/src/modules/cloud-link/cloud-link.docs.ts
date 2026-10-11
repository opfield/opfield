import { z } from '@hono/zod-openapi';
import { appRoute, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';

export const ConnectCloudSchema = z.object({
  code: z.string().trim().min(1).max(64),
});

export const CloudRemoteManagementSchema = z.object({
  enabled: z.boolean(),
});

export const cloudRemoteManagementRoute = appRoute({
  method: 'post',
  path: '/remote-management',
  tags: ['Cloud'],
  summary: 'Allow or forbid the cloud account to create node tokens, start updates and issue setup codes',
  request: jsonBody(CloudRemoteManagementSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const cloudStatusRoute = appRoute({
  method: 'get',
  path: '/status',
  tags: ['Cloud'],
  summary: 'Get the cloud account connection of this installation',
  responses: okJson(UnknownDataResponseSchema),
});

export const connectCloudRoute = appRoute({
  method: 'post',
  path: '/connect',
  tags: ['Cloud'],
  summary: 'Connect this installation to a cloud account with a code from the account',
  request: jsonBody(ConnectCloudSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const disconnectCloudRoute = appRoute({
  method: 'post',
  path: '/disconnect',
  tags: ['Cloud'],
  summary: 'Disconnect this installation from its cloud account',
  responses: okJson(UnknownDataResponseSchema),
});
