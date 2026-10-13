import type { NormalizedOpfieldLogEvent } from './types.js';

export interface OpfieldTransportOptions {
  endpoint: string;
  token: string;
  fetch?: typeof fetch;
}

export type OpfieldTransportResult =
  | { ok: true; accepted: number; rejected: number }
  | {
      ok: false;
      retryable: boolean;
      rateLimited: boolean;
      retryAfterMs?: number;
      status?: number;
      error?: unknown;
    };

export interface OpfieldTransport {
  send(events: NormalizedOpfieldLogEvent[]): Promise<OpfieldTransportResult>;
}

export function createOpfieldTransport(options: OpfieldTransportOptions): OpfieldTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint.replace(/\/+$/, '');

  return {
    async send(events) {
      if (events.length === 0) return { ok: true, accepted: 0, rejected: 0 };

      const path = events.length === 1 ? '/api/logging/ingest' : '/api/logging/ingest/batch';
      const body = events.length === 1 ? events[0] : { logs: events };

      try {
        const response = await fetchImpl(`${endpoint}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        const payload = await readJson(response);
        if (response.ok) {
          return {
            ok: true,
            accepted: readNumber(payload, 'accepted') ?? events.length,
            rejected: readNumber(payload, 'rejected') ?? 0,
          };
        }

        return {
          ok: false,
          retryable: isRetryableStatus(response.status),
          rateLimited: response.status === 429,
          retryAfterMs: getRetryAfterMs(response, payload),
          status: response.status,
          error: payload,
        };
      } catch (error) {
        return { ok: false, retryable: true, rateLimited: false, error };
      }
    },
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function getRetryAfterMs(response: Response, payload: unknown): number | undefined {
  const header = response.headers.get('Retry-After');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }

  const retryAfterSeconds = readRetryAfterSeconds(payload);
  if (retryAfterSeconds !== undefined) return retryAfterSeconds * 1000;

  return undefined;
}

function readRetryAfterSeconds(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object' || !('details' in payload)) return undefined;
  const details = payload.details;
  if (!details || typeof details !== 'object' || !('retryAfterSeconds' in details)) return undefined;
  const value = details.retryAfterSeconds;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readNumber(payload: unknown, key: string): number | undefined {
  if (!payload || typeof payload !== 'object' || !(key in payload)) return undefined;
  const value = payload[key as keyof typeof payload];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
