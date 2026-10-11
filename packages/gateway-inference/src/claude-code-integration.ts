import {
  configureClaudeCode,
  inspectClaudeCodeConfiguration,
  removeClaudeCodeConfiguration,
  resolveClaudeCodePaths,
} from './claude-code-config.js';
import { type CommandRunner, runCommand } from './codex-integration.js';
import type { CredentialStore } from './credentials.js';
import { CliError } from './errors.js';
import type { Fetch } from './http.js';
import type { CliPaths } from './paths.js';
import type { GatewayProfile } from './profiles.js';
import { installPrivateRuntime } from './runtime.js';
import type { InferenceSetupClient } from './tokens.js';
import type { InferenceDiscovery, RuntimeCredential } from './types.js';

const MINIMUM_CLAUDE_CODE_VERSION = '2.1.129';
type DiagnosticCheck = { name: string; status: 'ok' | 'error' | 'warning'; message: string };

interface ClaudeGatewayModel {
  id: string;
  display_name?: string;
}

export class ClaudeCodeIntegrationService {
  constructor(
    private readonly paths: CliPaths,
    private readonly credentials: CredentialStore,
    private readonly options: {
      fetch?: Fetch;
      commandRunner?: CommandRunner;
      runtimeSource?: string;
      env?: NodeJS.ProcessEnv;
      home?: string;
    } = {}
  ) {}

  async setup(input: {
    profileName: string;
    profile: GatewayProfile;
    discovery: InferenceDiscovery;
    client: InferenceSetupClient;
  }) {
    const claude = await this.requireClaudeCode();
    const runtime = await this.ensureRuntimeToken(input.profileName, input.profile, input.client);
    await this.installRuntime();
    const models = await this.fetchModels(input.discovery, runtime);
    const defaultModel = models[0]!.id;
    await this.smoke(input.discovery, runtime, defaultModel);
    const integrationPaths = resolveClaudeCodePaths(this.paths, input.profileName, this.options.env, this.options.home);
    const config = await configureClaudeCode({
      paths: integrationPaths,
      profile: input.profileName,
      baseUrl: input.discovery.adapters.anthropic.baseUrl,
      model: defaultModel,
      runtimeFile: this.paths.runtimeFile,
      cliHome: this.paths.homeDir,
    });
    return {
      claudeCodeVersion: claude.version,
      configFile: config.configFile,
      defaultModel,
      modelCount: models.length,
      token: { id: runtime.tokenId, prefix: runtime.prefix },
    };
  }

  async doctor(input: { profileName: string; discovery?: InferenceDiscovery }) {
    const checks: DiagnosticCheck[] = [];
    try {
      const claude = await this.requireClaudeCode();
      checks.push({ name: 'claude-code', status: 'ok', message: `Claude Code ${claude.version}` });
    } catch (error) {
      checks.push({ name: 'claude-code', status: 'error', message: messageOf(error) });
    }
    const integrationPaths = resolveClaudeCodePaths(this.paths, input.profileName, this.options.env, this.options.home);
    try {
      const config = await inspectClaudeCodeConfiguration({ paths: integrationPaths });
      checks.push({
        name: 'config',
        status: config.configured && config.conflicts.length === 0 ? 'ok' : 'error',
        message: !config.configured
          ? 'Not configured'
          : config.conflicts.length
            ? `Conflicts: ${config.conflicts.join(', ')}`
            : `Configured (${config.model})`,
      });
    } catch (error) {
      checks.push({ name: 'config', status: 'error', message: messageOf(error) });
    }
    const runtime = await this.credentials.getRuntime(input.profileName, 'claude-code');
    checks.push({
      name: 'runtime-token',
      status: runtime ? 'ok' : 'error',
      message: runtime ? `Stored (${runtime.prefix})` : 'Missing',
    });
    if (runtime && input.discovery) {
      try {
        const models = await this.fetchModels(input.discovery, runtime);
        checks.push({ name: 'gateway-models', status: 'ok', message: `${models.length} models` });
      } catch (error) {
        checks.push({ name: 'gateway-models', status: 'error', message: messageOf(error) });
      }
    } else {
      checks.push({
        name: 'gateway-models',
        status: runtime ? 'warning' : 'error',
        message: runtime ? 'Offline: model discovery was not checked' : 'Skipped because the runtime token is missing',
      });
    }
    return {
      ok: checks.every((check) => check.status !== 'error'),
      degraded: checks.some((check) => check.status === 'warning'),
      checks,
    };
  }

  async remove(input: { profileName: string; removeToken?: boolean; client?: InferenceSetupClient }) {
    const integrationPaths = resolveClaudeCodePaths(this.paths, input.profileName, this.options.env, this.options.home);
    const runtime = await this.credentials.getRuntime(input.profileName, 'claude-code');
    const config = await removeClaudeCodeConfiguration({ paths: integrationPaths });
    if (!config.removed) return { ...config, tokenRevoked: false };
    let tokenRevoked = false;
    if (input.removeToken && runtime && input.client) {
      await input.client.revokeToken(runtime.tokenId);
      tokenRevoked = true;
    }
    await this.credentials.deleteRuntime(input.profileName, 'claude-code');
    return { ...config, tokenRevoked };
  }

  private async ensureRuntimeToken(
    profileName: string,
    profile: GatewayProfile,
    client: InferenceSetupClient
  ): Promise<RuntimeCredential> {
    const [local, active] = await Promise.all([
      this.credentials.getRuntime(profileName, 'claude-code'),
      client.listTokens(),
    ]);
    const matching = active.find(
      (token) => token.harness === 'claude-code' && token.installationId === profile.installationId
    );
    if (local && matching?.id === local.tokenId) return local;
    const created = await client.createToken({
      harness: 'claude-code',
      installationId: profile.installationId,
      ...(matching ? { replaceExisting: true } : {}),
    });
    const runtime: RuntimeCredential = {
      token: created.token,
      tokenId: created.id,
      prefix: created.prefix,
      harness: 'claude-code',
      installationId: profile.installationId,
    };
    await this.credentials.setRuntime(profileName, runtime, 'claude-code');
    return runtime;
  }

  private async fetchModels(discovery: InferenceDiscovery, runtime: RuntimeCredential): Promise<ClaudeGatewayModel[]> {
    const url = new URL(`${discovery.adapters.anthropic.baseUrl.replace(/\/+$/, '')}/v1/models`);
    url.searchParams.set('limit', '1000');
    const response = await this.fetch(url, {
      headers: { Accept: 'application/json', 'x-api-key': runtime.token },
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new CliError('CLAUDE_MODELS_REJECTED', `Opfield model discovery failed with HTTP ${response.status}.`);
    }
    const body = (await response.json()) as { data?: unknown };
    const models = Array.isArray(body.data)
      ? body.data.filter(
          (value): value is ClaudeGatewayModel =>
            Boolean(value) &&
            typeof value === 'object' &&
            typeof (value as ClaudeGatewayModel).id === 'string' &&
            /^(claude|anthropic)/.test((value as ClaudeGatewayModel).id)
        )
      : [];
    if (!models.length) {
      throw new CliError('CLAUDE_MODELS_EMPTY', 'Opfield returned no Claude Code-compatible model aliases.');
    }
    return models;
  }

  private async smoke(discovery: InferenceDiscovery, runtime: RuntimeCredential, model: string): Promise<void> {
    const url = `${discovery.adapters.anthropic.baseUrl.replace(/\/+$/, '')}/v1/messages?beta=true`;
    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'x-api-key': runtime.token,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        stream: true,
        messages: [{ role: 'user', content: 'Reply with one character.' }],
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 300).trim();
      throw new CliError(
        'CLAUDE_SMOKE_REJECTED',
        `Opfield rejected the Claude Code compatibility probe with HTTP ${response.status}${details ? `: ${details}` : ''}.`
      );
    }
    const stream = await response.text();
    if (!stream.includes('message_stop')) {
      throw new CliError('CLAUDE_STREAM_INVALID', 'Opfield did not complete the Claude Code streaming probe.');
    }
  }

  private async installRuntime(): Promise<void> {
    const runtimeSource = this.options.runtimeSource ?? process.argv[1];
    if (!runtimeSource) throw new CliError('RUNTIME_SOURCE_MISSING', 'Could not locate the packaged Opfield runtime.');
    await installPrivateRuntime(runtimeSource, this.paths.runtimeFile);
  }

  private async requireClaudeCode(): Promise<{ command: string; version: string }> {
    const command = this.options.env?.CLAUDE_CODE_PATH || process.env.CLAUDE_CODE_PATH || 'claude';
    const result = await (this.options.commandRunner ?? runCommand)(command, ['--version'], {
      ...process.env,
      ...this.options.env,
    });
    if (result.code !== 0) {
      throw new CliError('CLAUDE_CODE_NOT_FOUND', 'Claude Code CLI is not installed or not executable.');
    }
    const version = `${result.stdout}\n${result.stderr}`.match(/(\d+\.\d+\.\d+)/)?.[1];
    if (!version) throw new CliError('CLAUDE_CODE_VERSION_UNKNOWN', 'Could not determine the Claude Code version.');
    if (compareVersions(version, MINIMUM_CLAUDE_CODE_VERSION) < 0) {
      throw new CliError(
        'CLAUDE_CODE_UPDATE_REQUIRED',
        `Claude Code ${MINIMUM_CLAUDE_CODE_VERSION} or newer is required (found ${version}).`
      );
    }
    return { command, version };
  }

  private fetch(url: string | URL, init: RequestInit): Promise<Response> {
    return (this.options.fetch ?? globalThis.fetch)(url, init);
  }
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10) || 0);
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
