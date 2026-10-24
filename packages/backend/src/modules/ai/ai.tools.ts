import { APP_INCIDENT_AI_TOOLS } from './ai.app-incident-tools.js';
import { APP_PROMOTION_AI_TOOLS } from './ai.app-promotion-tools.js';
import { BACKUP_AI_TOOLS } from './ai.backup-tools.js';
import { GIT_SCOPE_TARGET_AI_TOOLS } from './ai.git-scope-target-tools.js';
import { OPFIELD_RUNTIME_AI_TOOLS } from './ai.opfield-runtime-tool.js';
import { STORAGE_AI_TOOLS } from './ai.storage-tools.js';
import { APP_AI_TOOLS } from './ai.tools.apps.js';
import { CONTROL_AI_TOOLS } from './ai.tools.control.js';
import { DATABASE_AI_TOOLS } from './ai.tools.databases.js';
import { DISCOVERY_AI_TOOLS } from './ai.tools.discovery.js';
import { DOCKER_AI_TOOLS } from './ai.tools.docker.js';
import { FOLDER_AI_TOOLS } from './ai.tools.folders.js';
import { GITLAB_AI_TOOLS } from './ai.tools.gitlab.js';
import { HOSTING_AI_TOOLS } from './ai.tools.hosting.js';
import { INFERENCE_AI_TOOLS } from './ai.tools.inference.js';
import { INGRESS_AI_TOOLS } from './ai.tools.ingress.js';
import { INGRESS_GROUP_AI_TOOLS } from './ai.tools.ingress-groups.js';
import { INTEGRATION_AI_TOOLS } from './ai.tools.integrations.js';
import { NOTIFICATION_AI_TOOLS, WEB_SEARCH_AI_TOOL } from './ai.tools.notifications.js';
import { OPERATION_AI_TOOLS } from './ai.tools.operations.js';
import { PKI_AI_TOOLS } from './ai.tools.pki.js';
import { PLATFORM_AI_TOOLS } from './ai.tools.platform.js';
import { RESOURCE_SETUP_AI_TOOLS } from './ai.tools.resource-setup.js';
import { SSH_AI_TOOLS } from './ai.tools.ssh.js';
import type { AIToolDefinition } from './ai.types.js';
import { createAIToolArgumentValidator } from './ai-tool-contract.js';
import { canUseAiTool } from './ai-tool-filtering.js';
import { withFolderAccessNotes } from './ai-tool-folder-access-notes.js';
import { withAIToolPolicyMetadata } from './ai-tool-policy-metadata.js';

const AI_TOOL_DEFINITIONS: AIToolDefinition[] = [
  ...DISCOVERY_AI_TOOLS,
  ...PKI_AI_TOOLS,
  ...FOLDER_AI_TOOLS,
  ...INGRESS_AI_TOOLS,
  ...INGRESS_GROUP_AI_TOOLS,
  ...APP_AI_TOOLS,
  ...APP_INCIDENT_AI_TOOLS,
  ...APP_PROMOTION_AI_TOOLS,
  ...PLATFORM_AI_TOOLS,
  ...CONTROL_AI_TOOLS,
  ...DOCKER_AI_TOOLS,
  ...DATABASE_AI_TOOLS,
  ...STORAGE_AI_TOOLS,
  ...BACKUP_AI_TOOLS,
  ...GITLAB_AI_TOOLS,
  ...INTEGRATION_AI_TOOLS,
  ...GIT_SCOPE_TARGET_AI_TOOLS,
  ...HOSTING_AI_TOOLS,
  ...INFERENCE_AI_TOOLS,
  ...OPERATION_AI_TOOLS,
  ...OPFIELD_RUNTIME_AI_TOOLS,
  ...RESOURCE_SETUP_AI_TOOLS,
  ...SSH_AI_TOOLS,
  ...NOTIFICATION_AI_TOOLS,
  WEB_SEARCH_AI_TOOL,
];

export const AI_TOOLS: AIToolDefinition[] = withAIToolPolicyMetadata(withFolderAccessNotes(AI_TOOL_DEFINITIONS));

const destructiveSet = new Set(AI_TOOLS.filter((t) => t.destructive).map((t) => t.name));
const REQUIRED_RUNTIME_AI_TOOL_NAMES = new Set([
  'read_tool_output',
  'search_tool_output',
  'read_skill',
  'activate_skill',
]);
const BASE_AI_TOOL_NAMES = new Set([
  'enter_plan_mode',
  'submit_plan',
  'submit_plan_review',
  'start_plan_execution',
  'update_plan_step',
  'pause_plan_execution',
  'resume_plan_execution',
  'finalize_plan_execution',
  'submit_plan_verification',
  'discover_tools',
  'read_skill',
  'activate_skill',
  'get_current_context',
  'read_tool_output',
  'search_tool_output',
  'wait',
  'send_comment',
  'end_conversation',
  'find_resource',
  'get_my_access',
  'ask_question',
  'internal_documentation',
  'search_chats',
  'search_compacted_history',
  'find_in_chat',
  'read_chat_slice',
  'list_chat_projects',
  'fetch',
  'web_search',
]);

export function isBaseAIToolName(name: string): boolean {
  return BASE_AI_TOOL_NAMES.has(name);
}

const TOOL_NAME_BOUNDARY = '[^a-zA-Z0-9_]';

export function isDestructiveTool(name: string): boolean {
  return destructiveSet.has(name);
}

export function inferDiscoveredToolsetsFromText(text: string): string[] {
  const discovered = new Set<string>();
  for (const tool of AI_TOOLS) {
    if (BASE_AI_TOOL_NAMES.has(tool.name)) continue;
    if (matchesToolName(text, tool.name)) discovered.add(tool.category);
  }
  return [...discovered].sort((a, b) => a.localeCompare(b));
}

function matchesToolName(text: string, toolName: string): boolean {
  const escapedName = escapeRegExp(toolName);
  if (new RegExp(`(^|${TOOL_NAME_BOUNDARY})${escapedName}($|${TOOL_NAME_BOUNDARY})`, 'i').test(text)) return true;

  const readableName = escapeRegExp(toolName.replaceAll('_', ' '));
  return new RegExp(`(^|${TOOL_NAME_BOUNDARY})${readableName}($|${TOOL_NAME_BOUNDARY})`, 'i').test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Map of tool names to frontend store names that should be invalidated after execution.
 */
export const TOOL_STORE_INVALIDATION_MAP: Record<string, string[]> = Object.fromEntries(
  AI_TOOLS.filter((t) => t.invalidateStores.length > 0).map((t) => [t.name, t.invalidateStores])
);

let AI_TOOL_ARGUMENT_VALIDATOR = createAIToolArgumentValidator(AI_TOOLS);

/** Register verified first-party tools together with their validation and policy metadata. */
export function registerCommercialAITools(definitions: readonly AIToolDefinition[]): () => void {
  const additions = withAIToolPolicyMetadata([...definitions]);
  const validator = createAIToolArgumentValidator([...AI_TOOLS, ...additions]);
  AI_TOOLS.push(...additions);
  AI_TOOL_ARGUMENT_VALIDATOR = validator;
  for (const tool of additions) {
    if (tool.destructive) destructiveSet.add(tool.name);
    if (tool.invalidateStores.length) TOOL_STORE_INVALIDATION_MAP[tool.name] = tool.invalidateStores;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const tool of additions) {
      const index = AI_TOOLS.indexOf(tool);
      if (index !== -1) AI_TOOLS.splice(index, 1);
      destructiveSet.delete(tool.name);
      delete TOOL_STORE_INVALIDATION_MAP[tool.name];
    }
    AI_TOOL_ARGUMENT_VALIDATOR = createAIToolArgumentValidator(AI_TOOLS);
  };
}

export function parseAndValidateAIToolArguments(toolName: string, rawArguments: string) {
  return AI_TOOL_ARGUMENT_VALIDATOR.parseAndValidate(toolName, rawArguments);
}

export function validateAIToolArguments(toolName: string, argumentsValue: unknown) {
  return AI_TOOL_ARGUMENT_VALIDATOR.validate(toolName, argumentsValue);
}

/**
 * Get tools in OpenAI function-calling format, filtered by:
 * - Disabled tools (admin config)
 * - User scopes (only tools the user has the required scope for)
 * - Web search availability
 */
export function getOpenAITools(
  disabledTools: string[],
  userScopes: string[],
  webSearchEnabled: boolean,
  options: { discoveredToolsets?: string[]; sandboxEnabled?: boolean; planningMode?: boolean } = {}
): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  const discoveredToolsets = options.discoveredToolsets === undefined ? undefined : new Set(options.discoveredToolsets);
  return AI_TOOLS.filter((t) => {
    if (t.mcpOnly) return false;
    if (options.planningMode && t.planningAccess !== 'allowed') return false;
    if (disabledTools.includes(t.name) && !REQUIRED_RUNTIME_AI_TOOL_NAMES.has(t.name)) return false;
    if (t.name === 'web_search' && !webSearchEnabled) return false;
    if (t.category === 'Sandbox' && options.sandboxEnabled !== true) return false;
    if (discoveredToolsets && !BASE_AI_TOOL_NAMES.has(t.name) && !discoveredToolsets.has(t.category)) return false;
    // Every tool must have a requiredScope — reject tools without one
    if (!t.requiredScope) return false;
    return canUseAiTool(t.name, t.requiredScope, userScopes, t.requiredScopes);
  }).map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
