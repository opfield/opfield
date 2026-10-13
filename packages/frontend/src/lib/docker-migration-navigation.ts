import { ApiRequestError } from "@/services/api-base";

export const MIGRATION_TARGET_RETRY_DELAYS_MS = [0, 150, 300, 500, 750, 1_000, 1_500, 2_000, 2_500];
const OWNED_MIGRATION_STORAGE_KEY = "opfield:docker-migration:owned";

export function markDockerMigrationOwnedByTab(migrationId: string): void {
  window.sessionStorage.setItem(OWNED_MIGRATION_STORAGE_KEY, migrationId);
}

export function isDockerMigrationOwnedByTab(migrationId: string): boolean {
  return window.sessionStorage.getItem(OWNED_MIGRATION_STORAGE_KEY) === migrationId;
}

export function clearDockerMigrationOwnedByTab(migrationId: string): void {
  if (isDockerMigrationOwnedByTab(migrationId)) {
    window.sessionStorage.removeItem(OWNED_MIGRATION_STORAGE_KEY);
  }
}

export async function resolveMigrationTarget<T>(
  enabled: boolean,
  resolver: () => Promise<T>,
  delays = MIGRATION_TARGET_RETRY_DELAYS_MS
): Promise<T> {
  if (!enabled) return resolver();
  let lastError: unknown;
  for (const delayMs of delays) {
    if (delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    try {
      return await resolver();
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApiRequestError) || ![404, 502, 503, 504].includes(error.status)) {
        throw error;
      }
    }
  }
  throw lastError;
}
