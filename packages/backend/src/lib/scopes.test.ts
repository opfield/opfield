import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasScope, hasScopeForResource } from './permissions.js';
import {
  ADMIN_SCOPES,
  ALL_SCOPES,
  API_TOKEN_SCOPES,
  BUILTIN_GROUPS,
  canonicalizeScopes,
  DEMO_ADMIN_SCOPES,
  extractBaseScope,
  FOLDER_MANAGE_SCOPES,
  FOLDER_SCOPABLE,
  GUEST_SCOPES,
  getBootstrapBuiltinGroups,
  isApiTokenScope,
  isMcpTokenScope,
  isValidBaseScope,
  MANUAL_APPROVAL_SCOPES,
  MCP_TOKEN_SCOPES,
  OPERATOR_SCOPES,
  PROGRAMMATIC_DENIED_BASE_SCOPES,
  RESOURCE_SCOPABLE,
  RETIRED_SCOPE_REPLACEMENTS,
  SYSTEM_ADMIN_SCOPES,
  USER_ONLY_SCOPES,
  VIEWER_SCOPES,
} from './scopes.js';

function frontendResourceScopableScopes(): string[] {
  const source = readFileSync(join(process.cwd(), '../frontend/src/types/scope-resource-restrictions.ts'), 'utf8');
  const match = source.match(/export const RESOURCE_SCOPABLE_SCOPES = \[([\s\S]*?)\] as const;/);
  if (!match) throw new Error('RESOURCE_SCOPABLE_SCOPES not found');
  // Expand every `...LIST` spread (FOLDER_CREATION_SCOPES, GIT_TARGET_SCOPES, ...) from the same module.
  const body = match[1].replace(/\.\.\.([A-Z_]+)/g, (_spread, name: string) => {
    const list = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
    if (!list) throw new Error(`${name} not found`);
    return list[1];
  });
  return [...body.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function frontendSelectableScopes(): string[] {
  const source = ['scope-token-core.ts', 'scope-token-platform.ts', 'scope-token-infrastructure.ts']
    .map((file) => readFileSync(join(process.cwd(), '../frontend/src/types', file), 'utf8'))
    .join('\n');
  const matches = [...source.matchAll(/export const [A-Z_]+_TOKEN_SCOPES = \[([\s\S]*?)\] as const;/g)];
  if (matches.length !== 3) throw new Error('TOKEN_SCOPES source modules not found');
  return matches.flatMap((match) => [...match[1].matchAll(/value: "([^"]+)"/g)].map((entry) => entry[1]));
}

function frontendProgrammaticDeniedScopes(): string[] {
  const source = readFileSync(join(process.cwd(), '../frontend/src/types/scope-token-catalog.ts'), 'utf8');
  const match = source.match(/const PROGRAMMATIC_DENIED_SCOPE_VALUES = new Set<string>\(\[([\s\S]*?)\]\);/);
  if (!match) throw new Error('PROGRAMMATIC_DENIED_SCOPE_VALUES not found');
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function listScopeRemovalMigration(): string {
  return readFileSync(join(process.cwd(), 'src/db/migrations/0030_remove_list_scopes.sql'), 'utf8');
}

function documentedScopes(): string[] {
  const source = readFileSync(join(process.cwd(), '../../SCOPES.md'), 'utf8');
  const section = source.match(/## Scope List([\s\S]*?)## API Token Delegation/);
  if (!section) throw new Error('SCOPES.md scope list not found');
  return [...section[1].matchAll(/\| `([^`]+)` \|/g)].map((entry) => entry[1]);
}

function documentedProgrammaticDeniedScopes(): string[] {
  const source = readFileSync(join(process.cwd(), '../../SCOPES.md'), 'utf8');
  const section = source.match(/## API Token Delegation([\s\S]*?)## OAuth Manual Approval Scopes/);
  if (!section) throw new Error('SCOPES.md API token delegation list not found');
  return [...section[1].matchAll(/\| `([^`]+)` \|/g)].map((entry) => entry[1]);
}

function documentedManualApprovalScopes(): string[] {
  const source = readFileSync(join(process.cwd(), '../../SCOPES.md'), 'utf8');
  const section = source.match(/## OAuth Manual Approval Scopes([\s\S]*)$/);
  if (!section) throw new Error('SCOPES.md OAuth manual approval list not found');
  return [...section[1].matchAll(/\| `([^`]+)` \|/g)].map((entry) => entry[1]);
}

function migratedProgrammaticStoredScopes(scopes: string[]): string[] {
  return canonicalizeScopes(
    scopes.filter(
      (scope) => !PROGRAMMATIC_DENIED_BASE_SCOPES.some((denied) => scope === denied || scope.startsWith(`${denied}:`))
    )
  );
}

describe('canonical scope definitions', () => {
  it('delegates the same scopes to Gateway MCP as to API tokens, including connector operations', () => {
    expect(MCP_TOKEN_SCOPES).toEqual(API_TOKEN_SCOPES);
    expect(MCP_TOKEN_SCOPES).toContain('nodes:details');
    expect(MCP_TOKEN_SCOPES).not.toContain('mcp:use');
    expect(MCP_TOKEN_SCOPES).toEqual(
      expect.arrayContaining([
        'integrations:gitlab:repo:write',
        'integrations:gitlab:use',
        'integrations:github:manage',
        'integrations:github:repo:write',
        'integrations:git:manage',
        'integrations:ssh:use',
        'integrations:ssh:manage',
        'integrations:cloudflare:manage',
        'integrations:hosting:manage',
      ])
    );
    expect(MCP_TOKEN_SCOPES).not.toContain('integrations:gitlab:sandbox:clone');
    expect(isMcpTokenScope('integrations:ssh:use')).toBe(true);
    expect(isMcpTokenScope('nodes:details:node-1')).toBe(true);
    expect(isMcpTokenScope('mcp:use')).toBe(false);
  });

  it('gives every Git provider the same delegable verbs', () => {
    for (const provider of ['gitlab', 'github', 'git']) {
      for (const verb of ['view', 'manage', 'use', 'repo:read', 'repo:write']) {
        const scope = `integrations:${provider}:${verb}`;
        expect(ALL_SCOPES, scope).toContain(scope);
        expect(isApiTokenScope(scope), scope).toBe(true);
        expect(isMcpTokenScope(scope), scope).toBe(true);
      }
      // Sync is part of manage; the system credential is `use`.
      expect(ALL_SCOPES).not.toContain(`integrations:${provider}:sync`);
      expect(ALL_SCOPES).not.toContain(`integrations:${provider}:system`);
      expect(MANUAL_APPROVAL_SCOPES).toEqual(
        expect.arrayContaining([`integrations:${provider}:use`, `integrations:${provider}:repo:write`])
      );
    }
    for (const scope of ['integrations:ssh:manage', 'integrations:ssh:use', 'integrations:cloudflare:sync']) {
      expect(isApiTokenScope(scope), scope).toBe(true);
      expect(isMcpTokenScope(scope), scope).toBe(true);
    }
    expect(ALL_SCOPES).toContain('integrations:gitlab:sandbox:clone');
    expect(ALL_SCOPES).not.toContain('integrations:ssh:sync');
  });

  it('gives built-in groups the Cloudflare sync scope when they manage Cloudflare', () => {
    for (const group of BUILTIN_GROUPS) {
      if (group.scopes.includes('integrations:cloudflare:manage')) {
        expect(group.scopes, group.name).toContain('integrations:cloudflare:sync');
      }
    }
    expect(DEMO_ADMIN_SCOPES.filter((scope) => scope.endsWith(':sync') && scope.startsWith('integrations:'))).toEqual(
      []
    );
  });

  it('applies the v2.11 catalog cleanup decisions', () => {
    for (const retired of Object.keys(RETIRED_SCOPE_REPLACEMENTS)) {
      expect(ALL_SCOPES, retired).not.toContain(retired);
    }
    // A: never-enforced SSL scopes are gone.
    expect(ALL_SCOPES).not.toContain('ssl:cert:revoke');
    expect(ALL_SCOPES).not.toContain('ssl:cert:export');
    // B: one view and one manage scope per notification area.
    expect(ALL_SCOPES.filter((scope) => scope.startsWith('notifications:'))).toEqual([
      'notifications:alerts:view',
      'notifications:alerts:manage',
      'notifications:webhooks:view',
      'notifications:webhooks:manage',
    ]);
    // C, D, I: logging catch-all and container config are removed; Docker folders are one scope.
    expect(ALL_SCOPES).not.toContain('logs:manage');
    expect(ALL_SCOPES).not.toContain('docker:containers:config');
    expect(ALL_SCOPES).toContain('docker:folders:manage');
    // E: general node control.
    expect(ALL_SCOPES).toContain('nodes:manage');
    expect(RESOURCE_SCOPABLE).toContain('nodes:manage');
    expect(FOLDER_SCOPABLE).toContain('nodes:manage');
    expect(MANUAL_APPROVAL_SCOPES).toContain('nodes:manage');
    // F: CA scopes qualifiable by CA ID or CA folder; key export needs manual approval.
    for (const scope of ['pki:ca:view', 'pki:ca:edit', 'pki:ca:export']) {
      expect(RESOURCE_SCOPABLE, scope).toContain(scope);
      expect(FOLDER_SCOPABLE, scope).toContain(scope);
      expect(isApiTokenScope(`${scope}:ca-1`), scope).toBe(true);
    }
    expect(MANUAL_APPROVAL_SCOPES).toContain('pki:ca:export');
    expect(MANUAL_APPROVAL_SCOPES).not.toContain('pki:ca:edit');
    expect(extractBaseScope('pki:ca:view:ca-1')).toBe('pki:ca:view');
    // H: proxy bypasses and template verbs are merged.
    expect(ALL_SCOPES).toContain('proxy:unrestricted');
    expect(FOLDER_SCOPABLE).toContain('proxy:unrestricted');
    expect(MANUAL_APPROVAL_SCOPES).toEqual(expect.arrayContaining(['proxy:unrestricted', 'proxy:templates:manage']));
    expect(ALL_SCOPES.filter((scope) => scope.startsWith('proxy:templates:'))).toEqual([
      'proxy:templates:view',
      'proxy:templates:manage',
      'proxy:templates:folders:manage',
    ]);
    // K, L: logging tokens and availability grants can target folders.
    for (const scope of [
      'logs:tokens:view',
      'logs:tokens:create',
      'logs:tokens:delete',
      'docker:availability:manage',
    ]) {
      expect(FOLDER_SCOPABLE, scope).toContain(scope);
    }
  });

  it('keeps built-in groups on the current catalog', () => {
    const catalog = new Set<string>(ALL_SCOPES);
    for (const group of [...BUILTIN_GROUPS, { name: 'demo-admin', scopes: DEMO_ADMIN_SCOPES }]) {
      expect(
        group.scopes.filter((scope) => !catalog.has(scope)),
        group.name
      ).toEqual([]);
    }
    expect(DEMO_ADMIN_SCOPES).not.toContain('pki:ca:export');
    expect(DEMO_ADMIN_SCOPES).not.toContain('proxy:unrestricted');
    expect(DEMO_ADMIN_SCOPES).not.toContain('integrations:gitlab:repo:read');
    expect(OPERATOR_SCOPES).not.toContain('proxy:templates:manage');
    expect(ADMIN_SCOPES).toEqual(expect.arrayContaining(['pki:ca:edit', 'pki:ca:export', 'nodes:manage']));
    // Ingress groups have their own scopes: admins hold them, operators view them to place routes and domains on
    // them, and node permissions of the other groups do not reveal them.
    expect(ADMIN_SCOPES).toEqual(expect.arrayContaining(['ingress:groups:view', 'ingress:groups:manage']));
    expect(OPERATOR_SCOPES.filter((scope) => scope.startsWith('ingress:'))).toEqual(['ingress:groups:view']);
    expect(VIEWER_SCOPES.filter((scope) => scope.startsWith('ingress:'))).toEqual([]);
  });

  it('keeps system-admin on every canonical scope', () => {
    expect(SYSTEM_ADMIN_SCOPES).toEqual([...ALL_SCOPES]);
    expect(SYSTEM_ADMIN_SCOPES).toContain('ai:skills:manage');
    expect(OPERATOR_SCOPES).not.toContain('ai:skills:manage');
  });

  it('keeps the public scope reference aligned with canonical scope contracts', () => {
    expect(documentedScopes()).toEqual([...ALL_SCOPES]);
    expect(documentedProgrammaticDeniedScopes()).toEqual([...PROGRAMMATIC_DENIED_BASE_SCOPES]);
    expect(documentedManualApprovalScopes()).toEqual([...MANUAL_APPROVAL_SCOPES]);
  });

  it('keeps frontend scope selectors aligned', () => {
    expect(frontendSelectableScopes().sort()).toEqual([...ALL_SCOPES].sort());
    expect(frontendProgrammaticDeniedScopes().sort()).toEqual([...PROGRAMMATIC_DENIED_BASE_SCOPES].sort());
  });

  it('keeps built-in admin broad while excluding protected operational scopes', () => {
    expect(ADMIN_SCOPES).toContain('settings:opfield:view');
    expect(ADMIN_SCOPES).not.toContain('settings:opfield:edit');
    expect(ADMIN_SCOPES).toContain('housekeeping:run');
    expect(ADMIN_SCOPES).not.toContain('housekeeping:configure');
    expect(ADMIN_SCOPES).toContain('docker:registries:view');
    expect(ADMIN_SCOPES).not.toContain('docker:registries:create');
    expect(ADMIN_SCOPES).not.toContain('docker:registries:edit');
    expect(ADMIN_SCOPES).not.toContain('docker:registries:delete');
    expect(ADMIN_SCOPES).toContain('docker:containers:mounts');
    expect(ADMIN_SCOPES).toContain('proxy:unrestricted');
    expect(ADMIN_SCOPES).toContain('audit:siem:view');
    expect(ADMIN_SCOPES).toContain('audit:siem:manage');
    expect(ADMIN_SCOPES).not.toContain('nodes:console');
    expect(SYSTEM_ADMIN_SCOPES).toContain('admin:users:impersonate');
    expect(ADMIN_SCOPES).not.toContain('admin:users:impersonate');
    expect(OPERATOR_SCOPES).not.toContain('proxy:unrestricted');
    expect(OPERATOR_SCOPES).toContain('proxy:maintenance:bypass');
    expect(OPERATOR_SCOPES).not.toContain('nodes:console');
    expect(ADMIN_SCOPES).not.toContain('admin:system');
    expect(hasScope(['admin:users'], 'admin:users:impersonate')).toBe(false);
    expect(hasScope(['admin:users:impersonate'], 'admin:users:impersonate')).toBe(true);
  });

  it('keeps demo-admin visible but strips system, secret, execution, and external automation capabilities', () => {
    expect(DEMO_ADMIN_SCOPES).toContain('docker:containers:create');
    expect(DEMO_ADMIN_SCOPES).toContain('admin:update');
    expect(DEMO_ADMIN_SCOPES).not.toContain('admin:system');
    expect(DEMO_ADMIN_SCOPES).not.toContain('nodes:console');
    expect(DEMO_ADMIN_SCOPES).not.toContain('nodes:files:read');
    expect(DEMO_ADMIN_SCOPES).not.toContain('nodes:config:view');
    expect(DEMO_ADMIN_SCOPES).not.toContain('docker:containers:secrets');
    expect(DEMO_ADMIN_SCOPES).not.toContain('docker:containers:environment');
    expect(DEMO_ADMIN_SCOPES).not.toContain('docker:containers:webhooks');
    expect(DEMO_ADMIN_SCOPES).not.toContain('logs:tokens:view');
    expect(DEMO_ADMIN_SCOPES).not.toContain('notifications:webhooks:view');
    expect(DEMO_ADMIN_SCOPES).not.toContain('admin:audit');
    expect(DEMO_ADMIN_SCOPES).not.toContain('audit:siem:view');
    expect(DEMO_ADMIN_SCOPES).not.toContain('databases:credentials:reveal');
    expect(DEMO_ADMIN_SCOPES).not.toContain('mcp:use');
    expect(DEMO_ADMIN_SCOPES.some((scope) => scope.startsWith('ai:'))).toBe(false);
    expect(DEMO_ADMIN_SCOPES.some((scope) => scope.startsWith('inference:'))).toBe(false);
  });

  it('does not create demo-admin metadata on standard installations', () => {
    expect(getBootstrapBuiltinGroups('standard').map((group) => group.name)).not.toContain('demo-admin');
    expect(getBootstrapBuiltinGroups('demo').map((group) => group.name)).toContain('demo-admin');
  });

  it('grants Docker mount editing only to built-in admin tiers by default', () => {
    expect(SYSTEM_ADMIN_SCOPES).toContain('docker:containers:mounts');
    expect(ADMIN_SCOPES).toContain('docker:containers:mounts');
    expect(OPERATOR_SCOPES).not.toContain('docker:containers:mounts');
    expect(ALL_SCOPES).toContain('docker:containers:mounts');
  });

  it('applies the Compose project scope contract', () => {
    const composeScopes = [
      'docker:compose:view',
      'docker:compose:create',
      'docker:compose:manage',
      'docker:compose:delete',
    ];
    for (const scope of composeScopes) {
      expect(SYSTEM_ADMIN_SCOPES).toContain(scope);
      expect(ADMIN_SCOPES).toContain(scope);
      expect(RESOURCE_SCOPABLE).toContain(scope);
      expect(isApiTokenScope(`${scope}:node-1/project-1`)).toBe(true);
    }
    expect(OPERATOR_SCOPES).toEqual(
      expect.arrayContaining(['docker:compose:view', 'docker:compose:create', 'docker:compose:manage'])
    );
    expect(OPERATOR_SCOPES).not.toContain('docker:compose:delete');
    expect(VIEWER_SCOPES).toContain('docker:compose:view');
    expect(VIEWER_SCOPES).not.toContain('docker:compose:manage');
    expect(FOLDER_SCOPABLE).toEqual(
      expect.arrayContaining(['docker:compose:view', 'docker:compose:manage', 'docker:compose:delete'])
    );
    expect(FOLDER_SCOPABLE).toContain('docker:compose:create');
  });

  it('uses Docker operation scopes instead of provider-specific GitLab registry scopes', () => {
    expect(ALL_SCOPES).not.toContain('integrations:gitlab:registry:use');
    expect(ALL_SCOPES).not.toContain('integrations:gitlab:registry:view');
    expect(SYSTEM_ADMIN_SCOPES).not.toContain('integrations:gitlab:registry:use');
    expect(SYSTEM_ADMIN_SCOPES).not.toContain('integrations:gitlab:registry:view');
    expect(ADMIN_SCOPES).not.toContain('integrations:gitlab:registry:use');
    expect(ADMIN_SCOPES).not.toContain('integrations:gitlab:registry:view');
    expect(ADMIN_SCOPES).toContain('docker:registries:view');
    expect(VIEWER_SCOPES).not.toContain('integrations:gitlab:registry:use');
    expect(VIEWER_SCOPES).not.toContain('integrations:gitlab:registry:view');
    expect(VIEWER_SCOPES).toContain('docker:registries:view');
    expect(VIEWER_SCOPES).not.toContain('integrations:gitlab:registry:manage');
  });

  it('keeps the built-in guest group authenticated but unprivileged', () => {
    expect(GUEST_SCOPES).toEqual([]);
    expect(BUILTIN_GROUPS.at(-1)).toMatchObject({
      name: 'guest',
      scopes: [],
    });
  });

  it('applies the Pages built-in, resource, folder, and API-token scope contract', () => {
    const operatorPages = [
      'pages:view',
      'pages:create',
      'pages:edit',
      'pages:deploy',
      'pages:deployments:manage',
      'pages:tags:manage',
      'pages:folders:manage',
      'pages:settings:view',
    ];
    for (const scope of operatorPages) {
      expect(SYSTEM_ADMIN_SCOPES).toContain(scope);
      expect(ADMIN_SCOPES).toContain(scope);
      expect(OPERATOR_SCOPES).toContain(scope);
    }
    expect(OPERATOR_SCOPES).not.toContain('pages:delete');
    expect(OPERATOR_SCOPES).not.toContain('pages:tokens:manage');
    expect(OPERATOR_SCOPES).not.toContain('pages:settings:edit');
    expect(VIEWER_SCOPES).toEqual(expect.arrayContaining(['pages:view', 'pages:settings:view']));
    expect(VIEWER_SCOPES).not.toContain('pages:edit');

    const projectScopes = [
      'pages:view',
      'pages:edit',
      'pages:delete',
      'pages:deploy',
      'pages:deployments:manage',
      'pages:tags:manage',
      'pages:tokens:manage',
    ];
    for (const scope of projectScopes) {
      expect(RESOURCE_SCOPABLE).toContain(scope);
      expect(FOLDER_SCOPABLE).toContain(scope);
      expect(isApiTokenScope(`${scope}:project-1`)).toBe(true);
    }
    expect(RESOURCE_SCOPABLE).toContain('pages:create');
    expect(FOLDER_SCOPABLE).toContain('pages:create');
    for (const scope of ['pages:settings:view', 'pages:settings:edit']) {
      expect(RESOURCE_SCOPABLE).not.toContain(scope);
      expect(FOLDER_SCOPABLE).not.toContain(scope);
    }
    // Folder management takes a folder qualifier only (it manages that folder's subfolders).
    expect(FOLDER_SCOPABLE).toContain('pages:folders:manage');
    expect(canonicalizeScopes(['pages:view:project-2', 'pages:view:project-1'])).toEqual([
      'pages:view:project-1',
      'pages:view:project-2',
    ]);
    expect(extractBaseScope('pages:deployments:manage:project-1')).toBe('pages:deployments:manage');
  });

  it('grants Docker migrations only to admin tiers and requires manual approval', () => {
    expect(SYSTEM_ADMIN_SCOPES).toContain('docker:containers:migrate');
    expect(ADMIN_SCOPES).toContain('docker:containers:migrate');
    expect(OPERATOR_SCOPES).not.toContain('docker:containers:migrate');
    expect(RESOURCE_SCOPABLE).toContain('docker:containers:migrate');
    expect(MANUAL_APPROVAL_SCOPES).toContain('docker:containers:migrate');
    expect(hasScopeForResource([...ADMIN_SCOPES], 'docker:containers:migrate', 'node-1')).toBe(true);
    expect(hasScopeForResource(['docker:containers:migrate:node-1'], 'docker:containers:migrate', 'node-1')).toBe(true);
    expect(hasScopeForResource(['docker:containers:migrate:node-1'], 'docker:containers:migrate', 'node-2')).toBe(
      false
    );
  });

  it('protects Docker archive export with a resource-scoped manual-approval permission', () => {
    expect(SYSTEM_ADMIN_SCOPES).toContain('docker:containers:export');
    expect(ADMIN_SCOPES).toContain('docker:containers:export');
    expect(OPERATOR_SCOPES).not.toContain('docker:containers:export');
    expect(RESOURCE_SCOPABLE).toContain('docker:containers:export');
    expect(MANUAL_APPROVAL_SCOPES).toContain('docker:containers:export');
    expect(
      hasScopeForResource(
        ['docker:containers:export:node-1/container-1'],
        'docker:containers:export',
        'node-1/container-1'
      )
    ).toBe(true);
    expect(
      hasScopeForResource(
        ['docker:containers:export:node-1/container-1'],
        'docker:containers:export',
        'node-1/container-2'
      )
    ).toBe(false);
  });

  it('protects Docker volume archive export with a resource-scoped manual-approval permission', () => {
    expect(SYSTEM_ADMIN_SCOPES).toContain('docker:volumes:export');
    expect(ADMIN_SCOPES).toContain('docker:volumes:export');
    expect(OPERATOR_SCOPES).not.toContain('docker:volumes:export');
    expect(RESOURCE_SCOPABLE).toContain('docker:volumes:export');
    expect(MANUAL_APPROVAL_SCOPES).toContain('docker:volumes:export');
    expect(hasScopeForResource(['docker:volumes:export:node-1'], 'docker:volumes:export', 'node-1')).toBe(true);
    expect(hasScopeForResource(['docker:volumes:export:node-1'], 'docker:volumes:export', 'node-2')).toBe(false);
  });

  it('lets the operator group run backups without revealing storage credentials or administering buckets', () => {
    // What backup policy create/run and retention need on the storage side.
    for (const scope of ['storage:objects:write', 'storage:credentials:use']) {
      expect(hasScopeForResource([...OPERATOR_SCOPES], scope, 'storage-1'), scope).toBe(true);
    }
    for (const scope of ['databases:backups:manage', 'databases:backups:run', 'nodes:backups:execute']) {
      expect(OPERATOR_SCOPES).toContain(scope);
    }
    expect(OPERATOR_SCOPES).not.toContain('storage:credentials:reveal');
    expect(OPERATOR_SCOPES).not.toContain('storage:objects:admin');
    expect(ADMIN_SCOPES).toContain('storage:credentials:use');
    expect(MANUAL_APPROVAL_SCOPES).not.toContain('storage:credentials:use');
    // Existing custom groups keep working: reveal implies use, globally and per resource.
    expect(hasScopeForResource(['storage:credentials:reveal'], 'storage:credentials:use', 'storage-1')).toBe(true);
    expect(hasScopeForResource(['storage:credentials:reveal:storage-1'], 'storage:credentials:use', 'storage-1')).toBe(
      true
    );
    expect(hasScopeForResource(['storage:credentials:reveal:storage-1'], 'storage:credentials:use', 'storage-2')).toBe(
      false
    );
    expect(hasScope(['storage:credentials:use'], 'storage:credentials:reveal')).toBe(false);
  });

  it('requires explicit grants for high-risk host node consoles', () => {
    expect(ALL_SCOPES).toContain('nodes:console');
    expect(SYSTEM_ADMIN_SCOPES).toContain('nodes:console');
    expect(RESOURCE_SCOPABLE).toContain('nodes:console');
    expect(MANUAL_APPROVAL_SCOPES).toContain('nodes:console');
    expect(ADMIN_SCOPES).not.toContain('nodes:console');
    expect(OPERATOR_SCOPES).not.toContain('nodes:console');
    expect(hasScopeForResource([...ADMIN_SCOPES], 'nodes:console', 'node-1')).toBe(false);
    expect(hasScopeForResource([...OPERATOR_SCOPES], 'nodes:console', 'node-1')).toBe(false);
    expect(hasScopeForResource(['nodes:console:node-1'], 'nodes:console', 'node-1')).toBe(true);
    expect(hasScopeForResource(['nodes:console:node-1'], 'nodes:console', 'node-2')).toBe(false);
    expect(hasScopeForResource(['nodes:console'], 'nodes:console', 'node-2')).toBe(true);
  });

  it('keeps only browser- and identity-bound scopes out of API tokens', () => {
    expect(PROGRAMMATIC_DENIED_BASE_SCOPES).toEqual([
      ...USER_ONLY_SCOPES,
      'admin:users:impersonate',
      'integrations:gitlab:sandbox:clone',
    ]);
    expect(ALL_SCOPES).not.toContain('admin:housekeeping');
    expect(ALL_SCOPES).not.toContain('inference:use');
    expect(ALL_SCOPES).not.toContain('inference:usage:view:self');
    expect(ALL_SCOPES).not.toContain('inference:tokens:manage');
    expect(isValidBaseScope('inference:use')).toBe(false);
    expect(isValidBaseScope('inference:usage:view:self')).toBe(false);

    for (const scope of USER_ONLY_SCOPES) {
      expect(API_TOKEN_SCOPES, scope).not.toContain(scope);
      expect(isApiTokenScope(scope), scope).toBe(false);
    }
    expect(isApiTokenScope('admin:users:impersonate')).toBe(false);
    expect(isApiTokenScope('admin:users:impersonate:user-1')).toBe(false);
    expect(isApiTokenScope('integrations:gitlab:sandbox:clone')).toBe(false);

    for (const scope of [
      'admin:system',
      'admin:users',
      'admin:groups',
      'settings:opfield:view',
      'settings:opfield:edit',
      'integrations:gitlab:manage',
      'integrations:gitlab:use',
      'integrations:hosting:manage',
      'hosting:resources:create',
      'hosting:resources:delete',
      'hosting:snapshots:restore',
      'hosting:billing:view',
      'hosting:billing:topup',
      'proxy:raw:read',
      'proxy:raw:write',
      'proxy:unrestricted',
      'proxy:maintenance:bypass',
      'nodes:config:view',
      'nodes:manage',
      'nodes:files:read',
      'nodes:files:write',
      'databases:credentials:reveal',
      'feat:ai:use',
      'inference:providers:view',
      'inference:providers:manage',
      'inference:models:manage',
      'inference:limits:manage',
      'inference:usage:view',
    ]) {
      expect(API_TOKEN_SCOPES, scope).toContain(scope);
      expect(isApiTokenScope(scope), scope).toBe(true);
    }
    expect(isApiTokenScope('proxy:raw:write:host-1')).toBe(true);
    expect(isApiTokenScope('proxy:unrestricted:host-1')).toBe(true);
    expect(isApiTokenScope('nodes:manage:node-1')).toBe(true);
    expect(isApiTokenScope('admin:users:team-1')).toBe(true);
  });

  it('grants inference administration only to built-in admin tiers by default', () => {
    for (const scope of [
      'inference:providers:view',
      'inference:providers:manage',
      'inference:models:manage',
      'inference:limits:manage',
      'inference:usage:view',
    ]) {
      expect(SYSTEM_ADMIN_SCOPES).toContain(scope);
      expect(ADMIN_SCOPES).toContain(scope);
      expect(OPERATOR_SCOPES).not.toContain(scope);
    }

    for (const scopes of [SYSTEM_ADMIN_SCOPES, ADMIN_SCOPES, OPERATOR_SCOPES, VIEWER_SCOPES]) {
      expect(scopes).toContain('ai:workspace:use');
    }

    expect(SYSTEM_ADMIN_SCOPES).toContain('feat:ai:use');
    expect(ADMIN_SCOPES).toContain('feat:ai:use');
    expect(OPERATOR_SCOPES).toContain('feat:ai:use');
    expect(VIEWER_SCOPES).not.toContain('feat:ai:use');

    expect(isValidBaseScope('inference:tokens:create')).toBe(false);
    expect(isValidBaseScope('inference:tokens:revoke')).toBe(false);
  });

  it('keeps OAuth manual approval scopes focused on high-risk delegated access', () => {
    expect(MANUAL_APPROVAL_SCOPES).toEqual([
      'storage:credentials:reveal',
      'storage:iam',
      'databases:backups:restore',
      'pki:ca:create:root',
      'pki:ca:create:intermediate',
      'pki:ca:export',
      'pki:ca:revoke:root',
      'pki:ca:revoke:intermediate',
      'pki:cert:export',
      'ssl:cert:issue',
      'ssl:cert:delete',
      'proxy:raw:write',
      'proxy:unrestricted',
      'proxy:templates:manage',
      'pages:delete',
      'pages:tokens:manage',
      'pages:settings:edit',
      'nodes:manage',
      'nodes:console',
      'nodes:files:read',
      'nodes:files:write',
      'docker:containers:console',
      'docker:containers:files:read',
      'docker:containers:files:write',
      'docker:containers:export',
      'docker:containers:secrets',
      'docker:containers:mounts',
      'docker:containers:migrate',
      'docker:volumes:export',
      'docker:volumes:files:read',
      'docker:volumes:files:write',
      'databases:query:read',
      'databases:query:write',
      'databases:query:admin',
      'databases:credentials:reveal',
      'integrations:gitlab:use',
      'integrations:gitlab:repo:write',
      'integrations:gitlab:sandbox:clone',
      'integrations:github:use',
      'integrations:github:repo:write',
      'integrations:git:use',
      'integrations:git:repo:write',
      'integrations:ssh:use',
      'integrations:hosting:manage',
      'hosting:resources:create',
      'hosting:resources:delete',
      'hosting:snapshots:restore',
      'hosting:billing:topup',
      'logs:tokens:create',
      'feat:ai:use',
      'admin:audit',
      'audit:siem:manage',
      'admin:details:certificates',
      'admin:update',
      'admin:system',
      'admin:users',
      'admin:groups',
      'settings:opfield:edit',
      'storage:bind',
    ]);
    for (const scope of MANUAL_APPROVAL_SCOPES) {
      if (scope === 'integrations:gitlab:sandbox:clone') continue;
      expect(isApiTokenScope(scope), scope).toBe(true);
    }
    expect(MANUAL_APPROVAL_SCOPES).not.toContain('docker:containers:environment');
  });

  it('keeps SIEM read and configuration scopes distinct while allowing management to imply read', () => {
    expect(ALL_SCOPES).toContain('audit:siem:view');
    expect(ALL_SCOPES).toContain('audit:siem:manage');
    expect(MANUAL_APPROVAL_SCOPES).toContain('audit:siem:manage');
    expect(MANUAL_APPROVAL_SCOPES).not.toContain('audit:siem:view');
  });

  it('keeps backend and frontend resource-scopable lists aligned', () => {
    expect(frontendResourceScopableScopes()).toEqual([...RESOURCE_SCOPABLE]);
  });

  it('uses longest-match parsing for resource-scoped scopes', () => {
    expect(extractBaseScope('docker:containers:files:read:node-1/c1')).toBe('docker:containers:files:read');
    expect(extractBaseScope('proxy:unrestricted:host-1')).toBe('proxy:unrestricted');
    expect(extractBaseScope('proxy:advanced:host-1')).toBe('proxy:advanced');
    expect(isValidBaseScope('admin:users:team-1')).toBe(true);
  });

  it('canonicalizes scopes with broad scopes winning over resource variants', () => {
    expect(canonicalizeScopes(['proxy:view:host-1', 'proxy:view', 'proxy:view:host-2'])).toEqual(['proxy:view']);
    expect(canonicalizeScopes(['proxy:view:host-2', 'proxy:view:host-1'])).toEqual([
      'proxy:view:host-1',
      'proxy:view:host-2',
    ]);
  });

  it('removes obsolete list scopes from stored scope-bearing tables', () => {
    const migration = listScopeRemovalMigration();

    for (const scope of [
      'pki:ca:list:root',
      'pki:ca:list:intermediate',
      'pki:cert:list',
      'pki:templates:list',
      'proxy:list',
      'ssl:cert:list',
      'acl:list',
      'nodes:list',
      'docker:containers:list',
      'docker:images:list',
      'docker:volumes:list',
      'docker:networks:list',
      'docker:registries:list',
      'databases:list',
      'notifications:alerts:list',
      'notifications:webhooks:list',
      'notifications:deliveries:list',
      'logs:environments:list',
      'logs:tokens:list',
      'logs:schemas:list',
    ]) {
      expect(migration).toContain(`('${scope}')`);
    }
    for (const table of [
      'permission_groups',
      'api_tokens',
      'oauth_authorization_codes',
      'oauth_refresh_tokens',
      'oauth_access_tokens',
    ]) {
      expect(migration).toContain(`UPDATE "${table}"`);
    }
    expect(migration).toContain('"requested_scopes"');
    expect(migration).toContain("scope_value LIKE obsolete.scope || ':%'");
    expect(migration).not.toContain('proxy:view');
  });

  it('models the stored-scope migration behavior for denied suffixes and overlapping resource scopes', () => {
    // proxy:advanced:bypass is a retired name (scopes-aliases.ts) and never reads as a proxy:advanced grant.
    expect(
      migratedProgrammaticStoredScopes([
        'mcp:use:any',
        'admin:users:impersonate:user-1',
        'integrations:gitlab:sandbox:clone',
        'proxy:raw:write:host-1',
        'proxy:advanced:bypass:host-1',
        'proxy:advanced:host-1',
        'proxy:advanced:bypasser',
        'proxy:view',
        'proxy:view:host-1',
        'unknown:scope',
      ])
    ).toEqual(['proxy:advanced:bypasser', 'proxy:advanced:host-1', 'proxy:raw:write:host-1', 'proxy:view']);
  });
});

describe('folder management scopes', () => {
  const FOLDER_ID = '22222222-2222-4222-8222-222222222222';

  it('accept a folder qualifier only', async () => {
    const { delegatedScopeIssue } = await import('./scopes-schemas.js');
    for (const scope of FOLDER_MANAGE_SCOPES) {
      expect(delegatedScopeIssue(`${scope}:folder/${FOLDER_ID}`), scope).toBeNull();
      expect(delegatedScopeIssue(`${scope}:${FOLDER_ID}`), scope).toContain('can only be restricted to a folder');
      expect(extractBaseScope(`${scope}:folder/${FOLDER_ID}`)).toBe(scope);
    }
    for (const scope of [
      'docker:folders:manage',
      'databases:folders:manage',
      'storage:folders:manage',
      'pages:folders:manage',
      'logs:environments:folders:manage',
      'logs:schemas:folders:manage',
    ]) {
      expect(FOLDER_MANAGE_SCOPES as readonly string[]).toContain(scope);
    }
    // Snapshot folders stay qualified by their hosting resource.
    expect(FOLDER_MANAGE_SCOPES as readonly string[]).not.toContain('hosting:snapshots:folders:manage');
    expect(delegatedScopeIssue('docker:folders:manage:node/node-1')).toContain('can only be restricted to a folder');
  });
});
