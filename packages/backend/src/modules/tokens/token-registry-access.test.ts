import { describe, expect, it, vi } from 'vitest';
import {
  assertTokenRegistryAccessAllowed,
  ownerMayUseRegistry,
  type RegistryRepositoryWorkload,
  registryAccessWorkloads,
  splitRegistryScopes,
  tokenAllowsRegistryAction,
  tokenRegistryAccess,
} from './token-registry-access.js';

const FOLDER = 'folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';
const APP: RegistryRepositoryWorkload = { kind: 'containers', nodeId: 'node-1', resourceId: 'app' };
const STACK: RegistryRepositoryWorkload = { kind: 'compose', nodeId: 'node-2', resourceId: 'stack' };

describe('token registry access', () => {
  it('reads the registry scopes of older tokens as registry access', () => {
    expect(
      tokenRegistryAccess({
        registryAccess: { push: ['team/web'] },
        scopes: ['nodes:details', 'docker:registries:internal:pull', 'docker:registries:internal:push:team/app'],
      })
    ).toEqual({ pull: 'all', push: ['team/app', 'team/web'] });
    expect(splitRegistryScopes(['proxy:view', 'docker:registries:internal:pull:team/app'])).toEqual({
      scopes: ['proxy:view'],
      registryAccess: { pull: ['team/app'] },
    });
  });

  it('gives every repository only to broad workload and image scopes', () => {
    expect(ownerMayUseRegistry(['docker:containers:view'], 'pull')).toBe(true);
    expect(ownerMayUseRegistry(['docker:images:view'], 'pull')).toBe(true);
    expect(ownerMayUseRegistry(['docker:compose:view'], 'pull')).toBe(true);
    expect(ownerMayUseRegistry(['docker:containers:edit'], 'push')).toBe(true);
    expect(ownerMayUseRegistry(['docker:compose:manage'], 'push')).toBe(true);
    expect(ownerMayUseRegistry(['docker:containers:view'], 'push')).toBe(false);
    // One container, folder, node or image is no longer every repository.
    expect(ownerMayUseRegistry([`docker:containers:view:${FOLDER}`], 'pull')).toBe(false);
    expect(ownerMayUseRegistry(['docker:images:view:node-1'], 'pull')).toBe(false);
    expect(ownerMayUseRegistry(['docker:containers:edit:node-1/app'], 'push')).toBe(false);
    // Creating a workload names a destination, not an existing workload.
    expect(ownerMayUseRegistry(['docker:containers:create'], 'pull')).toBe(false);
    expect(ownerMayUseRegistry(['docker:registries:view'], 'pull')).toBe(false);
  });

  it('gives a repository to view or change rights on a workload using it', () => {
    expect(ownerMayUseRegistry(['docker:containers:view:node-1/app'], 'pull', 'team/app', [APP])).toBe(true);
    expect(ownerMayUseRegistry(['docker:containers:view:node-1'], 'pull', 'team/app', [APP])).toBe(true);
    expect(ownerMayUseRegistry(['docker:images:view:node-1'], 'pull', 'team/app', [APP])).toBe(true);
    expect(ownerMayUseRegistry(['docker:containers:view:node-1/app'], 'push', 'team/app', [APP])).toBe(false);
    expect(ownerMayUseRegistry(['docker:containers:edit:node-1/app'], 'push', 'team/app', [APP])).toBe(true);
    expect(ownerMayUseRegistry(['docker:containers:manage:node-1/app'], 'push', 'team/app', [APP])).toBe(true);
    // Another container on the node, or no workload using the repository.
    expect(ownerMayUseRegistry(['docker:containers:view:node-1/other'], 'pull', 'team/app', [APP])).toBe(false);
    expect(ownerMayUseRegistry(['docker:containers:view:node-1/app'], 'pull', 'team/app', [])).toBe(false);
    // Compose projects use the Compose scopes.
    expect(ownerMayUseRegistry(['docker:compose:view:node-2/stack'], 'pull', 'team/stack', [STACK])).toBe(true);
    expect(ownerMayUseRegistry(['docker:containers:view:node-2/stack'], 'pull', 'team/stack', [STACK])).toBe(false);
    expect(ownerMayUseRegistry(['docker:compose:manage:node-2/stack'], 'push', 'team/stack', [STACK])).toBe(true);
    // A container without an access resource is reached by node-wide grants only.
    const unnamed: RegistryRepositoryWorkload = { kind: 'containers', nodeId: 'node-1', resourceId: null };
    expect(ownerMayUseRegistry(['docker:containers:view:node-1'], 'pull', 'team/app', [unnamed])).toBe(true);
    expect(ownerMayUseRegistry(['docker:containers:view:node-1/app'], 'pull', 'team/app', [unnamed])).toBe(false);
  });

  it('keeps a legacy registry grant per repository, and every repository only unqualified', () => {
    const owner = ['docker:registries:internal:push:team/app'];
    expect(ownerMayUseRegistry(owner, 'push', 'team/app')).toBe(true);
    expect(ownerMayUseRegistry(owner, 'push', 'team/other')).toBe(false);
    expect(ownerMayUseRegistry(owner, 'pull', 'team/app')).toBe(false);
    expect(ownerMayUseRegistry(owner, 'push')).toBe(false);
    expect(ownerMayUseRegistry(['docker:registries:internal:push'], 'push')).toBe(true);
  });

  it('refuses registry access the owner cannot give', () => {
    expect(() => assertTokenRegistryAccessAllowed({ pull: 'all', push: 'all' }, ['docker:containers:view'])).toThrow(
      expect.objectContaining({ statusCode: 403, code: 'REGISTRY_ACCESS_NOT_ALLOWED' })
    );
    expect(() =>
      assertTokenRegistryAccessAllowed({ pull: 'all', push: ['team/app'] }, ['docker:containers:manage'])
    ).not.toThrow();
    expect(() =>
      assertTokenRegistryAccessAllowed({ push: ['team/other'] }, ['docker:registries:internal:push:team/app'])
    ).toThrow(expect.objectContaining({ code: 'REGISTRY_ACCESS_NOT_ALLOWED' }));
    // A single container grant gives neither every repository nor one it has nothing to do with.
    expect(() => assertTokenRegistryAccessAllowed({ pull: 'all' }, ['docker:containers:view:node-1/app'])).toThrow(
      expect.objectContaining({ code: 'REGISTRY_ACCESS_NOT_ALLOWED' })
    );
    const workloads = new Map([['team/app', [APP]]]);
    expect(() =>
      assertTokenRegistryAccessAllowed({ pull: ['team/app'] }, ['docker:containers:view:node-1/app'], workloads)
    ).not.toThrow();
    expect(() =>
      assertTokenRegistryAccessAllowed(
        { pull: ['team/app', 'team/other'] },
        ['docker:containers:view:node-1/app'],
        workloads
      )
    ).toThrow(expect.objectContaining({ message: expect.stringContaining('pull team/other') }));
  });

  it('looks workloads up only for listed repositories the broad or legacy scopes leave open', async () => {
    const workloadsOf = vi.fn().mockResolvedValue([APP]);
    const workloads = await registryAccessWorkloads(
      { pull: ['team/app', 'team/legacy'], push: ['team/app'] },
      ['docker:registries:internal:pull:team/legacy'],
      workloadsOf
    );
    expect(workloadsOf.mock.calls).toEqual([['team/app']]);
    expect(workloads).toEqual(new Map([['team/app', [APP]]]));
    workloadsOf.mockClear();
    await registryAccessWorkloads({ pull: 'all', push: ['team/app'] }, ['docker:containers:manage'], workloadsOf);
    expect(workloadsOf).not.toHaveBeenCalled();
  });

  it('matches narrowed repositories exactly and rechecks the owner on every request', async () => {
    const workloadsOf = vi.fn().mockResolvedValue([]);
    const allows = (access: object, owner: string[], action: 'pull' | 'push', repository: string) =>
      tokenAllowsRegistryAction(access, owner, action, repository, workloadsOf);
    const access = { pull: ['team/app'], push: ['team/app'] };
    expect(await allows(access, ['docker:containers:manage'], 'push', 'team/app')).toBe(true);
    expect(await allows(access, ['docker:containers:manage'], 'pull', 'team/app-two')).toBe(false);
    expect(await allows(access, ['docker:containers:manage'], 'pull', 'team')).toBe(false);
    // The owner was demoted to a viewer: pull stays, push goes.
    expect(await allows(access, ['docker:containers:view'], 'pull', 'team/app')).toBe(true);
    expect(await allows(access, ['docker:containers:view'], 'push', 'team/app')).toBe(false);
    expect(await allows({}, ['docker:containers:manage'], 'pull', 'team/app')).toBe(false);
  });

  it('bounds tokens created under the earlier rule by the workloads their owner covers now', async () => {
    const workloadsOf = vi.fn(async (repository: string) => (repository === 'team/app' ? [APP] : []));
    // An `all` token of an owner who holds one container.
    const owner = ['docker:containers:edit:node-1/app', 'docker:containers:view:node-1/app'];
    expect(await tokenAllowsRegistryAction({ pull: 'all' }, owner, 'pull', 'team/app', workloadsOf)).toBe(true);
    expect(await tokenAllowsRegistryAction({ push: 'all' }, owner, 'push', 'team/app', workloadsOf)).toBe(true);
    expect(await tokenAllowsRegistryAction({ pull: 'all' }, owner, 'pull', 'other/app', workloadsOf)).toBe(false);
    expect(await tokenAllowsRegistryAction({ push: ['other/app'] }, owner, 'push', 'other/app', workloadsOf)).toBe(
      false
    );
  });
});
