import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { count, eq, inArray } from 'drizzle-orm';
import Handlebars from 'handlebars';
import type { DrizzleClient } from '@/db/client.js';
import { nginxTemplates } from '@/db/schema/nginx-templates.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';
import {
  LEGACY_INGRESS_HEALTH_NAME,
  LEGACY_NGINX_MARK_PREFIX,
  LEGACY_RESERVED_PATH_PREFIX,
} from '@/lib/legacy-compat.js';
import { createChildLogger } from '@/lib/logger.js';
import { formatHostPort } from '@/lib/network-endpoint.js';
import {
  escapeNginxReturnText,
  OPFIELD_NOT_FOUND_HTML,
  opfieldMaintenanceHtml,
  opfieldNotFoundHtml,
} from '@/lib/opfield-error-pages.js';
import { hasScope, scopeMatcher } from '@/lib/permissions.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { getDnsResolverServers } from '@/modules/domains/dns.utils.js';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { injectAccessListIntoAdvancedLocations } from '@/services/nginx-advanced-location.js';
import type { ProxyAdditionalRouteConfig, ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { additionalRouteAdvancedConfigErrors } from './additional-route.validation.js';
import {
  ADDITIONAL_ROUTES_TEMPLATE_PLACEHOLDER,
  supportsAdditionalRoutesTemplate,
} from './additional-route-template.js';
import { managedSecureLinkUpstreamBody, withAvailabilityNextUpstream } from './nginx-availability-upstream.js';
import {
  MAINTENANCE_ABSENT_FILE,
  MAINTENANCE_STATE_HOP,
  renderMaintenanceFlagGuard,
} from './nginx-maintenance-flag-guard.js';
import { toLegacyNginxNames } from './nginx-node-names.js';
import type { CreateNginxTemplateInput, UpdateNginxTemplateInput } from './nginx-template.schemas.js';
import { withoutReservedTemplateVariables } from './proxy-template-variables.js';
import { withStatusPageStaleCache } from './status-page-stale-cache.js';

const logger = createChildLogger('NginxTemplateService');

const NGINX_LOGS_PREFIX = '/var/log/nginx';
/** The Pages runtime configuration script the rendered pages load (window.runtime.config). */
export const PAGES_CONFIG_SCRIPT_PATH = '/_opfield/pages/config.js';
/**
 * The pre-Opfield path of the script, answered the same way: it is documented, and pages may load it themselves.
 * legacy-name: Pages runtime configuration path customer pages may load directly — remove once no page loads it
 */
export const LEGACY_PAGES_CONFIG_SCRIPT_PATH = `${LEGACY_RESERVED_PATH_PREFIX}/pages/config.js`;
const DEFAULT_RATE_LIMIT_RPS = 1000;
const DEFAULT_RATE_LIMIT_BURST = 3000;
const DEFAULT_CONNECTIONS_PER_IP = 1000;

// nginx-daemon writes HTTP-01 tokens to
// <acme_challenge_dir>/.well-known/acme-challenge/<token>, so the location
// alias must include that subdirectory (matching the setup-node.sh catch-all).
const ACME_CHALLENGE_ALIAS = '/var/www/acme-challenge/.well-known/acme-challenge/';
// Custom templates cloned before the fix alias the webroot base, which makes
// every challenge 404. Rewrite that exact legacy directive at render time.
const LEGACY_ACME_CHALLENGE_ALIAS =
  /(location\s+\/\.well-known\/acme-challenge\/\s*\{\s*alias\s+)\/var\/www\/acme-challenge\/;/g;

export function normalizeAcmeChallengeAlias(rendered: string): string {
  return rendered.replace(LEGACY_ACME_CHALLENGE_ALIAS, `$1${ACME_CHALLENGE_ALIAS};`);
}

const DEFAULT_PROXY_TEMPLATE_VARIABLES = [
  {
    name: 'cacheEnabled',
    type: 'boolean' as const,
    default: false,
    description: 'Cache upstream responses',
  },
  {
    name: 'cacheMaxAge',
    type: 'number' as const,
    default: 3600,
    description: 'Cache lifetime in seconds',
  },
  {
    name: 'rateLimitMode',
    type: 'string' as const,
    default: 'inherit',
    description: 'Use the Opfield default, a custom policy, or disable protection',
  },
  {
    name: 'rateLimitRPS',
    type: 'number' as const,
    default: DEFAULT_RATE_LIMIT_RPS,
    description: 'Requests allowed per second for each client IP',
  },
  {
    name: 'rateLimitBurst',
    type: 'number' as const,
    default: DEFAULT_RATE_LIMIT_BURST,
    description: 'Additional request burst allowed for each client IP',
  },
  {
    name: 'connectionsPerIp',
    type: 'number' as const,
    default: DEFAULT_CONNECTIONS_PER_IP,
    description: 'Concurrent connections allowed for each client IP',
  },
];

// ---------------------------------------------------------------------------
// Register Handlebars helpers
// ---------------------------------------------------------------------------

// Characters that end a directive, open or close a block or string, start a comment or a variable, or (`\`, tabs
// and other control characters) escape or split the token structure nginx reads. Plain spaces stay: values such as
// header values are rendered inside quotes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
const DANGEROUS_CHARS = /[\x00-\x1f\x7f;'"{}`$#\\]/g;

Handlebars.registerHelper('sanitize', (value: unknown) => {
  if (typeof value !== 'string') return value;
  return new Handlebars.SafeString(value.replace(DANGEROUS_CHARS, ''));
});

// Rewrite regexes and replacements need `$` for anchors and captures ($1) and
// `\` for escapes, so only the characters that could end or break out of the
// directive are removed: whitespace (the arguments are unquoted) and a trailing
// unpaired backslash, which would escape the separator after the argument.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
const DANGEROUS_REWRITE_CHARS = /[\x00-\x1f\x7f\s;'"{}`#]/g;

export function sanitizeRewriteArgument(value: string): string {
  const cleaned = value.replace(DANGEROUS_REWRITE_CHARS, '');
  const trailingBackslashes = cleaned.length - cleaned.replace(/\\+$/, '').length;
  return trailingBackslashes % 2 === 1 ? cleaned.slice(0, -1) : cleaned;
}

Handlebars.registerHelper('sanitizeRewrite', (value: unknown) => {
  if (typeof value !== 'string') return value;
  return new Handlebars.SafeString(sanitizeRewriteArgument(value));
});

// Custom templates cloned before regex rewrites worked render them with the
// generic sanitize helper, which strips `$`. Upgrade that exact directive.
const LEGACY_REWRITE_ARGUMENTS = /rewrite \{\{sanitize this\.source\}\} \{\{sanitize this\.destination\}\}/g;

export function upgradeLegacyRewriteArguments(content: string): string {
  return content.replace(
    LEGACY_REWRITE_ARGUMENTS,
    'rewrite {{sanitizeRewrite this.source}} {{sanitizeRewrite this.destination}}'
  );
}

Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);

Handlebars.registerHelper('indent', (value: unknown, spaces: unknown) => {
  if (typeof value !== 'string' || !value) return '';
  const pad = ' '.repeat(typeof spaces === 'number' ? spaces : 4);
  return new Handlebars.SafeString(
    value
      .split('\n')
      .map((line, i) => (i === 0 ? line : pad + line))
      .join('\n')
  );
});

Handlebars.registerHelper('applyAccessListToAdvancedLocations', (advancedConfig: unknown, accessList: unknown) => {
  if (typeof advancedConfig !== 'string') return '';
  return injectAccessListIntoAdvancedLocations(
    advancedConfig,
    buildAccessListDirectives(accessList as ProxyHostConfig['accessList'])
  );
});

function routeNginxValue(value: string): string {
  return value.replace(DANGEROUS_CHARS, '');
}

function routeRegexPath(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safePagesFallbackUrl(value: string | null | undefined): string | null {
  if (!value || /[\s;'"{}\\`$#]/.test(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Upstreams served by Availability members. Their socket lists are set only for Availability workloads (one member
 * per placement); every other Secure Link upstream has a single socket path.
 */
function availabilityUpstreamNames(host: ProxyHostConfig, includeRoutes: boolean): string[] {
  return [
    ...(host.secureLinkUpstream && host.secureLinkSocketPaths?.length
      ? [`opfield_secure_link_${host.id.replace(/-/g, '_')}`]
      : []),
    ...(host.additionalSecureLinks ?? [])
      .filter((binding) => binding.socketPaths?.length)
      .map((binding) => `opfield_additional_secure_link_${binding.id.replace(/-/g, '_')}`),
    ...(includeRoutes ? (host.additionalRoutes ?? []) : [])
      .filter((route) => route.secureLinkUpstream && route.secureLinkSocketPaths?.length)
      .map((route) => `opfield_additional_secure_link_${route.id.replace(/-/g, '_')}`),
  ];
}

function renderAdditionalRouteLocation(
  route: ProxyAdditionalRouteConfig,
  hostId: string,
  accessList: ProxyHostConfig['accessList'],
  rateLimitEnabled: boolean,
  rateLimitBurst: number,
  connectionsPerIp: number
): string {
  const path = routeNginxValue(route.path);
  const upstreamName = `opfield_additional_secure_link_${route.id.replace(/-/g, '_')}`;
  const upstream = route.secureLinkUpstream
    ? `${route.forwardScheme}://${upstreamName}`
    : `${route.forwardScheme}://${routeNginxValue(route.forwardHost ?? '')}:${route.forwardPort ?? 0}`;
  const access = buildAccessListDirectives(accessList).map((directive) => `        ${directive}`);
  const limits = rateLimitEnabled
    ? [
        '        limit_req_status 429;',
        `        limit_req zone=ratelimit_${hostId} burst=${rateLimitBurst} nodelay;`,
        '        limit_conn_status 429;',
        `        limit_conn connlimit_${hostId} ${connectionsPerIp};`,
      ]
    : [];
  const common = [...access, ...(access.length > 0 ? [''] : []), ...limits, ...(limits.length > 0 ? [''] : [])];
  // The deny-list was applied on save unless the editor held proxy:unrestricted on the Route; the stored lines must
  // still be complete directives, or they would run into the directives rendered after them.
  const advancedErrors = route.advancedConfig ? additionalRouteAdvancedConfigErrors(route.advancedConfig, true) : [];
  if (advancedErrors.length > 0) {
    throw new AppError(
      400,
      'INVALID_ADDITIONAL_ROUTE_CONFIG',
      `Additional Route ${path} advanced config is invalid: ${advancedErrors.join(', ')}`
    );
  }
  const advanced = route.advancedConfig ? route.advancedConfig.split(/\r?\n/).map((line) => `        ${line}`) : [];
  if (route.targetKind === 'pages') {
    const scopedConfigPath = `${path}${PAGES_CONFIG_SCRIPT_PATH}`;
    // legacy-name: pages written before 2.12.1 may load the pre-Opfield script path themselves
    const legacyScopedConfigPath = `${path}${LEGACY_PAGES_CONFIG_SCRIPT_PATH}`;
    const escaped = routeRegexPath(path);
    const notFoundLocation = `opfield_pages_not_found_${route.id.replace(/-/g, '_')}`;
    const notFoundPageLocation = `opfield_pages_404_${route.id.replace(/-/g, '_')}`;
    const spaLocation = `opfield_pages_spa_${route.id.replace(/-/g, '_')}`;
    const fallbackUrl = safePagesFallbackUrl(route.pagesFallbackUrl);
    const errorPage = route.pagesSpaFallback
      ? `        error_page 404 = @${spaLocation};`
      : fallbackUrl
        ? `        error_page 404 =302 ${fallbackUrl};`
        : // No "=": the project's own 404.html is served with the original 404 status.
          `        error_page 404 @${notFoundPageLocation};`;
    const pageBody = [
      ...common,
      '        limit_except GET HEAD { deny all; }',
      '        add_header X-Content-Type-Options nosniff always;',
      '        add_header Referrer-Policy same-origin always;',
      `        rewrite ^${escaped}(?:/(.*))?$ /$1 break;`,
      `        include ${routeNginxValue(route.pagesRouteIncludePath ?? '')};`,
      ...advanced,
      errorPage,
      // The SPA location answers a missing file path with 404 itself; that second error page only runs when the first
      // error_page of the request allows it.
      ...(route.pagesSpaFallback ? ['        recursive_error_pages on;'] : []),
      // Resolve directory indexes explicitly so nginx does not internally redirect
      // a stripped Pages subpath (/) into the host's generic location /.
      '        try_files $uri/index.html $uri =404;',
      '        sub_filter_once on;',
      `        sub_filter '</head>' '<script src="${scopedConfigPath}"></script></head>';`,
    ];
    const configLocation = [scopedConfigPath, legacyScopedConfigPath].flatMap((scriptPath, index) => [
      ...(index > 0 ? [''] : []),
      `    location = ${scriptPath} {`,
      ...common,
      '        limit_except GET HEAD { deny all; }',
      `        alias ${routeNginxValue(route.pagesRuntimeConfigPath ?? '')};`,
      '        default_type application/javascript;',
      '        add_header Cache-Control "no-store" always;',
      '    }',
    ]);
    const fallbackLocations = [
      ...(route.pagesSpaFallback
        ? [
            `    location @${spaLocation} {`,
            ...common,
            '        limit_except GET HEAD { deny all; }',
            `        include ${routeNginxValue(route.pagesRouteIncludePath ?? '')};`,
            // SPA fallback covers app paths only: a missing path with a file extension answers 404 (the deployment's
            // 404.html when it has one), as on a preview.
            `        error_page 404 @${fallbackUrl ? notFoundLocation : notFoundPageLocation};`,
            '        if ($uri ~ "\\.[^/]+$") { return 404; }',
            `        try_files /index.html @${notFoundLocation};`,
            '        sub_filter_once on;',
            `        sub_filter '</head>' '<script src="${scopedConfigPath}"></script></head>';`,
            '    }',
            '',
          ]
        : []),
      ...(!fallbackUrl
        ? [
            // The deployment's top-level 404.html answers a missing path; without one the generic page does.
            `    location @${notFoundPageLocation} {`,
            ...common,
            `        include ${routeNginxValue(route.pagesRouteIncludePath ?? '')};`,
            `        try_files /404.html @${notFoundLocation};`,
            '        sub_filter_once on;',
            `        sub_filter '</head>' '<script src="${scopedConfigPath}"></script></head>';`,
            '    }',
            '',
            `    location @${notFoundLocation} {`,
            '        default_type text/html;',
            `        return 404 ${escapeNginxReturnText(OPFIELD_NOT_FOUND_HTML)};`,
            '    }',
            '',
          ]
        : []),
    ];
    return [
      `    location = ${path} {`,
      ...common,
      `        return 308 ${path}/;`,
      '    }',
      '',
      ...configLocation,
      '',
      // Keep this a normal prefix so the following dot-file regex can win;
      // `^~` would suppress regex locations and allow hidden files through.
      `    location ${path}/ {`,
      ...pageBody,
      '    }',
      '',
      ...fallbackLocations,
      `    location ~ ^${escaped}/\\. { deny all; }`,
    ].join('\n');
  }

  const body = [
    ...common,
    route.requestBuffering ? '        proxy_request_buffering on;' : '        proxy_request_buffering off;',
    route.responseBuffering ? '        proxy_buffering on;' : '        proxy_buffering off;',
    `        proxy_connect_timeout ${route.connectTimeoutSeconds}s;`,
    `        proxy_read_timeout ${route.readTimeoutSeconds}s;`,
    `        proxy_send_timeout ${route.sendTimeoutSeconds}s;`,
    ...advanced,
    ...(route.websocketSupport
      ? [
          '        proxy_http_version 1.1;',
          '        proxy_set_header Upgrade $http_upgrade;',
          '        proxy_set_header Connection "upgrade";',
        ]
      : ['        proxy_http_version 1.1;', '        proxy_set_header Connection "";']),
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '        proxy_set_header X-Forwarded-Host $host;',
    '        proxy_set_header X-Forwarded-Port $server_port;',
    `        proxy_pass ${upstream}${route.stripPrefix ? '/' : ''};`,
  ];
  const exact = [`    location = ${path} {`, ...body, '    }'];
  const prefix = [`    location ^~ ${path}/ {`, ...body, '    }'];
  return [...exact, '', ...prefix].join('\n');
}

Handlebars.registerHelper(
  'renderAdditionalRoutes',
  (
    routes: unknown,
    hostId: unknown,
    accessList: unknown,
    rateLimitEnabled: unknown,
    rateLimitBurst: unknown,
    connectionsPerIp: unknown
  ) => {
    if (!Array.isArray(routes) || routes.length === 0) return '';
    const rendered = routes
      .filter((route): route is ProxyAdditionalRouteConfig => Boolean(route && typeof route === 'object'))
      .sort((left, right) => right.path.length - left.path.length || left.path.localeCompare(right.path))
      .map((route) =>
        renderAdditionalRouteLocation(
          route,
          typeof hostId === 'string' ? hostId : '00000000-0000-0000-0000-000000000000',
          accessList as ProxyHostConfig['accessList'],
          rateLimitEnabled === true,
          typeof rateLimitBurst === 'number' ? rateLimitBurst : DEFAULT_RATE_LIMIT_BURST,
          typeof connectionsPerIp === 'number' ? connectionsPerIp : DEFAULT_CONNECTIONS_PER_IP
        )
      );
    return new Handlebars.SafeString(rendered.join('\n\n'));
  }
);

function accessListPasswordFile(accessListId: string): string {
  return `/etc/nginx/opfield/htpasswd/access-list-${accessListId.replace(DANGEROUS_CHARS, '')}`;
}

/**
 * The allow/deny rules of an access list for the maintenance guard's locations: a client the list denies gets 403
 * during maintenance too, never the maintenance page (deny wins). Basic authentication stays on the route itself.
 */
export function maintenanceAccessListDirectives(accessList: ProxyHostConfig['accessList']): string[] {
  if (!accessList || accessList.ipRules.length === 0) return [];
  return buildAccessListDirectives({ ...accessList, basicAuthEnabled: false });
}

function indentedDirectives(directives: readonly string[]): string {
  return directives.map((directive) => `\n        ${directive}`).join('');
}

function buildAccessListDirectives(accessList: ProxyHostConfig['accessList']): string[] {
  if (!accessList) return [];

  const directives = accessList.ipRules.map(
    (rule) => `${rule.type.replace(DANGEROUS_CHARS, '')} ${rule.value.replace(DANGEROUS_CHARS, '')};`
  );
  // A list that ends in its own "deny all" needs no second one.
  if (accessList.ipRules.length > 0 && directives.at(-1) !== 'deny all;') directives.push('deny all;');
  if (accessList.basicAuthEnabled) {
    directives.push('auth_basic "Restricted Access";');
    directives.push(`auth_basic_user_file ${accessListPasswordFile(accessList.id)};`);
  }
  return directives;
}

// ---------------------------------------------------------------------------
// Built-in template content
// ---------------------------------------------------------------------------

const BUILTIN_PROXY_TEMPLATE = `{{#if rateLimitEnabled}}
limit_req_zone $binary_remote_addr zone=ratelimit_{{id}}:10m rate={{rateLimitRPS}}r/s;
limit_conn_zone $binary_remote_addr zone=connlimit_{{id}}:10m;

{{/if}}
{{#if secureLinkUpstream}}
upstream {{secureLinkUpstreamName}} {
{{#if secureLinkUsesLoadBalancing}}    least_conn;
{{/if}}{{#each secureLinkSocketPaths}}    server unix:{{this}};
{{/each}}
    keepalive 64;
}

{{/if}}
{{#if registryAuthRealm}}
map $upstream_http_www_authenticate \${{registryAuthVariableName}} {
    default "";
    ~*^Bearer\\s+realm="[^"]+"(.*)$ 'Bearer realm="{{registryAuthRealm}}"$1';
}

{{/if}}
{{#if cacheEnabled}}
proxy_cache_path /tmp/nginx-cache-{{id}} levels=1:2 keys_zone=cache_{{id}}:10m max_size=100m inactive={{cacheMaxAge}}s;

{{/if}}
{{#if sslForced}}
server {
    listen 80;
    listen [::]:80;
    server_name {{serverNames}};

    location /.well-known/acme-challenge/ {
        alias /var/www/acme-challenge/.well-known/acme-challenge/;
        auth_basic off;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

{{/if}}
server {
{{#unless sslForced}}
    listen 80;
    listen [::]:80;
{{/unless}}
{{#if sslEnabled}}
    listen 443 ssl;
    listen [::]:443 ssl;
{{#if http2Support}}
    http2 on;
{{/if}}
{{/if}}
    server_name {{serverNames}};

{{#if sslEnabled}}
    ssl_certificate {{sslCertPath}};
    ssl_certificate_key {{sslKeyPath}};
{{#if sslChainPath}}
    ssl_trusted_certificate {{sslChainPath}};
{{/if}}

{{/if}}
    access_log {{logPath}}.access.log opfield_combined;
    error_log {{logPath}}.error.log warn;

{{#unless sslForced}}
    location /.well-known/acme-challenge/ {
        alias /var/www/acme-challenge/.well-known/acme-challenge/;
        auth_basic off;
    }

{{/unless}}
${ADDITIONAL_ROUTES_TEMPLATE_PLACEHOLDER}
{{#if pagesRouteIncludePath}}
    include {{pagesRouteIncludePath}};
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy same-origin always;
{{#if pagesFallbackUrl}}
    error_page 404 =302 {{pagesFallbackUrl}};
{{else}}
    error_page 404 @opfield_pages_404_{{id}};
{{/if}}
    location ~ /\\. { deny all; }

    location = ${PAGES_CONFIG_SCRIPT_PATH} {
{{#if accessList}}
{{#each accessList.ipRules}}
        {{sanitize this.type}} {{sanitize this.value}};
{{/each}}
{{#if accessListHasIpRules}}
        deny all;
{{/if}}
{{#if accessList.basicAuthEnabled}}
        auth_basic "Restricted Access";
        auth_basic_user_file /etc/nginx/opfield/htpasswd/access-list-{{accessList.id}};
{{/if}}

{{/if}}
{{#if rateLimitEnabled}}
        limit_req_status 429;
        limit_req zone=ratelimit_{{id}} burst={{rateLimitBurst}} nodelay;
        limit_conn_status 429;
        limit_conn connlimit_{{id}} {{connectionsPerIp}};
{{/if}}
        limit_except GET HEAD { deny all; }
        alias $opfield_pages_runtime_config_path;
        default_type application/javascript;
        add_header Cache-Control "no-store" always;
{{#each customHeaders}}
        add_header {{sanitize this.name}} "{{sanitize this.value}}" always;
{{/each}}
    }

    location = ${LEGACY_PAGES_CONFIG_SCRIPT_PATH} {
{{#if accessList}}
{{#each accessList.ipRules}}
        {{sanitize this.type}} {{sanitize this.value}};
{{/each}}
{{#if accessListHasIpRules}}
        deny all;
{{/if}}
{{#if accessList.basicAuthEnabled}}
        auth_basic "Restricted Access";
        auth_basic_user_file /etc/nginx/opfield/htpasswd/access-list-{{accessList.id}};
{{/if}}

{{/if}}
{{#if rateLimitEnabled}}
        limit_req_status 429;
        limit_req zone=ratelimit_{{id}} burst={{rateLimitBurst}} nodelay;
        limit_conn_status 429;
        limit_conn connlimit_{{id}} {{connectionsPerIp}};
{{/if}}
        limit_except GET HEAD { deny all; }
        alias $opfield_pages_runtime_config_path;
        default_type application/javascript;
        add_header Cache-Control "no-store" always;
{{#each customHeaders}}
        add_header {{sanitize this.name}} "{{sanitize this.value}}" always;
{{/each}}
    }

{{/if}}
    location / {
{{#if accessList}}
{{#each accessList.ipRules}}
        {{sanitize this.type}} {{sanitize this.value}};
{{/each}}
{{#if accessListHasIpRules}}
        deny all;
{{/if}}
{{#if accessList.basicAuthEnabled}}
        auth_basic "Restricted Access";
        auth_basic_user_file /etc/nginx/opfield/htpasswd/access-list-{{accessList.id}};
{{/if}}

{{/if}}
{{#if rateLimitEnabled}}
        limit_req_status 429;
        limit_req zone=ratelimit_{{id}} burst={{rateLimitBurst}} nodelay;
        limit_conn_status 429;
        limit_conn connlimit_{{id}} {{connectionsPerIp}};
{{/if}}
{{#if cacheEnabled}}
{{#if pagesRouteIncludePath}}
        expires {{cacheMaxAge}}s;
        add_header Cache-Control "public, max-age={{cacheMaxAge}}" always;
{{else}}
        proxy_cache cache_{{id}};
        proxy_cache_valid 200 301 302 {{cacheMaxAge}}s;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_background_update on;
        add_header X-Cache-Status $upstream_cache_status;
{{/if}}
{{/if}}
{{#if pagesRouteIncludePath}}
        limit_except GET HEAD { deny all; }
        sub_filter_once on;
        sub_filter '</head>' '<script src="${PAGES_CONFIG_SCRIPT_PATH}"></script></head>';
{{#if pagesSpaFallback}}
        try_files $uri $uri/ /index.html;
        # SPA fallback covers app paths only: a missing path with a file extension answers 404 (the deployment's
        # 404.html), as on a preview. Nested locations take the access list, limits and headers of this one.
        location ~ /\\. { deny all; }
        location ~ \\.[^/]+$ {
            limit_except GET HEAD { deny all; }
{{#each customRewrites}}
            rewrite {{sanitizeRewrite this.source}} {{sanitizeRewrite this.destination}} {{#if (eq this.type "permanent")}}permanent{{else}}redirect{{/if}};
{{/each}}
            try_files $uri =404;
        }
{{else}}
        try_files $uri $uri/ =404;
{{/if}}
{{else}}
{{#if secureLinkUpstream}}
        # opfield-managed-secure-link-upstream {{id}}
{{/if}}
{{#if registryAuthRealm}}
        proxy_hide_header WWW-Authenticate;
        add_header WWW-Authenticate \${{registryAuthVariableName}} always;
{{/if}}
        proxy_pass {{upstream}};

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
{{#if secureLinkUpstream}}
{{#unless websocketSupport}}
        proxy_http_version 1.1;
        proxy_set_header Connection "";
{{/unless}}
{{/if}}

        proxy_connect_timeout 60s;
        proxy_send_timeout {{#if websocketSupport}}2h{{else}}{{#if secureLinkUpstream}}2h{{else}}60s{{/if}}{{/if}};
        proxy_read_timeout {{#if websocketSupport}}2h{{else}}{{#if secureLinkUpstream}}2h{{else}}60s{{/if}}{{/if}};

{{#if websocketSupport}}
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

{{/if}}
{{/if}}
{{#each customHeaders}}
{{#if ../pagesRouteIncludePath}}
        add_header {{sanitize this.name}} "{{sanitize this.value}}" always;
{{else}}
        proxy_set_header {{sanitize this.name}} "{{sanitize this.value}}";
{{/if}}
{{/each}}
{{#each customRewrites}}
        rewrite {{sanitizeRewrite this.source}} {{sanitizeRewrite this.destination}} {{#if (eq this.type "permanent")}}permanent{{else}}redirect{{/if}};
{{/each}}
    }

{{#if pagesRouteIncludePath}}
{{#unless pagesFallbackUrl}}
    location @opfield_pages_404_{{id}} {
        try_files /404.html @opfield_pages_not_found_{{id}};
        sub_filter_once on;
        sub_filter '</head>' '<script src="${PAGES_CONFIG_SCRIPT_PATH}"></script></head>';
    }

    location @opfield_pages_not_found_{{id}} {
        default_type text/html;
        return 404 ${escapeNginxReturnText(OPFIELD_NOT_FOUND_HTML)};
    }
{{/unless}}
{{/if}}

{{#if advancedConfig}}
    {{{indent (applyAccessListToAdvancedLocations advancedConfig accessList) 4}}}
{{/if}}
}
`;

const BUILTIN_REDIRECT_TEMPLATE = `server {
    listen 80;
    listen [::]:80;
    server_name {{serverNames}};

    access_log {{logPath}}.access.log opfield_combined;
    error_log {{logPath}}.error.log warn;

    location /.well-known/acme-challenge/ {
        alias /var/www/acme-challenge/.well-known/acme-challenge/;
        auth_basic off;
    }

{{#if sslForced}}
    location / {
        return 301 https://$host$request_uri;
    }
{{else}}
    location / {
        return {{redirectStatusCode}} {{sanitize redirectUrl}};
    }
{{/if}}

{{#if advancedConfig}}
    {{{indent (applyAccessListToAdvancedLocations advancedConfig accessList) 4}}}
{{/if}}
}
{{#if sslEnabled}}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
{{#if http2Support}}
    http2 on;
{{/if}}
    server_name {{serverNames}};

{{#if sslCertPath}}
    ssl_certificate {{sslCertPath}};
{{/if}}
{{#if sslKeyPath}}
    ssl_certificate_key {{sslKeyPath}};
{{/if}}
{{#if sslChainPath}}
    ssl_trusted_certificate {{sslChainPath}};
{{/if}}

    access_log {{logPath}}.access.log opfield_combined;
    error_log {{logPath}}.error.log warn;

    location / {
        return {{redirectStatusCode}} {{sanitize redirectUrl}};
    }

{{#if advancedConfig}}
    {{{indent (applyAccessListToAdvancedLocations advancedConfig accessList) 4}}}
{{/if}}
}
{{/if}}
`;

const BUILTIN_DEAD_TEMPLATE = `server {
    listen 80;
    listen [::]:80;
    server_name {{serverNames}};

    access_log {{logPath}}.access.log opfield_combined;
    error_log {{logPath}}.error.log warn;

    location /.well-known/acme-challenge/ {
        alias /var/www/acme-challenge/.well-known/acme-challenge/;
        auth_basic off;
    }

    location / {
        default_type text/html;
        return 404 ${escapeNginxReturnText(OPFIELD_NOT_FOUND_HTML)};
    }
}
{{#if sslEnabled}}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
{{#if http2Support}}
    http2 on;
{{/if}}
    server_name {{serverNames}};

{{#if sslCertPath}}
    ssl_certificate {{sslCertPath}};
{{/if}}
{{#if sslKeyPath}}
    ssl_certificate_key {{sslKeyPath}};
{{/if}}
{{#if sslChainPath}}
    ssl_trusted_certificate {{sslChainPath}};
{{/if}}

    access_log {{logPath}}.access.log opfield_combined;
    error_log {{logPath}}.error.log warn;

    location / {
        default_type text/html;
        return 404 ${escapeNginxReturnText(OPFIELD_NOT_FOUND_HTML)};
    }
}
{{/if}}
`;

function maintenanceAccessVariable(hostId: string) {
  return hostId.replace(/-/g, '_');
}

/**
 * Map rules that remove one cookie from a Cookie header with the separator that joined it to its neighbours, so no
 * empty or leading `;` is left wherever it stood. Kept in step with maintenance_guard.go in the nginx daemon.
 */
function stripCookieRules(name: string) {
  return `"~^${name}=[^;]*(?:;\\s*(.*))?$" "$1";
    "~^(.*?);\\s*${name}=[^;]*(.*)$" "$1$2";`;
}

// The reserved health paths (current and legacy) both bypass maintenance: monitors of customers probe the
// pre-Opfield one (legacy-name: remove once no customer monitor probes it).
function maintenanceMaps(hostId: string) {
  const suffix = maintenanceAccessVariable(hostId);
  return `map "$uri:$secure_link" $gm_block_${suffix} {
    default 1;
    ~^/\\.well-known/acme-challenge/ 0;
    ~^/\\.well-known/(?:opfield-ingress-health|${LEGACY_INGRESS_HEALTH_NAME}): 0;
    ~^/\\.well-known/opfield-error: 0;
    ~^/_opfield/maintenance-access: 0;
    ~^/_opfield/maintenance-access/status: 0;
    ~:1$ 0;
}

map $secure_link $gm_active_${suffix} {
    default false;
    "1" true;
}

map $http_cookie $gms_${suffix} {
    default $http_cookie;
    ${stripCookieRules('opfield_maintenance_access_sig')}
}

map $gms_${suffix} $gm_cookie_${suffix} {
    default $gms_${suffix};
    ${stripCookieRules('opfield_maintenance_access_exp')}
}
`;
}

function maintenanceAccessLocation(hostId: string, acl: string) {
  const suffix = maintenanceAccessVariable(hostId);
  return `
    location = /_opfield/maintenance-access {${acl}
        proxy_pass http://unix:/run/nginx-daemon/maintenance-access.sock:/redeem/${hostId};
        proxy_set_header Host $host;
        proxy_set_header X-Opfield-Maintenance-Host $host;
        proxy_set_header X-Opfield-Maintenance-Secure $https;
        proxy_set_header Cookie "";
        proxy_connect_timeout 5s;
        proxy_send_timeout 5s;
        proxy_read_timeout 5s;
    }

    location = /_opfield/maintenance-access/status {${acl}
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
        return 200 '{"active":$gm_active_${suffix}}';
    }
`;
}

/**
 * The internal location that answers with the maintenance page. Its name is not a URI, so no request reaches it except
 * through the guard's rewrite. The page keeps the server-level add_header of the route and of the guard; default_type
 * is set here because a route may set its own on the server, where a second one fails nginx -t. It answers after the
 * access phase (MAINTENANCE_ABSENT_FILE), so the access list's deny wins over the page.
 */
const MAINTENANCE_PAGE_LOCATION = 'opfield-maintenance';

function maintenancePageLocation(hideExternalBranding: boolean, teamAccess: boolean, acl: string) {
  return `
    location = ${MAINTENANCE_PAGE_LOCATION} {
        internal;${acl}
        error_page 503 @opfield-maintenance-page;
        try_files ${MAINTENANCE_ABSENT_FILE} =503;
    }

    location @opfield-maintenance-page {
        default_type text/html;
        return 503 ${escapeNginxReturnText(opfieldMaintenanceHtml(hideExternalBranding, teamAccess))};
    }
`;
}

function maintenanceServerGuard(hostId: string, accessSecret: string, hideExternalBranding: boolean, acl: string) {
  const suffix = maintenanceAccessVariable(hostId);
  return `
    # Opfield maintenance mode. Server-rewrite directives run before location
    # selection, so upstream/access/cache/rewrite behavior is never reached.
    add_header Cache-Control "no-store" always;
    secure_link "$cookie_opfield_maintenance_access_sig,$cookie_opfield_maintenance_access_exp";
    secure_link_md5 "\${secure_link_expires}\${host}${accessSecret}";
    if ($gm_block_${suffix}) {
        rewrite ^ ${MAINTENANCE_PAGE_LOCATION} last;
    }
${maintenancePageLocation(hideExternalBranding, true, acl)}${maintenanceAccessLocation(hostId, acl)}`;
}

/** The guard without the access-code bypass: every request but ACME and the ingress health check gets the page. */
function plainMaintenanceServerGuard(hideExternalBranding: boolean, acl: string) {
  return `
    # Opfield maintenance mode. Server-rewrite directives run before location
    # selection, so upstream/access/cache/rewrite behavior is never reached.
    add_header Cache-Control "no-store" always;
    if ($uri !~ ^/\\.well-known/(acme-challenge/|(?:opfield-ingress-health|${LEGACY_INGRESS_HEALTH_NAME})$|opfield-error$)) {
        rewrite ^ ${MAINTENANCE_PAGE_LOCATION} last;
    }
${maintenancePageLocation(hideExternalBranding, false, acl)}`;
}

/**
 * Whether the access-code bypass fits the route's config. It sets secure_link on the server, defines the $gm_*
 * variables of maintenanceMaps and the /_opfield/maintenance-access locations. A route that sets secure_link itself
 * would get a second server-level secure_link (nginx -t fails) or, in its own locations, Opfield's $secure_link; such
 * a config, or one that uses those variables or locations, gets the maintenance page without team access.
 */
function maintenanceAccessFits(renderedConfig: string): boolean {
  return !(
    /(?:^|[\s;{}])secure_link(?:_md5|_secret)?[\s;]/m.test(renderedConfig) ||
    /\$\{?(?:secure_link|gms?_)/.test(renderedConfig) ||
    // legacy-name: the legacy maintenance access location of configs written before 2.12.1 — remove once every node reports none
    new RegExp(
      String.raw`\blocation\s*=\s*(?:\/_opfield|${LEGACY_RESERVED_PATH_PREFIX.replaceAll('/', '/')})\/maintenance-access(?:\/status)?[\s{]`
    ).test(renderedConfig)
  );
}

/** A location named like the guard's page location would be a duplicate location in nginx -t. */
function declaresMaintenancePageLocation(renderedConfig: string): boolean {
  // legacy-name: the legacy maintenance locations of configs written before 2.12.1 — remove once every node reports none
  const prefix = `(?:opfield-|${LEGACY_NGINX_MARK_PREFIX})`;
  return new RegExp(
    String.raw`\blocation\s*(?:=\s*${prefix}maintenance|@${prefix}maintenance-(?:page|state))[\s{]`
  ).test(renderedConfig);
}

const BUILTIN_TEMPLATES = [
  {
    name: 'Default Proxy',
    description: 'Standard reverse proxy with SSL, caching, rate limiting, WebSocket, and access control support.',
    type: 'proxy' as const,
    content: BUILTIN_PROXY_TEMPLATE,
    variables: DEFAULT_PROXY_TEMPLATE_VARIABLES,
  },
  {
    name: 'Default Redirect',
    description: 'HTTP redirect with optional SSL termination.',
    type: 'redirect' as const,
    content: BUILTIN_REDIRECT_TEMPLATE,
    variables: [],
  },
  {
    name: 'Default 404',
    description: 'Returns 404 for all requests. Use to block domains.',
    type: '404' as const,
    content: BUILTIN_DEAD_TEMPLATE,
    variables: [],
  },
];

// ---------------------------------------------------------------------------
// Sample context for preview
// ---------------------------------------------------------------------------

const SAMPLE_CONTEXT = {
  id: '00000000-0000-0000-0000-000000000000',
  serverNames: 'example.com www.example.com',
  upstream: 'http://10.0.0.1:8080',
  forwardScheme: 'http',
  forwardHost: '10.0.0.1',
  forwardPort: 8080,
  sslEnabled: true,
  sslForced: true,
  http2Support: true,
  websocketSupport: false,
  sslCertPath: '/etc/nginx/certs/example.com.crt',
  sslKeyPath: '/etc/nginx/certs/example.com.key',
  sslChainPath: null,
  redirectUrl: 'https://example.com',
  redirectStatusCode: 301,
  cacheEnabled: false,
  cacheMaxAge: 3600,
  cacheStale: 60,
  rateLimitMode: 'inherit',
  rateLimitEnabled: true,
  rateLimitRPS: DEFAULT_RATE_LIMIT_RPS,
  rateLimitBurst: DEFAULT_RATE_LIMIT_BURST,
  connectionsPerIp: DEFAULT_CONNECTIONS_PER_IP,
  customHeaders: [],
  customRewrites: [],
  accessList: null,
  advancedConfig: null,
  logPath: '/var/log/nginx/proxy-00000000',
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class NginxTemplateService {
  private eventBus?: EventBusService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly configValidator: ConfigValidatorService = new ConfigValidatorService()
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  private emitTemplate(id: string, action: string, extra: Record<string, unknown> = {}) {
    this.eventBus?.publish('nginx.template.changed', { id, action, ...extra });
  }

  // -----------------------------------------------------------------------
  // Seed built-in templates
  // -----------------------------------------------------------------------

  async seedBuiltinTemplates(): Promise<void> {
    for (const template of BUILTIN_TEMPLATES) {
      const existing = await this.db.query.nginxTemplates.findFirst({
        where: (t, { and, eq }) => and(eq(t.name, template.name), eq(t.isBuiltin, true)),
      });
      if (!existing) {
        await this.db.insert(nginxTemplates).values({
          ...template,
          isBuiltin: true,
        });
        logger.info('Seeded built-in nginx template', { name: template.name });
      } else if (
        existing.content !== template.content ||
        JSON.stringify(existing.variables ?? []) !== JSON.stringify(template.variables)
      ) {
        const [updated] = await this.db
          .update(nginxTemplates)
          .set({ content: template.content, variables: template.variables, updatedAt: new Date() })
          .where(eq(nginxTemplates.id, existing.id))
          .returning();
        logger.info('Updated built-in nginx template', { name: template.name });
        this.emitTemplate(updated.id, 'updated', {
          type: updated.type,
          isBuiltin: true,
          renderingChanged: true,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  async listTemplates(options?: { allowedIds?: string[] }) {
    if (options?.allowedIds?.length === 0) return [];
    return this.db.query.nginxTemplates.findMany({
      where: options?.allowedIds ? inArray(nginxTemplates.id, options.allowedIds) : undefined,
      orderBy: (t, { asc }) => [asc(t.name)],
    });
  }

  async getTemplate(id: string) {
    const template = await this.db.query.nginxTemplates.findFirst({
      where: eq(nginxTemplates.id, id),
    });
    if (!template) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Nginx template not found');
    return template;
  }

  /**
   * Deny-list errors for template content written by a caller without broad proxy:unrestricted. Template content
   * is raw nginx configuration of every route that uses the template, so it follows the raw config deny-list. A
   * test also checks what the content rendered with sample data, because that output goes to a node.
   */
  templateContentErrors(content: string, scopes: readonly string[], sampleRendered?: string): string[] {
    if (hasScope(scopes, 'proxy:unrestricted')) return [];
    const source = this.configValidator.validateTemplate(content);
    if (!source.valid || sampleRendered === undefined) return source.errors;
    return this.configValidator.validateRenderedTemplate(sampleRendered).errors;
  }

  private assertTemplateContentAllowed(content: string, scopes: readonly string[]): void {
    const errors = this.templateContentErrors(content, scopes);
    if (errors.length > 0) {
      throw new AppError(
        400,
        'INVALID_TEMPLATE_CONTENT',
        `Template content needs proxy:unrestricted: ${errors.join('; ')}`
      );
    }
  }

  /**
   * Changed content reaches every route that uses the template. Without the broad grant (a folder or template
   * grant) the caller changes it only when they may edit each of those routes, so a folder grant cannot rewrite
   * routes outside the caller's own.
   */
  private async assertTemplateRoutesEditable(templateId: string, scopes: readonly string[]): Promise<void> {
    if (hasScope(scopes, 'proxy:templates:manage')) return;
    const routes = await this.db
      .select({ id: proxyHosts.id })
      .from(proxyHosts)
      .where(eq(proxyHosts.nginxTemplateId, templateId));
    const holds = scopeMatcher(scopes);
    const blocked = routes.filter((route) => !holds(`proxy:edit:${route.id}`));
    if (blocked.length > 0) {
      throw new AppError(
        403,
        'TEMPLATE_ROUTES_FORBIDDEN',
        `Template content is used by ${blocked.length} route(s) you cannot edit`,
        { requiredScope: `proxy:edit:${blocked[0]!.id}` }
      );
    }
  }

  async createTemplate(input: CreateNginxTemplateInput, userId: string, scopes: readonly string[]) {
    // Validate the template compiles
    this.compileTemplate(input.content);
    this.assertTemplateContentAllowed(input.content, scopes);

    const [template] = await this.db
      .insert(nginxTemplates)
      .values({
        ...input,
        createdById: userId,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'nginx_template.create',
      resourceType: 'nginx_template',
      resourceId: template.id,
      details: { name: template.name },
    });

    this.emitTemplate(template.id, 'created');
    return template;
  }

  async updateTemplate(id: string, input: UpdateNginxTemplateInput, userId: string, scopes: readonly string[]) {
    const existing = await this.getTemplate(id);
    if (existing.isBuiltin) throw new AppError(403, 'BUILTIN_IMMUTABLE', 'Built-in templates cannot be modified');

    if (input.content !== undefined) {
      this.compileTemplate(input.content);
      this.assertTemplateContentAllowed(input.content, scopes);
      await this.assertTemplateRoutesEditable(id, scopes);
    }
    const [updated] = await this.db
      .update(nginxTemplates)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(nginxTemplates.id, id))
      .returning();

    await this.auditService.log({
      userId,
      action: 'nginx_template.update',
      resourceType: 'nginx_template',
      resourceId: id,
      details: { changes: Object.keys(input) },
    });

    this.emitTemplate(id, 'updated', {
      type: updated.type,
      isBuiltin: updated.isBuiltin,
      renderingChanged: input.content !== undefined || input.variables !== undefined,
    });
    return updated;
  }

  async deleteTemplate(id: string, userId: string) {
    const existing = await this.getTemplate(id);
    if (existing.isBuiltin) throw new AppError(403, 'BUILTIN_IMMUTABLE', 'Built-in templates cannot be deleted');

    // Check no proxy hosts using it
    const [{ count: usageCount }] = await this.db
      .select({ count: count() })
      .from(proxyHosts)
      .where(eq(proxyHosts.nginxTemplateId, id));

    if (Number(usageCount) > 0) {
      throw new AppError(400, 'TEMPLATE_IN_USE', `Template is used by ${usageCount} route(s)`);
    }

    await transactionWithScopeCleanup(this.db, (tx) => tx.delete(nginxTemplates).where(eq(nginxTemplates.id, id)));

    await this.auditService.log({
      userId,
      action: 'nginx_template.delete',
      resourceType: 'nginx_template',
      resourceId: id,
      details: { name: existing.name },
    });

    this.emitTemplate(id, 'deleted');
  }

  async cloneTemplate(id: string, userId: string, scopes: readonly string[]) {
    const existing = await this.getTemplate(id);
    // A copy is new content written by the caller.
    this.assertTemplateContentAllowed(existing.content, scopes);

    const [clone] = await this.db
      .insert(nginxTemplates)
      .values({
        name: `Copy of ${existing.name}`,
        description: existing.description,
        type: existing.type,
        content: existing.content,
        variables: existing.variables ?? [],
        createdById: userId,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'nginx_template.clone',
      resourceType: 'nginx_template',
      resourceId: clone.id,
      details: { sourceId: id, sourceName: existing.name },
    });

    this.emitTemplate(clone.id, 'created');
    return clone;
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  renderTemplate(content: string, host: ProxyHostConfig): string {
    return this.renderTemplateWithAdvancedConfig(content, host).rendered;
  }

  private renderTemplateWithAdvancedConfig(
    content: string,
    host: ProxyHostConfig
  ): { rendered: string; advancedConfig: string | null } {
    const template = this.compileTemplate(upgradeLegacyRewriteArguments(content));
    const baseContext = this.buildBaseContext(host);
    const advancedConfig = host.advancedConfig ? this.renderTemplateString(host.advancedConfig, baseContext) : null;
    if (advancedConfig) {
      const sourceValidation = this.configValidator.validate(host.advancedConfig!, false);
      const renderedValidation = this.configValidator.validate(advancedConfig, false);
      if (sourceValidation.valid && !renderedValidation.valid) {
        throw new AppError(
          400,
          'INVALID_ADVANCED_CONFIG_TEMPLATE',
          `Rendered advanced config is unsafe: ${renderedValidation.errors.join('; ')}`
        );
      }
    }
    const context = {
      ...baseContext,
      advancedConfig,
    };
    return { rendered: template(context), advancedConfig };
  }

  /**
   * Handlebars can assemble any directive from literals and route values, so what a custom template renders gets
   * the raw deny-list as well. Content that fails the deny-list itself was written with broad proxy:unrestricted
   * (or before template content was checked) and renders as written.
   */
  private assertCustomTemplateRender(
    content: string,
    rendered: string,
    advancedConfig: string | null,
    host: ProxyHostConfig
  ): void {
    if (!this.configValidator.validateTemplate(content).valid) return;
    const includePaths = [
      host.pagesRouteIncludePath,
      ...(host.additionalRoutes ?? []).map((route) =>
        route.pagesRouteIncludePath ? routeNginxValue(route.pagesRouteIncludePath) : undefined
      ),
    ].filter((path): path is string => Boolean(path));
    const validation = this.configValidator.validateRenderedTemplate(rendered, {
      statements: [
        ...includePaths.map((path) => ['include', path]),
        ...(host.accessList
          ? [
              ['auth_basic_user_file', accessListPasswordFile(host.accessList.id)],
              // legacy-name: custom templates saved before 2.12.1 name the pre-Opfield htpasswd directory — remove once
              // every node reports none
              ['auth_basic_user_file', toLegacyNginxNames(accessListPasswordFile(host.accessList.id))],
            ]
          : []),
      ],
      snippets: [
        ...(advancedConfig ? [advancedConfig] : []),
        ...(host.additionalRoutes ?? []).flatMap((route) => (route.advancedConfig ? [route.advancedConfig] : [])),
      ],
    });
    if (!validation.valid) {
      throw new AppError(
        400,
        'INVALID_TEMPLATE_RENDER',
        `Template renders forbidden nginx directives for this route: ${validation.errors.join('; ')}`
      );
    }
  }

  async getBuiltinTemplateContent(type: string): Promise<string> {
    const template = await this.db.query.nginxTemplates.findFirst({
      where: (t, { and, eq }) => and(eq(t.type, type as any), eq(t.isBuiltin, true)),
    });
    if (template) return template.content;

    // Fallback to hardcoded if DB not seeded yet
    switch (type) {
      case 'proxy':
        return BUILTIN_PROXY_TEMPLATE;
      case 'redirect':
        return BUILTIN_REDIRECT_TEMPLATE;
      case '404':
        return BUILTIN_DEAD_TEMPLATE;
      default:
        return `# No built-in template for type: ${type}\n`;
    }
  }

  async renderForHost(host: ProxyHostConfig, templateId: string | null, hideExternalBranding = false): Promise<string> {
    let content: string;
    let customTemplate = false;
    let supportsAdditionalRoutes = !templateId;
    if (templateId) {
      const template = await this.getTemplate(templateId);
      content = template.content;
      customTemplate = !template.isBuiltin;
      supportsAdditionalRoutes =
        template.type === 'proxy' && (template.isBuiltin || supportsAdditionalRoutesTemplate(template.content));
    } else {
      content = await this.getBuiltinTemplateContent(host.type);
    }
    const { rendered: renderedTemplate, advancedConfig } = this.renderTemplateWithAdvancedConfig(content, host);
    if (customTemplate) this.assertCustomTemplateRender(content, renderedTemplate, advancedConfig, host);
    const rendered = normalizeAcmeChallengeAlias(this.applyUpstreamIpFamily(renderedTemplate, host)).replaceAll(
      escapeNginxReturnText(OPFIELD_NOT_FOUND_HTML),
      escapeNginxReturnText(opfieldNotFoundHtml(hideExternalBranding))
    );
    const withSecureLinkUpstreams = this.ensureManagedAdditionalSecureLinkUpstreams(
      this.ensureManagedSecureLinkUpstream(rendered, host),
      host
    );
    const withUpstreams = supportsAdditionalRoutes
      ? this.ensureManagedAdditionalRouteUpstreams(withSecureLinkUpstreams, host)
      : withSecureLinkUpstreams;
    const result = withAvailabilityNextUpstream(
      withUpstreams,
      availabilityUpstreamNames(host, supportsAdditionalRoutes)
    );
    return host.statusPageStaleCache && host.type === 'proxy'
      ? withStatusPageStaleCache(result, host.id, hideExternalBranding)
      : result;
  }

  private applyUpstreamIpFamily(rendered: string, host: ProxyHostConfig): string {
    const forwardHost = host.forwardHost?.replace(DANGEROUS_CHARS, '') ?? '';
    if (
      host.type !== 'proxy' ||
      host.upstreamIpv6Enabled === true ||
      host.secureLinkUpstream ||
      isIP(forwardHost) !== 0 ||
      !forwardHost ||
      !host.forwardPort
    ) {
      return rendered;
    }

    const staticUpstream = `${host.forwardScheme}://${formatHostPort(forwardHost, host.forwardPort)}`;
    const variableName = `opf_up_${createHash('sha256').update(host.id).digest('hex').slice(0, 16)}`;
    const dynamicUpstream = `${host.forwardScheme}://$${variableName}:${host.forwardPort}`;
    if (!rendered.includes(staticUpstream)) return rendered;

    const ipv4Resolvers = getDnsResolverServers().filter((server) => {
      const separator = server.lastIndexOf(':');
      const address = separator > -1 ? server.slice(0, separator) : server;
      return isIP(address) === 4 || isIP(server) === 4;
    });
    if (ipv4Resolvers.length === 0) {
      throw new AppError(
        500,
        'NGINX_IPV4_RESOLVER_REQUIRED',
        'At least one IPv4 DNS resolver is required when upstream IPv6 support is disabled'
      );
    }

    const withDynamicUpstream = rendered.replaceAll(staticUpstream, dynamicUpstream);
    const resolverDirective = `resolver ${ipv4Resolvers.join(' ')} valid=300s ipv6=off;`;
    const withResolvers = this.ensureResolverForDynamicUpstream(
      withDynamicUpstream,
      dynamicUpstream,
      resolverDirective
    );
    return `map $host $${variableName} {\n    default "${forwardHost}";\n}\n\n${withResolvers}`;
  }

  private ensureResolverForDynamicUpstream(rendered: string, dynamicUpstream: string, directive: string): string {
    const serverPattern = /^[\t ]*server[\t ]*\{/gm;
    const edits: Array<{ start: number; end: number; replacement: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = serverPattern.exec(rendered))) {
      const openingBrace = rendered.indexOf('{', match.index);
      const closingBrace = this.findMatchingBrace(rendered, openingBrace);
      if (closingBrace < 0) break;
      const body = rendered.slice(openingBrace + 1, closingBrace);
      if (body.includes(dynamicUpstream)) {
        const existingResolver = /^[\t ]*resolver[\t ]+([^;]+);/m.exec(body);
        if (!existingResolver) {
          edits.push({ start: openingBrace + 1, end: openingBrace + 1, replacement: `\n    ${directive}` });
        } else if (!/(?:^|\s)ipv6=off(?:\s|$)/.test(existingResolver[1]!)) {
          const start = openingBrace + 1 + existingResolver.index;
          const options = existingResolver[1]!.replace(/(?:^|\s)ipv6=\S+/g, '').trim();
          edits.push({
            start,
            end: start + existingResolver[0].length,
            replacement: `    resolver ${options} ipv6=off;`,
          });
        }
      }
      serverPattern.lastIndex = closingBrace + 1;
    }

    let result = rendered;
    for (const edit of edits.reverse()) {
      result = `${result.slice(0, edit.start)}${edit.replacement}${result.slice(edit.end)}`;
    }
    return result;
  }

  private findMatchingBrace(value: string, openingBrace: number): number {
    let depth = 0;
    let quote: '"' | "'" | null = null;
    let inComment = false;
    for (let index = openingBrace; index < value.length; index++) {
      const char = value[index]!;
      if (inComment) {
        if (char === '\n') inComment = false;
        continue;
      }
      if (quote) {
        if (char === quote && value[index - 1] !== '\\') quote = null;
        continue;
      }
      if (char === '#') {
        inComment = true;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '{') depth += 1;
      if (char === '}' && --depth === 0) return index;
    }
    return -1;
  }

  private ensureManagedAdditionalSecureLinkUpstreams(rendered: string, host: ProxyHostConfig): string {
    const declarations = (host.additionalSecureLinks ?? []).flatMap((binding) => {
      const upstreamName = `opfield_additional_secure_link_${binding.id.replace(/-/g, '_')}`;
      const declaration = new RegExp(`(^|\\n)[\\t ]*upstream[\\t ]+${upstreamName}[\\t ]*\\{`, 'm');
      if (declaration.test(rendered)) return [];
      const socketPaths = binding.socketPaths?.length ? binding.socketPaths : [binding.socketPath];
      return [
        `upstream ${upstreamName} {\n${managedSecureLinkUpstreamBody(socketPaths, Boolean(binding.socketPaths?.length))}\n}`,
      ];
    });
    return declarations.length > 0 ? `${declarations.join('\n\n')}\n\n${rendered}` : rendered;
  }

  private ensureManagedAdditionalRouteUpstreams(rendered: string, host: ProxyHostConfig): string {
    const declarations = (host.additionalRoutes ?? [])
      .filter(
        (route) => route.secureLinkUpstream && (route.secureLinkSocketPath || route.secureLinkSocketPaths?.length)
      )
      .flatMap((route) => {
        const upstreamName = `opfield_additional_secure_link_${route.id.replace(/-/g, '_')}`;
        const declaration = new RegExp(`(^|\\n)[\\t ]*upstream[\\t ]+${upstreamName}[\\t ]*\\{`, 'm');
        if (declaration.test(rendered)) return [];
        const socketPaths = route.secureLinkSocketPaths?.length
          ? route.secureLinkSocketPaths
          : [route.secureLinkSocketPath!];
        return [
          `upstream ${upstreamName} {\n${managedSecureLinkUpstreamBody(socketPaths, Boolean(route.secureLinkSocketPaths?.length))}\n}`,
        ];
      });
    return declarations.length > 0 ? `${declarations.join('\n\n')}\n\n${rendered}` : rendered;
  }

  private ensureManagedSecureLinkUpstream(rendered: string, host: ProxyHostConfig): string {
    if (!host.secureLinkUpstream) return rendered;

    const upstreamName = `opfield_secure_link_${host.id.replace(/-/g, '_')}`;
    const upstreamDeclaration = new RegExp(`(^|\\n)[\\t ]*upstream[\\t ]+${upstreamName}[\\t ]*\\{`, 'm');
    const socketPaths = host.secureLinkSocketPaths?.length
      ? host.secureLinkSocketPaths
      : [host.secureLinkSocketPath ?? `/run/opfield-secure-links/${host.id}.sock`];
    const declaration = `upstream ${upstreamName} {
${managedSecureLinkUpstreamBody(socketPaths, Boolean(host.secureLinkSocketPaths?.length))}
}`;
    if (upstreamDeclaration.test(rendered)) {
      return rendered.replace(new RegExp(`upstream[\\t ]+${upstreamName}[\\t ]*\\{[^}]*\\}`, 'm'), declaration);
    }
    return `${declaration}

${rendered}`;
  }

  /**
   * The maintenance guard a node that keeps maintenance flags runs in and out of maintenance (see
   * nginx-maintenance-flag-guard.ts), or null when the config keeps the guard below.
   */
  applyMaintenanceFlagGuard(
    renderedConfig: string,
    access: { hostId: string; secret: string },
    hideExternalBranding = false,
    accessList: ProxyHostConfig['accessList'] = null
  ): string | null {
    return renderMaintenanceFlagGuard(renderedConfig, {
      ...access,
      pageText: escapeNginxReturnText(opfieldMaintenanceHtml(hideExternalBranding)),
      accessDirectives: maintenanceAccessListDirectives(accessList),
    });
  }

  /**
   * The guard a route runs only during maintenance (each toggle reloads nginx). With `access` it lets a visitor with a
   * team access cookie through, unless the route's config cannot carry that (maintenanceAccessFits): it then gets the
   * page without team access, as on a node without maintenance access support.
   */
  applyMaintenanceGuard(
    renderedConfig: string,
    access?: { hostId: string; secret: string },
    hideExternalBranding = false,
    accessList: ProxyHostConfig['accessList'] = null
  ): string {
    // The access list's allow/deny rules guard the maintenance locations too: deny wins over maintenance.
    const acl = indentedDirectives(maintenanceAccessListDirectives(accessList));
    if (!/^[\t ]*server[\t ]*\{/m.test(renderedConfig)) {
      throw new AppError(500, 'MAINTENANCE_CONFIG_INVALID', 'Rendered proxy config has no server block');
    }
    if (declaresMaintenancePageLocation(renderedConfig)) {
      throw new AppError(
        409,
        'MAINTENANCE_CONFIG_CONFLICT',
        `The route config declares location ${MAINTENANCE_PAGE_LOCATION}, which maintenance mode uses; rename it to enter maintenance`
      );
    }
    if (!access || !maintenanceAccessFits(renderedConfig)) {
      return renderedConfig.replace(
        /^[\t ]*server[\t ]*\{/gm,
        (match) => `${match}${plainMaintenanceServerGuard(hideExternalBranding, acl)}`
      );
    }
    const cookieDirective = `proxy_set_header Cookie $gm_cookie_${maintenanceAccessVariable(access.hostId)};`;
    const guarded = this.appendLocationDirective(this.stripProxyCookieHeaders(renderedConfig), cookieDirective).replace(
      /^[\t ]*server[\t ]*\{/gm,
      (match) => `${match}${maintenanceServerGuard(access.hostId, access.secret, hideExternalBranding, acl)}`
    );
    return `${maintenanceMaps(access.hostId)}\n${guarded}`;
  }

  /**
   * A location-level proxy_set_header disables server-level inheritance and
   * duplicate Cookie headers can be forwarded independently. Replace every
   * rendered Cookie override with the managed, sanitized value below. This
   * operates only on the generated deployment config; no stored user config
   * is edited.
   */
  private stripProxyCookieHeaders(renderedConfig: string): string {
    return renderedConfig.replace(/(^|[;{}])\s*proxy_set_header\s+Cookie\s+[^;]*;/gim, '$1');
  }

  private appendLocationDirective(renderedConfig: string, directive: string): string {
    let result = '';
    let header = '';
    let quote: '"' | "'" | null = null;
    let inComment = false;
    const blocks: boolean[] = [];

    for (let index = 0; index < renderedConfig.length; index++) {
      const char = renderedConfig[index]!;
      if (inComment) {
        result += char;
        if (char === '\n') inComment = false;
        continue;
      }
      if (quote) {
        result += char;
        if (char === quote && renderedConfig[index - 1] !== '\\') quote = null;
        continue;
      }
      if (char === '#') {
        result += char;
        inComment = true;
        continue;
      }
      if (char === '"' || char === "'") {
        result += char;
        quote = char;
        continue;
      }
      if (char === '{') {
        blocks.push(/^\s*location\b/i.test(header));
        header = '';
        result += char;
        continue;
      }
      if (char === '}') {
        if (blocks.pop()) result += `\n        ${directive}\n`;
        header = '';
        result += char;
        continue;
      }
      result += char;
      if (char === ';') header = '';
      else header += char;
    }
    return result;
  }

  previewWithSampleData(content: string): string {
    return this.renderTemplateString(content, SAMPLE_CONTEXT);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private compileTemplate(content: string): HandlebarsTemplateDelegate {
    try {
      return Handlebars.compile(content, { noEscape: true });
    } catch (err) {
      throw new AppError(
        400,
        'INVALID_TEMPLATE',
        `Template compilation error: ${err instanceof Error ? err.message : 'unknown'}`
      );
    }
  }

  private renderTemplateString(content: string, context: Record<string, unknown>): string {
    const template = this.compileTemplate(content);
    return template(context);
  }

  private buildBaseContext(host: ProxyHostConfig): Record<string, unknown> {
    const serverNames = host.domainNames.map((d) => d.replace(DANGEROUS_CHARS, '')).join(' ');
    const sanitizedHost = host.forwardHost ? host.forwardHost.replace(DANGEROUS_CHARS, '') : '';
    const secureLinkUpstreamName = `opfield_secure_link_${host.id.replace(/-/g, '_')}`;
    const secureLinkSocketPath = host.secureLinkSocketPath ?? `/run/opfield-secure-links/${host.id}.sock`;
    const secureLinkSocketPaths = host.secureLinkSocketPaths?.length
      ? host.secureLinkSocketPaths
      : [secureLinkSocketPath];
    const registryAuthRealm = host.registryAuthRealm?.replace(DANGEROUS_CHARS, '');
    const upstream = host.secureLinkUpstream
      ? `${host.forwardScheme}://${secureLinkUpstreamName}`
      : `${host.forwardScheme}://${formatHostPort(sanitizedHost, host.forwardPort ?? 0)}`;

    const opts = (host.rateLimitOptions ?? {}) as Record<string, unknown>;
    const cacheOpts = (host.cacheOptions ?? {}) as Record<string, unknown>;
    const templateVariables = this.sanitizeTemplateVariables(
      withoutReservedTemplateVariables(host.templateVariables ?? {})
    );
    const cacheEnabled =
      typeof templateVariables.cacheEnabled === 'boolean' ? templateVariables.cacheEnabled : host.cacheEnabled;
    const cacheMaxAge =
      typeof templateVariables.cacheMaxAge === 'number' ? templateVariables.cacheMaxAge : (cacheOpts.maxAge ?? 3600);
    const configuredRateLimitMode =
      templateVariables.rateLimitMode === 'inherit' ||
      templateVariables.rateLimitMode === 'custom' ||
      templateVariables.rateLimitMode === 'disabled'
        ? templateVariables.rateLimitMode
        : (host.rateLimitMode ?? (host.rateLimitEnabled ? 'custom' : 'inherit'));
    const rateLimitRPS =
      configuredRateLimitMode === 'custom'
        ? typeof templateVariables.rateLimitRPS === 'number'
          ? templateVariables.rateLimitRPS
          : (opts.requestsPerSecond ?? DEFAULT_RATE_LIMIT_RPS)
        : DEFAULT_RATE_LIMIT_RPS;
    const rateLimitBurst =
      configuredRateLimitMode === 'custom'
        ? typeof templateVariables.rateLimitBurst === 'number'
          ? templateVariables.rateLimitBurst
          : (opts.burst ?? DEFAULT_RATE_LIMIT_BURST)
        : DEFAULT_RATE_LIMIT_BURST;
    const connectionsPerIp =
      configuredRateLimitMode === 'custom'
        ? typeof templateVariables.connectionsPerIp === 'number'
          ? templateVariables.connectionsPerIp
          : (opts.connectionsPerIp ?? DEFAULT_CONNECTIONS_PER_IP)
        : DEFAULT_CONNECTIONS_PER_IP;
    const additionalSecureLinks = Object.fromEntries(
      (host.additionalSecureLinks ?? []).map((binding) => [
        binding.name,
        `${binding.scheme}://opfield_additional_secure_link_${binding.id.replace(/-/g, '_')}`,
      ])
    );

    return {
      // Custom variables stay available to user templates, but every managed
      // built-in below is written after them so a stored or submitted variable
      // can never replace the upstream, access list, TLS or log paths.
      ...templateVariables,
      id: host.id,
      serverNames,
      upstream,
      forwardScheme: host.forwardScheme,
      forwardHost: sanitizedHost,
      forwardPort: host.forwardPort,
      sslEnabled: host.sslEnabled,
      sslForced: host.sslForced,
      http2Support: host.http2Support,
      websocketSupport: host.websocketSupport,
      secureLinkUpstream: host.secureLinkUpstream === true,
      secureLinkUpstreamName,
      secureLinkSocketPath,
      secureLinkSocketPaths,
      secureLinkUsesLoadBalancing: secureLinkSocketPaths.length > 1,
      registryAuthRealm,
      // Nginx variable names must stay short enough for the stock
      // variables_hash_bucket_size 64 (see opf_up_ for dynamic upstreams).
      registryAuthVariableName: `opf_rc_${createHash('sha256').update(host.id).digest('hex').slice(0, 16)}`,
      sslCertPath: host.sslCertPath,
      sslKeyPath: host.sslKeyPath,
      sslChainPath: host.sslChainPath,
      // Rendered unquoted; whitespace has no place in a URL and would split the argument.
      redirectUrl: host.redirectUrl?.replace(/\s/g, '') ?? host.redirectUrl,
      redirectStatusCode: host.redirectStatusCode,
      cacheStale: cacheOpts.staleWhileRevalidate ?? 60,
      // Header names are rendered unquoted: keep them to RFC 9110 token characters.
      customHeaders: host.customHeaders.map((header) => ({
        ...header,
        name: header.name.replace(/[^!#$%&'*+.^_`|~0-9A-Za-z-]/g, ''),
      })),
      customRewrites: host.customRewrites,
      accessList: host.accessList,
      accessListHasIpRules: (host.accessList?.ipRules?.length ?? 0) > 0,
      logPath: `${NGINX_LOGS_PREFIX}/proxy-${host.id}`,
      pagesRouteIncludePath: host.pagesRouteIncludePath,
      pagesSpaFallback: host.pagesSpaFallback === true,
      pagesFallbackUrl: safePagesFallbackUrl(host.pagesFallbackUrl),
      additionalRoutes: host.additionalRoutes ?? [],
      cacheEnabled,
      cacheMaxAge,
      rateLimitMode: configuredRateLimitMode,
      rateLimitEnabled: configuredRateLimitMode !== 'disabled',
      rateLimitRPS,
      rateLimitBurst,
      connectionsPerIp,
      additionalSecureLinks,
    };
  }

  private sanitizeTemplateVariables(
    vars: Record<string, string | number | boolean>
  ): Record<string, string | number | boolean> {
    const sanitized: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(vars)) {
      if (typeof value === 'string') {
        sanitized[key] = value.replace(DANGEROUS_CHARS, '');
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}
