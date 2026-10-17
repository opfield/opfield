import { describe, expect, it } from 'vitest';
import { getAuditRequestContext, runWithAuditRequestContext } from '@/modules/audit/audit-request-context.js';
import { EventBusService } from './event-bus.service.js';

// rc.3 GF-2: an event published inside an API request handed the request's audit context (IP, user agent, MCP token
// and tool arguments) to the background work its subscribers started, so a container change made by root on a node
// was audited as if an unrelated API token had made it.
describe('event bus subscribers', () => {
  it('run in the context of their subscription, not of the publishing request', () => {
    const bus = new EventBusService();
    const seen: Array<string | undefined> = [];
    bus.subscribe('docker.container.changed', () => {
      seen.push(getAuditRequestContext()?.ipAddress);
      setTimeout(() => seen.push(getAuditRequestContext()?.ipAddress), 0);
    });
    runWithAuditRequestContext({ ipAddress: '172.20.0.138', userAgent: 'Python-urllib/3.13' }, () =>
      bus.publish('docker.container.changed', { nodeId: 'n1' })
    );
    expect(seen).toEqual([undefined]);
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(seen).toEqual([undefined, undefined]);
        resolve();
      }, 5)
    );
  });

  it('keep the context they subscribed in, such as a websocket session', () => {
    const bus = new EventBusService();
    const seen: Array<string | undefined> = [];
    runWithAuditRequestContext({ ipAddress: '10.0.0.5' }, () =>
      bus.subscribe('apps', () => seen.push(getAuditRequestContext()?.ipAddress))
    );
    runWithAuditRequestContext({ ipAddress: '172.20.0.130' }, () => bus.publish('apps', {}));
    bus.publish('apps', {});
    expect(seen).toEqual(['10.0.0.5', '10.0.0.5']);
  });

  it('can still be unsubscribed', () => {
    const bus = new EventBusService();
    let calls = 0;
    const unsubscribe = bus.subscribe('apps', () => calls++);
    bus.publish('apps', {});
    unsubscribe();
    bus.publish('apps', {});
    expect(calls).toBe(1);
  });
});
