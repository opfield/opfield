import { type NginxConfigDirective, parseNginxConfig } from './nginx-config-tree.js';

/**
 * The Opfield pages nginx answers with when nginx itself ends a request: a client the access list denies, a missing
 * page, a refused method or body, an upstream it cannot reach. A visitor never sees nginx's own plain pages.
 *
 * The pages live once per node, in an http-level file of variables the nginx daemon keeps (errorpages.Config in the
 * nginx daemon; it reports NGINX_ERROR_PAGES_CAPABILITY). Every server of a route hands the codes to one named
 * location that answers with the page of the response status:
 *
 *   error_page 400 401 403 ... @opfield_error;
 *   location @opfield_error { default_type text/html; return 200 $opfield_error_page; }
 *
 * `return 200` keeps the status of the error: nginx sends a response that error_page produced with the original code
 * unless error_page names another (`=code`). nginx answers 494-497 with 400; each has a page that says what went wrong.
 * 400 and 414 can end a request whose request line nginx could not read, which has no URI and cannot be handed to a
 * named location (nginx answers 500), so they go to an internal location with a reserved path (ERROR_PAGE_PATH); a
 * request for that path from outside gets the 404 page. The locations allow every client and ask for no password, so a
 * client the server's own access rules deny gets the 403 page.
 *
 * error_page applies only to responses nginx generates. An upstream's own error responses pass through unchanged,
 * since no route turns proxy_intercept_errors on. Codes a scope already answers itself keep its own handling (the
 * 404 of Pages and its SPA fallback, a custom config's own pages); a location with error_page directives of its own
 * does not inherit the server's, so it gets the codes it does not name.
 */

export const NGINX_ERROR_PAGES_CAPABILITY = 'nginx_error_pages_v1';

/** Kept in step with Pages and SpecialPages in the nginx daemon (internal/errorpages). */
export const OPFIELD_ERROR_PAGE_CODES = [400, 401, 403, 404, 405, 408, 413, 414, 429, 500, 502, 503, 504] as const;
export const OPFIELD_SPECIAL_ERROR_PAGE_CODES = [494, 495, 496, 497] as const;

/** Kept in step with RequestLinePath and RequestLineCodes in the nginx daemon (internal/errorpages). */
export const ERROR_PAGE_PATH = '/.well-known/opfield-error';
const REQUEST_LINE_CODES: readonly number[] = [400, 414];

const RESERVED = /@opfield_error\b|\$\{?opfield_error_page|\/\.well-known\/opfield-error\b/;

function pageLocation(code?: number): string {
  return code === undefined ? '@opfield_error' : `@opfield_error_${code}`;
}

function pageVariable(hideExternalBranding: boolean, code?: number): string {
  return `$opfield_error_page${code === undefined ? '' : `_${code}`}${hideExternalBranding ? '_unbranded' : ''}`;
}

/** The codes the error_page directives directly inside a scope name. */
function declaredCodes(scope: NginxConfigDirective): Set<number> {
  const codes = new Set<number>();
  for (const directive of scope.block?.children ?? []) {
    if (directive.name !== 'error_page') continue;
    for (const arg of directive.args.slice(0, -1)) {
      if (/^\d{3}$/.test(arg.value)) codes.add(Number(arg.value));
    }
  }
  return codes;
}

function missing(codes: readonly number[], declared: Set<number>): number[] {
  return codes.filter((code) => !declared.has(code));
}

interface TextEdit {
  position: number;
  text: string;
}

function serverPages(server: NginxConfigDirective, hideExternalBranding: boolean): string {
  const declared = declaredCodes(server);
  const codes = missing(OPFIELD_ERROR_PAGE_CODES, declared);
  const named = codes.filter((code) => !REQUEST_LINE_CODES.includes(code));
  const requestLine = codes.filter((code) => REQUEST_LINE_CODES.includes(code));
  const special = missing(OPFIELD_SPECIAL_ERROR_PAGE_CODES, declared);
  const lines = ['', '    # Opfield error pages: the pages nginx answers with when it ends a request itself.'];
  if (named.length > 0) lines.push(`    error_page ${named.join(' ')} ${pageLocation()};`);
  if (requestLine.length > 0) lines.push(`    error_page ${requestLine.join(' ')} ${ERROR_PAGE_PATH};`);
  for (const code of special) lines.push(`    error_page ${code} ${pageLocation(code)};`);
  const body = (code?: number) => [
    '        allow all;',
    '        auth_basic off;',
    '        default_type text/html;',
    `        return 200 ${pageVariable(hideExternalBranding, code)};`,
    '    }',
  ];
  lines.push(`    location ${pageLocation()} {`, ...body());
  lines.push(`    location = ${ERROR_PAGE_PATH} {`, '        internal;', ...body());
  for (const code of special) lines.push(`    location ${pageLocation(code)} {`, ...body(code));
  lines.push('');
  return lines.join('\n');
}

/** Locations (at any depth) that name error pages themselves get the codes they do not name. */
function locationEdits(children: NginxConfigDirective[], edits: TextEdit[]): void {
  for (const location of children) {
    if (location.name !== 'location' || !location.block) continue;
    const declared = declaredCodes(location);
    if (declared.size > 0) {
      const codes = missing(OPFIELD_ERROR_PAGE_CODES, declared);
      const named = codes.filter((code) => !REQUEST_LINE_CODES.includes(code));
      const requestLine = codes.filter((code) => REQUEST_LINE_CODES.includes(code));
      const last = location.block.children.filter((directive) => directive.name === 'error_page').at(-1)!;
      const text = [
        named.length > 0 ? ` error_page ${named.join(' ')} ${pageLocation()};` : '',
        requestLine.length > 0 ? ` error_page ${requestLine.join(' ')} ${ERROR_PAGE_PATH};` : '',
      ].join('');
      if (text) edits.push({ position: last.end, text });
    }
    locationEdits(location.block.children, edits);
  }
}

/**
 * Hands nginx's own error responses of every server in a rendered route config to the Opfield pages. A config that
 * cannot be parsed, or already names the pages, is returned unchanged.
 */
export function withOpfieldErrorPages(rendered: string, hideExternalBranding = false): string {
  if (RESERVED.test(rendered)) return rendered;
  let directives: NginxConfigDirective[];
  try {
    directives = parseNginxConfig(rendered);
  } catch {
    return rendered;
  }
  const edits: TextEdit[] = [];
  for (const server of directives) {
    if (server.name !== 'server' || !server.block) continue;
    edits.push({ position: server.block.open + 1, text: serverPages(server, hideExternalBranding) });
    locationEdits(server.block.children, edits);
  }
  let result = rendered;
  for (const edit of edits.sort((left, right) => right.position - left.position)) {
    result = result.slice(0, edit.position) + edit.text + result.slice(edit.position);
  }
  return result;
}
