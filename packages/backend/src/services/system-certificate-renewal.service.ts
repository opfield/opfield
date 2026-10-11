import { X509Certificate } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { systemCertificateRenewals } from '@/db/schema/index.js';
import type { SystemCertificateRenewalRow } from '@/db/schema/system-certificate-renewals.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from './event-bus.service.js';

const logger = createChildLogger('SystemCertificateRenewal');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How often the scheduler asks every owner whether its certificate is due. */
export const SYSTEM_CERTIFICATE_RENEWAL_CHECK_INTERVAL_MS = HOUR_MS;
/** Renew once this many days or fewer remain, whatever the lifetime. */
export const RENEW_BEFORE_EXPIRY_MS = 30 * DAY_MS;
/** Inside this window a restart or recreate is acceptable to get the new certificate served. */
export const URGENT_BEFORE_EXPIRY_MS = 7 * DAY_MS;
/** Renew once this share of the lifetime has passed (a 365-day leaf at about 122 days left). */
export const RENEW_AFTER_LIFETIME_FRACTION = 2 / 3;
const BACKOFF_BASE_MS = HOUR_MS;
const BACKOFF_MAX_MS = DAY_MS;
/** A delivered certificate the engine still does not serve after this long is a failure. */
const AWAITING_RELOAD_LIMIT_MS = 6 * HOUR_MS;
/** A backup waiting for a certificate does not retrigger a delivery more often than this. */
const ON_DEMAND_RETRY_MS = 5 * 60 * 1000;
/** Bounds for rechecking a delivered certificate the engine rereads on its own interval. */
/** Validity of a renewed leaf when the owner does not say (the Storage and Database CAs issue 365 days). */
const DEFAULT_RENEWED_VALIDITY_DAYS = 365;
/** A renewal must extend the certificate by more than this to be worth issuing. */
const CA_END_MARGIN_MS = DAY_MS;
const RECHECK_MIN_MS = 60 * 1000;
const SCHEDULE_TOLERANCE_MS = 60 * 1000;
const RECHECK_MARGIN_MS = 30 * 1000;
/** A "not served yet" answer is reused this long, so a waiting run does not probe the node on every tick. */
const NOT_READY_CACHE_MS = 60 * 1000;

export type RenewableOwnerType = 'managed_storage' | 'managed_database';

export type RenewalReason =
  | 'manual'
  | 'expiring'
  | 'lifetime'
  | 'names_missing'
  | 'usage_missing'
  | 'ca_changed'
  | 'served_mismatch'
  | 'awaiting_reload';

export type RenewalSkipReason =
  | 'paused'
  | 'node_offline'
  | 'operation_pending'
  | 'not_ready'
  | 'tls_disabled'
  | 'ca_limit';

export interface RenewalCertificate {
  id: string;
  serialNumber: string;
  caId: string;
  notBefore: Date;
  notAfter: Date;
  sans: string[];
  /** Extended key usages of the leaf (serverAuth, clientAuth); absent when the owner type does not track them. */
  extKeyUsage?: string[];
  certificatePem: string;
}

export interface SystemCertificateRenewalTarget {
  ownerType: RenewableOwnerType;
  ownerId: string;
  /** Human name for audit entries and alerts. */
  name: string;
  /** Audit resource type of the owning resource. */
  resourceType: string;
  /** Set when the owner cannot take a delivery right now; it is checked again next time. */
  skipReason?: RenewalSkipReason;
  current: RenewalCertificate | null;
  /** The system CA a renewed leaf is issued by; a current leaf from another CA is renewed. */
  expectedCaId: string;
  /** Names the certificate must carry (stable node identity, loopback names). */
  requiredSans: string[];
  /** Extended key usages the certificate must carry (a database set member's leaf is its replication client too). */
  requiredExtKeyUsage?: string[];
  /** Every node daemon of the owner reports `managed_tls_reload_v1`. */
  supportsHotReload: boolean;
  /** When the issuing CA expires: a renewed leaf is clamped to it. */
  issuerNotAfter?: Date;
  /** Validity a renewed leaf is requested with (365 days when omitted). */
  renewedValidityDays?: number;
}

export interface RenewalDeliveryResult {
  status: 'reloaded' | 'pending';
  servedFingerprint: string;
  restarted: boolean;
  method: string;
  reloadIntervalSeconds?: number;
}

export interface ServedCertificateInfo {
  fingerprintSha256: string;
  dnsNames: string[];
  ipAddresses: string[];
}

/** One owner type's side of the renewal: its rows, its CA and its daemon command. */
export interface SystemCertificateRenewalAdapter {
  readonly ownerType: RenewableOwnerType;
  listTargets(): Promise<SystemCertificateRenewalTarget[]>;
  getTarget(ownerId: string): Promise<SystemCertificateRenewalTarget | null>;
  /** Stages (or reuses) a pending leaf without touching the current one. */
  issuePending(target: SystemCertificateRenewalTarget): Promise<RenewalCertificate>;
  /** Pending leaf of the owner, when one is staged. */
  findPending(target: SystemCertificateRenewalTarget): Promise<RenewalCertificate | null>;
  /** Sends the certificate to the running workload without putting it into `updating`. */
  deliver(
    target: SystemCertificateRenewalTarget,
    certificate: RenewalCertificate,
    options: { allowRestart: boolean }
  ): Promise<RenewalDeliveryResult>;
  /** The certificate the workload serves now. */
  probe(target: SystemCertificateRenewalTarget): Promise<ServedCertificateInfo>;
  /** Makes the served pending leaf current (retires the previous one) and points the owner at it. */
  promote(target: SystemCertificateRenewalTarget, pending: RenewalCertificate): Promise<void>;
  /**
   * Restart/recreate path for daemons without hot reload: an update carrying
   * the pending leaf, which the owner's operation-success hook promotes only
   * after the daemon applied it. It never promotes before that.
   */
  fallback(target: SystemCertificateRenewalTarget, pending: RenewalCertificate): Promise<void>;
}

export interface RenewalEvaluation {
  due: boolean;
  reason: RenewalReason | null;
  urgent: boolean;
  daysRemaining: number;
  missingNames: string[];
}

/**
 * When a system leaf must be replaced: two thirds of its lifetime passed,
 * 30 days or fewer remain, a required name is missing (node address change,
 * loopback names), a required usage is missing (a database that became a set
 * member), or it was issued by a CA other than the current one.
 */
export function evaluateCertificateRenewal(
  certificate: Pick<RenewalCertificate, 'notBefore' | 'notAfter' | 'sans' | 'caId' | 'extKeyUsage'>,
  desired: { requiredSans: readonly string[]; expectedCaId: string; requiredExtKeyUsage?: readonly string[] },
  now = new Date()
): RenewalEvaluation {
  const remainingMs = certificate.notAfter.getTime() - now.getTime();
  const lifetimeMs = Math.max(1, certificate.notAfter.getTime() - certificate.notBefore.getTime());
  const present = new Set(certificate.sans.map((name) => name.toLowerCase()));
  const missingNames = [...new Set(desired.requiredSans)].filter((name) => !present.has(name.toLowerCase()));
  const urgent = remainingMs <= URGENT_BEFORE_EXPIRY_MS;
  const daysRemaining = Math.floor(remainingMs / DAY_MS);
  const reason: RenewalReason | null =
    certificate.caId !== desired.expectedCaId
      ? 'ca_changed'
      : missingNames.length > 0
        ? 'names_missing'
        : certificate.extKeyUsage &&
            (desired.requiredExtKeyUsage ?? []).some((usage) => !certificate.extKeyUsage!.includes(usage))
          ? 'usage_missing'
          : remainingMs <= RENEW_BEFORE_EXPIRY_MS
            ? 'expiring'
            : now.getTime() - certificate.notBefore.getTime() >= lifetimeMs * RENEW_AFTER_LIFETIME_FRACTION
              ? 'lifetime'
              : null;
  return { due: reason !== null, reason, urgent, daysRemaining, missingNames };
}

/** Retry delay after `attempts` consecutive failures: 1h, 2h, 4h … capped at 24h (1h when urgent). */
export function renewalBackoffMs(attempts: number, urgent = false): number {
  if (urgent) return BACKOFF_BASE_MS;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/** SHA-256 of the DER certificate as lowercase hex, the daemon's fingerprint format. */
export function certificateFingerprintSha256(certificatePem: string): string {
  return new X509Certificate(certificatePem).fingerprint256.replaceAll(':', '').toLowerCase();
}

export type RenewalOutcomeStatus =
  | 'renewed'
  | 'awaiting_reload'
  | 'waiting_for_daemon'
  | 'not_due'
  | 'backoff'
  | 'skipped'
  | 'failed'
  | 'redelivered';

export interface RenewalOutcome {
  status: RenewalOutcomeStatus;
  reason?: RenewalReason | RenewalSkipReason | null;
  error?: string;
  restarted?: boolean;
  method?: string;
}

export interface CertificateRenewalStatusView {
  ownerType: RenewableOwnerType;
  ownerId: string;
  certificate: {
    id: string;
    serialNumber: string;
    notBefore: string;
    notAfter: string;
    daysRemaining: number;
    sans: string[];
  } | null;
  renewal: {
    state: string;
    reason: string | null;
    due: boolean;
    dueReason: RenewalReason | null;
    urgent: boolean;
    hotReloadSupported: boolean;
    skipReason: RenewalSkipReason | null;
    attempts: number;
    lastAttemptAt: string | null;
    nextAttemptAt: string | null;
    deliveredAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    lastMethod: string | null;
    lastRestarted: boolean;
    pendingSerial: string | null;
  };
}

/** Why a managed certificate needs someone to look at it; null when it renews on its own. */
export type CertificateAttentionReason =
  | 'renewal_failed'
  | 'ca_limited'
  | 'waiting_for_daemon'
  | 'awaiting_reload'
  | 'expiring';

/** Days before expiry from which a certificate is shown as needing attention. */
export const ATTENTION_BEFORE_EXPIRY_DAYS = 7;

export function certificateAttentionReason(
  state: string | null | undefined,
  daysRemaining: number
): CertificateAttentionReason | null {
  if (state === 'failed') return 'renewal_failed';
  if (state === 'ca_limited') return 'ca_limited';
  if (state === 'waiting_for_daemon') return 'waiting_for_daemon';
  if (state === 'awaiting_reload') return 'awaiting_reload';
  return daysRemaining <= ATTENTION_BEFORE_EXPIRY_DAYS ? 'expiring' : null;
}

/** A managed certificate that needs attention (dashboard summary). */
export interface CertificateAttentionItem {
  ownerType: RenewableOwnerType;
  ownerId: string;
  reason: CertificateAttentionReason;
  daysRemaining: number;
  notAfter: string;
}

/** The dashboard reads the summary often; renewal state changes clear it at once. */
const ATTENTION_CACHE_MS = 60_000;

export interface RenewalReadiness {
  ready: boolean;
  /** `renewing`, `renewal_failed`, `waiting_for_daemon` or `unavailable` when not ready. */
  reason?: string;
  message?: string;
}

type RenewalStatePatch = Partial<
  Omit<SystemCertificateRenewalRow, 'ownerType' | 'ownerId' | 'createdAt' | 'updatedAt'>
>;

/** Persistence of per-owner renewal progress (`system_certificate_renewals`). */
export interface SystemCertificateRenewalStateStore {
  load(ownerType: RenewableOwnerType, ownerId: string): Promise<SystemCertificateRenewalRow | null>;
  save(ownerType: RenewableOwnerType, ownerId: string, patch: RenewalStatePatch, now: Date): Promise<void>;
  list(ownerType: RenewableOwnerType): Promise<SystemCertificateRenewalRow[]>;
  delete(ownerType: RenewableOwnerType, ownerId: string): Promise<void>;
}

export class DrizzleCertificateRenewalStateStore implements SystemCertificateRenewalStateStore {
  constructor(private readonly db: DrizzleClient) {}

  async load(ownerType: RenewableOwnerType, ownerId: string) {
    const [row] = await this.db
      .select()
      .from(systemCertificateRenewals)
      .where(and(eq(systemCertificateRenewals.ownerType, ownerType), eq(systemCertificateRenewals.ownerId, ownerId)))
      .limit(1);
    return row ?? null;
  }

  async save(ownerType: RenewableOwnerType, ownerId: string, patch: RenewalStatePatch, now: Date) {
    await this.db
      .insert(systemCertificateRenewals)
      .values({ ownerType, ownerId, ...patch, updatedAt: now })
      .onConflictDoUpdate({
        target: [systemCertificateRenewals.ownerType, systemCertificateRenewals.ownerId],
        set: { ...patch, updatedAt: now },
      });
  }

  async list(ownerType: RenewableOwnerType) {
    return this.db.select().from(systemCertificateRenewals).where(eq(systemCertificateRenewals.ownerType, ownerType));
  }

  async delete(ownerType: RenewableOwnerType, ownerId: string) {
    await this.db
      .delete(systemCertificateRenewals)
      .where(and(eq(systemCertificateRenewals.ownerType, ownerType), eq(systemCertificateRenewals.ownerId, ownerId)));
  }
}

interface RenewOptions {
  force?: boolean;
  allowRestart?: boolean;
  actorUserId?: string | null;
  trigger: 'schedule' | 'manual' | 'on_demand';
}

/**
 * Renews the TLS certificates Gateway issues to managed storage clusters and
 * managed databases while they run. A due certificate is staged as `pending`,
 * delivered to the workload's daemon (which makes the engine reload it
 * without downtime where the engine supports it), verified by the fingerprint
 * the workload actually serves, and only then promoted to `current`. Retries
 * back off from 1h to 24h, keep the same pending leaf (idempotent per owner
 * and pending serial) and record the last error for the UI.
 */
export class SystemCertificateRenewalService {
  private readonly adapters = new Map<RenewableOwnerType, SystemCertificateRenewalAdapter>();
  private readonly inFlight = new Map<string, Promise<RenewalOutcome>>();
  private readonly notReady = new Map<string, { at: number; readiness: RenewalReadiness }>();
  private audit?: Pick<AuditService, 'log'>;
  private eventBus?: Pick<EventBusService, 'publish'>;
  private readonly now: () => Date;
  private readonly store: SystemCertificateRenewalStateStore;
  private readonly schedule: (task: () => void, delayMs: number) => void;
  private attentionCache: { at: number; items: Promise<CertificateAttentionItem[]> } | null = null;

  constructor(
    db: DrizzleClient,
    options: {
      audit?: Pick<AuditService, 'log'>;
      eventBus?: Pick<EventBusService, 'publish'>;
      now?: () => Date;
      store?: SystemCertificateRenewalStateStore;
      /** Runs a one-off recheck later (tests replace the timer). */
      schedule?: (task: () => void, delayMs: number) => void;
    } = {}
  ) {
    this.audit = options.audit;
    this.eventBus = options.eventBus;
    this.now = options.now ?? (() => new Date());
    this.store = options.store ?? new DrizzleCertificateRenewalStateStore(db);
    this.schedule =
      options.schedule ??
      ((task, delayMs) => {
        setTimeout(task, delayMs).unref?.();
      });
  }

  /** A delivered certificate the engine rereads soon is confirmed without waiting for the hourly pass. */
  private scheduleRecheck(adapter: SystemCertificateRenewalAdapter, ownerId: string, delayMs: number) {
    this.schedule(() => {
      void adapter
        .getTarget(ownerId)
        .then((target) => (target ? this.run(adapter, target, { trigger: 'schedule' }) : undefined))
        .catch((error) =>
          logger.warn('Certificate renewal recheck failed', {
            ownerType: adapter.ownerType,
            ownerId,
            error: errorMessage(error),
          })
        );
    }, delayMs);
  }

  setAuditService(audit: Pick<AuditService, 'log'>) {
    this.audit = audit;
  }

  setEventBus(eventBus: Pick<EventBusService, 'publish'>) {
    this.eventBus = eventBus;
  }

  registerAdapter(adapter: SystemCertificateRenewalAdapter) {
    this.adapters.set(adapter.ownerType, adapter);
  }

  hasAdapter(ownerType: RenewableOwnerType) {
    return this.adapters.has(ownerType);
  }

  /** Scheduler entry point: checks every owner of every registered type. */
  async renewDue(): Promise<Record<RenewalOutcomeStatus, number>> {
    const summary = {
      renewed: 0,
      awaiting_reload: 0,
      waiting_for_daemon: 0,
      not_due: 0,
      backoff: 0,
      skipped: 0,
      failed: 0,
      redelivered: 0,
    } satisfies Record<RenewalOutcomeStatus, number>;
    for (const adapter of this.adapters.values()) {
      let targets: SystemCertificateRenewalTarget[];
      try {
        targets = await adapter.listTargets();
      } catch (error) {
        logger.warn('Could not list certificate renewal targets', {
          ownerType: adapter.ownerType,
          error: errorMessage(error),
        });
        continue;
      }
      for (const target of targets) {
        const outcome = await this.run(adapter, target, { trigger: 'schedule' });
        summary[outcome.status] += 1;
      }
      await this.forgetMissingOwners(adapter.ownerType, new Set(targets.map((target) => target.ownerId)));
    }
    if (summary.renewed || summary.failed || summary.redelivered) {
      logger.info('System certificate renewal pass finished', summary);
    }
    return summary;
  }

  /**
   * An owner that was deleted, lost its certificate or had TLS turned off is
   * no longer renewed: resolve a firing renewal alert and drop its state.
   */
  private async forgetMissingOwners(ownerType: RenewableOwnerType, present: ReadonlySet<string>) {
    let rows: SystemCertificateRenewalRow[];
    try {
      rows = await this.store.list(ownerType);
    } catch (error) {
      logger.warn('Could not list certificate renewal state', { ownerType, error: errorMessage(error) });
      return;
    }
    for (const row of rows) {
      if (present.has(row.ownerId) || this.inFlight.has(key(ownerType, row.ownerId))) continue;
      if (row.state !== 'idle') {
        this.eventBus?.publish('system-certificate.renewal', {
          action: 'renewal_cleared',
          ownerType,
          ownerId: row.ownerId,
          name: row.ownerId,
        });
      }
      await this.store.delete(ownerType, row.ownerId).catch((error) =>
        logger.warn('Could not drop certificate renewal state', {
          ownerType,
          ownerId: row.ownerId,
          error: errorMessage(error),
        })
      );
    }
  }

  /** Manual "renew now": renews even when the certificate is not due yet. */
  async renewNow(
    ownerType: RenewableOwnerType,
    ownerId: string,
    options: { actorUserId?: string | null; allowRestart?: boolean } = {}
  ): Promise<RenewalOutcome> {
    const adapter = this.requireAdapter(ownerType);
    const target = await adapter.getTarget(ownerId);
    if (!target) return { status: 'skipped', reason: 'not_ready', error: 'Certificate owner not found' };
    return this.run(adapter, target, {
      trigger: 'manual',
      force: true,
      allowRestart: options.allowRestart,
      actorUserId: options.actorUserId ?? null,
    });
  }

  async getStatus(ownerType: RenewableOwnerType, ownerId: string): Promise<CertificateRenewalStatusView> {
    const adapter = this.requireAdapter(ownerType);
    const target = await adapter.getTarget(ownerId);
    const state = await this.loadState(ownerType, ownerId);
    const now = this.now();
    const evaluation = target?.current ? evaluateCertificateRenewal(target.current, target, now) : null;
    return {
      ownerType,
      ownerId,
      certificate: target?.current
        ? {
            id: target.current.id,
            serialNumber: target.current.serialNumber,
            notBefore: target.current.notBefore.toISOString(),
            notAfter: target.current.notAfter.toISOString(),
            daysRemaining: evaluation?.daysRemaining ?? 0,
            sans: target.current.sans,
          }
        : null,
      renewal: {
        state: state?.state ?? 'idle',
        reason: state?.reason ?? null,
        due: evaluation?.due ?? false,
        dueReason: evaluation?.reason ?? null,
        urgent: evaluation?.urgent ?? false,
        hotReloadSupported: target?.supportsHotReload ?? false,
        skipReason: target?.skipReason ?? null,
        attempts: state?.attempts ?? 0,
        lastAttemptAt: state?.lastAttemptAt?.toISOString() ?? null,
        nextAttemptAt: state?.nextAttemptAt?.toISOString() ?? null,
        deliveredAt: state?.deliveredAt?.toISOString() ?? null,
        lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
        lastError: state?.lastError ?? null,
        lastMethod: state?.lastMethod ?? null,
        lastRestarted: state?.lastRestarted ?? false,
        pendingSerial: state?.pendingSerial ?? null,
      },
    };
  }

  /**
   * Managed certificates that need attention across every owner type: a
   * failed or CA-limited renewal, a renewal waiting for the daemon or for the
   * engine to reload, or 7 days or less left. The caller filters by what the
   * viewer may see.
   */
  async listAttention(): Promise<CertificateAttentionItem[]> {
    const nowMs = this.now().getTime();
    if (this.attentionCache && nowMs - this.attentionCache.at < ATTENTION_CACHE_MS) {
      return this.attentionCache.items;
    }
    const items = this.collectAttention().catch((error) => {
      this.attentionCache = null;
      throw error;
    });
    this.attentionCache = { at: nowMs, items };
    return items;
  }

  private async collectAttention(): Promise<CertificateAttentionItem[]> {
    const now = this.now();
    const groups = await Promise.all(
      [...this.adapters.values()].map(async (adapter) => {
        const [targets, states] = await Promise.all([adapter.listTargets(), this.store.list(adapter.ownerType)]);
        const stateByOwner = new Map(states.map((row) => [row.ownerId, row.state]));
        return targets.flatMap((target): CertificateAttentionItem[] => {
          if (!target.current) return [];
          const { daysRemaining } = evaluateCertificateRenewal(target.current, target, now);
          const reason = certificateAttentionReason(stateByOwner.get(target.ownerId), daysRemaining);
          return reason
            ? [
                {
                  ownerType: target.ownerType,
                  ownerId: target.ownerId,
                  reason,
                  daysRemaining,
                  notAfter: target.current.notAfter.toISOString(),
                },
              ]
            : [];
        });
      })
    );
    return groups.flat();
  }

  /**
   * Whether the workload serves a certificate that carries `names` (for a
   * backup, the loopback names the relay verifies). Checks the certificate
   * actually served where the daemon can report it. When it does not, a
   * delivery is started in the background and the caller is told to retry.
   */
  async ensureNamesServed(
    ownerType: RenewableOwnerType,
    ownerId: string,
    names: readonly string[]
  ): Promise<RenewalReadiness> {
    const cacheKey = `${key(ownerType, ownerId)}:${names.join(',')}`;
    const cached = this.notReady.get(cacheKey);
    if (cached && this.now().getTime() - cached.at < NOT_READY_CACHE_MS) return cached.readiness;
    const readiness = await this.checkNamesServed(ownerType, ownerId, names);
    if (readiness.ready) this.notReady.delete(cacheKey);
    else this.notReady.set(cacheKey, { at: this.now().getTime(), readiness });
    return readiness;
  }

  private async checkNamesServed(
    ownerType: RenewableOwnerType,
    ownerId: string,
    names: readonly string[]
  ): Promise<RenewalReadiness> {
    const adapter = this.adapters.get(ownerType);
    if (!adapter) return { ready: false, reason: 'unavailable', message: 'Certificate renewal is unavailable' };
    const target = await adapter.getTarget(ownerId);
    if (!target?.current) {
      return { ready: false, reason: 'unavailable', message: 'The TLS certificate of this resource is unavailable' };
    }
    const carries = (sans: readonly string[]) => {
      const present = new Set(sans.map((name) => name.toLowerCase()));
      return names.every((name) => present.has(name.toLowerCase()));
    };
    let served: ServedCertificateInfo | null = null;
    if (target.supportsHotReload && !target.skipReason) {
      try {
        served = await adapter.probe(target);
      } catch (error) {
        logger.warn('Could not probe the served certificate', { ownerType, ownerId, error: errorMessage(error) });
      }
    }
    if (served ? carries([...served.dnsNames, ...served.ipAddresses]) : carries(target.current.sans)) {
      // The engine may already serve a delivered pending leaf; finish that
      // renewal now instead of on the next hourly pass.
      const state = await this.loadState(ownerType, ownerId);
      if (served && state?.state === 'awaiting_reload') await this.run(adapter, target, { trigger: 'on_demand' });
      return { ready: true } satisfies RenewalReadiness;
    }
    const state = await this.loadState(ownerType, ownerId);
    const now = this.now().getTime();
    const recentlyTried = state?.lastAttemptAt && now - state.lastAttemptAt.getTime() < ON_DEMAND_RETRY_MS;
    // A failing renewal keeps its backoff; a waiting backup does not hammer it.
    const backingOff = state?.state === 'failed' && state.nextAttemptAt && state.nextAttemptAt.getTime() > now;
    if (!recentlyTried && !backingOff && !this.inFlight.has(key(ownerType, ownerId))) {
      void this.run(adapter, target, { trigger: 'on_demand', force: true });
    }
    if (backingOff) {
      return {
        ready: false,
        reason: 'renewal_failed',
        message: `The TLS certificate does not name ${names.join(', ')} yet and its renewal failed: ${state?.lastError ?? 'unknown error'}. Opfield retries at ${state?.nextAttemptAt?.toISOString()}; the run continues automatically once it succeeds.`,
      } satisfies RenewalReadiness;
    }
    if (!target.supportsHotReload) {
      return {
        ready: false,
        reason: 'waiting_for_daemon',
        message: `The TLS certificate does not name ${names.join(', ')} yet. It is reissued once the node daemon is updated to a version that reloads certificates without a restart.`,
      } satisfies RenewalReadiness;
    }
    return {
      ready: false,
      reason: 'renewing',
      message: `Waiting for the renewed TLS certificate (naming ${names.join(', ')}) to be served; the run continues automatically.`,
    } satisfies RenewalReadiness;
  }

  private run(
    adapter: SystemCertificateRenewalAdapter,
    target: SystemCertificateRenewalTarget,
    options: RenewOptions
  ): Promise<RenewalOutcome> {
    const id = key(target.ownerType, target.ownerId);
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const running = this.renewTarget(adapter, target, options).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, running);
    return running;
  }

  private async renewTarget(
    adapter: SystemCertificateRenewalAdapter,
    target: SystemCertificateRenewalTarget,
    options: RenewOptions
  ): Promise<RenewalOutcome> {
    if (target.skipReason) return { status: 'skipped', reason: target.skipReason };
    if (!target.current) return { status: 'skipped', reason: 'tls_disabled' };
    const now = this.now();
    const state = await this.loadState(target.ownerType, target.ownerId);
    const evaluation = evaluateCertificateRenewal(target.current, target, now);
    const awaiting = state?.state === 'awaiting_reload' && !!state.pendingSerial;
    const reason: RenewalReason | null = options.force
      ? (evaluation.reason ?? (options.trigger === 'manual' ? 'manual' : 'served_mismatch'))
      : awaiting
        ? (evaluation.reason ?? 'awaiting_reload')
        : evaluation.reason;

    if (!options.force && !awaiting && !evaluation.due) {
      if (target.supportsHotReload) {
        const drift = await this.repairDrift(adapter, target, options);
        if (drift) return drift;
      }
      if (state && state.state !== 'idle') {
        // Recovered some other way (a user update delivered the leaf, the CA
        // changed): resolve a firing renewal alert.
        await this.saveState(target, { state: 'idle', lastError: null, attempts: 0, nextAttemptAt: null });
        this.publish(target, 'renewal_recovered', {});
      }
      return { status: 'not_due' };
    }
    if (
      !options.force &&
      options.trigger === 'schedule' &&
      state?.nextAttemptAt &&
      // The hourly pass may fire a little early; do not skip a whole hour for that.
      state.nextAttemptAt.getTime() - now.getTime() > SCHEDULE_TOLERANCE_MS &&
      !(evaluation.urgent && state.nextAttemptAt.getTime() - now.getTime() > BACKOFF_BASE_MS)
    ) {
      return { status: 'backoff', reason };
    }

    if (this.renewalWouldNotExtend(target, reason, now)) {
      const caEnd = target.issuerNotAfter!.toISOString();
      if (state?.state !== 'ca_limited') {
        logger.warn('System certificate renewal skipped: the issuing CA ends first', {
          ownerType: target.ownerType,
          ownerId: target.ownerId,
          caNotAfter: caEnd,
        });
      }
      await this.saveState(target, {
        state: 'ca_limited',
        reason,
        attempts: 0,
        nextAttemptAt: null,
        lastError: `The issuing CA expires ${caEnd}; a renewed certificate would not last longer than the current one. Renew or replace the CA.`,
      });
      // Not a renewal failure (the CA expiry alerts cover it): resolve a
      // firing renewal-failed alert on the way in.
      if (state?.state !== 'ca_limited') this.publish(target, 'renewal_ca_limited', { reason, caNotAfter: caEnd });
      return { status: 'skipped', reason: 'ca_limit' };
    }

    if (!target.supportsHotReload) {
      if (evaluation.urgent || options.trigger === 'manual') {
        return this.renewWithFallback(adapter, target, reason, evaluation, options);
      }
      // No backoff: every pass checks again whether the daemon was updated.
      await this.saveState(target, {
        state: 'waiting_for_daemon',
        reason,
        attempts: 0,
        lastAttemptAt: now,
        nextAttemptAt: null,
        lastError:
          'The node daemon cannot reload certificates without a restart yet; the renewal waits for the daemon update and uses a restart only once 7 days or less remain.',
      });
      // Waiting for the daemon update is not a failure: resolve a firing alert.
      if (state?.state !== 'waiting_for_daemon') this.publish(target, 'renewal_waiting_for_daemon', { reason });
      return { status: 'waiting_for_daemon', reason };
    }

    let pending: RenewalCertificate | null = null;
    try {
      pending = await adapter.issuePending(target);
      const expected = certificateFingerprintSha256(pending.certificatePem);
      const deliveredAt = state?.pendingSerial === pending.serialNumber && state.deliveredAt ? state.deliveredAt : now;
      await this.saveState(target, {
        state: 'delivering',
        reason,
        pendingCertificateId: pending.id,
        pendingSerial: pending.serialNumber,
        lastAttemptAt: now,
        deliveredAt,
      });
      const overdue = now.getTime() - deliveredAt.getTime() > AWAITING_RELOAD_LIMIT_MS;
      const allowRestart = evaluation.urgent || options.allowRestart === true;
      const result = await adapter.deliver(target, pending, { allowRestart });
      if (result.status === 'reloaded' && result.servedFingerprint === expected) {
        await adapter.promote(target, pending);
        await this.recordSuccess(target, pending, reason, evaluation, options, result);
        return { status: 'renewed', reason, restarted: result.restarted, method: result.method };
      }
      if (result.status === 'reloaded') {
        throw new Error(`The workload serves certificate ${result.servedFingerprint}, expected ${expected}`);
      }
      if (overdue) {
        throw new Error(
          `The renewed certificate was delivered ${Math.round((now.getTime() - deliveredAt.getTime()) / HOUR_MS)}h ago but the engine still serves the previous one`
        );
      }
      // Check again once the engine has reread its files; an engine on a long
      // interval is picked up by the hourly pass.
      const recheckMs = Math.min(
        BACKOFF_BASE_MS,
        Math.max(RECHECK_MIN_MS, (result.reloadIntervalSeconds ?? 15 * 60) * 1000 + RECHECK_MARGIN_MS)
      );
      await this.saveState(target, {
        state: 'awaiting_reload',
        servedFingerprint: result.servedFingerprint || null,
        lastMethod: result.method,
        lastRestarted: result.restarted,
        nextAttemptAt: new Date(now.getTime() + recheckMs),
        lastError: null,
      });
      if (recheckMs < BACKOFF_BASE_MS) this.scheduleRecheck(adapter, target.ownerId, recheckMs);
      this.publish(target, 'renewal_pending', { reason, method: result.method });
      return { status: 'awaiting_reload', reason, method: result.method };
    } catch (error) {
      return this.recordFailure(target, reason, evaluation, options, state, error, pending);
    }
  }

  /**
   * Near the end of the issuing CA every renewed leaf is clamped to the CA's
   * end. Reissuing for time alone then produces a leaf that ends no later than
   * the current one, on every pass: skip it. Renewals for other reasons
   * (missing names, a replaced CA, a manual request) still run.
   */
  private renewalWouldNotExtend(
    target: SystemCertificateRenewalTarget,
    reason: RenewalReason | null,
    now: Date
  ): boolean {
    if (!target.current || !target.issuerNotAfter) return false;
    if (reason !== 'expiring' && reason !== 'lifetime') return false;
    const requested = now.getTime() + (target.renewedValidityDays ?? DEFAULT_RENEWED_VALIDITY_DAYS) * DAY_MS;
    const renewedEnd = Math.min(requested, target.issuerNotAfter.getTime());
    return renewedEnd <= target.current.notAfter.getTime() + CA_END_MARGIN_MS;
  }

  /**
   * The workload serves a certificate other than the current one (an update
   * raced a renewal, or a pending leaf was served but not yet promoted).
   * Promote the pending leaf it serves, or deliver the current one again.
   */
  private async repairDrift(
    adapter: SystemCertificateRenewalAdapter,
    target: SystemCertificateRenewalTarget,
    options: RenewOptions
  ): Promise<RenewalOutcome | null> {
    const current = target.current!;
    let served: ServedCertificateInfo;
    try {
      served = await adapter.probe(target);
    } catch {
      // An unreachable engine is a lifecycle problem, not a certificate one.
      return null;
    }
    if (!served.fingerprintSha256 || served.fingerprintSha256 === certificateFingerprintSha256(current.certificatePem))
      return null;
    try {
      const pending = await adapter.findPending(target);
      if (pending && certificateFingerprintSha256(pending.certificatePem) === served.fingerprintSha256) {
        await adapter.promote(target, pending);
        await this.recordSuccess(
          target,
          pending,
          'served_mismatch',
          evaluateCertificateRenewal(pending, target, this.now()),
          options,
          {
            status: 'reloaded',
            servedFingerprint: served.fingerprintSha256,
            restarted: false,
            method: 'already_served',
          }
        );
        return { status: 'renewed', reason: 'served_mismatch' };
      }
      const result = await adapter.deliver(target, current, { allowRestart: false });
      await this.audit?.log({
        userId: null,
        action: 'certificate.system.redeliver',
        resourceType: target.resourceType,
        resourceId: target.ownerId,
        details: {
          name: target.name,
          certificateId: current.id,
          servedFingerprint: served.fingerprintSha256,
          status: result.status,
          method: result.method,
        },
      });
      return { status: 'redelivered', reason: 'served_mismatch', method: result.method };
    } catch (error) {
      logger.warn('Could not repair a served certificate mismatch', {
        ownerType: target.ownerType,
        ownerId: target.ownerId,
        error: errorMessage(error),
      });
      return null;
    }
  }

  private async renewWithFallback(
    adapter: SystemCertificateRenewalAdapter,
    target: SystemCertificateRenewalTarget,
    reason: RenewalReason | null,
    evaluation: RenewalEvaluation,
    options: RenewOptions
  ): Promise<RenewalOutcome> {
    const now = this.now();
    const state = await this.loadState(target.ownerType, target.ownerId);
    let pending: RenewalCertificate | null = null;
    try {
      pending = await adapter.issuePending(target);
      await this.saveState(target, {
        state: 'delivering',
        reason,
        pendingCertificateId: pending.id,
        pendingSerial: pending.serialNumber,
        lastAttemptAt: now,
        deliveredAt: now,
      });
      await adapter.fallback(target, pending);
      // The update's success hook promotes the leaf; trust the database state,
      // not the call returning, before calling it renewed.
      const updated = await adapter.getTarget(target.ownerId);
      if (updated?.current?.id !== pending.id) {
        throw new Error('The update carrying the renewed certificate did not complete; the certificate stays pending');
      }
      await this.recordSuccess(target, pending, reason, evaluation, options, {
        status: 'reloaded',
        servedFingerprint: '',
        restarted: true,
        method: 'fallback_restart',
      });
      return { status: 'renewed', reason, restarted: true, method: 'fallback_restart' };
    } catch (error) {
      return this.recordFailure(target, reason, evaluation, options, state, error, pending);
    }
  }

  private async recordSuccess(
    target: SystemCertificateRenewalTarget,
    certificate: RenewalCertificate,
    reason: RenewalReason | null,
    evaluation: RenewalEvaluation,
    options: RenewOptions,
    result: RenewalDeliveryResult
  ) {
    const now = this.now();
    await this.saveState(target, {
      state: 'idle',
      reason,
      pendingCertificateId: null,
      pendingSerial: null,
      attempts: 0,
      nextAttemptAt: null,
      deliveredAt: null,
      lastSuccessAt: now,
      lastError: null,
      servedFingerprint: result.servedFingerprint || null,
      lastMethod: result.method,
      lastRestarted: result.restarted,
    });
    await this.audit?.log({
      userId: options.actorUserId ?? null,
      action: 'certificate.system.renew',
      resourceType: target.resourceType,
      resourceId: target.ownerId,
      details: {
        name: target.name,
        ownerType: target.ownerType,
        trigger: options.trigger,
        reason,
        previousCertificateId: target.current?.id ?? null,
        certificateId: certificate.id,
        serialNumber: certificate.serialNumber,
        notAfter: certificate.notAfter.toISOString(),
        daysRemainingBefore: evaluation.daysRemaining,
        method: result.method,
        restarted: result.restarted,
      },
    });
    this.publish(target, 'renewed', {
      reason,
      method: result.method,
      restarted: result.restarted,
      notAfter: certificate.notAfter.toISOString(),
    });
  }

  private async recordFailure(
    target: SystemCertificateRenewalTarget,
    reason: RenewalReason | null,
    evaluation: RenewalEvaluation,
    options: RenewOptions,
    previous: SystemCertificateRenewalRow | null,
    error: unknown,
    pending: RenewalCertificate | null
  ): Promise<RenewalOutcome> {
    const now = this.now();
    const attempts = (previous?.state === 'failed' ? previous.attempts : 0) + 1;
    const message = errorMessage(error).slice(0, 2000);
    await this.saveState(target, {
      state: 'failed',
      reason,
      attempts,
      lastAttemptAt: now,
      nextAttemptAt: new Date(now.getTime() + renewalBackoffMs(attempts, evaluation.urgent)),
      lastError: message,
      ...(pending ? { pendingCertificateId: pending.id, pendingSerial: pending.serialNumber } : {}),
    });
    logger.warn('System certificate renewal failed', {
      ownerType: target.ownerType,
      ownerId: target.ownerId,
      attempts,
      error: message,
    });
    await this.audit?.log({
      userId: options.actorUserId ?? null,
      action: 'certificate.system.renew_failed',
      resourceType: target.resourceType,
      resourceId: target.ownerId,
      details: {
        name: target.name,
        ownerType: target.ownerType,
        trigger: options.trigger,
        reason,
        attempts,
        daysRemaining: evaluation.daysRemaining,
        error: message,
      },
    });
    this.publish(target, 'renewal_failed', { reason, attempts, error: message });
    return { status: 'failed', reason, error: message };
  }

  private publish(target: SystemCertificateRenewalTarget, action: string, details: Record<string, unknown>) {
    const daysRemaining = target.current
      ? Math.floor((target.current.notAfter.getTime() - this.now().getTime()) / DAY_MS)
      : null;
    this.eventBus?.publish('system-certificate.renewal', {
      action,
      ownerType: target.ownerType,
      ownerId: target.ownerId,
      resourceType: target.resourceType,
      name: target.name,
      daysRemaining,
      ...details,
    });
  }

  private loadState(ownerType: RenewableOwnerType, ownerId: string) {
    return this.store.load(ownerType, ownerId);
  }

  private saveState(target: SystemCertificateRenewalTarget, patch: RenewalStatePatch) {
    this.attentionCache = null;
    return this.store.save(target.ownerType, target.ownerId, patch, this.now());
  }

  private requireAdapter(ownerType: RenewableOwnerType) {
    const adapter = this.adapters.get(ownerType);
    if (!adapter) throw new Error(`Certificate renewal is not available for ${ownerType}`);
    return adapter;
  }
}

function key(ownerType: string, ownerId: string) {
  return `${ownerType}:${ownerId}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
