import type { NodeIngressHealth } from '@/db/schema/nodes.js';

/**
 * The ingress health an nginx daemon reports (HealthReport.ingress_health, sf-ingress). It is what the daemon's
 * reserved health endpoint `/.well-known/opfield-ingress-health` (and the pre-Opfield
 * `/.well-known/gateway-ingress-health`) answers at that moment: serving only while nginx runs the config generation
 * the daemon applied last and, for a node with Secure Link sources, at least one relay transport is usable. DNS
 * failover (Cloudflare monitors, the DNS steward) probes the endpoint itself; Opfield shows the reported copy per
 * ingress group member.
 */
export type IngressHealthReport = NodeIngressHealth;

/** The reserved path every Opfield-rendered server block and every node's default servers answer. */
export const INGRESS_HEALTH_PATH = '/.well-known/opfield-ingress-health';
/**
 * The pre-Opfield reserved path, answered the same way: load balancers and monitors of customers set up before 2.12.1
 * probe it.
 * legacy-name: health path external monitors were set up with — remove once no customer monitor probes it
 */
export const LEGACY_INGRESS_HEALTH_PATH = '/.well-known/gateway-ingress-health';
/** Unix socket of the nginx daemon's health responder that the reserved locations proxy to. */
export const INGRESS_HEALTH_SOCKET = '/run/opfield-ingress-health/health.sock';
/** Host name the daemon-managed health server answers on :80 and :443 (with a self-signed certificate). */
export const INGRESS_HEALTH_HOSTNAME = 'ingress-health.opfield.invalid';

function toNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

/** Maps the proto message (proto-loader keeps camelCase, int64 as strings) to the stored health report field. */
export function ingressHealthFromProto(raw: unknown): { ingressHealth?: IngressHealthReport } {
  if (!raw || typeof raw !== 'object') return {};
  const value = raw as Record<string, unknown>;
  const checkedAtMs = toNumber(value.checkedAtUnixMs);
  return {
    ingressHealth: {
      serving: value.serving === true,
      reason: typeof value.reason === 'string' ? value.reason.slice(0, 500) : '',
      configGeneration: toNumber(value.configGeneration),
      nginxRunning: value.nginxRunning === true,
      configApplied: value.configApplied === true,
      secureLinkSources: toNumber(value.secureLinkSources),
      usableRelayTransports: toNumber(value.usableRelayTransports),
      checkedAt: checkedAtMs > 0 ? new Date(checkedAtMs).toISOString() : null,
    },
  };
}

/** The stored copy from a node's last health report, if its daemon reports one. */
export function ingressHealthOf(lastHealthReport: unknown): IngressHealthReport | null {
  const report = (lastHealthReport as { ingressHealth?: IngressHealthReport } | null | undefined)?.ingressHealth;
  return report && typeof report === 'object' ? report : null;
}

/** Header nginx adds with the config generation of the configuration that handled the probe. */
export const INGRESS_GENERATION_HEADER = 'X-Opfield-Ingress-Generation';

function ingressHealthLocation(path: string): string {
  return `    location = ${path} {
        access_log off;
        allow all;
        auth_basic off;
        default_type application/json;
        add_header Cache-Control "no-store" always;
        proxy_pass http://unix:${INGRESS_HEALTH_SOCKET}:/health;
        proxy_set_header Host $host;
        proxy_set_header ${INGRESS_GENERATION_HEADER} $opfield_ingress_generation;
        proxy_connect_timeout 2s;
        proxy_send_timeout 3s;
        proxy_read_timeout 3s;
    }
`;
}

/**
 * The reserved locations (the Opfield path, then the pre-Opfield one) every Opfield-rendered server block gets on a
 * node that advertises ingress_group_v1. Kept byte-identical with nginx.IngressHealthLocation() in the nginx daemon
 * (the daemon renders them into its own servers). An exact-match location wins over every other location of the
 * block; access lists and basic auth do not apply.
 */
export const INGRESS_HEALTH_LOCATION = `${ingressHealthLocation(INGRESS_HEALTH_PATH)}${ingressHealthLocation(LEGACY_INGRESS_HEALTH_PATH)}`;

/**
 * Adds the reserved health locations to every server block of a rendered config: the ones it does not have yet (a
 * config written before 2.12.1 may carry the pre-Opfield one, and a second location for a path fails nginx -t).
 */
export function withIngressHealthLocation(rendered: string): string {
  const missing = [INGRESS_HEALTH_PATH, LEGACY_INGRESS_HEALTH_PATH].filter(
    (path) => !rendered.includes(`location = ${path} {`)
  );
  if (missing.length === 0) return rendered;
  const locations = missing.map(ingressHealthLocation).join('');
  return rendered.replace(/^[\t ]*server[\t ]*\{/gm, (match) => `${match}\n${locations}`);
}
