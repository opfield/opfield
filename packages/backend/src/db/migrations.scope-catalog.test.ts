import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_INSTALL_DIR_NAME } from '@/lib/legacy-compat.js';
import { MIGRATION_0200_RETIRED_SCOPES, SCOPE_CLEANUP_MIGRATION_ADDITIONS } from '@/lib/scopes-aliases.js';

const MIGRATION_TAG = '0200_scope_catalog_cleanup';

function readMigration(): string {
  return readFileSync(join(process.cwd(), `src/db/migrations/${MIGRATION_TAG}.sql`), 'utf8');
}

// Grants keep their retired names for a rollback to a release before v2.11; required-scope lists are replaced.
const SCOPE_COLUMNS: Array<[table: string, column: string, keepRetired: boolean]> = [
  ['permission_groups', 'scopes', true],
  ['users', 'additional_scopes', true],
  ['api_tokens', 'scopes', true],
  ['oauth_authorization_codes', 'requested_scopes', true],
  ['oauth_authorization_codes', 'scopes', true],
  ['oauth_refresh_tokens', 'scopes', true],
  ['oauth_access_tokens', 'scopes', true],
  ['ai_run_tool_calls', 'required_scopes', false],
  ['sandbox_jobs', 'required_scopes', false],
];

describe('0200 scope catalog cleanup migration', () => {
  it('is journaled at its reserved position', () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    expect(journal.entries.find((entry) => entry.tag === MIGRATION_TAG)).toMatchObject({
      idx: 200,
      when: 1790400000000,
    });
  });

  it('rewrites retired names exactly like inbound canonicalization', () => {
    const migration = readMigration();
    for (const [retired, replacements] of Object.entries(MIGRATION_0200_RETIRED_SCOPES)) {
      if (replacements.length === 0) {
        expect(migration, retired).toMatch(new RegExp(`\\('${retired}', NULL(::text)?\\)`));
        continue;
      }
      for (const replacement of replacements) {
        expect(migration, `${retired} -> ${replacement}`).toContain(`('${retired}', '${replacement}')`);
      }
    }
    const rows = [...migration.matchAll(/^\s+\('([^']+)', (?:'([^']+)'|NULL(?:::text)?)\)/gm)];
    const retiredRows = rows.filter(([, from]) => from in MIGRATION_0200_RETIRED_SCOPES);
    const expectedRetiredRows = Object.values(MIGRATION_0200_RETIRED_SCOPES).reduce(
      (count, replacements) => count + Math.max(replacements.length, 1),
      0
    );
    expect(retiredRows).toHaveLength(expectedRetiredRows);
  });

  it('keeps effective access for scopes whose capabilities moved', () => {
    const migration = readMigration();
    for (const [trigger, additions] of Object.entries(SCOPE_CLEANUP_MIGRATION_ADDITIONS)) {
      for (const addition of additions) {
        expect(migration, `${trigger} + ${addition}`).toContain(`('${trigger}', '${addition}')`);
      }
    }
    // Additions are computed from the renamed set (so an old name such as github:sync gets the same
    // additions as manage), keep the trigger's qualifier, and never duplicate a scope the row already
    // holds, so a second run changes nothing.
    expect(migration).toContain(
      'additions.new_scope || substr(renamed.scope, length(additions.trigger_scope) + 1) AS scope'
    );
    expect(migration).toContain(
      "left(renamed.scope, length(additions.trigger_scope) + 1) = additions.trigger_scope || ':'"
    );
    // Folder and node destinations never receive additions.
    expect(migration).toContain("left(substr(renamed.scope, length(additions.trigger_scope) + 2), 7) <> 'folder/'");
    expect(migration).toContain("left(substr(renamed.scope, length(additions.trigger_scope) + 2), 5) <> 'node/'");
    expect(migration).toContain(
      'WHERE NOT EXISTS (SELECT 1 FROM renamed AS existing WHERE existing.scope = added.scope)'
    );
  });

  it('preserves resource, folder, and node qualifiers and matches whole scope segments', () => {
    const migration = readMigration();
    expect(migration).toContain("left(entries.scope, length(candidate.old_scope) + 1) = candidate.old_scope || ':'");
    expect(migration).toContain('retired.new_scope || substr(matched.scope, length(matched.old_scope) + 1)');
    expect(migration).toContain('ORDER BY length(candidate.old_scope) DESC');
    expect(migration).not.toMatch(/LIKE/);
  });

  it('rewrites every stored scope column idempotently and removes its helper', () => {
    const migration = readMigration();
    for (const [table, column, keepRetired] of SCOPE_COLUMNS) {
      expect(migration, `${table}.${column}`).toContain(`UPDATE "${table}"`);
      expect(migration, `${table}.${column}`).toContain(
        `"${column}" IS DISTINCT FROM ${LEGACY_INSTALL_DIR_NAME}_scope_catalog_cleanup_0200("${column}", ${keepRetired})`
      );
    }
    expect(migration).toContain('WHERE matched.old_scope IS NULL OR keep_retired');
    // Finished tool calls are history: only calls that can still run are rewritten.
    expect(migration).toContain(`WHERE "status" IN ('created', 'pending_approval', 'approved', 'running')`);
    expect(migration).toContain(`DROP FUNCTION ${LEGACY_INSTALL_DIR_NAME}_scope_catalog_cleanup_0200(jsonb, boolean);`);
    expect(migration).not.toMatch(/DELETE FROM|DROP TABLE|ALTER TABLE/i);
  });
});
