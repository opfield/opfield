import { randomUUID } from 'node:crypto';
import type { WSContext } from 'hono/ws';
import { container, TOKENS } from '@/container.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { createChildLogger } from '@/lib/logger.js';
import { canUseAI } from '@/lib/permissions.js';
import { withRateLimitRedisTimeout } from '@/lib/rate-limit-timeout.js';
import { AppError } from '@/middleware/error-handler.js';
import { runWithAuditRequestContext } from '@/modules/audit/audit-request-context.js';
import {
  type LiveSessionUser,
  requiresSessionMfaReauthentication,
  resolveLiveSessionUser,
} from '@/modules/auth/live-session-user.js';
import { isDemoRealtimeCapabilityAllowed } from '@/modules/demo/demo-mode.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import { AISettingsService } from './ai.settings.service.js';
import type { WSClientMessage, WSServerMessage } from './ai.types.js';
import { AIPlanService } from './ai-plan.service.js';
import { AIProviderRuntimeService } from './ai-provider-runtime.service.js';
import { AIRunService, aiUserConversationsChangedChannel } from './ai-run.service.js';

const logger = createChildLogger('AI-WebSocket');
const RATE_LIMIT_PIPELINE_RESULT_COUNT = 4;
const CONVERSATION_TITLE_TIMEOUT_MS = 30_000;

type RedisClient = ReturnType<typeof import('@/services/cache.service.js').createRedisClient>;

interface WSConnectionState {
  user: User | null;
  impersonation: LiveSessionUser['impersonation'] | null;
  sessionId: string | null;
  authenticated: boolean;
  subscribedConversationIds: Set<string>;
  runtimeUnsubscribe: (() => void) | null;
  keepaliveInterval: ReturnType<typeof setInterval> | null;
}

function send(ws: WSContext, msg: WSServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Connection may be closed
  }
}

// License denials carry plan metadata the client needs to open the upgrade
// dialog. Details of every other error stay server-side.
const LICENSE_ERROR_CODES = new Set([
  'LICENSE_ENTITLEMENT_REQUIRED',
  'LICENSE_QUOTA_EXCEEDED',
  'COMMERCIAL_MODULE_UNAVAILABLE',
]);

function sendCommandError(
  ws: WSContext,
  msg: WSClientMessage,
  error: unknown,
  fallbackMessage = 'Command failed'
): void {
  if (error instanceof AppError) {
    send(ws, {
      type: 'command.error',
      commandType: msg.type,
      clientCommandId: getClientCommandId(msg),
      conversationId: getConversationId(msg),
      runId: getRunId(msg),
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
      ...(LICENSE_ERROR_CODES.has(error.code) && error.details !== undefined ? { details: error.details } : {}),
    });
    return;
  }

  logger.error('AI websocket command failed', {
    commandType: msg.type,
    error: error instanceof Error ? error.message : String(error),
  });
  send(ws, {
    type: 'command.error',
    commandType: msg.type,
    clientCommandId: getClientCommandId(msg),
    conversationId: getConversationId(msg),
    runId: getRunId(msg),
    code: 'AI_COMMAND_FAILED',
    message: error instanceof Error ? error.message : fallbackMessage,
    statusCode: 500,
  });
}

function getClientCommandId(msg: WSClientMessage): string | undefined {
  return 'clientCommandId' in msg ? msg.clientCommandId : undefined;
}

function getConversationId(msg: WSClientMessage): string | undefined {
  return 'conversationId' in msg ? msg.conversationId : undefined;
}

function getRunId(msg: WSClientMessage): string | undefined {
  return 'runId' in msg ? msg.runId : undefined;
}

function userVisibleContent(content: string): string {
  return content
    .replace(/<system-instruction>[\s\S]*?<\/system-instruction>\s*/gi, '')
    .trim()
    .replace(/\s+/g, ' ');
}

async function sendConversationSnapshot(ws: WSContext, userId: string, conversationId: string) {
  const runService = container.resolve(AIRunService);
  const snapshot = await runService.getConversationSnapshot(userId, conversationId);
  if (!snapshot) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');
  send(ws, { type: 'conversation.snapshot', conversationId, snapshot });
  return snapshot;
}

function sendConversationSnapshotBestEffort(ws: WSContext, userId: string, conversationId: string): void {
  void sendConversationSnapshot(ws, userId, conversationId).catch((error) => {
    logger.warn('Failed to publish AI conversation snapshot after committed command', {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function revisionPayload(snapshot: { revision?: number }): { revision?: number } {
  return typeof snapshot.revision === 'number' ? { revision: snapshot.revision } : {};
}

async function resumeResolvedCredentialContinuation(
  user: User,
  snapshot: Awaited<ReturnType<AIRunService['getConversationSnapshot']>>
) {
  if (!snapshot) return;
  const activeRun = snapshot.runtime.activeRun;
  if (activeRun?.status !== 'waiting_for_credential' || snapshot.runtime.pendingCredentialChallenge) return;
  await container.resolve(AIRunService).resumeResolvedCredentialContinuation(user, {
    conversationId: activeRun.conversationId,
    runId: activeRun.id,
  });
}

function subscribeToUserRuntime(ws: WSContext, state: WSConnectionState, userId: string): void {
  if (state.runtimeUnsubscribe) return;
  const eventBus = container.resolve(EventBusService);
  state.runtimeUnsubscribe = eventBus.subscribe(aiUserConversationsChangedChannel(userId), (payload) => {
    const event = payload as {
      type?: string;
      userId?: string;
      conversationId?: string;
      runId?: string;
      content?: string;
      version?: number;
      invalidatedStores?: string[];
      challenge?: Extract<WSServerMessage, { type: 'credential.required' }>['challenge'];
      action?: Record<string, unknown>;
    };
    if (event.userId !== userId || typeof event.conversationId !== 'string') return;
    if (event.type === 'credential.required') {
      if (
        state.subscribedConversationIds.has(event.conversationId) &&
        typeof event.runId === 'string' &&
        event.challenge
      ) {
        void sendConversationSnapshot(ws, userId, event.conversationId)
          .then((snapshot) => {
            send(ws, {
              type: 'credential.required',
              conversationId: event.conversationId!,
              runId: event.runId!,
              challenge: event.challenge!,
              ...revisionPayload(snapshot),
            });
          })
          .catch((error) => {
            logger.warn('Failed to send AI credential state', {
              conversationId: event.conversationId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      return;
    }
    if (event.type === 'client.action') {
      if (
        state.subscribedConversationIds.has(event.conversationId) &&
        typeof event.runId === 'string' &&
        event.action
      ) {
        send(ws, {
          type: 'client.action',
          conversationId: event.conversationId,
          runId: event.runId,
          action: event.action,
        });
      }
      return;
    }
    if (event.type === 'assistant.comment_done') {
      if (state.subscribedConversationIds.has(event.conversationId) && typeof event.runId === 'string') {
        send(ws, {
          type: 'assistant.comment_done',
          conversationId: event.conversationId,
          runId: event.runId,
        });
      }
      return;
    }
    if (event.type === 'assistant.delta' || event.type === 'assistant.comment_delta') {
      if (
        state.subscribedConversationIds.has(event.conversationId) &&
        typeof event.runId === 'string' &&
        typeof event.content === 'string' &&
        typeof event.version === 'number'
      ) {
        send(ws, {
          type: event.type,
          conversationId: event.conversationId,
          runId: event.runId,
          content: event.content,
          version: event.version,
        });
      }
      return;
    }
    void sendConversationSnapshot(ws, userId, event.conversationId)
      .then((snapshot) => {
        if (snapshot.runtime.activePlan) {
          send(ws, {
            type: 'plan.status_changed',
            conversationId: event.conversationId!,
            plan: snapshot.runtime.activePlan,
            ...revisionPayload(snapshot),
          });
        }
        if (event.invalidatedStores?.length) {
          send(ws, {
            type: 'stores.invalidated',
            conversationId: event.conversationId!,
            stores: event.invalidatedStores,
            ...revisionPayload(snapshot),
          });
        }
      })
      .catch((error) => {
        logger.warn('Failed to send AI conversation snapshot from event', {
          conversationId: event.conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

function unsubscribeFromUserRuntime(state: WSConnectionState): void {
  state.runtimeUnsubscribe?.();
  state.runtimeUnsubscribe = null;
}

async function authenticateFromSession(sessionId: string): Promise<LiveSessionUser | null> {
  const result = await resolveLiveSessionUser(sessionId);
  if (
    !result ||
    result.session.purpose === 'setup' ||
    (result.impersonation && !result.impersonation.authorized) ||
    (!result.impersonation && requiresSessionMfaReauthentication(result.user, result.session))
  ) {
    return null;
  }
  return result;
}

interface AIRateLimitResult {
  allowed: boolean;
  retryAfter: number;
  unavailable?: boolean;
}

function getRateLimitCount(results: unknown): number {
  if (!Array.isArray(results)) throw new Error('Redis pipeline returned no results');
  if (results.length !== RATE_LIMIT_PIPELINE_RESULT_COUNT) {
    throw new Error('Redis pipeline returned incomplete results');
  }
  for (const result of results) {
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error('Redis pipeline returned malformed result');
    }
    const [error] = result;
    if (error) throw error;
  }
  const count = results[1]?.[1];
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new Error('Redis pipeline returned invalid request count');
  }
  return count;
}

async function checkRateLimit(userId: string): Promise<AIRateLimitResult> {
  const settingsService = container.resolve(AISettingsService);
  const config = await settingsService.getConfig();
  if (config.providerType === 'opfield_inference') {
    return { allowed: true, retryAfter: 0 };
  }

  const key = `ai-ratelimit:${userId}`;
  const now = Date.now();
  const windowMs = config.rateLimitWindowSeconds * 1000;
  const windowStart = now - windowMs;

  try {
    const redis = container.resolve<RedisClient>(TOKENS.RedisClient);
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zcard(key);
    pipeline.zadd(key, now, `${now}-${randomUUID()}`);
    pipeline.expire(key, config.rateLimitWindowSeconds + 1);

    const results = await withRateLimitRedisTimeout(pipeline.exec());
    const requestCount = getRateLimitCount(results);

    if (requestCount >= config.rateLimitMax) {
      return { allowed: false, retryAfter: config.rateLimitWindowSeconds };
    }
    return { allowed: true, retryAfter: 0 };
  } catch (error) {
    logger.warn('AI rate limiter unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: false, retryAfter: 0, unavailable: true };
  }
}

// WeakMap to store per-connection state
const wsStates = new WeakMap<WSContext, WSConnectionState>();

export function createWSHandlers() {
  return {
    onOpen(_event: Event, ws: WSContext) {
      const state: WSConnectionState = {
        user: null,
        impersonation: null,
        sessionId: null,
        authenticated: false,
        subscribedConversationIds: new Set(),
        runtimeUnsubscribe: null,
        keepaliveInterval: null,
      };

      wsStates.set(ws, state);

      state.keepaliveInterval = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: 'pong' }));
        } catch {
          if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
        }
      }, 30_000);
    },

    async onMessage(event: MessageEvent, ws: WSContext) {
      const state = wsStates.get(ws);
      if (!state) return;

      return runWithAuditRequestContext(
        {
          impersonation: state.impersonation
            ? {
                actorUserId: state.impersonation.actor.id,
                subjectUserId: state.impersonation.subject.id,
                subjectEmail: state.impersonation.subject.email,
                subjectName: state.impersonation.subject.name,
              }
            : undefined,
        },
        async () => {
          let raw: Record<string, unknown>;
          let msg: WSClientMessage;
          try {
            const parsed = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
            if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
              send(ws, { type: 'error', requestId: '', message: 'Invalid message format' });
              return;
            }
            raw = parsed as Record<string, unknown>;
            msg = raw as WSClientMessage;
          } catch {
            send(ws, { type: 'error', requestId: '', message: 'Invalid JSON' });
            return;
          }

          if (msg.type === 'ping') {
            send(ws, { type: 'pong' });
            return;
          }

          if (!state.authenticated) {
            send(ws, { type: 'auth_error', message: 'Not authenticated' });
            return;
          }

          // Re-validate session on each message to catch role changes
          if (state.sessionId) {
            const freshIdentity = await authenticateFromSession(state.sessionId);
            const freshUser = freshIdentity?.user;
            if (
              !freshIdentity ||
              !freshUser ||
              freshUser.isBlocked ||
              !isDemoRealtimeCapabilityAllowed(freshUser, freshIdentity.effectiveScopes, 'ai:workspace') ||
              !canUseAI(freshUser.scopes)
            ) {
              send(ws, { type: 'auth_error', message: 'Session expired or role changed' });
              try {
                ws.close();
              } catch {
                /* ignore */
              }
              return;
            }
            state.user = freshUser;
            state.impersonation = freshIdentity.impersonation ?? null;
          }

          const user = state.user!;

          if (msg.type === 'conversation.subscribe') {
            try {
              state.subscribedConversationIds.add(msg.conversationId);
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
              });
              const snapshot = await sendConversationSnapshot(ws, user.id, msg.conversationId);
              await resumeResolvedCredentialContinuation(user, snapshot);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to subscribe to conversation');
            }
            return;
          }

          if (msg.type === 'conversation.unsubscribe') {
            state.subscribedConversationIds.delete(msg.conversationId);
            send(ws, { type: 'command.ack', commandType: msg.type, conversationId: msg.conversationId });
            return;
          }

          if (msg.type === 'conversation.sync') {
            try {
              const snapshot = await sendConversationSnapshot(ws, user.id, msg.conversationId);
              await resumeResolvedCredentialContinuation(user, snapshot);
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
              });
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to sync conversation');
            }
            return;
          }

          if (msg.type === 'conversation.send_message') {
            try {
              const content = msg.content.trim();
              if (!content && !msg.attachments?.length) {
                throw new AppError(400, 'AI_MESSAGE_REQUIRED', 'Message content is required');
              }
              const model = msg.model?.trim();
              if (model && model.length > 255) {
                throw new AppError(400, 'AI_MODEL_INVALID', 'AI model identifier is too long');
              }
              const reasoningEffort = msg.reasoningEffort?.trim();
              if (reasoningEffort && reasoningEffort.length > 64) {
                throw new AppError(400, 'AI_REASONING_EFFORT_INVALID', 'AI reasoning effort is too long');
              }

              const rateCheck = await checkRateLimit(user.id);
              if (!rateCheck.allowed) {
                const code = rateCheck.unavailable ? 'RATE_LIMIT_UNAVAILABLE' : 'RATE_LIMITED';
                throw new AppError(
                  rateCheck.unavailable ? 503 : 429,
                  code,
                  rateCheck.unavailable ? 'Opfield is temporarily unavailable' : 'AI rate limit exceeded',
                  rateCheck.unavailable ? undefined : { retryAfter: rateCheck.retryAfter }
                );
              }

              const providerRuntime = container.resolve(AIProviderRuntimeService);
              if (msg.attachments?.length) {
                const providerStatus = await providerRuntime.statusForUser(user);
                const supportsImages =
                  providerStatus.providerType === 'opfield_inference'
                    ? providerStatus.models.find((candidate) => candidate.id === (model || providerStatus.defaultModel))
                        ?.supportsImages === true
                    : providerStatus.supportsImages;
                if (!supportsImages) {
                  throw new AppError(
                    400,
                    'AI_IMAGE_INPUT_UNSUPPORTED',
                    'The selected AI model does not support image attachments'
                  );
                }
              }

              const runService = container.resolve(AIRunService);
              const planService = container.isRegistered(AIPlanService) ? container.resolve(AIPlanService) : null;
              let activePlan =
                msg.conversationId && planService
                  ? await planService.getActivePlanSnapshot(user.id, msg.conversationId)
                  : null;
              if (msg.workMode === 'plan' || activePlan) {
                await container.resolve(LicensePolicyService).requireFeature('ai-plan-mode');
              }
              if (activePlan?.status === 'validating' || activePlan?.status === 'verifying') {
                throw new AppError(409, 'AI_PLAN_BUSY', 'The active plan is being verified');
              }
              if (activePlan?.status === 'paused' && planService) {
                activePlan = await planService.resume(user.id, activePlan.conversationId);
              }
              const title = msg.conversationId
                ? 'New Work Session'
                : await providerRuntime.generateConversationTitle(user, {
                    requestId: `conversation-title:${msg.clientCommandId}`,
                    content: userVisibleContent(content),
                    ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
                    ...(model ? { requestedModel: model } : {}),
                    signal: AbortSignal.timeout(CONVERSATION_TITLE_TIMEOUT_MS),
                  });
              const result = await runService.startUserRun({
                conversationId: msg.conversationId ?? null,
                userId: user.id,
                title,
                userMessage: {
                  role: 'user',
                  content,
                  ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
                },
                clientCommandId: msg.clientCommandId,
                lastContext: msg.context ? { ...msg.context } : null,
                ...(model ? { model } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
              });
              if (msg.workMode === 'plan' && !activePlan) {
                if (!planService) throw new AppError(503, 'AI_PLAN_UNAVAILABLE', 'Plan Mode is unavailable');
                activePlan = await planService.enterPlan({
                  userId: user.id,
                  conversationId: result.conversationId,
                  title,
                  model: model ?? null,
                  reasoningEffort: reasoningEffort ?? null,
                });
              }
              let run = result.run;
              if (
                !result.duplicate &&
                activePlan &&
                (activePlan.status === 'drafting' ||
                  activePlan.status === 'executing' ||
                  activePlan.status === 'verifying')
              ) {
                run = await runService.attachRunToPlan({
                  userId: user.id,
                  conversationId: result.conversationId,
                  runId: result.run.id,
                  plan: activePlan,
                  purpose:
                    activePlan.status === 'drafting'
                      ? 'plan_draft'
                      : activePlan.status === 'verifying'
                        ? 'plan_verification'
                        : 'plan_execution',
                });
              }

              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: result.conversationId,
                runId: run.id,
                duplicate: result.duplicate,
              });
              state.subscribedConversationIds.add(result.conversationId);
              const snapshot = await sendConversationSnapshot(ws, user.id, result.conversationId);
              send(ws, {
                type: 'run.status_changed',
                conversationId: result.conversationId,
                run: snapshot.runtime.activeRun,
                ...revisionPayload(snapshot),
              });
              if (!result.duplicate) {
                runService.startRunExecution(user, run.id);
              }
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to send AI message');
            }
            return;
          }

          if (msg.type === 'conversation.start_scenario') {
            try {
              const scenarios = container.isRegistered(TOKENS.CommercialEdition)
                ? await container.resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition).listAIScenarios(user)
                : [];
              const scenario = scenarios.find((item) => item.id === msg.scenarioId);
              if (!scenario) {
                throw new AppError(404, 'AI_SCENARIO_NOT_FOUND', 'This scenario is not available to you');
              }
              const rateCheck = await checkRateLimit(user.id);
              if (!rateCheck.allowed) {
                const code = rateCheck.unavailable ? 'RATE_LIMIT_UNAVAILABLE' : 'RATE_LIMITED';
                throw new AppError(
                  rateCheck.unavailable ? 503 : 429,
                  code,
                  rateCheck.unavailable ? 'Opfield is temporarily unavailable' : 'AI rate limit exceeded',
                  rateCheck.unavailable ? undefined : { retryAfter: rateCheck.retryAfter }
                );
              }
              const model = msg.model?.trim();
              const reasoningEffort = msg.reasoningEffort?.trim();
              const content = `${scenario.title}\n<system-instruction>\nScenario selected: ${scenario.title}. ${scenario.kickoffInstruction}\n</system-instruction>`;
              const runService = container.resolve(AIRunService);
              const result = await runService.startUserRun({
                conversationId: null,
                userId: user.id,
                title: scenario.title,
                userMessage: {
                  role: 'user',
                  content,
                  scenario: {
                    id: scenario.id,
                    title: scenario.title,
                    description: scenario.description,
                    icon: scenario.icon,
                    category: scenario.category,
                  },
                },
                clientCommandId: msg.clientCommandId,
                lastContext: msg.context ? { ...msg.context } : null,
                ...(model ? { model } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
              });
              // A scenario begins with requirement discovery. It must not create a
              // plan just because the eventual work might mutate infrastructure.
              const run = result.run;
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: result.conversationId,
                runId: run.id,
                duplicate: result.duplicate,
              });
              state.subscribedConversationIds.add(result.conversationId);
              const snapshot = await sendConversationSnapshot(ws, user.id, result.conversationId);
              send(ws, {
                type: 'run.status_changed',
                conversationId: result.conversationId,
                run: snapshot.runtime.activeRun,
                ...revisionPayload(snapshot),
              });
              if (!result.duplicate) runService.startRunExecution(user, run.id);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to start AI scenario');
            }
            return;
          }

          if (msg.type === 'conversation.queue_message') {
            try {
              const content = msg.content.trim();
              if (!content && !msg.attachments?.length) {
                throw new AppError(400, 'AI_MESSAGE_REQUIRED', 'Message content is required');
              }
              const rateCheck = await checkRateLimit(user.id);
              if (!rateCheck.allowed) {
                const code = rateCheck.unavailable ? 'RATE_LIMIT_UNAVAILABLE' : 'RATE_LIMITED';
                throw new AppError(
                  rateCheck.unavailable ? 503 : 429,
                  code,
                  rateCheck.unavailable ? 'Opfield is temporarily unavailable' : 'AI rate limit exceeded',
                  rateCheck.unavailable ? undefined : { retryAfter: rateCheck.retryAfter }
                );
              }
              const runService = container.resolve(AIRunService);
              const result = await runService.queueConversationInput({
                conversationId: msg.conversationId,
                userId: user.id,
                inputId: msg.inputId,
                clientCommandId: msg.clientCommandId,
                content,
                attachments: msg.attachments,
                context: msg.context ? { ...msg.context } : null,
              });
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
                duplicate: result.duplicate,
              });
              await sendConversationSnapshot(ws, user.id, msg.conversationId);
              runService.startPendingInputExecution(user, msg.conversationId);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to queue AI message');
            }
            return;
          }

          if (msg.type === 'conversation.steer_message') {
            try {
              const runService = container.resolve(AIRunService);
              await runService.steerConversationInput({
                conversationId: msg.conversationId,
                inputId: msg.inputId,
                userId: user.id,
              });
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
              });
              await sendConversationSnapshot(ws, user.id, msg.conversationId);
              runService.startPendingInputExecution(user, msg.conversationId);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to steer AI message');
            }
            return;
          }

          if (msg.type === 'conversation.cancel_queued_message') {
            try {
              const runService = container.resolve(AIRunService);
              await runService.cancelConversationInput({
                conversationId: msg.conversationId,
                inputId: msg.inputId,
                userId: user.id,
              });
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
              });
              await sendConversationSnapshot(ws, user.id, msg.conversationId);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to cancel queued AI message');
            }
            return;
          }

          if (msg.type === 'conversation.continue') {
            try {
              const model = msg.model?.trim();
              if (model && model.length > 255) {
                throw new AppError(400, 'AI_MODEL_INVALID', 'AI model identifier is too long');
              }
              const reasoningEffort = msg.reasoningEffort?.trim();
              if (reasoningEffort && reasoningEffort.length > 64) {
                throw new AppError(400, 'AI_REASONING_EFFORT_INVALID', 'AI reasoning effort is too long');
              }
              const rateCheck = await checkRateLimit(user.id);
              if (!rateCheck.allowed) {
                const code = rateCheck.unavailable ? 'RATE_LIMIT_UNAVAILABLE' : 'RATE_LIMITED';
                throw new AppError(
                  rateCheck.unavailable ? 503 : 429,
                  code,
                  rateCheck.unavailable ? 'Opfield is temporarily unavailable' : 'AI rate limit exceeded',
                  rateCheck.unavailable ? undefined : { retryAfter: rateCheck.retryAfter }
                );
              }

              const runService = container.resolve(AIRunService);
              const result = await runService.startContinuationRun({
                conversationId: msg.conversationId,
                userId: user.id,
                clientCommandId: msg.clientCommandId,
                lastContext: msg.context ? { ...msg.context } : null,
                ...(model ? { model } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
              });

              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: result.conversationId,
                runId: result.run.id,
                duplicate: result.duplicate,
              });
              state.subscribedConversationIds.add(result.conversationId);
              const snapshot = await sendConversationSnapshot(ws, user.id, result.conversationId);
              send(ws, {
                type: 'run.status_changed',
                conversationId: result.conversationId,
                run: snapshot.runtime.activeRun,
                ...revisionPayload(snapshot),
              });
              if (!result.duplicate) runService.startRunExecution(user, result.run.id);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to continue AI conversation');
            }
            return;
          }

          if (msg.type === 'conversation.compact') {
            try {
              const model = msg.model?.trim();
              if (model && model.length > 255) {
                throw new AppError(400, 'AI_MODEL_INVALID', 'AI model identifier is too long');
              }
              const reasoningEffort = msg.reasoningEffort?.trim();
              if (reasoningEffort && reasoningEffort.length > 64) {
                throw new AppError(400, 'AI_REASONING_EFFORT_INVALID', 'AI reasoning effort is too long');
              }
              const rateCheck = await checkRateLimit(user.id);
              if (!rateCheck.allowed) {
                const code = rateCheck.unavailable ? 'RATE_LIMIT_UNAVAILABLE' : 'RATE_LIMITED';
                throw new AppError(
                  rateCheck.unavailable ? 503 : 429,
                  code,
                  rateCheck.unavailable ? 'Opfield is temporarily unavailable' : 'AI rate limit exceeded',
                  rateCheck.unavailable ? undefined : { retryAfter: rateCheck.retryAfter }
                );
              }

              const runService = container.resolve(AIRunService);
              const result = await runService.startContextCompactionRun({
                conversationId: msg.conversationId,
                userId: user.id,
                clientCommandId: msg.clientCommandId,
                lastContext: msg.context ? { ...msg.context } : null,
                ...(model ? { model } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
              });

              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: result.conversationId,
                runId: result.run.id,
                duplicate: result.duplicate,
              });
              state.subscribedConversationIds.add(result.conversationId);
              const snapshot = await sendConversationSnapshot(ws, user.id, result.conversationId);
              send(ws, {
                type: 'run.status_changed',
                conversationId: result.conversationId,
                run: snapshot.runtime.activeRun,
                ...revisionPayload(snapshot),
              });
              if (!result.duplicate) {
                runService.startContextCompaction(user, result.run.id, 'manual');
              }
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to compact AI conversation');
            }
            return;
          }

          if (msg.type === 'plan.decide') {
            try {
              const planService = container.resolve(AIPlanService);
              const runService = container.resolve(AIRunService);
              const result = await planService.decide({
                userId: user.id,
                conversationId: msg.conversationId,
                planId: msg.planId,
                revisionId: msg.revisionId,
                decision: msg.decision,
                customInstruction: msg.customInstruction,
                clientCommandId: msg.clientCommandId,
              });
              if (msg.decision !== 'refine') {
                await runService.startPlanRun({
                  user,
                  plan: result.plan,
                  purpose: 'plan_execution',
                  clientCommandId: `plan-decision:${msg.clientCommandId}`,
                  instruction: msg.decision === 'custom' ? msg.customInstruction : undefined,
                });
              }
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
                duplicate: result.duplicate,
              });
              await sendConversationSnapshot(ws, user.id, msg.conversationId);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to apply the plan decision');
            }
            return;
          }

          if (msg.type === 'plan.pause') {
            try {
              const planService = container.resolve(AIPlanService);
              const plan = await planService.getActivePlanSnapshot(user.id, msg.conversationId);
              if (!plan || plan.id !== msg.planId) throw new AppError(404, 'AI_PLAN_NOT_FOUND', 'AI plan not found');
              await planService.requestPause(user.id, msg.conversationId, 'Paused by user');
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
              });
              await sendConversationSnapshot(ws, user.id, msg.conversationId);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to pause the plan');
            }
            return;
          }

          if (msg.type === 'plan.resume') {
            try {
              const planService = container.resolve(AIPlanService);
              const runService = container.resolve(AIRunService);
              const current = await planService.getActivePlanSnapshot(user.id, msg.conversationId);
              if (!current || current.id !== msg.planId)
                throw new AppError(404, 'AI_PLAN_NOT_FOUND', 'AI plan not found');
              const plan = await planService.resume(user.id, msg.conversationId);
              await runService.startPlanRun({
                user,
                plan,
                purpose: plan.status === 'verifying' ? 'plan_verification' : 'plan_execution',
                clientCommandId: `plan-resume:${msg.clientCommandId}`,
              });
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
              });
              await sendConversationSnapshot(ws, user.id, msg.conversationId);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to resume the plan');
            }
            return;
          }

          if (msg.type === 'plan.cancel') {
            try {
              const planService = container.resolve(AIPlanService);
              const runService = container.resolve(AIRunService);
              const current = await planService.getActivePlanSnapshot(user.id, msg.conversationId);
              if (!current || current.id !== msg.planId)
                throw new AppError(404, 'AI_PLAN_NOT_FOUND', 'AI plan not found');
              await planService.cancel(user.id, msg.conversationId);
              await runService.stopActiveRunForRollback({ userId: user.id, conversationId: msg.conversationId });
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
              });
              await sendConversationSnapshot(ws, user.id, msg.conversationId);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to cancel the plan');
            }
            return;
          }

          if (msg.type === 'conversation.abandon_planning') {
            try {
              const runService = container.resolve(AIRunService);
              const lifecycle = await runService.abandonPlanning({
                userId: user.id,
                conversationId: msg.conversationId,
                clientCommandId: msg.clientCommandId,
              });
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
                duplicate: lifecycle.duplicate,
              });
              await sendConversationSnapshot(ws, user.id, msg.conversationId);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to leave Plan Mode');
              sendConversationSnapshotBestEffort(ws, user.id, msg.conversationId);
            }
            return;
          }

          if (msg.type === 'run.stop') {
            try {
              const runService = container.resolve(AIRunService);
              const result = await runService.stopRun({
                conversationId: msg.conversationId,
                runId: msg.runId,
                userId: user.id,
              });
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
                runId: msg.runId,
                duplicate: result.duplicate,
              });
              const snapshot = await sendConversationSnapshot(ws, user.id, msg.conversationId);
              send(ws, {
                type: 'run.status_changed',
                conversationId: msg.conversationId,
                run: result.run,
                ...revisionPayload(snapshot),
              });
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to stop AI run');
            }
            return;
          }

          if (msg.type === 'approval.decide') {
            try {
              const runService = container.resolve(AIRunService);
              const result = await runService.decideToolCall({
                conversationId: msg.conversationId,
                runId: msg.runId,
                toolCallId: msg.approvalId,
                userId: user.id,
                clientCommandId: msg.clientCommandId,
                decision: msg.decision,
              });
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
                runId: msg.runId,
                duplicate: result.duplicate,
              });
              send(ws, {
                type: 'approval.updated',
                conversationId: msg.conversationId,
                runId: msg.runId,
                approval: result.toolCall,
                duplicate: result.duplicate,
              });
              try {
                if (result.toolCall.roundId && result.continuationReady) {
                  runService.startToolRoundContinuation(user, {
                    conversationId: msg.conversationId,
                    runId: msg.runId,
                    roundId: result.toolCall.roundId,
                  });
                } else if (!result.toolCall.roundId && result.continuationReady !== false) {
                  runService.startApprovalContinuation(user, {
                    conversationId: msg.conversationId,
                    runId: msg.runId,
                    toolCall: result.toolCall,
                    approved: msg.decision === 'approved',
                  });
                }
              } catch (error) {
                logger.error('Failed to schedule AI approval continuation after committed decision', {
                  conversationId: msg.conversationId,
                  runId: msg.runId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              sendConversationSnapshotBestEffort(ws, user.id, msg.conversationId);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to decide AI tool approval');
            }
            return;
          }

          if (msg.type === 'credential.resolve') {
            try {
              const runService = container.resolve(AIRunService);
              const result = await runService.resolveCredentialChallenge({
                conversationId: msg.conversationId,
                runId: msg.runId,
                challengeId: msg.challengeId,
                userId: user.id,
                clientCommandId: msg.clientCommandId,
                decision: msg.decision,
              });
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
                runId: msg.runId,
                duplicate: result.duplicate,
              });
              send(ws, {
                type: 'credential.updated',
                conversationId: msg.conversationId,
                runId: msg.runId,
                challenge: result.challenge,
                duplicate: result.duplicate,
              });
              try {
                for (const challenge of [result.challenge, ...result.additionalChallenges]) {
                  runService.startCredentialContinuation(user, {
                    conversationId: challenge.conversationId,
                    runId: challenge.runId,
                    challenge,
                    authorized: msg.decision === 'authorized',
                  });
                }
              } catch (error) {
                logger.error('Failed to schedule AI credential continuation after committed decision', {
                  conversationId: msg.conversationId,
                  runId: msg.runId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              sendConversationSnapshotBestEffort(ws, user.id, msg.conversationId);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to resolve GitLab authorization');
            }
            return;
          }

          if (msg.type === 'setup.resolve') {
            try {
              const runService = container.resolve(AIRunService);
              const result = await runService.resolveSetupInteraction({
                conversationId: msg.conversationId,
                runId: msg.runId,
                interactionId: msg.interactionId,
                userId: user.id,
                clientCommandId: msg.clientCommandId,
                status: msg.status,
                result: msg.result,
              });
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
                runId: msg.runId,
                duplicate: result.duplicate,
              });
              try {
                runService.startSetupContinuation(user, {
                  conversationId: msg.conversationId,
                  runId: msg.runId,
                  interaction: result.interaction,
                });
              } catch (error) {
                logger.error('Failed to schedule AI setup continuation after committed result', {
                  conversationId: msg.conversationId,
                  runId: msg.runId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              sendConversationSnapshotBestEffort(ws, user.id, msg.conversationId);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to resolve setup interaction');
            }
            return;
          }

          if (msg.type === 'question.answer') {
            try {
              const runService = container.resolve(AIRunService);
              const result = await runService.answerQuestion({
                conversationId: msg.conversationId,
                runId: msg.runId,
                questionId: msg.questionId,
                userId: user.id,
                clientCommandId: msg.clientCommandId,
                answer: msg.answer,
              });
              send(ws, {
                type: 'command.ack',
                commandType: msg.type,
                clientCommandId: msg.clientCommandId,
                conversationId: msg.conversationId,
                runId: msg.runId,
                duplicate: result.duplicate,
              });
              send(ws, {
                type: 'question.answered',
                conversationId: msg.conversationId,
                runId: msg.runId,
                question: result.question,
                duplicate: result.duplicate,
              });
              try {
                if (result.question.roundId && result.continuationReady) {
                  runService.startToolRoundContinuation(user, {
                    conversationId: msg.conversationId,
                    runId: msg.runId,
                    roundId: result.question.roundId,
                  });
                } else if (!result.question.roundId && result.continuationReady !== false) {
                  runService.startQuestionContinuation(user, {
                    conversationId: msg.conversationId,
                    runId: msg.runId,
                    question: result.question,
                  });
                }
              } catch (error) {
                logger.error('Failed to schedule AI question continuation after committed answer', {
                  conversationId: msg.conversationId,
                  runId: msg.runId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              sendConversationSnapshotBestEffort(ws, user.id, msg.conversationId);
            } catch (error) {
              sendCommandError(ws, msg, error, 'Failed to answer AI question');
            }
            return;
          }

          send(ws, {
            type: 'command.error',
            commandType: raw.type as string,
            clientCommandId:
              typeof raw.clientCommandId === 'string' ? raw.clientCommandId : (raw.requestId as string | undefined),
            conversationId: typeof raw.conversationId === 'string' ? raw.conversationId : undefined,
            runId: typeof raw.runId === 'string' ? raw.runId : undefined,
            code: 'AI_UNKNOWN_COMMAND',
            message: 'Unknown AI websocket command',
            statusCode: 400,
          });
        }
      );
    },

    onClose(_event: unknown, ws: WSContext) {
      const state = wsStates.get(ws);
      if (state) {
        unsubscribeFromUserRuntime(state);
        if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
        wsStates.delete(ws);
      }
    },

    onError(_error: Event, ws: WSContext) {
      logger.error('WebSocket error');
      const state = wsStates.get(ws);
      if (state) {
        unsubscribeFromUserRuntime(state);
        if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
        wsStates.delete(ws);
      }
    },
  };
}

/**
 * Authenticate and initialize a WS connection from the session cookie.
 * Called during the WS upgrade / onOpen.
 */
export async function authenticateWSConnection(ws: WSContext, sessionId: string): Promise<boolean> {
  const state = wsStates.get(ws);
  if (!state) return false;

  const identity = await authenticateFromSession(sessionId);
  const user = identity?.user;
  if (!identity || !user) {
    send(ws, { type: 'auth_error', message: 'Invalid or expired session' });
    return false;
  }

  if (user.isBlocked) {
    send(ws, { type: 'auth_error', message: 'Account is blocked' });
    return false;
  }

  if (!isDemoRealtimeCapabilityAllowed(user, identity.effectiveScopes, 'ai:workspace')) {
    send(ws, { type: 'auth_error', message: 'AI Workspace is unavailable in demo mode' });
    return false;
  }

  if (!canUseAI(user.scopes)) {
    send(ws, { type: 'auth_error', message: 'Insufficient permissions to use AI Workspace' });
    return false;
  }

  const settingsService = container.resolve(AISettingsService);
  const enabled = container.isRegistered(AIProviderRuntimeService)
    ? (await container.resolve(AIProviderRuntimeService).statusForUser(user)).enabled
    : await settingsService.isEnabled();
  if (!enabled) {
    send(ws, { type: 'auth_error', message: 'AI Workspace is not enabled' });
    return false;
  }

  state.user = user;
  state.impersonation = identity.impersonation ?? null;
  state.sessionId = sessionId;
  state.authenticated = true;
  subscribeToUserRuntime(ws, state, user.id);
  send(ws, { type: 'auth_ok', userId: user.id });
  return true;
}
