import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
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
 * execute_node_console_command: one command on the node's host, run by the daemon as root (or console.user; the
 * daemon's own user when the daemon is not root, which the result's runAs and limits say) in the agent sandbox, where the container runtime's sockets and CLIs are covered (see agent_sandbox.go). A command that
 * visibly changes Opfield-managed Docker objects or daemon state (MANAGED_RESOURCE_CONSOLE_FORBIDDEN) or uses the
 * container runtime (NODE_CONSOLE_RUNTIME_UNAVAILABLE) is refused before it is sent, with the tool to use. People in
 * the browser console (a PTY, not this tool) are not affected.
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

  const timeoutSeconds = readTimeoutSeconds(args.timeoutSeconds);
  const result = await dispatch.sendNodeAgentCommand(
    nodeId,
    safety.normalizedCommand,
    (timeoutSeconds + NODE_CONSOLE_ANSWER_MARGIN_SECONDS) * 1000,
    timeoutSeconds
  );
  const output = parseConsoleCommandResult(result.detail);
  if (!result.success && !commandRan(output)) {
    throw new Error(result.error || 'Node console command failed');
  }
  // A command that ran and failed (a non-zero exit, its time limit) keeps its output, exit code and risk: the agent
  // needs them to see why (rc.3 GO-1 returned only "exit status 2").
  return {
    nodeId,
    command: safety.normalizedCommand,
    risky: consoleCommandRisky(safety.risky, analysis),
    ...output,
    ...(result.success ? {} : { error: result.error || 'The command failed' }),
    ...(output.timedOut ? { timeoutSeconds } : {}),
  };
}

/** Default and maximum time an agent console command may run on the node. */
export const NODE_CONSOLE_DEFAULT_TIMEOUT_SECONDS = 30;
export const NODE_CONSOLE_MAX_TIMEOUT_SECONDS = 300;
/** How much longer Opfield waits for the daemon's answer than the command may run. */
const NODE_CONSOLE_ANSWER_MARGIN_SECONDS = 10;

function readTimeoutSeconds(value: unknown): number {
  if (value === undefined || value === null) return NODE_CONSOLE_DEFAULT_TIMEOUT_SECONDS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > NODE_CONSOLE_MAX_TIMEOUT_SECONDS) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `timeoutSeconds must be a whole number of seconds from 1 to ${NODE_CONSOLE_MAX_TIMEOUT_SECONDS} (default ${NODE_CONSOLE_DEFAULT_TIMEOUT_SECONDS}).`
    );
  }
  return value;
}

/** Whether a failed run still ran the command (and so has output to return), rather than failing to start it. */
function commandRan(output: ReturnType<typeof parseConsoleCommandResult>): boolean {
  return (
    output.sandbox !== undefined ||
    output.timedOut === true ||
    (output.exitCode !== undefined && output.exitCode !== 0) ||
    !!output.stdout ||
    !!output.stderr
  );
}
