// HTTP access to one Opfield installation with one set of credentials: request pacing that leaves rate-limit budget
// for other people, 429 retries, CSRF for browser sessions, and the MCP JSON-RPC calls.

const BODY_LIMIT_BYTES = 64 * 1024;
const MCP_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SECRET_PATTERN = /\b(?:opf|opfo|opfi|opfl|opfr|gwo|gwl|gwr)_[A-Za-z0-9_-]{6,}/g;
/** An OAuth access token is refreshed this long before its known expiry. */
const REFRESH_SKEW_MS = 60_000;

const BUCKETS_BY_ORIGIN = new Map();
// One refresh state per OAuth grant, shared by every credential object that carries it (a run comparing an
// installation with itself parses the same grant twice): refresh tokens rotate, and a reused one revokes the grant.
const REFRESH_STATES = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Known credential kinds, in report order. */
export const CREDENTIAL_KINDS = [
  { id: 'session', type: 'session', label: 'browser session (cookie + CSRF)' },
  { id: 'apiToken', type: 'bearer', label: 'opf_ API token, full scopes' },
  { id: 'apiTokenNarrow', type: 'bearer', label: 'opf_ API token, narrow folder-scoped grant' },
  { id: 'oauthApi', type: 'bearer', label: 'opfo_ OAuth token for the API resource' },
  { id: 'oauthMcp', type: 'bearer', label: 'opfo_ OAuth token for the MCP resource' },
  { id: 'inferenceKey', type: 'bearer', label: 'opfi_ inference key' },
  { id: 'impersonation', type: 'session', label: 'impersonation session (cookie + CSRF)' },
];
export const ANONYMOUS = { id: 'anonymous', type: 'none', label: 'no credential' };

/**
 * The credentials of one installation from the credentials file. Unknown keys are kept as extra credentials: a string
 * or {token} is a bearer token, {cookie, csrf?} a browser session.
 * @returns {{credentials: Array<object>, missing: string[], problems: string[]}}
 */
export function parseInstallationCredentials(section) {
  const credentials = [];
  const problems = [];
  const value = section && typeof section === 'object' ? section : {};
  const known = new Map(CREDENTIAL_KINDS.map((kind) => [kind.id, kind]));
  for (const [id, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined || raw === '') continue;
    const kind = known.get(id);
    if (typeof raw === 'string') {
      if (kind?.type === 'session') {
        credentials.push({ ...kind, cookie: raw, csrf: null });
      } else {
        credentials.push({ id, type: 'bearer', label: kind?.label ?? `${id} (bearer)`, token: raw.trim() });
      }
    } else if (typeof raw === 'object' && typeof raw.cookie === 'string' && raw.cookie) {
      credentials.push({
        id,
        type: 'session',
        label: kind?.label ?? `${id} (session)`,
        cookie: raw.cookie.trim(),
        csrf: typeof raw.csrf === 'string' && raw.csrf ? raw.csrf : null,
      });
    } else if (typeof raw === 'object' && typeof raw.token === 'string' && raw.token) {
      const credential = { id, type: 'bearer', label: kind?.label ?? `${id} (bearer)`, token: raw.token.trim() };
      const refresh = parseOAuthRefresh(raw);
      if (refresh.problem) problems.push(`${id}: ${refresh.problem}`);
      else if (refresh.value) credential.oauthRefresh = refresh.value;
      credentials.push(credential);
    } else {
      problems.push(`${id}: expected a token string, {"token": ...} or {"cookie": ..., "csrf": ...}`);
    }
  }
  const present = new Set(credentials.map((credential) => credential.id));
  const missing = CREDENTIAL_KINDS.filter((kind) => !present.has(kind.id)).map((kind) => kind.id);
  return { credentials: [ANONYMOUS, ...credentials], missing, problems };
}

/** Milliseconds since the epoch from an ISO date, epoch seconds or epoch milliseconds; null when absent or invalid. */
function parseExpiry(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The refresh fields of an OAuth credential: refreshToken (refresh_token), clientId (client_id), clientSecret
 * (client_secret, confidential clients only), tokenEndpoint (token_endpoint, default <installation>/api/oauth/token),
 * resource, expiresAt (expires_at: ISO date or epoch seconds).
 */
export function parseOAuthRefresh(raw) {
  const pick = (...names) => names.map((name) => raw[name]).find((value) => typeof value === 'string' && value.trim());
  const refreshToken = pick('refreshToken', 'refresh_token');
  const expiresAt = parseExpiry(raw.expiresAt ?? raw.expires_at);
  if (!refreshToken) return { value: null };
  const clientId = pick('clientId', 'client_id');
  if (!clientId) return { problem: 'a refresh token needs client_id' };
  const tokenEndpoint = pick('tokenEndpoint', 'token_endpoint');
  if (tokenEndpoint && !/^https?:\/\//.test(tokenEndpoint)) return { problem: 'token_endpoint must be an http(s) URL' };
  return {
    value: {
      refreshToken: refreshToken.trim(),
      clientId: clientId.trim(),
      clientSecret: pick('clientSecret', 'client_secret')?.trim() ?? null,
      tokenEndpoint: tokenEndpoint?.trim() ?? null,
      resource: pick('resource')?.trim() ?? null,
      expiresAt,
    },
  };
}

/** Every secret a credential carries, for redaction. */
export function credentialSecrets(credential) {
  return [
    credential.token,
    credential.cookie,
    credential.csrf,
    credential.oauthRefresh?.refreshToken,
    credential.oauthRefresh?.clientSecret,
    ...(credential.cookie ?? '').split(/;\s*/),
  ]
    .filter((value) => typeof value === 'string' && value.length >= 6)
    .map((value) => value.replace(/^[^=]+=/, ''))
    .filter((value) => value.length >= 6);
}

export function redact(text, secrets) {
  if (typeof text !== 'string') return text;
  let out = text.replace(SECRET_PATTERN, '[redacted]');
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out;
}

function rateBucket(path, credential) {
  const auth = path.startsWith('/auth/') || path.startsWith('/api/oauth/');
  if (auth) return 'auth:ip';
  return credential.type === 'session' ? `api:session:${credential.id}` : 'api:ip';
}

async function readLimited(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function parseErrorBody(text) {
  try {
    const json = JSON.parse(text);
    if (json && typeof json === 'object') {
      return {
        code: typeof json.code === 'string' ? json.code : typeof json.error === 'string' ? json.error : null,
        message:
          typeof json.message === 'string'
            ? json.message
            : typeof json.error_description === 'string'
              ? json.error_description
              : null,
      };
    }
  } catch {}
  return { code: null, message: text ? text.slice(0, 200) : null };
}

/** Parses an MCP answer: plain JSON, or the JSON-RPC message carried in an SSE `data:` line. */
export function parseMcpBody(text, id) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json = JSON.parse(trimmed);
      const list = Array.isArray(json) ? json : [json];
      return list.find((message) => message?.id === id) ?? list[0] ?? null;
    } catch {
      return null;
    }
  }
  const messages = [];
  let data = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    else if (line === '' && data.length) {
      messages.push(data.join('\n'));
      data = [];
    }
  }
  if (data.length) messages.push(data.join('\n'));
  for (const message of messages) {
    try {
      const json = JSON.parse(message);
      if (json?.id === id) return json;
    } catch {}
  }
  return null;
}

export class Installation {
  /**
   * @param {string} name 'baseline' | 'candidate'
   * @param {string} baseUrl
   * @param {{timeoutMs: number, reserve: number, maxRetries: number, log: (line: string) => void}} options
   */
  constructor(name, baseUrl, options) {
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.options = options;
    // The rate limit counts per server and client IP: two installations on one origin share their budget.
    const origin = new URL(this.baseUrl).origin;
    if (!BUCKETS_BY_ORIGIN.has(origin)) BUCKETS_BY_ORIGIN.set(origin, new Map());
    this.buckets = BUCKETS_BY_ORIGIN.get(origin);
    this.csrf = new Map();
    this.requestCount = 0;
  }

  async pace(bucketKey) {
    for (;;) {
      const bucket = this.buckets.get(bucketKey);
      if (!bucket) return;
      const now = Date.now();
      if (bucket.waitUntil && now < bucket.waitUntil) {
        await sleep(bucket.waitUntil - now);
        continue;
      }
      if (bucket.remaining === null || bucket.limit === null) return;
      const reserve = Math.max(5, Math.ceil(bucket.limit * this.options.reserve));
      if (bucket.remaining > reserve) {
        bucket.remaining -= 1; // in-flight requests count before their answers come back
        return;
      }
      // Every worker on this budget waits for the window to move on, not only the first one to notice.
      const waitMs = Math.min(65_000, Math.max(250, bucket.resetAt - now + 250));
      this.options.log(
        `${this.name}: ${bucketKey} rate budget at ${bucket.remaining}/${bucket.limit}, waiting ${Math.ceil(waitMs / 1000)} s`
      );
      bucket.waitUntil = now + waitMs;
      bucket.remaining = null;
    }
  }

  noteRateHeaders(bucketKey, headers) {
    const limit = Number(headers.get('x-ratelimit-limit'));
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (!Number.isFinite(limit) || !Number.isFinite(remaining) || headers.get('x-ratelimit-limit') === null) return;
    const previous = this.buckets.get(bucketKey);
    this.buckets.set(bucketKey, {
      limit,
      remaining,
      resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 60_000,
      waitUntil: previous?.waitUntil && previous.waitUntil > Date.now() ? previous.waitUntil : 0,
    });
  }

  /** The shared refresh state of an OAuth credential that carries a refresh token, or null. */
  refreshStateFor(credential) {
    const refresh = credential.oauthRefresh;
    if (!refresh) return null;
    if (credential.refreshState) return credential.refreshState;
    const endpoint = refresh.tokenEndpoint ?? `${this.baseUrl}/api/oauth/token`;
    const key = [endpoint, refresh.clientId, refresh.refreshToken].join('\n');
    let state = REFRESH_STATES.get(key);
    if (!state) {
      state = {
        endpoint,
        clientId: refresh.clientId,
        clientSecret: refresh.clientSecret,
        resource: refresh.resource,
        refreshToken: refresh.refreshToken,
        accessToken: credential.token,
        expiresAt: refresh.expiresAt,
        inflight: null,
        refreshes: 0,
        failure: null,
      };
      REFRESH_STATES.set(key, state);
    }
    credential.refreshState = state;
    return state;
  }

  /** The access token to send now: the latest one a refresh gave, else the one from the file. */
  currentToken(credential) {
    return this.refreshStateFor(credential)?.accessToken ?? credential.token;
  }

  /** Refreshes before a known expiry; returns whether it refreshed. */
  async ensureFresh(credential) {
    const state = this.refreshStateFor(credential);
    if (state?.expiresAt && Date.now() > state.expiresAt - REFRESH_SKEW_MS && !state.failure) {
      return this.refreshOAuth(credential, state.accessToken);
    }
    return false;
  }

  /**
   * Exchanges the refresh token once for every caller that saw `usedToken` fail; a caller whose token was already
   * replaced just retries. Returns whether a usable new token is there. A failed refresh is not tried again.
   */
  async refreshOAuth(credential, usedToken) {
    const state = this.refreshStateFor(credential);
    if (!state) return false;
    if (state.accessToken !== usedToken) return true;
    if (state.inflight) return state.inflight;
    if (state.failure) return false;
    state.inflight = (async () => {
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: state.refreshToken,
        client_id: state.clientId,
      });
      if (state.clientSecret) form.set('client_secret', state.clientSecret);
      if (state.resource) form.set('resource', state.resource);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await fetch(state.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: form.toString(),
          signal: controller.signal,
        });
        const text = await response.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        if (!response.ok || typeof json?.access_token !== 'string') {
          const reason = json?.error_description ?? json?.error ?? `HTTP ${response.status}`;
          state.failure = String(reason).slice(0, 200);
          this.options.log(`${this.name}: refreshing ${credential.id} failed: ${state.failure}`);
          return false;
        }
        state.accessToken = json.access_token;
        if (typeof json.refresh_token === 'string' && json.refresh_token) state.refreshToken = json.refresh_token;
        state.expiresAt = Number.isFinite(json.expires_in) ? Date.now() + json.expires_in * 1000 : null;
        state.refreshes += 1;
        this.options.onSecret?.(state.accessToken);
        this.options.onSecret?.(state.refreshToken);
        this.options.log(`${this.name}: refreshed ${credential.id} (${state.refreshes})`);
        return true;
      } catch (error) {
        state.failure = controller.signal.aborted ? 'timeout' : String(error?.cause?.code ?? error?.message ?? error);
        this.options.log(`${this.name}: refreshing ${credential.id} failed: ${state.failure}`);
        return false;
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      return await state.inflight;
    } finally {
      state.inflight = null;
    }
  }

  async authHeaders(credential, method) {
    if (credential.type === 'bearer') return { Authorization: `Bearer ${this.currentToken(credential)}` };
    if (credential.type !== 'session') return {};
    const headers = { Cookie: credential.cookie };
    if (UNSAFE_METHODS.has(method)) {
      const csrf = credential.csrf ?? (await this.fetchCsrf(credential));
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }
    return headers;
  }

  async fetchCsrf(credential) {
    if (this.csrf.has(credential.id)) return this.csrf.get(credential.id);
    const result = await this.raw(credential, 'GET', '/auth/csrf', { Accept: 'application/json' }, undefined, {
      readBody: true,
      skipAuth: false,
      csrfLookup: true,
    });
    let token = null;
    try {
      token = JSON.parse(result.text ?? '{}').csrfToken ?? null;
    } catch {}
    this.csrf.set(credential.id, token);
    return token;
  }

  /**
   * One HTTP exchange with pacing and 429 retries. An OAuth credential with a refresh token is refreshed before its
   * known expiry, and once on a 401 that says the token expired (REST) or is invalid (WWW-Authenticate
   * invalid_token, as MCP answers); that one request is then sent again.
   */
  async raw(credential, method, path, headers, body, options = {}) {
    const bucketKey = rateBucket(path, credential);
    const refreshable = credential.type === 'bearer' && !!this.refreshStateFor(credential);
    let attempts = 0;
    let refreshed = false;
    for (;;) {
      attempts += 1;
      // One refresh per request at most, before it (known expiry) or after a 401.
      if (refreshable && !refreshed && (await this.ensureFresh(credential))) refreshed = true;
      const usedToken = refreshable ? this.currentToken(credential) : null;
      const auth = options.csrfLookup
        ? credential.type === 'session'
          ? { Cookie: credential.cookie }
          : {}
        : await this.authHeaders(credential, method);
      await this.pace(bucketKey);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      const started = Date.now();
      try {
        this.requestCount += 1;
        const response = await fetch(this.baseUrl + path, {
          method,
          headers: { 'User-Agent': 'opfield-access-diff/1', ...headers, ...auth },
          body,
          redirect: 'manual',
          signal: controller.signal,
        });
        this.noteRateHeaders(bucketKey, response.headers);
        if (response.status === 429 && attempts <= this.options.maxRetries) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await response.body?.cancel().catch(() => {});
          clearTimeout(timer);
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000 * attempts;
          this.options.log(`${this.name}: 429 on ${method} ${path}, retrying in ${Math.ceil(waitMs / 1000)} s`);
          await sleep(Math.min(waitMs, 65_000));
          continue;
        }
        if (response.status === 401 && refreshable && !refreshed) {
          const text = await readLimited(response, options.bodyLimit ?? BODY_LIMIT_BYTES);
          clearTimeout(timer);
          const challenge = response.headers.get('www-authenticate') ?? '';
          if (/expired/i.test(text) || /invalid_token/i.test(challenge)) {
            refreshed = true;
            if (await this.refreshOAuth(credential, usedToken)) continue;
          }
          return { status: 401, headers: response.headers, text, durationMs: Date.now() - started, attempts, error: null };
        }
        const success = response.status >= 200 && response.status < 400;
        let text = null;
        if (!success || options.readBody) {
          text = await readLimited(response, options.bodyLimit ?? BODY_LIMIT_BYTES);
        } else {
          await response.body?.cancel().catch(() => {});
        }
        clearTimeout(timer);
        return {
          status: response.status,
          headers: response.headers,
          text,
          durationMs: Date.now() - started,
          attempts,
          error: null,
        };
      } catch (error) {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        return {
          status: null,
          headers: null,
          text: null,
          durationMs: Date.now() - started,
          attempts,
          error: timedOut ? `timeout after ${this.options.timeoutMs} ms` : String(error?.cause?.code ?? error?.message ?? error),
        };
      }
    }
  }

  /** A REST probe: status plus the error code/message of a refusal. */
  async rest(credential, method, path, headers, body) {
    const result = await this.raw(credential, method, path, headers, body);
    const parsed = result.text !== null && result.status !== null && result.status >= 400 ? parseErrorBody(result.text) : {};
    return {
      status: result.status,
      code: parsed.code ?? null,
      message: parsed.message ?? null,
      error: result.error,
      durationMs: result.durationMs,
      attempts: result.attempts,
    };
  }

  /** One MCP JSON-RPC request. */
  async mcp(credential, payload, sessionId) {
    const headers = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    };
    const result = await this.raw(credential, 'POST', '/api/mcp', headers, JSON.stringify(payload), {
      readBody: true,
      bodyLimit: MCP_BODY_LIMIT_BYTES,
    });
    if (result.error) return { error: result.error, durationMs: result.durationMs };
    if (result.status !== 200 && result.status !== 202) {
      const parsed = parseErrorBody(result.text ?? '');
      return { httpStatus: result.status, code: parsed.code, message: parsed.message, durationMs: result.durationMs };
    }
    const message = payload.id === undefined ? null : parseMcpBody(result.text ?? '', payload.id);
    return {
      httpStatus: 200,
      message,
      sessionId: result.headers?.get('mcp-session-id') ?? sessionId ?? null,
      durationMs: result.durationMs,
    };
  }
}
