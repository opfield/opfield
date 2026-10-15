import { z } from '@hono/zod-openapi';
import {
  appRoute,
  createdJson,
  dataResponseSchema,
  IdParamSchema,
  jsonBody,
  okJson,
  optionalJsonBody,
  pathParamSchema,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import {
  ManagedCertificateStatusSchema,
  RenewManagedCertificateSchema,
} from '@/modules/managed-workloads/certificate-renewal.docs.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import {
  AddPostgresColumnSchema,
  BrowsePostgresRowsQuerySchema,
  BrowseSqlRowsQuerySchema,
  CreateDatabaseConnectionSchema,
  CreateManagedDatabaseBindingSchema,
  CreateManagedDatabaseSchema,
  DatabaseListQuerySchema,
  DeleteManagedDatabaseBindingSchema,
  DeletePostgresColumnSchema,
  DeleteSqlRowSchema,
  ExecutePostgresSqlSchema,
  ExecuteRedisCommandSchema,
  ExecuteSqlSchema,
  InsertSqlRowSchema,
  ManagedDatabaseAvailabilityCreatePreflightSchema,
  ManagedDatabaseListQuerySchema,
  MoveManagedDatabaseToValkeySchema,
  PostgresObjectSchema,
  RedisExpireKeySchema,
  RedisGetKeyQuerySchema,
  RedisScanKeysQuerySchema,
  RedisSetKeySchema,
  SqlTableQuerySchema,
  UpdateDatabaseConnectionSchema,
  UpdateManagedDatabaseSchema,
  UpdatePostgresColumnTypeSchema,
  UpdateSqlRowSchema,
} from './databases.schemas.js';
import { availabilityRouteDocs } from './managed-availability.docs.js';

const PostgresTableQuerySchema = BrowsePostgresRowsQuerySchema.pick({ schema: true, table: true });
const PostgresInsertRowSchema = PostgresTableQuerySchema.extend({
  values: PostgresObjectSchema,
});
const PostgresUpdateRowSchema = PostgresInsertRowSchema.extend({
  primaryKey: PostgresObjectSchema,
});
const PostgresDeleteRowSchema = PostgresTableQuerySchema.extend({
  primaryKey: PostgresObjectSchema,
});
const PostgresExtensionParamSchema = IdParamSchema.extend({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
});

export const listDatabaseConnectionsRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Databases'],
  summary: 'List database connections',
  request: { query: DatabaseListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listManagedDatabaseCatalogRoute = appRoute({
  method: 'get',
  path: '/managed/catalog',
  tags: ['Databases'],
  summary: 'List curated managed database versions',
  description:
    'Key-value stores work with Redis clients. New key-value stores run Valkey (`redis` lists only Valkey versions); a create that asks for an older Redis version gets the current Valkey version.',
  responses: okJson(UnknownDataResponseSchema),
});

export const listManagedDatabasesRoute = appRoute({
  method: 'get',
  path: '/managed',
  tags: ['Databases'],
  summary: 'List managed database instances',
  request: { query: ManagedDatabaseListQuerySchema },
  description:
    'Each instance reports `engine`. A key-value store (`type: "redis"`) reports `valkey` or, when it was created before 2.12 and not moved yet, `redis`.',
  responses: okJson(UnknownDataResponseSchema),
});

export const createManagedDatabaseRoute = appRoute({
  method: 'post',
  path: '/managed',
  tags: ['Databases'],
  summary: 'Deploy a managed database instance',
  request: jsonBody(CreateManagedDatabaseSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const getManagedDatabaseRoute = appRoute({
  method: 'get',
  path: '/managed/{id}',
  tags: ['Databases'],
  summary: 'Get managed database instance details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateManagedDatabaseRoute = appRoute({
  method: 'patch',
  path: '/managed/{id}',
  tags: ['Databases'],
  summary: 'Update managed database configuration',
  description:
    "Changes resources, version, publication and engine settings. `version` moves to a newer catalog version of the same engine: PostgreSQL within its major version (another major is a backup restored into a new database, 409 `POSTGRES_MAJOR_CHANGE`), Valkey and ClickHouse to the next catalog version (409 `MANAGED_DATABASE_VERSION_STEP`); the node recreates the container on the new image with the data kept (409 `MANAGED_DATABASE_DAEMON_UPDATE_REQUIRED` on an older node daemon). `imageUpdate: true` moves a PostgreSQL database from the official image of its version to Opfield's image of the same version, which adds the extensions (data kept, one restart; 409 `MANAGED_DATABASE_IMAGE_CURRENT` when it already runs it or none is published yet). A database on several servers (availability on) takes the settings at once with status `updating` and changes its members one at a time: copies first, each until it is an eligible copy again, then a planned switchover to a changed copy when the primary must restart, then the old primary; `availability.operation` shows the rolling update, and the status goes back to `ready` (a stop part-way leaves `lastError`). TLS cannot be turned on or off there (409 `AVAILABILITY_TLS_CHANGE`); an older member daemon answers 409 `AVAILABILITY_NODE_NOT_CAPABLE`. A database in an app environment isolated by the kill switch is refused (409 `APP_ISOLATED`).",
  request: { params: IdParamSchema, ...jsonBody(UpdateManagedDatabaseSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

const MANAGED_EXTENSION_CHANGE_NOTES =
  'Only the curated extensions the list returns can change (400 `EXTENSION_NOT_ALLOWED`). DDL runs as the control superuser in the application database, on the primary when the database runs on several servers (copies follow). An extension that needs a preload library restarts the database (a rolling update copies-first on several servers); one that comes as a download is installed into the database volume on every server first (409 `EXTENSION_NEEDS_STORAGE` when the volume lacks room). The answer is the extension list; `pending` is set while a restart or a download runs, and the SQL step follows on its own. Refusals: 409 `EXTENSION_NEEDS_IMAGE_UPDATE` (update with `imageUpdate: true` first), `EXTENSION_NOT_AVAILABLE` (not in this version), `MANAGED_DATABASE_DAEMON_UPDATE_REQUIRED` (a node daemon predates extensions), `MANAGED_DATABASE_EXTENSION_CHANGE_PENDING` (another change runs).';

export const listManagedDatabaseExtensionsRoute = appRoute({
  method: 'get',
  path: '/managed/{id}/extensions',
  tags: ['Databases'],
  summary: 'List the extensions of a managed PostgreSQL database',
  description:
    'The curated extensions Opfield offers, with their state on the database: `status` enabled, update_available, available, needs_bundle (a download of `bundleSizeBytes` into the database volume), needs_image_update (the database runs the official image: update with `imageUpdate: true`) or unavailable (not in this version); `availableVersion`, `installedVersion`, `category`, `description`, `preloadLibraries` and whether enabling or disabling restarts the database (`restartToEnable`, `restartToDisable`). Also `imageUpdateAvailable`, the volume space, the change in progress (`pending`) and the last failed one (`lastError`). `daemonUpdateRequired` true means the node daemon predates extensions (no status is reported). Needs databases:view.',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const enableManagedDatabaseExtensionRoute = appRoute({
  method: 'post',
  path: '/managed/{id}/extensions/{name}',
  tags: ['Databases'],
  summary: 'Enable an extension of a managed PostgreSQL database',
  description: `CREATE EXTENSION ... CASCADE, after the preload library or the download it needs, and grants the application role use of its objects. Enabling an enabled extension changes nothing. ${MANAGED_EXTENSION_CHANGE_NOTES} Needs databases:edit.`,
  request: { params: PostgresExtensionParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const disableManagedDatabaseExtensionRoute = appRoute({
  method: 'delete',
  path: '/managed/{id}/extensions/{name}',
  tags: ['Databases'],
  summary: 'Disable an extension of a managed PostgreSQL database',
  description: `DROP EXTENSION without CASCADE: refused while database objects depend on it (409 \`EXTENSION_HAS_DEPENDENTS\` with the dependent objects). A preload library or a download no other enabled extension needs is removed afterwards (a restart for a library). ${MANAGED_EXTENSION_CHANGE_NOTES} Needs databases:edit.`,
  request: { params: PostgresExtensionParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateManagedDatabaseExtensionRoute = appRoute({
  method: 'post',
  path: '/managed/{id}/extensions/{name}/update',
  tags: ['Databases'],
  summary: 'Update an extension of a managed PostgreSQL database',
  description: `ALTER EXTENSION ... UPDATE to the version the database image ships (\`availableVersion\`); at that version already, nothing changes. ${MANAGED_EXTENSION_CHANGE_NOTES} Needs databases:edit.`,
  request: { params: PostgresExtensionParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteManagedDatabaseRoute = appRoute({
  method: 'delete',
  path: '/managed/{id}',
  tags: ['Databases'],
  summary: 'Delete a managed database instance',
  description:
    'A database in an app environment isolated by the kill switch is refused until the kill switch is turned off (409 `APP_ISOLATED`). A database of a shut-down app can be deleted; Start then skips it. A database on several servers (availability on) answers at once with `deleting: true`: availability is turned off first (every other member and its data go, the primary is back on one server), then the database is deleted; links and running backups are refused first as for one server.',
  request: { params: IdParamSchema },
  responses: okJson(z.object({ success: z.boolean() })),
});

export const retryManagedDatabaseProvisioningRoute = appRoute({
  method: 'post',
  path: '/managed/{id}/retry-provisioning',
  tags: ['Databases'],
  summary: 'Retry failed managed database provisioning',
  description:
    'Provisions a managed database in `error` again on its node and answers 200 with the database once the node answered (`ready`, or `error` with the new lastError): the database already exists, so nothing is created (201 is for create). What the node kept of it (storage image, container) is taken over with its data. 409 MANAGED_DATABASE_NOT_RETRYABLE when the database did not fail or its node still holds it (change its settings, restart or delete it instead), 409 MANAGED_DATABASE_NODE_STATE_UNKNOWN when the node daemon cannot tell what it kept (update the node first), 409 NODE_OFFLINE when the node is offline.',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const restartManagedDatabaseRoute = appRoute({
  method: 'post',
  path: '/managed/{id}/restart',
  tags: ['Databases'],
  summary: 'Restart a managed database container',
  description:
    'On several servers (availability on) a rolling restart: copies first, each until it is an eligible copy again, then a planned switchover, then the old primary (in place, briefly unavailable, only when no copy can take over). Answers at once with status `updating`.',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const moveManagedDatabaseToValkeyRoute = appRoute({
  method: 'post',
  path: '/managed/{id}/move-to-valkey',
  tags: ['Databases'],
  summary: 'Move a key-value store that runs Redis to Valkey',
  description:
    'Copies every key of a running key-value store that still runs Redis into Valkey on the same node and switches the store to it. Writes pause while the keys are copied; reads keep working. The Redis data stays on the node until the key counts match, and the store goes back to Redis if anything fails. A store holding keys that cannot be copied (Bloom or cuckoo filters, time series, vector sets, search indexes) is refused before anything changes, with the store left as it was. A store with pending entries in stream consumer groups is refused unless the body has `acceptPendingStreamLoss: true`: the groups are moved, their pending entries are not. A store in an app environment that is isolated by the kill switch is refused (409 `APP_ISOLATED`); a store paused by an app shutdown is not running, so start the app first. Check the store first with GET on the same path.',
  request: { params: IdParamSchema, ...optionalJsonBody(MoveManagedDatabaseToValkeySchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const moveManagedDatabaseToValkeyPreflightRoute = appRoute({
  method: 'get',
  path: '/managed/{id}/move-to-valkey',
  tags: ['Databases'],
  summary: 'Check a key-value store before moving it to Valkey',
  description:
    'Reads the running store and answers what a move to Valkey would copy and what would stop it: `keys`, `usedMemoryBytes`, `pendingStreamEntries` (entries of stream consumer groups a move drops; the move then needs `acceptPendingStreamLoss: true`), `blockers` (data Valkey cannot take over; the move is refused while there are any), `estimatedPauseSeconds` (the expected time writes are unavailable), `fromVersion` and `toVersion`. Needs databases:edit.',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const pauseManagedDatabaseRoute = appRoute({
  method: 'post',
  path: '/managed/{id}/pause',
  tags: ['Databases'],
  summary: 'Pause a managed database container',
  description:
    'On several servers (availability on) the copies stop first, then the primary, which keeps its role (nothing fails over); the database reads `paused` at once.',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const unpauseManagedDatabaseRoute = appRoute({
  method: 'post',
  path: '/managed/{id}/unpause',
  tags: ['Databases'],
  summary: 'Unpause a managed database container',
  description:
    'On several servers (availability on) the primary starts first, then the copies; status `updating` until every member runs, then `ready`.',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const revealManagedDatabaseCredentialsRoute = appRoute({
  method: 'get',
  path: '/managed/{id}/reveal-credentials',
  tags: ['Databases'],
  summary: 'Reveal managed database direct-access credentials',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const rotateManagedDatabaseDirectCredentialsRoute = appRoute({
  method: 'post',
  path: '/managed/{id}/rotate-direct-credentials',
  tags: ['Databases'],
  summary: 'Rotate managed database direct-access credentials',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const rotateManagedDatabaseCertificateRoute = appRoute({
  method: 'post',
  path: '/managed/{id}/rotate-certificate',
  tags: ['Databases'],
  summary: 'Rotate a managed database direct-TLS certificate',
  description:
    'Issues a new certificate from the Database CA and has the running engine reload it in place (PostgreSQL, key-value stores and ClickHouse keep serving). A restart is used only with allowRestart or when the node daemon cannot reload certificates yet. Opfield also renews these certificates automatically before they expire.',
  request: { params: IdParamSchema, ...optionalJsonBody(RenewManagedCertificateSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const getManagedDatabaseCertificateRoute = appRoute({
  method: 'get',
  path: '/managed/{id}/certificate',
  tags: ['Databases'],
  summary: 'Get the TLS certificate of a managed database and its automatic renewal status',
  description:
    'Shows expiry, the renewal state and the last renewal error. Opfield renews the certificate while the database runs (two thirds into its lifetime or 30 days before expiry) without a restart.',
  request: { params: IdParamSchema },
  responses: okJson(dataResponseSchema(ManagedCertificateStatusSchema)),
});

export const listManagedDatabaseBindingsRoute = appRoute({
  method: 'get',
  path: '/managed/{id}/bindings',
  tags: ['Databases'],
  summary: 'List managed database bindings',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createManagedDatabaseBindingRoute = appRoute({
  method: 'post',
  path: '/managed/{id}/bindings',
  tags: ['Databases'],
  summary: 'Create a managed database binding',
  description:
    "The link is saved into the workload whatever it is doing and the call does not wait for the workload to become healthy; observedState is target_applied until the workload runs it, then active. A Git-source container whose first build has not created it yet is linked by its name, authorized on its reserved identity, and its first build starts it with the link. A Compose service may be linked before the project's first revision or while a build rollout or another operation holds the project, by a service name the next revision defines; the link fails with the reason when that revision lacks the service.",
  request: { params: IdParamSchema, ...jsonBody(CreateManagedDatabaseBindingSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const deleteManagedDatabaseBindingRoute = appRoute({
  method: 'delete',
  path: '/managed/{id}/bindings/{bindingId}',
  tags: ['Databases'],
  summary: 'Delete a managed database binding',
  description:
    'Removes the binding, its connector and the variables it gave the workload. Refused while the database or the workload sits in an app environment isolated by the kill switch (409 `APP_ISOLATED`): the kill switch holds the binding and restores it. A shut-down app holds nothing.',
  request: {
    params: IdParamSchema.extend({ bindingId: z.string().uuid() }),
    ...jsonBody(DeleteManagedDatabaseBindingSchema),
  },
  responses: okJson(z.object({ success: z.boolean() })),
});

export const getManagedDatabaseBindingRuntimeRoute = appRoute({
  method: 'get',
  path: '/managed/{id}/bindings/{bindingId}/runtime',
  tags: ['Databases'],
  summary: 'Get managed database binding runtime',
  description:
    "The link's Relay counters and its connections as the node running the workload reports them: activeStreams are the link's open connections (as many as the database accepts), openedTotal and the byte counters what it carried through that node, throttledTotal counts the connections refused at that limit by the node or a relay. connections is null while that node's daemon does not report links. The Relay counters sum every relay that holds the link's routes; relayCountersComplete is false when one did not answer, and those counters are then partial. Needs databases:view and view access to the linked workload.",
  request: { params: IdParamSchema.extend({ bindingId: z.string().uuid() }) },
  responses: okJson(UnknownDataResponseSchema),
});

export const revealManagedDatabaseBindingCredentialsRoute = appRoute({
  method: 'get',
  path: '/managed/{id}/bindings/{bindingId}/reveal-credentials',
  tags: ['Databases'],
  summary: 'Reveal managed database binding credentials',
  request: { params: IdParamSchema.extend({ bindingId: z.string().uuid() }) },
  responses: okJson(UnknownDataResponseSchema),
});

export const listDatabaseFoldersRoute = appRoute({
  method: 'get',
  path: '/folders',
  tags: ['Databases'],
  summary: 'List database folders',
  responses: okJson(UnknownDataResponseSchema),
});

export const createDatabaseFolderRoute = appRoute({
  method: 'post',
  path: '/folders',
  tags: ['Databases'],
  summary: 'Create a database folder',
  request: jsonBody(CreateResourceFolderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const reorderDatabaseFoldersRoute = appRoute({
  method: 'put',
  path: '/folders/reorder',
  tags: ['Databases'],
  summary: 'Reorder database folders',
  request: jsonBody(ReorderResourceFoldersSchema),
  responses: okJson(z.object({ success: z.boolean() })),
});

export const moveDatabasesToFolderRoute = appRoute({
  method: 'post',
  path: '/folders/move-databases',
  tags: ['Databases'],
  summary: 'Move database connections to a folder',
  request: jsonBody(MoveResourcesToFolderSchema),
  responses: okJson(z.object({ success: z.boolean() })),
});

export const reorderDatabasesRoute = appRoute({
  method: 'put',
  path: '/folders/reorder-databases',
  tags: ['Databases'],
  summary: 'Reorder database connections within a folder',
  request: jsonBody(ReorderResourcesSchema),
  responses: okJson(z.object({ success: z.boolean() })),
});

export const updateDatabaseFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}',
  tags: ['Databases'],
  summary: 'Rename a database folder',
  request: { params: IdParamSchema, ...jsonBody(UpdateResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const moveDatabaseFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}/move',
  tags: ['Databases'],
  summary: 'Move a database folder',
  request: { params: IdParamSchema, ...jsonBody(MoveResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteDatabaseFolderRoute = appRoute({
  method: 'delete',
  path: '/folders/{id}',
  tags: ['Databases'],
  summary: 'Delete a database folder',
  request: { params: IdParamSchema },
  responses: okJson(z.object({ success: z.boolean() })),
});

export const createDatabaseConnectionRoute = appRoute({
  method: 'post',
  path: '/',
  tags: ['Databases'],
  summary: 'Create a database connection',
  request: jsonBody(CreateDatabaseConnectionSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const getDatabaseConnectionRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Databases'],
  summary: 'Get database connection details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getDatabaseConnectionBySlugRoute = appRoute({
  method: 'get',
  path: '/by-slug/{slug}',
  tags: ['Databases'],
  summary: 'Resolve database connection by slug',
  request: { params: pathParamSchema('slug') },
  responses: okJson(UnknownDataResponseSchema),
});

export const getDatabaseHealthHistoryRoute = appRoute({
  method: 'get',
  path: '/{id}/health-history',
  tags: ['Databases'],
  summary: 'Get database connection health history',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateDatabaseConnectionRoute = appRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Databases'],
  summary: 'Update a database connection',
  request: { params: IdParamSchema, ...jsonBody(UpdateDatabaseConnectionSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteDatabaseConnectionRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Databases'],
  summary: 'Delete a database connection',
  request: { params: IdParamSchema },
  responses: okJson(z.object({ success: z.boolean() })),
});

export const testDatabaseConnectionRoute = appRoute({
  method: 'post',
  path: '/{id}/test',
  tags: ['Databases'],
  summary: 'Test a saved database connection',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const revealDatabaseCredentialsRoute = appRoute({
  method: 'get',
  path: '/{id}/reveal-credentials',
  tags: ['Databases'],
  summary: 'Reveal stored database credentials',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const databaseMonitoringStreamRoute = appRoute({
  method: 'get',
  path: '/{id}/monitoring/stream',
  tags: ['Databases'],
  summary: 'Stream database monitoring snapshots',
  request: { params: IdParamSchema },
  responses: { 200: { description: 'Server-sent events stream' } },
});

export const listSqlNamespacesRoute = appRoute({
  method: 'get',
  path: '/{id}/sql/namespaces',
  tags: ['Databases'],
  summary: 'List SQL database namespaces',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listSqlObjectsRoute = appRoute({
  method: 'get',
  path: '/{id}/sql/objects',
  tags: ['Databases'],
  summary: 'List SQL tables and views',
  request: { params: IdParamSchema, query: z.object({ namespace: z.string().min(1) }) },
  responses: okJson(UnknownDataResponseSchema),
});

export const sqlTableMetadataRoute = appRoute({
  method: 'get',
  path: '/{id}/sql/table-metadata',
  tags: ['Databases'],
  summary: 'Get SQL table metadata',
  request: { params: IdParamSchema, query: SqlTableQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const browseSqlRowsRoute = appRoute({
  method: 'get',
  path: '/{id}/sql/rows',
  tags: ['Databases'],
  summary: 'Browse SQL table rows',
  request: { params: IdParamSchema, query: BrowseSqlRowsQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const insertSqlRowRoute = appRoute({
  method: 'post',
  path: '/{id}/sql/rows',
  tags: ['Databases'],
  summary: 'Insert a SQL table row',
  request: { params: IdParamSchema, ...jsonBody(InsertSqlRowSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const updateSqlRowRoute = appRoute({
  method: 'patch',
  path: '/{id}/sql/rows',
  tags: ['Databases'],
  summary: 'Update one uniquely identified SQL table row',
  request: { params: IdParamSchema, ...jsonBody(UpdateSqlRowSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteSqlRowRoute = appRoute({
  method: 'delete',
  path: '/{id}/sql/rows',
  tags: ['Databases'],
  summary: 'Delete one uniquely identified SQL table row',
  request: { params: IdParamSchema, ...jsonBody(DeleteSqlRowSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const executeSqlRoute = appRoute({
  method: 'post',
  path: '/{id}/sql/query',
  tags: ['Databases'],
  summary: 'Execute a provider-specific SQL statement',
  request: { params: IdParamSchema, ...jsonBody(ExecuteSqlSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const listPostgresSchemasRoute = appRoute({
  method: 'get',
  path: '/{id}/postgres/schemas',
  tags: ['Databases'],
  summary: 'List PostgreSQL schemas',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listManagedPostgresExtensionsRoute = appRoute({
  method: 'get',
  path: '/{id}/postgres/extensions',
  tags: ['Databases'],
  summary: 'List extensions built into a managed PostgreSQL image',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const enableManagedPostgresExtensionRoute = appRoute({
  method: 'post',
  path: '/{id}/postgres/extensions/{name}',
  tags: ['Databases'],
  summary: 'Enable a built-in managed PostgreSQL extension',
  request: { params: PostgresExtensionParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const disableManagedPostgresExtensionRoute = appRoute({
  method: 'delete',
  path: '/{id}/postgres/extensions/{name}',
  tags: ['Databases'],
  summary: 'Disable a managed PostgreSQL extension',
  request: { params: PostgresExtensionParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listPostgresTablesRoute = appRoute({
  method: 'get',
  path: '/{id}/postgres/tables',
  tags: ['Databases'],
  summary: 'List PostgreSQL tables',
  request: { params: IdParamSchema, query: z.object({ schema: z.string().min(1) }) },
  responses: okJson(UnknownDataResponseSchema),
});

export const postgresTableMetadataRoute = appRoute({
  method: 'get',
  path: '/{id}/postgres/table-metadata',
  tags: ['Databases'],
  summary: 'Get PostgreSQL table metadata',
  request: { params: IdParamSchema, query: PostgresTableQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const browsePostgresRowsRoute = appRoute({
  method: 'get',
  path: '/{id}/postgres/rows',
  tags: ['Databases'],
  summary: 'Browse PostgreSQL table rows',
  request: { params: IdParamSchema, query: BrowsePostgresRowsQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const insertPostgresRowRoute = appRoute({
  method: 'post',
  path: '/{id}/postgres/rows',
  tags: ['Databases'],
  summary: 'Insert a PostgreSQL row',
  request: { params: IdParamSchema, ...jsonBody(PostgresInsertRowSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const updatePostgresRowRoute = appRoute({
  method: 'patch',
  path: '/{id}/postgres/rows',
  tags: ['Databases'],
  summary: 'Update a PostgreSQL row',
  request: { params: IdParamSchema, ...jsonBody(PostgresUpdateRowSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deletePostgresRowRoute = appRoute({
  method: 'delete',
  path: '/{id}/postgres/rows',
  tags: ['Databases'],
  summary: 'Delete a PostgreSQL row',
  request: { params: IdParamSchema, ...jsonBody(PostgresDeleteRowSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const addPostgresColumnRoute = appRoute({
  method: 'post',
  path: '/{id}/postgres/columns',
  tags: ['Databases'],
  summary: 'Add a PostgreSQL column',
  request: { params: IdParamSchema, ...jsonBody(AddPostgresColumnSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const deletePostgresColumnRoute = appRoute({
  method: 'delete',
  path: '/{id}/postgres/columns',
  tags: ['Databases'],
  summary: 'Delete a PostgreSQL column',
  request: { params: IdParamSchema, ...jsonBody(DeletePostgresColumnSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const updatePostgresColumnTypeRoute = appRoute({
  method: 'patch',
  path: '/{id}/postgres/columns/type',
  tags: ['Databases'],
  summary: 'Update a PostgreSQL column data type',
  request: { params: IdParamSchema, ...jsonBody(UpdatePostgresColumnTypeSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const executePostgresQueryRoute = appRoute({
  method: 'post',
  path: '/{id}/postgres/query',
  tags: ['Databases'],
  summary: 'Execute a PostgreSQL SQL statement',
  request: { params: IdParamSchema, ...jsonBody(ExecutePostgresSqlSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const scanRedisKeysRoute = appRoute({
  method: 'get',
  path: '/{id}/redis/keys',
  tags: ['Databases'],
  summary: 'Scan keys of a key-value store',
  request: { params: IdParamSchema, query: RedisScanKeysQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getRedisKeyRoute = appRoute({
  method: 'get',
  path: '/{id}/redis/key',
  tags: ['Databases'],
  summary: 'Get a key of a key-value store',
  request: { params: IdParamSchema, query: RedisGetKeyQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const setRedisKeyRoute = appRoute({
  method: 'put',
  path: '/{id}/redis/key',
  tags: ['Databases'],
  summary: 'Set a key of a key-value store',
  request: { params: IdParamSchema, ...jsonBody(RedisSetKeySchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteRedisKeyRoute = appRoute({
  method: 'delete',
  path: '/{id}/redis/key',
  tags: ['Databases'],
  summary: 'Delete a key of a key-value store',
  request: { params: IdParamSchema, ...jsonBody(RedisGetKeyQuerySchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const expireRedisKeyRoute = appRoute({
  method: 'post',
  path: '/{id}/redis/key/expire',
  tags: ['Databases'],
  summary: 'Set the expiration of a key of a key-value store',
  request: { params: IdParamSchema, ...jsonBody(RedisExpireKeySchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const executeRedisCommandRoute = appRoute({
  method: 'post',
  path: '/{id}/redis/command',
  tags: ['Databases'],
  summary: 'Execute a Redis command on a key-value store',
  request: { params: IdParamSchema, ...jsonBody(ExecuteRedisCommandSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

/** Database availability (one database on several servers), served by the commercial edition. */
export const databaseAvailabilityRoutes = availabilityRouteDocs({
  base: '/managed/{id}',
  createPreflightPath: '/managed/availability/preflight',
  createPreflightSchema: ManagedDatabaseAvailabilityCreatePreflightSchema,
  tag: 'Databases',
  noun: 'database',
  viewScope: 'databases:view',
  editScope: 'databases:edit',
  createScope: 'databases:create',
});
