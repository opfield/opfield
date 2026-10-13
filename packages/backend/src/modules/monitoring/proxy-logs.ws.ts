import type { WSContext } from 'hono/ws';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import { resolveWebSocketCredential, type WebSocketCredential } from '@/modules/auth/websocket-auth.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { User } from '@/types.js';
import { getNginxLogHistory, logRelay, type RelayedLogEntry } from './log-relay.service.js';
import { requestProxyLogHistory, resolveProxyLogNodes, subscribeProxyLogs } from './proxy-log-nodes.js';

const logger = createChildLogger('ProxyLogStream');
const HISTORY_BATCH_SIZE = 200;
const MAX_HISTORY_ENTRIES = 5_000;

interface ProxyLogStreamWSState {
  user: User | null;
  authenticated: boolean;
  streaming: boolean;
  keepaliveInterval: ReturnType<typeof setInterval> | null;
  cleanupSubscription: (() => void) | null;
  loadingMore: boolean;
  pendingWhileLoading: RelayedLogEntry[];
  historyLoadedCount: number;
  oldestHistoryKey: string | null;
  newestHistoryKey: string | null;
  hasMore: boolean;
}

const wsStates = new WeakMap<WSContext, ProxyLogStreamWSState>();

async function authorizeLogAccess(credential: WebSocketCredential | null, hostId: string): Promise<User | null> {
  const result = await resolveWebSocketCredential(credential, `proxy:view:${hostId}`);
  return result?.user ?? null;
}

function send(ws: WSContext, msg: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Connection may already be closed.
  }
}

export function proxyLogEntryKey(entry: RelayedLogEntry): string {
  return [
    entry.nodeId,
    entry.logType,
    entry.timestamp,
    entry.remoteAddr,
    entry.method,
    entry.path,
    entry.status,
    entry.bodyBytesSent,
    entry.raw,
    entry.level,
  ].join('\u0000');
}

export function selectProxyLogHistoryPage(
  snapshot: RelayedLogEntry[],
  pending: RelayedLogEntry[],
  oldestHistoryKey: string | null,
  newestHistoryKey: string | null,
  batchSize = HISTORY_BATCH_SIZE
): { entries: RelayedLogEntry[]; liveEntries: RelayedLogEntry[]; hasMore: boolean } {
  const historySnapshot = snapshot.filter((entry) => entry.logType !== 'error');
  const oldestIndex = oldestHistoryKey
    ? historySnapshot.findIndex((entry) => proxyLogEntryKey(entry) === oldestHistoryKey)
    : historySnapshot.length;
  const end = Math.max(0, oldestIndex >= 0 ? oldestIndex : historySnapshot.length);
  const start = Math.max(0, end - batchSize);
  const newestIndex = newestHistoryKey
    ? historySnapshot.findIndex((entry) => proxyLogEntryKey(entry) === newestHistoryKey)
    : -1;
  const liveAccessKeys = new Set(newestIndex >= 0 ? historySnapshot.slice(newestIndex + 1).map(proxyLogEntryKey) : []);
  const snapshotKeys = new Set(snapshot.map(proxyLogEntryKey));
  const liveByKey = new Map<string, RelayedLogEntry>();
  for (const entry of snapshot) {
    const key = proxyLogEntryKey(entry);
    if (entry.logType === 'error' || liveAccessKeys.has(key)) liveByKey.set(key, entry);
  }
  for (const entry of pending) {
    const key = proxyLogEntryKey(entry);
    if (!snapshotKeys.has(key)) liveByKey.set(key, entry);
  }
  return {
    entries: historySnapshot.slice(start, end),
    liveEntries: [...liveByKey.values()],
    hasMore: start > 0,
  };
}

/** The nodes whose logs a route view shows: its node, or every member of its ingress group. */
async function resolveHostNodes(hostId: string): Promise<string[]> {
  return resolveProxyLogNodes(container.resolve(TOKENS.DrizzleClient) as DrizzleClient, hostId);
}

export function createProxyLogStreamWSHandlers(hostId: string, tail: number, credential: WebSocketCredential | null) {
  const registry = container.resolve(NodeRegistryService);

  return {
    onOpen(_event: Event, ws: WSContext) {
      const state: ProxyLogStreamWSState = {
        user: null,
        authenticated: false,
        streaming: false,
        keepaliveInterval: null,
        cleanupSubscription: null,
        loadingMore: false,
        pendingWhileLoading: [],
        historyLoadedCount: 0,
        oldestHistoryKey: null,
        newestHistoryKey: null,
        hasMore: true,
      };
      wsStates.set(ws, state);

      state.keepaliveInterval = setInterval(() => {
        void revalidateLogAccess(ws, state, credential, hostId, true);
      }, 30_000);

      authenticateAndStartStream(ws, state, credential, hostId, tail, registry).catch((err) => {
        logger.error('Proxy log stream start failed', {
          hostId,
          error: err instanceof Error ? err.message : String(err),
        });
        send(ws, { type: 'error', message: 'Failed to start log stream' });
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      });
    },

    async onMessage(event: MessageEvent, ws: WSContext) {
      const state = wsStates.get(ws);
      if (!state) return;

      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      try {
        const msg = JSON.parse(raw);
        if (msg?.type === 'ping') {
          send(ws, { type: 'pong' });
        }
        if (msg?.type === 'load_more') {
          if (!state.authenticated || state.loadingMore || !state.hasMore) return;
          if (!(await revalidateLogAccess(ws, state, credential, hostId))) return;
          state.loadingMore = true;
          handleLoadMore(ws, state, hostId, registry).catch((err) => {
            state.loadingMore = false;
            logger.error('Proxy log load_more failed', {
              hostId,
              error: err instanceof Error ? err.message : String(err),
            });
            send(ws, { type: 'error', message: 'Failed to load more logs' });
          });
        }
      } catch {
        // ignore invalid JSON
      }
    },

    onClose(_event: unknown, ws: WSContext) {
      cleanup(ws);
      logger.info('Proxy log stream WS closed', { hostId });
    },

    onError(_error: Event, ws: WSContext) {
      cleanup(ws);
      logger.error('Proxy log stream WS error', { hostId });
    },
  };

  function cleanup(ws: WSContext) {
    const state = wsStates.get(ws);
    if (!state) return;
    if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
    state.cleanupSubscription?.();
    wsStates.delete(ws);
  }
}

async function authenticateAndStartStream(
  ws: WSContext,
  state: ProxyLogStreamWSState,
  credential: WebSocketCredential | null,
  hostId: string,
  tail: number,
  registry: NodeRegistryService
): Promise<void> {
  const user = await authorizeLogAccess(credential, hostId);
  if (!user) {
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    ws.close(1008, 'Authentication failed');
    return;
  }

  state.user = user;
  state.authenticated = true;

  const nodeIds = await resolveHostNodes(hostId);
  if (nodeIds.length === 0) {
    send(ws, { type: 'error', message: 'Route has no nginx node assigned' });
    ws.close(1011, 'Node not connected');
    return;
  }
  const servingNodes = new Set(nodeIds);

  const onLog = (entry: RelayedLogEntry) => {
    if (!servingNodes.has(entry.nodeId) || entry.hostId !== hostId) return;
    if (state.loadingMore) {
      state.pendingWhileLoading.push(entry);
      return;
    }
    if (state.streaming) {
      if (entry.logType !== 'error') {
        state.historyLoadedCount += 1;
        const key = proxyLogEntryKey(entry);
        if (!state.oldestHistoryKey) state.oldestHistoryKey = key;
        state.newestHistoryKey = key;
      }
      send(ws, { type: 'new', entries: [entry] });
    }
  };

  logRelay.on('log', onLog);
  const subscription = subscribeProxyLogs(registry, nodeIds, hostId);
  if (!subscription.ok) {
    logRelay.off('log', onLog);
    send(ws, { type: 'error', message: subscription.message });
    ws.close(1011, 'Stream start failed');
    return;
  }
  state.cleanupSubscription = () => {
    logRelay.off('log', onLog);
    subscription.cleanup();
  };

  state.loadingMore = true;
  state.pendingWhileLoading = [];
  const normalizedTail = Math.max(1, Math.min(Math.floor(tail), HISTORY_BATCH_SIZE));
  const bufferedEntries = getNginxLogHistory(hostId).filter((entry) => servingNodes.has(entry.nodeId));
  if (bufferedEntries.length > 0) {
    send(ws, {
      type: 'initial',
      entries: bufferedEntries.slice(-normalizedTail),
      hasMore: true,
      cached: true,
    });
  }

  const initialResult = await requestProxyLogHistory(registry, nodeIds, hostId, normalizedTail + 1);
  if (!initialResult.ok && bufferedEntries.length === 0) {
    state.loadingMore = false;
    state.pendingWhileLoading = [];
    send(ws, { type: 'error', message: initialResult.message });
    ws.close(1011, 'Initial fetch failed');
    return;
  }

  const initialSnapshot = initialResult.ok ? initialResult.entries : bufferedEntries;
  const initialEntries = initialSnapshot.slice(-normalizedTail);
  const initialHistoryEntries = initialEntries.filter((entry) => entry.logType !== 'error');
  const initialHistorySnapshot = initialSnapshot.filter((entry) => entry.logType !== 'error');
  state.historyLoadedCount = initialHistoryEntries.length;
  state.oldestHistoryKey = initialHistoryEntries[0] ? proxyLogEntryKey(initialHistoryEntries[0]) : null;
  state.newestHistoryKey = initialHistoryEntries.at(-1) ? proxyLogEntryKey(initialHistoryEntries.at(-1)!) : null;
  state.hasMore = initialResult.ok ? initialHistorySnapshot.length > initialHistoryEntries.length : true;
  const snapshotKeys = new Set(initialSnapshot.map(proxyLogEntryKey));
  const liveEntries = state.pendingWhileLoading.filter((entry) => !snapshotKeys.has(proxyLogEntryKey(entry)));
  state.pendingWhileLoading = [];
  state.loadingMore = false;
  send(ws, {
    type: bufferedEntries.length > 0 ? 'sync' : 'initial',
    entries: initialEntries,
    hasMore: state.hasMore,
  });

  state.streaming = true;
  send(ws, { type: 'connected', streaming: true });
  if (liveEntries.length > 0) {
    const liveHistoryEntries = liveEntries.filter((entry) => entry.logType !== 'error');
    state.historyLoadedCount += liveHistoryEntries.length;
    if (!state.oldestHistoryKey && liveHistoryEntries[0]) {
      state.oldestHistoryKey = proxyLogEntryKey(liveHistoryEntries[0]);
    }
    if (liveHistoryEntries.at(-1)) {
      state.newestHistoryKey = proxyLogEntryKey(liveHistoryEntries.at(-1)!);
    }
    send(ws, { type: 'new', entries: liveEntries });
  }
}

async function handleLoadMore(
  ws: WSContext,
  state: ProxyLogStreamWSState,
  hostId: string,
  registry: NodeRegistryService
) {
  try {
    if (state.historyLoadedCount >= MAX_HISTORY_ENTRIES) {
      state.hasMore = false;
      send(ws, { type: 'history', entries: [], hasMore: false });
      return;
    }

    const nodeIds = await resolveHostNodes(hostId);
    if (nodeIds.length === 0) {
      send(ws, { type: 'history', entries: [], hasMore: false });
      state.hasMore = false;
      return;
    }

    state.pendingWhileLoading = [];
    const requestedTail = Math.min(state.historyLoadedCount + HISTORY_BATCH_SIZE + 1, MAX_HISTORY_ENTRIES + 1);
    const result = await requestProxyLogHistory(registry, nodeIds, hostId, requestedTail);
    if (!result.ok) {
      send(ws, { type: 'error', message: result.message });
      return;
    }

    const page = selectProxyLogHistoryPage(
      result.entries,
      state.pendingWhileLoading,
      state.oldestHistoryKey,
      state.newestHistoryKey
    );
    state.historyLoadedCount += page.entries.length;
    if (page.entries[0]) state.oldestHistoryKey = proxyLogEntryKey(page.entries[0]);
    state.hasMore = state.historyLoadedCount < MAX_HISTORY_ENTRIES && page.hasMore;
    send(ws, { type: 'history', entries: page.entries, hasMore: state.hasMore });

    if (page.liveEntries.length > 0) {
      const liveHistoryEntries = page.liveEntries.filter((entry) => entry.logType !== 'error');
      state.historyLoadedCount += liveHistoryEntries.length;
      if (!state.oldestHistoryKey && liveHistoryEntries[0]) {
        state.oldestHistoryKey = proxyLogEntryKey(liveHistoryEntries[0]);
      }
      if (liveHistoryEntries.at(-1)) {
        state.newestHistoryKey = proxyLogEntryKey(liveHistoryEntries.at(-1)!);
      }
      send(ws, { type: 'new', entries: page.liveEntries });
    }
  } finally {
    state.pendingWhileLoading = [];
    state.loadingMore = false;
  }
}

async function revalidateLogAccess(
  ws: WSContext,
  state: ProxyLogStreamWSState,
  credential: WebSocketCredential | null,
  hostId: string,
  emitPong = false
): Promise<boolean> {
  const user = await authorizeLogAccess(credential, hostId);
  if (!user) {
    state.authenticated = false;
    state.cleanupSubscription?.();
    state.cleanupSubscription = null;
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    try {
      ws.close(1008, 'Authentication failed');
    } catch {
      /* ignore */
    }
    return false;
  }

  state.user = user;
  if (emitPong) send(ws, { type: 'pong' });
  return true;
}
