import { describe, expect, it } from 'vitest';
import { canReachApps, hasAppsSectionScope } from './app-access.js';
import { incidentForMembers, incidentItemKeys, memberVisibilityKeys } from './app-member-visibility.js';
import type { AppMember } from './app-members.service.js';

const member = (patch: Partial<AppMember> & Pick<AppMember, 'type' | 'id'>): AppMember => ({
  name: patch.id,
  environmentId: 'env',
  nodeIds: [],
  ...patch,
});

describe('app visibility through members', () => {
  it('lets member viewers reach the apps API without showing them the section by scope', () => {
    expect(canReachApps(['docker:containers:view:folder/f1'])).toBe(true);
    expect(canReachApps(['databases:view:db-1'])).toBe(true);
    expect(canReachApps(['nodes:details'])).toBe(false);
    expect(hasAppsSectionScope(['docker:containers:view'])).toBe(false);
    expect(hasAppsSectionScope(['apps:view:env/e1'])).toBe(true);
    expect(hasAppsSectionScope(['apps:create'])).toBe(true);
  });

  it('matches incident items to the members they concern', () => {
    const keys = memberVisibilityKeys([
      member({ type: 'container', id: 'web', nodeId: 'n1' }),
      member({ type: 'deployment', id: 'dep-1', nodeId: 'n1' }),
      member({ type: 'database', id: 'conn-1', managedId: 'inst-1' }),
      member({ type: 'route', id: 'route-1' }),
    ]);
    const sees = (itemKind: string, ref: Record<string, unknown>) =>
      incidentItemKeys({ itemKind, ref }).some((key) => keys.has(key));
    expect(sees('container_stop', { nodeId: 'n1', name: 'web' })).toBe(true);
    expect(sees('container_stop', { nodeId: 'n1', name: 'admin' })).toBe(false);
    expect(
      sees('container_network', { nodeId: 'n1', name: 'dep-1-blue', owner: { type: 'deployment', id: 'dep-1' } })
    ).toBe(true);
    expect(sees('deployment_stop', { deploymentId: 'dep-1' })).toBe(true);
    expect(sees('database_pause', { databaseId: 'inst-1', connectionId: 'conn-1' })).toBe(true);
    expect(sees('database_publication', { databaseId: 'inst-1' })).toBe(true);
    expect(sees('storage_pause', { storageId: 'cl-1', connectionId: 'st-1' })).toBe(false);
    expect(sees('route_overlay', { routeId: 'route-1' })).toBe(true);
    expect(sees('container_link', { linkId: 'l1' })).toBe(false);
    expect(sees('secure_link', { secureLinkId: 's1' })).toBe(false);
  });

  it('keeps only visible items of an incident and drops its incident-level error', () => {
    const keys = memberVisibilityKeys([member({ type: 'compose', id: 'p1', nodeId: 'n1' })]);
    const incident = incidentForMembers(
      {
        id: 'i1',
        lastError: 'node n2 unreachable',
        items: [
          { itemKind: 'compose_stop', ref: { projectId: 'p1' } },
          { itemKind: 'compose_stop', ref: { projectId: 'p2' } },
        ],
      },
      keys
    );
    expect(incident.items).toEqual([{ itemKind: 'compose_stop', ref: { projectId: 'p1' } }]);
    expect(incident.lastError).toBeNull();
    expect(incident.id).toBe('i1');
  });
});
