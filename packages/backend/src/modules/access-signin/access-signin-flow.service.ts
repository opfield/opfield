import bcrypt from 'bcryptjs';
import { AppError } from '@/middleware/error-handler.js';
import type { AccessDecide } from './access-decision.js';
import { scheduleAccessPolicySync } from './access-policy-sync.js';
import type { AccessSessionRow, AccessSessionStore } from './access-sessions.service.js';
import { isLiveSession, sessionIdentity } from './access-sessions.service.js';
import type { SignInTarget } from './access-signin.schemas.js';
import type { AccessListRow, AccessSignInDirectory } from './access-signin-directory.js';
import type { AccessSignInSettings } from './access-signin-settings.service.js';
import type { AccessSigningKeyService } from './access-signing-key.service.js';
import { type AccessTokenIdentity, normalizeAccessHost } from './access-token.js';

/** The central session cookie on the sign-in domain (aud = sign-in host). */
export const ACCESS_SESSION_COOKIE = 'opfield_access_session';
/** Methods that identify a visitor of one list only. */
const LIST_BOUND_METHODS = new Set(['password', 'basic', 'shared']);
// Compared against when the username is unknown, so a miss takes as long as a wrong password.
const DUMMY_HASH = '$2b$10$xTpgSgCm5puWA8nTrfyvne5Lxm8qrJkHX8IUrzblxyxNM6fYfdkhq';

export interface SignInMethodView {
  key: string;
  label: string;
  kind: 'opfield' | 'idp' | 'password' | 'shared';
}

export type SignInContext =
  | { redirect: string }
  | {
      host: string;
      methods: SignInMethodView[];
      state: 'methods' | 'denied';
      identity?: { email?: string; name?: string };
    };

export interface VisitorMeta {
  clientIp: string;
  userAgent: string | null;
}

export interface SignedIn {
  /** Value of the central session cookie. */
  cookie: string;
  /** Seconds the cookie lives. */
  maxAge: number;
  /** Where the visitor goes next: back to the host with a token, or the sign-in page (no access). */
  redirect: string;
}

export interface ResolvedTarget {
  list: AccessListRow;
  host: string;
  secure: boolean;
  nonce: string;
  returnPath: string;
}

export interface AccessSignInFlowDeps {
  directory: AccessSignInDirectory;
  sessions: AccessSessionStore;
  keys: Pick<AccessSigningKeyService, 'sign' | 'verify'>;
  settings: { getConfig(): Promise<AccessSignInSettings>; signInOrigin(): Promise<string> };
  decide: AccessDecide;
  now?: () => Date;
}

/** The return path the daemon accepts: starts with `/`, not `//`. */
export function safeReturnPath(value: string | undefined | null): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

const unix = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * The sign-in side of access lists: resolves where a visitor came from, checks the central session against the list
 * (the shared evaluator), creates sessions and sends the visitor back to the host with a host token. Tokens are only
 * issued for a host that a route or Pages project protected by the same list serves.
 */
export class AccessSignInFlowService {
  constructor(private readonly deps: AccessSignInFlowDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async resolveTarget(target: SignInTarget): Promise<ResolvedTarget> {
    const list = await this.deps.directory.getList(target.list);
    if (!list) throw new AppError(404, 'ACCESS_LIST_NOT_FOUND', 'This sign-in link is no longer valid');
    const host = normalizeAccessHost(target.host);
    const served = host ? await this.deps.directory.hostOfList(list.id, host) : null;
    if (!served) {
      throw new AppError(400, 'ACCESS_HOST_NOT_PROTECTED', 'This site does not sign visitors in here');
    }
    return { list, host, secure: served.secure, nonce: target.n, returnPath: safeReturnPath(target.r) };
  }

  /** The live session behind a central session cookie, else null. */
  async centralSession(cookie: string | undefined): Promise<AccessSessionRow | null> {
    if (!cookie) return null;
    const signInHost = normalizeAccessHost(new URL(await this.deps.settings.signInOrigin()).host);
    const payload = await this.deps.keys.verify(cookie, signInHost, this.now());
    if (!payload) return null;
    const session = await this.deps.sessions.get(payload.sid);
    return isLiveSession(session, this.now()) ? session : null;
  }

  /** What the sign-in page shows for a visitor, or where it sends them right away. */
  async context(target: SignInTarget, cookie: string | undefined, meta: VisitorMeta): Promise<SignInContext> {
    const resolved = await this.resolveTarget(target);
    const session = await this.centralSession(cookie);
    const methods = await this.methodViews(resolved.list);
    if (!session) return { host: resolved.host, methods, state: 'methods' };
    const identity = await this.currentIdentity(session);
    if (!identity) return { host: resolved.host, methods, state: 'methods' };
    const shown = { ...(identity.em ? { email: identity.em } : {}), ...(identity.nm ? { name: identity.nm } : {}) };
    if (!this.usable(resolved.list, identity))
      return { host: resolved.host, methods, state: 'methods', identity: shown };
    if (this.deps.decide(resolved.list, { clientIp: meta.clientIp }, identity) !== 'allow') {
      return { host: resolved.host, methods, state: 'denied', identity: shown };
    }
    await this.deps.sessions.touch(session.id, this.now());
    return { redirect: await this.hostCallbackUrl(resolved, session, identity) };
  }

  /** Signs a visitor in with an identity the caller verified; the result sends them on. */
  async completeSignIn(
    resolved: ResolvedTarget,
    identity: Omit<AccessTokenIdentity, 'lst'>,
    meta: VisitorMeta
  ): Promise<SignedIn> {
    const now = this.now();
    const ttl = await this.ttlSeconds(resolved.list);
    const session = await this.deps.sessions.create({
      method: identity.m,
      subject: identity.sub,
      email: identity.em ?? null,
      name: identity.nm ?? null,
      groups: identity.grp ?? [],
      accessListId: LIST_BOUND_METHODS.has(identity.m) ? resolved.list.id : null,
      clientIp: meta.clientIp || null,
      userAgent: meta.userAgent?.slice(0, 1024) ?? null,
      expiresAt: new Date(now.getTime() + ttl * 1000),
    });
    const signInHost = normalizeAccessHost(new URL(await this.deps.settings.signInOrigin()).host);
    const cookie = await this.deps.keys.sign({
      sid: session.id,
      aud: signInHost,
      iat: unix(now),
      exp: unix(session.expiresAt),
      idn: sessionIdentity(session),
    });
    return { cookie, maxAge: ttl, redirect: await this.nextStep(resolved, session, meta) };
  }

  async signInWithPassword(
    target: SignInTarget,
    username: string,
    password: string,
    meta: VisitorMeta
  ): Promise<SignedIn> {
    const resolved = await this.resolveTarget(target);
    if (!resolved.list.signInMethods.includes('password')) {
      throw new AppError(400, 'ACCESS_METHOD_NOT_OFFERED', 'This site does not offer username sign-in');
    }
    const user = resolved.list.users.find((candidate) => candidate.username === username);
    const matches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !matches) throw new AppError(401, 'ACCESS_SIGN_IN_FAILED', 'Wrong username or password');
    return this.completeSignIn(resolved, { m: 'password', sub: user.username }, meta);
  }

  async signInWithSharedPassword(target: SignInTarget, password: string, meta: VisitorMeta): Promise<SignedIn> {
    const resolved = await this.resolveTarget(target);
    if (!resolved.list.signInMethods.includes('shared') || !resolved.list.sharedPasswordHash) {
      throw new AppError(400, 'ACCESS_METHOD_NOT_OFFERED', 'This site does not offer a shared password');
    }
    if (!(await bcrypt.compare(password, resolved.list.sharedPasswordHash))) {
      throw new AppError(401, 'ACCESS_SIGN_IN_FAILED', 'Wrong password');
    }
    return this.completeSignIn(resolved, { m: 'shared', sub: 'shared' }, meta);
  }

  /** Ends the central session: every token it issued stops working once the policy reaches the nodes. */
  async signOut(cookie: string | undefined): Promise<boolean> {
    const session = await this.centralSession(cookie);
    if (!session) return false;
    const revoked = await this.deps.sessions.revoke(session.id, this.now());
    if (revoked) scheduleAccessPolicySync();
    return revoked;
  }

  /** The sign-in page for a target; `error` tells the page why the visitor is back. */
  async signInPageUrl(target: SignInTarget, error?: string): Promise<string> {
    const url = new URL('/access/sign-in', await this.deps.settings.signInOrigin());
    url.searchParams.set('list', target.list);
    url.searchParams.set('host', target.host);
    url.searchParams.set('n', target.n);
    url.searchParams.set('r', safeReturnPath(target.r));
    if (error) url.searchParams.set('error', error);
    return url.toString();
  }

  /** Back to the host with a token when the list lets the session in, else the sign-in page (no access). */
  private async nextStep(resolved: ResolvedTarget, session: AccessSessionRow, meta: VisitorMeta): Promise<string> {
    const identity = await this.currentIdentity(session);
    if (
      identity &&
      this.usable(resolved.list, identity) &&
      this.deps.decide(resolved.list, { clientIp: meta.clientIp }, identity) === 'allow'
    ) {
      return this.hostCallbackUrl(resolved, session, identity);
    }
    return this.signInPageUrl({
      list: resolved.list.id,
      host: resolved.host,
      n: resolved.nonce,
      r: resolved.returnPath,
    });
  }

  /** `<host>/_opfield/access/callback?t=<host token>&r=<path>`; the token is valid for that host only. */
  async hostCallbackUrl(
    resolved: ResolvedTarget,
    session: AccessSessionRow,
    identity: AccessTokenIdentity
  ): Promise<string> {
    const now = this.now();
    const ttl = await this.ttlSeconds(resolved.list);
    const exp = Math.min(unix(session.expiresAt), unix(now) + ttl);
    const token = await this.deps.keys.sign({
      sid: session.id,
      aud: resolved.host,
      iat: unix(now),
      exp,
      idn: identity,
      non: resolved.nonce,
    });
    const url = new URL(`${resolved.secure ? 'https' : 'http'}://${resolved.host}/_opfield/access/callback`);
    url.searchParams.set('t', token);
    url.searchParams.set('r', resolved.returnPath);
    return url.toString();
  }

  /** The session's identity now: an Opfield account's email, name and groups as they are today. */
  private async currentIdentity(session: AccessSessionRow): Promise<AccessTokenIdentity | null> {
    const identity = sessionIdentity(session);
    if (identity.m !== 'opfield') return identity;
    const user = await this.deps.directory.getOpfieldUser(identity.sub);
    if (!user) {
      // A blocked or deleted account keeps no access.
      if (await this.deps.sessions.revoke(session.id, this.now())) scheduleAccessPolicySync();
      return null;
    }
    return {
      m: 'opfield',
      sub: user.id,
      em: user.email,
      nm: user.name,
      ...(user.groups.length ? { grp: user.groups } : {}),
    };
  }

  /** Contract step 5: the method is one the list offers; list-bound identities only for their own list. */
  private usable(list: AccessListRow, identity: AccessTokenIdentity): boolean {
    if (!list.signInMethods.includes(identity.m as never)) return false;
    return !LIST_BOUND_METHODS.has(identity.m) || identity.lst === list.id;
  }

  private async ttlSeconds(list: AccessListRow): Promise<number> {
    return list.sessionTtlSeconds ?? (await this.deps.settings.getConfig()).defaultSessionTtlSeconds;
  }

  private async methodViews(list: AccessListRow): Promise<SignInMethodView[]> {
    const providerIds = list.signInMethods.filter((method) => method.startsWith('idp:')).map((m) => m.slice(4));
    const names = await this.deps.directory.providerNames(providerIds);
    const views: SignInMethodView[] = [];
    for (const method of list.signInMethods) {
      if (method === 'opfield') views.push({ key: method, label: 'Opfield account', kind: 'opfield' });
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
