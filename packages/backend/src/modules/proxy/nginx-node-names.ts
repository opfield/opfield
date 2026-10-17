import { LEGACY_INGRESS_GENERATION_HEADER, LEGACY_INGRESS_HEALTH_HOST, LEGACY_MAINTENANCE_HEADER_PREFIX, LEGACY_NGINX_DIR, LEGACY_NGINX_MARK_PREFIX, LEGACY_NGINX_RUN_PREFIX, LEGACY_NGINX_VARIABLE_PREFIX, LEGACY_RESERVED_PATH_PREFIX } from '@/lib/legacy-compat.js';
/**
 * The names Opfield gives files, directories and nginx identifiers on an ingress node, and the pre-Opfield
 * names a node keeps until its nginx daemon moved it (internal/naming in the nginx daemon).
 *
 * Configs are rendered with the Opfield names. A node whose daemon does not report NGINX_OPFIELD_NAMES_CAPABILITY
 * (a 2.12.0 daemon, or a 2.12.1 daemon before the launcher committed its update) gets them with the pre-Opfield names
 * (toLegacyNginxNames); a node that reports it gets every pre-Opfield name a stored config may still carry (a raw
 * config, a custom template, a Pages include path the daemon reported earlier) replaced (toOpfieldNginxNames).
 */

/** The node runs with the Opfield names. Kept identical with naming.Capability in the nginx daemon. */
export const NGINX_OPFIELD_NAMES_CAPABILITY = 'nginx_opfield_names_v1';

/**
 * The names that differ between the schemes, Opfield name first. Only names that tie two places together (a path the
 * daemon serves, a variable a daemon file defines, a header the daemon reads, a marker it looks for) are listed. The
 * reserved health path and the Pages script path are absent on purpose: both names stay answered, and a config may
 * carry a location for each. Kept identical with `pairs` in the nginx daemon (internal/naming/naming.go).
 * legacy-name: pre-Opfield names of nodes and of configs stored before 2.12.1 — remove once every node reports none
 */
export const NGINX_NAME_PAIRS: ReadonlyArray<readonly [opfield: string, legacy: string]> = [
  ['/etc/nginx/opfield/', `${LEGACY_NGINX_DIR}/`],
  ['/run/opfield-secure-links/', `${LEGACY_NGINX_RUN_PREFIX}secure-links/`],
  ['/run/opfield-registry-links/', `${LEGACY_NGINX_RUN_PREFIX}registry-links/`],
  ['/run/opfield-ingress-health/', `${LEGACY_NGINX_RUN_PREFIX}ingress-health/`],
  ['/_opfield/maintenance-access', `${LEGACY_RESERVED_PATH_PREFIX}/maintenance-access`],
  ['opfield_maintenance', `${LEGACY_NGINX_VARIABLE_PREFIX}maintenance`],
  ['opfield-maintenance', `${LEGACY_NGINX_MARK_PREFIX}maintenance`],
  ['opfield_ingress_generation', `${LEGACY_NGINX_VARIABLE_PREFIX}ingress_generation`],
  ['X-Opfield-Maintenance-', LEGACY_MAINTENANCE_HEADER_PREFIX],
  ['X-Opfield-Ingress-Generation', LEGACY_INGRESS_GENERATION_HEADER],
  ['opfield-managed-secure-link-upstream', `${LEGACY_NGINX_MARK_PREFIX}managed-secure-link-upstream`],
  ['opfield_pages_', `${LEGACY_NGINX_VARIABLE_PREFIX}pages_`],
  ['# opfield-pages ', `# ${LEGACY_NGINX_MARK_PREFIX}pages `],
  ['opfield_secure_link_', `${LEGACY_NGINX_VARIABLE_PREFIX}secure_link_`],
  ['opfield_additional_secure_link_', `${LEGACY_NGINX_VARIABLE_PREFIX}additional_secure_link_`],
  ['ingress-health.opfield.invalid', LEGACY_INGRESS_HEALTH_HOST],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One-pass replacement of every name in `from` by its counterpart (earlier pairs win at the same position). */
function replacer(from: 0 | 1): (content: string) => string {
  const to = from === 0 ? 1 : 0;
  const map = new Map(NGINX_NAME_PAIRS.map((pair) => [pair[from], pair[to]] as const));
  const pattern = new RegExp(NGINX_NAME_PAIRS.map((pair) => escapeRegExp(pair[from])).join('|'), 'g');
  return (content) => content.replace(pattern, (match) => map.get(match) ?? match);
}

/** Replaces the Opfield names in a rendered config by the pre-Opfield ones, for a node that still runs with them. */
export const toLegacyNginxNames = replacer(0);

/** Replaces the pre-Opfield names in a config by the Opfield ones. */
export const toOpfieldNginxNames = replacer(1);

/**
 * The access log format the route templates log with. A node still on the pre-Opfield names defines the legacy
 * format; a node on the Opfield names defines `opfield_combined` (and keeps the legacy one while a config on it uses
 * it), so the format is not one of the name pairs the daemon renames in nginx.conf.
 */
const ACCESS_LOG_FORMAT_PATTERN = / opfield_combined;/g;

/**
 * Route configs log with the access log format only on a node whose daemon defines it before the includes that
 * bring them in (an Alpine node defined it after them and refused every route). Kept identical with
 * AccessLogFormatCapability in the nginx daemon.
 */
export const NGINX_ACCESS_LOG_FORMAT_CAPABILITY = 'nginx_access_log_format_v1';

/**
 * The config with the names of a node: Opfield ones when it reports the capability, else the pre-Opfield ones. Without
 * `accessLogFormat` the route's access log uses nginx's default format.
 */
export function nginxNamesForNode(config: string, opfieldNames: boolean, accessLogFormat = true): string {
  if (!accessLogFormat) return nginxNamesForNode(config.replace(ACCESS_LOG_FORMAT_PATTERN, ';'), opfieldNames);
  return opfieldNames
    ? toOpfieldNginxNames(config)
    : toLegacyNginxNames(config).replace(ACCESS_LOG_FORMAT_PATTERN, ` ${LEGACY_NGINX_VARIABLE_PREFIX}combined;`);
}
