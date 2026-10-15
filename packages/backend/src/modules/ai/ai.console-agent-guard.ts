import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { User } from '@/types.js';
import type { EffectiveCommand } from './ai.console-commands.js';
import { type ConsoleMutation, consoleMutations } from './ai.console-docker-mutations.js';
import {
  type ConsoleRefusal,
  emptyInventory,
  evaluateConsoleMutations,
  inventoryNeeds,
  managedResourceConsoleError,
} from './ai.console-managed-guard.js';
import { loadManagedInventory } from './ai.console-managed-inventory.js';

const logger = createChildLogger('ConsoleManagedGuard');
const AUDIT_COMMAND_MAX = 500;
/** Paths an Opfield Docker daemon keeps on its host: their presence makes an SSH target an Opfield Docker node. */
const OPFIELD_DOCKER_NODE_PROBE =
  'for d in /var/lib/docker-daemon /etc/docker-daemon; do [ -e "$d" ] && echo "$d"; done; true';

async function auditRefusal(
  user: User,
  refusal: ConsoleRefusal,
  toolName: string,
  source: 'ai' | 'mcp' | undefined,
  target: Record<string, string>
) {
  try {
    await container.resolve(AuditService).log({
      userId: user.id,
      action: 'node.console.managed_resource_refused',
      resourceType: target.nodeId ? 'node' : 'ssh_connector',
      resourceId: target.nodeId ?? target.connectorId,
      details: {
        ...target,
        tool: toolName,
        // Remote MCP calls also carry the token context; the in-app assistant is marked here.
        caller: source === 'mcp' ? 'mcp' : 'assistant',
        command: refusal.mutation.command.slice(0, AUDIT_COMMAND_MAX),
        object: refusal.object,
        use: refusal.tool,
        success: false,
        errorCode: 'MANAGED_RESOURCE_CONSOLE_FORBIDDEN',
      },
    });
  } catch (error) {
    logger.warn('Failed to audit a refused console command', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Refuses an agent's node console command that would change an Opfield-managed Docker object of the node or the
 * state its daemons keep (see MANAGED_RESOURCE_CONSOLE_FORBIDDEN). Every agent is checked: remote MCP (OAuth grants
 * and API tokens) and the in-app assistant. People in the browser console (an interactive PTY) are not.
 */
export async function assertAgentNodeConsoleCommandAllowed(input: {
  user: User;
  nodeId: string;
  commands: EffectiveCommand[];
  toolName: string;
  dispatch: NodeDispatchService;
  source?: 'ai' | 'mcp';
}): Promise<void> {
  const mutations = consoleMutations(input.commands);
  if (mutations.length === 0) return;
  const inventory = mutations.every((mutation) => mutation.kind === 'state_path')
    ? emptyInventory()
    : await loadManagedInventory(
        container.resolve<DrizzleClient>(TOKENS.DrizzleClient),
        input.dispatch,
        input.nodeId,
        inventoryNeeds(mutations)
      );
  const refusal = evaluateConsoleMutations(mutations, inventory);
  if (!refusal) return;
  await auditRefusal(input.user, refusal, input.toolName, input.source, { nodeId: input.nodeId });
  throw managedResourceConsoleError(refusal);
}

/**
 * The SSH variant: a connector Opfield cannot map to an enrolled node (those are refused outright) may still reach
 * one through an address the node does not report. A command that would change Docker objects or daemon state
 * first probes the target for an Opfield Docker daemon; on one, every Docker object counts as managed.
 */
export async function assertAgentSshCommandAllowed(input: {
  user: User;
  connectorId: string;
  commands: EffectiveCommand[];
  probe: (command: string) => Promise<{ stdout?: string }>;
  source?: 'ai' | 'mcp';
}): Promise<void> {
  const mutations: ConsoleMutation[] = consoleMutations(input.commands);
  if (mutations.length === 0) return;
  let opfieldNode = false;
  try {
    opfieldNode = /\S/.test((await input.probe(OPFIELD_DOCKER_NODE_PROBE)).stdout ?? '');
  } catch (error) {
    logger.debug('Opfield node probe over SSH failed', {
      connectorId: input.connectorId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!opfieldNode) return;
  const refusal = evaluateConsoleMutations(mutations, { ...emptyInventory(), containers: null, allManaged: true });
  if (!refusal) return;
  await auditRefusal(input.user, refusal, 'ssh_execute_command', input.source, { connectorId: input.connectorId });
  throw managedResourceConsoleError(refusal);
}
