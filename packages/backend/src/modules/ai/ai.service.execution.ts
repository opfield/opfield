import { container, TOKENS } from '@/container.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { withLimitedAccessGuidance } from '@/lib/access-denied.js';
import { accessSummaryDatabase } from '@/lib/access-summary-resolver.js';
import { boundScopes, hasScopeBase } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { getAuditRequestContext, setAuditMcpContext } from '@/modules/audit/audit-request-context.js';
import { type LicenseFeature, requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { User } from '@/types.js';
import { ACCESS_LIST_TOOL_NAMES, executeAccessListTool } from './ai.access-list-tools.js';
import { ACCESS_TOOL_NAMES, executeAccessTool } from './ai.access-tools.js';
import { APP_INCIDENT_TOOL_NAMES, executeAppIncidentTool } from './ai.app-incident-tools.js';
import { APP_PROMOTION_TOOL_NAMES, executeAppPromotionTool } from './ai.app-promotion-tools.js';
import { APP_TOOL_NAMES, executeAppTool } from './ai.app-tools.js';
import { executeBackupTool } from './ai.backup-tools.js';
import { DATABASE_TOOL_NAMES, executeDatabaseTool } from './ai.database-tools.js';
import { DOCKER_TOOL_NAMES, executeDockerTool } from './ai.docker-tools.js';
import { DOMAIN_TOOL_NAMES, executeDomainTool } from './ai.domain-tools.js';
import { executeFolderTool, FOLDER_TOOL_NAMES } from './ai.folder-tools.js';
import { executeGitScopeTargetTool, GIT_SCOPE_TARGET_TOOL_NAMES } from './ai.git-scope-target-tools.js';
import { executeGitLabTool, GITLAB_TOOL_NAMES } from './ai.gitlab-tools.js';
import { executeGroupTool, GROUP_TOOL_NAMES } from './ai.group-tools.js';
import { executeHostingTool, HOSTING_TOOL_NAMES } from './ai.hosting-tools.js';
import { executeInferenceTool, INFERENCE_TOOL_NAMES } from './ai.inference-tools.js';
import { executeIngressGroupTool, INGRESS_GROUP_TOOL_NAMES } from './ai.ingress-group-tools.js';
import { executeIntegrationTool, INTEGRATION_TOOL_NAMES } from './ai.integration-tools.js';
import {
  assertDockerToolNode,
  DOCKER_LIST_TOOLS,
  deniedNodeTargetText,
  hasNodeIdArgument,
  listDockerAcrossNodes,
  type NodeDirectory,
  nodeDirectoryFor,
  withNodeTargetGuidance,
} from './ai.node-target-guidance.js';
import { executeNodeTool, NODE_TOOL_NAMES } from './ai.node-tools.js';
import {
  executeNotificationTool,
  NOTIFICATION_TOOL_NAMES,
  SIEM_NOTIFICATION_TOOL_NAMES,
} from './ai.notification-tools.js';
import { executePkiCaTool, PKI_CA_TOOL_NAMES } from './ai.pki-ca-tools.js';
import { executePkiCertificateTool, PKI_CERTIFICATE_TOOL_NAMES } from './ai.pki-certificate-tools.js';
import { executePkiTemplateTool, PKI_TEMPLATE_TOOL_NAMES } from './ai.pki-template-tools.js';
import { executeProxyTool, PROXY_TOOL_NAMES } from './ai.proxy-tools.js';
import { executeResourceSetupTool, RESOURCE_SETUP_TOOL_NAMES } from './ai.resource-setup-tools.js';
import {
  isRecord,
  isToolAllowedForPlanState,
  logger,
  SANDBOX_TOOL_NAMES,
  type ToolRuntimeContext,
  UNHANDLED_TOOL,
} from './ai.service.runtime-helpers.js';
import { AIServiceRuntimeSupport } from './ai.service.runtime-support.js';
import { redactArgsForAudit } from './ai.service.tool-helpers.js';
import { getToolResourceId, hasToolExecutionScope, isMutatingTool } from './ai.service-helpers.js';
import { executeSshTool, SSH_TOOL_NAMES } from './ai.ssh-tools.js';
import { executeStorageTool, STORAGE_TOOL_NAMES } from './ai.storage-tools.js';
import { AI_TOOLS, TOOL_STORE_INVALIDATION_MAP } from './ai.tools.js';
import type { ToolExecutionOptions, ToolExecutionResult } from './ai.types.js';
import { assertToolCallAllowedUnderImpersonation } from './ai-impersonation-policy.js';
import { describeToolError, formatToolError } from './ai-tool-errors.js';
import {
  publishToolStoreInvalidation,
  resolveToolStoreInvalidations,
  toolInvalidationContext,
} from './ai-tool-store-invalidation.js';

const GIT_CREDENTIAL_REQUIRED_CODES = new Set([
  'GITLAB_CREDENTIAL_REQUIRED',
  'GITHUB_CREDENTIAL_REQUIRED',
  'GIT_CREDENTIAL_REQUIRED',
  // A stored personal token that expired needs the same re-authorization.
  'GIT_CREDENTIAL_EXPIRED',
]);

/** Remote MCP has no credential sign-in prompt, so the 428 challenge becomes an actionable tool error. */
function mcpGitCredentialRequiredMessage(err: AppError): string {
  const details = isRecord(err.details) ? err.details : {};
  const provider =
    details.provider === 'gitlab' || details.provider === 'github' || details.provider === 'git'
      ? details.provider
      : err.code === 'GITLAB_CREDENTIAL_REQUIRED'
        ? 'gitlab'
        : err.code === 'GITHUB_CREDENTIAL_REQUIRED'
          ? 'github'
          : 'git';
  const label = provider === 'gitlab' ? 'GitLab' : provider === 'github' ? 'GitHub' : 'Git';
  const connector = typeof details.connectorName === 'string' ? details.connectorName : 'this connector';
  const state =
    details.reason === 'invalid' ? 'was rejected' : details.reason === 'expired' ? 'has expired' : 'is not set up';
  return `${err.code}: The personal ${label} credential for ${connector} ${state}, and remote MCP cannot start that sign-in. Grant this token integrations:${provider}:use, or set up the personal ${label} credential in AI Workspace, then retry.`;
}

/** Enterprise tools that read, revoke, export, or delete existing SIEM and PKI resources. */
const PAID_EXISTING_TOOLS = new Set([
  'list_siem_destinations',
  'get_siem_destination',
  'delete_siem_destination',
  'list_siem_deliveries',
  'get_siem_delivery',
  'list_templates',
  'delete_template',
  'list_cas',
  'get_ca',
  'delete_ca',
  'list_certificates',
  'get_certificate',
  'revoke_certificate',
]);
const PAID_EXISTING_OPERATIONS: Record<string, ReadonlySet<string>> = {
  manage_template: new Set(['get']),
  manage_ca: new Set(['revoke', 'export_key']),
  manage_certificate: new Set(['chain', 'export']),
};

/**
 * Same classes as the SIEM and PKI routes: existing resources keep working after the
 * license grace period; creating, changing, issuing, testing, and requeueing (and any
 * unknown operation) needs the current plan.
 */
function isExistingPaidToolCall(toolName: string, args: Record<string, unknown>): boolean {
  if (PAID_EXISTING_TOOLS.has(toolName)) return true;
  return PAID_EXISTING_OPERATIONS[toolName]?.has(String(args.operation ?? '')) ?? false;
}

function toolNodeDirectory(): NodeDirectory | null {
  return nodeDirectoryFor(accessSummaryDatabase());
}

/** Node-type guidance for a refused call; the plain message when the lookup is unavailable or fails. */
async function withNodeGuidance(
  message: string,
  code: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
  scopes: string[]
): Promise<string> {
  const directory = toolNodeDirectory();
  if (!directory) return message;
  try {
    return await withNodeTargetGuidance({ message, code, toolName, args, scopes, directory });
  } catch (error) {
    logger.warn('Failed to add node guidance to a tool error', { toolName, error });
    return message;
  }
}

export abstract class AIServiceExecution extends AIServiceRuntimeSupport {
  protected abstract executeInteractionTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext: ToolRuntimeContext
  ): Promise<unknown>;
  protected abstract executeAdministrationTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext: ToolRuntimeContext
  ): Promise<unknown>;
  protected abstract executeLifecycleTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext: ToolRuntimeContext
  ): Promise<unknown>;

  async executeTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    options: ToolExecutionOptions = {}
  ): Promise<ToolExecutionResult> {
    const toolDef = AI_TOOLS.find((t) => t.name === toolName);
    if (!toolDef) {
      return { error: `Unknown tool: ${toolName}`, invalidateStores: [] };
    }
    if (toolDef.mcpOnly && options.source !== 'mcp') {
      return { error: `Tool ${toolName} is available only through remote MCP`, invalidateStores: [] };
    }

    const activePlan =
      options.source !== 'mcp' && options.conversationId && this.planService
        ? await this.planService.getActivePlanSnapshot(user.id, options.conversationId)
        : null;
    if (!isToolAllowedForPlanState(toolDef, activePlan?.status ?? null, args)) {
      return {
        error: `PLAN_MODE_BLOCKED: ${toolName} is unavailable while the active plan is ${activePlan?.status ?? 'inactive'}.`,
        invalidateStores: [],
      };
    }

    let executionUser: User;
    const refreshUser = this.authService?.getUserById?.bind(this.authService);
    if (!refreshUser) {
      // Lightweight unit-test service constructors may omit AuthService; production DI always supplies it.
      executionUser = options.scopes ? { ...user, scopes: options.scopes } : user;
    } else {
      try {
        const currentUser = await refreshUser(user.id);
        if (!currentUser || currentUser.isBlocked) {
          return {
            error: 'PERMISSION_DENIED: Your current account access no longer allows this action.',
            invalidateStores: [],
          };
        }
        executionUser =
          options.source === 'mcp'
            ? {
                ...currentUser,
                scopes: boundScopes(options.scopes ?? [], currentUser.scopes),
                accountScopes: currentUser.scopes,
              }
            : currentUser;
      } catch (error) {
        logger.warn('Failed to refresh current access before AI tool execution', { userId: user.id, error });
        return {
          error: 'PERMISSION_DENIED: Current account access could not be verified.',
          invalidateStores: [],
        };
      }
    }

    // Permission check — tools with empty requiredScope are blocked (must be explicit)
    if (!hasToolExecutionScope(executionUser.scopes, toolName, toolDef.requiredScope, args, toolDef)) {
      // A caller holding the scope on other folders, nodes or resources is limited, not unauthorized.
      if (toolDef.requiredScope && hasScopeBase(executionUser.scopes, toolDef.requiredScope)) {
        return {
          error: await withLimitedAccessGuidance(
            `PERMISSION_DENIED: "${toolDef.requiredScope}" is not granted ${await deniedNodeTargetText(args, executionUser.scopes, toolNodeDirectory())}.`,
            executionUser.scopes,
            accessSummaryDatabase()
          ),
          invalidateStores: [],
        };
      }
      return {
        error: `PERMISSION_DENIED: You do not have the "${toolDef.requiredScope || 'unknown'}" scope required for this action. Tell the user they lack this permission and suggest contacting an administrator. Do NOT ask follow-up questions or retry.`,
        invalidateStores: [],
      };
    }

    const source = options.source ?? 'ai';
    const shouldAudit = isMutatingTool(toolDef);
    const redactedArgs = redactArgsForAudit(toolName, args);
    const mcpDetails =
      source === 'mcp'
        ? {
            toolName,
            category: toolDef.category,
            arguments: redactedArgs,
            tokenId: options.tokenId,
            tokenPrefix: options.tokenPrefix,
            authType: options.authType,
            clientId: options.clientId,
          }
        : undefined;
    if (mcpDetails) setAuditMcpContext(mcpDetails);
    const auditWasEmitted = getAuditRequestContext()?.auditEmitted ?? false;
    const auditEmittedDuringTool = () => !auditWasEmitted && Boolean(getAuditRequestContext()?.auditEmitted);
    const auditBase = {
      userId: user.id,
      resourceType: toolDef.category.toLowerCase().replace(/\s+/g, '_'),
      resourceId: getToolResourceId(toolDef, args),
    };

    try {
      assertToolCallAllowedUnderImpersonation(toolName, args);
      const result = await this.executeToolInternal(executionUser, toolName, args, {
        pageContext: options.pageContext,
        conversationId: options.conversationId,
        source,
      });
      const invalidateStores = resolveToolStoreInvalidations(
        toolName,
        args,
        TOOL_STORE_INVALIDATION_MAP[toolName] || []
      );
      await this.persistToolRuntimeState(user, options, toolName, result);

      publishToolStoreInvalidation(this.eventBus, {
        userId: user.id,
        source,
        toolName,
        stores: invalidateStores,
        resourceId: getToolResourceId(toolDef, args),
        context: toolInvalidationContext(args),
      });

      if (source === 'mcp' && !auditEmittedDuringTool()) {
        await this.auditService.log({
          ...auditBase,
          action: `mcp.${toolName}`,
          details: { ...mcpDetails, source: 'mcp', success: true },
        });
      } else if (source === 'ai' && shouldAudit) {
        await this.auditService.log({
          ...auditBase,
          action: `${source}.${toolName}`,
          details: { ai_initiated: true, arguments: redactedArgs },
        });
      }

      return { result, invalidateStores };
    } catch (err) {
      if (source === 'ai' && err instanceof AppError && GIT_CREDENTIAL_REQUIRED_CODES.has(err.code)) {
        const details = isRecord(err.details) ? err.details : {};
        const provider = details.provider ?? (err.code === 'GITLAB_CREDENTIAL_REQUIRED' ? 'gitlab' : null);
        if (
          typeof details.connectorId === 'string' &&
          (provider === 'gitlab' || provider === 'github' || provider === 'git')
        ) {
          return {
            credentialChallenge: { provider, connectorId: details.connectorId },
            invalidateStores: [],
          };
        }
      }
      const toolError = describeToolError(err);
      const message =
        source === 'mcp' && err instanceof AppError && GIT_CREDENTIAL_REQUIRED_CODES.has(err.code)
          ? mcpGitCredentialRequiredMessage(err)
          : formatToolError(toolError);
      // Refusals (permission, validation, not found, conflict) are answers to the caller, not failures of Opfield.
      if (toolError.expected) {
        logger.warn(`Tool call refused: ${toolName}`, {
          code: toolError.code,
          message: toolError.message,
          args: redactedArgs,
        });
      } else {
        logger.error(`Tool execution failed: ${toolName}`, { error: err, args: redactedArgs });
      }
      if (source === 'mcp' && !auditEmittedDuringTool()) {
        await this.auditService.log({
          ...auditBase,
          action: `mcp.${toolName}`,
          details: {
            ...mcpDetails,
            source: 'mcp',
            success: false,
            error: message,
          },
        });
      }
      // Folder-, node- and resource-limited callers learn where they can act instead of reading "no access",
      // and a call on a node of the wrong type learns which nodes take it.
      const guided = await withNodeGuidance(message, toolError.code, toolName, args, executionUser.scopes);
      return {
        error: await withLimitedAccessGuidance(guided, executionUser.scopes, accessSummaryDatabase()),
        invalidateStores: [],
      };
    }
  }

  protected async executeSandboxTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext: ToolRuntimeContext
  ) {
    const config = await this.settingsService.getConfig();
    if (!config.sandboxEnabled) {
      throw new Error('Sandbox runner is disabled');
    }
    if (!this.sandboxService) {
      throw new Error('Sandbox runner is not configured');
    }
    const a = args as Record<string, unknown>;
    const resourceTier = (a.resourceTier ?? config.sandboxDefaultTier) as never;
    switch (toolName) {
      case 'execute_script':
        return this.sandboxService.executeScript(user, {
          runtime: a.runtime,
          script: String(a.script ?? ''),
          resourceTier,
          ttlSeconds: typeof a.ttlSeconds === 'number' ? a.ttlSeconds : undefined,
          conversationId: runtimeContext.conversationId,
        });
      case 'run_process':
        return this.sandboxService.runProcess(user, {
          runtime: a.runtime,
          command: Array.isArray(a.command) ? a.command.map(String) : [],
          resourceTier,
          ttlSeconds: typeof a.ttlSeconds === 'number' ? a.ttlSeconds : undefined,
          conversationId: runtimeContext.conversationId,
        });
      case 'fetch':
        return this.sandboxService.fetch(user, { url: String(a.url ?? '') });
      case 'download_artifact':
        return this.sandboxService.downloadArtifact(user, {
          processId: String(a.processId ?? ''),
          url: String(a.url ?? ''),
          path: typeof a.path === 'string' ? a.path : undefined,
        });
      case 'list_artifact_files':
        return this.sandboxService.listArtifactFiles(user, {
          processId: String(a.processId ?? ''),
          path: typeof a.path === 'string' ? a.path : undefined,
          maxDepth: typeof a.maxDepth === 'number' ? a.maxDepth : undefined,
          limit: typeof a.limit === 'number' ? a.limit : undefined,
          includeFiles: typeof a.includeFiles === 'boolean' ? a.includeFiles : undefined,
          includeDirectories: typeof a.includeDirectories === 'boolean' ? a.includeDirectories : undefined,
        });
      case 'read_artifact':
        return this.sandboxService.readArtifact(user, {
          processId: String(a.processId ?? ''),
          path: String(a.path ?? ''),
          offset: typeof a.offset === 'number' ? a.offset : undefined,
          length: typeof a.length === 'number' ? a.length : undefined,
          encoding: a.encoding === 'base64' ? 'base64' : 'utf8',
        });
      case 'send_artifact':
        return this.sandboxService.sendArtifact(user, {
          processId: String(a.processId ?? ''),
          path: String(a.path ?? ''),
          filename: typeof a.filename === 'string' ? a.filename : undefined,
          mediaType: typeof a.mediaType === 'string' ? a.mediaType : undefined,
          conversationId: runtimeContext.conversationId,
        });
      case 'read_process_output':
        return this.sandboxService.readProcessOutput(
          user,
          String(a.processId ?? ''),
          typeof a.tail === 'number' ? a.tail : undefined
        );
      case 'write_process_stdin':
        return this.sandboxService.writeProcessStdin(
          user,
          String(a.processId ?? ''),
          String(a.data ?? ''),
          a.close === true
        );
      case 'kill_process':
        return this.sandboxService.killProcess(user, String(a.processId ?? ''));
      case 'list_sandbox_jobs':
        return this.sandboxService.listJobs(user, {
          activeOnly: a.activeOnly === true,
          limit: typeof a.limit === 'number' ? a.limit : undefined,
        });
      default:
        throw new Error(`Unsupported sandbox tool: ${toolName}`);
    }
  }

  private async requirePaidToolFeature(
    feature: LicenseFeature,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<void> {
    const policy = requireConfiguredLicensePolicy(this.licensePolicyService);
    if (isExistingPaidToolCall(toolName, args)) await policy.requireFeatureForExistingRuntime(feature);
    else await policy.requireFeature(feature);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async executeToolInternal(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext: ToolRuntimeContext = {}
  ): Promise<unknown> {
    // Tool args come from LLM JSON — use explicit casts to match service input types.
    // The services themselves validate the data, so loose typing here is acceptable.
    const a = args as any; // shorthand for repeated casts

    if (toolName === 'read_tool_output' || toolName === 'search_tool_output') {
      if (!this.artifactService || !runtimeContext.conversationId) {
        throw new AppError(
          409,
          'TOOL_OUTPUT_CONTEXT_REQUIRED',
          'Tool-output artifacts can only be accessed from their originating conversation'
        );
      }
      if (toolName === 'read_tool_output') {
        return this.artifactService.readToolOutput({
          userId: user.id,
          conversationId: runtimeContext.conversationId,
          artifactId: String(a.artifactId ?? ''),
          offset: typeof a.offset === 'number' ? a.offset : undefined,
          limitBytes: typeof a.limitBytes === 'number' ? a.limitBytes : undefined,
        });
      }
      return this.artifactService.searchToolOutput({
        userId: user.id,
        conversationId: runtimeContext.conversationId,
        artifactId: String(a.artifactId ?? ''),
        query: String(a.query ?? ''),
        maxMatches: typeof a.maxMatches === 'number' ? a.maxMatches : undefined,
      });
    }

    if (ACCESS_TOOL_NAMES.has(toolName)) return executeAccessTool(user, toolName, args, runtimeContext.source);
    if (toolName === 'manage_database_backups') return executeBackupTool(user, args);
    if (STORAGE_TOOL_NAMES.has(toolName)) return executeStorageTool(user, toolName, args);
    if (DATABASE_TOOL_NAMES.has(toolName)) {
      return executeDatabaseTool({ databaseService: this.databaseService }, user, toolName, args);
    }
    if (INFERENCE_TOOL_NAMES.has(toolName)) {
      return executeInferenceTool(user, toolName, args);
    }
    if (INTEGRATION_TOOL_NAMES.has(toolName)) {
      return executeIntegrationTool(user, toolName, args);
    }
    if (GIT_SCOPE_TARGET_TOOL_NAMES.has(toolName)) return executeGitScopeTargetTool(user, args);
    if (HOSTING_TOOL_NAMES.has(toolName)) {
      return executeHostingTool(user, toolName, args);
    }
    if (RESOURCE_SETUP_TOOL_NAMES.has(toolName)) {
      return executeResourceSetupTool(user, toolName, args);
    }
    if (DOCKER_TOOL_NAMES.has(toolName)) {
      const dockerContext = {
        dockerService: this.dockerService,
        ensureToolScope: (executionUser: User, scope: string) => this.ensureToolScope(executionUser, scope),
        ensureToolScopeForResource: (executionUser: User, baseScope: string, resourceId: string) =>
          this.ensureToolScopeForResource(executionUser, baseScope, resourceId),
      };
      const directory = toolNodeDirectory();
      if (directory) {
        // A Docker list without nodeId lists every Docker node the caller can see instead of failing.
        if (DOCKER_LIST_TOOLS.has(toolName) && !hasNodeIdArgument(args)) {
          return listDockerAcrossNodes(user.scopes, directory, (nodeId) =>
            executeDockerTool(dockerContext, user, toolName, { ...args, nodeId })
          );
        }
        await assertDockerToolNode(toolName, args, directory);
      }
      return executeDockerTool(dockerContext, user, toolName, args);
    }
    if (NOTIFICATION_TOOL_NAMES.has(toolName)) {
      if (SIEM_NOTIFICATION_TOOL_NAMES.has(toolName)) {
        // LICENSE ENFORCEMENT: AI/MCP callers cannot bypass the Enterprise SIEM entitlement.
        await this.requirePaidToolFeature('siem-export', toolName, args);
      }
      return executeNotificationTool(
        {
          notifRuleService: this.notifRuleService,
          notifWebhookService: this.notifWebhookService,
          notifDeliveryService: this.notifDeliveryService,
          notifDispatcherService: this.notifDispatcherService,
          siemDestinationService: this.siemDestinationService,
          siemDeliveryService: this.siemDeliveryService,
          generalSettingsService: this.generalSettingsService,
        },
        user,
        toolName,
        args
      );
    }
    if (SANDBOX_TOOL_NAMES.has(toolName)) {
      return this.executeSandboxTool(user, toolName, args, runtimeContext);
    }
    if (GITLAB_TOOL_NAMES.has(toolName)) {
      return executeGitLabTool(
        {
          sandboxService: this.sandboxService,
          conversationId: runtimeContext.conversationId,
        },
        user,
        toolName,
        args
      );
    }
    if (SSH_TOOL_NAMES.has(toolName)) {
      return executeSshTool(user, toolName, args);
    }
    if (FOLDER_TOOL_NAMES.has(toolName)) {
      return executeFolderTool(user, toolName, args);
    }
    if (NODE_TOOL_NAMES.has(toolName)) {
      return executeNodeTool(
        { nodesService: this.nodesService, getDispatchService: () => container.resolve(NodeDispatchService) },
        user,
        toolName,
        args
      );
    }
    if (GROUP_TOOL_NAMES.has(toolName)) {
      return executeGroupTool(
        { groupService: this.groupService, auditService: this.auditService },
        user,
        toolName,
        args
      );
    }
    if (DOMAIN_TOOL_NAMES.has(toolName)) {
      return executeDomainTool(
        {
          domainsService: this.domainsService,
          ensureToolScopeForResource: (executionUser, baseScope, resourceId) =>
            this.ensureToolScopeForResource(executionUser, baseScope, resourceId),
        },
        user,
        toolName,
        args
      );
    }
    if (APP_TOOL_NAMES.has(toolName)) {
      return executeAppTool(user, toolName, args);
    }
    if (APP_INCIDENT_TOOL_NAMES.has(toolName)) {
      return executeAppIncidentTool(user, args);
    }
    if (APP_PROMOTION_TOOL_NAMES.has(toolName)) {
      return executeAppPromotionTool(user, args);
    }
    if (INGRESS_GROUP_TOOL_NAMES.has(toolName)) {
      return executeIngressGroupTool(user, args);
    }
    if (ACCESS_LIST_TOOL_NAMES.has(toolName)) {
      return executeAccessListTool(
        {
          accessListService: this.accessListService,
          ensureToolScopeForResource: (executionUser, baseScope, resourceId) =>
            this.ensureToolScopeForResource(executionUser, baseScope, resourceId),
        },
        user,
        toolName,
        args
      );
    }
    if (PKI_TEMPLATE_TOOL_NAMES.has(toolName)) {
      // LICENSE ENFORCEMENT: AI/MCP callers cannot bypass the Enterprise PKI entitlement.
      await this.requirePaidToolFeature('internal-pki', toolName, args);
      return executePkiTemplateTool(
        {
          templatesService: this.templatesService,
          ensureToolScope: (executionUser, scope) => this.ensureToolScope(executionUser, scope),
          ensureToolScopeForResource: (executionUser, baseScope, resourceId) =>
            this.ensureToolScopeForResource(executionUser, baseScope, resourceId),
        },
        user,
        toolName,
        args
      );
    }
    if (PKI_CA_TOOL_NAMES.has(toolName)) {
      // LICENSE ENFORCEMENT: AI/MCP callers cannot bypass the Enterprise PKI entitlement.
      await this.requirePaidToolFeature('internal-pki', toolName, args);
      if (!container.isRegistered(TOKENS.CommercialEdition)) return commercialModuleUnavailable();
      container.resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition).requireAvailable();
      return executePkiCaTool({ caService: this.caService, auditService: this.auditService }, user, toolName, args);
    }
    if (PKI_CERTIFICATE_TOOL_NAMES.has(toolName)) {
      // LICENSE ENFORCEMENT: AI/MCP callers cannot bypass the Enterprise PKI entitlement.
      if (toolName !== 'audit_system_pki_leaves') {
        await this.requirePaidToolFeature('internal-pki', toolName, args);
        if (!container.isRegistered(TOKENS.CommercialEdition)) return commercialModuleUnavailable();
        container.resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition).requireAvailable();
      }
      return executePkiCertificateTool(
        {
          caService: this.caService,
          certService: this.certService,
          auditService: this.auditService,
          ensureToolScope: (executionUser, scope) => this.ensureToolScope(executionUser, scope),
          ensureToolScopeForResource: (executionUser, baseScope, resourceId) =>
            this.ensureToolScopeForResource(executionUser, baseScope, resourceId),
        },
        user,
        toolName,
        args
      );
    }
    if (PROXY_TOOL_NAMES.has(toolName)) {
      return executeProxyTool(
        { proxyService: this.proxyService, folderService: this.folderService },
        user,
        toolName,
        args
      );
    }

    const interactionResult = await this.executeInteractionTool(user, toolName, args, runtimeContext);
    if (interactionResult !== UNHANDLED_TOOL) return interactionResult;
    const administrationResult = await this.executeAdministrationTool(user, toolName, args, runtimeContext);
    if (administrationResult !== UNHANDLED_TOOL) return administrationResult;
    const lifecycleResult = await this.executeLifecycleTool(user, toolName, args, runtimeContext);
    if (lifecycleResult !== UNHANDLED_TOOL) return lifecycleResult;
    throw new Error(`Tool not implemented: ${toolName}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}
