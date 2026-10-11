import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CatalogSyncResult } from './codex-catalog.js';
import { inspectCodexConfiguration, resolveCodexPaths } from './codex-config.js';
import { CodexIntegrationService } from './codex-integration.js';
import type { CredentialStore } from './credentials.js';
import { CLI_VERSION } from './discovery.js';
import type { Fetch } from './http.js';
import type { InferenceProxyDaemonManager } from './inference-proxy-daemon.js';
import { inferenceProxyDaemonManager } from './inference-proxy-daemon.js';
import type { CliPaths } from './paths.js';
import type { ProfileStore } from './profiles.js';
import { authenticatedSetupClient } from './session.js';

const FALLBACK_POLL_MS = 5 * 60_000;

export async function runInferenceMcp(input: {
  profileName: string;
  paths: CliPaths;
  profiles: ProfileStore;
  credentials: CredentialStore;
  fetch?: Fetch;
  signal?: AbortSignal;
  proxyDaemon?: InferenceProxyDaemonManager;
}): Promise<void> {
  const server = new McpServer({ name: 'wiolett-gateway-inference', version: CLI_VERSION });
  const integration = new CodexIntegrationService(input.paths, input.credentials, {
    fetch: input.fetch,
    proxyDaemon: input.proxyDaemon,
  });
  const integrationPaths = resolveCodexPaths(input.paths, input.profileName);
  const configured = await inspectCodexConfiguration({ paths: integrationPaths, profile: input.profileName });
  if (!configured.configured || !configured.baseUrl) {
    throw new Error('Opfield inference is not configured. Run setup codex again.');
  }
  const proxy = await (input.proxyDaemon ?? inferenceProxyDaemonManager).ensure({
    paths: input.paths,
    profileName: input.profileName,
    remoteBaseUrl: configured.baseUrl,
    runtimeFile: input.paths.runtimeFile,
  });
  let lastRefresh: { status: string; at: string; warning?: string } | null = null;
  let refreshPromise: Promise<CatalogSyncResult> | null = null;

  const refresh = async () => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async (): Promise<CatalogSyncResult> => {
      const refreshedContext = await authenticatedSetupClient(
        input.profileName,
        input.profiles,
        input.credentials,
        input.fetch
      );
      const result = await integration.sync({ profileName: input.profileName, discovery: refreshedContext.discovery });
      lastRefresh = {
        status: result.status,
        at: new Date().toISOString(),
        ...(result.warning ? { warning: result.warning } : {}),
      };
      return result;
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  };

  server.registerTool(
    'inference_status',
    { description: 'Inspect the local Opfield Codex integration and catalog freshness.' },
    async () => {
      const refreshedContext = await authenticatedSetupClient(
        input.profileName,
        input.profiles,
        input.credentials,
        input.fetch
      );
      const report = await integration.doctor({
        profileName: input.profileName,
        discovery: refreshedContext.discovery,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...report, proxy: proxy.baseUrl, lastRefresh }, null, 2) }],
        structuredContent: { ...report, proxy: proxy.baseUrl, lastRefresh },
      };
    }
  );
  server.registerTool(
    'inference_refresh',
    { description: 'Refresh the local Codex model catalog from Opfield.' },
    async () => {
      const result = await refresh();
      return {
        content: [
          {
            type: 'text',
            text: `Catalog ${result.status}; changes apply to the next Codex process.`,
          },
        ],
        structuredContent: { ...result },
      };
    }
  );

  void refresh().catch((error) =>
    process.stderr.write(`Opfield catalog startup refresh failed: ${messageOf(error)}\n`)
  );
  const controller = new AbortController();
  void monitorCatalog({ ...input, refresh, signal: controller.signal });
  const transport = new StdioServerTransport();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    controller.abort();
  };
  transport.onclose = () => void close();
  process.stdin.once('end', () => void close());
  input.signal?.addEventListener('abort', () => void close(), { once: true });
  try {
    await server.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }
}

async function monitorCatalog(input: {
  profileName: string;
  profiles: ProfileStore;
  credentials: CredentialStore;
  fetch?: Fetch;
  signal: AbortSignal;
  refresh: () => Promise<unknown>;
}) {
  const poll = schedulePoll(input.refresh, input.signal);
  let lastEventId: string | undefined;
  try {
    while (!input.signal.aborted) {
      try {
        const context = await authenticatedSetupClient(
          input.profileName,
          input.profiles,
          input.credentials,
          input.fetch
        );
        const response = await (input.fetch ?? globalThis.fetch)(
          new URL('/api/inference/setup/events', context.profile.origin),
          {
            headers: eventStreamHeaders(context.credential.accessToken, lastEventId),
            signal: input.signal,
          }
        );
        if (!response.ok || !response.body) throw new Error(`SSE returned HTTP ${response.status}`);
        // A conditional refresh on every connection closes the gap when the
        // server can no longer replay an old event ID from its bounded history.
        await refreshWithoutDisconnect(input.refresh, 'reconnect');
        try {
          await consumeSse(response.body, async (event, _data, eventId) => {
            if (eventId) lastEventId = eventId;
            if (event === 'invalidate') await refreshWithoutDisconnect(input.refresh, 'invalidation');
          });
        } finally {
          // If parsing or a callback fails, explicitly close the old stream
          // before reconnecting so repeated failures cannot leak SSE sockets.
          await response.body.cancel().catch(() => undefined);
        }
      } catch (error) {
        if (input.signal.aborted) break;
        process.stderr.write(`Opfield catalog event stream disconnected: ${messageOf(error)}\n`);
        await abortableDelay(5_000, input.signal);
      }
    }
  } finally {
    clearTimeout(poll.current);
  }
}

async function refreshWithoutDisconnect(refresh: () => Promise<unknown>, reason: string): Promise<void> {
  try {
    await refresh();
  } catch (error) {
    process.stderr.write(`Opfield catalog ${reason} refresh failed: ${messageOf(error)}\n`);
  }
}

export async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: string, id?: string) => Promise<void> | void
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let boundary = eventBoundary(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        let event = 'message';
        let id: string | undefined;
        const data: string[] = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('id:')) id = line.slice(3).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        await onEvent(event, data.join('\n'), id);
        boundary = eventBoundary(buffer);
      }
      if (chunk.done) return;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function eventStreamHeaders(accessToken: string, lastEventId?: string): Headers {
  const headers = new Headers({ Accept: 'text/event-stream', Authorization: `Bearer ${accessToken}` });
  if (lastEventId) headers.set('Last-Event-ID', lastEventId);
  return headers;
}

function eventBoundary(value: string): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
}

function schedulePoll(refresh: () => Promise<unknown>, signal: AbortSignal) {
  const holder: { current: ReturnType<typeof setTimeout> } = {
    current: setTimeout(() => {}, 0),
  };
  const schedule = () => {
    if (signal.aborted) return;
    const jitter = Math.round(FALLBACK_POLL_MS * (Math.random() * 0.2 - 0.1));
    holder.current = setTimeout(async () => {
      await refresh().catch((error) => process.stderr.write(`Opfield catalog poll failed: ${messageOf(error)}\n`));
      schedule();
    }, FALLBACK_POLL_MS + jitter);
    holder.current.unref();
  };
  clearTimeout(holder.current);
  schedule();
  return holder;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
