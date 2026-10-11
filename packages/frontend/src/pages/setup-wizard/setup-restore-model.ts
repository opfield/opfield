import { isNetworkDraftValid, isPublicUrlValid, type NetworkDraft } from "./setup-wizard-model";

/** The largest chunk the setup API takes in one request. */
export const RESTORE_CHUNK_BYTES = 32 * 1024 * 1024;
export const RESTORE_FILE_EXTENSION = ".opfield-export";

export type SetupRestoreState =
  | "empty"
  | "uploaded"
  | "verifying"
  | "verified"
  | "invalid"
  | "restoring";

export interface RestoreExportSummary {
  createdAt: string;
  gatewayVersion: string;
  installationId: string;
  sourcePublicUrl: string | null;
  sourceGrpcPublicTarget: string | null;
  sourceGrpcLocalIp: string | null;
  includes: { registry: boolean; logs: boolean };
  commercial: boolean;
  parts: Array<{ name: string; bytes: number }>;
}

export interface RestoreRunStatus {
  state: "verifying" | "restoring" | "starting" | "completed" | "failed" | "rolled_back";
  step: string;
  updatedAt: string;
  error?: string;
}

export interface SetupRestoreView {
  state: SetupRestoreState;
  uploadedBytes: number;
  verifiedBytes: number;
  summary: RestoreExportSummary | null;
  error: { code: string; message: string } | null;
  restore: RestoreRunStatus | null;
  currentVersion: string;
}

/** Identifies a chosen file across page loads, to tell whether a partial upload is its own. */
export function uploadFingerprint(file: { name: string; size: number; lastModified: number }) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/**
 * Where an upload of the chosen file starts: where the server stopped when the bytes it holds are
 * from the same file, otherwise from the beginning (offset 0 replaces what the server holds).
 */
export function uploadStartOffset(input: {
  fileSize: number;
  serverBytes: number;
  sameFile: boolean;
}): number {
  const { fileSize, serverBytes, sameFile } = input;
  if (!sameFile || serverBytes <= 0 || serverBytes > fileSize) return 0;
  return serverBytes;
}

/** The byte range of the next chunk, or null when the file is uploaded. */
export function nextChunkRange(
  offset: number,
  fileSize: number,
  chunkBytes = RESTORE_CHUNK_BYTES
): { start: number; end: number } | null {
  if (offset >= fileSize) return null;
  return { start: offset, end: Math.min(fileSize, offset + chunkBytes) };
}

/**
 * Where to retry after a chunk failed. Before the server confirmed any byte of this file in this
 * run, what it holds may belong to another file: start over. After that, continue at what it
 * holds (a failed chunk may have landed in part), or at the failed chunk when it cannot be read.
 */
export function resumeOffsetAfterFailure(input: {
  confirmed: number;
  serverBytes: number | null;
  fileSize: number;
  chunkStart: number;
}): number {
  const { confirmed, serverBytes, fileSize, chunkStart } = input;
  if (confirmed < 0) return 0;
  if (serverBytes === null || serverBytes < confirmed || serverBytes > fileSize) return chunkStart;
  return serverBytes;
}

export function percentOf(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
}

function comparableUrl(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value.trim());
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase();
  }
}

function comparableTarget(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Which of the restored addresses differ from the ones the export was made with. */
export function restoreAddressChanges(
  summary: Pick<RestoreExportSummary, "sourcePublicUrl" | "sourceGrpcPublicTarget">,
  publicUrl: string,
  network: NetworkDraft
): { publicUrl: boolean; grpcPublicTarget: boolean } {
  return {
    publicUrl:
      Boolean(summary.sourcePublicUrl) &&
      comparableUrl(summary.sourcePublicUrl) !== comparableUrl(publicUrl),
    grpcPublicTarget:
      Boolean(summary.sourceGrpcPublicTarget) &&
      comparableTarget(summary.sourceGrpcPublicTarget) !==
        comparableTarget(network.grpcPublicTarget),
  };
}

/** The host of `host`, `host:port`, `[v6]:port` or a bare IPv6 address. */
export function hostOfTarget(target: string): string {
  const value = target.trim();
  const bracketed = value.match(/^\[([^\]]+)](?::\d+)?$/);
  if (bracketed) return bracketed[1]!;
  const withPort = value.match(/^([^:]+):\d+$/);
  return withPort ? withPort[1]! : value;
}

/**
 * The addresses the restore form starts with: the export's own public URL and gRPC target, and
 * its local IP only when this host has it too (a local IP rarely moves with the installation).
 */
export function initialRestoreAddress(
  summary: Pick<
    RestoreExportSummary,
    "sourcePublicUrl" | "sourceGrpcPublicTarget" | "sourceGrpcLocalIp"
  >,
  localIps: string[]
): { publicUrl: string; network: NetworkDraft } {
  const sourceLocalHost = hostOfTarget(summary.sourceGrpcLocalIp ?? "");
  return {
    publicUrl: summary.sourcePublicUrl ?? "",
    network: {
      grpcPublicTarget: summary.sourceGrpcPublicTarget ?? "",
      grpcLocalIp:
        summary.sourceGrpcLocalIp && localIps.includes(sourceLocalHost)
          ? summary.sourceGrpcLocalIp
          : (localIps[0] ?? ""),
    },
  };
}

export function isRestoreAddressValid(publicUrl: string, network: NetworkDraft): boolean {
  return isPublicUrlValid(publicUrl) && isNetworkDraftValid(network);
}

export type RestoreWaitOutcome =
  | { kind: "waiting" }
  | { kind: "done" }
  | { kind: "failed"; message: string };

/**
 * What a poll during the restore means. The app stops while the restore runs, so failed polls are
 * waiting too. Setup completes once the restored installation answers (it has an administrator);
 * a restore that failed brings this installation back still pending with the error in its view.
 */
export function restoreWaitOutcome(
  setupState: "pending" | "complete" | null,
  view: Pick<SetupRestoreView, "restore"> | null
): RestoreWaitOutcome {
  if (setupState === "complete") return { kind: "done" };
  const restore = view?.restore;
  if (restore && (restore.state === "failed" || restore.state === "rolled_back")) {
    return {
      kind: "failed",
      message:
        restore.error ??
        (restore.state === "rolled_back"
          ? "The restore failed and this installation was put back as it was."
          : "The restore failed."),
    };
  }
  return { kind: "waiting" };
}

/** The address to sign in at after the restore. */
export function restoredLoginUrl(publicUrl: string): string {
  return `${publicUrl.trim().replace(/\/+$/, "")}/login`;
}
