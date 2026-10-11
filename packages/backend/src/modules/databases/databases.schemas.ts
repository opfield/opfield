import { z } from 'zod';

const nameSchema = z.string().trim().min(1).max(255);
const optionalTextSchema = z.string().trim().max(10_000).optional().nullable();
const tagsSchema = z.array(z.string().trim().min(1).max(64)).max(32).optional();
const interactiveQueryBudgetSecondsSchema = z.number().int().min(30).max(600);

const DATABASE_TLS_CA_CERTIFICATE_MAX_LENGTH = 65_536;

// Server certificate verification applies whenever the connection uses TLS.
// New connections verify by default; `tlsVerifyCertificate: false` is the
// explicit, insecure opt-out.
const tlsVerificationFields = {
  tlsVerifyCertificate: z
    .boolean()
    .optional()
    .describe(
      'Verify the server TLS certificate chain and hostname. Defaults to true for new connections; false disables verification (insecure).'
    ),
  tlsCaCertificate: z
    .string()
    .trim()
    .max(DATABASE_TLS_CA_CERTIFICATE_MAX_LENGTH)
    .nullable()
    .optional()
    .describe(
      'PEM CA certificate bundle trusted instead of the public CA bundle, for servers issued by a private CA. Empty or null clears it.'
    ),
};

const postgresConnectionFields = z.object({
  connectionString: z.string().trim().min(1).max(4096).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().trim().min(1).max(255).optional(),
  username: z.string().trim().min(1).max(255).optional(),
  password: z.string().max(4096).optional(),
  sslEnabled: z.boolean().optional(),
  ...tlsVerificationFields,
});

const redisConnectionFields = z.object({
  connectionString: z.string().trim().min(1).max(4096).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).max(255).optional(),
  password: z.string().max(4096).optional(),
  db: z.number().int().min(0).max(15).optional(),
  tlsEnabled: z.boolean().optional(),
  ...tlsVerificationFields,
});

const clickHouseConnectionFields = z.object({
  connectionString: z.string().trim().min(1).max(4096).optional(),
  url: z.string().trim().min(1).max(4096).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().trim().min(1).max(255).optional(),
  username: z.string().trim().min(1).max(255).optional(),
  password: z.string().max(4096).optional(),
  tlsEnabled: z.boolean().optional(),
  ...tlsVerificationFields,
});

export const DatabaseListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().optional(),
  type: z.enum(['postgres', 'redis', 'clickhouse']).optional(),
  healthStatus: z.enum(['online', 'offline', 'degraded', 'unknown']).optional(),
});

const managedDatabaseTypeSchema = z.enum(['postgres', 'redis', 'clickhouse']);
const managedDatabaseNameSchema = z.string().trim().min(1).max(255);
const managedDatabaseVersionSchema = z.string().trim().min(1).max(128);
const minimumClickHouseMemoryMb = 512;

export const ManagedRedisConfigSchema = z.object({
  maxmemoryPercent: z.number().int().min(10).max(95),
  maxmemoryPolicy: z.enum([
    'noeviction',
    'allkeys-lru',
    'allkeys-lfu',
    'allkeys-random',
    'volatile-lru',
    'volatile-lfu',
    'volatile-random',
    'volatile-ttl',
  ]),
  appendOnly: z.boolean(),
  appendFsync: z.enum(['always', 'everysec', 'no']),
  rdbSnapshotsEnabled: z.boolean(),
  rdbSaveSeconds: z.number().int().min(1).max(31_536_000),
  rdbSaveChanges: z.number().int().min(1).max(1_000_000_000),
  autoAofRewritePercentage: z.number().int().min(0).max(10_000),
  autoAofRewriteMinSizeMb: z.number().int().min(1).max(1_048_576),
  maxclients: z.number().int().min(1).max(1_000_000),
  timeoutSeconds: z.number().int().min(0).max(31_536_000),
  tcpKeepaliveSeconds: z.number().int().min(0).max(31_536_000),
  slowlogThresholdMicroseconds: z.number().int().min(-1).max(2_147_483_647),
  slowlogMaxLen: z.number().int().min(0).max(1_000_000),
  activeDefrag: z.boolean(),
});

/** PostgreSQL server settings. Every connection is a server process; the default is the engine's 100. */
export const MANAGED_POSTGRES_MIN_CONNECTIONS = 20;
export const MANAGED_POSTGRES_MAX_CONNECTIONS = 10_000;
export const DEFAULT_MANAGED_POSTGRES_MAX_CONNECTIONS = 100;

export const ManagedPostgresConfigSchema = z.object({
  maxConnections: z.number().int().min(MANAGED_POSTGRES_MIN_CONNECTIONS).max(MANAGED_POSTGRES_MAX_CONNECTIONS),
});

export const ManagedDatabaseListQuerySchema = z.object({
  nodeId: z.string().uuid().optional(),
  type: managedDatabaseTypeSchema.optional(),
});

const STORAGE_SIZE_GB_RULE = 'Storage size is in GB from 0.1 to 16384 with at most one decimal place';

/**
 * Managed database disk size, the same at create and resize. The daemon allocates and grows the storage image to the
 * exact byte size (fallocate, then resize2fs to the device), so any 0.1 GB step works; Gateway rounds it to bytes once.
 */
const managedDatabaseStorageSizeGbSchema = z
  .number({ invalid_type_error: STORAGE_SIZE_GB_RULE })
  .finite(STORAGE_SIZE_GB_RULE)
  .min(0.1, STORAGE_SIZE_GB_RULE)
  .max(16_384, STORAGE_SIZE_GB_RULE)
  .refine((value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-9, { message: STORAGE_SIZE_GB_RULE });

export const CreateManagedDatabaseSchema = z
  .object({
    name: managedDatabaseNameSchema,
    folderId: z.string().uuid().nullable().optional(),
    type: managedDatabaseTypeSchema,
    version: managedDatabaseVersionSchema,
    nodeId: z.string().uuid(),
    storageSizeGb: managedDatabaseStorageSizeGbSchema,
    cpuCores: z.number().min(0.1).max(128),
    memoryMb: z.number().int().min(128).max(1_048_576),
    swapMb: z.number().int().min(0).max(1_048_576).default(0),
    tags: tagsSchema,
    publishTcp: z.boolean().default(false),
    publishNativeTcp: z.boolean().optional(),
    publishedPort: z.number().int().min(1).max(65535).optional(),
    publishedNativePort: z.number().int().min(1).max(65535).optional(),
    tlsEnabled: z.boolean().default(true),
    // The database daemon accepts only plain SQL identifiers; reject others
    // here instead of failing the deployment after the record exists.
    databaseName: z
      .string()
      .trim()
      .regex(
        /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/,
        'Use letters, digits and underscores, starting with a letter or underscore'
      )
      .optional(),
    ownerUsername: z.string().trim().min(1).max(63).optional(),
    clickhouseConfigXml: z.string().trim().min(1).max(32_768).optional(),
    redisConfig: ManagedRedisConfigSchema.optional(),
    postgresConfig: ManagedPostgresConfigSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.type === 'clickhouse' && value.memoryMb < minimumClickHouseMemoryMb) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['memoryMb'],
        message: `ClickHouse requires at least ${minimumClickHouseMemoryMb} MB of memory`,
      });
    }
    if (value.publishedPort !== undefined && !value.publishTcp) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publishedPort'],
        message: 'publishedPort requires publishTcp',
      });
    }
    if (value.publishNativeTcp === true && (!value.publishTcp || value.type !== 'clickhouse')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publishNativeTcp'],
        message: 'publishNativeTcp requires published ClickHouse TCP',
      });
    }
    if (
      value.publishedNativePort !== undefined &&
      (!value.publishTcp || value.type !== 'clickhouse' || value.publishNativeTcp === false)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publishedNativePort'],
        message: 'publishedNativePort requires published ClickHouse TCP',
      });
    }
    if (value.clickhouseConfigXml !== undefined && value.type !== 'clickhouse') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clickhouseConfigXml'],
        message: 'clickhouseConfigXml is only supported for ClickHouse',
      });
    }
    if (value.redisConfig !== undefined && value.type !== 'redis') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['redisConfig'],
        message: 'redisConfig is only supported for key-value stores',
      });
    }
    if (value.postgresConfig !== undefined && value.type !== 'postgres') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['postgresConfig'],
        message: 'postgresConfig is only supported for PostgreSQL',
      });
    }
    if (value.type === 'redis' && value.ownerUsername !== undefined && value.ownerUsername !== 'default') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerUsername'],
        message: 'A key-value store uses the built-in default owner username',
      });
    }
  });

export const UpdateManagedDatabaseSchema = z
  .object({
    name: managedDatabaseNameSchema.optional(),
    tags: tagsSchema,
    storageSizeGb: managedDatabaseStorageSizeGbSchema.optional(),
    cpuCores: z.number().min(0.1).max(128).optional(),
    memoryMb: z.number().int().min(128).max(1_048_576).optional(),
    swapMb: z.number().int().min(0).max(1_048_576).optional(),
    publishTcp: z.boolean().optional(),
    publishNativeTcp: z.boolean().optional(),
    publishedPort: z.number().int().min(1).max(65535).nullable().optional(),
    publishedNativePort: z.number().int().min(1).max(65535).nullable().optional(),
    tlsEnabled: z.boolean().optional(),
    clickhouseConfigXml: z.string().trim().max(32_768).optional(),
    redisConfig: ManagedRedisConfigSchema.optional(),
    postgresConfig: ManagedPostgresConfigSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field must be provided' });

const bindingEnvironmentVariableSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Environment variable names must be valid identifiers');

const bindingEnvironmentSchema = z
  .object({
    connectionUri: bindingEnvironmentVariableSchema.optional(),
    host: bindingEnvironmentVariableSchema.optional(),
    port: bindingEnvironmentVariableSchema.optional(),
    database: bindingEnvironmentVariableSchema.optional(),
    username: bindingEnvironmentVariableSchema.optional(),
    password: bindingEnvironmentVariableSchema.optional(),
  })
  .describe(
    'The environment variable names the link injects into its workload, by value. At least one is required (400 MANAGED_DATABASE_BINDING_ENV_REQUIRED).'
  )
  .superRefine((value, context) => {
    const entries = Object.entries(value).filter(([, variable]) => variable !== undefined) as Array<[string, string]>;
    const seen = new Set<string>();
    for (const [field, variable] of entries) {
      if (seen.has(variable)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'Each binding field must use a distinct environment variable name',
        });
      }
      seen.add(variable);
    }
  });

export const CreateManagedDatabaseBindingSchema = z.object({
  targetNodeId: z.string().uuid(),
  targetType: z.enum(['container', 'deployment', 'compose_service']),
  targetResourceId: z.string().trim().min(1).max(255),
  environment: bindingEnvironmentSchema,
  /**
   * Container-only opt-in. The caller explicitly acknowledges that a managed
   * binding replaces existing ordinary env values and/or Docker secrets with
   * the same names.
   */
  replaceExistingEnvironment: z.boolean().optional(),
  /** Complete ordinary-container env draft to persist with this binding update. */
  targetEnvironment: z.record(z.string(), z.string()).optional(),
});

export const DeleteManagedDatabaseBindingSchema = z.object({
  /** Complete ordinary-container env draft to persist with the binding removal. */
  targetEnvironment: z.record(z.string(), z.string()).optional(),
});

export const CreateDatabaseConnectionSchema = z.discriminatedUnion('type', [
  z.object({
    name: nameSchema,
    folderId: z.string().uuid().nullable().optional(),
    description: optionalTextSchema,
    tags: tagsSchema,
    manualSizeLimitMb: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024)
      .optional()
      .nullable(),
    interactiveQueryBudgetSeconds: interactiveQueryBudgetSecondsSchema.optional(),
    type: z.literal('postgres'),
    config: postgresConnectionFields,
  }),
  z.object({
    name: nameSchema,
    folderId: z.string().uuid().nullable().optional(),
    description: optionalTextSchema,
    tags: tagsSchema,
    type: z.literal('redis'),
    config: redisConnectionFields,
  }),
  z.object({
    name: nameSchema,
    folderId: z.string().uuid().nullable().optional(),
    description: optionalTextSchema,
    tags: tagsSchema,
    type: z.literal('clickhouse'),
    interactiveQueryBudgetSeconds: interactiveQueryBudgetSecondsSchema.optional(),
    config: clickHouseConnectionFields,
  }),
]);

export const UpdateDatabaseConnectionSchema = z
  .object({
    name: nameSchema.optional(),
    description: optionalTextSchema,
    tags: tagsSchema,
    manualSizeLimitMb: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024)
      .optional()
      .nullable(),
    interactiveQueryBudgetSeconds: interactiveQueryBudgetSecondsSchema.optional(),
    config: z
      .object({
        connectionString: z.string().trim().min(1).max(4096).optional(),
        url: z.string().trim().min(1).max(4096).optional(),
        host: z.string().trim().min(1).max(255).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        database: z.string().trim().min(1).max(255).optional(),
        username: z.string().trim().min(1).max(255).optional(),
        password: z.string().max(4096).optional(),
        sslEnabled: z.boolean().optional(),
        db: z.number().int().min(0).max(15).optional(),
        tlsEnabled: z.boolean().optional(),
        ...tlsVerificationFields,
      })
      .optional(),
  })
  .refine(
    (data) =>
      !!data.name ||
      data.description !== undefined ||
      !!data.tags ||
      !!data.config ||
      data.interactiveQueryBudgetSeconds !== undefined,
    {
      message: 'At least one field must be provided',
    }
  );

export const BrowsePostgresRowsQuerySchema = z.object({
  schema: z.string().trim().min(1).max(255),
  table: z.string().trim().min(1).max(255),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  sortBy: z.string().trim().min(1).max(255).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  searchColumn: z.string().trim().min(1).max(255).optional(),
  searchOperation: z.enum(['like', 'equals', 'notEquals', 'greaterThan', 'lessThan']).optional(),
  searchValue: z.string().trim().max(1024).optional(),
});

export const PostgresObjectSchema = z.record(z.string(), z.any());

const PostgresColumnBaseSchema = BrowsePostgresRowsQuerySchema.pick({
  schema: true,
  table: true,
}).extend({
  column: z.string().trim().min(1).max(255),
});

export const AddPostgresColumnSchema = PostgresColumnBaseSchema.extend({
  dataType: z.string().trim().min(1).max(64),
});

export const UpdatePostgresColumnTypeSchema = PostgresColumnBaseSchema.extend({
  dataType: z.string().trim().min(1).max(64),
});

export const DeletePostgresColumnSchema = PostgresColumnBaseSchema;

export const ExecutePostgresSqlSchema = z.object({
  sql: z.string().trim().min(1).max(100_000),
  maxRows: z.number().int().min(1).max(2000).default(500),
});

export const SqlTableQuerySchema = z.object({
  namespace: z.string().trim().min(1).max(255),
  table: z.string().trim().min(1).max(255),
});

export const SqlObjectSchema = z
  .record(z.string(), z.any())
  .refine((value) => Object.keys(value).length > 0, 'At least one column value is required');

export const InsertSqlRowSchema = SqlTableQuerySchema.extend({
  values: SqlObjectSchema,
});

export const UpdateSqlRowSchema = InsertSqlRowSchema.extend({
  locator: SqlObjectSchema,
});

export const DeleteSqlRowSchema = SqlTableQuerySchema.extend({
  locator: SqlObjectSchema,
});

export const BrowseSqlRowsQuerySchema = SqlTableQuerySchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  sortBy: z.string().trim().min(1).max(255).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  searchColumn: z.string().trim().min(1).max(255).optional(),
  searchOperation: z.enum(['like', 'equals', 'notEquals', 'greaterThan', 'lessThan']).optional(),
  searchValue: z.string().trim().max(1024).optional(),
});

export const ExecuteSqlSchema = ExecutePostgresSqlSchema;

export const RedisScanKeysQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  search: z.string().trim().optional(),
  type: z.string().trim().optional(),
});

export const RedisGetKeyQuerySchema = z.object({
  key: z.string().min(1).max(4096),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  maxStringBytes: z.coerce
    .number()
    .int()
    .min(1)
    .max(1024 * 1024)
    .default(64 * 1024),
});

export const RedisSetKeySchema = z.object({
  key: z.string().min(1).max(4096),
  type: z.enum(['string', 'hash', 'list', 'set', 'zset']),
  ttlSeconds: z.number().int().min(-1).max(31_536_000).optional(),
  value: z.any(),
});

export const RedisExpireKeySchema = z.object({
  key: z.string().min(1).max(4096),
  ttlSeconds: z.number().int().min(-1).max(31_536_000),
});

export const ExecuteRedisCommandSchema = z.object({
  command: z.string().trim().min(1).max(10_000),
});

export type DatabaseListQuery = z.infer<typeof DatabaseListQuerySchema>;
export type CreateDatabaseConnectionInput = z.infer<typeof CreateDatabaseConnectionSchema>;
export type UpdateDatabaseConnectionInput = z.infer<typeof UpdateDatabaseConnectionSchema>;
export type ManagedDatabaseListQuery = z.infer<typeof ManagedDatabaseListQuerySchema>;
export type CreateManagedDatabaseInput = z.infer<typeof CreateManagedDatabaseSchema>;
export type UpdateManagedDatabaseInput = z.infer<typeof UpdateManagedDatabaseSchema>;
export type CreateManagedDatabaseBindingInput = z.infer<typeof CreateManagedDatabaseBindingSchema>;

/** POST /databases/managed/{id}/move-to-valkey. The body is optional. */
export const MoveManagedDatabaseToValkeySchema = z
  .object({
    /** Lets the move drop the pending entries of stream consumer groups (see the move check). */
    acceptPendingStreamLoss: z.boolean().optional(),
  })
  .strict();
export type MoveManagedDatabaseToValkeyInput = z.infer<typeof MoveManagedDatabaseToValkeySchema>;
