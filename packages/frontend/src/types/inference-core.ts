/**
 * Browser-facing lifecycle contract for the managed inference core. Mirrors
 * the backend core contract DTOs in
 * packages/backend/src/modules/inference/core/inference-core.contract.ts.
 */
export const INFERENCE_CORE_STATES = [
  "not_installed",
  "resolving",
  "pulling",
  "installing",
  "starting",
  "ready",
  "update_available",
  "updating",
  "rolling_back",
  "degraded",
  "failed",
] as const;
export type InferenceCoreState = (typeof INFERENCE_CORE_STATES)[number];

export type InferenceCoreOperationKind = "install" | "update" | "repair" | "rollback";
export type InferenceCoreOperationPhase =
  | "resolving"
  | "pulling"
  | "installing"
  | "starting"
  | "updating"
  | "rolling_back";
export type InferenceCoreOperationStatus = "running" | "succeeded" | "failed";

/** Truthful Docker progress: bytes/layers are present only when the daemon supplied them. */
export interface InferenceCoreOperationProgress {
  stage: string;
  downloadedBytes?: number;
  totalBytes?: number;
  layersCompleted?: number;
  layersTotal?: number;
}

export interface InferenceCoreOperation {
  id: string;
  kind: InferenceCoreOperationKind;
  phase: InferenceCoreOperationPhase;
  status: InferenceCoreOperationStatus;
  progress: InferenceCoreOperationProgress | null;
  fromVersion: string | null;
  toVersion: string | null;
  fromDigest: string | null;
  toDigest: string | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type InferenceCoreCompatibility = "compatible" | "update_required" | "unknown";
export type InferenceCoreRequestLimitsCapability = "negotiated-v1" | "legacy" | "unknown";

export interface InferenceCoreHealth {
  status: "healthy" | "unhealthy" | "unknown";
  version: string | null;
  coreProtocolMajor: number | null;
  stateSchemaVersion: number | null;
  checkedAt: string | null;
  requestLimitsCapability?: InferenceCoreRequestLimitsCapability;
}

export interface InferenceCoreInstalled {
  version: string;
  digest: string;
  imageRef: string;
}

export interface InferenceCoreLatest {
  version: string;
  digest: string;
  sizeBytes: number;
  releaseNotesUrl: string | null;
}

/** Single source for all three lifecycle UI entry points. */
export interface InferenceCoreStatus {
  state: InferenceCoreState;
  installed: InferenceCoreInstalled | null;
  latest: InferenceCoreLatest | null;
  compatibility: InferenceCoreCompatibility;
  health: InferenceCoreHealth;
  operation: InferenceCoreOperation | null;
  lastError: string | null;
}
