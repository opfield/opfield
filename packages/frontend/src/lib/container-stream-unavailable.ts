/**
 * A container stream (Logs, Console) or Files request that reached no container: it is being recreated (an update,
 * recreate or redeploy replaced its runtime) or does not run yet. This is not an access failure: the client shows it,
 * has the page look the container up again, and reconnects.
 */
export const CONTAINER_UNAVAILABLE_CODE = "container_unavailable";
export const CONTAINER_RECREATING_MESSAGE = "Container is being recreated…";
export const CONTAINER_NOT_RUNNING_MESSAGE = "Container is not running yet…";
/** Reconnect delay while the container is being recreated. */
export const CONTAINER_RECREATING_RETRY_MS = 3000;

/** The message to show for a stream error frame of an unavailable container; null for any other frame. */
export function containerUnavailableMessage(frame: unknown): string | null {
  const value = frame as { type?: unknown; code?: unknown; reason?: unknown } | null;
  if (value?.type !== "error" || value.code !== CONTAINER_UNAVAILABLE_CODE) return null;
  return value.reason === "not_running"
    ? CONTAINER_NOT_RUNNING_MESSAGE
    : CONTAINER_RECREATING_MESSAGE;
}

/** True when a frame says the container is being recreated (as opposed to not running yet). */
export function isContainerRecreatingFrame(frame: unknown): boolean {
  return containerUnavailableMessage(frame) === CONTAINER_RECREATING_MESSAGE;
}
