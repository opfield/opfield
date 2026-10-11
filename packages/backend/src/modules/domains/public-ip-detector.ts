import { ipInAnyCidr, isAlwaysBlockedOutboundIp, isPrivateIp, normalizeIp } from '@/lib/ip-cidr.js';

const PUBLIC_IP_REQUEST_TIMEOUT_MS = 3_000;
const PUBLIC_IP_MAX_SAMPLES = 10;
const PUBLIC_IP_MAX_RESPONSE_BYTES = 128;

const DEFAULT_PUBLIC_IP_PROVIDERS = [
  'https://api64.ipify.org',
  'https://ifconfig.me/ip',
  'https://checkip.amazonaws.com',
];

const NON_PUBLIC_ADDRESS_CIDRS = ['192.0.0.0/24', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '2001:db8::/32'];

export type PublicIpFetcher = (provider: string) => Promise<string>;

export function isPublicIpAddress(value: string): boolean {
  const address = normalizeIp(value);
  if (!address) return false;
  return (
    !isPrivateIp(address) && !isAlwaysBlockedOutboundIp(address) && !ipInAnyCidr(address, NON_PUBLIC_ADDRESS_CIDRS)
  );
}

export async function discoverPublicIpAddresses(
  fetchAddress: PublicIpFetcher = fetchPublicIpAddress,
  providers: string[] = DEFAULT_PUBLIC_IP_PROVIDERS
): Promise<string[]> {
  return samplePublicIpAddresses(providers, PUBLIC_IP_MAX_SAMPLES, fetchAddress);
}

async function samplePublicIpAddresses(
  providers: string[],
  samplesPerProvider: number,
  fetchAddress: PublicIpFetcher
): Promise<string[]> {
  const observed = new Set<string>();

  for (let sample = 0; sample < samplesPerProvider; sample += 1) {
    const results = await Promise.allSettled(providers.map((provider) => fetchAddress(provider)));
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const address = normalizeIp(result.value);
      if (address && isPublicIpAddress(address)) observed.add(address);
    }
  }

  return [...observed].sort();
}

async function fetchPublicIpAddress(provider: string): Promise<string> {
  const response = await fetch(provider, {
    headers: {
      Accept: 'text/plain',
      'Cache-Control': 'no-cache',
      'User-Agent': 'Opfield/public-ip-discovery',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(PUBLIC_IP_REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    throw new Error(`Public IP provider returned HTTP ${response.status}`);
  }

  const body = await readResponseBody(response, PUBLIC_IP_MAX_RESPONSE_BYTES);
  const address = normalizeIp(body);
  if (!address || !isPublicIpAddress(address)) {
    throw new Error('Public IP provider returned a non-public address');
  }
  return address;
}

async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw new Error('Public IP provider response is too large');
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body.trim();
  } finally {
    reader.releaseLock();
  }
}
