import { z } from 'zod';
import { appListQueryFields } from '@/modules/apps/app-list-query.js';
import {
  ManagedAvailabilityEnableSchema,
  ManagedAvailabilityPreflightSchema,
} from '@/modules/databases/databases.schemas.js';

const managedStorageNameSchema = z.string().trim().min(1).max(255);
// DTO validation is shared; the installed storage provider checks its private
// version catalog before creating any workload or database record.
const managedStorageVersionSchema = z.string().trim().min(1).max(128);
const tagsSchema = z.array(z.string().trim().min(1).max(64)).max(32).optional();

export const ManagedStorageListQuerySchema = z.object({
  nodeId: z.string().uuid().optional(),
  ...appListQueryFields,
});

/**
 * Create-time schema for a managed object storage cluster. New clusters run
 * SeaweedFS (the only creatable engine — the installed storage provider
 * resolves `version` against its catalog); legacy MinIO clusters stay
 * manageable but can no longer be created. Mirrors
 * `CreateManagedDatabaseSchema`'s shape (see `modules/databases/databases.schemas.ts`):
 * no `type` discriminant, a `publishedPort` for the optional public S3
 * listener (the cluster is private through the relay by default), and
 * optional root credentials that default to strong generated ones when
 * omitted.
 *
 * SeaweedFS clusters are single-node and speak S3 only: the distributed
 * (`memberNodeIds`) and multi-drive (`drivesPerNode`) fields are accepted
 * for one node and one drive and refused otherwise; FTP and SFTP are not
 * part of the schema.
 */
export const CreateManagedStorageSchema = z
  .object({
    name: managedStorageNameSchema,
    // Folder of the canonical storage connection the cluster registers. Folder-scoped
    // creators must name a folder they can create in (checked by the route).
    folderId: z.string().uuid().nullable().optional(),
    // Optional and redundant with `version` today (SeaweedFS is the only
    // creatable engine); anything else — `minio` included — is refused.
    engine: z
      .enum(['seaweedfs'], {
        errorMap: () => ({
          message: 'New managed storage runs SeaweedFS; MinIO is a legacy engine and cannot be created',
        }),
      })
      .optional(),
    version: managedStorageVersionSchema,
    nodeId: z.string().uuid(),
    storageSizeGb: z.number().finite().min(1).max(16_384),
    cpuCores: z.number().min(0.1).max(128),
    // SeaweedFS runs master, volume, filer and S3 in one container; below
    // 512 MiB it is killed under ordinary load.
    memoryMb: z.number().int().min(512).max(524_288),
    swapMb: z.number().int().min(0).max(524_288).default(0),
    publishS3: z.boolean().optional(),
    publishedPort: z.number().int().min(1).max(65535).default(9000),
    tags: tagsSchema,
    accessKey: z.string().trim().min(3).max(128).optional(),
    secretKey: z.string().min(8).max(256).optional(),
    // Distributed (erasure-coded) clusters were a MinIO-only topology. A single
    // entry is the same as `nodeId`; more than one is refused below.
    memberNodeIds: z.array(z.string().uuid()).optional(),
    // Drives contributed per member node. Only one drive per node is supported.
    drivesPerNode: z.number().int().min(1).max(1).optional(),
    // Opt-in TLS cert issuance from the internal Storage CA at create time
    // (see `ManagedStorageService.create`). Defaults to false in the service
    // when omitted; a relay create forces it on.
    tlsEnabled: z.boolean().optional(),
    // Opt-in Opfield-local relay: the S3 client reaches the cluster over a
    // 127.0.0.1 loopback tunnel (`ManagedStorageTunnelProxy`) instead of a
    // publicly reachable S3 port (see `ManagedStorageService.create`).
    // Relay implies TLS: the service forces `tlsEnabled` on for a relay
    // create regardless of this field, since the loopback leg is only ever
    // served over HTTPS.
    relayEnabled: z.boolean().optional(),
    /**
     * Create the storage on several servers (availability): the extra servers (nodeId is the first one), witnesses,
     * a replicated pair without automatic failover (`manual`). SeaweedFS replicates synchronously only.
     */
    availability: ManagedAvailabilityEnableSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.memberNodeIds !== undefined && value.memberNodeIds.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['memberNodeIds'],
        message: 'Managed storage is single-node: distributed clusters are not supported',
      });
    }
  });

/**
 * Preflight of the create form: the storage does not exist yet. `nodeId` is the server it is created on (default: the
 * first of `nodeIds`); `nodeIds` may list it too.
 */
export const ManagedStorageAvailabilityCreatePreflightSchema = ManagedAvailabilityPreflightSchema.extend({
  nodeId: z.string().uuid().optional(),
  folderId: z.string().uuid().nullable().optional(),
  publishS3: z.boolean().optional(),
  publishedPort: z.number().int().min(1).max(65535).optional(),
}).strict();

export const UpdateManagedStorageSchema = z
  .object({
    name: managedStorageNameSchema.optional(),
    tags: tagsSchema,
    storageSizeGb: z.number().finite().min(1).max(16_384).optional(),
    cpuCores: z.number().min(0.1).max(128).optional(),
    // 256 MiB stays valid for legacy MinIO clusters; the service enforces the
    // 512 MiB SeaweedFS minimum.
    memoryMb: z
      .number()
      .int()
      .min(256)
      .max(524_288)
      .optional()
      .describe('Memory in MiB: at least 512 for SeaweedFS clusters (as at create); legacy MinIO clusters accept 256'),
    swapMb: z.number().int().min(0).max(524_288).optional(),
    publishS3: z.boolean().optional(),
    publishedPort: z.number().int().min(1).max(65535).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field must be provided' });

/**
 * Create-time schema for a managed storage IAM access key. `name` is a display
 * label only — the key id and secret are generated for the caller (by Opfield
 * on SeaweedFS, by MinIO on legacy clusters), never chosen by them: letting a
 * caller pick their own secret defeats the "shown once, strongly random"
 * guarantee the reveal-once UX relies on.
 *
 * `access`/`buckets` (Phase 2b-vii Task 2) scope the inline IAM policy
 * `ManagedStorageService.createAccessKey` builds for the cluster's engine and
 * dispatches to the daemon. `access` defaults to `'read-write'` — unchanged
 * behavior for existing callers that omit it. `buckets` omitted/empty means
 * "all buckets", also matching prior behavior. Bucket names are validated to
 * the S3 naming grammar HERE (this is the enforcement boundary): each name is
 * interpolated into an IAM policy ARN (`arn:aws:s3:::<name>`), and IAM treats
 * `*`/`?` as wildcards — so a name like `*` or `foo*` would widen a "scoped"
 * key back to every bucket. The regex (lowercase alphanumerics, dots, hyphens;
 * must start/end alphanumeric; 3-63 chars) excludes `*`, `?`, `/`, whitespace,
 * quotes, commas and uppercase, so no injected name can broaden the scope.
 */
export const managedStorageBucketNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Invalid S3 bucket name');

export const CreateManagedStorageAccessKeySchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  access: z.enum(['read-only', 'read-write']).default('read-write'),
  buckets: z.array(managedStorageBucketNameSchema).max(64).optional(),
  // Optional ISO-8601 expiration. Must be a real datetime strictly in the
  // future; the storage server enforces its own min/max bounds and any such
  // rejection is surfaced verbatim. Omitted ⇒ the key never expires.
  expiresAt: z
    .string()
    .datetime({ message: 'expiresAt must be an ISO-8601 datetime' })
    .refine((value) => new Date(value).getTime() > Date.now(), { message: 'expiresAt must be in the future' })
    .optional(),
});

export type ManagedStorageListQuery = z.infer<typeof ManagedStorageListQuerySchema>;
export type CreateManagedStorageInput = z.infer<typeof CreateManagedStorageSchema>;
export type UpdateManagedStorageInput = z.infer<typeof UpdateManagedStorageSchema>;
// `z.input` (not `z.infer`/`z.output`): `access`'s `.default('read-write')`
// makes the *parsed* output always resolved/required, but callers of
// `ManagedStorageService.createAccessKey` (this type) should still see it as
// optional — the service itself resolves the default via `input.access ??
// 'read-write'`, mirroring how `input.buckets` is already handled.
export type CreateManagedStorageAccessKeyInput = z.input<typeof CreateManagedStorageAccessKeySchema>;

/**
 * Environment variable names a binding writes into its target workload. Every
 * field is optional: an application that only needs an endpoint and keys
 * should not be forced to accept a bucket or region variable it ignores.
 */
const storageBindingEnvironmentSchema = z
  .object({
    endpoint: z
      .string()
      .trim()
      .regex(/^[A-Z_][A-Z0-9_]*$/i)
      .max(128)
      .optional(),
    accessKeyId: z
      .string()
      .trim()
      .regex(/^[A-Z_][A-Z0-9_]*$/i)
      .max(128)
      .optional(),
    secretAccessKey: z
      .string()
      .trim()
      .regex(/^[A-Z_][A-Z0-9_]*$/i)
      .max(128)
      .optional(),
    bucket: z
      .string()
      .trim()
      .regex(/^[A-Z_][A-Z0-9_]*$/i)
      .max(128)
      .optional(),
    region: z
      .string()
      .trim()
      .regex(/^[A-Z_][A-Z0-9_]*$/i)
      .max(128)
      .optional(),
  })
  .refine((value) => Object.values(value).some(Boolean), {
    message: 'At least one environment variable name is required',
  })
  .refine(
    (value) => {
      const names = Object.values(value).filter(Boolean);
      return new Set(names).size === names.length;
    },
    {
      message: 'Use distinct environment variable names',
    }
  );

export const CreateManagedStorageBindingSchema = z.object({
  targetNodeId: z.string().uuid(),
  targetType: z.enum(['container', 'deployment']),
  targetResourceId: z.string().trim().min(1).max(255),
  environment: storageBindingEnvironmentSchema,
  targetEnvironment: z.record(z.string(), z.string()).optional(),
  // Scoping a binding to no bucket would hand the workload the whole cluster,
  // which defeats the point of a per-binding identity.
  buckets: z.array(managedStorageBucketNameSchema).min(1).max(32),
});

export type CreateManagedStorageBindingInput = z.infer<typeof CreateManagedStorageBindingSchema>;

export const DeleteManagedStorageBindingSchema = z.object({
  targetEnvironment: z.record(z.string(), z.string()).optional(),
});

// ── MinIO -> SeaweedFS cutover ──────────────────────────────────────────────

/** Point a workload link at another managed storage cluster, keeping its key, alias and environment. */
export const MoveManagedStorageBindingSchema = z.object({
  targetStorageId: z.string().uuid(),
});

export type MoveManagedStorageBindingInput = z.infer<typeof MoveManagedStorageBindingSchema>;

/**
 * Copy operator access keys from another cluster into this one with the same
 * access key id and secret. `keyIds` limits the copy to those access key ids;
 * omitted means every key of the source cluster.
 */
export const ImportManagedStorageAccessKeysSchema = z.object({
  sourceStorageId: z.string().uuid(),
  keyIds: z.array(z.string().trim().min(1).max(128)).min(1).max(256).optional(),
});

export type ImportManagedStorageAccessKeysInput = z.infer<typeof ImportManagedStorageAccessKeysSchema>;

/** Move finished backup history of this cluster to another one after its files were copied there. */
export const RehomeManagedStorageBackupHistorySchema = z.object({
  targetStorageId: z.string().uuid(),
  dryRun: z.boolean().optional(),
});

export type RehomeManagedStorageBackupHistoryInput = z.infer<typeof RehomeManagedStorageBackupHistorySchema>;

/** One key summary in an import report; never carries a secret. */
export interface ManagedStorageImportedKeySummary {
  accessKeyId: string;
  name: string | null;
  access: 'read-only' | 'read-write';
  buckets: string[];
}

export interface ManagedStorageKeyImportResult {
  sourceStorageId: string;
  targetStorageId: string;
  /** Created in the target with the same access key id and secret. */
  imported: ManagedStorageImportedKeySummary[];
  /**
   * Keys that cannot keep their id in the target (expiring keys, or an id or
   * secret the target engine does not accept). Create a new key with the same
   * access, buckets and expiry and hand it to the key holder.
   */
  needsNewId: Array<ManagedStorageImportedKeySummary & { expiresAt: string | null; reason: string }>;
  skipped: Array<{ accessKeyId: string; reason: 'already_present' | 'expired' | 'not_found' }>;
  failed: Array<{ accessKeyId: string; error: string }>;
}

/** The outcome of a write freeze or unfreeze. Keys are listed by access key id only. */
export interface ManagedStorageWriteFreezeResult {
  managedStorageId: string;
  writesFrozen: boolean;
  writesFrozenAt: string | null;
  /** Operator keys and workload-link keys whose policy was rewritten. */
  updated: Array<{ kind: 'access_key' | 'binding'; id: string; accessKeyId: string | null }>;
  skipped: Array<{ kind: 'access_key' | 'binding'; id: string; accessKeyId: string | null; reason: string }>;
  /**
   * Keys the storage server reports that Opfield did not issue (freeze only;
   * `null` when the server could not be listed). They are not frozen.
   */
  unmanagedKeys: string[] | null;
  /**
   * Enabled backup policies that still write to this storage (freeze only).
   * Their runs are refused while it is frozen; move them to the new storage.
   */
  backupPoliciesStillUsingStorage: number;
}
