import { BlockList, isIP } from 'node:net';
import type { NodeHealthReport } from '@/db/schema/nodes.js';

const hostnameRegex =
  /^(?=.{1,253}\.?$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.?$/;

const specialPurposeIpv6 = new BlockList();
const globallyReachableProtocolIpv6 = new BlockList();
// Most of 2001::/23 is reserved for protocol assignments, but IANA marks a
// small set of more-specific allocations as globally reachable.
globallyReachableProtocolIpv6.addAddress('2001:1::1', 'ipv6');
globallyReachableProtocolIpv6.addAddress('2001:1::2', 'ipv6');
globallyReachableProtocolIpv6.addAddress('2001:1::3', 'ipv6');
globallyReachableProtocolIpv6.addSubnet('2001:3::', 32, 'ipv6');
globallyReachableProtocolIpv6.addSubnet('2001:4:112::', 48, 'ipv6');
globallyReachableProtocolIpv6.addSubnet('2001:20::', 28, 'ipv6');
globallyReachableProtocolIpv6.addSubnet('2001:30::', 28, 'ipv6');
specialPurposeIpv6.addSubnet('2001::', 23, 'ipv6');
specialPurposeIpv6.addSubnet('2001:db8::', 32, 'ipv6');
specialPurposeIpv6.addSubnet('2002::', 16, 'ipv6');
specialPurposeIpv6.addSubnet('3fff::', 20, 'ipv6');

export function isValidNodeServiceAddress(value: string): boolean {
  return isIP(value) !== 0 || hostnameRegex.test(value);
}

function parseIpv4(value: string): number[] | null {
  if (isIP(value) !== 4) return null;
  return value.split('.').map(Number);
}

function isPublicIpv4(value: string): boolean {
  const parts = parseIpv4(value);
  if (!parts) return false;
  const [a, b, c] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPublicIpv6(value: string): boolean {
  if (isIP(value) !== 6) return false;
  const normalized = value.toLowerCase();

  // Public ingress must be globally routable unicast, not merely syntactically
  // inside the broad global-unicast allocation.
  const firstGroup = Number.parseInt(normalized.split(':', 1)[0] || '0', 16);
  if (firstGroup < 0x2000 || firstGroup > 0x3fff) return false;
  if (globallyReachableProtocolIpv6.check(normalized, 'ipv6')) return true;
  return !specialPurposeIpv6.check(normalized, 'ipv6');
}

export function isPubliclyRoutableIp(value: string): boolean {
  const trimmed = value.trim();
  return isPublicIpv4(trimmed) || isPublicIpv6(trimmed);
}

export function getReportedPublicNodeAddresses(node: { lastHealthReport?: NodeHealthReport | null }): string[] {
  const candidates = [
    ...(node.lastHealthReport?.publicIpAddresses ?? []),
    ...(node.lastHealthReport?.localIpAddresses ?? []),
  ];

  return Array.from(new Set(candidates.map((address) => address.trim()).filter(isPubliclyRoutableIp))).sort(
    (left, right) => {
      const versionDifference = isIP(left) - isIP(right);
      return versionDifference !== 0 ? versionDifference : left.localeCompare(right);
    }
  );
}

export function getEffectiveNginxIngressAddress(node: {
  serviceAddresses?: readonly string[] | null;
  serviceAddress?: string | null;
  lastHealthReport?: NodeHealthReport | null;
}): string | null {
  return getEffectiveNginxIngressAddresses(node)[0] ?? null;
}

export function getEffectiveNginxIngressAddresses(node: {
  serviceAddresses?: readonly string[] | null;
  serviceAddress?: string | null;
  secondaryServiceAddress?: string | null;
  lastHealthReport?: NodeHealthReport | null;
}): string[] {
  const candidates = getReportedPublicNodeAddresses(node);
  const configured = getConfiguredNodeServiceAddresses(node);
  if (configured.length === 0) return candidates.slice(0, 1);
  return configured.filter(isPubliclyRoutableIp);
}

export function getEffectiveServiceAddressForNode(node: {
  type: string;
  serviceAddresses?: readonly string[] | null;
  serviceAddress?: string | null;
  lastHealthReport?: NodeHealthReport | null;
}): string | null {
  return node.type === 'nginx' ? getEffectiveNginxIngressAddress(node) : getEffectiveNodeServiceAddress(node);
}

export function getEffectiveNodeServiceAddress(node: {
  serviceAddresses?: readonly string[] | null;
  serviceAddress?: string | null;
  lastHealthReport?: NodeHealthReport | null;
}): string | null {
  const configured = getConfiguredNodeServiceAddresses(node)[0];
  if (configured) return configured;
  return (
    node.lastHealthReport?.localIpAddresses?.find((address) => address.trim().length > 0) ??
    node.lastHealthReport?.publicIpAddresses?.find((address) => address.trim().length > 0) ??
    null
  );
}

/**
 * Returns the address exposed by a published managed database. When TLS is
 * enabled this must be an IP literal, because Opfield-issued database
 * certificates intentionally contain all reported node IP SANs, never an
 * arbitrary configured hostname.
 */
export function getEffectivePublishedNodeIP(node: {
  serviceAddresses?: readonly string[] | null;
  serviceAddress?: string | null;
  lastHealthReport?: NodeHealthReport | null;
}): string | null {
  const configured = getConfiguredNodeServiceAddresses(node)[0];
  if (configured && isIP(configured) !== 0) return configured;
  // Automatic service-address selection is local-first everywhere else in
  // Opfield. Keep published TLS endpoints consistent with that choice; all
  // reported IPs are included in the database certificate SANs. A configured
  // hostname cannot be a TLS endpoint identity, so retain the public-first
  // fallback for that explicit direct-access intent.
  const localAddresses = node.lastHealthReport?.localIpAddresses ?? [];
  const publicAddresses = node.lastHealthReport?.publicIpAddresses ?? [];
  const candidates = configured ? [...publicAddresses, ...localAddresses] : [...localAddresses, ...publicAddresses];
  return candidates.find((address) => isIP(address.trim()) !== 0) ?? null;
}

export function getConfiguredNodeServiceAddresses(node: {
  serviceAddresses?: readonly string[] | null;
  serviceAddress?: string | null;
  secondaryServiceAddress?: string | null;
}): string[] {
  const values =
    node.serviceAddresses == null ? [node.serviceAddress, node.secondaryServiceAddress] : node.serviceAddresses;
  return Array.from(
    new Set(
      values
        .filter((address): address is string => typeof address === 'string')
        .map((address) => address.trim())
        .filter(Boolean)
    )
  );
}
