import type {
  ConfigurationExportEstimate,
  ConfigurationExportProgress,
  GatewayMoveNodeStateName,
} from "@/services/api-configuration-transfer";

export const EXPORT_PASSPHRASE_MIN_LENGTH = 12;
export const DEFAULT_GRPC_PORT = 9443;

/** Why the passphrase pair cannot be used yet, or null when it can. */
export function exportPassphraseProblem(passphrase: string, confirmation: string): string | null {
  if (passphrase.length < EXPORT_PASSPHRASE_MIN_LENGTH) {
    return `Use at least ${EXPORT_PASSPHRASE_MIN_LENGTH} characters`;
  }
  if (passphrase !== confirmation) return "The passphrases do not match";
  return null;
}

/** Bytes the export is expected to write with the chosen options; null when nothing is known. */
export function estimatedExportBytes(
  estimate: ConfigurationExportEstimate,
  options: { includeRegistry: boolean; includeLogs: boolean }
): number | null {
  const { database, files, registry, logs } = estimate.sections;
  const parts = [
    database.bytes,
    files.bytes,
    options.includeRegistry ? registry.bytes : 0,
    options.includeLogs ? logs.bytes : 0,
  ];
  if (parts.every((bytes) => bytes === null)) return null;
  return parts.reduce<number>((sum, bytes) => sum + (bytes ?? 0), 0);
}

/**
 * Percent for the progress bar. The estimate comes from volume sizes before compression and
 * encryption, so a running export never shows 100 until it completes.
 */
export function exportProgressPercent(progress: ConfigurationExportProgress): number {
  if (progress.state === "completed") return 100;
  if (!progress.estimatedBytes || progress.estimatedBytes <= 0) return 0;
  return Math.min(99, Math.floor((progress.bytesWritten / progress.estimatedBytes) * 100));
}

function isValidPort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

function isHostname(value: string): boolean {
  if (!value || value.length > 253 || value.endsWith(".")) return false;
  return value
    .split(".")
    .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

function isIpv6(value: string): boolean {
  if (!value.includes(":")) return false;
  try {
    const url = new URL(`http://[${value}]/`);
    return url.hostname.startsWith("[") && url.hostname.endsWith("]");
  } catch {
    return false;
  }
}

/**
 * The gRPC address nodes move to as `host:port`, with the default port when none is given;
 * null when it is not a hostname or IP address with an optional port.
 */
export function normalizeMoveAddress(input: string): string | null {
  const value = input.trim();
  if (!value || /[/?#@\s]/.test(value) || value.includes("://")) return null;
  const bracketed = value.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (bracketed) {
    const [, host, port] = bracketed;
    if (!isIpv6(host!) || (port !== undefined && !isValidPort(port))) return null;
    return `[${host}]:${port ?? DEFAULT_GRPC_PORT}`;
  }
  if (isIpv6(value)) return `[${value}]:${DEFAULT_GRPC_PORT}`;
  const withPort = value.match(/^([^:]+):(\d+)$/);
  if (withPort) {
    const [, host, port] = withPort;
    return isHostname(host!) && isValidPort(port!) ? `${host}:${port}` : null;
  }
  return isHostname(value) ? `${value}:${DEFAULT_GRPC_PORT}` : null;
}

export const MOVE_NODE_STATE_LABELS: Record<
  GatewayMoveNodeStateName,
  { label: string; variant: "success" | "secondary" | "warning" | "destructive" }
> = {
  ready: { label: "Ready", variant: "secondary" },
  told: { label: "Told", variant: "success" },
  pending: { label: "Pending", variant: "secondary" },
  offline: { label: "Offline", variant: "warning" },
  unsupported: { label: "Update needed", variant: "warning" },
  failed: { label: "Failed", variant: "destructive" },
};
