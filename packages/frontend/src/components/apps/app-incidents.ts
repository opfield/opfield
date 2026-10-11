import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import type { AppDetail, AppIncident, AppIncidentKind } from "@/types";

/** Open incidents of a kind (not yet released), optionally only of some environments. */
export function openAppIncidents(
  app: AppDetail,
  kind: AppIncidentKind,
  environmentIds?: readonly string[]
): AppIncident[] {
  return app.environments
    .filter((env) => !environmentIds || environmentIds.includes(env.id))
    .flatMap((env) =>
      (env.incidents ?? []).filter(
        (incident) => incident.kind === kind && incident.state !== "released"
      )
    );
}

/**
 * The environments to end an incident in: every environment when the caller holds apps:operate on
 * the app (`null`), else the affected environments it may operate.
 */
function endScope(app: AppDetail, incidents: AppIncident[]): string[] | null {
  if (app.permissions.operate) return null;
  return incidents
    .map((incident) => incident.environmentId)
    .filter((id) => app.permissions.operateEnv?.[id]);
}

export function canEndIncidents(app: AppDetail, incidents: AppIncident[]): boolean {
  if (incidents.length === 0) return false;
  if (app.permissions.operate) return true;
  return incidents.some((incident) => app.permissions.operateEnv?.[incident.environmentId]);
}

/** Turn the kill switch off (confirmed): every recorded change is restored from its prior state. */
export async function turnOffKillSwitch(
  app: AppDetail,
  incidents: AppIncident[]
): Promise<boolean> {
  const ok = await confirm({
    title: `Turn Off the Kill Switch of ${app.name}`,
    description:
      "Routes, links, bindings, Secure Links, published ports and container networks go back to exactly what they were before the isolation.",
    confirmLabel: "Turn Off",
  });
  if (!ok) return false;
  try {
    await api.releaseAppIsolation(app.id, endScope(app, incidents));
    toast.success(`Restoring ${app.name}`);
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to turn off the kill switch");
    return false;
  }
}

/** Start after a shutdown (confirmed): only what the shutdown stopped and is still stopped starts. */
export async function startAfterShutdown(
  app: AppDetail,
  incidents: AppIncident[]
): Promise<boolean> {
  const ok = await confirm({
    title: `Start ${app.name}`,
    description:
      "Everything the shutdown stopped starts again and routes return to their own maintenance state. Resources changed by hand meanwhile are left as they are.",
    confirmLabel: "Start",
  });
  if (!ok) return false;
  try {
    await api.startApp(app.id, endScope(app, incidents));
    toast.success(`Starting ${app.name}`);
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to start the app");
    return false;
  }
}
