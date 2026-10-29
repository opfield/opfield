import { Redis } from 'ioredis';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { firstShutdownReport, isShuttingDown } from '@/services/shutdown-state.js';

const logger = createChildLogger('CacheService');

const TAKE_VALUE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value then return false end
redis.call('DEL', KEYS[1])
return value
`;

// Rewrites a key only while it still exists, so a writer that read it before a concurrent DEL cannot bring it back.
// ARGV[2] > 0 sets a new TTL in seconds; otherwise the key keeps its remaining TTL.
const SET_IF_EXISTS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local ttl = tonumber(ARGV[2])
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
else
  redis.call('SET', KEYS[1], ARGV[1], 'KEEPTTL')
end
return 1
`;

export type RedisClient = Redis;

export function createRedisClient(url: string): RedisClient {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    lazyConnect: true,
  });

  redis.on('connect', () => {
    logger.info('Connected to Redis');
  });

  redis.on('error', (error: Error) => {
    if (isShuttingDown()) {
      // Redis stops with the app at a host shutdown (N-19): expected, logged once.
      if (firstShutdownReport('redis'))
        logger.info('Redis connection closed while Opfield shuts down', { error: error.message });
      return;
    }
    logger.error('Redis connection error', { error: error.message });
  });

  redis.on('close', () => {
    if (isShuttingDown()) return;
    logger.warn('Redis connection closed');
  });

  redis.connect().catch((err: Error) => {
    logger.error('Failed to connect to Redis', { error: err.message });
  });

  return redis;
}

@injectable()
export class CacheService {
  private readonly redis: RedisClient;

  constructor(@inject(TOKENS.RedisClient) redis: RedisClient) {
    this.redis = redis;
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key);
    return this.deserialize<T>(value);
  }

  async take<T>(key: string): Promise<T | null> {
    const value = await this.redis.eval(TAKE_VALUE_SCRIPT, 1, key);
    return this.deserialize<T>(typeof value === 'string' ? value : null);
  }

  private deserialize<T>(value: string | null): T | null {
    if (!value) return null;

    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);

    if (ttlSeconds) {
      await this.redis.setex(key, ttlSeconds, serialized);
    } else {
      await this.redis.set(key, serialized);
    }
  }

  async setIfAbsent<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const result = await this.redis.set(key, serialized, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  /**
   * Writes `value` only when `key` still exists (atomically): with `ttlSeconds` the key gets that TTL, without it the
   * key keeps the TTL it has. False when the key was gone and nothing was written.
   */
  async setIfExists<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const result = await this.redis.eval(SET_IF_EXISTS_SCRIPT, 1, key, serialized, ttlSeconds ?? 0);
    return Number(result) === 1;
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async deletePattern(pattern: string): Promise<void> {
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.redis.exists(key);
    return result === 1;
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(key, ttlSeconds);
  }

  async ttl(key: string): Promise<number> {
    return this.redis.ttl(key);
  }

  async incr(key: string): Promise<number> {
    return this.redis.incr(key);
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    return this.redis.sadd(key, ...members);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return this.redis.srem(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return this.redis.smembers(key);
  }

  async publish(channel: string, message: string): Promise<number> {
    return this.redis.publish(channel, message);
  }

  getClient(): RedisClient {
    return this.redis;
  }
}
