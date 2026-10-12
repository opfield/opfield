import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { domainToASCII } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket, type NodeWebSocket } from '@hono/node-ws';
import { OpenAPIHono } from '@hono/zod-openapi';
import { apiReference } from '@scalar/hono-api-reference';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { getEnv, isDevelopment } from '@/config/env.js';
import { container, TOKENS } from '@/container.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { COMMERCIAL_ONLY_ROUTE_PREFIXES, commercialUnavailableRoutes } from '@/edition/unavailable-routes.js';
import { GATEWAY_RESTARTING_HTML, GATEWAY_RESTARTING_SCRIPT, gatewayNotFoundHtml } from '@/lib/gateway-error-pages.js';
import { injectLoginAuthMethods } from '@/lib/login-page.js';
import { ONE_TIME_LINK_TOKEN_PATH } from '@/lib/one-time-link-path.js';
import { tags as openApiTags, openApiValidationHook, securitySchemes } from '@/lib/openapi.js';
import { IDEMPOTENCY_API_DESCRIPTION, withIdempotencyKeyDocumentation } from '@/lib/openapi-idempotency.js';
import { auditContextMiddleware } from '@/middleware/audit-context.js';
import { emptyJsonBodyMiddleware } from '@/middleware/empty-json-body.js';
import { type ApiError, errorHandler } from '@/middleware/error-handler.js';
import { IDEMPOTENCY_REPLAYED_HEADER } from '@/middleware/idempotency.js';
import { loggerMiddleware } from '@/middleware/logger.js';
import {
  aiWebSocketRateLimitMiddleware,
  authCallbackRateLimitMiddleware,
  authLoginRateLimitMiddleware,
  authRateLimitMiddleware,
  createApiRateLimitMiddleware,
  pkiRateLimitMiddleware,
  publicStatusRateLimitMiddleware,
  publicWebhookRateLimitMiddleware,
  rateLimitMiddleware,
  setupRateLimitMiddleware,
  streamRateLimitMiddleware,
} from '@/middleware/rate-limit.js';
import { SCALAR_API_REFERENCE_CDN, securityHeadersMiddleware } from '@/middleware/security-headers.js';
import { accessListRoutes } from '@/modules/access-lists/access-list.routes.js';
import { adminRoutes } from '@/modules/admin/admin.routes.js';
import { DOCKER_ARCHIVE_LINK_PATH } from '@/modules/ai/ai.docker-archive-link.js';
import { dockerArchiveLinkRoutes } from '@/modules/ai/ai.docker-archive-link.routes.js';
import { aiRoutes } from '@/modules/ai/ai.routes.js';
import { STORAGE_OBJECT_LINK_PATH } from '@/modules/ai/ai.storage-object-link.js';
import { storageObjectLinkRoutes } from '@/modules/ai/ai.storage-object-link.routes.js';
import { authenticateWSConnection, createWSHandlers } from '@/modules/ai/ai.ws.js';
import { appsRoutes } from '@/modules/apps/apps.routes.js';
import { alertRoutes } from '@/modules/audit/alert.routes.js';
import { auditRoutes } from '@/modules/audit/audit.routes.js';
import { auditExportRouteRuntime } from '@/modules/audit/audit-export-route-runtime.js';
import { siemRouteRuntime } from '@/modules/audit/siem-route-runtime.js';
import { accessSummaryRoutes } from '@/modules/auth/access-summary.routes.js';
import {
  authMiddleware,
  isAdmittedSetupPurposeRequest,
  liveRequestSessionId,
  optionalAuthMiddleware,
  requireActiveUser,
} from '@/modules/auth/auth.middleware.js';
import { authRoutes } from '@/modules/auth/auth.routes.js';
import { AVATAR_UPLOAD_BODY_MAX_BYTES } from '@/modules/auth/avatar-storage.service.js';
import { getPublicAuthMethods } from '@/modules/auth/public-auth-methods.js';
import { getProgrammaticWebSocketCredential, getSessionWebSocketCredential } from '@/modules/auth/websocket-auth.js';
import { backupRuntime } from '@/modules/backups/backup-runtime.js';
import { cloudLinkRoutes } from '@/modules/cloud-link/cloud-link.routes.js';
import { statusPageUpstreamGuard } from '@/modules/cloud-link/cloud-link-status-page-upstream.js';
import {
  configurationExportLinkRoutes,
  configurationExportRoutes,
} from '@/modules/configuration-transfer/configuration-export.routes.js';
import { CONFIGURATION_EXPORT_LINK_PATH } from '@/modules/configuration-transfer/configuration-export.service.js';
import { SETUP_RESTORE_CHUNK_MAX_BYTES } from '@/modules/configuration-transfer/setup-restore.service.js';
import { databaseRouteRuntime } from '@/modules/databases/database-route-runtime.js';
import { databaseRoutes } from '@/modules/databases/databases.routes.js';
import { createManagedDatabaseLogStreamWSHandlers } from '@/modules/databases/managed-database-logs.ws.js';
import { isDemoMode } from '@/modules/demo/demo-mode.js';
import { PostgresProbe } from '@/modules/diagnostics/postgres-probe.js';
import { dockerRoutes } from '@/modules/docker/docker.routes.js';
import { DOCKER_LOG_TAIL_MAX } from '@/modules/docker/docker.schemas.js';
import { createComposeLogsWSHandlers } from '@/modules/docker/docker-compose-logs.ws.js';
import { createDockerExecWSHandlers } from '@/modules/docker/docker-exec.ws.js';
import { createDockerLogStreamWSHandlers } from '@/modules/docker/docker-logs.ws.js';
import { dockerRegistryAuthRoutes } from '@/modules/docker/docker-registry-auth.routes.js';
import { dockerSourceWebhookRoutes } from '@/modules/docker/docker-source.routes.js';
import { dockerWebhookTriggerRoutes } from '@/modules/docker/docker-webhook.routes.js';
import { domainRoutes } from '@/modules/domains/domain.routes.js';
import { groupRoutes } from '@/modules/groups/group.routes.js';
import { hostingIntegrationRoutes, hostingRoutes } from '@/modules/hosting/hosting.routes.js';
import { housekeepingRoutes } from '@/modules/housekeeping/housekeeping.routes.js';
import { inferenceCoreLifecycleRoutes } from '@/modules/inference/core/inference-core.routes.js';
import { createCoreResponsesWSHandlers } from '@/modules/inference/core/inference-core-proxy.ws.js';
import { inferenceManagementRoutes } from '@/modules/inference/inference.routes.js';
import { inferenceAuthMiddleware } from '@/modules/inference/inference-auth.middleware.js';
import { inferenceDataPlaneRoutes } from '@/modules/inference/inference-data-plane.routes.js';
import { inferenceDiscoveryRoutes } from '@/modules/inference/inference-discovery.routes.js';
import { inferenceSetupRoutes } from '@/modules/inference/inference-setup.routes.js';
import { ingressGroupRoutes } from '@/modules/ingress-groups/ingress-group.routes.js';
import { integrationsRoutes } from '@/modules/integrations/integrations.routes.js';
import { licenseRoutes } from '@/modules/license/license.routes.js';
import { loggingRouteRuntime } from '@/modules/logging/logging-route-runtime.js';
import { mcpRoutes } from '@/modules/mcp/mcp.routes.js';
import { monitoringRoutes } from '@/modules/monitoring/monitoring.routes.js';
import { createProxyLogStreamWSHandlers } from '@/modules/monitoring/proxy-logs.ws.js';
import { createNodeExecWSHandlers } from '@/modules/nodes/node-exec.ws.js';
import { createNodeNginxLogStreamWSHandlers } from '@/modules/nodes/node-nginx-logs.ws.js';
import { nodesRoutes } from '@/modules/nodes/nodes.routes.js';
import { notificationRoutes } from '@/modules/notifications/notification.routes.js';
import { oauthMetadataRoutes, oauthRoutes } from '@/modules/oauth/oauth.routes.js';
import { objectStorageRoutes } from '@/modules/object-storage/object-storage.routes.js';
import { storageRouteRuntime } from '@/modules/object-storage/storage-route-runtime.js';
import { finalizeSetupRoutes } from '@/modules/onboarding/finalize-setup.routes.js';
import { PAGE_UPLOAD_CHUNK_MAX_BYTES } from '@/modules/pages/deployments/page-deployment.service.js';
import { pagesRouteRuntime } from '@/modules/pages/pages-route-runtime.js';
import { PAGE_UPLOAD_LINK_PATH } from '@/modules/pages/uploads/page-upload-link.js';
import { pageUploadLinkRoutes } from '@/modules/pages/uploads/page-upload-link.routes.js';
import { pkiRouteRuntime } from '@/modules/pki/pki-route-runtime.js';
import { folderRoutes } from '@/modules/proxy/folder.routes.js';
import { nginxTemplateRoutes } from '@/modules/proxy/nginx-template.routes.js';
import { proxyRoutes } from '@/modules/proxy/proxy.routes.js';
import { resourceSearchRoutes } from '@/modules/resource-search/resource-search.routes.js';
import { environmentSettingsRoutes } from '@/modules/settings/environment-settings.routes.js';
import { getEnvironmentSettingsSnapshot } from '@/modules/settings/environment-settings.service.js';
import {
  FILE_UPLOAD_DEFAULT_BYTES,
  fileUploadBodyLimitBytes,
  GeneralSettingsService,
} from '@/modules/settings/general-settings.service.js';
import { setupApiDisabledMiddleware, setupRoutes } from '@/modules/setup/setup.routes.js';
import { SetupTokenPolicyService } from '@/modules/setup/setup-token-policy.js';
import { sslRoutes } from '@/modules/ssl/ssl.routes.js';
import { StatusPageService } from '@/modules/status-page/status-page.service.js';
import { statusPageRouteRuntime } from '@/modules/status-page/status-page-route-runtime.js';
import { managedStorageRoutes } from '@/modules/storage/managed-storage.routes.js';
import { managedStorageRouteRuntime } from '@/modules/storage/managed-storage-route-runtime.js';
import { systemRoutes } from '@/modules/system/system.routes.js';
import { tokensRoutes } from '@/modules/tokens/tokens.routes.js';
import { uiBootstrapRoutes } from '@/modules/ui-bootstrap/ui-bootstrap.routes.js';
import type { RedisClient } from '@/services/cache.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { GatewayLifecycleService } from '@/services/gateway-lifecycle.service.js';
import type { AppEnv } from '@/types.js';
import { authenticateEventsConnection, createEventsWSHandlers } from '@/ws/events.ws.js';

const STATUS_PREVIEW_PREFIX = '/_status-preview';
const OPENAPI_DOCUMENT_PATH = '/api/openapi.json';
const HEALTH_REDIS_TIMEOUT_MS = 1000;
const INFERENCE_RESPONSES_WEBSOCKET_PATH = '/api/inference/v1/responses';
const ENVIRONMENT_SETTINGS_KEY = 'environment:settings';
const GATEWAY_RESTARTING_SCRIPT_PATH = '/gateway-restarting.js';
const DOCKER_FILE_BODY_LIMIT_PATH =
  /^\/api\/docker\/nodes\/[^/]+\/(?:containers\/[^/]+\/files\/(?:write|create|uploads\/[^/]+\/chunks)|volumes\/[^/]+\/files\/(?:write|create|uploads\/[^/]+\/chunks))$/;
const NODE_FILE_BODY_LIMIT_PATH = /^\/api\/nodes\/[^/]+\/files\/(?:write|create|uploads\/[^/]+\/chunks)$/;
const PAGES_UPLOAD_CHUNK_PATH = /^\/api\/pages-deploy\/uploads\/[^/]+\/chunks$/;
const OBJECT_STORAGE_UPLOAD_PATH = /^\/api\/object-storage\/[^/]+\/objects\/upload$/;
const DOCKER_ARCHIVE_IMPORT_PATH = /^\/api\/docker\/nodes\/[^/]+\/containers\/archive$/;
const INFERENCE_DATA_PLANE_PREFIX = /^\/api\/inference\/(?:(?:anthropic|codex)\/v1|v1)(?:\/|$)/;

// Core lifecycle stays reachable while the inference feature is disabled:
// installing the core is what a fresh administrator does before enabling it.
const INFERENCE_CORE_LIFECYCLE_PREFIX = /^\/api\/inference\/core(?:\/|$)/;

function isInferenceDataPlanePath(path: string): boolean {
  return INFERENCE_DATA_PLANE_PREFIX.test(path);
}

function isBrowserDocumentRequest(
  method: string,
  path: string,
  accept: string | undefined,
  destination: string | undefined
) {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return false;
  if (path === '/api' || path.startsWith('/api/') || path === '/auth' || path.startsWith('/auth/')) return false;
  return destination === 'document' || accept?.toLowerCase().includes('text/html') === true;
}

function requestBodyLimit(maxSize: number): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize,
    onError: (c) => c.json({ code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' }, 413),
  }) as MiddlewareHandler<AppEnv>;
}

export function inferenceFeatureGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (INFERENCE_CORE_LIFECYCLE_PREFIX.test(c.req.path)) {
      await next();
      return;
    }
    const settings = container.resolve(GeneralSettingsService);
    if (!(await settings.isFeatureEnabled('inferenceEnabled'))) {
      return c.json({ code: 'INFERENCE_DISABLED', message: 'Inference proxy is disabled' }, 404);
    }
    await next();
  };
}

function requestBodyLimitDynamic(resolveMaxSize: () => Promise<number>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const maxSize = await resolveMaxSize();
    return requestBodyLimit(maxSize)(c, next);
  };
}

function requestBodyLimitDynamicExcept(
  resolveMaxSize: () => Promise<number> | number,
  except: (path: string) => boolean
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (except(c.req.path)) {
      await next();
      return;
    }
    return requestBodyLimit(await resolveMaxSize())(c, next);
  };
}

/**
 * The raw body of an object upload is the object: it may be as large as the file upload limit itself (the MCP upload
 * and the file managers use the same limit), and a larger one is refused with that limit named.
 */
function objectUploadBodyLimit(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let maxBytes = FILE_UPLOAD_DEFAULT_BYTES;
    try {
      maxBytes = (await container.resolve(GeneralSettingsService).getConfig()).fileUploadMaxBytes;
    } catch {
      /* the default limit */
    }
    const limit = `${Math.round((maxBytes / (1024 * 1024)) * 10) / 10} MB`;
    const limited = bodyLimit({
      maxSize: maxBytes,
      onError: (ctx) =>
        ctx.json(
          {
            code: 'STORAGE_UPLOAD_TOO_LARGE',
            message: `The object is larger than the file upload limit of ${limit} set in Settings`,
            details: { maxBytes },
          },
          413
        ),
    }) as MiddlewareHandler<AppEnv>;
    return limited(c, next);
  };
}

async function getFileUploadMaxBodyBytes(): Promise<number> {
  try {
    return await container.resolve(GeneralSettingsService).getFileUploadMaxBodyBytes();
  } catch {
    return fileUploadBodyLimitBytes(FILE_UPLOAD_DEFAULT_BYTES);
  }
}

const requireAnyEffectiveScope: MiddlewareHandler<AppEnv> = async (c, next) => {
  const scopes = c.get('effectiveScopes') ?? [];
  if (scopes.length === 0) {
    throw new HTTPException(403, { message: 'At least one permission scope is required' });
  }
  await next();
};

export function getDirectLocalRequestOrigin(
  requestUrl: string,
  hostHeader: string | undefined,
  localAddresses: ReadonlySet<string> = getLocalInterfaceAddresses()
): string | null {
  const rawHost = hostHeader?.trim();
  const requestHost = normalizeRequestHost(rawHost);
  if (!rawHost || !requestHost || !isLocalMachineHost(requestHost, localAddresses)) return null;

  try {
    const protocol = new URL(requestUrl).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return new URL(`${protocol}//${rawHost}`).origin;
  } catch {
    return null;
  }
}

export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  directLocalRequestOrigin: string | null = null
): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const requestOrigin = url.origin;
    const appOrigin = getCanonicalPublicUrlSync();
    if (requestOrigin === appOrigin) return true;
    if (requestOrigin === directLocalRequestOrigin) return true;
    return (
      isDevelopment() && (requestOrigin.startsWith('http://localhost') || requestOrigin.startsWith('http://127.0.0.1'))
    );
  } catch {
    return false;
  }
}

function getCanonicalPublicUrlSync(): string {
  try {
    return container.resolve(GeneralSettingsService).getCachedPublicUrl() ?? new URL(getEnv().APP_URL).origin;
  } catch {
    return new URL(getEnv().APP_URL).origin;
  }
}

function getAllowedWebSocketOrigin(requestUrl: string, hostHeader: string | undefined) {
  const directLocalRequestOrigin = getDirectLocalRequestOrigin(requestUrl, hostHeader);
  return (origin: string | undefined) => isAllowedWebSocketOrigin(origin, directLocalRequestOrigin);
}

function getWebSocketSessionId(
  cookieHeader: string | undefined,
  origin: string | undefined,
  requestUrl: string,
  hostHeader: string | undefined
): string {
  const credential = getSessionWebSocketCredential(
    cookieHeader,
    origin,
    getAllowedWebSocketOrigin(requestUrl, hostHeader)
  );
  return credential?.value ?? '';
}

async function isStatusHostRequest(hostHeader: string | undefined): Promise<boolean> {
  try {
    return await container.resolve(StatusPageService).isStatusHost(hostHeader);
  } catch {
    return false;
  }
}

async function getCanonicalPublicUrl(): Promise<string | null> {
  try {
    return await container.resolve(GeneralSettingsService).getPublicUrl();
  } catch {
    return getEnv().APP_URL;
  }
}

async function isSetupComplete(): Promise<boolean> {
  try {
    return await container.resolve(SetupTokenPolicyService).isSetupComplete();
  } catch {
    // Isolated route tests do not initialize the bootstrap container and
    // represent already configured installations.
    return true;
  }
}

export function normalizeRequestHost(hostHeader: string | undefined): string | null {
  const value = hostHeader?.trim();
  if (!value || /[\s/@?#\\]/.test(value)) return null;

  let hostname: string;
  const validPort = (suffix: string) => {
    if (!/^:\d{1,5}$/.test(suffix)) return false;
    const port = Number(suffix.slice(1));
    return port >= 1 && port <= 65535;
  };
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    if (closingBracket < 0) return null;
    hostname = value.slice(1, closingBracket);
    const suffix = value.slice(closingBracket + 1);
    if (suffix && !validPort(suffix)) return null;
    if (isIP(hostname) !== 6) return null;
  } else {
    const parts = value.split(':');
    if (parts.length > 2) return null;
    hostname = parts[0] ?? '';
    if (parts.length === 2 && !validPort(`:${parts[1] ?? ''}`)) return null;
  }

  hostname = hostname.toLowerCase().replace(/\.+$/, '');
  if (!hostname) return null;
  if (isIP(hostname)) return hostname;

  const ascii = domainToASCII(hostname).toLowerCase();
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split('.');
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    return null;
  }
  return ascii;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || (isIP(hostname) === 4 && hostname.startsWith('127.'));
}

function isPrivateOrLinkLocalIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [first = 0, second = 0] = address.split('.').map(Number);
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized);
  }
  return false;
}

function getLocalInterfaceAddresses(): Set<string> {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .map((entry) => entry.address.toLowerCase());
  addresses.push(
    ...(process.env.GATEWAY_LOCAL_HOSTS?.split(',')
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean) ?? [])
  );
  return new Set(addresses);
}

export function isLocalMachineHost(hostname: string, localAddresses?: ReadonlySet<string>): boolean {
  if (isLoopbackHost(hostname)) return true;
  const normalized = hostname.toLowerCase();
  // Interfaces are listed only for a private address: most requests carry the public host.
  return isPrivateOrLinkLocalIp(normalized) && (localAddresses ?? getLocalInterfaceAddresses()).has(normalized);
}

async function getRedisHealth(): Promise<'ok' | 'unavailable'> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const redis = container.resolve<RedisClient>(TOKENS.RedisClient);
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), HEALTH_REDIS_TIMEOUT_MS);
    });
    const result = await Promise.race([redis.ping(), timeoutPromise]);
    return result === 'PONG' ? 'ok' : 'unavailable';
  } catch {
    return 'unavailable';
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Over the probe's own connection: a pool saturated by work must not read as a database outage. */
async function getPostgresHealth(): Promise<'ok' | 'unavailable'> {
  if (!container.isRegistered(PostgresProbe)) return 'ok';
  return (await container.resolve(PostgresProbe).probe()).status;
}

export interface GatewayAppRuntime {
  app: OpenAPIHono<AppEnv>;
  injectWebSocket: NodeWebSocket['injectWebSocket'];
  wss: NodeWebSocket['wss'];
}

export function createApp(): GatewayAppRuntime {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // WebSocket support for AI assistant
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app: app as any });
  wss.options.maxPayload = getEnvironmentSettingsSnapshot().requestLimits.inferenceWebSocketMaxPayloadBytes;
  const inferenceSockets = new Set<typeof wss.clients extends Set<infer Socket> ? Socket : never>();
  wss.on('connection', (socket, request) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== INFERENCE_RESPONSES_WEBSOCKET_PATH) return;
    inferenceSockets.add(socket);
    socket.once('close', () => inferenceSockets.delete(socket));
  });
  if (container.isRegistered(EventBusService)) {
    container.resolve(EventBusService).subscribe('system.config.changed', (payload) => {
      if ((payload as { key?: unknown } | null)?.key !== ENVIRONMENT_SETTINGS_KEY) return;
      const previousLimit = wss.options.maxPayload;
      const nextLimit = getEnvironmentSettingsSnapshot().requestLimits.inferenceWebSocketMaxPayloadBytes;
      wss.options.maxPayload = nextLimit;
      // ws snapshots maxPayload in each receiver at upgrade time. Reconnect on
      // increases too, otherwise existing chats silently keep the old ceiling.
      if (typeof previousLimit !== 'number' || nextLimit === previousLimit) return;
      for (const socket of inferenceSockets) socket.terminate();
      inferenceSockets.clear();
    });
  }

  // Global middleware
  app.use('*', requestId());
  app.use('*', auditContextMiddleware);
  app.use('*', loggerMiddleware);
  app.use('*', securityHeadersMiddleware);
  app.use('*', emptyJsonBodyMiddleware);
  app.use('*', async (c, next) => {
    const requestHost = normalizeRequestHost(c.req.header('host'));
    const publicUrl = await getCanonicalPublicUrl();
    const appHost = publicUrl ? normalizeRequestHost(new URL(publicUrl).host) : null;
    const setupComplete = await isSetupComplete();
    // The setup guard below runs for the same request: it reuses this read.
    c.set('setupComplete', setupComplete);

    if (requestHost && (!setupComplete || (appHost && requestHost === appHost) || isLocalMachineHost(requestHost))) {
      await next();
      return;
    }

    if (requestHost && (await isStatusHostRequest(requestHost))) {
      await next();
      return;
    }

    const hideExternalBranding = container.isRegistered(GeneralSettingsService)
      ? (await container.resolve(GeneralSettingsService).getConfig()).hideExternalBranding
      : false;
    return c.html(gatewayNotFoundHtml(hideExternalBranding), 404);
  });
  app.use(
    '*',
    cors({
      origin: (origin) => {
        const appOrigin = getCanonicalPublicUrlSync();
        if (origin === appOrigin) return origin;
        if (
          isDevelopment() &&
          origin &&
          (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'))
        ) {
          return origin;
        }
        return '';
      },
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'X-API-Key',
        'X-Request-ID',
        'X-CSRF-Token',
        'Anthropic-Version',
        'Anthropic-Beta',
        'OpenAI-Beta',
        'OpenAI-Organization',
        'OpenAI-Project',
        'Idempotency-Key',
      ],
      exposeHeaders: [
        'X-Request-ID',
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
        IDEMPOTENCY_REPLAYED_HEADER,
      ],
      maxAge: 86400,
    })
  );

  app.use('*', async (c, next) => {
    const lifecycle = container.resolve(GatewayLifecycleService);
    if (lifecycle.getState() === 'running') {
      await acceptedOperations.run(next);
      return;
    }
    const path = new URL(c.req.url).pathname;
    const statusHost = await container.resolve(StatusPageService).isStatusHost(c.req.header('host'));
    const trafficClass = lifecycle.classifyRequest(c.req.method, path, statusHost);
    if (lifecycle.shouldAdmit(trafficClass)) {
      await acceptedOperations.run(next);
      return;
    }
    c.header('Retry-After', '1');
    c.header('Connection', 'close');
    c.header('Cache-Control', 'no-store');
    if (path === GATEWAY_RESTARTING_SCRIPT_PATH && c.req.method.toUpperCase() === 'GET') {
      return c.body(GATEWAY_RESTARTING_SCRIPT, 200, { 'Content-Type': 'text/javascript; charset=UTF-8' });
    }
    if (isBrowserDocumentRequest(c.req.method, path, c.req.header('accept'), c.req.header('sec-fetch-dest'))) {
      return c.html(GATEWAY_RESTARTING_HTML, 503);
    }
    return c.json({ code: 'SERVICE_RESTARTING', message: 'Opfield is restarting' }, 503);
  });

  app.use('*', async (c, next) => {
    if (c.get('setupComplete') ?? (await isSetupComplete())) {
      await next();
      return;
    }

    const path = new URL(c.req.url).pathname;
    if (path === '/health' || path === '/api/setup' || path.startsWith('/api/setup/')) {
      await next();
      return;
    }
    if (await isAdmittedSetupPurposeRequest(c)) {
      await next();
      return;
    }
    if (
      path.startsWith('/api/') ||
      path.startsWith('/auth/') ||
      path.startsWith('/pki/') ||
      path.startsWith('/.well-known/') ||
      path.startsWith('/docs') ||
      path === '/openapi.json'
    ) {
      return c.json({ code: 'SETUP_REQUIRED', message: 'Opfield setup must be completed first' }, 423);
    }
    await next();
  });

  const environmentSettings = getEnvironmentSettingsSnapshot;
  app.use(
    '/api/oauth/token',
    requestBodyLimitDynamic(async () => environmentSettings().requestLimits.oauthBodyMaxBytes)
  );
  app.use(
    '/api/oauth/revoke',
    requestBodyLimitDynamic(async () => environmentSettings().requestLimits.oauthBodyMaxBytes)
  );
  app.use(
    '/api/inference/v1/*',
    requestBodyLimitDynamic(async () => environmentSettings().requestLimits.inferenceHttpBodyMaxBytes)
  );
  app.use('/api/inference', inferenceFeatureGuard());
  app.use('/api/inference/*', inferenceFeatureGuard());
  app.use(
    '/api/logging/ingest',
    requestBodyLimitDynamic(async () => environmentSettings().loggingIngest.maxBodyBytes)
  );
  app.use(
    '/api/logging/ingest/batch',
    requestBodyLimitDynamic(async () => environmentSettings().loggingIngest.maxBodyBytes)
  );
  app.use(
    '/api/docker/nodes/:nodeId/containers/:containerId/files/write',
    requestBodyLimitDynamic(() => getFileUploadMaxBodyBytes())
  );
  app.use(
    '/api/docker/nodes/:nodeId/containers/:containerId/files/create',
    requestBodyLimitDynamic(() => getFileUploadMaxBodyBytes())
  );
  app.use(
    '/api/docker/nodes/:nodeId/containers/:containerId/files/uploads/:uploadId/chunks',
    requestBodyLimitDynamic(() => getFileUploadMaxBodyBytes())
  );
  app.use(
    '/api/docker/nodes/:nodeId/volumes/:name/files/write',
    requestBodyLimitDynamic(() => getFileUploadMaxBodyBytes())
  );
  app.use(
    '/api/docker/nodes/:nodeId/volumes/:name/files/create',
    requestBodyLimitDynamic(() => getFileUploadMaxBodyBytes())
  );
  app.use(
    '/api/docker/nodes/:nodeId/volumes/:name/files/uploads/:uploadId/chunks',
    requestBodyLimitDynamic(() => getFileUploadMaxBodyBytes())
  );
  app.use(
    '/api/nodes/:id/files/write',
    requestBodyLimitDynamic(() => getFileUploadMaxBodyBytes())
  );
  app.use(
    '/api/nodes/:id/files/create',
    requestBodyLimitDynamic(() => getFileUploadMaxBodyBytes())
  );
  app.use(
    '/api/nodes/:id/files/uploads/:uploadId/chunks',
    requestBodyLimitDynamic(() => getFileUploadMaxBodyBytes())
  );
  app.use('/api/pages-deploy/uploads/:id/chunks', requestBodyLimit(PAGE_UPLOAD_CHUNK_MAX_BYTES));
  // An object upload streams the file into storage: it takes the file upload limit, not the JSON body limit.
  app.use('/api/object-storage/:id/objects/upload', objectUploadBodyLimit());
  // A restore upload chunk is raw file bytes, up to its own limit.
  app.use('/api/setup/wizard/restore/archive', requestBodyLimit(SETUP_RESTORE_CHUNK_MAX_BYTES + 1024));
  app.use('/api/setup/*', setupApiDisabledMiddleware);
  app.use(
    '/api/*',
    requestBodyLimitDynamicExcept(
      () => environmentSettings().requestLimits.requestBodyMaxBytes,
      (path) =>
        DOCKER_FILE_BODY_LIMIT_PATH.test(path) ||
        NODE_FILE_BODY_LIMIT_PATH.test(path) ||
        PAGES_UPLOAD_CHUNK_PATH.test(path) ||
        OBJECT_STORAGE_UPLOAD_PATH.test(path) ||
        // One-time transfer links stream a whole file; their handlers enforce their own size limits.
        ONE_TIME_LINK_TOKEN_PATH.test(path) ||
        path === '/api/setup/wizard/restore/archive' ||
        DOCKER_ARCHIVE_IMPORT_PATH.test(path) ||
        isInferenceDataPlanePath(path)
    )
  );

  // Rate limiting for API and public PKI routes: a signed-in browser session has a budget of its own, anything else
  // counts per client IP.
  const apiRateLimitMiddleware = createApiRateLimitMiddleware(liveRequestSessionId);
  app.use('/api/*', async (c, next) => {
    if (isInferenceDataPlanePath(c.req.path)) {
      await next();
      return;
    }
    await apiRateLimitMiddleware(c, next);
  });
  // Public local-auth and passkey endpoints parse JSON before their route
  // schemas run, so give them the same conservative bound as OAuth bodies.
  app.use('/auth/me/avatar', requestBodyLimit(AVATAR_UPLOAD_BODY_MAX_BYTES));
  app.use(
    '/auth/*',
    requestBodyLimitDynamicExcept(
      async () => environmentSettings().requestLimits.oauthBodyMaxBytes,
      (path) => path === '/auth/me/avatar'
    )
  );
  app.use('/pki/*', rateLimitMiddleware);
  app.use('/auth/*', authRateLimitMiddleware);
  app.use('/auth/login', authLoginRateLimitMiddleware);
  app.use('/auth/password/login', authLoginRateLimitMiddleware);
  app.use('/auth/password/reset/request', authLoginRateLimitMiddleware);
  app.use('/auth/email-otp/request', authLoginRateLimitMiddleware);
  app.use('/auth/email-otp/verify', authLoginRateLimitMiddleware);
  if (isDemoMode()) {
    app.use('/auth/demo/request', authLoginRateLimitMiddleware);
    app.use('/auth/demo/verify', authLoginRateLimitMiddleware);
  }
  app.use('/auth/password/reset/complete', authLoginRateLimitMiddleware);
  app.use('/auth/mfa/*', authLoginRateLimitMiddleware);
  app.use('/auth/passkeys/*', authLoginRateLimitMiddleware);
  app.use('/auth/callback', authCallbackRateLimitMiddleware);
  app.use('/api/oauth/*', authRateLimitMiddleware);
  app.use('/pki/*', pkiRateLimitMiddleware);
  app.use('/api/public/status-page', publicStatusRateLimitMiddleware);
  app.use('/api/webhooks/docker/*', publicWebhookRateLimitMiddleware);
  app.use('/api/webhooks/docker-source/*', publicWebhookRateLimitMiddleware);
  app.use('/api/setup/*', setupRateLimitMiddleware);
  app.use('/api/ai/ws', aiWebSocketRateLimitMiddleware);
  app.use('/api/events', streamRateLimitMiddleware);
  app.use('/api/inference/setup/events', streamRateLimitMiddleware);
  app.use('/api/docker/nodes/:nodeId/containers/:containerId/exec', streamRateLimitMiddleware);
  app.use('/api/nodes/:nodeId/exec', streamRateLimitMiddleware);
  app.use('/api/docker/nodes/:nodeId/containers/:containerId/logs/stream', streamRateLimitMiddleware);
  app.use('/api/databases/:databaseId/logs/stream', streamRateLimitMiddleware);
  app.use('/api/docker/nodes/:nodeId/compose/:project/logs/stream', streamRateLimitMiddleware);
  app.use('/api/monitoring/logs/:hostId/ws', streamRateLimitMiddleware);
  app.use('/api/nodes/:nodeId/nginx-logs/ws', streamRateLimitMiddleware);

  // Safely no-ops when user is not set (unauthenticated); route-level authMiddleware handles 401
  app.use('/api/*', requireActiveUser);

  // Error handler
  app.onError(errorHandler);

  // Health check
  app.use('/health', optionalAuthMiddleware);
  app.get('/health', async (c) => {
    const [redis, postgres] = await Promise.all([getRedisHealth(), getPostgresHealth()]);
    const healthy = redis === 'ok' && postgres === 'ok';
    if (!c.get('user')) {
      return c.json({ status: healthy ? 'ok' : 'unavailable' }, healthy ? 200 : 503);
    }
    return c.json(
      {
        status: healthy ? 'ok' : 'unavailable',
        lifecycleState: container.resolve(GatewayLifecycleService).getState(),
        version: getEnv().APP_VERSION,
        timestamp: new Date().toISOString(),
        dependencies: { redis, postgres },
      },
      healthy ? 200 : 503
    );
  });

  app.use('*', async (c, next) => {
    const statusHost = await isStatusHostRequest(c.req.header('host'));
    if (!statusHost) {
      await next();
      return;
    }

    const path = new URL(c.req.url).pathname;
    if (path === '/api/public/status-page') {
      await next();
      return;
    }

    if (
      path.startsWith('/api/') ||
      path.startsWith('/auth/') ||
      path.startsWith('/oauth/') ||
      path.startsWith('/.well-known/') ||
      path.startsWith('/pki/') ||
      path.startsWith('/docs') ||
      path === '/openapi.json' ||
      path === '/health' ||
      path.startsWith(STATUS_PREVIEW_PREFIX)
    ) {
      return c.notFound();
    }

    await next();
  });

  // Public PKI endpoints (no auth) — CRL, OCSP, CA cert download

  // Auth routes
  app.route('/auth', authRoutes);
  app.route('/.well-known', oauthMetadataRoutes);
  app.route('/.well-known', inferenceDiscoveryRoutes);

  // Protected API routes
  app.route('/api/oauth', oauthRoutes);
  app.use('/api/inference/v1/responses', async (c, next) => {
    if (c.req.method === 'GET') return inferenceAuthMiddleware(c, next);
    await next();
  });
  app.get(
    '/api/inference/v1/responses',
    upgradeWebSocket((c) => {
      const user = c.get('user');
      const auth = c.get('inferenceAuth');
      return createCoreResponsesWSHandlers(
        user && auth ? { user, tokenId: auth.tokenId, tokenPrefix: auth.tokenPrefix, rawToken: auth.rawToken } : null,
        () => getEnvironmentSettingsSnapshot().requestLimits.inferenceWebSocketMaxPayloadBytes
      );
    })
  );
  app.route('/api/inference/v1', inferenceDataPlaneRoutes);
  app.route('/api/inference/setup', inferenceSetupRoutes);
  app.route('/api/inference/core', inferenceCoreLifecycleRoutes);
  app.route('/api/inference', inferenceManagementRoutes);
  app.route('/api/mcp/.well-known', oauthMetadataRoutes);
  app.route('/api/audit', auditRoutes);
  app.route('/api/alerts', alertRoutes);
  app.route('/api/auth', accessSummaryRoutes);
  app.route('/api/tokens', tokensRoutes);
  app.route('/api/admin/groups', groupRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/docker/registry', dockerRegistryAuthRoutes);
  app.route('/api/docker', dockerRoutes);
  app.route('/api/webhooks/docker', dockerWebhookTriggerRoutes);
  app.route('/api/webhooks/docker-source', dockerSourceWebhookRoutes);
  app.route('/api/nodes', nodesRoutes);
  app.route('/api/proxy-hosts', proxyRoutes);
  app.route('/api/resources', resourceSearchRoutes);
  app.route('/api/proxy-host-folders', folderRoutes);
  app.route('/api/nginx-templates', nginxTemplateRoutes);
  app.route('/api/ssl-certificates', sslRoutes);
  app.route('/api/domains', domainRoutes);
  app.route('/api/ingress-groups', ingressGroupRoutes);
  app.route('/api/apps', appsRoutes);
  app.route('/api/access-lists', accessListRoutes);
  app.route('/api/monitoring', monitoringRoutes);
  app.route('/api/setup', setupRoutes);
  app.route('/api/finalize-setup', finalizeSetupRoutes);
  app.route('/api/system/license', licenseRoutes);
  app.route('/api/system/cloud', cloudLinkRoutes);
  app.route('/api/system/configuration-export', configurationExportRoutes);
  app.route('/api/system', systemRoutes);
  app.route('/api/ui', uiBootstrapRoutes);
  app.route('/api/housekeeping', housekeepingRoutes);
  app.route('/api/settings/environment', environmentSettingsRoutes);
  app.route('/api/integrations/hosting', hostingIntegrationRoutes);
  app.route('/api/hosting', hostingRoutes);
  app.route('/api/integrations', integrationsRoutes);
  app.route('/api/notifications', notificationRoutes);
  app.route('/api/ai', aiRoutes);
  app.route('/api/mcp', mcpRoutes);
  app.route(PAGE_UPLOAD_LINK_PATH, pageUploadLinkRoutes);
  app.route(DOCKER_ARCHIVE_LINK_PATH, dockerArchiveLinkRoutes);
  app.route(STORAGE_OBJECT_LINK_PATH, storageObjectLinkRoutes);
  app.route(CONFIGURATION_EXPORT_LINK_PATH, configurationExportLinkRoutes);

  // A managed installation keeps the status page upstream the cloud set up (ahead of the module's own route).
  app.put('/api/status-page/settings', authMiddleware, statusPageUpstreamGuard);
  if (container.isRegistered(TOKENS.CommercialEdition)) {
    container.resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition).registerRoutes({
      app,
      upgradeWebSocket,
      pki: pkiRouteRuntime,
      siem: siemRouteRuntime,
      auditExport: auditExportRouteRuntime,
      pages: pagesRouteRuntime,
      logging: loggingRouteRuntime,
      statusPage: statusPageRouteRuntime,
      backups: backupRuntime,
      storage: storageRouteRuntime,
      databases: databaseRouteRuntime,
      managedStorage: managedStorageRouteRuntime,
    });
  }
  app.route('/api/object-storage', objectStorageRoutes);
  app.route('/api/databases', databaseRoutes);
  app.route('/api/managed-storage', managedStorageRoutes);
  // Only without the module: with it, a path or method its routes do not serve is a plain 404, not the paywall's 503
  // (stand rc.11 O-3: PATCH /api/status-page/incidents/{id} and GET /api/status-page/config).
  const commercialRoutesServed =
    container.isRegistered(TOKENS.CommercialEdition) &&
    container.resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition).status.state === 'ready';
  if (!commercialRoutesServed) {
    for (const prefix of COMMERCIAL_ONLY_ROUTE_PREFIXES) app.route(prefix, commercialUnavailableRoutes);
  }

  // AI WebSocket endpoint
  const wsHandlers = createWSHandlers();
  app.get(
    '/api/ai/ws',
    upgradeWebSocket((c) => {
      const sessionId = getWebSocketSessionId(
        c.req.header('cookie'),
        c.req.header('origin'),
        c.req.url,
        c.req.header('host')
      );
      return {
        onOpen(event, ws) {
          wsHandlers.onOpen(event, ws);
          // Authenticate after connection opens
          authenticateWSConnection(ws, sessionId).catch(() => {
            try {
              ws.close();
            } catch {
              /* ignore */
            }
          });
        },
        onMessage: wsHandlers.onMessage,
        onClose: wsHandlers.onClose,
        onError: wsHandlers.onError,
      };
    })
  );

  // Docker exec WebSocket endpoint
  app.get(
    '/api/docker/nodes/:nodeId/containers/:containerId/exec',
    upgradeWebSocket((c) => {
      const nodeId = c.req.param('nodeId') ?? '';
      const containerId = c.req.param('containerId') ?? '';
      const shell = c.req.query('shell') || '/bin/sh';
      const isAllowedOrigin = getAllowedWebSocketOrigin(c.req.url, c.req.header('host'));
      const credential = getProgrammaticWebSocketCredential(
        c.req.header('cookie'),
        c.req.header('origin'),
        c.req.header('authorization'),
        isAllowedOrigin
      );
      return createDockerExecWSHandlers(nodeId, containerId, shell, credential);
    })
  );

  // Node-level console WebSocket endpoint
  app.get(
    '/api/nodes/:nodeId/exec',
    upgradeWebSocket((c) => {
      const nodeId = c.req.param('nodeId') ?? '';
      const shell = c.req.query('shell') || 'auto';
      const isAllowedOrigin = getAllowedWebSocketOrigin(c.req.url, c.req.header('host'));
      const credential = getProgrammaticWebSocketCredential(
        c.req.header('cookie'),
        c.req.header('origin'),
        c.req.header('authorization'),
        isAllowedOrigin
      );
      return createNodeExecWSHandlers(nodeId, shell, credential);
    })
  );

  // Docker log stream WebSocket endpoint
  app.get(
    '/api/docker/nodes/:nodeId/containers/:containerId/logs/stream',
    upgradeWebSocket((c) => {
      const nodeId = c.req.param('nodeId') ?? '';
      const containerId = c.req.param('containerId') ?? '';
      const requestedTail = Number(c.req.query('tail')) || 100;
      const tail = Math.min(Math.max(Math.trunc(requestedTail), 1), DOCKER_LOG_TAIL_MAX);
      const isAllowedOrigin = getAllowedWebSocketOrigin(c.req.url, c.req.header('host'));
      const credential = getProgrammaticWebSocketCredential(
        c.req.header('cookie'),
        c.req.header('origin'),
        c.req.header('authorization'),
        isAllowedOrigin
      );
      return createDockerLogStreamWSHandlers(nodeId, containerId, tail, credential);
    })
  );

  app.get(
    '/api/databases/:databaseId/logs/stream',
    upgradeWebSocket((c) => {
      const databaseId = c.req.param('databaseId') ?? '';
      const requestedTail = Number(c.req.query('tail')) || 100;
      const tail = Math.min(Math.max(Math.trunc(requestedTail), 1), DOCKER_LOG_TAIL_MAX);
      const isAllowedOrigin = getAllowedWebSocketOrigin(c.req.url, c.req.header('host'));
      const credential = getProgrammaticWebSocketCredential(
        c.req.header('cookie'),
        c.req.header('origin'),
        c.req.header('authorization'),
        isAllowedOrigin
      );
      return createManagedDatabaseLogStreamWSHandlers(databaseId, tail, credential);
    })
  );

  // Proxy host log stream WebSocket endpoint
  app.get(
    '/api/monitoring/logs/:hostId/ws',
    upgradeWebSocket((c) => {
      const hostId = c.req.param('hostId') ?? '';
      const requestedTail = Number(c.req.query('tail')) || 100;
      const tail = Math.min(Math.max(Math.trunc(requestedTail), 1), DOCKER_LOG_TAIL_MAX);
      const isAllowedOrigin = getAllowedWebSocketOrigin(c.req.url, c.req.header('host'));
      const credential = getProgrammaticWebSocketCredential(
        c.req.header('cookie'),
        c.req.header('origin'),
        c.req.header('authorization'),
        isAllowedOrigin
      );
      return createProxyLogStreamWSHandlers(hostId, tail, credential);
    })
  );

  // Node-wide nginx log stream WebSocket endpoint
  app.get(
    '/api/nodes/:nodeId/nginx-logs/ws',
    upgradeWebSocket((c) => {
      const nodeId = c.req.param('nodeId') ?? '';
      const requestedTail = Number(c.req.query('tail')) || 100;
      const tail = Math.min(Math.max(Math.trunc(requestedTail), 1), DOCKER_LOG_TAIL_MAX);
      const isAllowedOrigin = getAllowedWebSocketOrigin(c.req.url, c.req.header('host'));
      const credential = getProgrammaticWebSocketCredential(
        c.req.header('cookie'),
        c.req.header('origin'),
        c.req.header('authorization'),
        isAllowedOrigin
      );
      return createNodeNginxLogStreamWSHandlers(nodeId, tail, credential);
    })
  );

  // Realtime events WebSocket — single channel for all push notifications
  const eventsHandlers = createEventsWSHandlers();
  app.get(
    '/api/events',
    upgradeWebSocket((c) => {
      const sessionId = getWebSocketSessionId(
        c.req.header('cookie'),
        c.req.header('origin'),
        c.req.url,
        c.req.header('host')
      );
      return {
        onOpen(event, ws) {
          eventsHandlers.onOpen(event, ws);
          authenticateEventsConnection(ws, sessionId).catch(() => {
            try {
              ws.close();
            } catch {
              /* ignore */
            }
          });
        },
        onMessage: eventsHandlers.onMessage,
        onClose: eventsHandlers.onClose,
        onError: eventsHandlers.onError,
      };
    })
  );

  // Docker compose logs WebSocket endpoint
  app.get(
    '/api/docker/nodes/:nodeId/compose/:project/logs/stream',
    upgradeWebSocket((c) => {
      const nodeId = c.req.param('nodeId') ?? '';
      const project = decodeURIComponent(c.req.param('project') ?? '');
      const isAllowedOrigin = getAllowedWebSocketOrigin(c.req.url, c.req.header('host'));
      const credential = getProgrammaticWebSocketCredential(
        c.req.header('cookie'),
        c.req.header('origin'),
        c.req.header('authorization'),
        isAllowedOrigin
      );
      return createComposeLogsWSHandlers(nodeId, project, credential);
    })
  );

  // OpenAPI documentation
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', securitySchemes.bearerAuth as any);
  app.openAPIRegistry.registerComponent(
    'securitySchemes',
    'inferenceTokenAuth',
    securitySchemes.inferenceTokenAuth as any
  );
  const openApiDocument = {
    openapi: '3.1.0',
    info: {
      title: 'Opfield API',
      version: '1.0.0',
      description:
        'Opfield is an infrastructure control plane for managing nodes, reverse proxies, Docker workloads, certificates, databases, logging, monitoring, status pages, notifications, and operational automation.\n\n## Authentication\n\nBrowser sessions authenticate through the HttpOnly `session_id` cookie set by OIDC login. Cookie-authenticated mutating requests must include `X-CSRF-Token` from `/auth/csrf`.\n\nAPI tokens use `Authorization: Bearer gw_...` for programmatic REST access. OAuth public clients use Authorization Code + PKCE and Opfield-issued `gwo_...` access tokens for the same programmatic API surface.\n\n## Remote MCP\n\n`POST /api/mcp` exposes Opfield through stateless Streamable HTTP MCP. It accepts only OAuth `gwo_...` access tokens issued for the Opfield MCP resource. Browser cookies, `gw_...` API tokens, and `gwl_...` logging ingest tokens are not accepted.\n\n## Public PKI Endpoints\n\nCRL and OCSP endpoints under `/pki/` are unauthenticated and publicly accessible.\n\n' +
        IDEMPOTENCY_API_DESCRIPTION,
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Development server',
      },
    ],
    tags: openApiTags,
  };
  // Same as app.doc31, plus the shared Idempotency-Key header on operations that honor it.
  const serveOpenApiDocument = (c: Context<AppEnv>) => {
    try {
      return c.json(withIdempotencyKeyDocumentation(app.getOpenAPI31Document(openApiDocument)));
    } catch (error) {
      return c.json(error as object, 500);
    }
  };
  app.use(OPENAPI_DOCUMENT_PATH, authMiddleware, requireActiveUser, requireAnyEffectiveScope);
  app.get(OPENAPI_DOCUMENT_PATH, serveOpenApiDocument);
  app.use('/openapi.json', authMiddleware, requireActiveUser, requireAnyEffectiveScope);
  app.get('/openapi.json', serveOpenApiDocument);

  // Scalar API Reference UI
  app.use('/docs', authMiddleware, requireActiveUser, requireAnyEffectiveScope);
  app.use('/docs/*', authMiddleware, requireActiveUser, requireAnyEffectiveScope);
  app.get(
    '/docs',
    apiReference({
      spec: { url: OPENAPI_DOCUMENT_PATH },
      cdn: SCALAR_API_REFERENCE_CDN,
      theme: 'default',
      layout: 'modern',
    })
  );

  // Every API and auth route is registered above: an unknown path there is a JSON 404, never the SPA below.
  const unknownApiPath = (c: Context<AppEnv>) =>
    c.json<ApiError>({ code: 'NOT_FOUND', message: `No API endpoint at ${c.req.method} ${c.req.path}` }, 404);
  app.all('/api/*', unknownApiPath);
  app.all('/auth/*', unknownApiPath);

  // In production, serve the frontend SPA
  const statusPublicDir = resolve(process.cwd(), 'status-public');
  if (existsSync(statusPublicDir)) {
    const statusStaticFiles = serveStatic({ root: './status-public' });
    const statusIndexFile = serveStatic({ path: './status-public/index.html' });

    app.use(
      `${STATUS_PREVIEW_PREFIX}/*`,
      serveStatic({
        root: './status-public',
        rewriteRequestPath: (path) => path.replace(STATUS_PREVIEW_PREFIX, '') || '/',
      })
    );
    app.get(STATUS_PREVIEW_PREFIX, serveStatic({ path: './status-public/index.html' }));
    app.get(`${STATUS_PREVIEW_PREFIX}/*`, serveStatic({ path: './status-public/index.html' }));

    app.use('/*', async (c, next) => {
      if (!(await isStatusHostRequest(c.req.header('host')))) {
        await next();
        return;
      }

      const path = new URL(c.req.url).pathname;
      if (path.startsWith('/assets/') || /\.[a-zA-Z0-9]+$/.test(path)) {
        let missed = false;
        const response = await statusStaticFiles(c, async () => {
          missed = true;
        });
        return missed ? c.notFound() : response;
      }
      let missed = false;
      const response = await statusIndexFile(c, async () => {
        missed = true;
      });
      return missed ? c.notFound() : response;
    });
  }

  const publicDir = resolve(process.cwd(), 'public');
  if (existsSync(publicDir)) {
    const loginHtmlPath = resolve(publicDir, 'login.html');
    if (existsSync(loginHtmlPath)) {
      const loginHtmlTemplate = readFileSync(loginHtmlPath, 'utf8');
      const serveLoginPage: MiddlewareHandler<AppEnv> = async (c, next) => {
        if (!(await isSetupComplete())) {
          await next();
          return;
        }

        let methods = null;
        try {
          methods = await getPublicAuthMethods();
        } catch {
          // The standalone client retains its existing retry state when auth
          // configuration is temporarily unavailable.
        }

        c.header('Cache-Control', 'no-store');
        return c.html(injectLoginAuthMethods(loginHtmlTemplate, methods));
      };

      app.get('/login', serveLoginPage);
      app.get('/reset-password', serveLoginPage);
      app.get('/callback', serveLoginPage);
    }

    // Serve static assets (JS, CSS, images, etc.)
    app.use(
      '/*',
      serveStatic({
        root: './public',
        onFound: (_path, c) => {
          const requestPath = new URL(c.req.url).pathname;
          if (requestPath === '/' || requestPath.endsWith('.html')) {
            c.header('Cache-Control', 'no-store');
          } else if (requestPath.startsWith('/assets/')) {
            c.header('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );

    // SPA fallback — serve index.html for any non-API route
    app.get(
      '/*',
      serveStatic({
        path: './public/index.html',
        onFound: (_path, c) => c.header('Cache-Control', 'no-store'),
      })
    );
  }

  return { app, injectWebSocket, wss };
}

import { acceptedOperations } from '@/edition/accepted-operations.js';
