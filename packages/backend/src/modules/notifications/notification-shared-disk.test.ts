import { describe, expect, it, vi } from 'vitest';
import { dockerEngineHealth } from '@/grpc/services/health-report.js';
import { DOCKER_ENGINE_UNAVAILABLE_METRIC } from './notification-catalog.js';
import { NotificationEvaluatorService } from './notification-evaluator.service.js';
import { extractMetricFromHealthReport } from './notification-metrics.js';

const NAMES: Record<string, string> = { 'node-a': 'nginx-1', 'node-b': 'builder-1', 'node-c': 'relay-1' };

function setup(rule: Record<string, unknown>, active: Record<string, string> = {}) {
  const registry = { getNode: (id: string) => (NAMES[id] ? { hostname: NAMES[id], displayName: null } : undefined) };
  const service = new NotificationEvaluatorService({} as any, {} as any, {} as any, {} as any, null, registry as any);
  const internals = service as any;
  internals.getThresholdRules = async () => [
    {
      id: 'rule-1',
      category: 'node',
      operator: '>=',
      thresholdValue: 85,
      resourceIds: [],
      durationSeconds: 60,
      ...rule,
    },
  ];
  internals.recordProbeOutcome = async () => undefined;
  internals.getActiveAlertState = async (_rule: string, _type: string, key: string) =>
    active[key] ? { id: active[key] } : null;
  const resolved: Array<{ key: string; notify: boolean | undefined }> = [];
  internals.resolveAlert = async (
    _id: string,
    _rule: unknown,
    _type: string,
    key: string,
    _n: unknown,
    _d: unknown,
    o: any
  ) => {
    resolved.push({ key, notify: o?.notify });
  };
  const breach = vi.fn(async (..._args: unknown[]) => undefined);
  const clear = vi.fn(async (..._args: unknown[]) => undefined);
  internals.handleThresholdBreach = breach;
  internals.handleThresholdClear = clear;
  return { service, breach, clear, resolved };
}

const disk = (usagePercent: number, diskId?: string) => ({
  diskMounts: [{ mountPoint: '/', usagePercent, role: 'root', ...(diskId ? { diskId } : {}) }],
});

describe('a disk several enrolled nodes share alerts once (rc.2 O-1)', () => {
  it('one node of the host evaluates the shared disk and the alert names every node', async () => {
    const t = setup({ metric: 'disk', metricTarget: '@data' });
    for (const node of ['node-c', 'node-a', 'node-b']) await t.service.evaluateHealthReport(node, disk(87, 'disk-1'));
    // Before every node of the host reported, the first two were evaluated alone or as a pair; once all three are known,
    // only the lowest id (node-a) evaluates the disk.
    t.breach.mockClear();
    for (const node of ['node-c', 'node-a', 'node-b']) await t.service.evaluateHealthReport(node, disk(87, 'disk-1'));
    expect(t.breach).toHaveBeenCalledTimes(1);
    const [, key, , nodeId, mount, details] = t.breach.mock.calls[0]! as [unknown, string, number, string, string, any];
    expect(key).toBe('disk:disk-1');
    expect(nodeId).toBe('node-a');
    expect(mount).toBe('/');
    // The message says it is one disk, and every node is named with its id (rc.3 O-A2, O-A3).
    expect(details.node.name).toBe('builder-1, nginx-1, relay-1 (one shared disk)');
    expect(details.details).toEqual({
      mount: '/',
      nodes: 'builder-1, nginx-1, relay-1',
      nodeIds: 'node-a, node-b, node-c',
    });
  });

  it('keeps one alert per node for disks of different hosts and for daemons without a disk id', async () => {
    const t = setup({ metric: 'disk', metricTarget: '@data' });
    await t.service.evaluateHealthReport('node-a', disk(90, 'disk-a'));
    await t.service.evaluateHealthReport('node-b', disk(90, 'disk-b'));
    await t.service.evaluateHealthReport('node-c', disk(90));
    expect(t.breach.mock.calls.map((call) => call[1])).toEqual(['node-a:/', 'node-b:/', 'node-c:/']);
  });

  it('folds the alerts each node raised before into the shared one, quietly', async () => {
    const t = setup({ metric: 'disk', metricTarget: '@data' }, { 'node-a:/': 'state-a', 'node-b:/': 'state-b' });
    await t.service.evaluateHealthReport('node-a', disk(90, 'disk-1'));
    await t.service.evaluateHealthReport('node-b', disk(90, 'disk-1'));
    await t.service.evaluateHealthReport('node-a', disk(90, 'disk-1'));
    expect(t.resolved).toEqual(
      expect.arrayContaining([
        { key: 'node-a:/', notify: false },
        { key: 'node-b:/', notify: false },
      ])
    );
  });
});

describe('Docker Engine unavailable (rc.2 F-12)', () => {
  it('decodes the report and turns it into a 0/1 node metric; older daemons send none', () => {
    const down = dockerEngineHealth({
      dockerEngineHealth: {
        available: false,
        component: 'containerd',
        problem: 'containerd does not answer at /run/containerd/containerd.sock: connection refused',
        checkedAtUnixMs: '1792184269000',
        unavailableSinceUnixMs: '1792100269000',
      },
    });
    expect(down.dockerEngine).toMatchObject({ available: false, component: 'containerd' });
    expect(down.dockerEngine?.unavailableSince).toBe(new Date(1792100269000).toISOString());
    expect(extractMetricFromHealthReport('node', DOCKER_ENGINE_UNAVAILABLE_METRIC, down)?.values).toEqual([
      { resourceId: 'docker', value: 1 },
    ]);
    const up = dockerEngineHealth({ dockerEngineHealth: { available: true, checkedAtUnixMs: '1792184269000' } });
    expect(up.dockerEngine).toEqual({ available: true, checkedAt: new Date(1792184269000).toISOString() });
    expect(extractMetricFromHealthReport('node', DOCKER_ENGINE_UNAVAILABLE_METRIC, up)?.values).toEqual([
      { resourceId: 'docker', value: 0 },
    ]);
    expect(dockerEngineHealth({})).toEqual({});
    expect(extractMetricFromHealthReport('node', DOCKER_ENGINE_UNAVAILABLE_METRIC, {})).toBeNull();
  });

  it('names what fails in the alert details', async () => {
    const t = setup({ metric: DOCKER_ENGINE_UNAVAILABLE_METRIC, thresholdValue: 1 });
    await t.service.evaluateHealthReport('node-a', {
      dockerEngine: { available: false, problem: 'containerd does not answer' },
    });
    expect(t.breach).toHaveBeenCalledTimes(1);
    const details = t.breach.mock.calls[0]![5] as any;
    expect(details.details).toEqual({ problem: 'containerd does not answer' });
  });
});
