import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import { eq, inArray } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/settings.js';
import { type CommercialUpdateGrant, commercialVersionKey } from '@/edition/prepare-update.js';
import { createChildLogger } from '@/lib/logger.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import {
  type CachedLicenseState,
  COMMUNITY_ENTITLEMENTS,
  type EncryptedLicenseCredential,
  isCanonicalEntitlements,
  LICENSE_COMMUNITY_HEARTBEAT_INTERVAL_MS,
  LICENSE_ENTITLEMENTS_VERSION,
  LICENSE_OFFLINE_GRACE_DAYS,
  LICENSE_PAID_HEARTBEAT_INTERVAL_MS,
  LICENSE_PLAN_GRACE_HOURS,
  LICENSE_SUPPORTED_ENTITLEMENTS_VERSIONS,
  type LicenseEntitlements,
  type LicensePlan,
  type LicenseServerEnvelope,
  type LicenseServerErrorEnvelope,
  type LicenseServerRegistration,
  type LicenseServerState,
  type LicenseStatus,
  type LicenseStatusView,
  licensePlanEntitlementsForVersion,
} from './license.types.js';
import {
  createLicenseRequestNonce,
  type LicenseAttestationPurpose,
  LicenseAttestationVerifier,
  type LicenseRequestBinding,
  type SignedLicenseState,
} from './license-attestation.js';
import { LicenseServiceEndpoints } from './license-endpoints.js';
import { LEGACY_LICENSE_VERSION_FIELD } from '@/lib/legacy-compat.js';

const logger = createChildLogger('LicenseService');

const SETTINGS_KEYS = {
  installationId: 'license:installation_id',
  registrationNonceEncrypted: 'license:registration_nonce_encrypted',
  installationTokenEncrypted: 'license:installation_token_encrypted',
  keyEncrypted: 'license:key_encrypted',
  // The cache in this release's entitlement format. Releases before v2.11 read only `license:cached_state`
  // (entitlements v4), and an updater that rolls back to one restores no database, so that key is read until
  // this one exists and never written.
  cachedState: 'license:cached_state_v5',
  legacyCachedState: 'license:cached_state',
  onboardingCompleted: 'license:onboarding_completed',
} as const;

type Fetcher = typeof fetch;
type PaidPlan = Exclude<LicensePlan, 'community'>;

interface StoredSettings {
  get<T>(key: string, fallback: T): T;
}

/** One address of the license service gets this long to answer a call before the next one is tried. */
const LICENSE_REQUEST_TIMEOUT_MS = 8_000;
/** A private core file download: this long for the response to start on one address, then the whole download. */
const LICENSE_FILE_RESPONSE_TIMEOUT_MS = 15_000;
const LICENSE_FILE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

const PLAN_RANK: Record<LicensePlan, number> = { community: 0, personal: 1, business: 2, enterprise: 3 };
const UNVERIFIED_STATE_MESSAGE = 'License state is not signed by the license server';

interface RegistrationCredential {
  token: string;
  newlyRegistered: boolean;
}

interface VerifiedStoredState {
  state: LicenseServerState;
  issuedAt: string;
}

interface PlanContract {
  plan: PaidPlan;
  entitlementsVersion: number;
}

/** The cached state after its signatures were checked, plus what the signatures still prove. */
interface ResolvedLicenseState {
  cached: CachedLicenseState;
  verified: boolean;
  /** Highest paid plan this installation held, for existing paid resources after grace. */
  continuity: PlanContract | null;
  /** A higher plan that still has its plan-specific grace after a downgrade. */
  downgrade: (PlanContract & { until: Date }) | null;
}

export class LicenseServerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'LicenseServerRequestError';
  }
}

/** No answer at all, or the server itself failing; never a refusal or a state that failed verification. */
function isLicenseServerUnreachable(error: unknown): error is LicenseServerRequestError {
  return (
    error instanceof LicenseServerRequestError &&
    (error.code === 'LICENSE_SERVER_UNAVAILABLE' || (error.code === 'LICENSE_SERVER_ERROR' && error.status >= 500))
  );
}

/** The license service answers every call with `{ data }` or `{ error: { code, message } }`. */
function isLicenseServiceEnvelope(
  value: unknown
): value is LicenseServerEnvelope<unknown> | LicenseServerErrorEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if ('data' in value) return true;
  const error = (value as { error?: unknown }).error;
  return Boolean(error) && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string';
}

export class LicenseService {
  private registrationPromise: Promise<RegistrationCredential> | null = null;
  private installationIdPromise: Promise<string> | null = null;
  private syncQueue: Promise<void> = Promise.resolve();
  private lastPublishedStatus: string | null = null;
  private lifecycleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly env: Env,
    private readonly fetcher: Fetcher = fetch,
    private readonly generalSettingsService?: GeneralSettingsService,
    private readonly eventBus?: EventBusService,
    private readonly attestations = new LicenseAttestationVerifier(),
    private readonly endpoints = new LicenseServiceEndpoints(db, env, fetcher)
  ) {}

  /** Refreshes the signed list of license service addresses (on start and daily). Never throws. */
  async refreshServiceEndpoints(): Promise<void> {
    await this.endpoints.refresh();
  }

  async getStatus(): Promise<LicenseStatusView> {
    // Every license gate a request passes reads the status: one query for all of it.
    const stored = await this.getSettings([
      SETTINGS_KEYS.installationId,
      SETTINGS_KEYS.keyEncrypted,
      SETTINGS_KEYS.installationTokenEncrypted,
      SETTINGS_KEYS.cachedState,
      SETTINGS_KEYS.legacyCachedState,
    ]);
    const installationId = await this.storedInstallationId(stored);
    const encryptedKey = stored.get<EncryptedLicenseCredential | null>(SETTINGS_KEYS.keyEncrypted, null);
    const encryptedToken = stored.get<EncryptedLicenseCredential | null>(
      SETTINGS_KEYS.installationTokenEncrypted,
      null
    );
    const cached = this.storedCachedState(stored);
    const registrationStatus = encryptedToken ? 'registered' : (cached?.registrationStatus ?? 'pending');
    const effectiveCached = cached ? { ...cached, registrationStatus } : this.communityState(registrationStatus);
    const resolved = this.resolveCachedState(effectiveCached, installationId);
    const status = this.toStatusView(resolved, encryptedKey, installationId, this.getInstallationName());
    this.scheduleLifecycleRefresh(status, resolved);
    this.publishStatusIfChanged(status);
    return status;
  }

  /**
   * Entitlements of the highest paid plan the installation held, proven by a stored
   * signature. Existing paid resources keep operating with them after every grace.
   */
  async getRuntimeContinuityEntitlements(): Promise<LicenseStatusView['entitlements'] | null> {
    const stored = await this.getSettings([
      SETTINGS_KEYS.installationId,
      SETTINGS_KEYS.cachedState,
      SETTINGS_KEYS.legacyCachedState,
    ]);
    const installationId = await this.storedInstallationId(stored);
    const cached = this.storedCachedState(stored);
    if (!cached) return null;
    const continuity = this.resolveCachedState(cached, installationId).continuity;
    return continuity ? (this.contractEntitlements(continuity) ?? null) : null;
  }

  async getOnboardingState(): Promise<{ completed: boolean; status: LicenseStatusView }> {
    const completed = await this.getSetting<boolean | string>(SETTINGS_KEYS.onboardingCompleted, false);
    return {
      completed: completed === true || completed === 'true',
      status: await this.getStatus(),
    };
  }

  async continueWithCommunity(): Promise<LicenseStatusView> {
    return this.runSerialized(() => this.continueWithCommunityNow());
  }

  private async continueWithCommunityNow(): Promise<LicenseStatusView> {
    await this.ensureRegistered(false);
    await this.setSetting(SETTINGS_KEYS.onboardingCompleted, true);
    return this.getStatus();
  }

  async activateKey(licenseKey: string): Promise<LicenseStatusView> {
    return this.runSerialized(() => this.activateKeyNow(licenseKey));
  }

  private async activateKeyNow(licenseKey: string): Promise<LicenseStatusView> {
    const key = licenseKey.trim();
    if (!key) throw new Error('License key is required');

    const credential = await this.ensureRegistered(true);
    if (!credential) throw new Error('Installation registration is required');
    const signed = await this.postSignedState('/api/v1/licenses/activate', 'activate', {
      installationToken: credential.token,
      licenseKey: key,
      entitlementsVersion: LICENSE_ENTITLEMENTS_VERSION,
    });
    const state = signed.state;
    if (state.effectivePlan === 'community' || state.paidLicenseStatus !== 'valid') {
      throw new LicenseServerRequestError(409, 'LICENSE_NOT_ACTIVE', 'License server did not activate the paid plan');
    }

    await this.setSetting(SETTINGS_KEYS.keyEncrypted, this.cryptoService.encryptString(key));
    await this.saveServerState(signed);
    await this.setSetting(SETTINGS_KEYS.onboardingCompleted, true);
    logger.info('License activated', { plan: state.effectivePlan });
    return this.getStatus();
  }

  async clearKey(): Promise<LicenseStatusView> {
    return this.runSerialized(() => this.clearKeyNow());
  }

  private async clearKeyNow(): Promise<LicenseStatusView> {
    const credential = await this.ensureRegistered(true);
    if (!credential) throw new Error('Installation registration is required');
    const signed = await this.postSignedState('/api/v1/licenses/deactivate', 'deactivate', {
      installationToken: credential.token,
      entitlementsVersion: LICENSE_ENTITLEMENTS_VERSION,
    });
    await this.saveServerState(signed);
    await this.deleteSetting(SETTINGS_KEYS.keyEncrypted);
    logger.info('License deactivated');
    return this.getStatus();
  }

  async checkNow(): Promise<LicenseStatusView> {
    return this.runSerialized(() => this.checkNowUnlocked());
  }

  /**
   * Update admission is online and strict; an offline cache must not authorize a new private download.
   * Only an installation with nothing paid to keep (no key, no paid plan in its state, no private core
   * on the host) updates as Community while the license server cannot be reached: Community downloads
   * nothing private and must stay self-hostable.
   */
  async authorizeCommercialUpdate(
    hostVersion: string,
    host: { privateCoreInstalled?: boolean } = {}
  ): Promise<CommercialUpdateGrant> {
    commercialVersionKey(hostVersion);
    return this.runSerialized(async () => {
      try {
        return await this.authorizeCommercialUpdateOnline(hostVersion);
      } catch (error) {
        if (host.privateCoreInstalled !== false || !isLicenseServerUnreachable(error) || !(await this.heldNoPaidPlan()))
          throw error;
        logger.warn('License server is unreachable; preparing the update as Community', {
          hostVersion,
          reason: error.message,
        });
        return { edition: 'community' };
      }
    });
  }

  private async heldNoPaidPlan(): Promise<boolean> {
    if (await this.getSetting<EncryptedLicenseCredential | null>(SETTINGS_KEYS.keyEncrypted, null)) return false;
    for (const key of [SETTINGS_KEYS.cachedState, SETTINGS_KEYS.legacyCachedState]) {
      const cached = await this.getSetting<Record<string, unknown> | null>(key, null);
      if (cached && (cached.plan !== 'community' || cached.paidPlan || cached.retainedAttestation)) return false;
    }
    return true;
  }

  private async authorizeCommercialUpdateOnline(hostVersion: string): Promise<CommercialUpdateGrant> {
    const cached = await this.getStoredCachedState();
    const credential = await this.ensureRegistered(true, false);
    if (!credential)
      throw new LicenseServerRequestError(
        503,
        'LICENSE_SERVER_UNAVAILABLE',
        'Installation registration is required for update'
      );
    if (credential.newlyRegistered && cached && !Object.hasOwn(cached, 'registrationStatus')) {
      const key = await this.getSetting<EncryptedLicenseCredential | null>(SETTINGS_KEYS.keyEncrypted, null);
      if (key) {
        await this.postSignedState('/api/v1/licenses/activate', 'activate', {
          installationToken: credential.token,
          licenseKey: this.cryptoService.decryptString(key),
          entitlementsVersion: LICENSE_ENTITLEMENTS_VERSION,
        });
      }
    }
    const binding = this.createBinding('release-authorize');
    const result = await this.post<{ state: LicenseServerState; signedManifest?: string }>(
      '/api/v1/releases/authorize',
      {
        installationToken: credential.token,
        hostVersion,
        entitlementsVersion: LICENSE_ENTITLEMENTS_VERSION,
        ...this.bindingBody(binding),
      }
    );
    // LICENSE ENFORCEMENT: The private core is authorized only by a signed state for this request.
    const state = (await this.verifyServerState(result?.state, binding)).state;
    if (!state.paidLicense) {
      if (await this.getSetting(SETTINGS_KEYS.keyEncrypted, null)) {
        throw new LicenseServerRequestError(
          409,
          'COMMERCIAL_UPDATE_NOT_AUTHORIZED',
          'Update cannot silently replace a paid installation with Community'
        );
      }
      return { edition: 'community' };
    }
    // A valid plan, a plan in grace, and a plan lost after expiration, revocation,
    // replacement, or deactivation all keep the private core: existing paid resources
    // keep running under Community entitlements, so an update must not remove it.
    if (typeof result.signedManifest !== 'string')
      throw new LicenseServerRequestError(
        403,
        'COMMERCIAL_UPDATE_NOT_AUTHORIZED',
        'A signed private core release is required for this installation'
      );
    // The target-image preparer shares the running version's database. Never
    // replace its cache with a newer entitlement format before activation.
    return {
      edition: 'commercial',
      signedManifest: result.signedManifest,
      readFile: (path, releaseId) =>
        this.downloadFile('/api/v1/releases/file', {
          installationToken: credential.token,
          hostVersion,
          releaseId,
          path,
          entitlementsVersion: LICENSE_ENTITLEMENTS_VERSION,
        }),
    };
  }

  private async checkNowUnlocked(): Promise<LicenseStatusView> {
    const [legacyCached, encryptedKey, encryptedToken] = await Promise.all([
      this.getStoredCachedState(),
      this.getSetting<EncryptedLicenseCredential | null>(SETTINGS_KEYS.keyEncrypted, null),
      this.getSetting<EncryptedLicenseCredential | null>(SETTINGS_KEYS.installationTokenEncrypted, null),
    ]);
    const legacyNeedsActivation =
      Boolean(encryptedKey) && Boolean(legacyCached) && !Object.hasOwn(legacyCached!, 'registrationStatus');

    let credential: RegistrationCredential | null;
    try {
      credential = await this.ensureRegistered(false);
    } catch {
      credential = null;
    }
    if (!credential) return this.getStatus();

    if (legacyNeedsActivation && !encryptedToken && credential.newlyRegistered && encryptedKey) {
      try {
        const key = this.cryptoService.decryptString(encryptedKey);
        const signed = await this.postSignedState('/api/v1/licenses/activate', 'activate', {
          installationToken: credential.token,
          licenseKey: key,
          entitlementsVersion: LICENSE_ENTITLEMENTS_VERSION,
        });
        await this.saveServerState(signed);
      } catch (error) {
        if (error instanceof LicenseServerRequestError) {
          await this.saveLegacyActivationFailure(error);
        } else {
          await this.markUnreachable(error);
        }
      }
      return this.getStatus();
    }

    if (credential.newlyRegistered) return this.getStatus();

    try {
      const signed = await this.postSignedState('/api/v1/installations/heartbeat', 'heartbeat', {
        installationToken: credential.token,
        installationName: this.getInstallationName(),
        [LEGACY_LICENSE_VERSION_FIELD]: this.env.APP_VERSION,
        entitlementsVersion: LICENSE_ENTITLEMENTS_VERSION,
      });
      await this.saveServerState(signed);
    } catch (error) {
      if (error instanceof LicenseServerRequestError && error.code === 'INVALID_INSTALLATION_TOKEN') {
        await this.deleteSetting(SETTINGS_KEYS.installationTokenEncrypted);
        const replacement = await this.ensureRegistered(false);
        if (replacement) return this.getStatus();
      }
      await this.markUnreachable(error);
    }
    return this.getStatus();
  }

  async heartbeat(): Promise<void> {
    await this.runSerialized(() => this.heartbeatUnlocked());
  }

  private async heartbeatUnlocked(): Promise<void> {
    const [cached, encryptedKey, installationId] = await Promise.all([
      this.getCachedState(),
      this.getSetting<EncryptedLicenseCredential | null>(SETTINGS_KEYS.keyEncrypted, null),
      this.getInstallationId(),
    ]);
    const interval =
      encryptedKey || (cached?.plan && cached.plan !== 'community')
        ? LICENSE_PAID_HEARTBEAT_INTERVAL_MS
        : LICENSE_COMMUNITY_HEARTBEAT_INTERVAL_MS;
    const lastCheckedAt = cached?.lastCheckedAt ? Date.parse(cached.lastCheckedAt) : 0;
    // A registered cache without a verifiable signature (e.g. written by an older
    // release) is replaced by a signed state as soon as the server answers.
    const unsigned =
      cached?.registrationStatus === 'registered' && !this.resolveCachedState(cached, installationId).verified;
    if (lastCheckedAt && Date.now() - lastCheckedAt < interval && !unsigned) return;

    const status = await this.checkNowUnlocked();
    logger.debug('License heartbeat completed', {
      status: status.status,
      plan: status.plan,
      registrationStatus: status.registrationStatus,
    });
  }

  private async ensureRegistered(strict: boolean, persistState = true): Promise<RegistrationCredential | null> {
    const token = await this.readInstallationToken();
    if (token) return { token, newlyRegistered: false };

    if (!this.registrationPromise) {
      this.registrationPromise = this.registerInstallation(persistState).finally(() => {
        this.registrationPromise = null;
      });
    }
    try {
      return await this.registrationPromise;
    } catch (error) {
      if (persistState) await this.markRegistrationPending(error);
      if (strict) throw error;
      return null;
    }
  }

  private async runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.syncQueue.then(task, task);
    this.syncQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async registerInstallation(persistState = true): Promise<RegistrationCredential> {
    const nonce = await this.getOrCreateRegistrationNonce();
    const binding = this.createBinding('register');
    const result = await this.post<LicenseServerRegistration>('/api/v1/installations/register', {
      installationId: await this.getInstallationId(),
      registrationNonce: nonce,
      installationName: this.getInstallationName(),
      [LEGACY_LICENSE_VERSION_FIELD]: this.env.APP_VERSION,
      entitlementsVersion: LICENSE_ENTITLEMENTS_VERSION,
      ...this.bindingBody(binding),
    });
    if (!result || typeof result.installationToken !== 'string' || !result.installationToken.trim()) {
      throw new LicenseServerRequestError(502, 'INVALID_LICENSE_STATE', 'License server returned an invalid state');
    }
    // A forged registration also forges its token: store neither unless the state is signed.
    const signed = await this.verifyServerState(result.state, binding);
    await this.setSetting(
      SETTINGS_KEYS.installationTokenEncrypted,
      this.cryptoService.encryptString(result.installationToken)
    );
    if (persistState) await this.saveServerState(signed);
    logger.info('Community installation registered');
    return { token: result.installationToken, newlyRegistered: true };
  }

  private async readInstallationToken(): Promise<string | null> {
    const encrypted = await this.getSetting<EncryptedLicenseCredential | null>(
      SETTINGS_KEYS.installationTokenEncrypted,
      null
    );
    if (!encrypted) return null;
    try {
      const token = this.cryptoService.decryptString(encrypted).trim();
      if (token) return token;
    } catch {
      // Re-register with the existing nonce when a stored token is unreadable.
    }
    await this.deleteSetting(SETTINGS_KEYS.installationTokenEncrypted);
    return null;
  }

  private async getOrCreateRegistrationNonce(): Promise<string> {
    const encrypted = await this.getSetting<EncryptedLicenseCredential | null>(
      SETTINGS_KEYS.registrationNonceEncrypted,
      null
    );
    if (encrypted) {
      try {
        const nonce = this.cryptoService.decryptString(encrypted).trim();
        if (nonce) return nonce;
      } catch {
        throw new Error('Stored license registration nonce cannot be decrypted');
      }
    }
    const nonce = randomBytes(32).toString('base64url');
    await this.setSetting(SETTINGS_KEYS.registrationNonceEncrypted, this.cryptoService.encryptString(nonce));
    return nonce;
  }

  /**
   * Sends a call to the license service: to each of its addresses in order (the one that answered last first) until one
   * answers as the license service does, with a JSON envelope. No response, a timeout, or a response that is not the
   * license service's (a proxy error page, a parked domain) moves on to the next address; an answer, a refusal
   * included, is final and is never retried elsewhere.
   */
  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const payloadBody = JSON.stringify(body);
    for (const endpoint of await this.endpoints.list()) {
      let response: Response | undefined;
      let payload: unknown;
      try {
        response = await this.fetcher(`${endpoint}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payloadBody,
          signal: AbortSignal.timeout(LICENSE_REQUEST_TIMEOUT_MS),
        });
        payload = await response?.json().catch(() => null);
      } catch {
        continue;
      }
      if (!response || !isLicenseServiceEnvelope(payload)) continue;
      this.endpoints.markAnswered(endpoint);
      if (!response.ok) {
        const serverError = 'error' in payload ? payload.error : null;
        throw new LicenseServerRequestError(
          response.status,
          serverError?.code ?? 'LICENSE_SERVER_ERROR',
          serverError?.message ?? `License server returned HTTP ${response.status}`,
          serverError?.details
        );
      }
      if (!('data' in payload)) throw new Error('License server returned an invalid response');
      return payload.data as T;
    }
    throw new LicenseServerRequestError(503, 'LICENSE_SERVER_UNAVAILABLE', 'License server is unavailable');
  }

  /**
   * A private core file, over the same addresses as {@link post}: a download that starts, or a JSON refusal, is the
   * answer. When no address answers, the last HTTP response is returned for the caller to reject.
   */
  private async downloadFile(path: string, body: Record<string, unknown>): Promise<Response> {
    const payloadBody = JSON.stringify(body);
    let lastResponse: Response | null = null;
    for (const endpoint of await this.endpoints.list()) {
      const started = new AbortController();
      const timer = setTimeout(() => started.abort(), LICENSE_FILE_RESPONSE_TIMEOUT_MS);
      let response: Response | undefined;
      try {
        response = await this.fetcher(`${endpoint}${path}`, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: payloadBody,
          signal: AbortSignal.any([started.signal, AbortSignal.timeout(LICENSE_FILE_DOWNLOAD_TIMEOUT_MS)]),
        });
      } catch {
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (!response) continue;
      if (response.ok) {
        this.endpoints.markAnswered(endpoint);
        return response;
      }
      const payload = await response
        .clone()
        .json()
        .catch(() => null);
      if (isLicenseServiceEnvelope(payload)) {
        this.endpoints.markAnswered(endpoint);
        return response;
      }
      lastResponse = response;
    }
    if (lastResponse) return lastResponse;
    throw new LicenseServerRequestError(503, 'LICENSE_SERVER_UNAVAILABLE', 'License server is unavailable');
  }

  private createBinding(purpose: LicenseAttestationPurpose): LicenseRequestBinding {
    return { purpose, requestNonce: createLicenseRequestNonce() };
  }

  private bindingBody(binding: LicenseRequestBinding): { requestNonce: string; attestationKeyIds: string[] } {
    return { requestNonce: binding.requestNonce, attestationKeyIds: this.attestations.keyIds };
  }

  private async postSignedState(
    path: string,
    purpose: LicenseAttestationPurpose,
    body: Record<string, unknown>
  ): Promise<SignedLicenseState> {
    const binding = this.createBinding(purpose);
    const state = await this.post<LicenseServerState>(path, { ...body, ...this.bindingBody(binding) });
    return this.verifyServerState(state, binding);
  }

  /**
   * LICENSE ENFORCEMENT: Opfield applies only the signed copy of a server state, and
   * only when it is signed for this installation and this request. Unsigned, forged,
   * replayed, stale, or foreign states are rejected; the last signed state stays in force.
   */
  private async verifyServerState(value: unknown, binding: LicenseRequestBinding): Promise<SignedLicenseState> {
    const attestation = value && typeof value === 'object' ? (value as LicenseServerState).attestation : undefined;
    let payload: ReturnType<LicenseAttestationVerifier['verifyResponse']>;
    try {
      payload = this.attestations.verifyResponse(attestation, await this.getInstallationId(), binding);
    } catch (error) {
      throw new LicenseServerRequestError(
        502,
        'INVALID_LICENSE_SIGNATURE',
        error instanceof Error ? error.message : 'License state signature is invalid'
      );
    }
    this.assertServerState(payload.state);
    return {
      state: payload.state,
      attestation: attestation as SignedLicenseState['attestation'],
      issuedAt: payload.issuedAt,
    };
  }

  private async saveServerState(signed: SignedLicenseState): Promise<void> {
    const state = signed.state;
    this.assertServerState(state);
    const [previous, installationId] = await Promise.all([this.getCachedState(), this.getInstallationId()]);
    const now = new Date().toISOString();
    const status = this.statusFromState(state);
    const paidEffective = status === 'valid' || status === 'expired_grace';
    const retained = this.readStoredAttestation(previous?.retainedAttestation, installationId);
    const retainedPaid = retained && this.isPaidEffective(retained.state) ? retained : null;
    // Keep the highest paid plan's latest signature: it proves continuity after any
    // loss and anchors the downgrade grace. A reported loss ends that downgrade grace.
    const replaceRetained =
      paidEffective && (!retainedPaid || PLAN_RANK[state.effectivePlan] >= PLAN_RANK[retainedPaid.state.effectivePlan]);
    await this.saveCachedState({
      registrationStatus: 'registered',
      attestation: signed.attestation,
      retainedAttestation: replaceRetained ? signed.attestation : (previous?.retainedAttestation ?? null),
      retainedGraceEligible: paidEffective && (replaceRetained || previous?.retainedGraceEligible === true),
      status,
      plan: state.effectivePlan,
      paidPlan: state.paidLicense?.plan ?? null,
      paidLicenseStatus: state.paidLicenseStatus,
      licenseName: state.paidLicense?.name ?? null,
      licenseMetadata: state.paidLicense?.metadata ?? {},
      expiresAt: state.paidLicense?.expiresAt ?? null,
      graceUntil: state.graceUntil,
      entitlementsVersion: state.entitlementsVersion,
      entitlements: state.entitlements,
      lastCheckedAt: now,
      lastValidAt: paidEffective ? signed.issuedAt : (previous?.lastValidAt ?? null),
      activeInstallationId: state.activation?.installationId ?? null,
      activeInstallationName: state.activation?.installationName ?? null,
      errorMessage:
        status === 'valid' || status === 'expired_grace' || status === 'community' ? null : state.paidLicenseStatus,
    });
  }

  private async saveLegacyActivationFailure(error: LicenseServerRequestError): Promise<void> {
    const statusByCode: Record<string, LicenseStatus> = {
      LICENSE_EXPIRED: 'expired',
      LICENSE_REVOKED: 'revoked',
      LICENSE_IN_USE: 'invalid',
      LICENSE_NOT_FOUND: 'invalid',
    };
    const previous = await this.getCachedState();
    await this.saveCachedState({
      ...this.communityState('registered'),
      retainedAttestation: previous?.retainedAttestation ?? null,
      retainedGraceEligible: false,
      status: statusByCode[error.code] ?? 'invalid',
      paidLicenseStatus: error.code.toLowerCase(),
      lastCheckedAt: new Date().toISOString(),
      lastValidAt: previous?.lastValidAt ?? null,
      errorMessage: error.message,
    });
  }

  private async markRegistrationPending(error: unknown): Promise<void> {
    const cached = await this.getCachedState();
    await this.saveCachedState({
      ...(cached ?? this.communityState('pending')),
      registrationStatus: 'pending',
      lastCheckedAt: new Date().toISOString(),
      errorMessage: this.errorMessage(error),
    });
  }

  private async markUnreachable(error: unknown): Promise<void> {
    const cached = await this.getCachedState();
    await this.saveCachedState({
      ...(cached ?? this.communityState('pending')),
      lastCheckedAt: new Date().toISOString(),
      errorMessage: this.errorMessage(error),
    });
  }

  /**
   * LICENSE ENFORCEMENT: Server-derived fields come only from stored signatures. A cache
   * whose signature is missing, forged, or for another installation never grants more
   * than Community plus continuity for resources that already exist.
   */
  private resolveCachedState(cached: CachedLicenseState, installationId: string): ResolvedLicenseState {
    const current = this.readStoredAttestation(cached.attestation, installationId);
    const retained = this.readStoredAttestation(cached.retainedAttestation, installationId);
    const retainedPaid = retained && this.isPaidEffective(retained.state) ? retained : null;
    const retainedContract: PlanContract | null = retainedPaid
      ? {
          plan: retainedPaid.state.effectivePlan as PaidPlan,
          entitlementsVersion: retainedPaid.state.entitlementsVersion,
        }
      : null;

    if (!current) {
      const unsignedPaid = cached.plan !== 'community' || cached.paidPlan !== null;
      if (!unsignedPaid) return { cached, verified: false, continuity: retainedContract, downgrade: null };
      const loss: LicenseStatus[] = ['expired', 'revoked', 'replaced', 'deactivated', 'invalid'];
      const unsignedContract: PlanContract | null = cached.paidPlan
        ? { plan: cached.paidPlan, entitlementsVersion: cached.entitlementsVersion }
        : null;
      return {
        cached: {
          ...cached,
          status: loss.includes(cached.status) ? cached.status : 'unreachable_grace_expired',
          plan: 'community',
          entitlementsVersion: LICENSE_ENTITLEMENTS_VERSION,
          entitlements: COMMUNITY_ENTITLEMENTS,
          expiresAt: null,
          graceUntil: null,
          lastValidAt: null,
          errorMessage: cached.errorMessage ?? UNVERIFIED_STATE_MESSAGE,
        },
        verified: false,
        // An unsigned plan counts only for a cache written before signed states existed;
        // once a signed state was stored, only signatures prove what the installation held.
        continuity: retainedContract ?? (cached.attestation || cached.retainedAttestation ? null : unsignedContract),
        downgrade: null,
      };
    }

    const state = current.state;
    const status = this.statusFromState(state);
    const paidEffective = status === 'valid' || status === 'expired_grace';
    const lostContract: PlanContract | null = state.paidLicense
      ? { plan: state.paidLicense.plan, entitlementsVersion: state.entitlementsVersion }
      : null;
    const downgrade =
      paidEffective &&
      cached.retainedGraceEligible === true &&
      retainedPaid &&
      retainedContract &&
      PLAN_RANK[retainedContract.plan] > PLAN_RANK[state.effectivePlan]
        ? {
            ...retainedContract,
            until: new Date(
              Date.parse(retainedPaid.issuedAt) + LICENSE_PLAN_GRACE_HOURS[retainedContract.plan] * 60 * 60 * 1000
            ),
          }
        : null;
    return {
      cached: {
        ...cached,
        status,
        plan: state.effectivePlan,
        paidPlan: state.paidLicense?.plan ?? null,
        paidLicenseStatus: state.paidLicenseStatus,
        licenseName: state.paidLicense?.name ?? null,
        licenseMetadata: state.paidLicense?.metadata ?? {},
        expiresAt: state.paidLicense?.expiresAt ?? null,
        graceUntil: state.graceUntil,
        entitlementsVersion: state.entitlementsVersion,
        entitlements: state.entitlements,
        lastValidAt: paidEffective ? current.issuedAt : (retainedPaid?.issuedAt ?? null),
        activeInstallationId: state.activation?.installationId ?? null,
        activeInstallationName: state.activation?.installationName ?? null,
      },
      verified: true,
      continuity: this.higherContract(retainedContract, lostContract),
      downgrade,
    };
  }

  private readStoredAttestation(value: unknown, installationId: string): VerifiedStoredState | null {
    if (!value) return null;
    try {
      const payload = this.attestations.verifyStored(value, installationId);
      this.assertServerState(payload.state, LICENSE_SUPPORTED_ENTITLEMENTS_VERSIONS);
      return { state: payload.state, issuedAt: payload.issuedAt };
    } catch {
      return null;
    }
  }

  private isPaidEffective(state: LicenseServerState): boolean {
    const status = this.statusFromState(state);
    return status === 'valid' || status === 'expired_grace';
  }

  private higherContract(left: PlanContract | null, right: PlanContract | null): PlanContract | null {
    if (!left) return right;
    if (!right) return left;
    return PLAN_RANK[right.plan] > PLAN_RANK[left.plan] ? right : left;
  }

  private contractEntitlements(contract: PlanContract): LicenseEntitlements | undefined {
    return licensePlanEntitlementsForVersion(contract.entitlementsVersion)?.[contract.plan];
  }

  private toStatusView(
    resolved: ResolvedLicenseState,
    encrypted: EncryptedLicenseCredential | null,
    installationId: string,
    installationName: string
  ): LicenseStatusView {
    const cached = resolved.cached;
    const lastValidAt = cached.lastValidAt;
    const now = Date.now();
    const expiryAt = cached.expiresAt ? Date.parse(cached.expiresAt) : Number.NaN;
    const expirationGraceUntil = this.resolveExpirationGraceUntil(cached);
    const expirationGraceDeadline = expirationGraceUntil?.getTime() ?? Number.NaN;
    const offlineGraceUntil = cached.paidPlan && lastValidAt ? this.addOfflineGrace(lastValidAt) : null;
    let status = cached.status;
    let plan = cached.plan;
    let entitlements = cached.entitlements;
    let entitlementsVersion = cached.entitlementsVersion;
    let licensed = status === 'community' || status === 'valid' || status === 'expired_grace';
    let downgradeGraceUntil: Date | null = null;
    const authoritativeLoss = ['revoked', 'replaced', 'deactivated', 'invalid'].includes(cached.status);

    if (!authoritativeLoss && cached.paidPlan && Number.isFinite(expiryAt) && now >= expiryAt) {
      if (Number.isFinite(expirationGraceDeadline) && now < expirationGraceDeadline) {
        status = 'expired_grace';
        plan = cached.paidPlan;
        licensed = true;
      } else {
        status = 'expired';
        plan = 'community';
        entitlements = COMMUNITY_ENTITLEMENTS;
        licensed = false;
      }
    }

    // The offline deadline counts from the last signed paid state. It applies even
    // without a recorded error, so a cleared error cannot stretch an old signature.
    if (
      !authoritativeLoss &&
      cached.paidPlan &&
      offlineGraceUntil &&
      (cached.errorMessage || now >= offlineGraceUntil.getTime())
    ) {
      const offlineDeadline = Math.min(
        offlineGraceUntil.getTime(),
        Number.isFinite(expirationGraceDeadline) ? expirationGraceDeadline : Number.POSITIVE_INFINITY
      );
      if (offlineDeadline > now) {
        if (!(Number.isFinite(expiryAt) && now >= expiryAt)) status = 'valid_with_warning';
        licensed = true;
      } else {
        status =
          Number.isFinite(expirationGraceDeadline) && now >= expirationGraceDeadline
            ? 'expired'
            : 'unreachable_grace_expired';
        plan = 'community';
        entitlements = COMMUNITY_ENTITLEMENTS;
        licensed = false;
      }
    }

    // A lower paid plan keeps the higher plan's entitlements for that plan's grace,
    // counted from the last signed state that still reported the higher plan.
    const downgrade = resolved.downgrade;
    if (
      downgrade &&
      plan !== 'community' &&
      (status === 'valid' || status === 'expired_grace' || status === 'valid_with_warning') &&
      now < downgrade.until.getTime()
    ) {
      const retainedEntitlements = this.contractEntitlements(downgrade);
      if (retainedEntitlements) {
        plan = downgrade.plan;
        entitlements = retainedEntitlements;
        entitlementsVersion = downgrade.entitlementsVersion;
        downgradeGraceUntil = downgrade.until;
      }
    }

    // Community policy is local to this release. Keep the cached paid grant
    // untouched so legacy runtime continuity can still use its original contract.
    if (plan === 'community' && isCanonicalEntitlements(cached.plan, cached.entitlements, cached.entitlementsVersion)) {
      entitlements = COMMUNITY_ENTITLEMENTS;
      entitlementsVersion = LICENSE_ENTITLEMENTS_VERSION;
    }

    return {
      status,
      plan,
      registrationStatus: cached.registrationStatus,
      paidLicenseStatus: cached.paidLicenseStatus,
      licensed,
      hasKey: Boolean(encrypted),
      keyLast4: encrypted ? this.keyLast4(encrypted) : null,
      licenseName: cached.licenseName,
      licenseMetadata: cached.licenseMetadata,
      installationId,
      installationName,
      expiresAt: cached.expiresAt,
      entitlementsVersion,
      entitlements,
      lastCheckedAt: cached.lastCheckedAt,
      lastValidAt,
      graceUntil:
        status === 'expired_grace'
          ? (expirationGraceUntil?.toISOString() ?? null)
          : (downgradeGraceUntil?.toISOString() ?? null),
      offlineGraceUntil:
        status === 'valid_with_warning' || status === 'unreachable_grace_expired'
          ? (offlineGraceUntil?.toISOString() ?? null)
          : null,
      activeInstallationId: cached.activeInstallationId,
      activeInstallationName: cached.activeInstallationName,
      errorMessage: cached.errorMessage,
      serverUrl: this.endpoints.current(),
    };
  }

  private statusFromState(state: LicenseServerState): LicenseStatus {
    if (state.effectivePlan !== 'community' && state.paidLicenseStatus === 'valid') return 'valid';
    if (state.effectivePlan !== 'community' && state.paidLicenseStatus === 'expired_grace') return 'expired_grace';
    switch (state.paidLicenseStatus) {
      case 'none':
        return 'community';
      case 'expired':
      case 'revoked':
      case 'replaced':
      case 'deactivated':
        return state.paidLicenseStatus;
      default:
        return 'invalid';
    }
  }

  private communityState(registrationStatus: 'registered' | 'pending'): CachedLicenseState {
    return {
      registrationStatus,
      status: 'community',
      plan: 'community',
      paidPlan: null,
      paidLicenseStatus: 'none',
      licenseName: null,
      licenseMetadata: {},
      expiresAt: null,
      graceUntil: null,
      entitlementsVersion: LICENSE_ENTITLEMENTS_VERSION,
      entitlements: COMMUNITY_ENTITLEMENTS,
      lastCheckedAt: null,
      lastValidAt: null,
      activeInstallationId: null,
      activeInstallationName: null,
      errorMessage: null,
    };
  }

  private normalizeCachedState(value: Record<string, unknown>): CachedLicenseState {
    const legacyTier = value.tier;
    const legacyPlan: LicensePlan =
      legacyTier === 'homelab' ? 'personal' : legacyTier === 'enterprise' ? 'enterprise' : 'community';
    const plan =
      value.plan === 'community' ||
      value.plan === 'personal' ||
      value.plan === 'business' ||
      value.plan === 'enterprise'
        ? value.plan
        : legacyPlan;
    const paidPlan =
      value.paidPlan === 'personal' || value.paidPlan === 'business' || value.paidPlan === 'enterprise'
        ? value.paidPlan
        : plan === 'personal' || plan === 'business' || plan === 'enterprise'
          ? plan
          : null;
    const status = typeof value.status === 'string' ? (value.status as LicenseStatus) : 'community';
    const fallback = this.communityState(value.registrationStatus === 'registered' ? 'registered' : 'pending');
    return {
      registrationStatus: fallback.registrationStatus,
      attestation: value.attestation ?? null,
      retainedAttestation: value.retainedAttestation ?? null,
      retainedGraceEligible: value.retainedGraceEligible === true,
      status,
      plan,
      paidPlan,
      paidLicenseStatus:
        typeof value.paidLicenseStatus === 'string' ? value.paidLicenseStatus : status === 'valid' ? 'valid' : 'none',
      licenseMetadata:
        value.licenseMetadata && typeof value.licenseMetadata === 'object'
          ? (value.licenseMetadata as Record<string, unknown>)
          : {},
      entitlements:
        value.entitlements && typeof value.entitlements === 'object'
          ? (value.entitlements as CachedLicenseState['entitlements'])
          : COMMUNITY_ENTITLEMENTS,
      entitlementsVersion: typeof value.entitlementsVersion === 'number' ? value.entitlementsVersion : 1,
      licenseName: typeof value.licenseName === 'string' ? value.licenseName : null,
      expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : null,
      graceUntil: typeof value.graceUntil === 'string' ? value.graceUntil : null,
      lastCheckedAt: typeof value.lastCheckedAt === 'string' ? value.lastCheckedAt : null,
      lastValidAt: typeof value.lastValidAt === 'string' ? value.lastValidAt : null,
      activeInstallationId: typeof value.activeInstallationId === 'string' ? value.activeInstallationId : null,
      activeInstallationName: typeof value.activeInstallationName === 'string' ? value.activeInstallationName : null,
      errorMessage: typeof value.errorMessage === 'string' ? value.errorMessage : null,
    };
  }

  private keyLast4(encrypted: EncryptedLicenseCredential): string | null {
    try {
      return this.cryptoService.decryptString(encrypted).slice(-4);
    } catch {
      return null;
    }
  }

  private addOfflineGrace(iso: string): Date {
    const date = new Date(iso);
    date.setUTCDate(date.getUTCDate() + LICENSE_OFFLINE_GRACE_DAYS);
    return date;
  }

  private resolveExpirationGraceUntil(cached: CachedLicenseState): Date | null {
    if (!cached.paidPlan || !cached.expiresAt) return null;
    const expiresAt = new Date(cached.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) return null;
    expiresAt.setUTCHours(expiresAt.getUTCHours() + LICENSE_PLAN_GRACE_HOURS[cached.paidPlan]);
    if (!cached.graceUntil) return expiresAt;
    const declared = new Date(cached.graceUntil);
    if (!Number.isFinite(declared.getTime())) return expiresAt;
    return declared.getTime() < expiresAt.getTime() ? declared : expiresAt;
  }

  private assertServerState(
    value: unknown,
    versions: readonly number[] = [LICENSE_ENTITLEMENTS_VERSION]
  ): asserts value is LicenseServerState {
    if (!value || typeof value !== 'object') this.invalidServerState();
    const state = value as Partial<LicenseServerState>;
    const plans: LicensePlan[] = ['community', 'personal', 'business', 'enterprise'];
    const statuses = ['none', 'valid', 'expired_grace', 'expired', 'revoked', 'replaced', 'deactivated'];
    if (
      state.registrationStatus !== 'registered' ||
      !plans.includes(state.effectivePlan as LicensePlan) ||
      typeof state.paidLicenseStatus !== 'string' ||
      !statuses.includes(state.paidLicenseStatus) ||
      typeof state.entitlementsVersion !== 'number' ||
      !versions.includes(state.entitlementsVersion) ||
      !state.entitlements ||
      !isCanonicalEntitlements(state.effectivePlan as LicensePlan, state.entitlements, state.entitlementsVersion) ||
      typeof state.serverTime !== 'string' ||
      !Number.isFinite(Date.parse(state.serverTime))
    ) {
      this.invalidServerState();
    }

    const paid = state.paidLicense;
    if (state.paidLicenseStatus === 'none') {
      if (state.effectivePlan !== 'community' || paid !== undefined || state.graceUntil !== null) {
        this.invalidServerState();
      }
      return;
    }
    if (!paid || typeof paid !== 'object') this.invalidServerState();
    if (
      !['personal', 'business', 'enterprise'].includes(paid.plan) ||
      !['active', 'expired', 'revoked'].includes(paid.status) ||
      typeof paid.id !== 'string' ||
      typeof paid.name !== 'string' ||
      typeof paid.keyLast4 !== 'string' ||
      !paid.metadata ||
      typeof paid.metadata !== 'object' ||
      Array.isArray(paid.metadata) ||
      (paid.expiresAt !== null && (typeof paid.expiresAt !== 'string' || !Number.isFinite(Date.parse(paid.expiresAt))))
    ) {
      this.invalidServerState();
    }

    const effectivePaid = state.paidLicenseStatus === 'valid' || state.paidLicenseStatus === 'expired_grace';
    if (effectivePaid) {
      if (state.effectivePlan !== paid.plan) this.invalidServerState();
    } else if (state.effectivePlan !== 'community') {
      this.invalidServerState();
    }
    if (state.paidLicenseStatus === 'valid' && paid.status !== 'active') this.invalidServerState();
    if (state.paidLicenseStatus === 'expired_grace' && paid.status !== 'expired') this.invalidServerState();
    if (state.paidLicenseStatus === 'expired' && paid.status !== 'expired') this.invalidServerState();
    if (state.paidLicenseStatus === 'revoked' && paid.status !== 'revoked') this.invalidServerState();

    if (state.activation !== undefined) {
      const activation = state.activation;
      if (
        !activation ||
        typeof activation.installationId !== 'string' ||
        typeof activation.installationName !== 'string' ||
        typeof activation.activatedAt !== 'string' ||
        !Number.isFinite(Date.parse(activation.activatedAt)) ||
        (activation.lastHeartbeatAt !== null &&
          (typeof activation.lastHeartbeatAt !== 'string' || !Number.isFinite(Date.parse(activation.lastHeartbeatAt))))
      ) {
        this.invalidServerState();
      }
    }

    const expectedGrace = this.serverExpirationGraceUntil(paid.plan, paid.expiresAt);
    const declaredGrace = state.graceUntil;
    if (
      (expectedGrace === null && declaredGrace !== null) ||
      (expectedGrace !== null &&
        (typeof declaredGrace !== 'string' || Date.parse(declaredGrace) !== expectedGrace.getTime()))
    ) {
      this.invalidServerState();
    }
  }

  private invalidServerState(): never {
    throw new LicenseServerRequestError(502, 'INVALID_LICENSE_STATE', 'License server returned an invalid state');
  }

  private serverExpirationGraceUntil(plan: Exclude<LicensePlan, 'community'>, expiresAt: string | null): Date | null {
    if (!expiresAt) return null;
    const date = new Date(expiresAt);
    date.setUTCHours(date.getUTCHours() + LICENSE_PLAN_GRACE_HOURS[plan]);
    return date;
  }

  private scheduleLifecycleRefresh(status: LicenseStatusView, resolved: ResolvedLicenseState): void {
    if (this.lifecycleTimer) clearTimeout(this.lifecycleTimer);
    this.lifecycleTimer = null;
    const cached = resolved.cached;
    const now = Date.now();
    const offlineDeadline =
      cached.paidPlan && cached.lastValidAt ? this.addOfflineGrace(cached.lastValidAt).toISOString() : null;
    const expirationGraceDeadline = this.resolveExpirationGraceUntil(cached)?.toISOString() ?? null;
    const deadline = [
      status.expiresAt,
      status.graceUntil,
      status.offlineGraceUntil,
      offlineDeadline,
      expirationGraceDeadline,
      resolved.downgrade?.until.toISOString() ?? null,
    ]
      .map((value) => (value ? Date.parse(value) : Number.NaN))
      .filter((value) => Number.isFinite(value) && value > now)
      .sort((left, right) => left - right)[0];
    if (deadline === undefined) return;
    const delay = Math.min(deadline - now, 2_147_483_647);
    this.lifecycleTimer = setTimeout(() => {
      this.lifecycleTimer = null;
      void this.getStatus().catch((error) => {
        logger.error('Failed to refresh license lifecycle state', { error: this.errorMessage(error) });
      });
    }, delay);
    this.lifecycleTimer.unref?.();
  }

  private publishStatusIfChanged(status: LicenseStatusView): void {
    const payload = {
      status: status.status,
      plan: status.plan,
      paidLicenseStatus: status.paidLicenseStatus,
      expiresAt: status.expiresAt,
      graceUntil: status.graceUntil,
      offlineGraceUntil: status.offlineGraceUntil,
      entitlementsVersion: status.entitlementsVersion,
    };
    const signature = JSON.stringify(payload);
    if (signature === this.lastPublishedStatus) return;
    this.lastPublishedStatus = signature;
    this.eventBus?.publish('system.license.changed', payload);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'License server unreachable';
  }

  /** The name this installation reports to the license server and the cloud account. */
  getInstallationName(): string {
    try {
      const publicUrl = this.generalSettingsService?.getCachedPublicUrl() ?? this.env.APP_URL;
      return new URL(publicUrl).hostname || os.hostname();
    } catch {
      return os.hostname();
    }
  }

  async getInstallationId(): Promise<string> {
    if (!this.installationIdPromise) {
      this.installationIdPromise = this.loadOrCreateInstallationId().finally(() => {
        this.installationIdPromise = null;
      });
    }
    return this.installationIdPromise;
  }

  private async loadOrCreateInstallationId(): Promise<string> {
    const existing = await this.getSetting<string | null>(SETTINGS_KEYS.installationId, null);
    if (existing) return existing;
    const created = randomUUID();
    await this.setSetting(SETTINGS_KEYS.installationId, created);
    return created;
  }

  /** The stored installation id, or the one `getInstallationId` loads or creates when none is stored yet. */
  private async storedInstallationId(stored: StoredSettings): Promise<string> {
    return stored.get<string | null>(SETTINGS_KEYS.installationId, null) || this.getInstallationId();
  }

  /** {@link getCachedState} over values already read. */
  private storedCachedState(stored: StoredSettings): CachedLicenseState | null {
    const value =
      stored.get<Record<string, unknown> | null>(SETTINGS_KEYS.cachedState, null) ??
      stored.get<Record<string, unknown> | null>(SETTINGS_KEYS.legacyCachedState, null);
    return value ? this.normalizeCachedState(value) : null;
  }

  private async getCachedState(): Promise<CachedLicenseState | null> {
    const value = await this.getStoredCachedState();
    return value ? this.normalizeCachedState(value) : null;
  }

  /** The stored cache, or the one a release before v2.11 left until this release writes its own. */
  private async getStoredCachedState(): Promise<Record<string, unknown> | null> {
    const value = await this.getSetting<Record<string, unknown> | null>(SETTINGS_KEYS.cachedState, null);
    return value ?? this.getSetting<Record<string, unknown> | null>(SETTINGS_KEYS.legacyCachedState, null);
  }

  private async saveCachedState(state: CachedLicenseState): Promise<void> {
    await this.setSetting(SETTINGS_KEYS.cachedState, state);
  }

  private async getSetting<T>(key: string, fallback: T): Promise<T> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return (row?.value !== undefined ? row.value : fallback) as T;
  }

  /** Several settings in one query; `get` falls back exactly like {@link getSetting}. */
  private async getSettings(keys: readonly string[]): Promise<StoredSettings> {
    const rows = await this.db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, [...keys]));
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return {
      get: <T>(key: string, fallback: T) => {
        const value = values.get(key);
        return (value !== undefined ? value : fallback) as T;
      },
    };
  }

  private async setSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  private async deleteSetting(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }
}
