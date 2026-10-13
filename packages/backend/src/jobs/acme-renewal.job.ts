import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { sslCertificates } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AlertService } from '@/modules/audit/alert.service.js';
import { SSL_DISTRIBUTION_ERROR_PREFIX, type SSLService } from '@/modules/ssl/ssl.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';

const logger = createChildLogger('ACMERenewalJob');

const RENEWAL_WINDOW_DAYS = 30;
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const SKIPPED_RENEWAL_CODES: ReadonlySet<string> = new Set([
  'ACME_OPERATION_IN_PROGRESS',
  'ACME_ORDER_SUPERSEDED',
  'SSL_CERT_DELETED',
]);

export class ACMERenewalJob {
  private eventBus?: EventBusService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly sslService: SSLService,
    private readonly alertService: AlertService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  async run(): Promise<void> {
    logger.info('Starting ACME certificate renewal check');

    const threshold = new Date();
    threshold.setDate(threshold.getDate() + RENEWAL_WINDOW_DAYS);

    // Query certificates that are eligible for auto-renewal
    const certsToRenew = await this.db.query.sslCertificates.findMany({
      where: and(
        eq(sslCertificates.autoRenew, true),
        eq(sslCertificates.type, 'acme'),
        // A failed renewal keeps a still-valid certificate `active`; rows left in
        // `error` by v2.9.x or earlier, and expired ones, are retried as well.
        inArray(sslCertificates.status, ['active', 'error', 'expired']),
        or(isNull(sslCertificates.acmePendingOperation), eq(sslCertificates.acmePendingOperation, 'renewal')),
        lte(sslCertificates.notAfter, threshold)
      ),
      columns: {
        privateKeyPem: false,
        encryptedDek: false,
        dekIv: false,
        acmeAccountKey: false,
      },
    });

    if (certsToRenew.length === 0) {
      logger.info('No certificates need renewal');
      return;
    }

    logger.info(`Found ${certsToRenew.length} certificate(s) eligible for renewal`);

    let renewed = 0;
    let failed = 0;
    let manualRequired = 0;
    let busy = 0;

    for (const cert of certsToRenew) {
      try {
        if (cert.acmePendingOperation === 'renewal') {
          if (cert.acmeChallengeType === 'dns-01' && hasCloudflareChallenges(cert.acmePendingChallenges)) {
            const result = await this.sslService.completeDNS01Verification(cert.id, SYSTEM_USER_ID, {
              cleanupCloudflare: true,
              clearPendingOnFailure: true,
            });
            renewed++;
            logger.info(`Completed pending DNS-01 renewal: ${cert.name}`, {
              certId: cert.id,
              domains: cert.domainNames,
            });
            await this.alertOnIncompleteDelivery(cert, result);
          } else {
            await this.alertService.createAlert({
              type: 'expiry_warning',
              resourceType: 'ssl_certificate',
              resourceId: cert.id,
              message: `Certificate "${cert.name}" (DNS-01) is expiring on ${cert.notAfter?.toISOString()} and requires manual DNS verification.`,
            });
            manualRequired++;
            logger.warn(`DNS-01 certificate has pending manual verification: ${cert.name}`, { certId: cert.id });
          }
          continue;
        }

        if (cert.acmeChallengeType === 'http-01') {
          // Automatic renewal via HTTP-01 challenge
          const result = await this.sslService.renewCert(cert.id, SYSTEM_USER_ID);
          renewed++;
          logger.info(`Renewed certificate: ${cert.name}`, { certId: cert.id, domains: cert.domainNames });
          await this.alertOnIncompleteDelivery(cert, result);
        } else if (cert.acmeChallengeType === 'dns-01') {
          if (cert.autoRenewProvider !== 'cloudflare') {
            await this.alertService.createAlert({
              type: 'expiry_warning',
              resourceType: 'ssl_certificate',
              resourceId: cert.id,
              message: `Certificate "${cert.name}" (DNS-01) is expiring on ${cert.notAfter?.toISOString()} and requires Cloudflare auto-renewal to be enabled or manual DNS verification.`,
            });
            manualRequired++;
            logger.warn(`DNS-01 certificate is not configured for Cloudflare auto-renewal: ${cert.name}`, {
              certId: cert.id,
            });
            continue;
          }
          const result = await this.sslService.renewCert(cert.id, SYSTEM_USER_ID);
          if (result.status === 'active') {
            renewed++;
            logger.info(`Renewed DNS-01 certificate: ${cert.name}`, { certId: cert.id, domains: cert.domainNames });
            await this.alertOnIncompleteDelivery(cert, result);
          } else {
            await this.alertService.createAlert({
              type: 'expiry_warning',
              resourceType: 'ssl_certificate',
              resourceId: cert.id,
              message: `Certificate "${cert.name}" (DNS-01) is expiring on ${cert.notAfter?.toISOString()} and requires manual DNS verification.`,
            });
            manualRequired++;
            logger.warn(`DNS-01 certificate requires manual verification: ${cert.name}`, { certId: cert.id });
          }
        }
      } catch (error) {
        // Another operation owns the certificate: a renewal or verify started
        // by hand is still running, replaced the order, or the certificate was
        // deleted. None of these is a failed renewal; the next pass looks again.
        if (error instanceof AppError && SKIPPED_RENEWAL_CODES.has(error.code)) {
          busy++;
          logger.info(`Skipping certificate owned by another ACME operation: ${cert.name}`, {
            certId: cert.id,
            code: error.code,
          });
          continue;
        }
        failed++;
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`Failed to renew certificate: ${cert.name}`, { certId: cert.id, error: message });

        // Create an alert for the failure
        await this.alertService.createAlert({
          type: 'expiry_critical',
          resourceType: 'ssl_certificate',
          resourceId: cert.id,
          message: `Auto-renewal failed for certificate "${cert.name}": ${message}`,
        });
        this.eventBus?.publish('ssl.cert.changed', { id: cert.id, action: 'renewal_failed', name: cert.name });
      }
    }

    logger.info('ACME renewal job completed', { renewed, failed, manualRequired, busy, total: certsToRenew.length });
  }

  /** A renewed certificate that did not reach every proxy host still expires there. */
  private async alertOnIncompleteDelivery(
    cert: { id: string; name: string },
    result: { renewalError?: string | null } | unknown
  ): Promise<void> {
    const renewalError = (result as { renewalError?: string | null } | null)?.renewalError;
    if (!renewalError?.startsWith(SSL_DISTRIBUTION_ERROR_PREFIX)) return;
    await this.alertService.createAlert({
      type: 'expiry_warning',
      resourceType: 'ssl_certificate',
      resourceId: cert.id,
      message: `Certificate "${cert.name}" was renewed, but not every route received it: ${renewalError.slice(SSL_DISTRIBUTION_ERROR_PREFIX.length)}`,
    });
  }
}

function hasCloudflareChallenges(challenges: unknown): boolean {
  return Array.isArray(challenges) && challenges.some((challenge) => Boolean(challenge?.cloudflare));
}
