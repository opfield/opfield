import { describe, expect, it } from 'vitest';
import { ManagedRedisConfigSchema, UpdateManagedDatabaseSchema } from './databases.schemas.js';

const redisConfig = {
  maxmemoryPercent: 75,
  maxmemoryPolicy: 'noeviction',
  appendOnly: true,
  appendFsync: 'everysec',
  rdbSnapshotsEnabled: true,
  rdbSaveSeconds: 3600,
  rdbSaveChanges: 1,
  autoAofRewritePercentage: 100,
  autoAofRewriteMinSizeMb: 64,
  maxclients: 10_000,
  timeoutSeconds: 0,
  tcpKeepaliveSeconds: 300,
  slowlogThresholdMicroseconds: 10_000,
  slowlogMaxLen: 128,
  activeDefrag: false,
};

describe('key-value store AOF rewrite percentage', () => {
  it.each([1, 50, 100, 10_000])('keeps %s', (autoAofRewritePercentage) => {
    const parsed = ManagedRedisConfigSchema.parse({ ...redisConfig, autoAofRewritePercentage });
    expect(parsed.autoAofRewritePercentage).toBe(autoAofRewritePercentage);
  });

  it('reads 0 from older clients as the default 100, never as rewrite off', () => {
    expect(
      ManagedRedisConfigSchema.parse({ ...redisConfig, autoAofRewritePercentage: 0 }).autoAofRewritePercentage
    ).toBe(100);
    const update = UpdateManagedDatabaseSchema.parse({ redisConfig: { ...redisConfig, autoAofRewritePercentage: 0 } });
    expect(update.redisConfig?.autoAofRewritePercentage).toBe(100);
  });

  it.each([-1, 10_001, 1.5, '100'])('refuses %s', (autoAofRewritePercentage) => {
    expect(ManagedRedisConfigSchema.safeParse({ ...redisConfig, autoAofRewritePercentage }).success).toBe(false);
  });
});
