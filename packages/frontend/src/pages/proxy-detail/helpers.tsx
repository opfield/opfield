// ── Health badge mapping ────────────────────────────────────────
export const HEALTH_BADGE: Record<
  string,
  "success" | "destructive" | "secondary" | "default" | "warning"
> = {
  online: "success",
  recovering: "warning",
  offline: "destructive",
  degraded: "destructive",
  unknown: "secondary",
  disabled: "secondary",
};

export const HEALTH_LABEL: Record<string, string> = {
  online: "Healthy",
  recovering: "Recovering",
  offline: "Offline",
  degraded: "Degraded",
  unknown: "Unknown",
  // Health checks are off, or raw config mode skips them: the route's health is not known.
  disabled: "Unknown",
};

/** Compute effective status: if currently online but had errors/slow in last 5 min, show "recovering" */
export function effectiveHealthStatus(host: {
  healthStatus: string;
  rawConfigEnabled?: boolean;
  healthHistory?: Array<{ ts: string; status: string; slow?: boolean }>;
}): string {
  if (host.rawConfigEnabled) return "disabled";
  if (host.healthStatus !== "online" || !host.healthHistory?.length) return host.healthStatus;
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const recent = host.healthHistory.filter((h) => new Date(h.ts).getTime() >= fiveMinAgo);
  if (recent.some((h) => h.status === "offline" || h.slow)) return "recovering";
  return "online";
}

/** Route type colours, shared by the route list and the route page. */
export const TYPE_BADGE: Record<string, "secondary" | "warning" | "destructive"> = {
  proxy: "secondary",
  redirect: "warning",
  "404": "destructive",
  raw: "destructive",
};

// ── ToggleRow helper component ──────────────────────────────────
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <div className={cn(disabled && "opacity-50")}>
        <span className="text-sm font-medium">{label}</span>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}
