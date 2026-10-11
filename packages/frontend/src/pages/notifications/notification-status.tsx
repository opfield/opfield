import { Check, Clock, Minus, X } from "lucide-react";
import type { StatusTone } from "@/components/common/resource-status";
import { cn } from "@/lib/utils";
import type { SiemDeliveryStatus } from "@/types";

/** Alert severity as a Badge variant: alert rules and webhook deliveries. */
export function alertSeverityVariant(severity: string): StatusTone {
  if (severity === "critical") return "destructive";
  if (severity === "warning") return "warning";
  return "secondary";
}

/** Webhook delivery status as a Badge variant. */
export function webhookDeliveryVariant(status: string): StatusTone {
  if (status === "success") return "success";
  if (status === "failed") return "destructive";
  if (status === "retrying") return "warning";
  return "secondary";
}

const SIEM_DELIVERY_VARIANTS: Record<SiemDeliveryStatus, StatusTone> = {
  queued: "secondary",
  delivering: "warning",
  retrying: "warning",
  delivered: "success",
  failed: "destructive",
  paused: "secondary",
  discarded: "secondary",
};

/** SIEM delivery status as a Badge variant. */
export function siemDeliveryVariant(status: SiemDeliveryStatus): StatusTone {
  return SIEM_DELIVERY_VARIANTS[status] ?? "secondary";
}

/** The response code a collector or webhook endpoint returned, as a Badge variant. */
export function httpStatusVariant(status: number): StatusTone {
  return status < 300 ? "success" : "destructive";
}

/**
 * The status glyph at the start of a delivery log row: delivered, failed,
 * pending (neutral), still in progress (warning) or skipped (not sent, nothing went wrong).
 */
export function DeliveryStatusIcon({
  state,
}: {
  state: "delivered" | "failed" | "pending" | "in-progress" | "skipped";
}) {
  // The tile takes the matching Badge colour at the Badge's low opacity.
  const tile =
    state === "delivered"
      ? "bg-success/15"
      : state === "failed"
        ? "bg-destructive/15"
        : state === "in-progress"
          ? "bg-warning/15"
          : "bg-muted";
  return (
    <span className={cn("flex h-8 w-8 items-center justify-center", tile)}>
      {state === "delivered" ? (
        <Check className="h-4 w-4 text-success-text" aria-label="Delivered" />
      ) : state === "failed" ? (
        <X className="h-4 w-4 text-destructive" aria-label="Failed" />
      ) : state === "pending" ? (
        <Clock className="h-4 w-4 text-muted-foreground" aria-label="Pending" />
      ) : state === "skipped" ? (
        <Minus className="h-4 w-4 text-muted-foreground" aria-label="Not sent" />
      ) : (
        <Clock className="h-4 w-4 text-warning-text" aria-label="In progress" />
      )}
    </span>
  );
}
