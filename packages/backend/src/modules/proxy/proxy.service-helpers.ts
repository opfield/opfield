import { isIP } from 'node:net';
import { getEnv } from '@/config/env.js';
import { LEGACY_NGINX_RUN_PREFIX, LEGACY_NGINX_VARIABLE_PREFIX } from '@/lib/legacy-compat.js';
import { AppError } from '@/middleware/error-handler.js';
import type { PreparedTlsCertificate } from '@/services/nginx-certificate-distribution.service.js';

export type HealthCheckBodyMatchMode = 'includes' | 'exact' | 'starts_with' | 'ends_with';

export type ProxyValidationOptions = {
  bypassAdvancedValidation?: boolean;
  bypassRawValidation?: boolean;
  actorScopes?: string[];
  /** Internal-only placement migration controls. Never populated from an API request. */
  skipDomainNodeValidation?: boolean;
  preserveFormerNodeConfig?: boolean;
  allowSystemNodeMove?: boolean;
  /**
   * The write puts a host back where it was (an ingress migration's rollback): a name another enabled host took
   * meanwhile is recorded as a legacy conflict instead of refused, so the database follows what nginx serves.
   */
  restoringPriorState?: boolean;
};

export type ProxyValidationInput = boolean | ProxyValidationOptions;

export interface CertPaths {
  sslCertPath: string | null;
  sslKeyPath: string | null;
  sslChainPath: string | null;
  preparedTls?: PreparedTlsCertificate | null;
}

export interface SslPrerequisiteState {
  sslEnabled: boolean;
  sslCertificateId?: string | null;
  internalCertificateId?: string | null;
}

export interface SslPrerequisitePatch {
  sslEnabled?: boolean;
  sslCertificateId?: string | null;
  internalCertificateId?: string | null;
}

const STATUS_PAGE_SYSTEM_HOST_ROLLBACK_FIELDS = [
  'type',
  'domainNames',
  'enabled',
  'forwardHost',
  'forwardPort',
  'forwardScheme',
  'sslEnabled',
  'sslForced',
  'http2Support',
  'websocketSupport',
  'sslCertificateId',
  'internalCertificateId',
  'redirectUrl',
  'redirectStatusCode',
  'customHeaders',
  'cacheEnabled',
  'cacheOptions',
  'rateLimitEnabled',
  'rateLimitOptions',
  'customRewrites',
  'advancedConfig',
  'rawConfig',
  'rawConfigEnabled',
  'accessListId',
  'folderId',
  'nginxTemplateId',
  'templateVariables',
  'nodeId',
  'healthCheckEnabled',
  'healthCheckUrl',
  'healthCheckInterval',
  'healthCheckExpectedStatus',
  'healthCheckExpectedBody',
  'healthCheckBodyMatchMode',
  'healthCheckSlowThreshold',
  'healthStatus',
  'isSystem',
  'systemKind',
  'updatedAt',
] as const;

type StatusPageSystemHostRollbackField = (typeof STATUS_PAGE_SYSTEM_HOST_ROLLBACK_FIELDS)[number];

export function buildStatusPageSystemHostRollbackData(
  existing: Record<StatusPageSystemHostRollbackField, unknown>
): Record<StatusPageSystemHostRollbackField, unknown> {
  return Object.fromEntries(STATUS_PAGE_SYSTEM_HOST_ROLLBACK_FIELDS.map((field) => [field, existing[field]])) as Record<
    StatusPageSystemHostRollbackField,
    unknown
  >;
}

export function matchesExpectedBody(body: string, expectedBody: string, mode: HealthCheckBodyMatchMode): boolean {
  switch (mode) {
    case 'exact':
      return body === expectedBody;
    case 'starts_with':
      return body.startsWith(expectedBody);
    case 'ends_with':
      return body.endsWith(expectedBody);
    default:
      return body.includes(expectedBody);
  }
}

export function normalizeProxyValidationOptions(validationOptions: ProxyValidationInput = {}): ProxyValidationOptions {
  return typeof validationOptions === 'boolean'
    ? { bypassAdvancedValidation: validationOptions, bypassRawValidation: false }
    : validationOptions;
}

export function rawConfigAuditDetails(input: { rawConfig?: unknown }, options: ProxyValidationOptions) {
  if (input.rawConfig === undefined) return {};
  return {
    rawConfigChanged: true,
    rawValidationBypassed: options.bypassRawValidation === true,
  };
}

export function updateUsesRawMode(
  existing: { type: string; rawConfigEnabled: boolean },
  input: { type?: string; rawConfigEnabled?: boolean }
): boolean {
  return (input.type ?? existing.type) === 'raw' || (input.rawConfigEnabled ?? existing.rawConfigEnabled);
}

/**
 * Returns a persisted raw config only when this update newly opts into raw
 * mode without supplying replacement config. Existing raw-mode hosts must
 * remain editable, but a stored config must not gain a new raw-mode consumer
 * without the same validation applied to newly submitted raw config.
 */
export function storedRawConfigForRawModeEnablement(
  existing: { type: string; rawConfigEnabled: boolean; rawConfig?: unknown },
  input: { type?: string; rawConfigEnabled?: boolean; rawConfig?: unknown }
): unknown {
  const newlyEnablesRawMode =
    (input.rawConfigEnabled === true && !existing.rawConfigEnabled) ||
    (input.type === 'raw' && existing.type !== 'raw');
  if (input.rawConfig !== undefined || !newlyEnablesRawMode) {
    return undefined;
  }
  return existing.rawConfig;
}

/**
 * Whether a raw config proxies to the Route's own Secure Link: raw mode starts from the rendered config, whose
 * upstream block is named after the Route and points at the link's socket.
 */
export function rawConfigUsesSecureLink(hostId: string, rawConfig: string): boolean {
  // legacy-name: raw configs saved before 2.12.1 name the pre-Opfield socket and upstream — remove once every node reports none
  return [
    ['/run/opfield-', 'opfield_'],
    [LEGACY_NGINX_RUN_PREFIX, LEGACY_NGINX_VARIABLE_PREFIX],
  ].some(
    ([runPrefix, variablePrefix]) =>
      rawConfig.includes(`${runPrefix}secure-links/${hostId}.sock`) ||
      rawConfig.includes(`${variablePrefix}secure_link_${hostId.replace(/-/g, '_')}`)
  );
}

export function assertSslPrerequisites(input: SslPrerequisiteState) {
  if (input.sslEnabled && !input.sslCertificateId && !input.internalCertificateId) {
    throw new AppError(400, 'SSL_CERTIFICATE_REQUIRED', 'An SSL certificate must be selected before enabling HTTPS');
  }
}

export function assertSslPrerequisitesForUpdate(existing: SslPrerequisiteState, input: SslPrerequisitePatch) {
  const sslEnabled = input.sslEnabled ?? existing.sslEnabled;
  const sslCertificateId = input.sslCertificateId !== undefined ? input.sslCertificateId : existing.sslCertificateId;
  const internalCertificateId =
    input.internalCertificateId !== undefined ? input.internalCertificateId : existing.internalCertificateId;
  const touchesSslPrerequisites =
    input.sslEnabled === true ||
    (sslEnabled && (input.sslCertificateId !== undefined || input.internalCertificateId !== undefined));

  if (touchesSslPrerequisites) {
    assertSslPrerequisites({ sslEnabled, sslCertificateId, internalCertificateId });
  }
}

export function stripProxyHealthHistory<T extends { healthHistory?: unknown }>(host: T): Omit<T, 'healthHistory'> {
  const { healthHistory: _healthHistory, ...rest } = host;
  return rest;
}

export function getStatusPageUpstream(upstreamUrl: string | null | undefined): {
  host: string;
  port: number;
  scheme: 'http' | 'https';
} {
  const env = getEnv();
  if (!upstreamUrl) {
    return { host: '127.0.0.1', port: env.PORT, scheme: 'http' };
  }

  const url = new URL(upstreamUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(400, 'STATUS_PAGE_UPSTREAM_INVALID', 'Status page upstream must use http or https');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new AppError(
      400,
      'STATUS_PAGE_UPSTREAM_INVALID',
      'Status page upstream must not include path, query, or hash'
    );
  }
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  const port = url.port ? Number(url.port) : scheme === 'https' ? 443 : 80;
  return { host: url.hostname, port, scheme };
}

export type StatusPageDefaultUpstreamContext = {
  /** Addresses the status page ingress node reports for itself. */
  nodeAddresses: readonly string[];
  /** Interface addresses of the Opfield host (OPFIELD_LOCAL_HOSTS). */
  opfieldHostAddresses: readonly string[];
  /** Opfield host address local nodes enroll with, optionally with the gRPC port. */
  opfieldLocalTarget: string | null | undefined;
  /** Opfield host public nodes enroll with, optionally with the gRPC port. */
  opfieldPublicTarget: string | null | undefined;
  /** Opfield serves its web port with native HTTPS. */
  tlsEnabled: boolean;
  port: number;
};

function enrollmentTargetHost(target: string | null | undefined): string | null {
  const value = target?.trim();
  if (!value) return null;
  const bracketed = value.match(/^\[([^\]]+)](?::\d+)?$/);
  if (bracketed) return bracketed[1]!;
  if (isIP(value) === 6) return value;
  return value.replace(/:\d+$/, '') || null;
}

/**
 * The Opfield URL a status page ingress node proxies to when no upstream URL
 * is configured: loopback on the Opfield host itself; from any other node, the
 * Opfield host address nodes enroll with (local first, then public). The
 * scheme follows Opfield's own web listener.
 */
export function defaultStatusPageUpstreamUrl(context: StatusPageDefaultUpstreamContext): string {
  const normalize = (address: string) => address.trim().toLowerCase();
  const opfieldHost = new Set(context.opfieldHostAddresses.map(normalize).filter(Boolean));
  const onOpfieldHost = context.nodeAddresses.some((address) => opfieldHost.has(normalize(address)));
  const host = onOpfieldHost
    ? '127.0.0.1'
    : (enrollmentTargetHost(context.opfieldLocalTarget) ??
      enrollmentTargetHost(context.opfieldPublicTarget) ??
      '127.0.0.1');
  return `${context.tlsEnabled ? 'https' : 'http'}://${isIP(host) === 6 ? `[${host}]` : host}:${context.port}`;
}

export const __testOnly = {
  assertSslPrerequisitesForUpdate,
  buildStatusPageSystemHostRollbackData,
  defaultStatusPageUpstreamUrl,
  getStatusPageUpstream,
  matchesExpectedBody,
  normalizeProxyValidationOptions,
  rawConfigAuditDetails,
  storedRawConfigForRawModeEnablement,
  stripProxyHealthHistory,
  updateUsesRawMode,
};
