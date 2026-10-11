import { ipInCidr, normalizeIp } from '@/lib/ip-cidr.js';

const VMID_MIN = 100;
const VMID_MAX = 999_999_999;
const POOL_MAX = 1000;

function fail(message: string): never {
  throw new Error(message);
}

function ipv4Number(value: string): number {
  const normalized = normalizeIp(value);
  if (!normalized || normalized.includes(':')) fail('Use an IPv4 address');
  return normalized.split('.').reduce((result, part) => result * 256 + Number(part), 0);
}

function ipv4String(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function rangeParts(value: string): Array<[string, string]> {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) fail('At least one pool entry is required');
  return parts.map((part) => {
    const bounds = part.split('-').map((bound) => bound.trim());
    if (bounds.length > 2 || !bounds[0] || !bounds.at(-1)) fail(`Invalid pool entry: ${part}`);
    return [bounds[0], bounds.at(-1)!];
  });
}

function compactNumbers(values: number[]): string {
  const groups: string[] = [];
  for (let index = 0; index < values.length; ) {
    const start = values[index]!;
    let end = start;
    while (values[index + 1] === end + 1) end = values[++index]!;
    groups.push(start === end ? String(start) : `${start}-${end}`);
    index++;
  }
  return groups.join(',');
}

export function parseVmidRange(value: string): { ids: number[]; normalized: string } {
  const ids = new Set<number>();
  for (const [startRaw, endRaw] of rangeParts(value)) {
    if (!/^\d+$/.test(startRaw) || !/^\d+$/.test(endRaw)) fail('VMID ranges must contain integer IDs');
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < VMID_MIN || end > VMID_MAX || end < start)
      fail(`VMIDs must be between ${VMID_MIN} and ${VMID_MAX}`);
    if (end - start + 1 > POOL_MAX) fail(`A pool may contain at most ${POOL_MAX} IDs`);
    for (let id = start; id <= end; id++) {
      ids.add(id);
      if (ids.size > POOL_MAX) fail(`A pool may contain at most ${POOL_MAX} IDs`);
    }
  }
  const sorted = [...ids].sort((a, b) => a - b);
  if (!sorted.length || sorted.length > POOL_MAX) fail(`A pool may contain at most ${POOL_MAX} IDs`);
  return { ids: sorted, normalized: compactNumbers(sorted) };
}

export function parseIpv4Range(value: string, subnet: string, gateway: string): { ips: string[]; normalized: string } {
  const slash = subnet.indexOf('/');
  if (slash < 0) fail('Static addressing requires an IPv4 subnet');
  const networkIp = normalizeIp(subnet.slice(0, slash));
  const bits = Number(subnet.slice(slash + 1));
  if (!networkIp || networkIp.includes(':') || !Number.isInteger(bits) || bits < 0 || bits > 32)
    fail('Static addressing requires an IPv4 subnet');
  const network = ipv4Number(networkIp);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const first = (network & mask) >>> 0;
  const last = first + 2 ** (32 - bits) - 1;
  const gatewayIp = normalizeIp(gateway);
  if (!gatewayIp || gatewayIp.includes(':') || !ipInCidr(gatewayIp, subnet))
    fail('Opfield must be inside the configured subnet');
  const gatewayNumber = ipv4Number(gatewayIp);
  const addresses = new Set<number>();
  for (const [startRaw, endRaw] of rangeParts(value)) {
    const start = ipv4Number(startRaw);
    const end = ipv4Number(endRaw);
    if (end < start) fail(`Invalid IP range: ${startRaw}-${endRaw}`);
    if (end - start + 1 > POOL_MAX) fail(`A pool may contain at most ${POOL_MAX} addresses`);
    for (let ip = start; ip <= end; ip++) {
      if ((bits <= 30 && (ip === first || ip === last)) || ip === gatewayNumber || !ipInCidr(ipv4String(ip), subnet))
        fail('IP pools may only contain usable host addresses inside the subnet, excluding the gateway');
      addresses.add(ip);
      if (addresses.size > POOL_MAX) fail(`A pool may contain at most ${POOL_MAX} addresses`);
    }
  }
  const sorted = [...addresses].sort((a, b) => a - b);
  if (!sorted.length || sorted.length > POOL_MAX) fail(`A pool may contain at most ${POOL_MAX} addresses`);
  const groups: string[] = [];
  for (const ip of sorted.map(ipv4String)) {
    const previous = groups.at(-1);
    if (!previous) {
      groups.push(ip);
      continue;
    }
    const [startRaw, endRaw = startRaw] = previous.split('-');
    if (ipv4Number(ip) === ipv4Number(endRaw) + 1) groups[groups.length - 1] = `${startRaw}-${ip}`;
    else groups.push(ip);
  }
  const normalized = groups.join(',');
  return { ips: sorted.map(ipv4String), normalized };
}
