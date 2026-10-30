import bcrypt from 'bcryptjs';
import { AppError } from '@/middleware/error-handler.js';
import { accessIdentityUsable } from '@/modules/access-lists/access-policy-evaluator.js';
import type { AccessDecide } from './access-decision.js';
import type { AccessSessionStore } from './access-sessions.service.js';
import { sessionIdentity } from './access-sessions.service.js';
import type { AccessListRow, AccessSignInDirectory } from './access-signin-directory.js';
import type { AccessSignInSettings } from './access-signin-settings.service.js';
import type { AccessSigningKeyService } from './access-signing-key.service.js';
import { type AccessTokenIdentity, isAccessHostName } from './access-token.js';

/** Sign-in page methods whose session is valid for the list it signed in to only (basic never signs in here). */
const LIST_SESSION_METHODS = new Set(['password', 'shared']);
// Compared against when the username is unknown, so a miss takes as long as a wrong password.
const DUMMY_HASH = '$2b$10$xTpgSgCm5puWA8nTrfyvne5Lxm8qrJkHX8IUrzblxyxNM6fYfdkhq';

export interface SignInMethodView {
  key: string;
  label: string;
  kind: 'opfield' | 'idp' | 'password' | 'shared';
}

/**
 * A sign-in on a protected route's own page: the list and host the route's nginx daemon asked for, the node that asked
 * (its mTLS identity) and the visitor that daemon saw.
 */
export interface AccessSignInTarget {
  listId: string;
  host: string;
  nodeId: string;
  clientIp: string;
  userAgent: string | null;
}

export interface SignedIn {
  /** The v1 host token the daemon sets as the route's access cookie. */
  token: string;
}

export interface ResolvedTarget {
  list: AccessListRow;
  host: string;
  /** The route serves the host over HTTPS. */
  secure: boolean;
}

export interface AccessSignInFlowDeps {
  directory: AccessSignInDirectory;
  sessions: Pick<AccessSessionStore, 'create'>;
  keys: Pick<AccessSigningKeyService, 'sign'>;
  settings: { getConfig(): Promise<AccessSignInSettings> };
  decide: AccessDecide;
  now?: () => Date;
}

const unix = (date: Date) => Math.floor(date.getTime() / 1000);

/** Refused for a list, host or node that does not sign this visitor in: the same answer for every reason. */
export function notSignedInHere(): AppError {
  return new AppError(403, 'ACCESS_DENIED', 'This site does not sign visitors in here');
}

/**
 * The sign-in side of access lists. Every protected route signs its visitors in on its own page (served by the route's
 * nginx daemon, which asks here over its node channel): this resolves the list and host for the node that asked,
 * checks credentials and identities against the list (the shared evaluator), records a session and issues the host
 * token. Tokens are only issued for a host the asking node serves for a route or Pages preview protected by the list.
 */
export class AccessSignInFlowService {
  constructor(private readonly deps: AccessSignInFlowDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async resolveTarget(target: Pick<AccessSignInTarget, 'listId' | 'host' | 'nodeId'>): Promise<ResolvedTarget> {
    // nginx's $host: no port, user info or path; anything else is not a route host.
    const host = target.host.trim().toLowerCase().replace(/\.$/, '');
    if (!isAccessHostName(host)) throw notSignedInHere();
    const list = await this.deps.directory.getList(target.listId);
    if (!list) throw notSignedInHere();
    const served = await this.deps.directory.hostOfList(list.id, host, target.nodeId);
    if (!served) throw notSignedInHere();
    return { list, host, secure: served.secure };
  }

  /** The buttons of the route's sign-in page, in the list's order; empty when the list signs nobody in on a page. */
  async methods(target: AccessSignInTarget): Promise<SignInMethodView[]> {
    const resolved = await this.resolveTarget(target);
    return this.methodViews(resolved.list);
  }

  /**
   * Signs a visitor in with an identity the caller verified: the list must let it in from the visitor's address. The
   * session is recorded (revocation, password and account changes end it) and its host token returned.
   */
  async completeSignIn(
    resolved: ResolvedTarget,
    identity: Omit<AccessTokenIdentity, 'lst'>,
    target: Pick<AccessSignInTarget, 'clientIp' | 'userAgent'>
  ): Promise<SignedIn> {
    const listIdentity: AccessTokenIdentity = LIST_SESSION_METHODS.has(identity.m)
      ? { ...identity, lst: resolved.list.id }
      : identity;
    if (
      !accessIdentityUsable(resolved.list, listIdentity) ||
      this.deps.decide(resolved.list, { clientIp: target.clientIp }, listIdentity) !== 'allow'
    ) {
      const who = identity.em ?? identity.nm;
      throw new AppError(
        403,
        'ACCESS_DENIED',
        who ? `${who} has no access to this site` : 'This account has no access to this site'
      );
    }
    const now = this.now();
    const ttl = await this.ttlSeconds(resolved.list);
    const session = await this.deps.sessions.create({
      method: identity.m,
      subject: identity.sub,
      email: identity.em ?? null,
      name: identity.nm ?? null,
      groups: identity.grp ?? [],
      accessListId: LIST_SESSION_METHODS.has(identity.m) ? resolved.list.id : null,
      clientIp: target.clientIp || null,
      userAgent: target.userAgent?.slice(0, 1024) ?? null,
      expiresAt: new Date(now.getTime() + ttl * 1000),
    });
    return { token: await this.hostToken(resolved, session.id, sessionIdentity(session), session.expiresAt) };
  }

  async signInWithPassword(target: AccessSignInTarget, username: string, password: string): Promise<SignedIn> {
    const resolved = await this.resolveTarget(target);
    if (!resolved.list.signInMethods.includes('password')) {
      throw new AppError(400, 'ACCESS_METHOD_NOT_OFFERED', 'This site does not offer username sign-in');
    }
    const user = resolved.list.users.find((candidate) => candidate.username === username.trim());
    const matches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !matches) throw new AppError(401, 'ACCESS_SIGN_IN_FAILED', 'Wrong username or password');
    return this.completeSignIn(resolved, { m: 'password', sub: user.username }, target);
  }

  async signInWithSharedPassword(target: AccessSignInTarget, password: string): Promise<SignedIn> {
    const resolved = await this.resolveTarget(target);
    if (!resolved.list.signInMethods.includes('shared') || !resolved.list.sharedPasswordHash) {
      throw new AppError(400, 'ACCESS_METHOD_NOT_OFFERED', 'This site does not offer a shared password');
    }
    if (!(await bcrypt.compare(password, resolved.list.sharedPasswordHash))) {
      throw new AppError(401, 'ACCESS_SIGN_IN_FAILED', 'Wrong password');
    }
    return this.completeSignIn(resolved, { m: 'shared', sub: 'shared' }, target);
  }

  /** The v1 host token of a session: valid for exactly this host, until the session or the list's length ends. */
  private async hostToken(
    resolved: ResolvedTarget,
    sessionId: string,
    identity: AccessTokenIdentity,
    sessionExpiresAt: Date
  ): Promise<string> {
    // The token goes to exactly the host it is for.
    if (!isAccessHostName(resolved.host)) throw notSignedInHere();
    const now = this.now();
    const ttl = await this.ttlSeconds(resolved.list);
    return this.deps.keys.sign({
      sid: sessionId,
      aud: resolved.host,
      iat: unix(now),
      exp: Math.min(unix(sessionExpiresAt), unix(now) + ttl),
      idn: identity,
    });
  }

  private async ttlSeconds(list: AccessListRow): Promise<number> {
    return list.sessionTtlSeconds ?? (await this.deps.settings.getConfig()).defaultSessionTtlSeconds;
  }

  private async methodViews(list: AccessListRow): Promise<SignInMethodView[]> {
    const providerIds = list.signInMethods.filter((method) => method.startsWith('idp:')).map((m) => m.slice(4));
    const names = await this.deps.directory.providerNames(providerIds);
    const views: SignInMethodView[] = [];
    for (const method of list.signInMethods) {
      if (method === 'opfield') views.push({ key: method, label: 'Opfield', kind: 'opfield' });
      else if (method === 'password') views.push({ key: method, label: 'Username', kind: 'password' });
      else if (method === 'shared') views.push({ key: method, label: 'Shared password', kind: 'shared' });
      else if (method.startsWith('idp:')) {
        const name = names.get(method.slice(4));
        // A provider deleted behind the list's back is not offered.
        if (name) views.push({ key: method, label: name, kind: 'idp' });
      }
      // basic is HTTP authentication on the host itself, never a sign-in page button.
    }
    return views;
  }
}
