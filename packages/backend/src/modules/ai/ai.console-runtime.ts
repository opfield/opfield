import { AppError } from '@/middleware/error-handler.js';
import { commandText, type EffectiveCommand } from './ai.console-commands.js';
import { consoleMutations } from './ai.console-docker-mutations.js';
import { commandBaseName } from './ai.console-shell.js';

/**
 * Agents' node console commands run in the daemon's agent sandbox (packages/daemons/shared/exec/agent_sandbox.go):
 * root (or console.user) in their own mount namespace and process group, with the container runtime's sockets and
 * CLIs covered, so they do not reach Docker, containerd, Podman or CRI-O by accident. It is not a security boundary:
 * root can leave the namespace on purpose. A command that visibly uses the runtime is refused up front, so the agent
 * gets the tool to use instead of a socket error.
 */
export const NODE_CONSOLE_RUNTIME_UNAVAILABLE = 'NODE_CONSOLE_RUNTIME_UNAVAILABLE';

const RUNTIME_PROGRAMS = new Set([
  'docker',
  'dockerd',
  'docker-compose',
  'com.docker.cli',
  'podman',
  'podman-compose',
  'nerdctl',
  'ctr',
  'crictl',
  'containerd',
  'containerd-ctr',
  'runc',
  'crun',
  'buildctl',
  'kubectl',
  'k3s',
]);

/** A runtime socket or state directory named anywhere in a command (curl --unix-socket, socat, nc -U, ...). */
const RUNTIME_PATH =
  /(?:^|[^A-Za-z0-9_-])(?:docker|dockershim|containerd|podman|crio|cri-dockerd|k3s)(?:[-.][A-Za-z0-9_-]+)*\.sock\b|\/run\/(?:docker|containerd|podman|crio|k3s)(?:\/|$)|\/var\/lib\/(?:docker|containerd)(?:\/|$)/i;

/**
 * Read-only programs that only look at a path: naming the Docker data directory or a runtime socket with them is a
 * disk or file check (df -h /var/lib/docker, ls -l /var/run/docker.sock), not a use of the runtime, and it runs
 * harmlessly in the sandbox (rc.3 GO-5).
 */
const PATH_READING_PROGRAMS = new Set([
  'df',
  'du',
  'findmnt',
  'ls',
  'stat',
  'lsblk',
  'readlink',
  'realpath',
  'file',
  'tree',
  'mountpoint',
  'test',
  '[',
]);

/** The first program of a console command that uses the container runtime, or null. */
export function containerRuntimeCommand(commands: readonly EffectiveCommand[]): EffectiveCommand | null {
  for (const command of commands) {
    const program = commandBaseName(command.argv[0]);
    if (RUNTIME_PROGRAMS.has(program)) return command;
    if (PATH_READING_PROGRAMS.has(program) && command.writes.length === 0) continue;
    const texts = [
      ...command.argv.map((word) => word.text),
      ...command.writes.map((word) => word.text),
      ...Object.values(command.env),
    ];
    if (texts.some((text) => RUNTIME_PATH.test(text))) return command;
  }
  return null;
}

export function nodeConsoleRuntimeError(command: EffectiveCommand): AppError {
  const text = commandText(command);
  const shown = text.length > 200 ? `${text.slice(0, 200)}...` : text;
  return new AppError(
    403,
    NODE_CONSOLE_RUNTIME_UNAVAILABLE,
    `Refused "${shown}": the agent console sandbox keeps ordinary use of the container runtime (Docker, ` +
      'containerd, Podman, CRI-O and their sockets) out of the console. It is an accident guard, not a security ' +
      'boundary against a determined root process, so do not look for another way in. Use the Docker tools: ' +
      'list_docker_containers, get_docker_container, get_docker_container_logs, get_docker_container_stats, ' +
      'list_docker_images, list_docker_volumes, list_docker_networks, execute_docker_container_console_command, and ' +
      'the manage_docker_* tools for changes. Disk use of the Docker data directory: df, du, findmnt and ls of it ' +
      'work in the console, and get_node shows its mount (diskMounts, role docker_root). A person can use the ' +
      'browser console of the node.',
    { command: shown }
  );
}

/**
 * Whether a console command needs a person's attention before it runs: it matches a risky pattern, changes Docker
 * objects or daemon state, uses the container runtime, or runs code its command line does not show (a decoded
 * payload piped to a shell, a script file, an interpreter).
 */
export function consoleCommandRisky(
  patternRisky: boolean,
  analysis: { commands: readonly EffectiveCommand[]; opaque: readonly string[] }
): boolean {
  return (
    patternRisky ||
    analysis.opaque.length > 0 ||
    consoleMutations(analysis.commands).length > 0 ||
    containerRuntimeCommand(analysis.commands) !== null ||
    analysis.commands.some(leavesOrProbesTheSandbox)
  );
}

/**
 * A unix socket named by a client (curl --unix-socket, socat UNIX-CONNECT, nc -U), whatever its path's spelling
 * (rc.3 GO-6). Namespace tools (nsenter, unshare, chroot, systemd-run) are risky by pattern (ai.console-safety.ts):
 * the analysis takes them off as wrappers.
 */
const UNIX_SOCKET_CLIENT = /^--unix-socket(?:=|$)|^(?:unix-connect|unix-client|unix):/i;
const UNIX_SOCKET_FLAG_PROGRAMS = new Set(['nc', 'ncat', 'netcat', 'socat']);

function leavesOrProbesTheSandbox(command: EffectiveCommand): boolean {
  const program = commandBaseName(command.argv[0]);
  return command.argv.some(
    (word) => UNIX_SOCKET_CLIENT.test(word.text) || (UNIX_SOCKET_FLAG_PROGRAMS.has(program) && word.text === '-U')
  );
}
