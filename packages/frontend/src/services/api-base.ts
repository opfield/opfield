import { getLoginRedirectUrl } from "@/lib/auth-return-to";
import { useAppStatusStore } from "@/stores/app-status";
import { useAuthStore } from "@/stores/auth";
import {
  DEMO_MODE_RESTRICTED,
  handleDemoModeApiError,
  shouldBlockDemoRequest,
  useDemoModeStore,
} from "@/stores/demo-mode";
import type { ApiError } from "@/types";
import { mutationCachePrefixes } from "./mutation-cache";
import {
  clearPersistentCacheScope,
  deletePersistentCachePrefix,
  loadPersistentCache,
  persistCacheEntry,
} from "./persistent-api-cache";

const API_BASE = "/api";

interface CacheEntry<T = unknown> {
  data: T;
  timestamp: number;
}

const DEFAULT_CACHE_TTL = 60_000; // 1 minute

export { API_BASE, DEFAULT_CACHE_TTL };

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;
  /** HTTP method of the failed request; GET/HEAD failures come from loads, not user actions. */
  readonly method?: string;

  constructor(
    message: string,
    {
      status,
      code,
      details,
      retryAfterSeconds,
      method,
    }: {
      status: number;
      code?: string;
      details?: unknown;
      retryAfterSeconds?: number;
      method?: string;
    }
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
    this.method = method;
  }
}

function extractApiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const candidate = payload as {
    code?: unknown;
    message?: unknown;
    error?: unknown;
    details?: unknown;
  };
  const firstDetail = Array.isArray(candidate.details)
    ? candidate.details.find(
        (detail): detail is { message: string; path?: unknown } =>
          !!detail &&
          typeof detail === "object" &&
          typeof (detail as { message?: unknown }).message === "string" &&
          Boolean((detail as { message: string }).message.trim())
      )
    : undefined;
  const firstDetailMessage = firstDetail?.message;

  if (
    candidate.code === "VALIDATION_ERROR" &&
    typeof firstDetailMessage === "string" &&
    firstDetailMessage.trim()
  ) {
    return /^invalid$/i.test(firstDetailMessage.trim()) &&
      typeof firstDetail?.path === "string" &&
      firstDetail.path
      ? `Invalid value for ${firstDetail.path}`
      : firstDetailMessage;
  }
  if (typeof candidate.message === "string" && candidate.message.trim()) {
    return candidate.message;
  }
  if (typeof candidate.error === "string" && candidate.error.trim()) {
    return candidate.error;
  }
  if (candidate.error && typeof candidate.error === "object") {
    const nested = candidate.error as { message?: unknown; error?: unknown };
    if (typeof nested.message === "string" && nested.message.trim()) {
      return nested.message;
    }
    if (typeof nested.error === "string" && nested.error.trim()) {
      return nested.error;
    }
  }
  if (typeof firstDetailMessage === "string" && firstDetailMessage.trim())
    return firstDetailMessage;
  return fallback;
}

function extractApiErrorDetails(payload: unknown): unknown {
  return payload && typeof payload === "object" ? (payload as ApiError).details : undefined;
}

function forbiddenError(payload: unknown, status: number, method: string): ApiRequestError {
  const code = getApiErrorCode(payload) ?? "FORBIDDEN";
  handleDemoModeApiError(code);
  return new ApiRequestError(extractApiErrorMessage(payload, "Insufficient permissions"), {
    status,
    code,
    details: extractApiErrorDetails(payload),
    method,
  });
}

function assertDemoRequestAllowed(url: string, method: string): void {
  const user = useAuthStore.getState().user;
  if (
    user &&
    (user.groupNames ?? [user.groupName]).includes("system-admin") &&
    user.scopes.includes("admin:system")
  )
    return;
  const path = new URL(url, window.location.origin).pathname;
  if (!shouldBlockDemoRequest(path, method)) return;
  useDemoModeStore.getState().show();
  throw new ApiRequestError("This action is unavailable in demo mode.", {
    status: 403,
    code: DEMO_MODE_RESTRICTED,
  });
}

function getApiErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const code = (payload as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function activateOpfieldRestartIfNeeded(payload: unknown): void {
  if (getApiErrorCode(payload) === "SERVICE_RESTARTING") {
    useAppStatusStore.getState().setOpfieldRestartingActive(true);
  }
}

function getRetryAfterSeconds(response: Response): number {
  const retryAfter = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;

  const resetAt = Number(response.headers.get("X-RateLimit-Reset"));
  if (Number.isFinite(resetAt) && resetAt > 0) {
    return Math.max(1, Math.ceil(resetAt - Date.now() / 1000));
  }

  return 60;
}

function getXhrRetryAfterSeconds(xhr: XMLHttpRequest): number {
  const retryAfter = Number(xhr.getResponseHeader("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;

  const resetAt = Number(xhr.getResponseHeader("X-RateLimit-Reset"));
  if (Number.isFinite(resetAt) && resetAt > 0) {
    return Math.max(1, Math.ceil(resetAt - Date.now() / 1000));
  }

  return 60;
}

export class ApiClientBase {
  protected cache = new Map<string, CacheEntry>();
  private readonly cacheInflight = new Map<string, Promise<unknown>>();
  private cacheEpoch = 0;
  private readonly prefixEpochs = new Map<string, number>();
  private persistentHydrationEpoch = 0;
  private persistentCacheScope: string | null = null;
  private persistentCacheHydration: Promise<void> | null = null;
  private readonly latestSnapshots = new Map<string, { measuredAt: number; data: unknown }>();
  private csrfToken: string | null = null;
  private sessionGeneration = 0;

  private assertSessionGeneration(generation: number): void {
    if (generation !== this.sessionGeneration) {
      throw new ApiRequestError("Session changed", {
        status: 0,
        code: "SESSION_CHANGED",
      });
    }
  }

  private cacheVersion(key: string): string {
    let version = `${this.cacheEpoch}`;
    for (const [prefix, epoch] of this.prefixEpochs) {
      if (key.startsWith(prefix)) version += `:${prefix}:${epoch}`;
    }
    return version;
  }

  private setCacheIfCurrent<T>(key: string, version: string, data: T): void {
    if (this.cacheVersion(key) === version) this.setCache(key, data);
  }

  /** Get cached data if fresh enough. */
  getCached<T>(key: string, ttl = DEFAULT_CACHE_TTL): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > ttl) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  /** Store data in cache. */
  setCache<T>(key: string, data: T): void {
    this.cache.set(key, { data, timestamp: Date.now() });
    if (this.persistentCacheScope) {
      void persistCacheEntry(this.persistentCacheScope, key, data).catch(() => {});
    }
  }

  protected acceptFreshSnapshot<T extends { measuredAt?: string }>(key: string, data: T): T {
    const measuredAt = data.measuredAt ? Date.parse(data.measuredAt) : Number.NaN;
    if (!Number.isFinite(measuredAt)) return data;
    const current = this.latestSnapshots.get(key);
    if (current && current.measuredAt > measuredAt) return current.data as T;
    this.latestSnapshots.set(key, { measuredAt, data });
    return data;
  }

  async hydratePersistentCache(scope: string): Promise<void> {
    if (this.persistentCacheScope === scope && this.persistentCacheHydration) {
      return this.persistentCacheHydration;
    }
    this.persistentCacheScope = scope;
    const hydrationEpoch = this.persistentHydrationEpoch;
    const hydration = loadPersistentCache(scope)
      .then((entries) => {
        if (this.persistentCacheScope !== scope || this.persistentHydrationEpoch !== hydrationEpoch)
          return;
        const hydratedAt = Date.now();
        for (const entry of entries) {
          if (!this.cache.has(entry.key)) {
            // IndexedDB already enforced its longer durable TTL. Treat the
            // restored value as a fresh in-memory stale snapshot so route
            // consumers using the normal one-minute TTL can render it.
            this.cache.set(entry.key, { data: entry.data, timestamp: hydratedAt });
          }
        }
      })
      .catch(() => {});
    this.persistentCacheHydration = hydration;
    return hydration;
  }

  /** Invalidate a specific cache key or prefix. */
  invalidateCache(prefix?: string): void {
    this.persistentHydrationEpoch += 1;
    if (!prefix) {
      this.cache.clear();
      this.cacheInflight.clear();
      this.cacheEpoch += 1;
      if (this.persistentCacheScope) {
        void deletePersistentCachePrefix(this.persistentCacheScope).catch(() => {});
      }
      return;
    }
    this.prefixEpochs.set(prefix, (this.prefixEpochs.get(prefix) ?? 0) + 1);
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
    for (const key of this.cacheInflight.keys()) {
      if (key.startsWith(prefix)) this.cacheInflight.delete(key);
    }
    if (this.persistentCacheScope) {
      void deletePersistentCachePrefix(this.persistentCacheScope, prefix).catch(() => {});
    }
  }

  resetSessionState(): void {
    const previousScope = this.persistentCacheScope;
    this.cache.clear();
    this.cacheInflight.clear();
    this.latestSnapshots.clear();
    this.cacheEpoch += 1;
    this.prefixEpochs.clear();
    this.persistentHydrationEpoch += 1;
    this.csrfToken = null;
    this.persistentCacheScope = null;
    this.persistentCacheHydration = null;
    this.sessionGeneration += 1;
    if (previousScope) void clearPersistentCacheScope(previousScope).catch(() => {});
  }

  /**
   * Fetch with cache: returns cached data if available, fetches in background to update.
   * Returns [data, isFromCache].
   */
  async cachedRequest<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttl = DEFAULT_CACHE_TTL
  ): Promise<T> {
    const generation = this.sessionGeneration;
    const version = this.cacheVersion(key);
    const cached = this.getCached<T>(key, ttl);
    const existing = this.cacheInflight.get(key) as Promise<T> | undefined;
    const fresh =
      existing ??
      (() => {
        const request = fetcher()
          .then((data) => {
            this.assertSessionGeneration(generation);
            this.setCacheIfCurrent(key, version, data);
            return data;
          })
          .finally(() => {
            if (this.cacheInflight.get(key) === request) this.cacheInflight.delete(key);
          });
        this.cacheInflight.set(key, request);
        return request;
      })();

    // Cached values keep layout stable while exactly one shared refresh runs.
    // Consume background errors here; a later foreground caller can retry.
    if (cached !== undefined) {
      void fresh.catch(() => {});
      return cached;
    }
    return fresh;
  }

  protected getHeaders(): HeadersInit {
    return {
      "Content-Type": "application/json",
    };
  }

  clearCsrfToken(): void {
    this.csrfToken = null;
  }

  private async getCsrfToken(): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    const generation = this.sessionGeneration;

    const response = await fetch("/auth/csrf", {
      cache: "no-store",
      credentials: "include",
      headers: this.getHeaders(),
    });

    if (response.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = getLoginRedirectUrl();
      throw new ApiRequestError("Session expired", {
        status: response.status,
        code: "UNAUTHORIZED",
      });
    }

    if (!response.ok) {
      const error = await response.json().catch(() => undefined);
      activateOpfieldRestartIfNeeded(error);
      throw new ApiRequestError("Unable to prepare request", {
        status: response.status,
        code: getApiErrorCode(error) ?? "CSRF_TOKEN_UNAVAILABLE",
      });
    }

    const body = (await response.json()) as { csrfToken?: string };
    if (!body.csrfToken) {
      throw new ApiRequestError("Unable to prepare request", {
        status: response.status,
        code: "CSRF_TOKEN_UNAVAILABLE",
      });
    }

    this.assertSessionGeneration(generation);

    this.csrfToken = body.csrfToken;
    return body.csrfToken;
  }

  protected async fetchRaw<T>(
    url: string,
    options: RequestInit = {},
    { suppressGlobalStatus = false }: { suppressGlobalStatus?: boolean } = {}
  ): Promise<T> {
    let response: Response;
    const generation = this.sessionGeneration;
    const method = (options.method || "GET").toUpperCase();
    assertDemoRequestAllowed(url, method);
    const headers = new Headers(this.getHeaders());
    if (options.headers) {
      new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    }
    if (options.body instanceof FormData) {
      headers.delete("Content-Type");
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers.set("X-CSRF-Token", await this.getCsrfToken());
    }

    try {
      response = await fetch(url, {
        ...options,
        credentials: "include",
        headers,
      });
    } catch {
      if (options.signal?.aborted) {
        throw new ApiRequestError("Query cancelled", {
          status: 0,
          code: "REQUEST_ABORTED",
        });
      }
      if (!suppressGlobalStatus) {
        useAppStatusStore.getState().setMaintenanceActive(true);
      }
      throw new ApiRequestError("Service unavailable", {
        status: 0,
        code: "SERVICE_UNAVAILABLE",
      });
    }

    this.assertSessionGeneration(generation);

    if (!response.ok) {
      if (response.status >= 500) {
        const parsedError = await response.json().catch(() => ({
          code: "SERVICE_UNAVAILABLE",
          message: "Service unavailable",
        }));
        const error: ApiError =
          parsedError && typeof parsedError === "object"
            ? (parsedError as ApiError)
            : { code: "SERVICE_UNAVAILABLE", message: "Service unavailable" };
        activateOpfieldRestartIfNeeded(parsedError);
        throw new ApiRequestError(extractApiErrorMessage(parsedError, "Service unavailable"), {
          status: response.status,
          code: error.code || "SERVICE_UNAVAILABLE",
          details: error.details,
          method,
        });
      }

      if (response.status === 429) {
        const retryAfterSeconds = getRetryAfterSeconds(response);
        if (!suppressGlobalStatus) {
          useAppStatusStore.getState().activateRateLimit(retryAfterSeconds);
        }
        throw new ApiRequestError("Too many requests, please try again later", {
          status: response.status,
          code: "RATE_LIMIT_EXCEEDED",
          retryAfterSeconds,
        });
      }

      if (response.status === 401) {
        this.clearCsrfToken();
        useAuthStore.getState().logout();
        window.location.href = getLoginRedirectUrl();
        throw new ApiRequestError("Session expired", {
          status: response.status,
          code: "UNAUTHORIZED",
        });
      }

      if (response.status === 403) {
        const body = await response.json().catch(() => ({ message: "" }));
        if (body.message === "Invalid CSRF token") {
          this.clearCsrfToken();
        }
        if (
          body.message === "Account is blocked" &&
          !useAuthStore.getState().user?.impersonation?.active
        ) {
          window.location.href = "/blocked";
          throw new ApiRequestError("Account is blocked", {
            status: response.status,
            code: "ACCOUNT_BLOCKED",
          });
        }
        throw forbiddenError(body, response.status, method);
      }

      const error: ApiError = await response.json().catch(() => ({
        code: "UNKNOWN_ERROR",
        message: "An unknown error occurred",
      }));

      throw new ApiRequestError(extractApiErrorMessage(error, "An unknown error occurred"), {
        status: response.status,
        code: error.code,
        details: error.details,
        method,
      });
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const data = (await response.json()) as T;
    this.assertSessionGeneration(generation);
    return data;
  }

  protected async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url =
      endpoint.startsWith("/auth") || endpoint.startsWith(API_BASE)
        ? endpoint
        : `${API_BASE}${endpoint}`;
    const method = (options.method || "GET").toUpperCase();

    // For GET requests, update the shared cache but return the network result
    // to the caller. Stores already read cache explicitly when they want an
    // instant stale value; returning cached data here makes refresh actions
    // look successful while leaving the UI stale.
    if (method === "GET") {
      const generation = this.sessionGeneration;
      const cacheKey = `req:${url}`;
      const version = this.cacheVersion(cacheKey);
      const existing = this.cacheInflight.get(cacheKey) as Promise<T> | undefined;
      if (existing) return existing;
      const request = this.fetchRaw<T>(url, options)
        .then((data) => {
          this.assertSessionGeneration(generation);
          this.setCacheIfCurrent(cacheKey, version, data);
          return data;
        })
        .finally(() => {
          if (this.cacheInflight.get(cacheKey) === request) this.cacheInflight.delete(cacheKey);
        });
      this.cacheInflight.set(cacheKey, request);
      return request;
    }

    // Mutations invalidate only after the server confirms success. Clearing
    // before a long-running mutation allows an intervening GET to repopulate
    // stale data while the write is still in progress.
    const data = await this.fetchRaw<T>(url, options);
    for (const prefix of mutationCachePrefixes(url, method)) this.invalidateCache(prefix);
    return data;
  }

  protected async requestRouteContext<T>(endpoint: string): Promise<T> {
    const url = endpoint.startsWith(API_BASE) ? endpoint : `${API_BASE}${endpoint}`;
    return this.fetchRaw<T>(url, {}, { suppressGlobalStatus: true });
  }

  protected async requestBinary(
    endpoint: string,
    options: RequestInit = {},
    onProgress?: (progress: { loaded: number; total: number }) => void
  ): Promise<ArrayBuffer> {
    const url =
      endpoint.startsWith("/auth") || endpoint.startsWith(API_BASE)
        ? endpoint
        : `${API_BASE}${endpoint}`;
    const generation = this.sessionGeneration;
    const method = (options.method || "GET").toUpperCase();
    assertDemoRequestAllowed(url, method);
    const headers = new Headers(this.getHeaders());
    if (options.headers) {
      new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    }
    if (options.body instanceof FormData) {
      headers.delete("Content-Type");
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers.set("X-CSRF-Token", await this.getCsrfToken());
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        credentials: "include",
        headers,
      });
    } catch {
      useAppStatusStore.getState().setMaintenanceActive(true);
      throw new ApiRequestError("Service unavailable", {
        status: 0,
        code: "SERVICE_UNAVAILABLE",
      });
    }

    this.assertSessionGeneration(generation);

    if (!response.ok) {
      const parsedError = await response.json().catch(() => undefined);
      activateOpfieldRestartIfNeeded(parsedError);
      if (response.status === 429) {
        const retryAfterSeconds = getRetryAfterSeconds(response);
        useAppStatusStore.getState().activateRateLimit(retryAfterSeconds);
        throw new ApiRequestError("Too many requests, please try again later", {
          status: response.status,
          code: "RATE_LIMIT_EXCEEDED",
          retryAfterSeconds,
        });
      }
      if (response.status === 401) {
        this.clearCsrfToken();
        useAuthStore.getState().logout();
        window.location.href = getLoginRedirectUrl();
        throw new ApiRequestError("Session expired", {
          status: response.status,
          code: "UNAUTHORIZED",
        });
      }
      if (response.status === 403) {
        const message = extractApiErrorMessage(parsedError, "Insufficient permissions");
        if (message === "Invalid CSRF token") {
          this.clearCsrfToken();
        }
        if (
          message === "Account is blocked" &&
          !useAuthStore.getState().user?.impersonation?.active
        ) {
          window.location.href = "/blocked";
          throw new ApiRequestError("Account is blocked", {
            status: response.status,
            code: "ACCOUNT_BLOCKED",
          });
        }
        throw forbiddenError(parsedError, response.status, method);
      }

      const fallback = response.status >= 500 ? "Service unavailable" : "An unknown error occurred";
      throw new ApiRequestError(extractApiErrorMessage(parsedError, fallback), {
        status: response.status,
        code:
          parsedError && typeof parsedError === "object"
            ? ((parsedError as ApiError).code ?? undefined)
            : undefined,
        method,
      });
    }

    const contentLength = Number(response.headers.get("Content-Length"));
    const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
    onProgress?.({ loaded: 0, total });

    if (!response.body || !onProgress) {
      const data = await response.arrayBuffer();
      this.assertSessionGeneration(generation);
      onProgress?.({ loaded: data.byteLength, total });
      return data;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      loaded += next.value.byteLength;
      onProgress({ loaded, total });
    }

    const data = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.assertSessionGeneration(generation);
    return data.buffer;
  }

  protected async uploadRaw<T>(
    endpoint: string,
    {
      method = "POST",
      body,
      headers,
      onProgress,
    }: {
      method?: "POST" | "PUT";
      body: XMLHttpRequestBodyInit;
      headers?: HeadersInit;
      onProgress?: (progress: { loaded: number; total: number }) => void;
    }
  ): Promise<T> {
    const url =
      endpoint.startsWith("/auth") || endpoint.startsWith(API_BASE)
        ? endpoint
        : `${API_BASE}${endpoint}`;
    const generation = this.sessionGeneration;
    assertDemoRequestAllowed(url, method);
    const requestHeaders = new Headers(headers);
    requestHeaders.set("X-CSRF-Token", await this.getCsrfToken());

    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.withCredentials = true;
      requestHeaders.forEach((value, key) => xhr.setRequestHeader(key, value));

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress?.({ loaded: event.loaded, total: event.total });
        }
      };

      xhr.onerror = () => {
        useAppStatusStore.getState().setMaintenanceActive(true);
        reject(
          new ApiRequestError("Service unavailable", {
            status: 0,
            code: "SERVICE_UNAVAILABLE",
          })
        );
      };

      xhr.onload = () => {
        try {
          this.assertSessionGeneration(generation);
        } catch (err) {
          reject(err);
          return;
        }

        const parseJson = () => {
          if (!xhr.responseText) return undefined;
          try {
            return JSON.parse(xhr.responseText) as unknown;
          } catch {
            return undefined;
          }
        };

        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(parseJson() as T);
          return;
        }

        const parsedError = parseJson();
        const errorCode =
          parsedError && typeof parsedError === "object"
            ? ((parsedError as ApiError).code ?? undefined)
            : undefined;
        activateOpfieldRestartIfNeeded(parsedError);

        if (xhr.status === 429) {
          const retryAfterSeconds = getXhrRetryAfterSeconds(xhr);
          useAppStatusStore.getState().activateRateLimit(retryAfterSeconds);
          reject(
            new ApiRequestError("Too many requests, please try again later", {
              status: xhr.status,
              code: "RATE_LIMIT_EXCEEDED",
              retryAfterSeconds,
            })
          );
          return;
        }

        if (xhr.status === 401) {
          this.clearCsrfToken();
          useAuthStore.getState().logout();
          window.location.href = getLoginRedirectUrl();
          reject(
            new ApiRequestError("Session expired", {
              status: xhr.status,
              code: "UNAUTHORIZED",
            })
          );
          return;
        }

        if (xhr.status === 403) {
          const message = extractApiErrorMessage(parsedError, "Insufficient permissions");
          if (message === "Invalid CSRF token") {
            this.clearCsrfToken();
          }
          if (
            message === "Account is blocked" &&
            !useAuthStore.getState().user?.impersonation?.active
          ) {
            window.location.href = "/blocked";
            reject(
              new ApiRequestError("Account is blocked", {
                status: xhr.status,
                code: "ACCOUNT_BLOCKED",
              })
            );
            return;
          }
          reject(forbiddenError(parsedError, xhr.status, method));
          return;
        }

        const fallback = xhr.status >= 500 ? "Service unavailable" : "An unknown error occurred";
        reject(
          new ApiRequestError(extractApiErrorMessage(parsedError, fallback), {
            status: xhr.status,
            code: errorCode,
            method,
          })
        );
      };

      xhr.send(body);
    });
  }

  /**
   * Unwrap a single-resource response wrapped in `{ data: ... }` by the backend.
   */
  protected unwrapData<T>(promise: Promise<{ data: T }>): Promise<T> {
    return promise.then((r) => r.data);
  }
}
