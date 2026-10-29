import type { Context } from 'hono';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { container } from '@/container.js';
import { getClientIpForContext } from '@/lib/request-ip.js';
import { AppError } from '@/middleware/error-handler.js';
import { accessSignInRateLimitMiddleware } from '@/middleware/rate-limit.js';
import { optionalAuthMiddleware } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import {
  PasswordSignInSchema,
  SharedSignInSchema,
  type SignInTarget,
  SignInTargetSchema,
} from './access-signin.schemas.js';
import {
  ACCESS_SIGN_IN_STATE_COOKIE,
  AccessSignInExternalService,
  hashSignInState,
  PENDING_SIGN_IN_TTL_SECONDS,
} from './access-signin-external.service.js';
import {
  ACCESS_SESSION_COOKIE,
  AccessSignInFlowService,
  type SignedIn,
  type VisitorMeta,
} from './access-signin-flow.service.js';
import { AccessSignInSettingsService } from './access-signin-settings.service.js';
import { AccessSigningKeyService } from './access-signing-key.service.js';

// Public sign-in of access lists (contract "Backend sign-in"): the JSON API the sign-in page calls, the browser
// routes of the provider and Opfield account flows, and the JWKS of the token keys.

const flow = () => container.resolve(AccessSignInFlowService);
const external = () => container.resolve(AccessSignInExternalService);

async function visitor(c: Context<AppEnv>): Promise<VisitorMeta> {
  return { clientIp: (await getClientIpForContext(c)) ?? '', userAgent: c.req.header('user-agent') ?? null };
}

async function secureCookies(): Promise<boolean> {
  const origin = await container.resolve(AccessSignInSettingsService).signInOrigin();
  return new URL(origin).protocol === 'https:';
}

async function setSessionCookie(c: Context<AppEnv>, signed: SignedIn) {
  setCookie(c, ACCESS_SESSION_COOKIE, signed.cookie, {
    httpOnly: true,
    secure: await secureCookies(),
    sameSite: 'Lax',
    path: '/',
    maxAge: signed.maxAge,
  });
}

async function bindState(c: Context<AppEnv>, state: string) {
  setCookie(c, ACCESS_SIGN_IN_STATE_COOKIE, hashSignInState(state), {
    httpOnly: true,
    secure: await secureCookies(),
    sameSite: 'Lax',
    path: '/access',
    maxAge: PENDING_SIGN_IN_TTL_SECONDS,
  });
}

function targetFromQuery(c: Context<AppEnv>): SignInTarget | null {
  const parsed = SignInTargetSchema.safeParse({
    list: c.req.query('list'),
    host: c.req.query('host'),
    n: c.req.query('n'),
    r: c.req.query('r'),
  });
  return parsed.success ? parsed.data : null;
}

/** A browser route failed: back to the sign-in page with the reason, or a plain answer without a target. */
async function failBrowserRoute(c: Context<AppEnv>, error: unknown, target: SignInTarget | null) {
  if (!(error instanceof AppError)) throw error;
  if (target && error.code !== 'ACCESS_HOST_NOT_PROTECTED' && error.code !== 'ACCESS_LIST_NOT_FOUND') {
    return c.redirect(await flow().signInPageUrl(target, error.code), 302);
  }
  c.header('Cache-Control', 'no-store');
  return c.text(error.message, error.statusCode === 404 ? 404 : 400);
}

// ---------------------------------------------------------------------------
// JSON API (/api/access-sign-in)
// ---------------------------------------------------------------------------

export const accessSignInApiRoutes = new Hono<AppEnv>();

accessSignInApiRoutes.get('/context', async (c) => {
  const target = targetFromQuery(c);
  if (!target) throw new AppError(400, 'VALIDATION_ERROR', 'list, host and n are required');
  c.header('Cache-Control', 'no-store');
  return c.json(await flow().context(target, getCookie(c, ACCESS_SESSION_COOKIE), await visitor(c)));
});

accessSignInApiRoutes.post('/password', accessSignInRateLimitMiddleware, async (c) => {
  const body = PasswordSignInSchema.parse(await c.req.json());
  const signed = await flow().signInWithPassword(body, body.username, body.password, await visitor(c));
  await setSessionCookie(c, signed);
  return c.json({ redirect: signed.redirect });
});

accessSignInApiRoutes.post('/shared', accessSignInRateLimitMiddleware, async (c) => {
  const body = SharedSignInSchema.parse(await c.req.json());
  const signed = await flow().signInWithSharedPassword(body, body.password, await visitor(c));
  await setSessionCookie(c, signed);
  return c.json({ redirect: signed.redirect });
});

accessSignInApiRoutes.post('/sign-out', async (c) => {
  await flow().signOut(getCookie(c, ACCESS_SESSION_COOKIE));
  deleteCookie(c, ACCESS_SESSION_COOKIE, { path: '/', secure: await secureCookies() });
  return c.json({ success: true });
});

// On the console origin: the console session says which Opfield account signs in.
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
// Browser routes (/access)
// ---------------------------------------------------------------------------

export const accessSignInBrowserRoutes = new Hono<AppEnv>();

// A visitor whose central session already gets in goes straight back; anyone else gets the sign-in page (the login
// entry of the frontend, served after this handler).
accessSignInBrowserRoutes.get('/sign-in', async (c, next) => {
  const target = targetFromQuery(c);
  if (target) {
    try {
      const redirect = await flow().sessionRedirect(target, getCookie(c, ACCESS_SESSION_COOKIE), await visitor(c));
      if (redirect) {
        c.header('Cache-Control', 'no-store');
        return c.redirect(redirect, 302);
      }
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      // The page shows the error from /context.
    }
  }
  await next();
});

accessSignInBrowserRoutes.get('/idp/:providerId/start', async (c) => {
  const target = targetFromQuery(c);
  if (!target) return c.text('This sign-in link is not complete', 400);
  try {
    const { url, state } = await external().startIdp(c.req.param('providerId'), target);
    await bindState(c, state);
    return c.redirect(url, 302);
  } catch (error) {
    return failBrowserRoute(c, error, target);
  }
});

accessSignInBrowserRoutes.get('/idp/:providerId/callback', async (c) => {
  const query = new URL(c.req.url).searchParams;
  const target = await external().pendingTarget('idp', query.get('state') ?? '');
  try {
    if (query.get('error')) throw new AppError(401, 'ACCESS_SIGN_IN_FAILED', 'The provider did not sign you in');
    const signed = await external().finishIdp(
      c.req.param('providerId'),
      query,
      getCookie(c, ACCESS_SIGN_IN_STATE_COOKIE),
      await visitor(c)
    );
    await setSessionCookie(c, signed);
    deleteCookie(c, ACCESS_SIGN_IN_STATE_COOKIE, { path: '/access' });
    return c.redirect(signed.redirect, 302);
  } catch (error) {
    return failBrowserRoute(c, error, target);
  }
});

accessSignInBrowserRoutes.get('/opfield/start', async (c) => {
  const target = targetFromQuery(c);
  if (!target) return c.text('This sign-in link is not complete', 400);
  try {
    const { url, state } = await external().startOpfield(target);
    await bindState(c, state);
    return c.redirect(url, 302);
  } catch (error) {
    return failBrowserRoute(c, error, target);
  }
});

accessSignInBrowserRoutes.get('/opfield/callback', async (c) => {
  const state = c.req.query('state') ?? '';
  const target = await external().pendingTarget('opfield', state);
  try {
    const signed = await external().finishOpfield(
      c.req.query('code') ?? '',
      state,
      getCookie(c, ACCESS_SIGN_IN_STATE_COOKIE),
      await visitor(c)
    );
    await setSessionCookie(c, signed);
    deleteCookie(c, ACCESS_SIGN_IN_STATE_COOKIE, { path: '/access' });
    return c.redirect(signed.redirect, 302);
  } catch (error) {
    return failBrowserRoute(c, error, target);
  }
});

// ---------------------------------------------------------------------------
// /.well-known/opfield-access
// ---------------------------------------------------------------------------

export const accessJwksRoutes = new Hono<AppEnv>();

accessJwksRoutes.get('/jwks', async (c) => {
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(await container.resolve(AccessSigningKeyService).jwks());
});

/** Paths the sign-in domain serves; everything else there is a 404. */
export function isAccessSignInDomainPath(path: string): boolean {
  return (
    path === '/access' ||
    path.startsWith('/access/') ||
    path.startsWith('/api/access-sign-in/') ||
    path === '/.well-known/opfield-access/jwks' ||
    // The sign-in page's own files (the login entry of the frontend).
    path.startsWith('/assets/') ||
    path.startsWith('/fonts/') ||
    (/^\/[^/]+\.[a-zA-Z0-9]+$/.test(path) && !path.endsWith('.html'))
  );
}
