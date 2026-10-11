import { and, desc, eq, type SQL } from 'drizzle-orm';
import { domains, integrationConnectors } from '@/db/schema/index.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import { CloudflareClient } from './cloudflare-client.js';
import { CLOUDFLARE_AUDIT_ACTIONS } from './integration-audit.js';
import type {
  CloudflareConnectorCreateInput,
  CloudflareConnectorListQuery,
  CloudflareConnectorUpdateInput,
} from './integrations.schemas.js';
import type { CloudflareZoneRow, ConnectorRow } from './integrations.service.core.js';
import { IntegrationsGitLabConnectorService } from './integrations.service.gitlab-connectors.js';

export class IntegrationsCloudflareService extends IntegrationsGitLabConnectorService {
  async listCloudflareConnectors(query: CloudflareConnectorListQuery = {}) {
    const conditions: SQL[] = [eq(integrationConnectors.provider, 'cloudflare')];
    if (query.enabled !== undefined) conditions.push(eq(integrationConnectors.enabled, query.enabled));

    const rows = await this.db
      .select()
      .from(integrationConnectors)
      .where(buildWhere(conditions))
      .orderBy(desc(integrationConnectors.createdAt));

    return Promise.all(
      rows.map(async (row) => ({
        ...this.toSafeConnector(row),
        zones: await this.listCloudflareZoneRows(row.id),
      }))
    );
  }

  /** Safe shell-level capability check; never exposes connector metadata or credentials. */
  async hasEnabledCloudflareConnector(): Promise<boolean> {
    const [connector] = await this.db
      .select({ id: integrationConnectors.id })
      .from(integrationConnectors)
      .where(and(eq(integrationConnectors.provider, 'cloudflare'), eq(integrationConnectors.enabled, true)))
      .limit(1);
    return connector !== undefined;
  }

  async getCloudflareConnector(id: string) {
    const row = await this.getConnectorRow(id, 'cloudflare');
    const zones = await this.listCloudflareZoneRows(id);
    return { ...this.toSafeConnector(row), zones };
  }

  async createCloudflareConnector(input: CloudflareConnectorCreateInput, userId: string) {
    const settings = this.mergeCloudflareSettings(input.settings);
    const { capabilities, zones } = await this.testCloudflareToken(input.token);
    const encryptedToken = this.encryptToken(input.token);

    const [row] = await this.db
      .insert(integrationConnectors)
      .values({
        provider: 'cloudflare',
        name: input.name,
        baseUrl: 'https://api.cloudflare.com',
        enabled: input.enabled,
        encryptedToken,
        tokenLast4: this.tokenLast4(input.token),
        allowlistMode: 'all_visible',
        settings,
        capabilities,
        testedAt: new Date(),
      })
      .returning();

    await this.persistCloudflareZones(row.id, zones);
    await this.sslService?.revalidateCloudflareAutoRenew();

    await this.auditService.log({
      action: CLOUDFLARE_AUDIT_ACTIONS.connectorCreate,
      userId,
      resourceType: 'integration-connector',
      resourceId: row.id,
      details: { name: row.name, zoneCount: zones.length },
    });

    this.emitConnector(row.id, 'created', 'cloudflare');
    await this.markCloudflareInitialSync(row.id, userId, row.name, zones.length);
    return this.getCloudflareConnector(row.id);
  }

  async updateCloudflareConnector(id: string, input: CloudflareConnectorUpdateInput, userId: string) {
    const existing = await this.getConnectorRow(id, 'cloudflare');
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (input.name !== undefined) updates.name = input.name;
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.settings !== undefined)
      updates.settings = this.mergeCloudflareSettings(input.settings, existing.settings);

    let [row] = await this.db
      .update(integrationConnectors)
      .set(updates)
      .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, 'cloudflare')))
      .returning();

    if (!row) throw new AppError(404, 'NOT_FOUND', 'Cloudflare connector not found');

    const { capabilities, zones } = await this.testCloudflareToken(this.cloudflareTokenFor(row));
    [row] = await this.db
      .update(integrationConnectors)
      .set({ capabilities, testedAt: new Date(), updatedAt: new Date() })
      .where(eq(integrationConnectors.id, id))
      .returning();
    await this.persistCloudflareZones(id, zones);
    await this.sslService?.revalidateCloudflareAutoRenew();

    await this.auditService.log({
      action: CLOUDFLARE_AUDIT_ACTIONS.connectorUpdate,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: {
        name: existing.name,
        changes: Object.keys(updates).filter((key) => key !== 'updatedAt'),
        zoneCount: zones.length,
      },
    });

    this.emitConnector(id, 'updated', 'cloudflare');
    return this.getCloudflareConnector(id);
  }

  async rotateCloudflareConnectorToken(id: string, token: string, userId: string) {
    await this.getConnectorRow(id, 'cloudflare');
    const { capabilities, zones } = await this.testCloudflareToken(token);
    const [row] = await this.db
      .update(integrationConnectors)
      .set({
        encryptedToken: this.encryptToken(token),
        tokenLast4: this.tokenLast4(token),
        testedAt: new Date(),
        capabilities,
        updatedAt: new Date(),
      })
      .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, 'cloudflare')))
      .returning();

    if (!row) throw new AppError(404, 'NOT_FOUND', 'Cloudflare connector not found');
    await this.persistCloudflareZones(id, zones);
    await this.sslService?.revalidateCloudflareAutoRenew();

    await this.auditService.log({
      action: CLOUDFLARE_AUDIT_ACTIONS.connectorTokenRotate,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name: row.name, zoneCount: zones.length },
    });

    this.emitConnector(id, 'token-rotated', 'cloudflare');
    return this.getCloudflareConnector(id);
  }

  async deleteCloudflareConnector(id: string, userId: string) {
    const existing = await this.getConnectorRow(id, 'cloudflare');
    const linkedDomains = await this.db
      .select({ id: domains.id, domain: domains.domain })
      .from(domains)
      .where(eq(domains.integrationConnectorId, id))
      .limit(5);
    if (linkedDomains.length > 0) {
      throw new AppError(409, 'CLOUDFLARE_CONNECTOR_IN_USE', 'Cloudflare connector is used by Opfield domains', {
        domainCount: linkedDomains.length,
        domains: linkedDomains,
      });
    }
    await this.sslService?.disableCloudflareAutoRenewForConnector(id, 'cloudflare_connector_deleted');
    await this.db
      .delete(integrationConnectors)
      .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, 'cloudflare')));

    await this.auditService.log({
      action: CLOUDFLARE_AUDIT_ACTIONS.connectorDelete,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name: existing.name },
    });

    this.emitConnector(id, 'deleted', 'cloudflare');
  }

  async testCloudflareConnector(id: string, userId: string) {
    const row = await this.getConnectorRow(id, 'cloudflare');
    const { capabilities, zones } = await this.testCloudflareToken(this.cloudflareTokenFor(row));
    const [updated] = await this.db
      .update(integrationConnectors)
      .set({ capabilities, testedAt: new Date(), updatedAt: new Date() })
      .where(eq(integrationConnectors.id, id))
      .returning();
    await this.persistCloudflareZones(id, zones);
    await this.sslService?.revalidateCloudflareAutoRenew();

    await this.auditService.log({
      action: CLOUDFLARE_AUDIT_ACTIONS.connectorTest,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name: row.name, success: true, zoneCount: zones.length },
    });

    this.emitConnector(id, 'tested', 'cloudflare');
    return this.toSafeConnector(updated);
  }

  async testCloudflareConnectorPreview(input: { token: string }) {
    const { capabilities, zones } = await this.testCloudflareToken(input.token);
    return {
      capabilities,
      zones: zones.map((zone) => this.cloudflareZonePreview(zone)),
    };
  }

  async syncCloudflareConnector(id: string, userId: string | null, options: { scheduled?: boolean } = {}) {
    const row = await this.getConnectorRow(id, 'cloudflare');
    if (this.isSyncRunning(row) || this.syncLocks.has(id)) {
      await this.recordSyncOverlap(id);
      if (options.scheduled) return { status: 'skipped', reason: 'already_running' };
      throw new AppError(409, 'CONNECTOR_SYNC_RUNNING', 'Cloudflare connector sync is already running', {
        syncStartedAt: row.syncStartedAt,
      });
    }

    this.syncLocks.add(id);
    await this.db
      .update(integrationConnectors)
      .set({ syncStatus: 'running', syncStartedAt: new Date(), syncLastError: null, updatedAt: new Date() })
      .where(eq(integrationConnectors.id, id));
    this.emitConnector(id, 'sync-started', 'cloudflare');

    try {
      const { capabilities, zones } = await this.testCloudflareToken(this.cloudflareTokenFor(row));
      await this.persistCloudflareZones(id, zones);
      await this.sslService?.revalidateCloudflareAutoRenew();
      await this.db
        .update(integrationConnectors)
        .set({
          capabilities,
          testedAt: new Date(),
          syncStatus: 'success',
          syncFinishedAt: new Date(),
          syncFailureCount: 0,
          syncNextRetryAt: null,
          updatedAt: new Date(),
        })
        .where(eq(integrationConnectors.id, id));

      if (userId) {
        await this.auditService.log({
          action: CLOUDFLARE_AUDIT_ACTIONS.connectorSync,
          userId,
          resourceType: 'integration-connector',
          resourceId: id,
          details: { name: row.name, zoneCount: zones.length },
        });
      }

      this.emitConnector(id, 'synced', 'cloudflare', { name: row.name, failureCount: 0 });
      return { status: 'success', zoneCount: zones.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sync failure';
      const failureCount = row.syncFailureCount + 1;
      if (this.shouldDisableCloudflareAutoRenew(error)) {
        await this.sslService?.disableCloudflareAutoRenewForConnector(id, 'cloudflare_connector_unavailable');
      }
      await this.db
        .update(integrationConnectors)
        .set({
          syncStatus: 'error',
          syncFinishedAt: new Date(),
          syncLastError: message,
          syncFailureCount: failureCount,
          syncNextRetryAt: new Date(Date.now() + this.backoffSeconds(failureCount) * 1000),
          updatedAt: new Date(),
        })
        .where(eq(integrationConnectors.id, id));
      this.emitConnector(id, 'sync-failed', 'cloudflare', {
        name: row.name,
        failureCount,
        failureCode: this.connectorFailureCode(error),
      });
      throw error;
    } finally {
      this.syncLocks.delete(id);
    }
  }

  async runDueCloudflareSyncs() {
    const rows = await this.db
      .select()
      .from(integrationConnectors)
      .where(and(eq(integrationConnectors.provider, 'cloudflare'), eq(integrationConnectors.enabled, true)));
    const now = new Date();
    for (const row of rows) {
      if (!row.settings.autoSyncEnabled || !this.isDueForSync(row, now)) continue;
      try {
        await this.syncCloudflareConnector(row.id, null, { scheduled: true });
      } catch {
        // syncCloudflareConnector already persists failure state; scheduler must not block boot or other jobs.
      }
    }
  }

  async listCloudflareZones(id: string) {
    await this.getConnectorRow(id, 'cloudflare');
    return this.listCloudflareZoneRows(id);
  }

  async resolveCloudflareDnsContext(domain: string) {
    const connectors = await this.db
      .select()
      .from(integrationConnectors)
      .where(and(eq(integrationConnectors.provider, 'cloudflare'), eq(integrationConnectors.enabled, true)));
    const candidates: Array<{ connector: ConnectorRow; zone: CloudflareZoneRow; matchLength: number }> = [];

    for (const connector of connectors) {
      const zones = await this.listCloudflareZoneRows(connector.id);
      for (const zone of zones) {
        if (domain === zone.name || domain.endsWith(`.${zone.name}`)) {
          candidates.push({ connector, zone, matchLength: zone.name.length });
        }
      }
    }

    if (candidates.length === 0) {
      throw new AppError(
        409,
        'CLOUDFLARE_ZONE_NOT_FOUND',
        'No enabled Cloudflare connector has a synced zone for this domain',
        { domain }
      );
    }

    const bestLength = Math.max(...candidates.map((candidate) => candidate.matchLength));
    const best = candidates.filter((candidate) => candidate.matchLength === bestLength);
    if (best.length > 1) {
      throw new AppError(409, 'CLOUDFLARE_ZONE_AMBIGUOUS', 'Multiple Cloudflare connectors match this domain zone', {
        domain,
        zones: best.map((candidate) => ({
          connectorId: candidate.connector.id,
          connectorName: candidate.connector.name,
          zoneId: candidate.zone.remoteId,
          zoneName: candidate.zone.name,
        })),
      });
    }

    const [{ connector, zone }] = best;
    return {
      connector,
      zone,
      settings: this.mergeCloudflareSettings(undefined, connector.settings),
      client: new CloudflareClient(this.cloudflareTokenFor(connector)),
    };
  }

  async getCloudflareDnsContextForRecord(connectorId: string, zoneRemoteId: string) {
    const connector = await this.getConnectorRow(connectorId, 'cloudflare');
    const zones = await this.listCloudflareZoneRows(connector.id);
    const zone = zones.find((candidate) => candidate.remoteId === zoneRemoteId);
    if (!zone) {
      throw new AppError(409, 'CLOUDFLARE_ZONE_NOT_FOUND', 'Cloudflare zone is no longer synced for this domain', {
        connectorId,
        zoneId: zoneRemoteId,
      });
    }
    return {
      connector,
      zone,
      settings: this.mergeCloudflareSettings(undefined, connector.settings),
      client: new CloudflareClient(this.cloudflareTokenFor(connector)),
    };
  }
}
