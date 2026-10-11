import { createHash, randomUUID } from 'node:crypto';
import type { Context, Next } from 'hono';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { GATEWAY_TOKEN_PATTERN, PRIVATE_KEY_PATTERN } from '@/lib/secret-patterns.js';
import { CacheService, type RedisClient } from '@/services/cache.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import type { AppEnv } from '@/types.js';

const logger = createChildLogger('Idempotency');

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
/** Completed results are replayed for this long. */
export const IDEMPOTENCY_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
/** In-progress marker lifetime; a heartbeat extends it while the first request still runs. */
export const IDEMPOTENCY_IN_PROGRESS_TTL_MS = 2 * 60 * 1000;
export const IDEMPOTENCY_RETRY_AFTER_SECONDS = 2;
/** Bodies above this size are not fingerprinted, so the request runs without idempotency. */
export const IDEMPOTENCY_FINGERPRINT_MAX_BYTES = 1024 * 1024;
/** Responses above this size are not stored; retries learn only that the request completed. */
export const IDEMPOTENCY_STORED_RESPONSE_MAX_BYTES = 1024 * 1024;

const IN_PROGRESS_HEARTBEAT_MS = 30_000;
const REDIS_TIMEOUT_MS = 1000;
const REDIS_KEY_PREFIX = 'idempotency:v2:';
const RESERVE_ATTEMPTS = 3;
/** Deterministic client errors a retry would reproduce; 401/403 and 5xx are never stored. */
const STORABLE_CLIENT_ERROR_STATUSES = new Set([400, 404, 409, 422]);
const REPLAYED_RESPONSE_HEADERS = ['content-type', 'location', 'etag', 'last-modified'];
const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{1,255}$/;

export type IdempotentMethod = 'POST' | 'PUT' | 'PATCH';

/**
 * Opt-in list of REST creates that honor `Idempotency-Key`, as OpenAPI path templates. Every entry
 * was reviewed: its response carries no one-time secret (token, password, private key, generated
 * credential). Never add a route that returns one — token minting, enrollment, key issuance and
 * credential reveal or rotation stay off this list. The response guard below is a second line of
 * defense: a result that still looks secret is withheld instead of stored.
 */
export const IDEMPOTENT_CREATE_ROUTES: ReadonlyArray<{ method: IdempotentMethod; path: string }> = [
  // Docker: the daemon returns ids and names; deployment webhook tokens are redacted, source secrets never returned.
  { method: 'POST', path: '/api/docker/nodes/{nodeId}/containers' },
  { method: 'POST', path: '/api/docker/nodes/{nodeId}/containers/{containerId}/duplicate' },
  { method: 'POST', path: '/api/docker/nodes/{nodeId}/deployments' },
  { method: 'POST', path: '/api/docker/nodes/{nodeId}/compose-projects' },
  { method: 'POST', path: '/api/docker/nodes/{nodeId}/source-resources' },
  { method: 'POST', path: '/api/docker/nodes/{nodeId}/volumes' },
  { method: 'POST', path: '/api/docker/nodes/{nodeId}/networks' },
  { method: 'POST', path: '/api/docker/registries' },
  // Ingress and certificates: raw config redacted by scope; ACME results sanitized (no keys).
  { method: 'POST', path: '/api/proxy-hosts' },
  { method: 'POST', path: '/api/proxy-host-folders' },
  { method: 'POST', path: '/api/domains' },
  { method: 'POST', path: '/api/ssl-certificates/acme' },
  { method: 'POST', path: '/api/cas' },
  { method: 'POST', path: '/api/cas/{id}/intermediate' },
  // Databases and storage: credentials masked; generated passwords and root credentials never returned.
  { method: 'POST', path: '/api/databases' },
  { method: 'POST', path: '/api/databases/managed' },
  { method: 'POST', path: '/api/object-storage' },
  { method: 'POST', path: '/api/managed-storage' },
  // Pages projects (previewHash is a public subdomain id), alert rules and SIEM destinations (secretConfigured only).
  { method: 'POST', path: '/api/pages' },
  { method: 'POST', path: '/api/notifications/alert-rules' },
  { method: 'POST', path: '/api/audit/siem/destinations' },
];
// Deliberately absent: access lists (create echoes basic-auth password hashes), notification webhooks
// (create echoes caller-supplied auth headers), nodes (enrollment token), and every token, key,
// binding, credential reveal or rotation route.

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const IDEMPOTENT_ROUTE_MATCHERS = IDEMPOTENT_CREATE_ROUTES.map((route) => ({
  method: route.method,
  pattern: new RegExp(
    `^${route.path
      .split('/')
      .map((segment) => (/^\{[^/{}]+\}$/.test(segment) ? '[^/]+' : escapeRegExp(segment)))
      .join('/')}/?$`
  ),
}));

export const IDEMPOTENCY_REDIS_SCRIPTS = {
  complete: `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) return 1 end return 0`,
  release: `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
  extend: `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`,
} as const;

export interface IdempotencyScope {
  /** Authenticated principal plus a hash of its current scopes; any scope change starts a new key space. */
  principal: string;
  method: string;
  path: string;
  key: string;
}

/** What a retry learns when the original result was not stored: only that the request completed. */
export interface WithheldResult {
  status?: number;
  location?: string;
}

export interface IdempotencyLease<T> {
  /** Store the result, encrypted at rest, for replay. */
  complete(payload: T): Promise<void>;
  /** Record completion without the result (secret-looking or oversized results). */
  withhold(result: WithheldResult): Promise<void>;
  release(): Promise<void>;
}

export type IdempotencyBeginResult<T> =
  | { kind: 'proceed'; lease: IdempotencyLease<T> }
  | { kind: 'replay'; payload: T }
  | { kind: 'withheld'; result: WithheldResult }
  | { kind: 'mismatch' }
  | { kind: 'in_progress'; retryAfterSeconds: number }
  | { kind: 'unavailable' };

interface InProgressRecord {
  v: 2;
  state: 'in_progress';
  fingerprint: string;
  owner: string;
  startedAt: number;
}

interface SealedPayload {
  encryptedKey: string;
  encryptedDek: string;
}

interface CompletedRecord {
  v: 2;
  state: 'completed';
  fingerprint: string;
  completedAt: number;
  sealed?: SealedPayload;
  withheld?: WithheldResult;
}

export interface StoredHttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
}

let unavailableLogged = false;

function reportUnavailable(error: unknown): void {
  if (unavailableLogged) return;
  unavailableLogged = true;
  logger.warn('Idempotency store unavailable; requests run without idempotency until Redis recovers', {
    error: error instanceof Error ? error.message : String(error),
  });
}

function reportAvailable(): void {
  if (!unavailableLogged) return;
  unavailableLogged = false;
  logger.info('Idempotency store available again');
}

export function resetIdempotencyStateForTests(): void {
  unavailableLogged = false;
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Redis idempotency operation timed out')), REDIS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value);
}

/** Whether the request (or an OpenAPI path template) is one of the opt-in idempotent creates. */
export function isIdempotencyEligibleRequest(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  return IDEMPOTENT_ROUTE_MATCHERS.some((route) => route.method === upper && route.pattern.test(path));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** JSON with object keys sorted, so key order does not change a fingerprint. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && (value as object).constructor === Object) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

export function idempotencyFingerprint(parts: unknown): string {
  return sha256(canonicalJson(parts));
}

/** Hash of one or more scope sets; part of every key so a scope change never replays an old result. */
export function idempotencyScopeHash(...scopeSets: ReadonlyArray<readonly string[] | undefined>): string {
  return sha256(JSON.stringify(scopeSets.map((scopes) => [...new Set(scopes ?? [])].sort())));
}

export function idempotencyRedisKey(scope: IdempotencyScope): string {
  return `${REDIS_KEY_PREFIX}${sha256(JSON.stringify([scope.principal, scope.method.toUpperCase(), scope.path, scope.key]))}`;
}

// ── Secret guard ────────────────────────────────────────────────────────────

const SECRET_FIELD_SUFFIXES = [
  'token',
  'secret',
  'password',
  'passwordhash',
  'passwd',
  'passphrase',
  'privatekey',
  'privatekeypem',
  'secretkey',
  'secretaccesskey',
  'apikey',
  'accesscode',
  'recoverycodes',
  'connectionstring',
  'credentials',
];
const REDACTED_VALUE = /^(?:\[?redacted\]?|\*+|•+)$/i;
const PASSWORD_HASH_PATTERN = /^\$(?:2[abxy]?|argon2(?:id|i|d)|scrypt|pbkdf2[-a-z0-9]*|[156])\$/;
const CREDENTIAL_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i;
const SECRET_ENV_ASSIGNMENT =
  /^[A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Za-z0-9_.-]*=./i;
const SECRET_SCAN_MAX_NODES = 20_000;
const SECRET_SCAN_MAX_DEPTH = 32;

function isSecretFieldName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_FIELD_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function isSecretValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '' && !REDACTED_VALUE.test(value.trim());
  if (Array.isArray(value)) return value.some(isSecretValue);
  if (value && typeof value === 'object') return Object.values(value).some(isSecretValue);
  return false;
}

function secretInString(value: string): string | null {
  if (PRIVATE_KEY_PATTERN.test(value)) return 'private key';
  if (PASSWORD_HASH_PATTERN.test(value)) return 'password hash';
  if (CREDENTIAL_URL_PATTERN.test(value)) return 'URL with credentials';
  if (GATEWAY_TOKEN_PATTERN.test(value)) return 'Opfield token';
  if (SECRET_ENV_ASSIGNMENT.test(value)) return 'secret environment assignment';
  return null;
}

/**
 * Where a value carries secret-looking material (a secret-named field with a value, a private key,
 * a URL with credentials, a Gateway token, or a secret environment assignment), or null. Results
 * that trip it are never stored for replay.
 */
export function findSecretMaterial(value: unknown): string | null {
  let visited = 0;
  const walk = (node: unknown, path: string, depth: number): string | null => {
    visited += 1;
    if (visited > SECRET_SCAN_MAX_NODES || depth > SECRET_SCAN_MAX_DEPTH) return `${path || '$'}: too large to scan`;
    if (typeof node === 'string') {
      const reason = secretInString(node);
      return reason ? `${path || '$'}: ${reason}` : null;
    }
    if (Array.isArray(node)) {
      for (const [index, item] of node.entries()) {
        const found = walk(item, `${path}[${index}]`, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (node && typeof node === 'object') {
      for (const [name, item] of Object.entries(node)) {
        const itemPath = path ? `${path}.${name}` : name;
        if (isSecretFieldName(name) && isSecretValue(item)) return `${itemPath}: secret-named field`;
        const found = walk(item, itemPath, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(value, '', 0);
}

// ── Store ───────────────────────────────────────────────────────────────────

function parseRecord(raw: string): InProgressRecord | CompletedRecord | null {
  try {
    const record = JSON.parse(raw) as Partial<InProgressRecord | CompletedRecord>;
    if (record?.v !== 2 || typeof record.fingerprint !== 'string') return null;
    if (record.state === 'in_progress' || record.state === 'completed') {
      return record as InProgressRecord | CompletedRecord;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveRedis(): RedisClient {
  return container.resolve(CacheService).getClient();
}

/** Results are encrypted with the Gateway master key, so Redis dumps and backups never hold them in plaintext. */
function sealPayload(payload: unknown): SealedPayload | null {
  try {
    return container.resolve(CryptoService).encryptString(JSON.stringify(payload));
  } catch (error) {
    logger.warn('Cannot encrypt an Idempotency-Key result; storing completion only', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function openPayload<T>(sealed: SealedPayload): T | null {
  try {
    return JSON.parse(container.resolve(CryptoService).decryptString(sealed)) as T;
  } catch {
    return null;
  }
}

function createLease<T>(
  redis: RedisClient,
  redisKey: string,
  marker: string,
  fingerprint: string
): IdempotencyLease<T> {
  let settled = false;
  const heartbeat = setInterval(() => {
    withTimeout(
      redis.eval(IDEMPOTENCY_REDIS_SCRIPTS.extend, 1, redisKey, marker, String(IDEMPOTENCY_IN_PROGRESS_TTL_MS))
    ).catch(() => undefined);
  }, IN_PROGRESS_HEARTBEAT_MS);
  heartbeat.unref?.();

  const settle = () => {
    if (settled) return false;
    settled = true;
    clearInterval(heartbeat);
    return true;
  };

  const store = async (record: CompletedRecord) => {
    try {
      await withTimeout(
        redis.eval(
          IDEMPOTENCY_REDIS_SCRIPTS.complete,
          1,
          redisKey,
          marker,
          JSON.stringify(record),
          String(IDEMPOTENCY_RESULT_TTL_MS)
        )
      );
    } catch (error) {
      reportUnavailable(error);
    }
  };

  return {
    async complete(payload: T) {
      if (!settle()) return;
      const sealed = sealPayload(payload);
      await store({
        v: 2,
        state: 'completed',
        fingerprint,
        completedAt: Date.now(),
        ...(sealed ? { sealed } : { withheld: {} }),
      });
    },
    async withhold(result: WithheldResult) {
      if (!settle()) return;
      await store({ v: 2, state: 'completed', fingerprint, completedAt: Date.now(), withheld: result });
    },
    async release() {
      if (!settle()) return;
      try {
        await withTimeout(redis.eval(IDEMPOTENCY_REDIS_SCRIPTS.release, 1, redisKey, marker));
      } catch (error) {
        reportUnavailable(error);
      }
    },
  };
}

/**
 * Reserve an idempotency key, or report what an earlier request with the same key did.
 * Redis failures return `unavailable`: callers then run without idempotency instead of failing.
 */
export async function beginIdempotentOperation<T>(
  scope: IdempotencyScope,
  fingerprint: string
): Promise<IdempotencyBeginResult<T>> {
  let redis: RedisClient;
  try {
    redis = resolveRedis();
  } catch (error) {
    reportUnavailable(error);
    return { kind: 'unavailable' };
  }

  const redisKey = idempotencyRedisKey(scope);
  const marker = JSON.stringify({
    v: 2,
    state: 'in_progress',
    fingerprint,
    owner: randomUUID(),
    startedAt: Date.now(),
  } satisfies InProgressRecord);

  try {
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt += 1) {
      const reserved = await withTimeout(redis.set(redisKey, marker, 'PX', IDEMPOTENCY_IN_PROGRESS_TTL_MS, 'NX'));
      if (reserved === 'OK') {
        reportAvailable();
        return { kind: 'proceed', lease: createLease<T>(redis, redisKey, marker, fingerprint) };
      }
      const existing = await withTimeout(redis.get(redisKey));
      // The earlier record expired between SET NX and GET: try to reserve again.
      if (existing === null) continue;
      reportAvailable();
      const record = parseRecord(existing);
      if (!record) {
        logger.warn('Ignoring an unreadable idempotency record', { redisKey });
        return { kind: 'unavailable' };
      }
      if (record.fingerprint !== fingerprint) return { kind: 'mismatch' };
      if (record.state === 'in_progress') {
        return { kind: 'in_progress', retryAfterSeconds: IDEMPOTENCY_RETRY_AFTER_SECONDS };
      }
      const payload = record.sealed ? openPayload<T>(record.sealed) : null;
      if (payload === null) return { kind: 'withheld', result: record.withheld ?? {} };
      return { kind: 'replay', payload };
    }
    return { kind: 'in_progress', retryAfterSeconds: IDEMPOTENCY_RETRY_AFTER_SECONDS };
  } catch (error) {
    reportUnavailable(error);
    return { kind: 'unavailable' };
  }
}

// ── REST middleware ─────────────────────────────────────────────────────────

/**
 * The key owner: the API/OAuth token, or the browser session (not just the user, so another
 * session never replays this one's results), plus a hash of the current effective scopes.
 */
export function idempotencyPrincipal(c: Context<AppEnv>): string | null {
  const user = c.get('user');
  if (!user) return null;
  const authType = c.get('authType');
  let principal: string;
  if (authType === 'api-token' || authType === 'oauth-token') {
    const tokenId = c.get('authTokenId');
    if (!tokenId) return null;
    principal = `${authType}:${tokenId}`;
  } else {
    const sessionId = c.get('sessionId');
    if (!sessionId) return null;
    principal = `session:${sha256(sessionId)}:user:${user.id}`;
    const impersonation = c.get('impersonation');
    if (impersonation) principal += `:impersonated-by:${impersonation.actor.id}`;
  }
  return `${principal}:scopes:${idempotencyScopeHash(c.get('effectiveScopes'))}`;
}

function mediaType(value: string | null | undefined): string {
  return value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isJsonMediaType(type: string): boolean {
  return type === 'application/json' || type.endsWith('+json');
}

/**
 * Read the body for fingerprinting. Only JSON, plain text, and empty bodies qualify: reading
 * multipart or binary bodies here would break handlers that parse or stream them. Hono caches
 * the text, so the handler's own `c.req.json()` still works. `null` means "run without idempotency".
 */
async function readFingerprintBody(c: Context<AppEnv>): Promise<string | null> {
  const contentLength = c.req.header('content-length');
  if (contentLength !== undefined && Number(contentLength) > IDEMPOTENCY_FINGERPRINT_MAX_BYTES) return null;
  const type = mediaType(c.req.header('content-type'));
  if (type && !isJsonMediaType(type) && type !== 'text/plain') return null;
  if (!c.req.raw.body) return '';
  const text = await c.req.text();
  if (Buffer.byteLength(text) > IDEMPOTENCY_FINGERPRINT_MAX_BYTES) return null;
  if (!isJsonMediaType(type) || !text.trim()) return text;
  try {
    return canonicalJson(JSON.parse(text));
  } catch {
    return text;
  }
}

function canonicalQuery(url: string): Array<[string, string]> {
  return [...new URL(url).searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey < rightKey ? -1 : 1
  );
}

function isStorableResponse(response: Response): boolean {
  const status = response.status;
  if (!(status >= 200 && status < 300) && !STORABLE_CLIENT_ERROR_STATUSES.has(status)) return false;
  if (response.body === null) return true;
  // Streams, SSE, and downloads are never buffered or replayed.
  return isJsonMediaType(mediaType(response.headers.get('content-type')));
}

function replayResponse(stored: StoredHttpResponse): Response {
  const headers = new Headers(stored.headers);
  headers.set(IDEMPOTENCY_REPLAYED_HEADER, 'true');
  const body = Buffer.from(stored.bodyBase64, 'base64');
  const bodyless = stored.status === 204 || stored.status === 205 || stored.status === 304;
  return new Response(bodyless || body.byteLength === 0 ? null : body, { status: stored.status, headers });
}

function withheldResponse(result: WithheldResult): Response {
  const headers = new Headers({ 'content-type': 'application/json', [IDEMPOTENCY_REPLAYED_HEADER]: 'true' });
  if (result.location) headers.set('location', result.location);
  return new Response(
    JSON.stringify({
      code: 'IDEMPOTENCY_RESPONSE_WITHHELD',
      message:
        'The original request with this Idempotency-Key already completed, but its response is not stored for replay. Look up the resource instead of retrying.',
      ...(result.status ? { originalStatus: result.status } : {}),
    }),
    { status: 409, headers }
  );
}

function secretInResponseBody(body: Buffer, contentType: string): string | null {
  const text = body.toString('utf8');
  if (!text.trim()) return null;
  if (isJsonMediaType(contentType)) {
    try {
      return findSecretMaterial(JSON.parse(text));
    } catch {
      // Not valid JSON after all: scan the raw text below.
    }
  }
  return findSecretMaterial(text);
}

async function recordResponse(c: Context<AppEnv>, lease: IdempotencyLease<StoredHttpResponse>): Promise<void> {
  try {
    const response = c.res;
    if (!isStorableResponse(response)) {
      await lease.release();
      return;
    }
    const location = response.headers.get('location') ?? undefined;
    const withheld: WithheldResult = { status: response.status, ...(location ? { location } : {}) };
    const body = Buffer.from(await response.clone().arrayBuffer());
    if (body.byteLength > IDEMPOTENCY_STORED_RESPONSE_MAX_BYTES) {
      logger.warn('Response too large to store for Idempotency-Key replay; storing completion only', {
        path: c.req.path,
        bytes: body.byteLength,
      });
      await lease.withhold(withheld);
      return;
    }
    const secret = secretInResponseBody(body, mediaType(response.headers.get('content-type')));
    if (secret) {
      logger.warn('Response looks secret; storing Idempotency-Key completion only', { path: c.req.path, secret });
      await lease.withhold(withheld);
      return;
    }
    const headers: Record<string, string> = {};
    for (const name of REPLAYED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    await lease.complete({ status: response.status, headers, bodyBase64: body.toString('base64') });
  } catch (error) {
    logger.warn('Failed to record response for Idempotency-Key replay', {
      error: error instanceof Error ? error.message : String(error),
    });
    await lease.release();
  }
}

async function auditReplay(c: Context<AppEnv>, details: { status: number; withheld: boolean }): Promise<void> {
  // Loaded lazily: the audit service pulls in a large module graph that this middleware must not cycle with.
  const { AuditService } = await import('@/modules/audit/audit.service.js');
  const authType = c.get('authType');
  await container.resolve(AuditService).log({
    userId: c.get('user')?.id ?? null,
    action: 'api.idempotency.replay',
    resourceType: 'api_request',
    details: {
      method: c.req.method.toUpperCase(),
      path: c.req.path,
      status: details.status,
      withheld: details.withheld,
      authType,
      ...(authType === 'api-token' || authType === 'oauth-token' ? { tokenId: c.get('authTokenId') } : {}),
      requestId: c.get('requestId'),
    },
  });
}

const idempotencyHandledContexts = new WeakSet<object>();

/**
 * `Idempotency-Key` support for the opt-in create routes. It runs right after authentication, so
 * the key is bound to the principal and its current scopes, and wraps the rest of the chain.
 */
export async function runWithIdempotency(
  c: Context<AppEnv>,
  next: Next,
  isEligible: (method: string, path: string) => boolean = isIdempotencyEligibleRequest
): Promise<Response | undefined> {
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
  // Nested routers can authenticate the same request twice; only the outer pass applies the key.
  if (key === undefined || idempotencyHandledContexts.has(c)) {
    await next();
    return undefined;
  }
  idempotencyHandledContexts.add(c);

  const method = c.req.method.toUpperCase();
  const path = c.req.path;
  if (!isEligible(method, path)) {
    await next();
    return undefined;
  }
  if (!isValidIdempotencyKey(key)) {
    return c.json(
      {
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: `Idempotency-Key must be 1-${IDEMPOTENCY_KEY_MAX_LENGTH} printable ASCII characters`,
      },
      400
    );
  }
  const principal = idempotencyPrincipal(c);
  const body = principal ? await readFingerprintBody(c) : null;
  if (!principal || body === null) {
    await next();
    return undefined;
  }

  const fingerprint = idempotencyFingerprint({ query: canonicalQuery(c.req.url), body });
  const begin = await beginIdempotentOperation<StoredHttpResponse>({ principal, method, path, key }, fingerprint);
  switch (begin.kind) {
    case 'unavailable':
      await next();
      return undefined;
    case 'mismatch':
      return c.json(
        {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'This Idempotency-Key was already used with a different request; use a new key for a new request',
        },
        422
      );
    case 'in_progress':
      c.header('Retry-After', String(begin.retryAfterSeconds));
      return c.json(
        {
          code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
          message: 'A request with this Idempotency-Key is still running; retry after the Retry-After delay',
        },
        409
      );
    case 'replay':
      await auditReplay(c, { status: begin.payload.status, withheld: false });
      return replayResponse(begin.payload);
    case 'withheld':
      await auditReplay(c, { status: begin.result.status ?? 0, withheld: true });
      return withheldResponse(begin.result);
    case 'proceed':
      try {
        await next();
      } catch (error) {
        await begin.lease.release();
        throw error;
      }
      await recordResponse(c, begin.lease);
      return undefined;
  }
}
