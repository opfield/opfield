import type { DashboardRelayInstance } from "@/types";

/** Step states of a relay whose part of a Relay Pool update is over, one way or another. */
const FINISHED_RELAY_UPDATE_STEP_STATES = new Set([
  "pending",
  "ready",
  "completed",
  "failed",
  "rolled_back",
  "skipped",
]);

/**
 * The update step a relay is in while a Relay Pool rollout works on it (draining, updating, verifying, rolling_back),
 * or null. A relay in such a step goes offline for a few seconds while it restarts: that is the update, not an
 * outage, so the step wins over offline or error. Once the rollout is over, or the relay's own step finished or
 * failed, the relay shows its real state again, so a step left behind never hides an offline relay.
 */
export function activeRelayUpdateStep(
  instance: Pick<DashboardRelayInstance, "updateStep">,
  rolloutActive: boolean
): string | null {
  if (!rolloutActive) return null;
  const step = instance.updateStep?.state;
  return step && !FINISHED_RELAY_UPDATE_STEP_STATES.has(step) ? step : null;
}

export type RelayStatusBadge = {
  label: string;
  variant: "success" | "warning" | "destructive";
  /** Ready and trusted, but most nodes cannot reach its relay port. */
  unreachable: boolean;
  /** The relay's own last error is worth showing (not while its update step explains the state). */
  showLastError: boolean;
};

/** The status badge of a relay in the Relay Pool list, and whether its last error goes under it. */
export function relayStatusBadge(
  instance: Pick<
    DashboardRelayInstance,
    | "kind"
    | "state"
    | "policyExpiresAt"
    | "dataPlaneFailing"
    | "reconnecting"
    | "updateStep"
    | "policyTrust"
    | "health"
  >,
  rolloutActive: boolean,
  now = Date.now()
): RelayStatusBadge {
  const policyExpired = Boolean(
    instance.kind === "remote" &&
      instance.policyExpiresAt &&
      Date.parse(instance.policyExpiresAt) <= now
  );
  const unreachable =
    instance.state === "ready" && !policyExpired && instance.dataPlaneFailing === true;
  const step = activeRelayUpdateStep(instance, rolloutActive);
  if (step) {
    // A relay in a rollout drains, restarts and rejoins: the step, not each passing state or the
    // connection error of its restart.
    return { label: `updating · ${step}`, variant: "warning", unreachable, showLastError: false };
  }
  const variant =
    instance.state === "ready" && !policyExpired && !unreachable
      ? "success"
      : instance.state === "draining" || instance.state === "synchronizing" || instance.reconnecting
        ? "warning"
        : "destructive";
  const label =
    instance.state === "offline"
      ? "offline"
      : policyExpired
        ? "policy expired"
        : instance.reconnecting
          ? "reconnecting"
          : unreachable
            ? "unreachable"
            : instance.state;
  return {
    label,
    variant,
    unreachable,
    showLastError:
      !instance.policyTrust && instance.state !== "ready" && Boolean(instance.health?.lastError),
  };
}
