import { AppError } from '@/middleware/error-handler.js';

const CLOUDFLARE_API_ROOT = 'https://api.cloudflare.com/client/v4';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface CloudflareRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ code?: number; message?: string }>;
  result: T;
  result_info?: {
    page?: number;
    per_page?: number;
    total_pages?: number;
    count?: number;
    total_count?: number;
  };
}

export interface CloudflareZoneRef {
  id: string;
  name: string;
  status?: string | null;
  account?: {
    id?: string | null;
    name?: string | null;
  } | null;
}

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  proxiable?: boolean;
  comment?: string | null;
}

export interface CloudflareDnsRecordInput {
  type: 'A' | 'AAAA' | 'TXT';
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  comment?: string;
}

export class CloudflareClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async request<T>(path: string, options: CloudflareRequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          Authorization: `Bearer ${this.token}`,
          'User-Agent': 'Opfield Cloudflare Connector',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      const text = await response.text();
      const envelope = (text ? JSON.parse(text) : { result: null, success: response.ok }) as CloudflareEnvelope<T>;
      if (!response.ok || envelope.success === false) {
        const message = envelope.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join('; ');
        throw new AppError(response.status || 502, 'CLOUDFLARE_API_ERROR', message || 'Cloudflare API request failed', {
          status: response.status,
          path,
        });
      }
      return envelope.result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new AppError(504, 'CLOUDFLARE_API_TIMEOUT', 'Cloudflare API request timed out', { path });
      }
      throw new AppError(502, 'CLOUDFLARE_API_UNAVAILABLE', 'Cloudflare API request failed', {
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async paginate<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    maxPages = 20
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    while (page <= maxPages) {
      const envelope = await this.requestEnvelope<T[]>(path, {
        query: { ...query, page, per_page: query.per_page ?? 100 },
      });
      items.push(...envelope.result);
      const totalPages = envelope.result_info?.total_pages ?? page;
      if (page >= totalPages) break;
      page += 1;
    }
    return items;
  }

  async listZones(): Promise<CloudflareZoneRef[]> {
    return this.paginate<CloudflareZoneRef>('/zones', { status: 'active' });
  }

  async verifyToken(): Promise<{ id?: string; status?: string }> {
    return this.request<{ id?: string; status?: string }>('/user/tokens/verify');
  }

  async listDnsRecords(zoneId: string, name?: string): Promise<CloudflareDnsRecord[]> {
    return this.paginate<CloudflareDnsRecord>(`/zones/${zoneId}/dns_records`, { name });
  }

  async probeDnsRead(zoneId: string): Promise<void> {
    await this.request<CloudflareDnsRecord[]>(`/zones/${zoneId}/dns_records`, {
      query: { page: 1, per_page: 1 },
    });
  }

  async createDnsRecord(zoneId: string, input: CloudflareDnsRecordInput): Promise<CloudflareDnsRecord> {
    return this.request<CloudflareDnsRecord>(`/zones/${zoneId}/dns_records`, { method: 'POST', body: input });
  }

  async updateDnsRecord(
    zoneId: string,
    recordId: string,
    input: CloudflareDnsRecordInput
  ): Promise<CloudflareDnsRecord> {
    return this.request<CloudflareDnsRecord>(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PATCH',
      body: input,
    });
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request<unknown>(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
  }

  private async requestEnvelope<T>(
    path: string,
    options: CloudflareRequestOptions = {}
  ): Promise<CloudflareEnvelope<T>> {
    const url = this.buildUrl(path, options.query);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          Authorization: `Bearer ${this.token}`,
          'User-Agent': 'Opfield Cloudflare Connector',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await response.text();
      const envelope = (text ? JSON.parse(text) : { result: null, success: response.ok }) as CloudflareEnvelope<T>;
      if (!response.ok || envelope.success === false) {
        const message = envelope.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join('; ');
        throw new AppError(response.status || 502, 'CLOUDFLARE_API_ERROR', message || 'Cloudflare API request failed', {
          status: response.status,
          path,
        });
      }
      return envelope;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new AppError(504, 'CLOUDFLARE_API_TIMEOUT', 'Cloudflare API request timed out', { path });
      }
      throw new AppError(502, 'CLOUDFLARE_API_UNAVAILABLE', 'Cloudflare API request failed', {
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(path: string, query: CloudflareRequestOptions['query'] = {}): string {
    const url = new URL(`${CLOUDFLARE_API_ROOT}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}
