import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { LEGACY_RELAY_BINARY, LEGACY_RELAY_IDENTITY_DIR } from '@/lib/legacy-compat.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { User } from '@/types.js';
import { commandText, type EffectiveCommand } from './ai.console-commands.js';
import { consoleMutations } from './ai.console-docker-mutations.js';
import {
  type ConsoleRefusal,
  emptyInventory,
  evaluateConsoleMutations,
  inventoryNeeds,
  MANAGED_RESOURCE_CONSOLE_FORBIDDEN,
  managedResourceConsoleError,
} from './ai.console-managed-guard.js';
import { loadManagedInventory } from './ai.console-managed-inventory.js';
import {
  containerRuntimeCommand,
  NODE_CONSOLE_RUNTIME_UNAVAILABLE,
  nodeConsoleRuntimeError,
} from './ai.console-runtime.js';

const logger = createChildLogger('ConsoleManagedGuard');
const AUDIT_COMMAND_MAX = 500;
/**
 * Paths every Opfield daemon keeps on its host (Docker, nginx, monitoring, relay and their pre-2.12.1 names): their
 * presence makes an SSH target an Opfield node. rc.3 GF-4: only the Docker daemon's were probed, so an nginx node
 * reached through an address it does not report took agent commands.
 */
const OPFIELD_NODE_DIRS = [
  '/var/lib/docker-daemon',
  '/etc/docker-daemon',
  '/var/lib/nginx-daemon',
  '/etc/nginx-daemon',
  '/var/lib/monitoring-daemon',
  '/etc/monitoring-daemon',
  '/var/lib/opfield-relay',
  '/etc/opfield-relay',
  LEGACY_RELAY_IDENTITY_DIR,
  `/etc${LEGACY_RELAY_BINARY}-supervisor`,
];
const OPFIELD_NODE_PROBE = `for d in ${OPFIELD_NODE_DIRS.join(' ')}; do [ -e "$d" ] && echo "$d"; done; true`;

/** Why an agent's console command is refused before it runs. */
export type AgentConsoleRefusal =
  | { kind: 'managed'; refusal: ConsoleRefusal }
  | { kind: 'runtime'; command: EffectiveCommand };

export function agentConsoleRefusalError(refusal: AgentConsoleRefusal): AppError {
  return refusal.kind === 'managed'
    ? managedResourceConsoleError(refusal.refusal)
    : nodeConsoleRuntimeError(refusal.command);
}

async function auditRefusal(
  user: User,
  refusal: AgentConsoleRefusal,
  toolName: string,
  source: 'ai' | 'mcp' | undefined,
  target: Record<string, string>
) {
  const details =
    refusal.kind === 'managed'
      ? {
          action: 'node.console.managed_resource_refused',
          command: refusal.refusal.mutation.command,
          extra: { object: refusal.refusal.object, use: refusal.refusal.tool },
          errorCode: MANAGED_RESOURCE_CONSOLE_FORBIDDEN,
        }
      : {
          action: 'node.console.runtime_refused',
          command: commandText(refusal.command),
          extra: {},
          errorCode: NODE_CONSOLE_RUNTIME_UNAVAILABLE,
        };
  try {
    await container.resolve(AuditService).log({
      userId: user.id,
      action: details.action,
      resourceType: target.nodeId ? 'node' : 'ssh_connector',
      resourceId: target.nodeId ?? target.connectorId,
      details: {
        ...target,
        tool: toolName,
        // Remote MCP calls also carry the token context; the in-app assistant is marked here.
        caller: source === 'mcp' ? 'mcp' : 'assistant',
        command: details.command.slice(0, AUDIT_COMMAND_MAX),
        ...details.extra,
        success: false,
        errorCode: details.errorCode,
      },
    });
  } catch (error) {
    logger.warn('Failed to audit a refused console command', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Why an agent's node console command is refused before it is sent, or null. The daemon runs agent commands in the
 * agent sandbox, which keeps every spelling away from the container runtime; this check gives the refusal a reason
 * and the tool to use: a change to an Opfield-managed Docker object or daemon state (MANAGED_RESOURCE_CONSOLE_FORBIDDEN),
 * or any other use of the container runtime (NODE_CONSOLE_RUNTIME_UNAVAILABLE).
 */
export async function agentNodeConsoleRefusal(input: {
  nodeId: string;
  commands: EffectiveCommand[];
  dispatch: NodeDispatchService;
}): Promise<AgentConsoleRefusal | null> {
  const mutations = consoleMutations(input.commands);
  if (mutations.length > 0) {
    const inventory = mutations.every((mutation) => mutation.kind === 'state_path')
      ? emptyInventory()
      : await loadManagedInventory(
          container.resolve<DrizzleClient>(TOKENS.DrizzleClient),
          input.dispatch,
          input.nodeId,
          inventoryNeeds(mutations)
        );
    const refusal = evaluateConsoleMutations(mutations, inventory);
    if (refusal) return { kind: 'managed', refusal };
  }
  const runtime = containerRuntimeCommand(input.commands);
  return runtime ? { kind: 'runtime', command: runtime } : null;
}

/**
 * Refuses (and audits) an agent's node console command that agentNodeConsoleRefusal refuses. Every agent is checked:
 * remote MCP (OAuth grants and API tokens) and the in-app assistant. People in the browser console (an interactive
 * PTY) are not.
 */
export async function assertAgentNodeConsoleCommandAllowed(input: {
  user: User;
  nodeId: string;
  commands: EffectiveCommand[];
  toolName: string;
  dispatch: NodeDispatchService;
  source?: 'ai' | 'mcp';
}): Promise<void> {
  const refusal = await agentNodeConsoleRefusal(input);
  if (!refusal) return;
  await auditRefusal(input.user, refusal, input.toolName, input.source, { nodeId: input.nodeId });
  throw agentConsoleRefusalError(refusal);
}

/** How long an SSH target's probe result is reused. */
const SSH_PROBE_TTL_MS = 5 * 60_000;
const sshProbeCache = new Map<string, { opfieldNode: string | null; at: number }>();

/** The Opfield daemon directory an SSH target has, or null; probed once per connector within SSH_PROBE_TTL_MS. */
async function opfieldNodeOverSsh(
  connectorId: string,
  probe: (command: string) => Promise<{ stdout?: string }>,
  now = Date.now()
): Promise<string | null> {
  const cached = sshProbeCache.get(connectorId);
  if (cached && now - cached.at < SSH_PROBE_TTL_MS) return cached.opfieldNode;
  let opfieldNode: string | null = null;
  try {
    opfieldNode = ((await probe(OPFIELD_NODE_PROBE)).stdout ?? '').trim().split(/\s+/)[0] || null;
  } catch (error) {
    logger.debug('Opfield node probe over SSH failed', {
      connectorId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  sshProbeCache.set(connectorId, { opfieldNode, at: now });
  return opfieldNode;
}

/** Forgets the probe results (tests). */
export function clearSshProbeCache(): void {
  sshProbeCache.clear();
}

/**
 * The SSH variant. A connector Opfield can map to an enrolled node, by the addresses the node reports or by its SSH
 * host key (ExternalSshService), is refused outright (SSH_MANAGED_TARGET_BLOCKED); a node enrolled elsewhere, or one
 * whose daemon does not report host keys yet, may still be reached. SSH commands do not run in the agent sandbox, so
 * before an agent's first command the target is probed for any Opfield daemon, and on one every agent command is
 * refused: such a host is an Opfield node, reached with execute_node_console_command.
 */
export async function assertAgentSshCommandAllowed(input: {
  user: User;
  connectorId: string;
  commands: EffectiveCommand[];
  probe: (command: string) => Promise<{ stdout?: string }>;
  source?: 'ai' | 'mcp';
}): Promise<void> {
  const opfieldNode = await opfieldNodeOverSsh(input.connectorId, input.probe);
  if (!opfieldNode) return;
  const mutations = consoleMutations(input.commands);
  const managed = evaluateConsoleMutations(mutations, { ...emptyInventory(), containers: null, allManaged: true });
  if (managed) {
    await auditRefusal(input.user, { kind: 'managed', refusal: managed }, 'ssh_execute_command', input.source, {
      connectorId: input.connectorId,
    });
  }
  throw new AppError(
    403,
    'SSH_MANAGED_TARGET_BLOCKED',
    `This SSH target runs an Opfield daemon (${opfieldNode}), so it is an Opfield node. Agents do not run ` +
      'commands on Opfield nodes over SSH: use execute_node_console_command on the node, whose agent commands run in ' +
      'the agent sandbox, and the Docker tools for its containers. If the node is not enrolled in this Opfield, it belongs to another installation.'
  );
}
