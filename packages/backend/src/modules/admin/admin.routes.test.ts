import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { AuthMailService } from '@/modules/auth/auth-mail.service.js';
import { LocalAuthService } from '@/modules/auth/local-auth.service.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { CloudLinkService } from '@/modules/cloud-link/cloud-link.service.js';
import { groupRoutes } from '@/modules/groups/group.routes.js';
import { GroupService } from '@/modules/groups/group.service.js';
import { PermissionGroupFolderService } from '@/modules/groups/permission-group-folders.service.js';
import { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
import { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import { assertFolderMoveAccess, type FolderMoveAccess } from '@/modules/resource-folders/resource-folder.service.js';
import { DEFAULT_GENERAL_SETTINGS, GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { NetworkSettingsService } from '@/modules/settings/network-settings.service.js';
import { OutboundWebhookPolicyService } from '@/modules/settings/outbound-webhook-policy.service.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { GatewayIdentityRenewalService } from '@/services/gateway-identity-renewal.service.js';
import { SessionService } from '@/services/session.service.js';
import { WebIdentityService } from '@/services/web-identity.service.js';
import { WebTransportSettingsService } from '@/services/web-transport-settings.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import { adminRoutes, generalSettingsRollbackFields, generalSettingsRollbackPatch } from './admin.routes.js';
import { AdminUserFolderService } from './admin-user-folders.service.js';
import { findCloudManagedChanges } from './cloud-managed-settings.js';
import { findIdentityTrustChanges } from './identity-trust-settings.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'http://localhost/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PKI_MASTER_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [],
  isBlocked: false,
};

const SESSION: SessionData = {
  userId: USER.id,
  user: USER,
  accessToken: 'oidc-access-token',
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  csrfToken: 'csrf-token',
};

const TARGET_USER: User = {
  ...USER,
  id: '22222222-2222-4222-8222-222222222222',
  oidcSubject: 'target-user',
  email: 'target@example.com',
  name: 'Target User',
  groupName: 'viewer',
  scopes: ['nodes:details:node-1'],
};

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/admin', adminRoutes);
  return app;
}

function registerSession(scopes: string[], user: User = USER) {
  container.registerInstance(SessionService, {
    getSession: vi.fn().mockResolvedValue({ ...SESSION, userId: user.id, user }),
    validateCsrfToken: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(false),
  } as unknown as SessionService);
  container.registerInstance(TOKENS.DrizzleClient, {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: user.id,
          oidcSubject: user.oidcSubject,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
          groupId: user.groupId,
          additionalScopes: [],
          isBlocked: user.isBlocked,
        }),
      },
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue([{ id: user.groupId, parentId: null, name: user.groupName, scopes }]),
      },
    },
  } as unknown as DrizzleClient);
  container.registerInstance(AuthMailService, {
    getPublicConfig: vi.fn().mockResolvedValue({
      configured: false,
      host: null,
      port: null,
      tlsMode: null,
      username: null,
      passwordLast4: null,
      senderName: null,
      senderEmail: null,
      verifiedAt: null,
    }),
  } as unknown as AuthMailService);
  container.registerInstance(OidcSettingsService, {
    getPublicConfig: vi.fn().mockResolvedValue({
      configured: false,
      issuer: null,
      clientId: null,
      clientSecretLast4: null,
      redirectUri: null,
      scopes: 'openid email profile',
    }),
    saveConfig: vi.fn(),
  } as unknown as OidcSettingsService);
  container.registerInstance(LoggingSettingsService, {
    getPublicConfig: vi.fn().mockResolvedValue({
      mode: 'disabled',
      url: '',
      username: '',
      passwordLast4: null,
      database: 'gateway_logs',
      table: 'logs',
      requestTimeoutMs: 5000,
    }),
  } as unknown as LoggingSettingsService);
  container.registerInstance(WebTransportSettingsService, {
    getConfig: vi.fn().mockResolvedValue({ tlsEnabled: false }),
    updateConfig: vi.fn(),
  } as unknown as WebTransportSettingsService);
}

function sessionHeaders() {
  return {
    Cookie: 'session_id=session-1',
    'X-CSRF-Token': 'csrf-token',
    'Content-Type': 'application/json',
  };
}

afterEach(() => {
  container.reset();
  delete process.env.GATEWAY_DEPLOYMENT_MODE;
});

describe('admin user identity validation', () => {
  it('rejects creating a user with a blank name', async () => {
    registerSession(['admin:users']);

    const response = await createApp().request('/api/admin/users', {
      method: 'POST',
      headers: sessionHeaders(),
      body: JSON.stringify({
        email: 'new@example.com',
        name: '   ',
        groupId: '11111111-1111-4111-8111-111111111112',
        authMethod: 'email_otp',
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it("allows an administrator to reset a manageable user's avatar", async () => {
    registerSession(['admin:users', 'nodes:details:node-1']);
    const target = { ...TARGET_USER, avatarUrl: 'data:image/png;base64,cG5n' };
    const updated = { ...target, avatarUrl: null };
    const updateUserAvatar = vi.fn().mockResolvedValue(updated);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(target),
      updateUserAvatar,
    } as unknown as AuthService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const response = await createApp().request(`/api/admin/users/${target.id}/avatar`, {
      method: 'DELETE',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(200);
    expect(updateUserAvatar).toHaveBeenCalledWith(target.id, null);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.avatar_reset', resourceId: target.id })
    );
  });
});

describe('user and group folder moves', () => {
  const OWN_FOLDER = '44444444-4444-4444-8444-444444444444';
  const OTHER_TEAM_FOLDER = '55555555-5555-4555-8555-555555555555';
  const OWN_MEMBER = '66666666-6666-4666-8666-666666666666';

  // The moved folder holds a user and a group of another team; the real access check decides.
  function folderServiceHolding(resourceId: string) {
    return {
      moveFolder: vi.fn(
        async (_id: string, input: { parentId: string | null }, _userId: string, access: FolderMoveAccess | null) => {
          if (access) assertFolderMoveAccess(access, [resourceId], input.parentId);
          return { id: OTHER_TEAM_FOLDER, parentId: input.parentId };
        }
      ),
    };
  }

  it('refuses moving another team folder of users or groups under a folder the caller administers', async () => {
    registerSession([
      'admin:users:folders:manage',
      'admin:groups:folders:manage',
      `admin:users:${OWN_MEMBER}`,
      `admin:groups:${OWN_MEMBER}`,
    ]);
    container.registerInstance(AdminUserFolderService, folderServiceHolding(TARGET_USER.id) as never);
    container.registerInstance(PermissionGroupFolderService, folderServiceHolding('group-of-other-team') as never);
    const app = createApp();
    app.route('/api/admin/groups', groupRoutes);

    for (const path of [
      `/api/admin/user-folders/${OTHER_TEAM_FOLDER}/move`,
      `/api/admin/groups/folders/${OTHER_TEAM_FOLDER}/move`,
    ]) {
      const response = await app.request(path, {
        method: 'PUT',
        headers: sessionHeaders(),
        body: JSON.stringify({ parentId: OWN_FOLDER }),
      });
      expect(response.status).toBe(403);
    }
  });
});

describe('admin user email onboarding', () => {
  it('sends an onboarding email when an email-code user is created', async () => {
    registerSession(['admin:users']);
    const groupId = '33333333-3333-4333-8333-333333333333';
    const createdUser = { ...TARGET_USER, groupId, authMethod: 'email_otp' as const };
    const createUser = vi.fn().mockResolvedValue(createdUser);
    const requestPasswordLink = vi.fn().mockResolvedValue(undefined);
    const sendEmailOtpOnboarding = vi.fn().mockResolvedValue(undefined);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AuthService, {
      createUser,
      grantCreatedResourcePermissions: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuthService);
    container.registerInstance(GroupService, {
      getGroup: vi.fn().mockResolvedValue({ id: groupId, name: 'viewer', scopes: [], inheritedScopes: [] }),
    } as unknown as GroupService);
    container.registerInstance(AuthMailService, {
      getPublicConfig: vi.fn().mockResolvedValue({ verifiedAt: '2026-08-27T00:00:00.000Z' }),
    } as unknown as AuthMailService);
    container.registerInstance(LocalAuthService, {
      requestPasswordLink,
      sendEmailOtpOnboarding,
    } as unknown as LocalAuthService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const response = await createApp().request('/api/admin/users', {
      method: 'POST',
      headers: sessionHeaders(),
      body: JSON.stringify({
        email: createdUser.email,
        name: createdUser.name,
        groupId,
        authMethod: 'email_otp',
      }),
    });

    expect(response.status).toBe(201);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: createdUser.email, authMethod: 'email_otp' })
    );
    expect(sendEmailOtpOnboarding).toHaveBeenCalledWith(createdUser.email);
    expect(requestPasswordLink).not.toHaveBeenCalled();
  });

  it('sends the same onboarding email when an existing user is switched to email-code sign-in', async () => {
    registerSession(['admin:users', 'nodes:details:node-1']);
    const updatedUser = { ...TARGET_USER, authMethod: 'email_otp' as const };
    const updateUserAuthMethod = vi.fn().mockResolvedValue(updatedUser);
    const sendEmailOtpOnboarding = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue({ ...TARGET_USER, authMethod: 'oidc' }),
      updateUserAuthMethod,
    } as unknown as AuthService);
    container.registerInstance(AuthMailService, {
      getPublicConfig: vi.fn().mockResolvedValue({ verifiedAt: '2026-08-27T00:00:00.000Z' }),
    } as unknown as AuthMailService);
    container.registerInstance(LocalAuthService, {
      requestPasswordLink: vi.fn(),
      sendEmailOtpOnboarding,
    } as unknown as LocalAuthService);
    container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService);

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/auth-method`, {
      method: 'PATCH',
      headers: sessionHeaders(),
      body: JSON.stringify({ authMethod: 'email_otp' }),
    });

    expect(response.status).toBe(200);
    expect(updateUserAuthMethod).toHaveBeenCalledWith(TARGET_USER.id, 'email_otp');
    expect(sendEmailOtpOnboarding).toHaveBeenCalledWith(updatedUser.email);
  });
});

describe('admin user impersonation', () => {
  function registerImpersonationDependencies(target: User) {
    registerSession(['admin:users:impersonate', 'nodes:details']);
    const createImpersonationSession = vi.fn().mockResolvedValue({
      sessionId: 'impersonation-session',
      expiresAt: Date.now() + 60_000,
    });
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue({ ...SESSION, purpose: 'user' }),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
      createImpersonationSession,
    } as unknown as SessionService);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(target),
    } as unknown as AuthService);
    container.registerInstance(AuditService, {
      log: vi.fn().mockResolvedValue(true),
    } as unknown as AuditService);
    container.registerInstance(GeneralSettingsService, {
      requirePublicUrl: vi.fn().mockResolvedValue('https://gateway.example.com'),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'direct',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    return createImpersonationSession;
  }

  it('creates a separate impersonation session and replaces only the browser cookie', async () => {
    const createImpersonationSession = registerImpersonationDependencies(TARGET_USER);

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/impersonate`, {
      method: 'POST',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('impersonation-session');
    expect(createImpersonationSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER.id }),
      TARGET_USER,
      'session-1',
      expect.objectContaining({ userAgent: undefined })
    );
  });

  it('keeps starting impersonation browser-session-only for bearer tokens', async () => {
    const createImpersonationSession = registerImpersonationDependencies(TARGET_USER);
    container.registerInstance(TokensService, {
      validateToken: vi.fn().mockResolvedValue({
        user: { ...USER, scopes: ['admin:users', 'admin:users:impersonate'] },
        scopes: ['admin:users', 'admin:users:impersonate'],
        tokenId: 'token-1',
        tokenPrefix: 'gw_test',
      }),
    } as unknown as TokensService);

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/impersonate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer gw_test' },
    });

    expect(response.status).toBe(403);
    expect(createImpersonationSession).not.toHaveBeenCalled();
  });

  it('rejects blocked targets before creating an impersonation session', async () => {
    const createImpersonationSession = registerImpersonationDependencies({
      ...TARGET_USER,
      isBlocked: true,
    });

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/impersonate`, {
      method: 'POST',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(409);
    expect(createImpersonationSession).not.toHaveBeenCalled();
  });

  it('rejects deleted targets before creating an impersonation session', async () => {
    const createImpersonationSession = registerImpersonationDependencies({
      ...TARGET_USER,
      isBlocked: true,
      isDeleted: true,
    });

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/impersonate`, {
      method: 'POST',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'USER_DELETED' });
    expect(createImpersonationSession).not.toHaveBeenCalled();
  });
});

describe('admin Gateway settings route permissions', () => {
  it('allows reading Gateway settings with settings:gateway:view without admin:users', async () => {
    registerSession(['settings:gateway:view']);
    container.registerInstance(AuthSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        oidcAutoCreateUsers: false,
        oidcDefaultGroupId: null,
        oidcRequireVerifiedEmail: true,
        oauthExtendedCallbackCompatibility: false,
      }),
    } as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, {
      getConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        fileUploadMaxBytes: 100 * 1024 * 1024,
        fileOpenMaxBytes: 10 * 1024 * 1024,
        features: { pkiEnabled: true, domainsEnabled: true },
      }),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'auto',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({
        allowPrivateNetworks: true,
        allowedPrivateCidrs: ['10.0.0.0/8', '172.16.0.0/12'],
      }),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {
      listGroups: vi.fn().mockResolvedValue([]),
    } as unknown as GroupService);

    const response = await createApp().request('/api/admin/auth-settings', { headers: sessionHeaders() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      oidcAutoCreateUsers: false,
      oidcDefaultGroupId: null,
      oidcRequireVerifiedEmail: true,
      oauthExtendedCallbackCompatibility: false,
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
      },
      logging: {
        mode: 'disabled',
        url: '',
        username: '',
        passwordLast4: null,
        database: 'gateway_logs',
        table: 'logs',
        requestTimeoutMs: 5000,
      },
      mcpServerEnabled: true,
      mcpExtendedCompatibility: false,
      generalSettings: {
        fileUploadMaxBytes: 100 * 1024 * 1024,
        fileOpenMaxBytes: 10 * 1024 * 1024,
        features: { pkiEnabled: true, domainsEnabled: true },
      },
      webTransport: {
        tlsEnabled: false,
        restartRequired: false,
        directAccess: false,
        targetUrl: null,
      },
      networkSecurity: {
        clientIpSource: 'auto',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      },
      outboundWebhookPolicy: {
        allowPrivateNetworks: true,
        allowedPrivateCidrs: ['10.0.0.0/8', '172.16.0.0/12'],
      },
      currentRequestIp: {
        source: 'unknown',
      },
      availableGroups: [],
      cloudManaged: false,
    });
  });

  it('returns a shape-compatible non-secret Gateway settings projection to demo visitors', async () => {
    process.env.GATEWAY_DEPLOYMENT_MODE = 'demo';
    const demoUser = { ...USER, groupId: 'demo-group', groupName: 'demo-admin', authMethod: 'demo_email_otp' as const };
    registerSession(['settings:gateway:view'], demoUser);
    container.registerInstance(AuthSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'secret-group',
        oidcRequireVerifiedEmail: false,
        oauthExtendedCallbackCompatibility: true,
        mfaExistingSessionGracePeriodDays: 30,
        methods: { oidc: true, password: true, emailOtp: false, passkeyLogin: true },
        passwordPolicy: { minLength: 20, maxLength: 64 },
      }),
    } as unknown as AuthSettingsService);
    container.registerInstance(AuthMailService, {
      getPublicConfig: vi.fn().mockResolvedValue({
        configured: true,
        host: 'smtp.internal.example',
        port: 587,
        tlsMode: 'starttls',
        username: 'mailer',
        passwordLast4: '1234',
        senderName: 'Gateway',
        senderEmail: 'gateway@example.test',
        verifiedAt: '2026-08-31T00:00:00.000Z',
      }),
    } as unknown as AuthMailService);
    container.registerInstance(OidcSettingsService, {
      getPublicConfig: vi.fn().mockResolvedValue({
        configured: true,
        issuer: 'https://id.internal.example',
        clientId: 'internal-client',
        clientSecretLast4: '5678',
        redirectUri: 'https://gateway.example/auth/callback',
        scopes: 'openid email profile groups',
      }),
    } as unknown as OidcSettingsService);
    container.registerInstance(LoggingSettingsService, {
      getPublicConfig: vi.fn().mockResolvedValue({
        mode: 'external',
        url: 'https://logs.internal.example',
        username: 'logger',
        passwordLast4: '9012',
        database: 'private_logs',
        table: 'gateway_events',
        requestTimeoutMs: 9000,
      }),
    } as unknown as LoggingSettingsService);
    container.registerInstance(McpSettingsService, {
      getConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: true }),
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        publicUrl: 'https://demo.goodgateway.dev',
        updateChannel: 'preview',
        hideExternalBranding: false,
        fileUploadMaxBytes: 100,
        fileOpenMaxBytes: 10,
        gatewayGrpcPublicTarget: 'gateway.internal:9443',
        gatewayGrpcLocalIp: '10.0.0.2:9443',
        relayAutoRecovery: true,
        relay: { dataLanes: 8 },
        relayGrantTtlHours: 24,
        shutdown: { userRequestDrainSeconds: 99, structuredLogDrainSeconds: 88, finalizationTimeoutSeconds: 77 },
        features: { pkiEnabled: true, domainsEnabled: true, siemEnabled: true, inferenceEnabled: false },
      }),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'reverse_proxy',
        trustedProxyCidrs: ['10.0.0.0/8'],
        trustCloudflareHeaders: true,
      }),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({ allowPrivateNetworks: true, allowedPrivateCidrs: ['10.0.0.0/8'] }),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {
      listGroups: vi.fn().mockResolvedValue([{ id: 'secret-group', name: 'Internal admins', scopes: [] }]),
    } as unknown as GroupService);

    const response = await createApp().request('/api/admin/auth-settings', { headers: sessionHeaders() });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { generalSettings: Record<string, unknown> };
    expect(body).toMatchObject({
      methods: { oidc: false, password: false, emailOtp: true, passkeyLogin: false },
      smtp: { configured: false, host: null, username: null, passwordLast4: null },
      oidc: { configured: false, issuer: null, clientId: null, clientSecretLast4: null },
      logging: { mode: 'disabled', url: '', username: '', passwordLast4: null },
      mcpServerEnabled: false,
      generalSettings: {
        publicUrl: 'https://demo.goodgateway.dev',
        gatewayGrpcPublicTarget: null,
        gatewayGrpcLocalIp: null,
        relayAutoRecovery: false,
      },
      networkSecurity: { clientIpSource: 'auto', trustedProxyCidrs: [], trustCloudflareHeaders: false },
      outboundWebhookPolicy: { allowPrivateNetworks: false, allowedPrivateCidrs: [] },
      availableGroups: [],
    });
    expect(JSON.stringify(body)).not.toContain('internal.example');
    expect(JSON.stringify(body)).not.toContain('1234');
    expect(JSON.stringify(body)).not.toContain('5678');
    expect(JSON.stringify(body)).not.toContain('9012');
    expect(body.generalSettings).not.toHaveProperty('relay');
  });

  it('does not allow editing Gateway settings with only settings:gateway:view', async () => {
    registerSession(['settings:gateway:view']);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({ mcpServerEnabled: false }),
    });

    expect(response.status).toBe(403);
  });

  it('returns a human-readable conflict when OIDC is enabled before it is configured', async () => {
    registerSession(['settings:gateway:edit']);
    const updateConfig = vi.fn();
    container.registerInstance(AuthSettingsService, { updateConfig } as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, {} as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {} as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {} as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {} as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {} as GroupService);
    container.registerInstance(AuditService, {} as AuditService);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({ methods: { oidc: true } }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'OIDC_NOT_CONFIGURED',
      message: 'Configure OIDC before enabling OIDC sign-in',
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('returns a human-readable conflict when email sign-in is enabled before SMTP is verified', async () => {
    registerSession(['settings:gateway:edit']);
    const updateConfig = vi.fn();
    container.registerInstance(AuthSettingsService, { updateConfig } as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, {} as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {} as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {} as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {} as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {} as GroupService);
    container.registerInstance(AuditService, {} as AuditService);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({ methods: { password: true } }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'SMTP_NOT_VERIFIED',
      message: 'Configure and verify SMTP before enabling password or email-code sign-in',
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('allows editing verified OIDC email requirement with settings:gateway:edit', async () => {
    registerSession(['settings:gateway:edit']);
    const updateConfig = vi.fn().mockResolvedValue({
      oidcAutoCreateUsers: true,
      oidcDefaultGroupId: 'group-1',
      oidcRequireVerifiedEmail: true,
    });
    container.registerInstance(AuthSettingsService, {
      updateConfig,
    } as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
      getConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        fileUploadMaxBytes: 100 * 1024 * 1024,
        fileOpenMaxBytes: 10 * 1024 * 1024,
        features: { pkiEnabled: true, domainsEnabled: true },
      }),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'auto',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({
        allowPrivateNetworks: true,
        allowedPrivateCidrs: [],
      }),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {
      listGroups: vi.fn().mockResolvedValue([]),
    } as unknown as GroupService);
    container.registerInstance(AuditService, {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({ oidcRequireVerifiedEmail: true }),
    });

    expect(response.status).toBe(200);
    expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({ oidcRequireVerifiedEmail: true }));
  });

  it('never writes an SMTP password into the auth-settings audit event', async () => {
    registerSession(['settings:gateway:edit', 'admin:system']);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AuthSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({}),
    } as unknown as AuthSettingsService);
    container.registerInstance(AuthMailService, {
      saveConfig: vi.fn().mockResolvedValue(undefined),
      getPublicConfig: vi.fn().mockResolvedValue({ verifiedAt: '2026-08-03T00:00:00.000Z' }),
    } as unknown as AuthMailService);
    container.registerInstance(McpSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      getConfig: vi.fn().mockResolvedValue({}),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'auto',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({}),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {
      listGroups: vi.fn().mockResolvedValue([]),
    } as unknown as GroupService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const password = 'smtp-password-that-must-not-be-audited';
    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({
        smtp: {
          host: 'smtp.example.com',
          port: 587,
          tlsMode: 'starttls',
          username: 'gateway',
          password,
          senderName: 'Gateway',
          senderEmail: 'security@example.com',
        },
      }),
    });

    expect(response.status).toBe(200);
    const entry = auditLog.mock.calls[0]?.[0];
    expect(entry).toMatchObject({ details: { smtp: { passwordChanged: true } } });
    expect(JSON.stringify(entry)).not.toContain(password);
  });

  it('allows editing general file upload limit with settings:gateway:edit', async () => {
    registerSession(['settings:gateway:edit']);
    const updateGeneralConfig = vi.fn().mockResolvedValue({
      fileUploadMaxBytes: 50 * 1024 * 1024,
      fileOpenMaxBytes: 10 * 1024 * 1024,
      features: { pkiEnabled: true, domainsEnabled: true, inferenceEnabled: true },
    });
    container.registerInstance(AuthSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: null,
        oidcRequireVerifiedEmail: false,
        oauthExtendedCallbackCompatibility: false,
      }),
    } as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      updateConfig: updateGeneralConfig,
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'auto',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({
        allowPrivateNetworks: true,
        allowedPrivateCidrs: [],
      }),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {
      listGroups: vi.fn().mockResolvedValue([]),
    } as unknown as GroupService);
    container.registerInstance(AuditService, {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({
        generalSettings: {
          fileUploadMaxBytes: 50 * 1024 * 1024,
          features: { inferenceEnabled: true },
        },
      }),
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(updateGeneralConfig).toHaveBeenCalledWith({
      fileUploadMaxBytes: 50 * 1024 * 1024,
      features: { inferenceEnabled: true },
    });
    expect(body.generalSettings.fileUploadMaxBytes).toBe(50 * 1024 * 1024);
    expect(body.generalSettings.fileOpenMaxBytes).toBe(10 * 1024 * 1024);
    expect(body.generalSettings.features).toEqual({
      pkiEnabled: true,
      domainsEnabled: true,
      inferenceEnabled: true,
    });
  });

  it('allows editing OAuth extended callback compatibility with settings:gateway:edit', async () => {
    registerSession(['settings:gateway:view', 'settings:gateway:edit']);
    const updateConfig = vi.fn().mockResolvedValue({
      oidcAutoCreateUsers: true,
      oidcDefaultGroupId: null,
      oidcRequireVerifiedEmail: true,
      oauthExtendedCallbackCompatibility: true,
    });
    container.registerInstance(AuthSettingsService, {
      updateConfig,
    } as unknown as AuthSettingsService);
    const updateMcpConfig = vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: true });
    container.registerInstance(McpSettingsService, {
      updateConfig: updateMcpConfig,
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        fileUploadMaxBytes: 100 * 1024 * 1024,
        fileOpenMaxBytes: 10 * 1024 * 1024,
        features: { pkiEnabled: true, domainsEnabled: true },
      }),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'auto',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({
        allowPrivateNetworks: true,
        allowedPrivateCidrs: [],
      }),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, {
      listGroups: vi.fn().mockResolvedValue([]),
    } as unknown as GroupService);
    container.registerInstance(AuditService, {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({
        oauthExtendedCallbackCompatibility: true,
        mcpExtendedCompatibility: true,
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({ oauthExtendedCallbackCompatibility: true }));
    expect(updateMcpConfig).toHaveBeenCalledWith({
      serverEnabled: undefined,
      extendedCompatibility: true,
    });
    expect(body.oauthExtendedCallbackCompatibility).toBe(true);
    expect(body.mcpExtendedCompatibility).toBe(true);
    expect(body.oidcRequireVerifiedEmail).toBe(true);
  });

  it('sends the selected SMTP test email template', async () => {
    registerSession(['settings:gateway:edit', 'admin:system']);
    const saveConfig = vi.fn().mockResolvedValue(undefined);
    const sendTestEmail = vi.fn().mockResolvedValue(undefined);
    const smtp = {
      configured: true,
      host: 'smtp.resend.com',
      port: 587,
      tlsMode: 'starttls' as const,
      username: 'resend',
      passwordLast4: '1234',
      senderName: 'Gateway',
      senderEmail: 'security@example.com',
      verifiedAt: '2026-08-02T00:00:00.000Z',
    };
    container.registerInstance(AuthMailService, {
      saveConfig,
      sendTestEmail,
      getPublicConfig: vi.fn().mockResolvedValue(smtp),
    } as unknown as AuthMailService);
    container.registerInstance(AuthSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: null,
        oidcRequireVerifiedEmail: true,
        oauthExtendedCallbackCompatibility: false,
      }),
    } as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        fileUploadMaxBytes: 100 * 1024 * 1024,
        fileOpenMaxBytes: 10 * 1024 * 1024,
        features: { pkiEnabled: true, domainsEnabled: true },
      }),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'auto',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({ allowPrivateNetworks: false, allowedPrivateCidrs: [] }),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, { listGroups: vi.fn().mockResolvedValue([]) } as unknown as GroupService);
    container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({
        smtp: {
          host: smtp.host,
          port: smtp.port,
          tlsMode: smtp.tlsMode,
          username: smtp.username,
          password: 'test-api-key',
          senderName: smtp.senderName,
          senderEmail: smtp.senderEmail,
          testRecipient: 'recipient@example.com',
          testEmailKind: 'email_otp',
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(saveConfig).toHaveBeenCalledOnce();
    expect(sendTestEmail).toHaveBeenCalledWith('recipient@example.com', 'email_otp');
  });
});

describe('admin user browser sessions', () => {
  it('lists only public session identifiers for a manageable user', async () => {
    registerSession(['admin:users', 'nodes:details:node-1']);
    const listPublicUserSessions = vi.fn().mockResolvedValue([
      {
        id: 'public-session-id',
        authMethod: 'oidc',
        createdAt: 1,
        lastSeenAt: 2,
        expiresAt: 3,
        ipAddress: '203.0.113.1',
        userAgent: 'Browser',
        mfaSatisfiedAt: null,
        isCurrent: false,
      },
    ]);
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(SESSION),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
      listPublicUserSessions,
    } as unknown as SessionService);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(TARGET_USER),
    } as unknown as AuthService);

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/sessions`, {
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([expect.objectContaining({ id: 'public-session-id', authMethod: 'oidc' })]);
    expect(listPublicUserSessions).toHaveBeenCalledWith(TARGET_USER.id, 'session-1');
  });

  it('revokes one public session and writes an audit record', async () => {
    registerSession(['admin:users', 'nodes:details:node-1']);
    const revokeUserSessionByPublicId = vi.fn().mockResolvedValue(true);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(SESSION),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
      revokeUserSessionByPublicId,
    } as unknown as SessionService);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(TARGET_USER),
    } as unknown as AuthService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/sessions/public-session-id`, {
      method: 'DELETE',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(200);
    expect(revokeUserSessionByPublicId).toHaveBeenCalledWith(TARGET_USER.id, 'public-session-id');
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.session_revoke',
        resourceType: 'session',
        resourceId: 'public-session-id',
        details: expect.objectContaining({ targetUserId: TARGET_USER.id }),
      })
    );
  });

  it('revokes all sessions and writes an audit record', async () => {
    registerSession(['admin:users', 'nodes:details:node-1']);
    const destroyAllUserSessions = vi.fn().mockResolvedValue(undefined);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(SESSION),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
      destroyAllUserSessions,
    } as unknown as SessionService);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(TARGET_USER),
    } as unknown as AuthService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/sessions`, {
      method: 'DELETE',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(200);
    expect(destroyAllUserSessions).toHaveBeenCalledWith(TARGET_USER.id);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.sessions_revoke_all',
        resourceType: 'user',
        resourceId: TARGET_USER.id,
        details: expect.objectContaining({ targetUserId: TARGET_USER.id }),
      })
    );
  });

  it('does not expose sessions or revoke them across the privilege boundary', async () => {
    registerSession(['admin:users']);
    const listPublicUserSessions = vi.fn();
    const revokeUserSessionByPublicId = vi.fn();
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(SESSION),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
      listPublicUserSessions,
      revokeUserSessionByPublicId,
    } as unknown as SessionService);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(TARGET_USER),
    } as unknown as AuthService);

    const [listResponse, revokeResponse] = await Promise.all([
      createApp().request(`/api/admin/users/${TARGET_USER.id}/sessions`, { headers: sessionHeaders() }),
      createApp().request(`/api/admin/users/${TARGET_USER.id}/sessions/public-session-id`, {
        method: 'DELETE',
        headers: sessionHeaders(),
      }),
    ]);

    expect(listResponse.status).toBe(403);
    expect(revokeResponse.status).toBe(403);
    expect(listPublicUserSessions).not.toHaveBeenCalled();
    expect(revokeUserSessionByPublicId).not.toHaveBeenCalled();
  });
});

describe('admin actions on the caller sign-in', () => {
  const OWNER = { ...USER, scopes: ['admin:system', 'admin:users'], authMethod: 'password' as const };

  it('refuses bearer tokens acting on the sign-in, MFA or sessions of their own account', async () => {
    const getUserById = vi.fn().mockResolvedValue(OWNER);
    const updateUserAuthMethod = vi.fn();
    container.registerInstance(AuthService, { getUserById, updateUserAuthMethod } as unknown as AuthService);
    const sessionService = {
      listPublicUserSessions: vi.fn(),
      revokeUserSessionByPublicId: vi.fn(),
      destroyAllUserSessions: vi.fn(),
    };
    container.registerInstance(SessionService, sessionService as unknown as SessionService);
    container.registerInstance(TokensService, {
      validateToken: vi.fn().mockResolvedValue({
        user: OWNER,
        scopes: ['admin:system', 'admin:users'],
        tokenId: 'token-1',
        tokenPrefix: 'gw_test',
      }),
    } as unknown as TokensService);
    const headers = { Authorization: 'Bearer gw_test', 'Content-Type': 'application/json' };

    const responses = await Promise.all([
      createApp().request(`/api/admin/users/${OWNER.id}/auth-method`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ authMethod: 'oidc' }),
      }),
      createApp().request(`/api/admin/users/${OWNER.id}/password-setup`, { method: 'POST', headers }),
      createApp().request(`/api/admin/users/${OWNER.id}/mfa/reset`, { method: 'POST', headers }),
      createApp().request(`/api/admin/users/${OWNER.id}/sessions`, { headers }),
      createApp().request(`/api/admin/users/${OWNER.id}/sessions/public-session-id`, { method: 'DELETE', headers }),
      createApp().request(`/api/admin/users/${OWNER.id}/sessions`, { method: 'DELETE', headers }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: 'SELF_SIGN_IN_PROGRAMMATIC' });
    }
    expect(getUserById).not.toHaveBeenCalled();
    expect(updateUserAuthMethod).not.toHaveBeenCalled();
    expect(sessionService.listPublicUserSessions).not.toHaveBeenCalled();
    expect(sessionService.revokeUserSessionByPublicId).not.toHaveBeenCalled();
    expect(sessionService.destroyAllUserSessions).not.toHaveBeenCalled();
  });

  it('still lets a browser session end its own sessions', async () => {
    registerSession(['admin:users']);
    const destroyAllUserSessions = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(SESSION),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
      destroyAllUserSessions,
    } as unknown as SessionService);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue({ ...USER, scopes: ['admin:users'] }),
    } as unknown as AuthService);
    container.registerInstance(AuditService, { log: vi.fn() } as unknown as AuditService);

    const response = await createApp().request(`/api/admin/users/${USER.id}/sessions`, {
      method: 'DELETE',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(200);
    expect(destroyAllUserSessions).toHaveBeenCalledWith(USER.id);
  });
});

describe('admin password link delivery', () => {
  it('sends a setup link before the first completed sign-in and records the action', async () => {
    registerSession(['admin:users', 'nodes:details:node-1']);
    const requestPasswordLink = vi.fn().mockResolvedValue(undefined);
    const hasCompletedSignIn = vi.fn().mockResolvedValue(false);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue({ ...TARGET_USER, authMethod: 'password' }),
      hasCompletedSignIn,
    } as unknown as AuthService);
    container.registerInstance(AuthMailService, {
      getPublicConfig: vi.fn().mockResolvedValue({ verifiedAt: '2026-08-01T00:00:00.000Z' }),
    } as unknown as AuthMailService);
    container.registerInstance(LocalAuthService, { requestPasswordLink } as unknown as LocalAuthService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/password-setup`, {
      method: 'POST',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(200);
    expect(requestPasswordLink).toHaveBeenCalledWith(TARGET_USER.email, 'password_setup');
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.password_link_sent',
        resourceId: TARGET_USER.id,
        details: expect.objectContaining({ purpose: 'password_setup' }),
      })
    );
  });

  it('sends a reset link after a completed sign-in', async () => {
    registerSession(['admin:users', 'nodes:details:node-1']);
    const requestPasswordLink = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue({ ...TARGET_USER, authMethod: 'password' }),
      hasCompletedSignIn: vi.fn().mockResolvedValue(true),
    } as unknown as AuthService);
    container.registerInstance(AuthMailService, {
      getPublicConfig: vi.fn().mockResolvedValue({ verifiedAt: '2026-08-01T00:00:00.000Z' }),
    } as unknown as AuthMailService);
    container.registerInstance(LocalAuthService, { requestPasswordLink } as unknown as LocalAuthService);
    container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService);

    const response = await createApp().request(`/api/admin/users/${TARGET_USER.id}/password-setup`, {
      method: 'POST',
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(200);
    expect(requestPasswordLink).toHaveBeenCalledWith(TARGET_USER.email, 'password_reset');
    await expect(response.json()).resolves.toMatchObject({ purpose: 'password_reset' });
  });
});

describe('admin user additional permissions', () => {
  it('updates exact additional scopes and records the effective permission change', async () => {
    registerSession(['admin:users', 'nodes:details:node-1', 'nodes:console:node-1']);
    const targetUser: User = {
      ...USER,
      id: '22222222-2222-4222-8222-222222222222',
      oidcSubject: 'target-user',
      email: 'target@example.com',
      groupName: 'viewer',
      groupScopes: ['nodes:details:node-1'],
      additionalScopes: [],
      scopes: ['nodes:details:node-1'],
    };
    const updatedUser: User = {
      ...targetUser,
      additionalScopes: ['nodes:console:node-1'],
      scopes: ['nodes:console:node-1', 'nodes:details:node-1'],
    };
    const assertCanUpdateUserAdditionalScopes = vi.fn().mockResolvedValue({
      targetUser,
      additionalScopes: ['nodes:console:node-1'],
    });
    const updateUserAdditionalScopes = vi.fn().mockResolvedValue(updatedUser);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AuthService, {
      assertCanUpdateUserAdditionalScopes,
      updateUserAdditionalScopes,
    } as unknown as AuthService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const response = await createApp().request(
      '/api/admin/users/22222222-2222-4222-8222-222222222222/additional-permissions',
      {
        method: 'PUT',
        headers: sessionHeaders(),
        body: JSON.stringify({ additionalScopes: ['nodes:console:node-1'] }),
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: targetUser.id,
      additionalScopes: ['nodes:console:node-1'],
    });
    expect(assertCanUpdateUserAdditionalScopes).toHaveBeenCalledWith(
      USER.id,
      ['admin:users', 'nodes:console:node-1', 'nodes:details:node-1'],
      targetUser.id,
      ['nodes:console:node-1']
    );
    expect(updateUserAdditionalScopes).toHaveBeenCalledWith(targetUser.id, ['nodes:console:node-1']);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.additional_permissions_change',
        resourceType: 'user',
        resourceId: targetUser.id,
        details: expect.objectContaining({
          addedScopes: ['nodes:console:node-1'],
          removedScopes: [],
        }),
      })
    );
  });
});

describe('deleted user administration', () => {
  it('does not expose deleted users to a regular user administrator', async () => {
    registerSession(['admin:users']);

    const response = await createApp().request('/api/admin/users/deleted', { headers: sessionHeaders() });

    expect(response.status).toBe(403);
  });

  it('allows only a system administrator to list and restore deleted users', async () => {
    registerSession(['admin:system']);
    const deletedUser = {
      id: '22222222-2222-4222-8222-222222222222',
      email: 'deleted@example.com',
      name: 'Deleted User',
      avatarUrl: null,
      deletedAt: '2026-08-01T10:00:00.000Z',
      deletedByUserId: USER.id,
      deletedFromGroupId: '33333333-3333-4333-8333-333333333333',
      originalGroupExists: false,
    };
    const restoredUser: User = {
      ...USER,
      id: deletedUser.id,
      email: deletedUser.email,
      name: deletedUser.name,
      groupId: '44444444-4444-4444-8444-444444444444',
      groupName: 'viewer',
      isBlocked: true,
    };
    const listDeletedUsers = vi.fn().mockResolvedValue([deletedUser]);
    const restoreUser = vi.fn().mockResolvedValue(restoredUser);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AuthService, { listDeletedUsers, restoreUser } as unknown as AuthService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const listResponse = await createApp().request('/api/admin/users/deleted', { headers: sessionHeaders() });
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([deletedUser]);

    const restoreResponse = await createApp().request(`/api/admin/users/${deletedUser.id}/restore`, {
      method: 'POST',
      headers: sessionHeaders(),
      body: JSON.stringify({ groupId: restoredUser.groupId }),
    });
    expect(restoreResponse.status).toBe(200);
    expect(restoreUser).toHaveBeenCalledWith(deletedUser.id, restoredUser.groupId, expect.any(Array));
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.restore', details: expect.objectContaining({ remainsBlocked: true }) })
    );
  });

  it('lets bearer tokens administer users through their delegated admin scopes', async () => {
    const listDeletedUsers = vi.fn().mockResolvedValue([]);
    container.registerInstance(AuthService, { listDeletedUsers } as unknown as AuthService);
    const validateToken = vi.fn().mockResolvedValue({
      user: { ...USER, scopes: ['admin:system', 'admin:users'] },
      scopes: ['admin:system'],
      tokenId: 'token-1',
      tokenPrefix: 'gw_test',
    });
    container.registerInstance(TokensService, { validateToken } as unknown as TokensService);

    const allowed = await createApp().request('/api/admin/users/deleted', {
      headers: { Authorization: 'Bearer gw_test' },
    });
    expect(allowed.status).toBe(200);
    expect(listDeletedUsers).toHaveBeenCalledTimes(1);

    validateToken.mockResolvedValueOnce({
      user: { ...USER, scopes: ['admin:system', 'admin:users'] },
      scopes: ['admin:users'],
      tokenId: 'token-1',
      tokenPrefix: 'gw_test',
    });
    const denied = await createApp().request('/api/admin/users/deleted', {
      headers: { Authorization: 'Bearer gw_test' },
    });
    expect(denied.status).toBe(403);
    expect(listDeletedUsers).toHaveBeenCalledTimes(1);
  });
});

describe('identity-trust settings require admin:system', () => {
  const currentSmtp = {
    configured: true,
    host: 'smtp.example.com',
    port: 587,
    tlsMode: 'starttls',
    username: 'gateway',
    senderName: 'Gateway',
    senderEmail: 'security@example.com',
  };
  const current = {
    smtp: async () => currentSmtp,
    generalSettings: async () => ({ publicUrl: 'https://gateway.example.com' }),
    authSettings: async () => ({ oidcRequireVerifiedEmail: true }),
  };
  const smtpInput = {
    host: 'smtp.example.com',
    port: 587,
    tlsMode: 'starttls' as const,
    username: 'gateway',
    senderName: 'Gateway',
    senderEmail: 'Security@Example.com',
  };

  it('flags SMTP, OIDC, public URL and verified-email relaxations', async () => {
    await expect(
      findIdentityTrustChanges({ smtp: { ...smtpInput, host: 'smtp.attacker.example' } }, current)
    ).resolves.toEqual(['SMTP']);
    await expect(findIdentityTrustChanges({ smtp: { ...smtpInput, password: 'new' } }, current)).resolves.toEqual([
      'SMTP',
    ]);
    await expect(
      findIdentityTrustChanges(
        {
          oidc: {
            issuer: 'https://idp.attacker.example',
            clientId: 'gateway',
            redirectUri: 'https://gateway.example.com/auth/callback',
          },
        },
        current
      )
    ).resolves.toEqual(['the OIDC provider']);
    await expect(
      findIdentityTrustChanges({ generalSettings: { publicUrl: 'https://attacker.example' } }, current)
    ).resolves.toEqual(['the public URL']);
    await expect(findIdentityTrustChanges({ oidcRequireVerifiedEmail: false }, current)).resolves.toEqual([
      'OIDC verified-email enforcement',
    ]);
  });

  it('allows resubmitting unchanged values and unrelated settings', async () => {
    await expect(
      findIdentityTrustChanges(
        {
          smtp: { ...smtpInput, testRecipient: 'ops@example.com' },
          generalSettings: { publicUrl: 'https://gateway.example.com/', hideExternalBranding: true },
          oidcRequireVerifiedEmail: true,
          mcpServerEnabled: false,
        },
        current
      )
    ).resolves.toEqual([]);
  });

  it('rejects an SMTP change from a settings:gateway:edit holder before anything is saved', async () => {
    registerSession(['settings:gateway:edit']);
    const saveConfig = vi.fn();
    container.registerInstance(AuthMailService, {
      saveConfig,
      getPublicConfig: vi.fn().mockResolvedValue({ ...currentSmtp, passwordLast4: '1234', verifiedAt: null }),
    } as unknown as AuthMailService);
    container.registerInstance(AuthSettingsService, { updateConfig: vi.fn() } as unknown as AuthSettingsService);
    container.registerInstance(GeneralSettingsService, {
      getConfig: vi.fn().mockResolvedValue({ publicUrl: 'https://gateway.example.com' }),
    } as unknown as GeneralSettingsService);
    for (const service of [McpSettingsService, NetworkSettingsService, OutboundWebhookPolicyService, GroupService]) {
      container.registerInstance(service as never, {} as never);
    }
    container.registerInstance(AuditService, { log: vi.fn() } as unknown as AuditService);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({ smtp: { ...smtpInput, host: 'smtp.attacker.example', password: 'secret' } }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'ADMIN_SYSTEM_REQUIRED' });
    expect(saveConfig).not.toHaveBeenCalled();
  });
});

describe('general settings rollback', () => {
  it('rolls back only requested fields, and only if nothing changed them since', async () => {
    registerSession(['settings:gateway:edit', 'admin:system']);
    const previous = { ...DEFAULT_GENERAL_SETTINGS, publicUrl: 'https://old.example.com' };
    const applied = { ...previous, publicUrl: 'https://new.example.com' };
    const restoreFields = vi.fn().mockResolvedValue(previous);
    const updateConfig = vi.fn().mockResolvedValue(applied);
    container.registerInstance(AuthSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({}),
      getConfig: vi.fn().mockResolvedValue({}),
    } as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      getConfig: vi.fn().mockResolvedValue(previous),
      updateConfig,
      restoreFields,
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({}),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({}),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(WebTransportSettingsService, {
      getConfig: vi.fn().mockResolvedValue({ tlsEnabled: true }),
    } as unknown as WebTransportSettingsService);
    container.registerInstance(WebIdentityService, {
      refresh: vi.fn().mockRejectedValue(new Error('certificate issuance failed')),
    } as unknown as WebIdentityService);
    container.registerInstance(AuditService, { log: vi.fn() } as unknown as AuditService);
    container.registerInstance(CloudLinkService, {
      managedByCloud: vi.fn().mockResolvedValue(false),
    } as unknown as CloudLinkService);

    const response = await createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({ generalSettings: { publicUrl: 'https://new.example.com' } }),
    });

    expect(response.status).toBe(500);
    expect(updateConfig).toHaveBeenCalledOnce();
    expect(restoreFields).toHaveBeenCalledWith(previous, ['publicUrl'], { ifUnchangedFrom: applied });
  });

  it('never rolls back a field the request did not ask to change', () => {
    const previous = { ...DEFAULT_GENERAL_SETTINGS, publicUrl: 'https://old.example.com' };
    const applied = { ...previous, publicUrl: 'https://new.example.com', hideExternalBranding: true };

    expect(generalSettingsRollbackFields(previous, applied, { publicUrl: 'https://new.example.com' })).toEqual([
      'publicUrl',
    ]);
    expect(generalSettingsRollbackFields(previous, applied, undefined)).toEqual([]);
  });

  it('restores only the fields the failed request changed', () => {
    const previous = { ...DEFAULT_GENERAL_SETTINGS, publicUrl: 'https://old.example.com', hideExternalBranding: false };
    const applied = {
      ...previous,
      publicUrl: 'https://new.example.com',
      gatewayGrpcPublicTarget: 'grpc.example.com:443',
      relay: { ...previous.relay, dataLanes: previous.relay.dataLanes + 1 },
    };

    expect(generalSettingsRollbackPatch(previous, applied)).toEqual({
      publicUrl: 'https://old.example.com',
      gatewayGrpcPublicTarget: null,
      relay: { dataLanes: previous.relay.dataLanes },
    });
  });
});

describe('cloud-managed addresses', () => {
  const currentGeneral = {
    ...DEFAULT_GENERAL_SETTINGS,
    publicUrl: 'https://gw.example.com',
    gatewayGrpcPublicTarget: 'gw.example.com:9443',
    gatewayGrpcLocalIp: null,
  };

  function registerSettings(managed: boolean) {
    registerSession(['settings:gateway:edit', 'admin:system']);
    container.registerInstance(WebIdentityService, { refresh: vi.fn() } as unknown as WebIdentityService);
    container.registerInstance(GatewayIdentityRenewalService, {
      refreshGrpcIdentity: vi.fn(),
    } as unknown as GatewayIdentityRenewalService);
    const updateGeneralConfig = vi.fn().mockResolvedValue(currentGeneral);
    container.registerInstance(AuthSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: null,
        oidcRequireVerifiedEmail: true,
        oauthExtendedCallbackCompatibility: false,
      }),
      getConfig: vi.fn().mockResolvedValue({ oidcRequireVerifiedEmail: true }),
    } as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, {
      updateConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: false }),
    } as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, {
      getConfig: vi.fn().mockResolvedValue(currentGeneral),
      updateConfig: updateGeneralConfig,
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi
        .fn()
        .mockResolvedValue({ clientIpSource: 'auto', trustedProxyCidrs: [], trustCloudflareHeaders: false }),
    } as unknown as NetworkSettingsService);
    container.registerInstance(OutboundWebhookPolicyService, {
      getConfig: vi.fn().mockResolvedValue({ allowPrivateNetworks: true, allowedPrivateCidrs: [] }),
    } as unknown as OutboundWebhookPolicyService);
    container.registerInstance(GroupService, { listGroups: vi.fn().mockResolvedValue([]) } as unknown as GroupService);
    container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService);
    container.registerInstance(CloudLinkService, {
      managedByCloud: vi.fn().mockResolvedValue(managed),
    } as unknown as CloudLinkService);
    return updateGeneralConfig;
  }

  const put = (generalSettings: Record<string, unknown>) =>
    createApp().request('/api/admin/auth-settings', {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({ generalSettings }),
    });

  it('refuses changing the public URL or gRPC addresses of a managed installation', async () => {
    for (const change of [
      { gatewayGrpcPublicTarget: 'other.example.com:9443' },
      { gatewayGrpcLocalIp: '10.0.0.5:9443' },
      { publicUrl: 'https://other.example.com', fileUploadMaxBytes: 50 * 1024 * 1024 },
    ]) {
      const updateGeneralConfig = registerSettings(true);
      const response = await put(change);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'CLOUD_MANAGED' });
      expect(updateGeneralConfig).not.toHaveBeenCalled();
    }
  });

  it('still saves other fields with the managed addresses resubmitted unchanged', async () => {
    const updateGeneralConfig = registerSettings(true);
    const change = {
      publicUrl: 'https://gw.example.com/',
      gatewayGrpcPublicTarget: 'gw.example.com:9443',
      gatewayGrpcLocalIp: '',
      fileUploadMaxBytes: 50 * 1024 * 1024,
      relayGrantTtlHours: 12,
    };
    const response = await put(change);
    expect(response.status).toBe(200);
    expect(updateGeneralConfig).toHaveBeenCalledWith(change);
  });

  it('lets an installation that is not managed change them', async () => {
    const updateGeneralConfig = registerSettings(false);
    const response = await put({ gatewayGrpcPublicTarget: 'other.example.com:9443' });
    expect(response.status).toBe(200);
    expect(updateGeneralConfig).toHaveBeenCalledWith({ gatewayGrpcPublicTarget: 'other.example.com:9443' });
  });

  it('names only the addresses that change', () => {
    expect(
      findCloudManagedChanges({ publicUrl: 'https://gw.example.com', gatewayGrpcLocalIp: null }, currentGeneral)
    ).toEqual([]);
    expect(findCloudManagedChanges({ gatewayGrpcPublicTarget: 'not a host' }, currentGeneral)).toEqual([
      'the gRPC public target',
    ]);
  });
});
