import { hasScopeForResource } from '@/lib/permissions.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { User } from '@/types.js';
import { assertAgentNodeConsoleCommandAllowed } from './ai.console-agent-guard.js';
import { consoleCommands } from './ai.console-commands.js';
import { inspectConsoleCommand, parseConsoleCommandResult } from './ai.console-safety.js';

export interface NodeConsoleToolContext {
  getDispatch: () => NodeDispatchService;
  /** Who calls: remote MCP (OAuth grants and API tokens) or the in-app assistant. */
  source?: 'ai' | 'mcp';
}

function assertNodeConsoleScope(user: User, nodeId: string) {
  if (!hasScopeForResource(user.scopes, 'nodes:console', nodeId)) {
    throw new Error(`Missing required scope: nodes:console:${nodeId}`);
  }
}

/**
 * execute_node_console_command: one command on the node's host. Agents (remote MCP and the in-app assistant) may not change Opfield-managed
 * Docker objects or daemon state with it (MANAGED_RESOURCE_CONSOLE_FORBIDDEN); people in the browser console (a PTY,
 * not this tool) and read-only commands are not affected.
 */
export async function executeNodeConsoleCommand(
  context: NodeConsoleToolContext,
  user: User,
  args: Record<string, unknown>
) {
  const nodeId = String(args.nodeId || '');
  if (!nodeId) throw new Error('nodeId is required');
  assertNodeConsoleScope(user, nodeId);

  const safety = inspectConsoleCommand(args.command as string[]);
  if (safety.blocked) {
    throw new Error(safety.reason ?? 'Console command is blocked');
  }
  const dispatch = context.getDispatch();
  await assertAgentNodeConsoleCommandAllowed({
    user,
    nodeId,
    commands: consoleCommands(safety.normalizedCommand),
    toolName: 'execute_node_console_command',
    dispatch,
    source: context.source,
  });

  const result = await dispatch.sendNodeExecCommand(nodeId, 'run', { command: safety.normalizedCommand }, 35000);
  if (!result.success) {
    throw new Error(result.error || 'Node console command failed');
  }
  const output = parseConsoleCommandResult(result.detail);
  return {
    nodeId,
    command: safety.normalizedCommand,
    risky: safety.risky,
    ...output,
  };
}
