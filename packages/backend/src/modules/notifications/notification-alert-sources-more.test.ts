import { describe, expect, it, vi } from 'vitest';
import {
  beginPlannedPortChange,
  endPlannedPortChange,
  recordedRelayState,
} from '@/services/relay-planned-port-changes.js';
import { AlertSourceMonitor } from './notification-alert-sources.js';
import { CATEGORY_MAP, catalogMismatch } from './notification-catalog.js';
import { extractMetricFromDatabaseSnapshot } from './notification-metrics.js';
import { assertAlertRuleAccess } from './notification-rule-access.js';

/** A query chain that resolves to rows at whichever step the caller awaits. */
function rowsOf<T>(rows: T[]) {
  const done = Promise.resolve(rows);
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    // biome-ignore lint/suspicious/noThenProperty: a fake drizzle query is awaited like the real one
    then: (resolve: (value: T[]) => unknown, reject: (error: unknown) => unknown) => done.then(resolve, reject),
  };
  return chain;
}

/** A db whose queries answer the given row lists in order. */
function fakeDb(...answers: unknown[][]) {
  let call = 0;
  const next = () => rowsOf(answers[call++] ?? []);
  return { select: next, selectDistinctOn: next } as never;
}

function evaluatorFor(category: string) {
  const observed: Array<{ state: string; id: string; pattern: string; details: unknown }> = [];
  const evaluator = {
    hasEnabledRules: vi.fn(async (c: string) => c === category),
    enabledRuleScopes: vi.fn(async () => null),
    observeStatefulEvent: vi.fn(async (_c: string, state: string, resource: { id: string }, details, patterns) => {
      observed.push({ state, id: resource.id, pattern: (patterns as string[])[0]!, details });
    }),
    evaluateMetricSnapshots: vi.fn(async (_category: string, _snapshots: unknown, _period: number) => undefined),
    evaluateContainerMetric: vi.fn(),
    emitEvent: vi.fn(async (_category: string, _eventId: string, _resource: unknown, _context?: unknown) => undefined),
  };
  return { evaluator, observed };
}

const base = {
  dispatch: { isNodeConnected: () => false, requestTrafficStats: vi.fn() },
  registry: { getNodesByType: () => [] },
};

describe('internal PKI expiry', () => {
  it('reads days until expiry of CAs and the certificates they issued, keyed so a CA scope covers them', async () => {
    const now = Date.UTC(2026, 9, 14);
    const { evaluator } = evaluatorFor('pki');
    const db = fakeDb(
      [{ id: 'ca-1', name: 'Root', notAfter: new Date(now + 400 * 86_400_000) }],
      [{ id: 'leaf-1', caId: 'ca-1', name: 'api.internal', notAfter: new Date(now + 9.5 * 86_400_000) }]
    );
    await new AlertSourceMonitor({ db, evaluator: evaluator as never, ...base }).pkiExpiry(now);
    const snapshots = evaluator.evaluateMetricSnapshots.mock.calls[0]![1] as unknown as Array<Record<string, any>>;
    expect(snapshots.map((snapshot) => [snapshot.key, snapshot.metrics.days_until_expiry])).toEqual([
      ['ca-1', 400],
      ['ca-1:leaf-1', 10],
    ]);
    expect(snapshots[1]!.details.ca).toBe('Root');
  });
});

describe('relay pool', () => {
  it('observes offline relays, a degraded pool and a failed update; draining is planned', async () => {
    const { evaluator, observed } = evaluatorFor('relay_pool');
    const db = fakeDb(
      [
        { id: 'r1', poolId: 'system', name: 'relay-a', state: 'ready', health: null },
        { id: 'r2', poolId: 'system', name: 'relay-b', state: 'offline', health: { lastError: 'no answer' } },
        { id: 'r3', poolId: 'system', name: 'relay-c', state: 'draining', health: null },
      ],
      [{ poolId: 'system', state: 'failed', error: 'verify timed out' }]
    );
    await new AlertSourceMonitor({ db, evaluator: evaluator as never, ...base }).relayPool();
    const state = (id: string, pattern: string) => observed.find((o) => o.id === id && o.pattern === pattern)?.state;
    expect(state('r1', 'member.offline')).toBe('member.online');
    expect(state('r2', 'member.offline')).toBe('member.offline');
    expect(state('r3', 'member.offline')).toBe('member.online');
    expect(state('pool:system', 'pool.degraded')).toBe('pool.degraded');
    expect(state('pool:system', 'update.failed')).toBe('update.failed');
    expect(observed.find((o) => o.id === 'pool:system' && o.pattern === 'pool.degraded')?.details).toEqual({
      ready: 1,
      total: 2,
    });
  });
});

// Stand 2.12.6-rc.2, O-10: a relay restarting for a planned port move reports offline; no alert may fire for it.
describe('relay pool alerts around a planned port move', () => {
  async function observeAfterReport(reported: 'offline' | 'error') {
    const { evaluator, observed } = evaluatorFor('relay_pool');
    // control.ts records the reported state through recordedRelayState; the alert source reads what was recorded.
    const db = fakeDb(
      [
        { id: 'r1', poolId: 'system', name: 'relay-a', state: 'ready', health: null },
        {
          id: 'r2',
          poolId: 'system',
          name: 'relay-b',
          state: recordedRelayState('r2', reported),
          health: { lastError: 'connection refused' },
        },
      ],
      []
    );
    await new AlertSourceMonitor({ db, evaluator: evaluator as never, ...base }).relayPool();
    return (id: string, pattern: string) => observed.find((o) => o.id === id && o.pattern === pattern)?.state;
  }

  it('fires neither relay offline nor pool degraded while the relay restarts for its port move', async () => {
    beginPlannedPortChange('r2');
    try {
      for (const reported of ['offline', 'error'] as const) {
        const state = await observeAfterReport(reported);
        expect(state('r2', 'member.offline')).toBe('member.online');
        expect(state('pool:system', 'pool.degraded')).toBe('pool.healthy');
      }
    } finally {
      endPlannedPortChange('r2');
    }
  });

  it('fires both when the relay goes offline outside a port move', async () => {
    const state = await observeAfterReport('offline');
    expect(state('r2', 'member.offline')).toBe('member.offline');
    expect(state('pool:system', 'pool.degraded')).toBe('pool.degraded');
  });
});

describe('inference', () => {
  it('observes provider connection states and the core', async () => {
    const { evaluator, observed } = evaluatorFor('inference');
    const db = fakeDb(
      [
        { id: 'c1', name: 'Work', providerId: 'openai', status: 'reauth_required', reason: 'token revoked' },
        { id: 'c2', name: 'Spare', providerId: 'anthropic', status: 'quota_hot', reason: null },
      ],
      [{ state: 'degraded', health: 'unhealthy', error: 'probe failed' }]
    );
    await new AlertSourceMonitor({ db, evaluator: evaluator as never, ...base }).inference();
    const state = (id: string, pattern: string) => observed.find((o) => o.id === id && o.pattern === pattern)?.state;
    expect(state('c1', 'provider.reauth_required')).toBe('provider.reauth_required');
    expect(state('c1', 'provider.unavailable')).toBe('provider.unavailable.clear');
    expect(state('c2', 'provider.quota_low')).toBe('provider.quota_low');
    expect(state('inference-core', 'core.unhealthy')).toBe('core.unhealthy');
  });
});

describe('Docker Availability', () => {
  it('observes degraded and unavailable workloads and reports finished failovers and failbacks once', async () => {
    const { evaluator, observed } = evaluatorFor('docker_availability');
    const later = new Date(Date.now() + 60_000);
    const db = fakeDb(
      [{ id: 'p1', name: 'shop', containerName: null, kind: 'container', status: 'degraded', error: null }],
      [
        {
          policyId: 'p1',
          type: 'heal',
          status: 'completed',
          error: null,
          completedAt: later,
          name: 'shop',
          containerName: null,
        },
        {
          policyId: 'p1',
          type: 'failback',
          status: 'completed',
          error: null,
          completedAt: later,
          name: 'shop',
          containerName: null,
        },
      ]
    );
    await new AlertSourceMonitor({ db, evaluator: evaluator as never, ...base }).dockerAvailability();
    expect(observed.find((o) => o.pattern === 'policy.degraded')?.state).toBe('policy.degraded');
    expect(observed.find((o) => o.pattern === 'policy.unavailable')?.state).toBe('policy.available');
    expect(evaluator.emitEvent.mock.calls.map((call) => call[1])).toEqual(['failover.completed', 'failback.completed']);
  });
});

describe('new categories in the catalog', () => {
  it('accepts their metrics and events and names the view each needs', () => {
    expect(catalogMismatch({ type: 'threshold', category: 'pki', metric: 'days_until_expiry' })).toBeNull();
    expect(catalogMismatch({ type: 'event', category: 'relay_pool', eventPattern: 'member.offline' })).toBeNull();
    expect(catalogMismatch({ type: 'event', category: 'inference', eventPattern: 'core.unhealthy' })).toBeNull();
    expect(
      catalogMismatch({ type: 'event', category: 'docker_availability', eventPattern: 'failover.completed' })
    ).toBeNull();
    expect(catalogMismatch({ type: 'threshold', category: 'database_redis', metric: 'managed_disk_pct' })).toBeNull();
    for (const category of CATEGORY_MAP.values()) expect(category.viewScopes.length).toBeGreaterThan(0);
  });

  it('derives the managed data disk share', () => {
    const snapshot = { databaseId: 'db', metrics: { managed_disk_used_bytes: 80, managed_disk_total_bytes: 100 } };
    expect(extractMetricFromDatabaseSnapshot('database_postgres', 'managed_disk_pct', snapshot)?.values[0]?.value).toBe(
      80
    );
  });
});

describe('who may create or edit a rule', () => {
  const rule = (category: string, resourceIds: string[] = []) => ({ category, type: 'event', resourceIds });
  const db = fakeDb();

  it('needs the broad view for a rule on every resource', async () => {
    await expect(assertAlertRuleAccess(db, ['proxy:view'], rule('proxy'))).resolves.toBeUndefined();
    await expect(assertAlertRuleAccess(db, ['proxy:view:r1'], rule('proxy'))).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('needs view of each picked resource', async () => {
    await expect(assertAlertRuleAccess(db, ['proxy:view:r1'], rule('proxy', ['r1']))).resolves.toBeUndefined();
    await expect(assertAlertRuleAccess(db, ['proxy:view:r1'], rule('proxy', ['r1', 'r2']))).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('checks app environments against their app', async () => {
    const envId = '11111111-1111-4111-8111-111111111111';
    const appDb = fakeDb([{ id: envId, appId: 'app-1' }]);
    await expect(assertAlertRuleAccess(appDb, ['apps:view:app-1'], rule('app', [envId]))).resolves.toBeUndefined();
    await expect(
      assertAlertRuleAccess(fakeDb([{ id: envId, appId: 'app-1' }]), ['apps:view:app-2'], rule('app', [envId]))
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('needs the broad view for families without per-resource grants', async () => {
    await expect(
      assertAlertRuleAccess(db, ['settings:opfield:view'], rule('relay_pool', ['r1']))
    ).resolves.toBeUndefined();
    await expect(assertAlertRuleAccess(db, [], rule('opfield'))).rejects.toMatchObject({ statusCode: 403 });
  });
});
