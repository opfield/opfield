import { analyzeConsoleCommand } from './ai.console-commands.js';
import { consoleMutations } from './ai.console-docker-mutations.js';
import { emptyInventory, evaluateConsoleMutations, managedResourceConsoleError } from './ai.console-managed-guard.js';
import { containerRuntimeCommand, nodeConsoleRuntimeError } from './ai.console-runtime.js';
import { inspectConsoleCommand } from './ai.console-safety.js';

/**
 * The refusal execute_node_console_command answers with whatever the node's state and the caller's grants, read from
 * the command alone: a blocked pattern, a write to daemon state, or any use of the container runtime (every change to
 * a managed Docker object is one). Null otherwise, also for a malformed call (the tool reports that itself). The
 * in-app assistant asks it before it asks a person to approve the call, so nobody approves a command that is refused
 * anyway; the call then runs and is refused, and audited, as usual.
 */
export function nodeConsoleCommandStaticRefusal(args: Record<string, unknown>): Error | null {
  if (!String(args.nodeId || '')) return null;
  let safety: ReturnType<typeof inspectConsoleCommand>;
  try {
    safety = inspectConsoleCommand(args.command as string[]);
  } catch {
    return null;
  }
  if (safety.blocked) return new Error(safety.reason ?? 'Console command is blocked');
  const { commands } = analyzeConsoleCommand(safety.normalizedCommand);
  const stateWrite = evaluateConsoleMutations(
    consoleMutations(commands).filter((mutation) => mutation.kind === 'state_path'),
    emptyInventory()
  );
  if (stateWrite) return managedResourceConsoleError(stateWrite);
  const runtime = containerRuntimeCommand(commands);
  return runtime ? nodeConsoleRuntimeError(runtime) : null;
}

/** Whether an agent tool call is refused whatever the node's state, so asking a person to approve it is pointless. */
export function toolCallRefusedBeforeApproval(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'execute_node_console_command') return nodeConsoleCommandStaticRefusal(args) !== null;
  if (toolName === 'ssh_execute_command') {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) return false;
    try {
      return inspectConsoleCommand(['sh', '-lc', command]).blocked;
    } catch {
      return false;
    }
  }
  return false;
}
