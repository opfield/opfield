import { LEGACY_STATUS_PAGE_ZONE_PREFIX } from '@/lib/legacy-compat.js';
import { escapeNginxReturnText, opfieldStatusPageUnavailableHtml } from '@/lib/opfield-error-pages.js';

/**
 * Status page routes (C-2). A status page must stay up exactly when things are down, but its upstream is Opfield
 * itself: every Opfield update used to answer 502 for 11-12 s on the public status page. The ingress node now keeps
 * the last good responses of the route (the page, its assets and the status API it polls, all served through the
 * same route) and serves them while Opfield refuses connections, times out or answers 5xx/429; a page that was never
 * cached gets a small self-reloading fallback instead of a bare 502.
 *
 * Freshness: a cached response counts as fresh for STATUS_PAGE_CACHE_VALID_SECONDS only; after that every request goes
 * to Opfield again and gets live data (no background update, which would always answer with the previous copy). The
 * stale copies stay on disk for STATUS_PAGE_CACHE_INACTIVE so a long outage still shows the last good page. Opfield
 * marks the page no-store for browsers; the ingress cache ignores that header for itself but passes it on, so browsers
 * still never keep a copy. Responses that set a cookie are never cached.
 *
 * The cache directory is /tmp/nginx-cache-<host id>, the path the nginx daemon already removes with the host config.
 */
export const STATUS_PAGE_CACHE_VALID_SECONDS = 5;
export const STATUS_PAGE_CACHE_INACTIVE = '7d';
/** Opfield down means a refused connection or no answer; a status page does not wait a minute for it. */
const STATUS_PAGE_TIMEOUTS = {
  proxy_connect_timeout: '5s',
  proxy_send_timeout: '15s',
  proxy_read_timeout: '15s',
} as const;

function suffixOf(hostId: string): string {
  return hostId.replace(/[^A-Za-z0-9]/g, '_');
}

export function statusPageCacheZone(hostId: string): string {
  return `${LEGACY_STATUS_PAGE_ZONE_PREFIX}${suffixOf(hostId)}`;
}

export function statusPageFallbackLocation(hostId: string): string {
  return `@${LEGACY_STATUS_PAGE_ZONE_PREFIX}unavailable_${suffixOf(hostId)}`;
}

export function statusPageCachePath(hostId: string): string {
  return `/tmp/nginx-cache-${hostId.replace(/[^A-Za-z0-9-]/g, '')}`;
}

/** Index of the brace closing the block opened at openingBrace, skipping quotes and comments; -1 when unbalanced. */
function matchingBrace(value: string, openingBrace: number): number {
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

/** Directives of one block level only: nested blocks are blanked out, so their directives are not seen. */
function ownLevel(body: string): string {
  let result = '';
  let depth = 0;
  for (const char of body) {
    if (char === '{') depth += 1;
    if (depth === 0) result += char;
    if (char === '}') depth -= 1;
  }
  return result;
}

function locationDirectives(hostId: string, indent: string): string {
  const lines = [
    '# Opfield status page (C-2): serve the last good response while Opfield is unreachable.',
    `proxy_cache ${statusPageCacheZone(hostId)};`,
    'proxy_cache_key "$scheme$host$request_uri";',
    `proxy_cache_valid 200 ${STATUS_PAGE_CACHE_VALID_SECONDS}s;`,
    'proxy_cache_use_stale error timeout invalid_header updating http_500 http_502 http_503 http_504 http_429;',
    'proxy_cache_lock on;',
    'proxy_ignore_headers Cache-Control Expires;',
    ...Object.entries(STATUS_PAGE_TIMEOUTS).map(([directive, value]) => `${directive} ${value};`),
    'proxy_intercept_errors on;',
    `error_page 500 502 503 504 = ${statusPageFallbackLocation(hostId)};`,
  ];
  return lines.map((line) => `${indent}${line}`).join('\n');
}

function fallbackLocation(hostId: string, indent: string, hideExternalBranding: boolean): string {
  const inner = `${indent}    `;
  return [
    `${indent}location ${statusPageFallbackLocation(hostId)} {`,
    `${inner}default_type text/html;`,
    `${inner}add_header Cache-Control "no-store" always;`,
    `${inner}add_header Retry-After 15 always;`,
    `${inner}return 503 ${escapeNginxReturnText(opfieldStatusPageUnavailableHtml(hideExternalBranding))};`,
    `${indent}}`,
  ].join('\n');
}

/**
 * Adds the stale-serving cache to every location of the rendered status page config that proxies to Opfield, plus
 * the cache zone (http level) and one fallback location per server block. A config whose template manages caching
 * itself, or that has no proxying location (a redirect), is returned unchanged.
 */
export function withStatusPageStaleCache(rendered: string, hostId: string, hideExternalBranding = false): string {
  if (/^[\t ]*proxy_cache(?:_path)?[\t ]/m.test(rendered)) return rendered;
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const serverPattern = /^[\t ]*server[\t ]*\{/gm;
  let server: RegExpExecArray | null;
  while ((server = serverPattern.exec(rendered))) {
    const serverOpen = rendered.indexOf('{', server.index);
    const serverClose = matchingBrace(rendered, serverOpen);
    if (serverClose < 0) break;
    const locationPattern = /^([\t ]*)location\b[^{;]*\{/gm;
    locationPattern.lastIndex = serverOpen + 1;
    let location: RegExpExecArray | null;
    let lastProxyLocationEnd = -1;
    let locationIndent = '    ';
    while ((location = locationPattern.exec(rendered)) && location.index < serverClose) {
      const open = rendered.indexOf('{', location.index);
      const close = matchingBrace(rendered, open);
      if (close < 0 || close > serverClose) break;
      locationPattern.lastIndex = close + 1;
      const body = rendered.slice(open + 1, close);
      if (location[0].includes('@') || !/(^|[\s;{])proxy_pass[\t ]/m.test(ownLevel(body))) continue;
      const indent = location[1] ?? '    ';
      const inner = `${indent}    `;
      const withoutTimeouts = body.replace(
        /^[\t ]*proxy_(?:connect|send|read)_timeout[\t ]+[^;]*;[\t ]*\n?/gm,
        (match, offset: number) => (ownLevelAt(body, offset) ? '' : match)
      );
      edits.push({
        start: open + 1,
        end: close,
        replacement: `${withoutTimeouts.replace(/\s*$/, '')}\n\n${locationDirectives(hostId, inner)}\n${indent}`,
      });
      lastProxyLocationEnd = close + 1;
      locationIndent = indent;
    }
    if (lastProxyLocationEnd > 0) {
      edits.push({
        start: lastProxyLocationEnd,
        end: lastProxyLocationEnd,
        replacement: `\n\n${fallbackLocation(hostId, locationIndent, hideExternalBranding)}`,
      });
    }
    serverPattern.lastIndex = serverClose + 1;
  }
  if (edits.length === 0) return rendered;
  let result = rendered;
  for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end)) {
    result = `${result.slice(0, edit.start)}${edit.replacement}${result.slice(edit.end)}`;
  }
  const zone = `proxy_cache_path ${statusPageCachePath(hostId)} levels=1:2 keys_zone=${statusPageCacheZone(hostId)}:1m max_size=64m inactive=${STATUS_PAGE_CACHE_INACTIVE} use_temp_path=off;`;
  return `${zone}\n\n${result}`;
}

/** Whether the character at offset of a block body is on the body's own level (not inside a nested block). */
function ownLevelAt(body: string, offset: number): boolean {
  let depth = 0;
  for (let index = 0; index < offset; index++) {
    if (body[index] === '{') depth += 1;
    if (body[index] === '}') depth -= 1;
  }
  return depth === 0;
}
