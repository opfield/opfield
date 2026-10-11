import { describe, expect, it } from 'vitest';
import { isRecoveryEvent } from './notification-catalog.js';
import { alertDurationSeconds } from './notification-evaluator.service.js';
import { evaluateWindowRatio } from './notification-metrics.js';
import { defaultResolveMessage, resolveTemplateOf } from './notification-resolve-messages.js';
import { buildNotificationTemplateContext, renderTemplate } from './notification-templates.js';

describe('resolve messages', () => {
  it('tells the recovery for the rule, with how long the alert lasted', () => {
    const proxyDown = { name: 'Proxy host down', type: 'event', category: 'proxy', eventPattern: 'health.offline' };
    expect(defaultResolveMessage(proxyDown, 'shop.example.com', { fired: { duration: 782 } })).toBe(
      'Proxy host shop.example.com is back online after 13m 2s.'
    );
    expect(
      defaultResolveMessage(
        { name: 'Node down', type: 'event', category: 'node', eventPattern: 'offline' },
        'pd-backend'
      )
    ).toBe('Node pd-backend is back online.');
    expect(
      defaultResolveMessage({ name: 'CPU', type: 'threshold', category: 'node', metric: 'cpu' }, 'node-1', {
        metric: { value: 41.96 },
        fired: { duration: 300 },
      })
    ).toBe('CPU Usage on node-1 is back to normal at 42% after 5m 0s.');
    expect(
      defaultResolveMessage(
        { name: 'VM', type: 'event', category: 'hosting_vm', eventPattern: 'power.stopped' },
        'vm-7'
      )
    ).toBe('VM vm-7 is no longer stopped.');
    expect(
      defaultResolveMessage(
        { name: 'Storage', type: 'event', category: 'pages', eventPattern: 'cleanup.needs_attention' },
        'site'
      )
    ).toBe('Cleanup Needs Attention has cleared on site.');
  });

  it('renders the resolve message, or a firing message written for both states, never a plain firing message', () => {
    expect(resolveTemplateOf({ messageTemplate: 'Proxy host {{resource.name}} has gone offline' })).toBeNull();
    expect(resolveTemplateOf({ messageTemplate: 'down', resolveMessageTemplate: '{{resource.name}} is back' })).toBe(
      '{{resource.name}} is back'
    );
    expect(resolveTemplateOf({ messageTemplate: 'x', resolveMessageTemplate: '  ' })).toBeNull();
    const both = '{{#if (eq alert.status "resolved")}}up{{else}}down{{/if}}';
    expect(resolveTemplateOf({ messageTemplate: both })).toBe(both);
  });

  it('renders {{fired.duration}} as a readable duration and keeps the seconds for JSON and .seconds', () => {
    const context = buildNotificationTemplateContext({
      alert: { id: 'r', name: 'Node down', status: 'resolved', severity: 'critical' },
      resource: { type: 'node', id: 'n', key: 'n', name: 'alpine-1' },
      fired: { at: '2026-10-09T10:00:00.000Z', duration: 217 },
    });
    expect(renderTemplate('back after {{fired.duration}}', context)).toBe('back after 3m 37s');
    expect(renderTemplate('{{fired.duration.seconds}} {{formatDuration fired.duration}}', context)).toBe('217 3m 37s');
    expect(renderTemplate('{{{json fired}}}', context)).toBe('{"at":"2026-10-09T10:00:00.000Z","duration":217}');
  });

  it('counts an alert until its resource got back, not until the resolve window was covered', () => {
    const firedAt = new Date(1_000_000);
    // A 20-s relay outage resolved by a 61-s window: the clear run began at the first healthy sample.
    const window = evaluateWindowRatio(
      [
        { timestamp: 1_020_000, breached: false },
        { timestamp: 1_081_000, breached: false },
      ],
      'clear',
      100,
      60_000,
      1_081_000
    );
    expect(window.targetSince).toBe(1_020_000);
    expect(alertDurationSeconds(firedAt, window.targetSince, 1_081_000)).toBe(20);
    expect(alertDurationSeconds(firedAt, null, 1_081_000)).toBe(81);
    expect(
      evaluateWindowRatio(
        [
          { timestamp: 1, breached: false },
          { timestamp: 2, breached: true },
          { timestamp: 3, breached: false },
        ],
        'clear',
        50,
        0,
        3
      ).targetSince
    ).toBe(3);
  });

  it('treats back-online events as recoveries that close without a resolve', () => {
    expect(isRecoveryEvent('node', 'online')).toBe(true);
    expect(isRecoveryEvent('proxy', 'health.online')).toBe(true);
    expect(isRecoveryEvent('node', 'offline')).toBe(false);
    expect(isRecoveryEvent('proxy', 'health.offline')).toBe(false);
  });
});
