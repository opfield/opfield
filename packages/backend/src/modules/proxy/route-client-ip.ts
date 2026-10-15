import { isIP } from 'node:net';
import type { RouteClientIpOptions, RouteClientIpSource } from '@/db/schema/proxy-hosts.js';
import { isValidCidr } from '@/lib/ip-cidr.js';
import { AppError } from '@/middleware/error-handler.js';

/**
 * Client IP source of a route. nginx's realip module replaces $remote_addr (and $binary_remote_addr) with the address
 * a trusted peer forwards, so access list IP rules, rate limits, access logs and the X-Real-IP / X-Forwarded-For sent
 * to the upstream all see the client. Only a TCP peer in set_real_ip_from is believed: a client that connects directly
 * keeps its own address whatever headers it sends.
 */
export const ROUTE_CLIENT_IP_SOURCES = ['auto', 'direct', 'cloudflare', 'reverse_proxy'] as const;
export const ROUTE_CLIENT_IP_HEADERS = ['x_forwarded_for', 'x_real_ip'] as const;
export const MAX_ROUTE_TRUSTED_PROXIES = 64;

/** What a route renders: auto resolved to the TCP peer or to Cloudflare. */
export type EffectiveClientIpSource = 'direct' | 'cloudflare' | 'reverse_proxy';

/**
 * A raw config line that Opfield replaces with the route's client IP directives, so a raw config behind Cloudflare
 * keeps the current edge ranges without listing them itself.
 */
export const RAW_CLIENT_IP_MARKER = '# opfield:client-ip';

/** The comment above the directives Opfield puts into a rendered server block. */
const RENDERED_BLOCK_COMMENT = '# Client IP source (Opfield)';

const HEADER_NAMES: Record<RouteClientIpOptions['header'], string> = {
  x_forwarded_for: 'X-Forwarded-For',
  x_real_ip: 'X-Real-IP',
};

// Only address characters reach a set_real_ip_from line, whatever was stored.
const ADDRESS_TOKEN = /^[0-9a-fA-F:.]+(?:\/\d{1,3})?$/;

export function isValidTrustedProxy(value: string): boolean {
  if (!ADDRESS_TOKEN.test(value)) return false;
  return value.includes('/') ? isValidCidr(value) : isIP(value) !== 0;
}

/** Why a client IP source and its options cannot be saved together (empty when they can). */
export function clientIpSettingsErrors(
  source: RouteClientIpSource,
  options: Partial<RouteClientIpOptions> | null | undefined
): string[] {
  const proxies = options?.trustedProxyCidrs ?? [];
  const errors = proxies
    .filter((value) => !isValidTrustedProxy(value))
    .map((value) => `Invalid trusted proxy address or CIDR: ${value.slice(0, 64)}`);
  if (proxies.length > MAX_ROUTE_TRUSTED_PROXIES) {
    errors.push(`At most ${MAX_ROUTE_TRUSTED_PROXIES} trusted proxies are allowed`);
  }
  if (source === 'reverse_proxy' && proxies.length === 0) {
    errors.push('Trusted proxies need at least one proxy address or CIDR');
  }
  return errors;
}

/** Stored options in their saved shape: trimmed unique proxies and a known header. */
export function normalizeClientIpOptions(
  options: Partial<RouteClientIpOptions> | null | undefined
): RouteClientIpOptions {
  return {
    trustedProxyCidrs: [...new Set((options?.trustedProxyCidrs ?? []).map((value) => value.trim()).filter(Boolean))],
    header: options?.header === 'x_real_ip' ? 'x_real_ip' : 'x_forwarded_for',
  };
}

/**
 * The client IP fields a route update writes, with the options normalized. The source and options are checked
 * together, with the stored value of the one the update leaves out.
 */
export function clientIpUpdateFields(
  input: { clientIpSource?: RouteClientIpSource; clientIpOptions?: Partial<RouteClientIpOptions> | null },
  existing: { clientIpSource?: RouteClientIpSource | null; clientIpOptions?: RouteClientIpOptions | null }
): { clientIpSource?: RouteClientIpSource; clientIpOptions?: RouteClientIpOptions | null } {
  if (input.clientIpSource === undefined && input.clientIpOptions === undefined) return {};
  const source = input.clientIpSource ?? existing.clientIpSource ?? 'auto';
  const written =
    input.clientIpOptions === undefined || input.clientIpOptions === null
      ? input.clientIpOptions
      : normalizeClientIpOptions(input.clientIpOptions);
  const errors = clientIpSettingsErrors(source, written !== undefined ? written : existing.clientIpOptions);
  if (errors.length > 0) throw new AppError(400, 'INVALID_CLIENT_IP_SOURCE', errors.join('; '));
  return {
    ...(input.clientIpSource !== undefined ? { clientIpSource: input.clientIpSource } : {}),
    ...(written !== undefined ? { clientIpOptions: written } : {}),
  };
}

/** The realip directives of a source; none for direct. */
export function clientIpDirectives(
  source: EffectiveClientIpSource,
  options: RouteClientIpOptions | null | undefined,
  cloudflareCidrs: readonly string[]
): string[] {
  if (source === 'direct') return [];
  const peers = source === 'cloudflare' ? cloudflareCidrs : normalizeClientIpOptions(options).trustedProxyCidrs;
  const trusted = peers.filter((peer) => ADDRESS_TOKEN.test(peer));
  if (trusted.length === 0) return [];
  const header = source === 'cloudflare' ? 'CF-Connecting-IP' : HEADER_NAMES[normalizeClientIpOptions(options).header];
  return [...trusted.map((peer) => `set_real_ip_from ${peer};`), `real_ip_header ${header};`, 'real_ip_recursive on;'];
}

/**
 * The rendered config with the directives at the top of every server block. A block that sets real_ip_header itself
 * (a custom template or the route's advanced config) keeps its own: a second one would fail nginx -t.
 */
export function withClientIpDirectives(rendered: string, directives: readonly string[]): string {
  if (directives.length === 0) return rendered;
  const serverPattern = /^[\t ]*server[\t ]*\{/gm;
  const insertions: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = serverPattern.exec(rendered))) {
    const openingBrace = rendered.indexOf('{', match.index);
    const closingBrace = matchingBrace(rendered, openingBrace);
    if (closingBrace < 0) break;
    if (!setsRealIpHeader(rendered.slice(openingBrace + 1, closingBrace))) insertions.push(openingBrace + 1);
    serverPattern.lastIndex = closingBrace + 1;
  }
  const block = `\n    ${RENDERED_BLOCK_COMMENT}\n${directives.map((line) => `    ${line}`).join('\n')}`;
  let result = rendered;
  for (const position of insertions.reverse()) {
    result = `${result.slice(0, position)}${block}${result.slice(position)}`;
  }
  return result;
}

/** A raw config with each marker line replaced by the directives (indented like the marker); unchanged without any. */
export function withRawClientIpMarker(raw: string, directives: readonly string[]): string {
  if (directives.length === 0) return raw;
  return raw.replace(/^([\t ]*)# ?opfield:client-ip[\t ]*$/gm, (_line, indent: string) =>
    directives.map((directive) => `${indent}${directive}`).join('\n')
  );
}

/**
 * A raw config written with an unchanged copy of the rendered directives (raw mode starts from the rendered config)
 * gets the marker in their place, so the route keeps following Cloudflare's current ranges and its own setting. A
 * block that differs from what the route renders now was edited and stays as written.
 */
export function markCopiedClientIpBlocks(config: string, directives: readonly string[]): string {
  if (directives.length === 0 || !config.includes(RENDERED_BLOCK_COMMENT)) return config;
  const escaped = [RENDERED_BLOCK_COMMENT, ...directives].map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const lines = escaped.slice(1).map((line) => `\\r?\\n\\1${line}`);
  const pattern = new RegExp(`^([\\t ]*)${escaped[0]}${lines.join('')}[\\t ]*$`, 'gm');
  return config.replace(pattern, (_block, indent: string) => `${indent}${RAW_CLIENT_IP_MARKER}`);
}

export function hasRenderedClientIpBlock(config: string | null | undefined): boolean {
  return !!config && config.includes(RENDERED_BLOCK_COMMENT);
}

export function hasRawClientIpMarker(raw: string | null | undefined): boolean {
  return !!raw && /^[\t ]*# ?opfield:client-ip[\t ]*$/m.test(raw);
}

/** Whether a server block body sets real_ip_header at its own level (not in a nested location). */
function setsRealIpHeader(body: string): boolean {
  let depth = 0;
  let statement = '';
  let quote: '"' | "'" | null = null;
  let inComment = false;
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (inComment) {
      if (char === '\n') inComment = false;
      continue;
    }
    if (quote) {
      if (char === quote && body[index - 1] !== '\\') quote = null;
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
    if (char === '{' || char === '}' || char === ';') {
      if (depth === 0 && char === ';' && /^real_ip_header\s/.test(statement.trim())) return true;
      if (char === '{') depth += 1;
      if (char === '}') depth = Math.max(0, depth - 1);
      statement = '';
      continue;
    }
    if (depth === 0) statement += char;
  }
  return false;
}

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
