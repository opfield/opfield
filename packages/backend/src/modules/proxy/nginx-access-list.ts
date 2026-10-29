import type { AccessListUser, AccessRule } from '@/db/schema/access-lists.js';
import { type NginxConfigDirective, parseNginxConfig } from './nginx-config-tree.js';

/**
 * What a route's nginx config renders of its access list.
 *
 * A node whose daemon reports NGINX_ACCESS_AUTH_CAPABILITY decides every request at its access socket: each protected
 * location asks it through auth_request (accessListDirectives), and the server answers the sign-in challenge and the
 * callback from the sign-in page (withAccessAuthLocations). The daemon checks the policy Opfield syncs to it, so a
 * change of the list changes no config.
 *
 * A node without it (an older daemon, during an update) gets allow/deny and basic authentication rendered from the
 * list instead (fallbackAccess): IP rules exactly, a list that only offers basic authentication with an htpasswd file,
 * and every other sign-in method as denied, so an older daemon never lets in a visitor it cannot check.
 */

export const NGINX_ACCESS_AUTH_CAPABILITY = 'nginx_access_auth_v1';
const ACCESS_SOCKET = '/run/nginx-daemon/access.sock';
export const ACCESS_CHECK_PATH = '/_opfield/access/check';
const ACCESS_CALLBACK_PATH = '/_opfield/access/callback';
const ACCESS_CHALLENGE_LOCATION = '@opfield_access_challenge';

export interface NginxAccessList {
  id: string;
  /** The node checks requests at its access socket; false: the fallback directives. */
  authRequest: boolean;
  signInMethods: string[];
  /** The list has users (basic authentication of the fallback). */
  hasUsers: boolean;
  skipIpRanges: string[];
  includeRules: AccessRule[];
  requireRules: AccessRule[];
  excludeRules: AccessRule[];
}

/** A stored access list as a route renders it; authRequest is decided per node. */
export function nginxAccessListOf(
  list: {
    id: string;
    signInMethods: string[];
    users: AccessListUser[] | null;
    skipIpRanges: string[];
    includeRules: AccessRule[] | null;
    requireRules: AccessRule[] | null;
    excludeRules: AccessRule[] | null;
  },
  authRequest = false
): NginxAccessList {
  return {
    id: list.id,
    authRequest,
    signInMethods: list.signInMethods ?? [],
    hasUsers: (list.users ?? []).length > 0,
    skipIpRanges: list.skipIpRanges ?? [],
    includeRules: list.includeRules ?? [],
    requireRules: list.requireRules ?? [],
    excludeRules: list.excludeRules ?? [],
  };
}

type AccessPolicy = Omit<NginxAccessList, 'id' | 'authRequest'>;

// Values were validated as IPs or CIDR ranges on write; anything else never reaches a directive.
function ipValue(value: string): string {
  return value.replace(/[^0-9A-Fa-f.:/]/g, '');
}

function ipValues(rules: readonly AccessRule[]): string[][] {
  return rules.filter((rule) => rule.selector === 'ip').map((rule) => rule.values.map(ipValue).filter(Boolean));
}

const matchesEveryBasicIdentity = (rule: AccessRule) =>
  rule.selector === 'everyone' || (rule.selector === 'method' && rule.values.includes('basic'));

/**
 * How the fallback's basic authentication lets a user in: from any address (null), only from these ranges, or not at
 * all (false: the list offers more than basic, has no users, or its rules need more than nginx can check).
 */
function fallbackBasicRanges(list: AccessPolicy): string[] | null | false {
  if (list.signInMethods.length !== 1 || list.signInMethods[0] !== 'basic' || !list.hasUsers) return false;
  if (!list.includeRules.some(matchesEveryBasicIdentity)) return false;
  if (list.excludeRules.some((rule) => rule.selector !== 'ip' && matchesEveryBasicIdentity(rule))) return false;
  if (!list.requireRules.every((rule) => rule.selector === 'ip' || matchesEveryBasicIdentity(rule))) return false;
  const required = ipValues(list.requireRules);
  if (required.length > 1) return false;
  return required[0] ?? null;
}

/** Whether a node without the access socket checks the list with basic authentication (an htpasswd file). */
export function usesFallbackBasicAuth(list: AccessPolicy): boolean {
  return fallbackBasicRanges(list) !== false;
}

export interface FallbackAccess {
  /** allow/deny in nginx order, ending in an `all` rule when it restricts anyone. */
  rules: { type: 'allow' | 'deny'; value: string }[];
  basicAuth: boolean;
}

/**
 * The list as allow/deny and basic authentication: excluded addresses are denied, skip ranges allowed, a basic-only
 * list asks for its users (from its required networks), and every other visitor is denied. Without `basic` (a node
 * that checks at its access socket, where no htpasswd file is kept) basic authentication is denied too.
 */
export function fallbackAccess(list: AccessPolicy, { basic }: { basic: boolean }): FallbackAccess {
  const deny = (value: string) => ({ type: 'deny' as const, value });
  const allow = (value: string) => ({ type: 'allow' as const, value });
  const denies = ipValues(list.excludeRules).flat().map(deny);
  const basicRanges = basic ? fallbackBasicRanges(list) : false;
  if (basicRanges === false) {
    return { rules: [...denies, ...list.skipIpRanges.map(ipValue).map(allow), deny('all')], basicAuth: false };
  }
  if (basicRanges === null) return { rules: denies.length > 0 ? [...denies, allow('all')] : [], basicAuth: true };
  return { rules: [...denies, ...basicRanges.map(allow), deny('all')], basicAuth: true };
}

/**
 * A Pages preview's protection until the nginx daemon has the list's policy (PagesPreviewAccess ip_rules,
 * basic_auth_enabled and the htpasswd content): the same fallback as a route on a node without the access socket.
 * The preview always sends the list id; the daemon checks it at its access socket once the policy is synced.
 */
export function pagesPreviewFallbackAccess(list: Parameters<typeof nginxAccessListOf>[0]) {
  const fallback = fallbackAccess(nginxAccessListOf(list), { basic: true });
  const users = list.users ?? [];
  return {
    accessListId: list.id,
    ipRules: fallback.rules,
    basicAuthEnabled: fallback.basicAuth,
    htpasswd: fallback.basicAuth
      ? `${users.map((user) => `${user.username}:${user.passwordHash}`).join('\n')}\n`
      : null,
  };
}

export function accessListPasswordFile(accessListId: string): string {
  return `/etc/nginx/opfield/htpasswd/access-list-${accessListId.replace(/[^0-9A-Za-z-]/g, '')}`;
}

// The identity the node checked, and the service token credentials cleared: the upstream never sees a secret.
const IDENTITY_HEADERS = [
  'proxy_set_header Opfield-Access-Jwt-Assertion $opfield_access_assertion;',
  'proxy_set_header Opfield-Access-Email $opfield_access_email;',
  'proxy_set_header Opfield-Access-User $opfield_access_user;',
  'proxy_set_header Opfield-Access-Client-Id "";',
  'proxy_set_header Opfield-Access-Client-Secret "";',
];
const CHALLENGE_PAGE = `error_page 401 = ${ACCESS_CHALLENGE_LOCATION};`;

const AUTH_REQUEST_DIRECTIVES = [
  `auth_request ${ACCESS_CHECK_PATH};`,
  'auth_request_set $opfield_access_assertion $upstream_http_x_opfield_access_assertion;',
  'auth_request_set $opfield_access_email $upstream_http_x_opfield_access_email;',
  'auth_request_set $opfield_access_user $upstream_http_x_opfield_access_user;',
  CHALLENGE_PAGE,
  ...IDENTITY_HEADERS,
];

/** The directives of a location the list protects. */
export function accessListDirectives(list: NginxAccessList | null | undefined): string[] {
  if (!list) return [];
  if (list.authRequest) return [...AUTH_REQUEST_DIRECTIVES];
  const fallback = fallbackAccess(list, { basic: true });
  return [
    ...fallback.rules.map((rule) => `${rule.type} ${rule.value};`),
    ...(fallback.basicAuth
      ? ['auth_basic "Restricted Access";', `auth_basic_user_file ${accessListPasswordFile(list.id)};`]
      : []),
  ];
}

/**
 * The address rules of the list for the maintenance guard's locations: a client the list turns away by address alone
 * gets 403 during maintenance too, never the maintenance page (deny wins). Sign-in stays on the route itself.
 */
export function maintenanceAccessListDirectives(list: NginxAccessList | null | undefined): string[] {
  if (!list) return [];
  const denies = ipValues(list.excludeRules)
    .flat()
    .map((value) => `deny ${value};`);
  const required = ipValues(list.requireRules);
  const signsIn = list.signInMethods.length > 0 || list.includeRules.some((rule) => rule.selector === 'service_token');
  // Only skip ranges get in without signing in; with sign-in, an address outside the one required network can't.
  const allowed = !signsIn
    ? list.skipIpRanges.map(ipValue)
    : required.length === 1
      ? [...list.skipIpRanges.map(ipValue), ...required[0]!]
      : null;
  return [...denies, ...(allowed ? [...allowed.map((value) => `allow ${value};`), 'deny all;'] : [])];
}

/**
 * The `accessList` and `accessListHasIpRules` of a template's context. Templates written before sign-in based lists
 * read accessList.ipRules and accessList.basicAuthEnabled: they get the fallback rules (on a node with the access
 * socket without basic authentication, so such a template denies what it cannot check). The access list block of the
 * built-in templates becomes {{{accessListDirectives accessList}}} (upgradeLegacyAccessListBlocks).
 */
export function accessListTemplateContext(list: NginxAccessList | null | undefined) {
  if (!list) return { accessList: null, accessListHasIpRules: false };
  const fallback = fallbackAccess(list, { basic: !list.authRequest });
  return {
    accessList: { ...list, ipRules: fallback.rules, basicAuthEnabled: fallback.basicAuth },
    accessListHasIpRules: fallback.rules.length > 0,
  };
}

// The access list block of the built-in templates before sign-in based lists, as custom templates copied it.
const LEGACY_ACCESS_LIST_BLOCK =
  /\{\{#if accessList\}\}\s*\{\{#each accessList\.ipRules\}\}\s*\{\{sanitize this\.type\}\} \{\{sanitize this\.value\}\};\s*\{\{\/each\}\}\s*\{\{#if accessListHasIpRules\}\}\s*deny all;\s*\{\{\/if\}\}\s*\{\{#if accessList\.basicAuthEnabled\}\}\s*auth_basic "Restricted Access";\s*auth_basic_user_file [^;\n]*\/htpasswd\/access-list-\{\{accessList\.id\}\};\s*\{\{\/if\}\}\s*\{\{\/if\}\}[\t ]*\n/g;

/** The access list block of the built-in proxy template; the helper renders the lines and a blank line after them. */
export const ACCESS_LIST_TEMPLATE_BLOCK = '{{#if accessList}}\n{{{accessListDirectives accessList}}}\n{{/if}}';

/** Custom templates copied from a built-in one render the access list like the built-in templates do now. */
export function upgradeLegacyAccessListBlocks(content: string): string {
  return content.replace(LEGACY_ACCESS_LIST_BLOCK, `${ACCESS_LIST_TEMPLATE_BLOCK}\n`);
}

// ---------------------------------------------------------------------------
// Server-level locations and inheritance (nodes with the access socket)
// ---------------------------------------------------------------------------

const FORWARDED_ACCESS_HEADERS = (listId: string) => [
  `proxy_set_header X-Opfield-Access-List "${listId.replace(/[^0-9A-Za-z-]/g, '')}";`,
  'proxy_set_header X-Opfield-Access-Host $host;',
  'proxy_set_header X-Opfield-Access-Client-Ip $remote_addr;',
  'proxy_set_header X-Opfield-Access-Uri $request_uri;',
  'proxy_set_header X-Opfield-Access-Secure $https;',
];

function accessLocations(listId: string): string {
  const block = (header: string, lines: string[]) => [
    `    ${header} {`,
    ...lines.map((line) => `        ${line}`),
    '    }',
  ];
  return [
    '',
    '    # Opfield access list: the node checks every request at its access socket.',
    ...block(`location = ${ACCESS_CHECK_PATH}`, [
      'internal;',
      `proxy_pass http://unix:${ACCESS_SOCKET}:/check;`,
      'proxy_pass_request_body off;',
      'proxy_set_header Content-Length "";',
      ...FORWARDED_ACCESS_HEADERS(listId),
    ]),
    '',
    ...block(`location = ${ACCESS_CALLBACK_PATH}`, [
      // The host token is in the query string: it never goes to the access log.
      'access_log off;',
      'auth_request off;',
      `proxy_pass http://unix:${ACCESS_SOCKET}:/callback;`,
      'proxy_set_header X-Opfield-Access-Host $host;',
      'proxy_set_header X-Opfield-Access-Secure $https;',
    ]),
    '',
    ...block(`location ${ACCESS_CHALLENGE_LOCATION}`, [
      'auth_request off;',
      'rewrite ^ /challenge break;',
      `proxy_pass http://unix:${ACCESS_SOCKET};`,
      'proxy_pass_request_body off;',
      'proxy_set_header Content-Length "";',
      ...FORWARDED_ACCESS_HEADERS(listId),
    ]),
    '',
  ].join('\n');
}

function isAccessLocation(location: NginxConfigDirective): boolean {
  const target = location.args.at(-1)?.value;
  return target === ACCESS_CHECK_PATH || target === ACCESS_CALLBACK_PATH || target === ACCESS_CHALLENGE_LOCATION;
}

function protectsHere(location: NginxConfigDirective): boolean {
  return (location.block?.children ?? []).some(
    (child) => child.name === 'auth_request' && child.args[0]?.value === ACCESS_CHECK_PATH
  );
}

function hasProtectedLocation(children: NginxConfigDirective[]): boolean {
  return children.some(
    (child) =>
      child.name === 'location' && !!child.block && (protectsHere(child) || hasProtectedLocation(child.block.children))
  );
}

const isIdentityHeader = (directive: NginxConfigDirective) =>
  directive.name === 'proxy_set_header' && /^Opfield-Access-/i.test(directive.args[0]?.value ?? '');
const namesUnauthorized = (directive: NginxConfigDirective) =>
  directive.name === 'error_page' && directive.args.slice(0, -1).some((arg) => arg.value === '401');

/** proxy_set_header and error_page in effect at a level: its own, or (with none of its own) the outer level's. */
interface InheritedDirectives {
  headers: string[];
  errorPages: string[];
}

function own(text: string, children: NginxConfigDirective[], name: string): string[] {
  return children.filter((child) => child.name === name).map((child) => text.slice(child.start, child.end));
}

interface TextEdit {
  position: number;
  text: string;
}

/**
 * A location-level proxy_set_header or error_page stops nginx from inheriting the outer ones. Where the access
 * directives were rendered into a location that had none of its own, the outer ones are repeated next to them; a
 * location inside a protected one that sets its own headers or error pages gets the identity headers and the sign-in
 * challenge too.
 */
function inheritanceEdits(
  text: string,
  children: NginxConfigDirective[],
  outer: InheritedDirectives,
  insideProtected: boolean,
  edits: TextEdit[]
): void {
  for (const location of children) {
    if (location.name !== 'location' || !location.block || isAccessLocation(location)) continue;
    const body = location.block.children;
    const authRequest = body.find((child) => child.name === 'auth_request');
    const here = protectsHere(location);
    const isProtected = authRequest ? here : insideProtected;
    const headers = body.filter((child) => child.name === 'proxy_set_header');
    const errorPages = body.filter((child) => child.name === 'error_page');
    const added: string[] = [];
    if (here) {
      if (!headers.some((child) => !isIdentityHeader(child))) added.push(...outer.headers);
      if (!errorPages.some((child) => !namesUnauthorized(child))) added.push(...outer.errorPages);
    } else if (isProtected) {
      if (headers.length > 0 && !headers.some(isIdentityHeader)) added.push(...IDENTITY_HEADERS);
      if (errorPages.length > 0 && !errorPages.some(namesUnauthorized)) added.push(CHALLENGE_PAGE);
    }
    if (added.length > 0) {
      const lineStart = text.lastIndexOf('\n', location.start) + 1;
      const indent = `${/^[\t ]*/.exec(text.slice(lineStart, location.start))?.[0] ?? ''}    `;
      edits.push({
        position: body.at(-1)?.end ?? location.block.open + 1,
        text: added.map((directive) => `\n${indent}${directive}`).join(''),
      });
    }
    const addedHeaders = added.filter((directive) => directive.startsWith('proxy_set_header'));
    const addedPages = added.filter((directive) => directive.startsWith('error_page'));
    const inner: InheritedDirectives = {
      headers: headers.length > 0 ? [...own(text, body, 'proxy_set_header'), ...addedHeaders] : outer.headers,
      errorPages: errorPages.length > 0 ? [...own(text, body, 'error_page'), ...addedPages] : outer.errorPages,
    };
    inheritanceEdits(text, body, inner, isProtected, edits);
  }
}

/**
 * Adds the access socket's locations to every server block of a rendered config that has a location the list
 * protects, and keeps the inherited headers and error pages of those locations. A config that cannot be parsed is
 * returned unchanged (nginx's own config test rejects it on the node).
 */
export function withAccessAuthLocations(rendered: string, list: NginxAccessList | null | undefined): string {
  if (!list?.authRequest || !rendered.includes(ACCESS_CHECK_PATH)) return rendered;
  let directives: NginxConfigDirective[];
  try {
    directives = parseNginxConfig(rendered);
  } catch {
    return rendered;
  }
  const edits: TextEdit[] = [];
  for (const server of directives) {
    if (server.name !== 'server' || !server.block || !hasProtectedLocation(server.block.children)) continue;
    const children = server.block.children;
    if (!children.some((child) => child.name === 'location' && isAccessLocation(child))) {
      edits.push({ position: server.block.open + 1, text: accessLocations(list.id) });
    }
    const outer = {
      headers: own(rendered, children, 'proxy_set_header'),
      errorPages: own(rendered, children, 'error_page'),
    };
    inheritanceEdits(rendered, children, outer, false, edits);
  }
  let result = rendered;
  for (const edit of edits.sort((left, right) => right.position - left.position)) {
    result = result.slice(0, edit.position) + edit.text + result.slice(edit.position);
  }
  return result;
}
