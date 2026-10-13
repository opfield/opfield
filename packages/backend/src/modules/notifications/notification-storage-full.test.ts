import { describe, expect, it } from 'vitest';
import { CATEGORY_MAP, eventSupportsThreshold, isRecoveryEvent } from './notification-catalog.js';
import { EVENT_BUS_MAPPINGS } from './notification-event-mappings.js';
import { extractMetricFromStorageSnapshot } from './notification-metrics.js';
import { defaultResolveMessage } from './notification-resolve-messages.js';

const STORAGE = '33333333-3333-4333-8333-333333333333';
const STORAGE_CONNECTION = '44444444-4444-4444-8444-444444444444';

function storageEvent(action: string) {
  return { id: STORAGE_CONNECTION, managedStorageClusterId: STORAGE, name: 'files', status: 'ready', action };
}

const matching = (payload: Record<string, unknown>) =>
  EVENT_BUS_MAPPINGS['managed-storage.changed']!.filter((mapping) => mapping.match(payload));

describe('managed storage that refuses uploads', () => {
  it('offers the full state, its recovery and the disk usage metric', () => {
    const category = CATEGORY_MAP.get('managed_storage')!;
    expect(category.events.find((event) => event.id === 'storage.full')).toMatchObject({ defaultSeverity: 'critical' });
    expect(eventSupportsThreshold('managed_storage', 'storage.full')).toBe(true);
    expect(eventSupportsThreshold('managed_storage', 'storage.writable')).toBe(true);
    expect(isRecoveryEvent('managed_storage', 'storage.writable')).toBe(true);
    expect(isRecoveryEvent('managed_storage', 'storage.full')).toBe(false);
    expect(category.metrics.map((metric) => metric.id)).toEqual(['disk_used_pct']);
  });

  it('follows the full and writable announcements of a storage as one state on its connection', () => {
    const [full] = matching(storageEvent('full'));
    expect(full).toMatchObject({ category: 'managed_storage', eventId: 'storage.full' });
    expect(full!.extractResource(storageEvent('full'))).toEqual({
      type: 'managed_storage',
      id: STORAGE_CONNECTION,
      name: 'files',
    });
    expect(full!.stateful).toMatchObject({
      observedPatterns: ['storage.full', 'storage.writable'],
      holdsUntilNextEvent: true,
    });
    expect(full!.stateful!.currentState(storageEvent('full'))).toBe('storage.full');

    const [writable] = matching(storageEvent('writable'));
    expect(writable).toBe(full);
    expect(writable!.stateful!.currentState(storageEvent('writable'))).toBe('storage.writable');

    // Lifecycle actions are not write states, and the availability alerts still match their own actions only.
    for (const action of ['ready', 'stopped', 'updating', 'created']) {
      expect(matching(storageEvent(action))).toEqual([]);
    }
    expect(matching(storageEvent('availability.failover')).map((mapping) => mapping.eventId)).toEqual([
      'availability.failover',
    ]);
  });

  it('says the storage takes uploads again when the alert resolves', () => {
    expect(
      defaultResolveMessage({ name: 'Full', category: 'managed_storage', eventPattern: 'storage.full' }, 'files')
    ).toMatch(/^Storage files takes uploads again/);
  });

  it('reads the disk usage from the disk its node reports', () => {
    const snapshot = (metrics: Record<string, number | null>) => ({ storageId: STORAGE_CONNECTION, metrics });
    expect(
      extractMetricFromStorageSnapshot(
        'managed_storage',
        'disk_used_pct',
        snapshot({ disk_used_bytes: 930, disk_total_bytes: 1000 })
      )
    ).toEqual({ values: [{ resourceId: STORAGE_CONNECTION, value: 93 }] });
    // No node report (a provider storage, a stale report), another category or metric: nothing.
    const samples: Array<Record<string, number | null>> = [
      { disk_used_bytes: null, disk_total_bytes: 1000 },
      { disk_used_bytes: 10, disk_total_bytes: 0 },
      { latency_ms: 12 },
    ];
    for (const metrics of samples) {
      expect(extractMetricFromStorageSnapshot('managed_storage', 'disk_used_pct', snapshot(metrics))).toBeNull();
    }
    expect(
      extractMetricFromStorageSnapshot(
        'database_postgres',
        'disk_used_pct',
        snapshot({ disk_used_bytes: 1, disk_total_bytes: 2 })
      )
    ).toBeNull();
  });
});
