import { isIP } from 'node:net';
import { getPublicIPs } from '@/modules/domains/dns.utils.js';
import { isPublicIpAddress } from '@/modules/domains/public-ip-detector.js';

function isPrivateIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [first = 0, second = 0] = address.split('.').map(Number);
    return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized.startsWith('fc') || normalized.startsWith('fd');
  }
  return false;
}

export function filterLocalIpSuggestions(addresses: string[]): string[] {
  return [
    ...new Set(
      addresses
        .map((address) => address.trim())
        .filter(Boolean)
        .filter(isPrivateIp)
    ),
  ];
}

export function filterPublicIpSuggestions(addresses: string[]): string[] {
  return [...new Set(addresses.map((address) => address.trim()).filter(isPublicIpAddress))];
}

export function getSetupNetworkSuggestions(): { publicIps: string[]; localIps: string[] } {
  const configuredLocalHosts = process.env.OPFIELD_LOCAL_HOSTS?.split(',') ?? [];
  const { ipv4, ipv6 } = getPublicIPs();

  return {
    // Match daemon reporting: combine externally observed NAT egress addresses
    // with any public addresses assigned directly to host interfaces.
    publicIps: [...new Set([...ipv4, ...ipv6, ...filterPublicIpSuggestions(configuredLocalHosts)])],
    // Only installer-provided host interfaces are valid here. Reading
    // networkInterfaces() inside the app would expose the container network.
    localIps: filterLocalIpSuggestions(configuredLocalHosts),
  };
}
