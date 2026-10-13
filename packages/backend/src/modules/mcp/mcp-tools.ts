import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { container } from '@/container.js';
import { withLimitedAccessGuidance } from '@/lib/access-denied.js';
import { accessSummaryDatabase } from '@/lib/access-summary-resolver.js';
import { AIService } from '@/modules/ai/ai.service.js';
import { redactArgsForAudit } from '@/modules/ai/ai.service.tool-helpers.js';
import { AI_TOOLS, validateAIToolArguments } from '@/modules/ai/ai.tools.js';
import type { AIToolDefinition, ToolExecutionResult } from '@/modules/ai/ai.types.js';
import { getAIToolResourceId } from '@/modules/ai/ai-tool-policy-metadata.js';
import { hasAIToolCallScope, hasAIToolVisibilityScope } from '@/modules/ai/ai-tool-scope-policy.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { setAuditMcpContext } from '@/modules/audit/audit-request-context.js';
import type { User } from '@/types.js';
import {
  extractMcpIdempotencyKey,
  MCP_IDEMPOTENCY_WITHHELD_ERROR,
  mcpToolListing,
  runMcpToolIdempotently,
} from './mcp-idempotency.js';
import type { McpAuthContext } from './mcp-types.js';

/**
 * MCP exposes every resource and management tool. Only browser- or identity-bound tools stay out:
 * AI chat internals, the AI sandbox, Opfield token/grant minting, and embedded-assistant UI actions.
 */
const MCP_EXCLUDED_CATEGORIES = new Set([
  'Planning',
  'Sandbox',
  'Conversations',
  'Conversation Retrieval',
  'Interaction',
  'Artifact',
  'Setup',
]);
const MCP_EXCLUDED_TOOLS = new Set([
  // AI chat internals: assistant discovery, skills, tool-output paging, chat retrieval, and coordination.
  'discover_tools',
  'read_skill',
  'activate_skill',
  'ask_question',
  'get_current_context',
  'read_tool_output',
  'search_tool_output',
  'end_conversation',
  'search_chats',
  'search_compacted_history',
  'find_in_chat',
  'read_chat_slice',
  'list_projects',
  'list_chat_projects',
  'internal_documentation',
  'web_search',
  'wait',
  'send_comment',
  'manage_ai_conversation',
  // AI sandbox runner, its artifacts, and repository clones into the sandbox working copy.
  'execute_script',
  'run_process',
  'fetch',
  'download_artifact',
  'list_artifact_files',
  'read_artifact',
  'send_artifact',
  'read_process_output',
  'write_process_stdin',
  'kill_process',
  'list_sandbox_jobs',
  'gitlab_clone_repository_to_sandbox',
  // A token must not mint Opfield credentials: API tokens or OAuth grants. Inference keys are resources.
  'manage_api_token',
  'manage_oauth_authorization',
  // Embedded-assistant UI actions: setup dialogs and per-browser pin preferences.
  'open_node_enrollment',
  'open_connector_setup',
  'set_resource_pin',
]);
const MCP_ALWAYS_VISIBLE_AI_TOOLS = new Set(['find_resource', 'get_my_access', 'read_opfield_documentation']);
const MCP_TOOLS_PAGE_SIZE = 80;
const MCP_DISCOVERY_STATE_TTL_MS = 24 * 60 * 60 * 1000;

interface McpToolsetDefinition {
  id: string;
  title: string;
  description: string;
  toolNames: string[];
  isDefault?: boolean;
}

interface McpDiscoveryState {
  activeToolsets: Set<string>;
  lastAccessAt: number;
}

const mcpDiscoveryStates = new Map<string, McpDiscoveryState>();

function toolNamesForCategories(categories: string[]): string[] {
  const categorySet = new Set(categories);
  return AI_TOOLS.filter((tool) => categorySet.has(tool.category)).map((tool) => tool.name);
}

const MCP_TOOLSET_DEFINITIONS: McpToolsetDefinition[] = [
  {
    id: 'core',
    title: 'Core inventory',
    description: 'Small default inventory surface for nodes, common read-only resources, and resource search.',
    isDefault: true,
    toolNames: [
      'list_nodes',
      'get_node',
      'list_routes',
      'get_route',
      'list_ssl_certificates',
      'list_domains',
      'list_access_lists',
      'list_databases',
      'get_database_connection',
      'list_cas',
      'list_certificates',
      'list_templates',
      'list_resource_folders',
    ],
  },
  {
    id: 'apps',
    title: 'Apps',
    description:
      'Apps and their environments: members, environment variables and secrets, allowed nodes, maintenance, overview and activity. Create resources inside an environment with folderId from get_app placementFolderIds.',
    isDefault: true,
    toolNames: toolNamesForCategories(['Apps']),
  },
  {
    id: 'folders',
    title: 'Folders',
    description: 'Folder layout and foldered resource assignment operations across Opfield resources.',
    toolNames: toolNamesForCategories(['Folders']),
  },
  {
    id: 'nodes',
    title: 'Nodes',
    description: 'Node inventory, enrollment, lifecycle, global nginx config, console, and filesystem operations.',
    toolNames: toolNamesForCategories(['Nodes']),
  },
  {
    id: 'proxy',
    title: 'Ingress',
    description:
      'Domains, routes, route folders, nginx templates, access lists, and raw route operations when delegated.',
    toolNames: toolNamesForCategories(['Ingress', 'Domains', 'Access Lists']),
  },
  {
    id: 'certificates',
    title: 'PKI and certificates',
    description:
      'Certificate authorities, PKI certificates, PKI templates, SSL certificates, and system PKI leaf audit.',
    toolNames: toolNamesForCategories([
      'PKI - Certificate Authorities',
      'PKI - Certificates',
      'PKI - Templates',
      'PKI - System Audit',
      'SSL Certificates',
    ]),
  },
  {
    id: 'docker',
    title: 'Docker',
    description:
      'Docker containers, deployments, images, volumes, networks, registries, tasks, config, and cross-node migrations.',
    toolNames: toolNamesForCategories(['Docker', 'Docker Migration']),
  },
  {
    id: 'databases',
    title: 'Databases',
    description:
      'Database connections, managed databases and bindings, PostgreSQL data tools, and key-value data tools.',
    toolNames: toolNamesForCategories(['Databases', 'Managed Databases']),
  },
  {
    id: 'storage',
    title: 'Storage',
    description:
      'External storage connections, object operations, server-side data copy between storages, managed SeaweedFS storage lifecycle (legacy MinIO clusters included), and private workload links.',
    toolNames: toolNamesForCategories(['Storage']),
  },
  {
    id: 'pages',
    title: 'Pages',
    description: 'Static Page Projects, Deployments, Tags, runtime configuration, and Pages profile operations.',
    toolNames: toolNamesForCategories(['Pages']),
  },
  {
    id: 'logging',
    title: 'Logging',
    description: 'Logging backend, environments, tokens, schemas, metadata, search, and facets.',
    toolNames: toolNamesForCategories(['Logging', 'Logging Backend']),
  },
  {
    id: 'status_page',
    title: 'Status page',
    description: 'Status page services, incidents, settings, templates, and preview.',
    toolNames: toolNamesForCategories(['Status Page']),
  },
  {
    id: 'integrations',
    title: 'Integrations',
    description:
      'Integration connector inventory and resync for GitLab, GitHub, generic Git, Cloudflare, and external SSH, plus Cloudflare connector setup.',
    toolNames: toolNamesForCategories(['Integrations', 'Cloudflare']),
  },
  {
    id: 'gitlab',
    title: 'GitLab',
    description: 'GitLab connectors, projects, repository files, CI pipelines, variables, webhooks, and registry.',
    toolNames: toolNamesForCategories(['GitLab']),
  },
  {
    id: 'github',
    title: 'GitHub',
    description: 'GitHub connectors, repositories, branches, workflow runs, repository files, and Actions settings.',
    toolNames: toolNamesForCategories(['GitHub']),
  },
  {
    id: 'git',
    title: 'Generic Git',
    description: 'Generic HTTPS Git connectors, remote refs, repository trees, and repository files.',
    toolNames: toolNamesForCategories(['Git']),
  },
  {
    id: 'external_ssh',
    title: 'External SSH',
    description: 'External SSH connectors and remote command execution.',
    toolNames: toolNamesForCategories(['External SSH']),
  },
  {
    id: 'hosting',
    title: 'Hosting',
    description: 'Hosting provider connectors, VMs, power and resize actions, snapshots, firewalls, and operations.',
    toolNames: toolNamesForCategories(['Hosting']),
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Alert rules, webhooks, delivery logs, and notification statistics.',
    toolNames: toolNamesForCategories(['Notifications']),
  },
  {
    id: 'administration',
    title: 'Administration',
    description: 'Users, permission groups, audit log, and system alert administration.',
    toolNames: toolNamesForCategories(['Administration']),
  },
  {
    id: 'maintenance',
    title: 'Maintenance',
    description:
      "Opfield settings, system updates, license, cloud account connection, housekeeping, and Opfield's own diagnostics (host, process, Postgres, Redis, stack containers, jobs, API latency, logs).",
    toolNames: toolNamesForCategories(['Maintenance']),
  },
  {
    id: 'inference',
    title: 'Inference',
    description:
      'Opfield Inference core, provider connections, published models, limits, usage, and personal inference keys.',
    toolNames: toolNamesForCategories(['Inference']),
  },
  {
    id: 'ai_assistant',
    title: 'AI assistant',
    description: 'AI assistant provider, limits, tool access, web search, and sandbox runner configuration.',
    toolNames: toolNamesForCategories(['AI Workspace']),
  },
];

const MCP_TOOLSET_BY_ID = new Map(MCP_TOOLSET_DEFINITIONS.map((toolset) => [toolset.id, toolset]));
const MCP_DEFAULT_TOOLSET_IDS = new Set(
  MCP_TOOLSET_DEFINITIONS.filter((toolset) => toolset.isDefault).map((toolset) => toolset.id)
);
const MCP_DISCOVER_TOOLS_DEFINITION = {
  name: 'discover_tools',
  description:
    'List Opfield MCP toolsets or activate a toolset by category id. Use this before specialized work, then call tools/list again to refresh the visible Opfield tools without loading every tool at once.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      category: {
        type: 'string',
        enum: MCP_TOOLSET_DEFINITIONS.map((toolset) => toolset.id),
        description: 'Optional toolset id to activate for this OAuth token/client.',
      },
    },
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
  },
  _meta: {
    category: 'MCP Discovery',
  },
};

function isEligibleMcpTool(tool: AIToolDefinition): boolean {
  return !!tool.requiredScope && !MCP_EXCLUDED_CATEGORIES.has(tool.category) && !MCP_EXCLUDED_TOOLS.has(tool.name);
}

/** Tool listing: resource-scoped, folder and node grants count; the call re-checks the target resource. */
function hasToolScope(scopes: string[], tool: AIToolDefinition): boolean {
  return hasAIToolVisibilityScope(scopes, tool);
}

/**
 * Same per-call gate as the assistant (`hasToolExecutionScope`): resource-scoped tools are checked against their
 * target resource, while any-scope tools and Docker child resources (`<nodeId>/<resourceId>` grants) are checked
 * against the base scope and authorized per resource by their handlers.
 */
function hasToolScopeForArgs(scopes: string[], tool: AIToolDefinition, args: Record<string, unknown>): boolean {
  return hasAIToolCallScope(scopes, tool, args);
}

function cleanupMcpDiscoveryStates(now = Date.now()): void {
  for (const [key, state] of mcpDiscoveryStates) {
    if (now - state.lastAccessAt > MCP_DISCOVERY_STATE_TTL_MS) {
      mcpDiscoveryStates.delete(key);
    }
  }
}

function mcpDiscoveryStateKey(auth: McpAuthContext): string {
  const authKey = [
    auth.authType ?? 'unknown',
    auth.tokenId || auth.tokenPrefix || 'token',
    auth.clientId ?? 'client',
  ].join(':');
  return auth.mcpSessionId ? `${authKey}:session:${auth.mcpSessionId}` : authKey;
}

function mcpIssuedSessionStateKey(auth: McpAuthContext): string | undefined {
  if (!auth.issuedMcpSessionId || auth.mcpSessionId) return undefined;
  const authKey = [
    auth.authType ?? 'unknown',
    auth.tokenId || auth.tokenPrefix || 'token',
    auth.clientId ?? 'client',
  ].join(':');
  return `${authKey}:session:${auth.issuedMcpSessionId}`;
}

function getMcpDiscoveryState(auth: McpAuthContext): McpDiscoveryState {
  cleanupMcpDiscoveryStates();
  const key = mcpDiscoveryStateKey(auth);
  const existing = mcpDiscoveryStates.get(key);
  if (existing) {
    existing.lastAccessAt = Date.now();
    return existing;
  }
  const state = {
    activeToolsets: new Set(MCP_DEFAULT_TOOLSET_IDS),
    lastAccessAt: Date.now(),
  };
  mcpDiscoveryStates.set(key, state);
  return state;
}

function visibleToolNamesForState(state: McpDiscoveryState): Set<string> {
  const names = new Set<string>(MCP_ALWAYS_VISIBLE_AI_TOOLS);
  for (const id of [...state.activeToolsets].reverse()) {
    const toolset = MCP_TOOLSET_BY_ID.get(id);
    for (const toolName of toolset?.toolNames ?? []) {
      names.add(toolName);
    }
  }
  return names;
}

function toolsetSummary(scopes: string[], state: McpDiscoveryState) {
  return MCP_TOOLSET_DEFINITIONS.map((toolset) => {
    const scopedTools = toolset.toolNames.filter((toolName) => {
      const tool = AI_TOOLS.find((candidate) => candidate.name === toolName);
      return tool && isEligibleMcpTool(tool) && hasToolScope(scopes, tool);
    });
    return {
      id: toolset.id,
      title: toolset.title,
      description: toolset.description,
      active: state.activeToolsets.has(toolset.id),
      isDefault: !!toolset.isDefault,
      availableToolCount: scopedTools.length,
      totalToolCount: toolset.toolNames.length,
      tools: scopedTools,
    };
  });
}

function paginateTools<T>(items: T[], cursor: unknown): { items: T[]; nextCursor?: string } {
  const offset = typeof cursor === 'string' && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const page = items.slice(offset, offset + MCP_TOOLS_PAGE_SIZE);
  const nextOffset = offset + MCP_TOOLS_PAGE_SIZE;
  return {
    items: page,
    nextCursor: nextOffset < items.length ? String(nextOffset) : undefined,
  };
}

async function auditDeniedMcpTool(
  tool: AIToolDefinition | undefined,
  toolName: string,
  auth: McpAuthContext,
  user: User,
  args: Record<string, unknown>,
  reason: string
): Promise<void> {
  const category = tool?.category ?? 'Unknown';
  // Same per-tool redaction as executed calls, so denied and invalid calls never audit a secret either.
  const redactedArgs = redactArgsForAudit(toolName, args);
  setAuditMcpContext({
    toolName,
    category,
    arguments: redactedArgs,
    tokenId: auth.tokenId,
    tokenPrefix: auth.tokenPrefix,
    authType: auth.authType,
    clientId: auth.clientId,
  });

  await container.resolve(AuditService).log({
    userId: user.id,
    action: tool ? `mcp.${toolName}` : 'mcp.tool.denied',
    resourceType: tool ? category.toLowerCase().replace(/\s+/g, '_') : 'mcp_tool',
    resourceId: getAIToolResourceId(tool, args),
    details: {
      source: 'mcp',
      success: false,
      denied: true,
      reason,
      tokenId: auth.tokenId,
      tokenPrefix: auth.tokenPrefix,
      authType: auth.authType,
      clientId: auth.clientId,
      toolName,
      category,
      requiredScope: tool?.requiredScope,
      arguments: redactedArgs,
    },
  });
}

/** Every idempotent replay is audited like the call it stands in for, marked as a replay. */
async function auditReplayedMcpTool(
  tool: AIToolDefinition,
  auth: McpAuthContext,
  user: User,
  args: Record<string, unknown>,
  withheld: boolean
): Promise<void> {
  const redactedArgs = redactArgsForAudit(tool.name, args);
  setAuditMcpContext({
    toolName: tool.name,
    category: tool.category,
    arguments: redactedArgs,
    tokenId: auth.tokenId,
    tokenPrefix: auth.tokenPrefix,
    authType: auth.authType,
    clientId: auth.clientId,
  });
  await container.resolve(AuditService).log({
    userId: user.id,
    action: `mcp.${tool.name}`,
    resourceType: tool.category.toLowerCase().replace(/\s+/g, '_'),
    resourceId: getAIToolResourceId(tool, args),
    details: {
      source: 'mcp',
      success: true,
      idempotencyReplayed: true,
      withheld,
      tokenId: auth.tokenId,
      tokenPrefix: auth.tokenPrefix,
      authType: auth.authType,
      clientId: auth.clientId,
      toolName: tool.name,
      category: tool.category,
      arguments: redactedArgs,
    },
  });
}

export function listAvailableMcpTools(scopes: string[], visibleToolNames?: Set<string>): AIToolDefinition[] {
  const tools = AI_TOOLS.filter(
    (tool) =>
      isEligibleMcpTool(tool) && hasToolScope(scopes, tool) && (!visibleToolNames || visibleToolNames.has(tool.name))
  );
  if (!visibleToolNames) return tools;

  const order = new Map([...visibleToolNames].map((name, index) => [name, index]));
  return tools.sort(
    (left, right) =>
      (order.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.name) ?? Number.MAX_SAFE_INTEGER)
  );
}

export function resetMcpDiscoveryStateForTests(): void {
  mcpDiscoveryStates.clear();
}

function toolError(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function toolResult(value: unknown, options: { idempotencyReplayed?: boolean } = {}): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value ?? null),
      },
    ],
    ...(options.idempotencyReplayed ? { _meta: { idempotencyReplayed: true } } : {}),
  };
}

export function registerMcpToolHandlers(server: McpAuthContext['server'], auth: McpAuthContext, user: User): void {
  const state = getMcpDiscoveryState(auth);
  server.server.registerCapabilities({ tools: { listChanged: true } });

  server.server.setRequestHandler(ListToolsRequestSchema, (request): ListToolsResult => {
    state.lastAccessAt = Date.now();
    const visibleToolNames = auth.eagerToolListing ? undefined : visibleToolNamesForState(state);
    const tools = [
      ...(auth.eagerToolListing ? [] : [MCP_DISCOVER_TOOLS_DEFINITION]),
      ...listAvailableMcpTools(auth.scopes, visibleToolNames).map((tool) => ({
        name: tool.name,
        ...mcpToolListing(tool),
        annotations: {
          readOnlyHint: !tool.destructive && tool.invalidateStores.length === 0,
          destructiveHint: tool.destructive,
        },
        _meta: {
          category: tool.category,
          requiredScope: tool.requiredScope,
        },
      })),
    ];
    if (auth.eagerToolListing) return { tools };

    const page = paginateTools(tools, request.params?.cursor);

    return { tools: page.items, nextCursor: page.nextCursor };
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const toolName = request.params.name;
    const args = request.params.arguments ?? {};
    if (toolName === 'discover_tools') {
      const category = typeof args.category === 'string' ? args.category : undefined;
      if (category) {
        const toolset = MCP_TOOLSET_BY_ID.get(category);
        if (!toolset) {
          return toolError(`Unknown MCP toolset category "${category}"`);
        }
        state.activeToolsets.delete(category);
        state.activeToolsets.add(category);
        state.lastAccessAt = Date.now();
        const issuedSessionKey = mcpIssuedSessionStateKey(auth);
        if (issuedSessionKey) {
          mcpDiscoveryStates.set(issuedSessionKey, {
            activeToolsets: new Set(state.activeToolsets),
            lastAccessAt: state.lastAccessAt,
          });
        }
        await extra.sendNotification({ method: 'notifications/tools/list_changed' });
      }
      return toolResult({
        activeToolsets: [...state.activeToolsets],
        toolsets: toolsetSummary(auth.scopes, state),
      });
    }

    const tool = AI_TOOLS.find((candidate) => candidate.name === toolName);
    const eligible = !!tool && isEligibleMcpTool(tool);
    // Tools hidden by the token scopes never validate arguments, so callers get no schema feedback.
    const visible = !!tool && eligible && hasToolScope(auth.scopes, tool);
    const idempotency = visible ? extractMcpIdempotencyKey(tool, args) : null;
    if (idempotency && !idempotency.ok) return toolError(idempotency.error);
    const validation = visible ? validateAIToolArguments(toolName, idempotency?.args ?? args) : null;
    if (!tool || !visible || !validation?.ok || !hasToolScopeForArgs(auth.scopes, tool, validation.arguments)) {
      await auditDeniedMcpTool(
        tool,
        toolName,
        auth,
        user,
        args,
        !eligible ? 'unavailable_tool' : validation && !validation.ok ? 'invalid_arguments' : 'missing_scope'
      );
      if (validation && !validation.ok) return toolError(validation.error);
      const denied = `Tool "${toolName}" is unavailable for this MCP token`;
      if (tool && visible && validation?.ok && tool.requiredScope) {
        // The tool is listed but not for this target: a folder-, node- or resource-limited grant, not "no access".
        const guided = await withLimitedAccessGuidance(
          `${denied}: "${tool.requiredScope}" is not granted for this target.`,
          auth.scopes,
          accessSummaryDatabase()
        );
        if (guided.includes('get_my_access')) return toolError(guided);
      }
      return toolError(denied);
    }

    const execute = () =>
      container.resolve(AIService).executeTool(user, toolName, validation.arguments, {
        source: 'mcp',
        scopes: auth.scopes,
        tokenId: auth.tokenId,
        tokenPrefix: auth.tokenPrefix,
        authType: auth.authType,
        clientId: auth.clientId,
      });
    const idempotencyKey = idempotency?.ok ? idempotency.key : undefined;
    if (!idempotencyKey) return executionResult(await execute());

    const outcome = await runMcpToolIdempotently(
      { auth, user, toolName, key: idempotencyKey, args: validation.arguments },
      execute
    );
    if (outcome.kind === 'rejected') return toolError(outcome.error);
    if (outcome.kind === 'replayed' || outcome.kind === 'withheld') {
      await auditReplayedMcpTool(tool, auth, user, validation.arguments, outcome.kind === 'withheld');
      return outcome.kind === 'replayed'
        ? toolResult(outcome.result, { idempotencyReplayed: true })
        : toolError(MCP_IDEMPOTENCY_WITHHELD_ERROR);
    }
    return executionResult(outcome.execution);
  });
}

function executionResult(result: ToolExecutionResult): CallToolResult {
  if (result.error) {
    return toolError(result.error);
  }

  return toolResult(result.result);
}
