import { describe, expect, it } from 'vitest';
import { nginxUpgradeHealth, nginxVersionAtLeast, nginxVersionNotice } from './nginx-minimum-version.js';
import { compactMonitoringHistorySnapshot } from './node-monitoring.service.js';

describe('nginx minimum version', () => {
  it('compares dotted versions', () => {
    expect(nginxVersionAtLeast('1.30.6')).toBe(true);
    expect(nginxVersionAtLeast('1.30.10')).toBe(true);
    expect(nginxVersionAtLeast('1.31.0')).toBe(true);
    expect(nginxVersionAtLeast('1.30.5')).toBe(false);
    expect(nginxVersionAtLeast('1.28.3')).toBe(false);
    expect(nginxVersionAtLeast('')).toBe(false);
  });

  it('keeps the upgrade a daemon reports, with 64-bit fields as numbers', () => {
    expect(
      nginxUpgradeHealth({
        nginxUpgrade: {
          state: 'current',
          minimumVersion: '1.30.6',
          mode: 'direct',
          lastAttemptAt: '1792847086',
          upgradedAt: '1792847090',
          previousVersion: '1.28.3',
        },
      })
    ).toEqual({
      nginxUpgrade: {
        state: 'current',
        minimumVersion: '1.30.6',
        mode: 'direct',
        detail: '',
        command: '',
        lastAttemptAt: 1792847086,
        upgradedAt: 1792847090,
        previousVersion: '1.28.3',
      },
    });
    expect(nginxUpgradeHealth({})).toEqual({});
    expect(nginxUpgradeHealth({ nginxUpgrade: null })).toEqual({});
  });

  it('says nothing while nginx is current or unknown', () => {
    expect(nginxVersionNotice({ nginxVersion: '1.30.6' })).toBeUndefined();
    expect(nginxVersionNotice({ nginxVersion: '' })).toBeUndefined();
  });

  it('names what upgrades an old nginx', () => {
    expect(nginxVersionNotice({ nginxVersion: '1.28.3' })).toMatch(/older than 1\.30\.6.*Update the nginx daemon/);
    const manual = nginxVersionNotice({
      nginxVersion: '1.28.3',
      ...nginxUpgradeHealth({
        nginxUpgrade: { state: 'manual', command: 'sudo /usr/local/bin/nginx-daemon upgrade-nginx' },
      }),
    });
    expect(manual).toMatch(/run as root on the node: sudo \/usr\/local\/bin\/nginx-daemon upgrade-nginx$/);
    const failed = nginxVersionNotice({
      nginxVersion: '1.28.3',
      ...nginxUpgradeHealth({
        nginxUpgrade: { state: 'failed', detail: 'could not add the nginx.org repository: 404' },
      }),
    });
    expect(failed).toMatch(
      /failed and the old nginx keeps serving: could not add the nginx\.org repository: 404 It tries again/
    );
  });

  it('keeps the notice and the upgrade in the monitoring history', () => {
    const snapshot = compactMonitoringHistorySnapshot({
      timestamp: '2026-10-24T00:00:00Z',
      health: { nginxVersion: '1.28.3', nginxVersionNotice: 'notice', nginxUpgrade: { state: 'upgrading' } },
    });
    expect(snapshot.health.nginxVersionNotice).toBe('notice');
    expect(snapshot.health.nginxUpgrade).toEqual({ state: 'upgrading' });
  });
});
