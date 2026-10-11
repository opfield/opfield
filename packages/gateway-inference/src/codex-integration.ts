import { spawn } from 'node:child_process';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  assertCodexCatalog,
  codexBaseInstructionsFromCatalog,
  readCatalog,
  readCatalogMetadata,
  syncCodexCatalog,
} from './codex-catalog.js';
import {
  configureCodex,
  hasOtherManagedCodexHome,
  inspectCodexConfiguration,
  removeCodexConfiguration,
  resolveCodexPaths,
  restoreCodexBackup,
} from './codex-config.js';
import type { CredentialStore } from './credentials.js';
import { CliError } from './errors.js';
import type { Fetch } from './http.js';
import { inferenceProxyBaseUrl } from './inference-proxy.js';
import { type InferenceProxyDaemonManager, inferenceProxyDaemonManager } from './inference-proxy-daemon.js';
import type { CliPaths } from './paths.js';
import type { GatewayProfile } from './profiles.js';
import { installPrivateRuntime } from './runtime.js';
import type { InferenceSetupClient } from './tokens.js';
import type { InferenceDiscovery, RuntimeCredential } from './types.js';

const MINIMUM_CODEX_VERSION = '0.145.0';
export const CODEX_ACCOUNT_LOGIN_WARNING =
  'Codex is not signed in to an OpenAI account. Sign in to Codex, then fully quit and reopen Desktop to display Opfield models.';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<CommandResult>;
type DiagnosticCheck = { name: string; status: 'ok' | 'error' | 'warning'; message: string };

export class CodexIntegrationService {
  constructor(
    private readonly paths: CliPaths,
    private readonly credentials: CredentialStore,
    private readonly options: {
      fetch?: Fetch;
      commandRunner?: CommandRunner;
      runtimeSource?: string;
      env?: NodeJS.ProcessEnv;
      home?: string;
      now?: () => Date;
      proxyDaemon?: InferenceProxyDaemonManager;
    } = {}
  ) {}

  async setup(input: {
    profileName: string;
    profile: GatewayProfile;
    discovery: InferenceDiscovery;
    client: InferenceSetupClient;
  }) {
    const codex = await this.requireCodex();
    const baseInstructions = await this.readBundledBaseInstructions(codex.command);
    const integrationPaths = resolveCodexPaths(this.paths, input.profileName, this.options.env, this.options.home);
    const codexAccountReady = await this.hasCodexAccountLogin(codex.command, integrationPaths.codexHome);
    const runtimeCredential = await this.ensureRuntimeToken(input.profileName, input.profile, input.client);
    const runtimeSource = this.options.runtimeSource ?? process.argv[1];
    if (!runtimeSource) throw new CliError('RUNTIME_SOURCE_MISSING', 'Could not locate the packaged Opfield runtime.');
    await installPrivateRuntime(runtimeSource, this.paths.runtimeFile);

    const catalog = await syncCodexCatalog({
      modelsUrl: gatewayModelsUrl(input.discovery),
      token: runtimeCredential.token,
      catalogFile: integrationPaths.catalogFile,
      metadataFile: integrationPaths.metadataFile,
      lockFile: integrationPaths.lockFile,
      fetch: this.options.fetch,
      now: this.options.now,
      baseInstructions,
    });

    const previousState = await readOptionalFile(integrationPaths.stateFile);
    const localCatalog = await readCatalog(integrationPaths.catalogFile);
    const defaultModel = selectDefaultModel(localCatalog);
    const config = await configureCodex({
      paths: integrationPaths,
      profile: input.profileName,
      model: defaultModel,
      baseUrl: input.discovery.adapters.openai.baseUrl,
      proxyBaseUrl: inferenceProxyBaseUrl(this.paths, input.profileName),
      runtimeFile: this.paths.runtimeFile,
      cliHome: this.paths.homeDir,
      now: this.options.now,
    });
    try {
      await this.smoke(codex.command, codex.version, integrationPaths.catalogFile, integrationPaths.codexHome);
      await (this.options.proxyDaemon ?? inferenceProxyDaemonManager).ensure({
        paths: this.paths,
        profileName: input.profileName,
        remoteBaseUrl: input.discovery.adapters.openai.baseUrl,
        runtimeFile: this.paths.runtimeFile,
        env: this.options.env,
      });
    } catch (error) {
      await restoreCodexBackup(integrationPaths.configFile, config.backupFile);
      if (previousState === null) await rm(integrationPaths.stateFile, { force: true });
      else await writeFile(integrationPaths.stateFile, previousState, { mode: 0o600 });
      throw error;
    }
    return {
      codexVersion: codex.version,
      providerId: config.providerId,
      mcpId: config.mcpId,
      configFile: config.configFile,
      catalogFile: integrationPaths.catalogFile,
      defaultModel,
      proxyBaseUrl: inferenceProxyBaseUrl(this.paths, input.profileName),
      catalog,
      token: { id: runtimeCredential.tokenId, prefix: runtimeCredential.prefix },
      ...(codexAccountReady ? {} : { warning: CODEX_ACCOUNT_LOGIN_WARNING }),
    };
  }

  async sync(input: { profileName: string; discovery: InferenceDiscovery }) {
    // `sync` is also the upgrade path for the long-lived private runtime used
    // by Codex. Without refreshing this copy, `npx @sqgateway/inference@latest`
    // could successfully update the catalog itself while every subsequent MCP
    // process kept executing an older bundled implementation indefinitely.
    await this.installRuntime();
    const codex = await this.requireCodex();
    const baseInstructions = await this.readBundledBaseInstructions(codex.command);
    const runtime = await this.requireRuntimeCredential(input.profileName);
    const integrationPaths = resolveCodexPaths(this.paths, input.profileName, this.options.env, this.options.home);
    const config = await inspectCodexConfiguration({ paths: integrationPaths, profile: input.profileName });
    if (!config.configured) {
      throw new CliError('CODEX_NOT_CONFIGURED', 'Codex is not configured. Run setup first.');
    }
    const catalog = await syncCodexCatalog({
      modelsUrl: gatewayModelsUrl(input.discovery),
      token: runtime.token,
      catalogFile: integrationPaths.catalogFile,
      metadataFile: integrationPaths.metadataFile,
      lockFile: integrationPaths.lockFile,
      fetch: this.options.fetch,
      now: this.options.now,
      baseInstructions,
    });
    await (this.options.proxyDaemon ?? inferenceProxyDaemonManager).ensure({
      paths: this.paths,
      profileName: input.profileName,
      remoteBaseUrl: input.discovery.adapters.openai.baseUrl,
      runtimeFile: this.paths.runtimeFile,
      env: this.options.env,
    });
    return catalog;
  }

  async doctor(input: {
    profileName: string;
    discovery?: InferenceDiscovery;
    setupCheck?: Omit<DiagnosticCheck, 'name'>;
  }) {
    const checks: DiagnosticCheck[] = [];
    let codex: { command: string; version: string } | undefined;
    try {
      codex = await this.requireCodex();
      checks.push({ name: 'codex', status: 'ok', message: `Codex ${codex.version}` });
    } catch (error) {
      checks.push({ name: 'codex', status: 'error', message: messageOf(error) });
    }
    const integrationPaths = resolveCodexPaths(this.paths, input.profileName, this.options.env, this.options.home);
    const config = await inspectCodexConfiguration({ paths: integrationPaths, profile: input.profileName });
    checks.push({
      name: 'config',
      status: config.configured && config.conflicts.length === 0 ? 'ok' : 'error',
      message: !config.configured
        ? 'Not configured'
        : config.conflicts.length
          ? `Conflicts: ${config.conflicts.join(', ')}`
          : config.active
            ? 'Configured and active'
            : 'Configured but not active',
    });
    const runtime = await this.credentials.getRuntime(input.profileName);
    checks.push({
      name: 'runtime-token',
      status: runtime ? 'ok' : 'error',
      message: runtime ? `Stored (${runtime.prefix})` : 'Missing',
    });
    try {
      const catalog = await readCatalog(integrationPaths.catalogFile);
      checks.push({
        name: 'catalog',
        status: catalog ? 'ok' : 'error',
        message: catalog ? `${catalog.models.length} models` : 'Missing',
      });
    } catch (error) {
      checks.push({ name: 'catalog', status: 'error', message: messageOf(error) });
    }
    const metadata = await readCatalogMetadata(integrationPaths.metadataFile);
    if (metadata) checks.push({ name: 'catalog-refresh', status: 'ok', message: metadata.lastSyncedAt });

    checks.push({
      name: 'setup-auth',
      ...(input.setupCheck ??
        (input.discovery
          ? { status: 'ok' as const, message: 'Authenticated setup session available' }
          : { status: 'warning' as const, message: 'Offline: setup authorization was not checked' })),
    });

    if (runtime && input.discovery) {
      checks.push(await this.probeRuntimeToken(input.discovery, runtime));
    } else {
      checks.push({
        name: 'runtime-probe',
        status: runtime ? 'warning' : 'error',
        message: runtime ? 'Offline: runtime token was not checked' : 'Skipped because the runtime token is missing',
      });
    }

    if (codex && config.configured && config.conflicts.length === 0) {
      const result = await this.run(codex.command, ['debug', 'models'], {
        ...process.env,
        ...this.options.env,
        CODEX_HOME: integrationPaths.codexHome,
      });
      checks.push({
        name: 'codex-catalog',
        status: result.code === 0 ? 'ok' : 'error',
        message:
          result.code === 0 ? 'Codex accepted the managed catalog' : result.stderr.trim() || 'Codex rejected config',
      });
    }
    if (input.discovery) {
      checks.push({ name: 'gateway', status: 'ok', message: input.discovery.adapters.openai.baseUrl });
    }
    return {
      ok: checks.every((check) => check.status !== 'error'),
      degraded: checks.some((check) => check.status === 'warning'),
      checks,
    };
  }

  async remove(input: { profileName: string; removeToken?: boolean; client?: InferenceSetupClient }) {
    const integrationPaths = resolveCodexPaths(this.paths, input.profileName, this.options.env, this.options.home);
    const inspection = await inspectCodexConfiguration({ paths: integrationPaths, profile: input.profileName });
    if (inspection.conflicts.length > 0) {
      return { removed: false, conflicts: inspection.conflicts, tokenRevoked: false };
    }
    const sharedWithAnotherHome = await hasOtherManagedCodexHome({
      paths: integrationPaths,
      profile: input.profileName,
    });
    const runtime = await this.credentials.getRuntime(input.profileName);
    const config = await removeCodexConfiguration({ paths: integrationPaths, profile: input.profileName });
    if (config.conflicts.length > 0) return { ...config, tokenRevoked: false };
    let tokenRevoked = false;
    if (!sharedWithAnotherHome) {
      await (this.options.proxyDaemon ?? inferenceProxyDaemonManager).stop({
        paths: this.paths,
        profileName: input.profileName,
      });
      if (input.removeToken && runtime && input.client) {
        await input.client.revokeToken(runtime.tokenId);
        tokenRevoked = true;
      }
      await rm(integrationPaths.profileDir, { recursive: true, force: true });
      await this.credentials.deleteRuntime(input.profileName);
    }
    return { ...config, tokenRevoked };
  }

  private async ensureRuntimeToken(
    profileName: string,
    profile: GatewayProfile,
    client: InferenceSetupClient
  ): Promise<RuntimeCredential> {
    const [local, active] = await Promise.all([this.credentials.getRuntime(profileName), client.listTokens()]);
    const matching = active.find(
      (token) => token.harness === 'codex' && token.installationId === profile.installationId
    );
    if (local && matching?.id === local.tokenId) return local;
    const created = await client.createToken({
      installationId: profile.installationId,
      ...(matching ? { replaceExisting: true } : {}),
    });
    const runtime: RuntimeCredential = {
      token: created.token,
      tokenId: created.id,
      prefix: created.prefix,
      harness: 'codex',
      installationId: profile.installationId,
    };
    await this.credentials.setRuntime(profileName, runtime);
    return runtime;
  }

  private async requireRuntimeCredential(profileName: string): Promise<RuntimeCredential> {
    const runtime = await this.credentials.getRuntime(profileName);
    if (!runtime) {
      throw new CliError('RUNTIME_TOKEN_MISSING', 'Codex runtime token is missing. Run setup codex.', {
        exitCode: 2,
      });
    }
    return runtime;
  }

  private async installRuntime(): Promise<void> {
    const runtimeSource = this.options.runtimeSource ?? process.argv[1];
    if (!runtimeSource) throw new CliError('RUNTIME_SOURCE_MISSING', 'Could not locate the packaged Opfield runtime.');
    // The private runtime invokes `sync` on MCP startup. It is already the
    // installed artifact, so trying to reinstall itself would resolve native
    // packaging dependencies from the stripped runtime directory.
    if (resolve(runtimeSource) === resolve(this.paths.runtimeFile)) return;
    await installPrivateRuntime(runtimeSource, this.paths.runtimeFile);
  }

  private async probeRuntimeToken(discovery: InferenceDiscovery, runtime: RuntimeCredential): Promise<DiagnosticCheck> {
    const url = new URL(gatewayModelsUrl(discovery));
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${runtime.token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok || response.status === 304) {
        return { name: 'runtime-probe', status: 'ok', message: 'Opfield accepted the runtime token' };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          name: 'runtime-probe',
          status: 'error',
          message: `Opfield rejected the runtime token (HTTP ${response.status})`,
        };
      }
      return {
        name: 'runtime-probe',
        status: 'warning',
        message: `Opfield runtime probe is degraded (HTTP ${response.status})`,
      };
    } catch (error) {
      return { name: 'runtime-probe', status: 'warning', message: `Offline: ${messageOf(error)}` };
    }
  }

  private async requireCodex(): Promise<{ command: string; version: string }> {
    const command = this.options.env?.CODEX_CLI_PATH || process.env.CODEX_CLI_PATH || 'codex';
    const result = await this.run(command, ['--version']);
    if (result.code !== 0) throw new CliError('CODEX_NOT_FOUND', 'Codex CLI is not installed or not executable.');
    const version = result.stdout.match(/(\d+\.\d+\.\d+)/)?.[1];
    if (!version) throw new CliError('CODEX_VERSION_UNKNOWN', 'Could not determine the installed Codex version.');
    if (compareVersions(version, MINIMUM_CODEX_VERSION) < 0) {
      throw new CliError(
        'CODEX_UPDATE_REQUIRED',
        `Codex ${MINIMUM_CODEX_VERSION} or newer is required for the Opfield model catalog (found ${version}).`
      );
    }
    return { command, version };
  }

  private async hasCodexAccountLogin(command: string, codexHome: string): Promise<boolean> {
    const result = await this.run(command, ['login', 'status'], {
      ...process.env,
      ...this.options.env,
      CODEX_HOME: codexHome,
    });
    return result.code === 0;
  }

  private async readBundledBaseInstructions(command: string) {
    const result = await this.run(command, ['debug', 'models', '--bundled'], {
      ...process.env,
      ...this.options.env,
    });
    if (result.code !== 0) {
      throw new CliError(
        'CODEX_BUNDLED_CATALOG_UNAVAILABLE',
        `Codex could not provide its bundled model instructions: ${result.stderr || `exit ${result.code}`}`
      );
    }
    try {
      return codexBaseInstructionsFromCatalog(JSON.parse(result.stdout));
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('CODEX_BUNDLED_CATALOG_INVALID', 'Codex returned invalid bundled model JSON.', {
        cause: error,
      });
    }
  }

  private async smoke(command: string, version: string, catalogFile: string, codexHome: string): Promise<void> {
    const expected = await readCatalog(catalogFile);
    if (!expected) throw new CliError('CATALOG_MISSING', 'Codex catalog is missing after setup.');
    const result = await this.run(command, ['debug', 'models'], {
      ...process.env,
      ...this.options.env,
      CODEX_HOME: codexHome,
    });
    if (result.code !== 0) {
      throw new CliError(
        'CODEX_CONFIG_REJECTED',
        `Codex ${version} rejected the Opfield configuration: ${result.stderr}`
      );
    }
    let actual: unknown;
    try {
      actual = JSON.parse(result.stdout);
      assertCodexCatalog(actual);
    } catch (error) {
      throw new CliError('CODEX_CATALOG_REJECTED', 'Codex did not load a valid Opfield model catalog.', {
        cause: error,
      });
    }
    const expectedSlugs = expected.models.map((model) => model.slug).sort();
    const actualSlugs = (actual as { models: Array<{ slug: string }> }).models.map((model) => model.slug).sort();
    if (JSON.stringify(actualSlugs) !== JSON.stringify(expectedSlugs)) {
      throw new CliError('CODEX_CATALOG_NOT_AUTHORITATIVE', 'Codex model list differs from the Opfield catalog.');
    }
  }

  private run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> {
    return (this.options.commandRunner ?? runCommand)(command, args, env);
  }
}

function gatewayModelsUrl(discovery: InferenceDiscovery): string {
  return `${discovery.adapters.openai.baseUrl.replace(/\/+$/, '')}/models`;
}

function selectDefaultModel(catalog: Awaited<ReturnType<typeof readCatalog>>): string {
  const model = catalog?.models
    .filter((candidate) => candidate.visibility === 'list' && candidate.supported_in_api === true)
    .sort(
      (left, right) =>
        Number(left.priority ?? Number.MAX_SAFE_INTEGER) - Number(right.priority ?? Number.MAX_SAFE_INTEGER)
    )[0];
  if (!model) throw new CliError('CATALOG_EMPTY', 'Opfield catalog has no model that Codex can select by default.');
  return String(model.slug);
}

export async function runCommand(command: string, args: string[], env = process.env): Promise<CommandResult> {
  return new Promise((resolve) => {
    const launch = resolveCommandLaunch(process.platform, command, args, env);
    const child = spawn(launch.command, launch.args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ code: 124, stdout, stderr: `${stderr}\nCommand timed out.`.trim() });
    }, 15_000);
    timeout.unref();
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', (error) => finish({ code: 127, stdout, stderr: error.message }));
    child.once('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

export function resolveCommandLaunch(
  platform: NodeJS.Platform,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): { command: string; args: string[] } {
  if (platform !== 'win32') return { command, args };
  const commandLine = [command, ...args].map(quoteWindowsCmdArgument).join(' ');
  return {
    command: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
  };
}

function quoteWindowsCmdArgument(value: string): string {
  if (/^[A-Za-z0-9_./:\\=-]+$/.test(value)) return value;
  return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function assertFileExists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false
  );
}

async function readOptionalFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
