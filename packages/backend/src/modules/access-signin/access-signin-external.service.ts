import { createHash, randomBytes } from 'node:crypto';
import * as client from 'openid-client';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CacheService } from '@/services/cache.service.js';
import {
  type AccessIdentityProviderService,
  identityProviderCallbackPath,
} from './access-identity-providers.service.js';
import type { SignInTarget } from './access-signin.schemas.js';
import type { AccessSignInDirectory } from './access-signin-directory.js';
import type { AccessSignInFlowService, SignedIn, VisitorMeta } from './access-signin-flow.service.js';

const logger = createChildLogger('AccessSignInExternal');

/** Binds a pending sign-in at a provider or the console to the browser that started it (login CSRF). */
export const ACCESS_SIGN_IN_STATE_COOKIE = 'opfield_access_signin';
export const PENDING_SIGN_IN_TTL_SECONDS = 600;
const OPFIELD_CODE_TTL_SECONDS = 60;
const IDP_STATE_PREFIX = 'access-signin:idp:';
const OPFIELD_STATE_PREFIX = 'access-signin:opfield:';
const OPFIELD_CODE_PREFIX = 'access-signin:opfield-code:';

interface PendingIdpSignIn {
  providerId: string;
  codeVerifier: string;
  nonce: string;
  target: SignInTarget;
}

interface PendingOpfieldSignIn {
  target: SignInTarget;
}

export function hashSignInState(state: string): string {
  return createHash('sha256').update(state).digest('base64url');
}

function claimString(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Only an address the provider says it verified is an identity email rules may match (no claim: unverified). */
export function verifiedEmail(claims: Record<string, unknown>): string | undefined {
  return claims.email_verified === true ? claimString(claims, 'email')?.toLowerCase() : undefined;
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
 * Sign-in through an identity provider (Google, OIDC) and with an Opfield account of this installation. Both end in
 * AccessSignInFlowService.completeSignIn.
 */
export class AccessSignInExternalService {
  constructor(
    private readonly flow: AccessSignInFlowService,
    private readonly providers: Pick<AccessIdentityProviderService, 'find' | 'clientConfiguration'>,
    private readonly directory: Pick<AccessSignInDirectory, 'getOpfieldUser'>,
    private readonly cache: Pick<CacheService, 'set' | 'get' | 'take'>,
    private readonly signInOrigin: () => Promise<string>,
    private readonly consoleOrigin: () => Promise<string>
  ) {}

  /** The provider's authorization URL and the state the browser is bound to. */
  async startIdp(providerId: string, target: SignInTarget): Promise<{ url: string; state: string }> {
    const resolved = await this.flow.resolveTarget(target);
    if (!resolved.list.signInMethods.includes(`idp:${providerId}`)) {
      throw new AppError(400, 'ACCESS_METHOD_NOT_OFFERED', 'This site does not offer this sign-in method');
    }
    const provider = await this.providers.find(providerId);
    if (!provider) throw new AppError(404, 'ACCESS_IDENTITY_PROVIDER_NOT_FOUND', 'Identity provider not found');
    const config = await this.providers.clientConfiguration(provider);
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    await this.cache.set<PendingIdpSignIn>(
      `${IDP_STATE_PREFIX}${state}`,
      { providerId, codeVerifier, nonce, target },
      PENDING_SIGN_IN_TTL_SECONDS
    );
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: `${await this.signInOrigin()}${identityProviderCallbackPath(providerId)}`,
      scope: provider.scopes,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url: url.href, state };
  }

  /** The provider sent the browser back: exchange the code, sign the visitor in. */
  async finishIdp(
    providerId: string,
    query: URLSearchParams,
    boundState: string | undefined,
    meta: VisitorMeta
  ): Promise<SignedIn> {
    const state = query.get('state') ?? '';
    if (!state || boundState !== hashSignInState(state)) {
      throw new AppError(400, 'ACCESS_SIGN_IN_EXPIRED', 'This sign-in expired; start again');
    }
    const pending = await this.cache.take<PendingIdpSignIn>(`${IDP_STATE_PREFIX}${state}`);
    if (!pending || pending.providerId !== providerId) {
      throw new AppError(400, 'ACCESS_SIGN_IN_EXPIRED', 'This sign-in expired; start again');
    }
    const resolved = await this.flow.resolveTarget(pending.target);
    const provider = await this.providers.find(providerId);
    if (!provider || !resolved.list.signInMethods.includes(`idp:${providerId}`)) {
      throw new AppError(400, 'ACCESS_METHOD_NOT_OFFERED', 'This site does not offer this sign-in method');
    }
    const config = await this.providers.clientConfiguration(provider);
    const callbackUrl = new URL(`${await this.signInOrigin()}${identityProviderCallbackPath(providerId)}`);
    callbackUrl.search = query.toString();
    let claims: Record<string, unknown>;
    try {
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: state,
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
    const email = verifiedEmail(claims);
    const groups = groupsFromClaim(claims, provider.groupsClaim);
    return this.flow.completeSignIn(
      resolved,
      {
        m: `idp:${providerId}`,
        sub: subject,
        ...(email ? { em: email } : {}),
        ...(claimString(claims, 'name') ? { nm: claimString(claims, 'name') } : {}),
        ...(groups.length ? { grp: groups } : {}),
      },
      meta
    );
  }

  /** Opfield account: the console origin confirms who the visitor is (their console session). */
  async startOpfield(target: SignInTarget): Promise<{ url: string; state: string }> {
    const resolved = await this.flow.resolveTarget(target);
    if (!resolved.list.signInMethods.includes('opfield')) {
      throw new AppError(400, 'ACCESS_METHOD_NOT_OFFERED', 'This site does not offer Opfield account sign-in');
    }
    const state = randomBytes(32).toString('base64url');
    await this.cache.set<PendingOpfieldSignIn>(
      `${OPFIELD_STATE_PREFIX}${state}`,
      { target },
      PENDING_SIGN_IN_TTL_SECONDS
    );
    const url = new URL('/api/access-sign-in/opfield/authorize', await this.consoleOrigin());
    url.searchParams.set('state', state);
    return { url: url.toString(), state };
  }

  /** On the console origin, for a signed-in console user: a one-time code back to the sign-in origin. */
  async authorizeOpfield(state: string, userId: string): Promise<string> {
    const pending = state ? await this.cache.get<PendingOpfieldSignIn>(`${OPFIELD_STATE_PREFIX}${state}`) : null;
    if (!pending) throw new AppError(400, 'ACCESS_SIGN_IN_EXPIRED', 'This sign-in expired; start again');
    const code = randomBytes(32).toString('base64url');
    await this.cache.set(`${OPFIELD_CODE_PREFIX}${code}`, { userId, state }, OPFIELD_CODE_TTL_SECONDS);
    const url = new URL('/access/opfield/callback', await this.signInOrigin());
    url.searchParams.set('code', code);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async finishOpfield(
    code: string,
    state: string,
    boundState: string | undefined,
    meta: VisitorMeta
  ): Promise<SignedIn> {
    // A code shown in another browser must not use up the visitor's own pending sign-in.
    if (!state || boundState !== hashSignInState(state)) {
      throw new AppError(400, 'ACCESS_SIGN_IN_EXPIRED', 'This sign-in expired; start again');
    }
    const issued = code
      ? await this.cache.take<{ userId: string; state: string }>(`${OPFIELD_CODE_PREFIX}${code}`)
      : null;
    const pending = state ? await this.cache.take<PendingOpfieldSignIn>(`${OPFIELD_STATE_PREFIX}${state}`) : null;
    if (!issued || !pending || issued.state !== state) {
      throw new AppError(400, 'ACCESS_SIGN_IN_EXPIRED', 'This sign-in expired; start again');
    }
    const resolved = await this.flow.resolveTarget(pending.target);
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
      meta
    );
  }

  /** The target a pending sign-in was started for, to send a failed visitor back to the sign-in page. */
  async pendingTarget(kind: 'idp' | 'opfield', state: string): Promise<SignInTarget | null> {
    if (!state) return null;
    const prefix = kind === 'idp' ? IDP_STATE_PREFIX : OPFIELD_STATE_PREFIX;
    const pending = await this.cache.get<{ target: SignInTarget }>(`${prefix}${state}`);
    return pending?.target ?? null;
  }
}
