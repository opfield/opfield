function isTerminalLogError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("no such container") ||
    lower.includes("not found") ||
    lower.includes("access denied") ||
    /\b(forbidden|unauthori[sz]ed)\b/.test(lower)
  );
}

/**
 * How the Logs tab treats an error frame from the log stream. A stream error is never toasted:
 * it describes the stream's state (node not connected, no containers yet), which the tab shows
 * inline. "terminal" stops reconnecting; "retry" reconnects with a growing delay until the
 * stream delivers logs again.
 */
export function classifyLogStreamError(
  message: string,
  type: "error" | "auth_error" = "error"
): "terminal" | "retry" {
  return type === "auth_error" || isTerminalLogError(message) ? "terminal" : "retry";
}

const LOG_RECONNECT_BASE_MS = 3000;
const LOG_RECONNECT_MAX_MS = 30000;

/** Delay before reconnect attempt `attempt` (0-based): 3 s, doubling up to 30 s. */
export function logReconnectDelay(attempt: number): number {
  return Math.min(LOG_RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), LOG_RECONNECT_MAX_MS);
}
