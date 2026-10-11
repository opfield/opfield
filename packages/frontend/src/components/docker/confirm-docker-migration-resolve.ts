import { confirm } from "@/components/common/ConfirmDialog";
import type { DockerMigration } from "@/types";

/**
 * Asks the operator to confirm which node is authoritative for a migration that needs attention.
 * The side follows cutover: before cutover the source stays authoritative, after it the target.
 * Resolves to the confirmed side, or null when the operator cancels.
 */
export async function confirmDockerMigrationResolve(
  migration: Pick<DockerMigration, "cutoverAt">
): Promise<"source" | "target" | null> {
  const side = migration.cutoverAt ? "target" : "source";
  const ok = await confirm({
    title: "Resolve migration",
    description:
      side === "source"
        ? "Cutover did not complete, so Opfield keeps the source node as authoritative. Confirm that you removed or stopped the target copy and restarted the source if it should run. Resolving releases the migration lock and the maintenance mode it entered; it does not start or remove any container."
        : "Cutover completed, so Opfield treats the target node as authoritative. Confirm that the source copy is stopped or removed. Resolving releases the migration lock and the maintenance mode it entered; it does not start or remove any container.",
    confirmLabel: side === "source" ? "Source is authoritative" : "Target is authoritative",
    variant: "destructive",
  });
  return ok ? side : null;
}
