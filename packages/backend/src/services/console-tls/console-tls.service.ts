import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { serve } from '@hono/node-server';
import * as acme from 'acme-client';
import { createChildLogger } from '@/lib/logger.js';
import type { ACMEService } from '@/modules/ssl/acme.service.js';
import {
  ALERT_REPEAT_MS,
  type CertificateValidity,
  type ConsoleTlsAlertLevel,
  failureAlertLevel,
  isRenewalDue,
  MAX_CHECK_INTERVAL_MS,
  nextCheckDelayMs,
  orderRetryDelayMs,
  probeRetryDelayMs,
  renewalDueAt,
  shouldOrder,
} from './console-tls-policy.js';

const logger = createChildLogger('ConsoleTLS');

const CHALLENGE_PREFIX = '/.well-known/acme-challenge/';
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_LOG_INTERVAL_MS = 10 * 60 * 1000;
const FALLBACK_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
}

type ServedSource = 'acme' | 'fallback';
type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface ConsoleTlsDeps {
  domain: string;
  email: string;
  staging: boolean;
  /** Where the certificate, its key, the ACME account key and the state live (the app's data volume). */
  stateDir: string;
  httpsPort: number;
  httpPort: number;
  bindHost: string;
  /** A dedicated ACME client (its challenge callbacks are set here); never the route certificate one. */
  acme: Pick<ACMEService, 'requestCertHTTP01' | 'onChallengeCreate' | 'onChallengeRemove'>;
  /** The certificate served until Let's Encrypt issued one: the Gateway web identity (System CA). */
  fallback: () => Promise<TlsMaterial>;
  publicUrl: { get: () => Promise<string | null>; set: (url: string) => Promise<void> };
  alert: (level: Exclude<ConsoleTlsAlertLevel, null>, message: string) => Promise<void>;
  /** GET a URL as text, null when it does not answer 200. Replaced in tests. */
  probe?: (url: string) => Promise<string | null>;
  now?: () => Date;
}

interface StoredState {
  domain?: string;
}

/** The answer of the port-80 listener: ACME challenges, everything else redirected to the console over HTTPS. */
export function consoleHttpResponse(
  url: string | undefined,
  method: string | undefined,
  domain: string,
  challenges: ReadonlyMap<string, string>
): { status: number; headers: Record<string, string>; body: string } {
  const target = url?.startsWith('/') ? url : '/';
  const path = target.split('?')[0]!;
  if (path.startsWith(CHALLENGE_PREFIX)) {
    const content = challenges.get(path.slice(CHALLENGE_PREFIX.length));
    return content === undefined
      ? { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' }
      : { status: 200, headers: { 'content-type': 'text/plain' }, body: content };
  }
  const status = method === 'GET' || method === 'HEAD' ? 301 : 308;
  return { status, headers: { location: `https://${domain}${target}`, 'content-type': 'text/plain' }, body: '' };
}

async function defaultProbe(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.status === 200 ? await response.text() : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validity(certPem: Buffer | string): CertificateValidity & { certificate: X509Certificate } {
  const certificate = new X509Certificate(certPem);
  return { certificate, notBefore: new Date(certificate.validFrom), notAfter: new Date(certificate.validTo) };
}

/**
 * The console on its own domain: an HTTPS listener (published as 443) with a Let's Encrypt certificate this
 * installation obtains over HTTP-01 on its port-80 listener, stores in its data, renews well before the end and
 * switches to without a restart. Until a certificate exists, and whenever issuance fails, the listener keeps serving
 * what it has (the Gateway web identity at first); attempts repeat with backoff and never stop the app.
 */
export class ConsoleTlsService {
  private readonly challenges = new Map<string, string>();
  private readonly now: () => Date;
  private readonly probe: (url: string) => Promise<string | null>;
  private httpsServer: ReturnType<typeof serve> | null = null;
  private httpServer: Server | null = null;
  private fetchHandler: FetchHandler | null = null;
  private onHttpsListener: ((server: ReturnType<typeof serve>) => void) | null = null;
  private served: { source: ServedSource; material: TlsMaterial; validity: CertificateValidity } | null = null;
  private acmeValidity: CertificateValidity | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private orderFailures = 0;
  private probeFailures = 0;
  private lastOrderAt: Date | null = null;
  private nextOrderAllowedAt: Date | null = null;
  private failingSince: Date | null = null;
  private lastProbeLogAt = 0;
  private lastAlertAt = 0;
  private lastError: string | null = null;

  constructor(private readonly deps: ConsoleTlsDeps) {
    this.now = deps.now ?? (() => new Date());
    this.probe = deps.probe ?? defaultProbe;
    deps.acme.onChallengeCreate = async (token, content) => {
      this.challenges.set(token, content);
    };
    deps.acme.onChallengeRemove = async (token) => {
      this.challenges.delete(token);
    };
  }

  get domain(): string {
    return this.deps.domain;
  }

  /** What the HTTPS listener presents: the Let's Encrypt certificate, the fallback, or nothing yet. */
  status(): {
    source: ServedSource | null;
    notAfter: Date | null;
    renewalDueAt: Date | null;
    orderFailures: number;
    lastError: string | null;
  } {
    return {
      source: this.served?.source ?? null,
      notAfter: this.served?.validity.notAfter ?? null,
      renewalDueAt: this.acmeValidity ? renewalDueAt(this.acmeValidity) : null,
      orderFailures: this.orderFailures,
      lastError: this.lastError,
    };
  }

  /** The listeners to close on shutdown. */
  servers(): Server[] {
    return [this.httpsServer, this.httpServer].filter((server): server is Server => server !== null);
  }

  /**
   * Starts both listeners with the best certificate at hand, and the issuance loop. Never
   * throws: a failure is logged and retried by the loop.
   */
  async start(handler: FetchHandler, onHttpsListener?: (server: ReturnType<typeof serve>) => void): Promise<void> {
    this.fetchHandler = handler;
    this.onHttpsListener = onHttpsListener ?? null;
    try {
      await mkdir(this.deps.stateDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      logger.error('Cannot create the console certificate directory', { error: errorMessage(error) });
    }
    await this.loadInitialMaterial();
    this.startHttpListener();
    this.ensureHttpsListener();
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One pass of the issuance loop; returns how long to wait before the next one. */
  async runOnce(): Promise<number> {
    const now = this.now();
    if (this.served?.source === 'acme' && this.acmeValidity && !isRenewalDue(this.acmeValidity, now)) {
      return nextCheckDelayMs(this.acmeValidity, now);
    }
    if (this.served?.source !== 'acme') await this.refreshFallback();

    if (this.nextOrderAllowedAt && now < this.nextOrderAllowedAt) {
      return Math.min(MAX_CHECK_INTERVAL_MS, this.nextOrderAllowedAt.getTime() - now.getTime());
    }
    const reachable = await this.probeReachable();
    if (
      !shouldOrder({
        now,
        probeReachable: reachable,
        lastOrderAt: this.lastOrderAt,
        nextOrderAllowedAt: this.nextOrderAllowedAt,
      })
    ) {
      this.probeFailures += 1;
      this.failingSince ??= now;
      this.lastError = `http://${this.deps.domain}/ does not reach this installation yet`;
      if (now.getTime() - this.lastProbeLogAt >= PROBE_LOG_INTERVAL_MS) {
        this.lastProbeLogAt = now.getTime();
        logger.warn('Console domain does not reach this installation yet; waiting before ordering a certificate', {
          domain: this.deps.domain,
        });
      }
      await this.maybeAlert(now);
      return probeRetryDelayMs(this.probeFailures);
    }
    this.probeFailures = 0;
    this.lastOrderAt = now;
    try {
      const issued = await this.order();
      this.orderFailures = 0;
      this.nextOrderAllowedAt = null;
      this.failingSince = null;
      this.lastError = null;
      return nextCheckDelayMs(issued, this.now());
    } catch (error) {
      this.orderFailures += 1;
      this.failingSince ??= now;
      this.lastError = errorMessage(error);
      const delay = orderRetryDelayMs(this.orderFailures);
      this.nextOrderAllowedAt = new Date(now.getTime() + delay);
      logger.warn('Console certificate order failed; the current certificate stays and the order is retried', {
        domain: this.deps.domain,
        failures: this.orderFailures,
        retryInSeconds: Math.round(delay / 1000),
        servedNotAfter: this.served?.validity.notAfter.toISOString() ?? null,
        error: this.lastError,
      });
      await this.maybeAlert(now);
      return delay;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    let delay: number;
    try {
      delay = await this.runOnce();
    } catch (error) {
      logger.error('Console certificate check failed', { error: errorMessage(error) });
      delay = 60_000;
    }
    this.schedule(delay);
  }

  private path(name: string): string {
    return join(this.deps.stateDir, name);
  }

  private async readState(): Promise<StoredState> {
    try {
      return JSON.parse(await readFile(this.path('state.json'), 'utf8')) as StoredState;
    } catch {
      return {};
    }
  }

  private async writeAtomic(name: string, content: string | Buffer, mode: number): Promise<void> {
    const temporary = this.path(`${name}.tmp-${process.pid}`);
    await writeFile(temporary, content, { mode });
    await rename(temporary, this.path(name));
  }

  /**
   * Runs at start, before the listeners resolve their identities. Never throws.
   * The public URL follows the console domain: set when none is configured, and moved along when the domain changes
   * and the public URL still names the previous one. A public URL an administrator chose otherwise is kept.
   */
  async seedPublicUrl(): Promise<void> {
    try {
      await mkdir(this.deps.stateDir, { recursive: true, mode: 0o700 });
      await this.applyPublicUrl();
    } catch (error) {
      logger.warn('Could not set the public URL from the console domain', { error: errorMessage(error) });
    }
  }

  private async applyPublicUrl(): Promise<void> {
    const target = `https://${this.deps.domain}`;
    const state = await this.readState();
    const current = await this.deps.publicUrl.get();
    const previous = state.domain && state.domain !== this.deps.domain ? `https://${state.domain}` : null;
    if (!current || (previous && current === previous)) {
      await this.deps.publicUrl.set(target);
      logger.info('Public URL set from the console domain', { publicUrl: target, previous: current });
    }
    if (state.domain !== this.deps.domain) {
      await this.writeAtomic('state.json', `${JSON.stringify({ domain: this.deps.domain })}\n`, 0o600);
    }
  }

  private async loadInitialMaterial(): Promise<void> {
    const stored = await this.loadStored();
    if (stored) {
      this.apply('acme', stored);
      return;
    }
    await this.refreshFallback();
  }

  /** The stored certificate when it is for this domain, not expired, and matches its key. */
  private async loadStored(): Promise<TlsMaterial | null> {
    let material: TlsMaterial;
    try {
      material = { cert: await readFile(this.path('cert.pem')), key: await readFile(this.path('key.pem')) };
    } catch {
      return null;
    }
    try {
      const { certificate, notAfter } = validity(material.cert);
      if (!certificate.checkHost(this.deps.domain)) {
        logger.info('Stored console certificate is for another domain; a new one is ordered', {
          domain: this.deps.domain,
          subject: certificate.subjectAltName,
        });
        return null;
      }
      if (notAfter <= this.now()) {
        logger.warn('Stored console certificate expired; a new one is ordered', { notAfter: notAfter.toISOString() });
        return null;
      }
      createSecureContext(material);
      return material;
    } catch (error) {
      logger.warn('Stored console certificate is unusable; a new one is ordered', { error: errorMessage(error) });
      return null;
    }
  }

  /** Serves the current fallback while no Let's Encrypt certificate is in use, renewing it before it ends. */
  private async refreshFallback(): Promise<void> {
    if (this.served?.source === 'acme') return;
    try {
      const material = await this.deps.fallback();
      if (this.served && this.served.material.cert.equals(material.cert)) return;
      this.apply('fallback', material);
    } catch (error) {
      logger.warn('Console fallback certificate is unavailable', { error: errorMessage(error) });
    }
  }

  /** Validates the material and switches the HTTPS listener to it; new connections get it at once. */
  private apply(source: ServedSource, material: TlsMaterial): CertificateValidity {
    createSecureContext(material);
    const { notBefore, notAfter } = validity(material.cert);
    this.served = { source, material, validity: { notBefore, notAfter } };
    if (source === 'acme') this.acmeValidity = { notBefore, notAfter };
    if (this.httpsServer) {
      (this.httpsServer as unknown as { setSecureContext(options: TlsMaterial): void }).setSecureContext(material);
    } else {
      this.ensureHttpsListener();
    }
    logger.info('Console HTTPS certificate in use', { source, notAfter: notAfter.toISOString() });
    return { notBefore, notAfter };
  }

  private async accountKey(): Promise<string> {
    try {
      const existing = await readFile(this.path('account.key'), 'utf8');
      if (existing.includes('PRIVATE KEY')) return existing;
    } catch {
      // Created below.
    }
    const created = (await acme.crypto.createPrivateKey()).toString();
    await this.writeAtomic('account.key', created, 0o600);
    return created;
  }

  private async order(): Promise<CertificateValidity> {
    logger.info('Ordering the console certificate', { domain: this.deps.domain, staging: this.deps.staging });
    const result = await this.deps.acme.requestCertHTTP01(
      [this.deps.domain],
      this.deps.staging,
      this.deps.email,
      await this.accountKey()
    );
    const fullChain = [result.certificatePem.trim(), result.chainPem.trim()].filter(Boolean).join('\n');
    const material = { cert: Buffer.from(`${fullChain}\n`), key: Buffer.from(result.privateKeyPem) };
    createSecureContext(material);
    // Key first: a crash between the two writes leaves a certificate that does not match its key, which the next
    // start rejects and replaces, never a served pair that does not match.
    await this.writeAtomic('key.pem', material.key, 0o600);
    await this.writeAtomic('cert.pem', material.cert, 0o644);
    return this.apply('acme', material);
  }

  private async probeReachable(): Promise<boolean> {
    const token = `opfield-probe-${randomBytes(12).toString('hex')}`;
    const content = randomBytes(24).toString('hex');
    this.challenges.set(token, content);
    try {
      return (await this.probe(`http://${this.deps.domain}${CHALLENGE_PREFIX}${token}`))?.trim() === content;
    } finally {
      this.challenges.delete(token);
    }
  }

  private async maybeAlert(now: Date): Promise<void> {
    const level = failureAlertLevel({
      now,
      certificate: this.served?.source === 'acme' ? this.served.validity : null,
      failingSince: this.failingSince,
    });
    if (!level || now.getTime() - this.lastAlertAt < ALERT_REPEAT_MS) return;
    this.lastAlertAt = now.getTime();
    const ends =
      this.served?.source === 'acme' ? ` The current one ends ${this.served.validity.notAfter.toISOString()}.` : '';
    const message = `The Let's Encrypt certificate for ${this.deps.domain} could not be obtained: ${this.lastError ?? 'unknown error'}. Opfield keeps retrying; check that ${this.deps.domain} points at this host and port 80 is reachable.${ends}`;
    try {
      await this.deps.alert(level, message);
    } catch (error) {
      logger.warn('Could not raise the console certificate alert', { error: errorMessage(error) });
    }
  }

  private startHttpListener(): void {
    if (this.httpServer) return;
    const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const answer = consoleHttpResponse(request.url, request.method, this.deps.domain, this.challenges);
      response.writeHead(answer.status, answer.headers);
      response.end(request.method === 'HEAD' ? undefined : answer.body);
    });
    server.on('error', (error) =>
      logger.error('Console HTTP listener failed', { port: this.deps.httpPort, error: errorMessage(error) })
    );
    server.listen(this.deps.httpPort, this.deps.bindHost, () =>
      logger.info(
        `Console HTTP listener (ACME challenges, redirect to HTTPS) on ${this.deps.bindHost}:${this.deps.httpPort}`
      )
    );
    this.httpServer = server;
  }

  private ensureHttpsListener(): void {
    if (this.httpsServer || !this.served || !this.fetchHandler) return;
    const server = serve({
      fetch: this.fetchHandler,
      port: this.deps.httpsPort,
      hostname: this.deps.bindHost,
      createServer: createHttpsServer,
      serverOptions: { cert: this.served.material.cert, key: this.served.material.key },
    });
    server.on('error', (error) =>
      logger.error('Console HTTPS listener failed', { port: this.deps.httpsPort, error: errorMessage(error) })
    );
    logger.info(
      `Console HTTPS listener for https://${this.deps.domain} on ${this.deps.bindHost}:${this.deps.httpsPort}`
    );
    this.httpsServer = server;
    this.onHttpsListener?.(server);
  }
}

/** Reads a TLS pair from disk and renews the web identity first when it ends within a week. */
export async function readFallbackMaterial(
  resolve: () => Promise<{ certPath: string; keyPath: string }>,
  refresh: () => Promise<{ certPath: string; keyPath: string }>
): Promise<TlsMaterial> {
  let identity = await resolve();
  let cert = await readFile(identity.certPath);
  if (validity(cert).notAfter.getTime() - Date.now() <= FALLBACK_RENEW_BEFORE_MS) {
    identity = await refresh();
    cert = await readFile(identity.certPath);
  }
  return { cert, key: await readFile(identity.keyPath) };
}
