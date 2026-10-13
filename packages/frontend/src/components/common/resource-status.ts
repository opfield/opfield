/**
 * One status colour scheme for resources wherever they appear: dashboard cards,
 * pinned sidebar items and lists. A tone is also a `Badge` variant.
 */
export type StatusTone = "success" | "warning" | "destructive" | "secondary";

/** Proxy host health, as the route list shows it. */
export function proxyHealthTone(status: string | null | undefined): StatusTone {
  if (status === "online") return "success";
  if (status === "recovering") return "warning";
  if (status === "offline" || status === "degraded") return "destructive";
  return "secondary";
}

/** Node status, usually from `effectiveNodeStatus`. */
export function nodeStatusTone(status: string | null | undefined): StatusTone {
  if (status === "online") return "success";
  if (status === "degraded") return "warning";
  if (status === "offline" || status === "error") return "destructive";
  return "secondary";
}

/** App health (healthy / degraded / failing / unknown). */
export function appHealthTone(status: string | null | undefined): StatusTone {
  if (status === "healthy") return "success";
  if (status === "degraded") return "warning";
  if (status === "failing") return "destructive";
  return "secondary";
}

export function databaseHealthTone(status: string | null | undefined): StatusTone {
  if (status === "online") return "success";
  if (status === "degraded") return "warning";
  if (status === "offline") return "destructive";
  return "secondary";
}

/** Docker container, deployment, Compose and build states that are still changing. */
const DOCKER_TRANSITIONAL_STATES = new Set([
  "stopping",
  "restarting",
  "recreating",
  "killing",
  "updating",
  "migrating",
  "queued",
  "claimed",
  "checking_out",
  "building",
  "scanning",
  "pushing",
  "deploying",
  "applying",
  "validating",
]);

export function isDockerStateTransitional(state: string | null | undefined): boolean {
  return DOCKER_TRANSITIONAL_STATES.has(state?.toLowerCase() ?? "");
}

export function dockerStateTone(state: string | null | undefined): StatusTone {
  const status = state?.toLowerCase();
  if (status === "running" || status === "healthy" || status === "succeeded") return "success";
  if (status === "failed" || status === "dead" || status === "exited") return "destructive";
  if (status === "degraded" || isDockerStateTransitional(status)) return "warning";
  return "secondary";
}

/** Background class of a small status dot in the tone's colour. */
export function statusDotClass(tone: StatusTone): string {
  if (tone === "success") return "bg-success";
  if (tone === "warning") return "bg-warning";
  if (tone === "destructive") return "bg-destructive";
  return "bg-muted-foreground/40";
}
