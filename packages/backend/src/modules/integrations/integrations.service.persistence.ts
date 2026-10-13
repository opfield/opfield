import { eq, type SQL } from 'drizzle-orm';
import {
  type IntegrationProvider,
  integrationConnectorAllowlistEntries,
  integrationConnectorCloudflareZones,
  integrationConnectorProjects,
  integrationConnectorRegistries,
  integrationConnectors,
} from '@/db/schema/index.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import { CloudflareClient, type CloudflareDnsRecord, type CloudflareZoneRef } from './cloudflare-client.js';
import { CLOUDFLARE_AUDIT_ACTIONS } from './integration-audit.js';
import type { GitLabAllowlistEntryInput } from './integrations.schemas.js';
import {
  type AllowlistRow,
  type CloudflareZoneInput,
  type CloudflareZoneRow,
  type ConnectorRow,
  type DockerBuildSourceRepository,
  IntegrationsCoreService,
  type ProjectRow,
  type ProjectRowInput,
  type RegistryRowInput,
  type SafeIntegrationConnector,
  UUID_RE,
} from './integrations.service.core.js';
import { invalidateSourceRepositoryLists } from './source-repository-lists.js';

export abstract class IntegrationsPersistenceService extends IntegrationsCoreService {
  abstract syncGitLabConnector(id: string, userId: string | null, options?: { scheduled?: boolean }): Promise<unknown>;

  protected async syncConnectorAfterCreate(provider: IntegrationProvider, id: string, userId: string) {
    try {
      if (provider === 'gitlab') {
        await this.syncGitLabConnector(id, userId);
      }
    } catch {
      // Sync methods persist failure state. Connector creation should not fail after the row exists.
    }
  }

  protected async markCloudflareInitialSync(id: string, userId: string, name: string, zoneCount: number) {
    await this.db
      .update(integrationConnectors)
      .set({
        syncStatus: 'success',
        syncStartedAt: new Date(),
        syncFinishedAt: new Date(),
        syncFailureCount: 0,
        syncNextRetryAt: null,
        syncLastError: null,
        updatedAt: new Date(),
      })
      .where(eq(integrationConnectors.id, id));

    await this.auditService.log({
      action: CLOUDFLARE_AUDIT_ACTIONS.connectorSync,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name, zoneCount, source: 'connector.create' },
    });
    this.emitConnector(id, 'synced', 'cloudflare');
  }

  protected async getConnectorRow(id: string, provider?: IntegrationProvider): Promise<ConnectorRow> {
    if (!UUID_RE.test(id)) {
      throw new AppError(400, 'INVALID_CONNECTOR_ID', 'connectorId must be a valid integration connector UUID');
    }
    const conditions: SQL[] = [eq(integrationConnectors.id, id)];
    if (provider) conditions.push(eq(integrationConnectors.provider, provider));
    const [row] = await this.db.select().from(integrationConnectors).where(buildWhere(conditions)).limit(1);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Integration connector not found');
    return row;
  }

  protected async listAllowlistRows(connectorId: string): Promise<AllowlistRow[]> {
    return this.db
      .select()
      .from(integrationConnectorAllowlistEntries)
      .where(eq(integrationConnectorAllowlistEntries.connectorId, connectorId))
      .orderBy(integrationConnectorAllowlistEntries.fullPath);
  }

  protected async replaceAllowlistEntries(connectorId: string, entries: GitLabAllowlistEntryInput[]) {
    invalidateSourceRepositoryLists(connectorId);
    await this.db
      .delete(integrationConnectorAllowlistEntries)
      .where(eq(integrationConnectorAllowlistEntries.connectorId, connectorId));
    if (entries.length === 0) return;
    await this.db.insert(integrationConnectorAllowlistEntries).values(
      entries.map((entry) => ({
        connectorId,
        entryType: entry.entryType,
        remoteId: entry.remoteId,
        fullPath: entry.fullPath,
        name: entry.name ?? null,
        webUrl: entry.webUrl ?? null,
      }))
    );
  }

  protected async persistProjects(connectorId: string, projects: ProjectRowInput[]) {
    const now = new Date();
    const seenRemoteIds = new Set(projects.map((project) => project.remoteId));
    await this.upsertProjectRows(connectorId, projects, now);

    const existing = await this.db
      .select()
      .from(integrationConnectorProjects)
      .where(eq(integrationConnectorProjects.connectorId, connectorId));
    for (const project of existing) {
      if (seenRemoteIds.has(project.remoteId) || project.inaccessibleAt) continue;
      await this.db
        .update(integrationConnectorProjects)
        .set({ inaccessibleAt: now, updatedAt: now })
        .where(eq(integrationConnectorProjects.id, project.id));
    }
  }

  protected async upsertProjectRows(connectorId: string, projects: ProjectRowInput[], now = new Date()) {
    for (const project of projects) {
      await this.db
        .insert(integrationConnectorProjects)
        .values({
          connectorId,
          remoteId: project.remoteId,
          fullPath: project.fullPath,
          name: project.name,
          webUrl: project.webUrl ?? null,
          visibility: project.visibility ?? null,
          defaultBranch: project.defaultBranch ?? null,
          archived: project.archived ?? false,
          lastSeenAt: now,
          inaccessibleAt: null,
          metadata: {},
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [integrationConnectorProjects.connectorId, integrationConnectorProjects.remoteId],
          set: {
            fullPath: project.fullPath,
            name: project.name,
            webUrl: project.webUrl ?? null,
            visibility: project.visibility ?? null,
            defaultBranch: project.defaultBranch ?? null,
            archived: project.archived ?? false,
            lastSeenAt: now,
            inaccessibleAt: null,
            updatedAt: now,
          },
        });
    }
  }

  protected toDockerBuildSourceRepository(connector: ConnectorRow, project: ProjectRow): DockerBuildSourceRepository {
    if (!['gitlab', 'github', 'git'].includes(connector.provider)) {
      throw new AppError(400, 'UNSUPPORTED_SOURCE_CONNECTOR', 'Connector does not provide a Git repository');
    }
    return {
      connectorId: connector.id,
      connectorName: connector.name,
      projectId: project.id,
      provider: connector.provider as 'gitlab' | 'github' | 'git',
      remoteId: project.remoteId,
      fullPath: project.fullPath,
      name: project.name,
      webUrl: project.webUrl,
      defaultBranch: project.defaultBranch,
      archived: project.archived,
    };
  }

  protected async persistRegistries(connectorId: string, registries: RegistryRowInput[]) {
    const now = new Date();
    const seenUrls = new Set(registries.map((registry) => registry.registryUrl));
    for (const registry of registries) {
      await this.db
        .insert(integrationConnectorRegistries)
        .values({
          connectorId,
          remoteRegistryId: registry.remoteRegistryId ?? null,
          projectRemoteId: registry.projectRemoteId ?? null,
          projectFullPath: registry.projectFullPath ?? null,
          registryUrl: registry.registryUrl,
          name: registry.name,
          status: 'available',
          lastSeenAt: now,
          inaccessibleAt: null,
          metadata: {},
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [integrationConnectorRegistries.connectorId, integrationConnectorRegistries.registryUrl],
          set: {
            remoteRegistryId: registry.remoteRegistryId ?? null,
            projectRemoteId: registry.projectRemoteId ?? null,
            projectFullPath: registry.projectFullPath ?? null,
            name: registry.name,
            status: 'available',
            lastSeenAt: now,
            inaccessibleAt: null,
            updatedAt: now,
          },
        });
    }

    const existing = await this.db
      .select()
      .from(integrationConnectorRegistries)
      .where(eq(integrationConnectorRegistries.connectorId, connectorId));
    for (const registry of existing) {
      if (seenUrls.has(registry.registryUrl) || registry.inaccessibleAt) continue;
      await this.db
        .update(integrationConnectorRegistries)
        .set({ status: 'inaccessible', inaccessibleAt: now, updatedAt: now })
        .where(eq(integrationConnectorRegistries.id, registry.id));
    }
  }

  protected async listCloudflareZoneRows(connectorId: string): Promise<CloudflareZoneRow[]> {
    return this.db
      .select()
      .from(integrationConnectorCloudflareZones)
      .where(eq(integrationConnectorCloudflareZones.connectorId, connectorId))
      .orderBy(integrationConnectorCloudflareZones.name);
  }

  protected async persistCloudflareZones(connectorId: string, zones: CloudflareZoneInput[]) {
    const now = new Date();
    await this.db
      .delete(integrationConnectorCloudflareZones)
      .where(eq(integrationConnectorCloudflareZones.connectorId, connectorId));
    if (zones.length === 0) return;

    await this.db.insert(integrationConnectorCloudflareZones).values(
      zones.map((zone) => ({
        connectorId,
        remoteId: zone.id,
        name: zone.name,
        status: zone.status ?? null,
        accountId: zone.account?.id ?? null,
        accountName: zone.account?.name ?? null,
        lastSeenAt: now,
        metadata: {},
        updatedAt: now,
      }))
    );
  }

  protected async testCloudflareToken(token: string) {
    const client = new CloudflareClient(token);
    let tokenStatus: Awaited<ReturnType<CloudflareClient['verifyToken']>>;
    try {
      tokenStatus = await client.verifyToken();
    } catch (error) {
      if (!this.isCloudflarePermissionError(error)) throw error;
      throw new AppError(400, 'CLOUDFLARE_TOKEN_INVALID', 'Cloudflare API token is invalid', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (tokenStatus.status && tokenStatus.status !== 'active') {
      throw new AppError(400, 'CLOUDFLARE_TOKEN_INACTIVE', 'Cloudflare token is not active', {
        status: tokenStatus.status,
      });
    }
    let zones: CloudflareZoneRef[];
    try {
      zones = await client.listZones();
    } catch (error) {
      if (!this.isCloudflarePermissionError(error)) throw error;
      throw new AppError(
        400,
        'CLOUDFLARE_ZONE_READ_REQUIRED',
        'Cloudflare token must include Zone:Read permission for the zones Opfield should manage',
        { cause: error instanceof Error ? error.message : String(error) }
      );
    }
    if (zones.length === 0) {
      throw new AppError(400, 'CLOUDFLARE_ZONE_NOT_FOUND', 'Cloudflare token has no active zones');
    }

    const manageableZones: CloudflareZoneRef[] = [];
    const dnsReadFailures: Array<{ zone: string; cause: string }> = [];
    for (const zone of zones) {
      try {
        await client.probeDnsRead(zone.id);
        manageableZones.push(zone);
      } catch (error) {
        if (!this.isCloudflarePermissionError(error)) throw error;
        dnsReadFailures.push({
          zone: zone.name,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const probeZone = manageableZones[0];
    if (!probeZone) {
      const firstFailure = dnsReadFailures[0];
      throw new AppError(
        400,
        'CLOUDFLARE_DNS_READ_REQUIRED',
        firstFailure
          ? `Cloudflare denied DNS access for ${firstFailure.zone}: ${firstFailure.cause}`
          : 'Cloudflare denied DNS access for every active zone',
        { failures: dnsReadFailures }
      );
    }
    let probeRecordId: string | null = null;
    let cleanupError: unknown = null;
    try {
      let probeRecord: CloudflareDnsRecord;
      try {
        probeRecord = await client.createDnsRecord(probeZone.id, {
          type: 'TXT',
          name: `_opfield-permission-check.${probeZone.name}`,
          content: `opfield-${Date.now()}`,
          ttl: 60,
          comment: 'Opfield permission check',
        });
      } catch (error) {
        if (!this.isCloudflarePermissionError(error)) throw error;
        throw new AppError(
          400,
          'CLOUDFLARE_DNS_EDIT_REQUIRED',
          'Cloudflare token must include DNS:Edit permission for Opfield-managed zones',
          { zone: probeZone.name, cause: error instanceof Error ? error.message : String(error) }
        );
      }
      probeRecordId = probeRecord.id;
    } finally {
      if (probeRecordId) {
        try {
          await client.deleteDnsRecord(probeZone.id, probeRecordId);
        } catch (error) {
          cleanupError = error;
        }
      }
    }
    if (cleanupError) {
      throw new AppError(400, 'CLOUDFLARE_DNS_PROBE_CLEANUP_FAILED', 'Cloudflare DNS probe cleanup failed', {
        zone: probeZone.name,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    return {
      capabilities: {
        apiReachable: true,
        tokenActive: true,
        zonesRead: true,
        dnsRead: true,
        dnsEdit: true,
      },
      zones: manageableZones,
    };
  }

  protected isCloudflarePermissionError(error: unknown): boolean {
    return error instanceof AppError && (error.statusCode === 401 || error.statusCode === 403);
  }

  protected shouldDisableCloudflareAutoRenew(error: unknown): boolean {
    if (!(error instanceof AppError)) return false;
    return [
      'CLOUDFLARE_TOKEN_INACTIVE',
      'CLOUDFLARE_ZONE_READ_REQUIRED',
      'CLOUDFLARE_ZONE_NOT_FOUND',
      'CLOUDFLARE_DNS_READ_REQUIRED',
      'CLOUDFLARE_DNS_EDIT_REQUIRED',
    ].includes(error.code);
  }

  protected cloudflareZonePreview(zone: CloudflareZoneRef) {
    return {
      remoteId: zone.id,
      name: zone.name,
      status: zone.status ?? null,
      accountId: zone.account?.id ?? null,
      accountName: zone.account?.name ?? null,
    };
  }

  protected toSafeConnector(row: ConnectorRow): SafeIntegrationConnector {
    const { encryptedToken: _encryptedToken, encryptedRefreshToken: _encryptedRefreshToken, ...safe } = row;
    return {
      ...safe,
      hasToken: Boolean(row.encryptedToken),
      tokenMasked: row.tokenLast4 ? `****${row.tokenLast4}` : null,
    };
  }
}
