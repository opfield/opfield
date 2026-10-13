import { and, eq, gt, gte, inArray, isNotNull, lt, lte, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  alerts,
  certificateAuthorities,
  certificates,
  expiryAlertMarkers,
  gitLabUserCredentials,
  integrationConnectors,
  managedDatabaseInstances,
  managedStorageClusters,
  nodes,
  relayInstances,
  sslCertificates,
  users,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { compareSemver, parseSemver } from '@/lib/semver.js';
import type { AlertService } from '@/modules/audit/alert.service.js';
import { getEnvironmentSettingsSnapshot } from '@/modules/settings/environment-settings.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';

const logger = createChildLogger('ExpiryAlertJob');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Redistributing a CA takes time, so CAs warn long before leaves do (plus the 30/7-day defaults). */
export const USER_CA_ALERT_DAYS = [180, 60] as const;
/**
 * System CAs (node mTLS, storage TLS, database TLS) last 10 years and have no
 * automatic rollover yet; their leaves are clamped to the CA's lifetime, so
 * the operator must be told years ahead.
 */
export const SYSTEM_CA_ALERT_DAYS = [730, 365, 180, 60] as const;
/** Node mTLS client certificates renew themselves at a third of their lifetime; 30 days left means renewal is stuck. */
export const NODE_CERT_ALERT_DAYS = { warning: 30, critical: 7 } as const;
/** First daemon release that renews its client certificate at a third of its lifetime. */
export const NODE_EARLY_RENEWAL_DAEMON_VERSION = '2.11.0-rc.9';
/** Older daemons renew only in the last 7 days; alert only once that renewal is overdue. */
export const LEGACY_NODE_CERT_ALERT_DAYS = 3;
/**
 * Resources that expired longer ago than this are no longer reported, and
 * their markers are pruned at the same boundary. Both use this one window, so
 * a long-expired certificate, CA or token left in the database never alerts
 * again once its marker is gone.
 */
export const EXPIRED_REPORT_WINDOW_MS = 365 * DAY_MS;
/** Git integration tokens (GitLab PATs, project/group tokens, OAuth refresh tokens). */
export const GIT_TOKEN_ALERT_DAYS = { warning: 30, critical: 7 } as const;

type AlertType = 'expiry_warning' | 'expiry_critical' | 'ca_expiry';

type SystemOwnerType =
  | 'node'
  | 'managed_database'
  | 'managed_storage'
  | 'opfield_listener'
  | 'opfield_service'
  | 'relay_node_server';

const SYSTEM_CA_PURPOSE_LABELS: Record<string, string> = {
  'node-mtls': 'node and relay mTLS',
  'storage-tls': 'managed storage TLS',
  'database-tls': 'managed database TLS',
};

/**
 * The tightest alert threshold (in days) a resource expiring at `notAfter`
 * has crossed, or null when it is outside every threshold.
 */
export function crossedThreshold(notAfter: Date, thresholds: readonly number[], now: Date): number | null {
  const remainingDays = (notAfter.getTime() - now.getTime()) / DAY_MS;
  let crossed: number | null = null;
  for (const threshold of thresholds) {
    if (remainingDays <= threshold && (crossed === null || threshold < crossed)) crossed = threshold;
  }
  return crossed;
}

function reportWindowStart(now: Date): Date {
  return new Date(now.getTime() - EXPIRED_REPORT_WINDOW_MS);
}

function daysLeft(notAfter: Date, now: Date): number {
  return Math.ceil((notAfter.getTime() - now.getTime()) / DAY_MS);
}

function expiresPhrase(notAfter: Date, now: Date): string {
  const days = daysLeft(notAfter, now);
  return days <= 0 ? `expired on ${notAfter.toISOString()}` : `expires in ${days} day(s) on ${notAfter.toISOString()}`;
}

/** Outcome of the Git token maintenance that runs before the token alerts. */
export interface GitTokenMaintenanceOutcome {
  /** `resourceType:id` of tokens that rotate themselves before they expire; they are not alerted. */
  autoRotating?: string[];
  alerts?: Array<{
    severity: 'warning' | 'critical';
    resourceType: string;
    resourceId: string;
    reason: string;
    expiresAt: Date;
    message: string;
  }>;
}

/** An optional maintenance step that rotates expiring Git tokens before they are alerted on. */
export type GitTokenMaintenance = () => Promise<GitTokenMaintenanceOutcome | undefined>;

/** A node daemon older than rc.9 renews its certificate only in the last 7 days. */
export function isLegacyRenewalDaemon(version: string | null | undefined): boolean {
  if (!version || !parseSemver(version)) return false;
  return compareSemver(version, NODE_EARLY_RENEWAL_DAEMON_VERSION) < 0;
}

export class ExpiryAlertJob {
  private eventBus?: EventBusService;
  private gitTokenMaintenance?: GitTokenMaintenance;

  constructor(
    private readonly db: DrizzleClient,
    private readonly alertService: AlertService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  setGitTokenMaintenance(maintenance: GitTokenMaintenance) {
    this.gitTokenMaintenance = maintenance;
  }

  async run(now = new Date()): Promise<void> {
    logger.info('Starting expiry alert check');

    const { expiryWarningDays, expiryCriticalDays } = getEnvironmentSettingsSnapshot().pkiDefaults;
    const leafThresholds = [expiryWarningDays, expiryCriticalDays];
    const counts: Record<string, number> = {};
    let alertsCreated = 0;

    const section = async (name: string, check: () => Promise<{ checked: number; created: number }>) => {
      try {
        const result = await check();
        counts[name] = result.checked;
        alertsCreated += result.created;
      } catch (error) {
        // One broken source must not hide the others.
        logger.error(`Expiry alert check failed for ${name}`, { error });
      }
    };

    await this.pruneMarkers(now);

    let autoRotating = new Set<string>();
    if (this.gitTokenMaintenance) {
      try {
        const outcome = (await this.gitTokenMaintenance()) ?? {};
        autoRotating = new Set(outcome.autoRotating ?? []);
        for (const alert of outcome.alerts ?? []) {
          const created = await this.createOnce({
            type: alert.severity === 'critical' ? 'expiry_critical' : 'expiry_warning',
            resourceType: alert.resourceType,
            resourceId: alert.resourceId,
            expiresAt: alert.expiresAt,
            reason: alert.reason,
            message: alert.message,
          });
          if (created) alertsCreated++;
        }
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== 'COMMERCIAL_MODULE_UNAVAILABLE') {
          logger.warn('Git token maintenance failed; expiring tokens are alerted instead', { error });
        }
      }
    }

    await section('sslCertificates', () => this.checkSslCertificates(leafThresholds, expiryCriticalDays, now));
    await section('pkiCertificates', () => this.checkPkiCertificates(leafThresholds, expiryCriticalDays, now));
    await section('nodeCertificates', () => this.checkNodeCertificates(now));
    await section('certificateAuthorities', () =>
      this.checkCertificateAuthorities(expiryWarningDays, expiryCriticalDays, now)
    );
    await section('gitTokens', () => this.checkGitTokens(now, autoRotating));

    logger.info('Expiry alert job completed', { alertsCreated, checked: counts });
  }

  // ── SSL certificates ─────────────────────────────────────────────

  private async checkSslCertificates(thresholds: number[], criticalDays: number, now: Date) {
    // A certificate whose renewal failed is still served until it expires, so
    // `error` (rows from v2.9.x or earlier) and `expired` rows are alerted too.
    const expiringSSL = await this.db.query.sslCertificates.findMany({
      where: and(
        inArray(sslCertificates.status, ['active', 'error', 'expired']),
        lte(sslCertificates.notAfter, new Date(now.getTime() + Math.max(...thresholds) * DAY_MS)),
        gte(sslCertificates.notAfter, reportWindowStart(now))
      ),
      columns: {
        id: true,
        name: true,
        type: true,
        notAfter: true,
        domainNames: true,
        autoRenew: true,
        renewalError: true,
      },
    });

    let created = 0;
    for (const cert of expiringSSL) {
      if (!cert.notAfter) continue;
      const threshold = crossedThreshold(cert.notAfter, thresholds, now);
      if (threshold === null) continue;
      const type: AlertType = threshold <= criticalDays ? 'expiry_critical' : 'expiry_warning';
      const message = `SSL certificate "${cert.name}" (${cert.domainNames?.join(', ')}) ${expiresPhrase(cert.notAfter, now)}.${internalCertificateHint(cert)}`;
      if (await this.expiryAlertOnce(type, 'ssl_certificate', cert.id, cert.notAfter, threshold, message)) {
        created++;
        if (daysLeft(cert.notAfter, now) <= 0) {
          this.eventBus?.publish('ssl.cert.changed', { id: cert.id, action: 'expired', name: cert.name });
        }
      }
    }
    return { checked: expiringSSL.length, created };
  }

  // ── PKI leaf certificates ────────────────────────────────────────

  private async checkPkiCertificates(thresholds: number[], criticalDays: number, now: Date) {
    const expiringPKI = await this.db.query.certificates.findMany({
      where: and(
        eq(certificates.status, 'active'),
        lte(certificates.notAfter, new Date(now.getTime() + Math.max(...thresholds) * DAY_MS)),
        gte(certificates.notAfter, reportWindowStart(now))
      ),
      columns: {
        id: true,
        caId: true,
        commonName: true,
        notAfter: true,
        systemOwnerType: true,
        systemOwnerId: true,
        systemLifecycleState: true,
      },
    });

    const owners = await this.resolveOwnerLabels(
      expiringPKI.flatMap((cert) =>
        cert.systemOwnerType && cert.systemOwnerId ? [{ type: cert.systemOwnerType, id: cert.systemOwnerId }] : []
      )
    );

    let created = 0;
    for (const cert of expiringPKI) {
      // A staged leaf is not in use yet; node certificates are alerted from
      // the node itself, which also covers leaves that predate ownership.
      if (cert.systemLifecycleState === 'pending' || cert.systemOwnerType === 'node') continue;
      const threshold = crossedThreshold(cert.notAfter, thresholds, now);
      if (threshold === null) continue;
      const type: AlertType = threshold <= criticalDays ? 'expiry_critical' : 'expiry_warning';
      const owner =
        cert.systemOwnerType && cert.systemOwnerId
          ? owners.get(`${cert.systemOwnerType}:${cert.systemOwnerId}`)
          : undefined;
      let message = owner
        ? `TLS certificate of ${owner} ${expiresPhrase(cert.notAfter, now)} (PKI certificate "${cert.commonName}").`
        : `PKI certificate "${cert.commonName}" ${expiresPhrase(cert.notAfter, now)}.`;
      if (!cert.systemOwnerType) message += await this.successorHint(cert);
      if (await this.expiryAlertOnce(type, 'certificate', cert.id, cert.notAfter, threshold, message)) created++;
    }
    return { checked: expiringPKI.length, created };
  }

  /** A leaf reissued by automation (or by hand) is still reported, but says it has a replacement. */
  private async successorHint(cert: { id: string; caId: string; commonName: string; notAfter: Date }) {
    const successor = await this.db.query.certificates.findFirst({
      where: and(
        eq(certificates.caId, cert.caId),
        eq(certificates.commonName, cert.commonName),
        eq(certificates.status, 'active'),
        ne(certificates.id, cert.id),
        gt(certificates.notAfter, cert.notAfter)
      ),
      columns: { serialNumber: true, notAfter: true },
    });
    if (!successor) return '';
    return ` A newer certificate with the same name exists (serial ${successor.serialNumber}, valid until ${successor.notAfter.toISOString()}); this only matters where the old one is still deployed.`;
  }

  /** Human names for the resources that own system leaves, keyed `type:id`. */
  private async resolveOwnerLabels(owners: Array<{ type: SystemOwnerType; id: string }>) {
    const labels = new Map<string, string>();
    const idsOf = (type: SystemOwnerType) => [
      ...new Set(owners.filter((owner) => owner.type === type).map((owner) => owner.id)),
    ];

    const storageIds = idsOf('managed_storage');
    if (storageIds.length) {
      const rows = await this.db.query.managedStorageClusters.findMany({
        where: inArray(managedStorageClusters.id, storageIds),
        columns: { id: true, name: true },
      });
      for (const row of rows) labels.set(`managed_storage:${row.id}`, `managed storage "${row.name}"`);
    }
    const databaseIds = idsOf('managed_database');
    if (databaseIds.length) {
      const rows = await this.db.query.managedDatabaseInstances.findMany({
        where: inArray(managedDatabaseInstances.id, databaseIds),
        columns: { id: true, name: true },
      });
      for (const row of rows) labels.set(`managed_database:${row.id}`, `managed database "${row.name}"`);
    }
    const relayIds = idsOf('relay_node_server');
    if (relayIds.length) {
      const rows = await this.db.query.relayInstances.findMany({
        where: inArray(relayInstances.id, relayIds),
        columns: { id: true, displayName: true },
      });
      for (const row of rows) labels.set(`relay_node_server:${row.id}`, `relay "${row.displayName}"`);
    }
    for (const owner of owners) {
      const key = `${owner.type}:${owner.id}`;
      if (labels.has(key)) continue;
      if (owner.type === 'opfield_listener') labels.set(key, `the Opfield ${owner.id} listener`);
      else if (owner.type === 'opfield_service') labels.set(key, `the Opfield internal service ${owner.id}`);
      else if (owner.type === 'managed_storage') labels.set(key, `deleted managed storage ${owner.id}`);
      else if (owner.type === 'managed_database') labels.set(key, `deleted managed database ${owner.id}`);
      else if (owner.type === 'relay_node_server') labels.set(key, `relay ${owner.id}`);
    }
    return labels;
  }

  // ── Node mTLS client certificates ────────────────────────────────

  private async checkNodeCertificates(now: Date) {
    const thresholds = [NODE_CERT_ALERT_DAYS.warning, NODE_CERT_ALERT_DAYS.critical];
    const expiringNodes = await this.db.query.nodes.findMany({
      where: and(
        ne(nodes.status, 'pending'),
        isNotNull(nodes.certificateExpiresAt),
        lte(nodes.certificateExpiresAt, new Date(now.getTime() + NODE_CERT_ALERT_DAYS.warning * DAY_MS)),
        gte(nodes.certificateExpiresAt, reportWindowStart(now))
      ),
      columns: {
        id: true,
        hostname: true,
        displayName: true,
        status: true,
        certificateExpiresAt: true,
        daemonVersion: true,
      },
    });

    let created = 0;
    for (const node of expiringNodes) {
      const notAfter = node.certificateExpiresAt;
      if (!notAfter) continue;
      const legacy = isLegacyRenewalDaemon(node.daemonVersion);
      // A daemon before rc.9 renews only in its last 7 days: 30 days left is
      // normal there, so only an overdue renewal is reported.
      const threshold = crossedThreshold(notAfter, legacy ? [LEGACY_NODE_CERT_ALERT_DAYS] : thresholds, now);
      if (threshold === null) continue;
      const type: AlertType = threshold <= NODE_CERT_ALERT_DAYS.critical ? 'expiry_critical' : 'expiry_warning';
      const name = node.displayName || node.hostname;
      const offline = node.status === 'online' ? '' : ` (the node is ${node.status})`;
      const message = legacy
        ? `mTLS client certificate of node "${name}" ${expiresPhrase(notAfter, now)} and its daemon (${node.daemonVersion}) has not renewed it${offline}. Update the node daemon: current daemons renew once a third of the lifetime remains. After expiry the node must be re-enrolled.`
        : `mTLS client certificate of node "${name}" ${expiresPhrase(notAfter, now)}. The daemon renews it once a third of its lifetime remains, so its renewal is failing${offline}. Make sure the node can reach Opfield and runs a current daemon; after expiry it must be re-enrolled.`;
      if (await this.expiryAlertOnce(type, 'node', node.id, notAfter, threshold, message)) created++;
    }
    return { checked: expiringNodes.length, created };
  }

  // ── Certificate authorities ──────────────────────────────────────

  private async checkCertificateAuthorities(warningDays: number, criticalDays: number, now: Date) {
    const userThresholds = [...USER_CA_ALERT_DAYS, warningDays, criticalDays];
    const systemThresholds = [...SYSTEM_CA_ALERT_DAYS, warningDays, criticalDays];
    const horizon = Math.max(...systemThresholds);
    const expiringCAs = await this.db.query.certificateAuthorities.findMany({
      where: and(
        eq(certificateAuthorities.status, 'active'),
        lte(certificateAuthorities.notAfter, new Date(now.getTime() + horizon * DAY_MS)),
        gte(certificateAuthorities.notAfter, reportWindowStart(now))
      ),
      columns: {
        id: true,
        commonName: true,
        notAfter: true,
        type: true,
        isSystem: true,
        systemPurpose: true,
      },
    });

    let created = 0;
    for (const ca of expiringCAs) {
      const threshold = crossedThreshold(ca.notAfter, ca.isSystem ? systemThresholds : userThresholds, now);
      if (threshold === null) continue;
      const type: AlertType = threshold <= criticalDays ? 'expiry_critical' : 'ca_expiry';
      const kind = ca.type === 'root' ? 'Root' : 'Intermediate';
      const purpose = ca.systemPurpose ? SYSTEM_CA_PURPOSE_LABELS[ca.systemPurpose] : undefined;
      const message = ca.isSystem
        ? `System ${purpose ? `${purpose} ` : ''}CA "${ca.commonName}" ${expiresPhrase(ca.notAfter, now)}. Certificates it issues now end with the CA, and there is no automatic CA rollover yet: plan its replacement before then, because every node, relay, managed storage and managed database certificate it issued stops working when it expires.`
        : `${kind} CA "${ca.commonName}" ${expiresPhrase(ca.notAfter, now)}. Certificates issued from it cannot outlive it; create its successor and distribute the new trust anchor in time.`;
      if (await this.expiryAlertOnce(type, 'certificate_authority', ca.id, ca.notAfter, threshold, message)) created++;
    }
    return { checked: expiringCAs.length, created };
  }

  // ── Git integration tokens ───────────────────────────────────────

  private async checkGitTokens(now: Date, autoRotating: ReadonlySet<string>) {
    const thresholds = [GIT_TOKEN_ALERT_DAYS.warning, GIT_TOKEN_ALERT_DAYS.critical];
    const horizon = new Date(now.getTime() + GIT_TOKEN_ALERT_DAYS.warning * DAY_MS);
    const typeFor = (threshold: number): AlertType =>
      threshold <= GIT_TOKEN_ALERT_DAYS.critical ? 'expiry_critical' : 'expiry_warning';
    let checked = 0;
    let created = 0;

    const connectors = await this.db.query.integrationConnectors.findMany({
      where: and(
        inArray(integrationConnectors.provider, ['gitlab', 'github', 'git']),
        isNotNull(integrationConnectors.encryptedToken)
      ),
      columns: {
        id: true,
        name: true,
        provider: true,
        enabled: true,
        authMode: true,
        tokenExpiresAt: true,
        refreshTokenExpiresAt: true,
      },
    });
    const connectorNames = new Map(connectors.map((connector) => [connector.id, connector.name]));
    for (const connector of connectors) {
      // OAuth access tokens refresh themselves; the refresh token is what can lapse.
      const oauth = connector.authMode === 'oauth';
      const expiresAt = oauth ? connector.refreshTokenExpiresAt : connector.tokenExpiresAt;
      if (!expiresAt || expiresAt > horizon || expiresAt < reportWindowStart(now)) continue;
      checked++;
      // It rotates itself 14 days ahead; an impossible or failed rotation is alerted.
      if (!oauth && autoRotating.has(`integration_connector:${connector.id}`)) continue;
      const threshold = crossedThreshold(expiresAt, thresholds, now);
      if (threshold === null) continue;
      const provider = PROVIDER_LABELS[connector.provider] ?? connector.provider;
      const message = oauth
        ? `The ${provider} authorization of integration "${connector.name}" ${expiresPhrase(expiresAt, now)}. It is refreshed while the connector syncs${connector.enabled ? '' : ' (the connector is disabled)'}; reconnect it if syncing has stopped.`
        : `The access token of ${provider} integration "${connector.name}" ${expiresPhrase(expiresAt, now)}. Syncs, Docker sources and Pages builds that use it stop working then; rotate the token.`;
      if (
        await this.expiryAlertOnce(
          typeFor(threshold),
          'integration_connector',
          connector.id,
          expiresAt,
          threshold,
          message
        )
      ) {
        created++;
      }
    }

    const credentials = await this.db.query.gitLabUserCredentials.findMany({
      where: and(
        eq(gitLabUserCredentials.status, 'valid'),
        isNotNull(gitLabUserCredentials.tokenExpiresAt),
        lte(gitLabUserCredentials.tokenExpiresAt, horizon),
        gte(gitLabUserCredentials.tokenExpiresAt, reportWindowStart(now))
      ),
      columns: { id: true, userId: true, connectorId: true, gitlabUsername: true, tokenExpiresAt: true },
    });
    const userIds = [...new Set(credentials.map((credential) => credential.userId))];
    const owners = userIds.length
      ? await this.db.query.users.findMany({
          where: inArray(users.id, userIds),
          columns: { id: true, email: true },
        })
      : [];
    const ownerEmails = new Map(owners.map((owner) => [owner.id, owner.email]));
    for (const credential of credentials) {
      const expiresAt = credential.tokenExpiresAt;
      if (!expiresAt) continue;
      checked++;
      if (autoRotating.has(`gitlab_user_credential:${credential.id}`)) continue;
      const threshold = crossedThreshold(expiresAt, thresholds, now);
      if (threshold === null) continue;
      const connectorName = connectorNames.get(credential.connectorId) ?? credential.connectorId;
      const message = `The GitLab personal access token of ${ownerEmails.get(credential.userId) ?? 'a user'} (GitLab user ${credential.gitlabUsername}) for integration "${connectorName}" ${expiresPhrase(expiresAt, now)}. Actions that use it fail after that; authorize a new token.`;
      if (
        await this.expiryAlertOnce(
          typeFor(threshold),
          'gitlab_user_credential',
          credential.id,
          expiresAt,
          threshold,
          message
        )
      ) {
        created++;
      }
    }
    return { checked, created };
  }

  // ── Dedupe ───────────────────────────────────────────────────────

  /** Expiry alert for a crossed threshold, once per validity period. */
  private expiryAlertOnce(
    type: AlertType,
    resourceType: string,
    resourceId: string,
    notAfter: Date,
    threshold: number,
    message: string
  ): Promise<boolean> {
    return this.createOnce({
      type,
      resourceType,
      resourceId,
      expiresAt: notAfter,
      reason: `expiry:${threshold}`,
      message,
      legacySince: new Date(notAfter.getTime() - threshold * DAY_MS),
    });
  }

  /**
   * Raise the alert once per resource, reason (threshold) and validity period.
   * The durable marker outlives the alert row, which housekeeping deletes
   * after the dismissed-alert retention, and a renewal (a new expiry) starts a
   * new period. `legacySince` also honors alerts raised before markers
   * existed, so an upgrade does not repeat them.
   */
  private async createOnce(input: {
    type: AlertType;
    resourceType: string;
    resourceId: string;
    expiresAt: Date;
    reason: string;
    message: string;
    legacySince?: Date;
  }): Promise<boolean> {
    const marker = {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      reason: input.reason,
      expiresAt: input.expiresAt,
    };
    const inserted = await this.db
      .insert(expiryAlertMarkers)
      .values(marker)
      .onConflictDoNothing()
      .returning({ reason: expiryAlertMarkers.reason });
    if (inserted.length === 0) return false;

    if (input.legacySince) {
      const existing = await this.db.query.alerts.findFirst({
        where: and(
          eq(alerts.type, input.type),
          eq(alerts.resourceType, input.resourceType),
          eq(alerts.resourceId, input.resourceId),
          gte(alerts.createdAt, input.legacySince)
        ),
        columns: { id: true },
      });
      if (existing) return false;
    }

    try {
      await this.alertService.createAlert({
        type: input.type,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        message: input.message,
      });
    } catch (error) {
      // Without the alert the marker must not suppress the next attempt.
      await this.db
        .delete(expiryAlertMarkers)
        .where(
          and(
            eq(expiryAlertMarkers.resourceType, marker.resourceType),
            eq(expiryAlertMarkers.resourceId, marker.resourceId),
            eq(expiryAlertMarkers.reason, marker.reason),
            eq(expiryAlertMarkers.expiresAt, marker.expiresAt)
          )
        )
        .catch(() => undefined);
      throw error;
    }
    logger.info(`Created ${input.type} alert`, {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      reason: input.reason,
    });
    return true;
  }

  private async pruneMarkers(now: Date): Promise<void> {
    try {
      await this.db.delete(expiryAlertMarkers).where(lt(expiryAlertMarkers.expiresAt, reportWindowStart(now)));
    } catch (error) {
      logger.warn('Failed to prune old expiry alert markers', { error });
    }
  }
}

const PROVIDER_LABELS: Record<string, string> = { gitlab: 'GitLab', github: 'GitHub', git: 'Git' };

function internalCertificateHint(cert: { type: string; autoRenew: boolean; renewalError: string | null }): string {
  if (cert.type !== 'internal') return '';
  if (cert.autoRenew) {
    return cert.renewalError
      ? ` Automatic reissue from its CA has not succeeded: ${cert.renewalError}`
      : ' Opfield reissues it from its CA automatically.';
  }
  return ' Automatic reissue is off, or it was issued from a CSR so Opfield does not hold its key: issue a new certificate from the CA and link it.';
}
