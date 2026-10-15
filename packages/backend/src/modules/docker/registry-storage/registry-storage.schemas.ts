import { z } from 'zod';

/** No quote, line break or NUL: the values go into the installation's .env. */
const ENV_SAFE = /^[^'\r\n\0]*$/;
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export const RegistryStorageInputSchema = z.discriminatedUnion('backend', [
  z.object({ backend: z.literal('filesystem') }).strict(),
  z
    .object({
      backend: z.literal('s3'),
      /** An object storage connection whose endpoint, region, path style and keys the registry uses. */
      connectionId: z.string().uuid().optional(),
      endpoint: z
        .string()
        .trim()
        .max(500)
        .refine((value) => {
          if (!value) return true;
          try {
            const url = new URL(value);
            return (
              (url.protocol === 'https:' || url.protocol === 'http:') &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash &&
              ENV_SAFE.test(value)
            );
          } catch {
            return false;
          }
        }, 'Use an http(s) URL without credentials or query, for example https://s3.example.com')
        .optional(),
      region: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Use letters, digits, - or _')
        .optional(),
      bucket: z.string().trim().regex(BUCKET_NAME, 'Use a valid S3 bucket name').optional(),
      rootDirectory: z
        .string()
        .trim()
        .max(200)
        .regex(/^[A-Za-z0-9._/-]*$/, 'Use letters, digits, ., _, - and /')
        .optional(),
      forcePathStyle: z.boolean().optional(),
      accessKeyId: z.string().trim().min(1).max(256).regex(/^\S+$/).regex(ENV_SAFE).optional(),
      /** Omitted: the key the registry uses now is kept (same access key only). */
      secretAccessKey: z.string().min(1).max(512).regex(ENV_SAFE, 'Must not contain quotes or line breaks').optional(),
    })
    .strict(),
]);

export type RegistryStorageInput = z.infer<typeof RegistryStorageInputSchema>;

/**
 * PUT /registries/internal/settings. External access is optional so a request may change only the storage;
 * clients that send only the external access fields keep working as before.
 */
export const DockerInternalRegistryUpdateSchema = z
  .object({
    externalAccessEnabled: z.boolean().optional(),
    externalHostname: z.string().trim().min(1).max(253).optional(),
    externalNginxNodeId: z.string().uuid().optional(),
    externalCertificateId: z.string().uuid().optional(),
    storage: RegistryStorageInputSchema.optional(),
  })
  .refine((value) => value.externalAccessEnabled !== undefined || value.storage !== undefined, {
    message: 'Send externalAccessEnabled, storage or both',
  });

export type DockerInternalRegistryUpdateInput = z.infer<typeof DockerInternalRegistryUpdateSchema>;
