import { and, eq } from 'drizzle-orm';
import { getEnv } from '@/config/env.js';
import {
  dockerSourceBindings,
  type IntegrationConnectorCapabilities,
  integrationConnectors,
  integrationGitHubOAuthSessions,
} from '@/db/schema/index.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { AppError } from '@/middleware/error-handler.js';
import type {
  GitConnectorCreateInput,
  GitConnectorPreviewTestInput,
  GitConnectorUpdateInput,
  GitHubConnectorCreateInput,
  GitHubConnectorPreviewTestInput,
  GitHubOAuthStartInput,
  GitUserCredentialAuthorizeInput,
} from './integrations.schemas.js';
import {
  type GitHubOAuthCredential,
  type GitHubOAuthSession,
  type GitUserCredentialStatus,
  genericGitCapabilities,
  githubApiUrl,
  githubTokenCapabilities,
} from './integrations.service.core.js';
import { IntegrationsGitRepositoryService } from './integrations.service.git-repositories.js';

function isForeignKeyViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if ('code' in current && current.code === '23503') return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}

export abstract class IntegrationsGitConnectorService extends IntegrationsGitRepositoryService {
  async createGitConnector(
    provider: 'github' | 'git',
    input: GitConnectorCreateInput | GitHubConnectorCreateInput,
    userId: string,
    authMode: 'token' | 'oauth' = 'token',
    oauthCredential?: GitHubOAuthCredential
  ) {
    const baseUrl = this.normalizeBaseUrl(input.baseUrl);
    const gitInput = provider === 'git' ? (input as GitConnectorCreateInput) : null;
    if (gitInput && !gitInput.username?.trim()) {
      throw new AppError(400, 'GIT_USERNAME_REQUIRED', 'Username is required for a generic Git connector');
    }
    const githubIdentity = provider === 'github' ? await this.validateGitHubToken(baseUrl, input.token) : null;
    const capabilities = githubIdentity?.capabilities ?? genericGitCapabilities();
    const allowlistEntries = this.dedupeAllowlistEntries(gitInput?.allowlistEntries ?? []);
    const [row] = await this.db
      .insert(integrationConnectors)
      .values({
        provider,
        name: input.name,
        baseUrl,
        enabled: input.enabled,
        authMode,
        username: githubIdentity?.username ?? gitInput?.username?.trim() ?? null,
        encryptedToken: this.encryptToken(input.token),
        encryptedRefreshToken: oauthCredential?.refreshToken ? this.encryptToken(oauthCredential.refreshToken) : null,
        tokenLast4: this.tokenLast4(input.token),
        tokenExpiresAt: oauthCredential?.tokenExpiresAt ?? null,
        refreshTokenExpiresAt: oauthCredential?.refreshTokenExpiresAt ?? null,
        allowlistMode: provider === 'github' ? 'all_visible' : 'selected',
        settings: {
          repositoryMode: 'multi_repository',
          autoSyncEnabled: provider === 'github',
          autoSyncIntervalSeconds: provider === 'github' ? 900 : 86_400,
        },
        capabilities,
        syncStatus: provider === 'github' ? 'success' : 'never',
        testedAt: new Date(),
      })
      .returning();
    await this.replaceAllowlistEntries(row.id, allowlistEntries);
    await this.auditService.log({
      action: `integrations.${provider}.connector.create`,
      userId,
      resourceType: 'integration-connector',
      resourceId: row.id,
      details: { name: row.name, baseUrl: row.baseUrl, repositoryMode: 'multi_repository', authMode },
    });
    this.emitConnector(row.id, 'created', provider);
    return { ...this.toSafeConnector(row), allowlistEntries };
  }

  async updateGitConnector(provider: 'github' | 'git', id: string, input: GitConnectorUpdateInput, userId: string) {
    const existing = await this.getConnectorRow(id, provider);
    const updates: Partial<typeof integrationConnectors.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.baseUrl !== undefined) updates.baseUrl = this.normalizeBaseUrl(input.baseUrl);
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.username !== undefined) updates.username = input.username?.trim() || null;
    if (input.authMode === 'token') {
      if (provider === 'github' && existing.authMode === 'oauth' && input.token === undefined) {
        throw new AppError(
          400,
          'GITHUB_TOKEN_REQUIRED',
          'A personal access token is required to switch this connector from OAuth'
        );
      }
      updates.authMode = 'token';
      updates.encryptedRefreshToken = null;
      updates.tokenExpiresAt = null;
      updates.refreshTokenExpiresAt = null;
    }
    if (input.token !== undefined) {
      if (provider === 'github') {
        const identity = await this.validateGitHubToken(
          input.baseUrl !== undefined ? this.normalizeBaseUrl(input.baseUrl) : existing.baseUrl,
          input.token
        );
        updates.capabilities = identity.capabilities;
        updates.username = identity.username;
      }
      updates.encryptedToken = this.encryptToken(input.token);
      updates.tokenLast4 = this.tokenLast4(input.token);
      updates.testedAt = new Date();
      updates.syncStatus = 'success';
      updates.syncLastError = null;
    }
    if (provider === 'git' && input.allowlistEntries !== undefined) {
      updates.allowlistMode = 'selected';
      updates.settings = {
        repositoryMode: 'multi_repository',
        autoSyncEnabled: false,
        autoSyncIntervalSeconds: 86_400,
      };
    }
    const [row] = await this.db
      .update(integrationConnectors)
      .set(updates)
      .where(eq(integrationConnectors.id, existing.id))
      .returning();
    if (provider === 'git' && input.allowlistEntries !== undefined) {
      await this.replaceAllowlistEntries(existing.id, this.dedupeAllowlistEntries(input.allowlistEntries));
    }
    await this.auditService.log({
      action: `integrations.${provider}.connector.update`,
      userId,
      resourceType: 'integration-connector',
      resourceId: existing.id,
      details: { name: row.name, authMode: row.authMode },
    });
    this.emitConnector(existing.id, 'updated', provider);
    return { ...this.toSafeConnector(row), allowlistEntries: await this.listAllowlistRows(existing.id) };
  }

  async testGitConnector(provider: 'github' | 'git', id: string, userId: string | null) {
    const row = await this.getConnectorRow(id, provider);
    try {
      if (!row.encryptedToken) {
        throw new AppError(400, 'CONNECTOR_CREDENTIAL_MISSING', `${row.name} has no credential`);
      }
      const token =
        provider === 'github' ? await this.resolveGitHubConnectorToken(row) : this.decryptToken(row.encryptedToken);
      let capabilities = row.capabilities;
      let username = row.username;
      if (provider === 'github') {
        const identity = await this.validateGitHubToken(row.baseUrl, token);
        capabilities = identity.capabilities;
        username = identity.username;
      } else {
        if (!username) throw new AppError(400, 'GIT_USERNAME_REQUIRED', 'Username is required for this connector');
        await this.validateGenericGitCredential(row, username, token);
        capabilities = genericGitCapabilities();
      }
      const [updated] = await this.db
        .update(integrationConnectors)
        .set({
          username,
          capabilities,
          syncStatus: 'success',
          syncLastError: null,
          testedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, provider)))
        .returning();
      if (userId) {
        await this.auditService.log({
          action: `integrations.${provider}.connector.test`,
          userId,
          resourceType: 'integration-connector',
          resourceId: id,
          details: { name: row.name, success: true },
        });
      }
      this.emitConnector(id, 'tested', provider);
      return { ...this.toSafeConnector(updated), allowlistEntries: await this.listAllowlistRows(id) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connector health check failed';
      await this.db
        .update(integrationConnectors)
        .set({ syncStatus: 'error', syncLastError: message, testedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, provider)));
      this.emitConnector(id, 'tested', provider);
      throw error;
    }
  }

  async syncGitConnector(provider: 'github' | 'git', id: string, userId: string) {
    // Repositories may have moved or been renamed: re-read provider data behind Git scope checks.
    this.invalidateRepositoryScopeCache(provider, id);
    const result = await this.testGitConnector(provider, id, userId);
    const [updated] = await this.db
      .update(integrationConnectors)
      .set({ syncFinishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, provider)))
      .returning();
    this.emitConnector(id, 'synced', provider);
    return { ...this.toSafeConnector(updated), allowlistEntries: result.allowlistEntries };
  }

  async deleteGitConnector(provider: 'github' | 'git', id: string, userId: string) {
    const row = await this.getConnectorRow(id, provider);
    const linkedBindings = await this.db
      .select({ id: dockerSourceBindings.id, targetKind: dockerSourceBindings.targetKind })
      .from(dockerSourceBindings)
      .where(eq(dockerSourceBindings.connectorId, id))
      .limit(5);
    if (linkedBindings.length > 0) {
      throw new AppError(
        409,
        'GIT_CONNECTOR_IN_USE',
        `${provider === 'github' ? 'GitHub' : 'Git'} connector is used by source projects or workloads and cannot be deleted`,
        { bindings: linkedBindings }
      );
    }
    try {
      await transactionWithScopeCleanup(this.db, (tx) =>
        tx
          .delete(integrationConnectors)
          .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, provider)))
      );
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new AppError(
          409,
          'GIT_CONNECTOR_IN_USE',
          `${provider === 'github' ? 'GitHub' : 'Git'} connector is used by source projects or workloads and cannot be deleted`
        );
      }
      throw error;
    }
    await this.auditService.log({
      action: `integrations.${provider}.connector.delete`,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name: row.name, baseUrl: row.baseUrl },
    });
    this.emitConnector(id, 'deleted', provider);
  }

  private async validateGitHubToken(
    baseUrl: string,
    token: string
  ): Promise<{ capabilities: IntegrationConnectorCapabilities; username: string; scopes: string[] }> {
    let response: Response;
    try {
      response = await fetch(githubApiUrl(baseUrl, '/user'), {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
      });
    } catch {
      throw new AppError(400, 'GITHUB_CONNECTION_FAILED', 'GitHub could not be reached');
    }
    if (!response.ok) {
      throw new AppError(400, 'GITHUB_AUTHORIZATION_INVALID', 'GitHub rejected this access token');
    }
    const body = (await response.json().catch(() => null)) as { login?: unknown } | null;
    const username = typeof body?.login === 'string' ? body.login.trim() : '';
    if (!username) {
      throw new AppError(400, 'GITHUB_AUTHORIZATION_INVALID', 'GitHub did not return the authorized username');
    }
    const scopes = (response.headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((scope) => scope.trim().toLowerCase())
      .filter(Boolean);
    return { capabilities: githubTokenCapabilities(scopes), username, scopes };
  }

  async previewGitHubConnectorTest(input: GitHubConnectorPreviewTestInput) {
    const baseUrl = this.normalizeBaseUrl(input.baseUrl);
    const identity = await this.validateGitHubToken(baseUrl, input.token);
    return {
      success: true as const,
      baseUrl,
      username: identity.username,
      capabilities: identity.capabilities,
    };
  }

  async previewGitConnectorTest(input: GitConnectorPreviewTestInput) {
    const baseUrl = this.normalizeBaseUrl(input.baseUrl);
    await this.validateGenericGitAccess(baseUrl, input.repositoryUrl, input.username, input.token);
    return {
      success: true as const,
      baseUrl,
      capabilities: genericGitCapabilities(),
    };
  }

  getGitHubOAuthAvailability() {
    return { available: true };
  }

  async startGitHubOAuth(input: GitHubOAuthStartInput, userId: string): Promise<GitHubOAuthSession> {
    const clientId = getEnv().GITHUB_OAUTH_CLIENT_ID;
    const baseUrl = 'https://github.com';
    let response: Response;
    try {
      response = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          scope: 'repo workflow read:org read:packages offline_access',
        }),
      });
    } catch {
      throw new AppError(502, 'GITHUB_OAUTH_START_FAILED', 'GitHub authorization could not be started');
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const deviceCode = typeof body?.device_code === 'string' ? body.device_code : '';
    const userCode = typeof body?.user_code === 'string' ? body.user_code : '';
    const verificationUri = typeof body?.verification_uri === 'string' ? body.verification_uri : '';
    const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : 900;
    const interval = typeof body?.interval === 'number' ? Math.max(1, body.interval) : 5;
    if (!response.ok || !deviceCode || !userCode || !verificationUri) {
      throw new AppError(502, 'GITHUB_OAUTH_START_FAILED', 'GitHub returned an incomplete authorization response');
    }
    const targetConnector = input.connectorId ? await this.getConnectorRow(input.connectorId, 'github') : null;
    const [row] = await this.db
      .insert(integrationGitHubOAuthSessions)
      .values({
        userId,
        encryptedDeviceCode: this.encryptToken(deviceCode),
        userCode,
        verificationUri,
        connectorDraft: {
          targetConnectorId: targetConnector?.id,
          name: input.name,
          enabled: input.enabled,
          baseUrl,
          repositoryMode: 'multi_repository',
          allowlistEntries: [],
        },
        pollIntervalSeconds: interval,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      })
      .returning();
    return this.toSafeGitHubOAuthSession(row);
  }

  async replaceGitHubConnectorAuthentication(
    id: string,
    input: { name: string; enabled: boolean },
    credential: GitHubOAuthCredential,
    userId: string
  ) {
    const existing = await this.getConnectorRow(id, 'github');
    const identity = await this.validateGitHubToken('https://github.com', credential.accessToken);
    const [row] = await this.db
      .update(integrationConnectors)
      .set({
        name: input.name,
        baseUrl: 'https://github.com',
        enabled: input.enabled,
        authMode: 'oauth',
        username: identity.username,
        encryptedToken: this.encryptToken(credential.accessToken),
        encryptedRefreshToken: credential.refreshToken ? this.encryptToken(credential.refreshToken) : null,
        tokenLast4: this.tokenLast4(credential.accessToken),
        tokenExpiresAt: credential.tokenExpiresAt,
        refreshTokenExpiresAt: credential.refreshTokenExpiresAt,
        capabilities: identity.capabilities,
        syncStatus: 'success',
        syncLastError: null,
        testedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, 'github')))
      .returning();
    await this.auditService.log({
      action: 'integrations.github.connector.reauthorize',
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name: row.name, previousAuthMode: existing.authMode, authMode: 'oauth' },
    });
    this.emitConnector(id, 'updated', 'github');
    return this.toSafeConnector(row);
  }

  async getGitHubOAuthStatus(id: string, userId: string): Promise<GitHubOAuthSession> {
    let row = await this.getGitHubOAuthSession(id, userId);
    if (row.status !== 'pending') return this.toSafeGitHubOAuthSession(row);
    if (row.expiresAt.getTime() <= Date.now()) {
      [row] = await this.db
        .update(integrationGitHubOAuthSessions)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(and(eq(integrationGitHubOAuthSessions.id, id), eq(integrationGitHubOAuthSessions.userId, userId)))
        .returning();
      return this.toSafeGitHubOAuthSession(row);
    }
    if (row.lastPolledAt && Date.now() - row.lastPolledAt.getTime() < Math.max(1, row.pollIntervalSeconds) * 1000) {
      return this.toSafeGitHubOAuthSession(row);
    }
    const [claimed] = await this.db
      .update(integrationGitHubOAuthSessions)
      .set({ status: 'processing', lastPolledAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(integrationGitHubOAuthSessions.id, id),
          eq(integrationGitHubOAuthSessions.userId, userId),
          eq(integrationGitHubOAuthSessions.status, 'pending')
        )
      )
      .returning();
    if (!claimed) return this.toSafeGitHubOAuthSession(await this.getGitHubOAuthSession(id, userId));
    return this.pollClaimedGitHubOAuthSession(claimed, userId);
  }

  async cancelGitHubOAuth(id: string, userId: string): Promise<GitHubOAuthSession> {
    const [row] = await this.db
      .update(integrationGitHubOAuthSessions)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(integrationGitHubOAuthSessions.id, id),
          eq(integrationGitHubOAuthSessions.userId, userId),
          eq(integrationGitHubOAuthSessions.status, 'pending')
        )
      )
      .returning();
    return this.toSafeGitHubOAuthSession(row ?? (await this.getGitHubOAuthSession(id, userId)));
  }

  async getGitUserCredentialStatus(
    provider: 'github' | 'git',
    connectorId: string,
    userId: string
  ): Promise<GitUserCredentialStatus> {
    const connector = await this.getConnectorRow(connectorId, provider);
    const status = await this.gitLabUserCredentials.getStatus(userId, connectorId);
    return {
      provider,
      connectorId,
      connectorName: connector.name,
      baseUrl: connector.baseUrl,
      authorized: status.authorized,
      status: status.status,
      tokenMasked: status.tokenMasked,
      username: status.gitlabUsername,
      authorizationUrl:
        provider === 'github'
          ? 'https://github.com/settings/tokens/new?description=Opfield%20AI&scopes=repo,workflow,read:org,read:packages'
          : null,
    };
  }

  async authorizeGitUserCredential(
    provider: 'github' | 'git',
    connectorId: string,
    userId: string,
    input: GitUserCredentialAuthorizeInput
  ): Promise<GitUserCredentialStatus> {
    const connector = await this.getConnectorRow(connectorId, provider);
    let username = input.username?.trim() ?? '';
    let scopes: string[] = [];
    if (provider === 'github') {
      const identity = await this.validateGitHubToken(connector.baseUrl, input.token);
      username = identity.username;
      scopes = identity.scopes;
    } else {
      if (!username) throw new AppError(400, 'GIT_USERNAME_REQUIRED', 'Username is required for Git authorization');
      await this.validateGenericGitCredential(connector, username, input.token);
    }
    await this.gitLabUserCredentials.replace(userId, connectorId, input.token, {
      gitlabUserId: username,
      gitlabUsername: username,
      tokenScopes: scopes,
      tokenExpiresAt: null,
    });
    await this.auditService.log({
      action: `integrations.${provider}.user_credential.authorize`,
      userId,
      resourceType: 'integration-connector',
      resourceId: connectorId,
      details: { connectorName: connector.name, username },
    });
    return this.getGitUserCredentialStatus(provider, connectorId, userId);
  }

  async disconnectGitUserCredential(provider: 'github' | 'git', connectorId: string, userId: string) {
    const connector = await this.getConnectorRow(connectorId, provider);
    const disconnected = await this.gitLabUserCredentials.disconnect(userId, connectorId);
    if (disconnected) {
      await this.auditService.log({
        action: `integrations.${provider}.user_credential.disconnect`,
        userId,
        resourceType: 'integration-connector',
        resourceId: connectorId,
        details: { connectorName: connector.name },
      });
    }
    return { disconnected };
  }
}
