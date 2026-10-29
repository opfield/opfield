import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { CreateAccessListSchema, UpdateAccessListSchema } from './access-list.schemas.js';
import { type AccessListModel, nextAccessListModel, presentAccessList } from './access-list-model.js';

const create = (body: Record<string, unknown>) => nextAccessListModel(CreateAccessListSchema.parse(body), null);
const update = (body: Record<string, unknown>, current: AccessListModel) =>
  nextAccessListModel(UpdateAccessListSchema.parse(body), current);

describe('legacy fields of published API clients', () => {
  it('converts ipRules and basic authentication with the mapping of migration 0277', async () => {
    const office = await create({
      name: 'Office',
      ipRules: [
        { type: 'deny', value: '10.0.0.7' },
        { type: 'allow', value: '10.0.0.0/8' },
        { type: 'deny', value: 'all' },
        { type: 'allow', value: '192.0.2.1' },
      ],
    });
    expect(office).toMatchObject({
      signInMethods: [],
      skipIpRanges: ['10.0.0.0/8'],
      includeRules: [],
      requireRules: [],
      excludeRules: [{ selector: 'ip', values: ['10.0.0.7'] }],
    });

    const open = await create({
      name: 'Open',
      ipRules: [
        { type: 'deny', value: '192.0.2.7' },
        { type: 'allow', value: 'all' },
      ],
    });
    expect(open).toMatchObject({
      skipIpRanges: ['0.0.0.0/0', '::/0'],
      excludeRules: [{ selector: 'ip', values: ['192.0.2.7'] }],
    });

    const staff = await create({
      name: 'Staff',
      ipRules: [{ type: 'allow', value: '10.0.0.0/8' }],
      basicAuthEnabled: true,
      basicAuthUsers: [{ username: 'lena', password: 'secret' }],
    });
    expect(staff).toMatchObject({
      signInMethods: ['basic'],
      skipIpRanges: [],
      includeRules: [{ selector: 'everyone', values: [] }],
      requireRules: [{ selector: 'ip', values: ['10.0.0.0/8'] }],
      excludeRules: [],
    });
    expect(await bcrypt.compare('secret', staff.users[0]!.passwordHash)).toBe(true);
  });

  it('keeps the other legacy fields on a partial legacy update, and refuses one that cannot be expressed', async () => {
    const staff = await create({
      name: 'Staff',
      ipRules: [{ type: 'allow', value: '10.0.0.0/8' }],
      basicAuthEnabled: true,
      basicAuthUsers: [{ username: 'lena', password: 'secret' }],
    });
    const rotated = await update({ basicAuthUsers: [{ username: 'lena', password: 'new' }] }, staff);
    expect(rotated.requireRules).toEqual(staff.requireRules);
    expect(rotated.signInMethods).toEqual(['basic']);
    expect(await bcrypt.compare('new', rotated.users[0]!.passwordHash)).toBe(true);

    const sso = await create({ name: 'SSO', signInMethods: ['opfield'], includeRules: [{ selector: 'everyone' }] });
    await expect(update({ basicAuthEnabled: false }, sso)).rejects.toMatchObject({ code: 'ACCESS_LIST_NOT_LEGACY' });
    expect(await update({ ipRules: [], basicAuthEnabled: false }, sso)).toMatchObject({
      signInMethods: [],
      skipIpRanges: ['0.0.0.0/0', '::/0'],
    });
  });

  it('refuses legacy and sign-in fields in one body', () => {
    expect(() => CreateAccessListSchema.parse({ name: 'x', ipRules: [], signInMethods: ['opfield'] })).toThrow();
  });
});

describe('sign-in fields', () => {
  it('keeps a password sent empty, needs one for a new user, and sets, keeps and clears the shared password', async () => {
    const list = await create({
      name: 'Team',
      signInMethods: ['password', 'shared'],
      users: [{ username: 'lena', password: 'one' }],
      sharedPassword: 'shared-one',
      includeRules: [{ selector: 'everyone' }],
    });
    const kept = await update({ users: [{ username: 'lena' }] }, list);
    expect(kept.users[0]!.passwordHash).toBe(list.users[0]!.passwordHash);
    expect(kept.sharedPasswordHash).toBe(list.sharedPasswordHash);
    await expect(update({ users: [{ username: 'maya' }] }, list)).rejects.toMatchObject({
      code: 'ACCESS_LIST_PASSWORD_REQUIRED',
    });
    await expect(update({ sharedPassword: null }, list)).rejects.toMatchObject({ code: 'SHARED_PASSWORD_REQUIRED' });
    const cleared = await update({ sharedPassword: null, signInMethods: ['password'] }, list);
    expect(cleared.sharedPasswordHash).toBeNull();
  });

  it('validates every selector and the state of the whole list', async () => {
    const bad = [
      { selector: 'ip', values: ['10.0.0.0/33'] },
      { selector: 'email_domain', values: ['@acme.dev'] },
      { selector: 'everyone', values: ['x'] },
      { selector: 'opfield_user', values: ['lena'] },
      { selector: 'method', values: ['magic'] },
      { selector: 'email', values: [] },
    ];
    for (const rule of bad) {
      expect(CreateAccessListSchema.safeParse({ name: 'x', includeRules: [rule] }).success, rule.selector).toBe(false);
    }
    expect(CreateAccessListSchema.safeParse({ name: 'x', skipIpRanges: ['all'] }).success).toBe(false);
    await expect(create({ name: 'x', signInMethods: ['opfield'] })).rejects.toMatchObject({
      code: 'ACCESS_LIST_INCLUDE_REQUIRED',
    });
    await expect(
      create({ name: 'x', signInMethods: ['basic'], includeRules: [{ selector: 'everyone' }] })
    ).rejects.toMatchObject({ code: 'ACCESS_LIST_USERS_REQUIRED' });
  });

  it('answers without hashes', async () => {
    const model = await create({
      name: 'Team',
      signInMethods: ['basic', 'shared'],
      users: [{ username: 'lena', password: 'one' }],
      sharedPassword: 'two',
      includeRules: [{ selector: 'everyone' }],
    });
    const presented = presentAccessList({ id: 'list', name: 'Team', ...model } as never);
    expect(presented.users).toEqual([{ username: 'lena' }]);
    expect(presented.sharedPasswordSet).toBe(true);
    expect(JSON.stringify(presented)).not.toContain('$2');
  });
});
