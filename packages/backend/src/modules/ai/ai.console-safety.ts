const MAX_CONSOLE_COMMAND_ARGS = 64;
const MAX_CONSOLE_COMMAND_ARG_BYTES = 16 * 1024;

const RISKY_COMMAND_RE =
  /(^|[;&|()`\s])(?:rm|rmdir|mv|dd|mkfs(?:\.[a-z0-9]+)?|fdisk|parted|mount|umount|chmod|chown|chattr|iptables|nft|ufw|firewall-cmd|systemctl|service|docker|podman|kill|killall|pkill|reboot|shutdown|halt|poweroff|restart|nsenter|unshare|chroot|pivot_root|systemd-run|machinectl)(?=$|[;&|()`\s])/i;

const CATASTROPHIC_COMMAND_RE = [
  /(^|[;&|()`\s])rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+|--recursive\s+|--force\s+){1,}(?:--no-preserve-root\s+)?\/(?:\s|$|[;&|()`])/i,
  /(^|[;&|()`\s])rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+|--recursive\s+|--force\s+){1,}(?:--no-preserve-root\s+)?\/\*(?:\s|$|[;&|()`])/i,
  /(^|[;&|()`\s])dd\s+[^;&|`]*\bof=\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d+n\d+|mmcblk\d+)\b/i,
  /(^|[;&|()`\s])mkfs(?:\.[a-z0-9]+)?\s+[^;&|`]*\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d+n\d+|mmcblk\d+)\b/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
];

export interface ConsoleCommandSafety {
  normalizedCommand: string[];
  commandText: string;
  risky: boolean;
  blocked: boolean;
  reason?: string;
}

export interface ConsoleCommandResult {
  stdout: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
  /** The command was stopped at its time limit; the output is what it wrote until then. */
  timedOut?: boolean;
  /** Agent node console commands (daemons of 2.12.3 and later): the OS user the command ran as. */
  runAs?: string;
  /** How it was sandboxed: root, user_namespace or daemon_user (a daemon that does not run as root). */
  sandbox?: string;
  /** What running without root limits, as a sentence; absent for root. */
  limits?: string;
}

export function normalizeConsoleCommand(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('command must be an array of strings');
  }
  if (value.length === 0) {
    throw new Error('command is required');
  }
  if (value.length > MAX_CONSOLE_COMMAND_ARGS) {
    throw new Error(`command has too many arguments. Maximum is ${MAX_CONSOLE_COMMAND_ARGS}.`);
  }
  return value.map((part, index) => {
    if (typeof part !== 'string') {
      throw new Error(`command argument ${index} must be a string`);
    }
    if (!part.trim()) {
      throw new Error(`command argument ${index} must not be empty`);
    }
    if (Buffer.byteLength(part, 'utf8') > MAX_CONSOLE_COMMAND_ARG_BYTES) {
      throw new Error(`command argument ${index} is too large`);
    }
    return part;
  });
}

export function inspectConsoleCommand(command: string[]): ConsoleCommandSafety {
  const normalizedCommand = normalizeConsoleCommand(command);
  const commandText = normalizedCommand.join(' ');
  const blocked = CATASTROPHIC_COMMAND_RE.some((pattern) => pattern.test(commandText));

  return {
    normalizedCommand,
    commandText,
    risky: blocked || RISKY_COMMAND_RE.test(commandText),
    blocked,
    reason: blocked
      ? 'This command is blocked because it matches a destructive host/container breaking pattern.'
      : undefined,
  };
}

export function parseConsoleCommandResult(detail: string | undefined): ConsoleCommandResult {
  if (!detail) return { stdout: '' };
  try {
    const value = JSON.parse(detail) as Partial<ConsoleCommandResult>;
    return {
      stdout: typeof value.stdout === 'string' ? value.stdout : detail,
      stderr: typeof value.stderr === 'string' ? value.stderr : undefined,
      exitCode: typeof value.exitCode === 'number' ? value.exitCode : undefined,
      truncated: value.truncated === true,
      ...(value.timedOut === true ? { timedOut: true } : {}),
      ...(typeof value.runAs === 'string' && value.runAs ? { runAs: value.runAs } : {}),
      ...(typeof value.sandbox === 'string' && value.sandbox ? { sandbox: value.sandbox } : {}),
      ...(typeof value.limits === 'string' && value.limits ? { limits: value.limits } : {}),
    };
  } catch {
    return { stdout: detail };
  }
}
