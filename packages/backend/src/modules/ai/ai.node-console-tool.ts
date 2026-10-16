import { hasScopeForResource } from '@/lib/permissions.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { User } from '@/types.js';
import { assertAgentNodeConsoleCommandAllowed } from './ai.console-agent-guard.js';
import { analyzeConsoleCommand } from './ai.console-commands.js';
import { consoleCommandRisky } from './ai.console-runtime.js';
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

function readCall(user: User, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId || '');
  if (!nodeId) throw new Error('nodeId is required');
  assertNodeConsoleScope(user, nodeId);
  const safety = inspectConsoleCommand(args.command as string[]);
  if (safety.blocked) {
    throw new Error(safety.reason ?? 'Console command is blocked');
  }
  const analysis = analyzeConsoleCommand(safety.normalizedCommand);
  return { nodeId, safety, analysis };
}

/**
 * execute_node_console_command: one command on the node's host, run by the daemon in the agent sandbox (no container
 * runtime, an unprivileged identity; see agent_sandbox.go). A command that visibly changes Opfield-managed Docker
 * objects or daemon state (MANAGED_RESOURCE_CONSOLE_FORBIDDEN) or uses the container runtime
 * (NODE_CONSOLE_RUNTIME_UNAVAILABLE) is refused before it is sent, with the tool to use. People in the browser console
 * (a PTY, not this tool) are not affected.
 */
export async function executeNodeConsoleCommand(
  context: NodeConsoleToolContext,
  user: User,
  args: Record<string, unknown>
) {
  const { nodeId, safety, analysis } = readCall(user, args);
  const dispatch = context.getDispatch();
  await assertAgentNodeConsoleCommandAllowed({
    user,
    nodeId,
    commands: analysis.commands,
    toolName: 'execute_node_console_command',
    dispatch,
    source: context.source,
  });

  const result = await dispatch.sendNodeAgentCommand(nodeId, safety.normalizedCommand, 35000);
  if (!result.success) {
    throw new Error(result.error || 'Node console command failed');
  }
  const output = parseConsoleCommandResult(result.detail);
  return {
    nodeId,
    command: safety.normalizedCommand,
    risky: consoleCommandRisky(safety.risky, analysis),
    ...output,
  };
}
