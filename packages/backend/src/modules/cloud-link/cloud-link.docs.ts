import { z } from '@hono/zod-openapi';
import { appRoute, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';

export const ConnectCloudSchema = z.object({
  code: z.string().trim().min(1).max(64),
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
