import { container } from '@/container.js';
import { isScopeSubset } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  CreateUserSchema,
  RestoreUserSchema,
  UpdateAuthProvisioningSettingsSchema,
  UpdateUserAdditionalPermissionsSchema,
  UpdateUserAuthMethodSchema,
  UpdateUserGroupSchema,
  UpdateUserNameSchema,
} from '@/modules/admin/admin.schemas.js';
import {
  type AdminUserActionServices,
  type AdminUserActor,
  createAdminUser,
  deleteAdminUser,
  listAdminUserSessions,
  listAdminUsers,
  listDeletedAdminUsers,
  renameAdminUser,
  resetAdminUserAvatar,
  resetAdminUserMfa,
  restoreAdminUser,
  revokeAdminUserSession,
  revokeAllAdminUserSessions,
  sendAdminUserInvitation,
  sendAdminUserPasswordLink,
  setAdminUserBlocked,
  updateAdminUserAdditionalPermissions,
  updateAdminUserAuthMethod,
  updateAdminUserGroups,
} from '@/modules/admin/admin-user-actions.js';
import { readOpfieldSettings, updateOpfieldSettings } from '@/modules/admin/opfield-settings.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { CloudLinkRequestError, CloudLinkService } from '@/modules/cloud-link/cloud-link.service.js';
import {
  assertNotCloudManaged,
  CLOUD_MANAGED_MESSAGES,
  isCloudManaged,
} from '@/modules/cloud-link/cloud-link-managed-locks.js';
import { ConfigurationExportService } from '@/modules/configuration-transfer/configuration-export.service.js';
import { OpfieldMoveService } from '@/modules/configuration-transfer/opfield-move.service.js';
import { DiagnosticsService } from '@/modules/diagnostics/diagnostics.service.js';
import { HousekeepingConfigUpdateSchema } from '@/modules/housekeeping/housekeeping.docs.js';
import { toLicenseAppError } from '@/modules/license/license.errors.js';
import { LicenseService } from '@/modules/license/license.service.js';
import { LicenseModuleService } from '@/modules/license/license-module.service.js';
import { EnvironmentSettingsUpdateSchema } from '@/modules/settings/environment-settings.schemas.js';
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsService,
} from '@/modules/settings/environment-settings.service.js';
import { registryRepositoryWorkloads } from '@/modules/tokens/token-registry-workloads.js';
import { CreateTokenSchema, UpdateTokenSchema } from '@/modules/tokens/tokens.schemas.js';
import {
  authorizeRequestedRegistryAccessForWorkloads,
  resolveRequestedTokenScopes,
  TokensService,
} from '@/modules/tokens/tokens.service.js';
import { HousekeepingService } from '@/services/housekeeping.service.js';
import { SchedulerService } from '@/services/scheduler.service.js';
import type { User } from '@/types.js';
import { AIServiceInteractionTools } from './ai.service.interaction-tools.js';
import { isRecord, type ToolRuntimeContext, UNHANDLED_TOOL } from './ai.service.runtime-helpers.js';
import { aiSettingsUpdatesFromArgs } from './ai.service.tool-helpers.js';
import { AI_TOOLS } from './ai.tools.js';
import { AIConversationService } from './ai-conversation.service.js';

export abstract class AIServiceAdministrationTools extends AIServiceInteractionTools {
  /** manage_configuration_export: the same service and checks as /api/system/configuration-export. */
  private async executeConfigurationExportTool(user: User, a: Record<string, any>): Promise<unknown> {
    const exports = container.resolve(ConfigurationExportService);
    const move = container.resolve(OpfieldMoveService);
    switch (a.operation) {
      case 'estimate':
        return exports.estimate();
      case 'export': {
        if (typeof a.passphrase !== 'string') throw new Error('passphrase is required');
        const prepared = await exports.prepare(user.id, {
          passphrase: a.passphrase,
          includeRegistry: a.includeRegistry === true,
          includeLogs: a.includeLogs === true,
        });
        return {
          exportId: prepared.export.id,
          filename: prepared.export.filename,
          estimatedBytes: prepared.export.estimatedBytes,
          downloadUrl: prepared.downloadUrl,
          expiresAt: prepared.expiresAt,
          command: `curl -fSL -o ${prepared.export.filename} '${prepared.downloadUrl}'`,
          note: 'The link works once. Keep the file and the passphrase apart: together they open every secret of this installation.',
        };
      }
      case 'progress':
        return exports.progress(requiredId(a.exportId, 'exportId'), user.id);
      case 'move_status':
        return move.status();
      case 'announce_move':
      case 'withdraw_move': {
        const address = a.operation === 'announce_move' ? String(a.address ?? '') : null;
        if (address !== null && !address.trim()) throw new Error('address is required');
        const status = await move.announce(address, user.id);
        await container.resolve(AuditService).log({
          userId: user.id,
          action: address ? 'system.opfield_move_announced' : 'system.opfield_move_withdrawn',
          resourceType: 'system',
          details: {
            address: status.announcement?.address ?? null,
            told: status.nodes.filter((node) => node.state === 'told').length,
            notTold: status.nodes
              .filter((node) => node.state !== 'told')
              .map((node) => ({ name: node.name, state: node.state })),
          },
        });
        return status;
      }
      default:
        throw new Error('Unsupported configuration export operation');
    }
  }

  protected async executeAdministrationTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    _runtimeContext: ToolRuntimeContext
  ): Promise<unknown> {
    const a = args as any;
    switch (toolName) {
      // ── Administration ──
      case 'list_users':
        return listAdminUsers(this.adminUserActor(user), this.adminUserServices());
      case 'create_user': {
        const input = CreateUserSchema.parse(
          definedFields({
            email: a.email,
            name: a.name,
            groupId: a.groupId,
            groupIds: a.groupIds,
            authMethod: a.authMethod,
            folderId: a.folderId,
          })
        );
        return createAdminUser(this.adminUserActor(user), input, this.adminUserServices());
      }
      case 'update_user_role': {
        const { groupIds } = UpdateUserGroupSchema.parse(definedFields({ groupId: a.groupId, groupIds: a.groupIds }));
        return updateAdminUserGroups(
          this.adminUserActor(user),
          requiredId(a.userId),
          groupIds,
          this.adminUserServices()
        );
      }
      case 'set_user_additional_permissions': {
        if (
          !Array.isArray(a.additionalScopes) ||
          a.additionalScopes.some((scope: unknown) => typeof scope !== 'string')
        ) {
          throw new Error('additionalScopes must be an array of permission scope strings');
        }
        const { additionalScopes } = UpdateUserAdditionalPermissionsSchema.parse({
          additionalScopes: a.additionalScopes,
        });
        return updateAdminUserAdditionalPermissions(
          this.adminUserActor(user),
          requiredId(a.userId),
          additionalScopes,
          this.adminUserServices()
        );
      }
      case 'set_user_blocked':
        return setAdminUserBlocked(
          this.adminUserActor(user),
          requiredId(a.userId),
          a.blocked === true,
          this.adminUserServices()
        );
      case 'delete_user':
        await deleteAdminUser(this.adminUserActor(user), requiredId(a.userId), this.adminUserServices());
        return { success: true };
      case 'manage_user':
        return this.executeManageUserTool(user, a);
      case 'get_ai_settings': {
        const [config, opfieldInferenceModels] = await Promise.all([
          this.settingsService.getConfigForAdmin(),
          this.getAdminInferenceModels(),
        ]);
        return { ...config, opfieldInferenceModels };
      }
      case 'update_ai_settings': {
        const updates = aiSettingsUpdatesFromArgs(args);
        if (Object.keys(updates).length === 0) {
          throw new Error('No supported AI settings fields were provided');
        }
        await this.settingsService.updateConfig(updates);
        const [config, opfieldInferenceModels] = await Promise.all([
          this.settingsService.getConfigForAdmin(),
          this.getAdminInferenceModels(),
        ]);
        return { ...config, opfieldInferenceModels };
      }
      case 'list_ai_tools':
        return AI_TOOLS.map((tool) => ({
          name: tool.name,
          category: tool.category,
          description: tool.description,
          destructive: tool.destructive,
          requiredScope: tool.requiredScope,
          invalidateStores: tool.invalidateStores,
        }));
      case 'get_sandbox_runtime_status': {
        const config = await this.settingsService.getConfig();
        const status = this.sandboxService?.status() ?? { status: 'unconfigured' };
        const health = this.sandboxService
          ? await this.sandboxService.health().catch((error) => ({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }))
          : { ok: false, error: 'Sandbox runner is not configured' };
        return {
          enabled: config.sandboxEnabled,
          defaultTier: config.sandboxDefaultTier,
          status,
          health,
        };
      }
      case 'manage_ai_conversation': {
        const conversationService = container.resolve(AIConversationService);
        const operation = String(a.operation ?? '');
        switch (operation) {
          case 'list':
            return conversationService.listConversations(user.id);
          case 'get': {
            const conversationId = String(a.conversationId ?? '');
            if (!conversationId) throw new Error('conversationId is required');
            const conversation = await conversationService.getConversation(user.id, conversationId);
            if (!conversation) throw new Error('Conversation not found');
            return conversation;
          }
          case 'delete': {
            const conversationId = String(a.conversationId ?? '');
            if (!conversationId) throw new Error('conversationId is required');
            const deleted = await conversationService.deleteConversation(user.id, conversationId);
            if (!deleted) throw new Error('Conversation not found');
            return { deleted: true };
          }
          case 'delete_by_title': {
            const title = String(a.title ?? '');
            if (!title.trim()) throw new Error('title is required');
            return { deleted: await conversationService.deleteConversationByTitle(user.id, title) };
          }
          default:
            throw new Error('Unsupported conversation operation');
        }
      }
      case 'manage_oauth_authorization': {
        const { OAuthService } = await import('@/modules/oauth/oauth.service.js');
        const oauthService = container.resolve(OAuthService);
        const operation = String(a.operation ?? '');
        switch (operation) {
          case 'list':
            return oauthService.listUserAuthorizations(user.id);
          case 'update_scopes': {
            const authorizationId = String(a.authorizationId ?? '');
            const scopes = Array.isArray(a.scopes) ? a.scopes.map(String) : [];
            if (!authorizationId) throw new Error('authorizationId is required (the id from list)');
            if (scopes.length === 0) throw new Error('scopes are required');
            return oauthService.updateUserAuthorizationScopes(user, authorizationId, scopes);
          }
          case 'update': {
            const authorizationId = String(a.authorizationId ?? '');
            if (!authorizationId) throw new Error('authorizationId is required (the id from list)');
            // Validated like PATCH /api/oauth/authorizations/:id.
            const { OAuthAuthorizationScopesSchema } = await import('@/modules/oauth/oauth.schemas.js');
            const input = OAuthAuthorizationScopesSchema.parse({
              scopes: a.scopes,
              expiresAt: a.expiresAt,
              allowedIps: a.allowedIps,
            });
            return oauthService.updateUserAuthorization(user, authorizationId, input);
          }
          case 'revoke': {
            const authorizationId = String(a.authorizationId ?? '');
            if (!authorizationId) throw new Error('authorizationId is required (the id from list)');
            await oauthService.revokeUserAuthorization(user.id, authorizationId);
            return { revoked: true };
          }
          default:
            throw new Error('Unsupported OAuth authorization operation');
        }
      }
      case 'manage_api_token': {
        const tokensService = container.resolve(TokensService);
        const operation = String(a.operation ?? '');
        switch (operation) {
          case 'list':
            return tokensService.listTokens(user.id);
          case 'create': {
            // Validate first (retired names are accepted), then rewrite them like the REST route.
            const parsed = CreateTokenSchema.parse({
              name: a.name,
              scopes: a.scopes,
              registryAccess: a.registryAccess,
              expiresAt: a.expiresAt,
              allowedIps: a.allowedIps,
            });
            const input = { ...parsed, scopes: resolveRequestedTokenScopes(parsed.scopes, user.scopes, 'create') };
            const delegated = await authorizeRequestedRegistryAccessForWorkloads(
              input,
              user.scopes,
              registryRepositoryWorkloads
            );
            if (!isScopeSubset(delegated, user.scopes)) {
              throw new Error('Cannot create a token with scopes you do not possess');
            }
            return tokensService.createToken(user.id, input);
          }
          case 'update': {
            const tokenId = String(a.tokenId ?? '');
            if (!tokenId) throw new Error('tokenId is required');
            const parsed = UpdateTokenSchema.parse({
              name: a.name,
              scopes: a.scopes,
              registryAccess: a.registryAccess,
              expiresAt: a.expiresAt,
              allowedIps: a.allowedIps,
            });
            const input = {
              ...parsed,
              ...(parsed.scopes !== undefined
                ? { scopes: resolveRequestedTokenScopes(parsed.scopes, user.scopes, 'update') }
                : {}),
            };
            const delegated = await authorizeRequestedRegistryAccessForWorkloads(
              input,
              user.scopes,
              registryRepositoryWorkloads
            );
            if (input.scopes !== undefined && !isScopeSubset(delegated, user.scopes)) {
              throw new Error('Cannot update a token with scopes you do not possess');
            }
            await tokensService.updateToken(user.id, tokenId, input);
            return { success: true };
          }
          case 'revoke': {
            const tokenId = String(a.tokenId ?? '');
            if (!tokenId) throw new Error('tokenId is required');
            await tokensService.revokeToken(user.id, tokenId);
            return { success: true };
          }
          default:
            throw new Error('Unsupported API token operation');
        }
      }
      case 'get_license_status': {
        const [status, cloudManaged] = await Promise.all([
          container.resolve(LicenseService).getStatus(),
          isCloudManaged(),
        ]);
        return { ...status, cloudManaged };
      }
      case 'manage_license': {
        // Mirrors /system/license: activation also installs the licensed module.
        const service = container.resolve(LicenseService);
        try {
          switch (a.operation) {
            case 'activate': {
              const licenseKey = String(a.licenseKey ?? '').trim();
              if (!licenseKey) throw new AppError(400, 'INVALID_LICENSE_KEY', 'licenseKey is required');
              // As POST /system/license/activate: a managed installation keeps its account's key.
              await assertNotCloudManaged(CLOUD_MANAGED_MESSAGES.license);
              const status = await service.activateKey(licenseKey);
              const activation = await container.resolve(LicenseModuleService).ensureAvailable();
              return { ...status, moduleRestarting: activation.restarting };
            }
            case 'activate_module':
              return await container.resolve(LicenseModuleService).ensureAvailable();
            case 'check':
              return await service.checkNow();
            case 'clear':
              await assertNotCloudManaged(CLOUD_MANAGED_MESSAGES.license);
              return await service.clearKey();
            default:
              throw new Error('Unsupported license operation');
          }
        } catch (error) {
          throw toLicenseAppError(error) ?? error;
        }
      }
      case 'get_cloud_status':
        return container.resolve(CloudLinkService).getStatus();
      case 'manage_cloud': {
        // Mirrors /system/cloud.
        const service = container.resolve(CloudLinkService);
        try {
          switch (a.operation) {
            case 'connect': {
              const code = String(a.code ?? '').trim();
              if (!code) throw new AppError(400, 'CLOUD_CODE_INVALID', 'code is required');
              return await service.connect(code, { userId: user.id });
            }
            case 'disconnect':
              return await service.disconnect({ userId: user.id });
            case 'set_remote_management': {
              if (typeof a.enabled !== 'boolean') {
                throw new AppError(400, 'INVALID_INPUT', 'enabled must be true or false');
              }
              return await service.setRemoteManagement(a.enabled, { userId: user.id });
            }
            default:
              throw new Error('Unsupported cloud operation');
          }
        } catch (error) {
          throw error instanceof CloudLinkRequestError ? new AppError(error.status, error.code, error.message) : error;
        }
      }
      case 'manage_configuration_export':
        return this.executeConfigurationExportTool(user, a);
      case 'manage_opfield_diagnostics': {
        const service = container.resolve(DiagnosticsService);
        const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
        const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
        switch (a.operation) {
          case 'snapshot':
            return await service.snapshot();
          case 'history':
            return await service.history({
              from: text(a.from),
              to: text(a.to),
              metrics: Array.isArray(a.metrics)
                ? a.metrics.filter((metric: unknown) => typeof metric === 'string')
                : undefined,
              stepMinutes: count(a.stepMinutes),
            });
          case 'requests':
            return service.requests(count(a.minutes));
          case 'jobs':
            return service.jobs();
          case 'logs':
            this.ensureToolScope(user, 'diagnostics:logs');
            return await service.logs({
              source: text(a.source),
              since: text(a.since),
              until: text(a.until),
              level: ['error', 'warn', 'info', 'debug'].includes(a.level) ? a.level : undefined,
              text: text(a.text),
              context: text(a.context),
              requestId: text(a.requestId),
              limit: count(a.limit),
            });
          default:
            throw new Error('Unsupported diagnostics operation');
        }
      }
      case 'manage_housekeeping': {
        const service = container.resolve(HousekeepingService);
        switch (a.operation) {
          case 'get_config':
            return service.getConfig();
          case 'get_stats':
            return service.getStats();
          case 'get_history':
            return service.getRunHistory();
          case 'update_config': {
            this.ensureToolScope(user, 'housekeeping:configure');
            const validated = HousekeepingConfigUpdateSchema.parse(isRecord(a.config) ? a.config : {});
            const updated = await service.updateConfig(validated as Parameters<typeof service.updateConfig>[0]);
            if (validated.cronExpression) {
              container.resolve(SchedulerService).updateSchedule('housekeeping', validated.cronExpression);
            }
            return updated;
          }
          case 'run':
            this.ensureToolScope(user, 'housekeeping:run');
            try {
              return await service.runAll('manual', user.id);
            } catch (error) {
              if (error instanceof Error && error.message.includes('already running')) {
                throw new AppError(409, 'ALREADY_RUNNING', 'Housekeeping is already running');
              }
              throw error;
            }
          default:
            throw new Error('Unsupported housekeeping operation');
        }
      }
      case 'get_opfield_settings': {
        const settings = await readOpfieldSettings(
          { user, scopes: user.scopes },
          {},
          { groupService: this.groupService }
        );
        return {
          ...settings,
          environmentSettings: {
            data: container.resolve(EnvironmentSettingsService).getSnapshot(),
            defaults: DEFAULT_ENVIRONMENT_SETTINGS,
          },
        };
      }
      case 'update_opfield_settings': {
        // Same validation, privilege boundaries, side effects and audit as PUT /admin/auth-settings
        // and PATCH /settings/environment.
        const { environmentSettings, ...settingsArgs } = args;
        const environmentInput =
          environmentSettings === undefined ? undefined : EnvironmentSettingsUpdateSchema.parse(environmentSettings);
        const settingsInput = UpdateAuthProvisioningSettingsSchema.parse(settingsArgs);
        if (!environmentInput && Object.keys(settingsInput).length === 0) {
          throw new Error('No supported Opfield settings fields were provided');
        }
        const settings =
          Object.keys(settingsInput).length > 0
            ? await updateOpfieldSettings(
                { user, scopes: user.scopes },
                settingsInput,
                {},
                { groupService: this.groupService, auditService: this.auditService }
              )
            : await readOpfieldSettings({ user, scopes: user.scopes }, {}, { groupService: this.groupService });
        const environmentService = container.resolve(EnvironmentSettingsService);
        const environment = environmentInput
          ? await environmentService.update(environmentInput)
          : environmentService.getSnapshot();
        return { ...settings, environmentSettings: { data: environment, defaults: DEFAULT_ENVIRONMENT_SETTINGS } };
      }
      default:
        return UNHANDLED_TOOL;
    }
  }

  private adminUserActor(user: User): AdminUserActor {
    // The assistant and MCP clients are never the browser session of the account they act for.
    return { user, scopes: user.scopes, accountScopes: user.accountScopes, programmatic: true };
  }

  private adminUserServices(): AdminUserActionServices {
    return { authService: this.authService, auditService: this.auditService, groupService: this.groupService };
  }

  /** Mirrors the /api/admin/users/{id}/* routes through the shared user actions. */
  private async executeManageUserTool(user: User, a: Record<string, unknown>): Promise<unknown> {
    const actor = this.adminUserActor(user);
    const services = this.adminUserServices();
    const operation = String(a.operation ?? '');
    if (operation === 'list_deleted') return listDeletedAdminUsers(actor, services);
    const userId = requiredId(a.userId);
    switch (operation) {
      case 'set_auth_method': {
        const { authMethod } = UpdateUserAuthMethodSchema.parse({ authMethod: a.authMethod });
        return updateAdminUserAuthMethod(actor, userId, authMethod, services);
      }
      case 'rename': {
        const { name } = UpdateUserNameSchema.parse({ name: a.name });
        return renameAdminUser(actor, userId, name, services);
      }
      case 'reset_avatar':
        return resetAdminUserAvatar(actor, userId, services);
      case 'send_password_link':
        return sendAdminUserPasswordLink(actor, userId, services);
      case 'send_invitation':
        return sendAdminUserInvitation(actor, userId, services);
      case 'list_sessions':
        // Assistant and MCP calls are not a browser session, so no session is marked current.
        return listAdminUserSessions(actor, userId, '', services);
      case 'revoke_session': {
        const sessionId = requiredId(a.sessionId, 'sessionId');
        await revokeAdminUserSession(actor, userId, sessionId, services);
        return { message: 'Session revoked' };
      }
      case 'revoke_all_sessions':
        await revokeAllAdminUserSessions(actor, userId, services);
        return { message: 'All sessions revoked' };
      case 'reset_mfa':
        return resetAdminUserMfa(actor, userId, services);
      case 'restore': {
        const groups = RestoreUserSchema.parse(definedFields({ groupIds: a.groupIds }));
        return restoreAdminUser(actor, userId, groups, services);
      }
      default:
        throw new Error(`Unsupported user operation: ${operation}`);
    }
  }
}

function requiredId(value: unknown, name = 'userId'): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', `${name} is required`);
  return id;
}

/** Drop omitted arguments so the parsed body matches what the HTTP route receives. */
function definedFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
