import { randomUUID } from 'node:crypto';
import type { WSContext, WSEvents } from 'hono/ws';
import WebSocket from 'ws';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import { InferenceCoreAccountingService } from '../accounting/inference-core-accounting.service.js';
import { acquireInferenceConcurrency, consumeInferenceRateLimit } from '../inference-limit.middleware.js';
import { InferenceTokenService } from '../inference-token.service.js';
import { mapReasoningEffort } from '../models/inference-reasoning.service.js';
import { InferenceProtocolError, inferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { canFailOver } from '../providers/inference-routing.service.js';
import type { CoreDataPlaneTarget } from './inference-core-bridge.service.js';
import { coreRequestHeaders, newCoreRequestContext } from './inference-core-context.js';
import { rewriteCoreModelIdText } from './inference-core-model-rewrite.js';
import { InferenceCoreProxyService } from './inference-core-proxy.service.js';
import { publishResponsesEventModel } from './inference-core-published-model.js';
import { startInferenceWebSocketHeartbeat } from './inference-websocket-heartbeat.js';

const logger = createChildLogger('InferenceCoreWebSocketProxy');

class CoreWebSocketUpgradeError extends Error {
  constructor(readonly statusCode: number | null) {
    super(
      statusCode === null
        ? 'Inference core rejected the WebSocket upgrade'
        : `Inference core rejected the WebSocket upgrade with status ${statusCode}`
    );
    this.name = 'CoreWebSocketUpgradeError';
  }
}

export interface InferenceCoreWebSocketAuth {
  user: User;
  tokenId: string;
  tokenPrefix: string;
  /** Raw token is retained only per connection to revalidate each new turn. */
  rawToken: string;
  /** The client address of the upgrade request; each turn's revalidation checks the token's address limit. */
  clientIp?: string;
}

interface ConnectionState {
  connectionId: string;
  openedAt: number;
  lastClientMessageAt: number | null;
  lastCoreMessageAt: number | null;
  lastRequestId: string | null;
  stopHeartbeat: () => void;
  active: ActiveTurn | null;
  unsubscribe: (() => void) | null;
  closedForRevocation: boolean;
  closed: boolean;
  starting: boolean;
  cancelStarting: boolean;
}

interface ActiveTurn {
  startedAt: number;
  upstream: WebSocket | null;
  requestId: string;
  responseId: string;
  model: string;
  cancelled: boolean;
  terminalSeen: boolean;
  terminalSent: boolean;
  emittedOutput: boolean;
  pendingPreludeFrames: string[];
  finalized: boolean;
  disposeUpstream?: () => void;
  firstTransportError?: Error;
  /** Provider answer of the latest attempt that failed over before output. */
  lastProviderError?: InferenceProtocolError;
  refreshAffinity?: () => Promise<void>;
  /** Per-user concurrency lease; released exactly once when the turn ends. */
  release: () => Promise<void>;
}

/** Responses WS events that end a turn. */
const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);
const MAX_PENDING_PRELUDE_FRAMES = 4;
const MAX_PENDING_PRELUDE_BYTES = 1024 * 1024;
const MAX_CLIENT_BUFFERED_BYTES = 1024 * 1024;
const UPSTREAM_CLOSE_BEFORE_RETRY_MS = 1_000;

/**
 * Per-turn WebSocket proxy (plan T5). The client-facing contract is unchanged:
 * one active response per connection, token revalidation per turn, revocation
 * close. Each response.create turn gets its own upstream connection with a
 * freshly signed request context — the signed context binds one rootRequestId,
 * so one upstream socket per turn keeps accounting lineage exact.
 */
export function createCoreResponsesWSHandlers(
  auth: InferenceCoreWebSocketAuth | null,
  maxPayloadBytes: number | (() => number | Promise<number>) = 128 * 1024 * 1024
): WSEvents {
  const state: ConnectionState = {
    connectionId: randomUUID(),
    openedAt: Date.now(),
    lastClientMessageAt: null,
    lastCoreMessageAt: null,
    lastRequestId: null,
    stopHeartbeat: () => undefined,
    active: null,
    unsubscribe: null,
    closedForRevocation: false,
    closed: false,
    starting: false,
    cancelStarting: false,
  };
  return {
    onOpen(_event, ws) {
      if (!auth) {
        sendError(ws, 401, 'invalid_api_key', 'Invalid inference token');
        ws.close(1008, 'Unauthorized');
        return;
      }
      state.stopHeartbeat();
      state.stopHeartbeat = startInferenceWebSocketHeartbeat(ws.raw, () => {
        logTransportEvent(state, state.active, 'client', 'heartbeat_error');
      });
      if (container.isRegistered(EventBusService)) {
        state.unsubscribe = container
          .resolve(EventBusService)
          .subscribe(`permissions.changed.${auth.user.id}`, (payload) => {
            if (isAccessRevocation(payload)) closeForRevocation(state, ws);
          });
      }
    },
    async onMessage(event, ws) {
      if (!auth || state.closed) return;
      state.lastClientMessageAt = Date.now();
      // A small cancellation frame must fence pending admission before any await.
      // Still run the normal rate/payload checks below; this only prevents work
      // from starting while those checks are outstanding.
      if (state.starting && payloadBytes(event.data) <= 1024) {
        try {
          if (JSON.parse(String(event.data))?.type === 'response.cancel') state.cancelStarting = true;
        } catch {
          // The normal parser below reports malformed frames.
        }
      }
      try {
        await consumeInferenceRateLimit(auth);
      } catch (error) {
        const protocol = inferenceProtocolError(error);
        sendError(ws, protocol.status, protocol.code, protocol.message);
        return;
      }
      const effectiveMaxPayloadBytes =
        typeof maxPayloadBytes === 'function' ? await maxPayloadBytes() : maxPayloadBytes;
      if (payloadBytes(event.data) > effectiveMaxPayloadBytes) {
        sendError(ws, 413, 'request_too_large', 'WebSocket message is too large');
        state.stopHeartbeat();
        ws.close(1009, 'Message too large');
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        sendError(ws, 400, 'invalid_request_error', 'Message must be JSON');
        return;
      }
      if (message.type === 'response.cancel') {
        if (state.starting) state.cancelStarting = true;
        const active = state.active;
        if (active) {
          active.cancelled = true;
          if (active.upstream) upstreamSend(active.upstream, JSON.stringify(message));
          if (!active.terminalSent) {
            send(ws, cancelledEvent(active.responseId, active.model));
            active.terminalSent = true;
          }
          try {
            active.upstream?.close();
          } catch {
            // Already closed.
          }
          endTurn(state, 'cancelled');
        }
        return;
      }
      if (message.type !== 'response.create') {
        sendError(ws, 400, 'invalid_request_error', 'Unsupported WebSocket event');
        return;
      }
      if (message.generate === false) {
        for (const frame of warmupCompletionFrames(message)) send(ws, frame);
        return;
      }
      const freshAuth = await revalidateAuth(auth);
      if (state.closed) return;
      if (!freshAuth) {
        sendError(ws, 401, 'invalid_api_key', 'Invalid or revoked Opfield inference token');
        state.stopHeartbeat();
        ws.close(1008, 'Unauthorized');
        return;
      }
      if (state.active || state.starting) {
        sendError(ws, 409, 'response_in_progress', 'A response is already running');
        return;
      }
      state.starting = true;
      state.cancelStarting = false;
      const release = await acquireInferenceConcurrency(freshAuth).catch((error: unknown) => {
        const protocol = inferenceProtocolError(error);
        sendError(ws, protocol.status, protocol.code, protocol.message);
        return null;
      });
      if (!release) {
        state.starting = false;
        return;
      }
      try {
        if (state.closed) {
          await release();
          return;
        }
        await startTurn(state, ws, freshAuth, message, release);
      } catch (error) {
        // The turn never started, so the lease is still owned here.
        await release();
        const protocol = inferenceProtocolError(error);
        sendError(ws, protocol.status, protocol.code, protocol.message);
      } finally {
        state.starting = false;
      }
    },
    onClose(event) {
      state.closed = true;
      state.stopHeartbeat();
      logTransportEvent(state, state.active, 'client', 'close', event.code);
      endTurn(state, 'cancelled');
      state.unsubscribe?.();
      state.unsubscribe = null;
    },
    onError() {
      state.closed = true;
      state.stopHeartbeat();
      logTransportEvent(state, state.active, 'client', 'error');
      endTurn(state, 'cancelled');
      state.unsubscribe?.();
      state.unsubscribe = null;
    },
  };
}

async function startTurn(
  state: ConnectionState,
  ws: WSContext,
  auth: InferenceCoreWebSocketAuth,
  message: Record<string, unknown>,
  release: () => Promise<void>
): Promise<void> {
  const proxy = container.resolve(InferenceCoreProxyService);
  const accounting = container.resolve(InferenceCoreAccountingService);
  const envelope = asObject(message.response) ?? message;
  const publicModelId = typeof envelope.model === 'string' ? envelope.model : '';
  if (!publicModelId.trim()) throw new InferenceProtocolError(400, 'invalid_request_error', 'model is required');

  const affinityKey = typeof envelope.prompt_cache_key === 'string' ? envelope.prompt_cache_key : undefined;
  const existingThread = typeof envelope.previous_response_id === 'string';
  const isCompaction = hasCompactionTrigger(envelope.input);
  const initial = await proxy.resolveTarget(auth.user, publicModelId, {
    ...(affinityKey ? { affinityKey } : {}),
    existingThread,
  });
  const requestedEffort =
    (envelope.reasoning && typeof envelope.reasoning === 'object'
      ? (envelope.reasoning as Record<string, unknown>).effort
      : undefined) ?? envelope.reasoning_effort;
  // A missing core must fail before an idempotent request row exists.
  const target = await proxy.dataPlaneTarget();
  const { requestId } = await accounting.createCoreRequest({
    userId: auth.user.id,
    tokenId: auth.tokenId,
    protocol: 'responses',
    operation: 'responses',
    model: initial.model,
    source: initial.selected.source,
    connection: initial.selected.connection,
    serviceTier: typeof envelope.service_tier === 'string' ? envelope.service_tier : null,
    reasoningEffort: typeof requestedEffort === 'string' ? requestedEffort : null,
    ...(typeof envelope.idempotency_key === 'string' ? { idempotencyKey: envelope.idempotency_key } : {}),
    ...(affinityKey ? { affinityKey } : {}),
    ...(isCompaction ? { isCompaction: true } : {}),
  });
  const releaseAffinityTurn = affinityKey ? await proxy.beginAffinityTurn(affinityKey) : undefined;
  let affinityTurnFinalized = false;
  const refreshAffinity = affinityKey
    ? async () => {
        if (affinityTurnFinalized) return;
        affinityTurnFinalized = true;
        try {
          await proxy.markAffinityActive(affinityKey);
        } finally {
          await releaseAffinityTurn?.();
        }
      }
    : undefined;
  const turn: ActiveTurn = {
    startedAt: Date.now(),
    upstream: null,
    requestId,
    responseId: `resp_${requestId}`,
    model: initial.model.publicId,
    cancelled: false,
    terminalSeen: false,
    terminalSent: false,
    emittedOutput: false,
    pendingPreludeFrames: [],
    finalized: false,
    ...(refreshAffinity ? { refreshAffinity } : {}),
    release,
  };
  state.active = turn;
  state.lastRequestId = requestId;
  state.lastCoreMessageAt = null;
  if (state.closed || state.cancelStarting) {
    if (!state.closed) {
      send(ws, cancelledEvent(turn.responseId, turn.model));
      turn.terminalSent = true;
    }
    endTurn(state, 'cancelled');
    return;
  }
  try {
    await connectTurnAttempt({
      state,
      ws,
      auth,
      proxy,
      accounting,
      target,
      turn,
      message,
      envelope,
      requestedEffort: typeof requestedEffort === 'string' ? requestedEffort : undefined,
      affinityKey,
      existingThread,
      resolved: initial,
      excludedConnectionIds: [],
    });
  } catch (error) {
    state.active = null;
    if (turn.refreshAffinity) await turn.refreshAffinity().catch(() => undefined);
    await accounting.finalizeCoreRequest(requestId, 'failed', error).catch(() => undefined);
    throw error;
  }
}

type ResolvedCoreTarget = Awaited<ReturnType<InferenceCoreProxyService['resolveTarget']>>;

async function connectTurnAttempt(input: {
  state: ConnectionState;
  ws: WSContext;
  auth: InferenceCoreWebSocketAuth;
  proxy: InferenceCoreProxyService;
  accounting: InferenceCoreAccountingService;
  target: CoreDataPlaneTarget;
  turn: ActiveTurn;
  message: Record<string, unknown>;
  envelope: Record<string, unknown>;
  requestedEffort?: string;
  affinityKey?: string;
  existingThread: boolean;
  resolved: ResolvedCoreTarget;
  excludedConnectionIds: string[];
}): Promise<void> {
  let resolved = input.resolved;
  if (input.excludedConnectionIds.length > 0) {
    resolved = await input.proxy.resolveTarget(input.auth.user, input.turn.model, {
      ...(input.affinityKey ? { affinityKey: input.affinityKey } : {}),
      existingThread: input.existingThread,
      excludeConnectionIds: input.excludedConnectionIds,
    });
    await input.accounting.retargetCoreRequest(
      input.turn.requestId,
      resolved.selected.source,
      resolved.selected.connection
    );
  }
  // Resolving a replacement can outlive a downstream cancellation.
  if (input.state.closed || input.state.active !== input.turn || input.turn.finalized) return;

  const rewritten: Record<string, unknown> = { ...input.message };
  const rewrittenEnvelope: Record<string, unknown> = { ...input.envelope, model: resolved.upstreamModel };
  const mapped = mapReasoningEffort(
    input.requestedEffort,
    resolved.model.defaultReasoningEffort,
    resolved.model.reasoningEfforts,
    resolved.selected.source.reasoningEffortMap
  );
  if (mapped.upstreamEffort) {
    rewrittenEnvelope.reasoning = {
      ...(input.envelope.reasoning && typeof input.envelope.reasoning === 'object'
        ? (input.envelope.reasoning as Record<string, unknown>)
        : {}),
      effort: mapped.upstreamEffort,
    };
  }
  if (asObject(input.message.response)) rewritten.response = rewrittenEnvelope;
  else Object.assign(rewritten, rewrittenEnvelope);

  const { claims } = newCoreRequestContext({
    requestLimits: input.target.requestLimits,
    maxOutputTokens: input.target.outputLimitSupported ? resolved.model.maxOutputTokens : null,
    tenantUserId: input.auth.user.id,
    rootRequestId: input.turn.requestId,
    publicModelId: resolved.model.publicId,
    coreAccountId: resolved.coreAccountId,
    coreModelId: resolved.upstreamModel,
    operation: 'responses',
  });
  let pendingFrame: string | undefined = JSON.stringify(rewritten);
  const maxCoreFrameBytes = input.target.requestLimits?.webSocketMaxPayloadBytes ?? 50 * 1024 * 1024;
  if (Buffer.byteLength(pendingFrame) > maxCoreFrameBytes) {
    throw new InferenceProtocolError(
      413,
      'request_too_large',
      input.target.requestLimitsCapability === 'negotiated-v1'
        ? 'WebSocket message exceeds the configured inference limit'
        : 'WebSocket message exceeds the legacy core limit; update the inference core to apply Opfield limits'
    );
  }
  let upstream: WebSocket;
  try {
    upstream = new WebSocket(`${input.target.baseUrl.replace(/^http/, 'ws')}/v1/responses`, {
      headers: coreRequestHeaders(claims, input.target.credential),
    });
  } catch (error) {
    if (resolved.candidateConnectionIds.length > 1) {
      return connectTurnAttempt({
        ...input,
        resolved,
        excludedConnectionIds: [...input.excludedConnectionIds, resolved.selected.connection.id],
      });
    }
    throw error;
  }
  input.turn.upstream = upstream;
  let ended = false;
  let retryAfterClose = false;
  let providerFailure = false;
  let closeWatchdog: ReturnType<typeof setTimeout> | null = null;

  const clearCloseWatchdog = () => {
    if (!closeWatchdog) return;
    clearTimeout(closeWatchdog);
    closeWatchdog = null;
  };

  // Keep only the serialized send buffer until open. The listener must not
  // retain a second parsed copy of a large request for the socket lifetime.
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ended = true;
    clearCloseWatchdog();
    pendingFrame = undefined;
    input.message = {};
    input.envelope = {};
    if (input.turn.upstream === upstream) input.turn.upstream = null;
    closeCoreSocket(upstream);
  };
  input.turn.disposeUpstream = dispose;

  const retryOrFail = (error?: unknown, allowConnectionFailover = true) => {
    if (ended) return;
    ended = true;
    clearCloseWatchdog();
    if (input.state.active !== input.turn || input.turn.cancelled || input.turn.finalized) return;
    if (allowConnectionFailover && !input.turn.emittedOutput && resolved.candidateConnectionIds.length > 1) {
      input.turn.pendingPreludeFrames = [];
      if (!providerFailure) {
        input.turn.firstTransportError ??=
          error instanceof CoreWebSocketUpgradeError
            ? error
            : new InferenceProtocolError(
                502,
                'inference_core_unavailable',
                'The inference core connection ended before output'
              );
      }
      const next = {
        ...input,
        resolved,
        excludedConnectionIds: [...input.excludedConnectionIds, resolved.selected.connection.id],
      };
      dispose();
      void connectTurnAttempt(next).catch((retryError) => {
        // With no alternative left, report why the last attempt failed instead of the
        // capacity error, which would hide the provider's answer (auth, quota, dispatch).
        const cause = input.turn.lastProviderError ?? input.turn.firstTransportError;
        failTurn(
          input.state,
          input.ws,
          input.accounting,
          input.turn,
          cause && retryError instanceof InferenceProtocolError && retryError.code === 'provider_capacity_unavailable'
            ? cause
            : retryError
        );
      });
      return;
    }
    failTurn(input.state, input.ws, input.accounting, input.turn, error);
  };

  const retryOnceClosed = () => {
    if (ended || retryAfterClose) return;
    retryAfterClose = true;
    providerFailure = true;
    closeWatchdog = setTimeout(() => {
      if (ended || !retryAfterClose) return;
      retryAfterClose = false;
      try {
        upstream.terminate();
      } catch {
        // The connection may already be gone without emitting close.
      }
      retryOrFail();
    }, UPSTREAM_CLOSE_BEFORE_RETRY_MS);
    closeWatchdog.unref?.();
    try {
      upstream.close();
    } catch {
      retryAfterClose = false;
      retryOrFail();
    }
  };

  upstream.once('open', () => {
    const frame = pendingFrame;
    pendingFrame = undefined;
    if (!ended && frame) upstreamSend(upstream, frame);
  });
  upstream.on('unexpected-response', (_request, response) => {
    const error = new CoreWebSocketUpgradeError(response.statusCode ?? null);
    response.resume();
    logger.error('Inference core WebSocket upgrade was rejected', {
      requestId: input.turn.requestId,
      statusCode: error.statusCode,
    });
    // This is a core transport failure, not a provider failure. Rotating across
    // provider connections only repeats the same rejected core handshake.
    retryOrFail(error, false);
  });
  upstream.on('message', (data) => {
    if (ended || input.state.active !== input.turn) return;
    input.state.lastCoreMessageAt = Date.now();
    // The core echoes its internal model id; clients only ever see the published one.
    let text = rewriteCoreModelIdText(String(data), resolved.upstreamModel, resolved.model.publicId);
    const parsed = asObject(safeParse(text));
    // A Responses object can also carry the provider's model id; only `response.model` changes.
    if (publishResponsesEventModel(parsed, resolved.model.publicId)) text = JSON.stringify(parsed);
    const terminal = parsed !== null && typeof parsed.type === 'string' && TERMINAL_EVENTS.has(parsed.type);
    const providerError =
      terminal && !input.turn.emittedOutput && resolved.candidateConnectionIds.length > 1
        ? wsEventProviderError(parsed)
        : null;
    if (providerError && canFailOver(providerError, false)) {
      input.turn.lastProviderError = providerError;
      retryOnceClosed();
      return;
    }
    if (terminal) {
      input.turn.terminalSeen = true;
      input.turn.terminalSent = true;
    }
    const eventType = typeof parsed?.type === 'string' ? parsed.type : '';
    if (!terminal && isPreludeEvent(eventType)) {
      const bufferedBytes = input.turn.pendingPreludeFrames.reduce(
        (bytes, frame) => bytes + Buffer.byteLength(frame),
        0
      );
      if (
        input.turn.pendingPreludeFrames.length < MAX_PENDING_PRELUDE_FRAMES &&
        bufferedBytes + Buffer.byteLength(text) <= MAX_PENDING_PRELUDE_BYTES
      ) {
        input.turn.pendingPreludeFrames.push(text);
      } else {
        // Never discard an ordered protocol frame. Once the bounded prelude
        // buffer is full, expose the buffered prefix plus the current frame
        // and permanently cross the replay boundary for this turn.
        if (!flushPreludeFrames(input.ws, input.turn) || !sendRaw(input.ws, text)) {
          failTurn(input.state, input.ws, input.accounting, input.turn);
          return;
        }
        input.turn.emittedOutput = true;
        input.message = {};
        input.envelope = {};
      }
      return;
    }
    if (!terminal && !isSubstantiveOutputEvent(eventType)) {
      if (!sendRaw(input.ws, text)) failTurn(input.state, input.ws, input.accounting, input.turn);
      return;
    }
    if (!flushPreludeFrames(input.ws, input.turn)) {
      failTurn(input.state, input.ws, input.accounting, input.turn);
      return;
    }
    if (!terminal) {
      input.turn.emittedOutput = true;
      // Crossing the output boundary permanently forbids replay. Release the
      // full input while a long model response is still streaming.
      input.message = {};
      input.envelope = {};
    }
    if (!sendRaw(input.ws, text)) {
      failTurn(input.state, input.ws, input.accounting, input.turn);
      return;
    }
    if (terminal) {
      ended = true;
      try {
        upstream.close();
      } catch {
        // Already closed.
      }
      if (input.state.active === input.turn) input.state.active = null;
      finalizeTurn(input.accounting, input.turn, terminalOutcome(parsed));
    }
  });
  upstream.on('close', (code) => {
    logTransportEvent(input.state, input.turn, 'core', 'close', code);
    if (ended) return;
    if (retryAfterClose) {
      retryAfterClose = false;
      clearCloseWatchdog();
      retryOrFail();
      return;
    }
    if (input.turn.cancelled) {
      ended = true;
      if (input.state.active === input.turn) input.state.active = null;
      if (!input.turn.terminalSent) send(input.ws, cancelledEvent(input.turn.responseId, input.turn.model));
      input.turn.terminalSent = true;
      finalizeTurn(input.accounting, input.turn, 'cancelled');
      return;
    }
    retryOrFail();
  });
  upstream.on('error', (error) => {
    logTransportEvent(input.state, input.turn, 'core', 'error');
    retryOrFail(error);
  });
}

function logTransportEvent(
  state: ConnectionState,
  turn: ActiveTurn | null,
  side: 'client' | 'core',
  event: 'close' | 'error' | 'heartbeat_error',
  closeCode?: number
): void {
  const now = Date.now();
  const fields = {
    connectionId: state.connectionId,
    requestId: turn?.requestId ?? state.lastRequestId,
    side,
    event,
    closeCode: typeof closeCode === 'number' ? closeCode : null,
    connectionAgeMs: now - state.openedAt,
    requestAgeMs: turn ? now - turn.startedAt : null,
    sinceLastClientMessageMs: state.lastClientMessageAt === null ? null : now - state.lastClientMessageAt,
    sinceLastCoreMessageMs: state.lastCoreMessageAt === null ? null : now - state.lastCoreMessageAt,
    activeTurn: turn !== null && state.active === turn,
    terminalSeen: turn?.terminalSeen ?? false,
    emittedOutput: turn?.emittedOutput ?? false,
    cancelled: turn?.cancelled ?? false,
  };
  // Close reasons and Error messages are peer-controlled; never log their text,
  // credentials, headers, or payloads. Normal terminal closes stay out of info logs.
  if (event !== 'close' || (fields.activeTurn && !fields.terminalSeen && !fields.cancelled)) {
    logger.warn('Inference WebSocket transport event', fields);
  } else {
    logger.debug('Inference WebSocket transport event', fields);
  }
}

function terminalOutcome(event: Record<string, unknown>): 'completed' | 'failed' {
  return event.type === 'response.completed' ? 'completed' : 'failed';
}

function failTurn(
  state: ConnectionState,
  ws: WSContext,
  accounting: InferenceCoreAccountingService,
  turn: ActiveTurn,
  error?: unknown
): void {
  if (state.active === turn) state.active = null;
  if (!turn.terminalSent) {
    if (error instanceof InferenceProtocolError && error === turn.lastProviderError) {
      sendError(ws, error.status, error.code, error.message);
    } else {
      const message =
        error instanceof CoreWebSocketUpgradeError
          ? error.message
          : 'The inference core connection ended before output';
      sendError(ws, 502, 'inference_core_unavailable', message);
    }
    turn.terminalSent = true;
  }
  finalizeTurn(accounting, turn, 'failed', error);
}

function finalizeTurn(
  accounting: InferenceCoreAccountingService,
  turn: ActiveTurn,
  outcome: 'completed' | 'failed' | 'cancelled',
  error?: unknown
): void {
  if (turn.finalized) return;
  turn.finalized = true;
  turn.disposeUpstream?.();
  turn.disposeUpstream = undefined;
  turn.pendingPreludeFrames = [];
  turn.firstTransportError = undefined;
  turn.lastProviderError = undefined;
  void turn.release().catch(() => undefined);
  if (turn.refreshAffinity) void turn.refreshAffinity().catch(() => undefined);
  const finalized = error
    ? accounting.finalizeCoreRequest(turn.requestId, outcome, error)
    : accounting.finalizeCoreRequest(turn.requestId, outcome);
  void finalized.catch(() => undefined);
}

function endTurn(state: ConnectionState, outcome: 'completed' | 'failed' | 'cancelled'): void {
  const active = state.active;
  state.active = null;
  if (!active) return;
  try {
    active.upstream?.close();
  } catch {
    // Already closed.
  }
  finalizeTurn(container.resolve(InferenceCoreAccountingService), active, outcome);
}

async function revalidateAuth(auth: InferenceCoreWebSocketAuth): Promise<InferenceCoreWebSocketAuth | null> {
  const fresh = await container
    .resolve(InferenceTokenService)
    .validateToken(auth.rawToken, { clientIp: auth.clientIp });
  if (!fresh || fresh.tokenId !== auth.tokenId) return null;
  return {
    user: fresh.user,
    tokenId: fresh.tokenId,
    tokenPrefix: fresh.tokenPrefix,
    rawToken: auth.rawToken,
    clientIp: auth.clientIp,
  };
}

function isAccessRevocation(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const reason = (payload as { reason?: unknown }).reason;
  return reason === 'user_blocked' || reason === 'user_deleted';
}

function closeForRevocation(state: ConnectionState, ws: WSContext): void {
  if (state.closedForRevocation) return;
  state.closedForRevocation = true;
  state.closed = true;
  state.stopHeartbeat();
  endTurn(state, 'cancelled');
  state.unsubscribe?.();
  state.unsubscribe = null;
  ws.close(1008, 'Access revoked');
}

/** Detach request-bearing listeners now; only a tiny close deadline may linger. */
function closeCoreSocket(upstream: WebSocket): void {
  for (const event of ['open', 'message', 'close', 'error', 'unexpected-response']) upstream.removeAllListeners(event);
  upstream.on('error', () => undefined);
  if (upstream.readyState === WebSocket.CLOSED) return;
  const timer = setTimeout(() => upstream.terminate(), UPSTREAM_CLOSE_BEFORE_RETRY_MS);
  timer.unref?.();
  upstream.once('close', () => clearTimeout(timer));
  try {
    upstream.close();
  } catch {
    clearTimeout(timer);
    upstream.terminate();
  }
}

function upstreamSend(upstream: WebSocket, frame: string): void {
  try {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
  } catch {
    // The upstream may have closed between the check and the send.
  }
}

function cancelledEvent(responseId: string, model: string): Record<string, unknown> {
  return {
    type: 'response.cancelled',
    response: {
      id: responseId,
      object: 'response',
      status: 'cancelled',
      model,
      output: [],
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
      },
    },
  };
}

function warmupCompletionFrames(message: Record<string, unknown>): Record<string, unknown>[] {
  const createdAt = Math.floor(Date.now() / 1000);
  const response = {
    id: '',
    object: 'response',
    created_at: createdAt,
    model: typeof message.model === 'string' ? message.model : undefined,
    output: [],
  };
  return [
    { type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress' } },
    { type: 'response.completed', sequence_number: 1, response: { ...response, status: 'completed' } },
  ];
}

function errorEvent(status: number, code: string, message: string): Record<string, unknown> {
  return {
    type: 'error',
    status,
    error: { type: code, code, message },
  };
}

function sendError(ws: WSContext, status: number, code: string, message: string): void {
  send(ws, errorEvent(status, code, message));
}

function send(ws: WSContext, message: Record<string, unknown>): void {
  if (clientBackpressured(ws)) return;
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The peer may have closed between an awaited event and this send.
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function hasCompactionTrigger(input: unknown): boolean {
  return (
    Array.isArray(input) &&
    input.some(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).type === 'compaction_trigger'
    )
  );
}

function isPreludeEvent(type: string): boolean {
  return (
    type === 'response.created' ||
    type === 'response.queued' ||
    type === 'response.in_progress' ||
    // Structural allocation does not commit visible output or an executable
    // tool call. Keep it behind the existing bounded prelude buffer so a
    // retryable core/provider failure can still rotate connections safely.
    type === 'response.output_item.added' ||
    type === 'response.content_part.added'
  );
}

function isSubstantiveOutputEvent(type: string): boolean {
  return type.startsWith('response.') && !isPreludeEvent(type) && !TERMINAL_EVENTS.has(type);
}

function flushPreludeFrames(ws: WSContext, turn: ActiveTurn): boolean {
  for (const frame of turn.pendingPreludeFrames) {
    if (!sendRaw(ws, frame)) return false;
  }
  turn.pendingPreludeFrames = [];
  return true;
}

function sendRaw(ws: WSContext, frame: string): boolean {
  if (clientBackpressured(ws)) return false;
  try {
    ws.send(frame);
    return true;
  } catch {
    // The peer may have closed while the upstream frame was in flight.
    return false;
  }
}

function clientBackpressured(ws: WSContext): boolean {
  const bufferedAmount = (ws as unknown as { raw?: { bufferedAmount?: unknown } }).raw?.bufferedAmount;
  if (typeof bufferedAmount !== 'number' || bufferedAmount <= MAX_CLIENT_BUFFERED_BYTES) return false;
  try {
    ws.close(1013, 'Inference client backpressure');
  } catch {
    // The peer may have closed while its send buffer was inspected.
  }
  return true;
}

/** The provider failure a terminal core event describes, keeping the core's code and message. */
function wsEventProviderError(event: Record<string, unknown>): InferenceProtocolError {
  const error = asObject(event.error) ?? asObject(asObject(event.response)?.error);
  const code =
    (typeof error?.code === 'string' && error.code) ||
    (typeof error?.type === 'string' && error.type) ||
    'provider_unavailable';
  const rawStatus = event.status ?? error?.status;
  const status =
    typeof rawStatus === 'number' && [401, 409, 429, 502].includes(rawStatus)
      ? (rawStatus as 401 | 409 | 429 | 502)
      : 503;
  const message =
    typeof error?.message === 'string' && error.message.trim()
      ? error.message.trim().slice(0, 500)
      : 'The selected provider attempt failed';
  return new InferenceProtocolError(status, code, message);
}

function payloadBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  return Buffer.byteLength(String(value));
}
