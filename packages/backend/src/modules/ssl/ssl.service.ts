import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lte, ne, or, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type OperationLeaseHold,
  type OperationLeaseStore,
  operationLeaseHeld,
  operationLeaseKey,
} from '@/db/operation-lease.js';
import {
  certificateAuthorities,
  certificates,
  pageWildcardProfiles,
  permissionGroups,
  proxyHosts,
  sslCertificateFolders,
  sslCertificates,
  users,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { buildWhere, escapeLike, sleep } from '@/lib/utils.js';
import { x509 } from '@/lib/x509.js';
import { AppError } from '@/middleware/error-handler.js';
import { appMemberFolderCondition, withAppMembers } from '@/modules/apps/app-membership.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { loadCertificateIssuerChainPem, loadIssuerChainPem } from '@/modules/pki/issuer-chain.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import {
  type NginxCertificateDistributionService,
  SSL_DISTRIBUTION_ERROR_PREFIX,
} from '@/services/nginx-certificate-distribution.service.js';
import type { PaginatedResponse } from '@/types.js';
import type { ACMEService } from './acme.service.js';
import { rethrowCertificateInUse } from './certificate-in-use.js';
import { canDeployInternalCertificate, INTERNAL_CERT_DEPLOY_SCOPE } from './internal-cert-deploy-access.js';
import type {
  LinkInternalCertInput,
  RequestACMECertInput,
  SetSslAutoRenewInput,
  SSLCertListQuery,
  UploadCertInput,
} from './ssl.schemas.js';
import { namesOnCloudflareIngressGroups } from './ssl-ingress-group-challenge.js';

const logger = createChildLogger('SSLService');
const CLOUDFLARE_DNS01_PROPAGATION_DELAY_MS = process.env.NODE_ENV === 'test' ? 0 : 10_000;
const OPFIELD_SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/** Prefix of a renewalError that reports incomplete delivery rather than a failed renewal. */
export { SSL_DISTRIBUTION_ERROR_PREFIX };

type ProxyHostSyncFailure = { hostId: string; error: string };

/** Reissues the internal PKI leaf behind an `internal` SSL certificate (see InternalCertificateRenewalService). */
export interface InternalCertificateRenewer {
  renewSslCertificate(sslCertificateId: string, userId: string, options?: { actorScopes?: string[] }): Promise<unknown>;
}

const RENEWABLE_STATUSES: ReadonlySet<string> = new Set(['active', 'error', 'expired']);

type DNSChallenge = {
  domain: string;
  recordName: string;
  recordValue: string;
  cloudflare?: {
    connectorId: string;
    zoneId: string;
    zoneName: string;
    recordId: string;
    created: boolean;
  };
};

type AcmeOperationKind = 'issue' | 'renew' | 'verify';

/** ACME operation keys held by the current async call chain (see SSLService.runAcmeOperation). */
const heldAcmeOperations = new AsyncLocalStorage<ReadonlySet<string>>();

/** The lease an ACME operation runs under, which fences its steps and order-state writes. */
type AcmeLeaseFence = { leaseKey: string; token: string; hold: OperationLeaseHold };
/** Leases of the ACME operations the current async call chain runs under (see SSLService.runLeasedAcmeOperation). */
const acmeLeaseFences = new AsyncLocalStorage<readonly AcmeLeaseFence[]>();

/**
 * An ACME step or write refused because its operation lost its lease: another
 * process may own the certificate now. ACME_ORDER_SUPERSEDED, so no caller
 * records it as this operation's failure over the new owner's work.
 */
function acmeLeaseLost(): AppError {
  return new AppError(
    409,
    'ACME_ORDER_SUPERSEDED',
    'The ACME operation lost its lease to another backend process, or could not renew it, and stopped',
    { leaseLost: true }
  );
}

/** How long a finished operation's outcome stays readable for callers in other processes that joined it. */
const ACME_OUTCOME_RETAIN_MS = 60_000;

type AcmeOperationOutcome =
  | { status: 'fulfilled'; value: unknown }
  | { status: 'rejected'; error: { message: string; statusCode?: number; code?: string; details?: unknown } };

/** An ACME operation's lease: who runs what, and once it finished, how it ended. */
type AcmeOperationLease = { kind: AcmeOperationKind; actor: string; outcome?: AcmeOperationOutcome };

function acmeOperationInProgress(kind: AcmeOperationKind, runningKind: AcmeOperationKind) {
  return new AppError(
    409,
    'ACME_OPERATION_IN_PROGRESS',
    kind === 'issue' && runningKind === 'issue'
      ? 'A certificate request for these domains is already running'
      : `An ACME ${runningKind} is already running for this certificate`,
    { operation: runningKind }
  );
}

/** The result as a joined caller in another process receives it: its JSON form. */
function acmeOutcomeValue(value: unknown): unknown {
  try {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function acmeOutcomeError(error: unknown): Extract<AcmeOperationOutcome, { status: 'rejected' }>['error'] {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof AppError)) return { message };
  return { message, statusCode: error.statusCode, code: error.code, details: acmeOutcomeValue(error.details) };
}

function settleAcmeOutcome<T>(outcome: AcmeOperationOutcome): T {
  if (outcome.status === 'fulfilled') return outcome.value as T;
  const { error } = outcome;
  if (error.statusCode === undefined || !error.code) throw new Error(error.message);
  const rebuilt = new AppError(error.statusCode, error.code, error.message, error.details ?? undefined);
  rebuilt.message = error.message;
  throw rebuilt;
}

type AutoRenewDnsBinding = {
  domain: string;
  connectorId: string;
  connectorName: string;
  zoneId: string;
  zoneName: string;
};

export class SSLService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly acmeService: ACMEService,
    private readonly cryptoService: CryptoService,
    private readonly auditService: AuditService,
    private readonly certificateDistribution: NginxCertificateDistributionService
  ) {}

  private eventBus?: EventBusService;
  private integrationsService?: IntegrationsService;
  private proxyService?: ProxyService;
  private internalCertRenewal?: InternalCertificateRenewer;
  /** Errors whose renewal failure is already persisted by an inner step. */
  private readonly recordedRenewalFailures = new WeakSet<object>();
  /** Running ACME operations, one per certificate (or per requested domain set for a new request). */
  private readonly acmeOperations = new Map<
    string,
    { kind: AcmeOperationKind; actor: string; promise: Promise<unknown> }
  >();
  /** Makes ACME operations exclusive across backend processes; without it, per process only. */
  private operationLeases?: OperationLeaseStore;
  /** How often a caller that joined another process's operation looks for its outcome. */
  private acmeJoinPollMs = 500;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }
  setOperationLeases(leases: OperationLeaseStore) {
    this.operationLeases = leases;
  }
  setIntegrationsService(service: IntegrationsService) {
    this.integrationsService = service;
  }
  /** Reissues linked internal PKI certificates (manual renew of an `internal` certificate). */
  setInternalCertificateRenewal(renewer: InternalCertificateRenewer) {
    this.internalCertRenewal = renewer;
  }
  setProxyService(service: ProxyService) {
    this.proxyService = service;
    // Lets periodic reconciliation re-render (and so reload) a host on a
    // legacy Nginx daemon after it retried a legacy certificate push.
    this.certificateDistribution.setLegacyHostConfigReapplier?.((hostId) =>
      service.reconcileAdditionalRouteHost(hostId)
    );
  }

  /**
   * Certificate issuance changes canonical material first, then every active
   * Proxy Host receives its own atomic TLS bundle. This also upgrades legacy
   * hosts that predate deployment records; failures remain a distribution
   * status on that host instead of invalidating an otherwise valid renewal.
   */
  private async refreshOpfieldAssetAndSyncProxyHosts(
    certId: string,
    userId: string
  ): Promise<{ synchronized: number; failures: ProxyHostSyncFailure[] }> {
    await this.certificateDistribution.upsertOpfieldAsset({ type: 'ssl', id: certId });
    return this.resyncActiveProxyHosts(certId, userId);
  }

  private async resyncActiveProxyHosts(
    certId: string,
    userId: string
  ): Promise<{ synchronized: number; failures: ProxyHostSyncFailure[] }> {
    if (!this.proxyService) return { synchronized: 0, failures: [] };

    const activeHosts = await this.db.query.proxyHosts.findMany({
      where: and(
        eq(proxyHosts.sslCertificateId, certId),
        eq(proxyHosts.enabled, true),
        eq(proxyHosts.sslEnabled, true)
      ),
      columns: { id: true, nodeId: true, sslEnabled: true, sslCertificateId: true, internalCertificateId: true },
    });
    let synchronized = 0;
    const failures: ProxyHostSyncFailure[] = [];
    for (const host of activeHosts) {
      try {
        await this.proxyService.resyncTlsHost(host.id, userId);
        synchronized += 1;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'NGINX_TLS_DAEMON_UPDATE_REQUIRED') {
          failures.push(this.recordHostSyncFailure(certId, host.id, error));
          continue;
        }
        // A daemon without TLS distribution v2 cannot take an atomic bundle.
        // Push the certificate with the legacy command; the distribution
        // service then re-applies the host config so nginx reloads it.
        try {
          const legacy = await this.certificateDistribution.deployLegacyCertificateForHost(host);
          if (legacy === 'not_legacy') {
            // A v2 daemon that is offline receives the bundle through its
            // reconnect reconciliation.
            logger.warn('TLS certificate refresh deferred until the Nginx node reconnects', {
              certId,
              hostId: host.id,
            });
            continue;
          }
          synchronized += 1;
        } catch (legacyError) {
          failures.push(this.recordHostSyncFailure(certId, host.id, legacyError));
        }
      }
    }
    return { synchronized, failures };
  }

  private recordHostSyncFailure(certId: string, hostId: string, error: unknown): ProxyHostSyncFailure {
    const message = error instanceof Error ? error.message : 'unknown error';
    logger.error('TLS certificate could not be delivered to a route', { certId, hostId, error: message });
    return { hostId, error: message };
  }

  /**
   * Make an incomplete delivery visible on the certificate. A later complete
   * delivery clears only this kind of message, never a renewal failure.
   */
  private async recordDistributionOutcome(certId: string, failures: ProxyHostSyncFailure[]): Promise<void> {
    if (failures.length === 0) {
      await this.db
        .update(sslCertificates)
        .set({ renewalError: null, updatedAt: new Date() })
        .where(
          and(
            eq(sslCertificates.id, certId),
            sql`${sslCertificates.renewalError} LIKE ${`${SSL_DISTRIBUTION_ERROR_PREFIX}%`}`
          )
        );
      return;
    }
    const first = failures[0]!;
    await this.db
      .update(sslCertificates)
      .set({
        renewalError: `${SSL_DISTRIBUTION_ERROR_PREFIX}${failures.length} route(s) did not receive the current certificate (${first.error})`,
        updatedAt: new Date(),
      })
      .where(eq(sslCertificates.id, certId));
    this.emitCert(certId, 'updated');
  }

  private emitCert(
    id: string,
    action: 'created' | 'renewed' | 'deleted' | 'updated' | 'renewal_failed' | 'expired',
    name?: string
  ) {
    this.eventBus?.publish('ssl.cert.changed', { id, action, name });
  }

  /**
   * Single flight for ACME work on one certificate: issue, renew, DNS-01
   * renewal start and DNS-01 verify. Two orders for one certificate would burn
   * the CA's duplicate-certificate limit, and a losing verify used to overwrite
   * the winner's result. The same caller repeating the same operation (double
   * click, retried request) shares the running one; any other operation on the
   * certificate gets 409 until it finishes. Calls made by the running operation
   * itself (renew, then verify for Cloudflare DNS-01) run directly.
   *
   * Within a process the running promise is shared. Across backend processes
   * the same rules hold through an operation lease (runAcmeOperationAcrossProcesses).
   * The conditional order-state writes below still keep a writer whose lease
   * lapsed from overwriting a newer order.
   */
  private runAcmeOperation<T>(key: string, kind: AcmeOperationKind, actor: string, task: () => Promise<T>): Promise<T> {
    // A further step (the verify a Cloudflare DNS-01 issue or renewal runs) of
    // an operation that lost its lease is not taken (acmeLeaseLost).
    const lostFence = acmeLeaseFences.getStore()?.find((fence) => fence.hold.lost);
    if (lostFence) {
      logger.error('ACME operation lost its lease; its next step is skipped', { leaseKey: lostFence.leaseKey, key });
      return Promise.reject(acmeLeaseLost());
    }
    const held = heldAcmeOperations.getStore();
    if (held?.has(key)) return task();
    const running = this.acmeOperations.get(key);
    if (running) {
      if (running.kind === kind && running.actor === actor) return running.promise as Promise<T>;
      return Promise.reject(acmeOperationInProgress(kind, running.kind));
    }
    const promise = heldAcmeOperations
      .run(new Set([...(held ?? []), key]), () => this.runAcmeOperationAcrossProcesses(key, kind, actor, task))
      .finally(() => {
        if (this.acmeOperations.get(key)?.promise === promise) this.acmeOperations.delete(key);
      });
    this.acmeOperations.set(key, { kind, actor, promise });
    return promise;
  }

  /**
   * One ACME operation per key across backend processes. A lease row
   * (OperationLeaseStore) is claimed in a short locked transaction before the
   * operation and renewed while it runs; no database lock is held across the
   * calls to the ACME server. Another operation on the key gets 409. The same
   * caller repeating the same operation waits for the running one and receives
   * its outcome, which the owner leaves on the lease for a while. A lease whose
   * process stopped lapses, and the waiting caller then runs the operation.
   */
  private async runAcmeOperationAcrossProcesses<T>(
    key: string,
    kind: AcmeOperationKind,
    actor: string,
    task: () => Promise<T>
  ): Promise<T> {
    const leases = this.operationLeases;
    if (!leases) return task();
    const leaseKey = operationLeaseKey('acme', key);
    for (;;) {
      const claim = await leases.claim<AcmeOperationLease>(
        [leaseKey],
        { kind, actor },
        // A finished operation only keeps its outcome for callers that joined it.
        { replaceable: (lease) => lease.data.outcome !== undefined }
      );
      if (claim.acquired) return this.runLeasedAcmeOperation(leases, leaseKey, claim, { kind, actor }, task);
      const running = claim.lease.data;
      if (running.kind !== kind || running.actor !== actor) throw acmeOperationInProgress(kind, running.kind);
      const outcome = await this.waitForAcmeOutcome(leases, leaseKey, claim.lease.token);
      if (outcome) return settleAcmeOutcome<T>(outcome);
    }
  }

  /**
   * Runs `task` as the owner of the lease `claim` took, renewing it meanwhile.
   * Once the lease is lost (another process took it over, or it could not be
   * renewed for its TTL), the task stops acting as the owner: its order-state
   * writes (acmeOrderGuard) match nothing, and a further ACME step it would
   * start (runAcmeOperation) is refused. The ACME call already in flight
   * cannot be recalled; what it returns is not stored over the new owner's.
   */
  private async runLeasedAcmeOperation<T>(
    leases: OperationLeaseStore,
    leaseKey: string,
    claim: { token: string; claimedAt: number },
    lease: AcmeOperationLease,
    task: () => Promise<T>
  ): Promise<T> {
    const { token } = claim;
    const heartbeat = leases.hold(
      () => [leaseKey],
      token,
      () =>
        logger.error('ACME operation lost its lease; its remaining steps and order-state writes are skipped', {
          leaseKey,
        }),
      { since: claim.claimedAt }
    );
    const fences = [...(acmeLeaseFences.getStore() ?? []), { leaseKey, token, hold: heartbeat }];
    let outcome: AcmeOperationOutcome = { status: 'rejected', error: { message: 'ACME operation did not finish' } };
    try {
      const value = await acmeLeaseFences.run(fences, task);
      outcome = { status: 'fulfilled', value: acmeOutcomeValue(value) };
      return value;
    } catch (error) {
      outcome = { status: 'rejected', error: acmeOutcomeError(error) };
      throw error;
    } finally {
      if (heartbeat.lost) {
        logger.error('ACME operation finished after losing its lease', { leaseKey, status: outcome.status });
      }
      heartbeat.stop();
      await leases
        .release([leaseKey], token, { data: { ...lease, outcome }, retainMs: ACME_OUTCOME_RETAIN_MS })
        .catch((error) =>
          logger.warn('Could not record an ACME operation outcome', {
            leaseKey,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      const cleanup = setTimeout(() => {
        void leases.release([leaseKey], token).catch(() => undefined);
      }, ACME_OUTCOME_RETAIN_MS);
      cleanup.unref?.();
    }
  }

  /** The outcome of the operation holding `token`, or null once it is gone without one. */
  private async waitForAcmeOutcome(
    leases: OperationLeaseStore,
    leaseKey: string,
    token: string
  ): Promise<AcmeOperationOutcome | null> {
    for (;;) {
      await sleep(this.acmeJoinPollMs);
      const lease = await leases.read<AcmeOperationLease>(leaseKey);
      if (!lease || lease.token !== token) return null;
      if (lease.data.outcome) return lease.data.outcome;
      // Lapsed by the database clock: its process stopped. Never compared
      // with this process's clock, which may be off by more than the TTL.
      if (!lease.live) return null;
    }
  }

  /**
   * Matches the certificate row only while it still holds the ACME order an
   * operation started from and, for an operation running under leases (across
   * backend processes), only while it still owns them by the database clock:
   * a write made after its lease was lost or taken over matches nothing.
   */
  private acmeOrderGuard(
    cert: Pick<typeof sslCertificates.$inferSelect, 'id' | 'acmeOrderUrl' | 'acmePendingOperation'>
  ): SQL {
    return this.acmeLeaseGuard(
      and(
        eq(sslCertificates.id, cert.id),
        cert.acmeOrderUrl ? eq(sslCertificates.acmeOrderUrl, cert.acmeOrderUrl) : isNull(sslCertificates.acmeOrderUrl),
        cert.acmePendingOperation
          ? eq(sslCertificates.acmePendingOperation, cert.acmePendingOperation)
          : isNull(sslCertificates.acmePendingOperation)
      )!
    );
  }

  /**
   * `condition`, and, while the current call chain runs an ACME operation
   * under leases, only while that operation still owns them by the database
   * clock (checked in the write's own statement).
   */
  private acmeLeaseGuard(condition: SQL): SQL {
    const fences = acmeLeaseFences.getStore() ?? [];
    if (fences.length === 0) return condition;
    return and(condition, ...fences.map((fence) => operationLeaseHeld(fence.leaseKey, fence.token)))!;
  }

  /**
   * Run right before an ACME write that cannot carry acmeLeaseGuard (an
   * insert), or before recording a failure: renews the leases the current
   * operation runs under, so no other process can take them for a full TTL
   * from here. Throws acmeLeaseLost once one was lost. Outside a leased
   * operation it does nothing.
   */
  private async confirmAcmeLeases(): Promise<void> {
    for (const fence of acmeLeaseFences.getStore() ?? []) {
      if (await fence.hold.confirm()) continue;
      logger.error('ACME operation lost its lease; its write is skipped', { leaseKey: fence.leaseKey });
      throw acmeLeaseLost();
    }
  }

  // ---------------------------------------------------------------------------
  // ACME certificate request
  // ---------------------------------------------------------------------------

  requestACMECert(input: RequestACMECertInput, userId: string, contactEmail?: string) {
    const domainSet = [...new Set(input.domains.map((domain) => domain.trim().toLowerCase()))].sort().join(',');
    return this.runAcmeOperation(`acme-request:${domainSet}`, 'issue', `${userId}:${JSON.stringify(input)}`, () =>
      this.requestACMECertOnce(input, userId, contactEmail)
    );
  }

  /**
   * A certificate for names of an ingress group domain managed through Cloudflare uses DNS-01 through the connector:
   * DNS lists every member, and an HTTP-01 validation reaching a member that is offline would fail. Everything else
   * keeps the requested challenge (HTTP-01 then publishes the token on every online member).
   */
  private async preferCloudflareDns01ForIngressGroups(input: RequestACMECertInput): Promise<RequestACMECertInput> {
    if (input.challengeType !== 'http-01' || !this.integrationsService) return input;
    if (!(await namesOnCloudflareIngressGroups(this.db, input.domains))) return input;
    try {
      for (const domain of input.domains) await this.integrationsService.resolveCloudflareDnsContext(domain);
    } catch (error) {
      logger.warn('Ingress group certificate keeps HTTP-01: not every name is in a Cloudflare zone of the connector', {
        domains: input.domains,
        error: error instanceof Error ? error.message : String(error),
      });
      return input;
    }
    logger.info('Issuing an ingress group certificate with DNS-01 through Cloudflare', { domains: input.domains });
    return { ...input, challengeType: 'dns-01', dnsProvider: 'cloudflare', autoRenew: input.autoRenew ?? true };
  }

  private async requestACMECertOnce(requested: RequestACMECertInput, userId: string, contactEmail?: string) {
    const input = await this.preferCloudflareDns01ForIngressGroups(requested);
    const isStaging = input.provider === 'letsencrypt-staging';
    const name = input.domains[0];

    if (input.challengeType === 'http-01') {
      // Full automatic flow
      const result = await this.acmeService.requestCertHTTP01(input.domains, isStaging, contactEmail);

      // Encrypt private key before storing
      const encrypted = this.cryptoService.encryptPrivateKey(result.privateKeyPem);

      // Encrypt ACME account key before storing
      const acmeKeyEncrypted = this.cryptoService.encryptPrivateKey(result.accountKey);
      const acmeAccountKeyBlob = JSON.stringify({
        encrypted: acmeKeyEncrypted.encryptedPrivateKey,
        encryptedDek: acmeKeyEncrypted.encryptedDek,
        dekIv: acmeKeyEncrypted.dekIv,
        contactEmail,
      });

      // Only while this request still owns its lease: another process may be
      // issuing for the same domains now.
      await this.confirmAcmeLeases();
      const [cert] = await this.db
        .insert(sslCertificates)
        .values({
          name,
          folderId: input.folderId ?? null,
          type: 'acme',
          domainNames: input.domains,
          certificatePem: result.certificatePem,
          privateKeyPem: encrypted.encryptedPrivateKey,
          encryptedDek: encrypted.encryptedDek,
          dekIv: encrypted.dekIv,
          chainPem: result.chainPem,
          acmeProvider: input.provider,
          acmeChallengeType: 'http-01',
          acmeAccountKey: acmeAccountKeyBlob,
          notBefore: result.notBefore,
          notAfter: result.notAfter,
          autoRenew: input.autoRenew,
          status: 'active',
          createdById: userId,
        })
        .returning();

      // Deploy cert files to nginx
      try {
        await this.refreshOpfieldAssetAndSyncProxyHosts(cert.id, userId);
      } catch (deployError) {
        const deployMessage = deployError instanceof Error ? deployError.message : 'Unknown deploy error';
        await this.db
          .update(sslCertificates)
          .set({
            status: 'error',
            renewalError: `Certificate deploy failed: ${deployMessage}`,
            updatedAt: new Date(),
          })
          .where(this.acmeLeaseGuard(eq(sslCertificates.id, cert.id)));
        throw deployError;
      }

      await this.auditService.log({
        userId,
        action: 'ssl.acme_request',
        resourceType: 'ssl_certificate',
        resourceId: cert.id,
        details: {
          domains: input.domains,
          challengeType: 'http-01',
          provider: input.provider,
        },
      });

      logger.info('ACME certificate issued via HTTP-01', { certId: cert.id, domains: input.domains });
      this.emitCert(cert.id, 'created', input.domains.join(', '));

      return {
        certificate: this.sanitizeCert(cert),
        status: 'issued' as const,
      };
    }

    // DNS-01: start flow, return challenges
    const result = await this.acmeService.requestCertDNS01Start(input.domains, isStaging, contactEmail);

    // Encrypt ACME account key before storing
    const dns01AcmeKeyEncrypted = this.cryptoService.encryptPrivateKey(result.accountKey);
    const dns01AcmeAccountKeyBlob = JSON.stringify({
      encrypted: dns01AcmeKeyEncrypted.encryptedPrivateKey,
      encryptedDek: dns01AcmeKeyEncrypted.encryptedDek,
      dekIv: dns01AcmeKeyEncrypted.dekIv,
      contactEmail,
    });

    // Save pending cert with ACME state, only while this request still owns its lease.
    await this.confirmAcmeLeases();
    const [cert] = await this.db
      .insert(sslCertificates)
      .values({
        name,
        folderId: input.folderId ?? null,
        type: 'acme',
        domainNames: input.domains,
        acmeProvider: input.provider,
        acmeChallengeType: 'dns-01',
        acmeAccountKey: dns01AcmeAccountKeyBlob,
        acmeOrderUrl: result.orderUrl,
        acmePendingOperation: 'issue',
        acmePendingChallenges: result.challenges,
        autoRenew: input.dnsProvider === 'cloudflare' ? false : input.autoRenew,
        status: 'pending',
        createdById: userId,
      })
      .returning();

    if (input.dnsProvider === 'cloudflare') {
      let cloudflareChallenges: DNSChallenge[] | null = null;
      try {
        const autoRenewBindings = input.autoRenew
          ? await this.resolveCloudflareAutoRenewBindings({
              id: cert.id,
              domainNames: input.domains,
              autoRenewDnsBindings: null,
              autoRenewProvider: 'cloudflare',
            })
          : null;
        cloudflareChallenges = await this.tryProvisionCloudflareDnsChallenges(
          cert.id,
          result.challenges,
          autoRenewBindings
        );
        if (!cloudflareChallenges) {
          throw new AppError(
            409,
            'CLOUDFLARE_DNS_NOT_CONFIGURED',
            'Cloudflare DNS automation is not available for this certificate'
          );
        }

        await this.db
          .update(sslCertificates)
          .set({
            acmePendingChallenges: cloudflareChallenges,
            autoRenew: input.autoRenew,
            autoRenewProvider: autoRenewBindings ? 'cloudflare' : null,
            autoRenewDnsBindings: autoRenewBindings,
            updatedAt: new Date(),
          })
          .where(eq(sslCertificates.id, cert.id));

        await this.auditService.log({
          userId,
          action: 'ssl.acme_dns01_cloudflare_provision',
          resourceType: 'ssl_certificate',
          resourceId: cert.id,
          details: {
            domains: input.domains,
            challengeType: 'dns-01',
            provider: input.provider,
            autoRenew: input.autoRenew,
          },
        });
      } catch (error) {
        if (cloudflareChallenges) {
          await this.cleanupCloudflareDnsChallenges(cloudflareChallenges);
        }
        const message = error instanceof Error ? error.message : 'Cloudflare DNS automation failed';
        await this.db
          .update(sslCertificates)
          .set({
            status: 'error',
            renewalError: message,
            acmeOrderUrl: null,
            acmePendingOperation: null,
            acmePendingChallenges: null,
            autoRenew: false,
            autoRenewProvider: null,
            autoRenewDnsBindings: null,
            updatedAt: new Date(),
          })
          .where(eq(sslCertificates.id, cert.id));
        throw error;
      }

      await sleep(CLOUDFLARE_DNS01_PROPAGATION_DELAY_MS);
      const issued = await this.completeDNS01Verification(cert.id, userId, {
        cleanupCloudflare: true,
        clearPendingOnFailure: true,
      });
      return {
        certificate: issued,
        status: 'issued' as const,
      };
    }

    await this.auditService.log({
      userId,
      action: 'ssl.acme_dns01_start',
      resourceType: 'ssl_certificate',
      resourceId: cert.id,
      details: {
        domains: input.domains,
        challengeType: 'dns-01',
        provider: input.provider,
      },
    });

    logger.info('ACME DNS-01 challenge started', { certId: cert.id, domains: input.domains });

    return {
      certificate: this.sanitizeCert(cert),
      status: 'pending_dns_verification' as const,
      challenges: result.challenges,
    };
  }

  // ---------------------------------------------------------------------------
  // Complete DNS-01 verification
  // ---------------------------------------------------------------------------

  completeDNS01Verification(
    certId: string,
    userId: string,
    options: { cleanupCloudflare?: boolean; clearPendingOnFailure?: boolean; contactEmail?: string } = {}
  ) {
    return this.runAcmeOperation(`cert:${certId}`, 'verify', userId, () =>
      this.completeDNS01VerificationOnce(certId, userId, options)
    );
  }

  private async completeDNS01VerificationOnce(
    certId: string,
    userId: string,
    options: { cleanupCloudflare?: boolean; clearPendingOnFailure?: boolean; contactEmail?: string }
  ) {
    const cert = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, certId),
    });

    if (!cert) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');
    if (cert.acmeChallengeType !== 'dns-01')
      throw new AppError(400, 'NOT_DNS01', 'Certificate is not a DNS-01 challenge');
    if (!cert.acmeAccountKey || !cert.acmeOrderUrl) {
      throw new AppError(400, 'MISSING_ACME_STATE', 'Missing ACME state data for verification');
    }
    const pendingOperation = cert.acmePendingOperation ?? (cert.status === 'pending' ? 'issue' : null);
    if (pendingOperation !== 'issue' && pendingOperation !== 'renewal') {
      throw new AppError(400, 'NOT_PENDING', 'Certificate is not pending DNS verification');
    }
    if (pendingOperation === 'issue' && cert.status !== 'pending' && cert.status !== 'error') {
      throw new AppError(400, 'NOT_PENDING', 'Certificate is not pending DNS verification');
    }
    if (pendingOperation === 'renewal' && !RENEWABLE_STATUSES.has(cert.status)) {
      throw new AppError(400, 'CERT_NOT_RENEWABLE', 'Certificate is not in a renewable state');
    }
    // Every write below applies only while the row still holds this order.
    const orderGuard = this.acmeOrderGuard(cert);

    let cloudflareCleanupDone = false;
    try {
      // Decrypt the stored ACME account key
      const acmeKeyBlob = JSON.parse(cert.acmeAccountKey);
      const decryptedAccountKey = this.cryptoService.decryptPrivateKey({
        encryptedPrivateKey: acmeKeyBlob.encrypted,
        encryptedDek: acmeKeyBlob.encryptedDek,
        dekIv: acmeKeyBlob.dekIv,
      });
      // Orders started on v2.9.x or earlier have no contact in the blob.
      const contactEmail = await this.resolveAcmeContactEmail(cert, options.contactEmail);

      const dns01IsStaging = cert.acmeProvider === 'letsencrypt-staging';
      const result = await this.acmeService.requestCertDNS01Verify(
        decryptedAccountKey,
        cert.acmeOrderUrl,
        cert.domainNames,
        dns01IsStaging,
        contactEmail
      );

      // Encrypt private key
      const encrypted = this.cryptoService.encryptPrivateKey(result.privateKeyPem);

      try {
        // Update cert in DB
        const stored = await this.db
          .update(sslCertificates)
          .set({
            certificatePem: result.certificatePem,
            privateKeyPem: encrypted.encryptedPrivateKey,
            encryptedDek: encrypted.encryptedDek,
            dekIv: encrypted.dekIv,
            chainPem: result.chainPem,
            notBefore: result.notBefore,
            notAfter: result.notAfter,
            status: 'active',
            lastRenewedAt: pendingOperation === 'renewal' ? new Date() : cert.lastRenewedAt,
            renewalError: null,
            renewalFailureCount: 0,
            ...(pendingOperation === 'renewal' ? { lastRenewalAttemptAt: new Date() } : {}),
            ...(contactEmail && contactEmail !== this.getStoredAcmeContactEmail(cert.acmeAccountKey)
              ? { acmeAccountKey: JSON.stringify({ ...acmeKeyBlob, contactEmail }) }
              : {}),
            acmeOrderUrl: null, // Clear order URL after completion
            acmePendingOperation: null,
            acmePendingChallenges: null,
            updatedAt: new Date(),
          })
          .where(orderGuard)
          .returning({ id: sslCertificates.id });
        if (stored.length === 0) {
          throw new AppError(
            409,
            'ACME_ORDER_SUPERSEDED',
            'The certificate or its ACME order changed while the order was being verified'
          );
        }

        // Deploy to nginx — separate try/catch since cert is already valid at this point
        try {
          const delivery = await this.refreshOpfieldAssetAndSyncProxyHosts(certId, userId);
          await this.recordDistributionOutcome(certId, delivery.failures);
        } catch (deployError) {
          const deployMsg = deployError instanceof Error ? deployError.message : 'Unknown deploy error';
          logger.error('Certificate obtained but deploy to nginx failed', { certId, error: deployMsg });
          // Keep status as 'active' — cert is valid, just not deployed yet
          await this.db
            .update(sslCertificates)
            .set({
              renewalError: `Deploy failed: ${deployMsg}`,
              updatedAt: new Date(),
            })
            .where(eq(sslCertificates.id, certId));
          throw new AppError(500, 'DEPLOY_FAILED', `Certificate obtained but deploy failed: ${deployMsg}`);
        }

        await this.auditService.log({
          userId,
          action: pendingOperation === 'renewal' ? 'ssl.acme_dns01_renew_verify' : 'ssl.acme_dns01_verify',
          resourceType: 'ssl_certificate',
          resourceId: certId,
          details: { domains: cert.domainNames },
        });

        logger.info('ACME DNS-01 certificate verified', { certId, domains: cert.domainNames, pendingOperation });
        this.emitCert(certId, pendingOperation === 'renewal' ? 'renewed' : 'created', cert.name);

        const updated = await this.db.query.sslCertificates.findFirst({
          where: eq(sslCertificates.id, certId),
        });

        return this.sanitizeCert(updated!);
      } finally {
        if (options.cleanupCloudflare) {
          await this.cleanupCloudflareDnsChallenges((cert.acmePendingChallenges ?? []) as DNSChallenge[]);
          cloudflareCleanupDone = true;
        }
      }
    } catch (error) {
      if (options.cleanupCloudflare && !cloudflareCleanupDone) {
        await this.cleanupCloudflareDnsChallenges((cert.acmePendingChallenges ?? []) as DNSChallenge[]);
      }
      // DEPLOY_FAILED means the certificate itself was obtained and stored;
      // ACME_ORDER_SUPERSEDED means another operation owns the row now.
      if (
        error instanceof AppError &&
        (pendingOperation !== 'renewal' || error.code === 'DEPLOY_FAILED' || error.code === 'ACME_ORDER_SUPERSEDED')
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown verification error';
      if (pendingOperation === 'renewal') {
        await this.recordRenewalFailure(
          cert,
          `Renewal failed: ${message}`,
          options.clearPendingOnFailure
            ? { acmeOrderUrl: null, acmePendingOperation: null, acmePendingChallenges: null }
            : {},
          orderGuard
        );
        const failure =
          error instanceof AppError
            ? error
            : new AppError(400, 'DNS01_VERIFICATION_FAILED', `DNS-01 verification failed: ${message}`);
        this.recordedRenewalFailures.add(failure);
        throw failure;
      } else {
        await this.db
          .update(sslCertificates)
          .set({
            status: 'error',
            renewalError: message,
            ...(options.clearPendingOnFailure
              ? {
                  acmeOrderUrl: null,
                  acmePendingOperation: null,
                  acmePendingChallenges: null,
                  autoRenew: false,
                  autoRenewProvider: null,
                  autoRenewDnsBindings: null,
                }
              : {}),
            updatedAt: new Date(),
          })
          // A newer order (or a verify that already succeeded) is not marked failed.
          .where(orderGuard);
      }

      throw new AppError(400, 'DNS01_VERIFICATION_FAILED', `DNS-01 verification failed: ${message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Upload certificate
  // ---------------------------------------------------------------------------

  async uploadCert(input: UploadCertInput, userId: string) {
    // Parse PEM to extract domains and validity dates
    let parsedCert: x509.X509Certificate;
    try {
      parsedCert = new x509.X509Certificate(input.certificatePem);
    } catch {
      throw new AppError(400, 'INVALID_CERT', 'Failed to parse certificate PEM');
    }

    // Check not expired
    if (parsedCert.notAfter < new Date()) {
      throw new AppError(400, 'CERT_EXPIRED', 'Certificate is already expired');
    }

    // Extract domains from SAN extension
    const domains = this.extractDomains(parsedCert);

    // Validate that the private key matches the certificate
    this.validateKeyMatchesCert(input.privateKeyPem, parsedCert);

    // Encrypt private key
    const encrypted = this.cryptoService.encryptPrivateKey(input.privateKeyPem);

    const [cert] = await this.db
      .insert(sslCertificates)
      .values({
        name: input.name,
        folderId: input.folderId ?? null,
        type: 'upload',
        domainNames: domains,
        certificatePem: input.certificatePem,
        privateKeyPem: encrypted.encryptedPrivateKey,
        encryptedDek: encrypted.encryptedDek,
        dekIv: encrypted.dekIv,
        chainPem: input.chainPem || null,
        notBefore: parsedCert.notBefore,
        notAfter: parsedCert.notAfter,
        autoRenew: false,
        status: 'active',
        createdById: userId,
      })
      .returning();

    // Deploy cert files to nginx
    try {
      const delivery = await this.refreshOpfieldAssetAndSyncProxyHosts(cert.id, userId);
      await this.recordDistributionOutcome(cert.id, delivery.failures);
    } catch (deployError) {
      const deployMessage = deployError instanceof Error ? deployError.message : 'Unknown deploy error';
      await this.db
        .update(sslCertificates)
        .set({
          status: 'error',
          renewalError: `Certificate deploy failed: ${deployMessage}`,
          updatedAt: new Date(),
        })
        .where(eq(sslCertificates.id, cert.id));
      throw deployError;
    }

    await this.auditService.log({
      userId,
      action: 'ssl.upload',
      resourceType: 'ssl_certificate',
      resourceId: cert.id,
      details: { name: input.name, domains },
    });

    logger.info('Certificate uploaded', { certId: cert.id, name: input.name, domains });
    this.emitCert(cert.id, 'created', input.name);

    return this.sanitizeCert(cert);
  }

  // ---------------------------------------------------------------------------
  // Link internal CA certificate
  // ---------------------------------------------------------------------------

  async linkInternalCert(input: LinkInternalCertInput, userId: string, actorScopes: string[]) {
    // Look up PKI certificate
    const pkiCert = await this.db.query.certificates.findFirst({
      where: eq(certificates.id, input.internalCertId),
    });

    // Linking copies the PKI private key into the SSL store, which only ever hands it to nginx (no SSL route,
    // tool or event returns it), so serving the certificate is enough: pki:cert:deploy on it or its issuing CA.
    // Checked before the certificate's existence, so a caller without the scope learns nothing about it.
    if (!canDeployInternalCertificate(actorScopes, input.internalCertId, pkiCert?.caId)) {
      throw new AppError(
        403,
        'FORBIDDEN',
        `Missing required scope: ${INTERNAL_CERT_DEPLOY_SCOPE}:${input.internalCertId}`
      );
    }

    if (!pkiCert) throw new AppError(404, 'PKI_CERT_NOT_FOUND', 'Internal PKI certificate not found');
    const [issuer] = await this.db
      .select({ isSystem: certificateAuthorities.isSystem })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.id, pkiCert.caId))
      .limit(1);
    if (!issuer || issuer.isSystem) {
      throw new AppError(403, 'SYSTEM_CERT', 'Certificates issued by a system CA cannot be used as SSL certificates');
    }
    if (pkiCert.status !== 'active' || pkiCert.notAfter.getTime() <= Date.now())
      throw new AppError(400, 'PKI_CERT_NOT_ACTIVE', 'Internal PKI certificate is not active');
    if (pkiCert.type !== 'tls-server') {
      throw new AppError(400, 'PKI_CERT_NOT_SERVER', 'Only TLS server certificates can be used as SSL certificates');
    }

    // Auto-generate name from cert CN if not provided
    const name = input.name || pkiCert.commonName;
    // Clients that trust only the root need the intermediate CAs in the chain.
    const chainPem = await loadIssuerChainPem(this.db, pkiCert.caId);

    // Extract domains from the PKI cert
    let domains: string[] = [];
    try {
      const parsed = new x509.X509Certificate(pkiCert.certificatePem);
      domains = this.extractDomains(parsed);
    } catch {
      // Fallback to commonName
      if (pkiCert.commonName) {
        domains = [pkiCert.commonName];
      }
    }

    // We need the private key to deploy — decrypt it if available
    let privateKeyPem: string | null = null;
    if (pkiCert.encryptedPrivateKey && pkiCert.encryptedDek) {
      privateKeyPem = this.cryptoService.decryptPrivateKey({
        encryptedPrivateKey: pkiCert.encryptedPrivateKey,
        encryptedDek: pkiCert.encryptedDek,
        dekIv: pkiCert.dekIv || '',
      });
    }

    // Re-encrypt for the SSL cert entry
    let encryptedData: { encryptedPrivateKey: string; encryptedDek: string; dekIv: string } | null = null;
    if (privateKeyPem) {
      encryptedData = this.cryptoService.encryptPrivateKey(privateKeyPem);
    }

    const [cert] = await this.db
      .insert(sslCertificates)
      .values({
        name,
        folderId: input.folderId ?? null,
        type: 'internal',
        domainNames: domains,
        certificatePem: pkiCert.certificatePem,
        chainPem,
        privateKeyPem: encryptedData?.encryptedPrivateKey || null,
        encryptedDek: encryptedData?.encryptedDek || null,
        dekIv: encryptedData?.dekIv || null,
        internalCertId: input.internalCertId,
        notBefore: pkiCert.notBefore,
        notAfter: pkiCert.notAfter,
        // Opfield holds the key: reissue from the same CA and template before
        // expiry. A CSR-issued leaf cannot be reissued here and only alerts.
        autoRenew: !!privateKeyPem,
        status: 'active',
        createdById: userId,
      })
      .returning();

    // Store the linked certificate canonically. Active hosts are synchronized
    // through their atomic TLS bundle; no default-node predeployment occurs.
    if (privateKeyPem) {
      const delivery = await this.refreshOpfieldAssetAndSyncProxyHosts(cert.id, userId);
      await this.recordDistributionOutcome(cert.id, delivery.failures);
    }

    await this.auditService.log({
      userId,
      action: 'ssl.link_internal',
      resourceType: 'ssl_certificate',
      resourceId: cert.id,
      details: { internalCertId: input.internalCertId, name },
    });

    logger.info('Internal certificate linked', { certId: cert.id, internalCertId: input.internalCertId });
    this.emitCert(cert.id, 'created', name);

    return this.sanitizeCert(cert);
  }

  // ---------------------------------------------------------------------------
  // Renew certificate
  // ---------------------------------------------------------------------------

  renewCert(certId: string, userId: string, requesterEmail?: string, options?: { actorScopes?: string[] }) {
    return this.runAcmeOperation(`cert:${certId}`, 'renew', userId, () =>
      this.renewCertOnce(certId, userId, requesterEmail, options)
    );
  }

  private async renewCertOnce(
    certId: string,
    userId: string,
    requesterEmail?: string,
    options?: { actorScopes?: string[] }
  ) {
    const cert = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, certId),
    });

    if (!cert) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');
    if (cert.type === 'internal' && this.internalCertRenewal) {
      await this.internalCertRenewal.renewSslCertificate(certId, userId, { actorScopes: options?.actorScopes });
      const renewed = await this.db.query.sslCertificates.findFirst({ where: eq(sslCertificates.id, certId) });
      return this.sanitizeCert(renewed!);
    }
    if (cert.type !== 'acme') {
      throw new AppError(400, 'NOT_ACME', 'Only ACME and linked internal certificates can be renewed');
    }
    if (!RENEWABLE_STATUSES.has(cert.status)) {
      throw new AppError(400, 'CERT_NOT_RENEWABLE', 'Certificate is not in a renewable state');
    }

    let result: {
      certificatePem: string;
      privateKeyPem: string;
      chainPem: string;
      notBefore: Date;
      notAfter: Date;
      accountKey?: string;
    };
    let contactEmail: string | undefined;
    try {
      contactEmail = await this.resolveAcmeContactEmail(cert, requesterEmail);
      if (cert.acmeChallengeType !== 'http-01') {
        return await this.startDNS01Renewal(cert, userId, contactEmail);
      }
      const switched = await this.switchIngressGroupCertificateToCloudflareDns01(cert);
      if (switched) return await this.startDNS01Renewal(switched, userId, contactEmail);
      const renewIsStaging = cert.acmeProvider === 'letsencrypt-staging';
      result = await this.acmeService.requestCertHTTP01(cert.domainNames, renewIsStaging, contactEmail);
    } catch (error) {
      // DEPLOY_FAILED: the new certificate was obtained and stored already.
      // ACME_ORDER_SUPERSEDED: another operation owns the row now.
      if (
        error instanceof AppError &&
        (error.code === 'DEPLOY_FAILED' ||
          error.code === 'ACME_ORDER_SUPERSEDED' ||
          this.recordedRenewalFailures.has(error))
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown renewal error';
      // A renewal that lost its lease records no failure over the new owner's work.
      await this.confirmAcmeLeases();
      await this.recordRenewalFailure(
        cert,
        `Renewal failed: ${message}`,
        {},
        this.acmeLeaseGuard(eq(sslCertificates.id, cert.id))
      );
      if (error instanceof AppError) throw error;
      throw new AppError(500, 'RENEWAL_FAILED', `Certificate renewal failed: ${message}`);
    }

    // Encrypt private key
    const encrypted = this.cryptoService.encryptPrivateKey(result.privateKeyPem);

    // Encrypt updated ACME account key if present
    const renewUpdateData: Partial<typeof sslCertificates.$inferInsert> = {
      certificatePem: result.certificatePem,
      privateKeyPem: encrypted.encryptedPrivateKey,
      encryptedDek: encrypted.encryptedDek,
      dekIv: encrypted.dekIv,
      chainPem: result.chainPem,
      notBefore: result.notBefore,
      notAfter: result.notAfter,
      status: 'active',
      lastRenewedAt: new Date(),
      lastRenewalAttemptAt: new Date(),
      renewalError: null,
      renewalFailureCount: 0,
      acmeOrderUrl: null,
      acmePendingOperation: null,
      acmePendingChallenges: null,
      updatedAt: new Date(),
    };

    if (result.accountKey) {
      const renewAcmeKeyEncrypted = this.cryptoService.encryptPrivateKey(result.accountKey);
      renewUpdateData.acmeAccountKey = JSON.stringify({
        encrypted: renewAcmeKeyEncrypted.encryptedPrivateKey,
        encryptedDek: renewAcmeKeyEncrypted.encryptedDek,
        dekIv: renewAcmeKeyEncrypted.dekIv,
        contactEmail,
      });
    }

    // Update cert data in DB, only while this renewal still owns its lease.
    // A certificate deleted meanwhile is not redistributed.
    await this.confirmAcmeLeases();
    const renewed = await this.db
      .update(sslCertificates)
      .set(renewUpdateData)
      .where(this.acmeLeaseGuard(eq(sslCertificates.id, certId)))
      .returning({ id: sslCertificates.id });
    if (renewed.length === 0) {
      await this.confirmAcmeLeases();
      throw new AppError(409, 'SSL_CERT_DELETED', 'The certificate was deleted while it was being renewed');
    }

    // Refresh the canonical asset and atomically synchronize active hosts.
    // The certificate is renewed at this point; a delivery problem must not
    // be recorded as a renewal failure.
    try {
      const delivery = await this.refreshOpfieldAssetAndSyncProxyHosts(certId, userId);
      await this.recordDistributionOutcome(certId, delivery.failures);
    } catch (deployError) {
      const deployMsg = deployError instanceof Error ? deployError.message : 'Unknown deploy error';
      logger.error('Certificate renewed but deploy to nginx failed', { certId, error: deployMsg });
      await this.db
        .update(sslCertificates)
        .set({ renewalError: `Deploy failed: ${deployMsg}`, updatedAt: new Date() })
        .where(this.acmeLeaseGuard(eq(sslCertificates.id, certId)));
      throw new AppError(500, 'DEPLOY_FAILED', `Certificate renewed but deploy failed: ${deployMsg}`);
    }

    await this.auditService.log({
      userId,
      action: 'ssl.renew',
      resourceType: 'ssl_certificate',
      resourceId: certId,
      details: { domains: cert.domainNames },
    });

    logger.info('Certificate renewed', { certId, domains: cert.domainNames });
    this.emitCert(certId, 'renewed', cert.name);

    const updated = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, certId),
    });

    return this.sanitizeCert(updated!);
  }

  /**
   * An HTTP-01 certificate whose names moved onto a Cloudflare-managed ingress group domain renews with DNS-01
   * through the connector from now on (see preferCloudflareDns01ForIngressGroups). Returns the updated row, or null
   * when it keeps HTTP-01.
   */
  private async switchIngressGroupCertificateToCloudflareDns01(
    cert: typeof sslCertificates.$inferSelect
  ): Promise<typeof sslCertificates.$inferSelect | null> {
    if (!this.integrationsService || !(await namesOnCloudflareIngressGroups(this.db, cert.domainNames))) return null;
    let bindings: AutoRenewDnsBinding[];
    try {
      bindings = await this.resolveCloudflareAutoRenewBindings({ ...cert, autoRenewProvider: 'cloudflare' });
    } catch (error) {
      logger.warn('Ingress group certificate keeps HTTP-01 renewal: its names are not all in one Cloudflare zone', {
        certId: cert.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const [updated] = await this.db
      .update(sslCertificates)
      .set({
        acmeChallengeType: 'dns-01',
        autoRenewProvider: 'cloudflare',
        autoRenewDnsBindings: bindings,
        updatedAt: new Date(),
      })
      .where(
        this.acmeLeaseGuard(and(eq(sslCertificates.id, cert.id), eq(sslCertificates.acmeChallengeType, 'http-01'))!)
      )
      .returning();
    if (!updated) return null;
    await this.auditService.log({
      userId: null,
      action: 'ssl.acme_challenge_switched',
      resourceType: 'ssl_certificate',
      resourceId: cert.id,
      details: {
        domains: cert.domainNames,
        from: 'http-01',
        to: 'dns-01',
        provider: 'cloudflare',
        reason: 'ingress_group',
      },
    });
    return updated;
  }

  /**
   * A failed renewal never demotes a certificate that is still valid: it stays
   * `active` so auto-renewal and expiry alerts keep selecting it. Only a
   * certificate past notAfter leaves `active`.
   */
  private async recordRenewalFailure(
    cert: Pick<typeof sslCertificates.$inferSelect, 'id' | 'name' | 'notAfter'>,
    message: string,
    extra: Partial<typeof sslCertificates.$inferInsert> = {},
    guard: SQL = eq(sslCertificates.id, cert.id)
  ): Promise<void> {
    const now = new Date();
    const status = !cert.notAfter ? 'error' : cert.notAfter.getTime() > now.getTime() ? 'active' : 'expired';
    await this.db
      .update(sslCertificates)
      .set({
        ...extra,
        status,
        renewalError: message,
        renewalFailureCount: sql`${sslCertificates.renewalFailureCount} + 1`,
        lastRenewalAttemptAt: now,
        updatedAt: now,
      })
      .where(guard);
    this.emitCert(cert.id, 'renewal_failed', cert.name);
  }

  /**
   * Contact for an ACME account. Blobs written by v2.9.x or earlier carry
   * none, so fall back to the renewing user, the certificate creator, and
   * finally the first active system administrator.
   */
  private async resolveAcmeContactEmail(
    cert: Pick<typeof sslCertificates.$inferSelect, 'acmeAccountKey' | 'createdById'>,
    requesterEmail?: string
  ): Promise<string | undefined> {
    const stored = this.getStoredAcmeContactEmail(cert.acmeAccountKey);
    if (stored) return stored;
    const requester = requesterEmail?.trim();
    if (requester) return requester;

    try {
      if (cert.createdById && cert.createdById !== OPFIELD_SYSTEM_USER_ID) {
        const [creator] = await this.db
          .select({ email: users.email })
          .from(users)
          .where(and(eq(users.id, cert.createdById), isNull(users.deletedAt), eq(users.isBlocked, false)))
          .limit(1);
        if (creator?.email?.trim()) return creator.email.trim();
      }

      const [admin] = await this.db
        .select({ email: users.email })
        .from(users)
        .innerJoin(permissionGroups, eq(users.groupId, permissionGroups.id))
        .where(
          and(
            eq(permissionGroups.name, 'system-admin'),
            ne(users.id, OPFIELD_SYSTEM_USER_ID),
            isNull(users.deletedAt),
            eq(users.isBlocked, false)
          )
        )
        .orderBy(asc(users.createdAt))
        .limit(1);
      return admin?.email?.trim() || undefined;
    } catch (error) {
      // The ACME client reports a missing contact precisely; do not let a
      // lookup failure mask that.
      logger.warn('Could not resolve a fallback ACME contact email', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async setAutoRenew(certId: string, input: SetSslAutoRenewInput, userId: string) {
    const cert = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, certId),
    });

    if (!cert) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');
    if (cert.type === 'internal') return this.setInternalAutoRenew(cert, input.enabled, userId);
    if (cert.type !== 'acme') {
      throw new AppError(400, 'NOT_ACME', 'Only ACME and linked internal certificates support auto-renewal');
    }

    const updates: Partial<typeof sslCertificates.$inferInsert> = {
      autoRenew: false,
      autoRenewProvider: null,
      autoRenewDnsBindings: null,
      autoRenewDisabledReason: null,
      autoRenewDisabledAt: null,
      updatedAt: new Date(),
    };

    if (input.enabled) {
      updates.renewalError = null;
      if (cert.acmeChallengeType === 'http-01') {
        updates.autoRenew = true;
      } else if (cert.acmeChallengeType === 'dns-01') {
        if (input.provider !== 'cloudflare') {
          throw new AppError(400, 'CLOUDFLARE_PROVIDER_REQUIRED', 'DNS-01 auto-renewal requires Cloudflare');
        }
        if (cert.status !== 'active') {
          throw new AppError(400, 'CERT_NOT_ACTIVE', 'DNS-01 auto-renewal can only be enabled for active certificates');
        }
        const bindings = await this.resolveCloudflareAutoRenewBindings(cert);
        updates.autoRenew = true;
        updates.autoRenewProvider = 'cloudflare';
        updates.autoRenewDnsBindings = bindings;
      } else {
        throw new AppError(400, 'UNSUPPORTED_ACME_CHALLENGE', 'Unsupported ACME challenge type');
      }
    }

    await this.db.update(sslCertificates).set(updates).where(eq(sslCertificates.id, certId));

    await this.auditService.log({
      userId,
      action: input.enabled ? 'ssl.auto_renew_enable' : 'ssl.auto_renew_disable',
      resourceType: 'ssl_certificate',
      resourceId: certId,
      details: {
        domains: cert.domainNames,
        provider: input.enabled && cert.acmeChallengeType === 'dns-01' ? input.provider : null,
      },
    });

    this.emitCert(certId, 'updated', cert.name);
    return this.getCert(certId);
  }

  async revalidateCloudflareAutoRenewForConnector(connectorId: string) {
    await this.revalidateCloudflareAutoRenew((bindings) =>
      bindings.some((binding) => binding.connectorId === connectorId)
    );
  }

  async revalidateCloudflareAutoRenew(shouldCheck?: (bindings: AutoRenewDnsBinding[]) => boolean) {
    const certs = await this.db.query.sslCertificates.findMany({
      where: eq(sslCertificates.autoRenewProvider, 'cloudflare'),
      columns: {
        privateKeyPem: false,
        encryptedDek: false,
        dekIv: false,
        acmeAccountKey: false,
      },
    });

    for (const cert of certs) {
      const bindings = (cert.autoRenewDnsBindings ?? []) as AutoRenewDnsBinding[];
      if (shouldCheck && !shouldCheck(bindings)) continue;
      try {
        await this.resolveCloudflareAutoRenewBindings(cert, { requireExistingMatch: true });
      } catch (error) {
        await this.disableCloudflareAutoRenew(cert, 'cloudflare_zone_unavailable', error);
      }
    }
  }

  async disableCloudflareAutoRenewForConnector(connectorId: string, reason = 'cloudflare_connector_unavailable') {
    const certs = await this.db.query.sslCertificates.findMany({
      where: eq(sslCertificates.autoRenewProvider, 'cloudflare'),
      columns: {
        privateKeyPem: false,
        encryptedDek: false,
        dekIv: false,
        acmeAccountKey: false,
      },
    });

    for (const cert of certs) {
      const bindings = (cert.autoRenewDnsBindings ?? []) as AutoRenewDnsBinding[];
      if (bindings.some((binding) => binding.connectorId === connectorId)) {
        await this.disableCloudflareAutoRenew(cert, reason);
      }
    }
  }

  private async startDNS01Renewal(
    cert: typeof sslCertificates.$inferSelect,
    userId: string,
    contactEmail: string | undefined
  ) {
    const cloudflareAutoRenewBindings =
      cert.autoRenewProvider === 'cloudflare'
        ? await this.resolveCloudflareAutoRenewBindings(cert, { requireExistingMatch: true }).catch(async (error) => {
            await this.disableCloudflareAutoRenew(cert, 'cloudflare_zone_unavailable', error);
            throw error;
          })
        : null;
    const renewIsStaging = cert.acmeProvider === 'letsencrypt-staging';
    const result = await this.acmeService.requestCertDNS01Start(cert.domainNames, renewIsStaging, contactEmail);

    const acmeKeyEncrypted = this.cryptoService.encryptPrivateKey(result.accountKey);
    const acmeAccountKeyBlob = JSON.stringify({
      encrypted: acmeKeyEncrypted.encryptedPrivateKey,
      encryptedDek: acmeKeyEncrypted.encryptedDek,
      dekIv: acmeKeyEncrypted.dekIv,
      contactEmail,
    });

    const cloudflareChallenges = await this.tryProvisionCloudflareDnsChallenges(
      cert.id,
      result.challenges,
      cloudflareAutoRenewBindings
    );
    if (cert.autoRenewProvider === 'cloudflare' && !cloudflareChallenges) {
      await this.disableCloudflareAutoRenew(cert, 'cloudflare_zone_unavailable');
      throw new AppError(
        409,
        'CLOUDFLARE_ZONE_NOT_FOUND',
        'Cloudflare DNS automation is no longer available for this certificate'
      );
    }
    const pendingChallenges: DNSChallenge[] = cloudflareChallenges ?? result.challenges;

    // Replace only the order this renewal started from: a verify in another
    // process must not find its order swapped underneath it.
    const started = await this.db
      .update(sslCertificates)
      .set({
        acmeAccountKey: acmeAccountKeyBlob,
        acmeOrderUrl: result.orderUrl,
        acmePendingOperation: 'renewal',
        acmePendingChallenges: pendingChallenges,
        renewalError: null,
        updatedAt: new Date(),
      })
      .where(this.acmeOrderGuard(cert))
      .returning({ id: sslCertificates.id });
    if (started.length === 0) {
      if (cloudflareChallenges) await this.cleanupCloudflareDnsChallenges(cloudflareChallenges);
      throw new AppError(
        409,
        'ACME_ORDER_SUPERSEDED',
        'The certificate or its ACME order changed while the renewal was starting'
      );
    }
    // TXT records Opfield created for the order this one replaces are no longer needed.
    const currentRecordIds = new Set(pendingChallenges.flatMap((challenge) => challenge.cloudflare?.recordId ?? []));
    await this.cleanupCloudflareDnsChallenges(
      ((cert.acmePendingChallenges ?? []) as DNSChallenge[]).filter(
        (challenge) => !challenge.cloudflare || !currentRecordIds.has(challenge.cloudflare.recordId)
      )
    );

    await this.auditService.log({
      userId,
      action: 'ssl.acme_dns01_renew_start',
      resourceType: 'ssl_certificate',
      resourceId: cert.id,
      details: { domains: cert.domainNames, challengeType: 'dns-01', cloudflare: Boolean(cloudflareChallenges) },
    });

    logger.info('ACME DNS-01 renewal challenge started', { certId: cert.id, domains: cert.domainNames });

    if (cloudflareChallenges) {
      await sleep(CLOUDFLARE_DNS01_PROPAGATION_DELAY_MS);
      return this.completeDNS01Verification(cert.id, userId, {
        cleanupCloudflare: true,
        clearPendingOnFailure: true,
      });
    }

    const updated = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, cert.id),
    });

    return {
      certificate: this.sanitizeCert(updated!),
      status: 'pending_dns_verification' as const,
      challenges: result.challenges as DNSChallenge[],
    };
  }

  private async tryProvisionCloudflareDnsChallenges(
    certId: string,
    challenges: DNSChallenge[],
    expectedBindings?: AutoRenewDnsBinding[] | null
  ): Promise<DNSChallenge[] | null> {
    if (!this.integrationsService) return null;

    const provisioned: DNSChallenge[] = [];
    const createdRecords: Array<{ zoneId: string; recordId: string; challenge: DNSChallenge }> = [];
    const expectedByDomain = new Map(
      (expectedBindings ?? []).map((binding) => [this.normalizeAcmeDomain(binding.domain), binding])
    );

    try {
      for (const challenge of challenges) {
        const context = await this.integrationsService.resolveCloudflareDnsContext(challenge.domain);
        const expected = expectedByDomain.get(this.normalizeAcmeDomain(challenge.domain));
        if (expected && (context.connector.id !== expected.connectorId || context.zone.remoteId !== expected.zoneId)) {
          throw new AppError(409, 'CLOUDFLARE_ZONE_CHANGED', 'Cloudflare zone binding changed for this certificate', {
            domain: challenge.domain,
            expectedConnectorId: expected.connectorId,
            expectedZoneId: expected.zoneId,
            actualConnectorId: context.connector.id,
            actualZoneId: context.zone.remoteId,
          });
        }
        const records = await context.client.listDnsRecords(context.zone.remoteId, challenge.recordName);
        const existing = records.find((record) => record.type === 'TXT' && record.content === challenge.recordValue);
        const record =
          existing ??
          (await context.client.createDnsRecord(context.zone.remoteId, {
            type: 'TXT',
            name: challenge.recordName,
            content: challenge.recordValue,
            ttl: 60,
            comment: `Opfield ACME DNS-01 challenge for SSL certificate ${certId}`,
          }));
        const created = !existing;
        const nextChallenge: DNSChallenge = {
          ...challenge,
          cloudflare: {
            connectorId: context.connector.id,
            zoneId: context.zone.remoteId,
            zoneName: context.zone.name,
            recordId: record.id,
            created,
          },
        };
        provisioned.push(nextChallenge);
        if (created) {
          createdRecords.push({ zoneId: context.zone.remoteId, recordId: record.id, challenge: nextChallenge });
        }
      }
      return provisioned;
    } catch (error) {
      for (const created of createdRecords.reverse()) {
        try {
          const context = await this.integrationsService.getCloudflareDnsContextForRecord(
            created.challenge.cloudflare!.connectorId,
            created.zoneId
          );
          await context.client.deleteDnsRecord(created.zoneId, created.recordId);
        } catch (cleanupError) {
          logger.warn('Failed to clean up Cloudflare ACME challenge after provisioning failure', {
            certId,
            zoneId: created.zoneId,
            recordId: created.recordId,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      if (error instanceof AppError && error.code === 'CLOUDFLARE_ZONE_NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  private async cleanupCloudflareDnsChallenges(challenges: DNSChallenge[]) {
    if (!this.integrationsService) return;
    for (const challenge of challenges) {
      const cloudflare = challenge.cloudflare;
      if (!cloudflare?.created) continue;
      try {
        const context = await this.integrationsService.getCloudflareDnsContextForRecord(
          cloudflare.connectorId,
          cloudflare.zoneId
        );
        await context.client.deleteDnsRecord(cloudflare.zoneId, cloudflare.recordId);
      } catch (error) {
        logger.warn('Failed to clean up Cloudflare ACME challenge record', {
          domain: challenge.domain,
          recordName: challenge.recordName,
          zoneId: cloudflare.zoneId,
          recordId: cloudflare.recordId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async resolveCloudflareAutoRenewBindings(
    cert: Pick<
      typeof sslCertificates.$inferSelect,
      'id' | 'domainNames' | 'autoRenewDnsBindings' | 'autoRenewProvider'
    >,
    options: { requireExistingMatch?: boolean } = {}
  ): Promise<AutoRenewDnsBinding[]> {
    if (!this.integrationsService) {
      throw new AppError(409, 'CLOUDFLARE_DNS_NOT_CONFIGURED', 'Cloudflare DNS integration is not configured');
    }

    const bindings: AutoRenewDnsBinding[] = [];
    for (const domain of cert.domainNames) {
      const context = await this.integrationsService.resolveCloudflareDnsContext(domain);
      bindings.push({
        domain,
        connectorId: context.connector.id,
        connectorName: context.connector.name,
        zoneId: context.zone.remoteId,
        zoneName: context.zone.name,
      });
    }

    const connectorIds = new Set(bindings.map((binding) => binding.connectorId));
    if (connectorIds.size > 1) {
      throw new AppError(
        409,
        'CLOUDFLARE_CONNECTOR_MISMATCH',
        'All certificate domains must resolve through the same Cloudflare connector',
        {
          certId: cert.id,
          connectors: [...connectorIds],
        }
      );
    }

    if (options.requireExistingMatch) {
      const existingByDomain = new Map(
        ((cert.autoRenewDnsBindings ?? []) as AutoRenewDnsBinding[]).map((binding) => [
          this.normalizeAcmeDomain(binding.domain),
          binding,
        ])
      );
      for (const binding of bindings) {
        const existing = existingByDomain.get(this.normalizeAcmeDomain(binding.domain));
        if (!existing || existing.connectorId !== binding.connectorId || existing.zoneId !== binding.zoneId) {
          throw new AppError(409, 'CLOUDFLARE_ZONE_CHANGED', 'Cloudflare zone binding changed for this certificate', {
            certId: cert.id,
            domain: binding.domain,
          });
        }
      }
    }

    return bindings;
  }

  private async disableCloudflareAutoRenew(
    cert: Pick<typeof sslCertificates.$inferSelect, 'id' | 'name' | 'domainNames'>,
    reason: string,
    cause?: unknown
  ) {
    const message = cause instanceof Error ? cause.message : cause ? String(cause) : reason;
    await this.db
      .update(sslCertificates)
      .set({
        autoRenew: false,
        autoRenewProvider: null,
        autoRenewDnsBindings: null,
        autoRenewDisabledReason: reason,
        autoRenewDisabledAt: new Date(),
        renewalError: `Cloudflare auto-renew disabled: ${message}`,
        updatedAt: new Date(),
      })
      .where(eq(sslCertificates.id, cert.id));

    await this.auditService.log({
      userId: null,
      action: 'ssl.auto_renew_disabled',
      resourceType: 'ssl_certificate',
      resourceId: cert.id,
      details: { domains: cert.domainNames, provider: 'cloudflare', reason, message },
    });

    this.emitCert(cert.id, 'updated', cert.name);
  }

  private normalizeAcmeDomain(domain: string) {
    return domain.trim().toLowerCase().replace(/^\*\./, '');
  }

  private getStoredAcmeContactEmail(accountKeyBlob: string | null): string | undefined {
    if (!accountKeyBlob) return undefined;
    try {
      const parsed = JSON.parse(accountKeyBlob) as { contactEmail?: unknown };
      return typeof parsed.contactEmail === 'string' && parsed.contactEmail.trim()
        ? parsed.contactEmail.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Delete certificate
  // ---------------------------------------------------------------------------

  async cancelPendingAcmeIssue(certId: string, userId: string) {
    const cert = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, certId),
      columns: { type: true, status: true, acmePendingOperation: true },
    });

    if (!cert) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');
    if (
      cert.type !== 'acme' ||
      cert.acmePendingOperation !== 'issue' ||
      (cert.status !== 'pending' && cert.status !== 'error')
    ) {
      throw new AppError(409, 'ACME_REQUEST_NOT_PENDING', 'Only a pending ACME certificate request can be cancelled');
    }

    await this.deleteCert(certId, userId);
  }

  async deleteCert(certId: string, userId: string) {
    const cert = await transactionWithScopeCleanup(this.db, async (tx) => {
      // Lock the row before looking for references. A proxy host write that
      // names this certificate waits on this lock (its foreign-key check) and
      // fails once the delete commits; one that committed first is seen below.
      const [cert] = await tx.select().from(sslCertificates).where(eq(sslCertificates.id, certId)).for('update');

      if (!cert) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');
      if (cert.isSystem) throw new AppError(403, 'SYSTEM_CERT', 'System certificates cannot be deleted');

      // Check no proxy hosts reference this cert
      const referencingHosts = await tx.query.proxyHosts.findMany({
        where: eq(proxyHosts.sslCertificateId, certId),
        columns: { id: true, domainNames: true },
      });

      if (referencingHosts.length > 0) {
        throw new AppError(409, 'CERT_IN_USE', 'Certificate is in use by routes', {
          proxyHostIds: referencingHosts.map((h) => h.id),
        });
      }

      const [pagesProfile] = await tx
        .select({ id: pageWildcardProfiles.id })
        .from(pageWildcardProfiles)
        .where(and(eq(pageWildcardProfiles.certificateId, certId), eq(pageWildcardProfiles.enabled, true)))
        .limit(1);
      if (pagesProfile) {
        throw new AppError(409, 'CERT_IN_USE', 'Certificate is in use by the Pages wildcard profile', {
          pagesProfileId: pagesProfile.id,
        });
      }

      // In this transaction: if the delete rolls back, the certificate's
      // replicas must not be left queued for cleanup.
      await this.certificateDistribution.removeSslCertificateAsset(certId, tx);

      // Delete from DB
      // ON DELETE RESTRICT: a host assigned after the check above still blocks the delete.
      await tx.delete(sslCertificates).where(eq(sslCertificates.id, certId)).catch(rethrowCertificateInUse);
      return cert;
    });

    await this.auditService.log({
      userId,
      action: 'ssl.delete',
      resourceType: 'ssl_certificate',
      resourceId: certId,
      details: { name: cert.name, domains: cert.domainNames },
    });

    logger.info('Certificate deleted', { certId, name: cert.name });
    this.emitCert(certId, 'deleted', cert.name);
  }

  async resyncDistribution(certId: string, userId: string): Promise<{ synchronized: number }> {
    const cert = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, certId),
      columns: { id: true, name: true },
    });
    if (!cert) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');
    const result = await this.certificateDistribution.syncCertificate({ type: 'ssl', id: certId });
    const delivery = await this.resyncActiveProxyHosts(certId, userId);
    await this.recordDistributionOutcome(certId, delivery.failures);
    const synchronized = Math.max(result.synchronized, delivery.synchronized);
    await this.auditService.log({
      userId,
      action: 'ssl.distribution_resync',
      resourceType: 'ssl_certificate',
      resourceId: certId,
      details: { synchronized },
    });
    return { synchronized };
  }

  // ---------------------------------------------------------------------------
  // List certificates
  // ---------------------------------------------------------------------------

  async listCerts(params: SSLCertListQuery, options?: { allowedIds?: string[] }): Promise<PaginatedResponse<any>> {
    const conditions = [];

    if (options?.allowedIds) {
      if (options.allowedIds.length === 0) {
        return {
          data: [],
          pagination: { page: params.page, limit: params.limit, total: 0, totalPages: 0 },
        };
      }
      conditions.push(inArray(sslCertificates.id, options.allowedIds));
    }

    if (!params.showSystem) conditions.push(eq(sslCertificates.isSystem, false));
    // App members: the normal list leaves them out, an app's Network tab asks for one app (before paging).
    const appFilter = appMemberFolderCondition(sslCertificates.folderId, sslCertificateFolders, {
      appId: params.appId ?? null,
      excludeAppMembers: params.excludeAppMembers,
    });
    if (appFilter) conditions.push(appFilter);
    if (params.type) conditions.push(eq(sslCertificates.type, params.type));
    if (params.status) conditions.push(eq(sslCertificates.status, params.status));
    if (params.search) {
      conditions.push(or(ilike(sslCertificates.name, `%${escapeLike(params.search)}%`))!);
    }

    const where = buildWhere(conditions);

    const [entries, [{ count: totalCount }]] = await Promise.all([
      this.db.query.sslCertificates.findMany({
        where: where ? () => where : undefined,
        orderBy: [desc(sslCertificates.createdAt)],
        limit: params.limit,
        offset: (params.page - 1) * params.limit,
        columns: {
          privateKeyPem: false,
          encryptedDek: false,
          dekIv: false,
          acmeAccountKey: false,
        },
      }),
      this.db.select({ count: count() }).from(sslCertificates).where(where),
    ]);

    const total = Number(totalCount);

    const distribution = await this.certificateDistribution.getStatusesForSslCertificates(
      entries.map((entry) => entry.id)
    );
    return {
      data: await withAppMembers(
        'certificates',
        entries.map((entry) => ({ ...entry, distribution: distribution.get(entry.id) }))
      ),
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Get single certificate
  // ---------------------------------------------------------------------------

  private async setInternalAutoRenew(cert: typeof sslCertificates.$inferSelect, enabled: boolean, userId: string) {
    if (enabled && (!cert.privateKeyPem || !cert.internalCertId)) {
      throw new AppError(
        400,
        'INTERNAL_CERT_NOT_RENEWABLE',
        'This certificate was issued from a CSR, so Opfield does not hold its private key and cannot reissue it'
      );
    }
    const [updated] = await this.db
      .update(sslCertificates)
      .set({ autoRenew: enabled, renewalError: enabled ? cert.renewalError : null, updatedAt: new Date() })
      .where(eq(sslCertificates.id, cert.id))
      .returning();
    await this.auditService.log({
      userId,
      action: 'ssl.auto_renew',
      resourceType: 'ssl_certificate',
      resourceId: cert.id,
      details: { enabled, type: 'internal' },
    });
    this.emitCert(cert.id, 'updated', cert.name);
    return this.sanitizeCert(updated!);
  }

  /**
   * Put a reissued internal PKI leaf into service for a linked SSL certificate:
   * store the new material, then refresh the canonical asset and every active
   * proxy host through the existing atomic TLS distribution. A delivery
   * problem is recorded on the certificate, never as a failed renewal.
   */
  async applyReissuedInternalCertificate(
    certId: string,
    material: {
      internalCertId: string;
      certificatePem: string;
      privateKeyPem: string;
      notBefore: Date;
      notAfter: Date;
    },
    userId: string,
    trigger: 'scheduled' | 'manual'
  ): Promise<{ failures: ProxyHostSyncFailure[] }> {
    const cert = await this.db.query.sslCertificates.findFirst({ where: eq(sslCertificates.id, certId) });
    if (!cert) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');
    if (cert.type !== 'internal') throw new AppError(400, 'NOT_INTERNAL', 'Not a linked internal certificate');

    let domains = cert.domainNames;
    try {
      const parsed = this.extractDomains(new x509.X509Certificate(material.certificatePem));
      if (parsed.length > 0) domains = parsed;
    } catch {
      // Keep the linked domain list.
    }
    const encrypted = this.cryptoService.encryptPrivateKey(material.privateKeyPem);
    const chainPem = await loadCertificateIssuerChainPem(this.db, material.internalCertId);
    const now = new Date();
    await this.db
      .update(sslCertificates)
      .set({
        certificatePem: material.certificatePem,
        chainPem,
        privateKeyPem: encrypted.encryptedPrivateKey,
        encryptedDek: encrypted.encryptedDek,
        dekIv: encrypted.dekIv,
        internalCertId: material.internalCertId,
        domainNames: domains,
        notBefore: material.notBefore,
        notAfter: material.notAfter,
        status: 'active',
        lastRenewedAt: now,
        lastRenewalAttemptAt: now,
        renewalError: null,
        renewalFailureCount: 0,
        updatedAt: now,
      })
      .where(eq(sslCertificates.id, certId));

    let failures: ProxyHostSyncFailure[] = [];
    try {
      const delivery = await this.refreshOpfieldAssetAndSyncProxyHosts(certId, userId);
      await this.recordDistributionOutcome(certId, delivery.failures);
      failures = delivery.failures;
    } catch (deployError) {
      const deployMsg = deployError instanceof Error ? deployError.message : 'Unknown deploy error';
      logger.error('Internal certificate reissued but deploy to nginx failed', { certId, error: deployMsg });
      await this.db
        .update(sslCertificates)
        .set({ renewalError: `Deploy failed: ${deployMsg}`, updatedAt: new Date() })
        .where(eq(sslCertificates.id, certId));
      throw new AppError(500, 'DEPLOY_FAILED', `Certificate reissued but deploy failed: ${deployMsg}`);
    }

    await this.auditService.log({
      userId,
      action: 'ssl.renew',
      resourceType: 'ssl_certificate',
      resourceId: certId,
      details: {
        type: 'internal',
        trigger,
        previousInternalCertId: cert.internalCertId,
        internalCertId: material.internalCertId,
        domains,
      },
    });
    logger.info('Linked internal certificate reissued', { certId, internalCertId: material.internalCertId, trigger });
    this.emitCert(certId, 'renewed', cert.name);
    return { failures };
  }

  /**
   * A certificate linked from the internal PKI before the issuer chain was
   * stored went out without its intermediate CAs. Store the chain and deliver
   * the certificate again. Returns true when the certificate was repaired.
   */
  async repairInternalIssuerChain(certId: string): Promise<boolean> {
    const cert = await this.db.query.sslCertificates.findFirst({ where: eq(sslCertificates.id, certId) });
    if (!cert || cert.type !== 'internal' || !cert.internalCertId || cert.chainPem) return false;
    const chainPem = await loadCertificateIssuerChainPem(this.db, cert.internalCertId);
    if (!chainPem) return false;
    await this.db
      .update(sslCertificates)
      .set({ chainPem, updatedAt: new Date() })
      .where(and(eq(sslCertificates.id, certId), isNull(sslCertificates.chainPem)));
    // Without its key the certificate was never delivered to Nginx.
    if (cert.privateKeyPem) {
      const delivery = await this.refreshOpfieldAssetAndSyncProxyHosts(certId, OPFIELD_SYSTEM_USER_ID);
      await this.recordDistributionOutcome(certId, delivery.failures);
    }
    logger.info('Issuer chain added to a linked internal certificate', { certId });
    this.emitCert(certId, 'updated', cert.name);
    return true;
  }

  async getCert(certId: string) {
    const cert = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, certId),
    });

    if (!cert) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');

    return {
      ...this.sanitizeCert(cert),
      distribution: await this.certificateDistribution.getStatusForSslCertificate(certId),
    };
  }

  // ---------------------------------------------------------------------------
  // Get certificates expiring soon (for renewal job)
  // ---------------------------------------------------------------------------

  async getCertsExpiringSoon(days: number, options?: { allowedIds?: string[] }) {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() + days);

    if (options?.allowedIds?.length === 0) return [];

    return this.db.query.sslCertificates.findMany({
      where: and(
        options?.allowedIds ? inArray(sslCertificates.id, options.allowedIds) : undefined,
        eq(sslCertificates.autoRenew, true),
        lte(sslCertificates.notAfter, threshold),
        or(
          eq(sslCertificates.status, 'active'),
          // A failed renewal on v2.9.x or earlier left still-valid rows in `error`.
          and(eq(sslCertificates.status, 'error'), gt(sslCertificates.notAfter, new Date()))
        )
      ),
      columns: {
        privateKeyPem: false,
        encryptedDek: false,
        dekIv: false,
        acmeAccountKey: false,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract domain names from a certificate's Subject Alternative Names.
   */
  private extractDomains(cert: x509.X509Certificate): string[] {
    const domains: string[] = [];

    // Try SAN extension first
    const sanExtension = cert.extensions.find((ext) => ext.type === '2.5.29.17');

    if (sanExtension) {
      try {
        const san = new x509.SubjectAlternativeNameExtension(sanExtension.rawData);
        for (const name of san.names.items) {
          if (name.type === 'dns') {
            domains.push(name.value);
          }
        }
      } catch {
        // Fall through to CN extraction
      }
    }

    // Fallback: extract CN from subject
    if (domains.length === 0) {
      const cnMatch = cert.subject.match(/CN=([^,]+)/);
      if (cnMatch) {
        domains.push(cnMatch[1]);
      }
    }

    return domains;
  }

  /**
   * Validate that a private key matches a certificate's public key.
   */
  private validateKeyMatchesCert(privateKeyPem: string, cert: x509.X509Certificate): void {
    try {
      // Create a KeyObject from the private key to verify it's valid
      const keyObject = crypto.createPrivateKey(privateKeyPem);
      const publicKeyFromPrivate = crypto.createPublicKey(keyObject);

      // Export both public keys and compare
      const pubKeyFromPrivateDer = publicKeyFromPrivate.export({ type: 'spki', format: 'der' });
      const certPublicKeyDer = Buffer.from(cert.publicKey.rawData);

      if (!pubKeyFromPrivateDer.equals(certPublicKeyDer)) {
        throw new AppError(400, 'KEY_MISMATCH', 'Private key does not match the certificate');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(400, 'INVALID_KEY', 'Failed to validate private key against certificate');
    }
  }

  /**
   * Strip sensitive fields from a certificate before returning to the client.
   */
  private sanitizeCert(cert: typeof sslCertificates.$inferSelect) {
    return {
      ...cert,
      privateKeyPem: undefined,
      encryptedDek: undefined,
      dekIv: undefined,
      acmeAccountKey: undefined,
    };
  }
}
