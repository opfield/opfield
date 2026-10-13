import { type HostingHttp, HostingProviderError, type HostingRequestOptions } from '../hosting-http.js';

/** CloudBlast serves API v2 below the official console origin; the connector stores only the origin. */
export const CLOUDBLAST_API_PREFIX = '/api/v2';
/** CloudBlast documents every price, credit and invoice amount in EUR. */
export const CLOUDBLAST_CURRENCY = 'EUR';
const MAX_PAGES = 100;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Json = Record<string, unknown>;

export function unsafe(): never {
  throw new HostingProviderError(502, false, 'CloudBlast returned an unsafe response');
}
export function invalid(): never {
  throw new HostingProviderError(400, false, 'Invalid provider request');
}
export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function record(value: unknown): Json {
  return isRecord(value) ? value : unsafe();
}
export function optionalRecord(value: unknown): Json | null {
  return value === undefined || value === null ? null : record(value);
}
export function string(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : unsafe();
}
export function optionalString(value: unknown): string | null {
  return value === undefined || value === null || value === '' ? null : string(value);
}
export function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return string(value);
}
export function uuid(value: unknown): string {
  const text = string(value);
  return UUID.test(text) ? text.toLowerCase() : unsafe();
}
export function number(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return unsafe();
}
export function values(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : unsafe();
}
export function input(value: string | undefined): string {
  return typeof value === 'string' && value.trim() !== '' ? value : invalid();
}
/** Sizes are documented in bytes; Opfield reports MiB for memory and GiB for disks. */
export function bytesTo(value: unknown, unit: number): number | null {
  const amount = number(value);
  return amount === null ? null : Math.round(amount / unit);
}
/** A malformed success after a write is not proof that the write was rejected. */
export function mutationResponse<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new HostingProviderError(
      error instanceof HostingProviderError ? error.providerStatus : 502,
      true,
      'CloudBlast returned an invalid mutation response'
    );
  }
}

export class CloudBlastApi {
  constructor(private readonly http: HostingHttp) {}

  async request<T = unknown>(path: string, options: HostingRequestOptions = {}): Promise<T> {
    try {
      return await this.http.request<T>(`${CLOUDBLAST_API_PREFIX}${path}`, options);
    } catch (error) {
      if (error instanceof HostingProviderError) throw error;
      throw new HostingProviderError(502, (options.method ?? 'GET') !== 'GET', 'Provider request failed');
    }
  }

  /** Every success response is wrapped in `{ data }`. */
  async data(path: string, options: HostingRequestOptions = {}): Promise<unknown> {
    return record(await this.request(path, options)).data;
  }

  /** Unpaginated collections (locations, templates, security groups). */
  async array<T>(path: string, parse: (value: unknown) => T): Promise<T[]> {
    const rows = await this.data(path);
    return Array.isArray(rows) ? rows.map(parse) : unsafe();
  }

  /** Paginated collections must report their pages; a partial list never proves absence. */
  async pages<T>(path: string, parse: (value: unknown) => T, query: HostingRequestOptions['query'] = {}): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const root = record(await this.request(path, { query: { ...query, page } }));
      if (!Array.isArray(root.data)) return unsafe();
      result.push(...root.data.map(parse));
      const meta = record(root.meta);
      const current = number(meta.current_page);
      const last = number(meta.last_page);
      if (current !== page || last === null) return unsafe();
      if (current >= last) return result;
    }
    throw new HostingProviderError(502, false, 'CloudBlast pagination was incomplete');
  }

  server(remoteId: string): string {
    return `/servers/${encodeURIComponent(input(remoteId))}`;
  }
}
