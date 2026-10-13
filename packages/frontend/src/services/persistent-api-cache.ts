const DATABASE_NAME = "opfield-api-cache";
const DATABASE_VERSION = 1;
const STORE_NAME = "entries";
const SCOPE_INDEX = "scope";

export const PERSISTENT_CACHE_TTL_MS = 15 * 60 * 1000;

export interface PersistentCacheEntry {
  id: string;
  scope: string;
  key: string;
  data: unknown;
  timestamp: number;
}

const PERSISTED_CACHE_PREFIXES = [
  "dashboard:stats:",
  "dashboard:bootstrap:",
  "dashboard:health",
  "cas:list:",
  "certificates:list:",
  "ssl:list:",
  "proxy:grouped",
  "domains:list",
  "templates:list",
  "access-lists:list",
  "nginx-templates:list",
  "system:version",
  "nodes:list:",
  "databases:list",
  "docker:snapshots:",
  "admin:users",
  "admin:groups",
  "admin:scope-",
  "logging:environments",
  "logging:schemas",
  "notifications:alerts",
  "notifications:webhooks",
  "status-page:",
  "settings:status-page-",
  "housekeeping:config",
  "housekeeping:stats",
  "settings:license-status",
] as const;

const PERSISTED_REQUEST_KEYS = new Set([
  "req:/api/ui/bootstrap",
  "req:/api/system/relay",
  "req:/api/system/version",
  "req:/api/system/license/status",
]);

// IndexedDB operations opened by separate calls may otherwise commit out of
// order. Serialize mutations so an invalidation issued after a cache write
// cannot be overtaken by that write and resurrect the invalidated entry.
let mutationQueue: Promise<void> = Promise.resolve();

function enqueueMutation(operation: () => Promise<void>): Promise<void> {
  const queued = mutationQueue.then(operation, operation);
  mutationQueue = queued.catch(() => {});
  return queued;
}

/**
 * Persist only explicitly reviewed, read-only projections. Unknown GETs are
 * deliberately excluded so credentials, tokens, logs, files, raw config, and
 * future sensitive endpoints never become durable browser data by accident.
 */
export function isPersistentCacheKey(key: string): boolean {
  return (
    PERSISTED_REQUEST_KEYS.has(key) ||
    PERSISTED_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function entryId(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!store.indexNames.contains(SCOPE_INDEX)) {
        store.createIndex(SCOPE_INDEX, "scope", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve(null);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function loadPersistentCache(
  scope: string,
  now = Date.now()
): Promise<PersistentCacheEntry[]> {
  const database = await openDatabase();
  if (!database) return [];

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index(SCOPE_INDEX);
    const request = index.getAll(IDBKeyRange.only(scope));
    const records = await new Promise<PersistentCacheEntry[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as PersistentCacheEntry[]);
      request.onerror = () => reject(request.error);
    });
    const fresh: PersistentCacheEntry[] = [];
    for (const record of records) {
      if (!isPersistentCacheKey(record.key) || now - record.timestamp > PERSISTENT_CACHE_TTL_MS) {
        store.delete(record.id);
      } else {
        fresh.push(record);
      }
    }
    await transactionDone(transaction);
    return fresh;
  } finally {
    database.close();
  }
}

export async function persistCacheEntry(
  scope: string,
  key: string,
  data: unknown,
  timestamp = Date.now()
): Promise<void> {
  if (!isPersistentCacheKey(key)) return;
  return enqueueMutation(async () => {
    const database = await openDatabase();
    if (!database) return;

    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({
        id: entryId(scope, key),
        scope,
        key,
        data,
        timestamp,
      } satisfies PersistentCacheEntry);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  });
}

/** Delete one current-scope cache key or a matching key prefix. */
export async function deletePersistentCachePrefix(scope: string, prefix?: string): Promise<void> {
  return enqueueMutation(async () => {
    const database = await openDatabase();
    if (!database) return;

    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.index(SCOPE_INDEX).openCursor(IDBKeyRange.only(scope));
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          const entry = cursor.value as PersistentCacheEntry;
          if (!prefix || entry.key.startsWith(prefix)) store.delete(cursor.primaryKey);
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  });
}

export async function clearPersistentCacheScope(scope: string): Promise<void> {
  return deletePersistentCachePrefix(scope);
}
