import { type Context, Hono } from 'hono';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, optionalAuthMiddleware } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { AccessSignInExternalService } from './access-signin-external.service.js';
import { AccessSigningKeyService } from './access-signing-key.service.js';

// Visitors of protected routes sign in on the route itself: its nginx daemon serves the page and asks Opfield over
// gRPC (grpc/services/access-sign-in.ts). The console serves only the Opfield account confirmation (its user confirms
// each sign-in on /access-sign-in/confirm) and the JWKS of the token keys.

const external = () => container.resolve(AccessSignInExternalService);

// ---------------------------------------------------------------------------
// /api/access-sign-in (console origin)
// ---------------------------------------------------------------------------

export const accessSignInApiRoutes = new Hono<AppEnv>();

/**
 * The console user who may vouch for an Opfield account sign-in: only the person at the browser (a bearer token, API,
 * OAuth or MCP, never signs anyone in), not an administrator acting as another user, not a blocked account.
 */
function consoleUser(c: Context<AppEnv>) {
  const authType = c.get('authType');
  if (authType && authType !== 'session') {
    throw new AppError(403, 'ACCESS_SIGN_IN_SESSION_REQUIRED', 'Opfield account sign-in needs a console session');
  }
  const user = c.get('impersonation') ? undefined : c.get('user');
  if (user?.isBlocked) throw new AppError(403, 'ACCOUNT_BLOCKED', 'Account is blocked');
  return user;
}

const stateOf = (value: unknown) => (typeof value === 'string' && value.length <= 256 ? value : '');

// The route's "Opfield account" button lands here. Nothing is signed in on a GET: the console asks its user to confirm
// the route host first (/access-sign-in/confirm), and only that page's POST sends the code back to the route.
accessSignInApiRoutes.get('/opfield/authorize', optionalAuthMiddleware, async (c) => {
  const state = stateOf(c.req.query('state'));
  c.header('Cache-Control', 'no-store');
  const here = new URL(c.req.url);
  if (!consoleUser(c)) {
    const login = new URL('/login', here.origin);
    login.searchParams.set('return_to', `${here.pathname}${here.search}`);
    return c.redirect(`${login.pathname}${login.search}`, 302);
  }
  const confirm = new URL('/access-sign-in/confirm', here.origin);
  confirm.searchParams.set('state', state);
  return c.redirect(`${confirm.pathname}${confirm.search}`, 302);
});

// The confirmation page: which route asks, and as whom it would be signed in.
accessSignInApiRoutes.get('/opfield/consent', authMiddleware, async (c) => {
  c.header('Cache-Control', 'no-store');
  const user = consoleUser(c);
  if (!user)
    throw new AppError(403, 'ACCESS_SIGN_IN_SESSION_REQUIRED', 'Opfield account sign-in needs a console session');
  const { host } = await external().opfieldConsent(stateOf(c.req.query('state')));
  return c.json({ host, account: { email: user.email, name: user.name ?? null } });
});

// Continue (a session POST: the console CSRF token is checked): the visitor goes back to the route with a code.
accessSignInApiRoutes.post('/opfield/consent/approve', authMiddleware, async (c) => {
  c.header('Cache-Control', 'no-store');
  const user = consoleUser(c);
  if (!user)
    throw new AppError(403, 'ACCESS_SIGN_IN_SESSION_REQUIRED', 'Opfield account sign-in needs a console session');
  const body = await c.req.json().catch(() => ({}));
  return c.json({ redirectUrl: await external().authorizeOpfield(stateOf(body?.state), user.id) });
});

// Cancel: the visitor goes back to the route, whose page says the sign-in failed.
accessSignInApiRoutes.post('/opfield/consent/deny', authMiddleware, async (c) => {
  c.header('Cache-Control', 'no-store');
  if (!consoleUser(c)) {
    throw new AppError(403, 'ACCESS_SIGN_IN_SESSION_REQUIRED', 'Opfield account sign-in needs a console session');
  }
  const body = await c.req.json().catch(() => ({}));
  return c.json({ redirectUrl: await external().denyOpfield(stateOf(body?.state)) });
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
