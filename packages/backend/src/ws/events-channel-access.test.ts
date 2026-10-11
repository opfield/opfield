import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_SET_CHANNEL,
  hasAvailabilitySetEventAccess,
  hasChannelAccess,
  hasHostingSnapshotEventAccess,
  hasIntegrationConnectorEventAccess,
  projectHostingSnapshotEvent,
} from './events-channel-access.js';

describe('SSL certificate event channel access', () => {
  it('projects snapshot billing per connector and recipient without altering shared events', () => {
    const event = Object.freeze({
      connectorId: 'account',
      resourceId: 'vm',
      nodeIds: ['node'],
      snapshot: Object.freeze({
        entityId: 'snapshot',
        status: 'ready',
        monthlyCost: { amount: '0.16', currency: 'USD' },
        storageRate: { amount: '0.06' },
      }),
    });
    for (const scopes of [
      [],
      ['hosting:billing:view:other'],
      ['integrations:hosting:manage'],
      ['hosting:snapshots:view'],
      ['*'],
    ]) {
      expect(projectHostingSnapshotEvent(scopes, event)).toEqual({
        ...event,
        snapshot: { entityId: 'snapshot', status: 'ready' },
      });
    }
    for (const scopes of [['hosting:billing:view'], ['hosting:billing:view:account']]) {
      expect(projectHostingSnapshotEvent(scopes, event)).toBe(event);
    }
    expect((projectHostingSnapshotEvent([], event) as any).snapshot).not.toHaveProperty('monthlyCost');
    expect(event.snapshot.monthlyCost.amount).toBe('0.16');
    expect(
      (projectHostingSnapshotEvent(['hosting:billing:view'], { ...event, connectorId: undefined }) as any).snapshot
    ).not.toHaveProperty('monthlyCost');
  });
  it('restricts snapshot entity events to the VM and all bound nodes', () => {
    const scopes = [
      'hosting:snapshots:view:vm',
      'hosting:resources:view:vm',
      'nodes:details:a',
      'integrations:hosting:view:account',
    ];
    expect(hasChannelAccess(scopes, 'hosting.snapshot.changed')).toBe(true);
    expect(hasChannelAccess(scopes, 'hosting.snapshot.folder.changed')).toBe(true);
    expect(hasChannelAccess(['integrations:hosting:view'], 'hosting.snapshot.folder.changed')).toBe(false);
    expect(hasHostingSnapshotEventAccess(scopes, { resourceId: 'vm', connectorId: 'account', nodeIds: ['a'] })).toBe(
      true
    );
    expect(hasHostingSnapshotEventAccess(scopes, { resourceId: 'vm', connectorId: 'other', nodeIds: ['a'] })).toBe(
      false
    );
    expect(hasHostingSnapshotEventAccess(scopes, { resourceId: 'other', connectorId: 'account', nodeIds: ['a'] })).toBe(
      false
    );
    expect(
      hasHostingSnapshotEventAccess(scopes, { resourceId: 'vm', connectorId: 'account', nodeIds: ['a', 'b'] })
    ).toBe(false);
    expect(hasHostingSnapshotEventAccess(scopes, { resourceId: 'vm', nodeIds: [] })).toBe(false);
    expect(hasChannelAccess(['integrations:hosting:view'], 'hosting.snapshot.changed')).toBe(false);
  });
  it('never exposes internal hosting observations or billing through WebSocket subscriptions', () => {
    for (const channel of [
      'hosting.account.observed',
      'hosting.vm.observed',
      'hosting.operation.changed',
      'hosting.firewall.observed',
    ]) {
      expect(hasChannelAccess(['*'], channel)).toBe(false);
      expect(hasChannelAccess(['integrations:hosting:view'], channel)).toBe(false);
    }
  });
  it('separates folder layout events from certificate lifecycle metadata', () => {
    expect(hasChannelAccess(['ssl:cert:folders:manage'], 'ssl.cert.folder.changed')).toBe(true);
    expect(hasChannelAccess(['ssl:cert:folders:manage'], 'ssl.cert.changed')).toBe(false);
    expect(hasChannelAccess(['ssl:cert:view'], 'ssl.cert.folder.changed')).toBe(true);
    // A folder-limited folder manager gets live layout events of that list.
    expect(hasChannelAccess(['ssl:cert:folders:manage:folder/f1'], 'ssl.cert.folder.changed')).toBe(true);
    expect(hasChannelAccess(['domains:folders:manage:folder/f1'], 'domain.changed')).toBe(true);
    expect(hasChannelAccess(['ssl:cert:view'], 'ssl.cert.changed')).toBe(true);
  });
});

describe('perm-data event channel access', () => {
  it('shows logging health to any logs viewer or housekeeping viewer', () => {
    expect(hasChannelAccess(['housekeeping:view'], 'logging.health.changed')).toBe(true);
    expect(hasChannelAccess(['logs:environments:view'], 'logging.health.changed')).toBe(true);
    expect(hasChannelAccess(['logs:schemas:view:schema-1'], 'logging.health.changed')).toBe(true);
    expect(hasChannelAccess(['logs:read:env-1'], 'logging.health.changed')).toBe(true);
    expect(hasChannelAccess(['nodes:details'], 'logging.health.changed')).toBe(false);
  });

  it('gates notification channels on the alert and webhook scopes', () => {
    expect(hasChannelAccess(['notifications:alerts:view'], 'notification.alert-rule.changed')).toBe(true);
    expect(hasChannelAccess(['notifications:alerts:manage'], 'notification.alert-rule.changed')).toBe(true);
    expect(hasChannelAccess(['notifications:webhooks:view'], 'notification.alert-rule.changed')).toBe(false);
    expect(hasChannelAccess(['notifications:webhooks:view'], 'notification.webhook.changed')).toBe(true);
    expect(hasChannelAccess(['notifications:webhooks:manage'], 'notification.webhook.changed')).toBe(true);
    expect(hasChannelAccess(['notifications:alerts:view'], 'alert.fired')).toBe(true);
    expect(hasChannelAccess(['notifications:webhooks:view'], 'alert.fired')).toBe(false);
  });

  it('lets folder-only and create-only pages users follow folder layout changes', () => {
    expect(hasChannelAccess(['pages:view:folder/f1'], 'pages.folder.changed')).toBe(true);
    expect(hasChannelAccess(['pages:create:folder/f1'], 'pages.folder.changed')).toBe(true);
    expect(hasChannelAccess(['domains:view'], 'pages.folder.changed')).toBe(false);
  });
});

describe('integration connector events', () => {
  const C = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';

  it('delivers a connector event only to callers who may see that connector', () => {
    const narrow = [`integrations:gitlab:repo:read:${C}/project/42`];
    // The narrow grant still subscribes to the channel...
    expect(hasChannelAccess(narrow, 'integration.connector.changed')).toBe(true);
    // ...but only receives its own connector.
    expect(hasIntegrationConnectorEventAccess(narrow, { id: C, provider: 'gitlab', name: 'Main' })).toBe(true);
    expect(hasIntegrationConnectorEventAccess(narrow, { id: OTHER, provider: 'gitlab', name: 'Secret' })).toBe(false);
    expect(hasIntegrationConnectorEventAccess(narrow, { id: C, provider: 'github', name: 'GitHub' })).toBe(false);
    expect(hasIntegrationConnectorEventAccess(narrow, { id: 'cf-1', provider: 'cloudflare' })).toBe(false);
    expect(hasIntegrationConnectorEventAccess(narrow, { id: 'ssh-1', provider: 'ssh' })).toBe(false);
    expect(hasIntegrationConnectorEventAccess(narrow, { id: 'host-1', provider: 'hosting' })).toBe(false);
  });

  it('keeps provider-wide viewers on every connector of their providers', () => {
    const scopes = [
      'integrations:github:view',
      'integrations:cloudflare:view',
      'integrations:ssh:manage',
      'integrations:hosting:view:host-1',
    ];
    expect(hasIntegrationConnectorEventAccess(scopes, { id: OTHER, provider: 'github' })).toBe(true);
    expect(hasIntegrationConnectorEventAccess(scopes, { id: 'cf-1', provider: 'cloudflare' })).toBe(true);
    expect(hasIntegrationConnectorEventAccess(scopes, { id: 'ssh-1', provider: 'ssh' })).toBe(true);
    expect(hasIntegrationConnectorEventAccess(scopes, { id: 'host-1', provider: 'hosting' })).toBe(true);
    expect(hasIntegrationConnectorEventAccess(scopes, { id: 'host-2', provider: 'hosting' })).toBe(false);
    expect(hasIntegrationConnectorEventAccess(scopes, { id: C, provider: 'gitlab' })).toBe(false);
    expect(hasIntegrationConnectorEventAccess(scopes, { provider: 'github' })).toBe(false);
    expect(hasIntegrationConnectorEventAccess(scopes, { id: 'x', provider: 'unknown' })).toBe(false);
  });
});

describe('availability set event channel access', () => {
  it('lets viewers of every database or storage subscribe and receive the events of their kind only', () => {
    expect(hasChannelAccess(['databases:view'], AVAILABILITY_SET_CHANNEL)).toBe(true);
    expect(hasChannelAccess(['storage:view:connection'], AVAILABILITY_SET_CHANNEL)).toBe(true);
    expect(hasChannelAccess(['nodes:details'], AVAILABILITY_SET_CHANNEL)).toBe(false);
    const database = { setId: 'set', ownerKind: 'managed_database', ownerId: 'db', action: 'lease_failover' };
    const storage = { ...database, ownerKind: 'managed_storage', ownerId: 'storage' };
    expect(hasAvailabilitySetEventAccess(['databases:view'], database)).toBe(true);
    expect(hasAvailabilitySetEventAccess(['databases:view'], storage)).toBe(false);
    expect(hasAvailabilitySetEventAccess(['storage:view'], storage)).toBe(true);
    // A grant on single resources cannot be matched to a set event (it names the managed id): no delivery.
    expect(hasAvailabilitySetEventAccess(['databases:view:connection'], database)).toBe(false);
  });
});
