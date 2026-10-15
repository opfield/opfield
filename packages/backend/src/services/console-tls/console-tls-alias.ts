import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { ACMEService } from '@/modules/ssl/acme.service.js';
import {
  CHALLENGE_PREFIX,
  errorMessage,
  issuedMaterial,
  type TlsMaterial,
  validity,
  writeAtomic,
} from './console-tls-material.js';
import {
  ALERT_REPEAT_MS,
  type CertificateValidity,
  type ConsoleTlsAlertLevel,
  failureAlertLevel,
  isRenewalDue,
  isValidConsoleDomain,
  MAX_CHECK_INTERVAL_MS,
  nextCheckDelayMs,
  orderRetryDelayMs,
} from './console-tls-policy.js';

const logger = createChildLogger('ConsoleTLSAlias');

/** A new issuance of the same alias starts at most this often (Let's Encrypt limits failed validations). */
export const PUBLIC_ALIAS_ATTEMPT_INTERVAL_MS = 10 * 60 * 1000;
/** Hosts of Opfield's own cloud: never an alias. */
const RESERVED_ALIAS_ZONES = ['opfield.cloud', 'opfield.dev'];
const MAX_REMEMBERED_ATTEMPTS = 8;
const MIN_LOOP_DELAY_MS = 1_000;

export type PublicAliasState = 'none' | 'issuing' | 'active' | 'failed';

/** The answer of the public-alias cloud link request. */
export interface PublicAliasView {
  domain: string | null;
  state: PublicAliasState;
  error?: string;
}

/** What the installation keeps of its alias (settings `cloud:public-alias`); survives restarts. */
export interface StoredPublicAlias {
  /** The alias the account asked for; null when it asked for none. */
  domain: string | null;
  state: PublicAliasState;
  error: string | null;
  updatedAt: string;
  /** The alias whose certificate is served and which the public URL names (the previous one while a new one issues). */
  servedDomain: string | null;
  /** When each recent alias was last ordered (ISO). */
  attempts: Record<string, string>;
}

export interface ConsoleAliasDeps {
  /** The console domain (the base host); always served, and the public URL without an alias. */
  baseDomain: string;
  stateDir: string;
  email: string;
  staging: boolean;
  acme: Pick<ACMEService, 'requestCertHTTP01'>;
  accountKey: () => Promise<string>;
  /** The challenges the port-80 listener answers, shared with the console certificate. */
  challenges: Map<string, string>;
  probe: (url: string) => Promise<string | null>;
  store: { get(): Promise<StoredPublicAlias | null>; set(value: StoredPublicAlias): Promise<void> };
  /** The public URL, read and written through the system path (the cloud lock is for people, not for this). */
  publicUrl: { get(): Promise<string | null>; set(url: string): Promise<void> };
  alert: (level: Exclude<ConsoleTlsAlertLevel, null>, message: string) => Promise<void>;
  now?: () => Date;
}

/** The alias as a plain lowercase host name; refused with INVALID_PUBLIC_ALIAS when it cannot be one. */
export function normalizePublicAlias(value: string, baseDomain: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  const invalid = (message: string) => new AppError(400, 'INVALID_PUBLIC_ALIAS', message);
  if (!isValidConsoleDomain(domain) || domain.split('.').length < 2) {
    throw invalid('The custom domain must be a host name such as panel.example.com');
  }
  if (domain === baseDomain) throw invalid('The custom domain must differ from the installation address');
  if (RESERVED_ALIAS_ZONES.some((zone) => domain === zone || domain.endsWith(`.${zone}`))) {
    throw invalid('The custom domain cannot be under an Opfield domain');
  }
  return domain;
}

function emptyStored(now: Date): StoredPublicAlias {
  return {
    domain: null,
    state: 'none',
    error: null,
    updatedAt: now.toISOString(),
    servedDomain: null,
    attempts: {},
  };
}

export function publicAliasView(stored: StoredPublicAlias | null): PublicAliasView {
  if (!stored?.domain) return { domain: null, state: 'none' };
  return {
    domain: stored.domain,
    state: stored.state,
    ...(stored.state === 'failed' && stored.error ? { error: stored.error } : {}),
  };
}

/**
 * The second host of the console: a custom domain the cloud account gives a managed installation. Its Let's Encrypt
 * certificate is obtained over HTTP-01 on the console's port-80 listener, served by SNI next to the console
 * certificate, and renewed like it. Once issued, the public URL names the alias; the console domain keeps serving.
 * A failed issuance is not repeated by itself: only a new request (retry or another domain), at most every 10 minutes
 * per domain. While a new alias issues, the previous one keeps serving and stays the public URL.
 */
export class ConsoleAliasManager {
  private served: { domain: string; context: SecureContext; validity: CertificateValidity } | null = null;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private looping = false;
  private loopAgain = false;
  private stopped = false;
  private renewFailures = 0;
  private nextRenewAt: Date | null = null;
  private renewFailingSince: Date | null = null;
  private lastAlertAt = 0;

  constructor(private readonly deps: ConsoleAliasDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The context SNI picks for a server name: the alias certificate for its host, otherwise none (the console's). */
  contextFor(servername: string | undefined): SecureContext | undefined {
    if (!this.served || !servername) return undefined;
    return servername.toLowerCase().replace(/\.$/, '') === this.served.domain ? this.served.context : undefined;
  }

  /** The alias host the HTTPS listener serves, if any. */
  servedHosts(): string[] {
    return this.served ? [this.served.domain] : [];
  }

  async start(): Promise<void> {
    try {
      await this.exclusive(() => this.restore());
    } catch (error) {
      logger.warn('Could not restore the custom domain certificate', { error: errorMessage(error) });
    }
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async view(): Promise<PublicAliasView> {
    return publicAliasView(await this.deps.store.get());
  }

  /** Applies the alias the account asks for (idempotent) and answers its state at once; issuance runs behind it. */
  async desire(input: { domain: string | null; retry?: boolean }): Promise<PublicAliasView> {
    const view = await this.exclusive(() => this.applyDesired(input));
    if (view.state === 'issuing') this.kick();
    return view;
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async save(stored: StoredPublicAlias, patch: Partial<StoredPublicAlias>): Promise<StoredPublicAlias> {
    const next = { ...stored, ...patch, updatedAt: this.now().toISOString() };
    await this.deps.store.set(next);
    return next;
  }

  private async applyDesired(input: { domain: string | null; retry?: boolean }): Promise<PublicAliasView> {
    const stored = (await this.deps.store.get()) ?? emptyStored(this.now());
    if (input.domain === null) {
      const previous = this.served?.domain ?? stored.servedDomain;
      if (previous) {
        this.served = null;
        await this.deps.publicUrl.set(`https://${this.deps.baseDomain}`);
        await this.removeMaterial(previous);
        logger.info('Custom domain turned off; the public URL is the console domain again', { previous });
      }
      if (stored.domain !== null || stored.servedDomain !== null || stored.state !== 'none') {
        await this.save(stored, { domain: null, state: 'none', error: null, servedDomain: null });
      }
      return { domain: null, state: 'none' };
    }
    const domain = normalizePublicAlias(input.domain, this.deps.baseDomain);
    if (this.served?.domain === domain) {
      // Already served: put the public URL back on it if anything moved it.
      if ((await this.deps.publicUrl.get()) !== `https://${domain}`) {
        await this.deps.publicUrl.set(`https://${domain}`);
      }
      if (stored.domain !== domain || stored.state !== 'active' || stored.servedDomain !== domain) {
        await this.save(stored, { domain, state: 'active', error: null, servedDomain: domain });
      }
      return { domain, state: 'active' };
    }
    if (stored.domain !== domain || (stored.state === 'failed' && input.retry === true) || stored.state === 'none') {
      const next = await this.save(stored, { domain, state: 'issuing', error: null });
      return publicAliasView(next);
    }
    return publicAliasView(stored);
  }

  /** At start: serve the stored certificate of the alias in use, or issue it again when it is gone. */
  private async restore(): Promise<void> {
    const stored = await this.deps.store.get();
    if (!stored?.servedDomain) return;
    const material = await this.loadStored(stored.servedDomain);
    if (material) {
      this.install(stored.servedDomain, material);
      return;
    }
    // The certificate is gone (a new data volume): the console domain is the public URL until it is issued again.
    logger.warn('The custom domain certificate is missing; ordering it again', { domain: stored.servedDomain });
    const { [stored.servedDomain]: _dropped, ...attempts } = stored.attempts;
    await this.deps.publicUrl.set(`https://${this.deps.baseDomain}`);
    await this.save(stored, {
      servedDomain: null,
      attempts,
      ...(stored.domain === stored.servedDomain ? { state: 'issuing' as const, error: null } : {}),
    });
  }

  private install(domain: string, material: TlsMaterial): void {
    const context = createSecureContext({ cert: material.cert, key: material.key });
    const { notBefore, notAfter } = validity(material.cert);
    this.served = { domain, context, validity: { notBefore, notAfter } };
    logger.info('Custom domain certificate in use', { domain, notAfter: notAfter.toISOString() });
  }

  private kick(): void {
    if (this.stopped) return;
    if (this.looping) {
      this.loopAgain = true;
      return;
    }
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    this.looping = true;
    let delay: number;
    try {
      delay = await this.runOnce();
    } catch (error) {
      logger.error('Custom domain certificate check failed', { error: errorMessage(error) });
      delay = 60_000;
    } finally {
      this.looping = false;
    }
    if (this.loopAgain) {
      this.loopAgain = false;
      delay = 0;
    }
    this.schedule(delay);
  }

  /** One pass: renew the served certificate when due, then issue the asked-for alias when allowed. */
  async runOnce(): Promise<number> {
    let delay = MAX_CHECK_INTERVAL_MS;
    const served = this.served;
    if (served) {
      const now = this.now();
      if (isRenewalDue(served.validity, now) && (!this.nextRenewAt || now >= this.nextRenewAt)) {
        await this.renew(served.domain);
      }
      if (this.served) {
        const after = this.now();
        delay = this.nextRenewAt
          ? Math.min(delay, this.nextRenewAt.getTime() - after.getTime())
          : Math.min(delay, nextCheckDelayMs(this.served.validity, after));
      }
    }
    const stored = await this.deps.store.get();
    if (stored?.domain && stored.state === 'issuing' && stored.domain !== this.served?.domain) {
      const last = stored.attempts[stored.domain];
      const wait = last ? Date.parse(last) + PUBLIC_ALIAS_ATTEMPT_INTERVAL_MS - this.now().getTime() : 0;
      if (wait > 0) delay = Math.min(delay, wait);
      else await this.issue(stored.domain);
    }
    return Math.max(MIN_LOOP_DELAY_MS, delay);
  }

  private async renew(domain: string): Promise<void> {
    const now = this.now();
    try {
      const material = await this.order(domain);
      await this.exclusive(async () => {
        if (this.served?.domain !== domain) return;
        await this.writeMaterial(domain, material);
        this.install(domain, material);
      });
      this.renewFailures = 0;
      this.nextRenewAt = null;
      this.renewFailingSince = null;
    } catch (error) {
      this.renewFailures += 1;
      this.renewFailingSince ??= now;
      const delay = orderRetryDelayMs(this.renewFailures);
      this.nextRenewAt = new Date(now.getTime() + delay);
      const message = errorMessage(error);
      logger.warn('Custom domain certificate renewal failed; the current one stays and renewal is retried', {
        domain,
        failures: this.renewFailures,
        retryInSeconds: Math.round(delay / 1000),
        error: message,
      });
      await this.maybeAlert(domain, message, now);
    }
  }

  /** Orders the alias certificate once; the outcome is stored only when the account still asks for this alias. */
  private async issue(domain: string): Promise<void> {
    const started = await this.exclusive(async () => {
      const stored = await this.deps.store.get();
      if (!stored || stored.domain !== domain || stored.state !== 'issuing') return false;
      const attempts = Object.fromEntries(
        Object.entries({ ...stored.attempts, [domain]: this.now().toISOString() })
          .sort(([, a], [, b]) => Date.parse(b) - Date.parse(a))
          .slice(0, MAX_REMEMBERED_ATTEMPTS)
      );
      await this.save(stored, { attempts });
      return true;
    });
    if (!started) return;

    const reachable = await this.probeReachable(domain);
    let material: TlsMaterial | null = null;
    let failure: string | null = null;
    try {
      material = await this.order(domain);
    } catch (error) {
      const message = errorMessage(error);
      failure = reachable
        ? `Let's Encrypt did not issue a certificate for ${domain}: ${message}`
        : `DNS for ${domain} does not point to this installation (${message})`;
      logger.warn('Custom domain certificate was not issued', { domain, reachable, error: message });
    }

    await this.exclusive(async () => {
      const stored = await this.deps.store.get();
      // The account asked for another alias (or none) meanwhile: this outcome no longer matters.
      if (!stored || stored.domain !== domain) return;
      if (!material) {
        await this.save(stored, { state: 'failed', error: failure });
        return;
      }
      await this.writeMaterial(domain, material);
      const previous = this.served?.domain ?? stored.servedDomain;
      this.install(domain, material);
      this.renewFailures = 0;
      this.nextRenewAt = null;
      this.renewFailingSince = null;
      try {
        await this.deps.publicUrl.set(`https://${domain}`);
      } catch (error) {
        await this.save(stored, {
          state: 'failed',
          servedDomain: domain,
          error: `The certificate for ${domain} was issued, but the public URL could not be changed: ${errorMessage(error)}`,
        });
        return;
      }
      await this.save(stored, { state: 'active', error: null, servedDomain: domain });
      if (previous && previous !== domain) await this.removeMaterial(previous);
      logger.info('Custom domain is active; the public URL names it', { domain, previous });
    });
  }

  private async order(domain: string): Promise<TlsMaterial> {
    logger.info('Ordering the custom domain certificate', { domain, staging: this.deps.staging });
    const result = await this.deps.acme.requestCertHTTP01(
      [domain],
      this.deps.staging,
      this.deps.email,
      await this.deps.accountKey()
    );
    const material = issuedMaterial(result);
    createSecureContext(material);
    return material;
  }

  private async probeReachable(domain: string): Promise<boolean> {
    const token = `opfield-probe-${randomBytes(12).toString('hex')}`;
    const content = randomBytes(24).toString('hex');
    this.deps.challenges.set(token, content);
    try {
      return (await this.deps.probe(`http://${domain}${CHALLENGE_PREFIX}${token}`))?.trim() === content;
    } finally {
      this.deps.challenges.delete(token);
    }
  }

  private dir(domain: string): string {
    return join(this.deps.stateDir, domain);
  }

  private async writeMaterial(domain: string, material: TlsMaterial): Promise<void> {
    const dir = this.dir(domain);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Key first: a crash between the writes leaves a pair the next start rejects, never a served mismatch.
    await writeAtomic(dir, 'key.pem', material.key, 0o600);
    await writeAtomic(dir, 'cert.pem', material.cert, 0o644);
  }

  private async removeMaterial(domain: string): Promise<void> {
    await rm(this.dir(domain), { recursive: true, force: true }).catch((error) =>
      logger.warn('Could not remove the previous custom domain certificate', { domain, error: errorMessage(error) })
    );
  }

  /** The stored certificate when it is for this alias, not expired, and matches its key. */
  private async loadStored(domain: string): Promise<TlsMaterial | null> {
    try {
      const material = {
        cert: await readFile(join(this.dir(domain), 'cert.pem')),
        key: await readFile(join(this.dir(domain), 'key.pem')),
      };
      const { certificate, notAfter } = validity(material.cert);
      if (!certificate.checkHost(domain) || notAfter <= this.now()) return null;
      createSecureContext(material);
      return material;
    } catch {
      return null;
    }
  }

  private async maybeAlert(domain: string, error: string, now: Date): Promise<void> {
    const level = failureAlertLevel({
      now,
      certificate: this.served?.validity ?? null,
      failingSince: this.renewFailingSince,
    });
    if (!level || now.getTime() - this.lastAlertAt < ALERT_REPEAT_MS) return;
    this.lastAlertAt = now.getTime();
    const ends = this.served ? ` The current one ends ${this.served.validity.notAfter.toISOString()}.` : '';
    try {
      await this.deps.alert(
        level,
        `The Let's Encrypt certificate for the custom domain ${domain} could not be renewed: ${error}. Opfield keeps retrying; check that ${domain} still points at this installation.${ends}`
      );
    } catch (alertError) {
      logger.warn('Could not raise the custom domain certificate alert', { error: errorMessage(alertError) });
    }
  }
}
