import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { container } from '@/container.js';
import { hasScope } from '@/lib/permissions.js';
import { assertDemoRequestAllowed } from '@/modules/demo/demo-mode.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import type { AppEnv } from '@/types.js';

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

export const mcpAuthMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header('Cookie')) {
    throw new HTTPException(401, { message: 'MCP requires bearer authentication; cookies are not accepted' });
  }

  const oauthService = container.resolve(OAuthService);
  const resourceMetadata = oauthService.getProtectedResourceMetadataUrl();
  const challenge = (error: string, description: string) => {
    c.header(
      'WWW-Authenticate',
      `Bearer error="${error}", error_description="${description}", resource_metadata="${resourceMetadata}"`
    );
  };

  const token = bearerToken(c.req.header('Authorization'));
  if (!token) {
    challenge('invalid_token', 'Missing bearer token');
    throw new HTTPException(401, { message: 'MCP requires OAuth bearer token authentication' });
  }
  // legacy-name: gwl_ logging ingest token prefix — remove once no gwl_ tokens remain
  if (token.startsWith('opfl_') || token.startsWith('gwl_')) {
    throw new HTTPException(401, { message: 'Logging ingest tokens cannot access MCP' });
  }
  // legacy-name: gwo_ OAuth access token prefix — remove once no gwo_ tokens remain
  if (token.startsWith('opfo_') || token.startsWith('gwo_')) {
    const result = await oauthService.validateAccessToken(token, { resource: oauthService.getMcpResourceUrl() });
    if (!result) {
      challenge('invalid_token', 'Invalid OAuth access token');
      throw new HTTPException(401, { message: 'Invalid OAuth access token' });
    }
    if (result.scopes.length === 0) {
      throw new HTTPException(403, { message: 'MCP requires at least one effective OAuth token scope' });
    }
    if (!hasScope(result.user.scopes, 'mcp:use')) {
      challenge('insufficient_scope', 'Your account is not allowed to use MCP');
      throw new HTTPException(403, { message: 'Your account is not allowed to use MCP' });
    }

    c.set('user', result.user);
    c.set('effectiveScopes', result.scopes);
    c.set('isTokenAuth', true);
    c.set('mcpAuth', {
      tokenId: result.tokenId,
      tokenPrefix: result.tokenPrefix,
      authType: 'oauth',
      clientId: result.clientId,
    });
    assertDemoRequestAllowed(c);

    await next();
    return;
  }
  challenge('invalid_token', 'MCP accepts only Opfield OAuth access tokens');
  throw new HTTPException(401, { message: 'MCP accepts only Opfield OAuth access tokens' });
};
