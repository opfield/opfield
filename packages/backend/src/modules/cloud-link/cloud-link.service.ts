import { eq, inArray } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/settings.js';
import { createChildLogger } from '@/lib/logger.js';
import type { LicenseService } from '@/modules/license/license.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import {
  CLOUD_CODE_ALPHABET,
  CLOUD_DISCONNECT_TIMEOUT_MS,
  CLOUD_ENROLL_TIMEOUT_MS,
  type CloudCredentials,
  type CloudDisconnectResult,
  type CloudLinkStatusView,
  type CloudSocketStatus,
  type StoredCloudDisconnect,
  type StoredCloudEnrollment,
} from './cloud-link.types.js';

const logger = createChildLogger('CloudLink');

const SETTINGS_KEYS = {
  enrollment: 'cloud:enrollment',
  disconnect: 'cloud:disconnected',
} as const;
/** The socket state of the replica that holds the link, for the status a request on any replica reads. */
const SOCKET_STATUS_CACHE_KEY = 'cloud:link:socket';
const SOCKET_STATUS_TTL_SECONDS = 60;
const DISCONNECTED_BY_ACCOUNT_REASON = 'Your cloud account disconnected this installation.';

type Fetcher = typeof fetch;

export class CloudLinkRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'CloudLinkRequestError';
  }
}

/** `CLD-7K3M-Q9TX`, `7K3M-Q9TX` or `7k3mq9tx` as the portal's canonical `CLD-XXXX-XXXX`; null when it is not a code. */
export function normalizeCloudCode(input: string): string | null {
  let compact = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact.length === 11 && compact.startsWith('CLD')) compact = compact.slice(3);
  if (!CLOUD_CODE_ALPHABET.test(compact)) return null;
  return `CLD-${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function portalErrorOf(body: unknown): { code: string | null; message: string | null } {
  if (!body || typeof body !== 'object') return { code: null, message: null };
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return { code: error, message: null };
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return {
      code: typeof code === 'string' ? code : null,
      message: typeof message === 'string' ? message : null,
    };
  }
  return { code: null, message: null };
}

interface EnrollResponse {
  agentId: string;
  secret: string;
  accountEmail: string;
  portalUrl?: string;
}

function readEnrollResponse(body: unknown): EnrollResponse | null {
  if (!body || typeof body !== 'object') return null;
  const value = ('data' in body && body.data && typeof body.data === 'object' ? body.data : body) as Record<
    string,
    unknown
  >;
  const { agentId, secret, accountEmail, portalUrl } = value;
  if (typeof agentId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(agentId)) return null;
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) return null;
  return {
    agentId,
    secret,
    accountEmail: typeof accountEmail === 'string' ? accountEmail.slice(0, 320) : '',
    ...(typeof portalUrl === 'string' ? { portalUrl } : {}),
  };
}

/**
 * The installation side of the cloud link: the enrolment with the account portal (agent id and secret, the secret
 * encrypted at rest in settings) and the status the Settings page shows. The socket itself is run by
 * {@link CloudLinkAgent}, which listens for enrolment changes here.
 */
export class CloudLinkService {
  private readonly listeners = new Set<() => void>();
  private localSocketStatus: (() => CloudSocketStatus | null) | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly env: Pick<Env, 'CLOUD_PORTAL_URL' | 'APP_VERSION'>,
    private readonly licenseService: Pick<LicenseService, 'getInstallationId' | 'getInstallationName'>,
    private readonly cache: Pick<CacheService, 'get' | 'set' | 'delete'> | null,
    private readonly fetcher: Fetcher = fetch
  ) {}

  /** Called after every enrolment change (connect, disconnect, revoked by the account). */
  onEnrollmentChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The socket state of this process when it holds the link; null otherwise. */
  setLocalSocketStatusReader(reader: (() => CloudSocketStatus | null) | null): void {
    this.localSocketStatus = reader;
  }

  get configuredPortalUrl(): string {
    return trimBaseUrl(this.env.CLOUD_PORTAL_URL);
  }

  async helloInfo(): Promise<{ installationId: string; name: string; version: string }> {
    return {
      installationId: await this.licenseService.getInstallationId(),
      name: this.licenseService.getInstallationName(),
      version: this.env.APP_VERSION,
    };
  }

  async getStatus(): Promise<CloudLinkStatusView> {
    const stored = await this.readStored();
    if (stored.enrollment) {
      const enrollment = stored.enrollment;
      const socket = await this.socketStatus(enrollment.agentId);
      return {
        state: 'connected',
        portalUrl: enrollment.portalUrl,
        accountEmail: enrollment.accountEmail || null,
        connectedSince: enrollment.enrolledAt,
        socket: socket
          ? { state: socket.state, since: socket.since, lastError: socket.lastError }
          : { state: 'connecting', since: null, lastError: null },
        disconnectedAt: null,
        disconnectedReason: null,
      };
    }
    if (stored.disconnect) {
      return {
        state: 'disconnected_by_account',
        portalUrl: stored.disconnect.portalUrl,
        accountEmail: stored.disconnect.accountEmail,
        connectedSince: null,
        socket: null,
        disconnectedAt: stored.disconnect.disconnectedAt,
        disconnectedReason: stored.disconnect.reason,
      };
    }
    return {
      state: 'not_connected',
      portalUrl: this.configuredPortalUrl,
      accountEmail: null,
      connectedSince: null,
      socket: null,
      disconnectedAt: null,
      disconnectedReason: null,
    };
  }

  /** Enrols with a code from the account portal. Enrolling again replaces the previous agent. */
  async connect(code: string): Promise<CloudLinkStatusView> {
    const normalized = normalizeCloudCode(code);
    if (!normalized) {
      throw new CloudLinkRequestError(
        400,
        'CLOUD_CODE_INVALID',
        'Enter the code exactly as your cloud account shows it, for example CLD-7K3M-Q9TX'
      );
    }
    await this.serialized(async () => {
      const portalUrl = this.configuredPortalUrl;
      const hello = await this.helloInfo();
      const { status, body } = await this.portalRequest(
        `${portalUrl}/api/cloud/enroll`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: normalized, ...hello }),
        },
        CLOUD_ENROLL_TIMEOUT_MS
      );
      if (status < 200 || status >= 300) throw this.enrollError(status, body);
      const enrolled = readEnrollResponse(body);
      if (!enrolled) {
        throw new CloudLinkRequestError(502, 'CLOUD_PORTAL_ERROR', 'Your cloud account returned an unreadable answer');
      }
      const enrollment: StoredCloudEnrollment = {
        agentId: enrolled.agentId,
        secret: this.cryptoService.encryptString(enrolled.secret),
        portalUrl: this.acceptedPortalUrl(enrolled.portalUrl, portalUrl),
        accountEmail: enrolled.accountEmail,
        enrolledAt: new Date().toISOString(),
      };
      await this.setSetting(SETTINGS_KEYS.enrollment, enrollment);
      await this.deleteSetting(SETTINGS_KEYS.disconnect);
      logger.info('Installation connected to the cloud account', { agentId: enrollment.agentId });
    });
    this.notify();
    return this.getStatus();
  }

  /** Revokes the agent at the portal, then forgets the enrolment here (also when the portal cannot be reached). */
  async disconnect(): Promise<CloudDisconnectResult> {
    let warning: string | undefined;
    await this.serialized(async () => {
      const credentials = await this.readCredentials();
      if (credentials) {
        try {
          const { status } = await this.portalRequest(
            `${credentials.portalUrl}/api/cloud/agent/disconnect`,
            { method: 'POST', headers: { Authorization: `Bearer ${credentials.agentId}.${credentials.secret}` } },
            CLOUD_DISCONNECT_TIMEOUT_MS
          );
          // 401/404: the account already revoked this agent.
          if (!(status >= 200 && status < 300) && status !== 401 && status !== 404) {
            warning = `Your cloud account answered HTTP ${status}, so it may still list this installation. Disconnect it there as well.`;
          }
        } catch {
          warning =
            'Your cloud account could not be reached, so it may still list this installation. Disconnect it there as well.';
        }
      }
      await this.deleteSetting(SETTINGS_KEYS.enrollment);
      await this.deleteSetting(SETTINGS_KEYS.disconnect);
      await this.publishSocketStatus(null);
      logger.info('Installation disconnected from the cloud account', { confirmed: !warning });
    });
    this.notify();
    return { ...(await this.getStatus()), ...(warning ? { warning } : {}) };
  }

  /** The socket answered 401: the account revoked the agent. Keeps the reason for the Settings page. */
  async markDisconnectedByAccount(agentId: string): Promise<void> {
    let changed = false;
    await this.serialized(async () => {
      const { enrollment } = await this.readStored();
      if (!enrollment || enrollment.agentId !== agentId) return;
      const disconnect: StoredCloudDisconnect = {
        accountEmail: enrollment.accountEmail || null,
        portalUrl: enrollment.portalUrl,
        disconnectedAt: new Date().toISOString(),
        reason: DISCONNECTED_BY_ACCOUNT_REASON,
      };
      await this.setSetting(SETTINGS_KEYS.disconnect, disconnect);
      await this.deleteSetting(SETTINGS_KEYS.enrollment);
      await this.publishSocketStatus(null);
      changed = true;
      logger.warn('The cloud account disconnected this installation', { agentId });
    });
    if (changed) this.notify();
  }

  /** The enrolled agent with its secret decrypted; null when not connected or the secret cannot be read. */
  async readCredentials(): Promise<CloudCredentials | null> {
    const { enrollment } = await this.readStored();
    if (!enrollment) return null;
    try {
      const secret = this.cryptoService.decryptString(enrollment.secret);
      return secret ? { agentId: enrollment.agentId, secret, portalUrl: enrollment.portalUrl } : null;
    } catch {
      logger.error('The stored cloud link secret cannot be decrypted; connect the installation again');
      return null;
    }
  }

  /** Shares the socket state of the replica holding the link; null clears it. */
  async publishSocketStatus(status: CloudSocketStatus | null): Promise<void> {
    if (!this.cache) return;
    try {
      if (status) await this.cache.set(SOCKET_STATUS_CACHE_KEY, status, SOCKET_STATUS_TTL_SECONDS);
      else await this.cache.delete(SOCKET_STATUS_CACHE_KEY);
    } catch (error) {
      logger.debug('Could not share the cloud link socket state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async socketStatus(agentId: string): Promise<CloudSocketStatus | null> {
    const local = this.localSocketStatus?.() ?? null;
    if (local?.agentId === agentId) return local;
    if (!this.cache) return null;
    try {
      const shared = await this.cache.get<CloudSocketStatus>(SOCKET_STATUS_CACHE_KEY);
      return shared?.agentId === agentId ? shared : null;
    } catch {
      return null;
    }
  }

  /** The portal's own URL from the enrolment answer, unless it would move the bearer off TLS or is not a URL. */
  private acceptedPortalUrl(returned: string | undefined, configured: string): string {
    if (!returned) return configured;
    try {
      const url = new URL(returned);
      const configuredUrl = new URL(configured);
      if (url.protocol === 'https:' || url.origin === configuredUrl.origin) return trimBaseUrl(url.toString());
    } catch {
      // Fall through to the configured portal.
    }
    return configured;
  }

  private enrollError(status: number, body: unknown): CloudLinkRequestError {
    const { code, message } = portalErrorOf(body);
    if (code === 'CLOUD_CODE_INVALID' || (status === 400 && !code)) {
      return new CloudLinkRequestError(
        400,
        'CLOUD_CODE_INVALID',
        'This code is not valid or has expired. Create a new code in your cloud account.'
      );
    }
    if (code === 'CLOUD_CODE_WRONG_INSTALLATION') {
      return new CloudLinkRequestError(
        409,
        'CLOUD_CODE_WRONG_INSTALLATION',
        'This code was created for another installation. Open this installation in your cloud account and create its code there.'
      );
    }
    if (status === 429) {
      return new CloudLinkRequestError(
        429,
        'CLOUD_RATE_LIMITED',
        'Too many attempts. Wait a few minutes before trying again.'
      );
    }
    return new CloudLinkRequestError(
      502,
      code ?? 'CLOUD_PORTAL_ERROR',
      message ?? `Your cloud account answered HTTP ${status}`
    );
  }

  private async portalRequest(
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new CloudLinkRequestError(
        502,
        'CLOUD_PORTAL_UNAVAILABLE',
        `Your cloud account could not be reached at ${new URL(url).origin}`
      );
    }
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        logger.warn('A cloud link listener failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private serialized(task: () => Promise<void>): Promise<void> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async readStored(): Promise<{
    enrollment: StoredCloudEnrollment | null;
    disconnect: StoredCloudDisconnect | null;
  }> {
    const rows = await this.db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, [SETTINGS_KEYS.enrollment, SETTINGS_KEYS.disconnect]));
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const enrollment = values.get(SETTINGS_KEYS.enrollment) as StoredCloudEnrollment | undefined;
    const disconnect = values.get(SETTINGS_KEYS.disconnect) as StoredCloudDisconnect | undefined;
    return {
      enrollment: enrollment && typeof enrollment.agentId === 'string' && enrollment.secret ? enrollment : null,
      disconnect: disconnect && typeof disconnect.disconnectedAt === 'string' ? disconnect : null,
    };
  }

  private async setSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }

  private async deleteSetting(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }
}
