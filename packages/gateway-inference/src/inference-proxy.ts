import { createHash } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { CLI_VERSION } from './discovery.js';
import { CliError } from './errors.js';
import type { CliPaths } from './paths.js';

const HOST = '127.0.0.1';
const LOCAL_PATH = '/v1';
const HEALTH_PATH = '/__wiolett_gateway_inference_health';
const MIN_PORT = 49_152;
const PORT_RANGE = 10_000;
const REQUEST_HEADERS_TO_DROP = new Set([
  'authorization',
  'chatgpt-account-id',
  'connection',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'origin',
  'proxy-authorization',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-api-key',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-openai-actor-authorization',
]);
const RESPONSE_HEADERS_TO_DROP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface InferenceProxyHandle {
  baseUrl: string;
  owned: boolean;
  close(): Promise<void>;
}

export interface InferenceProxyHealth {
  service: 'wiolett-gateway-inference';
  instanceId: string;
  owner: 'daemon' | 'mcp';
  pid: number;
}

export function inferenceProxyPort(paths: CliPaths, profileName: string): number {
  const digest = createHash('sha256').update(paths.dataDir).update('\0').update(profileName).digest();
  return MIN_PORT + (digest.readUInt16BE(0) % PORT_RANGE);
}

export function inferenceProxyBaseUrl(paths: CliPaths, profileName: string): string {
  return `http://${HOST}:${inferenceProxyPort(paths, profileName)}${LOCAL_PATH}`;
}

export function inferenceProxyInstanceId(
  paths: CliPaths,
  profileName: string,
  remoteBaseUrl: string,
  runtimeVersion = CLI_VERSION
): string {
  return createHash('sha256')
    .update(paths.dataDir)
    .update('\0')
    .update(profileName)
    .update('\0')
    .update(normalizeRemoteBaseUrl(remoteBaseUrl))
    .update('\0')
    .update(runtimeVersion)
    .digest('base64url')
    .slice(0, 24);
}

export async function probeInferenceProxy(paths: CliPaths, profileName: string): Promise<InferenceProxyHealth | null> {
  return probePort(inferenceProxyPort(paths, profileName));
}

export async function startInferenceProxy(input: {
  paths: CliPaths;
  profileName: string;
  remoteBaseUrl: string;
  getToken: () => Promise<string>;
}): Promise<InferenceProxyHandle> {
  const remoteBaseUrl = normalizeRemoteBaseUrl(input.remoteBaseUrl);
  const port = inferenceProxyPort(input.paths, input.profileName);
  const baseUrl = inferenceProxyBaseUrl(input.paths, input.profileName);
  const instanceId = inferenceProxyInstanceId(input.paths, input.profileName, remoteBaseUrl);
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    if (request.url === HEALTH_PATH) {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(
        `${JSON.stringify({
          service: 'wiolett-gateway-inference',
          instanceId,
          owner: 'daemon',
          pid: process.pid,
        })}\n`
      );
      return;
    }
    void proxyHttpRequest(request, response, remoteBaseUrl, input.getToken);
  });

  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      try {
        const target = targetUrl(remoteBaseUrl, request.url);
        const token = await requireRuntimeToken(input.getToken);
        sockets.handleUpgrade(request, socket, head, (downstream) => {
          bridgeWebSocket(downstream, request, target, token);
        });
      } catch (error) {
        socket.end(
          `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${messageOf(error)}\n`
        );
      }
    })();
  });

  try {
    await listen(server, port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    sockets.close();
    if (await isMatchingProxy(port, instanceId)) {
      return { baseUrl, owned: false, close: async () => undefined };
    }
    throw new CliError(
      'INFERENCE_PROXY_PORT_IN_USE',
      `Local inference proxy port ${port} is already used by another process.`
    );
  }

  return {
    baseUrl,
    owned: true,
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await Promise.all([
        new Promise<void>((resolve) => sockets.close(() => resolve())),
        new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
      ]);
    },
  };
}

async function proxyHttpRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  remoteBaseUrl: string,
  getToken: () => Promise<string>
): Promise<void> {
  try {
    const target = targetUrl(remoteBaseUrl, incoming.url);
    const token = await requireRuntimeToken(getToken);
    const headers = sanitizeRequestHeaders(incoming.headers, token);
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: incoming.method,
      headers,
    });
    let upstreamResponse: IncomingMessage | undefined;
    const cleanup = () => {
      incoming.off('aborted', abortUpstream);
      response.off('close', abortUpstream);
      response.off('finish', cleanup);
    };
    const abortUpstream = () => {
      cleanup();
      request.destroy();
      upstreamResponse?.destroy();
    };
    incoming.once('aborted', abortUpstream);
    response.once('close', abortUpstream);
    response.once('finish', cleanup);
    request.on('response', (upstream) => {
      upstreamResponse = upstream;
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (value !== undefined && !RESPONSE_HEADERS_TO_DROP.has(name.toLowerCase())) responseHeaders[name] = value;
      }
      response.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, responseHeaders);
      upstream.pipe(response);
      upstream.on('error', (error) => response.destroy(error));
    });
    request.on('error', (error) => writeProxyError(response, error));
    incoming.pipe(request);
  } catch (error) {
    writeProxyError(response, error);
  }
}

function bridgeWebSocket(downstream: WebSocket, request: IncomingMessage, target: URL, token: string): void {
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  const protocols = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const upstream = new WebSocket(target, protocols.length > 0 ? protocols : undefined, {
    headers: sanitizeRequestHeaders(request.headers, token),
  });
  const queued: Array<{ data: Parameters<WebSocket['send']>[0]; isBinary: boolean }> = [];

  downstream.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING) queued.push({ data, isBinary });
  });
  upstream.on('open', () => {
    for (const message of queued.splice(0)) upstream.send(message.data, { binary: message.isBinary });
  });
  upstream.on('message', (data, isBinary) => {
    if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary: isBinary });
  });
  downstream.on('close', (code, reason) => closeWebSocket(upstream, code, reason));
  upstream.on('close', (code, reason) => closeWebSocket(downstream, code, reason));
  downstream.on('error', () => upstream.terminate());
  upstream.on('error', () => closeWebSocket(downstream, 1011, Buffer.from('Opfield WebSocket connection failed')));
}

function closeWebSocket(socket: WebSocket, code: number, reason: Buffer): void {
  const validCode =
    code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || code >= 3000;
  if (socket.readyState === WebSocket.OPEN) socket.close(validCode ? code : 1000, validCode ? reason : undefined);
  else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
}

function targetUrl(remoteBaseUrl: string, incomingPath: string | undefined): URL {
  const incoming = new URL(incomingPath ?? '/', `http://${HOST}`);
  if (incoming.pathname !== LOCAL_PATH && !incoming.pathname.startsWith(`${LOCAL_PATH}/`)) {
    throw new CliError('INFERENCE_PROXY_PATH_INVALID', `Unsupported local inference path: ${incoming.pathname}`);
  }
  const target = new URL(remoteBaseUrl);
  const suffix = incoming.pathname.slice(LOCAL_PATH.length);
  target.pathname = `${target.pathname.replace(/\/$/, '')}${suffix}`;
  target.search = incoming.search;
  return target;
}

function sanitizeRequestHeaders(headers: IncomingHttpHeaders, token: string): Record<string, string | string[]> {
  const sanitized: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !REQUEST_HEADERS_TO_DROP.has(name.toLowerCase())) sanitized[name] = value;
  }
  sanitized.authorization = `Bearer ${token}`;
  return sanitized;
}

async function requireRuntimeToken(getToken: () => Promise<string>): Promise<string> {
  const token = await getToken();
  if (!token.startsWith('gwi_')) {
    throw new CliError('RUNTIME_TOKEN_INVALID', 'Stored Opfield inference token is invalid. Run setup codex again.');
  }
  return token;
}

function normalizeRemoteBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('INFERENCE_PROXY_URL_INVALID', `Unsupported Opfield inference URL: ${url.protocol}`);
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function writeProxyError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  response.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify({ error: { type: 'gateway_proxy_error', message: messageOf(error) } })}\n`);
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen({ host: HOST, port }, () => {
      server.off('error', onError);
      resolve(server.address() as AddressInfo);
    });
  });
}

async function isMatchingProxy(port: number, instanceId: string): Promise<boolean> {
  return (await probePort(port))?.instanceId === instanceId;
}

async function probePort(port: number): Promise<InferenceProxyHealth | null> {
  try {
    const response = await fetch(`http://${HOST}:${port}${HEALTH_PATH}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<InferenceProxyHealth>;
    if (
      body.service !== 'wiolett-gateway-inference' ||
      typeof body.instanceId !== 'string' ||
      (body.owner !== 'daemon' && body.owner !== 'mcp') ||
      typeof body.pid !== 'number' ||
      !Number.isInteger(body.pid) ||
      body.pid <= 0
    ) {
      return null;
    }
    return body as InferenceProxyHealth;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
