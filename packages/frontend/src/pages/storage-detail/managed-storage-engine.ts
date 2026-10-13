import type {
  ManagedObjectStorageCatalogEntry,
  ManagedStorageEngine,
  ObjectStorageConnection,
} from "@/types";

/** The only engine new managed storage clusters are created with. */
export const MANAGED_STORAGE_CREATE_ENGINE: ManagedStorageEngine = "seaweedfs";

export const MANAGED_STORAGE_MIGRATION_DOCS_URL =
  "https://docs.opfield.dev/en/storage/overview/#migrating-from-minio";

export const MANAGED_STORAGE_ENGINE_LABELS: Record<ManagedStorageEngine, string> = {
  minio: "MinIO",
  seaweedfs: "SeaweedFS",
};

/** The API error code for a legacy engine operation that needs an image the node no longer has. */
export const MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE = "MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE";

const ENGINE_IMAGE_UNAVAILABLE_PATTERN = /engine[\s_-]image[\s_-](?:is[\s_-])?unavailable/i;

export const MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE_MESSAGE =
  "The MinIO image for this legacy cluster is no longer on the node and can no longer be downloaded, so actions that recreate its container cannot run. Migrate the data to a SeaweedFS cluster.";

/**
 * The engine of a managed cluster, or `null` for an external connection.
 * Older backends omit `engine`; those clusters are MinIO.
 */
export function managedStorageEngine(
  storage: Pick<ObjectStorageConnection, "provider" | "managed">
): ManagedStorageEngine | null {
  if (!storage.managed) return null;
  return storage.managed.engine ?? (storage.provider === "seaweedfs" ? "seaweedfs" : "minio");
}

export function managedStorageMinimumMemoryMb(engine: ManagedStorageEngine): number {
  return engine === "seaweedfs" ? 512 : 256;
}

/** Versions the catalog offers for an engine; empty until the catalog lists it. */
export function catalogEngineVersions(
  catalog: ManagedObjectStorageCatalogEntry[],
  engine: ManagedStorageEngine
): string[] {
  return catalog.find((entry) => entry.type === engine)?.versions ?? [];
}

/** Matches the typed API error (`ApiRequestError.code`) or a stored/daemon message carrying it. */
export function isEngineImageUnavailable(error: unknown): boolean {
  if (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE
  ) {
    return true;
  }
  const message =
    typeof error === "string" ? error : error instanceof Error ? error.message : undefined;
  return (
    !!message &&
    (message.includes(MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE) ||
      ENGINE_IMAGE_UNAVAILABLE_PATTERN.test(message))
  );
}

/** The code at the front of a managed cluster's `lastError` while its disk is full. */
export const MANAGED_STORAGE_FULL = "MANAGED_STORAGE_FULL";

/** A serving managed cluster whose disk is full: it serves reads but refuses uploads. */
export function isManagedStorageFull(storage: Pick<ObjectStorageConnection, "managed">): boolean {
  const managed = storage.managed;
  return (
    managed?.status === "ready" && (managed.lastError?.startsWith(MANAGED_STORAGE_FULL) ?? false)
  );
}

/** The code at the front of a managed cluster's `lastError` while its disk has little room left. */
export const MANAGED_STORAGE_NEARLY_FULL = "MANAGED_STORAGE_NEARLY_FULL";

/** A serving managed cluster whose disk is nearly full: uploads still work. */
export function isManagedStorageNearlyFull(
  storage: Pick<ObjectStorageConnection, "managed">
): boolean {
  const managed = storage.managed;
  return (
    managed?.status === "ready" &&
    (managed.lastError?.startsWith(`${MANAGED_STORAGE_NEARLY_FULL}:`) ?? false)
  );
}

/** A stored error message, with the engine-image failure rewritten into guidance. */
export function formatManagedStorageError(message: string): string {
  return isEngineImageUnavailable(message)
    ? MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE_MESSAGE
    : message;
}

/** A toast message for a failed managed storage request. */
export function managedStorageErrorMessage(error: unknown, fallback: string): string {
  if (isEngineImageUnavailable(error)) return MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE_MESSAGE;
  return error instanceof Error ? error.message : fallback;
}
