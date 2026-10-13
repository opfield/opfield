import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type { DnsRecords } from '@/db/schema/domains.js';
import { createChildLogger } from '@/lib/logger.js';
import { discoverPublicIpAddresses } from './public-ip-detector.js';

const logger = createChildLogger('DnsUtils');

// Configured via initDnsResolver()
let resolverServers = ['8.8.8.8', '1.1.1.1'];
let resolver = new Resolver();
resolver.setServers(resolverServers);

function parseConfiguredIPs(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function initDnsResolver(servers: string[]): void {
  resolver = new Resolver();
  resolver.setServers(servers);
  resolverServers = [...servers];
  logger.info(`DNS resolvers set to: ${servers.join(', ')}`);
}

export function getDnsResolverServers(): string[] {
  return [...resolverServers];
}

const DNS_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), DNS_TIMEOUT_MS)),
  ]);
}

let cachedPublicIPv4: string[] = [];
let cachedPublicIPv6: string[] = [];

export async function detectPublicIP(envIPv4?: string, envIPv6?: string): Promise<void> {
  const configuredIPv4 = parseConfiguredIPs(envIPv4);
  const configuredIPv6 = parseConfiguredIPs(envIPv6);
  if (configuredIPv4.length > 0 && configuredIPv6.length > 0) {
    cachedPublicIPv4 = configuredIPv4;
    cachedPublicIPv6 = configuredIPv6;
    return;
  }

  const discovered = await discoverPublicIpAddresses();
  const discoveredIPv4 = discovered.filter((address) => !address.includes(':'));
  const discoveredIPv6 = discovered.filter((address) => address.includes(':'));

  cachedPublicIPv4 =
    configuredIPv4.length > 0 ? configuredIPv4 : discoveredIPv4.length > 0 ? discoveredIPv4 : cachedPublicIPv4;
  cachedPublicIPv6 =
    configuredIPv6.length > 0 ? configuredIPv6 : discoveredIPv6.length > 0 ? discoveredIPv6 : cachedPublicIPv6;

  if (discovered.length > 0) {
    logger.info(`Detected public IP addresses: ${discovered.join(', ')}`);
  } else {
    logger.warn('Failed to detect public IP addresses');
  }
}

export function getPublicIPs(): { ipv4: string[]; ipv6: string[] } {
  return { ipv4: cachedPublicIPv4, ipv6: cachedPublicIPv6 };
}

export type DnsAddressResolution = 'resolved' | 'empty' | 'error';

export interface DnsProbeResult {
  queryName: string;
  records: DnsRecords;
  addressResolution: DnsAddressResolution;
}

export function dnsProbeName(domain: string, token = randomBytes(6).toString('hex')): string {
  const normalized = domain.trim().toLowerCase();
  return normalized.startsWith('*.') ? `_opfield-check-${token}.${normalized.slice(2)}` : normalized;
}

function isMissingAddressError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ENONAME' || code === 'NXDOMAIN';
}

export async function probeDnsRecords(domain: string): Promise<DnsProbeResult> {
  const queryName = dnsProbeName(domain);
  const [a, aaaa, cname, caa, mx, txt] = await Promise.allSettled([
    withTimeout(resolver.resolve4(queryName)),
    withTimeout(resolver.resolve6(queryName)),
    withTimeout(resolver.resolveCname(queryName)),
    withTimeout(resolver.resolveCaa(queryName)),
    withTimeout(resolver.resolveMx(queryName)),
    withTimeout(resolver.resolveTxt(queryName)),
  ]);

  const records = {
    a: a.status === 'fulfilled' ? a.value : [],
    aaaa: aaaa.status === 'fulfilled' ? aaaa.value : [],
    cname: cname.status === 'fulfilled' ? cname.value : [],
    caa:
      caa.status === 'fulfilled'
        ? caa.value.map((r) => ({
            critical: r.critical,
            issue: r.issue,
            issuewild: r.issuewild,
          }))
        : [],
    mx: mx.status === 'fulfilled' ? mx.value : [],
    txt: txt.status === 'fulfilled' ? txt.value : [],
  };

  const addressResults = [a, aaaa];
  const addressResolution: DnsAddressResolution =
    records.a.length > 0 || records.aaaa.length > 0
      ? 'resolved'
      : addressResults.every((result) => result.status === 'rejected' && isMissingAddressError(result.reason))
        ? 'empty'
        : addressResults.some((result) => result.status === 'fulfilled')
          ? 'empty'
          : 'error';

  return { queryName, records, addressResolution };
}

export async function resolveDnsRecords(domain: string): Promise<DnsRecords> {
  return (await probeDnsRecords(domain)).records;
}

export type DnsStatus = 'valid' | 'invalid' | 'pending' | 'unknown';

export function computeDnsStatus(records: DnsRecords): DnsStatus {
  const { ipv4, ipv6 } = getPublicIPs();
  const hasARecords = records.a.length > 0 || records.aaaa.length > 0;

  if (!hasARecords && records.cname.length === 0) {
    return 'unknown';
  }

  const ipv4Match = ipv4.some((ip) => records.a.includes(ip));
  const ipv6Match = ipv6.some((ip) => records.aaaa.includes(ip));

  if (ipv4Match || ipv6Match) {
    return 'valid';
  }

  if (hasARecords) {
    return 'invalid';
  }

  return 'unknown';
}
