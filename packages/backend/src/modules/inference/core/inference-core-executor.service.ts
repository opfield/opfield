import { injectable } from 'tsyringe';
import type { DrizzleClient } from '@/db/client.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import { latestPricing, stringExtension, unitCharge } from '../accounting/inference-accounting.helpers.js';
import type { InferenceCoreAccountingService } from '../accounting/inference-core-accounting.service.js';
import { normalizeServiceTier } from '../accounting/inference-service-tier.js';
import { mapReasoningEffort } from '../models/inference-reasoning.service.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import type {
  InferenceExecution,
  InferenceExecutionContext,
  InferenceExecutor,
  InferenceRequest,
  InferenceStreamEvent,
} from '../protocol/inference-protocol.types.js';
import type { InferenceProviderDefinition } from '../providers/inference-provider.types.js';
import {
  createProviderStreamState,
  parseProviderEvent,
  providerRequestBody,
} from '../providers/inference-provider-wire.js';
import type { CoreDataPlaneTarget } from './inference-core-bridge.service.js';
import { coreRequestHeaders, newCoreRequestContext } from './inference-core-context.js';
import { type InferenceCoreProxyService, shouldFailOverCoreResponse } from './inference-core-proxy.service.js';

/**
 * The Opfield↔core wire is always the OpenAI Responses protocol: the core is
 * the provider/protocol authority and translates to whatever the upstream
 * speaks. A synthetic definition keeps the shared wire helpers honest.
 */
const CORE_WIRE_DEFINITION = {
  id: 'wiolett-core',
  wireProtocol: 'openai-responses',
} as InferenceProviderDefinition;

type JsonObject = Record<string, unknown>;

/**
 * Core-backed in-process executor (plan T5). Keeps the InferenceExecutor slot
 * used by the AI module while the request actually runs in the managed core:
 * admission and settlement flow through the internal contract exactly like
 * proxied public requests.
 */
@injectable()
export class InferenceCoreExecutor implements InferenceExecutor {
  constructor(
    private readonly db: DrizzleClient,
    private readonly proxy: InferenceCoreProxyService,
    private readonly coreAccounting: InferenceCoreAccountingService
  ) {}

  async execute(request: InferenceRequest, context: InferenceExecutionContext): Promise<InferenceExecution> {
    const user = await resolveLiveUser(this.db, context.userId);
    if (!user || user.isBlocked) {
      throw new InferenceProtocolError(401, 'invalid_api_key', 'Inference user is unavailable');
    }
    let resolved = await this.proxy.resolveTarget(user, request.model, {
      ...(context.affinityKey ? { affinityKey: context.affinityKey } : {}),
      ...(context.existingThread !== undefined ? { existingThread: context.existingThread } : {}),
    });
    // Resolve core readiness before creating the idempotent root request.
    const target = await this.dataPlaneTarget();
    let fixedApiMicrodollars = await this.fixedApiCharge(resolved.selected.source.id, context);

    const { requestId } = await this.coreAccounting.createCoreRequest({
      userId: user.id,
      tokenId: context.tokenId,
      protocol: 'responses',
      operation: context.operation ?? 'inference',
      model: resolved.model,
      source: resolved.selected.source,
      connection: resolved.selected.connection,
      serviceTier: normalizeServiceTier(request.extensions.service_tier),
      reasoningEffort: request.reasoningEffort ?? null,
      ...(stringExtension(request.extensions.idempotency_key)
        ? { idempotencyKey: stringExtension(request.extensions.idempotency_key) }
        : {}),
      ...(context.affinityKey ? { affinityKey: context.affinityKey } : {}),
      ...(fixedApiMicrodollars ? { fixedApiMicrodollars } : {}),
      ...(request.isCompaction ? { isCompaction: true } : {}),
    });
    let upstream: Response;
    let effectiveRequest: InferenceRequest = request;
    const excludedConnectionIds: string[] = [];
    try {
      for (;;) {
        if (excludedConnectionIds.length > 0) {
          resolved = await this.proxy.resolveTarget(user, request.model, {
            ...(context.affinityKey ? { affinityKey: context.affinityKey } : {}),
            ...(context.existingThread !== undefined ? { existingThread: context.existingThread } : {}),
            excludeConnectionIds: excludedConnectionIds,
          });
          fixedApiMicrodollars = await this.fixedApiCharge(resolved.selected.source.id, context);
          await this.coreAccounting.retargetCoreRequest(
            requestId,
            resolved.selected.source,
            resolved.selected.connection,
            fixedApiMicrodollars
          );
        }
        const mapped = mapReasoningEffort(
          request.reasoningEffort,
          resolved.model.defaultReasoningEffort,
          resolved.model.reasoningEfforts,
          resolved.selected.source.reasoningEffortMap
        );
        effectiveRequest = {
          ...request,
          ...(mapped.upstreamEffort ? { reasoningEffort: mapped.upstreamEffort } : {}),
        };
        const { claims } = newCoreRequestContext({
          requestLimits: target.requestLimits,
          maxOutputTokens: target.outputLimitSupported ? resolved.model.maxOutputTokens : null,
          tenantUserId: user.id,
          rootRequestId: requestId,
          publicModelId: resolved.model.publicId,
          coreAccountId: resolved.coreAccountId,
          coreModelId: resolved.upstreamModel,
          operation: 'responses',
        });
        const wire = providerRequestBody(CORE_WIRE_DEFINITION, resolved.upstreamModel, effectiveRequest);
        try {
          upstream = await fetch(`${target.baseUrl}/v1/responses`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'text/event-stream',
              ...coreRequestHeaders(claims, target.credential),
            },
            body: JSON.stringify(wire),
            signal: context.signal,
            duplex: 'half',
          });
        } catch (_error) {
          if (!context.signal.aborted && resolved.candidateConnectionIds.length > 1) {
            excludedConnectionIds.push(resolved.selected.connection.id);
            continue;
          }
          if (context.signal.aborted) throw new InferenceProtocolError(499, 'client_cancelled', 'Client disconnected');
          throw new InferenceProtocolError(503, 'inference_core_unavailable', 'The inference core is unavailable');
        }
        if (resolved.candidateConnectionIds.length > 1 && (await shouldFailOverCoreResponse(upstream))) {
          await upstream.body?.cancel().catch(() => undefined);
          excludedConnectionIds.push(resolved.selected.connection.id);
          continue;
        }
        if (!upstream.ok || !upstream.body) throw await coreFailure(upstream);
        break;
      }
    } catch (error) {
      await this.coreAccounting
        .finalizeCoreRequest(requestId, context.signal.aborted ? 'cancelled' : 'failed', error)
        .catch(() => undefined);
      throw error;
    }

    const state = createProviderStreamState(resolved.upstreamModel, effectiveRequest.tools);
    const accounting = this.coreAccounting;
    const signal = context.signal;
    const events = (async function* (): AsyncGenerator<InferenceStreamEvent> {
      let outcome: 'completed' | 'failed' | 'cancelled' = 'completed';
      try {
        yield* decodeSse(upstream.body!, (payload) => parseProviderEvent(CORE_WIRE_DEFINITION, payload, state));
      } catch {
        outcome = signal.aborted ? 'cancelled' : 'failed';
        throw new InferenceProtocolError(502, 'inference_core_stream_failed', 'The core stream ended unexpectedly');
      } finally {
        await accounting.finalizeCoreRequest(requestId, outcome).catch(() => undefined);
      }
    })();

    return {
      responseId: state.responseId,
      resolvedModel: resolved.model.publicId,
      events,
      ...(context.affinityKey ? { affinityKey: context.affinityKey } : {}),
    };
  }

  private async dataPlaneTarget(): Promise<CoreDataPlaneTarget> {
    try {
      return await this.proxy.dataPlaneTarget();
    } catch {
      throw new InferenceProtocolError(503, 'inference_core_unavailable', 'The inference core is unavailable');
    }
  }

  private async fixedApiCharge(sourceId: string, context: InferenceExecutionContext): Promise<number> {
    if (!context.apiUnitCharge) return 0;
    const pricing = await latestPricing(this.db, sourceId);
    const amount = unitCharge(pricing, context.apiUnitCharge.priceKey, context.apiUnitCharge.units);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new InferenceProtocolError(
        503,
        'pricing_unavailable',
        `API pricing for ${context.apiUnitCharge.priceKey} is unavailable`
      );
    }
    return amount;
  }
}

async function coreFailure(response: Response): Promise<InferenceProtocolError> {
  let code = 'inference_core_request_failed';
  let message = `The inference core request failed with HTTP ${response.status}`;
  try {
    const body = (await response.json()) as JsonObject;
    const error = body.error && typeof body.error === 'object' ? (body.error as JsonObject) : body;
    if (typeof error.code === 'string' && error.code) code = error.code;
    if (typeof error.message === 'string' && error.message) message = error.message;
    else if (typeof body.detail === 'string' && body.detail) message = body.detail;
  } catch {
    // Keep the generic failure.
  }
  const allowed = [400, 401, 403, 404, 409, 413, 429, 499, 500, 502, 503] as const;
  const status = (allowed as readonly number[]).includes(response.status)
    ? (response.status as InferenceProtocolError['status'])
    : 502;
  return new InferenceProtocolError(status, code, message.slice(0, 500));
}

async function* decodeSse(
  body: ReadableStream<Uint8Array>,
  parse: (payload: JsonObject) => InferenceStreamEvent[]
): AsyncGenerator<InferenceStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parseFrame = function* (frame: string): Generator<InferenceStreamEvent> {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      yield* parse(payload as JsonObject);
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        yield* parseFrame(frame);
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n');
    if (buffer.trim()) yield* parseFrame(buffer);
  } finally {
    reader.releaseLock();
  }
}
