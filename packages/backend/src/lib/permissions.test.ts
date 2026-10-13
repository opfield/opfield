import { describe, expect, it } from 'vitest';
import {
  boundScopes,
  canManageUser,
  canUseAI,
  hasAllScopes,
  hasAnyScope,
  hasScope,
  hasScopeBase,
  hasScopeForResource,
  isScopeSubset,
  privilegeBoundaryScopes,
} from './permissions.js';

describe('Scope-based permissions', () => {
  describe('hasScope', () => {
    it('keeps snapshot view and mutation rights isolated by VM', () => {
      expect(hasScope(['hosting:resources:view'], 'hosting:snapshots:view:vm')).toBe(false);
      expect(hasScope(['hosting:snapshots:view:vm'], 'hosting:snapshots:create:vm')).toBe(false);
      expect(hasScope(['hosting:snapshots:create:vm'], 'hosting:snapshots:view:vm')).toBe(true);
      expect(hasScope(['hosting:snapshots:create:vm'], 'hosting:snapshots:view:other')).toBe(false);
      expect(hasScope(['hosting:snapshots:create:vm'], 'hosting:snapshots:view')).toBe(false);
    });
    it('exact match', () => {
      expect(hasScope(['cert:read', 'cert:issue'], 'cert:issue')).toBe(true);
    });

    it('no match', () => {
      expect(hasScope(['cert:read'], 'cert:issue')).toBe(false);
    });

    it('hierarchical: parent grants child', () => {
      expect(hasScope(['nodes:details'], 'nodes:details:node-123')).toBe(true);
    });

    it('hierarchical: child does not grant parent', () => {
      expect(hasScope(['nodes:details:node-123'], 'nodes:details')).toBe(false);
    });

    it('hierarchical: exact resource match', () => {
      expect(hasScope(['nodes:details:node-123'], 'nodes:details:node-123')).toBe(true);
    });

    it('hierarchical: different resource no match', () => {
      expect(hasScope(['nodes:details:node-123'], 'nodes:details:node-456')).toBe(false);
    });

    it('lets a Docker node grant cover child resources without crossing nodes', () => {
      expect(hasScope(['docker:containers:view:node-1'], 'docker:containers:view:node-1/container-1')).toBe(true);
      expect(hasScope(['docker:containers:view:node-1/container-1'], 'docker:containers:view:node-1/container-2')).toBe(
        false
      );
      expect(hasScope(['docker:containers:view:node-1/container-1'], 'docker:containers:view:node-2/container-1')).toBe(
        false
      );
    });

    it('does not apply Docker child hierarchy to unrelated slash resource ids', () => {
      expect(hasScope(['proxy:view:folder'], 'proxy:view:folder/host')).toBe(false);
    });

    it('does not let an exact scope grant a different exact scope with the same prefix', () => {
      expect(hasScope(['proxy:templates:view'], 'proxy:templates:manage')).toBe(false);
      expect(hasScope(['proxy:unrestricted'], 'proxy:unrestricted:host-1')).toBe(true);
      expect(hasScope(['proxy:unrestricted:host-1'], 'proxy:unrestricted:host-1')).toBe(true);
      expect(hasScope(['proxy:unrestricted:host-1'], 'proxy:unrestricted:host-2')).toBe(false);
      expect(hasScope(['proxy:unrestricted:host-1'], 'proxy:raw:write:host-1')).toBe(false);
      expect(hasScope(['proxy:raw:write:host-1'], 'proxy:unrestricted:host-1')).toBe(false);
      expect(hasScope(['proxy:advanced'], 'proxy:unrestricted')).toBe(false);
    });

    it('never treats a retired scope name as a grant', () => {
      // Retired names are rewritten at input boundaries; permission checks see only the catalog.
      expect(hasScope(['proxy:advanced:bypass'], 'proxy:unrestricted')).toBe(false);
      expect(hasScope(['nodes:config:edit'], 'nodes:manage')).toBe(false);
      expect(hasScope(['nodes:config:edit:node-1'], 'nodes:manage:node-1')).toBe(false);
    });

    it('lets write scopes satisfy matching read scopes', () => {
      expect(hasScope(['settings:opfield:edit'], 'settings:opfield:view')).toBe(true);
      expect(hasScope(['proxy:edit'], 'proxy:view')).toBe(true);
      expect(hasScope(['proxy:edit'], 'proxy:view')).toBe(true);
      expect(hasScope(['databases:query:admin'], 'databases:query:read')).toBe(true);
      expect(hasScope(['inference:providers:manage'], 'inference:providers:view')).toBe(true);
      expect(hasScope(['inference:models:manage'], 'inference:providers:view')).toBe(true);
    });

    it('lets every action scope in a family satisfy the family view scope', () => {
      expect(hasScope(['proxy:delete'], 'proxy:view')).toBe(true);
      expect(hasScope(['notifications:webhooks:manage'], 'notifications:webhooks:view')).toBe(true);
      expect(hasScope(['databases:credentials:reveal'], 'databases:view')).toBe(true);
      expect(hasScope(['databases:credentials:reveal:db-1'], 'databases:view:db-1')).toBe(true);
      expect(hasScope(['logs:schemas:delete'], 'logs:schemas:view')).toBe(true);
      expect(hasScope(['docker:compose:manage:node-1/project-1'], 'docker:compose:view:node-1/project-1')).toBe(true);
      expect(hasScope(['docker:tasks:manage'], 'docker:tasks')).toBe(true);
      expect(hasScope(['nodes:console:node-1'], 'nodes:details:node-1')).toBe(true);
      expect(hasScope(['pki:cert:revoke:ca-1'], 'pki:cert:view:ca-1')).toBe(true);
      expect(hasScope(['integrations:gitlab:manage'], 'integrations:gitlab:view')).toBe(true);
      expect(hasScope(['status-page:incidents:update'], 'status-page:view')).toBe(true);
    });

    it('never lets creation reveal existing resources', () => {
      expect(hasScope(['proxy:create'], 'proxy:view')).toBe(false);
      expect(hasScope(['databases:create'], 'databases:view')).toBe(false);
      expect(hasScope(['status-page:incidents:create'], 'status-page:view')).toBe(false);
      expect(hasScope(['acl:create'], 'acl:view')).toBe(false);
      expect(hasScope(['docker:containers:create:node-1'], 'docker:containers:view:node-1/c1')).toBe(false);
    });

    it('keeps actions from satisfying sibling actions, other families, or folder item visibility', () => {
      expect(hasScope(['proxy:raw:write'], 'proxy:raw:read')).toBe(false);
      expect(hasScope(['proxy:raw:write:host-1'], 'proxy:raw:read:host-1')).toBe(false);
      expect(hasScope(['proxy:templates:view'], 'proxy:view')).toBe(false);
      expect(hasScope(['pages:settings:edit'], 'pages:view')).toBe(false);
      expect(hasScope(['proxy:folders:manage'], 'proxy:view')).toBe(false);
      expect(hasScope(['docker:folders:manage'], 'docker:containers:view')).toBe(false);
      expect(hasScope(['nodes:backups:execute'], 'nodes:details')).toBe(false);
    });

    it('keeps write-to-read implications inside the same resource boundary', () => {
      expect(hasScope(['proxy:edit:host-1'], 'proxy:view:host-1')).toBe(true);
      expect(hasScope(['proxy:edit:host-1'], 'proxy:view:host-2')).toBe(false);
      expect(hasScope(['proxy:edit:host-1'], 'proxy:view')).toBe(false);
      expect(hasScope(['databases:query:admin:db-1'], 'databases:query:write:db-1')).toBe(true);
      expect(hasScope(['databases:query:read:db-1'], 'databases:view:db-1')).toBe(true);
      expect(hasScope(['logs:environments:edit:env-1'], 'logs:environments:view:env-1')).toBe(true);
      expect(hasScope(['databases:query:admin:db-1'], 'databases:query:write')).toBe(false);
    });

    it('empty scopes', () => {
      expect(hasScope([], 'cert:read')).toBe(false);
    });
  });

  describe('hasAnyScope', () => {
    it('matches one of many', () => {
      expect(hasAnyScope(['cert:read'], ['admin:users', 'cert:read'])).toBe(true);
    });

    it('matches none', () => {
      expect(hasAnyScope(['cert:read'], ['admin:users', 'admin:audit'])).toBe(false);
    });
  });

  describe('hasScopeBase', () => {
    it('matches resource-scoped variants without treating sibling scopes as matches', () => {
      expect(hasScopeBase(['proxy:edit:host-1'], 'proxy:edit')).toBe(true);
      expect(hasScopeBase(['proxy:edit:host-1'], 'proxy:view')).toBe(true);
      expect(hasScopeBase(['proxy:raw:write:host-1'], 'proxy:raw:read')).toBe(false);
      expect(hasScopeBase(['proxy:unrestricted:host-1'], 'proxy:advanced')).toBe(false);
    });
  });

  describe('hasScopeForResource', () => {
    it('matches broad and exact resource-scoped scopes only', () => {
      expect(hasScopeForResource(['proxy:edit'], 'proxy:edit', 'host-1')).toBe(true);
      expect(hasScopeForResource(['proxy:edit:host-1'], 'proxy:edit', 'host-1')).toBe(true);
      expect(hasScopeForResource(['proxy:edit:host-2'], 'proxy:edit', 'host-1')).toBe(false);
    });
  });

  describe('hasAllScopes', () => {
    it('has all', () => {
      expect(hasAllScopes(['cert:read', 'cert:issue'], ['cert:read', 'cert:issue'])).toBe(true);
    });

    it('missing one', () => {
      expect(hasAllScopes(['cert:read'], ['cert:read', 'cert:issue'])).toBe(false);
    });
  });

  describe('canUseAI', () => {
    it('user with ai:workspace:use can use AI Workspace', () => {
      expect(canUseAI(['ai:workspace:use', 'cert:read'])).toBe(true);
    });

    it('user without ai:workspace:use cannot use AI Workspace', () => {
      expect(canUseAI(['cert:read', 'cert:issue'])).toBe(false);
    });

    it('does not treat inference access as AI Workspace access', () => {
      expect(canUseAI(['feat:ai:use'])).toBe(false);
    });
  });

  describe('isScopeSubset', () => {
    it('subset passes', () => {
      expect(isScopeSubset(['cert:read', 'cert:issue'], ['cert:read', 'cert:issue', 'ca:read'])).toBe(true);
    });

    it('resource-scoped is subset of parent', () => {
      expect(isScopeSubset(['nodes:details:node-123'], ['nodes:details'])).toBe(true);
    });

    it('non-subset fails', () => {
      expect(isScopeSubset(['admin:users'], ['cert:read', 'cert:issue'])).toBe(false);
    });
  });

  describe('boundScopes', () => {
    it('keeps exact scopes granted by both sides', () => {
      expect(boundScopes(['admin:users', 'nodes:details'], ['admin:users', 'nodes:details'])).toEqual([
        'admin:users',
        'nodes:details',
      ]);
    });

    it('downgrades a broad token to the current resource-scoped user permission', () => {
      expect(boundScopes(['nodes:details'], ['nodes:details:node-1'])).toEqual(['nodes:details:node-1']);
    });

    it('downgrades broad delegated read scopes to resource-scoped read scopes implied by write access', () => {
      expect(boundScopes(['proxy:view'], ['proxy:edit:host-1'])).toEqual(['proxy:view:host-1']);
      expect(boundScopes(['databases:view'], ['databases:edit:db-1'])).toEqual(['databases:view:db-1']);
      expect(boundScopes(['logs:environments:view'], ['logs:environments:edit:env-1'])).toEqual([
        'logs:environments:view:env-1',
      ]);
    });

    it('does not expand a delegated scope with permissions it merely implies', () => {
      expect(boundScopes(['databases:query:read'], ['databases:view', 'databases:query:read'])).toEqual([
        'databases:query:read',
      ]);
    });

    it('keeps a resource-scoped token when the current user still has the broad permission', () => {
      expect(boundScopes(['nodes:details:node-1'], ['nodes:details'])).toEqual(['nodes:details:node-1']);
    });

    it('does not bound a denied exact child scope from a grantable exact parent scope', () => {
      expect(boundScopes(['proxy:templates:manage'], ['proxy:templates:view'])).toEqual([]);
    });

    it('never lets a creation grant be delegated as a view grant', () => {
      const folder = 'folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';
      expect(boundScopes(['docker:containers:view'], ['docker:containers:create:node/n1'])).toEqual([]);
      expect(boundScopes(['proxy:view'], [`proxy:create:${folder}`])).toEqual([]);
      // Delegation checks (tokens, consent, groups, additional permissions) use the same rule.
      expect(isScopeSubset([`proxy:view:${folder}`], [`proxy:create:${folder}`])).toBe(false);
      expect(isScopeSubset(['docker:containers:view:node/n1'], ['docker:containers:create:node/n1'])).toBe(false);
      expect(isScopeSubset(['hosting:resources:view:account/a1'], ['hosting:resources:create:account/a1'])).toBe(false);
      expect(isScopeSubset([`ssl:cert:view:${folder}`], [`ssl:cert:issue:${folder}`])).toBe(false);
    });

    it('keeps a folder-restricted delegation inside the owner folder grant', () => {
      const folder = 'docker:containers:manage:folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';
      expect(boundScopes([folder], ['docker:containers:manage'])).toEqual([folder]);
      expect(boundScopes(['docker:containers:manage'], [folder])).toEqual([folder]);
      expect(isScopeSubset(['docker:containers:manage'], privilegeBoundaryScopes([folder], [folder], 'grant'))).toBe(
        false
      );
    });

    it('removes delegated scopes no longer granted by the current user', () => {
      expect(boundScopes(['admin:users', 'nodes:details:node-1'], ['nodes:details:node-2'])).toEqual([]);
    });

    it('does not merge different resource scopes', () => {
      expect(boundScopes(['nodes:details:node-1'], ['nodes:details:node-2'])).toEqual([]);
    });
  });

  describe('privilegeBoundaryScopes', () => {
    const token = ['admin:users', 'proxy:view'];
    const account = ['admin:users', 'proxy:view', 'proxy:edit', 'ai:workspace:use', 'admin:users:impersonate'];

    it('keeps session scopes unchanged', () => {
      expect(privilegeBoundaryScopes(token)).toEqual(token);
    });

    it('adds only the account-only scopes a token can never hold', () => {
      const scopes = privilegeBoundaryScopes(token, account);
      expect(scopes).toEqual(expect.arrayContaining([...token, 'ai:workspace:use', 'admin:users:impersonate']));
      expect(scopes).not.toContain('proxy:edit');
    });

    it('never lets a token grant impersonation, even when the owner holds it', () => {
      const grant = privilegeBoundaryScopes(token, account, 'grant');
      expect(grant).toContain('ai:workspace:use');
      expect(grant).not.toContain('admin:users:impersonate');
      expect(isScopeSubset(['admin:users:impersonate'], grant)).toBe(false);
      expect(privilegeBoundaryScopes(token, account)).toContain('admin:users:impersonate');
    });

    it('lets a token manage a user whose extra scopes are account-only and held by the owner', () => {
      const target = ['proxy:view', 'ai:workspace:use'];
      expect(canManageUser(token, target)).not.toBe(null);
      expect(canManageUser(privilegeBoundaryScopes(token, account), target)).toBe(null);
      expect(canManageUser(privilegeBoundaryScopes(token, ['admin:users', 'proxy:view']), target)).not.toBe(null);
      expect(canManageUser(privilegeBoundaryScopes(token, account), ['proxy:edit'])).not.toBe(null);
    });
  });

  describe('canManageUser', () => {
    it('admin can manage operator', () => {
      const admin = ['admin:users', 'admin:system', 'cert:read', 'cert:issue'];
      const operator = ['cert:read', 'cert:issue'];
      expect(canManageUser(admin, operator)).toBe(null);
    });

    it('operator cannot manage admin (admin has scopes operator lacks)', () => {
      const operator = ['admin:users', 'cert:read', 'cert:issue'];
      const admin = ['admin:users', 'admin:system', 'cert:read', 'cert:issue'];
      expect(canManageUser(operator, admin)).toMatch(/system administrator/);
    });

    it('admin:system is a hard shield', () => {
      // Even if actor has MORE scopes overall, lacking admin:system blocks management
      const actor = ['admin:users', 'cert:read', 'cert:issue', 'proxy:manage', 'ssl:manage'];
      const target = ['admin:system', 'cert:read'];
      expect(canManageUser(actor, target)).toMatch(/system administrator/);
    });

    it('admin:system holder can manage another admin:system holder', () => {
      const actor = ['admin:users', 'admin:system', 'cert:read'];
      const target = ['admin:system', 'cert:read'];
      expect(canManageUser(actor, target)).toBe(null);
    });

    it('cannot manage user with scope you lack', () => {
      const actor = ['admin:users', 'cert:read'];
      const target = ['cert:read', 'cert:issue']; // actor lacks cert:issue
      expect(canManageUser(actor, target)).toMatch(/permissions you do not possess/);
    });

    it('equal scopes allows management', () => {
      const scopes = ['admin:users', 'cert:read', 'cert:issue'];
      expect(canManageUser(scopes, scopes)).toBe(null);
    });
  });
});
