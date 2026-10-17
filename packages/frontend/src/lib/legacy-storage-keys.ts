import { LEGACY_STORAGE_KEY_PREFIX } from "../../../backend/src/lib/legacy-compat";
// Moves browser state saved under the old product name to its Opfield key. Runs once on import,
// before any store hydrates: main.tsx and login-main.tsx import this module first.

// legacy-name: browser storage keys written before 2.12.1 — remove once 2.12.0 is no longer an update source
const LEGACY_LOCAL_STORAGE_KEYS: ReadonlyArray<readonly [legacy: string, current: string]> = [
  [`${LEGACY_STORAGE_KEY_PREFIX}-ui`, "opfield-ui"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-app-status`, "opfield-app-status"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-auth-context-key`, "opfield-auth-context-key"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-dev-force-updates`, "opfield-dev-force-updates"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-pinned-nodes`, "opfield-pinned-nodes"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-pinned-databases`, "opfield-pinned-databases"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-pinned-containers`, "opfield-pinned-containers"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-pinned-proxy-hosts`, "opfield-pinned-proxy-hosts"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-pinned-storage`, "opfield-pinned-storage"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-sidebar-width`, "opfield-sidebar-width"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-ai-panel-width`, "opfield-ai-panel-width"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-ai-lite-expanded-project-ids`, "opfield-ai-lite-expanded-project-ids"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-database-console-split-percent`, "opfield-database-console-split-percent"],
  [`${LEGACY_STORAGE_KEY_PREFIX}:audit-log:view`, "opfield:audit-log:view"],
  [`${LEGACY_STORAGE_KEY_PREFIX}:ai:selected-model`, "opfield:ai:selected-model"],
  [`${LEGACY_STORAGE_KEY_PREFIX}:account-menu:ai-usage-open`, "opfield:account-menu:ai-usage-open"],
  [`${LEGACY_STORAGE_KEY_PREFIX}.dockerRegistries.gitlabExpanded`, "opfield.dockerRegistries.gitlabExpanded"],
];

// legacy-name: browser storage keys written before 2.12.1 — remove once 2.12.0 is no longer an update source
const LEGACY_LOCAL_STORAGE_PREFIXES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  [`${LEGACY_STORAGE_KEY_PREFIX}:ai:reasoning-effort:`, "opfield:ai:reasoning-effort:"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-ai-composer-draft:`, "opfield-ai-composer-draft:"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-ai-composer-attachments:`, "opfield-ai-composer-attachments:"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-database-console-input:`, "opfield-database-console-input:"],
  [`${LEGACY_STORAGE_KEY_PREFIX}-database-console-history:`, "opfield-database-console-history:"],
  [`${LEGACY_STORAGE_KEY_PREFIX}:finalize-setup:skip-prompt-shown:`, "opfield:finalize-setup:skip-prompt-shown:"],
];

// legacy-name: browser storage keys written before 2.12.1 — remove once 2.12.0 is no longer an update source
const LEGACY_SESSION_STORAGE_KEYS: ReadonlyArray<readonly [legacy: string, current: string]> = [
  [`${LEGACY_STORAGE_KEY_PREFIX}:setup-restore-upload`, "opfield:setup-restore-upload"],
  [`${LEGACY_STORAGE_KEY_PREFIX}:setup-restore-public-url`, "opfield:setup-restore-public-url"],
  [`${LEGACY_STORAGE_KEY_PREFIX}:setup-restore-owner-link-claim`, "opfield:setup-restore-owner-link-claim"],
  [`${LEGACY_STORAGE_KEY_PREFIX}:docker-migration:owned`, "opfield:docker-migration:owned"],
];

// legacy-name: browser storage keys written before 2.12.1 — remove once 2.12.0 is no longer an update source
const LEGACY_SESSION_STORAGE_PREFIXES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  [`${LEGACY_STORAGE_KEY_PREFIX}:setup-draft:`, "opfield:setup-draft:"],
];

// legacy-name: IndexedDB API cache written before 2.12.1 — remove once 2.12.0 is no longer an update source
const LEGACY_API_CACHE_DATABASE = `${LEGACY_STORAGE_KEY_PREFIX}-api-cache`;

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
