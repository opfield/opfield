import { X509Certificate } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CertificateValidity } from './console-tls-policy.js';

export const CHALLENGE_PREFIX = '/.well-known/acme-challenge/';
const PROBE_TIMEOUT_MS = 5_000;
const FALLBACK_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
}

/** The host of a Host header, lowercased, without its port. */
export function requestHostName(host: string | undefined): string | null {
  const value = host?.split(',')[0]?.trim().toLowerCase();
  if (!value) return null;
  try {
    return new URL(`http://${value}`).hostname.replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * The answer of the port-80 listener: ACME challenges, everything else redirected to the console over HTTPS. A
 * request for one of the hosts the HTTPS listener serves goes to that host; anything else to the console domain.
 */
export function consoleHttpResponse(
  url: string | undefined,
  method: string | undefined,
  domain: string,
  challenges: ReadonlyMap<string, string>,
  requestHost?: string,
  servedHosts: readonly string[] = []
): { status: number; headers: Record<string, string>; body: string } {
  const target = url?.startsWith('/') ? url : '/';
  const path = target.split('?')[0]!;
  if (path.startsWith(CHALLENGE_PREFIX)) {
    const content = challenges.get(path.slice(CHALLENGE_PREFIX.length));
    return content === undefined
      ? { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' }
      : { status: 200, headers: { 'content-type': 'text/plain' }, body: content };
  }
  const host = requestHostName(requestHost);
  const redirectHost = host && servedHosts.includes(host) ? host : domain;
  const status = method === 'GET' || method === 'HEAD' ? 301 : 308;
  return { status, headers: { location: `https://${redirectHost}${target}`, 'content-type': 'text/plain' }, body: '' };
}

export async function defaultProbe(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.status === 200 ? await response.text() : null;
  } catch {
    return null;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validity(certPem: Buffer | string): CertificateValidity & { certificate: X509Certificate } {
  const certificate = new X509Certificate(certPem);
  return { certificate, notBefore: new Date(certificate.validFrom), notAfter: new Date(certificate.validTo) };
}

/** Writes through a temporary file and a rename, so a crash never leaves a half-written file. */
export async function writeAtomic(dir: string, name: string, content: string | Buffer, mode: number): Promise<void> {
  const temporary = join(dir, `${name}.tmp-${process.pid}`);
  await writeFile(temporary, content, { mode });
  await rename(temporary, join(dir, name));
}

/** The full chain and key of an issued order, as stored and served. */
export function issuedMaterial(result: { certificatePem: string; chainPem: string; privateKeyPem: string }) {
  const fullChain = [result.certificatePem.trim(), result.chainPem.trim()].filter(Boolean).join('\n');
  return { cert: Buffer.from(`${fullChain}\n`), key: Buffer.from(result.privateKeyPem) } satisfies TlsMaterial;
}

/** Reads a TLS pair from disk and renews the web identity first when it ends within a week. */
export async function readFallbackMaterial(
  resolve: () => Promise<{ certPath: string; keyPath: string }>,
  refresh: () => Promise<{ certPath: string; keyPath: string }>
): Promise<TlsMaterial> {
  let identity = await resolve();
  let cert = await readFile(identity.certPath);
  if (validity(cert).notAfter.getTime() - Date.now() <= FALLBACK_RENEW_BEFORE_MS) {
    identity = await refresh();
    cert = await readFile(identity.certPath);
  }
  return { cert, key: await readFile(identity.keyPath) };
}
