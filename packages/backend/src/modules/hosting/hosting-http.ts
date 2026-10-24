import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { isAlwaysBlockedOutboundIp, isPrivateIp, normalizeIp } from '@/lib/ip-cidr.js';
import { logger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  cloudBlastErrorMessage,
  digitalOceanErrorMessage,
  hetznerErrorMessage,
  proxmoxErrorMessage,
} from './hosting-http-errors.js';
import type { HostingConnection } from './hosting-provider.types.js';

export interface HostingRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** HOSTKEY and PVE use application/x-www-form-urlencoded. */
  form?: Record<string, string | number | boolean | undefined>;
  /** Bounded, generated seed ISO only. Never used for arbitrary file uploads. */
  seedIso?: { filename: string; data: Buffer };
  /** HOSTKEY reads use POST too. Only explicit reads may replay after session expiry. */
  readOnly?: boolean;
}
export interface HostingHttp {
  request<T>(path: string, options?: HostingRequestOptions): Promise<T>;
}

const PROVIDER_ORIGINS = {
  hostkey: 'https://invapi.hostkey.com',
  digitalocean: 'https://api.digitalocean.com',
  hetzner: 'https://api.hetzner.cloud',
  cloudblast: 'https://console.cloudblast.io',
} as const;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;

function hostkeyLoginFailed(result: Record<string, unknown> | null): boolean {
  return Boolean(
    result &&
      ((typeof result.error === 'string' && result.error.trim()) ||
        [result.code, result.result].some(
          (value) =>
            (typeof value === 'number' && value < 0) ||
            (typeof value === 'string' && /^(?:-\d+|fail|failed|error)$/i.test(value))
        ))
  );
}

/** Only fixed, recognized diagnostics leave the provider boundary; never echo credentials. */
function hostkeyLoginError(result: Record<string, unknown> | null): AppError {
  const message =
    typeof result?.error === 'string' ? result.error : typeof result?.message === 'string' ? result.message : '';
  const normalized = message
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  const reasons: Record<string, string> = {
    'incorrect api key format':
      'HOSTKEY: incorrect API key format. Paste the full original key, not its displayed hash.',
    'api key is empty': 'HOSTKEY: API key is empty.',
    'api key not found': 'HOSTKEY: API key was not found. Check the original key and the HOSTKEY account region.',
    'invalid api key': 'HOSTKEY: API key was rejected.',
    'api key is disabled': 'HOSTKEY: API key is disabled.',
    'api key is inactive': 'HOSTKEY: API key is inactive.',
    'ip not allowed': 'HOSTKEY: the Opfield outbound IP is not allowed by the key ACL.',
    'access denied': 'HOSTKEY: API key login was denied.',
  };
  if (Object.hasOwn(reasons, normalized))
    return new AppError(403, 'HOSTING_AUTHENTICATION_FAILED', reasons[normalized]);
  const code = result?.code ?? result?.result;
  if (message || hostkeyLoginFailed(result)) {
    const suffix = typeof code === 'number' && Number.isSafeInteger(code) ? ` (provider code ${code})` : '';
    return new AppError(
      403,
      'HOSTING_AUTHENTICATION_FAILED',
      `HOSTKEY rejected API key login${suffix}. No provider action was sent.`
    );
  }
  // Protocol diagnostics must never serialize the provider payload, property names
  // supplied by it, or scalar values: any of those could contain credentials.
  const type = (value: unknown) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
  const shape = (value: unknown) => {
    const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return {
      type: type(value),
      token: type(record.token),
      tokenExpire: type(record.token_expire),
      result: type(record.result),
      error: type(record.error),
      message: type(record.message),
    };
  };
  logger.warn('HOSTKEY login response schema mismatch', {
    root: shape(result),
    resultEnvelope: shape(result?.result),
    dataEnvelope: shape(result?.data),
  });
  return new AppError(
    502,
    'HOSTING_AUTH_RESPONSE_INVALID',
    'HOSTKEY returned an unexpected login response without a usable session token. This is not a confirmed API key permission error.'
  );
}

/** Map only known codes: raw transport messages may contain credentials or certificate material. */
function connectionErrorMessage(error: unknown, provider: HostingConnection['provider']): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'HOSTING_REQUEST_TIMEOUT':
    case 'ETIMEDOUT':
    case 'ERR_TLS_HANDSHAKE_TIMEOUT':
      return 'Provider connection timed out. Check that Opfield can reach the API address and port through your firewall.';
    case 'ENOTFOUND':
      return 'Provider API hostname could not be resolved. Check the API address and DNS configuration.';
    case 'EAI_AGAIN':
      return 'Provider DNS lookup temporarily failed. Check Opfield DNS connectivity and try again.';
    case 'ECONNREFUSED':
      return 'Provider refused the connection. Check the API port and that the API service is running.';
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return 'Provider network is unreachable from Opfield. Check routing and firewall rules.';
    case 'ECONNRESET':
    case 'EPIPE':
      return 'Provider connection was reset. Check the API service, proxy and network path.';
    case 'HOSTING_CERTIFICATE_MISMATCH':
      return 'Provider certificate fingerprint does not match. Verify the API certificate through a trusted channel before updating the fingerprint.';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'Provider certificate does not match the API hostname or IP address. Use an address covered by the certificate.';
    case 'CERT_HAS_EXPIRED':
      return 'Provider TLS certificate has expired. Renew the certificate before reconnecting.';
    case 'CERT_NOT_YET_VALID':
      return 'Provider TLS certificate is not valid yet. Check the certificate validity dates and system clocks.';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'CERT_UNTRUSTED':
      return provider === 'proxmox'
        ? 'Proxmox TLS certificate is not trusted. Select Private CA certificate or Verified certificate fingerprint and provide independently verified trust details.'
        : 'Provider TLS certificate is not trusted. Check the provider certificate chain and Opfield trust configuration.';
    case 'ERR_OSSL_PEM_NO_START_LINE':
    case 'ERR_OSSL_PEM_BAD_BASE64_DECODE':
      return 'Trusted CA certificate is invalid. Paste the complete PEM certificate, including BEGIN CERTIFICATE and END CERTIFICATE.';
    case 'EPROTO':
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
      return 'Provider TLS handshake failed. Check that the API port serves HTTPS and supports a compatible TLS version.';
    case 'HOSTING_RESPONSE_LIMIT':
      return 'Provider response exceeded the supported size limit.';
    default:
      return 'Could not establish a secure provider connection. Check the API address, network access and TLS settings.';
  }
}

function responseErrorMessage(status: number): string {
  if (status === 401)
    return 'Provider authentication failed (HTTP 401). Check the API credentials and whether the token has expired or been revoked.';
  if (status === 403)
    return 'Provider denied access (HTTP 403). Check the token permissions for the requested resources.';
  if (status === 429) return 'Provider API rate limit reached (HTTP 429). Wait before retrying.';
  if (status >= 500)
    return `Provider API returned a server error (HTTP ${status}). Check provider availability before retrying.`;
  if (status === 404)
    return 'Provider API endpoint was not found (HTTP 404). Check the API address and supported provider version.';
  return `Provider returned HTTP ${status}`;
}

function transportError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

export function hostingOrigin(connection: Pick<HostingConnection, 'provider' | 'baseUrl'>): URL {
  const url = new URL(connection.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new AppError(400, 'HOSTING_ENDPOINT_INVALID', 'A credential-free HTTPS endpoint is required');
  }
  if (connection.provider !== 'proxmox' && url.origin !== PROVIDER_ORIGINS[connection.provider]) {
    throw new AppError(400, 'HOSTING_ENDPOINT_INVALID', 'Use the official provider API endpoint');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new AppError(400, 'HOSTING_ENDPOINT_INVALID', 'Configure the API origin without a path');
  }
  return url;
}

/** Errors intentionally exclude request payloads, credentials and raw provider responses. */
export class HostingProviderError extends AppError {
  constructor(
    public readonly providerStatus: number,
    public readonly outcomeUnknown: boolean,
    message: string
  ) {
    super(providerStatus === 401 || providerStatus === 403 ? 403 : 502, 'HOSTING_PROVIDER_ERROR', message);
  }
}

function normalizeFingerprint(value: string): string {
  return value
    .replace(/^sha256:/i, '')
    .replaceAll(':', '')
    .toLowerCase();
}

export class HostingHttpClient implements HostingHttp {
  private hostkeySession?: { token: string; expiresAt: number };
  private hostkeyLogin?: Promise<{ token: string; expiresAt: number }>;
  constructor(private readonly connection: HostingConnection) {
    hostingOrigin(connection);
  }

  async request<T>(path: string, options: HostingRequestOptions = {}): Promise<T> {
    if (this.connection.provider !== 'hostkey') return this.rawRequest<T>(path, options);
    // The configured credential is an API key, not a bearer/session token. Never send
    // it to business endpoints or use a provider-returned URL as an authentication target.
    const session = await this.getHostkeySession();
    const send = (token: string) => this.rawRequest<T>(path, { ...options, form: { ...options.form, token } });
    let result: T;
    try {
      result = await send(session.token);
    } catch (error) {
      if (!(error instanceof HostingProviderError) || error.providerStatus !== 401) throw error;
      if (this.hostkeySession === session) this.hostkeySession = undefined;
      if (!options.readOnly) throw error;
      return send((await this.getHostkeySession()).token);
    }
    const envelope = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    const providerError = typeof envelope.error === 'string' ? envelope.error : envelope.message;
    const expired =
      Number(envelope.code ?? envelope.result) < 0 &&
      typeof providerError === 'string' &&
      /\b(?:invalid (?:api )?token|(?:token|session) (?:has |is )?expired|session expired)\b/i.test(providerError);
    if (expired) {
      if (this.hostkeySession === session) this.hostkeySession = undefined;
      // No mutation retry, including on an explicit auth failure: the operation
      // state machine owns all write outcomes and reconciliation.
      if (options.readOnly) return send((await this.getHostkeySession()).token);
    }
    return result;
  }

  private async getHostkeySession(): Promise<{ token: string; expiresAt: number }> {
    if (this.hostkeySession && this.hostkeySession.expiresAt > Date.now() + 30_000) return this.hostkeySession;
    if (this.hostkeyLogin) return this.hostkeyLogin;
    const login = (async () => {
      let result: Record<string, unknown> | null;
      try {
        result = await this.rawRequest<Record<string, unknown> | null>('/auth.php', {
          method: 'POST',
          form: { action: 'login', key: this.connection.token, ttl: 3600 },
        });
      } catch (error) {
        if (error instanceof HostingProviderError)
          throw new AppError(
            error.statusCode,
            'HOSTING_AUTHENTICATION_FAILED',
            `HOSTKEY API key login failed. ${error.message}`
          );
        throw error;
      }
      if (hostkeyLoginFailed(result)) throw hostkeyLoginError(result);
      // Live auth/login wraps the session in `result`; documentation also shows
      // a root session. Accept these two explicit formats, not a recursive token search.
      const wrapped = result?.result;
      const sessionData =
        wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)
          ? (wrapped as Record<string, unknown>)
          : result;
      if (hostkeyLoginFailed(sessionData)) throw hostkeyLoginError(sessionData);
      if (
        !sessionData ||
        (sessionData !== result && result?.token !== undefined) ||
        (sessionData.result !== undefined && !['OK', 'success'].includes(String(sessionData.result))) ||
        typeof sessionData.token !== 'string' ||
        !sessionData.token ||
        sessionData.token.length > 4096 ||
        /\s/.test(sessionData.token)
      )
        throw hostkeyLoginError(result);
      const advertisedExpiry = Number(sessionData.token_expire);
      const expiresAt =
        Number.isFinite(advertisedExpiry) && advertisedExpiry > 0
          ? Math.min(advertisedExpiry * 1000, Date.now() + 3_600_000)
          : Date.now() + 300_000;
      if (expiresAt <= Date.now() + 30_000)
        throw new AppError(
          403,
          'HOSTING_AUTHENTICATION_FAILED',
          'HOSTKEY returned an expired session. Check Opfield time and API key validity.'
        );
      const session = { token: sessionData.token, expiresAt };
      this.hostkeySession = session;
      return session;
    })();
    this.hostkeyLogin = login;
    try {
      return await login;
    } finally {
      if (this.hostkeyLogin === login) this.hostkeyLogin = undefined;
    }
  }

  private errorMessage(body: string, status: number, fallback: string): string {
    if (this.connection.provider === 'hetzner') return hetznerErrorMessage(body, status, fallback);
    if (this.connection.provider === 'cloudblast') return cloudBlastErrorMessage(body, status, fallback);
    if (this.connection.provider === 'proxmox')
      return proxmoxErrorMessage(body, this.connection.token, status, fallback);
    return digitalOceanErrorMessage(body, this.connection.token, status, fallback);
  }

  private async rawRequest<T>(path: string, options: HostingRequestOptions = {}): Promise<T> {
    let origin = hostingOrigin(this.connection);
    // doctl uses this separate official origin for current-token introspection.
    // This is not a caller-selectable origin override; only this exact read is allowed.
    if (this.connection.provider === 'digitalocean' && path === '/v1/oauth/token/info') {
      if (
        (options.method ?? 'GET') !== 'GET' ||
        options.body !== undefined ||
        options.form !== undefined ||
        options.seedIso !== undefined ||
        Object.keys(options.query ?? {}).length > 0
      )
        throw new AppError(400, 'HOSTING_REQUEST_INVALID', 'Token introspection is a read-only request');
      origin = new URL('https://cloud.digitalocean.com');
    }
    const url = new URL(path, origin);
    if (!path.startsWith('/') || url.origin !== origin.origin || url.username || url.password) {
      throw new AppError(400, 'HOSTING_REQUEST_INVALID', 'Provider requests must stay on the configured origin');
    }
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const hostname = origin.hostname.replace(/^\[|\]$/g, '');
    // Resolve once and pin the TCP destination. Redirects are never followed.
    let target: { address: string; family: number };
    try {
      target = isIP(hostname) ? { address: hostname, family: isIP(hostname) } : await lookup(hostname);
    } catch (error) {
      throw new HostingProviderError(502, false, connectionErrorMessage(error, this.connection.provider));
    }
    const ip = normalizeIp(target.address);
    if (!ip || isAlwaysBlockedOutboundIp(ip) || (this.connection.provider !== 'proxmox' && isPrivateIp(ip))) {
      throw new AppError(400, 'HOSTING_ENDPOINT_BLOCKED', 'Provider endpoint resolves to a prohibited address');
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.connection.provider === 'proxmox') {
      if (!this.connection.settings.tokenId)
        throw new AppError(400, 'HOSTING_TOKEN_ID_REQUIRED', 'Proxmox token ID is required');
      headers.Authorization = `PVEAPIToken=${this.connection.settings.tokenId}=${this.connection.token}`;
    } else if (this.connection.provider !== 'hostkey') {
      headers.Authorization = `Bearer ${this.connection.token}`;
    }
    let body: string | Buffer | undefined;
    if (options.seedIso) {
      const { filename, data } = options.seedIso;
      if (
        this.connection.provider !== 'proxmox' ||
        !/^opfield-seed-gw-[a-f0-9-]+\.iso$/.test(filename) ||
        data.length > 2 * 1024 * 1024
      )
        throw new AppError(400, 'HOSTING_SEED_INVALID', 'Invalid bootstrap medium');
      const boundary = `opfield-${randomUUID()}`;
      body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\niso\r\n--${boundary}\r\nContent-Disposition: form-data; name="checksum-algorithm"\r\n\r\nsha256\r\n--${boundary}\r\nContent-Disposition: form-data; name="checksum"\r\n\r\n${createHash('sha256').update(data).digest('hex')}\r\n--${boundary}\r\nContent-Disposition: form-data; name="filename"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
        ),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    } else if (options.form) {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(options.form)) {
        if (value !== undefined) form.set(key, String(value));
      }
      body = form.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }
    if (body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(body));
    const method = options.method ?? (body === undefined ? 'GET' : 'POST');
    const pin = this.connection.settings.certificateFingerprint;
    await this.connection.beforeRequest?.();
    return new Promise<T>((resolve, reject) => {
      let req: ReturnType<typeof httpsRequest>;
      try {
        req = httpsRequest(
          url,
          {
            method,
            agent: false,
            family: target.family,
            headers,
            ca: this.connection.settings.caCertificate,
            // A pin is an explicit trust policy, never an implicit insecure fallback.
            rejectUnauthorized: !pin,
            servername: isIP(hostname) ? undefined : hostname,
            lookup: (_host, _options, callback) => callback(null, target.address, target.family),
            timeout: 20_000,
            checkServerIdentity: (host, cert) => checkServerIdentity(host, cert),
          },
          (response) => {
            const status = response.statusCode ?? 502;
            if (status < 200 || status >= 300) {
              const message =
                status === 403 &&
                this.connection.provider === 'digitalocean' &&
                method === 'POST' &&
                url.pathname === '/v2/droplets'
                  ? 'DigitalOcean denied VM creation (HTTP 403). Check droplet:create and tag:create on the API token, and the team role permissions.'
                  : responseErrorMessage(status);
              const fail = (detail = message) =>
                reject(new HostingProviderError(status, method !== 'GET' && status >= 500, detail));
              if (
                !['digitalocean', 'hetzner', 'cloudblast', 'proxmox'].includes(this.connection.provider) ||
                status < 400 ||
                status >= 500
              ) {
                response.resume();
                fail();
                return;
              }
              const chunks: Buffer[] = [];
              let bytes = 0;
              response.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes <= MAX_ERROR_RESPONSE_BYTES) chunks.push(chunk);
                else {
                  chunks.length = 0;
                  fail();
                }
              });
              response.once('end', () =>
                fail(
                  bytes <= MAX_ERROR_RESPONSE_BYTES
                    ? this.errorMessage(Buffer.concat(chunks).toString('utf8'), status, message)
                    : message
                )
              );
              response.once('error', () => fail());
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MAX_RESPONSE_BYTES) {
                req.destroy(transportError('HOSTING_RESPONSE_LIMIT'));
                return;
              }
              chunks.push(chunk);
            });
            response.on('end', () => {
              try {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve((text.trim() ? JSON.parse(text) : null) as T);
              } catch {
                reject(new HostingProviderError(status, method !== 'GET', 'Provider returned an invalid response'));
              }
            });
            response.on('error', () =>
              reject(new HostingProviderError(502, method !== 'GET', 'Provider response was interrupted'))
            );
          }
        );
      } catch (error) {
        reject(new HostingProviderError(502, false, connectionErrorMessage(error, this.connection.provider)));
        return;
      }
      req.on('socket', (socket) => {
        socket.once('secureConnect', () => {
          if (pin) {
            const cert = (socket as import('node:tls').TLSSocket).getPeerCertificate();
            if (!cert.fingerprint256 || normalizeFingerprint(cert.fingerprint256) !== normalizeFingerprint(pin)) {
              req.destroy(transportError('HOSTING_CERTIFICATE_MISMATCH'));
              return;
            }
          }
          // Do not transmit credentials until the explicit TLS policy is verified.
          if (body !== undefined) req.write(body);
          req.end();
        });
      });
      req.once('timeout', () => req.destroy(transportError('HOSTING_REQUEST_TIMEOUT')));
      req.once('error', (error) =>
        reject(new HostingProviderError(502, method !== 'GET', connectionErrorMessage(error, this.connection.provider)))
      );
    });
  }
}
