import { container } from '@/container.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { hasScope, hasScopeBase, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { appForMember } from '@/modules/apps/app-membership.js';
import {
  CreateNginxTemplateSchema,
  PreviewNginxTemplateSchema,
  UpdateNginxTemplateSchema,
} from '@/modules/proxy/nginx-template.schemas.js';
import { renderTemplatePreviewForHost, testTemplateContent } from '@/modules/proxy/nginx-template-preview.js';
import { redactProxyHostForScopes } from '@/modules/proxy/page-target-visibility.js';
import { assertTlsResyncAccess } from '@/modules/proxy/tls-resync-access.js';
import {
  LinkInternalCertSchema,
  RequestACMECertSchema,
  SetSslAutoRenewSchema,
  SSLCertListQuerySchema,
  UploadCertSchema,
} from '@/modules/ssl/ssl.schemas.js';
import { SSLCertificateFolderService } from '@/modules/ssl/ssl-certificate-folders.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { User } from '@/types.js';
import { requireExistingPageRouteAccess } from './ai.proxy-tools.js';
import { AIServiceExecution } from './ai.service.execution.js';
import {
  SEND_COMMENT_EMPTY_ERROR,
  SEND_COMMENT_TOOL_NAME,
  type ToolRuntimeContext,
  UNHANDLED_TOOL,
} from './ai.service.runtime-helpers.js';
import {
  commentMessageFromArgs,
  normalizeReadChatSliceMode,
  normalizeSearchScope,
  stringArg,
} from './ai.service.tool-helpers.js';
import {
  agentPage,
  agentPageLimit,
  allowedResourceIdsForScopes,
  compactProxyHostForAgent,
} from './ai.service-helpers.js';
import { AISkillService } from './ai.skills.js';
import { AIConversationSearchService } from './ai-conversation-search.service.js';

export abstract class AIServiceInteractionTools extends AIServiceExecution {
  protected async executeInteractionTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext: ToolRuntimeContext
  ): Promise<unknown> {
    const a = args as any;
    switch (toolName) {
      // ── Discovery ──
      case 'discover_tools':
        return this.discoverTools(user, args, runtimeContext.conversationId);

      case 'read_skill': {
        const skillId = stringArg(a.skillId);
        if (!skillId) throw new AppError(400, 'AI_SKILL_ID_REQUIRED', 'skillId is required');
        const skill = await new AISkillService(this.settingsService).getRuntimeSkill(skillId);
        return { skill, active: false, nextStep: 'Call activate_skill before applying this skill.' };
      }

      case 'activate_skill': {
        const skillId = stringArg(a.skillId);
        if (!skillId) throw new AppError(400, 'AI_SKILL_ID_REQUIRED', 'skillId is required');
        const skill = await new AISkillService(this.settingsService).getRuntimeSkill(skillId);
        return {
          active: true,
          activationScope: 'current_context',
          priority: skill.source === 'system' ? 'system_skill' : 'organization_skill',
          skill,
          instruction:
            'Apply the activated instructions while they remain in the current context. Do not activate this skill again until compaction removes this activation. Base security, authorization, permission, and approval rules always take priority.',
        };
      }

      case 'get_current_context':
        return {
          currentPage: runtimeContext.pageContext ?? null,
          hasCurrentPage: !!runtimeContext.pageContext?.route,
        };

      case 'wait': {
        const rawSeconds = Number(a.seconds ?? 5);
        const seconds = Math.min(30, Math.max(1, Number.isFinite(rawSeconds) ? rawSeconds : 5));
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        return {
          waitedSeconds: seconds,
          reason: stringArg(a.reason) ?? null,
          nextStep: 'Call the relevant read/status tool again to verify whether the pending operation completed.',
        };
      }

      case SEND_COMMENT_TOOL_NAME: {
        const message = commentMessageFromArgs(args);
        if (!message) throw new Error(SEND_COMMENT_EMPTY_ERROR);
        return { delivered: true, message };
      }

      case 'end_conversation': {
        const reason = String(a.reason ?? '').trim();
        return {
          ended: true,
          reason: reason || 'This conversation has been ended.',
        };
      }

      case 'find_resource':
        return this.searchResources(user, args, runtimeContext);
      case 'search_chats':
        return (this.conversationSearchService ?? container.resolve(AIConversationSearchService)).searchChats(user.id, {
          query: String(a.query ?? ''),
          scope: normalizeSearchScope(a.scope),
          limit: typeof a.limit === 'number' ? a.limit : undefined,
          currentConversationId: runtimeContext.conversationId,
        });
      case 'search_compacted_history': {
        if (!runtimeContext.conversationId) {
          throw new AppError(
            409,
            'AI_CONVERSATION_REQUIRED',
            'search_compacted_history requires the current saved conversation'
          );
        }
        return (
          this.conversationSearchService ?? container.resolve(AIConversationSearchService)
        ).searchCompactedHistory(user.id, {
          conversationId: runtimeContext.conversationId,
          query: String(a.query ?? ''),
          limit: typeof a.limit === 'number' ? a.limit : undefined,
        });
      }
      case 'find_in_chat':
        return (this.conversationSearchService ?? container.resolve(AIConversationSearchService)).findInChat(user.id, {
          conversationId: String(a.conversationId ?? ''),
          query: String(a.query ?? ''),
          limit: typeof a.limit === 'number' ? a.limit : undefined,
          currentConversationId: runtimeContext.conversationId,
        });
      case 'read_chat_slice':
        return (this.conversationSearchService ?? container.resolve(AIConversationSearchService)).readChatSlice(
          user.id,
          {
            conversationId: String(a.conversationId ?? ''),
            mode: normalizeReadChatSliceMode(a.mode),
            messageId: typeof a.messageId === 'string' ? a.messageId : undefined,
            cursor: typeof a.cursor === 'string' ? a.cursor : undefined,
            limit: typeof a.limit === 'number' ? a.limit : undefined,
            currentConversationId: runtimeContext.conversationId,
          }
        );
      case 'list_chat_projects':
        return (this.conversationSearchService ?? container.resolve(AIConversationSearchService)).listProjects(
          user.id,
          {
            limit: typeof a.limit === 'number' ? a.limit : undefined,
            cursor: typeof a.cursor === 'string' ? a.cursor : undefined,
            currentConversationId: runtimeContext.conversationId,
          }
        );

      case 'manage_proxy_template': {
        const { NginxTemplateService } = await import('@/modules/proxy/nginx-template.service.js');
        const templateService = container.resolve(NginxTemplateService);
        if (a.operation === 'list') {
          if (!hasScopeBase(user.scopes, 'proxy:templates:view')) this.ensureToolScope(user, 'proxy:templates:view');
          return templateService.listTemplates({
            allowedIds: allowedResourceIdsForScopes(user.scopes, 'proxy:templates:view'),
          });
        }
        if (a.operation === 'preview') {
          // Mirrors POST /nginx-templates/preview.
          if (!hasScopeBase(user.scopes, 'proxy:templates:view')) this.ensureToolScope(user, 'proxy:templates:view');
          const input = PreviewNginxTemplateSchema.parse({ content: a.content, hostId: a.routeId });
          if (!input.hostId) return { rendered: templateService.previewWithSampleData(input.content) };
          this.ensureToolScope(user, `proxy:view:${input.hostId}`);
          const host = await this.proxyService.getProxyHost(input.hostId);
          const includeAdvancedConfig = hasScope(user.scopes, `proxy:advanced:${input.hostId}`);
          return {
            rendered: renderTemplatePreviewForHost(templateService, input.content, host, includeAdvancedConfig),
          };
        }
        if (a.operation === 'test') {
          // Mirrors POST /nginx-templates/test: proxy:templates:manage on the template, or broad to test new content.
          const input = PreviewNginxTemplateSchema.parse({ content: a.content, templateId: a.templateId });
          this.ensureToolScope(
            user,
            input.templateId ? `proxy:templates:manage:${input.templateId}` : 'proxy:templates:manage'
          );
          return testTemplateContent(
            templateService,
            container.resolve(NodeDispatchService),
            input.content,
            user.scopes
          );
        }
        if (a.operation === 'get') {
          this.ensureToolScopeForResource(user, 'proxy:templates:view', String(a.templateId));
          return templateService.getTemplate(a.templateId);
        }
        // Template content writes need proxy:templates:manage: on the destination to create, on the template to change it.
        if (a.operation === 'create') {
          // Mirrors POST /nginx-templates: broad manage, or manage on the destination folder.
          const input = CreateNginxTemplateSchema.parse(args);
          const { NginxTemplateFolderService } = await import('@/modules/proxy/nginx-template-folders.service.js');
          await container.resolve(NginxTemplateFolderService).assertCreateFolder(user.scopes, input.folderId);
          return templateService.createTemplate(input, user.id, user.scopes);
        }
        if (a.operation === 'update') {
          this.ensureToolScopeForResource(user, 'proxy:templates:manage', String(a.templateId));
          return templateService.updateTemplate(
            a.templateId,
            UpdateNginxTemplateSchema.parse(args),
            user.id,
            user.scopes
          );
        }
        if (a.operation === 'delete') {
          this.ensureToolScopeForResource(user, 'proxy:templates:manage', String(a.templateId));
          await templateService.deleteTemplate(a.templateId, user.id);
          return { success: true };
        }
        if (a.operation === 'clone') {
          // Reads the source and creates a new template.
          this.ensureToolScopeForResource(user, 'proxy:templates:view', String(a.templateId));
          this.ensureToolScope(user, 'proxy:templates:manage');
          return templateService.cloneTemplate(a.templateId, user.id, user.scopes);
        }
        throw new Error(`Unsupported proxy template operation: ${String(a.operation)}`);
      }

      // ── SSL Certificates ──
      case 'list_ssl_certificates': {
        const query = SSLCertListQuerySchema.parse({
          search: a.search,
          type: a.type,
          status: a.status,
          showSystem: a.showSystem === true ? 'true' : undefined,
          excludeAppMembers: a.excludeAppMembers === true ? 'true' : undefined,
          appId: typeof a.appId === 'string' && a.appId ? a.appId : undefined,
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
        });
        // Same rule as GET /ssl-certificates: system certificates need admin:details:certificates.
        if (query.showSystem) this.ensureToolScope(user, 'admin:details:certificates');
        return this.sslService.listCerts(query, {
          allowedIds: allowedResourceIdsForScopes(user.scopes, 'ssl:cert:view'),
        });
      }
      case 'link_internal_cert': {
        const input = LinkInternalCertSchema.parse(args);
        if (!hasScopeForCreation(user.scopes, 'ssl:cert:issue', input.folderId)) {
          throw new AppError(403, 'FORBIDDEN', 'Missing ssl:cert:issue permission for the selected destination');
        }
        await container.resolve(SSLCertificateFolderService).assertFolderExists(input.folderId);
        const cert = await this.sslService.linkInternalCert(input, user.id, user.scopes);
        await grantCreatedResourcePermissions(user.id, 'ssl:cert', cert.id, { folderId: input.folderId ?? null });
        return cert;
      }
      case 'request_acme_cert': {
        const input = RequestACMECertSchema.parse(args);
        if (!hasScopeForCreation(user.scopes, 'ssl:cert:issue', input.folderId)) {
          throw new AppError(403, 'FORBIDDEN', 'Missing ssl:cert:issue permission for the selected destination');
        }
        await container.resolve(SSLCertificateFolderService).assertFolderExists(input.folderId);
        const result = await this.sslService.requestACMECert(input, user.id, user.email);
        await grantCreatedResourcePermissions(user.id, 'ssl:cert', result.certificate.id, {
          folderId: input.folderId ?? null,
        });
        return result;
      }
      case 'manage_ssl_certificate': {
        if (a.operation === 'get') {
          this.ensureToolScopeForResource(user, 'ssl:cert:view', String(a.sslCertificateId));
          const cert = await this.sslService.getCert(a.sslCertificateId);
          return { ...cert, app: await appForMember({ type: 'certificate', id: cert.id }) };
        }
        if (a.operation === 'upload') {
          const input = UploadCertSchema.parse(args);
          if (!hasScopeForCreation(user.scopes, 'ssl:cert:issue', input.folderId)) {
            throw new AppError(403, 'FORBIDDEN', 'Missing ssl:cert:issue permission for the selected destination');
          }
          await container.resolve(SSLCertificateFolderService).assertFolderExists(input.folderId);
          const cert = await this.sslService.uploadCert(input, user.id);
          await grantCreatedResourcePermissions(user.id, 'ssl:cert', cert.id, { folderId: input.folderId ?? null });
          return cert;
        }
        if (a.operation === 'renew') {
          this.ensureToolScopeForResource(user, 'ssl:cert:renew', String(a.sslCertificateId));
          return this.sslService.renewCert(a.sslCertificateId, user.id, user.email, { actorScopes: user.scopes });
        }
        if (a.operation === 'cancel_acme') {
          this.ensureToolScopeForResource(user, 'ssl:cert:renew', String(a.sslCertificateId));
          await this.sslService.cancelPendingAcmeIssue(a.sslCertificateId, user.id);
          return { success: true };
        }
        if (a.operation === 'verify_dns') {
          this.ensureToolScopeForResource(user, 'ssl:cert:renew', String(a.sslCertificateId));
          return this.sslService.completeDNS01Verification(a.sslCertificateId, user.id, {
            contactEmail: user.email,
          });
        }
        if (a.operation === 'set_auto_renew') {
          this.ensureToolScopeForResource(user, 'ssl:cert:renew', String(a.sslCertificateId));
          return this.sslService.setAutoRenew(a.sslCertificateId, SetSslAutoRenewSchema.parse(args), user.id);
        }
        if (a.operation === 'delete') {
          this.ensureToolScopeForResource(user, 'ssl:cert:delete', String(a.sslCertificateId));
          await this.sslService.deleteCert(a.sslCertificateId, user.id);
          return { success: true };
        }
        throw new Error(`Unsupported SSL certificate operation: ${String(a.operation)}`);
      }
      // Same checks as the TLS resync routes (system routes and certificates stay admin:update only).
      case 'resync_tls_distribution': {
        if (a.target === 'route') {
          const routeId = stringArg(a.routeId);
          if (!routeId) throw new AppError(400, 'ROUTE_ID_REQUIRED', 'routeId is required for target route');
          await assertTlsResyncAccess(user.scopes, 'route', routeId);
          return this.proxyService.resyncTlsHost(routeId, user.id);
        }
        if (a.target === 'certificate') {
          const certificateId = stringArg(a.sslCertificateId);
          if (!certificateId) {
            throw new AppError(
              400,
              'SSL_CERTIFICATE_ID_REQUIRED',
              'sslCertificateId is required for target certificate'
            );
          }
          await assertTlsResyncAccess(user.scopes, 'certificate', certificateId);
          return this.sslService.resyncDistribution(certificateId, user.id);
        }
        throw new Error(`Unsupported TLS resync target: ${String(a.target)}`);
      }

      // ── Raw Config ──
      case 'get_route_rendered_config': {
        const host = await this.proxyService.getProxyHost(a.routeId);
        if (!host) throw new Error('Route not found');
        const renderedConfig = await this.proxyService.getRenderedConfig(a.routeId);
        return { routeId: a.routeId, config: renderedConfig };
      }
      case 'update_route_raw_config': {
        const rawHost = await this.proxyService.getProxyHost(a.routeId);
        if (!rawHost) throw new Error('Route not found');
        if (!(rawHost as any).rawConfigEnabled) {
          throw new Error('Raw mode is not enabled on this route. Enable it first with toggle_route_raw_mode.');
        }
        // Same checks as a raw-only PUT /proxy-hosts/{id}.
        requireExistingPageRouteAccess(user, rawHost);
        const rawInput = { rawConfig: a.rawConfig };
        await this.proxyService.assertReferenceAccess(user.scopes, rawInput as never, rawHost as never);
        return compactProxyHostForAgent(
          redactProxyHostForScopes(
            await this.proxyService.updateProxyHost(a.routeId, rawInput as any, user.id, {
              bypassAdvancedValidation: hasScope(user.scopes, `proxy:unrestricted:${a.routeId}`),
              bypassRawValidation: hasScope(user.scopes, `proxy:unrestricted:${a.routeId}`),
              actorScopes: user.scopes,
            }),
            user.scopes
          )
        );
      }
      case 'toggle_route_raw_mode': {
        // PUT {rawConfigEnabled} is not a raw-only update, so the route also requires proxy:edit.
        this.ensureToolScopeForResource(user, 'proxy:edit', String(a.routeId));
        const existing = await this.proxyService.getProxyHost(a.routeId);
        requireExistingPageRouteAccess(user, existing);
        // Leaving raw mode also leaves the raw Route type the UI sets on entry, as the UI does; otherwise the
        // Route keeps serving its raw config.
        const toggleInput =
          a.enabled === false && existing?.type === 'raw'
            ? { rawConfigEnabled: false, type: 'proxy' as const }
            : { rawConfigEnabled: a.enabled };
        await this.proxyService.assertReferenceAccess(user.scopes, toggleInput as never, existing as never);
        return compactProxyHostForAgent(
          redactProxyHostForScopes(
            await this.proxyService.updateProxyHost(a.routeId, toggleInput as any, user.id, {
              bypassAdvancedValidation: hasScope(user.scopes, `proxy:unrestricted:${a.routeId}`),
              bypassRawValidation: hasScope(user.scopes, `proxy:unrestricted:${a.routeId}`),
              actorScopes: user.scopes,
            }),
            user.scopes
          )
        );
      }
      default:
        return UNHANDLED_TOOL;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}
