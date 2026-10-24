import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type ProbeResult = { status: number; body: string; error?: string };

/** Plain HTTP GET with an explicit Host header (fetch cannot set Host), for ingress and published-port probes. */
export function httpProbe(url: string, options: { host?: string; timeoutMs?: number } = {}): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const target = new URL(url);
    const req = request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { Host: options.host ?? target.host, 'User-Agent': 'opfield-matrix' },
        timeout: options.timeoutMs ?? 8000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          if (chunks.reduce((sum, item) => sum + item.length, 0) < 65_536) chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ status: 0, body: '', error: error.message }));
    req.end();
  });
}

export type StreamProbe = {
  status: number;
  accelBuffering?: string;
  contentType?: string;
  firstEventMs?: number;
  error?: string;
};

/**
 * Opens an event stream, records the status, `X-Accel-Buffering` and how long the first event took, then hangs up.
 * `host` overrides the Host header (ingress probes); https targets skip certificate checks only when the runner was
 * told to accept a self-signed Opfield.
 */
export function sseProbe(
  url: string,
  options: { host?: string; headers?: Record<string, string>; timeoutMs?: number } = {}
) {
  return new Promise<StreamProbe>((resolve) => {
    const target = new URL(url);
    const started = Date.now();
    const transport = target.protocol === 'https:' ? httpsRequest : request;
    let settled = false;
    const result: StreamProbe = { status: 0 };
    const finish = (extra: Partial<StreamProbe> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ ...result, ...extra });
    };
    const timer = setTimeout(
      () => finish({ error: `no event within ${(options.timeoutMs ?? 15_000) / 1000}s` }),
      options.timeoutMs ?? 15_000
    );
    const req = transport(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { Host: options.host ?? target.host, Accept: 'text/event-stream', ...options.headers },
        rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
      },
      (res) => {
        result.status = res.statusCode ?? 0;
        result.accelBuffering = String(res.headers['x-accel-buffering'] ?? '');
        result.contentType = String(res.headers['content-type'] ?? '');
        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          if (/(^|\n)(data|event):/.test(buffer)) finish({ firstEventMs: Date.now() - started });
        });
        res.on('end', () => finish({ error: 'stream ended before an event' }));
      }
    );
    req.on('error', (error) => finish({ error: error.message }));
    req.end();
  });
}
