import { History } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { Badge } from "@/components/ui/badge";
import type { AvailabilityEvent } from "@/types";
import { eventLabel, eventTone } from "./availability-labels";

function eventDetail(event: AvailabilityEvent): string | null {
  const details = event.details ?? {};
  for (const key of ["message", "reason", "error"]) {
    const value = details[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const from = details.fromNodeName ?? details.previousNodeName;
  const to = details.toNodeName ?? details.nodeName;
  if (typeof from === "string" && typeof to === "string") return `${from} → ${to}`;
  if (typeof to === "string") return to;
  return null;
}

/** Failovers, switches, degraded periods, rejoins and witness moves of the set, newest first. */
export function AvailabilityEvents({ events }: { events: AvailabilityEvent[] }) {
  return (
    <PanelShell
      title="Events"
      icon={<History className="h-4 w-4" />}
      description="Failovers, switches and copies falling behind or catching up."
    >
      {events.length === 0 ? (
        <EmptyState embedded message="No events yet." />
      ) : (
        <div className="divide-y divide-border">
          {events.map((event) => {
            const detail = eventDetail(event);
            return (
              <div
                key={event.id}
                className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <Badge size="inline" variant={eventTone(event.action)}>
                    {eventLabel(event.action)}
                  </Badge>
                  {detail ? (
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={detail}>
                      {detail}
                    </p>
                  ) : null}
                </div>
                <RelativeTime value={event.createdAt} className="text-xs text-muted-foreground" />
              </div>
            );
          })}
        </div>
      )}
    </PanelShell>
  );
}
