/**
 * The names Opfield gives files, directories and nginx identifiers on an ingress node, and the pre-Opfield (Opfield)
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
  ['/etc/nginx/opfield/', '/etc/nginx/gateway/'],
  ['/run/opfield-secure-links/', '/run/gateway-secure-links/'],
  ['/run/opfield-registry-links/', '/run/gateway-registry-links/'],
  ['/run/opfield-ingress-health/', '/run/gateway-ingress-health/'],
  ['/_opfield/maintenance-access', '/_gateway/maintenance-access'],
  ['opfield_maintenance', 'gateway_maintenance'],
  ['opfield-maintenance', 'gateway-maintenance'],
  ['opfield_ingress_generation', 'gateway_ingress_generation'],
  ['X-Opfield-Maintenance-', 'X-Gateway-Maintenance-'],
  ['X-Opfield-Ingress-Generation', 'X-Gateway-Ingress-Generation'],
  ['opfield-managed-secure-link-upstream', 'gateway-managed-secure-link-upstream'],
  ['opfield_pages_', 'gateway_pages_'],
  ['# opfield-pages ', '# gateway-pages '],
  ['opfield_secure_link_', 'gateway_secure_link_'],
  ['opfield_additional_secure_link_', 'gateway_additional_secure_link_'],
  ['ingress-health.opfield.invalid', 'ingress-health.gateway.invalid'],
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

/** The config with the names of a node: Opfield ones when it reports the capability, else the pre-Opfield ones. */
export function nginxNamesForNode(config: string, opfieldNames: boolean): string {
  return opfieldNames ? toOpfieldNginxNames(config) : toLegacyNginxNames(config);
}
