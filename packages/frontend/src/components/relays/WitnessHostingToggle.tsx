import { useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { api } from "@/services/api";
import type { DashboardRelayInstance } from "@/types";

/** The command a protected relay's owner runs on the relay to allow witnesses there. */
export const PROTECTED_WITNESS_OPT_IN_COMMAND =
  "relay-supervisor protected on --allow-database-witness";

/** The admin flag: newer backends send it; older ones only the effective state. */
export function witnessHostingAllowed(instance: DashboardRelayInstance): boolean {
  if (typeof instance.witnessHostingAllowed === "boolean") return instance.witnessHostingAllowed;
  return instance.witnessHosting !== undefined && instance.witnessHosting !== "disabled";
}

function statusLine(instance: DashboardRelayInstance, allowed: boolean) {
  if (!allowed) return { text: "Off", tone: "text-muted-foreground" };
  switch (instance.witnessHosting) {
    case "allowed":
      return { text: "Allowed", tone: "text-success-text" };
    case "protected_needs_opt_in":
      return { text: "Protected relay: needs local opt-in", tone: "text-warning-text" };
    case "not_reported":
      return { text: "Waiting for the relay to report", tone: "text-muted-foreground" };
    default:
      return { text: "Not available on this relay", tone: "text-warning-text" };
  }
}

/**
 * "Allow witnesses on this relay" on a relay row: a witness votes on which server of a database
 * or storage set is primary (and may run a ClickHouse Keeper); it holds no data. A protected
 * relay also needs its owner's local opt-in.
 */
export function WitnessHostingToggle({
  instance,
  canEdit,
  onChanged,
}: {
  instance: DashboardRelayInstance;
  canEdit: boolean;
  onChanged: (instance: DashboardRelayInstance) => void;
}) {
  const [saving, setSaving] = useState(false);
  const allowed = witnessHostingAllowed(instance);
  const status = statusLine(instance, allowed);
  const processes = instance.witnesses ?? [];

  const toggle = async (next: boolean) => {
    setSaving(true);
    try {
      onChanged(await api.setRelayWitnessHosting(instance.id, next));
      toast.success(next ? "Witnesses allowed on this relay" : "Witnesses no longer allowed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to change witness hosting");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-xs space-y-1">
      <div className="flex items-center gap-2">
        <Switch
          checked={allowed}
          onChange={(next) => void toggle(next)}
          disabled={!canEdit || saving}
          ariaLabel={`Allow witnesses on ${instance.displayName}`}
        />
        <span className={`text-xs ${status.tone}`}>{status.text}</span>
      </div>
      {allowed && instance.witnessHosting === "protected_needs_opt_in" ? (
        <p className="text-xs text-muted-foreground">
          Run <code className="font-mono">{PROTECTED_WITNESS_OPT_IN_COMMAND}</code> on the relay,
          then restart its supervisor.
        </p>
      ) : null}
      {processes.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {processes.map((process) => (
            <li key={process.id} className="truncate" title={process.error ?? undefined}>
              {process.ownerName ?? process.setId.slice(0, 8)} ·{" "}
              {process.kind === "keeper" ? "Keeper" : "Voter"} {process.role} · {process.state}
              {process.version ? ` · ${process.version}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
