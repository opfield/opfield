import { createHash } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { consumeRateLimit, peekRateLimit, rateLimitAddress, recordRateLimit } from '@/middleware/rate-limit.js';
import { AccessSignInExternalService } from '@/modules/access-signin/access-signin-external.service.js';
import {
  AccessSignInFlowService,
  type AccessSignInTarget,
} from '@/modules/access-signin/access-signin-flow.service.js';
import { getEnvironmentSettingsSnapshot } from '@/modules/settings/environment-settings.service.js';
import type {
  AccessSignInContextReply,
  AccessSignInContextRequest,
  AccessSignInFinishRequest,
  AccessSignInPasswordRequest,
  AccessSignInReply,
  AccessSignInStartReply,
  AccessSignInStartRequest,
  AccessSignInTarget as AccessSignInTargetMessage,
} from '../generated/types.js';
import type { GrpcServerDeps } from '../server.js';
import { nginxNodeId } from './maintenance-access.js';

const logger = createChildLogger('AccessSignInGrpc');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Values longer than these are refused before anything is looked up. */
const LIMITS = { host: 253, clientIp: 64, userAgent: 1024, username: 255, password: 1024, method: 128, url: 2048 };
const LONG_VALUE = 4096;

type Unary<Req, Res> = (call: grpc.ServerUnaryCall<Req, Res>, callback: grpc.sendUnaryData<Res>) => Promise<void>;

function text(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) return null;
  return value;
}

/** The visitor and route the daemon asks for, bound to the node that asks; null when malformed. */
function targetOf(message: AccessSignInTargetMessage | undefined, nodeId: string): AccessSignInTarget | null {
  const listId = text(message?.listId, 36);
  const host = text(message?.host, LIMITS.host);
  const clientIp = text(message?.clientIp, LIMITS.clientIp);
  const userAgent = text(message?.userAgent, LONG_VALUE);
  if (!listId || !UUID_PATTERN.test(listId) || !host || clientIp === null || userAgent === null) return null;
  return { listId, host, nodeId, clientIp, userAgent: userAgent ? userAgent.slice(0, LIMITS.userAgent) : null };
}

const refused = (message = 'This site does not sign visitors in here') => ({
  allowed: false,
  token: '',
  errorCode: 'ACCESS_DENIED',
  message,
});

/** An expected refusal (wrong password, no access, expired sign-in) as the reply the page shows. */
function failure(error: unknown): { errorCode: string; message: string } | null {
  if (!(error instanceof AppError)) return null;
  if (error.code === 'RATE_LIMIT_EXCEEDED') {
    return { errorCode: 'ACCESS_RATE_LIMITED', message: 'Too many attempts. Wait a minute and try again.' };
  }
  if (error.code === 'RATE_LIMIT_UNAVAILABLE') return null;
  return { errorCode: error.code, message: error.message };
}

const RATE_LIMIT_PREFIX = 'ratelimit:access-sign-in';
/** Failed passwords of a whole list, in the login budget's multiples, after which every attempt on it waits. */
const LIST_FAILURE_FACTOR = 10;
/** How long an attempt waits once its username or its list is over the failure ceiling: slower, never refused. */
const SLOW_DOWN_MS = 1_000;
/** Password checks (bcrypt) of one list at a time; the others wait their turn. */
const LIST_PASSWORD_CHECKS = 2;
/** How long an attempt waits for its turn before it is answered with "too many attempts". */
const LIST_PASSWORD_WAIT_MS = 5_000;

const tooManyAttempts = () => new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests, please try again later');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A per-account counter name: the list and the username, hashed (the username is not kept in Redis). */
function accountSubject(listId: string, username: string): string {
  const account = username.trim().toLowerCase();
  return `list:${listId}:user:${createHash('sha256').update(`${listId}\n${account}`).digest('hex').slice(0, 32)}`;
}

/**
 * Every RPC a visitor's request makes, per client address (an IPv6 address by its /64), with the console's auth
 * budget: a client that loops the sign-in page, a provider start or wrong passwords slows down only itself.
 */
function admitRequest(target: AccessSignInTarget): Promise<void> {
  return consumeRateLimit(
    `${RATE_LIMIT_PREFIX}:request`,
    [`ip:${rateLimitAddress(target.clientIp)}`],
    (settings) => settings.authMaxRequests
  );
}

/** At most `size` runs per key at a time; a run that waits longer than `waitMs` for its turn is refused. */
export class KeyedSlots {
  private readonly keys = new Map<string, { active: number; waiting: Array<() => void> }>();

  constructor(
    private readonly size: number,
    private readonly waitMs: number
  ) {}

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const entry = this.keys.get(key) ?? { active: 0, waiting: [] };
    this.keys.set(key, entry);
    if (entry.active < this.size) {
      entry.active += 1;
    } else {
      // A finished run hands its slot over, so `active` stays as it is.
      await new Promise<void>((resolve, reject) => {
        const turn = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          entry.waiting.splice(entry.waiting.indexOf(turn), 1);
          reject(tooManyAttempts());
        }, this.waitMs);
        entry.waiting.push(turn);
      });
    }
    try {
      return await work();
    } finally {
      const next = entry.waiting.shift();
      if (next) next();
      else if (--entry.active === 0) this.keys.delete(key);
    }
  }
}

/**
 * Throttles password and shared-password attempts. Only failed attempts count, so signing in never uses a budget up:
 * - per (list, client address): over the login budget, that client is refused for the rest of the window;
 * - per (list, username), and per list (LIST_FAILURE_FACTOR × the budget): over it, every attempt waits SLOW_DOWN_MS
 *   but is still checked, so nobody can lock a user or a list out from other addresses;
 * - the bcrypt work of a list runs LIST_PASSWORD_CHECKS at a time (KeyedSlots).
 */
async function throttledPasswordCheck<T>(
  slots: KeyedSlots,
  target: AccessSignInTarget,
  username: string | null,
  check: () => Promise<T>
): Promise<T> {
  const budget = getEnvironmentSettingsSnapshot().rateLimits.authLoginMaxRequests;
  const prefix = `${RATE_LIMIT_PREFIX}:failed`;
  const client = `list:${target.listId}:ip:${rateLimitAddress(target.clientIp)}`;
  const subjects = [client, `list:${target.listId}`, ...(username ? [accountSubject(target.listId, username)] : [])];
  const [clientFailures = 0, listFailures = 0, accountFailures = 0] = await peekRateLimit(prefix, subjects);
  if (clientFailures >= budget) throw tooManyAttempts();
  if (accountFailures >= budget || listFailures >= budget * LIST_FAILURE_FACTOR) await sleep(SLOW_DOWN_MS);
  try {
    return await slots.run(target.listId, check);
  } catch (error) {
    if (error instanceof AppError && error.code === 'ACCESS_SIGN_IN_FAILED' && error.statusCode === 401) {
      await recordRateLimit(prefix, subjects);
    }
    throw error;
  }
}

/**
 * opfield.v1.AccessSignIn: the sign-in page an nginx daemon serves on a protected route (/_opfield/access/ of that
 * route) checks credentials and runs provider sign-ins here. Only an enrolled nginx node may ask, and only for a list
 * and host it serves (AccessSignInFlowService.resolveTarget); the visitor never reaches Opfield.
 */
export function createAccessSignInHandlers(deps: GrpcServerDeps) {
  const flow = () => container.resolve(AccessSignInFlowService);
  const external = () => container.resolve(AccessSignInExternalService);

  const passwordChecks = new KeyedSlots(LIST_PASSWORD_CHECKS, LIST_PASSWORD_WAIT_MS);

  /** `refuse` returns null for an answer the reply cannot carry: the call then fails with RESOURCE_EXHAUSTED. */
  function handler<Req extends { target?: AccessSignInTargetMessage }, Res>(
    name: string,
    run: (request: Req, target: AccessSignInTarget) => Promise<Res>,
    refuse: (error: { errorCode: string; message: string }) => Res | null
  ): Unary<Req, Res> {
    const reply = (callback: grpc.sendUnaryData<Res>, error: { errorCode: string; message: string }) => {
      const refusal = refuse(error);
      if (refusal) return callback(null, refusal);
      callback({ code: grpc.status.RESOURCE_EXHAUSTED, message: error.message });
    };
    return async (call, callback) => {
      try {
        const nodeId = await nginxNodeId(call, deps);
        if (!nodeId) return callback({ code: grpc.status.PERMISSION_DENIED, message: 'Enrolled nginx node required' });
        const target = targetOf(call.request.target, nodeId);
        if (!target) return reply(callback, refused());
        await admitRequest(target);
        callback(null, await run(call.request, target));
      } catch (error) {
        const expected = failure(error);
        if (expected) return reply(callback, expected);
        logger.warn('Access sign-in request failed', {
          rpc: name,
          error: error instanceof Error ? error.message : String(error),
        });
        callback({ code: grpc.status.UNAVAILABLE, message: 'Sign-in is unavailable' });
      }
    };
  }

  return {
    Context: handler<AccessSignInContextRequest, AccessSignInContextReply>(
      'Context',
      async (_request, target) => ({ methods: await flow().methods(target) }),
      // A list or host this node does not serve offers nothing; a client over its budget gets no page.
      (error) => (error.errorCode === 'ACCESS_RATE_LIMITED' ? null : { methods: [] })
    ),

    Password: handler<AccessSignInPasswordRequest, AccessSignInReply>(
      'Password',
      async (request, target) => {
        const kind = request.kind ?? '';
        const username = text(request.username, LIMITS.username);
        const password = text(request.password, LIMITS.password);
        if ((kind !== 'password' && kind !== 'shared') || username === null || password === null) {
          throw new AppError(400, 'ACCESS_SIGN_IN_FAILED', 'Enter the password to continue');
        }
        if (!password || (kind === 'password' && !username.trim())) {
          throw new AppError(
            400,
            'ACCESS_SIGN_IN_FAILED',
            kind === 'password' ? 'Enter the username and password' : 'Enter the password'
          );
        }
        const signed = await throttledPasswordCheck(
          passwordChecks,
          target,
          kind === 'password' ? username : null,
          () =>
            kind === 'password'
              ? flow().signInWithPassword(target, username, password)
              : flow().signInWithSharedPassword(target, password)
        );
        return { allowed: true, token: signed.token, errorCode: '', message: '' };
      },
      (error) => ({ allowed: false, token: '', ...error })
    ),

    StartProvider: handler<AccessSignInStartRequest, AccessSignInStartReply>(
      'StartProvider',
      async (request, target) => {
        const method = text(request.methodKey, LIMITS.method);
        const callbackUrl = text(request.callbackUrl, LIMITS.url);
        if (!method || !callbackUrl) {
          throw new AppError(400, 'ACCESS_METHOD_NOT_OFFERED', 'This site does not offer this sign-in method');
        }
        const started = await external().start(target, method, callbackUrl);
        return { authorizeUrl: started.url, state: started.state, errorCode: '', message: '' };
      },
      (error) => ({ authorizeUrl: '', state: '', ...error })
    ),

    FinishProvider: handler<AccessSignInFinishRequest, AccessSignInReply>(
      'FinishProvider',
      async (request, target) => {
        const state = text(request.state, 256);
        const code = text(request.code, LONG_VALUE);
        const providerError = text(request.error, LONG_VALUE);
        const callbackUrl = text(request.callbackUrl, LIMITS.url);
        if (!state || code === null || providerError === null || !callbackUrl) {
          throw new AppError(400, 'ACCESS_SIGN_IN_EXPIRED', 'This sign-in expired; start again');
        }
        const signed = await external().finish(target, { state, code, error: providerError, callbackUrl });
        return { allowed: true, token: signed.token, errorCode: '', message: '' };
      },
      (error) => ({ allowed: false, token: '', ...error })
    ),
  };
}
