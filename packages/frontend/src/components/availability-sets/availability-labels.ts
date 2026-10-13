import { formatBytes } from "@/lib/utils";
import type {
  AvailabilityDurability,
  AvailabilityMember,
  AvailabilityOwner,
  AvailabilitySetState,
  AvailabilityView,
} from "@/types";

/** The license feature of database and storage availability (one gate, as Docker Availability). */
export const AVAILABILITY_FEATURE = "multi-node-availability" as const;
export const AVAILABILITY_CAPABILITY = "Availability";

/** A member pair at or below this p50 round trip is "near" (synchronous by default). */
export const NEAR_RTT_MS = 10;
/** Relay policy lease the preflight recommends (7 days): failover keeps working without Opfield this long. */
export const RECOMMENDED_POLICY_LEASE_HOURS = 168;

export type BadgeVariant = "success" | "warning" | "destructive" | "secondary" | "info";

export const SET_STATE_LABELS: Record<AvailabilitySetState, string> = {
  converting: "Setting up",
  healthy: "Healthy",
  degraded: "Degraded",
  no_failover: "No failover",
  failing_over: "Failing over",
  closing: "Turning off",
  error: "Error",
  paused: "Paused",
};

export function setStateVariant(state: AvailabilitySetState): BadgeVariant {
  if (state === "healthy") return "success";
  if (state === "error") return "destructive";
  if (state === "converting" || state === "closing") return "info";
  if (state === "paused") return "secondary";
  return "warning";
}

export const ROLE_LABELS: Record<AvailabilityMember["role"], string> = {
  primary: "Primary",
  copy: "Copy",
  rebuilding: "Rebuilding",
  fenced: "Stopped",
  unknown: "Unknown",
};

export function roleVariant(role: AvailabilityMember["role"]): BadgeVariant {
  if (role === "primary") return "info";
  if (role === "copy") return "secondary";
  if (role === "rebuilding") return "warning";
  return "destructive";
}

export const DURABILITY_LABELS: Record<AvailabilityDurability, string> = {
  synchronous: "Synchronous",
  asynchronous: "Asynchronous",
};

/** Human words for the reason a copy cannot take over (daemon/core reason codes). */
const ELIGIBILITY_REASONS: Record<string, string> = {
  lagging: "Too far behind",
  lag: "Too far behind",
  not_streaming: "Not receiving changes",
  not_linked: "Not receiving changes",
  degraded: "Not confirming writes",
  sync_degraded: "Not confirming writes",
  not_reporting: "Not reporting",
  stale_report: "Not reporting",
  starting: "Starting",
  seeding: "Copying data",
  rebuilding: "Copying data",
  rejoining: "Rejoining",
  removing: "Being removed",
  fenced: "Stopped",
  offline: "Server offline",
  acl_not_mirrored: "Copying users",
  keeper_quorum: "No Keeper quorum",
  readonly: "Read-only tables",
};

/** The role badge: a member that lost the primary role in a failover and has not reported since says so. */
export function memberRoleLabel(member: AvailabilityMember): string {
  if (member.desiredState === "removing") return "Removing";
  if (member.previousPrimary)
    return member.reporting ? "Previous primary" : "Previous primary, unreachable";
  return ROLE_LABELS[member.role];
}

export function eligibilityText(member: AvailabilityMember): string {
  if (!member.reporting) return "Not reporting";
  if (member.role === "primary") return "Serving";
  if (member.eligible) return "Can take over";
  const reason = member.eligibilityReason ?? "";
  return ELIGIBILITY_REASONS[reason] ?? (reason ? labelize(reason) : "Cannot take over yet");
}

export function memberHealthVariant(member: AvailabilityMember): BadgeVariant {
  if (member.status === "error" || member.lastError) return "destructive";
  if (!member.reporting) return "warning";
  if (member.role === "primary" || member.eligible) return "success";
  return "warning";
}

export function labelize(value: string): string {
  return value.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

export function formatLag(member: Pick<AvailabilityMember, "lagBytes" | "lagSeconds" | "role">) {
  if (member.role === "primary") return "—";
  if (member.lagBytes === null && member.lagSeconds === null) return "Unknown";
  const parts: string[] = [];
  if (member.lagBytes !== null)
    parts.push(member.lagBytes === 0 ? "0 B" : formatBytes(member.lagBytes));
  if (member.lagSeconds !== null) parts.push(`${formatSeconds(member.lagSeconds)}`);
  return parts.join(" · ");
}

export function formatSeconds(seconds: number): string {
  if (seconds < 1) return seconds <= 0 ? "0 s" : "< 1 s";
  if (seconds < 120) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

export function formatRtt(ms: number | null): string {
  if (ms === null) return "Not measured";
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

export function syncStateLabel(member: AvailabilityMember): string {
  if (member.role === "primary") return "—";
  if (member.syncState === "sync") return "Synchronous";
  if (member.syncState === "async") return "Asynchronous";
  return "None";
}

export function memberName(member: Pick<AvailabilityMember, "nodeName" | "nodeId">): string {
  return member.nodeName || member.nodeId.slice(0, 8);
}

export function activeMembers(view: AvailabilityView): AvailabilityMember[] {
  return view.members.filter((member) => member.desiredState === "member");
}

export function primaryOf(view: AvailabilityView): AvailabilityMember | null {
  return (
    view.members.find((member) => member.id === view.primaryMemberId) ??
    view.members.find((member) => member.role === "primary") ??
    null
  );
}

/** Copy of the panel's one-line description: engine on N servers with the failover mode. */
export function setSummary(view: AvailabilityView): string {
  const count = activeMembers(view).length;
  return `${count} servers · ${view.mode === "automatic" ? "automatic failover" : "manual failover"}`;
}

/** "Can lose" line: what the set survives now. */
export function canLoseText(view: AvailabilityView): string {
  if (view.mode === "manual") return "No automatic failover";
  if (view.canLose === null) return "Unknown";
  if (view.canLose <= 0) return "No server";
  return view.canLose === 1 ? "1 server" : `${view.canLose} servers`;
}

const OPERATION_LABELS: Record<string, string> = {
  convert: "Adding servers",
  create: "Setting up servers",
  add_member: "Adding a server",
  remove_member: "Removing a server",
  rebuild: "Rebuilding a copy",
  rebuild_member: "Rebuilding a copy",
  make_primary: "Switching the primary",
  switchover: "Switching the primary",
  forced_promotion: "Promoting a copy",
  failback: "Switching back",
  update_settings: "Applying settings",
  disable: "Turning off availability",
  rolling_update: "Updating servers one at a time",
  rolling_restart: "Restarting servers one at a time",
  pause: "Pausing servers",
  unpause: "Starting servers",
};

export function operationLabel(kind: string): string {
  return OPERATION_LABELS[kind] ?? labelize(kind);
}

const EVENT_LABELS: Record<string, string> = {
  failover: "Failover",
  switchover: "Primary switched",
  switchover_requested: "Primary switch requested",
  switchover_failed: "Primary switch failed",
  rejoined: "Copy rejoined",
  rejoin_failed: "Copy could not rejoin",
  rebuilt: "Copy rebuilt",
  degraded: "Degraded",
  restored: "Restored",
  no_failover: "No failover possible",
  member_offline: "Server offline",
  forced_promotion: "Copy promoted with data loss",
  cancelled_sync_wait: "Cancelled commit wait",
  enabled: "Availability turned on",
  disabled: "Availability turned off",
  member_added: "Server added",
  member_removed: "Server removed",
  settings_updated: "Settings changed",
  make_primary: "Make primary",
  operation_failed: "Operation failed",
  health_alert: "Health alert",
  health_release: "Primary released (health)",
  member_restarted: "Server restarted",
  fenced: "Primary stopped (fenced)",
  stepped_down: "Primary stepped down",
  witness_moved: "Witness moved",
  witness_lost: "Witness lost",
  sync_far: "Synchronous copy now far",
  rolling_update: "Updated server by server",
  rolling_restart: "Restarted server by server",
  paused: "Paused",
  resumed: "Started again",
};

export function eventLabel(action: string): string {
  const name = action.startsWith("availability.") ? action.slice("availability.".length) : action;
  return EVENT_LABELS[name] ?? labelize(name);
}

export function eventTone(action: string): BadgeVariant {
  const name = action.replace(/^availability\./, "");
  if (
    [
      "failover",
      "forced_promotion",
      "operation_failed",
      "switchover_failed",
      "rejoin_failed",
    ].includes(name)
  )
    return "destructive";
  if (
    [
      "degraded",
      "no_failover",
      "member_offline",
      "health_alert",
      "fenced",
      "cancelled_sync_wait",
      "witness_lost",
      "sync_far",
    ].includes(name)
  )
    return "warning";
  if (["restored", "rejoined", "rebuilt", "enabled"].includes(name)) return "success";
  return "secondary";
}

export function ownerNoun(owner: AvailabilityOwner): string {
  return owner.kind === "database" ? "database" : "storage";
}
