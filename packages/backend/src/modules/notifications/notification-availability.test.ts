import { describe, expect, it } from 'vitest';
import { CATEGORY_MAP, eventSupportsThreshold, isRecoveryEvent } from './notification-catalog.js';
import { EVENT_BUS_MAPPINGS, type EventMapping } from './notification-event-mappings.js';
import { defaultResolveMessage } from './notification-resolve-messages.js';

const DATABASE = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const STORAGE = '33333333-3333-4333-8333-333333333333';
const STORAGE_CONNECTION = '44444444-4444-4444-8444-444444444444';

function databaseEvent(action: string, availability: Record<string, unknown>, type = 'postgres') {
  return {
    resourceKind: 'managed_database',
    id: CONNECTION,
    managedDatabaseId: DATABASE,
    name: 'orders',
    type,
    status: 'ready',
    action,
    availability,
  };
}

function storageEvent(action: string, availability: Record<string, unknown>) {
  return {
    id: STORAGE_CONNECTION,
    managedStorageClusterId: STORAGE,
    name: 'files',
    status: 'ready',
    action,
    availability,
  };
}

function matches(channel: string, payload: Record<string, unknown>): EventMapping[] {
  return (EVENT_BUS_MAPPINGS[channel] ?? []).filter((mapping) => mapping.match(payload));
}

describe('availability alerts', () => {
  it('offers the availability events and metrics in every database category and in managed storage', () => {
    for (const category of ['database_postgres', 'database_clickhouse', 'database_redis', 'managed_storage'] as const) {
      const events = CATEGORY_MAP.get(category)!.events.map((event) => event.id);
      expect(events).toEqual(
        expect.arrayContaining([
          'availability.failover',
          'availability.switchover',
          'availability.degraded',
          'availability.no_failover',
          'availability.restored',
          'availability.member_offline',
          'availability.sync_degraded',
          'availability.sync_far',
          'availability.witness_lost',
          'availability.witness_moved',
        ])
      );
      expect(eventSupportsThreshold(category, 'availability.degraded')).toBe(true);
      expect(isRecoveryEvent(category, 'availability.restored')).toBe(true);
    }
    for (const category of ['database_postgres', 'database_clickhouse', 'database_redis'] as const) {
      expect(CATEGORY_MAP.get(category)!.metrics.map((metric) => metric.id)).toEqual(
        expect.arrayContaining(['replication_lag_bytes', 'replication_lag_seconds', 'rtt_ms'])
      );
    }
  });

  it('maps every availability mapping to an event its category has', () => {
    for (const channel of ['database.changed', 'managed-storage.changed']) {
      for (const mapping of EVENT_BUS_MAPPINGS[channel]!) {
        if (!mapping.eventId.startsWith('availability.')) continue;
        expect(CATEGORY_MAP.get(mapping.category)?.events.map((event) => event.id)).toContain(mapping.eventId);
      }
    }
  });

  it('alerts a failover of a database on its connection, with the time it happened', () => {
    const payload = databaseEvent('availability.failover', {
      setId: 'set',
      toMemberId: 'member-b',
      nodeId: 'node-b',
      occurredAt: '2026-10-11T08:00:00.000Z',
    });
    const [mapping, ...rest] = matches('database.changed', payload);
    expect(rest).toHaveLength(0);
    expect(mapping).toMatchObject({ category: 'database_postgres', eventId: 'availability.failover' });
    expect(mapping!.extractResource(payload)).toEqual({ type: 'database', id: CONNECTION, name: 'orders' });
    expect(mapping!.extractData!(payload)).toMatchObject({
      member_id: 'member-b',
      nodeId: 'node-b',
      occurred_at: '2026-10-11T08:00:00.000Z',
    });
  });

  it('tells set states from member events and keeps the state until the next change', () => {
    const state = databaseEvent(
      'availability.no_failover',
      { setId: 'set', state: 'no_failover', code: 'no_eligible_copy' },
      'clickhouse'
    );
    const [mapping] = matches('database.changed', state);
    expect(mapping!.category).toBe('database_clickhouse');
    expect(mapping!.stateful?.currentState(state)).toBe('availability.no_failover');
    expect(mapping!.stateful?.holdsUntilNextEvent).toBe(true);
    const restored = databaseEvent('availability.restored', { setId: 'set', state: 'healthy' }, 'clickhouse');
    expect(matches('database.changed', restored)[0]!.stateful?.currentState(restored)).toBe('availability.restored');

    // A member's synchronous copy fell back: a point event, not a set state.
    const member = databaseEvent('availability.degraded', {
      setId: 'set',
      memberId: 'member-b',
      kind: 'sync_degraded',
    });
    const found = matches('database.changed', member);
    expect(found.map((item) => item.eventId)).toEqual(['availability.sync_degraded']);
  });

  it('alerts managed storage on its storage connection', () => {
    const payload = storageEvent('availability.witness_lost', {
      setId: 'set',
      code: 'witness_offline',
      reason: 'Witness r1 does not respond',
    });
    const [mapping] = matches('managed-storage.changed', payload);
    expect(mapping).toMatchObject({ category: 'managed_storage', eventId: 'availability.witness_lost' });
    expect(mapping!.extractResource(payload)).toEqual({
      type: 'managed_storage',
      id: STORAGE_CONNECTION,
      name: 'files',
    });
    expect(mapping!.extractData!(payload)).toMatchObject({
      reason: 'Witness r1 does not respond',
      code: 'witness_offline',
    });
    // Lifecycle events of storage without an availability action raise nothing.
    expect(matches('managed-storage.changed', { ...payload, action: 'updated' })).toHaveLength(0);
  });

  it('says how a degraded set recovered', () => {
    expect(
      defaultResolveMessage(
        { name: 'rule', type: 'event', category: 'managed_storage', eventPattern: 'availability.no_failover' },
        'files'
      )
    ).toBe('Storage files can fail over again.');
  });
});
