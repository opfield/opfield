import { eq } from 'drizzle-orm';
import type { WSContext } from 'hono/ws';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { compareSemver, parseSemver } from '@/lib/semver.js';
import {
  auditWebSocketSession,
  captureWebSocketAuditOrigin,
  type WebSocketAuditOrigin,
} from '@/modules/audit/websocket-session-audit.js';
import {
  resolveWebSocketCredential,
  type WebSocketAuthResult,
  type WebSocketCredential,
} from '@/modules/auth/websocket-auth.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { nodeConsoleRefusal } from '@/services/node-host-access.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { User } from '@/types.js';

const logger = createChildLogger('NodeExec');

function send(ws: WSContext, msg: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Connection may already be closed
  }
}

/**
 * Daemons before this release keyed the node console by node only and ignored sessionKey, so
 * every user got the same shell. The shared lifecycle gained per-user keys in the same release
 * for every daemon type.
 */
export const NODE_CONSOLE_SESSION_ISOLATION_MIN_VERSION = 'v2.4.5';

export function daemonIsolatesNodeConsoleSessions(daemonVersion: string | null | undefined): boolean {
  // Local builds report "dev" and are built from current sources.
  if (daemonVersion === 'dev') return true;
  if (!daemonVersion || !parseSemver(daemonVersion)) return false;
  return compareSemver(daemonVersion, NODE_CONSOLE_SESSION_ISOLATION_MIN_VERSION) >= 0;
}

async function nodeIsolatesConsoleSessions(nodeId: string): Promise<boolean> {
  try {
    const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
    const [node] = await db
      .select({ daemonVersion: nodes.daemonVersion })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    return daemonIsolatesNodeConsoleSessions(node?.daemonVersion);
  } catch (error) {
    logger.warn('Failed to read daemon version for node console isolation; treating it as unisolated', {
      nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Creators of node console sessions on daemons that do not isolate sessions per user, keyed by
 * `${nodeId}\0${execId}`. Such a daemon hands every caller the node's existing shell, so only
 * the Opfield user who created it may attach again.
 */
const unisolatedConsoleOwners = new Map<string, string>();

function unisolatedConsoleKey(nodeId: string, execId: string): string {
  return `${nodeId}\0${execId}`;
}

interface ExecWSState {
  user: User | null;
  authenticated: boolean;
  execId: string | null;
  outputHandler: ((data: any) => void) | null;
  keepaliveInterval: ReturnType<typeof setInterval> | null;
  outputQueue: Array<{ output: any; bytes: number }>;
  outputBytes: number;
  drainingOutput: boolean;
  keepalivePending: boolean;
  credential: WebSocketCredential | null;
  auditOrigin: WebSocketAuditOrigin;
  /** The open console, audited when it opened and audited again when it closes. */
  session: { nodeId: string; execId: string; auth: WebSocketAuthResult; openedAt: number } | null;
}

const wsStates = new WeakMap<WSContext, ExecWSState>();
export const EXEC_OUTPUT_MAX_BYTES = 1024 * 1024;
export const EXEC_OUTPUT_MAX_CHUNKS = 256;

function cleanupExec(ws: WSContext, state: ExecWSState): void {
  if (wsStates.get(ws) !== state) return;
  wsStates.delete(ws);
  state.authenticated = false;
  if (state.session) {
    const { nodeId, execId, auth, openedAt } = state.session;
    state.session = null;
    auditWebSocketSession(state.auditOrigin, auth, state.credential, {
      action: 'node.console.close',
      resourceType: 'node',
      resourceId: nodeId,
      details: { execId, durationMs: Date.now() - openedAt },
    });
  }
  if (state.execId && state.outputHandler) {
    container.resolve(NodeRegistryService).removeExecHandler(state.execId, state.outputHandler);
  }
  state.outputHandler = null;
  if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
  state.keepaliveInterval = null;
  state.outputQueue.length = 0;
  state.outputBytes = 0;
}

function closeExec(ws: WSContext, state: ExecWSState, code: number, reason: string): void {
  if (wsStates.get(ws) !== state) return;
  cleanupExec(ws, state);
  try {
    ws.close(code, reason);
  } catch {
    /* already closed */
  }
}

async function drainOutput(ws: WSContext, state: ExecWSState, nodeId: string): Promise<void> {
  if (state.drainingOutput) return;
  state.drainingOutput = true;
  try {
    while (wsStates.get(ws) === state && state.outputQueue.length > 0) {
      // Do not hold a payload in the async frame while authorization is pending:
      // cleanup can release the entire queue immediately.
      if (!(await revalidateNodeExecAccess(ws, state, nodeId)) || wsStates.get(ws) !== state) return;
      const entry = state.outputQueue.shift();
      if (!entry) return;
      state.outputBytes -= entry.bytes;
      const output = entry.output;
      if (output.data?.length) {
        send(ws, { type: 'output', data: Buffer.from(output.data).toString('base64') });
      }
      if (output.exited) {
        if (state.execId) unisolatedConsoleOwners.delete(unisolatedConsoleKey(nodeId, state.execId));
        send(ws, { type: 'exit', exitCode: output.exitCode ?? 0 });
        closeExec(ws, state, 1000, 'Process exited');
        return;
      }
    }
  } catch (error) {
    if (wsStates.get(ws) !== state) return;
    logger.error('Error forwarding exec output', { error: String(error) });
    closeExec(ws, state, 1011, 'Output forwarding failed');
  } finally {
    state.drainingOutput = false;
  }
}

/**
 * Create WebSocket handlers for node-level console sessions.
 * Same pattern as Docker exec but uses NodeExecCommand (host-level PTY).
 */
export function createNodeExecWSHandlers(nodeId: string, shell: string, credential: WebSocketCredential | null) {
  const dispatch = container.resolve(NodeDispatchService);
  const registry = container.resolve(NodeRegistryService);
  const auditOrigin = captureWebSocketAuditOrigin();

  return {
    onOpen(_event: Event, ws: WSContext) {
      const state: ExecWSState = {
        user: null,
        authenticated: false,
        execId: null,
        outputHandler: null,
        keepaliveInterval: null,
        outputQueue: [],
        outputBytes: 0,
        drainingOutput: false,
        keepalivePending: false,
        credential,
        auditOrigin,
        session: null,
      };
      wsStates.set(ws, state);

      state.keepaliveInterval = setInterval(() => {
        if (state.keepalivePending) return;
        state.keepalivePending = true;
        void revalidateNodeExecAccess(ws, state, nodeId, true)
          .catch(() => closeExec(ws, state, 1011, 'Access check failed'))
          .finally(() => {
            state.keepalivePending = false;
          });
      }, 30_000);

      authenticateAndCreateExec(ws, state, credential, nodeId, shell, dispatch, registry).catch((err) => {
        if (wsStates.get(ws) !== state) return;
        cleanupExec(ws, state);
        logger.error('Auth/exec creation failed', { error: err instanceof Error ? err.message : String(err) });
        try {
          ws.close();
        } catch {
          /* */
        }
      });
    },

    async onMessage(event: MessageEvent, ws: WSContext) {
      const state = wsStates.get(ws);
      if (!state?.authenticated) return;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        if (!msg || typeof msg.type !== 'string') return;
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }

      if (msg.type === 'input' && state.execId) {
        if (!(await revalidateNodeExecAccess(ws, state, nodeId)) || wsStates.get(ws) !== state) return;
        try {
          const inputData = Buffer.from(msg.data as string, 'base64');
          dispatch.sendExecInput(nodeId, state.execId, inputData);
        } catch (err) {
          logger.error('Error forwarding exec input', { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (msg.type === 'resize' && state.execId) {
        if (!(await revalidateNodeExecAccess(ws, state, nodeId)) || wsStates.get(ws) !== state) return;
        try {
          await dispatch.sendNodeExecCommand(nodeId, 'resize', {
            rows: msg.rows as number,
            cols: msg.cols as number,
            sessionKey: state.user?.id,
          });
        } catch (err) {
          logger.error('Error sending resize', { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
    },

    onClose(_event: unknown, ws: WSContext) {
      const state = wsStates.get(ws);
      if (state) cleanupExec(ws, state);
      logger.info('Node exec WS closed', { nodeId });
    },

    onError(_error: Event, ws: WSContext) {
      const state = wsStates.get(ws);
      if (state) cleanupExec(ws, state);
      logger.error('Node exec WS error', { nodeId });
    },
  };
}

async function authenticateAndCreateExec(
  ws: WSContext,
  state: ExecWSState,
  credential: WebSocketCredential | null,
  nodeId: string,
  shell: string,
  dispatch: NodeDispatchService,
  registry: NodeRegistryService
): Promise<void> {
  const authResult = await resolveWebSocketCredential(credential, `nodes:console:${nodeId}`);
  if (wsStates.get(ws) !== state) return;
  if (!authResult) {
    send(ws, { type: 'auth_error', message: 'Invalid or expired token' });
    closeExec(ws, state, 1008, 'Authentication failed');
    return;
  }
  const { user } = authResult;

  if (user.isBlocked) {
    send(ws, { type: 'auth_error', message: 'Account is blocked' });
    closeExec(ws, state, 1008, 'Account blocked');
    return;
  }

  state.user = user;
  state.authenticated = true;

  logger.info('Node exec authenticated', { nodeId, userId: user.id });

  const node = registry.getNode(nodeId);
  if (!node) {
    send(ws, { type: 'error', message: `Node ${nodeId} is not connected` });
    closeExec(ws, state, 1011, 'Node not connected');
    return;
  }
  const consoleRefusal = nodeConsoleRefusal(registry, nodeId);
  if (consoleRefusal) {
    // A final refusal like the unisolated-session one below: auth_error stops terminal clients from reconnecting.
    send(ws, { type: 'auth_error', code: consoleRefusal.code, message: consoleRefusal.message });
    closeExec(ws, state, 1008, 'Console unavailable on the node');
    return;
  }

  const isolatesSessions = await nodeIsolatesConsoleSessions(nodeId);
  if (wsStates.get(ws) !== state) return;

  // Create or reuse node-level exec session
  const command = shell && shell !== 'auto' ? [shell] : [];
  let result: import('@/grpc/generated/types.js').CommandResult;
  try {
    result = await dispatch.sendNodeExecCommand(nodeId, 'create', {
      command,
      tty: true,
      sessionKey: user.id,
    });
  } catch (err) {
    if (wsStates.get(ws) !== state) return;
    const message = err instanceof Error ? err.message : 'Failed to create exec session';
    send(ws, { type: 'error', message });
    closeExec(ws, state, 1011, 'Exec creation failed');
    return;
  }

  if (wsStates.get(ws) !== state) return;
  if (!result.success) {
    send(ws, { type: 'error', message: result.error || 'Exec creation failed' });
    closeExec(ws, state, 1011, 'Exec creation failed');
    return;
  }

  let execId: string | undefined;
  let isNew = true;
  let buffer: string[] = [];
  let usedShell = shell || 'auto';
  try {
    const parsed = JSON.parse(result.detail || '{}');
    execId = parsed.exec_id || parsed.execId || parsed.id;
    if (parsed.is_new === false || parsed.isNew === false) isNew = false;
    if (Array.isArray(parsed.buffer)) buffer = parsed.buffer;
    if (parsed.shell) usedShell = parsed.shell;
  } catch {
    execId = result.detail || undefined;
  }

  if (!execId) {
    send(ws, { type: 'error', message: 'No exec ID returned from daemon' });
    closeExec(ws, state, 1011, 'No exec ID');
    return;
  }

  if (!isolatesSessions) {
    // This daemon ignores sessionKey and returns whichever console is already running on the
    // node, so a reused session may belong to another user. Never attach to it or replay it.
    const ownerKey = unisolatedConsoleKey(nodeId, execId);
    if (isNew) {
      unisolatedConsoleOwners.set(ownerKey, user.id);
    } else if (unisolatedConsoleOwners.get(ownerKey) !== user.id) {
      logger.warn('Refused to attach to a node console session this daemon cannot isolate', {
        nodeId,
        userId: user.id,
      });
      send(ws, {
        type: 'auth_error',
        message: `Another console session is already open on this node, and its daemon is too old to keep console sessions separate per user. Update the daemon to ${NODE_CONSOLE_SESSION_ISOLATION_MIN_VERSION} or later, or try again after that session exits.`,
      });
      closeExec(ws, state, 1008, 'Console session belongs to another user');
      return;
    }
  }

  state.execId = execId;

  const outputHandler = (output: any) => {
    if (wsStates.get(ws) !== state) return;
    const bytes =
      typeof output.data === 'string'
        ? Buffer.byteLength(output.data)
        : (output.data?.byteLength ?? output.data?.length ?? 0);
    if (state.outputQueue.length >= EXEC_OUTPUT_MAX_CHUNKS || state.outputBytes + bytes > EXEC_OUTPUT_MAX_BYTES) {
      send(ws, { type: 'error', code: 'EXEC_OUTPUT_OVERFLOW', message: 'Terminal output backlog exceeded its limit' });
      closeExec(ws, state, 1013, 'Terminal output backlog exceeded');
      return;
    }
    state.outputQueue.push({ output, bytes });
    state.outputBytes += bytes;
    void drainOutput(ws, state, nodeId);
  };
  state.outputHandler = outputHandler;
  registry.registerExecHandler(execId, outputHandler, nodeId);

  if (!isNew && buffer.length > 0) {
    for (const b64chunk of buffer) {
      send(ws, { type: 'output', data: b64chunk });
    }
  }

  send(ws, { type: 'connected', execId, shell: usedShell, isNew });
  // A root shell on the host: who opened it, as whom, and for how long belongs in the audit log.
  state.session = { nodeId, execId, auth: authResult, openedAt: Date.now() };
  auditWebSocketSession(state.auditOrigin, authResult, credential, {
    action: 'node.console.open',
    resourceType: 'node',
    resourceId: nodeId,
    details: { execId, shell: usedShell, isNew },
  });
}

async function revalidateNodeExecAccess(
  ws: WSContext,
  state: ExecWSState,
  nodeId: string,
  emitPong = false
): Promise<boolean> {
  if (wsStates.get(ws) !== state) return false;
  const authResult = await resolveWebSocketCredential(state.credential, `nodes:console:${nodeId}`);
  if (wsStates.get(ws) !== state) return false;
  if (!authResult) {
    state.authenticated = false;
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    try {
      closeExec(ws, state, 1008, 'Authentication failed');
    } catch {
      /* */
    }
    return false;
  }

  state.user = authResult.user;
  if (emitPong) {
    try {
      ws.send(JSON.stringify({ type: 'pong' }));
    } catch {
      cleanupExec(ws, state);
    }
  }
  return true;
}
