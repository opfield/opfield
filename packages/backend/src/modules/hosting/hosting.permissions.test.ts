import { describe, expect, it } from 'vitest';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { hasScope } from '@/lib/permissions.js';
import { API_TOKEN_SCOPES, isValidBaseScope } from '@/lib/scopes.js';
import { HostingSettingsSchema } from './hosting.schemas.js';
import {
  assertHostingAdoptionAuthority,
  assertHostingResourceAction,
  canViewHostingFinance,
} from './hosting-permissions.js';

describe('hosting authorization boundaries', () => {
  it('enforces provider actions independently and still requires access to every bound node', async () => {
    const accounts = [
      { id: 'pve-account', provider: 'proxmox' },
      { id: 'do-account', provider: 'digitalocean' },
    ];
    const resources = [
      { id: 'pve-vm', connectorId: 'pve-account' },
      { id: 'do-vm', connectorId: 'do-account' },
    ];
    const db = {
      select: (fields: Record<string, unknown>) => ({
        from: () => ({ where: async () => ('provider' in fields ? accounts : resources) }),
      }),
    };
    const scopes = await expandFolderScopes(db as never, [
      'hosting:resources:power:provider/proxmox',
      'hosting:resources:delete:account/do-account',
      'nodes:details:n1',
      'nodes:manage:n1',
      'nodes:delete:n1',
    ]);
    expect(() => assertHostingResourceAction(scopes, 'pve-vm', 'reboot', ['n1'])).not.toThrow();
    expect(() => assertHostingResourceAction(scopes, 'do-vm', 'reboot', ['n1'])).toThrow();
    expect(() => assertHostingResourceAction(scopes, 'pve-vm', 'delete', ['n1'])).toThrow();
    expect(() => assertHostingResourceAction(scopes, 'do-vm', 'delete', ['n1'])).not.toThrow();
    expect(() => assertHostingResourceAction(scopes, 'pve-vm', 'reboot', ['hidden-node'])).toThrow();
    expect(() => assertHostingResourceAction(scopes, 'pve-vm', 'reboot', ['n1', 'hidden-node'])).toThrow();
    expect(hasScope(scopes, 'hosting:billing:view:pve-account')).toBe(false);
  });
  it('registers scoped permissions without implicit node-to-finance grants', () => {
    expect(isValidBaseScope('hosting:resources:power')).toBe(true);
    expect(hasScope(['hosting:resources:power:r1'], 'hosting:resources:power:r2')).toBe(false);
    expect(canViewHostingFinance(['nodes:details', 'integrations:hosting:manage'], 'account')).toBe(false);
    expect(canViewHostingFinance(['hosting:billing:view:account'], 'account')).toBe(true);
    expect(canViewHostingFinance(['hosting:billing:view:other'], 'account')).toBe(false);
    // Hosting administration is delegable to API and OAuth/MCP tokens like any other resource scope.
    for (const scope of [
      'integrations:hosting:manage',
      'hosting:resources:create',
      'hosting:resources:power',
      'hosting:resources:resize',
      'hosting:resources:delete',
      'hosting:resources:recover',
      'hosting:billing:view',
    ])
      expect(API_TOKEN_SCOPES).toContain(scope);
  });
  it('does not authorize global adoption from a single-node grant', () => {
    const scopes = ['nodes:details:n1', 'nodes:manage:n1'];
    expect(() => assertHostingAdoptionAuthority(scopes, HostingSettingsSchema.parse({}))).toThrow();
    expect(() =>
      assertHostingAdoptionAuthority(
        scopes,
        HostingSettingsSchema.parse({ adoptionNodeIds: ['11111111-1111-4111-8111-111111111111'] })
      )
    ).toThrow();
    expect(() =>
      assertHostingAdoptionAuthority(scopes, { ...HostingSettingsSchema.parse({}), adoptionNodeIds: ['n1'] })
    ).not.toThrow();
  });
  it('requires rights for all impacted roles before power/delete', () => {
    const scopes = ['hosting:resources:power:r1', 'nodes:details', 'nodes:manage:n1'];
    expect(() => assertHostingResourceAction(scopes, 'r1', 'reboot', ['n1'])).not.toThrow();
    expect(() => assertHostingResourceAction(scopes, 'r1', 'reboot', ['n1', 'n2'])).toThrow();
    expect(() => assertHostingResourceAction(scopes, 'r1', 'delete', ['n1'])).toThrow();
  });
});
