import { lookup } from 'node:dns/promises';
import { and, eq } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { proxyHosts } from '@/db/schema/index.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { normalizeIp } from '@/lib/ip-cidr.js';
import { formatHostPort } from '@/lib/network-endpoint.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import {
  checkOutboundWebhookTarget,
  type OutboundWebhookPolicy,
  type OutboundWebhookTargetCheck,
} from '@/modules/settings/outbound-webhook-policy.service.js';
import {
  fetchWithPinnedAddresses,
  type OutboundWebhookFetchOptions,
  type OutboundWebhookFetchResponse,
} from '@/modules/settings/outbound-webhook-request.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { effectiveMaintenance, NOT_IN_EFFECTIVE_MAINTENANCE } from './effective-maintenance.js';
import type { HealthCheckBodyMatchMode } from './proxy.service-helpers.js';
import { matchesExpectedBody } from './proxy.service-helpers.js';
import { loadAvailabilityRouteProbeLinks, probeSecureLinkRoute } from './proxy-secure-link-health-probe.js';

export const PROXY_HEALTH_CHECK_TIMEOUT_MS = 10_000;
// Same ceiling as the daemon-side Secure Link and Pages probes.
const PROXY_HEALTH_MAX_BODY_BYTES = 1024 * 1024;
const PROXY_HEALTH_MAX_REDIRECTS = 5;
const INTERNAL_SERVICE_CACHE_MS = 60_000;

interface ProxyHealthLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
}

interface HealthEntry {
  ts: string;
  status: string;
  responseMs?: number;
}

export function resolveProxyHealthCheckUrl(host: {
  upstreamKind?: string | null;
  domainNames?: string[] | null;
  sslEnabled?: boolean | null;
  healthCheckUrl?: string | null;
  forwardScheme?: string | null;
  forwardHost?: string | null;
  forwardPort?: number | null;
}): string | null {
  const path = host.healthCheckUrl || '/';
  if (host.upstreamKind === 'pages') return null;
  if (!host.forwardHost || !host.forwardPort) return null;
  return `${host.forwardScheme || 'http'}://${formatHostPort(host.forwardHost, host.forwardPort)}${path}`;
}

export function resolvePagesRouteProbeDomain(host: { domainNames?: string[] | null }): string | null {
  return host.domainNames?.find((candidate) => candidate && !candidate.startsWith('*.')) ?? null;
}

interface ProxyHealthExpectation {
  healthCheckExpectedStatus?: number | null;
  healthCheckExpectedBody?: string | null;
  healthCheckBodyMatchMode?: string | null;
}

/**
 * The single pass/fail rule for every proxy health probe. It matches the daemon-side
 * Secure Link and Pages probes: the configured status (or any 2xx), then the body match.
 */
export function evaluateProxyHealthResponse(
  host: ProxyHealthExpectation,
  httpStatus: number,
  body: string | null
): boolean {
  const expectedStatus = host.healthCheckExpectedStatus;
  const statusPassed = expectedStatus ? httpStatus === expectedStatus : httpStatus >= 200 && httpStatus < 300;
  if (!statusPassed || !host.healthCheckExpectedBody) return statusPassed;
  const mode = (host.healthCheckBodyMatchMode as HealthCheckBodyMatchMode | null) ?? 'includes';
  return body !== null && matchesExpectedBody(body, host.healthCheckExpectedBody, mode);
}

/** Map a daemon probe (Secure Link / Pages) onto the same outcome space as direct probes. */
export function daemonProbeOutcome(probe: { ok: boolean }): 'online' | 'offline' {
  return probe.ok ? 'online' : 'offline';
}

export type ProxyHealthTargetChecker = (url: string) => Promise<OutboundWebhookTargetCheck>;
export type ProxyHealthRequester = (
  url: string,
  addresses: string[],
  options: OutboundWebhookFetchOptions
) => Promise<OutboundWebhookFetchResponse>;

export interface DirectProxyProbeDeps {
  checkTarget?: ProxyHealthTargetChecker;
  request?: ProxyHealthRequester;
}

export type DirectProxyProbeResult =
  | { status: 'online' | 'offline'; responseMs?: number; httpStatus?: number; error?: string }
  | { status: 'blocked'; reason: string };

let internalServiceCache: { expiresAt: number; names: Set<string>; addresses: Set<string> } | null = null;

function urlHostname(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return stripBrackets(new URL(raw.includes('://') ? raw : `tcp://${raw}`).hostname.toLowerCase()) || null;
  } catch {
    return null;
  }
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Hostnames of the Gateway's own compose services (database, cache, relay, registry, local ClickHouse). */
function gatewayInternalServiceNames(env: Partial<Env>): Set<string> {
  const names = [
    urlHostname(env.DATABASE_URL),
    urlHostname(env.REDIS_URL),
    urlHostname(env.GATEWAY_RELAY_TARGET),
    env.GATEWAY_RELAY_SERVICE_NAME?.toLowerCase(),
    urlHostname(process.env.GATEWAY_INTERNAL_REGISTRY_URL || 'http://registry:5000'),
    'gateway-clickhouse',
  ];
  // Compose service names are single-label; a dotted or literal-IP host may be a shared server
  // that also runs legitimate upstreams, so it is left to the outbound policy.
  return new Set(
    names.filter((name): name is string => !!name && !name.includes('.') && !normalizeIp(name) && name !== 'localhost')
  );
}

function urlPort(raw: string | undefined, fallback: number): number | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `tcp://${raw}`);
    return Number(url.port) || fallback;
  } catch {
    return null;
  }
}

/** Ports the Gateway's own services listen on (API, gRPC, database, cache, relay, registry). */
export function gatewayServicePorts(env: Partial<Env>): Set<number> {
  const registryUrl = process.env.GATEWAY_INTERNAL_REGISTRY_URL || 'http://registry:5000';
  const ports = [
    env.PORT ?? 3000,
    env.GRPC_PORT ?? 9443,
    urlPort(env.DATABASE_URL, 5432),
    urlPort(env.REDIS_URL, 6379),
    urlPort(env.GATEWAY_RELAY_TARGET, 9443),
    urlPort(registryUrl, registryUrl.startsWith('https:') ? 443 : 80),
  ];
  return new Set(ports.filter((port): port is number => Number.isInteger(port) && (port as number) > 0));
}

async function gatewayInternalServices(env: Partial<Env>): Promise<{ names: Set<string>; addresses: Set<string> }> {
  const now = Date.now();
  if (internalServiceCache && internalServiceCache.expiresAt > now) return internalServiceCache;
  const names = gatewayInternalServiceNames(env);
  const addresses = new Set<string>();
  await Promise.all(
    [...names].map(async (name) => {
      try {
        for (const record of await lookup(name, { all: true, verbatim: true })) {
          const ip = normalizeIp(record.address);
          if (ip) addresses.add(ip);
        }
      } catch {
        /* not resolvable from here: nothing to protect under this name */
      }
    })
  );
  internalServiceCache = { expiresAt: now + INTERNAL_SERVICE_CACHE_MS, names, addresses };
  return internalServiceCache;
}

/**
 * Proxy upstreams are internal services by nature (LAN hosts on 192.168/16, CGNAT/Tailscale on
 * 100.64/10, ULA), so health checks allow every private range instead of following the narrower
 * outbound webhook allowlist. Loopback, link-local/metadata, multicast and unspecified are still
 * always refused by checkOutboundWebhookTarget; the Gateway's own addresses are refused on its
 * service ports (see checkProxyHealthTarget).
 */
export const PROXY_HEALTH_CHECK_POLICY: OutboundWebhookPolicy = Object.freeze({
  allowPrivateNetworks: true,
  allowedPrivateCidrs: Object.freeze([
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '100.64.0.0/10',
    '198.18.0.0/15',
    'fc00::/7',
  ]) as string[],
});

/**
 * Health checks run inside the Gateway container against user-supplied upstreams, so they get
 * the health-check outbound policy (loopback and link-local/metadata are always refused; every
 * private range is allowed) plus the Gateway's own compose services, which a proxy upstream never
 * legitimately points at. The Gateway's own addresses (including the LAN address its public URL
 * resolves to on one-box installs) are refused only on the Gateway's service ports, so an
 * upstream on the same host stays checkable.
 */
export async function checkProxyHealthTarget(
  url: string,
  env: Env,
  publicUrl?: string | null
): Promise<OutboundWebhookTargetCheck> {
  const result = await checkOutboundWebhookTarget(url, PROXY_HEALTH_CHECK_POLICY, env, publicUrl, {
    selfAddressBlockedPorts: gatewayServicePorts(env),
  });
  if (!result.allowed) return result;
  const hostname = urlHostname(url);
  const internal = await gatewayInternalServices(env);
  if (hostname && internal.names.has(hostname)) {
    return { ...result, allowed: false, reason: `Health check target ${hostname} is a Gateway internal service` };
  }
  const internalAddress = result.resolvedAddresses.find((ip) => internal.addresses.has(ip));
  if (internalAddress) {
    return {
      ...result,
      allowed: false,
      reason: `Health check target address ${internalAddress} belongs to a Gateway internal service`,
    };
  }
  return result;
}

async function checkProxyHealthTargetFromContainer(url: string): Promise<OutboundWebhookTargetCheck> {
  const env = container.resolve<Env>(TOKENS.Env);
  const publicUrl = container.isRegistered(GeneralSettingsService)
    ? container.resolve(GeneralSettingsService).getCachedPublicUrl()
    : null;
  return checkProxyHealthTarget(url, env, publicUrl);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Probe a direct upstream from the Gateway process through the health-check network policy, pinned
 * to the validated addresses. Redirects are followed up to PROXY_HEALTH_MAX_REDIRECTS hops: a
 * same-origin hop stays on the addresses already validated, and a hop to another origin (for
 * example a force-HTTPS redirect) is validated through the same policy and pinned to its own
 * addresses. A redirect to a refused target is not followed; the 3xx then counts as a live
 * upstream unless a specific status is expected.
 */
export async function probeDirectProxyUpstream(
  host: Parameters<typeof resolveProxyHealthCheckUrl>[0] & ProxyHealthExpectation,
  deps: DirectProxyProbeDeps = {}
): Promise<DirectProxyProbeResult> {
  const url = resolveProxyHealthCheckUrl(host);
  if (!url) return { status: 'offline', error: 'Proxy upstream endpoint is unavailable' };
  const checkTarget = deps.checkTarget ?? checkProxyHealthTargetFromContainer;
  let target: OutboundWebhookTargetCheck;
  try {
    target = await checkTarget(url);
  } catch (error) {
    return { status: 'blocked', reason: error instanceof Error ? error.message : String(error) };
  }
  if (target.resolvedAddresses.length === 0) {
    // Unresolvable or malformed upstream: the upstream is down from here, exactly as before the policy.
    return { status: 'offline', error: target.reason ?? 'Upstream did not resolve' };
  }
  if (!target.allowed) return { status: 'blocked', reason: target.reason ?? 'target is not allowed' };

  const request = deps.request ?? fetchWithPinnedAddresses;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_HEALTH_CHECK_TIMEOUT_MS);
  const startedAt = performance.now();
  const send = (targetUrl: string, addresses: string[]) =>
    request(targetUrl, addresses, {
      method: 'GET',
      headers: {},
      signal: controller.signal,
      maxResponseBytes: PROXY_HEALTH_MAX_BODY_BYTES,
    });
  try {
    let currentUrl = url;
    let addresses = target.resolvedAddresses;
    let redirectRefused = false;
    let response = await send(currentUrl, addresses);
    for (let hop = 0; hop < PROXY_HEALTH_MAX_REDIRECTS && response.status >= 300 && response.status < 400; hop++) {
      const location = headerValue(response.headers?.location);
      if (!location) break;
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        break;
      }
      if (next.origin !== new URL(currentUrl).origin) {
        let nextTarget: OutboundWebhookTargetCheck | null = null;
        if (next.protocol === 'http:' || next.protocol === 'https:') {
          try {
            nextTarget = await checkTarget(next.toString());
          } catch {
            nextTarget = null;
          }
        }
        if (nextTarget && nextTarget.resolvedAddresses.length === 0) {
          return {
            status: 'offline',
            error: nextTarget.reason ?? `Redirect target ${next.host} did not resolve`,
            responseMs: Math.round(performance.now() - startedAt),
            httpStatus: response.status,
          };
        }
        if (!nextTarget?.allowed) {
          redirectRefused = true;
          break;
        }
        addresses = nextTarget.resolvedAddresses;
      }
      currentUrl = next.toString();
      response = await send(currentUrl, addresses);
    }
    const scoredHost =
      redirectRefused && !host.healthCheckExpectedStatus
        ? { ...host, healthCheckExpectedStatus: response.status }
        : host;
    const body = host.healthCheckExpectedBody ? await response.text() : null;
    const responseMs = Math.round(performance.now() - startedAt);
    return {
      status: evaluateProxyHealthResponse(scoredHost, response.status, body) ? 'online' : 'offline',
      responseMs,
      httpStatus: response.status,
    };
  } catch (error) {
    return {
      status: 'offline',
      error: controller.signal.aborted
        ? `Request timed out after ${PROXY_HEALTH_CHECK_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function runImmediateProxyHealthCheck({
  db,
  hostId,
  logger,
  nodeDispatch,
  eventBus,
  probeDeps,
}: {
  db: DrizzleClient;
  hostId: string;
  logger: ProxyHealthLogger;
  nodeDispatch?: NodeDispatchService;
  eventBus?: EventBusService;
  probeDeps?: DirectProxyProbeDeps;
}): void {
  // Run after a short delay to allow nginx reload to complete.
  setTimeout(async () => {
    try {
      const host = await db.query.proxyHosts.findFirst({
        where: eq(proxyHosts.id, hostId),
      });
      if (!host?.enabled || !host.healthCheckEnabled || effectiveMaintenance(host)) return;
      // A route on an ingress group is probed through every member by the scheduled job (within its next tick,
      // a few seconds): one immediate sample from a single member would misstate it.
      if (host.ingressGroupId) return;

      const path = host.healthCheckUrl || '/';
      const url = resolveProxyHealthCheckUrl(host);
      const secureLinkProbe =
        (host.upstreamKind === 'docker_container' || host.upstreamKind === 'docker_deployment') &&
        host.secureLinkMigratedAt != null;
      const pagesRouteProbe = host.upstreamKind === 'pages';
      if (!secureLinkProbe && !pagesRouteProbe && !url) return;

      // Same outcome rules as the scheduled HealthCheckJob, so the first sample never disagrees with later ones.
      let status: 'online' | 'offline' | 'unknown' = 'offline';
      let responseMs: number | undefined;
      try {
        if (pagesRouteProbe) {
          const domain = resolvePagesRouteProbeDomain(host);
          if (!host.nodeId || !nodeDispatch || !domain) {
            status = 'unknown';
          } else {
            const probe = await nodeDispatch.probePagesRoute(host.nodeId, {
              routeId: host.id,
              domain,
              tls: host.sslEnabled ?? false,
              path,
              expectedStatus: host.healthCheckExpectedStatus,
              expectedBody: host.healthCheckExpectedBody,
              bodyMatchMode: host.healthCheckBodyMatchMode,
              timeoutSeconds: PROXY_HEALTH_CHECK_TIMEOUT_MS / 1000,
            });
            if (probe.error === 'daemon is busy handling long-running commands; retry shortly') return;
            responseMs = probe.responseMs;
            status = probe.skipped ? 'unknown' : daemonProbeOutcome(probe);
          }
        } else if (secureLinkProbe) {
          if (!host.nodeId || !nodeDispatch) throw new Error('Secure Link health probe is unavailable');
          const members = await loadAvailabilityRouteProbeLinks(db, [host.id]);
          const probe = await probeSecureLinkRoute(
            nodeDispatch,
            { ...host, nodeId: host.nodeId },
            members.get(host.id),
            PROXY_HEALTH_CHECK_TIMEOUT_MS / 1000
          );
          if (probe.busy) return;
          responseMs = probe.responseMs;
          status = daemonProbeOutcome(probe);
        } else {
          const probe = await probeDirectProxyUpstream(host, probeDeps);
          if (probe.status === 'blocked') {
            logger.debug('Immediate health check target blocked by outbound network policy', {
              hostId,
              reason: probe.reason,
            });
            status = 'unknown';
          } else {
            status = probe.status;
            responseMs = probe.responseMs;
          }
        }
      } catch {
        status = 'offline';
      }

      const now = Date.now();
      const entry: HealthEntry = { ts: new Date(now).toISOString(), status };
      if (responseMs != null) entry.responseMs = responseMs;
      const existingHistory = (host.healthHistory as HealthEntry[] | null) ?? [];
      const healthHistory = compactHealthHistory([...existingHistory, entry], { nowMs: now });

      const persisted = await db
        .update(proxyHosts)
        .set({ healthStatus: status, lastHealthCheckAt: new Date(now), healthHistory })
        .where(
          and(
            eq(proxyHosts.id, hostId),
            eq(proxyHosts.enabled, true),
            eq(proxyHosts.healthCheckEnabled, true),
            NOT_IN_EFFECTIVE_MAINTENANCE
          )
        )
        .returning({ id: proxyHosts.id });

      if (persisted.length === 0) return;

      logger.debug('Immediate health check complete', { hostId, status });
      eventBus?.publish('proxy.host.changed', {
        id: hostId,
        action: `health.${status}`,
        domain: host.domainNames?.[0],
        health_status: status,
      });
    } catch (err) {
      logger.debug('Immediate health check failed', { hostId, error: err });
    }
  }, 2000);
}
