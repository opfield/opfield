import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disposableDatabase, migrateDatabase } from './migration-database.test-helpers.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): access lists move from nginx IP rules and basic auth to sign-in
 * methods and rules, each list keeping who gets in, and the old columns are gone afterwards.
 */
describe.skipIf(!url)('access list migration on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  const user = randomUUID();
  const lists: Record<string, string> = {};
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);

  const insertList = async (name: string, ipRules: unknown[], basicAuth: boolean) => {
    const id = randomUUID();
    await q(
      'insert into access_lists (id, name, ip_rules, basic_auth_enabled, basic_auth_users, created_by_id) values ($1, $2, $3, $4, $5, $6)',
      [
        id,
        name,
        JSON.stringify(ipRules),
        basicAuth,
        JSON.stringify(basicAuth ? [{ username: 'ops', passwordHash: '$2b$10$hash' }] : []),
        user,
      ]
    );
    lists[name] = id;
  };
  const row = async (name: string) =>
    (
      await q(
        'select sign_in_methods, users, skip_ip_ranges, include_rules, require_rules, exclude_rules from access_lists where id = $1',
        [lists[name]]
      )
    ).rows[0];

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'access_lists');
    pool = database.pool;
    await migrateDatabase(pool, '0276_backup_run_executor_set_null');
    const group = randomUUID();
    await q('insert into permission_groups (id, name) values ($1, $2)', [group, `acl-${group}`]);
    await q('insert into users (id, group_id, email, name) values ($1, $2, $3, $4)', [
      user,
      group,
      `${user}@acl.test`,
      'ACL test',
    ]);
    await insertList('open', [], false);
    await insertList(
      'office',
      [
        { type: 'allow', value: '10.0.0.0/8' },
        { type: 'deny', value: 'all' },
      ],
      false
    );
    await insertList(
      'blocklist',
      [
        { type: 'deny', value: '203.0.113.7' },
        { type: 'allow', value: 'all' },
      ],
      false
    );
    await insertList('office-basic', [{ type: 'allow', value: '10.0.40.0/24' }], true);
    await migrateDatabase(pool);
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('keeps an empty list open to everyone', async () => {
    expect(await row('open')).toMatchObject({ sign_in_methods: [], skip_ip_ranges: ['0.0.0.0/0', '::/0'] });
  });

  it('lets allowed addresses in without signing in and nobody else', async () => {
    expect(await row('office')).toMatchObject({
      sign_in_methods: [],
      skip_ip_ranges: ['10.0.0.0/8'],
      exclude_rules: [],
    });
  });

  it('keeps denied addresses out of an otherwise open list', async () => {
    expect(await row('blocklist')).toMatchObject({
      skip_ip_ranges: ['0.0.0.0/0', '::/0'],
      exclude_rules: [{ selector: 'ip', values: ['203.0.113.7'] }],
    });
  });

  it('asks for basic authentication from the allowed network only', async () => {
    expect(await row('office-basic')).toMatchObject({
      sign_in_methods: ['basic'],
      users: [{ username: 'ops', passwordHash: '$2b$10$hash' }],
      skip_ip_ranges: [],
      include_rules: [{ selector: 'everyone', values: [] }],
      require_rules: [{ selector: 'ip', values: ['10.0.40.0/24'] }],
    });
  });

  it('drops the nginx rule columns', async () => {
    const { rows } = await q(
      "select column_name from information_schema.columns where table_name = 'access_lists' and column_name in ('ip_rules', 'basic_auth_enabled', 'basic_auth_users')"
    );
    expect(rows).toEqual([]);
  });
});
