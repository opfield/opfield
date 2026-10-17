import { type NginxConfigDirective, parseNginxConfig, walkNginxConfig } from './nginx-config-tree.js';

/**
 * Maintenance without an nginx reload, for nodes whose daemon reports proxy_maintenance_flag_v1.
 *
 * Every managed route on such a node carries the guard below whether or not it is in maintenance. Per request it
 * checks whether the daemon keeps the route's flag file; the daemon creates and removes that file when Opfield sends
 * the route's maintenance state. So entering and leaving maintenance changes no config and reloads nothing, and the
 * idle keep-alive connections of every other route on the node stay open (a reload closes them).
 *
 * The http-level maps the guard uses are the same for every route and live in a file the daemon keeps
 * (maintenance_guard.go in the nginx daemon): one set of variables per node, however many routes it serves.
 *
 * While the flag is absent a request is handled exactly as without the guard:
 * - the guard's own locations have names that are not URIs (no leading "/"), so no request reaches them except
 *   through the guard's rewrite, which happens only while the flag exists; no path of the route is reserved;
 * - default_type and add_header of the maintenance page live in those locations only;
 * - secure_link is configured on the server but evaluated only while the flag exists; a config that uses
 *   secure_link itself keeps the reload-based guard (its own $secure_link would see Opfield's settings), whose page
 *   then has no team access (nginx-template.service.ts, maintenanceAccessFits);
 * - the Cookie each proxying scope sends is "$http_cookie", or the value of the route's own Cookie override, until
 *   the flag exists; then Opfield's access cookies are removed from it. A scope gets the directive only where it
 *   already sets proxy_set_header itself, so nginx's inheritance of proxy_set_header is unchanged. A proxying location
 *   that inherits the headers from outside the route's config (nginx.conf) keeps the reload-based guard.
 *
 * Returns null when the rendered config cannot carry the guard without changing what it does; the caller then uses
 * the guard that is rendered only during maintenance.
 */

export const MAINTENANCE_FLAG_CAPABILITY = 'proxy_maintenance_flag_v1';
/** Kept byte-identical with maintenanceFlagDir in the nginx daemon (maintenance_flags.go). */
export const MAINTENANCE_FLAG_DIR = '/etc/nginx/opfield/maintenance';

const PAGES_ROUTE_INCLUDE = /\/pages\/routes\/[A-Za-z0-9-]+\.inc$/;
const SECURE_LINK_DIRECTIVES = new Set(['secure_link', 'secure_link_md5', 'secure_link_secret']);
/**
 * The names of the guard's own locations, as `location = <name>` or `location =<name>`.
 * legacy-name: gateway-maintenance locations of configs rendered before 2.12.1 — remove once every node reports none
 */
const GUARD_LOCATION = /^[=@]?(?:opfield|gateway)-maintenance(?:-access|-status|-page|-state)?$/;

/**
 * Why the guard's locations answer through try_files and error_page instead of `return`: `return` runs in nginx's
 * rewrite phase, before the access phase, so the allow/deny rules of the route's access list in the same location
 * would never apply and a client the list denies would get the page (X-O-5). try_files runs after the access phase;
 * the file it names never exists, so it ends in the given code, and the location's error_page hands the request to a
 * named location that answers. A client the list denies gets 403 first. Named locations cannot be reached by a
 * request URI either.
 */
export const MAINTENANCE_ABSENT_FILE = '/.opfield-maintenance-absent';
/** The code that hands an allowed request of the state location to its answer (never sent to a client). */
export const MAINTENANCE_STATE_HOP = 418;

export interface MaintenanceFlagGuardInput {
  hostId: string;
  /** Secret of the maintenance access cookie (secure_link_md5). */
  secret: string;
  /** The maintenance page as an nginx return text. */
  pageText: string;
  /**
   * The allow/deny rules of the route's access list (maintenanceAccessListDirectives). The guard's locations carry
   * them and answer after nginx's access phase (MAINTENANCE_ABSENT_FILE), so a client the access list denies gets 403
   * during maintenance as well, never the page or its state.
   */
  accessDirectives?: readonly string[];
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

function isCookieHeader(directive: NginxConfigDirective): boolean {
  return directive.name === 'proxy_set_header' && directive.args[0]?.value.toLowerCase() === 'cookie';
}

function headerDirectives(scope: NginxConfigDirective): NginxConfigDirective[] {
  return scope.block!.children.filter((directive) => directive.name === 'proxy_set_header');
}

/** Whether a location proxies itself (directly, or in its `if` and `limit_except` blocks). */
function proxies(directives: NginxConfigDirective[]): boolean {
  return directives.some(
    (directive) =>
      directive.name === 'proxy_pass' ||
      (directive.block !== undefined && directive.name !== 'location' && proxies(directive.block.children))
  );
}

/** Whether the config uses something the guard would change the meaning of, or declares what the guard declares. */
function usesReservedFeatures(directives: NginxConfigDirective[]): boolean {
  let reserved = false;
  walkNginxConfig(directives, (directive) => {
    if (
      SECURE_LINK_DIRECTIVES.has(directive.name) ||
      directive.name === 'proxy_pass_request_headers' ||
      (directive.name === 'include' && !PAGES_ROUTE_INCLUDE.test(directive.args[0]?.value ?? '')) ||
      (directive.name === 'location' && directive.args.some((arg) => GUARD_LOCATION.test(arg.value))) ||
      // legacy-name: $gateway_maintenance of configs written before 2.12.1 — remove once every node reports none
      directive.args.some((arg) =>
        /\$\{?(secure_link|opfield_maintenance|gateway_maintenance|gm_cookie_)/.test(arg.raw)
      )
    ) {
      reserved = true;
    }
  });
  return reserved;
}

/**
 * The scopes of a server that set proxy_set_header themselves (the server and its locations), or null when a
 * proxying location inherits its headers from outside the server, or a scope sets Cookie more than once.
 */
function headerScopes(server: NginxConfigDirective): NginxConfigDirective[] | null {
  const scopes: NginxConfigDirective[] = [];
  const valid = (scope: NginxConfigDirective) => {
    const cookies = scope.block!.children.filter(isCookieHeader);
    return cookies.length <= 1 && cookies.every((cookie) => cookie.args.length === 2);
  };
  if (!valid(server)) return null;
  if (headerDirectives(server).length > 0) scopes.push(server);
  const visit = (children: NginxConfigDirective[], inherited: boolean): boolean => {
    for (const location of children) {
      if (location.name !== 'location' || !location.block) continue;
      if (!valid(location)) return false;
      const own = headerDirectives(location).length > 0;
      if (own) scopes.push(location);
      else if (!inherited && proxies(location.block.children)) return false;
      if (!visit(location.block.children, inherited || own)) return false;
    }
    return true;
  };
  return visit(server.block!.children, scopes.length > 0) ? scopes : null;
}

function lineIndent(text: string, position: number): string | null {
  const lineStart = text.lastIndexOf('\n', position - 1) + 1;
  const indent = text.slice(lineStart, position);
  return /^[\t ]*$/.test(indent) ? indent : null;
}

/** The route's own Cookie overrides keep their value outside maintenance (nginx variable names stay ≤ 46 bytes). */
function overrideMaps(hostId: string, overrides: string[]): string {
  return overrides
    .map(
      (value, index) => `map $opfield_maintenance ${overrideVariable(hostId, index + 1)} {
    volatile;
    default ${value};
    1 $opfield_maintenance_cookie_stripped;
}

`
    )
    .join('');
}

function overrideVariable(hostId: string, index: number): string {
  return `$gm_cookie_${hostId.replace(/-/g, '')}_${index}`;
}

function serverGuard(input: MaintenanceFlagGuardInput, serverHeaders: string[]): string {
  const copied = serverHeaders.map((header) => `\n        ${header}`).join('');
  const acl = (input.accessDirectives ?? []).map((directive) => `\n        ${directive}`).join('');
  return `
    # Opfield maintenance mode: answers only while the nginx daemon keeps ${MAINTENANCE_FLAG_DIR}/${input.hostId}.
    # Server-rewrite directives run before location selection; the guard's locations are reachable only through it.
    if (-f ${MAINTENANCE_FLAG_DIR}/${input.hostId}) {
        set $opfield_maintenance 1;
    }
    if ($opfield_maintenance_route) {
        rewrite ^ $opfield_maintenance_route last;
    }
    secure_link "$cookie_opfield_maintenance_access_sig,$cookie_opfield_maintenance_access_exp";
    secure_link_md5 "\${secure_link_expires}\${host}${input.secret}";

    location = opfield-maintenance {
        internal;${acl}
        error_page 503 @opfield-maintenance-page;
        try_files ${MAINTENANCE_ABSENT_FILE} =503;
    }

    location @opfield-maintenance-page {
        default_type text/html;
        add_header Cache-Control "no-store" always;${copied}
        return 503 ${input.pageText};
    }

    location = opfield-maintenance-access {
        internal;${acl}
        add_header Cache-Control "no-store" always;${copied}
        proxy_pass http://unix:/run/nginx-daemon/maintenance-access.sock:/redeem/${input.hostId};
        proxy_set_header Host $host;
        proxy_set_header X-Opfield-Maintenance-Host $host;
        proxy_set_header X-Opfield-Maintenance-Secure $https;
        proxy_set_header Cookie "";
        proxy_connect_timeout 5s;
        proxy_send_timeout 5s;
        proxy_read_timeout 5s;
    }

    location = opfield-maintenance-status {
        internal;${acl}
        error_page ${MAINTENANCE_STATE_HOP} = @opfield-maintenance-state;
        try_files ${MAINTENANCE_ABSENT_FILE} =${MAINTENANCE_STATE_HOP};
    }

    location @opfield-maintenance-state {
        default_type application/json;
        add_header Cache-Control "no-store" always;
        add_header X-Content-Type-Options "nosniff" always;
        if ($request_method != GET) {
            return 405 '{"error":"Only GET is allowed"}';
        }
        return 200 '{"active":$opfield_maintenance_access}';
    }
`;
}

/** Adds the flag-checked maintenance guard to a rendered route config, or returns null (see the module comment). */
export function renderMaintenanceFlagGuard(rendered: string, input: MaintenanceFlagGuardInput): string | null {
  let directives: NginxConfigDirective[];
  try {
    directives = parseNginxConfig(rendered);
  } catch {
    return null;
  }
  const servers = directives.filter((directive) => directive.name === 'server' && directive.block);
  if (servers.length === 0 || usesReservedFeatures(directives)) return null;

  const overrides: string[] = [];
  const edits: TextEdit[] = [];
  for (const server of servers) {
    const scopes = headerScopes(server);
    if (!scopes) return null;
    for (const scope of scopes) {
      const cookie = scope.block!.children.find(isCookieHeader);
      if (cookie) {
        const value = cookie.args[1]!;
        overrides.push(value.raw);
        edits.push({ start: value.start, end: value.end, text: overrideVariable(input.hostId, overrides.length) });
        continue;
      }
      const last = headerDirectives(scope).at(-1)!;
      const indent = lineIndent(rendered, last.start);
      const directive = 'proxy_set_header Cookie $opfield_maintenance_cookie;';
      edits.push({
        start: last.end,
        end: last.end,
        text: indent === null ? ` ${directive}` : `\n${indent}${directive}`,
      });
    }
    const serverHeaders = server
      .block!.children.filter((directive) => directive.name === 'add_header')
      .map((directive) => rendered.slice(directive.start, directive.end));
    const open = server.block!.open + 1;
    edits.push({ start: open, end: open, text: serverGuard(input, serverHeaders) });
  }

  let guarded = rendered;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    guarded = guarded.slice(0, edit.start) + edit.text + guarded.slice(edit.end);
  }
  return `${overrideMaps(input.hostId, overrides)}${guarded}`;
}
