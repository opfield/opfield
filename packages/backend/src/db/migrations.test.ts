import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_GUC_PROXY_DOMAIN_CONFLICTS, LEGACY_INSTALL_DIR_NAME } from '@/lib/legacy-compat.js';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function readMigrationJournal(): JournalEntry[] {
  const raw = readFileSync(join(process.cwd(), 'src/db/migrations/meta/_journal.json'), 'utf8');
  const parsed = JSON.parse(raw) as { entries: JournalEntry[] };
  return parsed.entries;
}

describe('drizzle migration metadata', () => {
  it('keeps journal entries monotonic and aligned with migration files', () => {
    const entries = readMigrationJournal();
    const journalTags = new Set(entries.map((entry) => entry.tag));
    const sqlTags = readdirSync(join(process.cwd(), 'src/db/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .map((file) => file.slice(0, -'.sql'.length))
      .sort();
    const snapshotTags = readdirSync(join(process.cwd(), 'src/db/migrations/meta'))
      .filter((file) => file.endsWith('_snapshot.json'))
      .map((file) => file.slice(0, -'_snapshot.json'.length))
      .sort();
    const journalPrefixes = entries.map((entry) => entry.tag.slice(0, 4));

    for (const [index, entry] of entries.entries()) {
      expect(entry.idx).toBe(index);
      expect(existsSync(join(process.cwd(), 'src/db/migrations', `${entry.tag}.sql`))).toBe(true);

      const previous = entries[index - 1];
      if (previous) {
        expect(entry.when).toBeGreaterThan(previous.when);
      }
    }

    expect(sqlTags.filter((tag) => !journalTags.has(tag))).toEqual([]);
    expect(journalPrefixes.filter((tag) => !snapshotTags.includes(tag))).toEqual([]);
    expect(snapshotTags.filter((tag) => !journalPrefixes.includes(tag))).toEqual([]);
    expect(snapshotTags.at(-1)).toBe(entries.at(-1)?.tag.slice(0, 4));
  });

  it('keeps historical core settlement estimation unknown during migration', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0187_core_attempt_usage_estimated.sql'),
      'utf8'
    );
    expect(migration.trim()).toBe('ALTER TABLE "inference_request_attempts" ADD COLUMN "usage_estimated" boolean;');
    const previous = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0186_snapshot.json'), 'utf8'));
    const current = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0187_snapshot.json'), 'utf8'));
    expect(current.prevId).toBe(previous.id);
    const column = current.tables['public.inference_request_attempts'].columns.usage_estimated;
    expect(column.notNull).toBe(false);
    expect(column.default).toBeUndefined();
    delete current.tables['public.inference_request_attempts'].columns.usage_estimated;
    expect(current.tables).toEqual(previous.tables);
  });

  it('keeps the AI search payload purge scoped to unsafe derived documents', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0053_ai_search_tool_payload_reset.sql'),
      'utf8'
    );

    expect(migration).toContain('"kind" IN');
    expect(migration).toContain("'tool_call'");
    expect(migration).toContain("'tool_result'");
    expect(migration).toContain("'window'");
    expect(migration).toContain('"role" = \'tool\'');
    expect(migration).not.toMatch(/DELETE FROM "ai_conversation_search_documents"\s*;$/m);
  });

  it('backfills the ordered node service address list from the legacy columns', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0145_perpetual_firebrand.sql'), 'utf8');

    expect(migration).toContain('ADD COLUMN "service_addresses" text[] DEFAULT \'{}\' NOT NULL');
    expect(migration).toContain('ARRAY_REMOVE(ARRAY["service_address", "secondary_service_address"], NULL)');
  });

  it('backfills resource slugs deterministically before enforcing constraints', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0056_strange_yellowjacket.sql'), 'utf8');

    expect(migration.match(/ORDER BY "created_at", "id"/g)).toHaveLength(3);
    expect(migration).toContain(`"${LEGACY_INSTALL_DIR_NAME}_slug_transliterate"`);
    expect(migration).toContain(`"${LEGACY_INSTALL_DIR_NAME}_slug_base"`);
    expect(migration).toContain(`"${LEGACY_INSTALL_DIR_NAME}_slug_candidate"`);
    expect(migration).toContain("WHEN \"base_value\" IN ('file', 'console') THEN 1");
    expect(migration).toContain('WHEN "base_value" = \'new\' THEN 1');

    for (const [table, constraint] of [
      ['nodes', 'nodes_slug_unique'],
      ['database_connections', 'database_connections_slug_unique'],
      ['proxy_hosts', 'proxy_hosts_slug_unique'],
    ]) {
      expect(migration).toContain(`ALTER TABLE "${table}" ALTER COLUMN "slug" SET NOT NULL`);
      expect(migration).toContain(`ADD CONSTRAINT "${constraint}" UNIQUE("slug")`);
    }

    expect(migration).not.toContain('ALTER TABLE "logging_environments"');
    expect(migration).not.toContain('ALTER TABLE "logging_schemas"');
  });

  it('creates encrypted inference credentials and an append-only usage ledger', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0064_glossy_celestials.sql'), 'utf8');

    expect(migration).toContain('"encrypted_payload" text NOT NULL');
    expect(migration).toContain('"encrypted_dek" text NOT NULL');
    expect(migration).not.toContain('"access_token"');
    expect(migration).not.toContain('"refresh_token"');
    expect(migration).toContain(`${LEGACY_INSTALL_DIR_NAME}_reject_inference_usage_ledger_mutation`);
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "inference_usage_ledger"');
  });

  it('keeps one active package-managed token per harness installation', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0071_new_zodiak.sql'), 'utf8');

    expect(migration).toContain('"managed_by" varchar(64)');
    expect(migration).toContain('"installation_id" uuid');
    expect(migration).toContain('"inference_tokens_managed_identity_active_unique"');
    expect(migration).toContain('"revoked_at" is null');
  });

  it('refreshes GPT-5.6 provider prices with the complete long-context tier', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0092_refresh_openai_gpt_5_6_pricing.sql'),
      'utf8'
    );

    expect(migration).toContain("'openai-api-2026-08-06'");
    expect(migration).toContain("WHEN 'gpt-5.6-terra' THEN 2000000");
    expect(migration).toContain("WHEN 'gpt-5.6-luna' THEN 200000");
    expect(migration).toContain("'long_context_threshold_tokens', 272000");
    expect(migration).toContain("'long_context_input_microdollars_per_million'");
    expect(migration).toContain('"snapshots"."source" = \'manual\'');
    expect(migration).toContain('ON CONFLICT ("source_id", "version") DO NOTHING');
  });

  it('removes the legacy relay database authorization surface', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0099_slow_karnak.sql'), 'utf8');

    expect(migration).toContain(`DROP VIEW IF EXISTS "public"."${LEGACY_INSTALL_DIR_NAME}_relay_node_identities_v1"`);
    expect(migration).toContain(`DROP VIEW IF EXISTS "public"."${LEGACY_INSTALL_DIR_NAME}_relay_managed_databases_v1"`);
    expect(migration).toContain(`DROP VIEW IF EXISTS "public"."${LEGACY_INSTALL_DIR_NAME}_relay_bindings_v1"`);
    expect(migration).toContain(`DROP OWNED BY ${LEGACY_INSTALL_DIR_NAME}_relay`);
    expect(migration).toContain(`DROP ROLE ${LEGACY_INSTALL_DIR_NAME}_relay`);
  });

  it('collapses existing inference token grants into the manage permission', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0078_collapse_inference_token_permissions.sql'),
      'utf8'
    );

    expect(migration).toContain("THEN 'inference:tokens:manage'");
    expect(migration).toContain('UPDATE "permission_groups"');
    expect(migration).toContain('UPDATE "users"');
    expect(migration).toContain('UPDATE "api_tokens"');
    expect(migration).toContain('UPDATE "oauth_authorization_codes"');
    expect(migration).toContain('UPDATE "ai_run_tool_calls"');
    expect(migration).toContain('UPDATE "sandbox_jobs"');
  });

  it('migrates inference use and personal usage grants into the canonical AI permission', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0114_collapse_inference_use_into_ai.sql'),
      'utf8'
    );

    expect(migration).toContain("WHEN entry.value IN ('inference:use', 'inference:usage:view:self')");
    expect(migration).toContain("THEN 'feat:ai:use'");
    expect(migration).toContain('UPDATE "permission_groups"');
    expect(migration).toContain('UPDATE "users"');
    expect(migration).toContain('UPDATE "api_tokens"');
    expect(migration).toContain('UPDATE "oauth_authorization_codes"');
    expect(migration).toContain('UPDATE "oauth_refresh_tokens"');
    expect(migration).toContain('UPDATE "oauth_access_tokens"');
    expect(migration).toContain('UPDATE "ai_run_tool_calls"');
    expect(migration).toContain('UPDATE "sandbox_jobs"');
    expect(migration).toContain("COALESCE(\"scopes\", '[]'::jsonb) - 'inference:use' - 'inference:usage:view:self'");
  });

  it('merges inference token management into AI use and backfills Workspace access', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0161_merge_inference_tokens_into_ai_use.sql'),
      'utf8'
    );

    expect(migration).toContain("WHEN entry.value = 'inference:tokens:manage' THEN 'feat:ai:use'");
    expect(migration).toContain('UPDATE "permission_groups"');
    expect(migration).toContain('UPDATE "users"');
    expect(migration).toContain('UPDATE "api_tokens"');
    expect(migration).toContain('UPDATE "oauth_authorization_codes"');
    expect(migration).toContain('UPDATE "oauth_refresh_tokens"');
    expect(migration).toContain('UPDATE "oauth_access_tokens"');
    expect(migration).toContain('UPDATE "ai_run_tool_calls"');
    expect(migration).toContain('UPDATE "sandbox_jobs"');
    expect(migration).toContain("WHERE \"name\" IN ('viewer', 'operator', 'admin', 'system-admin')");
    expect(migration).toContain("'ai:workspace:use'");
  });

  it('collapses GitLab registry-view grants into the canonical Docker registry permission', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0126_collapse_gitlab_registry_view.sql'),
      'utf8'
    );

    expect(migration).toContain("WHEN entry.value = 'integrations:gitlab:registry:view'");
    expect(migration).toContain("THEN 'docker:registries:view'");
    expect(migration).toContain('UPDATE "permission_groups"');
    expect(migration).toContain('UPDATE "users"');
    expect(migration).toContain('UPDATE "api_tokens"');
    expect(migration).toContain('UPDATE "oauth_authorization_codes"');
    expect(migration).toContain('UPDATE "oauth_refresh_tokens"');
    expect(migration).toContain('UPDATE "oauth_access_tokens"');
    expect(migration).toContain('UPDATE "ai_run_tool_calls"');
    expect(migration).toContain('UPDATE "sandbox_jobs"');
  });

  it('removes the OAuth-only inference setup scope from user assignments', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0154_remove_inference_setup_assignments.sql'),
      'utf8'
    );

    expect(migration).toContain('UPDATE "permission_groups"');
    expect(migration).toContain('UPDATE "users"');
    expect(migration).toContain("scope_value <> 'inference:setup'");
    expect(migration).not.toContain('UPDATE "oauth_access_tokens"');
    expect(migration).not.toContain('UPDATE "oauth_refresh_tokens"');
  });

  it('preserves the published 0155 migration before creating Compose tables and proxy bindings', () => {
    const entries = readMigrationJournal();
    const publishedScopeMigration = entries.findIndex((entry) => entry.tag === '0155_split_ai_workspace_access');
    const composeTables = entries.findIndex((entry) => entry.tag === '0156_organic_microbe');
    const composeProxyBindings = entries.findIndex((entry) => entry.tag === '0157_blue_network');

    expect(publishedScopeMigration).toBeGreaterThanOrEqual(0);
    expect(composeTables).toBe(publishedScopeMigration + 1);
    expect(composeProxyBindings).toBe(composeTables + 1);

    const composeMigration = readFileSync(join(process.cwd(), 'src/db/migrations/0156_organic_microbe.sql'), 'utf8');
    const proxyMigration = readFileSync(join(process.cwd(), 'src/db/migrations/0157_blue_network.sql'), 'utf8');
    expect(composeMigration).toContain('CREATE TABLE "docker_compose_projects"');
    expect(proxyMigration).toContain('REFERENCES "public"."docker_compose_projects"');
  });

  it('adds the Docker build platform after the Compose migration tail', () => {
    const entries = readMigrationJournal();
    const composeCleanup = entries.findIndex((entry) => entry.tag === '0158_clear_darkstar');
    const buildPlatform = entries.findIndex((entry) => entry.tag === '0159_rich_warbird');

    expect(composeCleanup).toBeGreaterThanOrEqual(0);
    expect(buildPlatform).toBe(composeCleanup + 1);

    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0159_rich_warbird.sql'), 'utf8');
    expect(migration).toContain('ALTER TYPE "public"."node_type" ADD VALUE \'builder\'');
    expect(migration).toContain('CREATE TABLE "docker_builds"');
    expect(migration).toContain('CREATE TABLE "docker_build_artifacts"');
    expect(migration).toContain('CREATE TABLE "docker_build_secrets"');
    expect(migration).toContain('CREATE TABLE "docker_source_bindings"');
    expect(migration).toContain('CREATE TABLE "docker_source_webhook_deliveries"');
    expect(migration).toContain('CREATE TABLE "docker_registry_node_bindings"');
    expect(migration).toContain('CREATE TABLE "docker_internal_registry_state"');
    expect(migration).toContain('ALTER TABLE "relay_endpoints" ALTER COLUMN "owner_id" SET DATA TYPE text');
    expect(migration).toContain('"docker_builds_superseded_by_build_id_docker_builds_id_fk"');
    expect(migration).toContain('"docker_build_artifacts_repository_digest_platform_idx"');
    expect(migration).not.toContain('"docker_build_artifacts_repository_digest_platform_unique"');
  });

  it('adds project-level Compose build batches after the base build platform', () => {
    const entries = readMigrationJournal();
    const buildPlatform = entries.findIndex((entry) => entry.tag === '0159_rich_warbird');
    const composeBuilds = entries.findIndex((entry) => entry.tag === '0160_lame_prodigy');

    expect(composeBuilds).toBe(buildPlatform + 1);
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0160_lame_prodigy.sql'), 'utf8');
    expect(migration).toContain('CREATE TABLE "docker_build_batches"');
    expect(migration).toContain('ADD COLUMN "compose_project_id" uuid');
    expect(migration).toContain('ADD COLUMN "batch_id" uuid');
    expect(migration).toContain('ADD COLUMN "compose_revision_id" uuid');
    expect(migration).toContain('docker_builds_batch_service_unique');
    expect(migration).toContain('docker_source_bindings_compose_project_unique');
    expect(migration).toContain("NOT LIKE '%/../%'");
  });

  it('preserves existing AI Workspace grants when splitting inference access', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0155_split_ai_workspace_access.sql'), 'utf8');

    expect(migration).toContain('UPDATE "permission_groups"');
    expect(migration).toContain('UPDATE "users"');
    expect(migration).toContain("'feat:ai:use'");
    expect(migration).toContain("'ai:workspace:use'");
    expect(migration).not.toContain('UPDATE "api_tokens"');
  });

  it('adds the inference core runtime tables without touching existing inference rows', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0139_inference_core_runtime.sql'), 'utf8');

    expect(migration).toContain('CREATE TABLE "inference_core_state"');
    expect(migration).toContain('CREATE TABLE "inference_core_operations"');
    expect(migration).toContain('CONSTRAINT "inference_core_state_singleton" CHECK');
    expect(migration).toContain('"inference_core_operations_running_unique"');
    expect(migration).toContain('ADD COLUMN "core_account_id" text');
    expect(migration).toContain('ADD COLUMN "core_model_id" text');
    expect(migration).toContain('ADD COLUMN "core_attempt_id" text');
    expect(migration).toContain('ADD COLUMN "parent_core_attempt_id" text');
    expect(migration).toContain('"inference_attempts_core_attempt_unique"');

    // Purely additive: no destructive or rewriting operation against the
    // existing inference tables or the immutable usage ledger.
    expect(migration).not.toMatch(/DROP TABLE/i);
    expect(migration).not.toMatch(/ALTER TABLE "inference_(requests|usage_ledger|quota_snapshots)"/i);
    expect(migration).not.toMatch(/ALTER COLUMN .* (DROP|SET) NOT NULL/i);
    expect(migration).not.toMatch(/DELETE FROM|UPDATE "inference_/i);
  });

  it('preserves a custom guest group before reserving the built-in name', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0115_reserve_guest_builtin_group.sql'),
      'utf8'
    );

    expect(migration).toContain('\'guest-custom-\' || "id"::text');
    expect(migration).toContain('WHERE "name" = \'guest\' AND "is_builtin" = false');
    expect(migration).not.toContain('DELETE FROM "permission_groups"');
  });

  it('backfills a random per-Project preview hash before enforcing it', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0206_pages_preview_links.sql'), 'utf8');
    const add = migration.indexOf('ADD COLUMN IF NOT EXISTS "preview_hash" varchar(12);');
    const backfill = migration.indexOf('UPDATE "page_projects" AS "project"');
    const notNull = migration.indexOf('ALTER COLUMN "preview_hash" SET NOT NULL');
    const unique = migration.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS "page_projects_preview_hash_unique"');
    expect(add).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(add);
    expect(notNull).toBeGreaterThan(backfill);
    expect(unique).toBeGreaterThan(notNull);
    // Random bytes, never derived from the name; evaluated per row (correlated) so rows never share a hash.
    expect(migration).toContain('gen_random_uuid()');
    expect(migration).toContain("'abcdefghijklmnopqrstuvwxyz234567'");
    expect(migration).toContain('WHERE "project"."id" IS NOT NULL');
    expect(migration).not.toMatch(/preview_hash[^\n]*"name"/);
    // Deleting an access list still used by previews is refused rather than silently unprotecting them.
    expect(migration).toContain('ON DELETE restrict');

    const previous = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0205_snapshot.json'), 'utf8'));
    const current = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0206_snapshot.json'), 'utf8'));
    expect(current.prevId).toBe(previous.id);
    const hash = current.tables['public.page_projects'].columns.preview_hash;
    expect(hash).toMatchObject({ type: 'varchar(12)', notNull: true });
    expect(hash.default).toBeUndefined();
    const changed = Object.keys(current.tables).filter(
      (table) => JSON.stringify(current.tables[table]) !== JSON.stringify(previous.tables[table])
    );
    expect(changed.sort()).toEqual([
      'public.page_deployments',
      'public.page_projects',
      'public.page_tags',
      'public.page_upload_sessions',
    ]);
  });
  it('moves uniqueness guarantees into the database without failing on existing collisions', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0207_uniqueness_guarantees.sql'), 'utf8');
    const position = (text: string) => {
      const index = migration.indexOf(text);
      expect(index, text).toBeGreaterThan(-1);
      return index;
    };
    // Every collision is flagged or resolved before the unique index that would reject it is built.
    expect(position('INSERT INTO "node_host_port_reservations"')).toBeLessThan(
      position('CREATE TRIGGER "docker_deployment_routes_host_ports"')
    );
    expect(position('INSERT INTO "proxy_host_domains"')).toBeLessThan(
      position('CREATE UNIQUE INDEX IF NOT EXISTS "proxy_host_domains_node_domain_unique"')
    );
    expect(position('"phase" = \'superseded\'')).toBeLessThan(
      position('CREATE UNIQUE INDEX IF NOT EXISTS "backup_runs_policy_active_unique"')
    );
    expect(position("'storage.managed.renamed_duplicate'")).toBeLessThan(
      position('CREATE UNIQUE INDEX IF NOT EXISTS "managed_storage_clusters_node_name_active_unique"')
    );
    // Later owners of a shared port are recorded as conflicts, outside the unique index.
    expect(migration).toContain('WHERE "node_host_port_reservations"."conflict" = false');
    expect(migration).toMatch(/row_number\(\) OVER \(\s*PARTITION BY "owned"."node_id", "owned"."port"/);
    expect(migration).toContain(
      'WHERE "proxy_host_domains"."enabled" = true AND "proxy_host_domains"."legacy_conflict" = false'
    );
    // The newest active run is kept; older ones fail and give their executor lease back.
    // A running run is kept over a queued one, then the newest.
    expect(migration).toContain(
      'ORDER BY ("run"."status" = \'running\') DESC, "run"."created_at" DESC, "run"."id" DESC'
    );
    expect(migration).toContain('DELETE FROM "backup_run_node_leases" USING "superseded"');
    expect(migration).toContain('ON DELETE restrict');
    expect(migration).not.toMatch(/DELETE FROM "(managed_storage_clusters|proxy_hosts|docker_deployments)"/);

    const previous = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0206_snapshot.json'), 'utf8'));
    const current = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0207_snapshot.json'), 'utf8'));
    expect(current.prevId).toBe(previous.id);
    expect(
      current.tables['public.proxy_hosts'].foreignKeys.proxy_hosts_ssl_certificate_id_ssl_certificates_id_fk.onDelete
    ).toBe('restrict');
    expect(
      current.tables['public.node_host_port_reservations'].indexes.node_host_port_reservations_port_unique
    ).toMatchObject({
      isUnique: true,
      where: '"node_host_port_reservations"."conflict" = false',
    });
    const changed = Object.keys({ ...previous.tables, ...current.tables }).filter(
      (table) => JSON.stringify(current.tables[table]) !== JSON.stringify(previous.tables[table])
    );
    expect(changed.sort()).toEqual([
      'public.backup_runs',
      'public.managed_storage_clusters',
      'public.node_host_port_reservations',
      'public.proxy_host_domains',
      'public.proxy_hosts',
    ]);
  });
  it('moves operation leases out of settings into their own table', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0208_operation_leases.sql'), 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "operation_leases"');
    expect(migration).toContain('"key" text PRIMARY KEY NOT NULL');
    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS "operation_leases_expires_at_idx" ON "operation_leases" USING btree ("expires_at")'
    );
    // The minute-long lease rows kept in settings before are dropped, nothing else there.
    expect(migration).toContain(`DELETE FROM "settings" WHERE "key" LIKE 'operation-lease:%'`);
    expect(migration.match(/DELETE FROM/g)).toHaveLength(1);

    const previous = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0207_snapshot.json'), 'utf8'));
    const current = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0208_snapshot.json'), 'utf8'));
    expect(current.prevId).toBe(previous.id);
    const changed = Object.keys({ ...previous.tables, ...current.tables }).filter(
      (table) => JSON.stringify(current.tables[table]) !== JSON.stringify(previous.tables[table])
    );
    expect(changed).toEqual(['public.operation_leases']);
    expect(current.tables['public.operation_leases'].indexes.operation_leases_expires_at_idx).toMatchObject({
      isUnique: false,
      columns: [expect.objectContaining({ expression: 'expires_at' })],
    });
  });

  it('adds reservation holds, replica reservations and record-mode rollbacks without rewriting 0207', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0209_reservation_holds.sql'), 'utf8');
    for (const name of [
      'node_host_port_reservations_add',
      'node_host_port_reservations_reserve',
      'node_host_port_reservations_hold',
      'node_host_port_reservations_settle',
      'node_host_port_reservations_sync_owner',
      'node_host_port_reservations_reconcile',
      'docker_availability_replica_host_ports_sync',
      'proxy_hosts_domains_trigger',
      'managed_storage_cluster_take_free_name',
    ]) {
      expect(migration, name).toContain(`CREATE OR REPLACE FUNCTION "${name}"`);
    }
    // Holds survive the owner's own sync; only a node the owner left or a settle ends them.
    expect(migration).toContain('OR ("held"."pending_until" IS NULL AND NOT ("held"."host_port" = ANY ("v_ports")))');
    // Rollbacks record a clashing name instead of failing; an enabled-only change keeps the legacy flag.
    expect(migration).toContain(`current_setting('${LEGACY_GUC_PROXY_DOMAIN_CONFLICTS}', true)`);
    expect(migration).toContain(
      'UPDATE "proxy_host_domains" SET "enabled" = NEW."enabled" WHERE "proxy_host_id" = NEW."id"'
    );
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "node_host_port_reservations_node_port_idx"');
    expect(migration).toContain('CREATE TRIGGER "docker_availability_placements_host_ports"');
    expect(migration).not.toMatch(/DROP TABLE|DELETE FROM "(managed_storage_clusters|proxy_hosts|docker_deployments)"/);

    const previous = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0208_snapshot.json'), 'utf8'));
    const current = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0209_snapshot.json'), 'utf8'));
    expect(current.prevId).toBe(previous.id);
    const reservations = current.tables['public.node_host_port_reservations'];
    expect(reservations.columns.pending_until).toMatchObject({ type: 'timestamp with time zone', notNull: false });
    expect(reservations.indexes.node_host_port_reservations_node_port_idx).toMatchObject({ isUnique: false });
    expect(reservations.indexes.node_host_port_reservations_node_port_idx.where).toBeUndefined();
    expect(reservations.checkConstraints.node_host_port_reservations_owner_kind_valid.value).toContain(
      "'deployment_replica'"
    );
    const changed = Object.keys({ ...previous.tables, ...current.tables }).filter(
      (table) => JSON.stringify(current.tables[table]) !== JSON.stringify(previous.tables[table])
    );
    expect(changed).toEqual(['public.node_host_port_reservations']);
  });
});

describe('inference companion removal migration', () => {
  it('drops only the companion bookkeeping and its OAuth grants, keeping issued inference tokens', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0245_remove_inference_companion.sql'),
      'utf8'
    );
    for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens', 'oauth_authorization_codes']) {
      expect(migration).toContain(`DELETE FROM "${table}"\nWHERE "scopes" ? 'inference:setup'`);
    }
    expect(migration).toContain('DROP INDEX IF EXISTS "inference_tokens_managed_identity_active_unique"');
    for (const column of ['managed_by', 'harness', 'device_name', 'installation_id']) {
      expect(migration).toContain(`ALTER TABLE "inference_tokens" DROP COLUMN IF EXISTS "${column}"`);
    }
    expect(migration).not.toMatch(/DELETE FROM "inference_tokens"|DROP TABLE/);
    expect(migration).toContain(`"metadata" -> 'composition' ->> 'role' = 'vision_sidecar'`);

    const previous = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0244_snapshot.json'), 'utf8'));
    const current = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0245_snapshot.json'), 'utf8'));
    expect(current.prevId).toBe(previous.id);
    const tokens = current.tables['public.inference_tokens'];
    for (const column of ['managed_by', 'harness', 'device_name', 'installation_id']) {
      expect(tokens.columns[column]).toBeUndefined();
    }
    expect(tokens.indexes.inference_tokens_managed_identity_active_unique).toBeUndefined();
    const changed = Object.keys({ ...previous.tables, ...current.tables }).filter(
      (table) => JSON.stringify(current.tables[table]) !== JSON.stringify(previous.tables[table])
    );
    expect(changed).toEqual(['public.inference_tokens']);
  });
});

describe('Availability runtime name prefix migration', () => {
  it('keeps gwav for every placement that exists and gives new placements opfav', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0250_opfield_availability_runtime_names.sql'),
      'utf8'
    );
    const [add, setDefault] = migration
      .split('--> statement-breakpoint')
      .map((statement) => statement.replace(/^--.*$/gm, '').trim());
    expect(add).toBe(
      `ALTER TABLE "docker_availability_placements" ADD COLUMN "runtime_name_prefix" varchar(16) DEFAULT 'gwav' NOT NULL;`
    );
    expect(setDefault).toBe(
      `ALTER TABLE "docker_availability_placements" ALTER COLUMN "runtime_name_prefix" SET DEFAULT 'opfav';`
    );

    const previous = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0249_snapshot.json'), 'utf8'));
    const current = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0250_snapshot.json'), 'utf8'));
    expect(current.prevId).toBe(previous.id);
    expect(current.tables['public.docker_availability_placements'].columns.runtime_name_prefix).toEqual({
      name: 'runtime_name_prefix',
      type: 'varchar(16)',
      primaryKey: false,
      notNull: true,
      default: "'opfav'",
    });
  });
});

describe('Docker migration history node references', () => {
  it('drops the restrict foreign keys so a node with migration history can be deleted', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0251_opfield_migration_history_nodes.sql'),
      'utf8'
    );
    const statements = migration
      .split('--> statement-breakpoint')
      .map((statement) => statement.replace(/^--.*$/gm, '').trim());
    expect(statements).toEqual([
      'ALTER TABLE "docker_migrations" DROP CONSTRAINT "docker_migrations_source_node_id_nodes_id_fk";',
      'ALTER TABLE "docker_migrations" DROP CONSTRAINT "docker_migrations_target_node_id_nodes_id_fk";',
    ]);

    const previous = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0250_snapshot.json'), 'utf8'));
    const current = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/0251_snapshot.json'), 'utf8'));
    expect(current.prevId).toBe(previous.id);
    const table = current.tables['public.docker_migrations'];
    expect(Object.keys(table.foreignKeys).sort()).toEqual([
      'docker_migrations_cancellation_requested_by_id_users_id_fk',
      'docker_migrations_created_by_id_users_id_fk',
    ]);
    // The history keeps the node ids.
    expect(table.columns.source_node_id).toMatchObject({ type: 'uuid', notNull: true });
    expect(table.columns.target_node_id).toMatchObject({ type: 'uuid', notNull: true });
  });
});
