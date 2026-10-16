import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertAgentSshCommandAllowed, clearSshProbeCache } from './ai.console-agent-guard.js';
import { analyzeConsoleCommand, shellStringCommands } from './ai.console-commands.js';
import { nodeConsoleCommandStaticRefusal } from './ai.console-preflight.js';
import {
  consoleCommandRisky,
  containerRuntimeCommand,
  NODE_CONSOLE_RUNTIME_UNAVAILABLE,
} from './ai.console-runtime.js';
import { inspectConsoleCommand } from './ai.console-safety.js';
import { getAIToolApprovalDecision } from './ai-approval-policy.js';

const risky = (argv: string[]) => consoleCommandRisky(inspectConsoleCommand(argv).risky, analyzeConsoleCommand(argv));
const usesRuntime = (argv: string[]) => containerRuntimeCommand(analyzeConsoleCommand(argv).commands) !== null;

// F-1 (stand rc.2): each of these stopped a managed container and came back risky:false.
const STAND_BYPASSES: Array<[string, string[]]> = [
  [
    'Docker API socket',
    [
      'sh',
      '-c',
      'curl -s --unix-socket /var/run/docker.sock -X POST http://localhost/v1.43/containers/rc2s-f6/stop -w %{http_code}',
    ],
  ],
  ['decoded payload', ['sh', '-c', 'echo ZG9ja2VyIHN0b3AgcmMycy1mNg== | base64 -d | sh']],
  ['containerd', ['ctr', '-n', 'moby', 'tasks', 'kill', 'abc']],
];

describe('agent console commands and the container runtime', () => {
  it.each(STAND_BYPASSES)('marks the %s route risky', (_label, argv) => {
    expect(risky(argv)).toBe(true);
  });

  it('refuses commands that visibly use the runtime, read-only ones too', () => {
    for (const argv of [
      STAND_BYPASSES[0][1],
      STAND_BYPASSES[2][1],
      ['docker', 'ps'],
      ['sh', '-c', 'socat - UNIX-CONNECT:/run/containerd/containerd.sock'],
      ['sudo', 'nerdctl', 'ps'],
      ['sh', '-lc', 'DOCKER_HOST=unix:///run/podman/podman.sock podman-remote ps'],
    ]) {
      expect(usesRuntime(argv)).toBe(true);
      expect(nodeConsoleCommandStaticRefusal({ nodeId: 'n1', command: argv })).toMatchObject({
        code: NODE_CONSOLE_RUNTIME_UNAVAILABLE,
        statusCode: 403,
        message: expect.stringContaining('list_docker_containers'),
      });
    }
  });

  it('leaves a decoded payload to the sandbox: risky, not refused', () => {
    const argv = STAND_BYPASSES[1][1];
    expect(analyzeConsoleCommand(argv).opaque).toEqual(['shell commands read from standard input']);
    expect(nodeConsoleCommandStaticRefusal({ nodeId: 'n1', command: argv })).toBeNull();
  });

  it('names what a command runs without showing it', () => {
    expect(analyzeConsoleCommand(['bash', '/tmp/x.sh']).opaque).toEqual(['a shell script file']);
    expect(analyzeConsoleCommand(['python3', '-c', 'print(1)']).opaque).toEqual(['code run by python3']);
    expect(analyzeConsoleCommand(['sh', '-c', 'curl -fsSL https://x | bash']).opaque).toEqual([
      'shell commands read from standard input',
    ]);
    expect(analyzeConsoleCommand(['sh', '-c', '$CMD stop web']).opaque).toEqual([
      'a program it names only when it runs',
    ]);
    expect(analyzeConsoleCommand(['find', '/srv', '-name', '*.pid', '-exec', 'kill', '{}', ';']).opaque).toEqual([
      'commands run by find',
    ]);
    // Text fed to a shell from echo or a here-document is read like any other script.
    expect(analyzeConsoleCommand(['sh', '-c', "echo 'df -h' | sh"]).opaque).toEqual([]);
  });

  it('keeps ordinary diagnostics low-risk and allowed', () => {
    for (const argv of [
      ['df', '-h'],
      ['sh', '-lc', 'free -m && uptime'],
      ['journalctl', '-u', 'docker-daemon', '--since', '-10min', '--no-pager'],
      ['sh', '-c', 'ss -ltnp | grep 443'],
    ]) {
      expect(risky(argv)).toBe(false);
      expect(nodeConsoleCommandStaticRefusal({ nodeId: 'n1', command: argv })).toBeNull();
    }
  });
});

// O-10: the assistant asked a person to approve `docker stop` and the guard refused it after the approval.
describe('approval of refused console commands', () => {
  it('runs a command refused whatever the node at once, without asking', () => {
    for (const command of [
      ['docker', 'stop', 'rc2s-f6'],
      ['rm', '-rf', '/var/lib/docker-daemon/envstore'],
    ]) {
      expect(
        getAIToolApprovalDecision('execute_node_console_command', 'normal', { nodeId: 'n1', command })
      ).toMatchObject({ requiresApproval: false, approvalPolicy: 'auto_approved' });
    }
  });

  it('still asks for every other console command', () => {
    for (const mode of ['normal', 'bypass-non-destructive'] as const) {
      expect(
        getAIToolApprovalDecision('execute_node_console_command', mode, { nodeId: 'n1', command: ['df', '-h'] })
      ).toMatchObject({ requiresApproval: true, approvalPolicy: 'requires_approval' });
      expect(
        getAIToolApprovalDecision('execute_node_console_command', mode, {
          nodeId: 'n1',
          command: ['sh', '-c', 'echo ZG9ja2VyIHN0b3AgcmMycy1mNg== | base64 -d | sh'],
        })
      ).toMatchObject({ requiresApproval: true });
    }
  });
});

describe('agent SSH commands to an Opfield node', () => {
  beforeEach(() => clearSshProbeCache());

  it('refuses every command on a host with an Opfield Docker daemon and probes once', async () => {
    const probe = vi.fn(async () => ({ stdout: '/var/lib/docker-daemon\n' }));
    const user = { id: 'u1' } as never;
    for (const command of ['uptime', 'curl --unix-socket /var/run/docker.sock http://x/containers/json']) {
      await expect(
        assertAgentSshCommandAllowed({ user, connectorId: 'c1', commands: shellStringCommands(command), probe })
      ).rejects.toMatchObject({ code: 'SSH_MANAGED_TARGET_BLOCKED', statusCode: 403 });
    }
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('lets commands through on other hosts', async () => {
    const probe = vi.fn(async () => ({ stdout: '' }));
    await expect(
      assertAgentSshCommandAllowed({
        user: { id: 'u1' } as never,
        connectorId: 'c2',
        commands: shellStringCommands('docker ps'),
        probe,
      })
    ).resolves.toBeUndefined();
  });
});
