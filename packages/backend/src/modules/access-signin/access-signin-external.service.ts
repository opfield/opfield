import { randomBytes } from 'node:crypto';
import * as client from 'openid-client';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CacheService } from '@/services/cache.service.js';
import type { AccessIdentityProviderService } from './access-identity-providers.service.js';
import type { AccessSignInDirectory } from './access-signin-directory.js';
import type {
  AccessSignInFlowService,
  AccessSignInTarget,
  ResolvedTarget,
  SignedIn,
} from './access-signin-flow.service.js';

const logger = createChildLogger('AccessSignInExternal');

/** Where a provider sends the visitor back: a path of the protected route itself, served by its nginx daemon. */
export const ACCESS_PROVIDER_CALLBACK_PATH = '/_opfield/access/provider-callback';
export const PENDING_SIGN_IN_TTL_SECONDS = 600;
const OPFIELD_CODE_TTL_SECONDS = 60;
const PENDING_PREFIX = 'access-signin:pending:';

const offers = (resolved: ResolvedTarget, method: string) => (resolved.list.signInMethods as string[]).includes(method);
const OPFIELD_CODE_PREFIX = 'access-signin:opfield-code:';
/** Set once the console user approved or cancelled an Opfield sign-in: each is decided once. */
const OPFIELD_DECIDED_PREFIX = 'access-signin:opfield-decided:';

const expiredSignIn = () => new AppError(400, 'ACCESS_SIGN_IN_EXPIRED', 'This sign-in expired; start again');

interface PendingSignIn {
  /** opfield or idp:<provider id>. */
  method: string;
  listId: string;
  host: string;
  callbackUrl: string;
  /** Provider sign-ins: PKCE verifier and OIDC nonce, never shown to the browser. */
  codeVerifier?: string;
  nonce?: string;
}

function claimString(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The identity email rules may match: an address the provider says it verified, or, when the provider's email is
 * trusted (the default), one it sends without an email_verified claim. `email_verified: false` never counts.
 */
export function verifiedEmail(claims: Record<string, unknown>, trustEmail = false): string | undefined {
  const verified = claims.email_verified === true || (trustEmail && claims.email_verified === undefined);
  return verified ? claimString(claims, 'email')?.toLowerCase() : undefined;
}

/** Group names from the provider's groups claim: an array of strings or one string. */
export function groupsFromClaim(claims: Record<string, unknown>, claim: string | null): string[] {
  if (!claim) return [];
  const value = claims[claim];
  if (typeof value === 'string') return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((group): group is string => typeof group === 'string' && group.length > 0).slice(0, 200);
}

/**
 * The provider callback of the route the visitor signs in on: `https://<host>/_opfield/access/provider-callback`, plain
 * HTTP only for a route served without TLS. Anything else (another host, port, path or query) is refused, so a code
 * is never sent anywhere but the route the sign-in is for.
 */
export function routeCallbackUrl(resolved: ResolvedTarget, callbackUrl: string): string {
  const invalid = () => new AppError(400, 'ACCESS_CALLBACK_INVALID', 'The sign-in return address is not valid');
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw invalid();
  }
  const schemeAllowed = url.protocol === 'https:' || (url.protocol === 'http:' && !resolved.secure);
  if (
    !schemeAllowed ||
    url.hostname !== resolved.host ||
    url.port !== '' ||
    url.username ||
    url.password ||
    url.pathname !== ACCESS_PROVIDER_CALLBACK_PATH ||
    url.search ||
    url.hash
  ) {
    throw invalid();
  }
  return `${url.protocol}//${resolved.host}${ACCESS_PROVIDER_CALLBACK_PATH}`;
}

/**
 * Sign-in through an identity provider (Google, OIDC) and with an Opfield account of this installation, started and
 * finished by the route's nginx daemon. The provider (or the Opfield console) sends the visitor back to the route's
 * own provider callback; state, PKCE verifier and nonce stay here. Both end in AccessSignInFlowService.completeSignIn.
 */
export class AccessSignInExternalService {
  constructor(
    private readonly flow: AccessSignInFlowService,
    private readonly providers: Pick<AccessIdentityProviderService, 'find' | 'clientConfiguration'>,
    private readonly directory: Pick<AccessSignInDirectory, 'getOpfieldUser'>,
    private readonly cache: Pick<CacheService, 'set' | 'get' | 'take' | 'setIfAbsent'>,
    private readonly consoleOrigin: () => Promise<string>
  ) {}

  /** Where the visitor goes to sign in with `method` (opfield or idp:<id>), and the state the daemon binds them to. */
  async start(
    target: AccessSignInTarget,
    method: string,
    callbackUrl: string
  ): Promise<{ url: string; state: string }> {
    const resolved = await this.flow.resolveTarget(target);
    const isProvider = method.startsWith('idp:');
    if ((method !== 'opfield' && !isProvider) || !offers(resolved, method)) {
      throw new AppError(400, 'ACCESS_METHOD_NOT_OFFERED', 'This site does not offer this sign-in method');
    }
    const callback = routeCallbackUrl(resolved, callbackUrl);
    const pending: PendingSignIn = { method, listId: resolved.list.id, host: resolved.host, callbackUrl: callback };
    if (!isProvider) {
      const state = randomBytes(32).toString('base64url');
      await this.cache.set(`${PENDING_PREFIX}${state}`, pending, PENDING_SIGN_IN_TTL_SECONDS);
      const url = new URL('/api/access-sign-in/opfield/authorize', await this.consoleOrigin());
      url.searchParams.set('state', state);
      return { url: url.toString(), state };
    }
    const provider = await this.providers.find(method.slice(4));
    if (!provider) throw new AppError(404, 'ACCESS_IDENTITY_PROVIDER_NOT_FOUND', 'Identity provider not found');
    const config = await this.providers.clientConfiguration(provider);
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    await this.cache.set(
      `${PENDING_PREFIX}${state}`,
      { ...pending, codeVerifier, nonce } satisfies PendingSignIn,
      PENDING_SIGN_IN_TTL_SECONDS
    );
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: callback,
      scope: provider.scopes,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url: url.href, state };
  }

  /** What the console asks its signed-in user to confirm: the route host of a pending, undecided Opfield sign-in. */
  async opfieldConsent(state: string): Promise<{ host: string }> {
    const pending = await this.pendingOpfield(state);
    if (await this.cache.get<boolean>(`${OPFIELD_DECIDED_PREFIX}${state}`)) throw expiredSignIn();
    return { host: pending.host };
  }

  /**
   * The console user confirmed (a POST with the console CSRF token): a one-time code back to the route's provider
   * callback. A sign-in is decided once, so a link to it cannot be approved again.
   */
  async authorizeOpfield(state: string, userId: string): Promise<string> {
    const pending = await this.decideOpfield(state);
    const code = randomBytes(32).toString('base64url');
    await this.cache.set(`${OPFIELD_CODE_PREFIX}${code}`, { userId, state }, OPFIELD_CODE_TTL_SECONDS);
    const url = new URL(pending.callbackUrl);
    url.searchParams.set('code', code);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** The console user cancelled: back to the route's provider callback, which shows that the sign-in failed. */
  async denyOpfield(state: string): Promise<string> {
    const pending = await this.decideOpfield(state);
    const url = new URL(pending.callbackUrl);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('state', state);
    return url.toString();
  }

  private async pendingOpfield(state: string): Promise<PendingSignIn> {
    const pending = state ? await this.cache.get<PendingSignIn>(`${PENDING_PREFIX}${state}`) : null;
    if (!pending || pending.method !== 'opfield') throw expiredSignIn();
    return pending;
  }

  private async decideOpfield(state: string): Promise<PendingSignIn> {
    const pending = await this.pendingOpfield(state);
    if (!(await this.cache.setIfAbsent(`${OPFIELD_DECIDED_PREFIX}${state}`, true, PENDING_SIGN_IN_TTL_SECONDS))) {
      throw expiredSignIn();
    }
    return pending;
  }

  /**
   * The visitor is back on the route's provider callback (the daemon checked the state against the cookie it set when
   * the sign-in started): exchange the code and sign the visitor in.
   */
  async finish(
    target: AccessSignInTarget,
    input: { state: string; code: string; error: string; callbackUrl: string }
  ): Promise<SignedIn> {
    const pending = input.state ? await this.cache.take<PendingSignIn>(`${PENDING_PREFIX}${input.state}`) : null;
    if (!pending) throw new AppError(400, 'ACCESS_SIGN_IN_EXPIRED', 'This sign-in expired; start again');
    // The callback may reach another member of the route's ingress group; that node must serve the same route.
    const resolved = await this.flow.resolveTarget(target);
    if (
      pending.listId !== resolved.list.id ||
      pending.host !== resolved.host ||
      routeCallbackUrl(resolved, input.callbackUrl) !== pending.callbackUrl
    ) {
      throw new AppError(400, 'ACCESS_SIGN_IN_EXPIRED', 'This sign-in expired; start again');
    }
    if (!offers(resolved, pending.method)) {
      throw new AppError(400, 'ACCESS_METHOD_NOT_OFFERED', 'This site does not offer this sign-in method');
    }
    if (pending.method === 'opfield') return this.finishOpfield(resolved, input, target);
    return this.finishIdp(resolved, pending, input, target);
  }

  private async finishIdp(
    resolved: ResolvedTarget,
    pending: PendingSignIn,
    input: { state: string; code: string; error: string },
    target: AccessSignInTarget
  ): Promise<SignedIn> {
    const providerId = pending.method.slice(4);
    const provider = await this.providers.find(providerId);
    if (!provider) throw new AppError(400, 'ACCESS_METHOD_NOT_OFFERED', 'This site does not offer this sign-in method');
    if (input.error || !input.code) {
      throw new AppError(401, 'ACCESS_SIGN_IN_FAILED', `${provider.name} did not sign you in`);
    }
    const config = await this.providers.clientConfiguration(provider);
    const callbackUrl = new URL(pending.callbackUrl);
    callbackUrl.searchParams.set('code', input.code);
    callbackUrl.searchParams.set('state', input.state);
    // The daemon hands back code and state only. A provider that announces the iss response parameter is the one the
    // state was issued for (the pending sign-in names it), so its own issuer stands in.
    const metadata = config.serverMetadata();
    if (metadata.authorization_response_iss_parameter_supported) callbackUrl.searchParams.set('iss', metadata.issuer);
    let claims: Record<string, unknown>;
    try {
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: input.state,
        expectedNonce: pending.nonce,
      });
      claims = (tokens.claims() ?? {}) as Record<string, unknown>;
    } catch (error) {
      logger.warn('Identity provider sign-in failed', {
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(401, 'ACCESS_SIGN_IN_FAILED', `${provider.name} did not sign you in`);
    }
    const subject = claimString(claims, 'sub');
    if (!subject) throw new AppError(401, 'ACCESS_SIGN_IN_FAILED', `${provider.name} did not name the account`);
    const email = verifiedEmail(claims, provider.trustEmail);
    const groups = groupsFromClaim(claims, provider.groupsClaim);
    const name = claimString(claims, 'name');
    return this.flow.completeSignIn(
      resolved,
      {
        m: pending.method,
        sub: subject,
        ...(email ? { em: email } : {}),
        ...(name ? { nm: name } : {}),
        ...(groups.length ? { grp: groups } : {}),
      },
      target
    );
  }

  private async finishOpfield(
    resolved: ResolvedTarget,
    input: { state: string; code: string; error: string },
    target: AccessSignInTarget
  ): Promise<SignedIn> {
    if (input.error) throw new AppError(401, 'ACCESS_SIGN_IN_FAILED', 'Opfield did not sign you in');
    const issued = input.code
      ? await this.cache.take<{ userId: string; state: string }>(`${OPFIELD_CODE_PREFIX}${input.code}`)
      : null;
    if (!issued || issued.state !== input.state) {
      throw new AppError(400, 'ACCESS_SIGN_IN_EXPIRED', 'This sign-in expired; start again');
    }
    const user = await this.directory.getOpfieldUser(issued.userId);
    if (!user) throw new AppError(403, 'ACCESS_SIGN_IN_FAILED', 'This Opfield account cannot sign in');
    return this.flow.completeSignIn(
      resolved,
      {
        m: 'opfield',
        sub: user.id,
        em: user.email,
        nm: user.name,
        ...(user.groups.length ? { grp: user.groups } : {}),
      },
      target
    );
  }
}
