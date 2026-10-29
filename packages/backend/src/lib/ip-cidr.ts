export function normalizeIp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  let ip = value.trim();
  if (!ip) return undefined;
  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'));
  }
  if (ip.startsWith('::ffff:') && ip.slice(7).includes('.')) {
    ip = ip.slice(7);
  }
  if (ip.includes(':') && ip.includes('.') && ip.lastIndexOf(':') > ip.lastIndexOf('.')) {
    ip = ip.slice(0, ip.lastIndexOf(':'));
  }
  const parsedIpv6 = ip.includes(':') ? parseIpv6(ip) : undefined;
  if (parsedIpv6 && parsedIpv6.value >> 32n === 0xffffn) {
    const ipv4 = parsedIpv6.value & 0xffffffffn;
    ip = [
      Number((ipv4 >> 24n) & 0xffn),
      Number((ipv4 >> 16n) & 0xffn),
      Number((ipv4 >> 8n) & 0xffn),
      Number(ipv4 & 0xffn),
    ].join('.');
  }
  return parseIp(ip) ? ip.toLowerCase() : undefined;
}

/**
 * What a per-client limit counts for an address: an IPv4 address as is, an IPv6 address by its /64 (one subscriber
 * network, which hands its hosts any number of addresses).
 */
export function clientLimitKey(ip: string): string {
  const parsed = parseIp(ip);
  if (!parsed || parsed.version === 4) return ip;
  return `${(parsed.value >> 64n).toString(16).padStart(16, '0')}::/64`;
}

export function isValidCidr(cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/');
  if (!range || bitsRaw === undefined || cidr.split('/').length !== 2) return false;
  const parsedRange = parseIp(range);
  const bits = Number(bitsRaw);
  if (!parsedRange || !Number.isInteger(bits)) return false;
  const maxBits = parsedRange.version === 4 ? 32 : 128;
  return bits >= 0 && bits <= maxBits;
}

export function ipInAnyCidr(ip: string, cidrs: string[]): boolean {
  const parsedIp = parseIp(ip);
  return parsedIp ? cidrs.some((cidr) => ipInParsedCidr(parsedIp, cidr)) : false;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const parsedIp = parseIp(ip);
  return parsedIp ? ipInParsedCidr(parsedIp, cidr) : false;
}

function ipInParsedCidr(parsedIp: { version: 4 | 6; value: bigint }, cidr: string): boolean {
  const range = parseCidrRange(cidr);
  return range !== null && range.version === parsedIp.version && parsedIp.value >> range.shift === range.prefix;
}

interface CidrRange {
  version: 4 | 6;
  shift: bigint;
  prefix: bigint;
}

// Client IP resolution checks the same proxy and Cloudflare ranges on every request.
const CIDR_RANGE_CACHE_MAX_ENTRIES = 1024;
const cidrRangeCache = new Map<string, CidrRange | null>();

function parseCidrRange(cidr: string): CidrRange | null {
  const cached = cidrRangeCache.get(cidr);
  if (cached !== undefined) return cached;
  const [range, bitsRaw] = cidr.split('/');
  const parsedRange = parseIp(range);
  const bits = Number(bitsRaw);
  let result: CidrRange | null = null;
  if (parsedRange && Number.isInteger(bits)) {
    const maxBits = parsedRange.version === 4 ? 32 : 128;
    if (bits >= 0 && bits <= maxBits) {
      const shift = BigInt(maxBits - bits);
      result = { version: parsedRange.version, shift, prefix: parsedRange.value >> shift };
    }
  }
  if (cidr.length <= 64) {
    if (cidrRangeCache.size >= CIDR_RANGE_CACHE_MAX_ENTRIES) cidrRangeCache.clear();
    cidrRangeCache.set(cidr, result);
  }
  return result;
}

export function isInternalIp(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  if (parsed.version === 4) {
    return (
      ipInCidr(ip, '10.0.0.0/8') ||
      ipInCidr(ip, '172.16.0.0/12') ||
      ipInCidr(ip, '192.168.0.0/16') ||
      ipInCidr(ip, '127.0.0.0/8') ||
      ipInCidr(ip, '169.254.0.0/16')
    );
  }
  return ip === '::1' || ipInCidr(ip, 'fc00::/7') || ipInCidr(ip, 'fe80::/10');
}

export function isPrivateIp(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  if (parsed.version === 4) {
    return (
      ipInCidr(ip, '10.0.0.0/8') ||
      ipInCidr(ip, '100.64.0.0/10') ||
      ipInCidr(ip, '172.16.0.0/12') ||
      ipInCidr(ip, '192.168.0.0/16') ||
      ipInCidr(ip, '198.18.0.0/15')
    );
  }
  return ipInCidr(ip, 'fc00::/7');
}

export function isAlwaysBlockedOutboundIp(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return true;
  if (parsed.version === 4) {
    return (
      ipInCidr(ip, '0.0.0.0/8') ||
      ipInCidr(ip, '127.0.0.0/8') ||
      ipInCidr(ip, '169.254.0.0/16') ||
      ipInCidr(ip, '224.0.0.0/4') ||
      ipInCidr(ip, '240.0.0.0/4') ||
      ip === '255.255.255.255'
    );
  }
  return ip === '::' || ip === '::1' || ipInCidr(ip, 'fe80::/10') || ipInCidr(ip, 'ff00::/8');
}

function parseIp(ip: string | undefined): { version: 4 | 6; value: bigint } | undefined {
  if (!ip) return undefined;
  if (ip.includes(':')) return parseIpv6(ip);
  return parseIpv4(ip);
}

function parseIpv4(ip: string): { version: 4; value: bigint } | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return undefined;
    value = (value << 8n) + BigInt(octet);
  }
  return { version: 4, value };
}

function parseIpv6(ip: string): { version: 6; value: bigint } | undefined {
  const normalized = ip.toLowerCase();
  if ((normalized.match(/::/g) ?? []).length > 1) return undefined;
  const [headRaw, tailRaw = ''] = normalized.split('::');
  const head = headRaw ? headRaw.split(':') : [];
  const tail = tailRaw ? tailRaw.split(':') : [];
  const pieces = [...head, ...tail];
  if (pieces.some((piece) => piece === '' || !/^[0-9a-f]{1,4}$/.test(piece))) return undefined;
  const fill = normalized.includes('::') ? 8 - pieces.length : 0;
  if (fill < 0 || (!normalized.includes('::') && pieces.length !== 8)) return undefined;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8) return undefined;

  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) + BigInt(Number.parseInt(group, 16));
  }
  return { version: 6, value };
}
