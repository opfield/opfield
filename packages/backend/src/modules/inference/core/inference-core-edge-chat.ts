import { randomUUID } from 'node:crypto';
import { and, eq, notLike } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { inferenceRequestAttempts } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { InferenceCoreAccountingService } from '../accounting/inference-core-accounting.service.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { InferenceProviderRegistry } from '../providers/inference-provider.registry.js';
import { type InferenceCoreAdmissionResponse, OPFIELD_CORE_CONTRACT_ID } from './inference-core.contract.js';
import { compareOpenCodexVersions, parseOpenCodexVersion } from './inference-core.manifest.js';
import { coreAdapterForWireProtocol } from './inference-core-provider-map.js';
import type { ChatRelayObservation } from './inference-core-response-relay.js';

const logger = createChildLogger('InferenceCoreEdgeChat');
const registry = new InferenceProviderRegistry();
/** Attempt ids Opfield issues itself; the core's own ids start with `att_`. */
const EDGE_ATTEMPT_PREFIX = 'opfield-edge-';

/** First core release whose native Chat lane admits and settles its own attempts. */
export const CORE_NATIVE_CHAT_ADMISSION_VERSION = '2.60.0-opfield.5';

/** Whether the running core (by its reported version) admits native Chat attempts itself. */
export function coreAdmitsNativeChat(version: string | null | undefined): boolean {
  if (!version || !parseOpenCodexVersion(version)) return false;
  return compareOpenCodexVersions(version, CORE_NATIVE_CHAT_ADMISSION_VERSION) >= 0;
}

/**
 * Cores before opfield.5 relay Chat Completions to an `openai-chat` provider
 * (API key or local) on their native path, which never calls admission or
 * settlement: the request would run unmetered. For those routes Opfield admits
 * and settles the attempt itself, from the usage the relayed answer reports.
 */
export function coreSkipsChatAdmission(connection: { providerId: string; authType: string }): boolean {
  if (connection.authType === 'oauth') return false;
  const definition = registry.get(connection.providerId);
  return definition !== undefined && coreAdapterForWireProtocol(definition.wireProtocol) === 'openai-chat';
}

/**
 * Whether Opfield must admit this Chat request itself. A core that admits on
 * its native lane already holds the one reservation; a second one from the
 * edge would refuse a user close to the limit with a false budget_exhausted.
 */
export function edgeChatAdmissionRequired(
  connection: { providerId: string; authType: string },
  target: { nativeChatAdmission: boolean }
): boolean {
  return !target.nativeChatAdmission && coreSkipsChatAdmission(connection);
}

export interface EdgeChatAttempt {
  rootRequestId: string;
  attemptId: string;
  coreAccountId: string;
  coreModelId: string;
  sourceType: 'subscription' | 'api';
  estimate: { inputTokens: number; maxOutputTokens: number };
  startedAt: Date;
}

/** Admit the attempt like the core's admission callback would; a refusal answers the client the same way. */
export async function admitEdgeChatAttempt(
  accounting: InferenceCoreAccountingService,
  input: Omit<EdgeChatAttempt, 'attemptId' | 'startedAt'>
): Promise<EdgeChatAttempt> {
  const attempt: EdgeChatAttempt = {
    ...input,
    attemptId: `${EDGE_ATTEMPT_PREFIX}${randomUUID()}`,
    startedAt: new Date(),
  };
  const decision = await accounting.admitCoreAttempt({
    contractId: OPFIELD_CORE_CONTRACT_ID,
    rootRequestId: attempt.rootRequestId,
    attemptId: attempt.attemptId,
    parentAttemptId: null,
    attemptKind: 'root',
    coreAccountId: attempt.coreAccountId,
    coreModelId: attempt.coreModelId,
    sourceType: attempt.sourceType,
    operation: 'chat_completions',
    estimate: attempt.estimate,
    occurredAt: attempt.startedAt.toISOString(),
  });
  if (decision.decision === 'deny') throw admissionDenied(decision);
  return attempt;
}

export function dropEdgeChatAttempt(
  accounting: InferenceCoreAccountingService,
  attempt: EdgeChatAttempt
): Promise<void> {
  return accounting.dropUnsettledAttempt(attempt.rootRequestId, attempt.attemptId);
}

/**
 * Settle the edge attempt with the usage the answer reported. When the core
 * admitted the work itself (its translated path), its own settlement counts
 * and the edge attempt is dropped. Never throws: finalization must go on.
 */
export async function settleEdgeChatAttempt(
  db: DrizzleClient,
  accounting: InferenceCoreAccountingService,
  attempt: EdgeChatAttempt,
  outcome: 'completed' | 'failed' | 'cancelled',
  observed: ChatRelayObservation
): Promise<void> {
  try {
    const coreAttempt = await db.query.inferenceRequestAttempts.findFirst({
      columns: { id: true },
      where: and(
        eq(inferenceRequestAttempts.requestId, attempt.rootRequestId),
        notLike(inferenceRequestAttempts.coreAttemptId, `${EDGE_ATTEMPT_PREFIX}%`)
      ),
    });
    if (coreAttempt) {
      await dropEdgeChatAttempt(accounting, attempt);
      return;
    }
    // Output reached the client but no usage came back: charge the admitted input estimate.
    const usage = observed.usage ?? {
      uncachedInputTokens: observed.emittedOutput ? attempt.estimate.inputTokens : 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    await accounting.settleCoreAttempt({
      contractId: OPFIELD_CORE_CONTRACT_ID,
      rootRequestId: attempt.rootRequestId,
      attemptId: attempt.attemptId,
      parentAttemptId: null,
      attemptKind: 'root',
      terminalStatus: outcome,
      coreAccountId: attempt.coreAccountId,
      coreModelId: attempt.coreModelId,
      sourceType: attempt.sourceType,
      upstreamStatus: outcome === 'completed' ? 200 : null,
      errorCode: null,
      usage,
      usageEstimated: observed.usage === null,
      emittedOutput: observed.emittedOutput,
      startedAt: attempt.startedAt.toISOString(),
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn('Chat Completions edge settlement failed', { requestId: attempt.rootRequestId, error });
  }
}

function admissionDenied(decision: Extract<InferenceCoreAdmissionResponse, { decision: 'deny' }>) {
  const retry =
    decision.retryAfterSeconds !== undefined ? { retryAfterSeconds: decision.retryAfterSeconds } : undefined;
  switch (decision.reason) {
    case 'budget_exceeded':
      return new InferenceProtocolError(429, 'budget_exhausted', 'Inference budget exhausted', retry);
    case 'rate_limited':
    case 'concurrency_limited':
      return new InferenceProtocolError(429, 'rate_limit_exceeded', 'Inference rate limit reached', retry);
    case 'model_disabled':
      return new InferenceProtocolError(403, 'model_disabled', 'The model is currently unavailable');
    default:
      return new InferenceProtocolError(403, 'permission_denied', 'Inference is disabled for this user');
  }
}
