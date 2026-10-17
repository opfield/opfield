import { AppError } from '@/middleware/error-handler.js';

/**
 * Host console and host file access can be turned off in a node's daemon config file (`console.enabled`,
 * `files.enabled`). The switch lives only on the node, so nobody can turn it back on from Opfield; the daemon
 * advertises a disabled feature with these markers when it registers. Docker container consoles and container files
 * are not covered: they give no host access.
 */
export const NODE_CONSOLE_DISABLED_CAPABILITY = 'node_console_disabled_v1';
export const NODE_FILES_DISABLED_CAPABILITY = 'node_files_disabled_v1';
/**
 * The daemon config sets `console.user` to another user, but the daemon runs without root and cannot start sessions
 * as that user, so it refuses every console session.
 */
export const NODE_CONSOLE_USER_UNAVAILABLE_CAPABILITY = 'node_console_user_unavailable_v1';
/**
 * Protected mode: the owner of the machine a relay runs on turned it on in the relay's local config. The relay refuses
 * console, command execution, file access and host diagnostics whatever Opfield sends; Opfield can only update it with
 * official signed releases and route traffic through it. Nobody can turn it off from Opfield.
 */
export const NODE_PROTECTED_CAPABILITY = 'node_protected_v1';
/** The owner of a protected relay allows database availability witness processes on it (off by default). */
export const RELAY_PROTECTED_WITNESS_ALLOWED_CAPABILITY = 'relay_protected_witness_allowed_v1';

const NODE_PROTECTED = {
  code: 'NODE_PROTECTED',
  message:
    "This relay runs in protected mode, set by the owner of its machine in the relay's local configuration. Opfield cannot open a console, run commands, read or write files or collect host diagnostics on it; it can only update the relay with official signed releases and route traffic through it. Only the machine owner can turn protected mode off.",
};

const CONSOLE_USER_UNAVAILABLE = {
  code: 'NODE_CONSOLE_USER_UNAVAILABLE',
  message:
    "This node's daemon config sets console.user to another user, but the daemon does not run as root and cannot start sessions as that user. Remove console.user from the daemon config file on the node, or run the daemon as root, and restart the daemon.",
};

export type NodeHostFeature = 'console' | 'files';

const FEATURES: Record<NodeHostFeature, { capability: string; code: string; message: string }> = {
  console: {
    capability: NODE_CONSOLE_DISABLED_CAPABILITY,
    code: 'NODE_CONSOLE_DISABLED',
    message:
      "Console is disabled in this node's daemon configuration. Set console.enabled: true in the daemon config file on the node and restart the daemon to enable it.",
  },
  files: {
    capability: NODE_FILES_DISABLED_CAPABILITY,
    code: 'NODE_FILES_DISABLED',
    message:
      "File access is disabled in this node's daemon configuration. Set files.enabled: true in the daemon config file on the node and restart the daemon to enable it.",
  },
};

/** The flags stored on the node's capabilities (and returned by the node API) for the features its daemon disabled. */
export function nodeHostAccessFlags(advertised: readonly string[] | null | undefined): {
  nodeProtected?: true;
  protectedWitnessAllowed?: true;
  nodeConsoleDisabled?: true;
  nodeFilesDisabled?: true;
  nodeConsoleUserUnavailable?: true;
} {
  const nodeProtected = advertised?.includes(NODE_PROTECTED_CAPABILITY) === true;
  return {
    ...(nodeProtected ? { nodeProtected: true as const } : {}),
    ...(nodeProtected && advertised?.includes(RELAY_PROTECTED_WITNESS_ALLOWED_CAPABILITY)
      ? { protectedWitnessAllowed: true as const }
      : {}),
    ...(advertised?.includes(NODE_CONSOLE_DISABLED_CAPABILITY) ? { nodeConsoleDisabled: true as const } : {}),
    ...(advertised?.includes(NODE_FILES_DISABLED_CAPABILITY) ? { nodeFilesDisabled: true as const } : {}),
    ...(advertised?.includes(NODE_CONSOLE_USER_UNAVAILABLE_CAPABILITY)
      ? { nodeConsoleUserUnavailable: true as const }
      : {}),
  };
}

export function nodeHostFeatureDisabledError(feature: NodeHostFeature): AppError {
  const { code, message } = FEATURES[feature];
  return new AppError(409, code, message);
}

type CapabilityRegistry = { hasCapability(nodeId: string, capability: string): boolean };

export function nodeProtectedError(): AppError {
  return new AppError(409, NODE_PROTECTED.code, NODE_PROTECTED.message);
}

/** Whether the connected node runs in protected mode. */
export function isNodeProtected(registry: CapabilityRegistry, nodeId: string): boolean {
  return registry.hasCapability(nodeId, NODE_PROTECTED_CAPABILITY);
}

/** Why the node's daemon refuses every host console session, or null when it accepts them. */
export function nodeConsoleRefusal(registry: CapabilityRegistry, nodeId: string): AppError | null {
  if (isNodeProtected(registry, nodeId)) {
    return nodeProtectedError();
  }
  if (registry.hasCapability(nodeId, NODE_CONSOLE_DISABLED_CAPABILITY)) {
    return nodeHostFeatureDisabledError('console');
  }
  if (registry.hasCapability(nodeId, NODE_CONSOLE_USER_UNAVAILABLE_CAPABILITY)) {
    return new AppError(409, CONSOLE_USER_UNAVAILABLE.code, CONSOLE_USER_UNAVAILABLE.message);
  }
  return null;
}

/** Refuses a host console or file command for a connected node whose daemon advertises the feature as unavailable. */
export function assertNodeHostFeatureEnabled(
  registry: CapabilityRegistry,
  nodeId: string,
  feature: NodeHostFeature
): void {
  const refusal =
    feature === 'console'
      ? nodeConsoleRefusal(registry, nodeId)
      : isNodeProtected(registry, nodeId)
        ? nodeProtectedError()
        : registry.hasCapability(nodeId, FEATURES[feature].capability)
          ? nodeHostFeatureDisabledError(feature)
          : null;
  if (refusal) {
    throw refusal;
  }
}

/**
 * Daemons that run agents' one-shot console commands (execute_node_console_command) in the agent sandbox: their own
 * mount namespace and process group, with the container runtime's sockets and CLIs covered. Opfield sends agent
 * commands only to these daemons.
 */
export const NODE_CONSOLE_AGENT_SANDBOX_CAPABILITY = 'node_console_agent_sandbox_v1';

/** Refuses an agent console command for a node whose daemon cannot run it in the agent sandbox. */
export function assertNodeAgentConsoleSandbox(registry: CapabilityRegistry, nodeId: string): void {
  if (registry.hasCapability(nodeId, NODE_CONSOLE_AGENT_SANDBOX_CAPABILITY)) return;
  throw new AppError(
    409,
    'NODE_CONSOLE_AGENT_SANDBOX_REQUIRED',
    "This node's daemon is too old to run agent console commands in the agent sandbox, so Opfield does not send them to it. Update the node's daemon (Nodes, the node, Update daemon), then run the command again. People can still use the browser console."
  );
}
