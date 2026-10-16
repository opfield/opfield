import type { AIToolApprovalClass, AIToolApprovalPolicy } from '@/db/schema/index.js';
import {
  classifyGitLabAIToolForApproval,
  isGitLabAIToolForcedApproval,
} from '@/modules/integrations/gitlab-approval-policy.js';
import type { User } from '@/types.js';
import { toolCallRefusedBeforeApproval } from './ai.console-preflight.js';
import { AI_TOOLS } from './ai.tools.js';
import type { AIToolOperationPolicy } from './ai.types.js';

export type AIApprovalMode = NonNullable<User['aiApprovalMode']>;

const SYSTEM_NEVER_ASK_TOOLS = new Set([
  'enter_plan_mode',
  'submit_plan',
  'submit_plan_review',
  'start_plan_execution',
  'update_plan_step',
  'pause_plan_execution',
  'resume_plan_execution',
  'finalize_plan_execution',
  'submit_plan_verification',
  'ask_question',
  'discover_tools',
  'internal_documentation',
  'get_current_context',
  'wait',
  'send_comment',
  'search_chats',
  'search_compacted_history',
  'find_in_chat',
  'read_chat_slice',
  'list_chat_projects',
  'compact_context',
]);

const READ_PREFIXES = /^(list|get|inspect|query|find|read|test)_/;
const CREATE_PREFIXES = /^(create|send|request|issue|link)_/;
const UPDATE_PREFIXES = /^(update|manage|start|stop|restart|pull|run|scan|write|move|toggle|rename|set)_/;
const DELETE_PREFIXES = /^(delete|remove|revoke|clear|kill)_/;
const EXECUTE_PREFIXES = /^(execute)_/;

export interface AIToolApprovalDecision {
  classification: AIToolApprovalClass;
  approvalPolicy: AIToolApprovalPolicy;
  requiresApproval: boolean;
}

export function classifyAIToolForApproval(
  toolName: string,
  toolArguments: Record<string, unknown> = {}
): AIToolApprovalClass {
  if (SYSTEM_NEVER_ASK_TOOLS.has(toolName)) return 'system-never-ask';
  const gitLabClassification = classifyGitLabAIToolForApproval(toolName);
  if (gitLabClassification) return gitLabClassification;

  const tool = AI_TOOLS.find((candidate) => candidate.name === toolName);
  const operationMetadata = tool?.operationDiscriminator;
  if (operationMetadata) {
    const discriminatorValues = operationMetadata.arguments.map((argument) => toolArguments[argument]);
    if (discriminatorValues.some((value) => typeof value !== 'string')) return 'destructive';
    const operationKey = discriminatorValues.join('.');
    const operationPolicy = operationMetadata.operations[operationKey];
    return operationPolicy ? operationApprovalClass(operationPolicy, toolArguments) : 'destructive';
  }
  if (tool?.approvalClass) return tool.approvalClass;

  if (EXECUTE_PREFIXES.test(toolName)) return 'execute';
  if (DELETE_PREFIXES.test(toolName)) return 'delete';
  if (CREATE_PREFIXES.test(toolName)) return 'create';
  if (UPDATE_PREFIXES.test(toolName)) return 'update';
  if (READ_PREFIXES.test(toolName)) return 'read';

  return tool?.destructive ? 'destructive' : 'read';
}

/** Applies an operation's argument refinement, failing closed on values the policy does not list. */
function operationApprovalClass(
  policy: AIToolOperationPolicy,
  toolArguments: Record<string, unknown>
): AIToolApprovalClass {
  const refinement = policy.argumentPolicy;
  if (!refinement) return policy.approvalClass;
  let value: unknown = toolArguments;
  for (const key of refinement.path) {
    value =
      value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
  }
  if (value === undefined) return policy.approvalClass;
  if (typeof value !== 'string' && typeof value !== 'boolean') return 'destructive';
  return Object.hasOwn(refinement.approvalClasses, String(value))
    ? refinement.approvalClasses[String(value)]
    : 'destructive';
}

export function getAIToolApprovalDecision(
  toolName: string,
  mode: AIApprovalMode | undefined,
  toolArguments: Record<string, unknown> = {}
): AIToolApprovalDecision {
  const classification = classifyAIToolForApproval(toolName, toolArguments);
  if (classification === 'system-never-ask') {
    return { classification, approvalPolicy: 'system_skipped', requiresApproval: false };
  }

  // A console command that is refused whatever the node's state runs at once and returns its refusal: nobody is
  // asked to approve a command that cannot run.
  if (toolCallRefusedBeforeApproval(toolName, toolArguments)) {
    return { classification, approvalPolicy: 'auto_approved', requiresApproval: false };
  }

  if (isGitLabAIToolForcedApproval(toolName)) {
    return { classification, approvalPolicy: 'requires_approval', requiresApproval: true };
  }

  const approvalMode = mode ?? 'normal';
  const requiresApproval =
    approvalMode === 'always-ask'
      ? true
      : approvalMode === 'normal'
        ? classification !== 'read'
        : approvalMode === 'bypass-non-destructive'
          ? classification === 'delete' || classification === 'destructive' || classification === 'execute'
          : false;

  return {
    classification,
    approvalPolicy: requiresApproval ? 'requires_approval' : 'auto_approved',
    requiresApproval,
  };
}
