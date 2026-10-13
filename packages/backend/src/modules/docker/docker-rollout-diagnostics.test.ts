import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';
import { collectDockerRolloutDiagnostics } from './docker-rollout-diagnostics.js';

const failedInspect = (patch: Record<string, unknown> = {}) => ({
  Name: '/api',
  RestartCount: 4,
  State: { Status: 'restarting', ExitCode: 1, OOMKilled: false, Error: '' },
  Config: { Env: ['DATABASE_URL=postgres://app:hunter2@db:5432/app', 'MODE=production'] },
  ...patch,
});

describe('rollout failure diagnostics', () => {
  it('reports the restarts and the log lines of a container with a large inspect, redacted', async () => {
    const labels = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`label.${index}`, 'x'.repeat(100)]));
    const diagnostics = await collectDockerRolloutDiagnostics({
      inspect: async () => failedInspect({ Config: { ...failedInspect().Config, Labels: labels } }),
      logs: async () => ['booting', 'connecting to postgres://app:hunter2@db:5432/app', 'fatal: migration failed'],
    });

    expect(diagnostics).toContain('Runtime: restarting; exit code 1; restarts 4; OOMKilled=false');
    expect(diagnostics).toContain('fatal: migration failed');
    expect(diagnostics).not.toContain('hunter2');
  });

  it('keeps the log lines when the inspect cannot be read, redacted with the values Opfield stores', async () => {
    const diagnostics = await collectDockerRolloutDiagnostics({
      inspect: async () => {
        throw new Error('inspect timed out');
      },
      logs: async () => ['token=s3cr3t-value accepted', 'listening on 3000'],
      storedValues: async () => ({ environment: ['3000'], secrets: ['s3cr3t-value'] }),
    });

    expect(diagnostics).toContain('Runtime: state unavailable');
    expect(diagnostics).toContain('listening on 3000');
    expect(diagnostics).not.toContain('s3cr3t-value');
  });

  it('redacts secrets and credential-like values but keeps short and numeric ones readable', async () => {
    const diagnostics = await collectDockerRolloutDiagnostics({
      inspect: async () =>
        failedInspect({
          RestartCount: 10,
          State: { Status: 'restarting', ExitCode: 3, OOMKilled: false, Error: '' },
          Config: {
            Env: ['PYTHONUNBUFFERED=1', 'HOLD_CONNS=0', 'PORT=3000', 'PIN=271', 'API_KEY=ab12cd34ef56gh78'],
          },
        }),
      // PIN is an Opfield secret, short as it is.
      secretEntries: async () => (entry) => entry.startsWith('PIN='),
      logs: async () => [
        '{"t":"2026-10-01T20:56:13","port":3000,"restarts":10}',
        'unlocking with 271 and ab12cd34ef56gh78',
      ],
    });

    expect(diagnostics).toContain('Runtime: restarting; exit code 3; restarts 10; OOMKilled=false');
    expect(diagnostics).toContain('{"t":"2026-10-01T20:56:13","port":3000,"restarts":10}');
    expect(diagnostics).toContain('unlocking with [REDACTED] and [REDACTED]');
  });

  it('redacts every value, but never the runtime line, when it cannot tell which entries are secrets', async () => {
    const diagnostics = await collectDockerRolloutDiagnostics({
      inspect: async () => failedInspect({ RestartCount: 1, Config: { Env: ['PYTHONUNBUFFERED=1'] } }),
      secretEntries: async () => {
        throw new Error('secrets unavailable');
      },
      logs: async () => ['attempt 1 failed'],
    });

    expect(diagnostics).toContain('Runtime: restarting; exit code 1; restarts 1; OOMKilled=false');
    expect(diagnostics).toContain('attempt [REDACTED] failed');
  });

  it('keeps the newest log lines that fit and names a line too long to show', async () => {
    const diagnostics = await collectDockerRolloutDiagnostics({
      inspect: async () => failedInspect(),
      logs: async () => ['y'.repeat(40 * 1024), 'last words'],
    });

    expect(diagnostics).toContain('[Oversized log line omitted]\nlast words');
  });

  it('withholds the log lines when the environment is too large to redact', async () => {
    const diagnostics = await collectDockerRolloutDiagnostics({
      inspect: async () => failedInspect({ Config: { Env: Array.from({ length: 300 }, (_, i) => `V${i}=v`) } }),
      logs: vi.fn(async () => ['secret output']),
    });

    expect(diagnostics).toContain('Container logs withheld');
    expect(diagnostics).not.toContain('secret output');
  });

  it('reads an inspect larger than one field limit from the node', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async () => ({
        success: true,
        detail: JSON.stringify(
          failedInspect({ Mounts: Array.from({ length: 300 }, (_, i) => ({ Source: `/data/${'m'.repeat(200)}${i}` })) })
        ),
      })),
      sendDockerLogsCommand: vi.fn(async () => ({ success: true, detail: JSON.stringify(['fatal: port in use']) })),
    };
    const service = new DockerManagementService({} as never, {} as never, dispatch as never, {} as never);

    const diagnostics = await service.getContainerFailureDiagnostics('node-1', 'container-1');

    expect(diagnostics).toContain('restarts 4');
    expect(diagnostics).toContain('fatal: port in use');
  });

  it('redacts the container secrets Opfield stores, whatever their length', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async () => ({
        success: true,
        detail: JSON.stringify(failedInspect({ Config: { Env: ['DB_PASSWORD=pw', 'WORKERS=4'] } })),
      })),
      sendDockerLogsCommand: vi.fn(async () => ({ success: true, detail: JSON.stringify(['login pw, 4 workers']) })),
    };
    const service = new DockerManagementService({} as never, {} as never, dispatch as never, {} as never);
    service.setSecretService({
      getSecretKeys: vi.fn(async () => ['DB_PASSWORD']),
      getDecryptedMap: vi.fn(async () => ({})),
    } as never);

    const diagnostics = await service.getContainerFailureDiagnostics('node-1', 'container-1');

    expect(diagnostics).toContain('login [REDACTED], 4 workers');
  });
});
