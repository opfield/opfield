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
  ManagedDatabaseListQuerySchema,
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
  responses: okJson(UnknownDataResponseSchema),
});

export const listManagedDatabasesRoute = appRoute({
  method: 'get',
  path: '/managed',
  tags: ['Databases'],
  summary: 'List managed database instances',
  request: { query: ManagedDatabaseListQuerySchema },
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
  request: { params: IdParamSchema, ...jsonBody(UpdateManagedDatabaseSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteManagedDatabaseRoute = appRoute({
  method: 'delete',
  path: '/managed/{id}',
  tags: ['Databases'],
  summary: 'Delete a managed database instance',
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
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const pauseManagedDatabaseRoute = appRoute({
  method: 'post',
  path: '/managed/{id}/pause',
  tags: ['Databases'],
  summary: 'Pause a managed database container',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const unpauseManagedDatabaseRoute = appRoute({
  method: 'post',
  path: '/managed/{id}/unpause',
  tags: ['Databases'],
  summary: 'Unpause a managed database container',
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
    'Issues a new certificate from the Database CA and has the running engine reload it in place (PostgreSQL, Redis and ClickHouse keep serving). A restart is used only with allowRestart or when the node daemon cannot reload certificates yet. Gateway also renews these certificates automatically before they expire.',
  request: { params: IdParamSchema, ...optionalJsonBody(RenewManagedCertificateSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const getManagedDatabaseCertificateRoute = appRoute({
  method: 'get',
  path: '/managed/{id}/certificate',
  tags: ['Databases'],
  summary: 'Get the TLS certificate of a managed database and its automatic renewal status',
  description:
    'Shows expiry, the renewal state and the last renewal error. Gateway renews the certificate while the database runs (two thirds into its lifetime or 30 days before expiry) without a restart.',
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
  summary: 'Scan Redis keys',
  request: { params: IdParamSchema, query: RedisScanKeysQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getRedisKeyRoute = appRoute({
  method: 'get',
  path: '/{id}/redis/key',
  tags: ['Databases'],
  summary: 'Get a Redis key',
  request: { params: IdParamSchema, query: RedisGetKeyQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const setRedisKeyRoute = appRoute({
  method: 'put',
  path: '/{id}/redis/key',
  tags: ['Databases'],
  summary: 'Set a Redis key',
  request: { params: IdParamSchema, ...jsonBody(RedisSetKeySchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteRedisKeyRoute = appRoute({
  method: 'delete',
  path: '/{id}/redis/key',
  tags: ['Databases'],
  summary: 'Delete a Redis key',
  request: { params: IdParamSchema, ...jsonBody(RedisGetKeyQuerySchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const expireRedisKeyRoute = appRoute({
  method: 'post',
  path: '/{id}/redis/key/expire',
  tags: ['Databases'],
  summary: 'Set Redis key expiration',
  request: { params: IdParamSchema, ...jsonBody(RedisExpireKeySchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const executeRedisCommandRoute = appRoute({
  method: 'post',
  path: '/{id}/redis/command',
  tags: ['Databases'],
  summary: 'Execute a Redis command',
  request: { params: IdParamSchema, ...jsonBody(ExecuteRedisCommandSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
