import { randomUUID } from 'node:crypto';
import { AppError } from '@/middleware/error-handler.js';
import { InferenceProtocolError } from '@/modules/inference/protocol/inference-protocol.error.js';
import { describeModelCallError, modelCallRefusal } from './ai-model-call-retry.js';

const ID_MAX = 255;

type FieldRule = { required?: boolean } & (
  | { kind: 'id' }
  | { kind: 'text' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'array' }
  | { kind: 'object' }
);

const id = (required = true): FieldRule => ({ kind: 'id', required });
const text = (required = true): FieldRule => ({ kind: 'text', required });
const oneOf = (...values: string[]): FieldRule => ({ kind: 'enum', values, required: true });
const optionalText = text(false);
const context = { kind: 'object', required: false } as const;

/** The fields each assistant WebSocket command needs, as WSClientMessage (ai.types.ts) declares them. */
const COMMANDS: Record<string, Record<string, FieldRule>> = {
  'conversation.subscribe': { conversationId: id(), clientCommandId: id(false) },
  'conversation.unsubscribe': { conversationId: id() },
  'conversation.sync': { conversationId: id(), clientCommandId: id(false) },
  'conversation.compact': {
    conversationId: id(),
    clientCommandId: id(),
    context,
    model: optionalText,
    reasoningEffort: optionalText,
  },
  'conversation.send_message': {
    clientCommandId: id(),
    conversationId: id(false),
    content: text(),
    attachments: { kind: 'array', required: false },
    context,
    model: optionalText,
    reasoningEffort: optionalText,
    workMode: { kind: 'enum', values: ['normal', 'plan'], required: false },
  },
  'conversation.start_scenario': {
    clientCommandId: id(),
    scenarioId: id(),
    context,
    model: optionalText,
    reasoningEffort: optionalText,
  },
  'conversation.continue': {
    conversationId: id(),
    clientCommandId: id(),
    context,
    model: optionalText,
    reasoningEffort: optionalText,
  },
  'conversation.queue_message': {
    conversationId: id(),
    inputId: id(),
    clientCommandId: id(),
    content: text(),
    attachments: { kind: 'array', required: false },
    context,
  },
  'conversation.steer_message': { conversationId: id(), inputId: id(), clientCommandId: id() },
  'conversation.cancel_queued_message': { conversationId: id(), inputId: id(), clientCommandId: id() },
  'run.stop': { conversationId: id(), runId: id(), clientCommandId: id() },
  'plan.decide': {
    conversationId: id(),
    planId: id(),
    revisionId: id(),
    decision: oneOf('implement', 'refine', 'custom'),
    customInstruction: optionalText,
    clientCommandId: id(),
  },
  'plan.pause': { conversationId: id(), planId: id(), clientCommandId: id() },
  'plan.resume': { conversationId: id(), planId: id(), clientCommandId: id() },
  'plan.cancel': { conversationId: id(), planId: id(), clientCommandId: id() },
  'conversation.abandon_planning': { conversationId: id(), clientCommandId: id() },
  'approval.decide': {
    conversationId: id(),
    runId: id(),
    approvalId: id(),
    decision: oneOf('approved', 'rejected'),
    clientCommandId: id(),
  },
  'question.answer': { conversationId: id(), runId: id(), questionId: id(), answer: text(), clientCommandId: id() },
  'credential.resolve': {
    conversationId: id(),
    runId: id(),
    challengeId: id(),
    decision: oneOf('authorized', 'rejected'),
    clientCommandId: id(),
  },
  'setup.resolve': {
    conversationId: id(),
    runId: id(),
    interactionId: id(),
    status: oneOf('configured', 'cancelled'),
    result: { kind: 'object', required: false },
    clientCommandId: id(),
  },
};

function fieldProblem(name: string, rule: FieldRule, value: unknown): string | null {
  if (value === undefined || value === null) return rule.required ? `${name} is required` : null;
  switch (rule.kind) {
    case 'id':
      return typeof value === 'string' && value.trim() && value.length <= ID_MAX
        ? null
        : `${name} must be a non-empty string of at most ${ID_MAX} characters`;
    case 'text':
      return typeof value === 'string' ? null : `${name} must be a string`;
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value)
        ? null
        : `${name} must be one of ${rule.values.join(', ')}`;
    case 'array':
      return Array.isArray(value) ? null : `${name} must be an array`;
    case 'object':
      return typeof value === 'object' && !Array.isArray(value) ? null : `${name} must be an object`;
  }
}

/**
 * Why an assistant WebSocket command cannot be accepted (400 AI_COMMAND_INVALID naming the fields), or null. Unknown
 * command types are left to the caller's AI_UNKNOWN_COMMAND answer.
 */
export function validateWSCommand(raw: Record<string, unknown>): AppError | null {
  const rules = COMMANDS[String(raw.type)];
  if (!rules) return null;
  const problems = Object.entries(rules)
    .map(([name, rule]) => fieldProblem(name, rule, raw[name]))
    .filter((problem): problem is string => problem !== null);
  if (problems.length === 0) return null;
  return new AppError(400, 'AI_COMMAND_INVALID', `Invalid ${String(raw.type)} command: ${problems.join('; ')}.`, {
    problems,
  });
}

export interface WSCommandFailure {
  code: string;
  statusCode: number;
  message: string;
  details?: Record<string, unknown>;
  /** Set when the failure is unexpected: the reference logged with the error. */
  reference?: string;
}

/**
 * What an assistant WebSocket command answers for an error that is not an AppError: a refusal of the model call
 * (budget, rate limit, content filter) or a provider failure with its own code and a message a person understands,
 * and anything else as AI_COMMAND_FAILED with a reference to the logged error. Internal messages (database errors,
 * stack details) never reach the client.
 */
export function wsCommandFailure(error: unknown, fallbackMessage: string): WSCommandFailure {
  const refusal = modelCallRefusal(error);
  if (refusal) {
    const retryAfterMs = (error as { details?: Record<string, unknown> }).details?.retryAfterMs;
    const details =
      typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
        ? { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) }
        : undefined;
    const [code, statusCode] =
      refusal === 'budget'
        ? ['AI_BUDGET_EXCEEDED', 402]
        : refusal === 'rate_limit'
          ? ['AI_RATE_LIMITED', 429]
          : ['AI_CONTENT_FILTERED', 422];
    return { code, statusCode, message: describeModelCallError(error), ...(details ? { details } : {}) };
  }
  if (error instanceof InferenceProtocolError) {
    return { code: 'AI_PROVIDER_FAILED', statusCode: 502, message: describeModelCallError(error) };
  }
  const reference = randomUUID();
  return {
    code: 'AI_COMMAND_FAILED',
    statusCode: 500,
    message: `${fallbackMessage}. Opfield logged the error under reference ${reference}; an administrator can find it in the Opfield logs.`,
    reference,
  };
}
