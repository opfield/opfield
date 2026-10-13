import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { relayInstances } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from './event-bus.service.js';
import type { NodeDispatchService } from './node-dispatch.service.js';
import type { RelayPolicyService } from './relay-policy.service.js';
import type { SystemCAService } from './system-ca.service.js';
import type { SystemCertificateLifecycleService } from './system-certificate-lifecycle.service.js';

const logger = createChildLogger('RelayCertificateRenewal');
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Relay server certificates live 365 days; renewal starts this long before they expire. */
export const RELAY_CERTIFICATE_RENEW_BEFORE_MS = 60 * DAY_MS;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
/** Relay server certificates are issued for this long. */
const CERTIFICATE_LIFETIME_MS = 365 * DAY_MS;
/**
 * A relay keeps serving one previous certificate. Renewing again before daemons received grant
 * bundles naming the last renewal would drop the certificate some of them still pin.
 */
const MIN_RENEWAL_INTERVAL_MS = DAY_MS;
/** Advertised by relay workers that keep serving the previous certificate during a renewal. */
export const SERVER_CERTIFICATE_ROLLOVER_CAPABILITY = 'server_certificate_rollover_v1';
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

type RelayInstanceRow = typeof relayInstances.$inferSelect;

export type RelayCertificateState = 'expiring' | 'expired' | 'renewal_failed';

/** Why a relay's certificate needs attention and what repairs it, for health surfaces. */
export interface RelayCertificateStatus {
  state: RelayCertificateState;
  message: string;
  expiresAt: string | null;
  observedAt: string;
}

function certificateFingerprint(certificatePem: string): string {
  return `sha256:${createHash('sha256').update(new X509Certificate(certificatePem).raw).digest('hex')}`;
}

function commonName(certificatePem: string): string {
  const match = new X509Certificate(certificatePem).subject.match(/(?:^|\n)CN=([^\n]+)/);
  if (!match?.[1]) throw new Error('Renewed relay certificate has no common name');
  return match[1];
}

function normalizeSan(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.slice(1, -1).includes(':')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function isUnsupportedCommand(message: string): boolean {
  return /unsupported command/i.test(message);
}

/**
 * Renews the data-plane server certificate of remote relays well before it expires.
 *
 * Daemons pin a relay's exact certificate and ask for it by its identity (TLS server name),
 * so a renewal cannot simply replace it. Opfield stages a certificate with a new identity and
 * sends it over the supervisor's authenticated control stream. The supervisor installs it next
 * to the one daemons pin, has its worker reload without dropping tunnels, and confirms the
 * worker serves it. Only then is the staged leaf promoted and the relay's published identity
 * switched, after which daemons receive grant bundles that name it. The worker keeps serving
 * the previous certificate by its old identity until the next renewal, so a daemon with an
 * older bundle is never cut off. The worker's admin client is the supervisor's own node
 * certificate, which the daemon lifecycle renews; the supervisor moves the worker onto it.
 */
export class RelayCertificateRenewalService {
  private readonly failures = new Map<string, { at: number; message: string }>();
  private inFlight: Promise<number> | null = null;
  private nextCheckAt = 0;

  constructor(
    private readonly db: DrizzleClient,
    private readonly lifecycle: Pick<SystemCertificateLifecycleService, 'issuePending' | 'promotePending'>,
    private readonly systemCA: Pick<SystemCAService, 'getSystemCAId'>,
    private readonly dispatch: Pick<NodeDispatchService, 'renewRelayIdentity' | 'isNodeConnected'>,
    private readonly policy: Pick<RelayPolicyService, 'refreshAllNodeGrantsIfDue'>,
    private readonly audit: Pick<AuditService, 'log'>,
    private readonly events?: Pick<EventBusService, 'publish'>
  ) {}

  /** Checks at most hourly; runs in the background of the pool reconciler. */
  renewDueIfScheduled(now = Date.now()): Promise<number> {
    if (this.inFlight || now < this.nextCheckAt) return Promise.resolve(0);
    this.nextCheckAt = now + CHECK_INTERVAL_MS;
    const flight = this.renewDue(new Date(now)).finally(() => {
      if (this.inFlight === flight) this.inFlight = null;
    });
    this.inFlight = flight;
    return flight;
  }

  /** Renews every connected remote relay whose certificate is due, one at a time. */
  async renewDue(now = new Date()): Promise<number> {
    const due = await this.db
      .select()
      .from(relayInstances)
      .where(
        and(
          eq(relayInstances.kind, 'remote'),
          isNotNull(relayInstances.nodeId),
          isNotNull(relayInstances.certificateExpiresAt),
          lte(relayInstances.certificateExpiresAt, new Date(now.getTime() + RELAY_CERTIFICATE_RENEW_BEFORE_MS))
        )
      );
    let renewed = 0;
    for (const instance of due) {
      const failure = this.failures.get(instance.id);
      if (failure && now.getTime() - failure.at < RETRY_AFTER_FAILURE_MS) continue;
      // The control stream is the authenticated channel; an offline relay waits for it.
      if (!this.dispatch.isNodeConnected(instance.nodeId)) continue;
      try {
        await this.renew(instance, null, { refreshGrants: false });
        renewed += 1;
      } catch (error) {
        logger.warn('Relay certificate renewal failed; it is retried later', {
          instanceId: instance.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // One grant refresh for the whole pass: every refresh makes daemons re-register.
    if (renewed > 0) await this.refreshGrants();
    return renewed;
  }

  private async refreshGrants(): Promise<void> {
    // Daemons pin the relay certificate from their grant bundles; hand them the renewed one.
    await this.policy.refreshAllNodeGrantsIfDue(true).catch((error) =>
      logger.warn('Relay certificate renewed; daemon grant bundles follow on the next refresh', {
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }

  /** Renews one remote relay's certificate now, for an operator or an automation tool. */
  async renewInstanceCertificate(instanceId: string, userId: string | null) {
    const [instance] = await this.db.select().from(relayInstances).where(eq(relayInstances.id, instanceId)).limit(1);
    if (!instance) throw new AppError(404, 'RELAY_INSTANCE_NOT_FOUND', 'Relay instance not found');
    if (instance.kind !== 'remote' || !instance.nodeId) {
      throw new AppError(
        409,
        'RELAY_CERTIFICATE_RENEWAL_UNSUPPORTED',
        'Only an enrolled remote relay has a renewable certificate'
      );
    }
    if (!this.dispatch.isNodeConnected(instance.nodeId)) {
      throw new AppError(
        409,
        'RELAY_NOT_CONNECTED',
        'The relay supervisor is not connected. If it cannot reconnect because its certificates expired, re-enroll the relay.'
      );
    }
    return this.renew(instance, userId);
  }

  private async renew(
    instance: RelayInstanceRow,
    userId: string | null,
    options: { refreshGrants: boolean } = { refreshGrants: true }
  ) {
    const nodeId = instance.nodeId!;
    // An older worker serves only its newest certificate: daemons that still pin the previous
    // one would be cut off until their next bundle. Such a relay is updated, not renewed.
    if (!instance.capabilities?.features?.includes(SERVER_CERTIFICATE_ROLLOVER_CAPABILITY)) {
      const message =
        'The relay worker is too old to renew its certificate without cutting off daemons. Update the Relay Pool, or re-enroll this relay.';
      this.failures.set(instance.id, { at: Date.now(), message });
      throw new AppError(409, 'RELAY_CERTIFICATE_ROLLOVER_UNSUPPORTED', message);
    }
    if (
      instance.certificateExpiresAt &&
      Date.now() - (instance.certificateExpiresAt.getTime() - CERTIFICATE_LIFETIME_MS) < MIN_RENEWAL_INTERVAL_MS
    ) {
      throw new AppError(
        409,
        'RELAY_CERTIFICATE_RECENTLY_RENEWED',
        'This relay certificate was renewed less than a day ago; daemons may still pin the previous one.'
      );
    }
    const owner = { type: 'relay_node_server', id: instance.id } as const;
    const identity = `relay-${instance.id}-${randomBytes(4).toString('hex')}`;
    const sans = [...new Set([identity, ...instance.advertisedAddresses].map(normalizeSan).filter(Boolean))];
    try {
      // A staged leaf is reused while it has most of its validity left, so a retry after a
      // lost response hands the relay the same certificate again.
      const issued = await this.lifecycle.issuePending(
        {
          caId: await this.systemCA.getSystemCAId(),
          type: 'tls-server',
          commonName: identity,
          sans,
          keyAlgorithm: 'ecdsa-p256',
          validityDays: 365,
        },
        SYSTEM_USER_ID,
        owner
      );
      const certificatePem = issued.certificate.certificatePem;
      const serverIdentity = commonName(certificatePem);
      const fingerprint = certificateFingerprint(certificatePem);
      const result = await this.dispatch.renewRelayIdentity(nodeId, {
        serverCertificate: Buffer.from(certificatePem),
        serverKey: Buffer.from(issued.privateKeyPem),
        serverIdentity,
        retainServerFingerprint: instance.certificateFingerprint ?? '',
      });
      if (!result.success) {
        const reason = result.error || result.detail || 'the relay supervisor refused the renewed certificate';
        throw new Error(
          isUnsupportedCommand(reason)
            ? 'The relay supervisor is too old to renew its certificate. Update the Relay Pool, or re-enroll this relay.'
            : reason
        );
      }
      let expiresAt: Date | null = null;
      await this.lifecycle.promotePending(owner, issued.certificate.serialNumber, async (tx, promoted) => {
        if (!promoted) throw new Error('The staged relay certificate was replaced before it could be promoted');
        expiresAt = promoted.notAfter;
        await tx
          .update(relayInstances)
          .set({
            certificateIdentity: serverIdentity,
            certificateFingerprint: fingerprint,
            certificateExpiresAt: promoted.notAfter,
            updatedAt: new Date(),
          })
          .where(eq(relayInstances.id, instance.id));
      });
      this.failures.delete(instance.id);
      logger.info('Renewed relay server certificate', { instanceId: instance.id, serverIdentity, expiresAt });
      await this.audit
        .log({
          userId,
          action: 'relay.instance.certificate.renew',
          resourceType: 'relay_instance',
          resourceId: instance.id,
          details: {
            serverIdentity,
            fingerprint,
            previousFingerprint: instance.certificateFingerprint,
            expiresAt: expiresAt ? (expiresAt as Date).toISOString() : null,
          },
        })
        .catch(() => undefined);
      if (options.refreshGrants) await this.refreshGrants();
      this.events?.publish('system.relay.health.changed', { poolId: instance.poolId, instanceId: instance.id });
      return { instanceId: instance.id, serverIdentity, fingerprint, expiresAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failures.set(instance.id, { at: Date.now(), message });
      this.events?.publish('system.relay.health.changed', { poolId: instance.poolId, instanceId: instance.id });
      throw error;
    }
  }

  /** Certificate status per relay for health surfaces; relays without a problem are absent. */
  describeCertificates(
    instances: Array<Pick<RelayInstanceRow, 'id' | 'kind' | 'certificateExpiresAt'>>,
    now = new Date()
  ): Map<string, RelayCertificateStatus> {
    const result = new Map<string, RelayCertificateStatus>();
    const observedAt = now.toISOString();
    for (const instance of instances) {
      if (instance.kind !== 'remote' || !instance.certificateExpiresAt) continue;
      const expiresAt = instance.certificateExpiresAt;
      const failure = this.failures.get(instance.id);
      const on = expiresAt.toISOString().slice(0, 10);
      if (expiresAt.getTime() <= now.getTime()) {
        result.set(instance.id, {
          state: 'expired',
          message:
            `The relay certificate expired on ${on}, so daemons and Opfield cannot connect to this relay. ` +
            'Opfield renews it automatically while the relay supervisor is connected' +
            (failure ? ` (last attempt failed: ${failure.message})` : '') +
            '. If the supervisor cannot reconnect, re-enroll the relay.',
          expiresAt: expiresAt.toISOString(),
          observedAt,
        });
      } else if (expiresAt.getTime() - now.getTime() <= RELAY_CERTIFICATE_RENEW_BEFORE_MS) {
        result.set(instance.id, {
          state: failure ? 'renewal_failed' : 'expiring',
          message: failure
            ? `Certificate renewal failed: ${failure.message} The certificate expires on ${on}; Opfield retries hourly.`
            : `The relay certificate expires on ${on}. Opfield renews it while the relay supervisor is connected.`,
          expiresAt: expiresAt.toISOString(),
          observedAt,
        });
      }
    }
    return result;
  }
}
