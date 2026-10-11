import { CheckCircle2, Clock, MinusCircle, XCircle } from "lucide-react";
import type { StatusTone } from "@/components/common/resource-status";
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
  return (
    <span className="flex h-8 w-8 items-center justify-center bg-muted">
      {state === "delivered" ? (
        <CheckCircle2 className="h-4 w-4 text-success-text" />
      ) : state === "failed" ? (
        <XCircle className="h-4 w-4 text-destructive" />
      ) : state === "pending" ? (
        <Clock className="h-4 w-4 text-muted-foreground" aria-label="Pending" />
      ) : state === "skipped" ? (
        <MinusCircle className="h-4 w-4 text-muted-foreground" aria-label="Not sent" />
      ) : (
        <Clock className="h-4 w-4 text-warning-text" />
      )}
    </span>
  );
}
