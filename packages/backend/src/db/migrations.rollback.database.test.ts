import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import * as schema from '@/db/schema/index.js';
import {
  canonicalizeScopes,
  isApiTokenScope,
  isRetiredScope,
  RETIRED_SCOPE_REPLACEMENTS,
  SCOPE_CLEANUP_MIGRATION_ADDITIONS,
} from '@/lib/scopes.js';
import { syncPermissionGroupsAtStartup } from '@/lib/startup-scope-sync.js';
import { resolveEffectiveUserAccess } from '@/modules/auth/live-session-user.js';
import { disposableDatabase, migrateDatabase } from './migration-database.test-helpers.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/** v2.10.1's scope catalog (ALL_SCOPES and RESOURCE_SCOPABLE), to replay what its startup does to a newer schema. */
const v2101 = JSON.parse(readFileSync(new URL('./fixtures/v2.10.1-scope-catalog.json', import.meta.url), 'utf8')) as {
  allScopes: string[];
  resourceScopable: string[];
};
const V2101_SCOPES = new Set(v2101.allScopes);
const V2101_SCOPABLE = new Set(v2101.resourceScopable);
const V2101_SCOPABLE_BY_LENGTH = [...v2101.resourceScopable].sort((a, b) => b.length - a.length);

function v2101Base(scope: string): string {
  if (V2101_SCOPES.has(scope)) return scope;
  return (
    V2101_SCOPABLE_BY_LENGTH.find((base) => scope.startsWith(`${base}:`) && scope.length > base.length + 1) ?? scope
  );
}

/** v2.10.1's canonicalizeScopes: drops every scope its catalog does not know; broad scopes win over qualified ones. */
function v2101Canonicalize(scopes: readonly string[]): string[] {
  const valid = scopes.filter((scope) => {
    const base = v2101Base(scope);
    return V2101_SCOPES.has(base) && (scope === base || V2101_SCOPABLE.has(base));
  });
  return [...new Set(valid.filter((scope) => scope === v2101Base(scope) || !valid.includes(v2101Base(scope))))].sort();
}

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const NODE = id('11');
const HOST = id('21');

// Grants as v2.10.1 stores them: retired names, scopes whose capabilities moved, and lookalikes of qualified scopes.
const OPS_SCOPES = [
  'notifications:manage',
  'nodes:config:edit',
  'pki:ca:view:root',
  'pki:ca:create:root',
  'proxy:templates:edit',
  'proxy:raw:bypass',
  'proxy:advanced:bypass',
  'docker:containers:folders:manage',
  'integrations:github:manage',
  'integrations:gitlab:ci:edit',
  'integrations:cloudflare:manage',
  'docker:volumes:create',
  'logs:manage',
  'ssl:cert:revoke',
  'proxy:view',
  'docker:containers:view',
];
const QUALIFIED_SCOPES = [
  `proxy:raw:bypass:${HOST}`,
  `proxy:advanced:bypass:${HOST}`,
  `docker:volumes:create:${NODE}`,
  `nodes:config:edit:${NODE}`,
  `proxy:edit:${HOST}`,
];
const USER_SCOPES = ['notifications:view', 'integrations:git:view'];
const TOKEN_SCOPES = ['integrations:gitlab:registry:manage', 'notifications:manage', 'proxy:view'];
const LEGACY_LICENSE_CACHE = {
  registrationStatus: 'registered',
  status: 'valid',
  plan: 'business',
  paidPlan: 'business',
  paidLicenseStatus: 'valid',
  entitlementsVersion: 4,
  lastCheckedAt: '2026-09-30T23:50:00.000Z',
  lastValidAt: '2026-09-30T23:50:00.000Z',
};

const OPS = id('101');
const QUALIFIED = id('102');
const OPS_USER = id('201');
const QUALIFIED_USER = id('202');
const TOKEN = id('301');

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL, see migration-database.test-helpers): a v2.10.1 install (schema
 * through 0188) upgraded to head, rolled back by the v2.10.1 updater (it restores no database: v2.10.1 starts on the
 * migrated schema, rewrites the built-in groups and drops every scope it does not know from the others), and upgraded
 * again. v2.10.1 must find its own grants after the rollback, and the second upgrade must restore full access.
 */
describe.skipIf(!url)('rollback to v2.10.1 after the v2.11 migrations on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const stored = async (table: string, column: string, rowId: string) =>
    (await q(`select ${column} as scopes from ${table} where id = $1`, [rowId])).rows[0].scopes as string[];

  /** What v2.11 grants: users through their groups and additional scopes, tokens through their own scopes. */
  const effectiveAccess = async () => {
    const access: Record<string, string[]> = {};
    for (const row of (await q('select id, group_id, additional_scopes, additional_group_ids from users')).rows) {
      access[row.id] = (
        await resolveEffectiveUserAccess(db, row.group_id, row.additional_scopes, row.additional_group_ids)
      ).scopes;
    }
    for (const row of (await q('select id, scopes from api_tokens')).rows) {
      access[row.id] = canonicalizeScopes((row.scopes as string[]).filter(isApiTokenScope));
    }
    return access;
  };

  /** What v2.10.1 grants on the same rows. */
  const v2101Access = async () => {
    const groups = new Map(
      (await q('select id, scopes from permission_groups')).rows.map((row) => [row.id, row.scopes as string[]])
    );
    const access: Record<string, string[]> = {};
    for (const row of (await q('select id, group_id, additional_scopes from users')).rows) {
      access[row.id] = v2101Canonicalize([...(groups.get(row.group_id) ?? []), ...row.additional_scopes]);
    }
    for (const row of (await q('select id, scopes from api_tokens')).rows)
      access[row.id] = v2101Canonicalize(row.scopes);
    return access;
  };

  /** v2.10.1's startup on the migrated schema: its built-in group sets, then every group on its own catalog. */
  const startV2101 = async () => {
    await q(`update permission_groups set scopes = $1 where name = 'system-admin'`, [JSON.stringify(v2101.allScopes)]);
    for (const row of (await q('select id, scopes from permission_groups')).rows) {
      const next = v2101Canonicalize(row.scopes);
      if (next.join('\0') !== [...row.scopes].sort().join('\0'))
        await q('update permission_groups set scopes = $1, updated_at = now() where id = $2', [
          JSON.stringify(next),
          row.id,
        ]);
    }
  };

  let seededV2101Access: Record<string, string[]>;
  let upgradedAccess: Record<string, string[]>;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'rollback');
    pool = database.pool;
    db = drizzle(pool, { schema });
    await migrateDatabase(pool, '0188_user_multiple_groups');

    await q(
      `insert into permission_groups (name, is_builtin, scopes) values ('system-admin', true, $1)
       on conflict (name) do update set scopes = excluded.scopes, is_builtin = true`,
      [JSON.stringify(v2101.allScopes)]
    );
    await q('insert into permission_groups (id, name, scopes) values ($1, $2, $3), ($4, $5, $6)', [
      OPS,
      'custom-ops',
      JSON.stringify(OPS_SCOPES),
      QUALIFIED,
      'custom-qualified',
      JSON.stringify(QUALIFIED_SCOPES),
    ]);
    await q(
      `insert into users (id, group_id, email, name, additional_scopes) values
       ($1, $2, 'ops@rollback.test', 'Ops', $3), ($4, $5, 'qualified@rollback.test', 'Qualified', '[]')`,
      [OPS_USER, OPS, JSON.stringify(USER_SCOPES), QUALIFIED_USER, QUALIFIED]
    );
    await q(
      `insert into api_tokens (id, user_id, name, token_hash, token_prefix, scopes)
       values ($1, $2, 'ci', 'hash', 'gw_ci', $3)`,
      [TOKEN, OPS_USER, JSON.stringify(TOKEN_SCOPES)]
    );
    await q(`insert into page_projects (name, slug, created_by_id) values ('Docs', 'docs', $1)`, [OPS_USER]);
    await q(`insert into settings (key, value) values ('license:cached_state', $1)`, [
      JSON.stringify(LEGACY_LICENSE_CACHE),
    ]);
    // An AI tool call waiting for approval and one that finished, both with v2.10.1 required scopes.
    const conversation = (
      await q(`insert into ai_conversations (user_id, title) values ($1, 'Ops') returning id`, [OPS_USER])
    ).rows[0].id;
    const run = (
      await q(
        `insert into ai_runs (conversation_id, user_id, client_command_id, status) values ($1, $2, 'c1', 'completed')
         returning id`,
        [conversation, OPS_USER]
      )
    ).rows[0].id;
    await q(
      `insert into ai_run_tool_calls
         (id, run_id, conversation_id, tool_call_id, tool_name, classification, approval_policy, required_scopes, status)
       values ($1, $3, $4, 'pending', 'create_alert_rule', 'create', 'requires_approval', $5, 'pending_approval'),
              ($2, $3, $4, 'done', 'create_alert_rule', 'create', 'requires_approval', $5, 'completed')`,
      [id('401'), id('402'), run, conversation, JSON.stringify(['notifications:manage'])]
    );
    seededV2101Access = await v2101Access();

    await migrateDatabase(pool);
    await syncPermissionGroupsAtStartup(db, 'standard');
    upgradedAccess = await effectiveAccess();
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('seeds grants v2.10.1 itself would store', () => {
    expect(v2101Canonicalize(OPS_SCOPES)).toEqual([...OPS_SCOPES].sort());
    expect(v2101Canonicalize(QUALIFIED_SCOPES)).toEqual([...QUALIFIED_SCOPES].sort());
    expect(v2101Canonicalize(TOKEN_SCOPES)).toEqual([...TOKEN_SCOPES].sort());
  });

  it('grants the replacements in v2.11 and nothing through the retired names it keeps', async () => {
    expect(upgradedAccess[OPS_USER]).toEqual(
      expect.arrayContaining([
        'notifications:alerts:manage',
        'notifications:webhooks:manage',
        'notifications:alerts:view',
        'nodes:manage',
        'pki:ca:view',
        'pki:ca:edit',
        'pki:ca:export',
        'proxy:templates:manage',
        'proxy:unrestricted',
        'docker:folders:manage',
        'integrations:github:repo:read',
        'integrations:github:repo:write',
        'integrations:gitlab:repo:write',
        'integrations:git:repo:read',
        'integrations:cloudflare:sync',
        'docker:volumes:edit',
        'logs:read',
      ])
    );
    expect(upgradedAccess[QUALIFIED_USER]).toEqual(
      [
        `docker:volumes:create:${NODE}`,
        `docker:volumes:edit:${NODE}`,
        `nodes:manage:${NODE}`,
        `proxy:edit:${HOST}`,
        `proxy:unrestricted:${HOST}`,
      ].sort()
    );
    expect(upgradedAccess[TOKEN]).toEqual(
      [
        'integrations:gitlab:repo:write',
        'notifications:alerts:manage',
        'notifications:webhooks:manage',
        'proxy:view',
      ].sort()
    );
    for (const scopes of Object.values(upgradedAccess)) expect(scopes.filter(isRetiredScope)).toEqual([]);
    // The retired names stay stored next to their replacements for a rollback.
    expect(await stored('permission_groups', 'scopes', OPS)).toEqual(expect.arrayContaining(OPS_SCOPES));
    expect(await stored('permission_groups', 'scopes', QUALIFIED)).toEqual(expect.arrayContaining(QUALIFIED_SCOPES));
    expect(await stored('users', 'additional_scopes', OPS_USER)).toEqual(expect.arrayContaining(USER_SCOPES));
    expect(await stored('api_tokens', 'scopes', TOKEN)).toEqual(expect.arrayContaining(TOKEN_SCOPES));
  });

  it('rewrites only tool calls that can still run and leaves the v2.10.1 license cache alone', async () => {
    const calls = (await q('select tool_call_id, required_scopes from ai_run_tool_calls order by tool_call_id')).rows;
    expect(calls).toEqual([
      { tool_call_id: 'done', required_scopes: ['notifications:manage'] },
      {
        tool_call_id: 'pending',
        required_scopes: ['notifications:alerts:manage', 'notifications:webhooks:manage'],
      },
    ]);
    const cache = await q(`select value from settings where key = 'license:cached_state'`);
    expect(cache.rows[0].value).toEqual(LEGACY_LICENSE_CACHE);
  });

  it('keeps every grant after a rollback to v2.10.1 and restores full access on the next upgrade', async () => {
    await startV2101();
    // v2.10.1 dropped the names it does not know and still finds all of its own. On top it sees only the names 0200
    // maps old ones to that it already knew: the expansions the release notes list.
    expect(await stored('permission_groups', 'scopes', OPS)).not.toContain('pki:ca:edit');
    const mappedKnownNames = new Set(
      [...Object.values(RETIRED_SCOPE_REPLACEMENTS), ...Object.values(SCOPE_CLEANUP_MIGRATION_ADDITIONS)]
        .flat()
        .filter((scope) => V2101_SCOPES.has(scope))
    );
    const rolledBack = await v2101Access();
    for (const [principal, scopes] of Object.entries(seededV2101Access)) {
      expect(rolledBack[principal], principal).toEqual(expect.arrayContaining(scopes));
      const added = rolledBack[principal].filter((scope) => !scopes.includes(scope));
      expect(
        added.filter((scope) => !mappedKnownNames.has(v2101Base(scope))),
        principal
      ).toEqual([]);
    }

    // Grants v2.10.1 writes before the next upgrade use its names too.
    await q(`insert into permission_groups (id, name, scopes) values ($1, 'made-on-v2101', $2)`, [
      id('103'),
      JSON.stringify(['notifications:manage', 'pki:ca:create:root']),
    ]);
    await q(`update users set additional_group_ids = array[$1::uuid] where id = $2`, [id('103'), QUALIFIED_USER]);
    await q(
      `insert into api_tokens (id, user_id, name, token_hash, token_prefix, scopes)
       values ($1, $2, 'v2101', 'hash-2', 'gw_v2101', '["nodes:config:edit"]')`,
      [id('302'), OPS_USER]
    );

    await migrateDatabase(pool);
    await syncPermissionGroupsAtStartup(db, 'standard');
    const reupgraded = await effectiveAccess();
    expect(reupgraded[OPS_USER]).toEqual(upgradedAccess[OPS_USER]);
    expect(reupgraded[TOKEN]).toEqual(upgradedAccess[TOKEN]);
    expect(reupgraded[QUALIFIED_USER]).toEqual(
      expect.arrayContaining([
        ...upgradedAccess[QUALIFIED_USER],
        'notifications:alerts:manage',
        'notifications:webhooks:manage',
        'pki:ca:edit',
        'pki:ca:export',
      ])
    );
    // nodes:manage also brings the ingress group scopes it covered before they had their own (migration 0228).
    expect(reupgraded[id('302')]).toEqual(['ingress:groups:manage', 'ingress:groups:view', 'nodes:manage']);

    // Built-in groups are exactly this release's again, so later starts leave deliberate v2.11 edits alone.
    await q('update permission_groups set scopes = $1 where id = $2', [
      JSON.stringify(
        canonicalizeScopes(
          (await stored('permission_groups', 'scopes', QUALIFIED)).filter(
            (scope) => scope !== `docker:volumes:edit:${NODE}`
          )
        )
      ),
      QUALIFIED,
    ]);
    await syncPermissionGroupsAtStartup(db, 'standard');
    expect(await stored('permission_groups', 'scopes', QUALIFIED)).not.toContain(`docker:volumes:edit:${NODE}`);
    expect((await effectiveAccess())[OPS_USER]).toEqual(upgradedAccess[OPS_USER]);
  });

  it('lets v2.10.1 create a Pages project without a preview hash', async () => {
    await q(`insert into page_projects (name, slug, created_by_id) values ('Blog', 'blog', $1)`, [OPS_USER]);
    const hashes = (await q('select slug, preview_hash from page_projects order by slug')).rows;
    expect(hashes.map((row) => row.slug)).toEqual(['blog', 'docs']);
    for (const row of hashes) expect(row.preview_hash).toMatch(/^[a-z2-7]{12}$/);
    expect(hashes[0].preview_hash).not.toBe(hashes[1].preview_hash);
  });
});
