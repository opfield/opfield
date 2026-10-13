/**
 * The `ManagedWorkloadProvider` seam abstracts the parts of managed workload
 * provisioning (databases today, object storage later) that are common
 * across workload kinds: catalog/image resolution, and the canonical
 * `database_connections` record and TLS certificate bookkeeping that ties a
 * managed workload back into the rest of the platform.
 *
 * This file defines the seam's types only. No logic is moved here yet — the
 * context/result interfaces below mirror the parameter lists of the private
 * methods on `ManagedDatabasesService` (see `managed-databases.service.ts`:
 * `createCanonicalConnection`, `syncCanonicalConnection*`,
 * `ensureManagedDatabaseCertificate`) so that a later task can move that
 * logic behind this interface without changing behavior.
 */

/** The two kinds of managed workload the platform can provision. */
export type ManagedWorkloadKind = 'database' | 'storage';

/** Owner-level credentials for the canonical connection record. */
export interface CanonicalConnectionCredentials {
  username: string;
  password: string;
  databaseName?: string;
}

/**
 * Mirrors the parameters of `createCanonicalConnection(name, type,
 * credentials, storageSizeBytes, userId, tags)`.
 */
export interface CanonicalConnectionContext {
  name: string;
  type: string;
  credentials: CanonicalConnectionCredentials;
  storageSizeBytes: number;
  userId: string;
  tags?: string[];
  /** Storage-kind only: shapes the auto-registered `object_storage_connections` row. Ignored by the database provider. */
  storage?: { endpoint: string; region: string; forcePathStyle: boolean; s3Provider: 'minio' | 'seaweedfs' };
  /** Folder of the auto-registered canonical connection; null or omitted places it at the root. */
  folderId?: string | null;
}

/**
 * Mirrors the combined parameters of the `syncCanonicalConnection*` helpers:
 * `syncCanonicalConnectionCredentials(row, credentials, userId)`,
 * `syncCanonicalConnectionName(row, previousName)`,
 * `syncCanonicalConnectionStorageLimit(row)`, and
 * `syncCanonicalConnectionTags(row, tags)`.
 *
 * Every field beyond the connection identity is optional because a single
 * sync call may only be updating one of these dimensions.
 *
 * NOTE on `updatedById`: the four source methods populate this field in three
 * different ways, which the `string | null` type below cannot itself express.
 * Task 3's implementation behind this seam must reproduce all three cases:
 *  1. `syncCanonicalConnectionCredentials` — derives it from a passed-in
 *     `userId` and sets it **conditionally**: when `userId` is falsy, the
 *     `updatedById` key is **omitted from the update payload entirely**
 *     (not written as `null`).
 *  2. `syncCanonicalConnectionName` / `syncCanonicalConnectionStorageLimit` /
 *     `syncCanonicalConnectionTags` — **unconditionally** copy
 *     `row.updatedById`, i.e. a value already persisted earlier in the same
 *     flow, rather than deriving it from a fresh `userId` argument.
 * A literal `null` value on this context should only ever mean "no updater
 * known", never "omit the field" — callers/implementers must not collapse
 * case 1's omission and case 2's copy-from-row into the same `null`.
 */
export interface CanonicalConnectionSyncContext {
  connectionId: string | null;
  /**
   * See the interface-level NOTE above: depending on which of the four
   * source sync methods this call corresponds to, this value is either
   * (a) omitted upstream when no fresh `userId` was supplied (methods must
   * not conflate that omission with an explicit `null`), or (b) copied
   * unconditionally from the row's already-persisted `updatedById`. `null`
   * here means "no updater known", not "leave the field untouched".
   */
  updatedById: string | null;
  name: string;
  previousName?: string;
  type?: string;
  credentials?: CanonicalConnectionCredentials;
  storageSizeBytes?: number;
  tags?: string[];
  /** Storage-kind only: fields of the `object_storage_connections` row to sync. Ignored by the database provider. */
  storage?: { endpoint?: string; region?: string };
}

/** Mirrors the `node` parameter shared by workload node lookups. */
export interface ManagedWorkloadNode {
  serviceAddress: string | null;
  /**
   * The node's hostname. Optional/kind-specific: managed storage includes it as
   * a DNS SAN because its auto-registered endpoint uses `serviceAddress ??
   * hostname` (a DNS name when no IP service address is configured), so the
   * cert must cover the hostname. The database kind ignores it (IP-only SANs).
   */
  hostname?: string;
  lastHealthReport: unknown;
}

/**
 * Mirrors the parameters of
 * `ensureManagedDatabaseCertificate(row, node)`.
 */
export interface CertificateContext {
  workloadId: string;
  existingCertificateId: string | null;
  node: ManagedWorkloadNode;
  /**
   * Storage-kind only: when true, the issued cert's SAN list must also cover
   * the Opfield-local loopback (`127.0.0.1`/`localhost`) the S3 client
   * verifies against over a `ManagedStorageTunnelProxy` relay tunnel. Ignored
   * by the database provider. Defaults to false (unchanged SAN list) when
   * omitted.
   */
  relay?: boolean;
  additionalAddresses?: string[];
}

/** The essential certificate identity produced when a certificate is issued. */
export interface CertificateResult {
  certificateId: string;
}

/**
 * One provisionable workload type in a provider's catalog, along with the
 * versions available for it (mirrors the shape `DatabaseWorkloadProvider`'s
 * `listCatalog` derives from `MANAGED_DATABASE_CATALOG`).
 */
export interface ManagedWorkloadCatalogEntry {
  type: string;
  versions: string[];
}

/**
 * A provider that knows how to provision and manage one kind of managed
 * workload (e.g. managed databases, or later, managed object storage) on
 * top of the shared node/docker/connection infrastructure.
 */
export interface ManagedWorkloadProvider {
  readonly kind: ManagedWorkloadKind;

  /** Resolves the pinned container image for a given workload type/version. */
  resolveImage(type: string, version: string): string;

  /** Returns the catalog of provisionable workload types/versions/images. */
  listCatalog(): ManagedWorkloadCatalogEntry[];

  /**
   * Registers the canonical `database_connections` record for a newly
   * provisioned workload and returns its id.
   */
  registerCanonicalConnection(ctx: CanonicalConnectionContext): Promise<string>;

  /** Syncs the canonical connection record after the workload changes. */
  syncCanonicalConnection(ctx: CanonicalConnectionSyncContext): Promise<void>;

  /**
   * Ensures a TLS certificate exists for the workload, issuing one if
   * needed. Returns `null` when no certificate action was required — e.g.
   * no certificate authority is configured for this deployment (today's
   * `ensureManagedDatabaseCertificate` never returns `null`: absent a CA or
   * an existing `certificateId` it just returns the row unchanged; `null`
   * here is the seam's intentional representation of that "nothing to do"
   * outcome, for Task 3 to implement rather than invent).
   */
  ensureCertificate(ctx: CertificateContext): Promise<CertificateResult | null>;
}
