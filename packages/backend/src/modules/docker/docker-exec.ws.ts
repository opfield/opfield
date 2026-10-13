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
  resolveWebSocketCredentialForScopeBase,
  type WebSocketAuthResult,
  type WebSocketCredential,
} from '@/modules/auth/websocket-auth.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { User } from '@/types.js';
import { DockerAvailabilityService } from './availability/docker-availability.service.js';
import { DockerManagementService } from './docker.service.js';
import { hasDockerResourceScope } from './docker-access-resource.service.js';
import { inspectUserContainer } from './docker-internal-containers.js';

const logger = createChildLogger('DockerExec');
export const DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES = 16 * 1024;

export function isDockerExecPreauthMessageTooLarge(payload: unknown): boolean {
  if (typeof payload === 'string') return Buffer.byteLength(payload, 'utf8') > DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES;
  if (payload instanceof ArrayBuffer) return payload.byteLength > DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES;
  if (ArrayBuffer.isView(payload)) return payload.byteLength > DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES;
  if (typeof Blob !== 'undefined' && payload instanceof Blob)
    return payload.size > DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES;
  return Buffer.byteLength(String(payload), 'utf8') > DOCKER_EXEC_PREAUTH_MESSAGE_MAX_BYTES;
}

async function authorizeExecAccess(
  credential: WebSocketCredential | null,
  nodeId: string,
  resourceId: string
): Promise<User | null> {
  const result = await resolveWebSocketCredentialForScopeBase(credential, 'docker:containers:console');
  if (!result) return null;
  return hasDockerResourceScope(result.scopes, 'docker:containers:console', nodeId, resourceId) ? result.user : null;
}

function send(ws: WSContext, msg: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Connection may already be closed
  }
}

/**
 * Resolve the user a console runs as: the container's configured user, or root when the image
 * sets none (Docker's own default). Fails closed when the container cannot be inspected, so an
 * inspect failure never silently escalates a console to root.
 */
export async function resolveDockerExecUser(
  docker: Pick<DockerManagementService, 'inspectContainer'>,
  nodeId: string,
  containerId: string
): Promise<string> {
  let inspectData: unknown;
  try {
    inspectData = await docker.inspectContainer(nodeId, containerId);
  } catch (error) {
    logger.warn('Failed to inspect container user for Docker exec; refusing console', {
      nodeId,
      containerId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error('Could not inspect the container to determine its user, so the console was not opened');
  }
  if (!inspectData || typeof inspectData !== 'object') {
    throw new Error('Could not inspect the container to determine its user, so the console was not opened');
  }
  const configuredUser = (inspectData as { Config?: { User?: unknown } }).Config?.User;
  return typeof configuredUser === 'string' && configuredUser.trim().length > 0 ? configuredUser.trim() : 'root';
}

/** Docker daemons before this release keyed console sessions by container only and ignored sessionKey. */
export const DOCKER_EXEC_SESSION_ISOLATION_MIN_VERSION = 'v2.4.5';

export function dockerDaemonIsolatesExecSessions(daemonVersion: string | null | undefined): boolean {
  // Local builds report "dev" and are built from current sources.
  if (daemonVersion === 'dev') return true;
  if (!daemonVersion || !parseSemver(daemonVersion)) return false;
  return compareSemver(daemonVersion, DOCKER_EXEC_SESSION_ISOLATION_MIN_VERSION) >= 0;
}

async function nodeIsolatesExecSessions(nodeId: string): Promise<boolean> {
  try {
    const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
    const [node] = await db
      .select({ daemonVersion: nodes.daemonVersion })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    return dockerDaemonIsolatesExecSessions(node?.daemonVersion);
  } catch (error) {
    logger.warn('Failed to read Docker daemon version for console isolation; treating it as unisolated', {
      nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Creators of console sessions on daemons that do not isolate sessions per user, keyed by
 * `${nodeId}\0${execId}`. Such a daemon hands every caller the container's existing session, so
 * only the Opfield user who created it may attach again.
 */
const unisolatedExecSessionOwners = new Map<string, string>();

function unisolatedExecSessionKey(nodeId: string, execId: string): string {
  return `${nodeId}\0${execId}`;
}

interface ExecWSState {
  user: User | null;
  authenticated: boolean;
  execId: string | null;
  terminalSize: DockerExecTerminalSize | null;
  outputHandler: ((data: any) => void) | null;
  keepaliveInterval: ReturnType<typeof setInterval> | null;
  outputQueue: Array<{ output: any; bytes: number }>;
  outputBytes: number;
  drainingOutput: boolean;
  keepalivePending: boolean;
  credential: WebSocketCredential | null;
  scopeResourceId: string | null;
  scopeNodeId: string | null;
  auditOrigin: WebSocketAuditOrigin;
  /** The open exec session, audited when it opened and audited again when it closes. */
  session: { nodeId: string; containerId: string; execId: string; auth: WebSocketAuthResult; openedAt: number } | null;
}

export interface DockerExecTerminalSize {
  rows: number;
  cols: number;
}

export function parseDockerExecTerminalSize(rows: unknown, cols: unknown): DockerExecTerminalSize | null {
  if (typeof rows !== 'number' || typeof cols !== 'number') return null;
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) return null;
  if (rows < 1 || rows > 65_535) return null;
  if (cols < 1 || cols > 65_535) return null;
  return { rows, cols };
}

export async function resizeDockerExec(
  dispatch: Pick<NodeDispatchService, 'sendDockerExecCommand'>,
  nodeId: string,
  execId: string,
  size: DockerExecTerminalSize
): Promise<void> {
  const result = await dispatch.sendDockerExecCommand(nodeId, 'resize', {
    // DockerExecCommand reuses container_id as the exec session ID for resize actions.
    containerId: execId,
    rows: size.rows,
    cols: size.cols,
  });
  if (!result.success) {
    throw new Error(result.error || 'Docker exec resize failed');
  }
}

const wsStates = new WeakMap<WSContext, ExecWSState>();
export const EXEC_OUTPUT_MAX_BYTES = 1024 * 1024;
export const EXEC_OUTPUT_MAX_CHUNKS = 256;

function cleanupExec(ws: WSContext, state: ExecWSState): void {
  if (wsStates.get(ws) !== state) return;
  wsStates.delete(ws);
  state.authenticated = false;
  if (state.session) {
    const { nodeId, containerId, execId, auth, openedAt } = state.session;
    state.session = null;
    auditWebSocketSession(state.auditOrigin, auth, state.credential, {
      action: 'docker.exec.close',
      resourceType: 'docker-container',
      resourceId: containerId,
      details: { nodeId, execId, durationMs: Date.now() - openedAt },
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
      if (!(await revalidateExecAccess(ws, state, nodeId)) || wsStates.get(ws) !== state) return;
      const entry = state.outputQueue.shift();
      if (!entry) return;
      state.outputBytes -= entry.bytes;
      const output = entry.output;
      if (output.data?.length) {
        send(ws, { type: 'output', data: Buffer.from(output.data).toString('base64') });
      }
      if (output.exited) {
        if (state.execId) unisolatedExecSessionOwners.delete(unisolatedExecSessionKey(nodeId, state.execId));
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
 * Create WebSocket handlers for Docker exec terminal sessions.
 *
 * Flow (persistent sessions):
 * 1. Client connects with the session cookie and ?shell=<shell>
 * 2. onOpen authenticates and asks daemon to create-or-reuse exec for this container
 * 3. Daemon creates a new exec OR reuses existing; sends buffered output first on reuse
 * 4. Daemon streams ExecOutput back; backend forwards to WebSocket
 * 5. Client sends { type: "input", data: "<base64>" } or { type: "resize", rows, cols }
 * 6. On WS disconnect, backend sends "detach" — daemon keeps exec alive, buffers output
 * 7. On reconnect, daemon replays buffered output then resumes live forwarding
 */
export function createDockerExecWSHandlers(
  nodeId: string,
  containerId: string,
  shell: string,
  credential: WebSocketCredential | null
) {
  const dispatch = container.resolve(NodeDispatchService);
  const registry = container.resolve(NodeRegistryService);
  const docker = container.resolve(DockerManagementService);
  const availability = container.resolve(DockerAvailabilityService);
  const auditOrigin = captureWebSocketAuditOrigin();

  return {
    onOpen(_event: Event, ws: WSContext) {
      const state: ExecWSState = {
        user: null,
        authenticated: false,
        execId: null,
        terminalSize: null,
        outputHandler: null,
        keepaliveInterval: null,
        outputQueue: [],
        outputBytes: 0,
        drainingOutput: false,
        keepalivePending: false,
        credential,
        scopeResourceId: null,
        scopeNodeId: null,
        auditOrigin,
        session: null,
      };
      wsStates.set(ws, state);

      state.keepaliveInterval = setInterval(() => {
        if (state.keepalivePending) return;
        state.keepalivePending = true;
        void revalidateExecAccess(ws, state, nodeId, true)
          .catch(() => closeExec(ws, state, 1011, 'Access check failed'))
          .finally(() => {
            state.keepalivePending = false;
          });
      }, 30_000);

      // Authenticate immediately from the session cookie.
      authenticateAndCreateExec(
        ws,
        state,
        credential,
        nodeId,
        containerId,
        shell,
        dispatch,
        registry,
        docker,
        availability
      ).catch((err) => {
        if (wsStates.get(ws) !== state) return;
        cleanupExec(ws, state);
        logger.error('Auth/exec creation failed', { error: err instanceof Error ? err.message : String(err) });
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

      // The credential is supplied during the WebSocket handshake, so no
      // legitimate pre-auth client command needs a large payload. Avoid JSON
      // parsing attacker-controlled megabyte payloads while authentication is
      // still in flight; authenticated terminal input keeps its existing flow.
      if (!state.authenticated && isDockerExecPreauthMessageTooLarge(event.data)) {
        send(ws, { type: 'error', message: 'Message too large before authentication' });
        try {
          closeExec(ws, state, 1009, 'Message too large');
        } catch {
          /* ignore */
        }
        return;
      }

      const raw = typeof event.data === 'string' ? event.data : String(event.data);

      let msg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
          send(ws, { type: 'error', message: 'Invalid message format' });
          return;
        }
        msg = parsed;
      } catch {
        send(ws, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      if (msg.type === 'resize') {
        const terminalSize = parseDockerExecTerminalSize(msg.rows, msg.cols);
        if (!terminalSize) {
          send(ws, { type: 'error', message: 'Invalid terminal size' });
          return;
        }

        state.terminalSize = terminalSize;
        if (!state.execId) return;
        if (!(await revalidateExecAccess(ws, state, nodeId)) || wsStates.get(ws) !== state) return;
        try {
          await resizeDockerExec(dispatch, nodeId, state.execId, terminalSize);
        } catch (err) {
          logger.error('Error sending resize', { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (!state.authenticated) {
        send(ws, { type: 'error', message: 'Not authenticated' });
        return;
      }

      if (msg.type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }

      if (msg.type === 'input' && state.execId) {
        if (!(await revalidateExecAccess(ws, state, nodeId)) || wsStates.get(ws) !== state) return;
        try {
          const inputData = Buffer.from(msg.data as string, 'base64');
          dispatch.sendExecInput(nodeId, state.execId, inputData);
        } catch (err) {
          logger.error('Error forwarding exec input', { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
    },

    onClose(event: unknown, ws: WSContext) {
      const state = wsStates.get(ws);
      if (state) cleanupExec(ws, state);
      const closeEvent = event as { code?: unknown; reason?: unknown; wasClean?: unknown } | null;
      logger.info('Docker exec WS closed', {
        nodeId,
        containerId,
        code: typeof closeEvent?.code === 'number' ? closeEvent.code : undefined,
        reason: typeof closeEvent?.reason === 'string' ? closeEvent.reason : undefined,
        wasClean: typeof closeEvent?.wasClean === 'boolean' ? closeEvent.wasClean : undefined,
      });
    },

    onError(_error: Event, ws: WSContext) {
      const state = wsStates.get(ws);
      if (state) cleanupExec(ws, state);
      logger.error('Docker exec WS error', { nodeId, containerId });
    },
  };
}

/**
 * Authenticate via session token and create/reuse the exec session on the daemon.
 * Called immediately on WebSocket open.
 */
async function authenticateAndCreateExec(
  ws: WSContext,
  state: ExecWSState,
  credential: WebSocketCredential | null,
  nodeId: string,
  containerId: string,
  shell: string,
  dispatch: NodeDispatchService,
  registry: NodeRegistryService,
  docker: DockerManagementService,
  availability: DockerAvailabilityService
): Promise<void> {
  const initialAuth = await resolveWebSocketCredentialForScopeBase(credential, 'docker:containers:console');
  if (wsStates.get(ws) !== state) return;
  if (!initialAuth) {
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    closeExec(ws, state, 1008, 'Authentication failed');
    return;
  }
  // Availability placements can still be inspectable as regular containers (notably
  // deployment slots). Resolve their logical identity first so authorization is
  // checked against the user-owned workload rather than the generated runtime name.
  const placementIdentity = await availability.resolveRuntimeAccessIdentity(nodeId, containerId).catch(() => null);
  if (wsStates.get(ws) !== state) return;
  const inspect = placementIdentity ? null : await inspectUserContainer(docker, nodeId, containerId).catch(() => null);
  if (wsStates.get(ws) !== state) return;
  const scopeNodeId = placementIdentity?.nodeId ?? nodeId;
  const scopeResourceId = String(placementIdentity?.resourceId ?? inspect?.scopeResourceId ?? '');
  const user =
    scopeResourceId &&
    hasDockerResourceScope(initialAuth.scopes, 'docker:containers:console', scopeNodeId, scopeResourceId)
      ? initialAuth.user
      : null;
  if (!user) {
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    closeExec(ws, state, 1008, 'Authentication failed');
    return;
  }

  state.user = user;
  state.authenticated = true;
  state.scopeResourceId = scopeResourceId;
  state.scopeNodeId = scopeNodeId;

  logger.info('Docker exec authenticated', { nodeId, containerId, userId: user.id });

  // Verify the node is connected
  const node = registry.getNode(nodeId);
  if (!node) {
    send(ws, { type: 'error', message: `Node ${nodeId} is not connected` });
    closeExec(ws, state, 1011, 'Node not connected');
    return;
  }

  // Auto-detect best available shell by reading /etc/shells
  let usedShell = shell && shell !== 'auto' ? shell : '/bin/sh';
  if (!shell || shell === 'auto') {
    try {
      const fileResult = await dispatch.sendDockerFileCommand(nodeId, 'read', {
        containerId,
        path: '/etc/shells',
        maxBytes: 4096,
      });
      if (wsStates.get(ws) !== state) return;
      if (fileResult.success && fileResult.data?.length) {
        const content = Buffer.from(fileResult.data).toString('utf-8');
        const lines = content
          .split('\n')
          .map((l: string) => l.trim())
          .filter((l: string) => l && !l.startsWith('#'));
        const preferred = ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/bin/ash', '/bin/sh'];
        for (const s of preferred) {
          if (lines.includes(s)) {
            usedShell = s;
            break;
          }
        }
      }
    } catch {
      // /etc/shells doesn't exist — fall back to /bin/sh
    }
    if (wsStates.get(ws) !== state) return;
    logger.info('Auto-detected shell', { nodeId, containerId, shell: usedShell });
  }

  let execUser: string;
  try {
    execUser = await resolveDockerExecUser(docker, nodeId, containerId);
  } catch (err) {
    if (wsStates.get(ws) !== state) return;
    send(ws, { type: 'error', message: err instanceof Error ? err.message : 'Could not determine the container user' });
    closeExec(ws, state, 1011, 'Container user unavailable');
    return;
  }
  if (wsStates.get(ws) !== state) return;
  const isolatesSessions = await nodeIsolatesExecSessions(nodeId);
  if (wsStates.get(ws) !== state) return;

  // Create or reuse exec session on daemon
  let result: import('@/grpc/generated/types.js').CommandResult;
  try {
    const initialSize = state.terminalSize;
    result = await dispatch.sendDockerExecCommand(nodeId, 'create', {
      containerId,
      command: [usedShell],
      tty: true,
      stdin: true,
      user: execUser,
      sessionKey: user.id,
      rows: initialSize?.rows,
      cols: initialSize?.cols,
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

  // Parse exec ID, reuse flag, and buffer from the command result
  let execId: string | undefined;
  let isNew = true;
  let buffer: string[] = [];
  try {
    const parsed = JSON.parse(result.detail || '{}');
    execId = parsed.exec_id || parsed.execId || parsed.id;
    if (parsed.is_new === false || parsed.isNew === false) {
      isNew = false;
    }
    if (Array.isArray(parsed.buffer)) {
      buffer = parsed.buffer;
    }
  } catch {
    execId = result.detail || undefined;
  }

  if (!execId) {
    send(ws, { type: 'error', message: 'No exec ID returned from daemon' });
    closeExec(ws, state, 1011, 'No exec ID');
    return;
  }

  if (!isolatesSessions) {
    // This daemon ignores sessionKey and returns whichever session is already running in the
    // container, so a reused session may belong to another user. Never attach to it.
    const ownerKey = unisolatedExecSessionKey(nodeId, execId);
    if (isNew) {
      unisolatedExecSessionOwners.set(ownerKey, user.id);
    } else if (unisolatedExecSessionOwners.get(ownerKey) !== user.id) {
      logger.warn('Refused to attach to a console session this daemon cannot isolate', {
        nodeId,
        containerId,
        userId: user.id,
      });
      send(ws, {
        type: 'auth_error',
        message: `Another console session is already open in this container, and this node's Docker daemon is too old to keep console sessions separate per user. Update the Docker daemon to ${DOCKER_EXEC_SESSION_ISOLATION_MIN_VERSION} or later, or try again after that session exits.`,
      });
      closeExec(ws, state, 1008, 'Console session belongs to another user');
      return;
    }
  }

  state.execId = execId;

  if (state.terminalSize) {
    try {
      await resizeDockerExec(dispatch, nodeId, execId, state.terminalSize);
    } catch (err) {
      logger.error('Error applying initial terminal size', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (wsStates.get(ws) !== state) return;
  // Register handler for live ExecOutput from daemon -> forward to this WS
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
  registry.registerExecHandler(execId, outputHandler);

  send(ws, { type: 'connected', execId, shell: usedShell, isNew });
  state.session = { nodeId, containerId, execId, auth: initialAuth, openedAt: Date.now() };
  auditWebSocketSession(state.auditOrigin, initialAuth, credential, {
    action: 'docker.exec.open',
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, execId, shell: usedShell, isNew },
  });

  // Replay output captured while the daemon was creating the exec session.
  if (buffer.length > 0) {
    for (const b64chunk of buffer) {
      send(ws, { type: 'output', data: b64chunk });
    }
  }
}

async function revalidateExecAccess(
  ws: WSContext,
  state: ExecWSState,
  nodeId: string,
  emitPong = false
): Promise<boolean> {
  if (wsStates.get(ws) !== state) return false;
  const user = state.scopeResourceId
    ? await authorizeExecAccess(state.credential, state.scopeNodeId ?? nodeId, state.scopeResourceId)
    : null;
  if (wsStates.get(ws) !== state) return false;
  if (!user) {
    state.authenticated = false;
    send(ws, { type: 'auth_error', message: 'Access revoked or token expired' });
    try {
      closeExec(ws, state, 1008, 'Authentication failed');
    } catch {
      /* */
    }
    return false;
  }

  state.user = user;
  if (emitPong) {
    try {
      ws.send(JSON.stringify({ type: 'pong' }));
    } catch {
      cleanupExec(ws, state);
    }
  }
  return true;
}
