import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type HostMoveLaunchInput,
  hasLegacyLayout,
  hostMoveContainerConfig,
  hostMoveLaunchDecision,
} from './host-move-launcher.js';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const settled: HostMoveLaunchInput = {
  production: true,
  composeDir: '/opt/gateway',
  composeProject: 'gateway',
  databaseUrl: 'postgres://gateway:secret@postgres:5432/gateway',
  uptimeMs: 10 * 60_000,
  updateBusy: false,
  sidecarRunning: false,
  moveContainer: null,
  record: { attempts: 0, lastStartedAt: null },
  now: NOW,
};

describe('when the app starts the host move', () => {
  it('knows the earlier layout by directory, project or database', () => {
    expect(
      hasLegacyLayout({
        composeDir: '/opt/gateway',
        composeProject: 'opfield',
        databaseUrl: 'postgres://opfield:x@postgres:5432/opfield',
      })
    ).toBe(true);
    expect(
      hasLegacyLayout({
        composeDir: '/opt/opfield',
        composeProject: 'gateway',
        databaseUrl: 'postgres://opfield:x@postgres:5432/opfield',
      })
    ).toBe(true);
    expect(
      hasLegacyLayout({
        composeDir: '/opt/opfield',
        composeProject: 'opfield',
        databaseUrl: 'postgres://gateway:x@postgres:5432/gateway',
      })
    ).toBe(true);
    expect(
      hasLegacyLayout({
        composeDir: '/opt/opfield',
        composeProject: 'opfield',
        databaseUrl: 'postgres://opfield:x@postgres:5432/opfield',
      })
    ).toBe(false);
  });

  it('starts once the update has settled', () => {
    expect(hostMoveLaunchDecision(settled)).toEqual({ launch: true, retry: false, removeContainer: false });
  });

  it.each([
    ['an update attempt is on record or running', { updateBusy: true }],
    ['an update sidecar still runs', { sidecarRunning: true }],
    ['the app just started', { uptimeMs: 30_000 }],
    ['a move runs', { moveContainer: 'running' as const }],
    [
      'the installation has the Opfield layout',
      {
        composeDir: '/opt/opfield',
        composeProject: 'opfield',
        databaseUrl: 'postgres://opfield:x@postgres:5432/opfield',
      },
    ],
    ['it is not a production installation', { production: false }],
    ['it does not run under Compose', { composeProject: null }],
  ])('waits while %s', (_reason, change) => {
    expect(hostMoveLaunchDecision({ ...settled, ...change }).launch).toBe(false);
  });

  it('removes the container of a finished move once the installation has the Opfield layout', () => {
    const moved = {
      ...settled,
      composeDir: '/opt/opfield',
      composeProject: 'opfield',
      databaseUrl: 'postgres://opfield:x@postgres:5432/opfield',
    };
    expect(hostMoveLaunchDecision({ ...moved, moveContainer: 'exited' })).toMatchObject({
      launch: false,
      removeFinished: true,
    });
    expect(hostMoveLaunchDecision({ ...moved, moveContainer: 'running' })).not.toHaveProperty('removeFinished');
    expect(hostMoveLaunchDecision({ ...moved, moveContainer: null })).not.toHaveProperty('removeFinished');
  });

  it('tries again six hours after a move went back, three times at most', () => {
    const recent = { attempts: 1, lastStartedAt: new Date(NOW - 60 * 60_000).toISOString() };
    expect(hostMoveLaunchDecision({ ...settled, moveContainer: 'exited', record: recent }).launch).toBe(false);
    const old = { attempts: 2, lastStartedAt: new Date(NOW - 7 * 60 * 60_000).toISOString() };
    expect(hostMoveLaunchDecision({ ...settled, moveContainer: 'exited', record: old })).toEqual({
      launch: true,
      retry: true,
      removeContainer: true,
    });
    expect(
      hostMoveLaunchDecision({ ...settled, record: { attempts: 3, lastStartedAt: old.lastStartedAt } }).launch
    ).toBe(false);
  });
});

describe('the host move container', () => {
  it('runs the move from the app image without the app healthcheck, restarted after a crash', () => {
    const config = hostMoveContainerConfig({
      image: 'ghcr.io/opfield/opfield@sha256:abc',
      composeDir: '/opt/gateway',
      composeProject: 'gateway',
      network: 'gateway_default',
      retry: true,
      parent: '/opt',
      sandbox: '/var/lib/opfield/sandbox-workspaces',
    });
    expect(config.Healthcheck).toEqual({ Test: ['NONE'] });
    expect(config.Cmd).toEqual([
      'node',
      'dist/cli/host-move.js',
      '--dir',
      '/opt/gateway',
      '--project',
      'gateway',
      '--network',
      'gateway_default',
      '--retry',
    ]);
    expect(config.HostConfig?.RestartPolicy).toEqual({ Name: 'unless-stopped' });
    expect(config.HostConfig?.NetworkMode).toBe('none');
  });

  it('is started without the app healthcheck by install.sh too', () => {
    const installer = readFileSync(new URL('../../../../scripts/install.sh', import.meta.url), 'utf8');
    const run = /run -d --name "\$HOST_MOVE_CONTAINER"[^\n]*\n[^\n]*/.exec(installer)?.[0] ?? '';
    expect(run).toContain('--no-healthcheck');
  });
});
