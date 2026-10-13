import { describe, expect, it, vi } from 'vitest';
import { AlertSourceMonitor, restartReading, restartsInLastHour } from './notification-alert-sources.js';
import { CATEGORY_MAP, catalogMismatch } from './notification-catalog.js';
import { extractMetricFromDatabaseSnapshot, routeTrafficMetrics } from './notification-metrics.js';
import { defaultResolveMessage } from './notification-resolve-messages.js';

const traffic = (total: number, s5xx: number, s4xx = 0, rps = total / 60, p95 = 0.25) => ({
  totalRequests: total,
  statusCodes: { s2xx: total - s5xx - s4xx, s3xx: 0, s4xx, s5xx },
  requestsPerSecond: rps,
  p95ResponseTime: p95,
});

describe('route alert metrics', () => {
  it('lets the owner build "5xx share >= 10% for 1 min" on routes', () => {
    const metric = CATEGORY_MAP.get('proxy')!.metrics.find((item) => item.id === 'error_5xx_percent');
    expect(metric).toMatchObject({ unit: '%', defaultOperator: '>=', defaultValue: 10, defaultDurationSeconds: 60 });
    expect(catalogMismatch({ type: 'threshold', category: 'proxy', metric: 'error_5xx_percent' })).toBeNull();
  });

  it('computes shares, rate and p95 over every node serving the route', () => {
    const metrics = routeTrafficMetrics([traffic(60, 6, 3, 1, 0.2), traffic(40, 6, 0, 0.5, 0.9)]);
    expect(metrics.error_5xx_percent).toBeCloseTo(12);
    expect(metrics.error_4xx_percent).toBeCloseTo(3);
    expect(metrics.requests_per_second).toBeCloseTo(1.5);
    expect(metrics.latency_p95_ms).toBeCloseTo(900);
    expect(metrics.requests).toBe(100);
    expect(metrics.errors_5xx).toBe(12);
  });

  it('counts a share as 0 below 10 requests and no traffic as no latency', () => {
    expect(routeTrafficMetrics([traffic(5, 5)]).error_5xx_percent).toBe(0);
    expect(routeTrafficMetrics([]).latency_p95_ms).toBe(0);
    expect(routeTrafficMetrics([]).error_5xx_percent).toBe(0);
  });
});

describe('alert rule catalog check', () => {
  it('refuses metrics and events the category does not have', () => {
    expect(catalogMismatch({ type: 'threshold', category: 'proxy', metric: 'cpu' })).toMatch(/no metric cpu/);
    expect(catalogMismatch({ type: 'threshold', category: 'domain', metric: 'x' })).toMatch(/no metrics/);
    expect(catalogMismatch({ type: 'event', category: 'app', eventPattern: 'offline' })).toMatch(/no event offline/);
    expect(catalogMismatch({ type: 'event', category: 'app', eventPattern: 'kill_switch.on' })).toBeNull();
    expect(catalogMismatch({ type: 'threshold', category: 'container', metric: 'restarts_per_hour' })).toBeNull();
  });

  it('keeps category ids within the 20 characters the rule column holds', () => {
    for (const id of CATEGORY_MAP.keys()) expect(id.length).toBeLessThanOrEqual(20);
  });

  it('names what each category scope picks', () => {
    for (const category of CATEGORY_MAP.values()) expect(category.resourceLabel).toMatch(/^[A-Za-z]/);
  });
});

describe('container restarts per hour', () => {
  it('reads RestartCount and the runtime from a cached inspect', () => {
    expect(restartReading({ Id: 'abc', RestartCount: 4 })).toEqual({ runtimeId: 'abc', restartCount: 4 });
    expect(restartReading({ Id: 'abc' })).toBeNull();
  });

  it('counts restarts of the current runtime within the last hour', () => {
    const now = 10 * 60 * 60 * 1000;
    const readings = [
      { at: now - 2 * 60 * 60 * 1000, runtimeId: 'a', restartCount: 0 },
      { at: now - 50 * 60 * 1000, runtimeId: 'a', restartCount: 2 },
      { at: now, runtimeId: 'a', restartCount: 7 },
    ];
    expect(restartsInLastHour(readings, now)).toBe(5);
    // A recreate starts the count over.
    expect(restartsInLastHour([...readings, { at: now, runtimeId: 'b', restartCount: 0 }], now)).toBe(0);
  });
});

describe('managed database metrics', () => {
  it('derives container memory as a share of its limit', () => {
    const snapshot = {
      databaseId: 'db',
      metrics: { managed_memory_usage_bytes: 450, managed_memory_limit_bytes: 500 },
    };
    expect(extractMetricFromDatabaseSnapshot('database_postgres', 'managed_memory_pct', snapshot)).toEqual({
      values: [{ resourceId: 'db', value: 90 }],
    });
    expect(
      extractMetricFromDatabaseSnapshot('database_postgres', 'managed_memory_pct', { databaseId: 'db', metrics: {} })
    ).toBeNull();
  });
});

describe('resolve texts of the new alerts', () => {
  it('names the recovery', () => {
    expect(
      defaultResolveMessage(
        { name: 'r', type: 'event', category: 'app', eventPattern: 'kill_switch.on' },
        'Shop · prod'
      )
    ).toBe('The kill switch of Shop · prod is off.');
    expect(
      defaultResolveMessage(
        { name: 'r', type: 'threshold', category: 'proxy', metric: 'error_5xx_percent' },
        'a.example',
        {
          metric: { value: 2 },
          fired: { duration: 125 },
        }
      )
    ).toBe('5xx Responses on a.example is back to normal at 2% after 2m 5s.');
    expect(
      defaultResolveMessage(
        { name: 'r', type: 'threshold', category: 'backup', metric: 'hours_since_last_backup' },
        'db'
      )
    ).toBe('A backup of db succeeded.');
  });
});

describe('app environment states', () => {
  it('observes health, kill switch, shutdown and maintenance per environment, with the Apps list health', async () => {
    const observed: Array<[string, string, string]> = [];
    const evaluator = {
      hasEnabledRules: vi.fn(async (category: string, type?: string) => category === 'app' && type === 'event'),
      enabledRuleScopes: vi.fn(async () => null),
      observeStatefulEvent: vi.fn(async (_category: string, state: string, resource: { id: string }, _c, patterns) => {
        observed.push([resource.id, (patterns as string[])[0]!, state]);
      }),
      evaluateMetricSnapshots: vi.fn(),
      evaluateContainerMetric: vi.fn(),
    };
    const envs = [
      { id: 'e1', appId: 'a1', name: 'prod', appName: 'Shop', maintenanceEnabled: false, maintenanceOverride: false },
      { id: 'e2', appId: 'a1', name: 'stage', appName: 'Shop', maintenanceEnabled: true, maintenanceOverride: false },
    ];
    const incidents = [{ environmentId: 'e1', kind: 'isolation' }];
    // Environments are read with a join, open incidents with a filter.
    const db = { select: () => ({ from: () => ({ innerJoin: async () => envs, where: async () => incidents }) }) };
    const summarizeEnvironments = vi.fn(
      async () =>
        new Map([
          ['e1', { health: 'failing', failing: 1, degraded: 0 }],
          ['e2', { health: 'unknown', failing: 0, degraded: 0 }],
        ])
    );
    const monitor = new AlertSourceMonitor({
      db: db as never,
      evaluator: evaluator as never,
      dispatch: { isNodeConnected: () => false, requestTrafficStats: vi.fn() },
      registry: { getNodesByType: () => [] },
      appHealth: () => ({ summarizeEnvironments }),
    });
    await monitor.appStates();
    expect(summarizeEnvironments).toHaveBeenCalledWith(expect.arrayContaining(['proxy:view']), ['e1', 'e2']);
    const state = (key: string, pattern: string) => observed.find(([id, p]) => id === key && p === pattern)?.[2];
    expect(state('a1:e1', 'health.failing')).toBe('health.failing');
    expect(state('a1:e1', 'health.degraded')).toBe('health.degraded');
    expect(state('a1:e1', 'health.healthy')).toBe('health.unhealthy');
    expect(state('a1:e1', 'kill_switch.on')).toBe('kill_switch.on');
    expect(state('a1:e2', 'health.healthy')).toBe('health.healthy');
    expect(state('a1:e2', 'maintenance.active')).toBe('maintenance.active');
    expect(state('a1:e2', 'kill_switch.on')).toBe('kill_switch.off');
  });
});

describe('a route rule "5xx share >= 10% for 1 min" through the evaluator', () => {
  it('fires after a minute of breaching samples and resolves after a minute of clear ones', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 14, 12, 0) });
    try {
      const { NotificationEvaluatorService } = await import('./notification-evaluator.service.js');
      // Redis that fails: alert windows are kept in memory, as during a Redis outage.
      const failing = () => Promise.reject(new Error('down'));
      const redis = { zadd: failing, zrevrangebyscore: failing, zrangebyscore: failing, set: failing, del: failing };
      const service = new NotificationEvaluatorService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { getClient: () => redis } as never,
        {} as never
      );
      const internals = service as any;
      internals.getThresholdRules = async () => [
        {
          id: 'r5xx',
          type: 'threshold',
          category: 'proxy',
          metric: 'error_5xx_percent',
          operator: '>=',
          thresholdValue: 10,
          durationSeconds: 60,
          fireThresholdPercent: 100,
          resolveAfterSeconds: 60,
          resolveThresholdPercent: 100,
          resourceIds: [],
        },
      ];
      const firing = new Map<string, { id: string; firedAt: Date }>();
      const fired = vi.fn(async (_rule: unknown, _type: string, key: string, _name: string) => {
        firing.set(key, { id: `s-${key}`, firedAt: new Date() });
      });
      const resolved = vi.fn(async (_id: string, _rule: unknown, _type: string, key: string) => {
        firing.delete(key);
      });
      internals.getActiveAlertState = async (_rule: string, _type: string, key: string) => firing.get(key) ?? null;
      internals.fireAlert = fired;
      internals.resolveAlert = resolved;
      const sample = (share: number) =>
        service.evaluateMetricSnapshots(
          'proxy',
          [{ key: 'route-1', id: 'route-1', name: 'a.example', metrics: { error_5xx_percent: share } }],
          30_000
        );

      await sample(12);
      vi.advanceTimersByTime(30_000);
      await sample(15);
      expect(fired).not.toHaveBeenCalled();
      vi.advanceTimersByTime(30_000);
      await sample(11);
      expect(fired).toHaveBeenCalledTimes(1);
      expect(fired.mock.calls[0]![2]).toBe('route-1');
      expect(fired.mock.calls[0]![3]).toBe('a.example');

      vi.advanceTimersByTime(30_000);
      await sample(1);
      expect(resolved).not.toHaveBeenCalled();
      vi.advanceTimersByTime(30_000);
      await sample(0);
      vi.advanceTimersByTime(30_000);
      await sample(0);
      expect(resolved).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
