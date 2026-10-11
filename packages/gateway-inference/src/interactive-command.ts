import { inspectClaudeCodeConfiguration, resolveClaudeCodePaths } from './claude-code-config.js';
import { ClaudeCodeIntegrationService } from './claude-code-integration.js';
import { readVisibleCatalogModels } from './codex-catalog.js';
import { inspectCodexConfiguration, resolveCodexPaths } from './codex-config.js';
import { CodexIntegrationService, type CommandRunner } from './codex-integration.js';
import { removeLegacyCodexUsageComponents } from './codex-usage-cleanup.js';
import type { CredentialStore } from './credentials.js';
import { CliError, errorPayload } from './errors.js';
import type { Fetch } from './http.js';
import type { InferenceProxyDaemonManager } from './inference-proxy-daemon.js';
import { runInteractiveLogin } from './interactive-login.js';
import { isAuthorizationRequired, runInteractiveInferenceSetup } from './interactive-setup.js';
import type { InteractiveCliUi, InteractiveOption } from './interactive-ui.js';
import { logoutCommand } from './login-command.js';
import type { Output } from './output.js';
import type { CliPaths } from './paths.js';
import type { ProfileStore } from './profiles.js';
import { authenticatedSetupClient } from './session.js';
import { type InferenceStartupManager, inferenceStartupManager, type StartupStatus } from './startup.js';
import type { InferenceSetupClient } from './tokens.js';
import type { InferenceDiscovery, SetupIdentity } from './types.js';

export interface InteractiveCommandInput {
  profileName: string;
  paths: CliPaths;
  profiles: ProfileStore;
  credentials: CredentialStore;
  ui: InteractiveCliUi;
  fetch?: Fetch;
  openBrowser?: (url: string) => Promise<void>;
  commandRunner?: CommandRunner;
  runtimeSource?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  proxyDaemon?: InferenceProxyDaemonManager;
  startupManager?: InferenceStartupManager;
  gateway?: string;
}

interface InteractiveState {
  identity?: SetupIdentity;
  codexConfigured: boolean;
  claudeCodeConfigured: boolean;
  startup: StartupStatus;
  models: string[];
}

type InferenceAction =
  | 'authenticate'
  | 'setup'
  | 'sync'
  | 'doctor'
  | 'remove'
  | 'enable-startup'
  | 'disable-startup'
  | 'doctor-claude-code'
  | 'remove-claude-code'
  | 'logout';

export async function runInteractiveRootCommand(input: InteractiveCommandInput): Promise<number> {
  input.ui.intro('Opfield Inference');
  return runInteractiveInferenceCommand(input, false);
}

export async function runInteractiveInferenceCommand(
  input: InteractiveCommandInput,
  showIntro = true
): Promise<number> {
  if (showIntro) input.ui.intro('Opfield Inference');
  const codexIntegration = createIntegration(input);
  const claudeCodeIntegration = createClaudeCodeIntegration(input);
  const state = await loadInferenceMenuState(input);
  await showState(input, state);

  while (true) {
    const action = (await input.ui.select(
      'What do you want to do?',
      inferenceActions(state)
    )) as InferenceAction | null;
    if (!action) {
      input.ui.cancel('No action selected.');
      return 0;
    }

    if (action === 'authenticate') {
      const identity = await authenticate(input);
      if (!identity) return 0;
      state.identity = identity;
      showAccount(input.ui, identity);
      continue;
    }
    if (action === 'logout') {
      const blocked = logoutBlockedReason(state);
      if (blocked) {
        input.ui.error(blocked);
        continue;
      }
      return logout(input);
    }
    if (action === 'setup') return setupHarness(input, codexIntegration, claudeCodeIntegration);
    if (action === 'sync') {
      state.models = await syncModels(input, codexIntegration);
      continue;
    }
    if (action === 'doctor') {
      await diagnose(input, codexIntegration);
      continue;
    }
    if (action === 'enable-startup') {
      state.startup = await installStartup(input);
      continue;
    }
    if (action === 'disable-startup') {
      state.startup = await uninstallStartup(input);
      continue;
    }
    if (action === 'doctor-claude-code') {
      await diagnoseClaudeCode(input, claudeCodeIntegration);
      continue;
    }
    if (action === 'remove' && (await removeHarness(input, codexIntegration))) {
      state.codexConfigured = false;
      state.models = [];
      continue;
    }
    if (action === 'remove-claude-code' && (await removeClaudeCode(input, claudeCodeIntegration))) {
      state.claudeCodeConfigured = false;
    }
  }
}

export async function runInteractiveHarnessSetupCommand(input: InteractiveCommandInput): Promise<number> {
  input.ui.intro('Opfield Inference · Setup');
  return setupHarness(input, createIntegration(input), createClaudeCodeIntegration(input));
}

async function loadInferenceMenuState(input: InteractiveCommandInput): Promise<InteractiveState> {
  let identity: SetupIdentity | undefined;
  const profile = await input.profiles.get(input.profileName);
  if (profile) {
    try {
      const context = await authenticatedSetupClient(input.profileName, input.profiles, input.credentials, input.fetch);
      identity = await context.client.me();
    } catch (error) {
      if (!isAuthorizationRequired(error)) throw error;
    }
  }

  const paths = resolveCodexPaths(input.paths, input.profileName, input.env, input.home);
  const config = await inspectCodexConfiguration({ paths, profile: input.profileName });
  const models = config.configured ? await readVisibleCatalogModels(paths.catalogFile) : [];
  const claudeCode = await inspectClaudeCodeConfiguration({
    paths: resolveClaudeCodePaths(input.paths, input.profileName, input.env, input.home),
  });
  const startup = await (input.startupManager ?? inferenceStartupManager).status({
    paths: input.paths,
    profileName: input.profileName,
    env: input.env,
    home: input.home,
  });
  return {
    identity,
    codexConfigured: config.configured,
    claudeCodeConfigured: claudeCode.configured,
    startup,
    models,
  };
}

async function showState(input: InteractiveCommandInput, state: InteractiveState): Promise<void> {
  const profile = await input.profiles.get(input.profileName);
  if (profile) input.ui.info(`Opfield: ${profile.origin}`);
  if (state.identity) showAccount(input.ui, state.identity);
  input.ui.info(state.codexConfigured ? `Codex: configured · ${state.models.length} models` : 'Codex: not configured');
  input.ui.info(state.claudeCodeConfigured ? 'Claude Code: configured' : 'Claude Code: not configured');
  if (state.startup.supported) {
    input.ui.info(
      `Startup: ${state.startup.installed ? (state.startup.active ? 'enabled' : 'installed') : 'disabled'}`
    );
  }
}

function inferenceActions(state: InteractiveState): InteractiveOption[] {
  const options: InteractiveOption[] = [];
  if (!state.identity) {
    options.push({
      value: 'authenticate',
      label: 'Login',
      hint: 'Authorize this device through Opfield OAuth',
    });
  }
  options.push({
    value: 'setup',
    label: state.codexConfigured || state.claudeCodeConfigured ? 'Setup or repair harness' : 'Setup harness',
    hint: 'Configure a supported inference harness',
  });
  if (state.codexConfigured) {
    if (state.identity) {
      options.push({
        value: 'sync',
        label: 'Refresh models',
        hint: `${state.models.length} Codex models currently cached`,
      });
    }
    options.push(
      {
        value: 'doctor',
        label: 'Check Codex integration',
        hint: 'Diagnose Codex, credentials, configuration, and catalog',
      },
      {
        value: 'remove',
        label: 'Remove Codex integration',
        hint: 'Delete only package-managed configuration and credentials',
      }
    );
    if (state.startup.supported) {
      options.push(
        state.startup.installed
          ? {
              value: 'disable-startup',
              label: 'Disable automatic startup',
              hint: 'Stop launching the local inference proxy with your user session',
            }
          : {
              value: 'enable-startup',
              label: 'Enable automatic startup',
              hint: 'Launch the local inference proxy with your user session',
            }
      );
    }
  }
  if (state.claudeCodeConfigured) {
    options.push(
      {
        value: 'doctor-claude-code',
        label: 'Check Claude Code integration',
        hint: 'Diagnose Claude Code, credentials, configuration, and model discovery',
      },
      {
        value: 'remove-claude-code',
        label: 'Remove Claude Code integration',
        hint: 'Restore only package-managed Claude Code settings and credentials',
      }
    );
  }
  if (state.identity) {
    options.push({
      value: 'logout',
      label: 'Logout',
      hint: `Remove setup authorization for ${state.identity.user.email}`,
    });
  }
  return options;
}

function logoutBlockedReason(state: InteractiveState): string | null {
  const configured = [state.codexConfigured ? 'Codex' : null, state.claudeCodeConfigured ? 'Claude Code' : null].filter(
    (name): name is string => name !== null
  );
  if (configured.length === 0) return null;
  const names = configured.length === 1 ? configured[0] : `${configured[0]} and ${configured[1]}`;
  return `Remove the ${names} ${configured.length === 1 ? 'integration' : 'integrations'} before logging out.`;
}

async function authenticate(input: InteractiveCommandInput): Promise<SetupIdentity | null> {
  const existing = await input.profiles.get(input.profileName);
  const gateway = input.gateway ?? existing?.origin ?? (await input.ui.gatewayOrigin());
  if (!gateway) {
    input.ui.cancel('Login cancelled.');
    return null;
  }
  const completed = await runInteractiveLogin({
    gateway,
    profileName: input.profileName,
    profiles: input.profiles,
    credentials: input.credentials,
    output: SILENT_OUTPUT,
    ui: input.ui,
    fetch: input.fetch,
    openBrowser: input.openBrowser,
  });
  if (!completed) return null;
  const context = await authenticatedSetupClient(input.profileName, input.profiles, input.credentials, input.fetch);
  const identity = await context.client.me();
  input.ui.info('Opfield authorization complete');
  return identity;
}

function showAccount(ui: InteractiveCliUi, identity: SetupIdentity): void {
  const name = identity.user.name?.trim();
  ui.info(`Account: ${identity.user.email}${name ? ` (${name})` : ''} ${identity.user.role}`);
}

async function syncModels(input: InteractiveCommandInput, integration: CodexIntegrationService): Promise<string[]> {
  const spinner = input.ui.spinner('Refreshing Opfield models...');
  try {
    const context = await authenticatedSetupClient(input.profileName, input.profiles, input.credentials, input.fetch);
    const result = await integration.sync({ profileName: input.profileName, discovery: context.discovery });
    const paths = resolveCodexPaths(input.paths, input.profileName, input.env, input.home);
    const models = await readVisibleCatalogModels(paths.catalogFile);
    spinner.stop(`Model catalog ${result.status} · ${models.length} models`);
    return models;
  } catch (error) {
    spinner.error('Could not refresh the model catalog');
    throw error;
  }
}

async function diagnose(input: InteractiveCommandInput, integration: CodexIntegrationService): Promise<void> {
  let discovery: InferenceDiscovery | undefined;
  let setupCheck: { status: 'ok' | 'error' | 'warning'; message: string } | undefined;
  try {
    const context = await authenticatedSetupClient(input.profileName, input.profiles, input.credentials, input.fetch);
    await context.client.me();
    discovery = context.discovery;
    setupCheck = { status: 'ok', message: 'Opfield accepted the setup authorization' };
  } catch (error) {
    const offline = error instanceof CliError && ['NETWORK_ERROR', 'NETWORK_TIMEOUT'].includes(error.code);
    setupCheck = {
      status: offline ? 'warning' : 'error',
      message: `${offline ? 'Offline' : 'Setup authorization failed'}: ${errorPayload(error).error.message}`,
    };
  }
  const spinner = input.ui.spinner('Checking the Codex integration...');
  try {
    const report = await integration.doctor({ profileName: input.profileName, discovery, setupCheck });
    spinner.stop(report.ok ? 'Integration check complete' : 'Integration needs attention');
    for (const check of report.checks) {
      input.ui.info(`${check.status.toUpperCase()} · ${check.name}: ${check.message}`);
    }
  } catch (error) {
    spinner.error('Could not check the Codex integration');
    throw error;
  }
}

async function diagnoseClaudeCode(
  input: InteractiveCommandInput,
  integration: ClaudeCodeIntegrationService
): Promise<void> {
  let discovery: InferenceDiscovery | undefined;
  try {
    discovery = (await authenticatedSetupClient(input.profileName, input.profiles, input.credentials, input.fetch))
      .discovery;
  } catch (error) {
    const expected =
      isAuthorizationRequired(error) ||
      (error instanceof CliError && ['NETWORK_ERROR', 'NETWORK_TIMEOUT'].includes(error.code));
    if (!expected) throw error;
  }
  const spinner = input.ui.spinner('Checking the Claude Code integration...');
  try {
    const report = await integration.doctor({ profileName: input.profileName, discovery });
    spinner.stop(report.ok ? 'Integration check complete' : 'Integration needs attention');
    for (const check of report.checks) {
      input.ui.info(`${check.status.toUpperCase()} · ${check.name}: ${check.message}`);
    }
  } catch (error) {
    spinner.error('Could not check the Claude Code integration');
    throw error;
  }
}

async function removeHarness(input: InteractiveCommandInput, integration: CodexIntegrationService): Promise<boolean> {
  const confirmed = await input.ui.confirm('Remove the package-managed Codex integration from this device?');
  if (!confirmed) {
    if (confirmed === null) input.ui.cancel('Removal cancelled.');
    return false;
  }
  let client: InferenceSetupClient | undefined;
  try {
    client = (await authenticatedSetupClient(input.profileName, input.profiles, input.credentials, input.fetch)).client;
  } catch (error) {
    const expected =
      isAuthorizationRequired(error) ||
      (error instanceof CliError && ['NETWORK_ERROR', 'NETWORK_TIMEOUT'].includes(error.code));
    if (!expected) throw error;
  }
  const spinner = input.ui.spinner('Removing the Codex integration...');
  try {
    await removeLegacyCodexUsageComponents(input.paths, {
      platform: process.platform,
      commandRunner: input.commandRunner,
      env: input.env,
      home: input.home,
    });
    const result = await integration.remove({
      profileName: input.profileName,
      removeToken: Boolean(client),
      client,
    });
    if (!result.removed) {
      spinner.error('Codex integration was not removed');
      if (result.conflicts.length > 0) {
        input.ui.info(`Preserved conflicting configuration: ${result.conflicts.join(', ')}`);
      }
      return false;
    }
    const startupManager = input.startupManager ?? inferenceStartupManager;
    const startupInput = {
      paths: input.paths,
      profileName: input.profileName,
      env: input.env,
      home: input.home,
    };
    if ((await startupManager.status(startupInput)).installed) {
      await startupManager.uninstall(startupInput);
    }
    spinner.stop(result.tokenRevoked ? 'Codex integration and runtime token removed' : 'Codex integration removed');
    if (result.conflicts.length > 0) {
      input.ui.info(`Preserved edited configuration blocks: ${result.conflicts.join(', ')}`);
    }
    return result.removed;
  } catch (error) {
    spinner.error('Could not remove the Codex integration');
    throw error;
  }
}

async function removeClaudeCode(
  input: InteractiveCommandInput,
  integration: ClaudeCodeIntegrationService
): Promise<boolean> {
  const confirmed = await input.ui.confirm('Remove the package-managed Claude Code integration from this device?');
  if (!confirmed) {
    if (confirmed === null) input.ui.cancel('Removal cancelled.');
    return false;
  }
  let client: InferenceSetupClient | undefined;
  try {
    client = (await authenticatedSetupClient(input.profileName, input.profiles, input.credentials, input.fetch)).client;
  } catch (error) {
    const expected =
      isAuthorizationRequired(error) ||
      (error instanceof CliError && ['NETWORK_ERROR', 'NETWORK_TIMEOUT'].includes(error.code));
    if (!expected) throw error;
  }
  const spinner = input.ui.spinner('Removing the Claude Code integration...');
  try {
    const result = await integration.remove({
      profileName: input.profileName,
      removeToken: Boolean(client),
      client,
    });
    if (!result.removed) {
      spinner.error('Claude Code integration was not removed');
      input.ui.info(`Preserved conflicting settings: ${result.conflicts.join(', ')}`);
      return false;
    }
    spinner.stop(
      result.tokenRevoked ? 'Claude Code integration and runtime token removed' : 'Claude Code integration removed'
    );
    return true;
  } catch (error) {
    spinner.error('Could not remove the Claude Code integration');
    throw error;
  }
}

async function setupHarness(
  input: InteractiveCommandInput,
  integration: CodexIntegrationService,
  claudeCodeIntegration: ClaudeCodeIntegrationService
): Promise<number> {
  const existing = await input.profiles.get(input.profileName);
  return runInteractiveInferenceSetup({
    profileName: input.profileName,
    gateway: input.gateway,
    existingOrigin: existing?.origin,
    ui: input.ui,
    showIntro: false,
    session: () => authenticatedSetupClient(input.profileName, input.profiles, input.credentials, input.fetch),
    authorize: (gateway) =>
      runInteractiveLogin({
        gateway,
        profileName: input.profileName,
        profiles: input.profiles,
        credentials: input.credentials,
        output: SILENT_OUTPUT,
        ui: input.ui,
        fetch: input.fetch,
        openBrowser: input.openBrowser,
        cancelMessage: 'Setup cancelled.',
      }),
    configure: async (harness, context) => {
      if (harness === 'claude-code') {
        const result = await claudeCodeIntegration.setup({
          profileName: input.profileName,
          profile: context.profile,
          discovery: context.discovery,
          client: context.client,
        });
        return {
          progress: `Configured Claude Code ${result.claudeCodeVersion}`,
          summary: [
            `${result.modelCount} Opfield models are ready.`,
            `Default model: ${result.defaultModel}.`,
            'Restart Claude Code to load Opfield models.',
          ].join('\n'),
        };
      }
      if (harness !== 'codex') {
        throw new CliError('UNSUPPORTED_HARNESS', `Harness ${harness} is not supported by this CLI version.`);
      }
      await removeLegacyCodexUsageComponents(input.paths, {
        platform: process.platform,
        commandRunner: input.commandRunner,
        env: input.env,
        home: input.home,
      });
      const result = await integration.setup({
        profileName: input.profileName,
        profile: context.profile,
        discovery: context.discovery,
        client: context.client,
      });
      return {
        progress: `Configured Codex ${result.codexVersion}`,
        summary: [
          `${result.catalog.modelCount} Opfield models are ready.`,
          `Default model: ${result.defaultModel}.`,
          ...(result.warning ? [`Warning: ${result.warning}`] : []),
          'Fully quit and reopen Codex to load the current model catalog.',
        ].join('\n'),
      };
    },
  });
}

async function installStartup(input: InteractiveCommandInput): Promise<StartupStatus> {
  const spinner = input.ui.spinner('Enabling automatic startup...');
  try {
    const status = await (input.startupManager ?? inferenceStartupManager).install({
      paths: input.paths,
      profileName: input.profileName,
      env: input.env,
      home: input.home,
    });
    spinner.stop('Automatic startup enabled');
    return status;
  } catch (error) {
    spinner.error('Could not enable automatic startup');
    throw error;
  }
}

async function uninstallStartup(input: InteractiveCommandInput): Promise<StartupStatus> {
  const spinner = input.ui.spinner('Disabling automatic startup...');
  try {
    const status = await (input.startupManager ?? inferenceStartupManager).uninstall({
      paths: input.paths,
      profileName: input.profileName,
      env: input.env,
      home: input.home,
    });
    spinner.stop('Automatic startup disabled');
    return status;
  } catch (error) {
    spinner.error('Could not disable automatic startup');
    throw error;
  }
}

async function logout(input: InteractiveCommandInput): Promise<number> {
  const spinner = input.ui.spinner('Removing Opfield authorization...');
  try {
    await logoutCommand(input.profileName, input.profiles, input.credentials, SILENT_OUTPUT, input.fetch);
    spinner.stop('Opfield authorization removed');
    input.ui.outro('Logged out. Harness configuration and runtime tokens were left unchanged.');
    return 0;
  } catch (error) {
    spinner.error('Could not remove Opfield authorization');
    throw error;
  }
}

function createIntegration(input: InteractiveCommandInput): CodexIntegrationService {
  return new CodexIntegrationService(input.paths, input.credentials, {
    fetch: input.fetch,
    commandRunner: input.commandRunner,
    runtimeSource: input.runtimeSource,
    env: input.env,
    home: input.home,
    proxyDaemon: input.proxyDaemon,
  });
}

function createClaudeCodeIntegration(input: InteractiveCommandInput): ClaudeCodeIntegrationService {
  return new ClaudeCodeIntegrationService(input.paths, input.credentials, {
    fetch: input.fetch,
    commandRunner: input.commandRunner,
    runtimeSource: input.runtimeSource,
    env: input.env,
    home: input.home,
  });
}

const SILENT_OUTPUT: Output = { json: false, write() {} };
