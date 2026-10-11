import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCodeIntegrationService } from './claude-code-integration.js';
import { CodexIntegrationService, type CommandRunner } from './codex-integration.js';
import { removeLegacyCodexUsageComponents } from './codex-usage-cleanup.js';
import { type CredentialStore, SecureCredentialStore } from './credentials.js';
import { CLI_VERSION } from './discovery.js';
import { CliError, errorPayload } from './errors.js';
import type { Fetch } from './http.js';
import { runInferenceMcp } from './inference-mcp.js';
import { type InferenceProxyDaemonManager, runInferenceProxyDaemon } from './inference-proxy-daemon.js';
import {
  type InteractiveCommandInput,
  runInteractiveHarnessSetupCommand,
  runInteractiveRootCommand,
} from './interactive-command.js';
import { runInteractiveLogin } from './interactive-login.js';
import { isAuthorizationRequired } from './interactive-setup.js';
import { createInteractiveCliUi, type InteractiveCliUi } from './interactive-ui.js';
import { loginCommand, loginWithInferenceTokenCommand, logoutCommand } from './login-command.js';
import { createOutput, type Output } from './output.js';
import { type CliPaths, resolveCliPaths } from './paths.js';
import { ProfileStore } from './profiles.js';
import { authenticatedSetupClient } from './session.js';
import { type InferenceStartupManager, inferenceStartupManager } from './startup.js';

interface ParsedArgs {
  command: string[];
  home?: string;
  token?: string;
  url?: string;
  startup?: boolean;
}

interface CliDependencies {
  paths?: CliPaths;
  profiles?: ProfileStore;
  credentials?: CredentialStore;
  fetch?: Fetch;
  output?: Output;
  interactive?: boolean;
  openBrowser?: (url: string) => Promise<void>;
  commandRunner?: CommandRunner;
  runtimeSource?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  interactiveUi?: InteractiveCliUi;
  proxyDaemon?: InferenceProxyDaemonManager;
  startupManager?: InferenceStartupManager;
}

const CONNECTION_NAME = 'default';

const HELP = `Usage: npx @sqgateway/inference [--home <path>] [--url <url>] [command]

Commands:
  login [URL]                      Authorize through OAuth or an existing gwi_ token
  logout                           Remove Opfield setup authorization
  setup [codex|claude-code]        Configure an inference harness
  startup install|uninstall|status Manage inference proxy startup

Running without a command opens the interactive manager.

Options:
  --home <path>                    Store all companion data under this directory
  --url <url>                      Use this Opfield URL without prompting
  --token <gwi_token>              Authenticate with an existing inference token
  --startup                        Install startup after setup codex
  -h, --help                       Show help
  -v, --version                    Show version`;

export function parseArgs(args: string[]): ParsedArgs {
  const command: string[] = [];
  let home: string | undefined;
  let token: string | undefined;
  let url: string | undefined;
  let startup = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === '--help' || value === '-h') return { command: ['help'] };
    if (value === '--version' || value === '-v') return { command: ['version'] };
    if (value === '--home' || value.startsWith('--home=')) {
      if (home !== undefined) throw new CliError('INVALID_ARGUMENT', 'Option --home may be provided only once.');
      const candidate = value === '--home' ? args[++index] : value.slice('--home='.length);
      if (!candidate?.trim() || candidate.startsWith('-')) {
        throw new CliError('INVALID_ARGUMENT', 'Option --home requires a directory path.');
      }
      home = candidate.trim();
      continue;
    }
    if (value === '--token' || value.startsWith('--token=')) {
      if (token !== undefined) throw new CliError('INVALID_ARGUMENT', 'Option --token may be provided only once.');
      const candidate = value === '--token' ? args[++index] : value.slice('--token='.length);
      if (!candidate?.trim() || candidate.startsWith('-')) {
        throw new CliError('INVALID_ARGUMENT', 'Option --token requires a value.');
      }
      token = candidate.trim();
      continue;
    }
    if (value === '--url' || value.startsWith('--url=')) {
      if (url !== undefined) throw new CliError('INVALID_ARGUMENT', 'Option --url may be provided only once.');
      const candidate = value === '--url' ? args[++index] : value.slice('--url='.length);
      if (!candidate?.trim() || candidate.startsWith('-')) {
        throw new CliError('INVALID_ARGUMENT', 'Option --url requires an Opfield URL.');
      }
      url = candidate.trim();
      continue;
    }
    if (value === '--startup') {
      if (startup) throw new CliError('INVALID_ARGUMENT', 'Option --startup may be provided only once.');
      startup = true;
      continue;
    }
    if (value.startsWith('-')) throw new CliError('INVALID_ARGUMENT', `Unknown option: ${value}`);
    command.push(value);
  }
  if (token && command[0] !== 'login') {
    throw new CliError('INVALID_ARGUMENT', 'Option --token is supported only with the login command.');
  }
  if (url && command[0] && command[0] !== 'login' && command[0] !== 'setup') {
    throw new CliError('INVALID_ARGUMENT', 'Option --url is supported with login, setup, or interactive mode.');
  }
  if (url && command[0] === 'login' && command[1]) {
    throw new CliError('INVALID_ARGUMENT', 'Provide the Opfield URL either positionally or with --url, not both.');
  }
  if (startup && (command[0] !== 'setup' || command[1] !== 'codex')) {
    throw new CliError('INVALID_ARGUMENT', 'Option --startup is supported only with setup codex.');
  }
  return {
    command,
    ...(home ? { home } : {}),
    ...(token ? { token } : {}),
    ...(url ? { url } : {}),
    ...(startup ? { startup: true } : {}),
  };
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const output = dependencies.output ?? createOutput(false);
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    const payload = errorPayload(error);
    output.write(payload, () => `Error [${payload.error.code}]: ${payload.error.message}`);
    return error instanceof CliError ? error.exitCode : 1;
  }
  const paths =
    dependencies.paths ??
    resolveCliPaths(dependencies.env ?? process.env, process.platform, dependencies.home, parsed.home);
  const profiles = dependencies.profiles ?? new ProfileStore(paths.profilesFile);
  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const interactiveUi = dependencies.interactiveUi ?? (interactive ? createInteractiveCliUi() : undefined);
  const credentials =
    dependencies.credentials ??
    SecureCredentialStore.forPlatform(paths.fileCredentialsFile, paths.dataDir, {
      allowFileCredentials: Boolean(paths.homeDir),
      preferFileCredentials: Boolean(paths.homeDir),
      interactive: interactive && process.platform !== 'darwin',
      confirmFileFallback: interactiveUi
        ? async () =>
            (await interactiveUi.confirm(
              `No OS credential store is available. Store credentials in ${paths.fileCredentialsFile} with mode 0600?`
            )) === true
        : undefined,
    });
  const input = interactiveCommandInput(
    paths,
    profiles,
    credentials,
    {
      ...dependencies,
      interactiveUi,
    },
    parsed.url
  );
  const privateRuntime = parsed.command[0]?.startsWith('__') ?? false;

  try {
    if (parsed.command[0] === 'help') {
      output.write({ help: HELP }, () => HELP);
      return 0;
    }
    if (parsed.command[0] === 'version') {
      output.write({ version: CLI_VERSION }, () => CLI_VERSION);
      return 0;
    }
    if (parsed.command[0] === '__mcp' && parsed.command.length === 1) {
      await runInferenceMcp({
        profileName: CONNECTION_NAME,
        paths,
        profiles,
        credentials,
        fetch: dependencies.fetch,
      });
      return 0;
    }
    if (parsed.command[0] === '__proxy' && parsed.command.length === 1) {
      await runInferenceProxyDaemon({
        profileName: CONNECTION_NAME,
        paths,
        credentials,
      });
      return 0;
    }
    if (parsed.command[0] === '__credential' && parsed.command[1] === 'claude-code' && parsed.command.length === 2) {
      const runtime = await credentials.getRuntime(CONNECTION_NAME, 'claude-code');
      if (!runtime) {
        throw new CliError('RUNTIME_TOKEN_MISSING', 'Claude Code runtime token is missing. Run setup claude-code.', {
          exitCode: 2,
        });
      }
      process.stdout.write(`${runtime.token}\n`);
      return 0;
    }
    if (parsed.command.length === 0) {
      if (!interactive) {
        throw new CliError(
          'INTERACTIVE_TTY_REQUIRED',
          'Interactive mode requires a TTY. Use login GATEWAY, logout, or setup HARNESS.'
        );
      }
      return await runInteractiveRootCommand(input);
    }
    if (parsed.command[0] === 'login') {
      if (parsed.command.length > 2) throw new CliError('INVALID_ARGUMENT', 'Usage: login [GATEWAY]');
      let gateway: string | undefined = parsed.url ?? parsed.command[1];
      if (!gateway && interactive) {
        input.ui.intro('Opfield Inference · Login');
        gateway = (await input.ui.gatewayOrigin()) ?? undefined;
        if (!gateway) {
          input.ui.cancel('Login cancelled.');
          return 0;
        }
      }
      if (!gateway) {
        throw new CliError('GATEWAY_REQUIRED', 'Provide an Opfield URL or run login in an interactive terminal.');
      }
      if (parsed.token) {
        await loginWithInferenceTokenCommand(
          { gateway, token: parsed.token },
          CONNECTION_NAME,
          profiles,
          credentials,
          output,
          dependencies.fetch
        );
      } else if (interactive) {
        const completed = await runInteractiveLogin({
          gateway,
          profileName: CONNECTION_NAME,
          profiles,
          credentials,
          output,
          ui: input.ui,
          fetch: dependencies.fetch,
          openBrowser: dependencies.openBrowser,
        });
        if (!completed) return 0;
      } else {
        await loginCommand(
          { gateway, command: ['login'] },
          CONNECTION_NAME,
          profiles,
          credentials,
          output,
          dependencies.fetch,
          dependencies.openBrowser
        );
      }
      return 0;
    }
    if (parsed.command[0] === 'logout') {
      if (parsed.command.length !== 1) throw new CliError('INVALID_ARGUMENT', 'Usage: logout');
      await logoutCommand(CONNECTION_NAME, profiles, credentials, output, dependencies.fetch);
      return 0;
    }
    if (parsed.command[0] === 'startup') {
      if (parsed.command.length !== 2 || !['install', 'uninstall', 'status'].includes(parsed.command[1]!)) {
        throw new CliError('INVALID_ARGUMENT', 'Usage: startup install|uninstall|status');
      }
      const manager = dependencies.startupManager ?? inferenceStartupManager;
      const startupInput = {
        paths,
        profileName: CONNECTION_NAME,
        env: dependencies.env,
        home: dependencies.home,
      };
      const status =
        parsed.command[1] === 'install'
          ? await manager.install(startupInput)
          : parsed.command[1] === 'uninstall'
            ? await manager.uninstall(startupInput)
            : await manager.status(startupInput);
      output.write({ ok: status.supported, ...status }, () =>
        !status.supported
          ? 'Automatic startup is supported on macOS and Linux.'
          : `Startup ${status.installed ? (status.active ? 'is installed and running' : 'is installed') : 'is not installed'}.`
      );
      return status.supported ? 0 : 2;
    }
    if (parsed.command[0] === 'uninstall' && parsed.command[1] === 'codex-usage') {
      if (parsed.command.length > 3) {
        throw new CliError('INVALID_ARGUMENT', 'Usage: uninstall codex-usage [desktop|cli|all]');
      }
      const target = parsed.command[2] ?? 'all';
      if (target !== 'desktop' && target !== 'cli' && target !== 'all') {
        throw new CliError('INVALID_ARGUMENT', 'Usage: uninstall codex-usage [desktop|cli|all]');
      }
      const result = await removeLegacyCodexUsageComponents(paths, {
        target,
        platform: process.platform,
        commandRunner: dependencies.commandRunner,
        env: dependencies.env,
        home: dependencies.home,
      });
      output.write({ ok: true, ...result }, () => `Removed legacy Codex usage components: ${target}.`);
      return 0;
    }
    if (parsed.command[0] === 'setup') {
      if (parsed.command.length > 2) throw new CliError('INVALID_ARGUMENT', 'Usage: setup [HARNESS]');
      const harness = parsed.command[1];
      if (!harness) {
        if (!interactive) {
          throw new CliError(
            'HARNESS_REQUIRED',
            'Interactive setup requires a TTY. For automation, use: setup codex or setup claude-code'
          );
        }
        return await runInteractiveHarnessSetupCommand(input);
      }
      if (harness !== 'codex' && harness !== 'claude-code') {
        throw new CliError('UNSUPPORTED_HARNESS', `Harness ${harness} is not supported by this CLI version.`);
      }
      return harness === 'codex'
        ? await setupCodexCommand(
            input,
            paths,
            profiles,
            credentials,
            output,
            interactive,
            dependencies,
            parsed.url,
            parsed.startup
          )
        : await setupClaudeCodeCommand(
            input,
            paths,
            profiles,
            credentials,
            output,
            interactive,
            dependencies,
            parsed.url
          );
    }
    throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${parsed.command.join(' ')}`);
  } catch (error) {
    const payload = errorPayload(error);
    const message = `Error [${payload.error.code}]: ${payload.error.message}`;
    if (privateRuntime) {
      process.stderr.write(`${message}\n`);
      return error instanceof CliError ? error.exitCode : 1;
    }
    if (interactive && interactiveUi && !output.json) {
      interactiveUi.error(message);
    } else {
      output.write(payload, () => message);
    }
    return error instanceof CliError ? error.exitCode : 1;
  }
}

async function setupClaudeCodeCommand(
  input: InteractiveCommandInput,
  paths: CliPaths,
  profiles: ProfileStore,
  credentials: CredentialStore,
  output: Output,
  interactive: boolean,
  dependencies: CliDependencies,
  gateway?: string
): Promise<number> {
  const context = await setupContext(input, profiles, credentials, output, interactive, dependencies, gateway);
  const result = await createClaudeCodeIntegration(paths, credentials, dependencies).setup({
    profileName: CONNECTION_NAME,
    profile: context.profile,
    discovery: context.discovery,
    client: context.client,
  });
  output.write({ ok: true, ...result }, () =>
    [
      `Configured Claude Code ${result.claudeCodeVersion}.`,
      `Models: ${result.modelCount}; default: ${result.defaultModel}.`,
      'Restart Claude Code to load Opfield models.',
      `Config: ${result.configFile}`,
    ].join('\n')
  );
  return 0;
}

async function setupCodexCommand(
  input: InteractiveCommandInput,
  paths: CliPaths,
  profiles: ProfileStore,
  credentials: CredentialStore,
  output: Output,
  interactive: boolean,
  dependencies: CliDependencies,
  gateway?: string,
  installStartup = false
): Promise<number> {
  await removeLegacyCodexUsageComponents(paths, {
    platform: process.platform,
    commandRunner: dependencies.commandRunner,
    env: dependencies.env,
    home: dependencies.home,
  });
  const context = await setupContext(input, profiles, credentials, output, interactive, dependencies, gateway);
  const result = await createIntegration(paths, credentials, dependencies).setup({
    profileName: CONNECTION_NAME,
    profile: context.profile,
    discovery: context.discovery,
    client: context.client,
  });
  if (installStartup) {
    await (dependencies.startupManager ?? inferenceStartupManager).install({
      paths,
      profileName: CONNECTION_NAME,
      env: dependencies.env,
      home: dependencies.home,
    });
  }
  output.write({ ok: true, ...result }, () =>
    [
      `Configured Codex ${result.codexVersion}.`,
      `Models: ${result.catalog.modelCount}; default: ${result.defaultModel}.`,
      ...(result.warning ? [`Warning: ${result.warning}`] : []),
      'Fully quit and reopen Codex to load the current model catalog.',
      `Config: ${result.configFile}`,
      ...(installStartup ? ['Startup: installed.'] : []),
    ].join('\n')
  );
  return 0;
}

async function setupContext(
  input: InteractiveCommandInput,
  profiles: ProfileStore,
  credentials: CredentialStore,
  output: Output,
  interactive: boolean,
  dependencies: CliDependencies,
  gateway?: string
) {
  let profile = await profiles.get(CONNECTION_NAME);
  let context: Awaited<ReturnType<typeof authenticatedSetupClient>>;
  if (gateway && profile?.origin !== gateway) {
    await loginCommand(
      { gateway, command: ['login'] },
      CONNECTION_NAME,
      profiles,
      credentials,
      output,
      dependencies.fetch,
      dependencies.openBrowser
    );
    profile = await profiles.getRequired(CONNECTION_NAME);
  }
  try {
    context = await authenticatedSetupClient(CONNECTION_NAME, profiles, credentials, dependencies.fetch);
  } catch (error) {
    if (!isAuthorizationRequired(error)) throw error;
    let selectedGateway = gateway ?? profile?.origin;
    if (!selectedGateway && interactive) selectedGateway = (await input.ui.gatewayOrigin()) ?? undefined;
    if (!selectedGateway) {
      throw new CliError('GATEWAY_REQUIRED', 'Log in first or run this command in a TTY to enter the Opfield URL.');
    }
    await loginCommand(
      { gateway: selectedGateway, command: ['login'] },
      CONNECTION_NAME,
      profiles,
      credentials,
      output,
      dependencies.fetch,
      dependencies.openBrowser
    );
    profile = await profiles.getRequired(CONNECTION_NAME);
    context = await authenticatedSetupClient(CONNECTION_NAME, profiles, credentials, dependencies.fetch);
  }
  profile ??= await profiles.getRequired(CONNECTION_NAME);
  await context.client.me();
  return { ...context, profile };
}

function createIntegration(paths: CliPaths, credentials: CredentialStore, dependencies: CliDependencies) {
  return new CodexIntegrationService(paths, credentials, {
    fetch: dependencies.fetch,
    commandRunner: dependencies.commandRunner,
    runtimeSource: dependencies.runtimeSource,
    env: dependencies.env,
    home: dependencies.home,
    proxyDaemon: dependencies.proxyDaemon,
  });
}

function createClaudeCodeIntegration(paths: CliPaths, credentials: CredentialStore, dependencies: CliDependencies) {
  return new ClaudeCodeIntegrationService(paths, credentials, {
    fetch: dependencies.fetch,
    commandRunner: dependencies.commandRunner,
    runtimeSource: dependencies.runtimeSource,
    env: dependencies.env,
    home: dependencies.home,
  });
}

function interactiveCommandInput(
  paths: CliPaths,
  profiles: ProfileStore,
  credentials: CredentialStore,
  dependencies: CliDependencies,
  gateway?: string
): InteractiveCommandInput {
  return {
    profileName: CONNECTION_NAME,
    paths,
    profiles,
    credentials,
    ui: dependencies.interactiveUi ?? createInteractiveCliUi(),
    fetch: dependencies.fetch,
    openBrowser: dependencies.openBrowser,
    commandRunner: dependencies.commandRunner,
    runtimeSource: dependencies.runtimeSource,
    env: dependencies.env,
    home: dependencies.home,
    proxyDaemon: dependencies.proxyDaemon,
    startupManager: dependencies.startupManager,
    gateway,
  };
}

export function isDirectCliInvocation(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  if (['gateway-inference', 'gateway-inference.cmd'].includes(basename(argvEntry))) return true;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry);
  } catch {
    return fileURLToPath(moduleUrl) === argvEntry;
  }
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2));
}
