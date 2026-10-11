import { CliError, redactText } from './errors.js';
import type { GatewayApiErrorBody } from './types.js';

export type Fetch = typeof fetch;

export interface RequestOptions {
  fetch?: Fetch;
  accessToken?: string;
  timeoutMs?: number;
  expectedStatuses?: number[];
}

export async function requestJson<T>(url: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (options.accessToken) headers.set('Authorization', `Bearer ${options.accessToken}`);
  const signal = init.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000);

  let response: Response;
  try {
    response = await fetcher(url, { ...init, headers, signal });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new CliError(
      timeout ? 'NETWORK_TIMEOUT' : 'NETWORK_ERROR',
      timeout ? 'Opfield request timed out.' : 'Opfield is unreachable.',
      {
        cause: error,
      }
    );
  }

  const expected = options.expectedStatuses ?? [];
  if (!response.ok && !expected.includes(response.status)) {
    throw await responseError(response);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new CliError('INVALID_GATEWAY_RESPONSE', 'Opfield returned an invalid JSON response.', { cause: error });
  }
}

async function responseError(response: Response): Promise<CliError> {
  let body: Partial<GatewayApiErrorBody> & { error?: string; error_description?: string } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // The status and generic message remain sufficient when an upstream proxy returns HTML.
  }
  const code = body.code || body.error || `HTTP_${response.status}`;
  const message = body.message || body.error_description || `Opfield request failed with HTTP ${response.status}.`;
  return new CliError(code, redactText(message), { details: body.details, exitCode: response.status === 401 ? 2 : 1 });
}

export function assertTrustedEndpoint(endpoint: string, issuer: string, label: string): string {
  let parsed: URL;
  let parsedIssuer: URL;
  try {
    parsed = new URL(endpoint);
    parsedIssuer = new URL(issuer);
  } catch (error) {
    throw new CliError('INVALID_OAUTH_METADATA', `Opfield advertised an invalid ${label}.`, { cause: error });
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (
    parsed.origin !== parsedIssuer.origin ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
  ) {
    throw new CliError('UNTRUSTED_OAUTH_ENDPOINT', `Opfield advertised an untrusted ${label}.`);
  }
  return parsed.href;
}
