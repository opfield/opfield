import { Notice } from "@/components/common/Notice";
import type { ObjectStorageConnection } from "@/types";
import { isManagedStorageFull, isManagedStorageNearlyFull } from "./managed-storage-engine";

/**
 * Shown while a managed cluster's disk is full: it still serves reads but
 * refuses uploads. The space of deleted objects comes back on its own. A disk
 * that is nearly full gets a warning first.
 */
export function ManagedStorageFullNotice({
  storage,
}: {
  storage: Pick<ObjectStorageConnection, "managed">;
}) {
  if (isManagedStorageNearlyFull(storage)) {
    return (
      <Notice role="status" tone="warning" title="Storage is nearly full">
        Uploads are refused once the disk is full. Grow the storage in its settings or delete
        objects.
      </Notice>
    );
  }
  if (!isManagedStorageFull(storage)) return null;
  return (
    <Notice role="status" tone="destructive" title="Storage is full">
      Uploads are refused until there is room again. Grow the storage in its settings or delete
      objects; the space of deleted objects is given back automatically within minutes.
    </Notice>
  );
}
