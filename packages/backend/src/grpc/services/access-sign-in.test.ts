import 'reflect-metadata';
import * as grpc from '@grpc/grpc-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { rateLimitAddress } from '@/middleware/rate-limit.js';
import { AccessSignInExternalService } from '@/modules/access-signin/access-signin-external.service.js';
import {
  AccessSignInFlowService,
  type AccessSignInTarget,
} from '@/modules/access-signin/access-signin-flow.service.js';
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsService,
} from '@/modules/settings/environment-settings.service.js';
import { createAccessSignInHandlers, KeyedSlots } from './access-sign-in.js';

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
  let limits: Partial<typeof DEFAULT_ENVIRONMENT_SETTINGS.rateLimits> = {};

  beforeEach(() => {
    seen.length = 0;
    limits = { authLoginMaxRequests: 3 };
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
      signInWithSharedPassword: async (target: AccessSignInTarget, password: string) => {
        seen.push(target);
        if (password !== 'shared') throw new AppError(401, 'ACCESS_SIGN_IN_FAILED', 'Wrong password');
        return { token: 'v1.shared' };
      },
    } as unknown as AccessSignInFlowService);
    container.registerInstance(AccessSignInExternalService, {
      start: async () => ({ url: 'https://accounts.example.com/auth?state=s', state: 's' }),
    } as unknown as AccessSignInExternalService);
    container.registerInstance(TOKENS.RedisClient, new MemoryRedis());
    const defaults = DEFAULT_ENVIRONMENT_SETTINGS;
    container.registerInstance(EnvironmentSettingsService, {
      getSnapshot: () => ({ ...defaults, rateLimits: { ...defaults.rateLimits, ...limits } }),
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

  it('signs in with a password and refuses a client over its failure budget, counting failures only', async () => {
    const handlers = createAccessSignInHandlers({} as never);
    const attempt = (password: string, clientIp = '203.0.113.9', username = 'lena') =>
      invoke(handlers.Password, { target: { ...TARGET, clientIp }, kind: 'password', username, password });

    // Successes never use the budget up.
    for (let i = 0; i < 5; i++) {
      expect((await attempt('right')).reply).toEqual({ allowed: true, token: 'v1.token', errorCode: '', message: '' });
    }
    expect((await attempt('wrong')).reply).toMatchObject({ allowed: false, errorCode: 'ACCESS_SIGN_IN_FAILED' });
    expect((await attempt('wrong', '203.0.113.9', 'other')).reply).toMatchObject({ allowed: false });
    expect((await attempt('wrong')).reply).toMatchObject({ allowed: false });
    // Fourth attempt from this address, whatever the username: over the budget of three failures.
    expect((await attempt('right', '203.0.113.9', 'anyone')).reply).toMatchObject({
      allowed: false,
      errorCode: 'ACCESS_RATE_LIMITED',
    });

    const badKind = await invoke(handlers.Password, { target: TARGET, kind: 'basic', username: 'lena', password: 'x' });
    expect(badKind.reply).toMatchObject({ allowed: false, errorCode: 'ACCESS_SIGN_IN_FAILED' });
  });

  it('never locks a user or a shared password out from another address, it only slows attempts down', async () => {
    const handlers = createAccessSignInHandlers({} as never);
    const password = (value: string, clientIp: string) =>
      invoke(handlers.Password, {
        target: { ...TARGET, clientIp },
        kind: 'password',
        username: 'lena',
        password: value,
      });
    const shared = (value: string, clientIp: string) =>
      invoke(handlers.Password, { target: { ...TARGET, clientIp }, kind: 'shared', username: '', password: value });

    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) await password('wrong', ip);
    for (let i = 0; i < 3; i++) await shared('wrong', '198.51.100.4');
    expect((await shared('shared', '198.51.100.4')).reply).toMatchObject({ errorCode: 'ACCESS_RATE_LIMITED' });

    // The account is over its ceiling: another address still signs in, after a short wait.
    const started = Date.now();
    expect((await password('right', '192.0.2.50')).reply).toMatchObject({ allowed: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect((await shared('shared', '192.0.2.51')).reply).toMatchObject({ allowed: true, token: 'v1.shared' });
  });

  it('counts an IPv6 client by its /64', async () => {
    const handlers = createAccessSignInHandlers({} as never);
    const shared = (value: string, clientIp: string) =>
      invoke(handlers.Password, { target: { ...TARGET, clientIp }, kind: 'shared', username: '', password: value });
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:aaaa::3']) await shared('wrong', ip);
    expect((await shared('shared', '2001:db8:1:2:ffff:ffff:ffff:ffff')).reply).toMatchObject({
      errorCode: 'ACCESS_RATE_LIMITED',
    });
    expect((await shared('shared', '2001:db8:1:3::1')).reply).toMatchObject({ allowed: true });
  });

  it('limits every RPC a visitor triggers per client address', async () => {
    limits = { authMaxRequests: 2 };
    const handlers = createAccessSignInHandlers({} as never);
    const start = (clientIp: string) =>
      invoke(handlers.StartProvider, {
        target: { ...TARGET, clientIp },
        methodKey: 'idp:x',
        callbackUrl: 'https://app.example.com/_opfield/access/provider-callback',
      });
    expect((await invoke(handlers.Context, { target: TARGET })).reply.methods).toHaveLength(1);
    expect((await start(TARGET.clientIp)).reply).toMatchObject({ state: 's' });
    // Over the budget: the page gets no methods (the call fails), a provider start is refused.
    expect((await invoke(handlers.Context, { target: TARGET })).error?.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
    expect((await start(TARGET.clientIp)).reply).toMatchObject({ authorizeUrl: '', errorCode: 'ACCESS_RATE_LIMITED' });
    const finish = await invoke(handlers.FinishProvider, {
      target: TARGET,
      state: 's',
      code: 'c',
      error: '',
      callbackUrl: 'https://app.example.com/_opfield/access/provider-callback',
    });
    expect(finish.reply).toMatchObject({ allowed: false, errorCode: 'ACCESS_RATE_LIMITED' });
    // Another client is not affected.
    expect((await start('198.51.100.9')).reply).toMatchObject({ state: 's' });
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

describe('rateLimitAddress', () => {
  it('keeps IPv4, buckets IPv6 by /64 and unmaps IPv4-mapped addresses', () => {
    expect(rateLimitAddress('203.0.113.9')).toBe('203.0.113.9');
    expect(rateLimitAddress('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitAddress('2001:0DB8:0001:0002:ffff:1:2:3')).toBe('2001:db8:1:2::/64');
    expect(rateLimitAddress('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitAddress('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(rateLimitAddress('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(rateLimitAddress('64:ff9b::198.51.100.7')).toBe('64:ff9b:0:0::/64');
    expect(rateLimitAddress('')).toBe('unknown');
  });
});

describe('KeyedSlots', () => {
  it('runs at most the slot count per key and refuses a run that waits too long', async () => {
    const slots = new KeyedSlots(1, 50);
    let release!: () => void;
    const first = slots.run('a', () => new Promise<string>((resolve) => (release = () => resolve('first'))));
    const second = slots.run('a', async () => 'second');
    const other = await slots.run('b', async () => 'other');
    expect(other).toBe('other');
    release();
    expect(await first).toBe('first');
    expect(await second).toBe('second');

    const blocked = slots.run('a', () => new Promise<void>((resolve) => setTimeout(resolve, 200)));
    await expect(slots.run('a', async () => 'late')).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    await blocked;
    expect(await slots.run('a', async () => 'free')).toBe('free');
  });
});
