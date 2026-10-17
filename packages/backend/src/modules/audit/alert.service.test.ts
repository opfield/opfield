// The schema barrel first, in its production order: the per-table modules import each other circularly.
import '@/db/schema/index.js';
import { describe, expect, it, vi } from 'vitest';
import { AlertService } from './alert.service.js';

// rc.3 stand housekeeping item 7: the folding of a repeated alert into the open one had no test of its own (callers
// mocked createAlert), and the daily jobs that repeat it cannot be run on demand.
function setup(openRows: number) {
  const updates: unknown[] = [];
  const inserts: unknown[] = [];
  const db = {
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            updates.push(values);
            return Array.from({ length: openRows }, (_, index) => ({ id: `alert-${index}` }));
          }),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (values: unknown) => {
        inserts.push(values);
      }),
    })),
  };
  return { service: new AlertService(db as never), updates, inserts };
}

const alert = {
  type: 'expiry_warning' as const,
  resourceType: 'certificate',
  resourceId: 'cert-1',
  message: 'Certificate app.example.com expires in 9 days',
};

describe('AlertService.createAlert', () => {
  it('refreshes the open alert of the same kind and resource instead of adding a row', async () => {
    const { service, updates, inserts } = setup(1);
    await service.createAlert(alert);
    expect(updates).toEqual([{ message: alert.message, createdAt: expect.any(Date) }]);
    expect(inserts).toEqual([]);
  });

  it('adds a row when no open alert exists (none yet, or the earlier one was dismissed)', async () => {
    const { service, inserts } = setup(0);
    await service.createAlert(alert);
    expect(inserts).toEqual([alert]);
  });
});
