// Moves browser state saved under the old product name to its Opfield key. Runs once on import,
// before any store hydrates: main.tsx and login-main.tsx import this module first.

// legacy-name: browser storage keys written before 2.12.1 — remove once 2.12.0 is no longer an update source
const LEGACY_LOCAL_STORAGE_KEYS: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ["gateway-ui", "opfield-ui"],
  ["gateway-app-status", "opfield-app-status"],
  ["gateway-auth-context-key", "opfield-auth-context-key"],
  ["gateway-dev-force-updates", "opfield-dev-force-updates"],
  ["gateway-pinned-nodes", "opfield-pinned-nodes"],
  ["gateway-pinned-databases", "opfield-pinned-databases"],
  ["gateway-pinned-containers", "opfield-pinned-containers"],
  ["gateway-pinned-proxy-hosts", "opfield-pinned-proxy-hosts"],
  ["gateway-pinned-storage", "opfield-pinned-storage"],
  ["gateway-sidebar-width", "opfield-sidebar-width"],
  ["gateway-ai-panel-width", "opfield-ai-panel-width"],
  ["gateway-ai-lite-expanded-project-ids", "opfield-ai-lite-expanded-project-ids"],
  ["gateway-database-console-split-percent", "opfield-database-console-split-percent"],
  ["gateway:audit-log:view", "opfield:audit-log:view"],
  ["gateway:ai:selected-model", "opfield:ai:selected-model"],
  ["gateway:account-menu:ai-usage-open", "opfield:account-menu:ai-usage-open"],
  ["gateway.dockerRegistries.gitlabExpanded", "opfield.dockerRegistries.gitlabExpanded"],
];

// legacy-name: browser storage keys written before 2.12.1 — remove once 2.12.0 is no longer an update source
const LEGACY_LOCAL_STORAGE_PREFIXES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ["gateway:ai:reasoning-effort:", "opfield:ai:reasoning-effort:"],
  ["gateway-ai-composer-draft:", "opfield-ai-composer-draft:"],
  ["gateway-ai-composer-attachments:", "opfield-ai-composer-attachments:"],
  ["gateway-database-console-input:", "opfield-database-console-input:"],
  ["gateway-database-console-history:", "opfield-database-console-history:"],
  ["gateway:finalize-setup:skip-prompt-shown:", "opfield:finalize-setup:skip-prompt-shown:"],
];

// legacy-name: browser storage keys written before 2.12.1 — remove once 2.12.0 is no longer an update source
const LEGACY_SESSION_STORAGE_KEYS: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ["gateway:setup-restore-upload", "opfield:setup-restore-upload"],
  ["gateway:setup-restore-public-url", "opfield:setup-restore-public-url"],
  ["gateway:setup-restore-owner-link-claim", "opfield:setup-restore-owner-link-claim"],
  ["gateway:docker-migration:owned", "opfield:docker-migration:owned"],
];

// legacy-name: browser storage keys written before 2.12.1 — remove once 2.12.0 is no longer an update source
const LEGACY_SESSION_STORAGE_PREFIXES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ["gateway:setup-draft:", "opfield:setup-draft:"],
];

// legacy-name: IndexedDB API cache written before 2.12.1 — remove once 2.12.0 is no longer an update source
const LEGACY_API_CACHE_DATABASE = "gateway-api-cache";

function moveKey(storage: Storage, legacy: string, current: string) {
  const value = storage.getItem(legacy);
  if (value === null) return;
  if (storage.getItem(current) === null) storage.setItem(current, value);
  storage.removeItem(legacy);
}

function migrateStorage(
  storage: Storage,
  keys: ReadonlyArray<readonly [string, string]>,
  prefixes: ReadonlyArray<readonly [string, string]>
) {
  for (const [legacy, current] of keys) {
    try {
      moveKey(storage, legacy, current);
    } catch {
      // A full or blocked storage keeps the old key; the next load tries again.
    }
  }
  if (prefixes.length === 0) return;

  const legacyKeys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== null && prefixes.some(([legacy]) => key.startsWith(legacy))) legacyKeys.push(key);
  }
  for (const key of legacyKeys) {
    const prefix = prefixes.find(([legacy]) => key.startsWith(legacy));
    if (!prefix) continue;
    try {
      moveKey(storage, key, prefix[1] + key.slice(prefix[0].length));
    } catch {
      // A full or blocked storage keeps the old key; the next load tries again.
    }
  }
}

export function migrateLegacyStorageKeys() {
  try {
    if (typeof window === "undefined") return;
    migrateStorage(window.localStorage, LEGACY_LOCAL_STORAGE_KEYS, LEGACY_LOCAL_STORAGE_PREFIXES);
    migrateStorage(
      window.sessionStorage,
      LEGACY_SESSION_STORAGE_KEYS,
      LEGACY_SESSION_STORAGE_PREFIXES
    );
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }

  try {
    if (typeof indexedDB !== "undefined") indexedDB.deleteDatabase(LEGACY_API_CACHE_DATABASE);
  } catch {
    // Best effort: the old cache only holds short-lived read-only projections.
  }
}

migrateLegacyStorageKeys();
