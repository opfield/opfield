import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type CloudflareConnectorSettings,
  type IntegrationConnectorCapabilities,
  type IntegrationConnectorSettings,
  type IntegrationProvider,
  type integrationConnectorAllowlistEntries,
  type integrationConnectorCloudflareZones,
  type integrationConnectorProjects,
  integrationConnectors,
  type integrationGitHubOAuthSessions,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { DockerRegistryService } from '@/modules/docker/docker-registry.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { SSLService } from '@/modules/ssl/ssl.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { CloudflareZoneRef } from './cloudflare-client.js';
import { type GitTokenMaintenanceResult, runGitTokenMaintenance } from './git-token-maintenance.js';
import { GitLabUserCredentialsService } from './gitlab-user-credentials.service.js';
import type { ConnectorProvider, VcsConnectorAuth, VcsConnectorProvider } from './integration-provider.types.js';
import type { GitLabAllowlistEntryInput } from './integrations.schemas.js';

export type ConnectorRow = typeof integrationConnectors.$inferSelect;
export type AllowlistRow = typeof integrationConnectorAllowlistEntries.$inferSelect;
export type ProjectRow = typeof integrationConnectorProjects.$inferSelect;
export type CloudflareZoneRow = typeof integrationConnectorCloudflareZones.$inferSelect;
export type GitHubOAuthSessionRow = typeof integrationGitHubOAuthSessions.$inferSelect;
export type GitLabCredentialSource = 'system' | 'personal';

export interface ResolvedGitLabCredential {
  source: GitLabCredentialSource;
  auth: VcsConnectorAuth;
  scopes: string[];
}

export interface GenericGitExecutionContext {
  checkoutDir: string;
  askpassPath: string;
  username: string;
  token: string;
  repositoryUrl: string;
}

export const DEFAULT_GITLAB_CONNECTOR_SETTINGS: IntegrationConnectorSettings = {
  autoSyncEnabled: true,
  autoSyncIntervalSeconds: 900,
  cloneShallow: true,
  cloneDepth: 1,
  cloneLfs: false,
  cloneSubmodules: false,
  cloneMaxSizeMb: 1024,
  cloneTimeoutSeconds: 300,
};

export const DEFAULT_CLOUDFLARE_CONNECTOR_SETTINGS: CloudflareConnectorSettings = {
  autoSyncEnabled: true,
  autoSyncIntervalSeconds: 900,
  defaultTtl: 1,
  defaultProxied: true,
};

export const MAX_BACKOFF_SECONDS = 3600;
export const STALE_SYNC_SECONDS = 1800;
export const GITHUB_HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000;
export const GIT_CHECKOUT_TIMEOUT_MS = 30_000;
export const GIT_FILE_READ_LIMIT_BYTES = 262_144;
export const GIT_FILE_WRITE_LIMIT_BYTES = 524_288;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function githubApiUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  if (url.hostname === 'github.com') return `https://api.github.com${path}`;
  return new URL(`/api/v3${path}`, `${url.protocol}//${url.host}`).toString();
}

export function githubTokenCapabilities(scopes: readonly string[]): IntegrationConnectorCapabilities {
  const has = (...candidates: string[]) => candidates.some((scope) => scopes.includes(scope));
  const canUseRepository = has('repo', 'public_repo');
  return {
    projectsView: true,
    repoRead: canUseRepository,
    repoWrite: canUseRepository,
    ciView: has('repo', 'public_repo', 'workflow'),
    ciEdit: has('repo', 'public_repo', 'workflow'),
    variablesView: canUseRepository,
    variablesEdit: canUseRepository,
    webhooksManage: canUseRepository,
    registryView: has('repo', 'read:packages', 'write:packages'),
  };
}

export function genericGitCapabilities(): IntegrationConnectorCapabilities {
  return { projectsView: true, repoRead: true, repoWrite: true };
}

export interface SafeIntegrationConnector extends Omit<ConnectorRow, 'encryptedToken' | 'encryptedRefreshToken'> {
  hasToken: boolean;
  tokenMasked: string | null;
}

export interface GitHubOAuthCredential {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}

export interface GitHubOAuthSession {
  id: string;
  status: GitHubOAuthSessionRow['status'];
  userCode: string;
  verificationUri: string;
  pollIntervalSeconds: number;
  expiresAt: Date;
  connectorId: string | null;
  errorMessage: string | null;
}

export interface GitUserCredentialStatus {
  provider: 'github' | 'git';
  connectorId: string;
  connectorName: string;
  baseUrl: string;
  authorized: boolean;
  status: 'missing' | 'valid' | 'invalid';
  tokenMasked: string | null;
  username: string | null;
  authorizationUrl: string | null;
}

export interface DockerBuildSourceRepository {
  connectorId: string;
  connectorName: string;
  projectId: string;
  provider: 'gitlab' | 'github' | 'git';
  remoteId: string;
  fullPath: string;
  name: string;
  webUrl: string | null;
  defaultBranch: string | null;
  archived: boolean;
}

export interface DockerBuildSourceResolution extends DockerBuildSourceRepository {
  cloneUrl: string;
  branch: string;
  commitSha: string;
}

export interface DockerBuildCheckoutCredential {
  username: string;
  password: string;
}

export type ProjectRowInput = {
  remoteId: string;
  fullPath: string;
  name: string;
  webUrl?: string | null;
  visibility?: string | null;
  defaultBranch?: string | null;
  archived?: boolean;
};

export type RegistryRowInput = {
  remoteRegistryId?: string | null;
  projectRemoteId?: string | null;
  projectFullPath?: string | null;
  registryUrl: string;
  name: string;
};

export type CloudflareZoneInput = CloudflareZoneRef;

export class IntegrationsCoreService {
  protected eventBus?: EventBusService;
  protected dockerRegistryService?: DockerRegistryService;
  protected sslService?: SSLService;
  protected licensePolicy?: LicensePolicyService;
  protected readonly providers = new Map<IntegrationProvider, ConnectorProvider>();
  protected readonly syncLocks = new Set<string>();
  protected readonly gitLabUserCredentials: GitLabUserCredentialsService;

  constructor(
    protected db: DrizzleClient,
    protected auditService: AuditService,
    protected cryptoService: CryptoService,
    providers: ConnectorProvider[] = []
  ) {
    this.gitLabUserCredentials = new GitLabUserCredentialsService(db, cryptoService);
    for (const provider of providers) {
      this.providers.set(provider.provider, provider);
    }
  }

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  setDockerRegistryService(service: DockerRegistryService) {
    this.dockerRegistryService = service;
  }

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  setSSLService(service: SSLService) {
    this.sslService = service;
  }

  registerProvider(provider: ConnectorProvider) {
    this.providers.set(provider.provider, provider);
  }

  /**
   * Record GitLab token expiry and self-rotate tokens that expire within 14
   * days (see git-token-maintenance.ts). A no-op without a GitLab provider.
   */
  async maintainGitTokens(now = new Date()): Promise<GitTokenMaintenanceResult> {
    return runGitTokenMaintenance(
      {
        db: this.db,
        provider: this.providers.get('gitlab') as VcsConnectorProvider | undefined,
        credentials: this.gitLabUserCredentials,
        auditService: this.auditService,
        encryptToken: (token) => this.encryptToken(token),
        decryptToken: (encryptedToken) => this.decryptToken(encryptedToken),
        emitConnector: (id, action) => this.emitConnector(id, action),
      },
      now
    );
  }

  /** Expiry of a connector token as the provider reports it; null when unknown. */
  protected async describeConnectorTokenExpiry(
    provider: IntegrationProvider,
    auth: VcsConnectorAuth
  ): Promise<Date | null> {
    const implementation = this.providers.get(provider) as VcsConnectorProvider | undefined;
    if (!implementation?.describeToken) return null;
    try {
      return (await implementation.describeToken(auth))?.expiresAt ?? null;
    } catch {
      return null;
    }
  }

  isGitLabProjectAllowed(
    project: Pick<ProjectRow, 'remoteId' | 'fullPath' | 'name'>,
    allowlistEntries: AllowlistRow[]
  ) {
    return allowlistEntries.some((entry) => {
      if (entry.entryType === 'project') return entry.remoteId === project.remoteId;
      return project.fullPath === entry.fullPath || project.fullPath.startsWith(`${entry.fullPath}/`);
    });
  }

  protected normalizeBaseUrl(rawUrl: string): string {
    const parsed = new URL(rawUrl.trim());
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  }

  protected encryptToken(token: string): string {
    return JSON.stringify(this.cryptoService.encryptString(token));
  }

  protected decryptToken(encryptedToken: string): string {
    return this.cryptoService.decryptString(JSON.parse(encryptedToken));
  }

  protected tokenLast4(token: string): string {
    return token.slice(-4);
  }

  protected gitLabPatCreationUrl(baseUrl: string): string {
    const url = new URL('/-/user_settings/personal_access_tokens', `${baseUrl}/`);
    url.searchParams.set('name', 'Opfield AI');
    url.searchParams.set('description', 'Personal token for Opfield AI tools');
    url.searchParams.set('scopes', 'api');
    return url.toString();
  }

  protected systemAuthFor(row: ConnectorRow): VcsConnectorAuth {
    if (!row.encryptedToken) {
      throw new AppError(400, 'CONNECTOR_TOKEN_MISSING', 'GitLab connector token is not configured');
    }
    if (row.authMode === 'token' && row.tokenExpiresAt && row.tokenExpiresAt.getTime() <= Date.now()) {
      throw new AppError(
        409,
        'CONNECTOR_TOKEN_EXPIRED',
        `The access token of integration "${row.name}" expired on ${row.tokenExpiresAt.toISOString().slice(0, 10)}. Rotate the token to continue.`,
        { connectorId: row.id, expiredAt: row.tokenExpiresAt.toISOString() }
      );
    }
    return { baseUrl: row.baseUrl, token: this.decryptToken(row.encryptedToken) };
  }

  protected cloudflareTokenFor(row: ConnectorRow): string {
    if (!row.encryptedToken) {
      throw new AppError(400, 'CONNECTOR_TOKEN_MISSING', 'Cloudflare connector token is not configured');
    }
    return this.decryptToken(row.encryptedToken);
  }

  protected isDueForSync(row: ConnectorRow, now: Date): boolean {
    if (row.syncNextRetryAt && row.syncNextRetryAt > now) return false;
    const lastCompleted = row.syncFinishedAt ?? row.testedAt ?? null;
    if (!lastCompleted) return true;
    return now.getTime() - lastCompleted.getTime() >= row.settings.autoSyncIntervalSeconds * 1000;
  }

  protected isSyncRunning(row: ConnectorRow): boolean {
    if (row.syncStatus !== 'running' || !row.syncStartedAt) return false;
    return Date.now() - row.syncStartedAt.getTime() < STALE_SYNC_SECONDS * 1000;
  }

  protected async recordSyncOverlap(id: string) {
    await this.db
      .update(integrationConnectors)
      .set({ syncLastOverlapAt: new Date(), updatedAt: new Date() })
      .where(eq(integrationConnectors.id, id));
  }

  protected backoffSeconds(failureCount: number): number {
    return Math.min(MAX_BACKOFF_SECONDS, 60 * 2 ** Math.max(0, failureCount - 1));
  }

  protected getProvider(provider: IntegrationProvider): ConnectorProvider {
    const implementation = this.providers.get(provider);
    if (!implementation) {
      throw new AppError(
        501,
        'CONNECTOR_PROVIDER_UNAVAILABLE',
        `The ${provider} connector provider is not available yet`
      );
    }
    return implementation;
  }

  protected getVcsProvider(provider: IntegrationProvider): VcsConnectorProvider {
    const implementation = this.getProvider(provider);
    if (
      !('readFile' in implementation) ||
      !('commitFiles' in implementation) ||
      !('updateProjectSettings' in implementation) ||
      !('downloadRepositoryArchive' in implementation)
    ) {
      throw new AppError(501, 'CONNECTOR_VCS_PROVIDER_UNAVAILABLE', `The ${provider} VCS provider is not available`);
    }
    return implementation as VcsConnectorProvider;
  }

  protected dedupeAllowlistEntries(entries: GitLabAllowlistEntryInput[]): GitLabAllowlistEntryInput[] {
    const keyed = new Map<string, GitLabAllowlistEntryInput>();
    for (const entry of entries) {
      keyed.set(`${entry.entryType}:${entry.remoteId}`, entry);
    }
    return [...keyed.values()];
  }

  protected emitConnector(
    id: string,
    action: string,
    provider: IntegrationProvider = 'gitlab',
    extra: { name?: string; failureCount?: number; failureCode?: string } = {}
  ) {
    this.eventBus?.publish('integration.connector.changed', { id, provider, action, ...extra });
  }

  protected connectorFailureCode(error: unknown): string {
    if (error instanceof AppError) return error.code;
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (/401|authentication|unauthorized|token/i.test(message)) return 'authentication_failed';
    if (/403|forbidden|permission/i.test(message)) return 'authorization_failed';
    if (/429|rate.?limit/i.test(message)) return 'rate_limited';
    if (/timeout|network|unreachable|ECONN/i.test(message)) return 'provider_unreachable';
    return 'provider_error';
  }
}
