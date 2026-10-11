import { z } from 'zod';
import { appListQueryFields } from '@/modules/apps/app-list-query.js';

const nameSchema = z.string().trim().min(1).max(255);
const optionalTextSchema = z.string().trim().max(10_000).optional().nullable();
const tagsSchema = z.array(z.string().trim().min(1).max(64)).max(32).optional();

export const StorageProviderSchema = z.enum([
  'aws',
  'cloudflare_r2',
  'minio',
  'other',
  'ftp',
  'ftps',
  'sftp',
  'seaweedfs',
]);

/**
 * A base path is confined to plain, non-relative segments: `..` would let a
 * connection reach outside the subtree it was scoped to.
 */
const basePathSchema = z
  .string()
  .trim()
  .max(1024)
  .refine((value) => !value.split('/').some((segment) => segment === '..' || segment === '.'), {
    message: 'Base path must not contain relative segments',
  })
  .refine((value) => !value.includes('\0') && !value.includes('\\'), {
    message: 'Base path contains an illegal character',
  });

const connectionFields = z.object({
  // S3
  endpoint: z.string().trim().max(512).optional().nullable(),
  region: z.string().trim().min(1).max(128).optional(),
  accessKeyId: z.string().trim().min(1).max(255).optional(),
  secretAccessKey: z.string().max(4096).optional(),
  sessionToken: z.string().max(8192).optional().nullable(),
  defaultBucket: z.string().trim().max(255).optional().nullable(),
  forcePathStyle: z.boolean().optional(),
  // File protocols (ftp/ftps/sftp)
  hostKeyFingerprint: z
    .string()
    .regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/)
    .optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65_535).optional().nullable(),
  username: z.string().trim().max(255).optional(),
  password: z.string().max(4096).optional(),
  privateKey: z.string().max(32_768).optional(),
  passphrase: z.string().max(4096).optional(),
  caPem: z.string().max(32_768).optional().nullable(),
  basePath: basePathSchema.optional().nullable(),
  implicitTls: z.boolean().optional(),
});

/** Kept as the historical name for the S3-shaped subset of connection fields. */
const s3ConnectionFields = connectionFields;

export const ObjectStorageListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().optional(),
  provider: StorageProviderSchema.optional(),
  healthStatus: z.enum(['online', 'offline', 'degraded', 'unknown']).optional(),
  ...appListQueryFields,
});

const FILE_PROTOCOLS: ReadonlySet<string> = new Set(['ftp', 'ftps', 'sftp']);

export const CreateObjectStorageConnectionSchema = z
  .object({
    name: nameSchema,
    folderId: z.string().uuid().nullable().optional(),
    description: optionalTextSchema,
    tags: tagsSchema,
    provider: StorageProviderSchema,
    config: connectionFields,
  })
  .superRefine((data, ctx) => {
    const required = (field: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['config', field], message });

    if (FILE_PROTOCOLS.has(data.provider)) {
      if (!data.config.host) required('host', 'host is required');
      if (!data.config.username) required('username', 'username is required');
      if (data.provider === 'sftp' && !data.config.hostKeyFingerprint)
        required('hostKeyFingerprint', 'Verified SSH host key fingerprint is required');
      // SFTP accepts either auth method; FTP/FTPS only have passwords, and an
      // empty one is legitimate for anonymous servers.
      if (data.provider === 'sftp' && !data.config.password && !data.config.privateKey) {
        required('password', 'either password or privateKey is required for SFTP');
      }
      return;
    }

    if (!data.config.region) required('region', 'region is required');
    if (!data.config.accessKeyId) required('accessKeyId', 'accessKeyId is required');
    if (!data.config.secretAccessKey) required('secretAccessKey', 'secretAccessKey is required');
  });

export const UpdateObjectStorageConnectionSchema = z
  .object({
    name: nameSchema.optional(),
    description: optionalTextSchema,
    tags: tagsSchema,
    provider: StorageProviderSchema.optional(),
    config: s3ConnectionFields.optional(),
  })
  .refine((data) => !!data.name || data.description !== undefined || !!data.tags || !!data.provider || !!data.config, {
    message: 'At least one field must be provided',
  });

// ── Object browser ──────────────────────────────────────────────────

export const ListBucketsQuerySchema = z.object({});

// On file protocols a bucket is a directory name, so the S3 grammar would
// reject perfectly valid targets. What must hold for both families is that the
// name stays a single, non-relative path segment — anything else could escape
// the connection's base path.
export const CreateBucketSchema = z.object({
  bucket: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[^/\\\0]+$/, 'Bucket name must be a single path segment')
    .refine((value) => value !== '.' && value !== '..', 'Invalid bucket name'),
});

export const ListObjectsQuerySchema = z.object({
  bucket: z.string().trim().min(1).max(255),
  prefix: z.string().max(1024).optional(),
  delimiter: z.string().max(8).optional().default('/'),
  continuationToken: z.string().max(4096).optional(),
  maxKeys: z.coerce.number().int().min(1).max(1000).default(200),
});

export const ObjectMetadataQuerySchema = z.object({
  bucket: z.string().trim().min(1).max(255),
  key: z.string().min(1).max(1024),
});

export const PresignObjectSchema = z.object({
  bucket: z.string().trim().min(1).max(255),
  key: z.string().min(1).max(1024),
  operation: z.enum(['get', 'put']).default('get'),
  contentType: z.string().max(255).optional(),
  expiresIn: z.number().int().min(1).max(604_800).default(3600),
});

export const CreatePrefixSchema = z.object({
  bucket: z.string().trim().min(1).max(255),
  prefix: z.string().min(1).max(1024),
});

export const DeleteObjectsSchema = z.object({
  bucket: z.string().trim().min(1).max(255),
  keys: z.array(z.string().min(1).max(1024)).min(1).max(1000),
});

/** `backupHistory=forget` confirms removing the finished backup history that still references the storage. */
export const DeleteStorageQuerySchema = z.object({
  backupHistory: z.enum(['forget']).optional(),
});

export type StorageProvider = z.infer<typeof StorageProviderSchema>;
export type ObjectStorageListQuery = z.infer<typeof ObjectStorageListQuerySchema>;
export type CreateObjectStorageConnectionInput = z.infer<typeof CreateObjectStorageConnectionSchema>;
export type UpdateObjectStorageConnectionInput = z.infer<typeof UpdateObjectStorageConnectionSchema>;
export type ListObjectsQuery = z.infer<typeof ListObjectsQuerySchema>;
export type PresignObjectInput = z.infer<typeof PresignObjectSchema>;
