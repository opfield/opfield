import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '@/db/schema/settings.js';
import { HousekeepingService } from './housekeeping.service.js';

describe('HousekeepingService system certificate cleanup', () => {
  it('cleans only obsolete unused Opfield connector images on online Docker nodes', async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: 'node-1' }]) })),
      })),
    };
    const dockerService = {
      inspectSelf: vi.fn().mockResolvedValue({
        Config: { Image: 'the-square-labs/gateway:v2.10.0-rc.8', Labels: {} },
      }),
    };
    const service = new HousekeepingService(
      db as any,
      dockerService as any,
      {} as any,
      {
        SECURE_LINK_CONNECTOR_IMAGE: 'the-square-labs/gateway/secure-link-connector@sha256:current',
      } as any
    );
    vi.spyOn(service as any, 'dockerRequest').mockResolvedValue({ statusCode: 200, body: '[]' });
    const dockerManagement = {
      listAllImages: vi.fn().mockResolvedValue([
        {
          Id: 'current',
          RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:current'],
          Created: 3,
          Containers: 0,
          Size: 10,
        },
        {
          Id: 'rollback',
          RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:rollback'],
          Created: 2,
          Containers: 0,
          Size: 20,
        },
        {
          Id: 'obsolete',
          RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:obsolete'],
          Created: 1,
          Containers: 0,
          Size: 30,
        },
        { Id: 'user', RepoTags: ['acme/api:old'], Created: 0, Containers: 0, Size: 40 },
      ]),
      removeOpfieldInternalImage: vi.fn().mockResolvedValue(undefined),
    };
    service.setDockerManagementService(dockerManagement as any);

    await expect((service as any).pruneDockerImages()).resolves.toEqual({
      itemsCleaned: 1,
      spaceFreedBytes: 30,
    });
    expect(dockerManagement.removeOpfieldInternalImage).toHaveBeenCalledWith('node-1', 'obsolete');
  });

  it('still cleans managed-node connector images when local Docker inspection is unavailable', async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: 'node-1' }]) })),
      })),
    };
    const service = new HousekeepingService(
      db as any,
      { inspectSelf: vi.fn().mockRejectedValue(new Error('socket unavailable')) } as any,
      {} as any,
      { SECURE_LINK_CONNECTOR_IMAGE: 'connector@sha256:current' } as any
    );
    const dockerManagement = {
      listAllImages: vi.fn().mockResolvedValue([
        {
          Id: 'rollback',
          RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:rollback'],
          Created: 2,
          Containers: 0,
          Size: 20,
        },
        {
          Id: 'obsolete',
          RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:obsolete'],
          Created: 1,
          Containers: 0,
          Size: 30,
        },
      ]),
      removeOpfieldInternalImage: vi.fn().mockResolvedValue(undefined),
    };
    service.setDockerManagementService(dockerManagement as any);

    await expect((service as any).pruneDockerImages()).resolves.toEqual({
      itemsCleaned: 1,
      spaceFreedBytes: 30,
    });
  });

  it('enables every available housekeeping category by default', async () => {
    const where = vi.fn().mockResolvedValue([{ key: 'logging:clickhouse', value: { mode: 'local' } }]);
    const service = new HousekeepingService(
      {
        select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
      } as any,
      {} as any,
      {} as any,
      {} as any
    );

    await expect(service.getConfig()).resolves.toMatchObject({
      enabled: true,
      nginxLogs: { enabled: true },
      auditLog: { enabled: true },
      dismissedAlerts: { enabled: true },
      deliveryLog: { enabled: true },
      structuredLogs: { enabled: true },
      clickHouseInternals: { enabled: true },
      orphanedAIArtifacts: { enabled: true },
      internalRegistry: { enabled: true, retentionSuccessfulArtifacts: 1 },
      orphanedVolumes: { enabled: true },
      dockerPrune: { enabled: true },
      orphanedCerts: { enabled: true },
      acmeCleanup: { enabled: true },
      operationHistory: { enabled: true, retentionDays: 90 },
      oauthCleanup: { enabled: true },
      expiredTokens: { enabled: true, retentionDays: 7 },
    });
  });

  it('prunes Docker tasks, old operation history and expired OAuth grants when enabled', async () => {
    const deleted: string[] = [];
    const db = {
      execute: vi.fn(async (statement: any) => {
        const text = new PgDialect().sqlToQuery(statement).sql;
        const match = /^DELETE FROM "([a-z_]+)"/.exec(text);
        if (!match) return { rows: [], rowCount: 0 };
        deleted.push(match[1]!);
        return { rowCount: 1 };
      }),
    };
    const service = new HousekeepingService(db as any, {} as any, {} as any, {} as any);
    const cleanup = vi.fn().mockResolvedValue(4);
    service.setDockerTaskService({ cleanup });
    vi.spyOn(service, 'getConfig').mockResolvedValue({
      enabled: true,
      cronExpression: '0 2 * * *',
      nginxLogs: { enabled: false, retentionDays: 30 },
      auditLog: { enabled: false, retentionDays: 90 },
      dismissedAlerts: { enabled: false, retentionDays: 30 },
      deliveryLog: { enabled: false, retentionDays: 7 },
      structuredLogs: { enabled: false, maxRows: 100_000, maxSizeBytes: 10 * 1024 ** 3 },
      clickHouseInternals: { enabled: false, maxSizeBytes: 512 * 1024 ** 2 },
      orphanedAIArtifacts: { enabled: false },
      internalRegistry: { enabled: true, retentionSuccessfulArtifacts: 1 },
      orphanedVolumes: { enabled: false, retentionDays: 30 },
      dockerPrune: { enabled: false },
      orphanedCerts: { enabled: false },
      acmeCleanup: { enabled: false },
      operationHistory: { enabled: true, retentionDays: 60 },
      oauthCleanup: { enabled: true },
      expiredTokens: { enabled: false, retentionDays: 7 },
    });
    vi.spyOn(service as any, 'saveRunResult').mockResolvedValue(undefined);

    const result = await service.runAll('scheduled');

    expect(cleanup).toHaveBeenCalledOnce();
    expect(deleted).toEqual(
      expect.arrayContaining(['docker_compose_operations', 'hosting_operations', 'oauth_clients'])
    );
    expect(result.categories).toEqual([
      expect.objectContaining({ category: 'Operation History', success: true, itemsCleaned: 4 + 4 }),
      expect.objectContaining({ category: 'Expired OAuth Grants', success: true, itemsCleaned: 4 }),
    ]);
  });

  it('normalizes persisted registry history retention to one artifact per source', async () => {
    const where = vi.fn().mockResolvedValue([
      { key: 'logging:clickhouse', value: { mode: 'local' } },
      { key: 'housekeeping:internal_registry:retention_successful_artifacts', value: 10 },
    ]);
    const service = new HousekeepingService(
      {
        select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
      } as any,
      {} as any,
      {} as any,
      {} as any
    );

    await expect(service.getConfig()).resolves.toMatchObject({
      internalRegistry: { enabled: true, retentionSuccessfulArtifacts: 1 },
    });
  });

  it('keeps ClickHouse internal-log cleanup off by default for external storage', async () => {
    const where = vi.fn().mockResolvedValue([{ key: 'logging:clickhouse', value: { mode: 'external' } }]);
    const service = new HousekeepingService(
      {
        select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
      } as any,
      {} as any,
      {} as any,
      {} as any
    );

    await expect(service.getConfig()).resolves.toMatchObject({
      structuredLogs: { enabled: true },
      clickHouseInternals: { enabled: false },
      orphanedVolumes: { enabled: true },
    });
  });

  it('limits returned run history to the persisted history cap', async () => {
    const history = Array.from({ length: 25 }, (_, index) => ({ startedAt: `run-${index}` }));
    const limit = vi.fn().mockResolvedValue([{ value: history }]);
    const where = vi.fn(() => ({ limit }));
    const service = new HousekeepingService(
      {
        select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
      } as any,
      {} as any,
      {} as any,
      {} as any
    );

    const result = await service.getRunHistory();

    expect(result).toHaveLength(20);
    expect(result.at(-1)).toEqual({ startedAt: 'run-19' });
  });

  it('uses the fixed 30-day lifecycle key-retention policy', async () => {
    const service = new HousekeepingService({} as any, {} as any, {} as any, {} as any);
    const destroyRetiredPrivateKeys = vi.fn().mockResolvedValue(3);
    service.setSystemCertificateLifecycleService({ destroyRetiredPrivateKeys } as any);

    await expect((service as any).cleanOrphanedCerts()).resolves.toEqual({ itemsCleaned: 3 });
    expect(destroyRetiredPrivateKeys).toHaveBeenCalledWith(30);
  });

  it('runs enabled ClickHouse internal-log cleanup during a manual run', async () => {
    const service = new HousekeepingService({} as any, {} as any, {} as any, {} as any);
    const cleanupInternalLogsAndRefresh = vi.fn().mockResolvedValue({ itemsCleaned: 42, spaceFreedBytes: 1024 });
    service.setLoggingMaintenanceService({ cleanupInternalLogsAndRefresh } as any);
    vi.spyOn(service, 'getConfig').mockResolvedValue({
      enabled: true,
      cronExpression: '0 2 * * *',
      nginxLogs: { enabled: false, retentionDays: 30 },
      auditLog: { enabled: false, retentionDays: 90 },
      dismissedAlerts: { enabled: false, retentionDays: 30 },
      deliveryLog: { enabled: false, retentionDays: 7 },
      structuredLogs: { enabled: false, maxRows: 100_000, maxSizeBytes: 10 * 1024 ** 3 },
      clickHouseInternals: { enabled: true, maxSizeBytes: 512 * 1024 ** 2 },
      orphanedAIArtifacts: { enabled: false },
      internalRegistry: { enabled: true, retentionSuccessfulArtifacts: 3 },
      orphanedVolumes: { enabled: false, retentionDays: 30 },
      dockerPrune: { enabled: false },
      orphanedCerts: { enabled: false },
      acmeCleanup: { enabled: false },
      operationHistory: { enabled: false, retentionDays: 90 },
      oauthCleanup: { enabled: false },
      expiredTokens: { enabled: false, retentionDays: 7 },
    });
    vi.spyOn(service as any, 'saveRunResult').mockResolvedValue(undefined);

    const result = await service.runAll('manual');

    expect(cleanupInternalLogsAndRefresh).toHaveBeenCalledWith(undefined, {
      enabled: true,
      maxSizeBytes: 512 * 1024 ** 2,
    });
    expect(result.categories).toEqual([
      expect.objectContaining({
        category: 'ClickHouse Internals',
        success: true,
        itemsCleaned: 42,
        spaceFreedBytes: 1024,
      }),
    ]);
  });

  it('runs Pages maintenance as a first-class housekeeping category', async () => {
    const service = new HousekeepingService({} as any, {} as any, {} as any, {} as any);
    const run = vi.fn().mockResolvedValue({ itemsCleaned: 2, spaceFreedBytes: 4096 });
    service.setPagesMaintenanceService({ run });
    vi.spyOn(service, 'getConfig').mockResolvedValue({
      enabled: true,
      cronExpression: '0 2 * * *',
      nginxLogs: { enabled: false, retentionDays: 30 },
      auditLog: { enabled: false, retentionDays: 90 },
      dismissedAlerts: { enabled: false, retentionDays: 30 },
      deliveryLog: { enabled: false, retentionDays: 7 },
      structuredLogs: { enabled: false, maxRows: 100_000, maxSizeBytes: 10 * 1024 ** 3 },
      clickHouseInternals: { enabled: false, maxSizeBytes: 512 * 1024 ** 2 },
      orphanedAIArtifacts: { enabled: false },
      internalRegistry: { enabled: true, retentionSuccessfulArtifacts: 3 },
      orphanedVolumes: { enabled: false, retentionDays: 30 },
      dockerPrune: { enabled: false },
      orphanedCerts: { enabled: false },
      acmeCleanup: { enabled: false },
      operationHistory: { enabled: false, retentionDays: 90 },
      oauthCleanup: { enabled: false },
      expiredTokens: { enabled: false, retentionDays: 7 },
    });
    vi.spyOn(service as any, 'saveRunResult').mockResolvedValue(undefined);

    const result = await service.runAll('manual');

    expect(run).toHaveBeenCalledOnce();
    expect(result.categories).toEqual([
      expect.objectContaining({ category: 'Pages', itemsCleaned: 2, spaceFreedBytes: 4096 }),
    ]);
  });

  it('always runs internal registry GC with the configured retention count', async () => {
    const service = new HousekeepingService({} as any, {} as any, {} as any, {} as any);
    const runGarbageCollection = vi.fn().mockResolvedValue({
      progress: { candidateArtifactIds: ['artifact-1', 'artifact-2'] },
    });
    service.setInternalRegistryMaintenanceService({ runGarbageCollection } as any);
    vi.spyOn(service, 'getConfig').mockResolvedValue({
      enabled: true,
      cronExpression: '0 2 * * *',
      nginxLogs: { enabled: false, retentionDays: 30 },
      auditLog: { enabled: false, retentionDays: 90 },
      dismissedAlerts: { enabled: false, retentionDays: 30 },
      deliveryLog: { enabled: false, retentionDays: 7 },
      structuredLogs: { enabled: false, maxRows: 100_000, maxSizeBytes: 10 * 1024 ** 3 },
      clickHouseInternals: { enabled: false, maxSizeBytes: 512 * 1024 ** 2 },
      orphanedAIArtifacts: { enabled: false },
      internalRegistry: { enabled: true, retentionSuccessfulArtifacts: 5 },
      orphanedVolumes: { enabled: false, retentionDays: 30 },
      dockerPrune: { enabled: false },
      orphanedCerts: { enabled: false },
      acmeCleanup: { enabled: false },
      operationHistory: { enabled: false, retentionDays: 90 },
      oauthCleanup: { enabled: false },
      expiredTokens: { enabled: false, retentionDays: 7 },
    });
    vi.spyOn(service as any, 'saveRunResult').mockResolvedValue(undefined);

    const result = await service.runAll('manual', 'user-1');

    expect(runGarbageCollection).toHaveBeenCalledWith({
      requestedById: 'user-1',
      reason: 'housekeeping run by a user',
    });
    expect(result.categories).toEqual([
      expect.objectContaining({ category: 'Internal Registry', success: true, itemsCleaned: 2 }),
    ]);
  });
});

describe('HousekeepingService orphaned volume retention', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const T0 = new Date('2026-09-01T02:00:00.000Z');
  const UNUSED_SINCE_KEY = 'housekeeping:orphaned_volumes:unused_since';
  const VOLUME_A = 'a'.repeat(64);
  const VOLUME_B = 'b'.repeat(64);
  const daysAgo = (days: number) => new Date(T0.getTime() - days * DAY_MS).toISOString();
  const at = (days: number) => vi.setSystemTime(new Date(T0.getTime() + days * DAY_MS));
  const volume = (name: string, overrides: Record<string, unknown> = {}) => ({
    Name: name,
    CreatedAt: daysAgo(60),
    Labels: {},
    UsedBy: [],
    UsageData: { Size: 2048 },
    ...overrides,
  });

  function createHarness(options: {
    onlineNodeIds?: string[];
    volumes: Record<string, unknown>;
    unusedSince?: unknown;
  }) {
    const stored = new Map<string, unknown>();
    if (options.unusedSince !== undefined) stored.set(UNUSED_SINCE_KEY, options.unusedSince);
    const persist = vi.fn(async (key: string, value: unknown) => {
      stored.set(key, JSON.parse(JSON.stringify(value)));
    });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) =>
          table === settings
            ? {
                where: vi.fn(() => ({
                  limit: vi.fn(async () =>
                    stored.has(UNUSED_SINCE_KEY) ? [{ key: UNUSED_SINCE_KEY, value: stored.get(UNUSED_SINCE_KEY) }] : []
                  ),
                })),
              }
            : { where: vi.fn(async () => (options.onlineNodeIds ?? ['node-1']).map((id) => ({ id }))) }
        ),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((row: { key: string; value: unknown }) => ({
          onConflictDoUpdate: vi.fn(() => persist(row.key, row.value)),
        })),
      })),
    };
    const dockerManagement = {
      listHousekeepingVolumes: vi.fn(async (nodeId: string) => {
        const result = options.volumes[nodeId];
        if (result instanceof Error) throw result;
        return result;
      }),
      removeOrphanedAnonymousVolume: vi.fn().mockResolvedValue(undefined),
    };
    const service = new HousekeepingService(db as any, {} as any, {} as any, {} as any);
    service.setDockerManagementService(dockerManagement as any);
    return {
      service,
      dockerManagement,
      persist,
      state: () => stored.get(UNUSED_SINCE_KEY),
      clean: (retentionDays = 30) => (service as any).cleanOrphanedVolumes(retentionDays, 'user-1'),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not remove an old anonymous volume the first time it is seen unused', async () => {
    const h = createHarness({ volumes: { 'node-1': [volume(VOLUME_A, { CreatedAt: daysAgo(365) })] } });

    await expect(h.clean()).resolves.toEqual({ itemsCleaned: 0, spaceFreedBytes: 0 });

    expect(h.dockerManagement.removeOrphanedAnonymousVolume).not.toHaveBeenCalled();
    expect(h.state()).toEqual({ 'node-1': { [VOLUME_A]: T0.toISOString() } });
  });

  it('removes a volume only after it has been continuously unused for the full retention', async () => {
    const h = createHarness({ volumes: { 'node-1': [volume(VOLUME_A)] } });

    await h.clean();
    at(29);
    await h.clean();
    expect(h.dockerManagement.removeOrphanedAnonymousVolume).not.toHaveBeenCalled();

    at(30);
    await expect(h.clean()).resolves.toEqual({ itemsCleaned: 1, spaceFreedBytes: 2048 });
    expect(h.dockerManagement.removeOrphanedAnonymousVolume).toHaveBeenCalledTimes(1);
    expect(h.dockerManagement.removeOrphanedAnonymousVolume).toHaveBeenCalledWith('node-1', VOLUME_A, 'user-1');
  });

  it('restarts the clock when an unused volume is attached again', async () => {
    const volumes: Record<string, unknown> = { 'node-1': [volume(VOLUME_A, { UsedBy: ['postgres'] })] };
    const h = createHarness({ volumes, unusedSince: { 'node-1': { [VOLUME_A]: daysAgo(40) } } });

    await h.clean();
    expect(h.dockerManagement.removeOrphanedAnonymousVolume).not.toHaveBeenCalled();
    expect(h.state()).toEqual({});

    at(1);
    volumes['node-1'] = [volume(VOLUME_A)];
    await h.clean();
    at(30);
    await h.clean();
    expect(h.dockerManagement.removeOrphanedAnonymousVolume).not.toHaveBeenCalled();
    expect(h.state()).toEqual({ 'node-1': { [VOLUME_A]: new Date(T0.getTime() + DAY_MS).toISOString() } });

    at(31);
    await h.clean();
    expect(h.dockerManagement.removeOrphanedAnonymousVolume).toHaveBeenCalledWith('node-1', VOLUME_A, 'user-1');
  });

  it('keeps tracking for nodes that are offline or fail to list volumes', async () => {
    const unusedSince = {
      'node-1': { [VOLUME_A]: daysAgo(40) },
      'node-2': { [VOLUME_A]: daysAgo(40) },
      'node-3': { [VOLUME_B]: daysAgo(40) },
      'node-offline': { [VOLUME_A]: daysAgo(40) },
    };
    const h = createHarness({
      onlineNodeIds: ['node-1', 'node-2', 'node-3'],
      volumes: { 'node-1': new Error('node unreachable'), 'node-2': { error: 'bad reply' }, 'node-3': [] },
      unusedSince,
    });

    await h.clean();

    expect(h.dockerManagement.removeOrphanedAnonymousVolume).not.toHaveBeenCalled();
    expect(h.state()).toEqual({
      'node-1': unusedSince['node-1'],
      'node-2': unusedSince['node-2'],
      'node-offline': unusedSince['node-offline'],
    });
  });

  it('keeps the existing filters for named, in-use and protected volumes', async () => {
    const h = createHarness({
      volumes: {
        'node-1': [
          volume('pgdata'),
          volume(VOLUME_A, { UsedBy: [], usedByCount: 1 }),
          volume(VOLUME_B, { Labels: { 'opfield.housekeeping.protected': 'true' } }),
        ],
      },
      unusedSince: { 'node-1': { pgdata: daysAgo(90), [VOLUME_A]: daysAgo(90), [VOLUME_B]: daysAgo(90) } },
    });

    await h.clean();

    expect(h.dockerManagement.removeOrphanedAnonymousVolume).not.toHaveBeenCalled();
    expect(h.state()).toEqual({});
  });

  // legacy-name: volumes protected before 2.12.1 carry gateway.housekeeping.protected.
  it('keeps volumes protected with the earlier label', async () => {
    const h = createHarness({
      volumes: {
        'node-1': [
          volume('pgdata'),
          volume(VOLUME_A, { UsedBy: [], usedByCount: 1 }),
          volume(VOLUME_B, { Labels: { 'gateway.housekeeping.protected': 'true' } }),
        ],
      },
      unusedSince: { 'node-1': { pgdata: daysAgo(90), [VOLUME_A]: daysAgo(90), [VOLUME_B]: daysAgo(90) } },
    });

    await h.clean();

    expect(h.dockerManagement.removeOrphanedAnonymousVolume).not.toHaveBeenCalled();
    expect(h.state()).toEqual({});
  });

  it('removes nothing when the tracking state cannot be saved, and does not resurrect cleared records', async () => {
    const volumes: Record<string, unknown> = {
      'node-1': [volume(VOLUME_A), volume(VOLUME_B, { UsedBy: ['postgres'] })],
    };
    const h = createHarness({
      volumes,
      unusedSince: { 'node-1': { [VOLUME_A]: daysAgo(40), [VOLUME_B]: daysAgo(40) } },
    });
    h.persist.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(h.clean()).rejects.toThrow('no volumes were removed');
    expect(h.dockerManagement.removeOrphanedAnonymousVolume).not.toHaveBeenCalled();

    volumes['node-1'] = [volume(VOLUME_A), volume(VOLUME_B)];
    await expect(h.clean()).resolves.toEqual({ itemsCleaned: 1, spaceFreedBytes: 2048 });
    expect(h.dockerManagement.removeOrphanedAnonymousVolume).toHaveBeenCalledTimes(1);
    expect(h.dockerManagement.removeOrphanedAnonymousVolume).toHaveBeenCalledWith('node-1', VOLUME_A, 'user-1');
    expect(h.state()).toEqual({ 'node-1': { [VOLUME_A]: daysAgo(40), [VOLUME_B]: T0.toISOString() } });
  });

  it('previews eligible volumes in stats without removing them or failing on a tracking write error', async () => {
    const h = createHarness({
      volumes: { 'node-1': [volume(VOLUME_A), volume(VOLUME_B)] },
      unusedSince: { 'node-1': { [VOLUME_A]: daysAgo(30) } },
    });
    vi.spyOn(h.service, 'getConfig').mockResolvedValue({
      orphanedVolumes: { enabled: true, retentionDays: 30 },
    } as any);
    h.persist.mockRejectedValueOnce(new Error('database unavailable'));

    await expect((h.service as any).getOrphanedVolumeStats()).resolves.toEqual({ count: 1, reclaimableBytes: 2048 });
    expect(h.dockerManagement.removeOrphanedAnonymousVolume).not.toHaveBeenCalled();

    // The unsaved observation of VOLUME_B is kept in memory and persisted by the next scan.
    at(1);
    await (h.service as any).getOrphanedVolumeStats();
    expect(h.state()).toEqual({ 'node-1': { [VOLUME_A]: daysAgo(30), [VOLUME_B]: T0.toISOString() } });
  });
});
