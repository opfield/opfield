import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { NotificationEvaluatorService } from './notification-evaluator.service.js';

const NODE = '22222222-2222-4222-8222-222222222222';
const RUNTIME_ID = 'f3a1c9d2e4b5a6978877665544332211f3a1c9d2e4b5a6978877665544332211';

function evaluator(rule: Record<string, unknown>) {
  const service = new NotificationEvaluatorService({} as never, {} as never, {} as never, {} as never, null, {
    getNode: () => undefined,
  } as never);
  const internals = service as any;
  internals.getEventRules = async () => [
    { id: 'rule-1', category: 'container', type: 'event', cooldownSeconds: 900, durationSeconds: 0, ...rule },
  ];
  internals.isEventInCooldown = async () => false;
  const fired = vi.fn(async () => undefined);
  internals.fireEventAlert = fired;
  const observed = vi.fn(async () => undefined);
  internals.observeStatefulEvent = observed;
  return { service, internals, fired, observed };
}

/**
 * Stand 2.12.6-rc.2, O-8: a Container Started rule scoped to a container in the console (which stores the container
 * name) never fired: the start event was keyed by the runtime container id.
 */
describe('container events are keyed by the container name', () => {
  it('fires a Container Started rule scoped by name for a start that carries the runtime id', async () => {
    const t = evaluator({ eventPattern: 'started', resourceIds: ['web'] });

    await t.internals.handleBusEvent('docker.container.changed', {
      nodeId: NODE,
      id: RUNTIME_ID,
      name: 'web',
      action: 'started',
    });

    expect(t.fired).toHaveBeenCalledTimes(1);
    const [, type, key, name, details] = t.fired.mock.calls[0] as unknown as [unknown, string, string, string, any];
    expect([type, key, name]).toEqual(['container', 'web', 'web']);
    // The runtime id stays available to templates as {{resource.id}}.
    expect(details.resourceId).toBe(RUNTIME_ID);
  });

  it('does not fire for another container', async () => {
    const t = evaluator({ eventPattern: 'started', resourceIds: ['web'] });

    await t.internals.handleBusEvent('docker.container.changed', {
      nodeId: NODE,
      id: RUNTIME_ID,
      name: 'worker',
      action: 'started',
    });

    expect(t.fired).not.toHaveBeenCalled();
  });

  it('keys a change made outside Opfield by the container name too', async () => {
    const t = evaluator({ eventPattern: 'changed_outside', resourceIds: ['web'] });

    await t.internals.handleBusEvent('docker.container.external_change', {
      nodeId: NODE,
      nodeName: 'app-node-1',
      id: RUNTIME_ID,
      name: 'web',
      change: 'stopped',
      consequence: 'Opfield starts it again',
      managedAs: 'container',
    });

    expect(t.fired).toHaveBeenCalledTimes(1);
    expect((t.fired.mock.calls[0] as unknown[])[2]).toBe('web');
  });
});
