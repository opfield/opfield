import { randomUUID } from 'node:crypto';
import { createChildLogger } from '@/lib/logger.js';
import { LicenseServerRequestError, type LicenseService } from '@/modules/license/license.service.js';
import type { CacheService } from '@/services/cache.service.js';
import { CloudLinkRequestError, type CloudLinkService } from './cloud-link.service.js';

const logger = createChildLogger('CloudLinkConnectCode');

/** The portal is asked whether the code was entered this often. */
export const CLOUD_CLAIM_POLL_MS = 3_000;
/** Shared by every replica, so the code and its state read the same wherever the page asks. */
const STATE_CACHE_KEY = 'cloud:link:connect-code';
/** A finished attempt (connected, refused, expired) is still reported this long after its code expired. */
const STATE_KEEP_SECONDS = 15 * 60;

/**
 * pending: shown, waiting for the account to enter it; connected: the account entered it and the link is stored;
 * expired, invalid, used: get a new code; wrong_installation and failed: an error; none: no attempt.
 */
export type CloudConnectCodeState =
  | 'none'
  | 'pending'
  | 'connected'
  | 'expired'
  | 'invalid'
  | 'used'
  | 'wrong_installation'
  | 'failed';

export interface CloudConnectCodeView {
  state: CloudConnectCodeState;
  /** XXXX-XXXX, shown while pending. */
  code: string | null;
  expiresAt: string | null;
  /** Account the installation was linked to (connected). */
  accountEmail: string | null;
  error: string | null;
  errorCode: string | null;
}

interface StoredAttempt {
  id: string;
  state: CloudConnectCodeState;
  code: string;
  expiresAt: string;
  portalUrl: string;
  userId: string | null;
  accountEmail: string | null;
  error: string | null;
  errorCode: string | null;
}

const NONE: CloudConnectCodeView = {
  state: 'none',
  code: null,
  expiresAt: null,
  accountEmail: null,
  error: null,
  errorCode: null,
};

const CLAIM_STATES: Record<string, CloudConnectCodeState> = {
  CLOUD_CLAIM_INVALID: 'invalid',
  CLOUD_CLAIM_USED: 'used',
  CLOUD_CLAIM_WRONG_INSTALLATION: 'wrong_installation',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function view(attempt: StoredAttempt | null, now: number): CloudConnectCodeView {
  if (!attempt) return NONE;
  // The replica that polls may have stopped: a pending code past its expiry is expired wherever it is read.
  const expired = attempt.state === 'pending' && Date.parse(attempt.expiresAt) <= now;
  const state = expired ? 'expired' : attempt.state;
  return {
    state,
    code: state === 'pending' ? attempt.code : null,
    expiresAt: attempt.expiresAt,
    accountEmail: attempt.accountEmail,
    error: expired ? 'The code expired before it was entered. Get a new code.' : attempt.error,
    errorCode: expired ? 'CLOUD_CLAIM_EXPIRED' : attempt.errorCode,
  };
}

/**
 * Connect started from Gateway with one code: the license service issues a short code for this installation, the
 * page shows it with its expiry, and Gateway asks the account portal every 3 s whether it was entered (Opfield account
 * > Installations > Add). Entered, the answer is the enrolment a CLD code gives, stored the same way, and the link
 * opens. The attempt lives in the shared cache so any replica reports it; the replica that started it polls.
 */
export class CloudLinkConnectCode {
  private local: StoredAttempt | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly service: Pick<CloudLinkService, 'isEnrolled' | 'claim' | 'claimPortalUrl' | 'recordConnectCode'>,
    private readonly license: Pick<LicenseService, 'requestConnectCode'>,
    private readonly cache: Pick<CacheService, 'get' | 'set' | 'delete'> | null,
    private readonly pollMs = CLOUD_CLAIM_POLL_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Asks for a code and starts waiting for it; a new code replaces one still shown. */
  async start(actor: { userId: string | null } = { userId: null }): Promise<CloudConnectCodeView> {
    if (await this.service.isEnrolled()) {
      throw new CloudLinkRequestError(
        409,
        'CLOUD_ALREADY_CONNECTED',
        'This Opfield installation is already connected; disconnect it first'
      );
    }
    this.stopPolling();
    let issued: Awaited<ReturnType<LicenseService['requestConnectCode']>>;
    try {
      issued = await this.license.requestConnectCode();
    } catch (error) {
      const code = error instanceof LicenseServerRequestError ? error.code : 'CLOUD_CONNECT_CODE_FAILED';
      await this.service.recordConnectCode(actor, {
        outcome: 'request_failed',
        errorCode: code,
        error: errorMessage(error),
      });
      throw new CloudLinkRequestError(
        error instanceof LicenseServerRequestError && error.status < 500 ? error.status : 502,
        code,
        error instanceof LicenseServerRequestError && error.code !== 'LICENSE_SERVER_UNAVAILABLE'
          ? error.message
          : 'The Opfield license service could not be reached to issue a code. Try again in a moment.',
        error instanceof LicenseServerRequestError ? error.code === 'LICENSE_SERVER_UNAVAILABLE' : true
      );
    }
    const attempt: StoredAttempt = {
      id: randomUUID(),
      state: 'pending',
      code: issued.code,
      expiresAt: issued.expiresAt,
      portalUrl: this.service.claimPortalUrl(issued.portalUrl),
      userId: actor.userId,
      accountEmail: null,
      error: null,
      errorCode: null,
    };
    await this.save(attempt);
    await this.service.recordConnectCode(actor, {
      outcome: 'requested',
      expiresAt: attempt.expiresAt,
      portalUrl: attempt.portalUrl,
    });
    this.schedule(attempt.id, this.pollMs);
    return view(attempt, this.now());
  }

  /** The code and its state, from whichever replica polls. */
  async status(): Promise<CloudConnectCodeView> {
    return view(await this.read(), this.now());
  }

  /** Stops waiting and forgets the code (the account can no longer link with it from here). */
  async cancel(actor: { userId: string | null } = { userId: null }): Promise<CloudConnectCodeView> {
    this.stopPolling();
    const attempt = await this.read();
    this.local = null;
    if (this.cache) await this.cache.delete(STATE_CACHE_KEY).catch(() => undefined);
    if (attempt?.state === 'pending') await this.service.recordConnectCode(actor, { outcome: 'cancelled' });
    return NONE;
  }

  stop(): void {
    this.stopPolling();
  }

  /** One poll of the portal; exposed for tests. False once the attempt finished (or was replaced or cancelled). */
  async pollOnce(id: string): Promise<boolean> {
    const attempt = await this.read();
    if (!attempt || attempt.id !== id || attempt.state !== 'pending') return false;
    const actor = { userId: attempt.userId };
    if (Date.parse(attempt.expiresAt) <= this.now()) {
      await this.finish(attempt, 'expired', 'CLOUD_CLAIM_EXPIRED', 'The code expired before it was entered.');
      await this.service.recordConnectCode(actor, { outcome: 'expired', errorCode: 'CLOUD_CLAIM_EXPIRED' });
      return false;
    }
    try {
      const result = await this.service.claim(attempt.code, attempt.portalUrl, actor);
      if (result.state === 'pending') return true;
      await this.save({ ...attempt, state: 'connected', accountEmail: result.status.accountEmail });
      return false;
    } catch (error) {
      if (error instanceof CloudLinkRequestError && error.retryable) {
        logger.debug('The cloud account could not be asked about the connect code; retrying', { error: error.message });
        return true;
      }
      const errorCode = error instanceof CloudLinkRequestError ? error.code : 'CLOUD_CONNECT_FAILED';
      const state = CLAIM_STATES[errorCode] ?? 'failed';
      await this.finish(attempt, state, errorCode, errorMessage(error));
      await this.service.recordConnectCode(actor, { outcome: state, errorCode, error: errorMessage(error) });
      return false;
    }
  }

  private async finish(
    attempt: StoredAttempt,
    state: CloudConnectCodeState,
    errorCode: string,
    error: string
  ): Promise<void> {
    await this.save({ ...attempt, state, errorCode, error });
  }

  private schedule(id: string, delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce(id)
        .catch((error) => {
          logger.warn('Polling the connect code failed', { error: errorMessage(error) });
          return true;
        })
        .then((again) => {
          if (again && this.local?.id === id) this.schedule(id, this.pollMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }

  private stopPolling(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async save(attempt: StoredAttempt): Promise<void> {
    this.local = attempt;
    if (!this.cache) return;
    const ttl = Math.max(60, Math.ceil((Date.parse(attempt.expiresAt) - this.now()) / 1000) + STATE_KEEP_SECONDS);
    await this.cache.set(STATE_CACHE_KEY, attempt, ttl).catch((error) => {
      logger.debug('Could not share the connect code state', { error: errorMessage(error) });
    });
  }

  private async read(): Promise<StoredAttempt | null> {
    if (!this.cache) return this.local;
    try {
      return (await this.cache.get<StoredAttempt>(STATE_CACHE_KEY)) ?? null;
    } catch {
      return this.local;
    }
  }
}
