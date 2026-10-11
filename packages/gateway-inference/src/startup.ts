import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inspectCodexConfiguration, resolveCodexPaths } from './codex-config.js';
import { type CommandRunner, runCommand } from './codex-integration.js';
import { CliError } from './errors.js';
import type { CliPaths } from './paths.js';

const MACOS_LABEL = 'com.wiolett.gateway-inference';
const LINUX_UNIT = 'wiolett-gateway-inference.service';

export interface StartupStatus {
  supported: boolean;
  installed: boolean;
  active: boolean;
  path?: string;
}

export interface StartupInput {
  paths: CliPaths;
  profileName: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface InferenceStartupManager {
  status(input: StartupInput): Promise<StartupStatus>;
  install(input: StartupInput): Promise<StartupStatus>;
  uninstall(input: StartupInput): Promise<StartupStatus>;
}

interface StartupOptions {
  platform?: NodeJS.Platform;
  nodePath?: string;
  uid?: number;
  commandRunner?: CommandRunner;
  isCodexConfigured?: (input: StartupInput) => Promise<boolean>;
}

export function createInferenceStartupManager(options: StartupOptions = {}): InferenceStartupManager {
  const platform = options.platform ?? process.platform;
  const commandRunner = options.commandRunner ?? runCommand;
  const nodePath = options.nodePath ?? process.execPath;
  const uid = options.uid ?? process.getuid?.();
  const isCodexConfigured =
    options.isCodexConfigured ??
    (async (input: StartupInput) =>
      (
        await inspectCodexConfiguration({
          paths: resolveCodexPaths(input.paths, input.profileName, input.env, input.home),
          profile: input.profileName,
        })
      ).configured);

  return {
    status: (input) => startupStatus(input, { platform, commandRunner, uid }),
    install: (input) => installStartup(input, { platform, commandRunner, nodePath, uid, isCodexConfigured }),
    uninstall: (input) => uninstallStartup(input, { platform, commandRunner, uid }),
  };
}

export const inferenceStartupManager = createInferenceStartupManager();

async function startupStatus(
  input: StartupInput,
  options: { platform: NodeJS.Platform; commandRunner: CommandRunner; uid?: number }
): Promise<StartupStatus> {
  const registration = resolveRegistration(input, options.platform);
  if (!registration) return { supported: false, installed: false, active: false };
  if (!(await exists(registration.path))) {
    return { supported: true, installed: false, active: false, path: registration.path };
  }
  const result =
    options.platform === 'darwin'
      ? await options.commandRunner('launchctl', ['print', `${launchDomain(options.uid)}/${MACOS_LABEL}`], input.env)
      : await options.commandRunner('systemctl', ['--user', 'is-active', LINUX_UNIT], input.env);
  return { supported: true, installed: true, active: result.code === 0, path: registration.path };
}

async function installStartup(
  input: StartupInput,
  options: {
    platform: NodeJS.Platform;
    commandRunner: CommandRunner;
    nodePath: string;
    uid?: number;
    isCodexConfigured: (input: StartupInput) => Promise<boolean>;
  }
): Promise<StartupStatus> {
  const registration = requireRegistration(input, options.platform);
  if (!(await options.isCodexConfigured(input))) {
    throw new CliError('CODEX_NOT_CONFIGURED', 'Opfield inference is not configured. Run setup codex first.');
  }
  if (!(await exists(input.paths.runtimeFile))) {
    throw new CliError('RUNTIME_NOT_INSTALLED', 'Opfield inference is not configured. Run setup codex first.');
  }
  await mkdir(registration.directory, { recursive: true });
  await mkdir(input.paths.runtimeDir, { recursive: true });
  const args = [input.paths.runtimeFile, ...(input.paths.homeDir ? ['--home', input.paths.homeDir] : []), '__proxy'];

  if (options.platform === 'darwin') {
    await options.commandRunner('launchctl', ['bootout', launchDomain(options.uid), registration.path], input.env);
    await writeFile(registration.path, macosPlist(options.nodePath, args, input.paths.runtimeDir), { mode: 0o600 });
    const result = await options.commandRunner(
      'launchctl',
      ['bootstrap', launchDomain(options.uid), registration.path],
      input.env
    );
    assertCommand(result, 'Could not install the macOS startup agent.');
  } else {
    await writeFile(registration.path, linuxUnit(options.nodePath, args), { mode: 0o600 });
    assertCommand(
      await options.commandRunner('systemctl', ['--user', 'daemon-reload'], input.env),
      'Could not reload systemd user services.'
    );
    assertCommand(
      await options.commandRunner('systemctl', ['--user', 'enable', '--now', LINUX_UNIT], input.env),
      'Could not enable the Opfield inference startup service.'
    );
  }
  return startupStatus(input, options);
}

async function uninstallStartup(
  input: StartupInput,
  options: { platform: NodeJS.Platform; commandRunner: CommandRunner; uid?: number }
): Promise<StartupStatus> {
  const registration = requireRegistration(input, options.platform);
  if (options.platform === 'darwin') {
    await options.commandRunner('launchctl', ['bootout', launchDomain(options.uid), registration.path], input.env);
  } else {
    await options.commandRunner('systemctl', ['--user', 'disable', '--now', LINUX_UNIT], input.env);
  }
  await rm(registration.path, { force: true });
  if (options.platform !== 'darwin') {
    await options.commandRunner('systemctl', ['--user', 'daemon-reload'], input.env);
  }
  return { supported: true, installed: false, active: false, path: registration.path };
}

function resolveRegistration(input: StartupInput, platform: NodeJS.Platform) {
  const userHome = input.home ?? homedir();
  if (platform === 'darwin') {
    const directory = join(userHome, 'Library', 'LaunchAgents');
    return { directory, path: join(directory, `${MACOS_LABEL}.plist`) };
  }
  if (platform === 'linux') {
    const directory = join(input.env?.XDG_CONFIG_HOME || join(userHome, '.config'), 'systemd', 'user');
    return { directory, path: join(directory, LINUX_UNIT) };
  }
  return null;
}

function requireRegistration(input: StartupInput, platform: NodeJS.Platform) {
  const registration = resolveRegistration(input, platform);
  if (!registration) {
    throw new CliError('STARTUP_UNSUPPORTED', 'Automatic startup is supported on macOS and Linux.');
  }
  return registration;
}

function launchDomain(uid?: number): string {
  if (uid === undefined) throw new CliError('STARTUP_UID_UNAVAILABLE', 'Could not determine the current macOS user.');
  return `gui/${uid}`;
}

function macosPlist(nodePath: string, args: string[], runtimeDir: string): string {
  const programArguments = [nodePath, ...args].map((value) => `      <string>${escapeXml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${MACOS_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(join(runtimeDir, 'startup.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(join(runtimeDir, 'startup-error.log'))}</string>
  </dict>
</plist>
`;
}

function linuxUnit(nodePath: string, args: string[]): string {
  return `[Unit]
Description=Opfield Inference proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${[nodePath, ...args].map(systemdQuote).join(' ')}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function assertCommand(result: Awaited<ReturnType<CommandRunner>>, message: string): void {
  if (result.code !== 0) {
    throw new CliError('STARTUP_INSTALL_FAILED', `${message}${result.stderr ? ` ${result.stderr}` : ''}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
