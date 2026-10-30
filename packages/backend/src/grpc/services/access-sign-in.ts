import { createHash } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { consumeAccessSignInRateLimit } from '@/middleware/rate-limit.js';
import { AccessSignInExternalService } from '@/modules/access-signin/access-signin-external.service.js';
import {
  AccessSignInFlowService,
  type AccessSignInTarget,
} from '@/modules/access-signin/access-signin-flow.service.js';
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

/** A per-account counter name: the list and the username, hashed (the username is not kept in Redis). */
function accountSubject(listId: string, kind: string, username: string): string {
  const account = kind === 'shared' ? 'shared' : username.trim().toLowerCase();
  return `account:${createHash('sha256').update(`${listId}\n${account}`).digest('hex').slice(0, 32)}`;
}

/**
 * opfield.v1.AccessSignIn: the sign-in page an nginx daemon serves on a protected route (/_opfield/access/ of that
 * route) checks credentials and runs provider sign-ins here. Only an enrolled nginx node may ask, and only for a list
 * and host it serves (AccessSignInFlowService.resolveTarget); the visitor never reaches Opfield.
 */
export function createAccessSignInHandlers(deps: GrpcServerDeps) {
  const flow = () => container.resolve(AccessSignInFlowService);
  const external = () => container.resolve(AccessSignInExternalService);

  function handler<Req extends { target?: AccessSignInTargetMessage }, Res>(
    name: string,
    run: (request: Req, target: AccessSignInTarget) => Promise<Res>,
    refuse: (error: { errorCode: string; message: string }) => Res
  ): Unary<Req, Res> {
    return async (call, callback) => {
      try {
        const nodeId = await nginxNodeId(call, deps);
        if (!nodeId) return callback({ code: grpc.status.PERMISSION_DENIED, message: 'Enrolled nginx node required' });
        const target = targetOf(call.request.target, nodeId);
        if (!target) return callback(null, refuse(refused()));
        callback(null, await run(call.request, target));
      } catch (error) {
        const expected = failure(error);
        if (expected) return callback(null, refuse(expected));
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
      // A list or host this node does not serve offers nothing.
      () => ({ methods: [] })
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
        // Per visitor address and per account, with the console login budget.
        await consumeAccessSignInRateLimit([
          `ip:${target.clientIp || 'unknown'}`,
          accountSubject(target.listId, kind, username),
        ]);
        const signed =
          kind === 'password'
            ? await flow().signInWithPassword(target, username, password)
            : await flow().signInWithSharedPassword(target, password);
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
