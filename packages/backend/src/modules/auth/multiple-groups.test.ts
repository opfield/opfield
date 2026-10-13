import { describe, expect, it } from 'vitest';
import { CreateUserSchema, UpdateUserGroupSchema } from '../admin/admin.schemas.js';
import { computeEffectiveUserAccess, groupsRequireMfa } from './live-session-user.js';

const groupMap = new Map([
  ['a', { id: 'a', name: 'A', parentId: null, scopes: ['pages:view:p1'], require2fa: true }],
  ['b', { id: 'b', name: 'B', parentId: null, scopes: ['databases:view:d1'] }],
  ['c', { id: 'c', name: 'C', parentId: 'b', scopes: ['pages:edit:p1'] }],
]);
describe('multiple user groups', () => {
  it('unions membership, inherited scopes and real additional permissions', () => {
    const access = computeEffectiveUserAccess('a', groupMap, ['nodes:details:n1'], ['c', 'a']);
    expect(access.groupIds).toEqual(['a', 'c']);
    expect(access.groupNames).toEqual(['A', 'C']);
    expect(access.groupScopes).toEqual(expect.arrayContaining(['pages:view:p1', 'pages:edit:p1', 'databases:view:d1']));
    expect(access.additionalScopes).toEqual(['nodes:details:n1']);
    expect(access.scopes).toContain('nodes:details:n1');
    expect(access.require2fa).toBe(true);
  });
  it('removes permissions from a deselected group but keeps additional grants', () => {
    const access = computeEffectiveUserAccess('b', groupMap, ['pages:view:p1']);
    expect(access.groupScopes).toEqual(['databases:view:d1']);
    expect(access.scopes).toContain('pages:view:p1');
    expect(access.require2fa).toBe(false);
    expect(groupsRequireMfa(['b', 'a'], groupMap)).toBe(true);
  });
  it('accepts legacy single membership and validated nonempty multiple membership', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    expect(UpdateUserGroupSchema.parse({ groupId: a }).groupIds).toEqual([a]);
    expect(UpdateUserGroupSchema.parse({ groupIds: [a, b, a] }).groupIds).toEqual([a, b]);
    expect(UpdateUserGroupSchema.safeParse({ groupIds: [] }).success).toBe(false);
    expect(UpdateUserGroupSchema.safeParse({}).success).toBe(false);
    expect(CreateUserSchema.parse({ name: 'Example', email: 'a@example.com', groupIds: [a, b] }).groupId).toBe(a);
  });
});
