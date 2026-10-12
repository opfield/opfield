import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { auditLog } from '@/db/schema/index.js';
import { settings } from '@/db/schema/settings.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
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
  type CloudRemoteManagement,
  type CloudRequestAudit,
  type CloudRequestSummary,
  type CloudSocketStatus,
  type StoredCloudDisconnect,
  type StoredCloudEnrollment,
  type StoredRemoteManagement,
} from './cloud-link.types.js';
import type { CloudRequestWindowView } from './cloud-link-request-audit.js';

const logger = createChildLogger('CloudLink');

const SETTINGS_KEYS = {
  enrollment: 'cloud:enrollment',
  remoteManagement: 'cloud:remote_management',
  disconnect: 'cloud:disconnected',
} as const;
/** The socket state of the replica that holds the link, for the status a request on any replica reads. */
const SOCKET_STATUS_CACHE_KEY = 'cloud:link:socket';
const SOCKET_STATUS_TTL_SECONDS = 60;
/** Audit actions of the cloud link; every entry has resource type `cloud-link` and the agent id as resource id. */
export const CLOUD_AUDIT_ACTIONS = {
  connect: 'cloud.connect',
  disconnect: 'cloud.disconnect',
  disconnectedByAccount: 'cloud.disconnected_by_account',
  enrollFile: 'cloud.enroll_file',
  /** A step of the Opfield account sign-in of a managed installation (provider, owner, setup, secrets). */
  managedSso: 'cloud.managed_sso',
  remoteManagement: 'cloud.remote_management',
  request: 'cloud.request',
} as const;
export { CLOUD_AUDIT_RESOURCE_TYPE } from './cloud-link-audit-format.js';

import { CLOUD_AUDIT_RESOURCE_TYPE } from './cloud-link-audit-format.js';

const RECENT_REQUESTS_SHOWN = 5;
const DISCONNECTED_BY_ACCOUNT_REASON = 'Your cloud account disconnected this installation.';
const CLOUD_MANAGED_LINK_MESSAGE = 'A managed cloud installation stays connected to its account.';

/** Refusal of a disconnect or account switch on a managed installation (and the portal's MANAGED_INSTALLATION). */
export function cloudManagedLinkError(): CloudLinkRequestError {
  return new CloudLinkRequestError(409, 'CLOUD_MANAGED', CLOUD_MANAGED_LINK_MESSAGE);
}

type Fetcher = typeof fetch;

export class CloudLinkRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The portal may accept the same request later (unreachable, rate limited, failing on its side). */
    readonly retryable = false
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
  private readonly helloListeners = new Set<() => void>();
  private localSocketStatus: (() => CloudSocketStatus | null) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private auditService: Pick<AuditService, 'log'> | null = null;
  private liveRequestWindows: (() => CloudRequestWindowView[]) | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly env: Pick<Env, 'CLOUD_PORTAL_URL' | 'APP_VERSION'>,
    private readonly licenseService: Pick<LicenseService, 'getInstallationId' | 'getInstallationName'>,
    private readonly cache: Pick<CacheService, 'get' | 'set' | 'delete'> | null,
    private readonly fetcher: Fetcher = fetch
  ) {}

  /** Connects, disconnects and every portal request the link serves are written to the audit log. */
  setAuditService(auditService: Pick<AuditService, 'log'>): void {
    this.auditService = auditService;
  }

  /** Called after every enrolment change (connect, disconnect, revoked by the account). */
  onEnrollmentChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called when what the hello reports changes on this replica (remote management turned on or off). */
  onHelloChanged(listener: () => void): () => void {
    this.helloListeners.add(listener);
    return () => this.helloListeners.delete(listener);
  }

  /** The socket state of this process when it holds the link; null otherwise. */
  setLocalSocketStatusReader(reader: (() => CloudSocketStatus | null) | null): void {
    this.localSocketStatus = reader;
  }

  get configuredPortalUrl(): string {
    return trimBaseUrl(this.env.CLOUD_PORTAL_URL);
  }

  /** What the socket hello tells the account: the installation and whether it may be managed remotely. */
  async helloInfo(): Promise<{ installationId: string; name: string; version: string; remoteManagement: boolean }> {
    return { ...(await this.identity()), remoteManagement: await this.privilegedAllowed() };
  }

  /** The installation as an enrolment names it. */
  private async identity(): Promise<{ installationId: string; name: string; version: string }> {
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
        remoteManagement: await this.remoteManagementFor(enrollment),
        recentRequests: await this.recentRequests(enrollment.agentId),
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
        remoteManagement: null,
        recentRequests: [],
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
      remoteManagement: null,
      recentRequests: [],
    };
  }

  /** Enrols with a code from the account portal. Enrolling again replaces the previous agent. */
  async connect(
    code: string,
    actor: { userId: string | null } = { userId: null },
    options: {
      /** Portal to enrol with instead of the configured one (the enrolment file names it). */
      portalUrl?: string;
      /** Where the code came from, for the audit entry. */
      source?: 'settings' | 'enroll-file';
      /** Whether a failure the portal may accept later is audited (the enrolment file retries quietly). */
      auditRetryableFailure?: boolean;
    } = {}
  ): Promise<CloudLinkStatusView> {
    const portalUrl = options.portalUrl
      ? this.acceptedPortalUrl(options.portalUrl, this.configuredPortalUrl)
      : this.configuredPortalUrl;
    const source = options.source ?? 'settings';
    let agentId: string | null = null;
    let accountEmail: string | null = null;
    try {
      const normalized = normalizeCloudCode(code);
      if (!normalized) {
        throw new CloudLinkRequestError(
          400,
          'CLOUD_CODE_INVALID',
          'Enter the code exactly as your cloud account shows it, for example CLD-7K3M-Q9TX'
        );
      }
      // A managed installation stays on its account; only its own enrolment file enrols it.
      if (source !== 'enroll-file' && (await this.managedByCloud())) throw cloudManagedLinkError();
      await this.enroll(normalized, portalUrl, source === 'enroll-file', (enrolled) => {
        agentId = enrolled.agentId;
        accountEmail = enrolled.accountEmail || null;
      });
    } catch (error) {
      const retryable = error instanceof CloudLinkRequestError && error.retryable;
      if (!retryable || options.auditRetryableFailure !== false) {
        await this.writeAudit(CLOUD_AUDIT_ACTIONS.connect, actor.userId, null, {
          success: false,
          source,
          portalUrl,
          retryable,
          errorCode: error instanceof CloudLinkRequestError ? error.code : 'CLOUD_CONNECT_FAILED',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
    await this.writeAudit(CLOUD_AUDIT_ACTIONS.connect, actor.userId, agentId, {
      success: true,
      source,
      portalUrl,
      accountEmail,
    });
    this.notify();
    return this.getStatus();
  }

  private async enroll(
    normalized: string,
    portalUrl: string,
    managed: boolean,
    onEnrolled: (enrollment: StoredCloudEnrollment) => void
  ): Promise<void> {
    await this.serialized(async () => {
      const hello = await this.identity();
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
      onEnrolled(await this.storeEnrollment(body, portalUrl, managed));
    });
  }

  /** Stores an enrolment answer (`/api/cloud/enroll`): agent id, secret encrypted. */
  private async storeEnrollment(body: unknown, portalUrl: string, managed: boolean): Promise<StoredCloudEnrollment> {
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
      ...(managed ? { managed: true } : {}),
    };
    await this.setSetting(SETTINGS_KEYS.enrollment, enrollment);
    // A new agent starts with remote management off; a managed VM is managed by the cloud anyway.
    await this.deleteSetting(SETTINGS_KEYS.remoteManagement);
    await this.deleteSetting(SETTINGS_KEYS.disconnect);
    logger.info('Installation connected to the cloud account', { agentId: enrollment.agentId });
    return enrollment;
  }

  /**
   * Revokes the agent at the portal, then forgets the enrolment here (also when the portal cannot be reached). A
   * managed installation is refused with CLOUD_MANAGED, here or when the portal answers MANAGED_INSTALLATION.
   */
  async disconnect(actor: { userId: string | null } = { userId: null }): Promise<CloudDisconnectResult> {
    let result: { previous: StoredCloudEnrollment | null; warning?: string };
    try {
      result = await this.disconnectLink();
    } catch (error) {
      if (error instanceof CloudLinkRequestError && error.code === 'CLOUD_MANAGED') {
        const kept = (await this.readStored()).enrollment;
        await this.writeAudit(CLOUD_AUDIT_ACTIONS.disconnect, actor.userId, kept?.agentId ?? null, {
          success: false,
          errorCode: error.code,
          error: error.message,
        });
      }
      throw error;
    }
    const { previous, warning } = result;
    await this.writeAudit(CLOUD_AUDIT_ACTIONS.disconnect, actor.userId, previous?.agentId ?? null, {
      success: true,
      wasConnected: previous !== null,
      portalUrl: previous?.portalUrl ?? null,
      accountEmail: previous?.accountEmail || null,
      confirmedByAccount: previous !== null && !warning,
      ...(warning ? { warning } : {}),
    });
    this.notify();
    return { ...(await this.getStatus()), ...(warning ? { warning } : {}) };
  }

  /** The disconnect itself, serialized with every enrolment change; refuses a managed installation. */
  private async disconnectLink(): Promise<{ previous: StoredCloudEnrollment | null; warning?: string }> {
    let warning: string | undefined;
    let forgotten: StoredCloudEnrollment | null = null;
    await this.serialized(async () => {
      forgotten = (await this.readStored()).enrollment;
      if ((forgotten as StoredCloudEnrollment | null)?.managed) throw cloudManagedLinkError();
      const credentials = await this.readCredentials();
      if (credentials) {
        let answer: { status: number; body: unknown } | null = null;
        try {
          answer = await this.portalRequest(
            `${credentials.portalUrl}/api/cloud/agent/disconnect`,
            { method: 'POST', headers: { Authorization: `Bearer ${credentials.agentId}.${credentials.secret}` } },
            CLOUD_DISCONNECT_TIMEOUT_MS
          );
        } catch {
          warning =
            'Your cloud account could not be reached, so it may still list this installation. Disconnect it there as well.';
        }
        if (answer) {
          const { status, body } = answer;
          // The account keeps a managed installation: the link stays as it is.
          if (status === 409 && portalErrorOf(body).code === 'MANAGED_INSTALLATION') throw cloudManagedLinkError();
          // 401/404: the account already revoked this agent.
          if (!(status >= 200 && status < 300) && status !== 401 && status !== 404) {
            warning = `Your cloud account answered HTTP ${status}, so it may still list this installation. Disconnect it there as well.`;
          }
        }
      }
      await this.deleteSetting(SETTINGS_KEYS.enrollment);
      await this.deleteSetting(SETTINGS_KEYS.remoteManagement);
      await this.deleteSetting(SETTINGS_KEYS.disconnect);
      await this.publishSocketStatus(null);
      logger.info('Installation disconnected from the cloud account', { confirmed: !warning });
    });
    return { previous: forgotten as StoredCloudEnrollment | null, ...(warning ? { warning } : {}) };
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
      await this.deleteSetting(SETTINGS_KEYS.remoteManagement);
      await this.publishSocketStatus(null);
      changed = true;
      logger.warn('The cloud account disconnected this installation', { agentId });
      await this.writeAudit(CLOUD_AUDIT_ACTIONS.disconnectedByAccount, null, agentId, {
        portalUrl: enrollment.portalUrl,
        accountEmail: enrollment.accountEmail || null,
        reason: 'The cloud account refused the agent (HTTP 401)',
      });
    });
    if (changed) this.notify();
  }

  /**
   * Whether the cloud account may run privileged requests (node tokens, updates, setup codes): the installation is a
   * managed cloud VM, or an admin turned on "Allow remote management" for the current agent.
   */
  async privilegedAllowed(): Promise<boolean> {
    const { enrollment } = await this.readStored();
    if (!enrollment) return false;
    const access = await this.remoteManagementFor(enrollment);
    return access.managed || access.enabled;
  }

  /** Whether the installation is a managed cloud VM (enrolled from its provisioning file). */
  async managedByCloud(): Promise<boolean> {
    const { enrollment } = await this.readStored();
    return enrollment?.managed === true;
  }

  /** The "Allow remote management" switch. A managed cloud VM has none: the cloud manages it. */
  async setRemoteManagement(
    enabled: boolean,
    actor: { userId: string | null } = { userId: null }
  ): Promise<CloudLinkStatusView> {
    let audit: { agentId: string; previous: boolean } | null = null;
    await this.serialized(async () => {
      const { enrollment } = await this.readStored();
      if (!enrollment) {
        throw new CloudLinkRequestError(
          409,
          'CLOUD_NOT_CONNECTED',
          'Connect this Opfield installation to your cloud account first'
        );
      }
      if (enrollment.managed) {
        throw new CloudLinkRequestError(
          409,
          'CLOUD_MANAGED',
          'This Opfield installation is managed by the cloud; remote management cannot be turned off'
        );
      }
      const previous = (await this.remoteManagementFor(enrollment)).enabled;
      const stored: StoredRemoteManagement = {
        enabled,
        changedAt: new Date().toISOString(),
        changedBy: actor.userId,
        agentId: enrollment.agentId,
      };
      await this.setSetting(SETTINGS_KEYS.remoteManagement, stored);
      audit = { agentId: enrollment.agentId, previous };
    });
    const changed = audit as { agentId: string; previous: boolean } | null;
    if (changed) {
      await this.writeAudit(CLOUD_AUDIT_ACTIONS.remoteManagement, actor.userId, changed.agentId, {
        enabled,
        previous: changed.previous,
      });
      // The open link tells the account at once; a replica holding it elsewhere notices on its next tick.
      if (changed.previous !== enabled) this.notifyHello();
    }
    return this.getStatus();
  }

  private async remoteManagementFor(enrollment: StoredCloudEnrollment): Promise<CloudRemoteManagement> {
    if (enrollment.managed) return { managed: true, enabled: true };
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SETTINGS_KEYS.remoteManagement))
      .limit(1);
    const stored = row?.value as StoredRemoteManagement | undefined;
    return { managed: false, enabled: stored?.enabled === true && stored.agentId === enrollment.agentId };
  }

  /** Whether an agent is enrolled (the account may still refuse it). */
  async isEnrolled(): Promise<boolean> {
    return (await this.readStored()).enrollment !== null;
  }

  /** Activation of the license key in the enrolment file, audited like Settings' activation. Never the key itself. */
  async recordLicenseActivation(details: Record<string, unknown>): Promise<void> {
    if (!this.auditService) return;
    try {
      await this.auditService.log({ userId: null, action: 'license.activate', resourceType: 'license', details });
    } catch (error) {
      logger.warn('Could not write the license activation audit entry', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** An outcome of the enrolment file other than a successful connect, which `connect` audits itself. */
  async recordEnrollFileEvent(details: Record<string, unknown>): Promise<void> {
    await this.writeAudit(CLOUD_AUDIT_ACTIONS.enrollFile, null, null, details);
  }

  /** A step of the Opfield account sign-in set up from the enrolment file or the portal; never a secret. */
  async recordManagedSso(details: Record<string, unknown>): Promise<void> {
    await this.writeAudit(CLOUD_AUDIT_ACTIONS.managedSso, null, null, details);
  }

  /** The open coalescing windows of this process when it holds the link (repeats not written yet). */
  setLiveRequestWindowsReader(reader: (() => CloudRequestWindowView[]) | null): void {
    this.liveRequestWindows = reader;
  }

  /**
   * Writes the audit entry of a served request: a failed read, the first read of a (type, service), or the summary
   * of the identical reads that followed it (see CloudRequestAuditCoalescer).
   */
  async recordRequest(agentId: string, request: CloudRequestAudit): Promise<void> {
    await this.writeAudit(CLOUD_AUDIT_ACTIONS.request, null, agentId, { ...request });
  }

  /** The latest portal requests of this agent, newest first, read back from the audit log. */
  private async recentRequests(agentId: string): Promise<CloudRequestSummary[]> {
    try {
      const rows = await this.db
        .select({ createdAt: auditLog.createdAt, details: auditLog.details })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.resourceType, CLOUD_AUDIT_RESOURCE_TYPE),
            eq(auditLog.resourceId, agentId),
            eq(auditLog.action, CLOUD_AUDIT_ACTIONS.request)
          )
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(RECENT_REQUESTS_SHOWN);
      const live = new Map((this.liveRequestWindows?.() ?? []).map((window) => [window.openedBy, window]));
      return rows.map((row) => {
        const details = (row.details ?? {}) as Partial<CloudRequestAudit>;
        const summary = details.summary;
        const counting = typeof details.requestId === 'string' && !summary ? live.get(details.requestId) : undefined;
        const resultBytes = typeof details.resultBytes === 'number' ? details.resultBytes : null;
        return {
          at: summary?.firstAt ?? row.createdAt.toISOString(),
          type: typeof details.type === 'string' ? details.type : 'unknown',
          service: typeof details.service === 'string' ? details.service : null,
          ok: details.ok === true,
          error: typeof details.error === 'string' ? details.error : null,
          resultBytes: counting && resultBytes !== null ? resultBytes + counting.repeatBytes : resultBytes,
          count: summary ? summary.count : 1 + (counting?.repeats ?? 0),
          lastAt: summary?.lastAt ?? counting?.lastAt ?? null,
        };
      });
    } catch (error) {
      logger.debug('Could not read the latest cloud requests', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async writeAudit(
    action: string,
    userId: string | null,
    agentId: string | null,
    details: Record<string, unknown>
  ): Promise<void> {
    if (!this.auditService) return;
    try {
      await this.auditService.log({
        userId,
        action,
        resourceType: CLOUD_AUDIT_RESOURCE_TYPE,
        ...(agentId ? { resourceId: agentId } : {}),
        details,
      });
    } catch (error) {
      logger.warn('Could not write a cloud link audit entry', {
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
        'Too many attempts. Wait a few minutes before trying again.',
        true
      );
    }
    return new CloudLinkRequestError(
      502,
      code ?? 'CLOUD_PORTAL_ERROR',
      message ?? `Your cloud account answered HTTP ${status}`,
      status >= 500
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
        `Your cloud account could not be reached at ${new URL(url).origin}`,
        true
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

  private notifyHello(): void {
    for (const listener of this.helloListeners) {
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
