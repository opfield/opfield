import { describe, expect, it, vi } from 'vitest';
import { withMemberIngressHealth } from '@/modules/proxy/proxy-group-health.js';
import { HealthCheckJob } from './health-check.job.js';

function setup() {
  const host: any = {
    id: 'route-1',
    enabled: true,
    healthCheckEnabled: true,
    maintenanceEnabled: false,
    healthStatus: 'online',
    healthHistory: [],
    healthCheckInterval: 30,
    healthCheckSlowThreshold: 3,
    lastHealthCheckAt: null,
    upstreamKind: 'proxy',
    secureLinkMigratedAt: null,
    ingressGroupId: null,
    nodeId: null,
    domainNames: ['app.test'],
  };
  const updates: Array<Record<string, unknown>> = [];
  const db: any = {
    query: { proxyHosts: { findMany: async () => [{ ...host }] } },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updates.push(values);
            Object.assign(host, values);
            // The job runs again at once in these tests; the interval gate is not under test.
            host.lastHealthCheckAt = null;
            return [{ id: host.id }];
          },
        }),
      }),
    }),
  };
  const job = new HealthCheckJob(db);
  const checkHost = vi.fn();
  (job as any).checkHost = checkHost;
  const evaluator = { observeStatefulEvent: vi.fn(async () => undefined) };
  job.setEvaluator(evaluator as any);
  const handlers = new Map<string, (payload: unknown) => void>();
  job.setEventBus({
    subscribe: (topic: string, handler: (payload: unknown) => void) => handlers.set(topic, handler),
    publish: vi.fn(),
  } as any);
  return { job, host, updates, checkHost, evaluator, handlers };
}

/** The listing's rule: an online route with an offline or degraded sample in the last 5 minutes is "recovering". */
const recovering = (host: { healthStatus: string; healthHistory: Array<{ ts: string; status: string }> }) =>
  host.healthStatus === 'online' &&
  host.healthHistory.some(
    (entry) =>
      new Date(entry.ts).getTime() >= Date.now() - 5 * 60_000 &&
      (entry.status === 'offline' || entry.status === 'degraded')
  );

describe('route health job: absorbed failures', () => {
  it('stores no offline sample for a failure it keeps the route up through', async () => {
    const t = setup();
    t.checkHost.mockResolvedValueOnce({ status: 'offline' });
    await t.job.run();
    expect(t.updates).toEqual([]);
    expect(t.evaluator.observeStatefulEvent).not.toHaveBeenCalled();

    t.checkHost.mockResolvedValueOnce({ status: 'online', responseMs: 5 });
    await t.job.run();
    expect(t.host.healthStatus).toBe('online');
    expect(t.host.healthHistory.map((entry: { status: string }) => entry.status)).toEqual(['online']);
    // Nothing is left for the 5-minute rule, so the route is not "recovering" once the probe passes.
    expect(recovering(t.host)).toBe(false);
  });

  it('still takes the route offline on the second failure in a row', async () => {
    const t = setup();
    t.checkHost.mockResolvedValue({ status: 'offline' });
    await t.job.run();
    await t.job.run();
    expect(t.host.healthStatus).toBe('offline');
    expect(t.host.healthHistory.map((entry: { status: string }) => entry.status)).toEqual(['offline']);
    expect(t.evaluator.observeStatefulEvent).toHaveBeenCalledWith(
      'proxy',
      'health.offline',
      expect.anything(),
      expect.anything(),
      undefined,
      expect.any(Number)
    );
  });

  it('a relay event without a state does not clear a critical relay', () => {
    const t = setup();
    const emit = t.handlers.get('system.relay.health.changed')!;
    emit({ state: 'critical' });
    emit({ reason: 'rebalance' });
    expect((t.job as any).relayUnavailable).toBe(true);
    emit({ state: 'healthy' });
    expect((t.job as any).relayUnavailable).toBe(false);
  });
});

// A local relay restart drops every node's control stream at once (O-b): a route must not go offline or degraded
// because its ingress members are reconnecting.
describe('route health job: ingress members that reconnect', () => {
  it('records no sample while every member is expected back, and still judges one that is gone', async () => {
    const reconnecting = new Set(['ingress-1']);
    const dispatch = { isNodeConnected: () => false, isNodeReconnecting: (id: string) => reconnecting.has(id) };
    const job = new HealthCheckJob({} as never, dispatch as never);
    // Past the startup grace, which defers every probe of a node that is not connected.
    (job as any).startedAt = Date.now() - 10 * 60_000;
    const host = { id: 'route-1', upstreamKind: 'pages', ingressGroupId: 'group-1', nodeId: null };
    const check = (members: string[]) => (job as any).checkHost(host, undefined, members);

    expect((await check(['ingress-1'])).status).toBe('deferred');
    expect((await check(['ingress-1', 'ingress-2'])).status).toBe('offline');
  });

  it('keeps a route probed from Opfield online while its members reconnect', () => {
    const member = (nodeId: string, extra: { connected: boolean; reconnecting?: boolean }) => ({
      nodeId,
      serving: null,
      ...extra,
    });
    expect(withMemberIngressHealth('online', [member('ingress-1', { connected: false, reconnecting: true })])).toEqual(
      expect.objectContaining({ status: 'deferred' })
    );
    expect(
      withMemberIngressHealth('online', [
        member('ingress-1', { connected: false, reconnecting: true }),
        member('ingress-2', { connected: true }),
      ]).status
    ).toBe('online');
    expect(withMemberIngressHealth('online', [member('ingress-1', { connected: false })]).status).toBe('offline');
  });
});

// After a local relay outage, relayed routes' streams move back between relays and their endpoints register again:
// a probe through them is slow or fails for a moment (stand rc.6 O-7: a route went degraded on one slow probe 6 s
// after the relay served again, and its alert stayed two minutes).
describe('route health job: relayed routes while the local relay settles', () => {
  const relayed = (t: ReturnType<typeof setup>) => {
    // No availability members: the route's own Secure Link is probed.
    (t.job as any).db.query.proxyAdditionalSecureLinks = { findMany: async () => [] };
    Object.assign(t.host, {
      upstreamKind: 'docker_deployment',
      secureLinkMigratedAt: new Date(Date.now() - 86_400_000),
      nodeId: 'ingress-1',
      healthHistory: Array.from({ length: 6 }, (_, index) => ({
        ts: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
        status: 'online',
        responseMs: 10,
      })),
    });
  };

  it('does not judge a relayed route slow within the reconnect grace, and does after it', async () => {
    const t = setup();
    relayed(t);
    const outage = { since: Date.now() - 30_000, servingAgainAt: Date.now() - 6_000, planned: false };
    t.job.setLocalRelayOutage({ latestOutage: () => outage });
    t.checkHost.mockResolvedValue({ status: 'online', responseMs: 300 });
    await t.job.run();
    expect(t.host.healthStatus).toBe('online');
    expect(t.host.healthHistory.at(-1)).not.toHaveProperty('slow');
    expect(t.evaluator.observeStatefulEvent).not.toHaveBeenCalledWith(
      'proxy',
      'health.degraded',
      expect.anything(),
      expect.anything(),
      undefined,
      expect.any(Number)
    );
    // The grace is over: a slow answer is the route's own again.
    outage.servingAgainAt = Date.now() - 3 * 60_000;
    await t.job.run();
    expect(t.host.healthStatus).toBe('degraded');
  });

  it('does not judge a relayed route slow while a Relay Pool update moves its streams, nor within the grace after (stand rc.7, F-3)', async () => {
    const t = setup();
    relayed(t);
    let run: { state: string; completedAt: Date | null } = { state: 'draining', completedAt: null };
    (t.job as any).db.select = () => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [run] }) }) }),
    });
    t.checkHost.mockResolvedValue({ status: 'online', responseMs: 300 });
    await t.job.run();
    expect(t.host.healthStatus).toBe('online');
    expect(t.host.healthHistory.at(-1)).not.toHaveProperty('slow');
    run = { state: 'complete', completedAt: new Date(Date.now() - 30_000) };
    await t.job.run();
    expect(t.host.healthStatus).toBe('online');
    // Two minutes after the update: a slow answer is the route's own again.
    run = { state: 'complete', completedAt: new Date(Date.now() - 3 * 60_000) };
    await t.job.run();
    expect(t.host.healthStatus).toBe('degraded');
  });

  it('defers a relayed probe that fails within the reconnect grace and judges it after', async () => {
    let outage = { since: Date.now() - 30_000, servingAgainAt: (Date.now() - 6_000) as number | null, planned: false };
    const dispatch = {
      isNodeConnected: () => true,
      probeProxySecureLink: vi.fn(async () => ({ ok: false, error: 'relay tunnel error: endpoint_unavailable' })),
    };
    const job = new HealthCheckJob({} as never, dispatch as never);
    (job as any).startedAt = Date.now() - 10 * 60_000;
    job.setLocalRelayOutage({ latestOutage: () => outage });
    const host = {
      id: 'route-1',
      upstreamKind: 'docker_deployment',
      secureLinkMigratedAt: new Date(),
      nodeId: 'ingress-1',
      domainNames: ['orders.test'],
    };
    expect((await (job as any).checkHostOnNode(host, 'ingress-1')).status).toBe('deferred');
    // Still restarting: deferred as well.
    outage = { ...outage, servingAgainAt: null };
    expect((await (job as any).checkHostOnNode(host, 'ingress-1')).status).toBe('deferred');
    outage = { ...outage, servingAgainAt: Date.now() - 3 * 60_000 };
    expect((await (job as any).checkHostOnNode(host, 'ingress-1')).status).toBe('offline');
  });
});

describe('route health job: probes Opfield sends itself', () => {
  const offlineContext = async (deps: ConstructorParameters<typeof HealthCheckJob>[2]) => {
    const t = setup();
    Object.assign(t.host, { forwardHost: 'app.pages.dev', forwardPort: 443, forwardScheme: 'https' });
    const job = new HealthCheckJob((t.job as any).db, undefined, deps);
    job.setEvaluator(t.evaluator as any);
    await job.run();
    await job.run();
    return (t.evaluator.observeStatefulEvent.mock.calls as unknown[][]).at(-1)?.[3];
  };

  it('marks an offline sample whose probe got no answer, so its alert can fold under an Opfield outbound loss', async () => {
    const context = await offlineContext({
      checkTarget: async (url) => ({ url, resolvedAddresses: [], allowed: false, reason: 'did not resolve' }),
    });
    expect(context).toEqual({ health_status: 'offline', probe_failure: 'unreachable' });
  });

  it('does not mark an offline sample whose upstream answered', async () => {
    const context = await offlineContext({
      checkTarget: async (url) => ({ url, resolvedAddresses: ['203.0.113.7'], allowed: true }),
      request: async () => ({ status: 503, text: async () => '' }),
    });
    expect(context).toEqual({ health_status: 'offline' });
  });
});

/**
 * A probe its node never answered because the node was updating (stand rc.12 F-2: a batch update replaced ingress-1's
 * stream with two Secure Link probes in flight) is deferred and logged at debug, not a warning; one that fails on a
 * node that is not away still warns.
 */
describe('route health job: probes of a node that updates', () => {
  const host = {
    id: 'route-1',
    upstreamKind: 'docker_deployment',
    secureLinkMigratedAt: new Date(),
    nodeId: 'ingress-1',
    domainNames: ['docs.test'],
  };
  const jobFailingWith = (error: string, updating = false) => {
    const dispatch = {
      isNodeConnected: () => true,
      isNodeReconnecting: () => false,
      isNodeUpdateInProgress: async () => updating,
      probeProxySecureLink: vi.fn(async () => {
        throw new Error(error);
      }),
    };
    const job = new HealthCheckJob({} as never, dispatch as never);
    (job as any).startedAt = Date.now() - 10 * 60_000;
    return job;
  };

  it('defers a probe lost with its node stream, and one that timed out while the node updates', async () => {
    const { logger } = await import('@/lib/logger.js');
    const warn = vi.spyOn(logger, 'warn');
    try {
      const lost = jobFailingWith('Node disconnected');
      expect((await (lost as any).checkHostOnNode(host, 'ingress-1')).status).toBe('deferred');
      const timedOut = jobFailingWith('Command d1761f61 timed out after 15000ms', true);
      expect((await (timedOut as any).checkHostOnNode(host, 'ingress-1')).status).toBe('deferred');
      expect(warn).not.toHaveBeenCalledWith('Secure Link health probe failed', expect.anything());

      const stillThere = jobFailingWith('Command d1761f61 timed out after 15000ms');
      expect((await (stillThere as any).checkHostOnNode(host, 'ingress-1')).status).toBe('offline');
    } finally {
      warn.mockRestore();
    }
  });
});
