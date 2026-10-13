import { describe, expect, it } from 'vitest';
import { OFFLINE_LEASE_MEMBER_WARN_MS, offlineLeaseMemberWarnings } from './relay-offline-lease-members.js';

const now = Date.parse('2026-10-13T00:00:00Z');
const relay = (id: string, overrides: Partial<Parameters<typeof offlineLeaseMemberWarnings>[0][number]> = {}) => ({
  id,
  kind: 'remote' as const,
  state: 'offline' as const,
  displayName: id,
  lastSeenAt: new Date(now - 9 * 24 * 60 * 60_000),
  updatedAt: new Date(now - 9 * 24 * 60 * 60_000),
  ...overrides,
});

describe('offlineLeaseMemberWarnings', () => {
  it('warns about a remote relay offline past the threshold that is still a lease member', () => {
    const warnings = offlineLeaseMemberWarnings([relay('deb-fresh-2')], new Set(['deb-fresh-2']), now);
    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'offline_lease_member',
        relayInstanceId: 'deb-fresh-2',
        offlineSince: '2026-10-04T00:00:00.000Z',
      }),
    ]);
    expect(warnings[0].message).toContain('deb-fresh-2 has been offline for 9 days');
    expect(warnings[0].message).toContain('Remove it from the pool');
  });

  it('stays quiet for a relay offline shorter than the threshold, online, local or not a lease member', () => {
    const recent = new Date(now - OFFLINE_LEASE_MEMBER_WARN_MS + 60_000);
    const instances = [
      relay('recent', { lastSeenAt: recent, updatedAt: recent }),
      relay('ready', { state: 'ready' as never }),
      relay('local', { kind: 'local' as never }),
      relay('not-member'),
    ];
    expect(offlineLeaseMemberWarnings(instances, new Set(['recent', 'ready', 'local']), now)).toEqual([]);
  });

  it('falls back to the last update when the relay was never seen', () => {
    const warnings = offlineLeaseMemberWarnings(
      [relay('never', { lastSeenAt: null, updatedAt: new Date(now - 2 * 24 * 60 * 60_000) })],
      new Set(['never']),
      now
    );
    expect(warnings.map(({ message }) => message)).toEqual([expect.stringContaining('offline for 2 days')]);
  });
});
