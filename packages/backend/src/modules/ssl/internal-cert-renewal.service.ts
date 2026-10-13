import { and, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  alerts,
  certificateAuthorities,
  certificates,
  certificateTemplates,
  proxyHosts,
  sslCertificates,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AlertService } from '@/modules/audit/alert.service.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { IssueCertificateInput } from '@/modules/pki/cert.schemas.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { NginxCertificateDistributionService } from '@/services/nginx-certificate-distribution.service.js';
import { SSL_DISTRIBUTION_ERROR_PREFIX, type SSLService } from './ssl.service.js';

const logger = createChildLogger('InternalCertificateRenewal');

const DAY_MS = 24 * 60 * 60 * 1000;
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
/** One failure alert per certificate per run window; the job runs daily. */
const FAILURE_ALERT_REPEAT_MS = 20 * 60 * 60 * 1000;
const PKI_ISSUE_SCOPE = 'pki:cert:issue';
const RENEWABLE_SSL_STATUSES = ['active', 'error', 'expired'] as const;

type SourceCertificate = typeof certificates.$inferSelect;

export interface InternalCertificateReissueResult {
  previousCertificateId: string;
  certificateId: string;
  notAfter: Date;
  sslCertificateIds: string[];
  proxyHostIds: string[];
  deliveryFailures: Array<{ target: string; error: string }>;
}

export interface InternalCertificateRenewalRunResult {
  checked: number;
  renewed: number;
  failed: number;
  csrIssued: number;
  /** Due, but the CA ends too soon for a replacement to outlive the current leaf. */
  notExtendable: number;
  /** Lives less than MIN_AUTO_REISSUE_LIFETIME_DAYS; the daily pass cannot keep up with it. */
  tooShortLived: number;
}

/**
 * Leaves that live less than this are not reissued automatically: the daily
 * pass would find them due only hours before expiry (or, with an earlier
 * trigger, reissue them on every run). Their expiry alerts stay.
 */
export const MIN_AUTO_REISSUE_LIFETIME_DAYS = 3;

/**
 * A linked internal leaf is due once two thirds of its lifetime have passed
 * (a third or less remains). A fixed "30 days left" rule would make a leaf
 * that lives 30 days or less due on the day it is issued.
 */
export function isInternalCertificateRenewalDue(notBefore: Date, notAfter: Date, now = new Date()): boolean {
  const remaining = notAfter.getTime() - now.getTime();
  const lifetime = notAfter.getTime() - notBefore.getTime();
  if (lifetime <= 0) return true;
  return remaining <= lifetime / 3;
}

/**
 * Near the CA's end a replacement is clamped to the CA. Reissuing is pointless
 * (and would repeat on every pass) unless the replacement outlives the leaf.
 */
export function reissueExtendsValidity(
  current: { notAfter: Date },
  ca: { notAfter: Date },
  validityDays: number,
  now = new Date()
): boolean {
  const projectedEnd = Math.min(now.getTime() + validityDays * DAY_MS, ca.notAfter.getTime());
  return projectedEnd > current.notAfter.getTime();
}

/** Recover O/OU/L/ST/C from a subject DN written by CertService.buildSubjectDn. */
export function subjectDnFieldsFromDn(subjectDn: string): IssueCertificateInput['subjectDnFields'] {
  const fields: NonNullable<IssueCertificateInput['subjectDnFields']> = {};
  const parts = subjectDn.split(/,\s*(?=(?:CN|O|OU|L|ST|C)=)/);
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!value) continue;
    if (key === 'O') fields.o = value;
    else if (key === 'OU') fields.ou = value;
    else if (key === 'L') fields.l = value;
    else if (key === 'ST') fields.st = value;
    else if (key === 'C' && value.length <= 2) fields.c = value;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/**
 * Keeps internal PKI leaves that serve proxy hosts valid: a leaf linked as an
 * SSL certificate (link_internal_cert) or referenced by a proxy host directly
 * is reissued from the same CA and template before it expires, while Gateway
 * holds its private key. CSR-issued leaves cannot be reissued here; they keep
 * the expiry alerts. The previous leaf is not revoked, because a copy of it
 * may still be in use outside Gateway; it simply expires.
 */
export class InternalCertificateRenewalService {
  private proxyService?: ProxyService;
  private readonly inFlight = new Map<string, Promise<InternalCertificateReissueResult>>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly certService: CertService,
    private readonly sslService: SSLService,
    private readonly certificateDistribution: NginxCertificateDistributionService,
    private readonly auditService: AuditService,
    private readonly alertService: AlertService
  ) {}

  setProxyService(service: ProxyService) {
    this.proxyService = service;
  }

  /** Scheduled pass: reissue every due leaf in TLS service. */
  async runDue(now = new Date()): Promise<InternalCertificateRenewalRunResult> {
    const linked = await this.db
      .select({ internalCertId: sslCertificates.internalCertId })
      .from(sslCertificates)
      .where(
        and(
          eq(sslCertificates.type, 'internal'),
          eq(sslCertificates.autoRenew, true),
          isNotNull(sslCertificates.internalCertId),
          inArray(sslCertificates.status, [...RENEWABLE_SSL_STATUSES])
        )
      );
    const direct = await this.db
      .select({ internalCertId: proxyHosts.internalCertificateId })
      .from(proxyHosts)
      .where(
        and(
          isNotNull(proxyHosts.internalCertificateId),
          isNull(proxyHosts.sslCertificateId),
          eq(proxyHosts.sslEnabled, true)
        )
      );
    const ids = [
      ...new Set(
        [...linked, ...direct].map((row) => row.internalCertId).filter((id): id is string => typeof id === 'string')
      ),
    ];
    const result: InternalCertificateRenewalRunResult = {
      checked: ids.length,
      renewed: 0,
      failed: 0,
      csrIssued: 0,
      notExtendable: 0,
      tooShortLived: 0,
    };
    if (ids.length === 0) return result;

    const sources = await this.db.select().from(certificates).where(inArray(certificates.id, ids));
    for (const source of sources) {
      if (source.status === 'revoked') continue;
      if (!isInternalCertificateRenewalDue(source.notBefore, source.notAfter, now)) continue;
      if (!source.encryptedPrivateKey || !source.encryptedDek) {
        // Expiry alerts cover CSR-issued leaves; Gateway cannot reissue them.
        result.csrIssued += 1;
        continue;
      }
      if (source.notAfter.getTime() - source.notBefore.getTime() < MIN_AUTO_REISSUE_LIFETIME_DAYS * DAY_MS) {
        result.tooShortLived += 1;
        await this.recordNotReissuable(
          source,
          `Automatic reissue is off for certificates that live less than ${MIN_AUTO_REISSUE_LIFETIME_DAYS} days; issue a longer-lived certificate and link it.`
        );
        continue;
      }
      try {
        const reissued = await this.reissue(source.id, SYSTEM_USER_ID, 'scheduled');
        result.renewed += 1;
        if (reissued.deliveryFailures.length > 0) await this.alertIncompleteDelivery(source, reissued);
      } catch (error) {
        if (error instanceof AppError && error.code === 'INTERNAL_CERT_NOT_EXTENDABLE') {
          // The CA expiry alerts cover this; the leaf's own expiry alerts
          // follow and quote this reason instead of promising a reissue.
          result.notExtendable += 1;
          await this.recordNotReissuable(source, `Automatic reissue is not possible: ${error.message}`);
          continue;
        }
        result.failed += 1;
        await this.recordFailure(source, error, now);
      }
    }
    logger.info('Internal certificate renewal pass completed', { ...result });
    return result;
  }

  /**
   * Internal PKI certificates put into service before their issuer chain was
   * served (linked SSL certificates and proxy hosts that reference a PKI leaf
   * directly) went out without their intermediate CAs. Deliver them again
   * with the chain. Returns how many certificates were repaired.
   */
  async repairMissingIssuerChains(): Promise<number> {
    let repaired = 0;
    const linked = await this.db
      .select({ id: sslCertificates.id })
      .from(sslCertificates)
      .where(
        and(
          eq(sslCertificates.type, 'internal'),
          isNotNull(sslCertificates.internalCertId),
          isNull(sslCertificates.chainPem)
        )
      );
    for (const row of linked) {
      try {
        if (await this.sslService.repairInternalIssuerChain(row.id)) repaired += 1;
      } catch (error) {
        logger.warn('Issuer chain could not be added to a linked internal certificate', {
          sslCertificateId: row.id,
          error: errorMessage(error),
        });
      }
    }

    const directHosts = await this.db
      .select({ id: proxyHosts.id, internalCertId: proxyHosts.internalCertificateId })
      .from(proxyHosts)
      .where(
        and(
          isNotNull(proxyHosts.internalCertificateId),
          isNull(proxyHosts.sslCertificateId),
          eq(proxyHosts.enabled, true),
          eq(proxyHosts.sslEnabled, true)
        )
      );
    const hostsByCertificate = new Map<string, string[]>();
    for (const host of directHosts) {
      if (!host.internalCertId) continue;
      hostsByCertificate.set(host.internalCertId, [...(hostsByCertificate.get(host.internalCertId) ?? []), host.id]);
    }
    for (const [certificateId, hostIds] of hostsByCertificate) {
      try {
        const refreshed = await this.certificateDistribution.refreshMissingIssuerChain({
          type: 'internal',
          id: certificateId,
        });
        if (!refreshed) continue;
        repaired += 1;
        for (const hostId of hostIds) {
          await this.proxyService?.resyncTlsHost(hostId, SYSTEM_USER_ID).catch((error: unknown) =>
            logger.warn('Proxy host did not receive the internal certificate issuer chain', {
              certificateId,
              hostId,
              error: errorMessage(error),
            })
          );
        }
      } catch (error) {
        logger.warn('Issuer chain could not be added to an internal certificate', {
          certificateId,
          error: errorMessage(error),
        });
      }
    }
    if (repaired > 0) logger.info('Issuer chains added to internal certificates in service', { repaired });
    return repaired;
  }

  /** Manual renew of a linked `internal` SSL certificate (REST, MCP and AI renew). */
  async renewSslCertificate(sslCertificateId: string, userId: string, options?: { actorScopes?: string[] }) {
    const [row] = await this.db
      .select({ id: sslCertificates.id, type: sslCertificates.type, internalCertId: sslCertificates.internalCertId })
      .from(sslCertificates)
      .where(eq(sslCertificates.id, sslCertificateId))
      .limit(1);
    if (!row) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');
    if (row.type !== 'internal' || !row.internalCertId) {
      throw new AppError(400, 'NOT_INTERNAL', 'Only linked internal certificates can be reissued from their CA');
    }
    const [source] = await this.db
      .select({ caId: certificates.caId })
      .from(certificates)
      .where(eq(certificates.id, row.internalCertId))
      .limit(1);
    if (!source) throw new AppError(404, 'PKI_CERT_NOT_FOUND', 'Linked internal PKI certificate not found');
    // Reissuing signs a new leaf on the CA, so an interactive caller needs the
    // same right as issuing on that CA directly.
    if (options?.actorScopes && !hasScopeForResource(options.actorScopes, PKI_ISSUE_SCOPE, source.caId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${PKI_ISSUE_SCOPE}:${source.caId}`);
    }
    return this.reissue(row.internalCertId, userId, 'manual', { sslCertificateId: row.id });
  }

  /**
   * Issue the replacement leaf and move the SSL certificates that keep
   * automatic reissue on (plus the one renewed by hand) and every proxy host
   * that references the old leaf directly onto it. An SSL certificate whose
   * automatic reissue was turned off keeps the old leaf. Concurrent requests
   * for the same leaf share one issuance.
   */
  reissue(
    certificateId: string,
    userId: string,
    trigger: 'scheduled' | 'manual',
    options: { sslCertificateId?: string } = {}
  ): Promise<InternalCertificateReissueResult> {
    const running = this.inFlight.get(certificateId);
    if (running) return running;
    const task = this.reissueOnce(certificateId, userId, trigger, options).finally(() =>
      this.inFlight.delete(certificateId)
    );
    this.inFlight.set(certificateId, task);
    return task;
  }

  private async reissueOnce(
    certificateId: string,
    userId: string,
    trigger: 'scheduled' | 'manual',
    options: { sslCertificateId?: string }
  ): Promise<InternalCertificateReissueResult> {
    const [source] = await this.db.select().from(certificates).where(eq(certificates.id, certificateId)).limit(1);
    if (!source) throw new AppError(404, 'PKI_CERT_NOT_FOUND', 'Internal PKI certificate not found');
    if (!source.encryptedPrivateKey || !source.encryptedDek) {
      throw new AppError(
        400,
        'INTERNAL_CERT_NOT_RENEWABLE',
        'This certificate was issued from a CSR, so Opfield does not hold its private key. Issue a new certificate from a CSR and link it.'
      );
    }
    if (source.type !== 'tls-server') {
      throw new AppError(400, 'PKI_CERT_NOT_SERVER', 'Only TLS server certificates can be reissued for proxy hosts');
    }
    const [ca] = await this.db
      .select({
        id: certificateAuthorities.id,
        status: certificateAuthorities.status,
        isSystem: certificateAuthorities.isSystem,
        maxValidityDays: certificateAuthorities.maxValidityDays,
        commonName: certificateAuthorities.commonName,
        notAfter: certificateAuthorities.notAfter,
      })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.id, source.caId))
      .limit(1);
    if (!ca || ca.isSystem) {
      throw new AppError(409, 'INTERNAL_CERT_CA_UNAVAILABLE', 'The issuing CA of this certificate is unavailable');
    }
    if (ca.status !== 'active') {
      throw new AppError(
        409,
        'INTERNAL_CERT_CA_NOT_ACTIVE',
        `The issuing CA "${ca.commonName}" is ${ca.status}; issue a certificate from another CA and link it`
      );
    }

    const lifetimeDays = Math.max(1, Math.round((source.notAfter.getTime() - source.notBefore.getTime()) / DAY_MS));
    const validityDays = Math.min(lifetimeDays, ca.maxValidityDays, 3650);
    if (!reissueExtendsValidity(source, ca, validityDays)) {
      throw new AppError(
        409,
        'INTERNAL_CERT_NOT_EXTENDABLE',
        `The issuing CA "${ca.commonName}" expires on ${ca.notAfter.toISOString()}, so a reissued certificate would not outlive the current one. Replace the CA, then issue and link a new certificate.`
      );
    }
    const templateId = source.templateId ? await this.existingTemplateId(source.templateId) : undefined;
    const issued = await this.certService.issueCertificate(
      {
        caId: source.caId,
        templateId,
        type: source.type,
        commonName: source.commonName,
        sans: source.sans ?? [],
        keyAlgorithm: source.keyAlgorithm,
        validityDays,
        subjectDnFields: subjectDnFieldsFromDn(source.subjectDn),
      },
      userId,
      // Near the CA's end the replacement ends with the CA instead of failing.
      { clampToCaValidity: true }
    );
    const replacement = issued.certificate;
    const deliveryFailures: InternalCertificateReissueResult['deliveryFailures'] = [];

    const sslRows = await this.db
      .select({ id: sslCertificates.id })
      .from(sslCertificates)
      .where(
        and(
          eq(sslCertificates.type, 'internal'),
          eq(sslCertificates.internalCertId, source.id),
          options.sslCertificateId
            ? or(eq(sslCertificates.autoRenew, true), eq(sslCertificates.id, options.sslCertificateId))
            : eq(sslCertificates.autoRenew, true)
        )
      );
    for (const row of sslRows) {
      try {
        const applied = await this.sslService.applyReissuedInternalCertificate(
          row.id,
          {
            internalCertId: replacement.id,
            certificatePem: replacement.certificatePem,
            privateKeyPem: issued.privateKeyPem,
            notBefore: replacement.notBefore,
            notAfter: replacement.notAfter,
          },
          userId,
          trigger
        );
        for (const failure of applied.failures) {
          deliveryFailures.push({ target: `proxy host ${failure.hostId}`, error: failure.error });
        }
      } catch (error) {
        deliveryFailures.push({ target: `SSL certificate ${row.id}`, error: errorMessage(error) });
      }
    }

    const movedHosts = await this.db
      .update(proxyHosts)
      .set({ internalCertificateId: replacement.id, updatedAt: new Date() })
      .where(eq(proxyHosts.internalCertificateId, source.id))
      .returning({
        id: proxyHosts.id,
        enabled: proxyHosts.enabled,
        sslEnabled: proxyHosts.sslEnabled,
        sslCertificateId: proxyHosts.sslCertificateId,
      });
    const directHosts = movedHosts.filter((host) => host.enabled && host.sslEnabled && !host.sslCertificateId);
    if (directHosts.length > 0) {
      try {
        await this.certificateDistribution.upsertOpfieldAsset({ type: 'internal', id: replacement.id });
        for (const host of directHosts) {
          if (!this.proxyService) {
            deliveryFailures.push({ target: `proxy host ${host.id}`, error: 'Proxy service unavailable' });
            continue;
          }
          try {
            await this.proxyService.resyncTlsHost(host.id, userId);
          } catch (error) {
            deliveryFailures.push({ target: `proxy host ${host.id}`, error: errorMessage(error) });
          }
        }
      } catch (error) {
        for (const host of directHosts) {
          deliveryFailures.push({ target: `proxy host ${host.id}`, error: errorMessage(error) });
        }
      }
    }

    await this.auditService.log({
      userId,
      action: 'cert.reissue',
      resourceType: 'certificate',
      resourceId: source.id,
      details: {
        trigger,
        caId: source.caId,
        cn: source.commonName,
        replacementCertificateId: replacement.id,
        notAfter: replacement.notAfter.toISOString(),
        sslCertificateIds: sslRows.map((row) => row.id),
        proxyHostIds: movedHosts.map((host) => host.id),
        deliveryFailures: deliveryFailures.length,
      },
    });
    logger.info('Internal certificate reissued', {
      previousCertificateId: source.id,
      certificateId: replacement.id,
      trigger,
      sslCertificates: sslRows.length,
      proxyHosts: movedHosts.length,
      deliveryFailures: deliveryFailures.length,
    });

    return {
      previousCertificateId: source.id,
      certificateId: replacement.id,
      notAfter: replacement.notAfter,
      sslCertificateIds: sslRows.map((row) => row.id),
      proxyHostIds: movedHosts.map((host) => host.id),
      deliveryFailures,
    };
  }

  private async existingTemplateId(templateId: string): Promise<string | undefined> {
    const [template] = await this.db
      .select({ id: certificateTemplates.id })
      .from(certificateTemplates)
      .where(eq(certificateTemplates.id, templateId))
      .limit(1);
    return template?.id;
  }

  /** Record why a due leaf is not reissued, so its expiry alert says so. */
  private async recordNotReissuable(source: SourceCertificate, reason: string): Promise<void> {
    await this.db
      .update(sslCertificates)
      .set({ renewalError: reason, updatedAt: new Date() })
      .where(
        and(
          eq(sslCertificates.type, 'internal'),
          eq(sslCertificates.internalCertId, source.id),
          eq(sslCertificates.autoRenew, true),
          sql`${sslCertificates.renewalError} IS DISTINCT FROM ${reason}`
        )
      );
  }

  private async recordFailure(source: SourceCertificate, error: unknown, now: Date): Promise<void> {
    const message = errorMessage(error);
    logger.error('Internal certificate reissue failed', { certificateId: source.id, error: message });
    const sslRows = await this.db
      .update(sslCertificates)
      .set({
        renewalError: `Reissue failed: ${message}`,
        lastRenewalAttemptAt: now,
        renewalFailureCount: sql`${sslCertificates.renewalFailureCount} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(sslCertificates.type, 'internal'),
          eq(sslCertificates.internalCertId, source.id),
          eq(sslCertificates.autoRenew, true)
        )
      )
      .returning({ id: sslCertificates.id, name: sslCertificates.name });

    const daysLeft = Math.ceil((source.notAfter.getTime() - now.getTime()) / DAY_MS);
    const type = daysLeft <= 7 ? ('expiry_critical' as const) : ('expiry_warning' as const);
    const targets =
      sslRows.length > 0
        ? sslRows.map((row) => ({ resourceType: 'ssl_certificate', id: row.id, name: row.name }))
        : [{ resourceType: 'certificate', id: source.id, name: source.commonName }];
    for (const target of targets) {
      if (await this.recentAlertExists(type, target.resourceType, target.id, now)) continue;
      await this.alertService.createAlert({
        type,
        resourceType: target.resourceType,
        resourceId: target.id,
        message: `Automatic reissue of internal certificate "${target.name}" failed (expires in ${daysLeft} day(s) on ${source.notAfter.toISOString()}): ${message}`,
      });
    }
  }

  private async alertIncompleteDelivery(source: SourceCertificate, result: InternalCertificateReissueResult) {
    const first = result.deliveryFailures[0]!;
    await this.alertService.createAlert({
      type: 'expiry_warning',
      resourceType: 'certificate',
      resourceId: result.certificateId,
      message: `Internal certificate "${source.commonName}" was reissued, but ${result.deliveryFailures.length} target(s) did not receive it (${first.target}: ${first.error.replace(SSL_DISTRIBUTION_ERROR_PREFIX, '')}). Retry the TLS distribution before ${source.notAfter.toISOString()}.`,
    });
  }

  private async recentAlertExists(type: string, resourceType: string, resourceId: string, now: Date) {
    const [existing] = await this.db
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(
          eq(alerts.type, type as typeof alerts.$inferSelect.type),
          eq(alerts.resourceType, resourceType),
          eq(alerts.resourceId, resourceId),
          eq(alerts.dismissed, false),
          gte(alerts.createdAt, new Date(now.getTime() - FAILURE_ALERT_REPEAT_MS))
        )
      )
      .limit(1);
    return !!existing;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
