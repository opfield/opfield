import { Hono } from 'hono';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { optionalAuthMiddleware } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { AccessSignInExternalService } from './access-signin-external.service.js';
import { AccessSigningKeyService } from './access-signing-key.service.js';

// Visitors of protected routes sign in on the route itself: its nginx daemon serves the page and asks Opfield over
// gRPC (grpc/services/access-sign-in.ts). The console serves only the Opfield account confirmation and the JWKS of the
// token keys.

const external = () => container.resolve(AccessSignInExternalService);

// ---------------------------------------------------------------------------
// /api/access-sign-in (console origin)
// ---------------------------------------------------------------------------

export const accessSignInApiRoutes = new Hono<AppEnv>();

// The console session says which Opfield account signs in; the visitor goes back to the route's provider callback.
accessSignInApiRoutes.get('/opfield/authorize', optionalAuthMiddleware, async (c) => {
  const state = c.req.query('state') ?? '';
  c.header('Cache-Control', 'no-store');
  // Only the person at the browser vouches for the account: a bearer token (API, OAuth, MCP) never signs anyone in.
  const authType = c.get('authType');
  if (authType && authType !== 'session') {
    throw new AppError(403, 'ACCESS_SIGN_IN_SESSION_REQUIRED', 'Opfield account sign-in needs a console session');
  }
  // An administrator acting as another user signs in as nobody: the visitor signs in with their own account.
  const user = c.get('impersonation') ? undefined : c.get('user');
  if (!user) {
    const here = new URL(c.req.url);
    const login = new URL('/login', here.origin);
    login.searchParams.set('return_to', `${here.pathname}${here.search}`);
    return c.redirect(`${login.pathname}${login.search}`, 302);
  }
  if (user.isBlocked) throw new AppError(403, 'ACCOUNT_BLOCKED', 'Account is blocked');
  return c.redirect(await external().authorizeOpfield(state, user.id), 302);
});

// ---------------------------------------------------------------------------
// /.well-known/opfield-access
// ---------------------------------------------------------------------------

export const accessJwksRoutes = new Hono<AppEnv>();

// Upstreams verify the Opfield-Access-Jwt-Assertion header with these keys.
accessJwksRoutes.get('/jwks', async (c) => {
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(await container.resolve(AccessSigningKeyService).jwks());
});
