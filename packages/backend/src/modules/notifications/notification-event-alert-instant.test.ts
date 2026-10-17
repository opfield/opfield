import { describe, expect, it, vi } from 'vitest';
import { NotificationEvaluatorService } from './notification-evaluator.service.js';
import { EVENT_BUS_MAPPINGS } from './notification-event-mappings.js';

// rc.3 GO-2: an event alert was stored with fired_at from the database clock and resolved_at from Opfield's, so it
// resolved before it fired (durationSeconds -0.0008).
describe('an event alert', () => {
  it('fires and resolves at one instant', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const self = {
      redis: undefined,
      eventBus: { publish: vi.fn() },
      buildTemplateResource: () => ({ type: 'container', id: 'c1', name: 'web' }),
      buildAlertTemplateContext: () => ({ notification: {} }),
      commitWithDeliveries: async (_rule: unknown, _event: unknown, write: (tx: unknown) => Promise<unknown>) =>
        write({
          insert: () => ({
            values: (values: Record<string, unknown>) => {
              inserted.push(values);
              return { returning: async () => [{ id: 'state-1' }] };
            },
          }),
        }),
    };
    const fire = (
      NotificationEvaluatorService.prototype as unknown as {
        fireEventAlert: (...args: unknown[]) => Promise<void>;
      }
    ).fireEventAlert;
    await fire.call(
      self,
      { id: 'rule-1', name: 'Container changed outside Opfield', severity: 'warning' },
      'container',
      'c1',
      'web',
      {}
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe('resolved');
    expect(inserted[0].firedAt).toBeInstanceOf(Date);
    expect(inserted[0].resolvedAt).toEqual(inserted[0].firedAt);
  });
});

// explore O-6: the message said "its permissions were reset" for every change, a new container or a stop too.
describe('the changed outside Opfield alert', () => {
  it('passes what each change means to the message', () => {
    const [mapping] = EVENT_BUS_MAPPINGS['docker.container.external_change']!;
    const payload = {
      nodeId: 'n1',
      nodeName: 'app-node-1',
      id: 'c1',
      name: 'web',
      change: 'stopped',
      consequence: 'It is not running now, and Opfield did not stop it. Start it from Opfield if it should run.',
      managedAs: 'container',
    };
    expect(mapping!.extractData!(payload)).toMatchObject({ change: 'stopped', consequence: payload.consequence });
  });
});
