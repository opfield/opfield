import { afterEach, describe, expect, it } from 'vitest';
import { accessLists, accessSessions } from '@/db/schema/index.js';
import { NGINX_ACCESS_AUTH_CAPABILITY } from '@/modules/proxy/nginx-access-list.js';
import { configureAccessPolicySync, syncAccessPolicyNow } from './access-policy-sync.js';
import { AccessSessionService, opfieldSessionMatches } from './access-sessions.service.js';
import { PasswordSignInSchema } from './access-signin.schemas.js';

const LIST = {
  id: '11111111-1111-4111-8111-111111111111',
  signInMethods: ['opfield'],
  skipIpRanges: [] as string[],
  includeRules: [{ selector: 'everyone', values: [] }],
  requireRules: [],
  excludeRules: [],
  users: [],
};

/** A db whose selects answer `rows(table)` and whose revision upsert counts up. */
function fakeDb(rows: (table: unknown) => unknown[]) {
  let revision = 0;
  return {
    select: () => ({
      from: (table: unknown) => {
        const result = Promise.resolve(rows(table)) as Promise<unknown[]> & { where: () => Promise<unknown[]> };
        result.where = async () => rows(table);
        return result;
      },
    }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: () => ({ returning: async () => [{ value: ++revision }] }) }),
    }),
  };
}

describe('access policy resync', () => {
  afterEach(() => configureAccessPolicySync(null));

  it('pushes on change and reconnect paths, but the periodic resync skips an unchanged policy', async () => {
    let lists = [LIST];
    let fail = false;
    const sent: string[] = [];
    configureAccessPolicySync({
      db: fakeDb((table) => (table === accessLists ? lists : [])) as never,
      keys: { verificationKeys: async () => [{ keyId: 'k1', publicKey: Buffer.alloc(32, 1) }] },
      settings: { signInOrigin: async () => 'https://access.example.com' },
      registry: {
        getNodesByType: () => [{ nodeId: 'n1', capabilities: new Set([NGINX_ACCESS_AUTH_CAPABILITY]) }] as never,
      },
      dispatch: {
        sendAccessPolicy: async (_nodeId, command) => {
          sent.push(String(command.revision));
          return { success: !fail } as never;
        },
      },
    });

    await syncAccessPolicyNow();
    await syncAccessPolicyNow({ onlyIfChanged: true });
    expect(sent).toEqual(['1']);

    lists = [{ ...LIST, skipIpRanges: ['10.0.0.0/8'] }];
    await syncAccessPolicyNow({ onlyIfChanged: true });
    expect(sent).toEqual(['1', '2']);

    // A node that refused it gets the same content again from the next resync.
    lists = [LIST];
    fail = true;
    await syncAccessPolicyNow({ onlyIfChanged: true });
    fail = false;
    await syncAccessPolicyNow({ onlyIfChanged: true });
    await syncAccessPolicyNow({ onlyIfChanged: true });
    expect(sent).toEqual(['1', '2', '3', '4']);
  });
});

describe('Opfield account sessions after an account change', () => {
  const user = { email: 'lena@acme.dev', groups: ['g1', 'g2'] };

  it('keep matching while email and groups are the same', () => {
    expect(opfieldSessionMatches({ email: 'lena@acme.dev', groups: ['g2', 'g1'] }, user)).toBe(true);
    expect(opfieldSessionMatches({ email: 'old@acme.dev', groups: ['g1', 'g2'] }, user)).toBe(false);
    expect(opfieldSessionMatches({ email: 'lena@acme.dev', groups: ['g1'] }, user)).toBe(false);
    expect(opfieldSessionMatches({ email: 'lena@acme.dev', groups: ['g1', 'g2'] }, null)).toBe(false);
  });

  it('revokes only when a live session carries an old email or old groups', async () => {
    let live = [{ id: 'current', email: 'lena@acme.dev', groups: ['g1', 'g2'] }];
    let updates = 0;
    const db = {
      select: () => ({ from: (table: unknown) => ({ where: async () => (table === accessSessions ? live : []) }) }),
      update: () => ({
        set: () => ({
          where: () => {
            updates++;
            return { returning: async () => [{ id: 'old-group' }] };
          },
        }),
      }),
    };
    const service = new AccessSessionService(db as never, {} as never);
    const directory = { getOpfieldUser: async () => ({ id: 'u1', name: 'Lena', ...user }) };
    expect(await service.revokeChangedOpfieldSessions('u1', directory)).toBe(0);
    expect(updates).toBe(0);

    live = [...live, { id: 'old-group', email: 'lena@acme.dev', groups: ['g1'] }];
    expect(await service.revokeChangedOpfieldSessions('u1', directory)).toBe(1);
    expect(updates).toBe(1);
  });
});

describe('password sign-in body', () => {
  it('trims the username like the stored ones', () => {
    const parsed = PasswordSignInSchema.parse({
      list: LIST.id,
      host: 'app.example.com',
      n: 'n'.repeat(43),
      username: '  lena.novak ',
      password: 'secret',
    });
    expect(parsed.username).toBe('lena.novak');
  });
});
