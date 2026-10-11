import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { container } from '@/container.js';
import { assertDemoRequestAllowed } from '@/modules/demo/demo-mode.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import type { AppEnv } from '@/types.js';
import { InferenceTokenService } from './inference-token.service.js';

function extractSetupToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  return token.startsWith('gwo_') || token.startsWith('gwi_') ? token : null;
}

export const inferenceSetupAuthMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    await next();
    return;
  }

  const rawToken = extractSetupToken(c.req.header('Authorization'));
  if (!rawToken) throw new HTTPException(401, { message: 'An Opfield inference setup credential is required' });

  if (rawToken.startsWith('gwi_')) {
    const result = await container.resolve(InferenceTokenService).validateToken(rawToken);
    if (!result || result.managedBy !== null) {
      throw new HTTPException(401, { message: 'A user-managed Opfield inference token is required' });
    }
    c.set('user', result.user);
    c.set('effectiveScopes', result.user.scopes);
    c.set('isTokenAuth', true);
    c.set('authType', 'inference-token');
    assertDemoRequestAllowed(c);
    await next();
    return;
  }

  const oauth = container.resolve(OAuthService);
  const result = await oauth.validateAccessToken(rawToken, { resource: oauth.getInferenceSetupResourceUrl() });
  if (!result?.scopes.includes('inference:setup')) {
    throw new HTTPException(401, { message: 'Invalid or expired inference setup OAuth token' });
  }

  c.set('user', result.user);
  c.set('effectiveScopes', result.scopes);
  c.set('isTokenAuth', true);
  c.set('authType', 'oauth-token');
  assertDemoRequestAllowed(c);
  await next();
};

export const __testOnly = { extractSetupToken };
