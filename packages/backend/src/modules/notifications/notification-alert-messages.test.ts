import { describe, expect, it, vi } from 'vitest';
import { describeFullestDisk } from '@/modules/diagnostics/diagnostics.service.js';
import { defaultFiredMessage, NotificationEvaluatorService } from './notification-evaluator.service.js';

// rc.3 stand: a custom threshold rule fired "rc3sp-alert: app-node-2" with no metric (srcparity O-10); the open
// "Opfield disk almost full" alert kept "86% full" while the disk reached 96 % (housekeeping O-4); the Opfield disk
// alerts did not say which disk (explore O-5).

describe('default message of a rule without a template', () => {
  it('says what crossed the limit for a threshold rule', () => {
    expect(
      defaultFiredMessage({ name: 'cpu-high', type: 'threshold' }, 'app-node-2', {
        metric: { name: 'cpu', value: 41.53, threshold: 0, operator: '>=', duration: 60 },
      })
    ).toBe('cpu-high: app-node-2: cpu is 41.5 (rule >= 0 for 60 s)');
    expect(
      defaultFiredMessage({ name: 'disk', type: 'threshold' }, 'n1', {
        metric: { name: 'disk', value: 90, threshold: 85, operator: '>' },
      })
    ).toBe('disk: n1: disk is 90 (rule > 85)');
  });

  it('keeps the rule and resource for an event rule', () => {
    expect(defaultFiredMessage({ name: 'changed', type: 'event' }, 'web', {})).toBe('changed: web');
  });
});

describe('a firing threshold alert follows the reading', () => {
  function setup(state: { id: string; message: string | null; context: Record<string, unknown> } | null) {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            updates.push(values);
          },
        }),
      }),
    };
    const service = new NotificationEvaluatorService(db as any, {} as any, {} as any, {} as any, null, {} as any);
    const internals = service as any;
    internals.getThresholdRules = async () => [
      {
        id: 'rule-1',
        name: 'Opfield disk almost full',
        type: 'threshold',
        category: 'opfield',
        metric: 'host_disk',
        operator: '>=',
        thresholdValue: 85,
        durationSeconds: 0,
        resourceIds: [],
        messageTemplate: 'The disk is {{metric.value}}% full{{#if details.disk}} ({{details.disk}}){{/if}}.',
      },
    ];
    internals.recordProbeOutcome = async () => undefined;
    internals.getActiveAlertState = async () => state;
    internals.getThresholdResourceId = async () => 'opfield';
    const fireAlert = vi.fn(async () => undefined);
    internals.fireAlert = fireAlert;
    return { service, updates, fireAlert };
  }

  it('rewrites the message of the open alert, naming the disk, without firing again', async () => {
    const t = setup({ id: 's1', message: 'The disk is 86% full.', context: { folded: null } });
    await t.service.evaluateOpfieldSnapshot({ host_disk: 96 }, { host_disk: { disk: 'postgres: /var/lib/postgresql/data' } });
    expect(t.fireAlert).not.toHaveBeenCalled();
    expect(t.updates).toHaveLength(1);
    expect(t.updates[0]?.message).toBe('The disk is 96% full (postgres: /var/lib/postgresql/data).');
    expect(t.updates[0]?.context).toMatchObject({ folded: null, metric: { value: 96 } });
  });

  it('writes nothing when the message is unchanged', async () => {
    const t = setup({ id: 's1', message: 'The disk is 96% full.', context: {} });
    await t.service.evaluateOpfieldSnapshot({ host_disk: 96 });
    expect(t.updates).toHaveLength(0);
  });

  it('fires with the disk in the details when nothing is open', async () => {
    const t = setup(null);
    await t.service.evaluateOpfieldSnapshot({ host_disk: 91 }, { host_disk: { disk: 'Opfield data (/var/lib/gateway)' } });
    expect(t.fireAlert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rule-1' }),
      'opfield',
      'opfield',
      'Opfield',
      expect.objectContaining({ details: { disk: 'Opfield data (/var/lib/gateway)' }, metric: expect.objectContaining({ value: 91 }) })
    );
  });
});

describe('describeFullestDisk', () => {
  it('names the fuller disk and what it holds', () => {
    expect(describeFullestDisk({ usedPercent: 20 }, null, '/var/lib/gateway')).toBe('Opfield data (/var/lib/gateway)');
    expect(
      describeFullestDisk(
        { usedPercent: 20 },
        { usedPercent: 96, holds: ['postgres: /var/lib/postgresql/data'], filesystem: '/dev/sdb1' },
        '/var/lib/gateway'
      )
    ).toBe('postgres: /var/lib/postgresql/data on /dev/sdb1');
    expect(describeFullestDisk(null, null, '/x')).toBeNull();
  });
});

describe('changed outside Opfield: what it means', () => {
  it('does not tell of reset permissions for a container created by hand', async () => {
    const { describeEffect } = await import('@/modules/docker/docker-external-changes.service.js');
    expect(describeEffect({ action: 'created' }, 'container')).toMatch(/does not manage the new container/);
    expect(describeEffect({ action: 'created' }, 'container')).not.toMatch(/were reset/);
    expect(describeEffect({ action: 'renamed' }, 'Git-source container')).toMatch(/Git source builds refuse it/);
    expect(describeEffect({ action: 'removed' }, 'container')).toBe('Its permissions went with it.');
  });
});
