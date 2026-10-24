import type { ApiResponse } from '../api-client.js';
import { excerpt, type Report, redact } from './report.js';

export type CallOptions = {
  query?: Record<string, string | number | boolean | null | undefined>;
  json?: unknown;
  /** Raw body (Blob, FormData, Uint8Array, string). Content-Type comes from `headers` or the body type. */
  body?: BodyInit;
  headers?: Record<string, string>;
  /** OpenAPI path template for coverage and 5xx dedupe; defaults to the concrete path. */
  template?: string;
  timeoutMs?: number;
  /** Do not record a 5xx as a finding (the caller judges the status itself). */
  allow5xx?: boolean;
  /** The response carries secrets: never keep its body in a finding. */
  secretResponse?: boolean;
};

export type Response<T = any> = ApiResponse<T> & { ms: number; error?: string };

export type CallRecord = { method: string; template: string; status: number; ms: number; phase: string };

/** Every request of the run goes through here, so the global "no 5xx anywhere" invariant sees all of them. */
export class MatrixClient {
  readonly calls: CallRecord[] = [];

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly report: Report,
    private readonly defaultTimeoutMs: number
  ) {}

  get = <T = any>(path: string, options: CallOptions = {}) => this.call<T>('GET', path, options);
  post = <T = any>(path: string, json?: unknown, options: CallOptions = {}) =>
    this.call<T>('POST', path, { ...options, json: json === undefined ? options.json : json });
  put = <T = any>(path: string, json?: unknown, options: CallOptions = {}) =>
    this.call<T>('PUT', path, { ...options, json });
  patch = <T = any>(path: string, json?: unknown, options: CallOptions = {}) =>
    this.call<T>('PATCH', path, { ...options, json });
  delete = <T = any>(path: string, options: CallOptions = {}) => this.call<T>('DELETE', path, options);

  /** Set by the runner: true while a chaos fault is active, so NODE_OFFLINE answers are waited out, not failed. */
  chaosActive: () => boolean = () => false;
  chaosRecoveryMs = 480_000;

  async call<T = any>(method: string, path: string, options: CallOptions = {}): Promise<Response<T>> {
    const offlineUntil = Date.now() + this.chaosRecoveryMs;
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.once<T>(method, path, options);
      const offline =
        (response.status === 502 || response.status === 503 || response.status === 409) &&
        /NODE_OFFLINE|NODE_NOT_CONNECTED|NODE_DISCONNECTED/.test(errorCode(response) ?? '');
      if (offline && this.chaosActive() && Date.now() < offlineUntil) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        continue;
      }
      if (response.status !== 429 || attempt >= 8) {
        this.record(method, path, options, response);
        return response;
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      await new Promise((resolve) =>
        setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500)
      );
    }
  }

  private async once<T>(method: string, path: string, options: CallOptions): Promise<Response<T>> {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {}))
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.token}`,
      ...options.headers,
    };
    let body: BodyInit | undefined = options.body;
    if (options.json !== undefined) {
      body = typeof options.json === 'string' && headers['Content-Type'] ? options.json : JSON.stringify(options.json);
      headers['Content-Type'] ??= 'application/json';
    }
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.defaultTimeoutMs);
    try {
      const response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'manual' });
      const text = await response.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return { status: response.status, headers: response.headers, body: parsed as T, text, ms: Date.now() - started };
    } catch (error) {
      const message =
        error instanceof Error ? (error.name === 'AbortError' ? 'timeout' : error.message) : String(error);
      return { status: 0, headers: new Headers(), body: null as T, text: '', ms: Date.now() - started, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  private record(method: string, path: string, options: CallOptions, response: Response) {
    const template = options.template ?? path.split('?')[0]!;
    this.calls.push({ method, template, status: response.status, ms: response.ms, phase: this.report.currentPhase });
    const request = { method, path, body: requestExcerpt(options) };
    const code = errorCode(response) ?? '';
    // A feature switched off or not configured answers 503 <X>_DISABLED / <X>_NOT_CONFIGURED: one info finding per code.
    const configState = response.status === 503 && /(DISABLED|NOT_CONFIGURED)$/.test(code);
    if (configState && !options.allow5xx) {
      this.report.add({
        severity: 'info',
        invariant: 'no-5xx',
        title: `503 ${code} is used for a configuration state (first seen on ${method} ${template})`,
        dedupeKey: `config-503|${code}`,
        request,
        response: { status: response.status, excerpt: excerpt(response.body, response.text) },
      });
    } else if (response.status >= 500 && !options.allow5xx) {
      this.report.add({
        // 500 is an unhandled error; a 502/503/504 with a specific code is a mapped upstream failure.
        severity: response.status === 500 || !code || code === 'INTERNAL_ERROR' ? 'high' : 'medium',
        invariant: 'no-5xx',
        title: `${method} ${template} returned ${response.status}${code ? ` ${code}` : ''}`,
        dedupeKey: `no-5xx|${method}|${template}|${response.status}`,
        request,
        response: {
          status: response.status,
          excerpt: options.secretResponse ? '<secret response withheld>' : excerpt(response.body, response.text),
        },
      });
    } else if (response.status === 0 && response.error === 'timeout' && !options.allow5xx) {
      this.report.add({
        severity: method === 'GET' ? 'medium' : 'high',
        invariant: 'request-completes',
        title: `${method} ${template} did not answer within ${(options.timeoutMs ?? this.defaultTimeoutMs) / 1000}s`,
        dedupeKey: `timeout|${method}|${template}`,
        request,
      });
    }
  }
}

function requestExcerpt(options: CallOptions) {
  if (options.json === undefined) return typeof options.body === 'string' ? options.body.slice(0, 200) : undefined;
  const text = JSON.stringify(redact(options.json));
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export function ok(response: Response) {
  return response.status >= 200 && response.status < 300;
}

export function data<T = any>(response: Response): T {
  const body = response.body as any;
  if (body && typeof body === 'object' && !Array.isArray(body) && 'data' in body) return body.data as T;
  return body as T;
}

export function rows(response: Response): any[] {
  const value = data<any>(response);
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['data', 'items', 'rows', 'results', 'nodes', 'resources', 'operations', 'alerts', 'instances']) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return [];
}

export function errorCode(response: Response): string | undefined {
  const body = response.body as any;
  return (
    body?.code ?? body?.error?.code ?? body?.data?.code ?? (typeof body?.error === 'string' ? undefined : undefined)
  );
}

export function describe(response: Response) {
  return `${response.status}${response.error ? ` (${response.error})` : ''}: ${excerpt(response.body, response.text, 400)}`;
}

/** Thrown inside a step to mark it skipped with a reason instead of failed. */
export class Skip extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'Skip';
  }
}

export class Failure extends Error {
  constructor(
    message: string,
    readonly response?: Response,
    readonly request?: { method: string; path: string; body?: unknown }
  ) {
    super(message);
    this.name = 'Failure';
  }
}

export function expectOk(
  response: Response,
  label: string,
  request?: { method: string; path: string; body?: unknown }
) {
  if (!ok(response)) throw new Failure(`${label}: ${describe(response)}`, response, request);
  return response;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `probe` until it returns a non-undefined value or the deadline passes (then returns undefined). */
export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  options: { timeoutMs: number; intervalMs: number }
): Promise<T | undefined> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(Math.min(options.intervalMs, Math.max(0, deadline - Date.now())));
  }
}
