import { createHash, createHmac } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';
import type { RegistryS3Settings } from '@/foundation/registry-storage.js';

/**
 * A minimal S3 client (Signature Version 4) for the registry storage switch: probe, copy and list objects. Every
 * plan can put its registry on S3, so this does not depend on the paid object storage module.
 */

const REQUEST_TIMEOUT_MS = 60_000;
/** A single PUT takes at most 5 GiB on S3. */
export const S3_SINGLE_PUT_LIMIT_BYTES = 5 * 1024 ** 3;

export class S3RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message);
    this.name = 'S3RequestError';
  }
}

export interface S3ObjectEntry {
  key: string;
  size: number;
}

type S3Body = Buffer | { stream: Readable; length: number; sha256: string };

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** RFC 3986 encoding as SigV4 expects it; `/` stays in object keys. */
function encodeRfc3986(value: string, keepSlash = false): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((match) => decodeXml(match[1]!));
}

async function readAll(response: IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      response.destroy();
      throw new Error('S3 response is too large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export class RegistryS3Client {
  private readonly endpoint: URL;

  constructor(private readonly settings: RegistryS3Settings) {
    this.endpoint = new URL(settings.endpoint ?? `https://s3.${settings.region}.amazonaws.com`);
  }

  /** Where the bucket lives, for messages; never carries a key. */
  describe(): string {
    return `${this.endpoint.origin}/${this.settings.bucket}`;
  }

  async putObject(key: string, body: S3Body): Promise<void> {
    const response = await this.send('PUT', key, {}, body);
    await this.expectStatus(response, 'PUT', [200]);
  }

  async getObject(key: string): Promise<IncomingMessage> {
    const response = await this.send('GET', key, {});
    await this.expectStatus(response, 'GET', [200], false);
    return response;
  }

  async getObjectBuffer(key: string, limit?: number): Promise<Buffer> {
    return readAll(await this.getObject(key), limit);
  }

  async headObject(key: string): Promise<boolean> {
    const response = await this.send('HEAD', key, {});
    response.resume();
    if (response.statusCode === 404) return false;
    await this.expectStatus(response, 'HEAD', [200]);
    return true;
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.send('DELETE', key, {});
    await this.expectStatus(response, 'DELETE', [200, 204]);
  }

  /** Objects under a prefix, page by page (ListObjectsV2). */
  async *listObjects(prefix: string, maxKeys = 1000): AsyncGenerator<S3ObjectEntry> {
    let continuationToken: string | null = null;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': String(maxKeys) };
      if (continuationToken) query['continuation-token'] = continuationToken;
      const response = await this.send('GET', '', query);
      await this.expectStatus(response, 'LIST', [200], false);
      const xml = (await readAll(response, 32 * 1024 * 1024)).toString('utf8');
      const contents = xmlValues(xml, 'Contents');
      for (const entry of contents) {
        const key = xmlValues(entry, 'Key')[0];
        if (key !== undefined) yield { key, size: Number(xmlValues(entry, 'Size')[0] ?? 0) };
      }
      const truncated = xmlValues(xml, 'IsTruncated')[0] === 'true';
      continuationToken = truncated ? (xmlValues(xml, 'NextContinuationToken')[0] ?? null) : null;
    } while (continuationToken);
  }

  async hasObjectsUnder(prefix: string): Promise<boolean> {
    for await (const _entry of this.listObjects(prefix, 1)) return true;
    return false;
  }

  private async expectStatus(
    response: IncomingMessage,
    operation: string,
    expected: number[],
    drain = true
  ): Promise<void> {
    const status = response.statusCode ?? 0;
    if (expected.includes(status)) {
      if (drain) response.resume();
      return;
    }
    const body = operation === 'HEAD' ? '' : (await readAll(response).catch(() => Buffer.alloc(0))).toString('utf8');
    const code = xmlValues(body, 'Code')[0] ?? null;
    const message = xmlValues(body, 'Message')[0] ?? null;
    throw new S3RequestError(
      `S3 ${operation} on ${this.describe()} failed (${status}${code ? ` ${code}` : ''})${message ? `: ${message}` : ''}`,
      status,
      code
    );
  }

  private send(
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    key: string,
    query: Record<string, string>,
    body?: S3Body
  ): Promise<IncomingMessage> {
    const { settings, endpoint } = this;
    const pathStyle = settings.forcePathStyle;
    const host = pathStyle ? endpoint.host : `${settings.bucket}.${endpoint.host}`;
    const basePath = endpoint.pathname.replace(/\/+$/, '');
    const objectPath = key ? `/${encodeRfc3986(key, true)}` : '/';
    const canonicalUri = pathStyle
      ? `${basePath}/${encodeRfc3986(settings.bucket)}${key ? objectPath : ''}`
      : `${basePath}${objectPath}`;
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query[name]!)}`)
      .join('&');
    const payloadHash = !body ? sha256Hex('') : Buffer.isBuffer(body) ? sha256Hex(body) : body.sha256;
    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const scope = `${day}/${settings.region}/s3/aws4_request`;
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    const signedHeaders = Object.keys(headers).sort();
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      signedHeaders.map((name) => `${name}:${headers[name]}\n`).join(''),
      signedHeaders.join(';'),
      payloadHash,
    ].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${settings.secretAccessKey}`, day), settings.region), 's3'),
      'aws4_request'
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const requestHeaders: Record<string, string | number> = {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${settings.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
    };
    if (body) requestHeaders['content-length'] = Buffer.isBuffer(body) ? body.length : body.length;
    const transport = endpoint.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const request = transport.request(
        {
          method,
          protocol: endpoint.protocol,
          hostname: pathStyle ? endpoint.hostname : `${settings.bucket}.${endpoint.hostname}`,
          port: endpoint.port || undefined,
          path: `${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`,
          headers: requestHeaders,
          timeout: REQUEST_TIMEOUT_MS,
        },
        resolve
      );
      request.on('timeout', () => request.destroy(new Error(`S3 ${method} on ${this.describe()} timed out`)));
      request.on('error', (error) =>
        reject(new Error(`S3 ${method} on ${this.describe()} failed: ${(error as Error).message}`))
      );
      if (!body) request.end();
      else if (Buffer.isBuffer(body)) request.end(body);
      else {
        body.stream.on('error', (error) => request.destroy(error));
        body.stream.pipe(request);
      }
    });
  }
}
