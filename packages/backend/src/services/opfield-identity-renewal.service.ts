import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, gt, isNotNull } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/index.js';
import type { RelayControlClient, RelayIdentityActivation } from '@/grpc/relay-control.client.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { GrpcIdentityService } from './grpc-identity.service.js';
import {
  OPFIELD_GRPC_CERTIFICATE_FINAL_RENEW_BEFORE_MS,
  OPFIELD_IDENTITY_RENEW_BEFORE_MS,
} from './grpc-server-certificate.js';
import type { AppRelayIdentity, RelayIdentityProvisionerService } from './relay-identity-provisioner.service.js';
import type { WebIdentityService } from './web-identity.service.js';

const logger = createChildLogger('OpfieldIdentityRenewal');

/** How often the scheduler asks whether an identity is due. */
export const OPFIELD_IDENTITY_RENEWAL_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Conditions that persist across checks are logged at most daily. */
const REPEATED_WARNING_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type OpfieldIdentityName = 'grpc' | 'web';

/** The running gRPC listener, as grpc/server.ts exposes it. */
export interface GrpcListenerControl {
  /** Validates the material, then serves it to new handshakes; throws and keeps the current material otherwise. */
  refreshCredentials(certPath: string, keyPath: string): Promise<void>;
  /** The certificate new handshakes receive, or null when the listener is not running. */
  servedCertificate(): Buffer | null;
  /** Trusts the next relay client certificate next to the current one; the returned commit drops the old one. */
  stageRelayTrust(relayClientFingerprint: string): () => void;
}

export interface OpfieldIdentityRenewalDeps {
  env: Pick<Env, 'OPFIELD_RELAY_REQUIRED' | 'GRPC_TLS_CERT'>;
  grpcIdentity: Pick<GrpcIdentityService, 'resolve' | 'refresh' | 'markServed'>;
  grpcListener: GrpcListenerControl;
  /** Present when Opfield runs behind its local relay. */
  relayIdentity?: Pick<RelayIdentityProvisionerService, 'refresh' | 'installedCertificatePaths'>;
  relayControl?: Pick<RelayControlClient, 'reloadIdentity' | 'setIdentityActivationListener'>;
  /** The relay identity provisioned at start-up, which the relay loaded as it started. */
  startupRelayIdentity?: Pick<AppRelayIdentity, 'materialDigest'>;
  /** Tells Opfield's own relay tunnel clients which client certificate they now present. */
  onAppClientFingerprint?: (fingerprint: string) => void;
  webIdentity?: Pick<WebIdentityService, 'resolve' | 'reloadServed' | 'servedCertificate'>;
  /** True while enrollment tokens are outstanding: their install commands pin the gRPC certificate. */
  hasPendingEnrollments?: () => Promise<boolean>;
  audit?: Pick<AuditService, 'log'>;
  now?: () => number;
}

export interface OpfieldIdentityRefreshResult {
  /** null without a local relay; false while the relay has not confirmed the new identity. */
  relayConfirmed: boolean | null;
}

export interface OpfieldIdentityRenewalResult {
  renewed: OpfieldIdentityName[];
  failed: Array<{ identity: OpfieldIdentityName; message: string }>;
  relayConfirmed: boolean | null;
}

interface DueMaterial {
  label: string;
  reason: 'expiring' | 'unreadable' | 'not_served';
  expiresAt: string | null;
  /** The certificate daemons are served, whose fingerprint enrollment commands pin. */
  advertised: boolean;
}

interface PendingRelayActivation {
  digest: string;
  appClientFingerprint: string;
  relayClientFingerprint: string;
  externalFingerprint: string;
  commitTrust: () => void;
}

function readCertificate(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function expiresAt(certificatePem: Buffer | null): number | null {
  if (!certificatePem) return null;
  try {
    const validTo = Date.parse(new X509Certificate(certificatePem).validTo);
    return Number.isFinite(validTo) ? validTo : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a relay reload moved Opfield onto the installed client for a relay that loaded the installed files. */
function relayLoaded(pending: PendingRelayActivation, activation: RelayIdentityActivation): boolean {
  if (activation.certificateSha256 !== pending.appClientFingerprint) return false;
  const loaded = activation.loaded;
  // Relays built before they reported what they loaded read the files at the reload, which is
  // sent only after the files were installed.
  if (!loaded) return true;
  return (
    loaded.appClientCertificateSha256 === pending.appClientFingerprint &&
    loaded.relayClientCertificateSha256 === pending.relayClientFingerprint &&
    loaded.externalCertificateSha256 === pending.externalFingerprint
  );
}

/** Enrollment tokens that can still be used; their install commands pin the gRPC certificate. */
export async function hasUnexpiredEnrollmentTokens(db: DrizzleClient, now = new Date()): Promise<boolean> {
  const [token] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(isNotNull(nodes.enrollmentTokenHash), gt(nodes.enrollmentTokenExpiresAt, now)))
    .limit(1);
  return Boolean(token);
}

/**
 * Keeps Opfield's own TLS identities valid while it runs: the gRPC listener certificate, the
 * local relay's service identities (its external listener copy, Opfield's internal listener,
 * and the client certificates both sides use toward each other), and the native web listener.
 *
 * They are issued for 365 days and were renewed only at start-up, so an Opfield running for a
 * year broke. Now an hourly check renews anything within OPFIELD_IDENTITY_RENEW_BEFORE_MS of
 * expiry and switches the running listeners to it: new handshakes get the new certificate and
 * established daemon and relay connections keep theirs. Each step validates before it switches,
 * so a failed renewal leaves the current, still valid certificates in service and is retried on
 * the next check, weeks before anything expires.
 */
export class OpfieldIdentityRenewalService {
  private queue: Promise<unknown> = Promise.resolve();
  private appliedRelayDigest: string | null;
  private pendingRelayActivation: PendingRelayActivation | null = null;
  private readonly warnedAt = new Map<string, number>();

  constructor(private readonly deps: OpfieldIdentityRenewalDeps) {
    this.appliedRelayDigest = deps.startupRelayIdentity?.materialDigest ?? null;
    // Any confirmed reload counts, including one a later admin call converged.
    deps.relayControl?.setIdentityActivationListener((activation) => this.onRelayIdentityActivated(activation));
  }

  /**
   * Re-resolves the gRPC identity and, behind the local relay, the relay service identities,
   * renewing what is due, and switches the running listener and relay to them. Shared by settings
   * changes, first-run setup and renewal. Throws when Opfield's listener could not be switched; it
   * keeps its current material then. A relay that does not confirm is not an error: both relay
   * client identities stay trusted and the reload is retried.
   */
  refreshGrpcIdentity(): Promise<OpfieldIdentityRefreshResult> {
    return this.serialized(() => this.performGrpcRefresh());
  }

  /** Renews and hot-reloads every identity that is due. Runs from the scheduler. */
  renewDue(): Promise<OpfieldIdentityRenewalResult> {
    return this.serialized(() => this.performRenewal());
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async performGrpcRefresh(options: { renewBeforeMs?: number } = {}): Promise<OpfieldIdentityRefreshResult> {
    const { grpcIdentity, grpcListener, relayIdentity } = this.deps;
    const external = await grpcIdentity.refresh(options);
    if (!this.deps.env.OPFIELD_RELAY_REQUIRED || !relayIdentity) {
      await grpcListener.refreshCredentials(external.certPath, external.keyPath);
      // Daemons connect to this listener: new enrollment commands may pin what it serves now.
      grpcIdentity.markServed(external.opfieldCertSha256);
      return { relayConfirmed: null };
    }

    const identity = await relayIdentity.refresh();
    if (
      (identity.materialDigest !== this.appliedRelayDigest || this.pendingRelayActivation) &&
      identity.materialDigest !== this.pendingRelayActivation?.digest
    ) {
      // The relay client certificate on disk may be new, and a relay that restarts presents it.
      // Trust it before anything below can fail.
      this.pendingRelayActivation = {
        digest: identity.materialDigest,
        appClientFingerprint: identity.appClientFingerprint,
        relayClientFingerprint: identity.relayClientFingerprint,
        externalFingerprint: identity.externalFingerprint,
        commitTrust: grpcListener.stageRelayTrust(identity.relayClientFingerprint),
      };
    }
    // The relay verifies this listener against the system CA, so switching it first is safe.
    await grpcListener.refreshCredentials(identity.internalServerCertPath, identity.internalServerKeyPath);
    // Nothing the relay loads changed: reloading it would only move its upstream connection.
    if (!this.pendingRelayActivation) return { relayConfirmed: true };
    return { relayConfirmed: await this.activateRelayIdentity() };
  }

  /**
   * Has the relay load the installed identity files. Only onRelayIdentityActivated confirms, for a
   * relay that loaded exactly these files; until then Opfield trusts both relay client
   * certificates and keeps its previous admin client, so neither side locks the other out.
   */
  private async activateRelayIdentity(): Promise<boolean> {
    const pending = this.pendingRelayActivation;
    if (!pending) return true;
    const relayControl = this.deps.relayControl;
    if (!relayControl) return false;
    try {
      await relayControl.reloadIdentity();
    } catch (error) {
      logger.warn('Relay identity refresh was not acknowledged; retaining both trusted relay identities', {
        error: errorMessage(error),
      });
      return false;
    }
    return this.pendingRelayActivation !== pending;
  }

  /**
   * Opfield moved to a relay client identity. Its own tunnel clients follow whatever it presents
   * now. When the relay loaded the installed files, the rotation is done: the relay serves the
   * installed external certificate, and its previous client certificate is no longer trusted.
   */
  private onRelayIdentityActivated(activation: RelayIdentityActivation): void {
    if (activation.certificateSha256) this.deps.onAppClientFingerprint?.(activation.certificateSha256);
    const pending = this.pendingRelayActivation;
    if (!pending || !relayLoaded(pending, activation)) return;
    this.pendingRelayActivation = null;
    this.appliedRelayDigest = pending.digest;
    if (pending.externalFingerprint) this.deps.grpcIdentity.markServed(pending.externalFingerprint);
    pending.commitTrust();
  }

  private async performRenewal(): Promise<OpfieldIdentityRenewalResult> {
    const result: OpfieldIdentityRenewalResult = { renewed: [], failed: [], relayConfirmed: null };
    // One identity failing, even in its checks, must not keep the other from renewing.
    try {
      await this.renewGrpc(result);
    } catch (error) {
      this.recordFailure(result, 'grpc', error, []);
    }
    if (result.relayConfirmed === false) {
      logger.warn('The local relay has not loaded the renewed identity yet; retrying on the next check');
    }
    try {
      await this.renewWeb(result);
    } catch (error) {
      this.recordFailure(result, 'web', error, []);
    }
    return result;
  }

  private async renewGrpc(result: OpfieldIdentityRenewalResult): Promise<void> {
    let renewBeforeMs = OPFIELD_IDENTITY_RENEW_BEFORE_MS;
    let due = await this.dueGrpcMaterial(renewBeforeMs);
    if (
      due.some(({ advertised, reason }) => advertised && reason === 'expiring') &&
      (await this.enrollmentsPending())
    ) {
      const finalDue = await this.dueGrpcMaterial(OPFIELD_GRPC_CERTIFICATE_FINAL_RENEW_BEFORE_MS);
      if (finalDue.some(({ advertised, reason }) => advertised && reason === 'expiring')) {
        this.warnDaily(
          'enrollment-renewal',
          'Renewing the gRPC certificate in its last week although enrollment tokens are outstanding; their install commands pin the previous certificate and must be generated again'
        );
      } else {
        renewBeforeMs = OPFIELD_GRPC_CERTIFICATE_FINAL_RENEW_BEFORE_MS;
        due = finalDue;
        this.warnDaily(
          'enrollment-postponed',
          'Postponing renewal of the gRPC certificate while enrollment tokens are outstanding, because their install commands pin it; it is renewed once they are used or expire, or in its last week'
        );
      }
    }

    if (!due.length) {
      if (this.pendingRelayActivation) result.relayConfirmed = await this.activateRelayIdentity();
      return;
    }
    logger.info('Renewing Opfield gRPC identity', { due });
    try {
      result.relayConfirmed = (await this.performGrpcRefresh({ renewBeforeMs })).relayConfirmed;
      const stillDue = await this.dueGrpcMaterial(renewBeforeMs);
      if (stillDue.length) {
        throw new Error(`Renewal left ${stillDue.map(({ label }) => label).join(', ')} due`);
      }
      result.renewed.push('grpc');
      await this.recordRenewal('grpc', due);
    } catch (error) {
      this.recordFailure(result, 'grpc', error, due);
    }
  }

  private async renewWeb(result: OpfieldIdentityRenewalResult): Promise<void> {
    const webIdentity = this.deps.webIdentity;
    const due = await this.dueWebMaterial();
    if (!webIdentity || !due.length) return;
    logger.info('Renewing Opfield web identity', { due });
    try {
      await webIdentity.reloadServed();
      const stillDue = await this.dueWebMaterial();
      if (stillDue.length) {
        throw new Error(`Renewal left ${stillDue.map(({ label }) => label).join(', ')} due`);
      }
      result.renewed.push('web');
      await this.recordRenewal('web', due);
    } catch (error) {
      this.recordFailure(result, 'web', error, due);
    }
  }

  private recordFailure(
    result: OpfieldIdentityRenewalResult,
    identity: OpfieldIdentityName,
    error: unknown,
    due: DueMaterial[]
  ): void {
    result.failed.push({ identity, message: errorMessage(error) });
    logger.error(`Opfield ${identity} identity renewal failed; the current certificates stay in service`, {
      error: errorMessage(error),
      due,
    });
  }

  private async enrollmentsPending(): Promise<boolean> {
    try {
      return (await this.deps.hasPendingEnrollments?.()) ?? false;
    } catch (error) {
      // Not knowing must not hold renewal back.
      logger.warn('Could not check for outstanding enrollment tokens', { error: errorMessage(error) });
      return false;
    }
  }

  /** @param advertisedRenewBeforeMs Renewal window for the certificate daemons are served. */
  private async dueGrpcMaterial(advertisedRenewBeforeMs: number): Promise<DueMaterial[]> {
    const { env, grpcIdentity, grpcListener, relayIdentity } = this.deps;
    const now = this.now();
    const due: DueMaterial[] = [];
    const external = await grpcIdentity.resolve();
    const externalPem = readCertificate(external.certPath);
    const operatorSupplied = Boolean(env.GRPC_TLS_CERT);
    if (operatorSupplied) this.warnIfOperatorCertificateExpires(externalPem, now);
    else this.checkExpiry(due, 'gRPC listener certificate', externalPem, now, advertisedRenewBeforeMs, true);

    const relayPaths = env.OPFIELD_RELAY_REQUIRED ? relayIdentity?.installedCertificatePaths() : undefined;
    if (relayPaths) {
      const relayExternal = readCertificate(relayPaths.externalServer);
      if (!operatorSupplied) {
        this.checkExpiry(due, 'relay external certificate', relayExternal, now, advertisedRenewBeforeMs, true);
      }
      if (externalPem && relayExternal && !externalPem.equals(relayExternal)) {
        due.push({ label: 'relay external certificate', reason: 'not_served', expiresAt: null, advertised: true });
      }
      const window = OPFIELD_IDENTITY_RENEW_BEFORE_MS;
      const internal = readCertificate(relayPaths.appInternalServer);
      this.checkExpiry(due, 'Opfield internal listener certificate', internal, now, window, false);
      const appClient = readCertificate(relayPaths.appRelayClient);
      this.checkExpiry(due, 'Opfield relay client certificate', appClient, now, window, false);
      const relayClient = readCertificate(relayPaths.relayAppClient);
      this.checkExpiry(due, 'relay client certificate', relayClient, now, window, false);
    }

    // The listener must serve what is installed: a renewal whose switch failed is retried here.
    const served = grpcListener.servedCertificate();
    if (served) {
      const installed = relayPaths ? readCertificate(relayPaths.appInternalServer) : externalPem;
      if (installed && !served.equals(installed)) {
        due.push({ label: 'served gRPC certificate', reason: 'not_served', expiresAt: null, advertised: !relayPaths });
      } else if (relayPaths) {
        this.checkExpiry(due, 'served gRPC certificate', served, now, OPFIELD_IDENTITY_RENEW_BEFORE_MS, false);
      } else if (!operatorSupplied) {
        this.checkExpiry(due, 'served gRPC certificate', served, now, advertisedRenewBeforeMs, true);
      }
    }
    return due;
  }

  private async dueWebMaterial(): Promise<DueMaterial[]> {
    const webIdentity = this.deps.webIdentity;
    const served = webIdentity?.servedCertificate();
    if (!webIdentity || !served) return [];
    const now = this.now();
    const window = OPFIELD_IDENTITY_RENEW_BEFORE_MS;
    const due: DueMaterial[] = [];
    const installed = readCertificate((await webIdentity.resolve()).certPath);
    this.checkExpiry(due, 'web listener certificate', installed, now, window, false);
    if (installed && !served.equals(installed)) {
      due.push({ label: 'served web certificate', reason: 'not_served', expiresAt: null, advertised: false });
    } else {
      this.checkExpiry(due, 'served web certificate', served, now, window, false);
    }
    return due;
  }

  private checkExpiry(
    due: DueMaterial[],
    label: string,
    certificatePem: Buffer | null,
    now: number,
    renewBeforeMs: number,
    advertised: boolean
  ): void {
    const expiry = expiresAt(certificatePem);
    if (expiry === null) {
      due.push({ label, reason: 'unreadable', expiresAt: null, advertised });
    } else if (expiry - now <= renewBeforeMs) {
      due.push({ label, reason: 'expiring', expiresAt: new Date(expiry).toISOString(), advertised });
    }
  }

  private warnIfOperatorCertificateExpires(certificatePem: Buffer | null, now: number): void {
    const expiry = expiresAt(certificatePem);
    if (expiry !== null && expiry - now > OPFIELD_IDENTITY_RENEW_BEFORE_MS) return;
    this.warnDaily(
      'operator-certificate',
      'The gRPC certificate configured by GRPC_TLS_CERT expires soon and cannot be renewed by Opfield',
      { expiresAt: expiry === null ? null : new Date(expiry).toISOString() }
    );
  }

  private warnDaily(key: string, message: string, details?: Record<string, unknown>): void {
    const now = this.now();
    if (now - (this.warnedAt.get(key) ?? Number.NEGATIVE_INFINITY) < REPEATED_WARNING_INTERVAL_MS) return;
    this.warnedAt.set(key, now);
    logger.warn(message, details);
  }

  private async recordRenewal(identity: OpfieldIdentityName, due: DueMaterial[]): Promise<void> {
    logger.info('Renewed Opfield identity without a restart', { identity });
    await this.deps.audit
      ?.log({
        userId: null,
        action: 'system.identity.renew',
        resourceType: 'system',
        resourceId: identity,
        details: { due },
      })
      .catch(() => undefined);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
