import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { desc, eq, type SQL } from 'drizzle-orm';
import sodium from 'libsodium-wrappers';
import { integrationConnectors } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { gitGrantsCover, principalGitConnectorGrants, principalHasGitScopeOnConnector } from '@/lib/git-scopes.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import type { GitLabConnectorListQuery } from './integrations.schemas.js';
import {
  type ConnectorRow,
  GIT_FILE_READ_LIMIT_BYTES,
  GIT_FILE_WRITE_LIMIT_BYTES,
  isPlainRecord,
} from './integrations.service.core.js';
import { invalidateGitHubRepositoryOwners } from './integrations.service.git-support.js';
import {
  IntegrationsGitHubScopeTargetService,
  invalidateGitHubScopeTargets,
} from './integrations.service.github-scope-targets.js';
import { invalidateSourceRepositoryLists } from './source-repository-lists.js';

/**
 * A path inside a GitHub repository for the contents API. The path is joined into the API URL, and URL parsing
 * resolves `..` segments, literal or percent-encoded, so one could leave the granted repository for any other API
 * path the connector credential reaches. Such paths are refused before any request.
 */
export function githubRepositoryContentPath(raw: string | undefined, options: { required: boolean }): string {
  const path = (raw ?? '').trim().replace(/^\/+/, '');
  const decoded = decodePathOrNull(path);
  if ((options.required && !path) || decoded === null || decoded.includes('..') || decoded.includes('\0')) {
    throw new AppError(400, 'INVALID_REPOSITORY_PATH', 'Repository path must be relative');
  }
  return path;
}

function decodePathOrNull(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

export abstract class IntegrationsGitRepositoryService extends IntegrationsGitHubScopeTargetService {
  async listGitLabConnectors(
    _query?: GitLabConnectorListQuery
  ): Promise<import('./integrations.service.core.js').SafeIntegrationConnector[]> {
    return commercialModuleUnavailable();
  }

  async listGitConnectors(provider: 'github' | 'git', enabled?: boolean) {
    const conditions: SQL[] = [eq(integrationConnectors.provider, provider)];
    if (enabled !== undefined) conditions.push(eq(integrationConnectors.enabled, enabled));
    const rows = await this.db
      .select()
      .from(integrationConnectors)
      .where(buildWhere(conditions))
      .orderBy(desc(integrationConnectors.createdAt));
    return Promise.all(
      rows.map(async (row) => ({
        ...this.toSafeConnector(row),
        allowlistEntries: await this.listAllowlistRows(row.id),
      }))
    );
  }

  /**
   * Repositories the caller may read: integrations:github:repo:read on the connector lists everything the
   * credential sees; owner- and repo-qualified grants list only the repositories they cover.
   */
  async githubListRepositories(user: User, input: { connectorId: string }) {
    const { connector, token, systemCredentialLimit } = await this.resolveGitHubAccount(user, input.connectorId);
    const readGrants = principalGitConnectorGrants(user, 'integrations:github:repo:read', connector.id);
    const response = await this.githubConnectorRequest(
      connector,
      token,
      '/user/repos?per_page=100&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member'
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    if (!Array.isArray(body)) return [];
    const repositories = body.slice(0, 100).map((entry) => {
      const repository = isPlainRecord(entry) ? entry : {};
      const owner = isPlainRecord(repository.owner) ? repository.owner : {};
      const permissions = isPlainRecord(repository.permissions) ? repository.permissions : {};
      return {
        id: typeof repository.id === 'number' ? repository.id : null,
        name: typeof repository.name === 'string' ? repository.name : '',
        fullName: typeof repository.full_name === 'string' ? repository.full_name : '',
        repositoryUrl: typeof repository.html_url === 'string' ? repository.html_url : '',
        owner: typeof owner.login === 'string' ? owner.login : '',
        ownerId: typeof owner.id === 'number' ? String(owner.id) : null,
        defaultBranch: typeof repository.default_branch === 'string' ? repository.default_branch : null,
        private: repository.private === true,
        archived: repository.archived === true,
        updatedAt: typeof repository.updated_at === 'string' ? repository.updated_at : null,
        permissions: {
          admin: permissions.admin === true,
          maintain: permissions.maintain === true,
          push: permissions.push === true,
          pull: permissions.pull === true,
        },
      };
    });
    return repositories.filter((repository) => {
      const target = {
        repositoryId: repository.id === null ? null : String(repository.id),
        containerIds: repository.ownerId ? [repository.ownerId] : [],
      };
      return (
        gitGrantsCover(readGrants, target) && (!systemCredentialLimit || gitGrantsCover(systemCredentialLimit, target))
      );
    });
  }

  async githubListRepositoryTree(
    user: User,
    input: { connectorId: string; repositoryUrl: string; path?: string; ref?: string }
  ) {
    const { connector, repositoryUrl, token } = await this.resolveGitRepository(
      user,
      'github',
      input.connectorId,
      input.repositoryUrl
    );
    const { owner, repository } = this.githubRepositoryIdentity(repositoryUrl);
    const path = githubRepositoryContentPath(input.path, { required: false });
    const query = input.ref?.trim() ? `?ref=${encodeURIComponent(input.ref.trim())}` : '';
    const response = await this.githubConnectorRequest(
      connector,
      token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path}${query}`
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const entries = Array.isArray(body) ? body : [body];
    return entries.slice(0, 500).map((entry) => {
      const item = isPlainRecord(entry) ? entry : {};
      return {
        name: typeof item.name === 'string' ? item.name : '',
        path: typeof item.path === 'string' ? item.path : '',
        type: typeof item.type === 'string' ? item.type : 'unknown',
        size: typeof item.size === 'number' ? item.size : null,
        sha: typeof item.sha === 'string' ? item.sha : null,
      };
    });
  }

  async githubReadRepositoryFile(
    user: User,
    input: { connectorId: string; repositoryUrl: string; path: string; ref?: string }
  ) {
    const { connector, repositoryUrl, token } = await this.resolveGitRepository(
      user,
      'github',
      input.connectorId,
      input.repositoryUrl
    );
    const { owner, repository } = this.githubRepositoryIdentity(repositoryUrl);
    const path = githubRepositoryContentPath(input.path, { required: true });
    const query = input.ref?.trim() ? `?ref=${encodeURIComponent(input.ref.trim())}` : '';
    const response = await this.githubConnectorRequest(
      connector,
      token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path}${query}`
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const item = isPlainRecord(body) ? body : {};
    const encoded = typeof item.content === 'string' ? item.content.replace(/\s+/g, '') : '';
    if (item.encoding !== 'base64' || !encoded) {
      throw new AppError(400, 'GITHUB_FILE_UNAVAILABLE', 'GitHub did not return file content');
    }
    const content = Buffer.from(encoded, 'base64');
    if (content.byteLength > 262_144) {
      throw new AppError(413, 'GITHUB_FILE_TOO_LARGE', 'Repository file exceeds the 256 KiB AI read limit');
    }
    return {
      path: typeof item.path === 'string' ? item.path : path,
      sha: typeof item.sha === 'string' ? item.sha : null,
      size: content.byteLength,
      content: content.toString('utf8'),
    };
  }

  async githubListBranches(user: User, input: { connectorId: string; repositoryUrl: string }) {
    const context = await this.resolveGitRepository(user, 'github', input.connectorId, input.repositoryUrl);
    const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
    const response = await this.githubConnectorRequest(
      context.connector,
      context.token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches?per_page=100`
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    if (!Array.isArray(body)) return [];
    return body.slice(0, 100).map((entry) => {
      const branch = isPlainRecord(entry) ? entry : {};
      const commit = isPlainRecord(branch.commit) ? branch.commit : {};
      return {
        name: typeof branch.name === 'string' ? branch.name : '',
        commitSha: typeof commit.sha === 'string' ? commit.sha : null,
        protected: branch.protected === true,
      };
    });
  }

  /**
   * A new branch at fromRef (a branch, tag or commit SHA; the default branch when omitted). An existing branch is
   * never moved: 409 GITHUB_BRANCH_EXISTS.
   */
  async githubCreateBranch(
    user: User,
    input: { connectorId: string; repositoryUrl: string; branch: string; fromRef?: string }
  ) {
    this.assertGitHubRepositoryWrite(user, input.connectorId);
    const context = await this.resolveGitRepository(user, 'github', input.connectorId, input.repositoryUrl, 'write');
    const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
    const branch = this.gitRefName(input.branch);
    const fromRef = input.fromRef?.trim()
      ? this.gitRefName(input.fromRef)
      : await this.githubDefaultBranch(context.connector, context.token, base);
    const commitResponse = await this.githubConnectorRequest(
      context.connector,
      context.token,
      `${base}/commits/${encodeURIComponent(fromRef)}`
    );
    const commit = (await commitResponse.json().catch(() => null)) as unknown;
    if (commitResponse.status === 404 || commitResponse.status === 422) {
      throw new AppError(
        404,
        'GITHUB_REF_NOT_FOUND',
        `${fromRef} is not a branch, tag or commit of the repository. Pass fromRef as one of them (github_list_branches lists the branches), or omit it to start from the default branch.`
      );
    }
    if (!commitResponse.ok) throw this.githubRepositoryRequestError(commitResponse.status, commit);
    const sha = isPlainRecord(commit) && typeof commit.sha === 'string' ? commit.sha : null;
    if (!sha) throw new AppError(502, 'GITHUB_REF_UNRESOLVED', `GitHub returned no commit for ${fromRef}`);
    const response = await this.githubConnectorRequest(context.connector, context.token, `${base}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (response.status === 422 && isPlainRecord(body) && /already exists/i.test(String(body.message ?? ''))) {
      throw new AppError(
        409,
        'GITHUB_BRANCH_EXISTS',
        `Branch ${branch} already exists. Use it as it is, or choose another name.`
      );
    }
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    return { repositoryUrl: context.repositoryUrl, branch, fromRef, commitSha: sha };
  }

  /** Deletes a branch; the default branch is refused (GitHub also refuses protected ones). */
  async githubDeleteBranch(user: User, input: { connectorId: string; repositoryUrl: string; branch: string }) {
    this.assertGitHubRepositoryWrite(user, input.connectorId);
    const context = await this.resolveGitRepository(user, 'github', input.connectorId, input.repositoryUrl, 'write');
    const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
    const branch = this.gitRefName(input.branch);
    if (branch === (await this.githubDefaultBranch(context.connector, context.token, base))) {
      throw new AppError(
        409,
        'GITHUB_DEFAULT_BRANCH',
        `${branch} is the default branch of the repository and cannot be deleted here. Change the default branch on GitHub first.`
      );
    }
    const response = await this.githubConnectorRequest(
      context.connector,
      context.token,
      `${base}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'DELETE' }
    );
    if (response.status === 404 || response.status === 422) {
      const body = (await response.json().catch(() => null)) as unknown;
      const message = isPlainRecord(body) && typeof body.message === 'string' ? body.message : '';
      if (response.status === 404 || /does not exist|not found/i.test(message)) {
        throw new AppError(
          404,
          'GITHUB_BRANCH_NOT_FOUND',
          `Branch ${branch} does not exist (github_list_branches lists the branches)`
        );
      }
      throw this.githubRepositoryRequestError(response.status, body);
    }
    if (!response.ok) {
      throw this.githubRepositoryRequestError(response.status, await response.json().catch(() => null));
    }
    return { repositoryUrl: context.repositoryUrl, branch, deleted: true };
  }

  private assertGitHubRepositoryWrite(user: User, connectorId: string): void {
    if (!principalHasGitScopeOnConnector(user, 'integrations:github:repo:write', connectorId)) {
      throw new AppError(403, 'PERMISSION_DENIED', 'GitHub repository write scope is required', {
        requiredScope: 'integrations:github:repo:write',
      });
    }
  }

  private async githubDefaultBranch(connector: ConnectorRow, token: string, base: string): Promise<string> {
    const response = await this.githubConnectorRequest(connector, token, base);
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const defaultBranch = isPlainRecord(body) && typeof body.default_branch === 'string' ? body.default_branch : null;
    if (!defaultBranch) throw new AppError(502, 'GITHUB_DEFAULT_BRANCH_UNKNOWN', 'GitHub returned no default branch');
    return defaultBranch;
  }

  async githubListWorkflowRuns(
    user: User,
    input: { connectorId: string; repositoryUrl: string; branch?: string; status?: string }
  ) {
    const context = await this.resolveGitRepository(user, 'github', input.connectorId, input.repositoryUrl);
    const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
    const query = new URLSearchParams({ per_page: '50' });
    if (input.branch?.trim()) query.set('branch', input.branch.trim());
    if (input.status?.trim()) query.set('status', input.status.trim());
    const response = await this.githubConnectorRequest(
      context.connector,
      context.token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs?${query}`
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const runs = isPlainRecord(body) && Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
    return runs.slice(0, 50).map((entry) => {
      const run = isPlainRecord(entry) ? entry : {};
      return {
        id: typeof run.id === 'number' ? run.id : null,
        name: typeof run.name === 'string' ? run.name : '',
        event: typeof run.event === 'string' ? run.event : null,
        branch: typeof run.head_branch === 'string' ? run.head_branch : null,
        headSha: typeof run.head_sha === 'string' ? run.head_sha : null,
        status: typeof run.status === 'string' ? run.status : null,
        conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
        url: typeof run.html_url === 'string' ? run.html_url : null,
        createdAt: typeof run.created_at === 'string' ? run.created_at : null,
        updatedAt: typeof run.updated_at === 'string' ? run.updated_at : null,
      };
    });
  }

  async githubListActionsVariables(user: User, input: { connectorId: string; repositoryUrl: string }) {
    // Variable values are returned, and CI/CD variables are secrets: reading them needs repo:write.
    const context = await this.resolveGitRepository(user, 'github', input.connectorId, input.repositoryUrl, 'write');
    const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
    const response = await this.githubConnectorRequest(
      context.connector,
      context.token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/variables?per_page=100`
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const variables = isPlainRecord(body) && Array.isArray(body.variables) ? body.variables : [];
    return variables.slice(0, 100).map((entry) => {
      const variable = isPlainRecord(entry) ? entry : {};
      return {
        name: typeof variable.name === 'string' ? variable.name : '',
        value: typeof variable.value === 'string' ? variable.value : '',
        createdAt: typeof variable.created_at === 'string' ? variable.created_at : null,
        updatedAt: typeof variable.updated_at === 'string' ? variable.updated_at : null,
      };
    });
  }

  async githubListActionsSecrets(user: User, input: { connectorId: string; repositoryUrl: string }) {
    const context = await this.resolveGitRepository(user, 'github', input.connectorId, input.repositoryUrl);
    const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
    const response = await this.githubConnectorRequest(
      context.connector,
      context.token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/secrets?per_page=100`
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const secrets = isPlainRecord(body) && Array.isArray(body.secrets) ? body.secrets : [];
    return secrets.slice(0, 100).map((entry) => {
      const secret = isPlainRecord(entry) ? entry : {};
      return {
        name: typeof secret.name === 'string' ? secret.name : '',
        createdAt: typeof secret.created_at === 'string' ? secret.created_at : null,
        updatedAt: typeof secret.updated_at === 'string' ? secret.updated_at : null,
      };
    });
  }

  async githubUpsertRepositoryFile(
    user: User,
    input: {
      connectorId: string;
      repositoryUrl: string;
      path: string;
      branch: string;
      message: string;
      content: string;
    }
  ) {
    if (!principalHasGitScopeOnConnector(user, 'integrations:github:repo:write', input.connectorId)) {
      throw new AppError(403, 'PERMISSION_DENIED', 'GitHub repository write scope is required', {
        requiredScope: 'integrations:github:repo:write',
      });
    }
    const { connector, repositoryUrl, token } = await this.resolveGitRepository(
      user,
      'github',
      input.connectorId,
      input.repositoryUrl,
      'write'
    );
    const { owner, repository } = this.githubRepositoryIdentity(repositoryUrl);
    const path = githubRepositoryContentPath(input.path, { required: true });
    if (Buffer.byteLength(input.content, 'utf8') > 524_288) {
      throw new AppError(413, 'GITHUB_FILE_TOO_LARGE', 'Repository file exceeds the 512 KiB write limit');
    }
    const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path}`;
    const existingResponse = await this.githubConnectorRequest(
      connector,
      token,
      `${apiPath}?ref=${encodeURIComponent(input.branch.trim())}`
    );
    let sha: string | undefined;
    if (existingResponse.ok) {
      const existing = (await existingResponse.json().catch(() => null)) as unknown;
      if (isPlainRecord(existing) && typeof existing.sha === 'string') sha = existing.sha;
    } else if (existingResponse.status !== 404) {
      throw this.githubRepositoryRequestError(existingResponse.status, await existingResponse.json().catch(() => null));
    }
    const response = await this.githubConnectorRequest(connector, token, apiPath, {
      method: 'PUT',
      body: JSON.stringify({
        message: input.message.trim(),
        branch: input.branch.trim(),
        content: Buffer.from(input.content, 'utf8').toString('base64'),
        ...(sha ? { sha } : {}),
      }),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const result = isPlainRecord(body) ? body : {};
    const commit = isPlainRecord(result.commit) ? result.commit : {};
    const content = isPlainRecord(result.content) ? result.content : {};
    return {
      repositoryUrl,
      path,
      branch: input.branch.trim(),
      commitSha: typeof commit.sha === 'string' ? commit.sha : null,
      contentSha: typeof content.sha === 'string' ? content.sha : null,
    };
  }

  async githubUpsertActionsVariable(
    user: User,
    input: { connectorId: string; repositoryUrl: string; name: string; value: string }
  ) {
    if (!principalHasGitScopeOnConnector(user, 'integrations:github:repo:write', input.connectorId)) {
      throw new AppError(403, 'PERMISSION_DENIED', 'GitHub repository write scope is required', {
        requiredScope: 'integrations:github:repo:write',
      });
    }
    const context = await this.resolveGitRepository(user, 'github', input.connectorId, input.repositoryUrl, 'write');
    const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
    const name = this.githubActionsName(input.name);
    const basePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/variables`;
    const updateResponse = await this.githubConnectorRequest(
      context.connector,
      context.token,
      `${basePath}/${encodeURIComponent(name)}`,
      { method: 'PATCH', body: JSON.stringify({ name, value: input.value }) }
    );
    if (updateResponse.status === 404) {
      const createResponse = await this.githubConnectorRequest(context.connector, context.token, basePath, {
        method: 'POST',
        body: JSON.stringify({ name, value: input.value }),
      });
      if (!createResponse.ok) {
        throw this.githubRepositoryRequestError(createResponse.status, await createResponse.json().catch(() => null));
      }
    } else if (!updateResponse.ok) {
      throw this.githubRepositoryRequestError(updateResponse.status, await updateResponse.json().catch(() => null));
    }
    return { repositoryUrl: context.repositoryUrl, name, updated: true };
  }

  async githubUpsertActionsSecret(
    user: User,
    input: { connectorId: string; repositoryUrl: string; name: string; value: string }
  ) {
    if (!principalHasGitScopeOnConnector(user, 'integrations:github:repo:write', input.connectorId)) {
      throw new AppError(403, 'PERMISSION_DENIED', 'GitHub repository write scope is required', {
        requiredScope: 'integrations:github:repo:write',
      });
    }
    const context = await this.resolveGitRepository(user, 'github', input.connectorId, input.repositoryUrl, 'write');
    const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
    const name = this.githubActionsName(input.name);
    const basePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/secrets`;
    const keyResponse = await this.githubConnectorRequest(context.connector, context.token, `${basePath}/public-key`);
    const keyBody = (await keyResponse.json().catch(() => null)) as unknown;
    if (!keyResponse.ok) throw this.githubRepositoryRequestError(keyResponse.status, keyBody);
    if (!isPlainRecord(keyBody) || typeof keyBody.key !== 'string' || typeof keyBody.key_id !== 'string') {
      throw new AppError(502, 'GITHUB_SECRET_KEY_INVALID', 'GitHub returned an invalid Actions secret public key');
    }
    await sodium.ready;
    const encrypted = sodium.crypto_box_seal(
      sodium.from_string(input.value),
      sodium.from_base64(keyBody.key, sodium.base64_variants.ORIGINAL)
    );
    const response = await this.githubConnectorRequest(
      context.connector,
      context.token,
      `${basePath}/${encodeURIComponent(name)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          encrypted_value: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL),
          key_id: keyBody.key_id,
        }),
      }
    );
    if (!response.ok) {
      throw this.githubRepositoryRequestError(response.status, await response.json().catch(() => null));
    }
    return { repositoryUrl: context.repositoryUrl, name, updated: true };
  }

  /**
   * Forget cached provider data behind Git scope checks: a whole connector on sync, one repository when its
   * source webhook arrives, so a moved, transferred or renamed repository is read again.
   */
  invalidateRepositoryScopeCache(provider: string, connectorId: string, repositoryId?: string | null): void {
    if (!repositoryId) invalidateSourceRepositoryLists(connectorId);
    if (provider === 'github') {
      invalidateGitHubRepositoryOwners(connectorId, repositoryId);
      if (!repositoryId) invalidateGitHubScopeTargets(connectorId);
    } else if (provider === 'gitlab') {
      this.invalidateGitLabScopeCaches(connectorId, repositoryId ?? null);
    }
  }

  async gitListRemoteRefs(user: User, input: { connectorId: string; repositoryUrl: string }) {
    const { repositoryUrl, token, username } = await this.resolveGitRepository(
      user,
      'git',
      input.connectorId,
      input.repositoryUrl
    );
    const url = new URL(repositoryUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/info/refs`;
    url.searchParams.set('service', 'git-upload-pack');
    const response = await fetch(url, {
      headers: {
        accept: 'application/x-git-upload-pack-advertisement',
        authorization: `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`,
      },
    }).catch(() => null);
    if (!response) throw new AppError(502, 'GIT_CONNECTION_FAILED', 'Git host could not be reached');
    if (!response.ok)
      throw new AppError(400, 'GIT_AUTHORIZATION_INVALID', `Git host rejected access (${response.status})`);
    const advertised = await response.text();
    if (advertised.length > 1_048_576) {
      throw new AppError(413, 'GIT_REFS_TOO_LARGE', 'Git reference advertisement exceeds 1 MiB');
    }
    const refs = [...advertised.matchAll(/([0-9a-f]{40,64})\s+(refs\/(?:heads|tags)\/[^\0\n ]+)/gi)]
      .slice(0, 500)
      .map((match) => ({ sha: match[1], ref: match[2] }));
    return { repositoryUrl, refs };
  }

  /**
   * A new branch at fromRef (a branch or tag; the default branch when omitted), pushed only if no branch of that
   * name exists: an existing branch is never moved (409 GIT_BRANCH_EXISTS).
   */
  async gitCreateBranch(
    user: User,
    input: { connectorId: string; repositoryUrl: string; branch: string; fromRef?: string }
  ) {
    this.assertGenericGitRepositoryWrite(user, input.connectorId);
    const branch = this.gitRefName(input.branch);
    const fromRef = input.fromRef?.trim() ? this.gitRefName(input.fromRef) : undefined;
    const exists = await this.withGenericGitRemote(
      user,
      input,
      async (context) =>
        (
          await this.runGit(['ls-remote', '--heads', '--', context.repositoryUrl, `refs/heads/${branch}`], context)
        ).stdout.trim() !== '',
      'write'
    );
    if (exists) {
      throw new AppError(
        409,
        'GIT_BRANCH_EXISTS',
        `Branch ${branch} already exists. Use it as it is, or choose another name.`
      );
    }
    return this.withGenericGitCheckout(
      user,
      { ...input, ref: fromRef },
      async (context) => {
        const commitSha = (await this.runGit(['rev-parse', 'HEAD'], context)).stdout.trim();
        // The lease with no expected value pushes only while the branch does not exist.
        await this.runGit(
          ['push', `--force-with-lease=refs/heads/${branch}:`, 'origin', `HEAD:refs/heads/${branch}`],
          context
        );
        return { repositoryUrl: context.repositoryUrl, branch, fromRef: fromRef ?? null, commitSha };
      },
      'write'
    );
  }

  /** Deletes a branch of an allowed generic Git repository; the default branch (the remote HEAD) is refused. */
  async gitDeleteBranch(user: User, input: { connectorId: string; repositoryUrl: string; branch: string }) {
    this.assertGenericGitRepositoryWrite(user, input.connectorId);
    const branch = this.gitRefName(input.branch);
    return this.withGenericGitRemote(
      user,
      input,
      async (context) => {
        const advertised = (
          await this.runGit(
            ['ls-remote', '--symref', '--', context.repositoryUrl, 'HEAD', `refs/heads/${branch}`],
            context
          )
        ).stdout;
        const lines = advertised.split('\n');
        if (lines.includes(`ref: refs/heads/${branch}\tHEAD`)) {
          throw new AppError(
            409,
            'GIT_DEFAULT_BRANCH',
            `${branch} is the default branch of the repository and cannot be deleted here. Change the default branch on the Git host first.`
          );
        }
        if (!lines.some((line) => line.endsWith(`\trefs/heads/${branch}`))) {
          throw new AppError(
            404,
            'GIT_BRANCH_NOT_FOUND',
            `Branch ${branch} does not exist (git_list_remote_refs lists the branches)`
          );
        }
        // push needs a repository to run in, even to delete a remote ref.
        await this.runGit(['init', '-q'], context);
        await this.runGit(['push', '--', context.repositoryUrl, `:refs/heads/${branch}`], context);
        return { repositoryUrl: context.repositoryUrl, branch, deleted: true };
      },
      'write'
    );
  }

  private assertGenericGitRepositoryWrite(user: User, connectorId: string): void {
    if (!principalHasGitScopeOnConnector(user, 'integrations:git:repo:write', connectorId)) {
      throw new AppError(403, 'PERMISSION_DENIED', 'Git repository write scope is required', {
        requiredScope: 'integrations:git:repo:write',
      });
    }
  }

  async gitListRepositoryTree(
    user: User,
    input: { connectorId: string; repositoryUrl: string; path?: string; ref?: string }
  ) {
    return this.withGenericGitCheckout(user, input, async ({ checkoutDir }) => {
      const relativePath = this.repositoryRelativePath(input.path ?? '', true);
      const directory = await this.resolveRepositoryPath(checkoutDir, relativePath, 'directory');
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => !(relativePath === '' && entry.name === '.git'))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 500)
        .map((entry) => ({
          name: entry.name,
          path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
          type: entry.isDirectory() ? 'tree' : entry.isFile() ? 'blob' : entry.isSymbolicLink() ? 'symlink' : 'other',
        }));
    });
  }

  async gitReadRepositoryFile(
    user: User,
    input: { connectorId: string; repositoryUrl: string; path: string; ref?: string }
  ) {
    return this.withGenericGitCheckout(user, input, async ({ checkoutDir }) => {
      const relativePath = this.repositoryRelativePath(input.path, false);
      const filePath = await this.resolveRepositoryPath(checkoutDir, relativePath, 'file');
      const stats = await lstat(filePath);
      if (stats.size > GIT_FILE_READ_LIMIT_BYTES) {
        throw new AppError(413, 'GIT_FILE_TOO_LARGE', 'Repository file exceeds the 256 KiB AI read limit');
      }
      const content = await readFile(filePath);
      if (content.includes(0)) throw new AppError(400, 'GIT_FILE_BINARY', 'Repository file is not text');
      return {
        repositoryUrl: input.repositoryUrl,
        path: relativePath,
        size: content.byteLength,
        content: content.toString('utf8'),
      };
    });
  }

  async gitUpsertRepositoryFile(
    user: User,
    input: {
      connectorId: string;
      repositoryUrl: string;
      path: string;
      branch: string;
      message: string;
      content: string;
    }
  ) {
    if (!principalHasGitScopeOnConnector(user, 'integrations:git:repo:write', input.connectorId)) {
      throw new AppError(403, 'PERMISSION_DENIED', 'Git repository write scope is required', {
        requiredScope: 'integrations:git:repo:write',
      });
    }
    if (Buffer.byteLength(input.content, 'utf8') > GIT_FILE_WRITE_LIMIT_BYTES) {
      throw new AppError(413, 'GIT_FILE_TOO_LARGE', 'Repository file exceeds the 512 KiB write limit');
    }
    const branch = this.gitRefName(input.branch);
    return this.withGenericGitCheckout(
      user,
      { ...input, ref: branch },
      async (context) => {
        const relativePath = this.repositoryRelativePath(input.path, false);
        await this.assertNoRepositorySymlink(context.checkoutDir, relativePath);
        const filePath = resolve(context.checkoutDir, relativePath);
        await mkdir(dirname(filePath), { recursive: true });
        const existing = await readFile(filePath, 'utf8').catch(() => null);
        if (existing === input.content) {
          return { repositoryUrl: context.repositoryUrl, path: relativePath, branch, changed: false, commitSha: null };
        }
        await writeFile(filePath, input.content, { mode: 0o600 });
        await this.runGit(['config', 'user.name', 'Opfield AI'], context);
        await this.runGit(['config', 'user.email', 'opfield-ai@localhost'], context);
        await this.runGit(['add', '--', relativePath], context);
        await this.runGit(['commit', '-m', input.message.trim()], context);
        await this.runGit(['push', 'origin', `HEAD:${branch}`], context);
        const commitSha = (await this.runGit(['rev-parse', 'HEAD'], context)).stdout.trim();
        return { repositoryUrl: context.repositoryUrl, path: relativePath, branch, changed: true, commitSha };
      },
      'write'
    );
  }
}
