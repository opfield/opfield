import { z } from 'zod';

/**
 * wiolett-core/v1 — the versioned internal contract between Opfield and the
 * managed OpenCodex core. The same literal values and wire shapes are
 * implemented by the OpenCodex integration module; the frozen fixtures under
 * ./fixtures are the shared source of truth protected by hash-pinned tests in
 * both repositories.
 */
// Wire value shared with the separately released inference core (frozen fixtures in both repositories): kept on
// purpose; it changes only with a core release that accepts both.
export const OPFIELD_CORE_CONTRACT_ID = 'wiolett-core/v1';
export const INFERENCE_CORE_PROTOCOL_MAJOR = 1;
export const INFERENCE_CORE_STATE_SCHEMA_VERSION = 1;

export const INFERENCE_CORE_STATES = [
  'not_installed',
  'resolving',
  'pulling',
  'installing',
  'starting',
  'ready',
  'update_available',
  'updating',
  'rolling_back',
  'degraded',
  'failed',
] as const;
export type InferenceCoreState = (typeof INFERENCE_CORE_STATES)[number];

/**
 * Legal runtime-state transitions. Install/update/repair operations drive the
 * machine forward; health reconciliation may only move between steady states
 * (ready, update_available, degraded). Terminal failure stays retryable
 * through a new operation.
 */
export const INFERENCE_CORE_TRANSITIONS: Readonly<Record<InferenceCoreState, readonly InferenceCoreState[]>> = {
  not_installed: ['resolving'],
  resolving: ['pulling', 'failed'],
  pulling: ['installing', 'failed'],
  installing: ['starting', 'failed'],
  starting: ['ready', 'degraded', 'failed'],
  ready: ['update_available', 'updating', 'rolling_back', 'degraded', 'starting', 'failed'],
  update_available: ['updating', 'ready', 'degraded'],
  updating: ['ready', 'rolling_back', 'degraded', 'failed'],
  rolling_back: ['ready', 'degraded', 'failed'],
  degraded: ['starting', 'updating', 'ready', 'failed'],
  failed: ['resolving', 'updating', 'starting'],
};

export class InferenceCoreStateTransitionError extends Error {
  constructor(
    readonly from: InferenceCoreState,
    readonly to: InferenceCoreState
  ) {
    super(`Illegal inference core state transition: ${from} -> ${to}`);
    this.name = 'InferenceCoreStateTransitionError';
  }
}

export function canInferenceCoreTransition(from: InferenceCoreState, to: InferenceCoreState): boolean {
  return INFERENCE_CORE_TRANSITIONS[from].includes(to);
}

export function assertInferenceCoreTransition(from: InferenceCoreState, to: InferenceCoreState): void {
  if (!canInferenceCoreTransition(from, to)) throw new InferenceCoreStateTransitionError(from, to);
}

export const INFERENCE_CORE_OPERATION_KINDS = ['install', 'update', 'repair', 'rollback'] as const;
export type InferenceCoreOperationKind = (typeof INFERENCE_CORE_OPERATION_KINDS)[number];

export const INFERENCE_CORE_OPERATION_PHASES = [
  'resolving',
  'pulling',
  'installing',
  'starting',
  'updating',
  'rolling_back',
] as const;
export type InferenceCoreOperationPhase = (typeof INFERENCE_CORE_OPERATION_PHASES)[number];

export const INFERENCE_CORE_OPERATION_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type InferenceCoreOperationStatus = (typeof INFERENCE_CORE_OPERATION_STATUSES)[number];

const isoDateTime = z.string().datetime({ offset: true });

/** Truthful Docker progress: only report bytes/layers the daemon supplied. */
export const inferenceCoreOperationProgressSchema = z
  .object({
    stage: z.string().min(1),
    downloadedBytes: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().nonnegative().optional(),
    layersCompleted: z.number().int().nonnegative().optional(),
    layersTotal: z.number().int().nonnegative().optional(),
  })
  .strict();
export type InferenceCoreOperationProgress = z.infer<typeof inferenceCoreOperationProgressSchema>;

export const inferenceCoreOperationSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(INFERENCE_CORE_OPERATION_KINDS),
    phase: z.enum(INFERENCE_CORE_OPERATION_PHASES),
    status: z.enum(INFERENCE_CORE_OPERATION_STATUSES),
    progress: inferenceCoreOperationProgressSchema.nullable(),
    fromVersion: z.string().min(1).nullable(),
    toVersion: z.string().min(1).nullable(),
    fromDigest: z.string().min(1).nullable(),
    toDigest: z.string().min(1).nullable(),
    error: z.string().nullable(),
    startedAt: isoDateTime,
    updatedAt: isoDateTime,
    finishedAt: isoDateTime.nullable(),
  })
  .strict();
export type InferenceCoreOperation = z.infer<typeof inferenceCoreOperationSchema>;

/** Browser-facing lifecycle status DTO; the single source for all three UI entry points. */
export const inferenceCoreStatusSchema = z
  .object({
    state: z.enum(INFERENCE_CORE_STATES),
    installed: z
      .object({
        version: z.string().min(1),
        digest: z.string().min(1),
        imageRef: z.string().min(1),
      })
      .strict()
      .nullable(),
    latest: z
      .object({
        version: z.string().min(1),
        digest: z.string().min(1),
        sizeBytes: z.number().int().positive(),
        releaseNotesUrl: z.string().url().nullable(),
      })
      .strict()
      .nullable(),
    compatibility: z.enum(['compatible', 'update_required', 'unknown']),
    health: z
      .object({
        status: z.enum(['healthy', 'unhealthy', 'unknown']),
        version: z.string().min(1).nullable(),
        coreProtocolMajor: z.number().int().positive().nullable(),
        stateSchemaVersion: z.number().int().positive().nullable(),
        checkedAt: isoDateTime.nullable(),
        requestLimitsCapability: z.enum(['negotiated-v1', 'legacy', 'unknown']).optional(),
      })
      .strict(),
    operation: inferenceCoreOperationSchema.nullable(),
    lastError: z.string().nullable(),
  })
  .strict();
export type InferenceCoreStatus = z.infer<typeof inferenceCoreStatusSchema>;

/** Identity the core reports on its health/readiness endpoints in Opfield mode.
 *  These fields are embedded in a larger health payload; unknown keys are
 *  stripped, not rejected. */
export const inferenceCoreHealthIdentitySchema = z.object({
  service: z.literal('opencodex'),
  version: z.string().min(1),
  contractId: z.literal(OPFIELD_CORE_CONTRACT_ID),
  coreProtocolMajor: z.number().int().positive(),
  stateSchemaVersion: z.number().int().positive(),
  instanceId: z.string().min(1),
  startedAt: isoDateTime,
  requestLimitsVersion: z.literal(1).optional(),
  /** Core accepts the signed `maxOutputTokens` claim (strict cores reject unknown claims). */
  outputLimitVersion: z.literal(1).optional(),
});
export type InferenceCoreHealthIdentity = z.infer<typeof inferenceCoreHealthIdentitySchema>;

/** Internal header names for the signed request context injected by Opfield. */
export const INFERENCE_CORE_CONTEXT_HEADERS = {
  contract: 'x-opfield-contract',
  context: 'x-opfield-context',
  signature: 'x-opfield-signature',
} as const;

// legacy-name: legacy core contract headers — cores released before the Opfield names read and send only these;
// sent next to the new ones and accepted on callbacks until the minimum supported core reads x-opfield-*.
export const LEGACY_INFERENCE_CORE_CONTEXT_HEADERS = {
  contract: 'x-wiolett-contract',
  context: 'x-wiolett-context',
  signature: 'x-wiolett-signature',
} as const;

/** Opfield internal listener paths the core calls for admission and settlement. */
export const INFERENCE_CORE_CALLBACK_PATHS = {
  admission: '/api/internal/inference-core/admission',
  settlement: '/api/internal/inference-core/settlement',
} as const;

/** Core -> Opfield callback authentication headers (HMAC over `${timestamp}.${body}`). */
export const INFERENCE_CORE_CALLBACK_HEADERS = {
  contract: 'x-opfield-contract',
  timestamp: 'x-opfield-timestamp',
  signature: 'x-opfield-signature',
} as const;

// legacy-name: legacy callback headers — see LEGACY_INFERENCE_CORE_CONTEXT_HEADERS.
export const LEGACY_INFERENCE_CORE_CALLBACK_HEADERS = {
  contract: 'x-wiolett-contract',
  timestamp: 'x-wiolett-timestamp',
  signature: 'x-wiolett-signature',
} as const;

/**
 * Signed request-context claims. Opfield signs the base64url-encoded canonical
 * JSON of these claims with the internal data credential (HMAC-SHA256); the
 * core validates signature, expiry, nonce replay, and tenant consistency.
 */
export const inferenceCoreRequestContextSchema = z
  .object({
    contractId: z.literal(OPFIELD_CORE_CONTRACT_ID),
    tenantUserId: z.string().uuid(),
    rootRequestId: z.string().uuid(),
    parentAttemptId: z.string().min(1).nullable(),
    publicModelId: z.string().min(1),
    coreAccountId: z.string().min(1),
    coreModelId: z.string().min(1),
    operation: z.string().min(1),
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    nonce: z.string().min(16),
    requestLimits: z
      .object({
        httpBodyMaxBytes: z
          .number()
          .int()
          .min(1024 * 1024)
          .max(2048 * 1024 * 1024),
        webSocketMaxPayloadBytes: z
          .number()
          .int()
          .min(1024 * 1024)
          .max(512 * 1024 * 1024),
      })
      .strict()
      .optional(),
    /** Published model output ceiling; sent only to cores advertising `outputLimitVersion`. */
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .strict()
  .refine((claims) => claims.expiresAt > claims.issuedAt, { message: 'expiresAt must be after issuedAt' });
export type InferenceCoreRequestContext = z.infer<typeof inferenceCoreRequestContextSchema>;

export const INFERENCE_CORE_ATTEMPT_KINDS = ['root', 'retry', 'compaction', 'subagent'] as const;
export type InferenceCoreAttemptKind = (typeof INFERENCE_CORE_ATTEMPT_KINDS)[number];

export const inferenceCoreUsageSchema = z
  .object({
    uncachedInputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
  })
  .strict();
export type InferenceCoreUsage = z.infer<typeof inferenceCoreUsageSchema>;

/** Core -> Opfield admission callback, invoked before every upstream dispatch. */
export const inferenceCoreAdmissionRequestSchema = z
  .object({
    contractId: z.literal(OPFIELD_CORE_CONTRACT_ID),
    rootRequestId: z.string().uuid(),
    attemptId: z.string().min(1),
    parentAttemptId: z.string().min(1).nullable(),
    attemptKind: z.enum(INFERENCE_CORE_ATTEMPT_KINDS),
    coreAccountId: z.string().min(1),
    coreModelId: z.string().min(1),
    sourceType: z.enum(['subscription', 'api']),
    operation: z.string().min(1),
    estimate: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        maxOutputTokens: z.number().int().positive(),
      })
      .strict(),
    occurredAt: isoDateTime,
  })
  .strict();
export type InferenceCoreAdmissionRequest = z.infer<typeof inferenceCoreAdmissionRequestSchema>;

export const inferenceCoreAdmissionResponseSchema = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('allow'),
      maxOutputTokens: z.number().int().positive().nullable().optional(),
    })
    .strict(),
  z
    .object({
      decision: z.literal('deny'),
      reason: z.enum(['budget_exceeded', 'rate_limited', 'concurrency_limited', 'model_disabled', 'tenant_revoked']),
      retryAfterSeconds: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);
export type InferenceCoreAdmissionResponse = z.infer<typeof inferenceCoreAdmissionResponseSchema>;

/**
 * Core -> Opfield terminal settlement. Idempotent per attemptId: a repeated
 * delivery must carry an identical payload and is acknowledged without a
 * second ledger effect.
 */
export const inferenceCoreSettlementSchema = z
  .object({
    contractId: z.literal(OPFIELD_CORE_CONTRACT_ID),
    rootRequestId: z.string().uuid(),
    attemptId: z.string().min(1),
    parentAttemptId: z.string().min(1).nullable(),
    attemptKind: z.enum(INFERENCE_CORE_ATTEMPT_KINDS),
    terminalStatus: z.enum(['completed', 'failed', 'cancelled']),
    coreAccountId: z.string().min(1),
    coreModelId: z.string().min(1),
    sourceType: z.enum(['subscription', 'api']),
    upstreamStatus: z.number().int().nullable(),
    errorCode: z.string().min(1).nullable(),
    usage: inferenceCoreUsageSchema,
    usageEstimated: z.boolean(),
    emittedOutput: z.boolean(),
    startedAt: isoDateTime,
    completedAt: isoDateTime,
  })
  .strict();
export type InferenceCoreSettlement = z.infer<typeof inferenceCoreSettlementSchema>;

/** Internal callback error envelope, aligned with the Opfield { code, message } error contract. */
export const inferenceCoreInternalErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type InferenceCoreInternalError = z.infer<typeof inferenceCoreInternalErrorSchema>;
