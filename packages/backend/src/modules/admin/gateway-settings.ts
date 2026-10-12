import { isIP } from 'node:net';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope, isScopeSubset } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { UpdateAuthProvisioningSettingsInput } from '@/modules/admin/admin.schemas.js';
import {
  CLOUD_MANAGED_SETTINGS_MESSAGE,
  findCloudManagedChanges,
  touchesCloudManagedSettings,
} from '@/modules/admin/cloud-managed-settings.js';
import { findIdentityTrustChanges } from '@/modules/admin/identity-trust-settings.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { assertAdminSignInRemains } from '@/modules/auth/admin-sign-in-guard.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { AuthMailService } from '@/modules/auth/auth-mail.service.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { CloudLinkService } from '@/modules/cloud-link/cloud-link.service.js';
import { isDemoVisitor } from '@/modules/demo/demo-mode.js';
import { GroupService } from '@/modules/groups/group.service.js';
import { LoggingRuntimeService } from '@/modules/logging/logging-runtime.service.js';
import { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
import { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import {
  type GeneralSettings,
  GeneralSettingsService,
  type GeneralSettingsUpdate,
} from '@/modules/settings/general-settings.service.js';
import { NetworkSettingsService } from '@/modules/settings/network-settings.service.js';
import { OutboundWebhookPolicyService } from '@/modules/settings/outbound-webhook-policy.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { GatewayIdentityRenewalService } from '@/services/gateway-identity-renewal.service.js';
import { RuntimeRestartService } from '@/services/runtime-restart.service.js';
import { WebIdentityService } from '@/services/web-identity.service.js';
import { WebTransportSettingsService } from '@/services/web-transport-settings.service.js';
import type { User } from '@/types.js';

/**
 * Gateway settings (auth, SMTP, OIDC, logging backend, MCP, general, network and
 * outbound webhook policy) shared by /api/admin/auth-settings and the AI/MCP
 * tools, so both apply the same privilege boundaries, side effects and audit.
 */
const logger = createChildLogger('GatewaySettings');

export interface GatewaySettingsActor {
  user: User;
  /** Effective scopes of the request (bounded for programmatic callers). */
  scopes: string[];
  userAgent?: string;
}

export interface GatewaySettingsRequest {
  /** Host header; decides whether a TLS switch leaves the caller on a direct IP address. */
  host?: string;
  forwardedHost?: string;
  /** Resolves the caller's client IP under the effective network security settings. */
  currentRequestIp?: (networkSecurity: Awaited<ReturnType<NetworkSettingsService['getConfig']>>) => unknown;
}

export interface GatewaySettingsServices {
  groupService?: GroupService;
  auditService?: AuditService;
}

function effectiveGroupScopes(group: { scopes: string[]; inheritedScopes?: string[] }) {
  return [...new Set([...(group.scopes ?? []), ...(group.inheritedScopes ?? [])])];
}

async function assignableGroups(scopes: string[], groupService: GroupService) {
  const groups = await groupService.listGroups();
  return groups
    .filter((group) => isScopeSubset(effectiveGroupScopes(group), scopes))
    .map((group) => ({ id: group.id, name: group.name, isBuiltin: group.isBuiltin }));
}

function touchesGrpcEndpointSettings(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const record = input as Record<string, unknown>;
  return 'gatewayGrpcPublicTarget' in record || 'gatewayGrpcLocalIp' in record;
}

/** Whether the cloud manages this installation's addresses; only greys out the form, the update refuses on its own. */
async function readCloudManaged(): Promise<boolean> {
  try {
    return await container.resolve(CloudLinkService).managedByCloud();
  } catch {
    return false;
  }
}

async function refreshActiveGrpcServerIdentity(): Promise<void> {
  await container.resolve(GatewayIdentityRenewalService).refreshGrpcIdentity();
}

export async function readGatewaySettings(
  actor: Pick<GatewaySettingsActor, 'user' | 'scopes'>,
  request: Pick<GatewaySettingsRequest, 'currentRequestIp'> = {},
  services: GatewaySettingsServices = {}
) {
  const groupService = services.groupService ?? container.resolve(GroupService);
  const [
    settings,
    smtp,
    oidc,
    logging,
    mcpSettings,
    generalSettings,
    webTransport,
    networkSecurity,
    outboundWebhookPolicy,
    availableGroups,
    cloudManaged,
  ] = await Promise.all([
    container.resolve(AuthSettingsService).getConfig(),
    container.resolve(AuthMailService).getPublicConfig(),
    container.resolve(OidcSettingsService).getPublicConfig(),
    container.resolve(LoggingSettingsService).getPublicConfig(),
    container.resolve(McpSettingsService).getConfig(),
    container.resolve(GeneralSettingsService).getConfig(),
    container.resolve(WebTransportSettingsService).getConfig(),
    container.resolve(NetworkSettingsService).getConfig(),
    container.resolve(OutboundWebhookPolicyService).getConfig(),
    assignableGroups(actor.scopes, groupService),
    readCloudManaged(),
  ]);

  const response = {
    ...settings,
    smtp,
    oidc,
    logging,
    mcpServerEnabled: mcpSettings.serverEnabled,
    mcpExtendedCompatibility: mcpSettings.extendedCompatibility,
    generalSettings,
    webTransport: { ...webTransport, restartRequired: false, directAccess: false, targetUrl: null },
    networkSecurity,
    outboundWebhookPolicy,
    ...(request.currentRequestIp ? { currentRequestIp: request.currentRequestIp(networkSecurity) } : {}),
    availableGroups,
    /** Managed cloud installation: the public URL and gRPC addresses are the cloud's and cannot be changed. */
    cloudManaged,
  };

  if (!isDemoVisitor(actor.user)) return response;

  return {
    ...response,
    oidcAutoCreateUsers: false,
    oidcDefaultGroupId: '',
    oidcRequireVerifiedEmail: true,
    oauthExtendedCallbackCompatibility: false,
    mfaExistingSessionGracePeriodDays: 3,
    methods: { oidc: false, password: false, emailOtp: true, passkeyLogin: false },
    passwordPolicy: {
      minLength: 12,
      maxLength: 72,
      requireUppercase: false,
      requireLowercase: false,
      requireDigit: false,
      requireSymbol: false,
    },
    smtp: {
      configured: false,
      host: null,
      port: null,
      tlsMode: null,
      username: null,
      passwordLast4: null,
      senderName: null,
      senderEmail: null,
      verifiedAt: null,
    },
    oidc: {
      configured: false,
      issuer: null,
      clientId: null,
      clientSecretLast4: null,
      redirectUri: null,
      scopes: 'openid email profile',
      displayName: null,
      opfieldAccount: false,
    },
    logging: {
      mode: 'disabled' as const,
      url: '',
      username: '',
      passwordLast4: null,
      database: 'gateway_logs',
      table: 'logs',
      requestTimeoutMs: 5000,
    },
    mcpServerEnabled: false,
    mcpExtendedCompatibility: false,
    webTransport: { tlsEnabled: false, restartRequired: false, directAccess: false, targetUrl: null },
    generalSettings: {
      publicUrl: generalSettings.publicUrl,
      updateChannel: 'stable' as const,
      hideExternalBranding: generalSettings.hideExternalBranding,
      fileUploadMaxBytes: generalSettings.fileUploadMaxBytes,
      fileOpenMaxBytes: generalSettings.fileOpenMaxBytes,
      gatewayGrpcPublicTarget: null,
      gatewayGrpcLocalIp: null,
      relayAutoRecovery: false,
      relayGrantTtlHours: 4,
      relayPolicyLeaseHours: 72,
      shutdown: {
        userRequestDrainSeconds: 30,
        structuredLogDrainSeconds: 5,
        finalizationTimeoutSeconds: 10,
      },
      features: generalSettings.features,
    },
    networkSecurity: { clientIpSource: 'auto' as const, trustedProxyCidrs: [], trustCloudflareHeaders: false },
    outboundWebhookPolicy: { allowPrivateNetworks: false, allowedPrivateCidrs: [] },
    currentRequestIp: { source: 'unknown' },
    availableGroups: [],
  };
}

export async function updateGatewaySettings(
  actor: GatewaySettingsActor,
  input: UpdateAuthProvisioningSettingsInput,
  request: GatewaySettingsRequest = {},
  services: GatewaySettingsServices = {}
) {
  const authSettingsService = container.resolve(AuthSettingsService);
  const authMailService = container.resolve(AuthMailService);
  const oidcSettingsService = container.resolve(OidcSettingsService);
  const mcpSettingsService = container.resolve(McpSettingsService);
  const generalSettingsService = container.resolve(GeneralSettingsService);
  const networkSettingsService = container.resolve(NetworkSettingsService);
  const outboundWebhookPolicyService = container.resolve(OutboundWebhookPolicyService);
  const webTransportSettingsService = container.resolve(WebTransportSettingsService);
  const loggingSettingsService = container.resolve(LoggingSettingsService);
  const groupService = services.groupService ?? container.resolve(GroupService);
  const auditService = services.auditService ?? container.resolve(AuditService);

  if (input.oidcDefaultGroupId) {
    const destGroup = await groupService.getGroup(input.oidcDefaultGroupId);
    if (!isScopeSubset(effectiveGroupScopes(destGroup), actor.scopes)) {
      throw new AppError(403, 'PRIVILEGE_BOUNDARY', 'Cannot assign a group with permissions you do not possess');
    }
  }

  if (!hasScope(actor.scopes, 'admin:system')) {
    const privilegedChanges = await findIdentityTrustChanges(input, {
      smtp: () => authMailService.getPublicConfig(),
      generalSettings: () => generalSettingsService.getConfig(),
      authSettings: () => authSettingsService.getConfig(),
    });
    if (privilegedChanges.length > 0) {
      throw new AppError(
        403,
        'ADMIN_SYSTEM_REQUIRED',
        `Changing ${privilegedChanges.join(', ')} requires the admin:system permission`
      );
    }
  }

  // A managed installation keeps the addresses the cloud set up; resubmitting them unchanged is fine.
  if (touchesCloudManagedSettings(input.generalSettings)) {
    const cloudManagedChanges = findCloudManagedChanges(
      input.generalSettings,
      await generalSettingsService.getConfig()
    );
    if (cloudManagedChanges.length > 0 && (await container.resolve(CloudLinkService).managedByCloud())) {
      throw new AppError(409, 'CLOUD_MANAGED', CLOUD_MANAGED_SETTINGS_MESSAGE);
    }
  }

  try {
    const previousWebTransport = await webTransportSettingsService.getConfig();
    if (input.smtp) {
      await authMailService.saveConfig(input.smtp);
      if (input.smtp.testRecipient)
        await authMailService.sendTestEmail(input.smtp.testRecipient, input.smtp.testEmailKind);
    }
    if (input.oidc) {
      // Another issuer unbinds every account bound to the current one: at least one administrator must still be
      // able to sign in afterwards (the owner of a managed installation signs in with the Opfield account).
      await assertAdminSignInRemains(container.resolve<DrizzleClient>(TOKENS.DrizzleClient), {
        issuer: input.oidc.issuer,
        methods: input.methods,
      });
      await oidcSettingsService.saveConfig(input.oidc);
      container.resolve(AuthService).invalidateOidcConfiguration();
    }
    if (input.methods && (input.methods.password === true || input.methods.emailOtp === true)) {
      const smtp = await authMailService.getPublicConfig();
      if (!smtp.verifiedAt) {
        throw new AppError(
          409,
          'SMTP_NOT_VERIFIED',
          'Configure and verify SMTP before enabling password or email-code sign-in'
        );
      }
    }
    if (input.methods?.oidc === true && !(await oidcSettingsService.getPublicConfig()).configured) {
      throw new AppError(409, 'OIDC_NOT_CONFIGURED', 'Configure OIDC before enabling OIDC sign-in');
    }
    const logging = input.logging
      ? await container.resolve(LoggingRuntimeService).update(input.logging)
      : await loggingSettingsService.getPublicConfig();
    const mayRefreshGrpcIdentity = touchesGrpcEndpointSettings(input.generalSettings);
    const mayRefreshWebIdentity = input.generalSettings?.publicUrl !== undefined;
    const nextTlsEnabled = input.webTlsEnabled ?? previousWebTransport.tlsEnabled;
    const previousGeneralSettings =
      mayRefreshGrpcIdentity || mayRefreshWebIdentity ? await generalSettingsService.getConfig() : null;
    const [updated, smtp, oidc, mcpSettings, generalSettings, networkSecurity, outboundWebhookPolicy] =
      await Promise.all([
        authSettingsService.updateConfig(input),
        authMailService.getPublicConfig(),
        oidcSettingsService.getPublicConfig(),
        mcpSettingsService.updateConfig({
          serverEnabled: input.mcpServerEnabled,
          extendedCompatibility: input.mcpExtendedCompatibility,
        }),
        input.generalSettings
          ? generalSettingsService.updateConfig(input.generalSettings)
          : generalSettingsService.getConfig(),
        input.networkSecurity
          ? networkSettingsService.updateConfig(input.networkSecurity)
          : networkSettingsService.getConfig(),
        input.outboundWebhookPolicy
          ? outboundWebhookPolicyService.updateConfig(input.outboundWebhookPolicy)
          : outboundWebhookPolicyService.getConfig(),
      ]);

    // The settings form sends the Public URL with every save. Only a changed URL
    // refreshes the web identity, which restarts Gateway.
    const shouldRefreshWebIdentity = Boolean(
      mayRefreshWebIdentity &&
        previousGeneralSettings &&
        previousGeneralSettings.publicUrl !== generalSettings.publicUrl
    );
    const shouldRefreshGrpcIdentity = Boolean(
      mayRefreshGrpcIdentity &&
        previousGeneralSettings &&
        (previousGeneralSettings.gatewayGrpcPublicTarget !== generalSettings.gatewayGrpcPublicTarget ||
          previousGeneralSettings.gatewayGrpcLocalIp !== generalSettings.gatewayGrpcLocalIp)
    );

    if (shouldRefreshGrpcIdentity || (shouldRefreshWebIdentity && nextTlsEnabled)) {
      const webIdentityService = container.resolve(WebIdentityService);
      try {
        if (shouldRefreshGrpcIdentity) {
          await refreshActiveGrpcServerIdentity();
        }
        if (shouldRefreshWebIdentity && nextTlsEnabled) await webIdentityService.refresh();
      } catch (error) {
        if (previousGeneralSettings) {
          try {
            // Undo only what this request changed, and only where nothing else
            // changed it since, so concurrent edits are not reverted with it.
            await generalSettingsService.restoreFields(
              previousGeneralSettings,
              generalSettingsRollbackFields(previousGeneralSettings, generalSettings, input.generalSettings),
              { ifUnchangedFrom: generalSettings }
            );
            if (shouldRefreshGrpcIdentity) {
              await refreshActiveGrpcServerIdentity();
            }
            if (shouldRefreshWebIdentity && nextTlsEnabled) await webIdentityService.refresh();
          } catch (rollbackError) {
            logger.error('Failed to rollback gRPC endpoint settings after identity refresh failure', {
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
          }
        }
        throw error;
      }
    }

    const [availableGroups, cloudManaged] = await Promise.all([
      assignableGroups(actor.scopes, groupService),
      readCloudManaged(),
    ]);

    await auditService.log({
      userId: actor.user.id,
      action: 'auth.settings_update',
      resourceType: 'settings',
      resourceId: 'auth',
      details: toAuthSettingsAuditDetails(input),
      userAgent: actor.userAgent,
    });

    let webTransport = {
      ...previousWebTransport,
      restartRequired: shouldRefreshWebIdentity && nextTlsEnabled,
      directAccess: false,
      targetUrl: null as string | null,
    };
    if (input.webTlsEnabled !== undefined && input.webTlsEnabled !== previousWebTransport.tlsEnabled) {
      const next = await webTransportSettingsService.updateConfig({ tlsEnabled: input.webTlsEnabled });
      const host = request.host ?? '';
      let hostname = '';
      try {
        hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
      } catch {
        // Global host validation already rejected malformed values.
      }
      const directAccess = isIP(hostname) !== 0 && !request.forwardedHost;
      webTransport = {
        ...next,
        restartRequired: true,
        directAccess,
        targetUrl: directAccess ? `${next.tlsEnabled ? 'https' : 'http'}://${host}` : null,
      };
    }
    if (webTransport.restartRequired) {
      container.resolve(RuntimeRestartService).request('web identity or transport changed');
    }
    container.resolve(EventBusService).publish('system.config.changed', {
      action: 'gateway_settings_updated',
      userId: actor.user.id,
    });

    return {
      ...updated,
      smtp,
      oidc,
      logging,
      mcpServerEnabled: mcpSettings.serverEnabled,
      mcpExtendedCompatibility: mcpSettings.extendedCompatibility,
      generalSettings,
      webTransport,
      networkSecurity,
      outboundWebhookPolicy,
      ...(request.currentRequestIp ? { currentRequestIp: request.currentRequestIp(networkSecurity) } : {}),
      availableGroups,
      cloudManaged,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update authentication settings';
    if (message === 'Permission group not found') throw new AppError(404, 'NOT_FOUND', message);
    throw err;
  }
}

/** Previous values for exactly the general settings fields that differ after an update. */
export function generalSettingsRollbackPatch(
  previous: GeneralSettings,
  applied: GeneralSettings
): GeneralSettingsUpdate {
  const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(applied) as Array<keyof GeneralSettings>) {
    if (key === 'features' || key === 'relay') {
      const before = previous[key] as unknown as Record<string, unknown>;
      const after = applied[key] as unknown as Record<string, unknown>;
      const changed = Object.keys(after).filter((field) => differs(before[field], after[field]));
      if (changed.length > 0) patch[key] = Object.fromEntries(changed.map((field) => [field, before[field]]));
    } else if (differs(previous[key], applied[key])) {
      patch[key] = previous[key];
    }
  }
  return patch as GeneralSettingsUpdate;
}

/** The general settings a request asked to change and that the write actually changed. */
export function generalSettingsRollbackFields(
  previous: GeneralSettings,
  applied: GeneralSettings,
  requested: object | undefined
): Array<keyof GeneralSettings> {
  if (!requested) return [];
  return (Object.keys(generalSettingsRollbackPatch(previous, applied)) as Array<keyof GeneralSettings>).filter(
    (field) => field in requested
  );
}

function toAuthSettingsAuditDetails(input: UpdateAuthProvisioningSettingsInput) {
  const { smtp: smtpInput, oidc: oidcInput, logging: loggingInput, ...rest } = input;
  const smtp = smtpInput ? (({ password: _password, ...safe }) => safe)(smtpInput) : undefined;
  const oidc = oidcInput ? (({ clientSecret: _clientSecret, ...safe }) => safe)(oidcInput) : undefined;
  const logging = loggingInput ? (({ password: _password, ...safe }) => safe)(loggingInput) : undefined;
  return {
    ...rest,
    ...(smtp ? { smtp: { ...smtp, ...(smtpInput?.password ? { passwordChanged: true } : {}) } } : {}),
    ...(oidc ? { oidc: { ...oidc, ...(oidcInput?.clientSecret ? { clientSecretChanged: true } : {}) } } : {}),
    ...(logging ? { logging: { ...logging, ...(loggingInput?.password ? { passwordChanged: true } : {}) } } : {}),
  };
}
