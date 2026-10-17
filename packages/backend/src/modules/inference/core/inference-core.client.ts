import { createChildLogger } from '@/lib/logger.js';
import { type InferenceCoreHealthIdentity, inferenceCoreHealthIdentitySchema } from './inference-core.contract.js';
import { LEGACY_CORE_API_PREFIX } from '@/lib/legacy-compat.js';

const logger = createChildLogger('InferenceCoreClient');

const REQUEST_TIMEOUT_MS = 5_000;

/** Provider row as the core's management API reports it (no secrets). */
export interface CoreProviderRow {
  name: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
  hasApiKey: boolean;
  models: string[];
  authMode?: string;
  disabled?: boolean;
  codexAccountMode?: string;
  discovery?: unknown;
}

export interface CoreLiveModel {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  reasoningEfforts?: string[];
  inputModalities?: string[];
  capabilities?: string[];
}

function unnamespaceCoreModelId(providerName: string, modelId: string): string {
  const prefix = `${providerName}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

function normalizeCoreModelDisplayName(providerName: string, displayName: string, modelId: string): string {
  const normalizedModelId = unnamespaceCoreModelId(providerName, modelId);
  return displayName === modelId || displayName === `${providerName}/${normalizedModelId}`
    ? normalizedModelId
    : displayName;
}

export class InferenceCoreClientError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'InferenceCoreClientError';
  }
}

/**
 * Private client for the managed core container. Talks to the container's
 * network alias on the installer-managed Compose network only; the core never
 * publishes a host port. The management credential authenticates every call.
 */
export class InferenceCoreClient {
  constructor(
    private readonly baseUrl: string,
    private readonly managementCredential: string
  ) {}

  /** Liveness + contract identity. Returns null when the core is unreachable. */
  async health(): Promise<InferenceCoreHealthIdentity | null> {
    return this.getIdentity('/healthz');
  }

  /**
   * Readiness + contract identity. Readiness is stricter than liveness: the
   * core reports `ready` only after its startup sync settled.
   */
  async ready(): Promise<{
    ready: boolean;
    status: 'ready' | 'pending' | 'failed' | null;
    identity: InferenceCoreHealthIdentity | null;
  }> {
    const response = await this.request('GET', '/readyz');
    if (!response) return { ready: false, status: null, identity: null };
    const identity = this.parseIdentity(response.body);
    const rawStatus = (response.body as { status?: unknown }).status;
    const status = rawStatus === 'ready' || rawStatus === 'pending' || rawStatus === 'failed' ? rawStatus : null;
    return { ready: response.status === 200 && status === 'ready', status, identity };
  }

  /** Opfield-only extended status (drain state + identity). */
  async drainStatus(): Promise<{ draining: boolean; drained?: boolean } | null> {
    const response = await this.request('GET', `${LEGACY_CORE_API_PREFIX}status`);
    if (!response || response.status !== 200) return null;
    const body = response.body as { draining?: unknown; drained?: unknown };
    return {
      draining: body.draining === true,
      ...(typeof body.drained === 'boolean' ? { drained: body.drained } : {}),
    };
  }

  // ----------------------------------------------------- management surface

  /** Config-backed provider rows as the core reports them (never includes secrets). */
  async listCoreProviders(): Promise<CoreProviderRow[] | null> {
    const response = await this.request('GET', '/api/providers');
    if (!response || response.status !== 200 || !Array.isArray(response.body)) return null;
    return response.body as CoreProviderRow[];
  }

  async createCoreProvider(name: string, provider: Record<string, unknown>): Promise<void> {
    const response = await this.request('POST', '/api/providers', { name, provider });
    this.assertOk(response, 'create provider');
  }

  async patchCoreProvider(name: string, patch: Record<string, unknown>): Promise<void> {
    const response = await this.request('PATCH', `/api/providers?name=${encodeURIComponent(name)}`, patch);
    this.assertOk(response, 'update provider');
  }

  async deleteCoreProvider(name: string): Promise<void> {
    const response = await this.request('DELETE', `/api/providers?name=${encodeURIComponent(name)}`);
    this.assertOk(response, 'delete provider');
  }

  /**
   * Makes `key` the provider's only API key: the core takes keys through its key endpoints only (a provider PATCH
   * with apiKey is refused), adds it as the active one, and the keys it had before are removed so its failover
   * never goes back to them.
   */
  async replaceCoreProviderKey(name: string, key: string): Promise<void> {
    const query = `name=${encodeURIComponent(name)}`;
    const listed = await this.request('GET', `/api/providers/keys?${query}`);
    this.assertOk(listed, 'list provider keys');
    const previous = ((listed.body as { keys?: unknown }).keys ?? []) as Array<{ id?: unknown }>;
    const added = await this.request('POST', '/api/providers/keys', { name, key });
    this.assertOk(added, 'add provider key');
    const activeId = (added.body as { id?: unknown }).id;
    for (const entry of previous) {
      if (typeof entry.id !== 'string' || entry.id === activeId) continue;
      const removed = await this.request('DELETE', `/api/providers/keys?${query}&id=${encodeURIComponent(entry.id)}`);
      this.assertOk(removed, 'remove provider key');
    }
  }

  /** Model rows known to the core (all providers, management view). */
  async listCoreModels(): Promise<unknown[] | null> {
    const response = await this.request('GET', '/api/models');
    if (!response || response.status !== 200 || !Array.isArray(response.body)) return null;
    return response.body as unknown[];
  }

  /** Model ids and metadata returned by one provider's live upstream discovery. */
  async coreProviderLiveModels(name: string): Promise<CoreLiveModel[] | null> {
    const response = await this.request(
      'POST',
      `/api/providers/test?name=${encodeURIComponent(name)}`,
      undefined,
      15_000
    );
    this.assertOk(response, 'discover provider models');
    if (!response.body || typeof response.body !== 'object')
      throw new InferenceCoreClientError('Core discovery returned an invalid response');
    const body = response.body as {
      ok?: unknown;
      modelIds?: unknown;
      modelDetails?: unknown;
      applicable?: unknown;
      reason?: unknown;
      message?: unknown;
      error?: unknown;
    };
    if (body.applicable === false && ['static_catalog', 'forward_auth'].includes(String(body.reason))) return null;
    if (
      body.ok === true &&
      typeof body.message === 'string' &&
      body.message.startsWith('Passthrough provider is configured')
    )
      return null;
    if (body.ok !== true || !Array.isArray(body.modelIds)) {
      // Keep the core's reason (for example an upstream 401 or a lost OAuth login) so the
      // connection's sync error tells the operator what to fix.
      const reason = typeof body.error === 'string' && body.error ? `: ${body.error.slice(0, 300)}` : '';
      throw new InferenceCoreClientError(`Core live model discovery did not succeed${reason}`);
    }
    const ids = body.modelIds
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      .map((id) => unnamespaceCoreModelId(name, id));
    if (!Array.isArray(body.modelDetails)) return ids.map((id) => ({ id }));
    const details = body.modelDetails.filter((entry): entry is Record<string, unknown> => {
      return Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
    });
    const byId = new Map<string, Record<string, unknown>>();
    for (const entry of details) {
      if (typeof entry.id !== 'string' || !entry.id) continue;
      byId.set(entry.id, entry);
      byId.set(unnamespaceCoreModelId(name, entry.id), entry);
    }
    return ids.map((id) => {
      const detail = byId.get(id);
      const detailId = typeof detail?.id === 'string' ? detail.id : id;
      return {
        id,
        ...(typeof detail?.displayName === 'string'
          ? { displayName: normalizeCoreModelDisplayName(name, detail.displayName, detailId) }
          : {}),
        ...(typeof detail?.contextWindow === 'number' ? { contextWindow: detail.contextWindow } : {}),
        ...(typeof detail?.maxInputTokens === 'number' ? { maxInputTokens: detail.maxInputTokens } : {}),
        ...(typeof detail?.maxOutputTokens === 'number' ? { maxOutputTokens: detail.maxOutputTokens } : {}),
        ...(Array.isArray(detail?.reasoningEfforts)
          ? { reasoningEfforts: detail.reasoningEfforts.filter((value): value is string => typeof value === 'string') }
          : {}),
        ...(Array.isArray(detail?.inputModalities)
          ? { inputModalities: detail.inputModalities.filter((value): value is string => typeof value === 'string') }
          : {}),
        ...(Array.isArray(detail?.capabilities)
          ? { capabilities: detail.capabilities.filter((value): value is string => typeof value === 'string') }
          : {}),
      } satisfies CoreLiveModel;
    });
  }

  /** Quota reports per provider/account as the core measures them. */
  async coreProviderQuotas(): Promise<unknown | null> {
    const response = await this.request('GET', '/api/provider-quotas');
    return response && response.status === 200 ? response.body : null;
  }

  /** Providers that support an OAuth login flow on this core. */
  async listCoreOauthProviders(): Promise<string[]> {
    const response = await this.request('GET', '/api/oauth/providers');
    if (!response || response.status !== 200 || !Array.isArray(response.body)) return [];
    return (response.body as unknown[]).filter((entry): entry is string => typeof entry === 'string');
  }

  async coreOauthLoginStart(
    provider: string,
    options: { addAccount?: boolean; accountId?: string; reauth?: boolean } = {}
  ): Promise<{ url: string | null; instructions: string | null; deviceCode: unknown | null }> {
    const response = await this.request('POST', '/api/oauth/login', { provider, ...options });
    this.assertOk(response, 'start OAuth login');
    const body = response.body as { url?: unknown; instructions?: unknown; deviceCode?: unknown };
    return {
      url: typeof body.url === 'string' ? body.url : null,
      instructions: typeof body.instructions === 'string' ? body.instructions : null,
      deviceCode: body.deviceCode ?? null,
    };
  }

  async coreOauthLoginStatus(provider: string): Promise<unknown | null> {
    const response = await this.request('GET', `/api/oauth/status?provider=${encodeURIComponent(provider)}`);
    return response && response.status === 200 ? response.body : null;
  }

  async coreOauthLoginCode(provider: string, input: string): Promise<void> {
    const response = await this.request('POST', '/api/oauth/login/code', { provider, input });
    this.assertOk(response, 'complete OAuth login');
  }

  async coreOauthLoginCancel(provider: string): Promise<void> {
    const response = await this.request('POST', '/api/oauth/login/cancel', { provider });
    this.assertOk(response, 'cancel OAuth login');
  }

  /**
   * OAuth account set for one provider as the core stores it. Emails arrive
   * masked upstream; account ids are the stable reference.
   */
  async listCoreOauthAccounts(
    provider: string
  ): Promise<{ activeAccountId: string | null; accounts: Array<Record<string, unknown>> } | null> {
    const response = await this.request('GET', `/api/oauth/accounts?provider=${encodeURIComponent(provider)}`);
    if (!response || response.status !== 200 || !response.body || typeof response.body !== 'object') return null;
    const body = response.body as { activeAccountId?: unknown; accounts?: unknown };
    return {
      activeAccountId: typeof body.activeAccountId === 'string' ? body.activeAccountId : null,
      accounts: Array.isArray(body.accounts)
        ? body.accounts.filter(
            (account): account is Record<string, unknown> => Boolean(account) && typeof account === 'object'
          )
        : [],
    };
  }

  /** Remove one account from a core OAuth provider account set. */
  /**
   * Per-account subscription quota. The provider-wide quota report only describes the core's active account, so a
   * connection bound to any other account must read its own row here. `quota` is null while the core has no reading.
   */
  async coreOauthAccountQuotas(provider: string): Promise<{
    activeAccountId: string | null;
    quotas: Map<string, unknown>;
    /** Accounts whose quota probe failed, with the core's closed failure code. */
    failures: Map<string, string>;
    /** Accounts the core will not use until they are signed in again. */
    reauthRequired: Set<string>;
  } | null> {
    const response = await this.request('GET', `/api/oauth/accounts?provider=${encodeURIComponent(provider)}&quota=1`);
    if (!response || response.status !== 200 || !response.body || typeof response.body !== 'object') return null;
    const body = response.body as { activeAccountId?: unknown; accounts?: unknown };
    const quotas = new Map<string, unknown>();
    const failures = new Map<string, string>();
    const reauthRequired = new Set<string>();
    for (const account of Array.isArray(body.accounts) ? body.accounts : []) {
      if (!account || typeof account !== 'object') continue;
      const row = account as {
        id?: unknown;
        quota?: unknown;
        quotaUnavailable?: unknown;
        quotaFailure?: unknown;
        needsReauth?: unknown;
        health?: unknown;
      };
      if (typeof row.id !== 'string' || !row.id) continue;
      quotas.set(row.id, row.quota ?? null);
      if (row.quotaUnavailable === true) {
        failures.set(row.id, typeof row.quotaFailure === 'string' && row.quotaFailure ? row.quotaFailure : 'unknown');
      }
      const healthStatus =
        row.health && typeof row.health === 'object' ? (row.health as { status?: unknown }).status : undefined;
      if (row.needsReauth === true || healthStatus === 'reauth_required') reauthRequired.add(row.id);
    }
    return {
      activeAccountId: typeof body.activeAccountId === 'string' ? body.activeAccountId : null,
      quotas,
      failures,
      reauthRequired,
    };
  }

  async deleteCoreOauthAccount(provider: string, accountId: string): Promise<void> {
    const response = await this.request(
      'DELETE',
      `/api/oauth/accounts?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(accountId)}`
    );
    this.assertOk(response, 'remove OAuth account');
  }

  /**
   * Per-provider account-pool rotation strategy. The core implements generic
   * OAuth account pools only for anthropic today; other providers keep their
   * active-account semantics and skip this call.
   */
  async setCoreOauthPoolStrategy(provider: string, strategy: 'balanced' | 'even' | 'sequential'): Promise<void> {
    const response = await this.request('PUT', '/api/oauth/accounts/pool', {
      provider,
      strategy,
      enabled: true,
    });
    this.assertOk(response, 'set account pool strategy');
  }

  // ---------------------------------------------------- codex (ChatGPT) pool
  // ChatGPT accounts live in the core's codex account pool, managed through
  // /api/codex-auth/* rather than the generic /api/oauth/* surface.

  async coreCodexLoginStart(
    options: { accountId?: string; reauth?: boolean; flow?: 'browser' | 'device' } = {}
  ): Promise<{ flowId: string; url: string | null; instructions: string | null; deviceCode: string | null }> {
    const response = await this.request('POST', '/api/codex-auth/login', {
      ...(options.accountId ? { id: options.accountId } : {}),
      ...(options.reauth ? { reauth: true } : {}),
      ...(options.flow ? { flow: options.flow } : {}),
    });
    this.assertOk(response, 'start ChatGPT login');
    const body = response.body as { flowId?: unknown; url?: unknown; instructions?: unknown; deviceCode?: unknown };
    if (typeof body.flowId !== 'string' || !body.flowId) {
      throw new InferenceCoreClientError('Core ChatGPT login did not return a flow id');
    }
    return {
      flowId: body.flowId,
      url: typeof body.url === 'string' ? body.url : null,
      instructions: typeof body.instructions === 'string' ? body.instructions : null,
      deviceCode: typeof body.deviceCode === 'string' ? body.deviceCode : null,
    };
  }

  async coreCodexLoginStatus(
    flowId: string
  ): Promise<{ status: string; accountId?: string; email?: string; error?: string } | null> {
    const response = await this.request('GET', `/api/codex-auth/login-status?flowId=${encodeURIComponent(flowId)}`);
    if (!response || response.status !== 200) return null;
    const body = response.body as { status?: unknown; accountId?: unknown; email?: unknown; error?: unknown };
    if (typeof body.status !== 'string') return null;
    return {
      status: body.status,
      ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
      ...(typeof body.email === 'string' ? { email: body.email } : {}),
      ...(typeof body.error === 'string' ? { error: body.error } : {}),
    };
  }

  async coreCodexLoginCode(flowId: string, input: string): Promise<void> {
    const response = await this.request('POST', '/api/codex-auth/login/code', { flowId, input });
    this.assertOk(response, 'complete ChatGPT login');
  }

  async coreCodexLoginCancel(flowId?: string): Promise<void> {
    const response = await this.request('POST', '/api/codex-auth/login/cancel', flowId ? { flowId } : {});
    this.assertOk(response, 'cancel ChatGPT login');
  }

  /** ChatGPT pool accounts as the core reports them (emails are masked upstream). */
  async listCoreCodexAccounts(): Promise<unknown[] | null> {
    const response = await this.request('GET', '/api/codex-auth/accounts');
    if (!response || response.status !== 200) return null;
    const accounts = (response.body as { accounts?: unknown }).accounts;
    return Array.isArray(accounts) ? accounts : null;
  }

  async deleteCoreCodexAccount(accountId: string): Promise<void> {
    const response = await this.request('DELETE', `/api/codex-auth/accounts?id=${encodeURIComponent(accountId)}`);
    this.assertOk(response, 'remove ChatGPT account');
  }

  async setCoreCodexAccountPaused(accountId: string, paused: boolean): Promise<void> {
    const response = await this.request('PUT', '/api/codex-auth/accounts/pause', { id: accountId, paused });
    this.assertOk(response, 'pause ChatGPT account');
  }

  async setCoreCodexAccountPriority(accountId: string, priority: number | null): Promise<void> {
    const response = await this.request('PUT', '/api/codex-auth/accounts/priority', { id: accountId, priority });
    this.assertOk(response, 'prioritize ChatGPT account');
  }

  async setCoreCodexPoolStrategy(strategy: 'balanced' | 'even' | 'sequential'): Promise<void> {
    const response = await this.request('PUT', '/api/codex-auth/pool-strategy', { strategy });
    this.assertOk(response, 'set ChatGPT pool strategy');
  }

  /** Raw per-account ChatGPT quota map keyed by core account id. */
  async coreCodexQuota(): Promise<Record<string, unknown> | null> {
    const response = await this.request('GET', '/api/codex-auth/quota');
    if (!response || response.status !== 200) return null;
    const quotas = (response.body as { quotas?: unknown }).quotas;
    return quotas && typeof quotas === 'object' ? (quotas as Record<string, unknown>) : null;
  }

  private assertOk(
    response: { status: number; body: unknown } | null,
    action: string
  ): asserts response is { status: number; body: unknown } {
    if (!response) throw new InferenceCoreClientError(`Core is unreachable during ${action}`);
    if (response.status < 200 || response.status >= 300) {
      const message =
        response.body &&
        typeof response.body === 'object' &&
        typeof (response.body as { error?: unknown }).error === 'string'
          ? (response.body as { error: string }).error
          : `core ${action} failed with status ${response.status}`;
      throw new InferenceCoreClientError(message, response.status);
    }
  }

  /** Ask the core to stop accepting new work and finish in-flight turns. */
  async drain(): Promise<void> {
    const response = await this.request('POST', `${LEGACY_CORE_API_PREFIX}drain`);
    if (!response || response.status !== 200) {
      throw new InferenceCoreClientError(`Core drain failed (${response?.status ?? 'unreachable'})`, response?.status);
    }
  }

  /** Resume after a drain (used when an update aborts before replacement). */
  async resume(): Promise<void> {
    const response = await this.request('POST', `${LEGACY_CORE_API_PREFIX}resume`);
    if (!response || response.status !== 200) {
      throw new InferenceCoreClientError(`Core resume failed (${response?.status ?? 'unreachable'})`, response?.status);
    }
  }

  private async getIdentity(path: string): Promise<InferenceCoreHealthIdentity | null> {
    const response = await this.request('GET', path);
    if (!response || response.status !== 200) return null;
    return this.parseIdentity(response.body);
  }

  private parseIdentity(body: unknown): InferenceCoreHealthIdentity | null {
    const parsed = inferenceCoreHealthIdentitySchema.safeParse(body);
    if (!parsed.success) return null;
    return parsed.data;
  }

  private async request(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    payload?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<{ status: number; body: unknown } | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'x-opencodex-api-key': this.managementCredential,
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      logger.debug('Core request failed', {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON replies carry no identity information.
    }
    return { status: response.status, body };
  }
}
