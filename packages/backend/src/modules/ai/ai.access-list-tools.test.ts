import { describe, expect, it, vi } from 'vitest';

vi.mock('@/container.js', () => ({
  container: { resolve: () => ({ assertCreateFolder: async () => undefined }) },
}));

import { ACCESS_LIST_AI_TOOLS } from './ai.access-list-tool-definitions.js';
import { executeAccessListTool } from './ai.access-list-tools.js';
import { createAIToolArgumentValidator } from './ai-tool-contract.js';

const USER = { id: 'user-1', scopes: ['acl:create'] } as never;

async function created(args: Record<string, unknown>) {
  const create = vi.fn().mockResolvedValue({ id: 'list-1' });
  const context = { accessListService: { create } as never, ensureToolScopeForResource: () => undefined };
  await executeAccessListTool(context, USER, 'create_access_list', args);
  return create.mock.calls[0]?.[0];
}

describe('create_access_list arguments of agents written before sign-in based lists', () => {
  it('are declared by the tool', () => {
    const validator = createAIToolArgumentValidator(ACCESS_LIST_AI_TOOLS);
    expect(
      validator.validate('create_access_list', {
        name: 'Office',
        allowIps: ['203.0.113.0/24'],
        denyIps: ['198.51.100.7'],
        basicAuthUsers: [{ username: 'ops', password: 'secret' }],
      }).ok
    ).toBe(true);
    const properties = Object.keys(
      (ACCESS_LIST_AI_TOOLS.find((tool) => tool.name === 'manage_access_list')!.parameters as any).properties
    );
    expect(properties).toEqual(expect.arrayContaining(['ipRules', 'basicAuthEnabled', 'basicAuthUsers']));
  });

  it('map allowIps and denyIps after ipRules, and basicAuthUsers to basic authentication, as 2.12 did', async () => {
    expect(
      await created({
        name: 'Office',
        ipRules: [{ type: 'deny', value: '10.0.0.7' }],
        allowIps: ['10.0.0.0/8'],
        denyIps: ['192.0.2.1'],
      })
    ).toMatchObject({
      ipRules: [
        { type: 'deny', value: '10.0.0.7' },
        { type: 'allow', value: '10.0.0.0/8' },
        { type: 'deny', value: '192.0.2.1' },
      ],
      basicAuthEnabled: false,
    });
    expect(await created({ name: 'Ops', basicAuthUsers: [{ username: 'ops', password: 'secret' }] })).toMatchObject({
      ipRules: [],
      basicAuthEnabled: true,
      basicAuthUsers: [{ username: 'ops', password: 'secret' }],
    });
  });

  it('leave a create with the sign-in fields as it is, and refuse a mix', async () => {
    const input = await created({ name: 'Team', skipIpRanges: ['10.0.0.0/8'] });
    expect(input).toMatchObject({ skipIpRanges: ['10.0.0.0/8'] });
    expect(input.ipRules).toBeUndefined();
    await expect(created({ name: 'Mixed', allowIps: ['10.0.0.0/8'], signInMethods: ['opfield'] })).rejects.toThrow(
      /cannot be combined/
    );
  });
});
