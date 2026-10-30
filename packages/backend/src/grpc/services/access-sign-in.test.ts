import 'reflect-metadata';
import * as grpc from '@grpc/grpc-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { AccessSignInExternalService } from '@/modules/access-signin/access-signin-external.service.js';
import {
  AccessSignInFlowService,
  type AccessSignInTarget,
} from '@/modules/access-signin/access-signin-flow.service.js';
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsService,
} from '@/modules/settings/environment-settings.service.js';
import { createAccessSignInHandlers } from './access-sign-in.js';

// The node a call comes from: the test sets it on the fake call instead of a client certificate.
vi.mock('./maintenance-access.js', () => ({
  nginxNodeId: async (call: { nodeId?: string }) => call.nodeId ?? null,
}));

const LIST_ID = '11111111-1111-4111-8111-111111111111';
const NODE_ID = '33333333-3333-4333-8333-333333333333';
const TARGET = { listId: LIST_ID, host: 'app.example.com', clientIp: '203.0.113.9', userAgent: 'test' };

function call<T>(request: T, nodeId: string | undefined = NODE_ID) {
  return { request, nodeId, metadata: new grpc.Metadata() } as unknown as grpc.ServerUnaryCall<T, unknown>;
}

function invoke<T>(handler: (c: never, cb: grpc.sendUnaryData<unknown>) => Promise<void>, request: T, nodeId?: string) {
  return new Promise<{ error: grpc.ServiceError | null; reply: any }>((resolve) => {
    void handler(call(request, nodeId) as never, (error, reply) =>
      resolve({ error: error as grpc.ServiceError | null, reply })
    );
  });
}

class MemoryRedis {
  private readonly sets = new Map<string, number[]>();

  pipeline() {
    const ops: Array<() => number> = [];
    const pipeline = {
      zremrangebyscore: (key: string, _min: number, max: number) => {
        ops.push(() => {
          this.sets.set(
            key,
            (this.sets.get(key) ?? []).filter((score) => score > max)
          );
          return 0;
        });
        return pipeline;
      },
      zcard: (key: string) => {
        ops.push(() => this.sets.get(key)?.length ?? 0);
        return pipeline;
      },
      zadd: (key: string, score: number) => {
        ops.push(() => {
          this.sets.set(key, [...(this.sets.get(key) ?? []), score]);
          return 1;
        });
        return pipeline;
      },
      expire: () => {
        ops.push(() => 1);
        return pipeline;
      },
      exec: async () => ops.map((op) => [null, op()] as [null, number]),
    };
    return pipeline;
  }
}

describe('AccessSignIn gRPC', () => {
  const seen: AccessSignInTarget[] = [];

  beforeEach(() => {
    seen.length = 0;
    container.registerInstance(AccessSignInFlowService, {
      methods: async (target: AccessSignInTarget) => {
        seen.push(target);
        if (target.host !== 'app.example.com') throw new AppError(403, 'ACCESS_DENIED', 'no');
        return [{ key: 'password', label: 'Username', kind: 'password' }];
      },
      signInWithPassword: async (target: AccessSignInTarget, username: string, password: string) => {
        seen.push(target);
        if (username !== 'lena' || password !== 'right') {
          throw new AppError(401, 'ACCESS_SIGN_IN_FAILED', 'Wrong username or password');
        }
        return { token: 'v1.token' };
      },
    } as unknown as AccessSignInFlowService);
    container.registerInstance(AccessSignInExternalService, {
      start: async () => ({ url: 'https://accounts.example.com/auth?state=s', state: 's' }),
    } as unknown as AccessSignInExternalService);
    container.registerInstance(TOKENS.RedisClient, new MemoryRedis());
    const defaults = DEFAULT_ENVIRONMENT_SETTINGS;
    container.registerInstance(EnvironmentSettingsService, {
      getSnapshot: () => ({ ...defaults, rateLimits: { ...defaults.rateLimits, authLoginMaxRequests: 3 } }),
    } as unknown as EnvironmentSettingsService);
  });

  afterEach(() => container.clearInstances());

  it('answers only an enrolled nginx node, for the node it is', async () => {
    const handlers = createAccessSignInHandlers({} as never);
    const anonymous = await invoke(handlers.Context, { target: TARGET }, '');
    expect(anonymous.error?.code).toBe(grpc.status.PERMISSION_DENIED);

    const context = await invoke(handlers.Context, { target: TARGET });
    expect(context.reply).toEqual({ methods: [{ key: 'password', label: 'Username', kind: 'password' }] });
    expect(seen[0]).toMatchObject({ nodeId: NODE_ID, host: 'app.example.com', clientIp: '203.0.113.9' });

    // A host the node does not serve, or a malformed target, offers nothing.
    expect((await invoke(handlers.Context, { target: { ...TARGET, host: 'evil.example.com' } })).reply).toEqual({
      methods: [],
    });
    expect((await invoke(handlers.Context, { target: { ...TARGET, listId: 'nope' } })).reply).toEqual({ methods: [] });
  });

  it('signs in with a password, reports a wrong one and throttles attempts per address and account', async () => {
    const handlers = createAccessSignInHandlers({} as never);
    const attempt = (password: string, clientIp = '203.0.113.9') =>
      invoke(handlers.Password, {
        target: { ...TARGET, clientIp },
        kind: 'password',
        username: 'lena',
        password,
      });

    expect((await attempt('right')).reply).toEqual({ allowed: true, token: 'v1.token', errorCode: '', message: '' });
    expect((await attempt('wrong')).reply).toMatchObject({ allowed: false, errorCode: 'ACCESS_SIGN_IN_FAILED' });
    expect((await attempt('wrong')).reply).toMatchObject({ allowed: false });
    // Fourth attempt from this address: over the budget of three.
    expect((await attempt('right')).reply).toMatchObject({ allowed: false, errorCode: 'ACCESS_RATE_LIMITED' });
    // Another address, same account: the account budget is used up too.
    expect((await attempt('right', '198.51.100.7')).reply).toMatchObject({ errorCode: 'ACCESS_RATE_LIMITED' });

    const badKind = await invoke(handlers.Password, { target: TARGET, kind: 'basic', username: 'lena', password: 'x' });
    expect(badKind.reply).toMatchObject({ allowed: false, errorCode: 'ACCESS_SIGN_IN_FAILED' });
  });

  it('starts a provider sign-in with the route callback', async () => {
    const handlers = createAccessSignInHandlers({} as never);
    const started = await invoke(handlers.StartProvider, {
      target: TARGET,
      methodKey: 'idp:x',
      callbackUrl: 'https://app.example.com/_opfield/access/provider-callback',
    });
    expect(started.reply).toEqual({
      authorizeUrl: 'https://accounts.example.com/auth?state=s',
      state: 's',
      errorCode: '',
      message: '',
    });
  });
});
