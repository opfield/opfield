import type { DockerMigration, DockerMigrationStatus } from "@/types";

/** The statuses whose error tells how the migration ended or why it needs an operator. */
const DOCKER_MIGRATION_ERROR_STATUSES: ReadonlySet<DockerMigrationStatus> = new Set([
  "failed",
  "cancelled",
  "needs_attention",
  "cleanup_pending",
]);

/**
 * The error to show for a migration, or null. A migration that waited for a node and then went on (or completed)
 * may still carry the wait's message from an earlier Opfield release; it is no error of the migration.
 */
export function dockerMigrationError(
  migration: Pick<DockerMigration, "status" | "errorMessage">
): string | null {
  return DOCKER_MIGRATION_ERROR_STATUSES.has(migration.status) && migration.errorMessage
    ? migration.errorMessage
    : null;
}
