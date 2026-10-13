import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationEvaluatorService } from './notification-evaluator.service.js';

/**
 * A "Node Online" rule (a recovery event) against the observations Opfield makes: every health report observes the
 * node online, a dropped node is observed offline once (stand rc.8, F-5).
 */
function setup(rule: Record<string, unknown> = {}) {
  const service = new NotificationEvaluatorService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined as never,
    {} as never
  );
  const internals = service as any;
  internals.getEventRules = async () => [
    {
      id: 'online-rule',
      category: 'node',
      eventPattern: 'online',
      resourceIds: [],
      durationSeconds: 0,
      resolveAfterSeconds: 60,
      ...rule,
    },
  ];
  const firing = new Map<string, { id: string }>();
  const fired = vi.fn(async (_rule: unknown, _type: string, resourceId: string) => {
    firing.set(resourceId, { id: `state-${resourceId}` });
  });
  const resolved = vi.fn(async (_stateId: string, _rule: unknown, _type: string, resourceId: string) => {
    firing.delete(resourceId);
  });
  internals.getActiveAlertState = async (_ruleId: string, _type: string, resourceId: string) =>
    firing.get(resourceId) ?? null;
  internals.fireAlert = fired;
  internals.resolveAlert = resolved;
  const observe = (nodeId: string, state: 'online' | 'offline') =>
    service.observeStatefulEvent('node', state, { type: 'node', id: nodeId, name: nodeId });
  return { service, fired, resolved, observe };
}

beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 9, 9, 20, 28) }));
afterEach(() => vi.useRealTimers());

describe('a Node Online rule', () => {
  it('does not fire for nodes that are simply online when the rule is created', async () => {
    const t = setup();
    for (const node of ['n1', 'n2', 'n3']) await t.observe(node, 'online');
    await t.observe('n1', 'online');
    expect(t.fired).not.toHaveBeenCalled();
  });

  it('fires each time the node comes back, once, and closes quietly when it goes offline', async () => {
    const t = setup();
    await t.observe('n1', 'online');

    for (let round = 1; round <= 3; round++) {
      await t.observe('n1', 'offline');
      vi.advanceTimersByTime(60_000);
      await t.observe('n1', 'online');
      await t.observe('n1', 'online');
      expect(t.fired).toHaveBeenCalledTimes(round);
    }
    // Going offline again closes the firing alert at once (its resolve sends nothing, see resolveAlert).
    await t.observe('n1', 'offline');
    expect(t.resolved).toHaveBeenCalledTimes(3);
  });

  it('keeps nodes apart', async () => {
    const t = setup();
    await t.observe('n1', 'offline');
    await t.observe('n2', 'online');
    await t.observe('n1', 'online');
    expect(t.fired).toHaveBeenCalledTimes(1);
    expect(t.fired.mock.calls[0]![2]).toBe('n1');
  });
});
