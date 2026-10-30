import { OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getClientIpForContext } from '@/lib/request-ip.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { AuthMailService } from '@/modules/auth/auth-mail.service.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { clearSessionCookies, setSessionCookie } from '@/modules/auth/session-cookie.js';
import { CloudLinkService } from '@/modules/cloud-link/cloud-link.service.js';
import { claimRestoredOwnerLink } from '@/modules/configuration-transfer/owner-password-link.js';
import { SetupRestoreService } from '@/modules/configuration-transfer/setup-restore.service.js';
import { toLicenseAppError } from '@/modules/license/license.errors.js';
import { LicenseService } from '@/modules/license/license.service.js';
import { LoggingRuntimeService } from '@/modules/logging/logging-runtime.service.js';
import { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
import {
  GeneralSettingsService,
  isValidOpfieldHostPortTarget,
  isValidOpfieldIpPortTarget,
} from '@/modules/settings/general-settings.service.js';
import { CacheService } from '@/services/cache.service.js';
import { RuntimeRestartService } from '@/services/runtime-restart.service.js';
import { SessionService } from '@/services/session.service.js';
import { WebTransportSettingsService } from '@/services/web-transport-settings.service.js';
import type { AppEnv } from '@/types.js';
import { SetupAccessService, SetupAlreadyInProgressError, SetupApplyInProgressError } from './setup-access.service.js';
import { SetupCloudConnect } from './setup-cloud-connect.js';
import { getSetupNetworkSuggestions } from './setup-network-suggestions.js';
import { SetupTokenPolicyService } from './setup-token-policy.js';
import { SetupWizardService } from './setup-wizard.service.js';

const logger = createChildLogger('SetupRoutes');

export const setupRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
export const SETUP_SESSION_COOKIE = 'setup_session';
export const SETUP_CSRF_HEADER = 'X-CSRF-Token';
const OPFIELD_SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

function isDockerSocketUnavailable(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    if (
      message.includes('/var/run/docker.sock') &&
      (code === 'ENOENT' ||
        code === 'ECONNREFUSED' ||
        code === 'EACCES' ||
        /\b(?:ENOENT|ECONNREFUSED|EACCES)\b/.test(message))
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

async function setupApiDisabledResponse(c: Context<AppEnv>): Promise<Response | null> {
  const path = new URL(c.req.url).pathname;
  if (path === '/api/setup/status' || path === '/api/setup/restore/owner-link') return null;

  const policy = container.resolve(SetupTokenPolicyService);
  const enabled = await policy.isSetupApiEnabled();
  if (enabled) return null;

  logger.warn('Disabled setup API endpoint requested after setup lockout', {
    path,
    method: c.req.method,
  });
  return c.notFound();
}

export const setupApiDisabledMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const disabled = await setupApiDisabledResponse(c);
  if (disabled) return disabled;
  await next();
};

setupRoutes.use('*', setupApiDisabledMiddleware);

setupRoutes.get('/status', async (c) => {
  const policy = container.resolve(SetupTokenPolicyService);
  const access = container.resolve(SetupAccessService);
  const [complete, code, publicUrl, transport, progress] = await Promise.all([
    policy.isSetupComplete(),
    access.getCodeMetadata(),
    container.resolve(GeneralSettingsService).getPublicUrl(),
    container.resolve(WebTransportSettingsService).getConfig(),
    access.getProgress(getCookie(c, SETUP_SESSION_COOKIE)),
  ]);
  return c.json({
    data: {
      state: complete ? 'complete' : 'pending',
      code,
      publicUrl,
      tlsEnabled: transport.tlsEnabled,
      setupInProgress: progress.inProgress,
      currentSession: progress.currentSession,
    },
  });
});

setupRoutes.post('/unlock', async (c) => {
  const body = await c.req.json<{ code?: string }>();
  let session: { sessionId: string; codeId: string; csrfToken: string; expiresAt: string };
  try {
    session = await container.resolve(SetupAccessService).createSession(body.code?.trim() ?? '');
  } catch (error) {
    if (error instanceof SetupAlreadyInProgressError) {
      throw new AppError(409, 'SETUP_IN_PROGRESS', 'Opfield setup is already in progress');
    }
    throw new AppError(401, 'SETUP_CODE_INVALID', 'Invalid or expired setup code');
  }
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const secure = forwardedProto ? forwardedProto === 'https' : new URL(c.req.url).protocol === 'https:';
  setCookie(c, SETUP_SESSION_COOKIE, session.sessionId, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    maxAge: Math.max(1, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000)),
    path: '/api/setup',
  });
  return c.json({
    data: {
      unlocked: true,
      codeId: session.codeId,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    },
  });
});

export const requireSetupSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const valid = await container.resolve(SetupAccessService).validateSession(getCookie(c, SETUP_SESSION_COOKIE));
  if (!valid) throw new AppError(401, 'SETUP_SESSION_REQUIRED', 'A valid setup session is required');
  await next();
};

const SetupAuthSchema = z.object({
  option: z.enum(['opfield_account', 'oidc', 'password_totp']),
  methods: z.object({ oidc: z.boolean(), password: z.boolean(), emailOtp: z.boolean() }),
  oidc: z
    .object({
      issuer: z.string().url(),
      clientId: z.string().trim().min(1),
      clientSecret: z.string().min(1).optional(),
      redirectUri: z.string().url(),
      scopes: z.string().trim().min(1).optional(),
    })
    .optional(),
  smtp: z
    .object({
      host: z.string().trim().min(1),
      port: z.number().int().min(1).max(65535),
      tlsMode: z.enum(['starttls', 'tls']),
      username: z.string().trim(),
      password: z.string().min(1).optional(),
      senderName: z.string().trim(),
      senderEmail: z.string().email(),
    })
    .optional(),
  passwordPolicy: z
    .object({
      minLength: z.number().int().min(8).max(72).optional(),
      maxLength: z.number().int().min(8).max(72).optional(),
      requireUppercase: z.boolean().optional(),
      requireLowercase: z.boolean().optional(),
      requireDigit: z.boolean().optional(),
      requireSymbol: z.boolean().optional(),
    })
    .optional(),
});

const SetupAdminSchema = z.object({
  name: z.string().trim().min(1).max(255),
  email: z.string().email().max(255),
  authMethod: z.enum(['oidc', 'password']),
  password: z.string().min(1).max(72).optional(),
});

const SetupLoggingSchema = z.object({
  mode: z.enum(['disabled', 'local', 'external']),
  url: z.string().url().optional(),
  username: z.string().trim().min(1).optional(),
  password: z.string().min(1).optional(),
  database: z.string().trim().min(1).optional(),
  table: z.string().trim().min(1).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
});

const SetupApplySchema = z.object({
  publicUrl: z.string().trim().min(1).max(2048),
  network: z.object({
    grpcPublicTarget: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(isValidOpfieldHostPortTarget, 'Must be a hostname or IP address, optionally with a port'),
    grpcLocalIp: z
      .string()
      .trim()
      .max(255)
      .refine((value) => value === '' || isValidOpfieldIpPortTarget(value), {
        message: 'Must be an IPv4 or IPv6 address, optionally with a port',
      }),
  }),
  auth: SetupAuthSchema,
  administrator: SetupAdminSchema.optional(),
  logging: SetupLoggingSchema,
});

setupRoutes.use('/wizard/*', requireSetupSession);

setupRoutes.get('/wizard/csrf', async (c) => {
  const csrfToken = await container.resolve(SetupAccessService).getCsrfToken(getCookie(c, SETUP_SESSION_COOKIE));
  if (!csrfToken) throw new AppError(401, 'SETUP_SESSION_REQUIRED', 'A valid setup session is required');
  return c.json({ data: { csrfToken } });
});

setupRoutes.use('/wizard/*', async (c, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method.toUpperCase())) {
    await next();
    return;
  }
  const valid = await container
    .resolve(SetupAccessService)
    .validateCsrfToken(getCookie(c, SETUP_SESSION_COOKIE), c.req.header(SETUP_CSRF_HEADER));
  if (!valid) throw new AppError(403, 'SETUP_CSRF_INVALID', 'Invalid setup CSRF token');
  await next();
});

setupRoutes.get('/wizard/config', async (c) => {
  const [general, auth, smtp, oidc, logging, transport, administratorCreated, phase, license, administrator, cloud] =
    await Promise.all([
      container.resolve(GeneralSettingsService).getConfig(),
      container.resolve(AuthSettingsService).getConfig(),
      container.resolve(AuthMailService).getPublicConfig(),
      container.resolve(OidcSettingsService).getPublicConfig(),
      container.resolve(LoggingSettingsService).getPublicConfig(),
      container.resolve(WebTransportSettingsService).getConfig(),
      container.resolve(SetupTokenPolicyService).isOpfieldConfigured(),
      container.resolve(SetupWizardService).getPhase(),
      container.resolve(LicenseService).getOnboardingState(),
      container.resolve(SetupWizardService).administratorView(),
      setupCloudConnect().view(),
    ]);
  return c.json({
    data: {
      general,
      auth,
      smtp,
      oidc,
      logging,
      transport,
      administratorCreated,
      administrator,
      cloud,
      phase,
      license,
      networkSuggestions: getSetupNetworkSuggestions(),
    },
  });
});

// ── Opfield account ─────────────────────────────────────────────────
// The browser connects the installation at the account portal (state + PKCE) and comes back to /setup/cloud-callback;
// the installation enrols with the code and asks the account for its sign-in client (see SetupCloudConnect).

function setupCloudConnect(): SetupCloudConnect {
  return new SetupCloudConnect({
    db: container.resolve<DrizzleClient>(TOKENS.DrizzleClient),
    cache: container.resolve(CacheService),
    cloud: container.resolve(CloudLinkService),
    oidcSettings: container.resolve(OidcSettingsService),
    authSettings: container.resolve(AuthSettingsService),
    installationName: () => container.resolve(LicenseService).getInstallationName(),
  });
}

const SetupPublicUrlSchema = z.object({ publicUrl: z.string().trim().min(1).max(2048) });
const SetupCloudStartSchema = SetupPublicUrlSchema.extend({
  /** The origin the browser is on (window.location.origin): where the portal sends it back. */
  returnOrigin: z.string().trim().min(1).max(2048).optional(),
});
const SetupCloudFinishSchema = z.object({
  code: z.string().trim().min(1).max(64),
  state: z.string().trim().min(16).max(256).optional(),
  publicUrl: z.string().trim().min(1).max(2048).optional(),
});

setupRoutes.post('/wizard/cloud-connect/start', async (c) => {
  const { publicUrl, returnOrigin } = SetupCloudStartSchema.parse(await c.req.json());
  return c.json({
    data: await setupCloudConnect().start(getCookie(c, SETUP_SESSION_COOKIE)!, publicUrl, returnOrigin),
  });
});

setupRoutes.post('/wizard/cloud-connect/finish', async (c) => {
  const input = SetupCloudFinishSchema.parse(await c.req.json());
  return c.json({ data: await setupCloudConnect().finish(getCookie(c, SETUP_SESSION_COOKIE)!, input) });
});

setupRoutes.get('/wizard/cloud-connect', async (c) => c.json({ data: await setupCloudConnect().view() }));

// Another sign-in option after connecting: the cloud link goes (with the Opfield account provider it gave).
setupRoutes.post('/wizard/cloud-connect/disconnect', async (c) => {
  if (await container.resolve(SetupTokenPolicyService).isOpfieldConfigured()) {
    throw new AppError(
      409,
      'SETUP_ADMINISTRATOR_EXISTS',
      'The administrator was already created; disconnect the Opfield account in Settings after setup'
    );
  }
  return c.json({ data: await setupCloudConnect().disconnect() });
});

setupRoutes.post('/wizard/cloud-connect/client', async (c) => {
  const { publicUrl } = SetupPublicUrlSchema.parse(await c.req.json());
  return c.json({ data: await setupCloudConnect().requestClient(publicUrl) });
});

// ── Password with an authenticator app ──────────────────────────────
// The administrator is created with their password before the wizard goes on, then enrols the authenticator app.

const SetupPasswordAdministratorSchema = z.object({
  auth: SetupAuthSchema,
  administrator: z.object({
    name: z.string().trim().min(1).max(255),
    email: z.string().email().max(255),
    password: z.string().min(1).max(72),
  }),
});
const SetupTotpConfirmSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});

setupRoutes.post('/wizard/administrator', async (c) => {
  const input = SetupPasswordAdministratorSchema.parse(await c.req.json());
  const access = container.resolve(SetupAccessService);
  try {
    const data = await access.withApplyLock(getCookie(c, SETUP_SESSION_COOKIE), () =>
      container.resolve(SetupWizardService).createPasswordAdministrator(input.auth, input.administrator)
    );
    return c.json({ data });
  } catch (error) {
    if (error instanceof SetupApplyInProgressError) {
      throw new AppError(409, 'SETUP_APPLY_IN_PROGRESS', 'Opfield setup is already being applied');
    }
    throw error;
  }
});

setupRoutes.post('/wizard/administrator/totp/setup', async (c) =>
  c.json({ data: await container.resolve(SetupWizardService).beginAdministratorTotp() })
);

setupRoutes.post('/wizard/administrator/totp/confirm', async (c) => {
  const { code } = SetupTotpConfirmSchema.parse(await c.req.json());
  return c.json({
    data: { recoveryCodes: await container.resolve(SetupWizardService).confirmAdministratorTotp(code) },
  });
});

setupRoutes.post('/wizard/session', async (c) => {
  const setupSessionId = getCookie(c, SETUP_SESSION_COOKIE);
  const access = container.resolve(SetupAccessService);
  const expiresAt = await access.getSessionExpiresAt(setupSessionId);
  if (!setupSessionId || !expiresAt) {
    throw new AppError(401, 'SETUP_SESSION_REQUIRED', 'A valid setup session is required');
  }
  if ((await container.resolve(SetupWizardService).getPhase()) !== 'ai_workspace') {
    throw new AppError(409, 'SETUP_CONFIGURATION_REQUIRED', 'Apply Opfield setup before configuring AI Workspace');
  }
  const user = await container.resolve(AuthService).getUserById(OPFIELD_SYSTEM_USER_ID);
  if (!user) throw new AppError(500, 'SETUP_SYSTEM_USER_MISSING', 'Opfield System user is unavailable');

  const sessions = container.resolve(SessionService);
  await sessions.destroySetupSessions(OPFIELD_SYSTEM_USER_ID, setupSessionId);
  const session = await sessions.createSession(user, {
    purpose: 'setup',
    setupSessionId,
    expiresAt: Date.parse(expiresAt),
    ipAddress: await getClientIpForContext(c),
    userAgent: c.req.header('user-agent'),
  });
  // Named for the protocol the browser came over, the same one the session cookie is read by (selectSessionCookie).
  setSessionCookie(c, session.sessionId, (session.expiresAt - Date.now()) / 1000);
  return c.json({ data: { expiresAt: new Date(session.expiresAt).toISOString() } });
});

setupRoutes.post('/wizard/apply', async (c) => {
  const access = container.resolve(SetupAccessService);
  const input = SetupApplySchema.parse(await c.req.json());
  let result: { status: 'ready_for_ai' };
  try {
    result = await access.withApplyLock(getCookie(c, SETUP_SESSION_COOKIE), () =>
      container.resolve(SetupWizardService).apply(input, container.resolve(LoggingRuntimeService))
    );
  } catch (error) {
    if (error instanceof SetupApplyInProgressError) {
      throw new AppError(409, 'SETUP_APPLY_IN_PROGRESS', 'Opfield setup is already being applied');
    }
    if (isDockerSocketUnavailable(error)) {
      throw new AppError(
        503,
        'SETUP_DOCKER_UNAVAILABLE',
        'Opfield cannot access Docker. Verify that /var/run/docker.sock is mounted and accessible, then retry.'
      );
    }
    throw error;
  }
  return c.json({ data: result });
});

const SetupLicenseActivationSchema = z.object({
  licenseKey: z.string().trim().min(1).max(256),
});

async function requireAppliedSetup(): Promise<void> {
  if ((await container.resolve(SetupWizardService).getPhase()) !== 'ai_workspace') {
    throw new AppError(409, 'SETUP_CONFIGURATION_REQUIRED', 'Apply Opfield setup before choosing a license');
  }
}

setupRoutes.post('/wizard/license/community', async (c) => {
  await requireAppliedSetup();
  return c.json({ data: await container.resolve(LicenseService).continueWithCommunity() });
});

setupRoutes.post('/wizard/license/activate', async (c) => {
  await requireAppliedSetup();
  const input = SetupLicenseActivationSchema.parse(await c.req.json());
  try {
    return c.json({ data: await container.resolve(LicenseService).activateKey(input.licenseKey) });
  } catch (error) {
    throw toLicenseAppError(error) ?? error;
  }
});

const SetupAIWorkspaceOutcomeSchema = z.object({
  status: z.enum(['configured', 'skipped']),
  configuredVia: z.enum(['direct', 'opfield_inference']).optional(),
});

setupRoutes.post('/wizard/complete', async (c) => {
  const setupSessionId = getCookie(c, SETUP_SESSION_COOKIE);
  const access = container.resolve(SetupAccessService);
  const outcome = SetupAIWorkspaceOutcomeSchema.parse(await c.req.json());
  await access.withApplyLock(setupSessionId, async () => {
    await container.resolve(SessionService).destroySetupSessions(OPFIELD_SYSTEM_USER_ID, setupSessionId);
    await container.resolve(SetupWizardService).completeAIWorkspace(outcome);
  });
  clearSessionCookies(c);
  deleteCookie(c, SETUP_SESSION_COOKIE, { path: '/api/setup' });
  const transport = await container.resolve(WebTransportSettingsService).getConfig();
  if (transport.tlsEnabled) container.resolve(RuntimeRestartService).request('first-run web identity updated', 1_000);
  return c.json({ data: { status: 'completed', restartRequired: transport.tlsEnabled } });
});

// ── Restore from an export ──────────────────────────────────────────
// The first-run wizard can restore a configuration export instead of setting up a new installation.
// The file arrives in chunks, is checked with its passphrase, and is restored by a one-off container.

const SetupRestorePassphraseSchema = z.object({ passphrase: z.string().min(1).max(1024) });
const SetupRestoreStartSchema = z.object({
  passphrase: z.string().min(1).max(1024),
  publicUrl: z.string().trim().min(1).max(2048),
  grpcPublicTarget: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(isValidOpfieldHostPortTarget, 'Must be a hostname or IP address, optionally with a port'),
  grpcLocalIp: z
    .string()
    .trim()
    .max(255)
    .refine((value) => value === '' || isValidOpfieldIpPortTarget(value), {
      message: 'Must be an IPv4 or IPv6 address, optionally with a port',
    }),
  ownerLinkClaim: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,128}$/)
    .optional(),
});

async function requireFreshForRestore(): Promise<void> {
  if (await container.resolve(SetupTokenPolicyService).isOpfieldConfigured()) {
    throw new AppError(
      409,
      'SETUP_RESTORE_CONFIGURED',
      'An administrator was already created in this installation. Restore into a fresh installation.'
    );
  }
}

setupRoutes.get('/wizard/restore', async (c) => c.json({ data: await container.resolve(SetupRestoreService).view() }));

setupRoutes.put('/wizard/restore/archive', async (c) => {
  await requireFreshForRestore();
  const offset = Number(c.req.query('offset') ?? '0');
  const uploadedBytes = await container.resolve(SetupRestoreService).receiveChunk(offset, c.req.raw.body);
  return c.json({ data: { uploadedBytes } });
});

setupRoutes.delete('/wizard/restore', async (c) => {
  await container.resolve(SetupRestoreService).discard();
  return c.json({ data: await container.resolve(SetupRestoreService).view() });
});

setupRoutes.post('/wizard/restore/verify', async (c) => {
  await requireFreshForRestore();
  const { passphrase } = SetupRestorePassphraseSchema.parse(await c.req.json());
  return c.json({ data: await container.resolve(SetupRestoreService).startVerify(passphrase) });
});

// After a wizard restore of a managed cloud installation's export, the browser that started it gets the owner's
// one-time password link, once. Open after setup completes (see setupApiDisabledResponse); the claim is a secret
// only that browser holds.
setupRoutes.post('/restore/owner-link', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { claim?: unknown } | null;
  const claim = typeof body?.claim === 'string' ? body.claim : '';
  const link = /^[A-Za-z0-9_-]{32,128}$/.test(claim)
    ? await claimRestoredOwnerLink(container.resolve(CacheService), claim)
    : null;
  if (!link) throw new AppError(404, 'NOT_FOUND', 'No owner password link for this browser');
  return c.json({ data: link });
});

setupRoutes.post('/wizard/restore/start', async (c) => {
  await requireFreshForRestore();
  const input = SetupRestoreStartSchema.parse(await c.req.json());
  const access = container.resolve(SetupAccessService);
  const data = await access.withApplyLock(getCookie(c, SETUP_SESSION_COOKIE), () =>
    container.resolve(SetupRestoreService).startRestore(input)
  );
  return c.json({ data });
});
