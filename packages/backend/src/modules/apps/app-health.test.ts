import { describe, expect, it } from 'vitest';
import { availabilityMemberHealth } from './app-availability-overview.js';
import { assessEnvironment, memberSignalKey } from './app-environment-health.js';
import {
  applyCrossMemberRules,
  certificateState,
  combineHealth,
  composeHealth,
  composeState,
  containerHealth,
  containerState,
  deploymentHealth,
  deploymentState,
  healthFromStatus,
  type MemberStatus,
  oomKilledOf,
  pagesState,
  recentRestartsOf,
  withAvailabilityState,
  workloadKey,
} from './app-health.service.js';
import type { AppMember } from './app-members.service.js';

describe('app health aggregation', () => {
  it('combines member states: failing beats degraded beats healthy, empty is healthy', () => {
    expect(combineHealth([])).toBe('healthy');
    expect(combineHealth(['healthy', 'none'])).toBe('healthy');
    expect(combineHealth(['healthy', 'degraded'])).toBe('degraded');
    expect(combineHealth(['degraded', 'failing', 'healthy'])).toBe('failing');
    expect(combineHealth(['healthy', 'stopped'])).toBe('healthy');
  });

  it.each([
    ['online', 'healthy'],
    ['degraded', 'degraded'],
    ['offline', 'failing'],
    ['unknown', 'none'],
    ['disabled', 'none'],
  ] as const)('route/database/storage %s -> %s', (status, health) => {
    expect(healthFromStatus(status)).toBe(health);
  });

  it.each([
    ['running', null, 'healthy'],
    ['running', 'offline', 'failing'],
    ['running', 'degraded', 'degraded'],
    // A restart loop, a dead or missing container fail.
    ['restarting', null, 'failing'],
    ['dead', null, 'failing'],
    [null, null, 'failing'],
    ['created', null, 'stopped'],
    ['paused', null, 'degraded'],
  ] as const)('container %s with check %s -> %s', (state, check, health) => {
    expect(containerHealth(state, check)).toBe(health);
  });

  it.each([
    // Stopped on request: a clean exit, SIGINT, SIGTERM, or SIGKILL (stop timeout, docker kill) without an OOM kill.
    ['Exited (0) 2 minutes ago', null, 'stopped'],
    ['Exited (143) 2 minutes ago', null, 'stopped'],
    ['Exited (130) 1 second ago', null, 'stopped'],
    ['Exited (137) 5 seconds ago', false, 'stopped'],
    // Crashed: another code, an OOM kill, or 137 whose OOM flag is unknown.
    ['Exited (1) 5 seconds ago', null, 'failing'],
    ['Exited (139) 5 seconds ago', false, 'failing'],
    ['Exited (137) 5 seconds ago', true, 'failing'],
    ['Exited (137) 5 seconds ago', null, 'failing'],
    ['Exited (0) 5 seconds ago', true, 'failing'],
    ['', null, 'failing'],
  ] as const)('an exited container (%s, OOM %s) -> %s', (status, oomKilled, health) => {
    expect(containerHealth('exited', 'online', { status, oomKilled })).toBe(health);
  });

  it('reads the OOM flag from a container inspect', () => {
    expect(oomKilledOf(JSON.stringify({ State: { OOMKilled: true } }))).toBe(true);
    expect(oomKilledOf({ State: { OOMKilled: false } })).toBe(false);
    expect(oomKilledOf('{}')).toBe(null);
  });

  it('maps deployments and Compose projects', () => {
    expect(deploymentHealth('ready', null)).toBe('healthy');
    expect(deploymentHealth('ready', 'offline')).toBe('failing');
    expect(deploymentHealth('deploying', null)).toBe('degraded');
    expect(deploymentHealth('stopped', null)).toBe('stopped');
    expect(deploymentHealth('failed', null)).toBe('failing');
    // The active slot's container decides first: stopped on request, or crashed.
    expect(deploymentHealth('ready', 'online', { state: 'exited', status: 'Exited (143) 1 minute ago' })).toBe(
      'stopped'
    );
    expect(deploymentHealth('ready', 'online', { state: 'exited', status: 'Exited (2) 1 minute ago' })).toBe('failing');
    expect(deploymentHealth('ready', null, { state: 'running' })).toBe('healthy');
    expect(composeHealth('running')).toBe('healthy');
    expect(composeHealth('degraded')).toBe('degraded');
    expect(composeHealth('stopped')).toBe('failing');
    expect(composeHealth('stopped', 'stopped')).toBe('stopped');
    expect(composeHealth('failed', 'stopped')).toBe('failing');
  });

  it('maps an availability set: degraded or no failover is degraded, never down while the primary answers', () => {
    expect(withAvailabilityState('healthy', null)).toBe('healthy');
    expect(withAvailabilityState('healthy', 'healthy')).toBe('healthy');
    expect(withAvailabilityState('healthy', 'degraded')).toBe('degraded');
    expect(withAvailabilityState('healthy', 'no_failover')).toBe('degraded');
    expect(withAvailabilityState('failing', 'failing_over')).toBe('degraded');
    expect(withAvailabilityState('failing', 'no_failover')).toBe('failing');
    expect(withAvailabilityState('none', 'degraded')).toBe('none');
  });

  it('reads each set member as healthy, degraded, down or stopped', () => {
    const now = 1_800_000_000_000;
    const seen = new Date(now - 5_000);
    const member = (role: string, eligible: boolean, lastReportedAt: Date | null = seen, stopped = false) => ({
      role,
      eligible,
      lastReportedAt,
      enginePosition: stopped ? { 'runtime.stopped': 'true' } : {},
    });
    expect(availabilityMemberHealth(member('primary', false), true, now)).toBe('healthy');
    expect(availabilityMemberHealth(member('copy', true), false, now)).toBe('healthy');
    expect(availabilityMemberHealth(member('copy', false), false, now)).toBe('degraded');
    expect(availabilityMemberHealth(member('rebuilding', false), false, now)).toBe('degraded');
    expect(availabilityMemberHealth(member('copy', true, new Date(now - 120_000)), false, now)).toBe('down');
    expect(availabilityMemberHealth(member('fenced', false), false, now)).toBe('down');
    expect(availabilityMemberHealth(member('copy', false, seen, true), false, now)).toBe('stopped');
  });
});

describe('member states beyond running and exited', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const minute = 60_000;

  it('is neutral while a health check has not reported, degraded when restarting repeatedly', () => {
    expect(containerState('running', 'unknown')).toEqual({ health: 'none', neutral: 'starting' });
    expect(deploymentState('ready', 'unknown', { state: 'running' })).toMatchObject({ neutral: 'starting' });
    expect(containerState('running', 'online', {}, 3)).toMatchObject({ health: 'degraded' });
    expect(containerState('running', 'online', {}, 2).health).toBe('healthy');
    // Restarted by Docker 3 times within 10 minutes (a process that crashes 20 s after each start): a restart loop.
    expect(containerState('running', null, {}, 3, 3)).toMatchObject({ health: 'failing' });
    expect(containerState('running', 'unknown', {}, 3, 3)).toMatchObject({ health: 'failing' });
    expect(deploymentState('ready', null, { state: 'running' }, 4, 4)).toMatchObject({ health: 'failing' });
    expect(containerState('running', null, {}, 3, 2)).toMatchObject({ health: 'degraded' });
    const samples = [0, 1, 2, 3].map((index) => ({
      at: now - (40 - index * 10) * minute,
      healthy: true,
      restartCount: index,
      runtime: 'web',
    }));
    expect(recentRestartsOf(samples, now)).toBe(3);
    // Older than an hour: not recent.
    expect(
      recentRestartsOf(
        samples.map((sample) => ({ ...sample, at: sample.at - 2 * 60 * minute })),
        now
      )
    ).toBe(null);
  });

  it('reads a Compose project from its containers: partial is degraded, a crash fails, a stop is neutral', () => {
    const up = { state: 'running', status: 'Up 3 minutes' };
    expect(
      composeState('degraded', 'running', [up, { state: 'exited', status: 'Exited (0) 1 minute ago' }]).health
    ).toBe('degraded');
    expect(
      composeState('degraded', 'running', [up, { state: 'exited', status: 'Exited (1) 1 minute ago' }])
    ).toMatchObject({
      health: 'failing',
      reason: 'A service crashed with exit code 1',
    });
    expect(composeState('stopped', 'running', [{ state: 'exited', status: 'Exited (143) 1 minute ago' }]).health).toBe(
      'stopped'
    );
  });

  it('fails a route on an expired certificate and degrades it on a failed renewal or a near expiry', () => {
    const day = 24 * 60 * minute;
    expect(certificateState({ status: 'expired', notAfter: null, renewalFailureCount: 0 }, now).health).toBe('failing');
    expect(
      certificateState({ status: 'active', notAfter: new Date(now - 1), renewalFailureCount: 0 }, now).health
    ).toBe('failing');
    expect(
      certificateState({ status: 'active', notAfter: new Date(now + 90 * day), renewalFailureCount: 2 }, now)
    ).toMatchObject({
      health: 'degraded',
      reason: 'Its certificate renewal failed',
    });
    expect(
      certificateState({ status: 'active', notAfter: new Date(now + 5 * day), renewalFailureCount: 0 }, now)
    ).toMatchObject({
      health: 'degraded',
      reason: 'Its certificate expires in 5 days',
    });
    expect(
      certificateState({ status: 'active', notAfter: new Date(now + 60 * day), renewalFailureCount: 0 }, now).health
    ).toBe('none');
  });
});

describe('environment assessment (Apps list and overview)', () => {
  const member = (type: AppMember['type'], id: string, nodeIds: string[] = []): AppMember => ({
    type,
    id,
    name: id,
    environmentId: 'env-1',
    nodeIds,
    ...(nodeIds[0] ? { nodeId: nodeIds[0] } : {}),
  });
  const status = (
    type: AppMember['type'],
    id: string,
    health: MemberStatus['health'],
    extra: Partial<MemberStatus> = {}
  ): MemberStatus => ({
    member: member(type, id, extra.member?.nodeIds),
    health,
    cpuPercent: null,
    memoryBytes: null,
    memoryLimitBytes: null,
    ...extra,
    ...(extra.member ? { member: { ...member(type, id), ...extra.member } } : {}),
  });
  const assess = (statuses: MemberStatus[], signals: Array<[AppMember, object]> = []) =>
    assessEnvironment({
      envName: 'production',
      statuses,
      signals: new Map(signals.map(([item, signal]) => [memberSignalKey(item), signal])),
    });

  it('is unknown without members', () => {
    expect(assess([]).health).toBe('unknown');
  });

  it('keeps a stopped member out of the health while something runs, and shows it as a stopped issue', () => {
    const result = assess([status('container', 'api', 'healthy'), status('container', 'job', 'stopped')]);
    expect(result.health).toBe('healthy');
    expect(result.issues).toEqual([{ family: 'containers', state: 'stopped', count: 1 }]);
    expect(result.alerts).toEqual([]);
    expect(result).toMatchObject({ running: 1, stopped: 1, failing: 0 });
  });

  it('is degraded when every container, deployment and Compose project is stopped', () => {
    const result = assess([
      status('container', 'api', 'stopped'),
      status('deployment', 'dep', 'stopped'),
      status('database', 'db', 'healthy'),
    ]);
    expect(result.health).toBe('degraded');
    expect(result.alerts).toEqual([
      {
        tone: 'warning',
        title: 'Nothing runs',
        detail: 'Every container, deployment and Compose project of production is stopped',
      },
    ]);
    // No workloads at all: the rule does not apply.
    expect(assess([status('database', 'db', 'healthy')]).health).toBe('healthy');
  });

  it('fails on a crashed member, with its reason as the alert detail', () => {
    const result = assess([
      status('container', 'api', 'failing', { reason: 'Crashed with exit code 139' }),
      status('container', 'job', 'stopped'),
    ]);
    expect(result.health).toBe('failing');
    expect(result.alerts[0]).toEqual({
      tone: 'destructive',
      title: 'api is failing',
      detail: 'Crashed with exit code 139',
    });
  });

  it('turns every degraded member into a warning alert, so alerts and health agree', () => {
    const result = assess([
      status('pages', 'site', 'degraded', { reason: 'Not serving' }),
      status('container', 'api', 'healthy'),
    ]);
    expect(result.health).toBe('degraded');
    expect(result.alerts).toEqual([{ tone: 'warning', title: 'site is degraded', detail: 'Not serving' }]);
  });

  it('is degraded by any warning: 5xx over the threshold or a disk at least 80% full', () => {
    const route = status('route', 'r1', 'healthy');
    expect(assess([route], [[route.member, { requests: 100, errors: 3 }]]).health).toBe('degraded');
    expect(assess([route], [[route.member, { requests: 100, errors: 1 }]]).health).toBe('healthy');
    // Too few requests prove nothing.
    expect(assess([route], [[route.member, { requests: 4, errors: 2 }]]).health).toBe('healthy');
    const db = status('database', 'db', 'healthy');
    expect(assess([db], [[db.member, { diskPercent: 80 }]]).health).toBe('degraded');
    expect(assess([db], [[db.member, { diskPercent: 79.9 }]]).health).toBe('healthy');
    // A disabled route brings no warning of its own.
    const off = status('route', 'r2', 'none', { neutral: 'disabled' });
    expect(assess([route, off], [[off.member, { requests: 100, errors: 50 }]]).health).toBe('healthy');
  });

  it('shows disabled and maintenance routes as neutral, degraded when no route serves', () => {
    const off = status('route', 'r1', 'none', { neutral: 'disabled' });
    const maintenance = status('route', 'r2', 'none', { neutral: 'maintenance' });
    const result = assess([off, maintenance]);
    expect(result.health).toBe('degraded');
    expect(result.issues).toEqual([
      { family: 'routes', state: 'disabled', count: 1 },
      { family: 'routes', state: 'maintenance', count: 1 },
    ]);
    expect(result.alerts.map((alert) => alert.title)).toEqual(['No route serves traffic']);
    // A route without a health check serves: no warning.
    expect(assess([off, status('route', 'r3', 'none')]).health).toBe('healthy');
  });

  it('degrades a route whose target was stopped, and a member on an unreachable node', () => {
    const container = status('container', 'web', 'stopped', { member: { ...member('container', 'web', ['n1']) } });
    const route = status('route', 'r1', 'failing', { reason: 'Its health check fails' });
    const other = status('route', 'r2', 'failing');
    const remote = status('container', 'api', 'healthy', { member: { ...member('container', 'api', ['n2']) } });
    const statuses = [container, route, other, remote];
    applyCrossMemberRules(
      statuses,
      new Map([
        ['r1', workloadKey('container', 'n1', 'web')],
        ['r2', workloadKey('deployment', null, 'dep')],
      ]),
      new Set(['n2'])
    );
    expect(route).toMatchObject({ health: 'degraded', reason: 'Its target is stopped' });
    expect(other.health).toBe('failing');
    expect(remote).toMatchObject({ health: 'degraded', reason: 'Its node is unreachable' });
    expect(container.health).toBe('stopped');
  });
});

describe('Pages project health', () => {
  const route = (status: string, routeEnabled = true, activeDeploymentId: string | null = 'dep-1') => ({
    status,
    routeEnabled,
    activeDeploymentId,
  });
  const ready = { status: 'ready', previewHostname: 'a1b2c3.pages.example.com' };

  it('with a route: healthy only while an enabled route serves an active deployment', () => {
    expect(pagesState({ routes: [route('ready')], previewsEnabled: true, deployments: [ready] })).toEqual({
      health: 'healthy',
    });
    expect(pagesState({ routes: [route('ready', false)], previewsEnabled: true, deployments: [ready] })).toMatchObject({
      health: 'degraded',
    });
    expect(
      pagesState({ routes: [route('pending', true, null)], previewsEnabled: true, deployments: [ready] })
    ).toMatchObject({ health: 'degraded' });
  });

  it('without a route: a ready deployment with a preview URL is healthy', () => {
    expect(pagesState({ routes: [], previewsEnabled: true, deployments: [ready] })).toEqual({ health: 'healthy' });
  });

  it('without a route and before the first ready deployment: neutral, not started', () => {
    const notStarted = { health: 'none', neutral: 'not_started' };
    expect(pagesState({ routes: [], previewsEnabled: true, deployments: [] })).toEqual(notStarted);
    expect(
      pagesState({
        routes: [],
        previewsEnabled: true,
        deployments: [{ status: 'uploading', previewHostname: null }],
      })
    ).toEqual(notStarted);
    expect(pagesState({ routes: [], previewsEnabled: true, deployments: [{ ...ready, status: 'deleted' }] })).toEqual(
      notStarted
    );
  });

  it('without a route and nothing served: degraded', () => {
    expect(
      pagesState({ routes: [], previewsEnabled: true, deployments: [{ status: 'failed', previewHostname: null }] })
    ).toMatchObject({ health: 'degraded', reason: 'Not serving: no deployment is ready' });
    expect(pagesState({ routes: [], previewsEnabled: false, deployments: [ready] })).toMatchObject({
      health: 'degraded',
      reason: 'Not serving: it has no route and no preview URL',
    });
  });

  it('a project not started yet leaves the environment healthy', () => {
    const member = (id: string) => ({ type: 'pages' as const, id, name: id });
    const healthy = assessEnvironment({
      envName: 'prod',
      statuses: [{ member: member('site'), ...pagesState({ routes: [], previewsEnabled: true, deployments: [] }) }],
      signals: new Map(),
    });
    expect(healthy.health).toBe('healthy');
    expect(healthy.issues).toEqual([{ family: 'pages', state: 'not_started', count: 1 }]);
  });
});
