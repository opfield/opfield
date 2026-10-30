import { createHash, randomUUID } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { Context, MiddlewareHandler } from 'hono';
import { container, TOKENS } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { withRateLimitRedisTimeout } from '@/lib/rate-limit-timeout.js';
import { getClientIpForContext } from '@/lib/request-ip.js';
import { AppError } from '@/middleware/error-handler.js';
import type { EnvironmentSettings } from '@/modules/settings/environment-settings.schemas.js';
import { getEnvironmentSettingsSnapshot } from '@/modules/settings/environment-settings.service.js';
import type { RedisClient } from '@/services/cache.service.js';
import type { AppEnv } from '@/types.js';

const logger = createChildLogger('RateLimit');
const RATE_LIMIT_PIPELINE_RESULT_COUNT = 4;
const PEEK_PIPELINE_RESULT_COUNT = 2;

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
  /** What the requests are counted per; the client IP by default. */
  key?: (c: Context<AppEnv>) => Promise<string>;
}

type RateLimitSelector = (settings: EnvironmentSettings['rateLimits']) => number;

function rateLimitUnavailable(error?: unknown): AppError {
  logger.warn('Rate limiter unavailable', {
    error: error instanceof Error ? error.message : error == null ? undefined : String(error),
  });
  return new AppError(503, 'RATE_LIMIT_UNAVAILABLE', 'Opfield is temporarily unavailable');
}

function getPipelineCount(results: unknown, expected = RATE_LIMIT_PIPELINE_RESULT_COUNT): number {
  if (!Array.isArray(results)) {
    throw rateLimitUnavailable(new Error('Redis pipeline returned no results'));
  }
  if (results.length !== expected) {
    throw rateLimitUnavailable(new Error('Redis pipeline returned incomplete results'));
  }

  for (const result of results) {
    if (!Array.isArray(result) || result.length < 2) {
      throw rateLimitUnavailable(new Error('Redis pipeline returned malformed result'));
    }
    const [error] = result;
    if (error) {
      throw rateLimitUnavailable(error);
    }
  }

  const count = results[1]?.[1];
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw rateLimitUnavailable(new Error('Redis pipeline returned invalid request count'));
  }

  return count;
}

/** Counts one request of `subject` in the sliding window and returns how many came before it in the window. */
async function countRequest(key: string, windowMs: number, now: number): Promise<number> {
  const redis = container.resolve<RedisClient>(TOKENS.RedisClient);
  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, now - windowMs);
  pipeline.zcard(key);
  pipeline.zadd(key, now, `${now}-${randomUUID()}`);
  pipeline.expire(key, Math.ceil(windowMs / 1000));
  return getPipelineCount(await withRateLimitRedisTimeout(pipeline.exec()));
}

/** How many requests of the key are in the sliding window, without counting one. */
async function peekRequests(key: string, windowMs: number, now: number): Promise<number> {
  const redis = container.resolve<RedisClient>(TOKENS.RedisClient);
  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, now - windowMs);
  pipeline.zcard(key);
  return getPipelineCount(await withRateLimitRedisTimeout(pipeline.exec()), PEEK_PIPELINE_RESULT_COUNT);
}

async function inRedis<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw rateLimitUnavailable(error);
  }
}

/**
 * The same sliding window outside an HTTP request (a daemon asking on a visitor's behalf): throws RATE_LIMIT_EXCEEDED
 * when any subject is over the environment's budget, else counts one request of each. A refused request is not
 * counted, so a client that keeps going is let in again once its window has passed.
 */
export async function consumeRateLimit(
  keyPrefix: string,
  subjects: string[],
  maxRequests: RateLimitSelector
): Promise<void> {
  const settings = getEnvironmentSettingsSnapshot().rateLimits;
  const limit = maxRequests(settings);
  const now = Date.now();
  const counts = await peekRateLimit(keyPrefix, subjects, now);
  if (counts.some((count) => count >= limit)) {
    throw new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests, please try again later');
  }
  await recordRateLimit(keyPrefix, subjects, now);
}

/** How many requests of each subject are in the environment's window (nothing is counted). */
export function peekRateLimit(keyPrefix: string, subjects: string[], now = Date.now()): Promise<number[]> {
  const { windowMs } = getEnvironmentSettingsSnapshot().rateLimits;
  return inRedis(() => Promise.all(subjects.map((subject) => peekRequests(`${keyPrefix}:${subject}`, windowMs, now))));
}

/** Counts one request of each subject in the environment's window. */
export async function recordRateLimit(keyPrefix: string, subjects: string[], now = Date.now()): Promise<void> {
  const { windowMs } = getEnvironmentSettingsSnapshot().rateLimits;
  await inRedis(() => Promise.all(subjects.map((subject) => countRequest(`${keyPrefix}:${subject}`, windowMs, now))));
}

/**
 * The counter name of a client address: an IPv4 address as is, an IPv6 address by its /64 (one subscriber's
 * network; every address in it is the same client), an IPv4-mapped IPv6 address as its IPv4 address.
 */
export function rateLimitAddress(address: string): string {
  const value = address.trim().replace(/%.*$/, '');
  if (!value) return 'unknown';
  if (isIPv4(value)) return value;
  if (!isIPv6(value)) return value.toLowerCase();
  const groups = ipv6Groups(value);
  if (!groups) return value.toLowerCase();
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address (with `::` and a dotted IPv4 tail expanded). */
function ipv6Groups(address: string): number[] | null {
  let value = address.toLowerCase();
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (isIPv4(tail)) {
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    value = `${value.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const groups = parts.map((part) => Number.parseInt(part, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

export function createRateLimiter(config: RateLimitConfig): MiddlewareHandler<AppEnv> {
  const { windowMs, maxRequests, keyPrefix = 'ratelimit' } = config;

  return async (c, next) => {
    const subject = config.key ? await config.key(c) : (await getClientIpForContext(c)) || 'unknown';

    const key = `${keyPrefix}:${subject}`;
    const now = Date.now();

    try {
      const requestCount = await countRequest(key, windowMs, now);

      c.res.headers.set('X-RateLimit-Limit', String(maxRequests));
      c.res.headers.set('X-RateLimit-Remaining', String(Math.max(0, maxRequests - requestCount - 1)));
      c.res.headers.set('X-RateLimit-Reset', String(Math.ceil((now + windowMs) / 1000)));

      if (requestCount >= maxRequests) {
        throw new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests, please try again later');
      }

      await next();
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw rateLimitUnavailable(error);
    }
  };
}

function createEnvironmentRateLimiter(keyPrefix: string, maxRequests: RateLimitSelector): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const settings = getEnvironmentSettingsSnapshot().rateLimits;
    return createRateLimiter({ windowMs: settings.windowMs, maxRequests: maxRequests(settings), keyPrefix })(c, next);
  };
}

export const rateLimitMiddleware = createEnvironmentRateLimiter('ratelimit:api', (settings) => settings.maxRequests);

/**
 * The general API limit. A request of a signed-in browser session counts against that session's own budget
 * (`sessionMaxRequests`), so the UI's page loads do not share one budget with every script and browser behind the
 * same IP (stand rc.7, O-21). Anything else (API and OAuth tokens, no or an invalid session) counts per client IP
 * against `maxRequests`, as before. `sessionOf` returns the session ID only for a live session.
 */
export function createApiRateLimitMiddleware(
  sessionOf: (c: Context<AppEnv>) => Promise<string | null>
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const settings = getEnvironmentSettingsSnapshot().rateLimits;
    let sessionId: string | null = null;
    try {
      sessionId = await sessionOf(c);
    } catch (error) {
      logger.debug('Session lookup for the API rate limit failed; counting per client', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!sessionId) return rateLimitMiddleware(c, next);
    // The session ID is a credential: only its hash names the counter.
    const subject = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
    return createRateLimiter({
      windowMs: settings.windowMs,
      maxRequests: settings.sessionMaxRequests,
      keyPrefix: 'ratelimit:api:session',
      key: async () => subject,
    })(c, next);
  };
}

export const authRateLimitMiddleware = createEnvironmentRateLimiter(
  'ratelimit:auth',
  (settings) => settings.authMaxRequests
);

export const authLoginRateLimitMiddleware = createEnvironmentRateLimiter(
  'ratelimit:auth:login',
  (settings) => settings.authLoginMaxRequests
);

export const authCallbackRateLimitMiddleware = createEnvironmentRateLimiter(
  'ratelimit:auth:callback',
  (settings) => settings.authCallbackMaxRequests
);

export const setupRateLimitMiddleware = createEnvironmentRateLimiter(
  'ratelimit:setup',
  (settings) => settings.setupMaxRequests
);

export const publicStatusRateLimitMiddleware = createEnvironmentRateLimiter(
  'ratelimit:public:status-page',
  (settings) => settings.publicStatusMaxRequests
);

export const publicWebhookRateLimitMiddleware = createEnvironmentRateLimiter(
  'ratelimit:public:webhook',
  (settings) => settings.publicWebhookMaxRequests
);

export const pkiRateLimitMiddleware = createEnvironmentRateLimiter(
  'ratelimit:pki',
  (settings) => settings.pkiMaxRequests
);

export const streamRateLimitMiddleware = createEnvironmentRateLimiter(
  'ratelimit:stream',
  (settings) => settings.streamMaxRequests
);

export const aiWebSocketRateLimitMiddleware = createEnvironmentRateLimiter(
  'ratelimit:ai:ws',
  (settings) => settings.aiWebSocketMaxRequests
);
