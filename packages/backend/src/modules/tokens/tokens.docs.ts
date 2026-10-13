import { z } from '@hono/zod-openapi';
import { appRoute, createdJson, IdParamSchema, jsonBody, okJson } from '@/lib/openapi.js';
import {
  CreateTokenResponseSchema,
  CreateTokenSchema,
  TokenResponseSchema,
  UpdateTokenSchema,
} from './tokens.schemas.js';

export const listTokensRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Tokens'],
  summary: 'List API tokens',
  responses: okJson(z.array(TokenResponseSchema)),
});

export const createTokenRoute = appRoute({
  method: 'post',
  path: '/',
  tags: ['Tokens'],
  summary: 'Create an API token',
  description:
    'The scopes are bounded by your own. A new token also gets the grants older scripts expect from the scopes they name (for example repository reads with integrations:github:view) where you hold them; send `exactScopes: true` to store exactly the requested scopes, as the token dialog does.',
  request: jsonBody(CreateTokenSchema),
  responses: createdJson(CreateTokenResponseSchema),
});

export const renameTokenRoute = appRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Tokens'],
  summary: 'Update an API token',
  request: { params: IdParamSchema, ...jsonBody(UpdateTokenSchema) },
  responses: okJson(z.object({ success: z.boolean() })),
});

export const revokeTokenRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Tokens'],
  summary: 'Revoke an API token',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});

export const tokenRegistryAccessRoute = appRoute({
  method: 'get',
  path: '/registry-access',
  tags: ['Tokens'],
  summary: 'Whether API tokens can be given internal registry access',
  description:
    'Internal registry access works through docker login on the external registry endpoint, so it is offered while external access to the internal registry is on.',
  responses: okJson(z.object({ externalAccessEnabled: z.boolean() })),
});

export const tokenClientAddressRoute = appRoute({
  method: 'get',
  path: '/client-address',
  tags: ['Tokens'],
  summary: 'The client address Opfield sees for this request',
  description:
    'The address a token limited to allowed addresses is checked against (resolved through the trusted proxies, as for the audit log); null when it cannot be told. Token dialogs offer it as "Add my current IP".',
  responses: okJson(z.object({ ipAddress: z.string().nullable() })),
});
