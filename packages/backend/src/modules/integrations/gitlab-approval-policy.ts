import type { AIToolApprovalClass } from '@/db/schema/index.js';
import { redactGitLabAuditDetails } from './integration-audit.js';

const FORCED_APPROVAL_TOOLS = new Set([
  'gitlab_delete_project_variable',
  'gitlab_commit_files',
  'gitlab_delete_branch',
  'gitlab_update_ci_config',
  'gitlab_update_project_settings',
  'gitlab_add_connector_projects',
]);

const READ_TOOL_PATTERNS = [
  /^gitlab_(?:list|search|get|read|find|inspect|discover|lint)_/,
  /^gitlab_repository_tree$/,
  /^gitlab_file_read$/,
  /^gitlab_ci_lint$/,
  /^gitlab_pipeline_read$/,
];

const CREATE_TOOL_PATTERNS = [/^gitlab_(?:create|clone)_/, /^gitlab_repository_clone$/, /^gitlab_deploy_token_create$/];

const UPDATE_TOOL_PATTERNS = [
  /^gitlab_(?:update|upsert|commit|write|set|manage|use|sync|add)_/,
  /^gitlab_file_commit$/,
  /^gitlab_commit_files$/,
  /^gitlab_ci_update$/,
  /^gitlab_registry_use$/,
  /^gitlab_webhook_manage$/,
];

const DELETE_TOOL_PATTERNS = [/^gitlab_(?:delete|remove|revoke)_/];
const EXECUTE_TOOL_PATTERNS = [/^gitlab_(?:run|execute)_/];

export interface GitLabApprovalOperationMetadata {
  action: string;
  filePath?: string;
  settingsKey?: string;
  highRisk?: boolean;
  description?: string;
}

export interface GitLabApprovalMetadataInput {
  connector: {
    id: string;
    name?: string | null;
    baseUrl?: string | null;
  };
  project?: {
    remoteId?: string | null;
    fullPath?: string | null;
    name?: string | null;
  } | null;
  branch?: string | null;
  defaultBranch?: boolean;
  protectedBranch?: boolean;
  operations: GitLabApprovalOperationMetadata[];
}

export function classifyGitLabAIToolForApproval(toolName: string): AIToolApprovalClass | null {
  if (!toolName.startsWith('gitlab_')) return null;
  if (READ_TOOL_PATTERNS.some((pattern) => pattern.test(toolName))) return 'read';
  if (DELETE_TOOL_PATTERNS.some((pattern) => pattern.test(toolName))) return 'delete';
  if (EXECUTE_TOOL_PATTERNS.some((pattern) => pattern.test(toolName))) return 'execute';
  if (CREATE_TOOL_PATTERNS.some((pattern) => pattern.test(toolName))) return 'create';
  if (UPDATE_TOOL_PATTERNS.some((pattern) => pattern.test(toolName))) return 'update';
  return 'destructive';
}

export function isGitLabAIToolForcedApproval(toolName: string): boolean {
  return FORCED_APPROVAL_TOOLS.has(toolName);
}

export function buildGitLabApprovalMetadata(input: GitLabApprovalMetadataInput) {
  const protectedOrDefault = input.protectedBranch === true || input.defaultBranch === true;
  return redactGitLabAuditDetails({
    provider: 'gitlab',
    connector: input.connector,
    project: input.project ?? null,
    branch: input.branch ?? null,
    protectedBranch: input.protectedBranch === true,
    defaultBranch: input.defaultBranch === true,
    requiresExplicitApprovalText: protectedOrDefault,
    operations: input.operations.map((operation) => ({
      action: operation.action,
      filePath: operation.filePath,
      settingsKey: operation.settingsKey,
      highRisk: operation.highRisk === true || protectedOrDefault,
    })),
  });
}
