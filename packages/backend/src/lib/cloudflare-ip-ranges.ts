import { isValidCidr } from '@/lib/ip-cidr.js';

/**
 * Cloudflare's edge ranges (https://www.cloudflare.com/ips/) as of this release. They are used until Opfield fetched
 * the current list once (CloudflareIpRangesService), and again whenever no stored list can be read.
 */
export const BAKED_CLOUDFLARE_IPV4_CIDRS: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

export const BAKED_CLOUDFLARE_IPV6_CIDRS: readonly string[] = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

export interface CloudflareCidrs {
  ipv4: string[];
  ipv6: string[];
}

let current: CloudflareCidrs = { ipv4: [...BAKED_CLOUDFLARE_IPV4_CIDRS], ipv6: [...BAKED_CLOUDFLARE_IPV6_CIDRS] };

/** The Cloudflare edge ranges Opfield trusts now: the last good fetched list, or the baked one. */
export function currentCloudflareCidrs(): CloudflareCidrs {
  return current;
}

/** Every current Cloudflare edge range, IPv4 first. */
export function currentCloudflareCidrList(): string[] {
  return [...current.ipv4, ...current.ipv6];
}

export function setCurrentCloudflareCidrs(next: CloudflareCidrs): void {
  current = { ipv4: [...next.ipv4], ipv6: [...next.ipv6] };
}

// A list is trusted as a whole: an empty, tiny or world-wide answer (a captive portal, a broken mirror) would let any
// peer pick its client address, so such a list is rejected and the last good one stays.
const MIN_IPV4_RANGES = 5;
const MIN_IPV6_RANGES = 2;
const MIN_IPV4_PREFIX = 8;
const MIN_IPV6_PREFIX = 16;
const MAX_RANGES = 200;

/** The ranges of one family when the whole list is plausible, else the reason it is not. */
export function validateCloudflareCidrs(
  values: unknown,
  family: 4 | 6
): { ok: true; cidrs: string[] } | { ok: false; error: string } {
  if (!Array.isArray(values)) return { ok: false, error: `IPv${family} list is missing` };
  const cidrs = values.map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''));
  const minimum = family === 4 ? MIN_IPV4_RANGES : MIN_IPV6_RANGES;
  if (cidrs.length < minimum || cidrs.length > MAX_RANGES) {
    return { ok: false, error: `IPv${family} list has ${cidrs.length} ranges` };
  }
  for (const cidr of cidrs) {
    const bits = Number(cidr.split('/')[1]);
    const isFamily = family === 4 ? !cidr.includes(':') : cidr.includes(':');
    if (!/^[0-9a-f:.]+\/\d{1,3}$/.test(cidr) || !isValidCidr(cidr) || !isFamily) {
      return { ok: false, error: `IPv${family} list has an invalid range: ${cidr.slice(0, 64)}` };
    }
    if (bits < (family === 4 ? MIN_IPV4_PREFIX : MIN_IPV6_PREFIX)) {
      return { ok: false, error: `IPv${family} list has a range too wide to trust: ${cidr}` };
    }
  }
  return { ok: true, cidrs: [...new Set(cidrs)] };
}
