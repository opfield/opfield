import type { WSContext } from 'hono/ws';
import { container } from '@/container.js';
import type { CommandResult } from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import { resolveWebSocketCredential, type WebSocketCredential } from '@/modules/auth/websocket-auth.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { type ManagedDatabaseLogTarget, ManagedDatabaseService } from './managed-databases.service.js';

const logger = createChildLogger('ManagedDatabaseLogStream');
const DOCKER_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s/;
const BATCH_SIZE = 200;
const LOG_ACCESS_RECHECK_INTERVAL_MS = 30_000;

type LogChunkHandler = (lines: string[], ended: boolean) => void;

export interface ManagedDatabaseLogFollowSubscription {
  /** (Re)start the daemon follow stream, ordered after any pending stop for the same container. */
  start(since: string | undefined): Promise<CommandResult>;
  /** Detach this viewer. The last viewer of a container stops the daemon-side follow. Idempotent. */
  unsubscribe(): void;
}

interface LogFollowChannel {
  subscribers: Set<LogChunkHandler>;
  unregister: () => void;
}

interface LogFollowState {
  channels: Map<string, LogFollowChannel>;
  commands: Map<string, Promise<void>>;
}

// The registry keeps one handler per `${nodeId}:${containerId}` key and the daemon keeps one
// follow stream per container, so every viewer of a database's logs shares one registry handler
// that fans chunks out to all of them (the same pattern as Docker container logs).
const followStates = new WeakMap<NodeRegistryService, LogFollowState>();

function getFollowState(registry: NodeRegistryService): LogFollowState {
  let state = followStates.get(registry);
  if (!state) {
    state = { channels: new Map(), commands: new Map() };
    followStates.set(registry, state);
  }
  return state;
}

// The daemon runs log commands concurrently, so a stop and a following restart for the same
// container must reach it in order or the stop could cancel the new viewer's stream.
function enqueueFollowCommand(
  state: LogFollowState,
  key: string,
  run: () => Promise<CommandResult>
): Promise<CommandResult> {
  const next = (state.commands.get(key) ?? Promise.resolve()).then(run);
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  state.commands.set(key, settled);
  void settled.then(() => {
    if (state.commands.get(key) === settled) state.commands.delete(key);
  });
  return next;
}

export function subscribeManagedDatabaseLogFollow(
  registry: NodeRegistryService,
  dispatch: NodeDispatchService,
  target: ManagedDatabaseLogTarget,
  handler: LogChunkHandler
): ManagedDatabaseLogFollowSubscription {
  const key = `${target.nodeId}:${target.containerId}`;
  const state = getFollowState(registry);
  let channel = state.channels.get(key);
  if (!channel) {
    const subscribers = new Set<LogChunkHandler>();
    const unregister = registry.registerLogStreamHandler(key, (lines, ended) => {
      for (const subscriber of [...subscribers]) subscriber(lines, ended === true);
    });
    channel = { subscribers, unregister };
    state.channels.set(key, channel);
  }
  const joined = channel;
  const subscriber: LogChunkHandler = (lines, ended) => handler(lines, ended);
  joined.subscribers.add(subscriber);
  let subscribed = true;

  return {
    start: (since) =>
      enqueueFollowCommand(state, key, () =>
        dispatch.sendManagedDatabaseLogsCommand(target.nodeId, target.managedDatabaseId, {
          tailLines: 0,
          follow: true,
          timestamps: true,
          since,
        })
      ),
    unsubscribe() {
      if (!subscribed) return;
      subscribed = false;
      joined.subscribers.delete(subscriber);
      if (joined.subscribers.size > 0 || state.channels.get(key) !== joined) return;
      state.channels.delete(key);
      joined.unregister();
      enqueueFollowCommand(state, key, () =>
        dispatch.stopManagedDatabaseLogStream(target.nodeId, target.managedDatabaseId)
      ).catch((error) => {
        logger.debug('Failed to stop managed database log stream', {
          managedDatabaseId: target.managedDatabaseId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };
}

interface ManagedLogStreamState {
  authenticated: boolean;
  target: ManagedDatabaseLogTarget | null;
  subscription: ManagedDatabaseLogFollowSubscription | null;
  oldestTimestamp?: string;
  loadingMore: boolean;
  keepaliveInterval: ReturnType<typeof setInterval> | null;
}

const states = new WeakMap<WSContext, ManagedLogStreamState>();

function send(ws: WSContext, message: Record<string, unknown>) {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The socket may already be closed.
  }
}

function extractTimestamp(line: string | undefined): string | undefined {
  return line?.match(DOCKER_TS_RE)?.[1];
}

function decrementTimestamp(timestamp: string): string {
  const match = timestamp.match(/^(.+\.)(\d+)Z$/);
  if (!match) return timestamp;
  const nanos = BigInt(match[2].padEnd(9, '0')) - 1n;
  return nanos < 0n ? timestamp : `${match[1]}${nanos.toString().padStart(9, '0')}Z`;
}

async function authorize(credential: WebSocketCredential | null, databaseId: string) {
  return resolveWebSocketCredential(credential, `databases:view:${databaseId}`);
}

export function createManagedDatabaseLogStreamWSHandlers(
  databaseId: string,
  tail: number,
  credential: WebSocketCredential | null
) {
  const databases = container.resolve(ManagedDatabaseService);
  const dispatch = container.resolve(NodeDispatchService);
  const registry = container.resolve(NodeRegistryService);

  const stopStream = (state: ManagedLogStreamState) => {
    state.subscription?.unsubscribe();
    state.subscription = null;
  };

  const closeSocket = (ws: WSContext, code: number, reason: string) => {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  };

  const cleanup = (ws: WSContext) => {
    const state = states.get(ws);
    if (!state) return;
    state.authenticated = false;
    stopStream(state);
    if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
    states.delete(ws);
  };

  // Access is checked at open, before history pages, and by the keepalive timer; never per chunk.
  const revalidate = async (ws: WSContext, state: ManagedLogStreamState, emitPong = false) => {
    if (states.get(ws) !== state) return false;
    const auth = await authorize(credential, databaseId);
    if (states.get(ws) !== state) return false;
    if (!auth) {
      cleanup(ws);
      send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
      closeSocket(ws, 1008, 'Authentication failed');
      return false;
    }
    if (!state.target || !registry.getNode(state.target.nodeId)) {
      cleanup(ws);
      send(ws, { type: 'error', message: 'Database node is not connected' });
      closeSocket(ws, 1011, 'Node not connected');
      return false;
    }
    if (emitPong) send(ws, { type: 'pong' });
    return true;
  };

  const loadMore = async (ws: WSContext, state: ManagedLogStreamState) => {
    try {
      if (!state.oldestTimestamp) {
        send(ws, { type: 'history', lines: [], hasMore: false });
        return;
      }
      const lines = await databases.getLogs(databaseId, {
        tailLines: BATCH_SIZE,
        follow: false,
        timestamps: true,
        until: decrementTimestamp(state.oldestTimestamp),
      });
      state.oldestTimestamp = extractTimestamp(lines[0]) ?? state.oldestTimestamp;
      send(ws, { type: 'history', lines, hasMore: lines.length >= BATCH_SIZE });
    } catch (error) {
      send(ws, { type: 'error', message: error instanceof Error ? error.message : 'Failed to load more logs' });
    } finally {
      state.loadingMore = false;
    }
  };

  const start = async (ws: WSContext, state: ManagedLogStreamState) => {
    const auth = await authorize(credential, databaseId);
    if (states.get(ws) !== state) return;
    if (!auth) {
      send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
      closeSocket(ws, 1008, 'Authentication failed');
      return;
    }
    state.authenticated = true;

    let target: Awaited<ReturnType<typeof databases.resolveLogTarget>>;
    try {
      target = await databases.resolveLogTarget(databaseId);
    } catch (error) {
      // A database without its engine container (a create or recreate that failed): its node keeps the log of the
      // failed start, which is shown once; there is nothing to follow.
      const kept = await databases
        .getLogs(databaseId, { tailLines: tail, follow: false, timestamps: true })
        .catch(() => null);
      if (states.get(ws) !== state) return;
      if (!kept || kept.length === 0) throw error;
      send(ws, { type: 'initial', lines: kept, hasMore: false });
      send(ws, { type: 'logs_ended' });
      closeSocket(ws, 1000, 'Log stream ended');
      return;
    }
    if (states.get(ws) !== state) return;
    state.target = target;
    if (!registry.getNode(target.nodeId)) {
      send(ws, { type: 'error', message: 'Database node is not connected' });
      closeSocket(ws, 1011, 'Node not connected');
      return;
    }

    const initialLines = await databases.getLogs(databaseId, {
      tailLines: tail,
      follow: false,
      timestamps: true,
    });
    if (states.get(ws) !== state) return;
    state.oldestTimestamp = extractTimestamp(initialLines[0]);
    send(ws, { type: 'initial', lines: initialLines, hasMore: initialLines.length >= tail });

    const subscription = subscribeManagedDatabaseLogFollow(registry, dispatch, target, (lines, ended) => {
      if (states.get(ws) !== state || state.subscription !== subscription || !state.authenticated) return;
      if (ended) {
        send(ws, { type: 'logs_ended' });
        closeSocket(ws, 1000, 'Log stream ended');
        return;
      }
      if (lines.length > 0) send(ws, { type: 'new', lines });
    });
    state.subscription = subscription;

    let result: CommandResult;
    try {
      result = await subscription.start(extractTimestamp(initialLines.at(-1)));
    } catch (error) {
      if (states.get(ws) !== state || state.subscription !== subscription) return;
      stopStream(state);
      send(ws, { type: 'error', message: error instanceof Error ? error.message : 'Failed to start log stream' });
      closeSocket(ws, 1011, 'Stream start failed');
      return;
    }
    if (states.get(ws) !== state || state.subscription !== subscription) return;
    if (!result.success) {
      stopStream(state);
      send(ws, { type: 'error', message: result.error || 'Failed to start log stream' });
      closeSocket(ws, 1011, 'Stream start failed');
      return;
    }
    send(ws, { type: 'connected', streaming: true });
  };

  return {
    onOpen(_event: Event, ws: WSContext) {
      const state: ManagedLogStreamState = {
        authenticated: false,
        target: null,
        subscription: null,
        loadingMore: false,
        keepaliveInterval: null,
      };
      states.set(ws, state);
      state.keepaliveInterval = setInterval(
        () => void revalidate(ws, state, true).catch(() => undefined),
        LOG_ACCESS_RECHECK_INTERVAL_MS
      );
      start(ws, state).catch((error) => {
        if (states.get(ws) !== state) return;
        cleanup(ws);
        logger.error('Managed database log stream start failed', {
          databaseId,
          error: error instanceof Error ? error.message : String(error),
        });
        send(ws, { type: 'error', message: error instanceof Error ? error.message : 'Failed to open database logs' });
        closeSocket(ws, 1011, 'Stream start failed');
      });
    },

    onMessage(event: MessageEvent, ws: WSContext) {
      const state = states.get(ws);
      if (!state) return;
      try {
        const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        if (message?.type === 'ping') send(ws, { type: 'pong' });
        if (message?.type === 'load_more' && state.authenticated && !state.loadingMore) {
          state.loadingMore = true;
          void revalidate(ws, state)
            .then((allowed) => {
              if (allowed) return loadMore(ws, state);
              state.loadingMore = false;
            })
            .catch(() => {
              state.loadingMore = false;
            });
        }
      } catch {
        // Ignore invalid client frames.
      }
    },

    onClose(_event: unknown, ws: WSContext) {
      cleanup(ws);
    },

    onError(_event: Event, ws: WSContext) {
      cleanup(ws);
    },
  };
}
