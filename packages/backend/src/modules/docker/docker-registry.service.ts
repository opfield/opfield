import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerImageRegistryMappings,
  dockerRegistries,
  integrationConnectorCredentials,
  integrationConnectorRegistries,
  integrationConnectorRegistryLinks,
  integrationConnectors,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { type DockerInternalRegistryService, INTERNAL_DOCKER_REGISTRY_ID } from './docker-registry-internal.service.js';

const logger = createChildLogger('DockerRegistryService');

export interface DockerRegistryAuthCandidate {
  registryId: string;
  url: string;
  authJson: string;
}

interface RegistryConnectionTestResult {
  success: boolean;
  status?: number;
  statusText?: string;
  error?: string;
}

type DockerRegistryRow = typeof dockerRegistries.$inferSelect;
type IntegrationRegistryLinkRow = typeof integrationConnectorRegistryLinks.$inferSelect;
type IntegrationConnectorRow = typeof integrationConnectors.$inferSelect;

type SafeDockerRegistry = Omit<DockerRegistryRow, 'encryptedPassword'> & {
  integration?: {
    provider: 'gitlab';
    connectorId: string;
    connectorName: string | null;
    connectorBaseUrl: string | null;
    projectRemoteId: string | null;
    projectFullPath: string | null;
    remoteRegistryId: string | null;
    status: 'available' | 'inaccessible';
    lastSeenAt: Date;
  };
};

interface RegistryUseContext {
  actorScopes?: string[];
}

export class DockerRegistryService {
  private eventBus?: EventBusService;
  private internalRegistryService?: DockerInternalRegistryService;

  constructor(
    private db: DrizzleClient,
    private auditService: AuditService,
    private cryptoService: CryptoService,
    private nodeDispatch: NodeDispatchService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  setInternalRegistryService(service: DockerInternalRegistryService): void {
    this.internalRegistryService = service;
  }

  private emitRegistry(id: string, action: string) {
    this.eventBus?.publish('docker.registry.changed', { id, action });
  }

  async list(nodeId?: string) {
    const conditions = [];
    if (nodeId) {
      // Return global registries + node-specific registries for this node
      conditions.push(or(eq(dockerRegistries.scope, 'global'), eq(dockerRegistries.nodeId, nodeId)));
    }
    const rows = await this.db
      .select()
      .from(dockerRegistries)
      .where(buildWhere(conditions))
      .orderBy(desc(dockerRegistries.createdAt));

    const registries = await this.toSafeRegistries(rows);
    if (!this.internalRegistryService) return registries;
    return [await this.internalRegistryView(), ...registries];
  }

  async get(id: string) {
    if (id === INTERNAL_DOCKER_REGISTRY_ID) return this.internalRegistryView();
    const row = await this.getRegistryRow(id);
    return this.toSafeRegistry(row);
  }

  private async getRegistryRow(id: string): Promise<DockerRegistryRow> {
    const [row] = await this.db.select().from(dockerRegistries).where(eq(dockerRegistries.id, id)).limit(1);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Docker registry not found');
    return row;
  }

  async create(
    input: {
      name: string;
      url: string;
      username?: string;
      password?: string;
      trustedAuthRealm?: string;
      scope: string;
      nodeId?: string;
    },
    userId: string
  ) {
    let encryptedPassword: string | null = null;
    if (input.password) {
      const encrypted = this.cryptoService.encryptString(input.password);
      // Store as JSON containing both components needed for decryption
      encryptedPassword = JSON.stringify(encrypted);
    }

    const [row] = await this.db
      .insert(dockerRegistries)
      .values({
        name: input.name,
        url: input.url,
        username: input.username ?? null,
        encryptedPassword,
        trustedAuthRealm: input.trustedAuthRealm?.trim() || null,
        scope: input.scope,
        nodeId: input.nodeId ?? null,
      })
      .returning();

    await this.auditService.log({
      action: 'docker.registry.create',
      userId,
      resourceType: 'docker-registry',
      resourceId: row.id,
      details: { name: input.name, url: input.url, scope: input.scope },
    });

    const safe = await this.toSafeRegistry(row);
    this.emitRegistry(row.id, 'created');
    return safe;
  }

  async update(
    id: string,
    input: {
      name?: string;
      url?: string;
      username?: string;
      password?: string;
      trustedAuthRealm?: string;
      scope?: string;
      nodeId?: string;
    },
    userId: string
  ) {
    this.assertNotInternalRegistry(id);
    const existing = await this.getRegistryRow(id);
    await this.assertManualRegistry(existing);
    this.assertOriginChangeHasReplacementPassword(existing, input);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.url !== undefined) updates.url = input.url;
    if (input.username !== undefined) updates.username = input.username;
    if (input.trustedAuthRealm !== undefined) updates.trustedAuthRealm = input.trustedAuthRealm.trim() || null;
    if (input.scope !== undefined) updates.scope = input.scope;
    if (input.nodeId !== undefined) {
      updates.nodeId = input.nodeId;
    } else if (input.scope === 'global') {
      updates.nodeId = null;
    }

    if (input.password !== undefined) {
      if (input.password) {
        const encrypted = this.cryptoService.encryptString(input.password);
        updates.encryptedPassword = JSON.stringify(encrypted);
      } else {
        updates.encryptedPassword = null;
      }
    }

    const [row] = await this.db.update(dockerRegistries).set(updates).where(eq(dockerRegistries.id, id)).returning();

    await this.auditService.log({
      action: 'docker.registry.update',
      userId,
      resourceType: 'docker-registry',
      resourceId: id,
      details: { name: input.name, url: input.url },
    });

    const safe = await this.toSafeRegistry(row);
    this.emitRegistry(id, 'updated');
    return safe;
  }

  async delete(id: string, userId: string) {
    this.assertNotInternalRegistry(id);
    const registry = await this.getRegistryRow(id);
    await this.assertManualRegistry(registry);

    await this.db.delete(dockerRegistries).where(eq(dockerRegistries.id, id));

    await this.auditService.log({
      action: 'docker.registry.delete',
      userId,
      resourceType: 'docker-registry',
      resourceId: id,
      details: { name: registry.name },
    });

    this.emitRegistry(id, 'deleted');
  }

  async testConnection(id: string, _context: RegistryUseContext = {}) {
    if (id === INTERNAL_DOCKER_REGISTRY_ID) {
      const registry = await this.internalRegistryView();
      return {
        success: registry.internal.status === 'ready' || registry.internal.status === 'read_only',
        statusText: registry.internal.status,
      };
    }
    const [row] = await this.db.select().from(dockerRegistries).where(eq(dockerRegistries.id, id)).limit(1);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Docker registry not found');

    const credentials = await this.resolveRegistryCredentials(row);
    if (this.isGitLabIntegrationRegistry(row) && !credentials) {
      return { success: false, statusText: 'GitLab registry credentials are not configured' };
    }
    const basicAuth = credentials
      ? `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
      : '';

    const trustedAuthRealm = await this.resolveRegistryTrustedAuthRealm(row);
    return this.testRegistryConnection(this.registryConnectionTestUrl(row), basicAuth, trustedAuthRealm);
  }

  async testConnectionDirect(url: string, username?: string, password?: string, trustedAuthRealm?: string) {
    const basicAuth = username && password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : '';
    return this.testRegistryConnection(url, basicAuth, trustedAuthRealm);
  }

  private normalizeRegistryBaseUrl(rawUrl: string): URL {
    const trimmed = rawUrl.trim().replace(/\/+$/, '');
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withScheme);
  }

  private isGitLabIntegrationRegistry(row: DockerRegistryRow): boolean {
    return row.source === 'integration' && row.provider === 'gitlab';
  }

  private registryConnectionTestUrl(row: DockerRegistryRow): string {
    if (!this.isGitLabIntegrationRegistry(row)) return row.url;
    const url = this.normalizeRegistryBaseUrl(row.url);
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  }

  private parseBearerChallenge(wwwAuthenticate: string): { realm: string | null; service: string | null } {
    const realmMatch = wwwAuthenticate.match(/realm="([^"]+)"/i);
    const serviceMatch = wwwAuthenticate.match(/service="([^"]+)"/i);
    return {
      realm: realmMatch?.[1] ?? null,
      service: serviceMatch?.[1] ?? null,
    };
  }

  private trustedRealmOrigin(rawRealm?: string | null): string | null {
    const trimmed = rawRealm?.trim();
    if (!trimmed) return null;

    try {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      const trustedUrl = new URL(withScheme);
      if (trustedUrl.protocol !== 'https:') return null;
      return trustedUrl.origin.toLowerCase();
    } catch {
      return null;
    }
  }

  private isAllowedBearerRealm(registryBaseUrl: URL, tokenUrl: URL, trustedAuthRealm?: string | null): boolean {
    if (tokenUrl.protocol !== 'https:') return false;
    const trustedOrigin = this.trustedRealmOrigin(trustedAuthRealm);
    if (trustedOrigin && tokenUrl.origin.toLowerCase() === trustedOrigin) return true;

    if (tokenUrl.hostname.toLowerCase() !== registryBaseUrl.hostname.toLowerCase()) return false;

    const registryPort = registryBaseUrl.port || (registryBaseUrl.protocol === 'https:' ? '443' : registryBaseUrl.port);
    const tokenPort = tokenUrl.port || '443';

    return registryPort === tokenPort;
  }

  private async testRegistryConnection(
    rawUrl: string,
    basicAuth: string,
    trustedAuthRealm?: string | null
  ): Promise<RegistryConnectionTestResult> {
    try {
      const baseUrl = this.normalizeRegistryBaseUrl(rawUrl);
      const basePath = baseUrl.pathname.replace(/\/+$/, '');
      const v2Url = new URL(`${basePath}/v2/`, baseUrl);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        // Step 1: Hit /v2/ to check if registry is reachable
        const headers: Record<string, string> = {};
        if (basicAuth) headers.Authorization = basicAuth;
        const response = await fetch(v2Url.toString(), { headers, signal: controller.signal });

        if (response.ok) {
          return { success: true, status: response.status, statusText: 'OK' };
        }

        // Step 2: If 401 with Bearer challenge, do Docker token exchange
        if (response.status === 401 && basicAuth) {
          const challenge = this.parseBearerChallenge(response.headers.get('www-authenticate') || '');

          if (challenge.realm) {
            let tokenUrl: URL;
            try {
              tokenUrl = new URL(challenge.realm);
            } catch {
              return { success: false, status: 401, statusText: 'Authentication failed: invalid Bearer realm' };
            }

            if (!this.isAllowedBearerRealm(baseUrl, tokenUrl, trustedAuthRealm)) {
              return {
                success: false,
                status: 401,
                statusText:
                  'Authentication failed: Bearer realm is not trusted for this registry. Configure a trusted token service origin if this registry uses a separate auth service.',
              };
            }

            if (challenge.service) tokenUrl.searchParams.set('service', challenge.service);
            const tokenResp = await fetch(tokenUrl.toString(), {
              headers: { Authorization: basicAuth },
              signal: controller.signal,
            });
            if (tokenResp.ok) {
              return { success: true, status: 200, statusText: 'Authenticated (token exchange)' };
            }
            return {
              success: false,
              status: tokenResp.status,
              statusText: `Authentication failed: ${tokenResp.statusText}`,
            };
          }

          // No Bearer challenge — plain 401
          return { success: false, status: 401, statusText: 'Authentication failed' };
        }

        return { success: false, status: response.status, statusText: response.statusText };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  /**
   * Push global + node-specific registry credentials to the Docker daemon.
   * Daemon-side pulls (for example a container tag update) resolve their
   * credentials from this set by image registry host.
   */
  async syncRegistriesToNode(nodeId: string) {
    try {
      const rows = await this.db
        .select()
        .from(dockerRegistries)
        .where(or(eq(dockerRegistries.scope, 'global'), eq(dockerRegistries.nodeId, nodeId)));

      const registries = (
        await Promise.all(
          rows.map(async (row) => {
            const credentials = await this.resolveRegistryCredentials(row);
            if (!credentials) return null;
            // The daemon matches credentials by the image reference host.
            const url = this.normalizeRegistryHost(row.url);
            if (!url) return null;
            return {
              url,
              username: credentials.username,
              password: credentials.password,
            };
          })
        )
      ).filter((registry): registry is { url: string; username: string; password: string } => Boolean(registry));

      if (registries.length === 0) return;

      // The config push allowlist is the daemon's container-name allowlist, not
      // a registry list: an empty list leaves it unchanged.
      await this.nodeDispatch.sendDockerConfigPush(nodeId, registries, []);
      logger.info(`Synced ${registries.length} registries to node ${nodeId}`);
    } catch (error) {
      logger.error('Failed to sync registries to node', { nodeId, error });
    }
  }

  async reconcileGitLabConnectorRegistries(connectorId: string) {
    const now = new Date();
    const [connector] = await this.db
      .select()
      .from(integrationConnectors)
      .where(eq(integrationConnectors.id, connectorId))
      .limit(1);
    const trustedAuthRealm = connector?.baseUrl ?? null;
    const connectorRegistries = await this.db
      .select()
      .from(integrationConnectorRegistries)
      .where(eq(integrationConnectorRegistries.connectorId, connectorId));

    const links = await this.db
      .select()
      .from(integrationConnectorRegistryLinks)
      .where(eq(integrationConnectorRegistryLinks.connectorId, connectorId));
    const linkedRegistryIds = links.map((link) => link.registryId);
    const linkedRegistries = linkedRegistryIds.length
      ? await this.db.select().from(dockerRegistries).where(inArray(dockerRegistries.id, linkedRegistryIds))
      : [];
    const linkedByUrl = new Map(linkedRegistries.map((registry) => [this.normalizeOriginUrl(registry.url), registry]));
    const linkByRegistryId = new Map(links.map((link) => [link.registryId, link]));
    const seenRegistryIds = new Set<string>();

    for (const connectorRegistry of connectorRegistries) {
      const normalizedUrl = this.normalizeOriginUrl(connectorRegistry.registryUrl);
      const existing = linkedByUrl.get(normalizedUrl);
      const isAvailable = connectorRegistry.status === 'available' && !connectorRegistry.inaccessibleAt;
      const linkStatus = isAvailable ? 'available' : 'inaccessible';

      if (!existing) {
        if (!isAvailable) continue;
        const [registry] = await this.db
          .insert(dockerRegistries)
          .values({
            name: connectorRegistry.name,
            url: connectorRegistry.registryUrl,
            username: null,
            encryptedPassword: null,
            trustedAuthRealm,
            source: 'integration',
            provider: 'gitlab',
            readOnly: true,
            scope: 'global',
            nodeId: null,
            updatedAt: now,
          })
          .returning();

        await this.db.insert(integrationConnectorRegistryLinks).values({
          connectorId,
          registryId: registry.id,
          remoteRegistryId: connectorRegistry.remoteRegistryId,
          projectRemoteId: connectorRegistry.projectRemoteId,
          projectFullPath: connectorRegistry.projectFullPath,
          status: linkStatus,
          lastSeenAt: connectorRegistry.lastSeenAt,
          updatedAt: now,
        });
        seenRegistryIds.add(registry.id);
        this.emitRegistry(registry.id, 'created');
        continue;
      }

      seenRegistryIds.add(existing.id);
      const existingLink = linkByRegistryId.get(existing.id);
      await this.db
        .update(dockerRegistries)
        .set({
          name: connectorRegistry.name,
          url: connectorRegistry.registryUrl,
          source: 'integration',
          provider: 'gitlab',
          readOnly: true,
          trustedAuthRealm,
          updatedAt: now,
        })
        .where(eq(dockerRegistries.id, existing.id));

      if (existingLink) {
        await this.db
          .update(integrationConnectorRegistryLinks)
          .set({
            remoteRegistryId: connectorRegistry.remoteRegistryId,
            projectRemoteId: connectorRegistry.projectRemoteId,
            projectFullPath: connectorRegistry.projectFullPath,
            status: linkStatus,
            lastSeenAt: connectorRegistry.lastSeenAt,
            updatedAt: now,
          })
          .where(eq(integrationConnectorRegistryLinks.id, existingLink.id));
      }

      if (!isAvailable && !(await this.isRegistryReferenced(existing.id))) {
        await this.db
          .delete(integrationConnectorRegistryLinks)
          .where(eq(integrationConnectorRegistryLinks.registryId, existing.id));
        await this.db.delete(dockerRegistries).where(eq(dockerRegistries.id, existing.id));
        this.emitRegistry(existing.id, 'deleted');
      } else {
        this.emitRegistry(existing.id, 'updated');
      }
    }

    for (const link of links) {
      if (seenRegistryIds.has(link.registryId)) continue;
      if (!(await this.isRegistryReferenced(link.registryId))) {
        await this.db
          .delete(integrationConnectorRegistryLinks)
          .where(eq(integrationConnectorRegistryLinks.id, link.id));
        await this.db.delete(dockerRegistries).where(eq(dockerRegistries.id, link.registryId));
        this.emitRegistry(link.registryId, 'deleted');
        continue;
      }
      await this.db
        .update(integrationConnectorRegistryLinks)
        .set({ status: 'inaccessible', updatedAt: now })
        .where(eq(integrationConnectorRegistryLinks.id, link.id));
      this.emitRegistry(link.registryId, 'updated');
    }
  }

  async deleteGitLabConnectorRegistries(connectorId: string) {
    const links = await this.db
      .select()
      .from(integrationConnectorRegistryLinks)
      .where(eq(integrationConnectorRegistryLinks.connectorId, connectorId));
    const registryIds = [...new Set(links.map((link) => link.registryId))];
    if (registryIds.length === 0) return;

    await this.db.delete(dockerRegistries).where(inArray(dockerRegistries.id, registryIds));
    for (const registryId of registryIds) {
      this.emitRegistry(registryId, 'deleted');
    }
  }

  private async isRegistryReferenced(registryId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: dockerImageRegistryMappings.id })
      .from(dockerImageRegistryMappings)
      .where(eq(dockerImageRegistryMappings.registryId, registryId))
      .limit(1);
    return rows.length > 0;
  }

  private normalizeRegistryHost(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    try {
      const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      const url = new URL(withScheme);
      return url.host.toLowerCase();
    } catch {
      return trimmed
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, '')
        .toLowerCase();
    }
  }

  private normalizeOriginUrl(rawUrl: string): string {
    try {
      const url = this.normalizeRegistryBaseUrl(rawUrl);
      const protocol = url.protocol.toLowerCase();
      const hostname = url.hostname.toLowerCase();
      const port = url.port ? `:${url.port}` : '';
      const path = url.pathname.replace(/\/+$/, '');
      return `${protocol}//${hostname}${port}${path}`;
    } catch {
      return rawUrl.trim().replace(/\/+$/, '').toLowerCase();
    }
  }

  private registryOrigin(
    registry: Pick<DockerRegistryRow, 'url' | 'trustedAuthRealm' | 'scope' | 'nodeId' | 'username'>
  ): Record<string, string> {
    return {
      url: this.normalizeOriginUrl(registry.url),
      trustedAuthRealm: registry.trustedAuthRealm?.trim() || '',
      scope: registry.scope,
      nodeId: registry.scope === 'node' ? (registry.nodeId ?? '') : '',
      username: registry.username ?? '',
    };
  }

  private nextRegistryOrigin(
    existing: DockerRegistryRow,
    input: {
      url?: string;
      username?: string;
      trustedAuthRealm?: string;
      scope?: string;
      nodeId?: string;
    }
  ): Record<string, string> {
    const scope = input.scope ?? existing.scope;
    return this.registryOrigin({
      url: input.url ?? existing.url,
      trustedAuthRealm:
        input.trustedAuthRealm !== undefined ? input.trustedAuthRealm.trim() || null : existing.trustedAuthRealm,
      scope,
      nodeId: scope === 'global' ? null : input.nodeId !== undefined ? input.nodeId : existing.nodeId,
      username: input.username !== undefined ? input.username : existing.username,
    });
  }

  private assertOriginChangeHasReplacementPassword(
    existing: DockerRegistryRow,
    input: {
      url?: string;
      username?: string;
      password?: string;
      trustedAuthRealm?: string;
      scope?: string;
      nodeId?: string;
    }
  ) {
    if (!existing.encryptedPassword) return;
    const currentOrigin = this.registryOrigin(existing);
    const nextOrigin = this.nextRegistryOrigin(existing, input);
    const originChanged = Object.keys(currentOrigin).some((key) => currentOrigin[key] !== nextOrigin[key]);
    if (!originChanged || input.password?.trim()) return;

    throw new AppError(
      400,
      'CREDENTIAL_REENTRY_REQUIRED',
      'Registry origin changed. Re-enter the registry password to avoid reusing saved credentials against a different registry.'
    );
  }

  private assertRegistryVisibleFromNode(row: DockerRegistryRow, nodeId: string) {
    if (row.scope === 'global' || row.nodeId === nodeId) return;
    throw new AppError(
      403,
      'REGISTRY_NOT_AVAILABLE_FOR_NODE',
      'This Docker registry is not available for the selected node.'
    );
  }

  private extractRegistryHostFromImageRef(imageRef: string): string | null {
    const firstSegment = imageRef.split('/')[0] ?? '';
    if (!firstSegment) return null;
    if (firstSegment === 'localhost' || firstSegment.includes('.') || firstSegment.includes(':')) {
      return firstSegment.toLowerCase();
    }
    return null;
  }

  /**
   * Get base64-encoded Docker auth JSON for a registry (for image pull).
   * Returns the registry URL and auth string, or null if not found.
   */
  async getAuthForPull(
    registryId: string,
    targetNodeId: string,
    _context: RegistryUseContext = {}
  ): Promise<DockerRegistryAuthCandidate | null> {
    const row = await this.getRegistryRow(registryId);
    this.assertRegistryVisibleFromNode(row, targetNodeId);
    return this.authCandidateFromRegistry(row);
  }

  async rememberImageRegistry(nodeId: string, imageRef: string, registryId?: string | null): Promise<void> {
    if (!registryId) return;
    const imageRepository = this.extractImageRepository(imageRef);
    if (!imageRepository) return;

    try {
      await this.db
        .insert(dockerImageRegistryMappings)
        .values({ nodeId, imageRepository, registryId })
        .onConflictDoUpdate({
          target: [dockerImageRegistryMappings.nodeId, dockerImageRegistryMappings.imageRepository],
          set: { registryId, updatedAt: new Date() },
        });
    } catch (error) {
      logger.warn('Failed to remember Docker image registry mapping', {
        nodeId,
        imageRepository,
        registryId,
        error,
      });
    }
  }

  extractImageRepository(imageRef: string): string {
    const withoutDigest = imageRef.trim().split('@')[0] ?? '';
    const lastSlash = withoutDigest.lastIndexOf('/');
    const lastColon = withoutDigest.lastIndexOf(':');
    if (lastColon > lastSlash) {
      return withoutDigest.slice(0, lastColon);
    }
    return withoutDigest;
  }

  private async authCandidateFromRegistry(
    row: typeof dockerRegistries.$inferSelect
  ): Promise<DockerRegistryAuthCandidate | null> {
    const credentials = await this.resolveRegistryCredentials(row);
    if (!credentials) return null;
    const authJson = Buffer.from(
      JSON.stringify({
        username: credentials.username,
        password: credentials.password,
        serveraddress: row.url,
      })
    ).toString('base64');
    return { registryId: row.id, url: row.url.replace(/^https?:\/\//, '').replace(/\/+$/, ''), authJson };
  }

  private async toSafeRegistries(rows: DockerRegistryRow[]): Promise<SafeDockerRegistry[]> {
    const metadata = await this.loadIntegrationMetadata(rows);
    return rows.map((row) => this.toSafeRegistrySync(row, metadata.get(row.id)));
  }

  private async internalRegistryView() {
    if (!this.internalRegistryService) {
      throw new AppError(503, 'INTERNAL_REGISTRY_UNAVAILABLE', 'Internal Docker registry service is unavailable');
    }
    const state = await this.internalRegistryService.getState();
    return {
      id: INTERNAL_DOCKER_REGISTRY_ID,
      name: 'Opfield Internal Registry',
      url: 'registry:5000',
      username: null,
      trustedAuthRealm: null,
      source: 'system' as const,
      provider: 'gateway' as const,
      readOnly: true,
      scope: 'global',
      nodeId: null,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      internal: state,
    };
  }

  private assertNotInternalRegistry(id: string): void {
    if (id === INTERNAL_DOCKER_REGISTRY_ID) {
      throw new AppError(
        409,
        'REGISTRY_SYSTEM_MANAGED',
        'The Opfield internal registry is managed through internal registry settings'
      );
    }
  }

  private async toSafeRegistry(row: DockerRegistryRow): Promise<SafeDockerRegistry> {
    const metadata = await this.loadIntegrationMetadata([row]);
    return this.toSafeRegistrySync(row, metadata.get(row.id));
  }

  private toSafeRegistrySync(
    row: DockerRegistryRow,
    integration: SafeDockerRegistry['integration'] | undefined
  ): SafeDockerRegistry {
    const { encryptedPassword: _encryptedPassword, ...safe } = row;
    return integration ? { ...safe, integration } : safe;
  }

  private async loadIntegrationMetadata(
    rows: DockerRegistryRow[]
  ): Promise<Map<string, SafeDockerRegistry['integration']>> {
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return new Map();

    const rawLinks = await this.db
      .select()
      .from(integrationConnectorRegistryLinks)
      .where(inArray(integrationConnectorRegistryLinks.registryId, ids))
      .limit(ids.length);
    const links = Array.isArray(rawLinks) ? rawLinks.filter((link) => link.connectorId && link.registryId) : [];
    if (links.length === 0) return new Map();

    const connectorIds = [...new Set(links.map((link) => link.connectorId))];
    const connectors = connectorIds.length
      ? await this.db.select().from(integrationConnectors).where(inArray(integrationConnectors.id, connectorIds))
      : [];
    const connectorsById = new Map(connectors.map((connector) => [connector.id, connector]));

    return new Map(
      links.map((link) => {
        const connector = connectorsById.get(link.connectorId);
        return [link.registryId, this.toIntegrationMetadata(link, connector)];
      })
    );
  }

  private toIntegrationMetadata(
    link: IntegrationRegistryLinkRow,
    connector: IntegrationConnectorRow | undefined
  ): SafeDockerRegistry['integration'] {
    return {
      provider: 'gitlab',
      connectorId: link.connectorId,
      connectorName: connector?.name ?? null,
      connectorBaseUrl: connector?.baseUrl ?? null,
      projectRemoteId: link.projectRemoteId,
      projectFullPath: link.projectFullPath,
      remoteRegistryId: link.remoteRegistryId,
      status: link.status,
      lastSeenAt: link.lastSeenAt,
    };
  }

  private async assertManualRegistry(row: DockerRegistryRow) {
    if (row.source !== 'integration' && !row.readOnly) {
      const link = await this.getIntegrationLink(row.id);
      if (!link) return;
    }
    throw new AppError(
      409,
      'REGISTRY_MANAGED_BY_INTEGRATION',
      'This Docker registry is managed by an integration and cannot be edited here.'
    );
  }

  private async getIntegrationLink(registryId: string): Promise<IntegrationRegistryLinkRow | null> {
    const [link] = await this.db
      .select()
      .from(integrationConnectorRegistryLinks)
      .where(eq(integrationConnectorRegistryLinks.registryId, registryId))
      .limit(1);
    return link?.connectorId ? link : null;
  }

  private async resolveRegistryTrustedAuthRealm(row: DockerRegistryRow): Promise<string | null> {
    if (row.trustedAuthRealm) return row.trustedAuthRealm;
    if (!this.isGitLabIntegrationRegistry(row)) return null;

    const link = await this.getIntegrationLink(row.id);
    if (!link) return null;
    const [connector] = await this.db
      .select()
      .from(integrationConnectors)
      .where(eq(integrationConnectors.id, link.connectorId))
      .limit(1);
    return connector?.baseUrl ?? null;
  }

  private async resolveRegistryCredentials(
    row: DockerRegistryRow
  ): Promise<{ username: string; password: string } | null> {
    if (row.username && row.encryptedPassword) {
      return { username: row.username, password: this.decryptPassword(row.encryptedPassword) };
    }

    if (row.source !== 'integration' && !row.readOnly && !row.provider) return null;
    const link = await this.getIntegrationLink(row.id);
    if (!link || link.status !== 'available') return null;

    const credentials = await this.db
      .select()
      .from(integrationConnectorCredentials)
      .where(
        and(
          eq(integrationConnectorCredentials.connectorId, link.connectorId),
          eq(integrationConnectorCredentials.credentialType, 'gitlab_deploy_token')
        )
      )
      .limit(50);
    const now = Date.now();
    const normalizedRegistryUrl = this.normalizeOriginUrl(row.url);
    const credential = credentials
      .filter((item) => !item.expiresAt || item.expiresAt.getTime() > now)
      .find((item) => {
        if (item.registryUrl && this.normalizeOriginUrl(item.registryUrl) === normalizedRegistryUrl) return true;
        if (item.projectRemoteId && item.projectRemoteId === link.projectRemoteId) return true;
        if (item.projectFullPath && item.projectFullPath === link.projectFullPath) return true;
        return false;
      });

    if (!credential?.username) return this.resolveGitLabConnectorPatCredentials(row, link);
    return { username: credential.username, password: this.decryptPassword(credential.encryptedSecret) };
  }

  private async resolveGitLabConnectorPatCredentials(
    row: DockerRegistryRow,
    link: IntegrationRegistryLinkRow
  ): Promise<{ username: string; password: string } | null> {
    if (!this.isGitLabIntegrationRegistry(row)) return null;
    const [connector] = await this.db
      .select()
      .from(integrationConnectors)
      .where(eq(integrationConnectors.id, link.connectorId))
      .limit(1);
    if (!connector?.encryptedToken) return null;
    return { username: 'oauth2', password: this.decryptPassword(connector.encryptedToken) };
  }

  /**
   * Resolve registry auth either by explicit registryId or by inferring the registry
   * host from the image reference and matching it against saved registries visible
   * to the target node (global + node-specific).
   */
  async resolveAuthForImagePull(
    nodeId: string,
    imageRef: string,
    registryId?: string,
    context: RegistryUseContext = {}
  ): Promise<DockerRegistryAuthCandidate | null> {
    const [auth] = await this.resolveAuthCandidatesForImagePull(nodeId, imageRef, registryId, context);
    return auth ?? null;
  }

  async resolveAuthCandidatesForImagePull(
    nodeId: string,
    imageRef: string,
    registryId?: string,
    context: RegistryUseContext = {}
  ): Promise<DockerRegistryAuthCandidate[]> {
    if (registryId) {
      const auth = await this.getAuthForPull(registryId, nodeId, context);
      const imageRegistryHost = this.extractRegistryHostFromImageRef(imageRef);
      if (auth && imageRegistryHost && this.normalizeRegistryHost(auth.url) !== imageRegistryHost) {
        throw new AppError(
          400,
          'REGISTRY_IMAGE_HOST_MISMATCH',
          'The selected registry credentials do not match the image registry host.'
        );
      }
      return auth ? [auth] : [];
    }

    const imageRepository = this.extractImageRepository(imageRef);
    const imageRegistryHost = this.extractRegistryHostFromImageRef(imageRef);

    const rows = await this.db
      .select()
      .from(dockerRegistries)
      .where(or(eq(dockerRegistries.scope, 'global'), eq(dockerRegistries.nodeId, nodeId)));

    const candidates: DockerRegistryAuthCandidate[] = [];
    const mappedRegistryId = await this.resolveMappedRegistryId(nodeId, imageRepository);
    if (mappedRegistryId) {
      const mapped = rows.find((row) => row.id === mappedRegistryId);
      // A remembered mapping must not send credentials to a different host,
      // e.g. after the registry URL changed.
      const hostMatches = !mapped || !imageRegistryHost || this.normalizeRegistryHost(mapped.url) === imageRegistryHost;
      const auth = mapped && hostMatches ? await this.authCandidateFromRegistry(mapped) : null;
      if (auth) candidates.push(auth);
    }

    if (!imageRegistryHost) return candidates;

    const seen = new Set(candidates.map((candidate) => candidate.registryId));
    for (const row of rows
      .filter((row) => this.normalizeRegistryHost(row.url) === imageRegistryHost)
      .filter((row) => !seen.has(row.id))) {
      const auth = await this.authCandidateFromRegistry(row);
      if (!auth) continue;
      candidates.push({ ...auth, url: this.normalizeRegistryHost(row.url) });
      seen.add(row.id);
    }

    return candidates;
  }

  private async resolveMappedRegistryId(nodeId: string, imageRepository: string): Promise<string | null> {
    if (!imageRepository) return null;
    const [row] = await this.db
      .select({ registryId: dockerImageRegistryMappings.registryId })
      .from(dockerImageRegistryMappings)
      .where(
        and(
          eq(dockerImageRegistryMappings.nodeId, nodeId),
          eq(dockerImageRegistryMappings.imageRepository, imageRepository)
        )
      )
      .limit(1);

    return row?.registryId ?? null;
  }

  private decryptPassword(encryptedJson: string): string {
    const parsed = JSON.parse(encryptedJson) as { encryptedKey: string; encryptedDek: string };
    return this.cryptoService.decryptString(parsed);
  }
}
