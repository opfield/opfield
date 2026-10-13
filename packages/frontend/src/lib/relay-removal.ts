import { formatDateTime } from "@/lib/utils";
import type { DashboardRelayInstance } from "@/types";

/**
 * An offline remote relay can be removed once its signed policy has expired and it has been silent for 90 s; Opfield
 * reports that moment as `removableAfter`. Until then removal is refused, and this names when it becomes possible, in
 * the browser's local time. Null once the relay can be removed, or when it is not offline.
 */
export function relayRemovalWaitNote(
  instance: Pick<DashboardRelayInstance, "state" | "removableAfter">,
  now = Date.now()
): string | null {
  if (instance.state !== "offline" || !instance.removableAfter) return null;
  const removableAt = Date.parse(instance.removableAfter);
  if (Number.isNaN(removableAt) || removableAt <= now) return null;
  return `Can be removed after ${formatDateTime(removableAt)}`;
}
