// The schema barrel first, in its production order: the per-table modules import each other circularly.
import '@/db/schema/index.js';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';
import { IntegrationsService } from './integrations.service.js';

// No MCP tool created or deleted a GitHub branch, so an agent could not "make its own branch and deploy it" (X-O-1).
const user = { id: 'user-1', scopes: ['integrations:github:repo:write'] } as unknown as User;
const REPO = 'https://github.com/acme/app';

function service(responses: Record<string, { status: number; body?: unknown }>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const instance = Object.create(IntegrationsService.prototype) as IntegrationsService;
  Object.assign(instance, {
    resolveGitRepository: vi.fn(async () => ({ connector: { id: 'c-1' }, repositoryUrl: REPO, token: 't' })),
    githubConnectorRequest: vi.fn(async (_connector: unknown, _token: string, path: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const response = responses[`${method} ${path}`] ?? { status: 404, body: { message: 'Not Found' } };
      return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
        status: response.status,
      });
    }),
  });
  return { instance, calls };
}

const repoInfo = { 'GET /repos/acme/app': { status: 200, body: { default_branch: 'main' } } };

describe('GitHub branches', () => {
  it('creates a branch from the default branch head', async () => {
    const { instance, calls } = service({
      ...repoInfo,
      'GET /repos/acme/app/commits/main': { status: 200, body: { sha: 'abc123' } },
      'POST /repos/acme/app/git/refs': { status: 201, body: { ref: 'refs/heads/feature/x' } },
    });
    await expect(
      instance.githubCreateBranch(user, { connectorId: 'c-1', repositoryUrl: REPO, branch: 'feature/x' })
    ).resolves.toEqual({ repositoryUrl: REPO, branch: 'feature/x', fromRef: 'main', commitSha: 'abc123' });
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: '/repos/acme/app/git/refs',
      body: { ref: 'refs/heads/feature/x', sha: 'abc123' },
    });
  });

  it('never moves an existing branch and names an unknown start', async () => {
    const exists = service({
      'GET /repos/acme/app/commits/v1': { status: 200, body: { sha: 'abc123' } },
      'POST /repos/acme/app/git/refs': { status: 422, body: { message: 'Reference already exists' } },
    });
    await expect(
      exists.instance.githubCreateBranch(user, { connectorId: 'c-1', repositoryUrl: REPO, branch: 'x', fromRef: 'v1' })
    ).rejects.toMatchObject({ statusCode: 409, code: 'GITHUB_BRANCH_EXISTS' });
    const unknown = service({});
    await expect(
      unknown.instance.githubCreateBranch(user, { connectorId: 'c-1', repositoryUrl: REPO, branch: 'x', fromRef: 'nope' })
    ).rejects.toMatchObject({ statusCode: 404, code: 'GITHUB_REF_NOT_FOUND' });
  });

  it('deletes a branch but never the default one, and needs repo:write', async () => {
    const { instance, calls } = service({
      ...repoInfo,
      'DELETE /repos/acme/app/git/refs/heads/feature/x': { status: 204 },
    });
    await expect(
      instance.githubDeleteBranch(user, { connectorId: 'c-1', repositoryUrl: REPO, branch: 'feature/x' })
    ).resolves.toEqual({ repositoryUrl: REPO, branch: 'feature/x', deleted: true });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/repos/acme/app/git/refs/heads/feature/x' });

    await expect(
      instance.githubDeleteBranch(user, { connectorId: 'c-1', repositoryUrl: REPO, branch: 'main' })
    ).rejects.toMatchObject({ statusCode: 409, code: 'GITHUB_DEFAULT_BRANCH' });
    await expect(
      instance.githubDeleteBranch({ ...user, scopes: ['integrations:github:repo:read'] } as User, {
        connectorId: 'c-1',
        repositoryUrl: REPO,
        branch: 'feature/x',
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
