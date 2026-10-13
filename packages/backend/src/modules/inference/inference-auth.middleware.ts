import type { MiddlewareHandler } from 'hono';
import { container } from '@/container.js';
import { getClientIpForContext } from '@/lib/request-ip.js';
import { hasTokenPrefix } from '@/lib/token-prefixes.js';
import { assertDemoRequestAllowed } from '@/modules/demo/demo-mode.js';
import type { AppEnv } from '@/types.js';
import { inferenceErrorResponse } from './inference-error.js';
import { InferenceTokenService } from './inference-token.service.js';

function extractInferenceToken(authorization?: string, apiKey?: string): string | null {
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : undefined;
  const headerKey = apiKey?.trim();

  if (bearer && headerKey && bearer !== headerKey) return null;
  const token = bearer || headerKey;
  return hasTokenPrefix(token, 'inference') ? (token as string) : null;
}

export const inferenceAuthMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    await next();
    return;
  }

  const rawToken = extractInferenceToken(c.req.header('Authorization'), c.req.header('x-api-key'));
  if (!rawToken) {
    return inferenceErrorResponse(c, 401, 'invalid_api_key', 'A valid Opfield inference token is required');
  }

  const clientIp = await getClientIpForContext(c);
  const result = await container.resolve(InferenceTokenService).validateToken(rawToken, { clientIp });
  if (!result) {
    return inferenceErrorResponse(c, 401, 'invalid_api_key', 'Invalid, expired or revoked Opfield inference token');
  }

  c.set('user', result.user);
  c.set('effectiveScopes', result.user.scopes);
  c.set('isTokenAuth', true);
  c.set('authType', 'inference-token');
  // Kept only in request-local state so WebSocket response.create events can revalidate it.
  c.set('inferenceAuth', { tokenId: result.tokenId, tokenPrefix: result.tokenPrefix, rawToken, clientIp });
  assertDemoRequestAllowed(c);
  await next();
};

export const __testOnly = { extractInferenceToken };
