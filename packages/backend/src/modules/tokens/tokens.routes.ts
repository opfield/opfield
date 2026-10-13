import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { isScopeSubset } from '@/lib/permissions.js';
import { getClientIpForContext } from '@/lib/request-ip.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, sessionOnly } from '@/modules/auth/auth.middleware.js';
import { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import type { AppEnv } from '@/types.js';
import {
  createTokenRoute,
  listTokensRoute,
  renameTokenRoute,
  revokeTokenRoute,
  tokenClientAddressRoute,
  tokenRegistryAccessRoute,
} from './tokens.docs.js';
import { CreateTokenSchema, UpdateTokenSchema } from './tokens.schemas.js';
import { authorizeRequestedRegistryAccess, resolveRequestedTokenScopes, TokensService } from './tokens.service.js';

export const tokensRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

export function assertTokenManagementSession(impersonation: unknown): void {
  if (impersonation) {
    throw new AppError(
      403,
      'IMPERSONATION_TOKEN_MANAGEMENT_FORBIDDEN',
      'API tokens cannot be managed while impersonating'
    );
  }
}

tokensRoutes.use('*', authMiddleware);
tokensRoutes.use('*', sessionOnly);
tokensRoutes.use('*', async (c, next) => {
  assertTokenManagementSession(c.get('impersonation'));
  await next();
});

tokensRoutes.openapi(listTokensRoute, async (c) => {
  const tokensService = container.resolve(TokensService);
  const user = c.get('user')!;
  const tokens = await tokensService.listTokens(user.id);
  return c.json(tokens);
});

// The token dialog offers internal registry access only while Docker clients can reach the registry.
tokensRoutes.openapi(tokenRegistryAccessRoute, async (c) => {
  const state = await container.resolve(DockerInternalRegistryService).getState();
  return c.json({ externalAccessEnabled: state.externalAccessEnabled });
});

// The address the token dialogs offer as "Add my current IP" is the one token limits are checked against.
tokensRoutes.openapi(tokenClientAddressRoute, async (c) => {
  return c.json({ ipAddress: (await getClientIpForContext(c)) ?? null });
});

tokensRoutes.openapi(createTokenRoute, async (c) => {
  const tokensService = container.resolve(TokensService);
  const user = c.get('user')!;
  const body = await c.req.json();
  const parsedInput = CreateTokenSchema.parse(body);
  const input = {
    ...parsedInput,
    scopes: resolveRequestedTokenScopes(parsedInput.scopes, user.scopes, 'create', {
      exact: parsedInput.exactScopes === true,
    }),
  };

  // Registry access comes from the user's workload permissions; every other scope must be one the user holds.
  const userScopes = user.scopes;
  const delegated = authorizeRequestedRegistryAccess(input, userScopes);
  if (!isScopeSubset(delegated, userScopes)) {
    const disallowed = delegated.filter((s) => !TokensService.hasScope(userScopes, s));
    return c.json(
      { code: 'SCOPE_NOT_ALLOWED', message: `Your group cannot grant scopes: ${disallowed.join(', ')}` },
      403
    );
  }

  const result = await tokensService.createToken(user.id, input);
  return c.json(result, 201);
});

tokensRoutes.openapi(renameTokenRoute, async (c) => {
  const tokensService = container.resolve(TokensService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const parsedInput = UpdateTokenSchema.parse(await c.req.json());
  const input = {
    ...parsedInput,
    ...(parsedInput.name !== undefined ? { name: parsedInput.name.trim() } : {}),
    ...(parsedInput.scopes !== undefined
      ? { scopes: resolveRequestedTokenScopes(parsedInput.scopes, user.scopes, 'update') }
      : {}),
  };

  const delegated = authorizeRequestedRegistryAccess(input, user.scopes);
  if (input.scopes !== undefined && !isScopeSubset(delegated, user.scopes)) {
    const disallowed = delegated.filter((s) => !TokensService.hasScope(user.scopes, s));
    return c.json(
      { code: 'SCOPE_NOT_ALLOWED', message: `Your group cannot grant scopes: ${disallowed.join(', ')}` },
      403
    );
  }

  await tokensService.updateToken(user.id, id, input);
  return c.json({ success: true });
});

tokensRoutes.openapi(revokeTokenRoute, async (c) => {
  const tokensService = container.resolve(TokensService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  await tokensService.revokeToken(user.id, id);
  return c.body(null, 204);
});
