import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { LEGACY_PAGES_HOST_KEY } from '@/lib/legacy-compat.js';
import { accessLists } from './access-lists.js';
import { appEnvironments, apps } from './apps.js';
import { domains } from './domains.js';
import { nodes } from './nodes.js';
import { proxyHosts } from './proxy-hosts.js';
import { sslCertificates } from './ssl-certificates.js';
import { users } from './users.js';

export const pageDeploymentStatusEnum = pgEnum('page_deployment_status', [
  'uploading',
  'validating',
  'stored',
  'staging',
  'ready',
  'failed',
  'cleaning',
  'deleted',
]);

export const pageUploadStatusEnum = pgEnum('page_upload_status', [
  'open',
  'finalizing',
  'complete',
  'failed',
  'expired',
]);

export const pageReplicaStatusEnum = pgEnum('page_replica_status', [
  'pending',
  'uploading',
  'materializing',
  'ready',
  'failed',
  'capability_missing',
  'cleanup_pending',
  'revoked',
]);

export const pageReplicaPurposeEnum = pgEnum('page_replica_purpose', ['preview', 'route', 'migration', 'storage']);

export const pageTagActivationStatusEnum = pgEnum('page_tag_activation_status', [
  'requested',
  'staging_consumers',
  'switching',
  'ready',
  'rolling_back',
  'failed',
]);

export const pageProfileStatusEnum = pgEnum('page_profile_status', [
  'disabled',
  'pending',
  'ready',
  'degraded',
  'capability_missing',
  'migration_pending',
]);

export const pageRouteTargetStatusEnum = pgEnum('page_route_target_status', [
  'pending',
  'staging',
  'ready',
  'failed',
  'capability_missing',
]);

export const pageIngressMigrationStatusEnum = pgEnum('page_ingress_migration_status', [
  'preflight',
  'staging',
  'applying',
  'switching_dns',
  'verifying',
  'cleanup_pending',
  'complete',
  'failed',
  'needs_attention',
]);

export const pageIngressMigrationSubjectEnum = pgEnum('page_ingress_migration_subject', ['wildcard_profile', 'route']);

export const pageProjectMigrationStatusEnum = pgEnum('page_project_migration_status', [
  'staging',
  'cleanup_pending',
  'failed',
]);

export interface PageDeploymentSourceMetadata {
  provider?: string;
  repository?: string;
  commitSha?: string;
  ref?: string;
  mergeRequest?: string;
  actor?: string;
  [key: string]: string | undefined;
}

export const pageProjectFolders = pgTable(
  'page_project_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => pageProjectFolders.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    depth: integer('depth').notNull().default(0),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Hidden app folders (decision: app members live in folders of their own type): set only by the apps module.
    appId: uuid('app_id').references(() => apps.id, { onDelete: 'restrict' }),
    appEnvironmentId: uuid('app_environment_id').references(() => appEnvironments.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('page_project_folders_parent_idx').on(table.parentId),
    index('page_project_folders_sort_idx').on(table.parentId, table.sortOrder),
    index('page_project_folders_app_idx').on(table.appId),
    check('page_project_folders_app_env_check', sql`${table.appEnvironmentId} IS NULL OR ${table.appId} IS NOT NULL`),
    uniqueIndex('page_project_folders_app_root_unique')
      .on(table.appId)
      .where(sql`${table.appId} IS NOT NULL AND ${table.appEnvironmentId} IS NULL`),
    uniqueIndex('page_project_folders_app_env_unique')
      .on(table.appEnvironmentId)
      .where(sql`${table.appEnvironmentId} IS NOT NULL`),
  ]
);

export const pageProjects = pgTable(
  'page_projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 60 }).notNull(),
    // Random, never derived from the name. Prefixes every Tag preview label and
    // is replaced (with every Deployment preview slug) by a link rotation. Opfield
    // sets it; the database default (0221) covers inserts by releases before v2.11.
    previewHash: varchar('preview_hash', { length: 12 }).notNull().default(sql`opfield_page_preview_hash()`),
    description: text('description'),
    appearanceColor: varchar('appearance_color', { length: 32 }),
    previewsEnabled: boolean('previews_enabled').notNull().default(true),
    spaFallback: boolean('spa_fallback').notNull().default(false),
    fallbackUrl: text('fallback_url'),
    // Applies to every preview host of the Project (Deployment and Tag). Restrict
    // deletion: silently dropping it would publish protected previews.
    accessListId: uuid('access_list_id').references(() => accessLists.id, { onDelete: 'restrict' }),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    migrationSourceNodeId: uuid('migration_source_node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    migrationTargetNodeId: uuid('migration_target_node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    migrationStatus: pageProjectMigrationStatusEnum('migration_status'),
    migrationGeneration: integer('migration_generation').notNull().default(0),
    migrationError: text('migration_error'),
    folderId: uuid('folder_id').references(() => pageProjectFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    maxDeployments: integer('max_deployments').notNull().default(20),
    storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'number' }).notNull().default(1_073_741_824),
    storageUsedBytes: bigint('storage_used_bytes', { mode: 'number' }).notNull().default(0),
    nextDeploymentSequence: integer('next_deployment_sequence').notNull().default(1),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('page_projects_slug_unique').on(table.slug),
    uniqueIndex('page_projects_preview_hash_unique').on(table.previewHash),
    index('page_projects_access_list_idx').on(table.accessListId),
    index('page_projects_folder_idx').on(table.folderId),
    index('page_projects_sort_idx').on(table.folderId, table.sortOrder),
    index('page_projects_created_by_idx').on(table.createdById),
    index('page_projects_node_idx').on(table.nodeId),
    index('page_projects_migration_idx').on(table.migrationStatus, table.migrationTargetNodeId),
  ]
);

export const pageDeployments = pgTable(
  'page_deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => pageProjects.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    publicSlug: varchar('public_slug', { length: 16 }).notNull(),
    previewHostname: varchar('preview_hostname', { length: 253 }),
    status: pageDeploymentStatusEnum('status').notNull().default('uploading'),
    artifactKey: text('artifact_key'),
    artifactSha256: varchar('artifact_sha256', { length: 64 }),
    compressedSizeBytes: bigint('compressed_size_bytes', { mode: 'number' }).notNull().default(0),
    expandedSizeBytes: bigint('expanded_size_bytes', { mode: 'number' }).notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),
    sourceMetadata: jsonb('source_metadata').$type<PageDeploymentSourceMetadata>().notNull().default({}),
    idempotencyKey: varchar('idempotency_key', { length: 255 }),
    requestedTag: varchar('requested_tag', { length: 63 }),
    deployTokenId: uuid('deploy_token_id').references(() => pageDeployTokens.id, { onDelete: 'set null' }),
    pinned: boolean('pinned').notNull().default(false),
    failureCode: varchar('failure_code', { length: 128 }),
    failureMessage: text('failure_message'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // Optional. Only a Deployment with an expiry is ever expired by maintenance.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('page_deployments_public_slug_unique').on(table.publicSlug),
    uniqueIndex('page_deployments_preview_hostname_unique').on(table.previewHostname),
    uniqueIndex('page_deployments_project_sequence_unique').on(table.projectId, table.sequence),
    uniqueIndex('page_deployments_project_idempotency_unique').on(table.projectId, table.idempotencyKey),
    index('page_deployments_project_status_idx').on(table.projectId, table.status),
    index('page_deployments_project_created_idx').on(table.projectId, table.createdAt),
    index('page_deployments_expires_idx').on(table.expiresAt).where(sql`${table.expiresAt} is not null`),
  ]
);

export const pageTags = pgTable(
  'page_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => pageProjects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 63 }).notNull(),
    deploymentId: uuid('deployment_id').references(() => pageDeployments.id, { onDelete: 'restrict' }),
    system: boolean('system').notNull().default(false),
    generation: integer('generation').notNull().default(0),
    // `<project previewHash>-<name>.<Pages domain>`; null until first published
    // or when the label does not fit one DNS label.
    previewHostname: varchar('preview_hostname', { length: 253 }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('page_tags_project_name_unique').on(table.projectId, table.name),
    uniqueIndex('page_tags_preview_hostname_unique').on(table.previewHostname),
    index('page_tags_deployment_idx').on(table.deploymentId),
  ]
);

export type PageRuntimeConfigValue = Record<string, unknown>;

export const pageRuntimeConfigs = pgTable(
  'page_runtime_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => pageProjects.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id').references(() => pageTags.id, { onDelete: 'cascade' }),
    value: jsonb('value').$type<PageRuntimeConfigValue>().notNull().default({}),
    generation: integer('generation').notNull().default(0),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('page_runtime_configs_tag_unique').on(table.tagId),
    uniqueIndex('page_runtime_configs_default_unique').on(table.projectId).where(sql`${table.tagId} is null`),
    index('page_runtime_configs_project_idx').on(table.projectId),
  ]
);

export const pageDeployTokens = pgTable(
  'page_deploy_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => pageProjects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    tokenPrefix: varchar('token_prefix', { length: 32 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    allowedTagPatterns: jsonb('allowed_tag_patterns').$type<string[]>().notNull().default([]),
    allowUserTag: boolean('allow_user_tag').notNull().default(false),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedById: uuid('revoked_by_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('page_deploy_tokens_hash_unique').on(table.tokenHash),
    index('page_deploy_tokens_project_idx').on(table.projectId),
    index('page_deploy_tokens_prefix_idx').on(table.tokenPrefix),
  ]
);

export const pageUploadSessions = pgTable(
  'page_upload_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => pageDeployments.id, { onDelete: 'cascade' }),
    status: pageUploadStatusEnum('status').notNull().default('open'),
    declaredSizeBytes: bigint('declared_size_bytes', { mode: 'number' }).notNull(),
    declaredSha256: varchar('declared_sha256', { length: 64 }).notNull(),
    receivedBytes: bigint('received_bytes', { mode: 'number' }).notNull().default(0),
    tempKey: text('temp_key').notNull(),
    // `html` wraps one uploaded HTML file as index.html; `tar.gz`, or null for
    // content detection, keeps the archive as uploaded.
    artifactFormat: varchar('artifact_format', { length: 16 }),
    failureCode: varchar('failure_code', { length: 128 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('page_upload_sessions_deployment_unique').on(table.deploymentId),
    index('page_upload_sessions_status_expiry_idx').on(table.status, table.expiresAt),
  ]
);

export const pageDeploymentReplicas = pgTable(
  'page_deployment_replicas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => pageDeployments.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    purpose: pageReplicaPurposeEnum('purpose').notNull(),
    referenceId: varchar('reference_id', { length: 255 }).notNull(),
    status: pageReplicaStatusEnum('status').notNull().default('pending'),
    generation: integer('generation').notNull().default(0),
    runtimeConfigGeneration: integer('runtime_config_generation').notNull().default(0),
    appliedSha256: varchar('applied_sha256', { length: 64 }),
    lastErrorCode: varchar('last_error_code', { length: 128 }),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    cleanupAfter: timestamp('cleanup_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('page_deployment_replicas_reference_unique').on(
      table.deploymentId,
      table.nodeId,
      table.purpose,
      table.referenceId
    ),
    index('page_deployment_replicas_node_status_idx').on(table.nodeId, table.status),
    index('page_deployment_replicas_cleanup_idx').on(table.cleanupAfter),
  ]
);

export const pageTagActivations = pgTable(
  'page_tag_activations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => pageTags.id, { onDelete: 'cascade' }),
    fromDeploymentId: uuid('from_deployment_id').references(() => pageDeployments.id, { onDelete: 'restrict' }),
    toDeploymentId: uuid('to_deployment_id')
      .notNull()
      .references(() => pageDeployments.id, { onDelete: 'restrict' }),
    status: pageTagActivationStatusEnum('status').notNull().default('requested'),
    expectedGeneration: integer('expected_generation').notNull(),
    progress: jsonb('progress').$type<Record<string, unknown>>().notNull().default({}),
    failureCode: varchar('failure_code', { length: 128 }),
    failureMessage: text('failure_message'),
    requestedById: uuid('requested_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('page_tag_activations_tag_status_idx').on(table.tagId, table.status),
    index('page_tag_activations_target_idx').on(table.toDeploymentId),
  ]
);

export const pageWildcardProfiles = pgTable(
  'page_wildcard_profiles',
  {
    id: varchar('id', { length: 32 }).primaryKey().default('default'),
    enabled: boolean('enabled').notNull().default(false),
    domainId: uuid('domain_id').references(() => domains.id, { onDelete: 'restrict' }),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    certificateId: uuid('certificate_id').references(() => sslCertificates.id, { onDelete: 'set null' }),
    labelTemplate: varchar('label_template', { length: 255 }).notNull().default('{hash}'),
    status: pageProfileStatusEnum('status').notNull().default('disabled'),
    overrideSameRegistrableDomain: boolean('override_same_registrable_domain').notNull().default(false),
    overrideComparedHosts: jsonb('override_compared_hosts').$type<{
      [LEGACY_PAGES_HOST_KEY]: string;
      pagesHost: string;
    }>(),
    overrideAcknowledgedById: uuid('override_acknowledged_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    overrideAcknowledgedAt: timestamp('override_acknowledged_at', { withTimezone: true }),
    lastErrorCode: varchar('last_error_code', { length: 128 }),
    lastErrorMessage: text('last_error_message'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('page_wildcard_profiles_node_status_idx').on(table.nodeId, table.status)]
);

export const pageRouteTargets = pgTable(
  'page_route_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proxyHostId: uuid('proxy_host_id')
      .notNull()
      .references(() => proxyHosts.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => pageProjects.id, { onDelete: 'restrict' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => pageTags.id, { onDelete: 'restrict' }),
    activeDeploymentId: uuid('active_deployment_id').references(() => pageDeployments.id, { onDelete: 'restrict' }),
    includePath: text('include_path'),
    status: pageRouteTargetStatusEnum('status').notNull().default('pending'),
    generation: integer('generation').notNull().default(0),
    runtimeConfigGeneration: integer('runtime_config_generation').notNull().default(0),
    lastErrorCode: varchar('last_error_code', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('page_route_targets_proxy_host_unique').on(table.proxyHostId),
    index('page_route_targets_project_tag_idx').on(table.projectId, table.tagId),
    index('page_route_targets_active_deployment_idx').on(table.activeDeploymentId),
  ]
);

export const pageIngressMigrations = pgTable(
  'page_ingress_migrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectType: pageIngressMigrationSubjectEnum('subject_type').notNull(),
    subjectId: varchar('subject_id', { length: 255 }).notNull(),
    projectId: uuid('project_id').references(() => pageProjects.id, { onDelete: 'cascade' }),
    sourceNodeId: uuid('source_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    targetNodeId: uuid('target_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    status: pageIngressMigrationStatusEnum('status').notNull().default('preflight'),
    retainedDeploymentIds: jsonb('retained_deployment_ids').$type<string[]>().notNull().default([]),
    progress: jsonb('progress').$type<Record<string, unknown>>().notNull().default({}),
    errorCode: varchar('error_code', { length: 128 }),
    errorMessage: text('error_message'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('page_ingress_migrations_subject_idx').on(table.subjectType, table.subjectId),
    index('page_ingress_migrations_target_status_idx').on(table.targetNodeId, table.status),
    index('page_ingress_migrations_project_idx').on(table.projectId),
  ]
);
