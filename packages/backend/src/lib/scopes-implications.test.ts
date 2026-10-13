import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasScope, hasScopeBase } from './permissions.js';
import { ALL_SCOPES } from './scopes-base.js';
import { IMPLIED_SCOPES_BY_REQUIRED_SCOPE, isCreationScope, scopeFamilyView } from './scopes-implications.js';

const FRONTEND_IMPLICATIONS = join(process.cwd(), '../frontend/src/types/scope-implications.ts');

/** The generated frontend module, formatted the way Biome keeps it (100 columns, double quotes). */
function renderFrontendImplications(): string {
  const lines = [
    '// Generated from packages/backend/src/lib/scopes-implications.ts. Do not edit by hand.',
    '// Regenerate: cd packages/backend && UPDATE_SCOPE_IMPLICATIONS=1 pnpm vitest run src/lib/scopes-implications.test.ts',
    '',
    '/** Required base scope -> every base scope that satisfies it (transitive, qualifier-preserving). */',
    'export const IMPLIED_SCOPES_BY_REQUIRED_SCOPE: Readonly<Record<string, readonly string[]>> = {',
  ];
  const renderMap = (map: Readonly<Record<string, readonly string[]>>) => {
    for (const required of Object.keys(map).sort()) {
      const implying = map[required];
      const oneLine = `  "${required}": [${implying.map((scope) => `"${scope}"`).join(', ')}],`;
      if (oneLine.length <= 100) {
        lines.push(oneLine);
        continue;
      }
      lines.push(`  "${required}": [`, ...implying.map((scope) => `    "${scope}",`), '  ],');
    }
  };
  renderMap(IMPLIED_SCOPES_BY_REQUIRED_SCOPE);
  lines.push('};');
  return `${lines.join('\n')}\n`;
}

function parseFrontendMap(source: string, name: string): Record<string, string[]> {
  const body = source.match(new RegExp(`${name}[^=]*= \\{([\\s\\S]*?)\\n\\};`));
  if (!body) throw new Error(`${name} not found`);
  const result: Record<string, string[]> = {};
  for (const entry of body[1].matchAll(/"([^"]+)": \[([\s\S]*?)\]/g)) {
    result[entry[1]] = [...entry[2].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  }
  return result;
}

describe('generated scope implications', () => {
  it('ships exactly the backend rules to the frontend', () => {
    if (process.env.UPDATE_SCOPE_IMPLICATIONS === '1')
      writeFileSync(FRONTEND_IMPLICATIONS, renderFrontendImplications());
    const source = readFileSync(FRONTEND_IMPLICATIONS, 'utf8');
    const plain = (map: Readonly<Record<string, readonly string[]>>) =>
      Object.fromEntries(Object.entries(map).map(([key, value]) => [key, [...value]]));
    expect(parseFrontendMap(source, 'IMPLIED_SCOPES_BY_REQUIRED_SCOPE')).toEqual(
      plain(IMPLIED_SCOPES_BY_REQUIRED_SCOPE)
    );
    expect(source).not.toContain('DESTINATION_IMPLYING');
  });

  it('only names catalog scopes and never makes a scope imply itself', () => {
    const catalog = new Set<string>(ALL_SCOPES);
    for (const [required, implying] of Object.entries(IMPLIED_SCOPES_BY_REQUIRED_SCOPE)) {
      expect(catalog.has(required), required).toBe(true);
      expect(
        implying.every((scope) => catalog.has(scope)),
        required
      ).toBe(true);
      expect(implying, required).not.toContain(required);
    }
  });

  it('assigns every action scope to its family view', () => {
    expect(scopeFamilyView('proxy:delete')).toBe('proxy:view');
    expect(scopeFamilyView('proxy:raw:write')).toBe('proxy:view');
    expect(scopeFamilyView('proxy:templates:manage')).toBe('proxy:templates:view');
    expect(scopeFamilyView('docker:containers:files:write')).toBe('docker:containers:view');
    expect(scopeFamilyView('docker:tasks:manage')).toBe('docker:tasks');
    expect(scopeFamilyView('nodes:manage')).toBe('nodes:details');
    expect(scopeFamilyView('ingress:groups:manage')).toBe('ingress:groups:view');
    expect(scopeFamilyView('pki:ca:create:intermediate')).toBe('pki:ca:view');
    expect(scopeFamilyView('integrations:gitlab:repo:write')).toBe('integrations:gitlab:view');
    expect(scopeFamilyView('storage:objects:admin')).toBe('storage:view');
    // Views and folder-tree scopes stay outside families.
    expect(scopeFamilyView('pages:settings:view')).toBeNull();
    expect(scopeFamilyView('proxy:folders:manage')).toBeNull();
    expect(scopeFamilyView('docker:folders:manage')).toBeNull();
    expect(scopeFamilyView('nodes:backups:execute')).toBeNull();
  });

  it('keeps the list of scopes without a family view deliberate', () => {
    const views = new Set(Object.keys(IMPLIED_SCOPES_BY_REQUIRED_SCOPE));
    const implying = new Set(Object.values(IMPLIED_SCOPES_BY_REQUIRED_SCOPE).flat());
    const unrelated = ALL_SCOPES.filter((scope) => !views.has(scope) && !implying.has(scope));
    // Creation scopes, folder trees, and account-level scopes stay outside every family.
    expect(unrelated.filter((scope) => !isCreationScope(scope))).toEqual([
      'storage:folders:manage',
      'nodes:backups:execute',
      'pki:ca:folders:manage',
      'pki:cert:folders:manage',
      'pki:templates:folders:manage',
      'domains:folders:manage',
      'proxy:maintenance:bypass',
      'proxy:folders:manage',
      'pages:folders:manage',
      'proxy:templates:folders:manage',
      'ssl:cert:folders:manage',
      'nodes:folders:manage',
      'apps:folders:manage',
      'admin:users',
      'admin:users:impersonate',
      'admin:users:folders:manage',
      'admin:groups',
      'admin:groups:folders:manage',
      'admin:audit',
      'admin:system',
      'admin:details:certificates',
      'admin:update',
      'admin:alerts',
      'ai:workspace:use',
      'feat:ai:use',
      'feat:ai:configure',
      'ai:skills:manage',
      'ai:sandbox:use',
      'ai:sandbox:tier:medium',
      'ai:sandbox:tier:high',
      'ai:sandbox:manage',
      'mcp:use',
      'inference:limits:manage',
      'inference:usage:view',
      'docker:folders:manage',
      'docker:registries:internal:pull',
      'docker:registries:internal:push',
      'databases:folders:manage',
      'logs:environments:folders:manage',
      'logs:schemas:folders:manage',
    ]);
  });

  it('preserves the qualifier of the implying scope', () => {
    expect(hasScope(['proxy:delete:host-1'], 'proxy:view:host-1')).toBe(true);
    expect(hasScope(['proxy:delete:host-1'], 'proxy:view:host-2')).toBe(false);
    expect(hasScope(['proxy:delete:host-1'], 'proxy:view')).toBe(false);
    expect(hasScope(['docker:containers:manage:node-1'], 'docker:containers:view:node-1/c1')).toBe(true);
    expect(hasScope(['docker:containers:manage:node-1/c1'], 'docker:containers:view:node-1/c2')).toBe(false);
    expect(hasScope(['docker:availability:manage:node-1/c1'], 'docker:containers:view:node-1/c1')).toBe(true);
    expect(hasScope(['pki:ca:export:ca-1'], 'pki:ca:view:ca-1')).toBe(true);
    expect(hasScope(['pki:ca:export:ca-1'], 'pki:ca:view:ca-2')).toBe(false);
    expect(hasScope(['logs:tokens:delete:env-1'], 'logs:environments:view:env-1')).toBe(true);
    expect(hasScope(['nodes:manage:node-1'], 'nodes:config:view:node-1')).toBe(true);
    expect(hasScope(['nodes:config:view:node-1'], 'nodes:details:node-1')).toBe(true);
    const folder = 'folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';
    expect(hasScopeBase([`docker:compose:manage:${folder}`], 'docker:compose:view')).toBe(true);
    expect(hasScope([`docker:compose:manage:${folder}`], 'docker:compose:view')).toBe(false);
  });

  it('never lets a creation scope imply a view, whatever its qualifier', () => {
    const folder = 'folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';
    const creationScopes = ALL_SCOPES.filter(isCreationScope);
    expect(creationScopes).toEqual(
      expect.arrayContaining([
        'acl:create',
        'pki:templates:create',
        'pki:ca:create:intermediate',
        'docker:registries:create',
        'hosting:resources:create',
        'status-page:incidents:create',
        'logs:tokens:create',
        'docker:images:pull',
        'ssl:cert:issue',
        'pki:cert:issue',
      ])
    );
    const implying = new Set(Object.values(IMPLIED_SCOPES_BY_REQUIRED_SCOPE).flat());
    // Only the per-VM snapshot creation keeps implying that VM's snapshot view (as before rc.9), and issue keeps
    // renewing certificates without revealing them.
    expect(creationScopes.filter((scope) => implying.has(scope))).toEqual([
      'ssl:cert:issue',
      'hosting:snapshots:create',
    ]);
    expect(IMPLIED_SCOPES_BY_REQUIRED_SCOPE['ssl:cert:view']).not.toContain('ssl:cert:issue');
    expect(hasScope(['proxy:create'], 'proxy:view')).toBe(false);
    expect(hasScope(['docker:containers:create'], 'docker:containers:view:node-1/c1')).toBe(false);
    expect(hasScope([`databases:create:${folder}`], `databases:view:${folder}`)).toBe(false);
    expect(hasScopeBase([`databases:create:${folder}`], 'databases:view')).toBe(false);
    expect(hasScope(['proxy:create:node/node-1'], 'proxy:view:node/node-1')).toBe(false);
    expect(hasScope(['docker:containers:create:node-1'], 'docker:containers:view:node-1/c1')).toBe(false);
    expect(hasScope(['hosting:resources:create:account/a1'], 'hosting:resources:view:account/a1')).toBe(false);
    expect(hasScope(['pki:ca:create:intermediate:ca-1'], 'pki:ca:view:ca-1')).toBe(false);
    expect(hasScope(['logs:tokens:create:env-1'], 'logs:environments:view:env-1')).toBe(false);
    expect(hasScope(['pki:cert:issue:ca-1'], 'pki:cert:view:ca-1')).toBe(false);
    expect(hasScope(['hosting:snapshots:create:vm-1'], 'hosting:snapshots:view:vm-1')).toBe(true);
    expect(hasScope(['ssl:cert:issue'], 'ssl:cert:view')).toBe(false);
    expect(hasScope([`ssl:cert:issue:${folder}`], `ssl:cert:view:${folder}`)).toBe(false);
  });

  it('keeps certificate renewal and PKI deployment compatible with the older scopes', () => {
    const folder = 'folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';
    expect(hasScope(['ssl:cert:issue'], 'ssl:cert:renew:cert-1')).toBe(true);
    expect(hasScope(['ssl:cert:issue:cert-1'], 'ssl:cert:renew:cert-1')).toBe(true);
    expect(hasScope(['ssl:cert:issue:cert-1'], 'ssl:cert:renew:cert-2')).toBe(false);
    expect(hasScope([`ssl:cert:issue:${folder}`], `ssl:cert:renew:${folder}`)).toBe(true);
    expect(hasScope(['ssl:cert:renew:cert-1'], 'ssl:cert:view:cert-1')).toBe(true);
    expect(hasScope(['ssl:cert:renew'], 'ssl:cert:issue')).toBe(false);
    expect(hasScope(['pki:cert:export:cert-1'], 'pki:cert:deploy:cert-1')).toBe(true);
    expect(hasScope(['pki:cert:deploy:cert-1'], 'pki:cert:view:cert-1')).toBe(true);
    expect(hasScope(['pki:cert:deploy'], 'pki:cert:export')).toBe(false);
  });

  it('keeps maintenance codes and registry credentials from revealing configuration', () => {
    expect(hasScope(['proxy:maintenance:bypass'], 'proxy:view')).toBe(false);
    expect(hasScope(['docker:registries:internal:pull'], 'docker:registries:view')).toBe(false);
    expect(hasScope(['docker:registries:internal:push'], 'docker:registries:view')).toBe(false);
  });

  it('keeps the explicit access tiers', () => {
    expect(hasScope(['storage:objects:admin:s1'], 'storage:objects:read:s1')).toBe(true);
    expect(hasScope(['storage:objects:read'], 'storage:objects:write')).toBe(false);
    expect(hasScope(['storage:credentials:reveal'], 'storage:credentials:use')).toBe(true);
    expect(hasScope(['storage:credentials:use'], 'storage:credentials:reveal')).toBe(false);
    expect(hasScope(['databases:query:admin'], 'databases:query:read')).toBe(true);
    expect(hasScope(['inference:models:manage'], 'inference:providers:view')).toBe(true);
  });

  it('keeps workload links with the scopes that used to gate them, and nothing more', () => {
    expect(hasScope(['databases:edit:db-1'], 'databases:bind:db-1')).toBe(true);
    expect(hasScope(['storage:iam:s1'], 'storage:bind:s1')).toBe(true);
    expect(hasScope(['databases:bind:db-1'], 'databases:view:db-1')).toBe(true);
    expect(hasScope(['databases:bind:db-1'], 'databases:edit:db-1')).toBe(false);
    expect(hasScope(['storage:bind:s1'], 'storage:iam:s1')).toBe(false);
    expect(hasScope(['storage:edit:s1'], 'storage:bind:s1')).toBe(false);
  });
});
