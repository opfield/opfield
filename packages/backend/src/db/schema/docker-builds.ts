import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { dockerComposeProjects, dockerComposeRevisions } from './docker-compose.js';
import { dockerDeployments } from './docker-deployments.js';
import { integrationConnectorProjects, integrationConnectors } from './integration-connectors.js';
import { nodes } from './nodes.js';
import { sslCertificates } from './ssl-certificates.js';
import { users } from './users.js';

export type DockerSourceTargetKind = 'container' | 'deployment' | 'compose_project' | 'pages_project';
export type PagesBuildPackageManager = 'npm' | 'pnpm' | 'yarn';
/** Why a build was queued; `attach`: the source was attached, or its repository or branch changed, and builds its head. */
export type DockerBuildTrigger =
  | 'manual'
  | 'gitlab_push'
  | 'github_push'
  | 'generic_webhook'
  | 'poll'
  | 'retry'
  | 'attach';
export type DockerBuildStatus =
  | 'queued'
  | 'claimed'
  | 'checking_out'
  | 'building'
  | 'scanning'
  | 'pushing'
  | 'deploying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'superseded';
export type DockerBuildBatchStatus =
  | 'building'
  | 'awaiting_approval'
  | 'applying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'superseded';
export type DockerArtifactStatus = 'pending' | 'ready' | 'rejected' | 'deleting' | 'deleted';
export type DockerArtifactPolicyDecision = 'pending' | 'approved' | 'rejected' | 'error';
export type DockerArtifactPinKind = 'active' | 'rollback' | 'build_in_progress' | 'manual';
export type DockerArtifactOwnerKind = 'build' | 'availability' | 'promotion';
export type DockerInternalRegistryStatus =
  | 'starting'
  | 'ready'
  | 'read_only'
  | 'maintenance'
  | 'degraded'
  | 'unhealthy';
export type DockerRegistryMaintenancePhase =
  | 'idle'
  | 'acquiring_lease'
  | 'pausing_admission'
  | 'draining_uploads'
  | 'computing_pins'
  | 'deleting_manifests'
  | 'entering_read_only'
  | 'collecting_blobs'
  | 'verifying'
  | 'restoring_writes'
  | 'switching_storage'
  | 'failed';

export type DockerBuildVulnerabilityScope = 'all' | 'application' | 'fixable_application' | 'fixable_all';

export interface DockerBuildPolicySnapshot {
  vulnerabilityThreshold?: string;
  vulnerabilityScope?: DockerBuildVulnerabilityScope;
  [key: string]: unknown;
}

export interface DockerComposeBuildSpec {
  serviceName: string;
  dockerfilePath: string;
  contextPath: string;
  buildArgs: Record<string, string>;
}

export interface DockerComposeBuildPlan {
  sourceYaml: string;
  services: DockerComposeBuildSpec[];
}

export interface DockerBuildSeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

export interface DockerBuildScanSummary {
  scanner?: string;
  skipped?: boolean;
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  vulnerabilities?: DockerBuildVulnerability[];
  vulnerabilitiesTruncated?: number;
  osPackages?: DockerBuildSeverityCounts;
  /** Findings with a released fix, over the full report. */
  fixable?: DockerBuildSeverityCounts;
  /** Findings with a released fix in OS packages (deb, rpm, apk, alpm). */
  fixableOsPackages?: DockerBuildSeverityCounts;
  policyScope?: DockerBuildVulnerabilityScope;
  [key: string]: unknown;
}

export interface DockerBuildVulnerability {
  id: string;
  severity: string;
  packageName: string;
  installedVersion: string;
  packageType: string;
  fixedVersions: string[];
  fixState: string;
  namespace: string;
  dataSource: string;
}

export const dockerSourceBindings = pgTable(
  'docker_source_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetKind: varchar('target_kind', { length: 32 }).$type<DockerSourceTargetKind>().notNull(),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'cascade' }),
    containerName: text('container_name'),
    deploymentId: uuid('deployment_id').references(() => dockerDeployments.id, { onDelete: 'cascade' }),
    composeProjectId: uuid('compose_project_id').references(() => dockerComposeProjects.id, { onDelete: 'cascade' }),
    pageProjectId: uuid('page_project_id'),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => integrationConnectors.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => integrationConnectorProjects.id, { onDelete: 'restrict' }),
    repositoryRemoteId: text('repository_remote_id').notNull(),
    repositoryFullPath: text('repository_full_path').notNull(),
    repositoryCloneUrl: text('repository_clone_url').notNull(),
    branch: text('branch').notNull(),
    dockerfilePath: text('dockerfile_path').notNull().default('Dockerfile'),
    contextPath: text('context_path').notNull().default('.'),
    composeFilePath: text('compose_file_path'),
    composeVariables: jsonb('compose_variables').$type<Record<string, string>>().notNull().default({}),
    composeSecretKeys: text('compose_secret_keys').array().notNull().default([]),
    composeBuildPlan: jsonb('compose_build_plan').$type<DockerComposeBuildPlan>(),
    autoBuild: boolean('auto_build').notNull().default(true),
    autoDeploy: boolean('auto_deploy').notNull().default(true),
    initialConfig: jsonb('initial_config').$type<Record<string, unknown>>(),
    buildArgs: jsonb('build_args').$type<Record<string, string>>().notNull().default({}),
    buildSecretNames: text('build_secret_names').array().notNull().default([]),
    configGeneration: integer('config_generation').notNull().default(1),
    applicationRoot: text('application_root').notNull().default('.'),
    packageManager: varchar('package_manager', { length: 16 }).$type<PagesBuildPackageManager>(),
    packageManagerVersion: varchar('package_manager_version', { length: 64 }),
    nodeVersion: varchar('node_version', { length: 16 }),
    buildScript: varchar('build_script', { length: 128 }),
    artifactDirectory: text('artifact_directory'),
    publishTag: varchar('publish_tag', { length: 63 }),
    policy: jsonb('policy').$type<DockerBuildPolicySnapshot>().notNull().default({}),
    desiredCommitSha: varchar('desired_commit_sha', { length: 64 }),
    deployedCommitSha: varchar('deployed_commit_sha', { length: 64 }),
    deployingCommitSha: varchar('deploying_commit_sha', { length: 64 }),
    lastResolvedAt: timestamp('last_resolved_at', { withTimezone: true }),
    lastPollAt: timestamp('last_poll_at', { withTimezone: true }),
    lastPollError: text('last_poll_error'),
    webhookConfiguredAt: timestamp('webhook_configured_at', { withTimezone: true }),
    webhookProviderId: text('webhook_provider_id'),
    lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true }),
    lastWebhookError: text('last_webhook_error'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'docker_source_bindings_target_shape_check',
      sql`(${table.targetKind} = 'container' AND ${table.nodeId} IS NOT NULL AND ${table.containerName} IS NOT NULL AND ${table.deploymentId} IS NULL AND ${table.composeProjectId} IS NULL AND ${table.pageProjectId} IS NULL AND ${table.composeFilePath} IS NULL) OR (${table.targetKind} = 'deployment' AND ${table.nodeId} IS NULL AND ${table.containerName} IS NULL AND ${table.deploymentId} IS NOT NULL AND ${table.composeProjectId} IS NULL AND ${table.pageProjectId} IS NULL AND ${table.composeFilePath} IS NULL) OR (${table.targetKind} = 'compose_project' AND ${table.nodeId} IS NULL AND ${table.containerName} IS NULL AND ${table.deploymentId} IS NULL AND ${table.composeProjectId} IS NOT NULL AND ${table.pageProjectId} IS NULL AND ${table.composeFilePath} IS NOT NULL) OR (${table.targetKind} = 'pages_project' AND ${table.nodeId} IS NULL AND ${table.containerName} IS NULL AND ${table.deploymentId} IS NULL AND ${table.composeProjectId} IS NULL AND ${table.pageProjectId} IS NOT NULL AND ${table.composeFilePath} IS NULL)`
    ),
    check('docker_source_bindings_branch_not_blank_check', sql`length(trim(${table.branch})) > 0`),
    check(
      'docker_source_bindings_pages_build_config_check',
      sql`(${table.targetKind} = 'pages_project' AND ${table.packageManager} IN ('npm', 'pnpm', 'yarn') AND ${table.nodeVersion} IN ('20', '22', '24') AND ${table.buildScript} IS NOT NULL AND length(trim(${table.buildScript})) > 0 AND ${table.artifactDirectory} IS NOT NULL AND length(trim(${table.artifactDirectory})) > 0 AND ${table.publishTag} IS NOT NULL) OR (${table.targetKind} <> 'pages_project' AND ${table.packageManager} IS NULL AND ${table.packageManagerVersion} IS NULL AND ${table.nodeVersion} IS NULL AND ${table.buildScript} IS NULL AND ${table.artifactDirectory} IS NULL AND ${table.publishTag} IS NULL)`
    ),
    check('docker_source_bindings_dockerfile_not_absolute_check', sql`${table.dockerfilePath} !~ '^/'`),
    check('docker_source_bindings_context_not_absolute_check', sql`${table.contextPath} !~ '^/'`),
    check(
      'docker_source_bindings_compose_file_not_absolute_check',
      sql`${table.composeFilePath} IS NULL OR (${table.composeFilePath} !~ '^/' AND ('/' || ${table.composeFilePath} || '/') NOT LIKE '%/../%')`
    ),
    uniqueIndex('docker_source_bindings_container_unique')
      .on(table.nodeId, table.containerName)
      .where(sql`${table.targetKind} = 'container'`),
    uniqueIndex('docker_source_bindings_deployment_unique')
      .on(table.deploymentId)
      .where(sql`${table.targetKind} = 'deployment'`),
    uniqueIndex('docker_source_bindings_compose_project_unique')
      .on(table.composeProjectId)
      .where(sql`${table.targetKind} = 'compose_project'`),
    uniqueIndex('docker_source_bindings_page_project_unique')
      .on(table.pageProjectId)
      .where(sql`${table.targetKind} = 'pages_project'`),
    index('docker_source_bindings_connector_project_idx').on(table.connectorId, table.projectId),
    index('docker_source_bindings_desired_commit_idx').on(table.desiredCommitSha),
  ]
);

export const dockerBuildSecrets = pgTable(
  'docker_build_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceBindingId: uuid('source_binding_id')
      .notNull()
      .references(() => dockerSourceBindings.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    encryptedValue: text('encrypted_value').notNull(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('docker_build_secrets_binding_name_unique').on(table.sourceBindingId, table.name),
    index('docker_build_secrets_binding_idx').on(table.sourceBindingId),
  ]
);

export const dockerBuildBatches = pgTable(
  'docker_build_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceBindingId: uuid('source_binding_id')
      .notNull()
      .references(() => dockerSourceBindings.id, { onDelete: 'cascade' }),
    dedupeKey: text('dedupe_key').notNull(),
    commitSha: varchar('commit_sha', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).$type<DockerBuildBatchStatus>().notNull().default('building'),
    expectedServices: jsonb('expected_services').$type<string[]>().notNull(),
    composeBuildPlan: jsonb('compose_build_plan').$type<DockerComposeBuildPlan>().notNull(),
    composeVariables: jsonb('compose_variables').$type<Record<string, string>>().notNull().default({}),
    composeSecretKeys: text('compose_secret_keys').array().notNull().default([]),
    candidateRevisionId: uuid('candidate_revision_id').references(() => dockerComposeRevisions.id, {
      onDelete: 'set null',
    }),
    supersededByBatchId: uuid('superseded_by_batch_id').references((): AnyPgColumn => dockerBuildBatches.id, {
      onDelete: 'set null',
    }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('docker_build_batches_dedupe_unique').on(table.dedupeKey),
    index('docker_build_batches_source_created_idx').on(table.sourceBindingId, table.createdAt),
    index('docker_build_batches_status_idx').on(table.status, table.updatedAt),
  ]
);

export const dockerSourceWebhookDeliveries = pgTable(
  'docker_source_webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceBindingId: uuid('source_binding_id')
      .notNull()
      .references(() => dockerSourceBindings.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).$type<'gitlab' | 'github' | 'git'>().notNull(),
    deliveryId: text('delivery_id').notNull(),
    payloadSha256: varchar('payload_sha256', { length: 64 }).notNull(),
    commitSha: varchar('commit_sha', { length: 64 }),
    accepted: boolean('accepted').notNull().default(false),
    errorCode: text('error_code'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('docker_source_webhook_delivery_unique').on(table.sourceBindingId, table.deliveryId),
    index('docker_source_webhook_delivery_received_idx').on(table.receivedAt),
  ]
);

export const dockerBuilds = pgTable(
  'docker_builds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceBindingId: uuid('source_binding_id')
      .notNull()
      .references(() => dockerSourceBindings.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id').references(() => dockerBuildBatches.id, { onDelete: 'cascade' }),
    dedupeKey: text('dedupe_key').notNull(),
    trigger: varchar('trigger', { length: 32 }).$type<DockerBuildTrigger>().notNull(),
    triggerDeliveryId: text('trigger_delivery_id'),
    repositoryRemoteId: text('repository_remote_id').notNull(),
    repositoryFullPath: text('repository_full_path').notNull(),
    ref: text('ref').notNull(),
    commitSha: varchar('commit_sha', { length: 64 }).notNull(),
    serviceName: text('service_name'),
    dockerfilePath: text('dockerfile_path').notNull().default('Dockerfile'),
    contextPath: text('context_path').notNull().default('.'),
    buildArgs: jsonb('build_args').$type<Record<string, string>>().notNull().default({}),
    applicationRoot: text('application_root').notNull().default('.'),
    packageManager: varchar('package_manager', { length: 16 }).$type<PagesBuildPackageManager>(),
    packageManagerVersion: varchar('package_manager_version', { length: 64 }),
    nodeVersion: varchar('node_version', { length: 16 }),
    buildScript: varchar('build_script', { length: 128 }),
    artifactDirectory: text('artifact_directory'),
    publishTag: varchar('publish_tag', { length: 63 }),
    sourceConfigGeneration: integer('source_config_generation').notNull().default(1),
    status: varchar('status', { length: 32 }).$type<DockerBuildStatus>().notNull().default('queued'),
    builderNodeId: uuid('builder_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    platform: varchar('platform', { length: 64 }),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    leaseOwner: text('lease_owner'),
    leaseHeartbeatAt: timestamp('lease_heartbeat_at', { withTimezone: true }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    cancellationRequestedAt: timestamp('cancellation_requested_at', { withTimezone: true }),
    cancellationRequestedById: uuid('cancellation_requested_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    supersededByBuildId: uuid('superseded_by_build_id').references((): AnyPgColumn => dockerBuilds.id, {
      onDelete: 'set null',
    }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    progress: jsonb('progress').$type<Record<string, unknown>>().notNull().default({}),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('docker_builds_dedupe_key_unique').on(table.dedupeKey),
    index('docker_builds_binding_created_idx').on(table.sourceBindingId, table.createdAt),
    index('docker_builds_status_lease_idx').on(table.status, table.leaseExpiresAt),
    index('docker_builds_builder_status_idx').on(table.builderNodeId, table.status),
    index('docker_builds_commit_idx').on(table.sourceBindingId, table.commitSha),
    uniqueIndex('docker_builds_batch_service_unique').on(table.batchId, table.serviceName),
    index('docker_builds_batch_status_idx').on(table.batchId, table.status),
    check('docker_builds_attempt_range_check', sql`${table.attempt} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 20`),
  ]
);

export const dockerBuildLogChunks = pgTable(
  'docker_build_log_chunks',
  {
    buildId: uuid('build_id')
      .notNull()
      .references(() => dockerBuilds.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    content: text('content').notNull(),
    byteLength: integer('byte_length').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.buildId, table.sequence], name: 'docker_build_log_chunks_pkey' }),
    check('docker_build_log_chunks_sequence_check', sql`${table.sequence} >= 0`),
    check('docker_build_log_chunks_size_check', sql`${table.byteLength} BETWEEN 0 AND 262144`),
  ]
);

export const dockerBuildArtifacts = pgTable(
  'docker_build_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    buildId: uuid('build_id').references(() => dockerBuilds.id, { onDelete: 'cascade' }),
    sourceBindingId: uuid('source_binding_id').references(() => dockerSourceBindings.id, { onDelete: 'cascade' }),
    ownerKind: varchar('owner_kind', { length: 32 }).$type<DockerArtifactOwnerKind>().notNull().default('build'),
    ownerKey: text('owner_key'),
    sourceImageReference: text('source_image_reference'),
    registryRepository: text('registry_repository').notNull(),
    digest: varchar('digest', { length: 128 }).notNull(),
    platform: varchar('platform', { length: 64 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    status: varchar('status', { length: 32 }).$type<DockerArtifactStatus>().notNull().default('pending'),
    sbomDigest: varchar('sbom_digest', { length: 128 }),
    provenanceDigest: varchar('provenance_digest', { length: 128 }),
    scanSummary: jsonb('scan_summary').$type<DockerBuildScanSummary>(),
    policyDecision: varchar('policy_decision', { length: 32 })
      .$type<DockerArtifactPolicyDecision>()
      .notNull()
      .default('pending'),
    policyReason: text('policy_reason'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('docker_build_artifacts_build_unique').on(table.buildId).where(sql`${table.buildId} IS NOT NULL`),
    uniqueIndex('docker_build_artifacts_availability_unique')
      .on(table.ownerKind, table.ownerKey, table.registryRepository)
      .where(sql`${table.ownerKind} = 'availability'`),
    index('docker_build_artifacts_repository_digest_platform_idx').on(
      table.registryRepository,
      table.digest,
      table.platform
    ),
    index('docker_build_artifacts_binding_created_idx').on(table.sourceBindingId, table.createdAt),
    index('docker_build_artifacts_status_idx').on(table.status, table.policyDecision),
    check('docker_build_artifacts_digest_check', sql`${table.digest} ~ '^sha256:[0-9a-f]{64}$'`),
    check(
      'docker_build_artifacts_owner_check',
      sql`(
        ${table.ownerKind} = 'build'
        AND ${table.buildId} IS NOT NULL
        AND ${table.sourceBindingId} IS NOT NULL
        AND ${table.ownerKey} IS NULL
        AND ${table.sourceImageReference} IS NULL
      ) OR (
        ${table.ownerKind} IN ('availability', 'promotion')
        AND ${table.buildId} IS NULL
        AND ${table.sourceBindingId} IS NULL
        AND ${table.ownerKey} IS NOT NULL
        AND ${table.sourceImageReference} IS NOT NULL
      )`
    ),
  ]
);

export const dockerArtifactPins = pgTable(
  'docker_artifact_pins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => dockerBuildArtifacts.id, { onDelete: 'cascade' }),
    composeRevisionId: uuid('compose_revision_id').references(() => dockerComposeRevisions.id, {
      onDelete: 'cascade',
    }),
    kind: varchar('kind', { length: 32 }).$type<DockerArtifactPinKind>().notNull(),
    ownerKey: text('owner_key').notNull(),
    reason: text('reason'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('docker_artifact_pins_artifact_kind_owner_unique').on(table.artifactId, table.kind, table.ownerKey),
    index('docker_artifact_pins_owner_idx').on(table.ownerKey, table.kind),
    index('docker_artifact_pins_expiry_idx').on(table.expiresAt),
  ]
);

export const dockerInternalRegistryState = pgTable('docker_internal_registry_state', {
  id: text('id').primaryKey().default('system'),
  status: varchar('status', { length: 32 }).$type<DockerInternalRegistryStatus>().notNull().default('starting'),
  writable: boolean('writable').notNull().default(false),
  storageBackend: varchar('storage_backend', { length: 32 }).notNull().default('filesystem'),
  storageUsedBytes: bigint('storage_used_bytes', { mode: 'number' }).notNull().default(0),
  storageCapacityBytes: bigint('storage_capacity_bytes', { mode: 'number' }),
  externalAccessEnabled: boolean('external_access_enabled').notNull().default(false),
  externalHostname: text('external_hostname'),
  externalNginxNodeId: uuid('external_nginx_node_id').references(() => nodes.id, { onDelete: 'set null' }),
  externalCertificateId: uuid('external_certificate_id').references(() => sslCertificates.id, { onDelete: 'set null' }),
  maintenancePhase: varchar('maintenance_phase', { length: 32 })
    .$type<DockerRegistryMaintenancePhase>()
    .notNull()
    .default('idle'),
  maintenanceLeaseOwner: text('maintenance_lease_owner'),
  maintenanceLeaseExpiresAt: timestamp('maintenance_lease_expires_at', { withTimezone: true }),
  lastGcAt: timestamp('last_gc_at', { withTimezone: true }),
  nextGcAt: timestamp('next_gc_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const dockerRegistryMaintenanceRuns = pgTable(
  'docker_registry_maintenance_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phase: varchar('phase', { length: 32 }).$type<DockerRegistryMaintenancePhase>().notNull(),
    status: varchar('status', { length: 32 }).notNull().default('running'),
    dryRun: boolean('dry_run').notNull().default(false),
    leaseOwner: text('lease_owner').notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    progress: jsonb('progress').$type<Record<string, unknown>>().notNull().default({}),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('docker_registry_maintenance_status_idx').on(table.status, table.leaseExpiresAt),
    index('docker_registry_maintenance_created_idx').on(table.createdAt),
  ]
);
