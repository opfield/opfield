import { createHash, randomUUID } from 'node:crypto';
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

function getPipelineCount(results: unknown): number {
  if (!Array.isArray(results)) {
    throw rateLimitUnavailable(new Error('Redis pipeline returned no results'));
  }
  if (results.length !== RATE_LIMIT_PIPELINE_RESULT_COUNT) {
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

export function createRateLimiter(config: RateLimitConfig): MiddlewareHandler<AppEnv> {
  const { windowMs, maxRequests, keyPrefix = 'ratelimit' } = config;

  return async (c, next) => {
    const subject = config.key ? await config.key(c) : (await getClientIpForContext(c)) || 'unknown';

    const key = `${keyPrefix}:${subject}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    try {
      const redis = container.resolve<RedisClient>(TOKENS.RedisClient);
      const pipeline = redis.pipeline();
      pipeline.zremrangebyscore(key, 0, windowStart);
      pipeline.zcard(key);
      pipeline.zadd(key, now, `${now}-${randomUUID()}`);
      pipeline.expire(key, Math.ceil(windowMs / 1000));

      const results = await withRateLimitRedisTimeout(pipeline.exec());
      const requestCount = getPipelineCount(results);

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
