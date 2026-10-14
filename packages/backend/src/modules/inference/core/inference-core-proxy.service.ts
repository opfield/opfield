import { randomUUID } from 'node:crypto';
import { gunzipSync, inflateRawSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { Context } from 'hono';
import { injectable } from 'tsyringe';
import type { DrizzleClient } from '@/db/client.js';
import {
  inferenceDiscoveredModels,
  inferenceModelSources,
  inferenceModels,
  inferencePricingSnapshots,
  inferenceProviderConnections,
} from '@/db/schema/index.js';
import { getEnvironmentSettingsSnapshot } from '@/modules/settings/environment-settings.service.js';
import type { AppEnv, User } from '@/types.js';
import { unitCharge } from '../accounting/inference-accounting.helpers.js';
import type { InferenceAccountingService } from '../accounting/inference-accounting.service.js';
import type { InferenceCoreAccountingService } from '../accounting/inference-core-accounting.service.js';
import type { InferenceModelService } from '../models/inference-model.service.js';
import { sourceSupportsModel } from '../models/inference-model.validation.js';
import { mapReasoningEffort } from '../models/inference-reasoning.service.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { canFailOver, type InferenceRoutingService } from '../providers/inference-routing.service.js';
import type { CoreDataPlaneTarget, InferenceCoreBridgeService } from './inference-core-bridge.service.js';
import { coreRequestHeaders, newCoreRequestContext } from './inference-core-context.js';
import { CoreModelIdRewriter } from './inference-core-model-rewrite.js';
import { CORE_ACCOUNT_METADATA_KEY } from './inference-core-provider-map.js';
import { relayCoreResponseBody } from './inference-core-response-relay.js';
import type { CoreSseWire } from './inference-core-sse-observer.js';

type SourceCandidate = {
  source: typeof inferenceModelSources.$inferSelect;
  connection: typeof inferenceProviderConnections.$inferSelect;
};

type ResolvedCoreTarget = {
  model: typeof inferenceModels.$inferSelect;
  selected: SourceCandidate;
  upstreamModel: string;
  coreAccountId: string;
  candidateConnectionIds: string[];
};

/** Endpoint classes the proxy distinguishes (billing/rewrite behavior differ). */
export type CoreProxyOperation =
  | 'responses'
  | 'responses/compact'
  | 'chat/completions'
  | 'messages'
  | 'messages/count_tokens'
  | 'images/generations'
  | 'images/edits'
  | 'alpha/search'
  | 'live'
  | 'realtime/calls';

const OPERATION_PROTOCOL: Record<
  CoreProxyOperation,
  'responses' | 'chat_completions' | 'messages' | 'images' | 'search' | 'realtime'
> = {
  responses: 'responses',
  'responses/compact': 'responses',
  'chat/completions': 'chat_completions',
  messages: 'messages',
  'messages/count_tokens': 'messages',
  'images/generations': 'images',
  'images/edits': 'images',
  'alpha/search': 'search',
  live: 'realtime',
  'realtime/calls': 'realtime',
};

/** Fixed per-call price keys (otherUnitPrices) for operations the core settles with ~zero tokens. */
const FIXED_PRICE_KEYS: Partial<Record<CoreProxyOperation, string>> = {
  'images/generations': 'image_generation',
  'images/edits': 'image_edit',
  'alpha/search': 'web_search_query',
  live: 'realtime_session',
  'realtime/calls': 'realtime_session',
};

/** Operations the core admits/settles itself through the wiolett-core/v1 contract. */
const CORE_ADMITTED: ReadonlySet<CoreProxyOperation> = new Set([
  'responses',
  'responses/compact',
  'chat/completions',
  'messages',
  'images/generations',
  'images/edits',
  'alpha/search',
]);

type ProxyRequestBody = string | ArrayBuffer | FormData;

const MAX_CORE_ERROR_BODY_BYTES = 1024 * 1024;
const MAX_CORE_IMAGE_BODY_BYTES = 100 * 1024 * 1024;
const MAX_CODEX_IMAGE_EDIT_IMAGES = 5;
const MAX_CODEX_IMAGE_EDIT_FILE_BYTES = 50 * 1024 * 1024;

function requireAuth(c: Context<AppEnv>): { user: User; tokenId: string } {
  const user = c.get('user');
  const auth = c.get('inferenceAuth');
  if (!user || !auth) throw new InferenceProtocolError(401, 'invalid_api_key', 'Authentication required');
  return { user, tokenId: auth.tokenId };
}

/**
 * Transparent data-plane proxy: Opfield keeps authentication, model access,
 * limits, and accounting authority while the managed core owns provider
 * protocols and credentials (plan T5). Client headers never reach the core;
 * the core only sees its data credential and a freshly signed request context.
 */
@injectable()
export class InferenceCoreProxyService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly bridge: InferenceCoreBridgeService,
    private readonly models: InferenceModelService,
    private readonly routing: InferenceRoutingService,
    private readonly coreAccounting: InferenceCoreAccountingService,
    private readonly legacyAccounting: InferenceAccountingService
  ) {}

  /**
   * Resolve the public model to the core-backed source the request will use:
   * access check, candidate filter, and quota-aware connection selection.
   * Shared by the HTTP proxy and the per-turn WebSocket proxy.
   */
  async resolveTarget(
    user: User,
    publicModelId: string,
    options: { affinityKey?: string; existingThread?: boolean; excludeConnectionIds?: string[] } = {}
  ): Promise<ResolvedCoreTarget> {
    const resolved = await this.models.resolveForUser(user, publicModelId);
    const excluded = new Set(options.excludeConnectionIds ?? []);
    const compatibleSourceIds = resolved.sources
      .filter((source) =>
        sourceSupportsModel(resolved.model, { modalities: source.modalities, capabilities: source.capabilities })
      )
      .map((source) => source.id);
    const candidates = (await this.coreCandidates(resolved.model.id, compatibleSourceIds)).filter(
      (candidate) => !excluded.has(candidate.connection.id)
    );
    assertRoutable(candidates);
    const providerIds = new Set(candidates.map((candidate) => candidate.connection.providerId));
    const singleProviderId = providerIds.size === 1 ? candidates[0]!.connection.providerId : undefined;
    const selection = await this.routing.select({
      ...(singleProviderId ? { providerId: singleProviderId } : {}),
      allowedConnectionIds: candidates.map((row) => row.connection.id),
      upstreamModelByConnection: Object.fromEntries(
        candidates.map((row) => [row.connection.id, row.source.upstreamModelId])
      ),
      ...(options.affinityKey ? { affinityKey: options.affinityKey } : {}),
      existingThread: options.existingThread === true,
    });
    const selected = candidates.find((row) => row.connection.id === selection.connectionId);
    if (!selected?.source.coreAccountId || !selected.source.coreModelId) {
      throw new InferenceProtocolError(503, 'service_unavailable', 'The selected model source is not core-backed');
    }
    return {
      model: resolved.model,
      selected,
      upstreamModel: selected.source.coreModelId,
      coreAccountId: exactCoreAccountId(selected),
      candidateConnectionIds: candidates.map((candidate) => candidate.connection.id),
    };
  }

  /**
   * Codex's built-in image tool sends an endpoint model such as `gpt-image-2`,
   * which intentionally is not a selectable Opfield text model. Select an
   * accessible OpenAI connection through an existing published source for
   * routing/accounting, but leave the endpoint model untouched in the body.
   */
  private async resolveImagesTarget(
    user: User,
    options: { excludeConnectionIds?: string[] } = {}
  ): Promise<ResolvedCoreTarget> {
    const visible = await this.models.listForUser(user);
    const publicModelIds = visible.data.map((model) => model.id);
    if (!publicModelIds.length) throw imageProviderUnavailable();

    const rows = await this.db
      .select({ model: inferenceModels, source: inferenceModelSources, connection: inferenceProviderConnections })
      .from(inferenceModelSources)
      .innerJoin(inferenceModels, eq(inferenceModelSources.modelId, inferenceModels.id))
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .leftJoin(inferenceDiscoveredModels, eq(inferenceModelSources.discoveredModelId, inferenceDiscoveredModels.id))
      .where(
        and(
          inArray(inferenceModels.publicId, publicModelIds),
          eq(inferenceModels.enabled, true),
          eq(inferenceModelSources.enabled, true),
          eq(inferenceProviderConnections.enabled, true),
          isNull(inferenceProviderConnections.deletedAt),
          inArray(inferenceProviderConnections.providerId, ['openai', 'openai-apikey']),
          isNotNull(inferenceModelSources.coreAccountId),
          isNotNull(inferenceModelSources.coreModelId),
          or(isNull(inferenceModelSources.discoveredModelId), eq(inferenceDiscoveredModels.available, true))
        )
      )
      .orderBy(
        asc(inferenceModels.sortOrder),
        asc(inferenceModelSources.priority),
        asc(inferenceProviderConnections.routingOrder)
      );

    const excluded = new Set(options.excludeConnectionIds ?? []);
    const primary = rows.filter((row) => !excluded.has(row.connection.id));
    const providerId = primary.some((row) => row.connection.providerId === 'openai') ? 'openai' : 'openai-apikey';
    const byConnection = new Map<string, (typeof primary)[number]>();
    for (const row of primary) {
      if (row.connection.providerId === providerId && !byConnection.has(row.connection.id)) {
        byConnection.set(row.connection.id, row);
      }
    }
    const candidates = [...byConnection.values()];
    if (!candidates.length) throw imageProviderUnavailable();
    const selection = await this.routing.select({
      providerId,
      allowedConnectionIds: candidates.map((row) => row.connection.id),
      upstreamModelByConnection: Object.fromEntries(
        candidates.map((row) => [row.connection.id, row.source.upstreamModelId])
      ),
      existingThread: false,
    });
    const selected = candidates.find((row) => row.connection.id === selection.connectionId);
    if (!selected?.source.coreAccountId || !selected.source.coreModelId) throw imageProviderUnavailable();
    return {
      model: selected.model,
      selected,
      upstreamModel: selected.source.coreModelId,
      coreAccountId: exactCoreAccountId(selected),
      candidateConnectionIds: candidates.map((candidate) => candidate.connection.id),
    };
  }

  /** Core base URL + data credential as a stable Opfield error when unavailable. */
  async dataPlaneTarget(): Promise<CoreDataPlaneTarget> {
    return this.coreTarget();
  }

  async markAffinityActive(affinityKey: string): Promise<void> {
    await this.routing.markAffinityActive(affinityKey);
  }

  async beginAffinityTurn(affinityKey: string): Promise<() => Promise<void>> {
    return this.routing.beginAffinityTurn(affinityKey);
  }

  async proxy(c: Context<AppEnv>, operation: CoreProxyOperation): Promise<Response> {
    const { user, tokenId } = requireAuth(c);
    const prepared = await this.prepareBody(c, operation);
    const imagesOperation = OPERATION_PROTOCOL[operation] === 'images';
    const resolveOperationTarget = (excludeConnectionIds: string[] = []) =>
      imagesOperation
        ? this.resolveImagesTarget(user, { excludeConnectionIds })
        : this.resolveTarget(user, prepared.publicModelId, {
            ...(prepared.affinityKey ? { affinityKey: prepared.affinityKey } : {}),
            existingThread: prepared.existingThread,
            excludeConnectionIds,
          });
    let resolved = await resolveOperationTarget();
    // Realtime is not admitted by the core; it keeps the legacy fixed-charge
    // accounting at the Opfield edge. Everything else correlates through the
    // request row the core's admission callback references.
    if (OPERATION_PROTOCOL[operation] === 'realtime') {
      const body = prepared.rewrite(resolved.upstreamModel, resolved.model, resolved.selected.source);
      return this.proxyRealtime(
        c,
        operation,
        user.id,
        tokenId,
        resolved.model,
        resolved.selected,
        resolved.upstreamModel,
        body
      );
    }

    const coreAdmitted = CORE_ADMITTED.has(operation);
    // Resolve the managed core before creating an idempotent root row. A
    // missing/degraded core must not leave an unserviceable reserved request.
    const target = await this.coreTarget();
    let rootRequestId: string = randomUUID();
    let fixedApiMicrodollars = 0;
    if (coreAdmitted) {
      fixedApiMicrodollars = await this.fixedCharge(operation, resolved.selected.source, prepared.units);
      rootRequestId = (
        await this.coreAccounting.createCoreRequest({
          userId: user.id,
          tokenId,
          protocol: OPERATION_PROTOCOL[operation],
          operation: requestOperation(operation),
          model: resolved.model,
          source: resolved.selected.source,
          connection: resolved.selected.connection,
          serviceTier: prepared.serviceTier ?? null,
          reasoningEffort: prepared.reasoningEffort ?? null,
          ...(prepared.idempotencyKey ? { idempotencyKey: prepared.idempotencyKey } : {}),
          ...(prepared.affinityKey ? { affinityKey: prepared.affinityKey } : {}),
          ...(fixedApiMicrodollars ? { fixedApiMicrodollars } : {}),
          ...(prepared.isCompaction ? { isCompaction: true } : {}),
        })
      ).requestId;
    }
    // Finalization lives as long as the response stream. Do not capture the
    // prepared body/rewrite closure (potentially hundreds of MB) just for a key.
    const affinityKey = prepared.affinityKey;
    const releaseAffinityTurn = affinityKey ? await this.routing.beginAffinityTurn(affinityKey) : undefined;
    let affinityTurnFinalized = false;
    const finalizeAffinityTurn = affinityKey
      ? async () => {
          if (affinityTurnFinalized) return;
          affinityTurnFinalized = true;
          try {
            await this.routing.markAffinityActive(affinityKey!);
          } finally {
            await releaseAffinityTurn?.();
          }
        }
      : undefined;
    const finalizeRequest = onceAsync(async (outcome, error) => {
      const finalizers: Promise<unknown>[] = [];
      if (coreAdmitted) finalizers.push(this.coreAccounting.finalizeCoreRequest(rootRequestId, outcome, error));
      if (finalizeAffinityTurn) finalizers.push(finalizeAffinityTurn());
      await Promise.allSettled(finalizers);
    });
    const excludedConnectionIds: string[] = [];
    let firstTransportError: InferenceProtocolError | undefined;
    let lastProviderError: InferenceProtocolError | undefined;
    try {
      for (;;) {
        if (excludedConnectionIds.length > 0) {
          resolved = await resolveOperationTarget(excludedConnectionIds).catch((error: unknown) => {
            // Once every alternative is gone, report why the last attempt failed. "No usable
            // capacity" would hide the provider's real answer (auth, quota, dispatch refusal).
            const cause = lastProviderError ?? firstTransportError;
            if (cause && error instanceof InferenceProtocolError && error.code === 'provider_capacity_unavailable') {
              throw cause;
            }
            throw error;
          });
          if (coreAdmitted) {
            fixedApiMicrodollars = await this.fixedCharge(operation, resolved.selected.source, prepared.units);
            await this.coreAccounting.retargetCoreRequest(
              rootRequestId,
              resolved.selected.source,
              resolved.selected.connection,
              fixedApiMicrodollars
            );
          }
        }
        const body = prepared.rewrite(
          imagesOperation ? prepared.publicModelId : resolved.upstreamModel,
          resolved.model,
          resolved.selected.source
        );
        const { claims } = newCoreRequestContext({
          requestLimits: target.requestLimits,
          maxOutputTokens: target.outputLimitSupported ? resolved.model.maxOutputTokens : null,
          tenantUserId: user.id,
          rootRequestId,
          publicModelId: resolved.model.publicId,
          coreAccountId: resolved.coreAccountId,
          coreModelId: resolved.upstreamModel,
          operation: contextOperation(operation),
        });
        // Images create paid, non-idempotent work inside the core. A lost core
        // response is not proof that the upstream generation was never dispatched.
        const allowFailover = coreAdmitted && !imagesOperation && resolved.candidateConnectionIds.length > 1;
        const forwarded = await this.forward(
          c,
          target,
          claims,
          rootRequestId,
          `/v1/${operation}`,
          { method: 'POST', headers: prepared.headers, body },
          allowFailover,
          imagesOperation,
          finalizeRequest,
          {
            wire: streamWire(operation),
            // Images keep the endpoint model the client sent; everything else answers
            // with the core id Opfield sent, which the client must never see.
            modelIds: imagesOperation
              ? null
              : CoreModelIdRewriter.create(resolved.upstreamModel, resolved.model.publicId),
          }
        );
        if (forwarded.kind === 'response') return forwarded.response;
        firstTransportError ??= forwarded.transportError;
        if (forwarded.providerError) lastProviderError = forwarded.providerError;
        excludedConnectionIds.push(resolved.selected.connection.id);
      }
    } catch (error) {
      const cancelled = c.req.raw.signal.aborted || (error instanceof InferenceProtocolError && error.status === 499);
      await finalizeRequest(cancelled ? 'cancelled' : 'failed', error);
      throw error;
    } finally {
      // Sibling closures can share the same V8 context. Explicitly sever the
      // replay closure once HTTP failover ends, even if a stream finalizer
      // still keeps scalar request metadata alive.
      prepared.rewrite = () => '';
    }
  }

  /** Core base URL + data credential, mapped to a stable Opfield error when unavailable. */
  private async coreTarget(): Promise<CoreDataPlaneTarget> {
    try {
      return await this.bridge.dataPlaneTarget();
    } catch {
      throw new InferenceProtocolError(503, 'inference_core_unavailable', 'The inference core is unavailable');
    }
  }

  private async forward(
    c: Context<AppEnv>,
    target: CoreDataPlaneTarget,
    claims: Parameters<typeof coreRequestHeaders>[0],
    requestId: string,
    path: string,
    init: { method: string; headers: Record<string, string>; body: ProxyRequestBody },
    allowFailover = false,
    nonRetryableDispatch = false,
    finalizeRequest: (outcome: 'completed' | 'failed' | 'cancelled', error?: unknown) => Promise<void> = async () =>
      undefined,
    relay: { wire: CoreSseWire; modelIds: CoreModelIdRewriter | null } = { wire: 'responses', modelIds: null }
  ): Promise<
    | { kind: 'response'; response: Response }
    | { kind: 'retry'; transportError?: InferenceProtocolError; providerError?: InferenceProtocolError }
  > {
    const controller = new AbortController();
    let clientGone = false;
    const signal = c.req.raw.signal;
    const abort = () => {
      clientGone = true;
      controller.abort(signal.reason);
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    const finishRequest: typeof finalizeRequest = (outcome, error) => {
      cleanup();
      return finalizeRequest(outcome, error);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    let upstream: Response;
    try {
      upstream = await fetch(`${target.baseUrl}${path}`, {
        method: init.method,
        headers: { ...init.headers, ...coreRequestHeaders(claims, target.credential) },
        body: init.body,
        signal: controller.signal,
        duplex: 'half',
      });
    } catch {
      cleanup();
      if (allowFailover && !clientGone)
        return {
          kind: 'retry',
          transportError: new InferenceProtocolError(
            503,
            'inference_core_unavailable',
            'The inference core is unavailable'
          ),
        };
      if (clientGone) throw new InferenceProtocolError(499, 'client_cancelled', 'Client disconnected');
      if (nonRetryableDispatch) {
        throw new InferenceProtocolError(
          409,
          'image_generation_result_unknown',
          'Image generation result is unknown; automatic retry is disabled to avoid duplicate paid work'
        );
      }
      throw new InferenceProtocolError(503, 'inference_core_unavailable', 'The inference core is unavailable');
    }
    const status = upstream.status;
    if (allowFailover && (await shouldFailOverCoreResponse(upstream))) {
      cleanup();
      const providerError = await coreResponseProviderError(upstream);
      await upstream.body?.cancel().catch(() => undefined);
      return { kind: 'retry', providerError };
    }
    if (nonRetryableDispatch) {
      const headers = publicResponseHeaders(upstream.headers);
      if (!upstream.body) {
        void finishRequest(status < 400 ? 'completed' : 'failed');
        if (status >= 500) return { kind: 'response', response: ambiguousImageResponse() };
        return { kind: 'response', response: new Response(null, { status, headers }) };
      }
      try {
        const body = await readBoundedCoreBody(
          upstream.body,
          MAX_CORE_IMAGE_BODY_BYTES,
          'Inference core image response exceeded the safe body limit'
        );
        void finishRequest(status < 400 ? 'completed' : 'failed');
        if (status >= 500) return { kind: 'response', response: ambiguousImageResponse() };
        return { kind: 'response', response: new Response(body, { status, headers }) };
      } catch (error) {
        if (clientGone) {
          const mapped = new InferenceProtocolError(499, 'client_cancelled', 'Client disconnected');
          void finishRequest('cancelled', mapped);
          throw mapped;
        }
        void finishRequest('failed', error);
        return { kind: 'response', response: ambiguousImageResponse() };
      }
    }
    if (status >= 400 && upstream.body) {
      const headers = publicResponseHeaders(upstream.headers);
      try {
        const body = await readBoundedCoreErrorBody(upstream.body);
        void finishRequest('failed');
        return { kind: 'response', response: new Response(body, { status, headers }) };
      } catch (error) {
        if (clientGone) {
          const mapped = new InferenceProtocolError(499, 'client_cancelled', 'Client disconnected');
          void finishRequest('cancelled', mapped);
          throw mapped;
        }
        void finishRequest('failed', error);
        return {
          kind: 'response',
          response: Response.json(
            {
              error: {
                type: 'server_error',
                code: 'inference_core_stream_reset',
                message: 'The inference core error response ended before it could be read',
              },
            },
            { status: 502 }
          ),
        };
      }
    }
    if (!upstream.body) {
      void finishRequest(status < 400 ? 'completed' : 'failed');
      return {
        kind: 'response',
        response: new Response(null, { status, headers: publicResponseHeaders(upstream.headers) }),
      };
    }
    const headers = publicResponseHeaders(upstream.headers);
    const stream = relayCoreResponseBody(upstream.body, {
      requestId,
      contentType: headers.get('content-type') ?? '',
      wire: relay.wire,
      modelIds: relay.modelIds,
      abortUpstream: (reason) => controller.abort(reason),
      clientGone: () => clientGone,
      finalize: (outcome, error) => void finishRequest(outcome, error),
      upstreamStatus: status,
    });
    return {
      kind: 'response',
      response: new Response(stream, { status, headers }),
    };
  }

  // -------------------------------------------------------------- realtime
  // The core does not admit realtime calls; keep the legacy fixed session
  // charge at the Opfield edge and release it when the upstream call ends.

  private async proxyRealtime(
    c: Context<AppEnv>,
    operation: CoreProxyOperation,
    userId: string,
    tokenId: string,
    model: Parameters<InferenceAccountingService['admitExtended']>[0]['model'],
    selected: SourceCandidate,
    upstreamModel: string,
    body: ProxyRequestBody
  ): Promise<Response> {
    const admission = await this.legacyAccounting.admitExtended({
      userId,
      tokenId,
      protocol: 'realtime',
      operation: 'realtime_call',
      model,
      source: selected.source,
      connection: selected.connection,
      priceKey: FIXED_PRICE_KEYS[operation]!,
      units: 1,
    });
    const target = await this.coreTarget();
    const { claims } = newCoreRequestContext({
      requestLimits: target.requestLimits,
      tenantUserId: userId,
      rootRequestId: admission.requestId,
      publicModelId: model.publicId,
      coreAccountId: exactCoreAccountId(selected),
      coreModelId: upstreamModel,
      operation: 'realtime/calls',
    });
    try {
      await this.legacyAccounting.markDispatched(admission);
      const query = `?model=${encodeURIComponent(upstreamModel)}`;
      const upstream = await fetch(`${target.baseUrl}/v1/${operation === 'live' ? 'live' : 'realtime/calls'}${query}`, {
        method: 'POST',
        headers: {
          'content-type': c.req.header('Content-Type') ?? 'application/sdp',
          'x-inference-model': upstreamModel,
          ...coreRequestHeaders(claims, target.credential),
        },
        body,
        signal: c.req.raw.signal,
        duplex: 'half',
      });
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const piped = upstream.body ? upstream.body.pipeTo(stream.writable) : null;
      piped?.then(
        () => void this.legacyAccounting.settle(admission, zeroUsage(), true).catch(() => undefined),
        () => void this.legacyAccounting.settle(admission, zeroUsage(), true).catch(() => undefined)
      );
      if (!piped) await this.legacyAccounting.settle(admission, zeroUsage(), true);
      return new Response(piped ? stream.readable : null, {
        status: upstream.status,
        headers: publicResponseHeaders(upstream.headers),
      });
    } catch (error) {
      await this.legacyAccounting.fail(admission, error, false);
      if (error instanceof InferenceProtocolError) throw error;
      throw new InferenceProtocolError(503, 'inference_core_unavailable', 'The inference core is unavailable');
    }
  }

  // ----------------------------------------------------------- preparation

  private async prepareBody(
    c: Context<AppEnv>,
    operation: CoreProxyOperation
  ): Promise<{
    publicModelId: string;
    units: number;
    headers: Record<string, string>;
    serviceTier?: string;
    reasoningEffort?: string;
    idempotencyKey?: string;
    affinityKey?: string;
    isCompaction: boolean;
    existingThread: boolean;
    rewrite: (
      upstreamModel: string,
      model: { reasoningEfforts: string[]; defaultReasoningEffort: string | null },
      source: SourceCandidate['source']
    ) => ProxyRequestBody;
  }> {
    if (operation === 'images/edits') {
      if (isJsonContentType(c.req.header('content-type'))) {
        const body = await readJsonObject(c);
        const units = validateCodexImageEditBody(body);
        const model = requiredModel(body.model);
        return {
          publicModelId: model,
          units,
          headers: { 'content-type': 'application/json' },
          isCompaction: false,
          existingThread: false,
          rewrite: (upstreamModel) => JSON.stringify({ ...body, model: upstreamModel }),
        };
      }
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        throw new InferenceProtocolError(
          400,
          'invalid_request_error',
          'Image edits require multipart form data or a Codex JSON image edit body'
        );
      }
      const units = positiveUnits(Number(form.get('n') ?? 1));
      const model = requiredModel(form.get('model'));
      return {
        publicModelId: model,
        units,
        headers: {},
        isCompaction: false,
        existingThread: false,
        rewrite: (upstreamModel) => {
          const upstream = new FormData();
          for (const [key, value] of form.entries()) upstream.append(key, value);
          upstream.set('model', upstreamModel);
          return upstream;
        },
      };
    }
    if (operation === 'live' || operation === 'realtime/calls') {
      const rawBody = await c.req.arrayBuffer();
      const model = requiredModel(c.req.query('model') ?? c.req.header('x-inference-model'));
      return {
        publicModelId: model,
        units: 1,
        headers: {}, // realtime builds its own headers in proxyRealtime
        isCompaction: false,
        existingThread: false,
        rewrite: () => rawBody,
      };
    }
    const body = await readJsonObject(c);
    const model = requiredModel(body.model);
    const units = operation === 'images/generations' ? positiveUnits(Number(body.n ?? 1)) : 1;
    // Anthropic Messages carries effort in `output_config.effort`; the OpenAI-style
    // `reasoning`/`reasoning_effort` fields are not part of that wire.
    const isMessages = operation === 'messages' || operation === 'messages/count_tokens';
    const outputConfig =
      body.output_config && typeof body.output_config === 'object' && !Array.isArray(body.output_config)
        ? (body.output_config as Record<string, unknown>)
        : undefined;
    const reasoningEffort = isMessages
      ? outputConfig?.effort
      : ((body.reasoning && typeof body.reasoning === 'object'
          ? (body.reasoning as Record<string, unknown>).effort
          : undefined) ?? body.reasoning_effort);
    return {
      publicModelId: model,
      units,
      headers: { 'content-type': 'application/json' },
      ...(typeof body.service_tier === 'string' ? { serviceTier: body.service_tier } : {}),
      ...(typeof reasoningEffort === 'string' ? { reasoningEffort } : {}),
      ...(typeof body.idempotency_key === 'string' ? { idempotencyKey: body.idempotency_key } : {}),
      ...(typeof body.prompt_cache_key === 'string' ? { affinityKey: body.prompt_cache_key } : {}),
      isCompaction: operation === 'responses/compact' || hasCompactionTrigger(body.input),
      existingThread: typeof body.previous_response_id === 'string',
      rewrite: (upstreamModel, resolvedModel, source) => {
        const next: Record<string, unknown> = { ...body, model: upstreamModel };
        if (isMessages) {
          // Only translate an effort the client actually sent: a model default must not
          // override the client's own `thinking` configuration on this wire.
          if (typeof reasoningEffort === 'string') {
            const mappedMessages = mapReasoningEffort(
              reasoningEffort,
              resolvedModel.defaultReasoningEffort,
              resolvedModel.reasoningEfforts,
              source.reasoningEffortMap
            );
            if (mappedMessages.upstreamEffort) {
              next.output_config = { ...outputConfig, effort: mappedMessages.upstreamEffort };
            }
          }
          return JSON.stringify(next);
        }
        const mapped = mapReasoningEffort(
          typeof reasoningEffort === 'string' ? reasoningEffort : undefined,
          resolvedModel.defaultReasoningEffort,
          resolvedModel.reasoningEfforts,
          source.reasoningEffortMap
        );
        if (mapped.upstreamEffort) {
          if (body.reasoning && typeof body.reasoning === 'object') {
            next.reasoning = { ...(body.reasoning as Record<string, unknown>), effort: mapped.upstreamEffort };
          } else if (typeof body.reasoning_effort === 'string') {
            next.reasoning_effort = mapped.upstreamEffort;
          } else if (operation === 'responses' || operation === 'responses/compact') {
            next.reasoning = { effort: mapped.upstreamEffort };
          } else {
            next.reasoning_effort = mapped.upstreamEffort;
          }
        }
        return JSON.stringify(next);
      },
    };
  }

  /** Core-backed, enabled, operation-capable sources joined with their connections. */
  private async coreCandidates(modelId: string, allowedSourceIds: string[]): Promise<SourceCandidate[]> {
    if (!allowedSourceIds.length) return [];
    return this.db
      .select({ source: inferenceModelSources, connection: inferenceProviderConnections })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .where(
        and(
          eq(inferenceModelSources.modelId, modelId),
          inArray(inferenceModelSources.id, allowedSourceIds),
          eq(inferenceModelSources.enabled, true),
          isNotNull(inferenceModelSources.coreAccountId),
          eq(inferenceProviderConnections.enabled, true),
          isNull(inferenceProviderConnections.deletedAt)
        )
      )
      .orderBy(asc(inferenceModelSources.priority), asc(inferenceProviderConnections.routingOrder));
  }

  /** Fixed per-call charge for operations the core settles without token usage. */
  private async fixedCharge(
    operation: CoreProxyOperation,
    source: typeof inferenceModelSources.$inferSelect,
    units: number
  ): Promise<number> {
    const priceKey = FIXED_PRICE_KEYS[operation];
    if (!priceKey) return 0;
    if (source.sourceType === 'subscription') return 0;
    const pricing = await this.db.query.inferencePricingSnapshots.findFirst({
      where: eq(inferencePricingSnapshots.sourceId, source.id),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });
    const amount = unitCharge(pricing ?? null, priceKey, units);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new InferenceProtocolError(503, 'pricing_unavailable', `API pricing for ${priceKey} is unavailable`);
    }
    return amount;
  }
}

async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  let decoded: Uint8Array;
  try {
    // Hono's arrayBuffer() caches the entire compressed input on the request
    // context. This one-shot data plane only needs the decoded object.
    const raw = new Uint8Array(await c.req.raw.arrayBuffer());
    decoded = decodeRequestBody(raw, c.req.header('content-encoding'));
  } catch (error) {
    if (error instanceof InferenceProtocolError) throw error;
    throw new InferenceProtocolError(400, 'invalid_request_error', 'Request body compression is invalid');
  }

  try {
    const value = JSON.parse(new TextDecoder().decode(decoded)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'Request body must be a JSON object');
  }
}

function isJsonContentType(contentType: string | undefined): boolean {
  const mediaType = (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

function validateCodexImageEditBody(body: Record<string, unknown>): number {
  const images = body.images;
  if (!Array.isArray(images) || images.length < 1 || images.length > MAX_CODEX_IMAGE_EDIT_IMAGES) {
    throw new InferenceProtocolError(
      400,
      'invalid_request_error',
      `images must contain between 1 and ${MAX_CODEX_IMAGE_EDIT_IMAGES} items`
    );
  }

  images.forEach((image, index) => {
    if (!image || typeof image !== 'object' || Array.isArray(image)) {
      throw new InferenceProtocolError(400, 'invalid_request_error', `images[${index}] must be an object`);
    }
    const imageUrl = (image as Record<string, unknown>).image_url;
    if (typeof imageUrl !== 'string') {
      throw new InferenceProtocolError(400, 'invalid_request_error', `images[${index}].image_url is required`);
    }
    decodeCodexImageDataUrl(imageUrl, index);
  });

  requiredModel(body.model);
  requiredImageEditString(body.prompt, 'prompt');
  for (const field of ['background', 'quality', 'size'] as const) {
    if (body[field] !== undefined) requiredImageEditString(body[field], field);
  }
  const units = positiveUnits(Number(body.n ?? 1));
  return units;
}

function requiredImageEditString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InferenceProtocolError(400, 'invalid_request_error', `${field} must be a non-empty string`);
  }
  return value;
}

function decodeCodexImageDataUrl(
  value: string,
  index: number
): { bytes: Uint8Array<ArrayBuffer>; extension: 'jpg' | 'png' | 'webp'; mimeType: string } {
  const match = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([a-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) {
    throw new InferenceProtocolError(
      400,
      'invalid_request_error',
      `images[${index}].image_url must be a base64 PNG, JPEG, or WebP data URL`
    );
  }

  const mimeType = match[1]!.toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1]!.toLowerCase();
  const encoded = match[2]!;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedBytes = Math.floor((encoded.length * 3) / 4) - padding;
  if (decodedBytes < 1 || decodedBytes > MAX_CODEX_IMAGE_EDIT_FILE_BYTES) {
    throw new InferenceProtocolError(
      400,
      'invalid_request_error',
      `images[${index}] must be between 1 byte and ${MAX_CODEX_IMAGE_EDIT_FILE_BYTES} bytes`
    );
  }

  const buffer = Buffer.from(encoded, 'base64');
  if (
    buffer.byteLength !== decodedBytes ||
    buffer.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')
  ) {
    throw new InferenceProtocolError(
      400,
      'invalid_request_error',
      `images[${index}].image_url contains invalid base64`
    );
  }
  const bytes = Uint8Array.from(buffer);
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  return { bytes, extension, mimeType };
}

function decodeRequestBody(raw: Uint8Array, contentEncoding: string | undefined): Uint8Array {
  const maxOutputLength = getEnvironmentSettingsSnapshot().requestLimits.inferenceHttpBodyMaxBytes;
  if (raw.byteLength > maxOutputLength)
    throw new InferenceProtocolError(413, 'request_too_large', 'Request body is too large');
  const encoding = (contentEncoding ?? '').trim().toLowerCase();
  if (!encoding || encoding === 'identity') return raw;
  if (encoding.includes(',')) {
    throw new InferenceProtocolError(400, 'invalid_request_error', `Unsupported content-encoding: ${encoding}`);
  }

  const input = raw as Uint8Array<ArrayBuffer>;
  const options = { maxOutputLength };
  try {
    if (encoding === 'zstd') return zstdDecompressSync(input, options);
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(input, options);
    if (encoding === 'deflate') {
      try {
        return inflateSync(input, options);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw error;
        return inflateRawSync(input, options);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new InferenceProtocolError(413, 'request_too_large', 'Decompressed request body is too large');
    }
    throw error;
  }

  throw new InferenceProtocolError(400, 'invalid_request_error', `Unsupported content-encoding: ${encoding}`);
}

function exactCoreAccountId(selected: SourceCandidate): string {
  const metadataAccountId = selected.connection.metadata?.[CORE_ACCOUNT_METADATA_KEY];
  if (selected.connection.authType === 'oauth') {
    if (typeof metadataAccountId !== 'string' || !metadataAccountId) {
      throw new InferenceProtocolError(
        503,
        'core_account_unavailable',
        'The selected OAuth account is not linked to the core'
      );
    }
    return metadataAccountId;
  }
  if (!selected.source.coreAccountId) {
    throw new InferenceProtocolError(503, 'core_account_unavailable', 'The selected account is not linked to the core');
  }
  return selected.source.coreAccountId;
}

export async function shouldFailOverCoreResponse(response: Response): Promise<boolean> {
  if (![401, 408, 409, 429, 502, 503, 504].includes(response.status)) return false;
  return canFailOver(await coreResponseProviderError(response), false);
}

/** The provider failure a core error response describes, keeping the core's code and message. */
async function coreResponseProviderError(response: Response): Promise<InferenceProtocolError> {
  let code = 'provider_unavailable';
  let message = 'The selected provider attempt failed';
  try {
    const body = (await response.clone().json()) as {
      code?: unknown;
      message?: unknown;
      error?: { code?: unknown; type?: unknown; message?: unknown };
    };
    const candidate = body.error?.code ?? body.error?.type ?? body.code;
    if (typeof candidate === 'string' && candidate) code = candidate;
    const text = body.error?.message ?? body.message;
    if (typeof text === 'string' && text.trim()) message = text.trim().slice(0, 500);
  } catch {
    // Status remains sufficient for transport/upstream failures with a non-JSON body.
  }
  const status = [401, 409, 429, 502].includes(response.status) ? (response.status as 401 | 409 | 429 | 502) : 503;
  return new InferenceProtocolError(status, code, message);
}

function contextOperation(operation: CoreProxyOperation): string {
  switch (operation) {
    case 'chat/completions':
      return 'chat_completions';
    case 'messages':
    case 'messages/count_tokens':
      return 'messages';
    case 'images/generations':
    case 'images/edits':
      return 'images';
    case 'alpha/search':
      return 'search';
    default:
      return operation;
  }
}

/** The wire a relayed stream speaks, which decides how a finished stream ends. */
function streamWire(operation: CoreProxyOperation): CoreSseWire {
  if (operation === 'chat/completions') return 'chat_completions';
  if (operation === 'messages' || operation === 'messages/count_tokens') return 'messages';
  return 'responses';
}

function requestOperation(operation: CoreProxyOperation): string {
  switch (operation) {
    case 'images/generations':
      return 'image_generation';
    case 'images/edits':
      return 'image_edit';
    case 'alpha/search':
      return 'search';
    case 'chat/completions':
      return 'chat_completions';
    default:
      return operation;
  }
}

function assertRoutable(candidates: SourceCandidate[]): void {
  const first = candidates[0];
  if (!first) {
    throw new InferenceProtocolError(
      503,
      'service_unavailable',
      'Inference is not configured yet; connect and publish a model first'
    );
  }
}

function imageProviderUnavailable(): InferenceProtocolError {
  return new InferenceProtocolError(
    503,
    'image_provider_unavailable',
    'No accessible OpenAI image provider is available'
  );
}

function requiredModel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'model is required');
  }
  return value.trim();
}

function positiveUnits(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'n must be an integer between 1 and 100');
  }
  return value;
}

function hasCompactionTrigger(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  return input.some(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === 'compaction_trigger'
  );
}

async function readBoundedCoreErrorBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return readBoundedCoreBody(
    body,
    MAX_CORE_ERROR_BODY_BYTES,
    'Inference core error response exceeded the safe body limit'
  );
}

async function readBoundedCoreBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  limitMessage: string
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('core response body exceeded safe limit').catch(() => undefined);
        throw new Error(limitMessage);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function ambiguousImageResponse(): Response {
  return Response.json(
    {
      error: {
        type: 'server_error',
        code: 'image_generation_result_unknown',
        message: 'Image generation result is unknown; automatic retry is disabled to avoid duplicate paid work',
      },
    },
    { status: 409 }
  );
}

function publicResponseHeaders(headers: Headers): Headers {
  const output = new Headers({ 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  for (const name of ['content-type', 'content-disposition']) {
    const value = headers.get(name);
    if (value) output.set(name, value);
  }
  return output;
}

function zeroUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimated: false,
  };
}

function onceAsync(
  fn: (outcome: 'completed' | 'failed' | 'cancelled', error?: unknown) => Promise<void>
): (outcome: 'completed' | 'failed' | 'cancelled', error?: unknown) => Promise<void> {
  let result: Promise<void> | undefined;
  return (outcome: 'completed' | 'failed' | 'cancelled', error?: unknown) => {
    result ??= fn(outcome, error);
    return result;
  };
}

export const __testOnly = {
  contextOperation,
  requestOperation,
  assertRoutable,
  publicResponseHeaders,
  shouldFailOverCoreResponse,
};
