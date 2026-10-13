import type { Node, NodeDetail, NodeType } from "@/types";

/** Host access a node operator can turn off in the daemon config file on the node. */
export type NodeHostFeature = "console" | "files";

const FEATURES: Record<
  NodeHostFeature,
  { flag: string; marker: string; key: string; label: string }
> = {
  console: {
    flag: "nodeConsoleDisabled",
    marker: "node_console_disabled_v1",
    key: "console.enabled",
    label: "The host console is",
  },
  files: {
    flag: "nodeFilesDisabled",
    marker: "node_files_disabled_v1",
    key: "files.enabled",
    label: "Host file access is",
  },
};

const DAEMON_CONFIG_PATHS: Partial<Record<NodeType, string>> = {
  nginx: "/etc/nginx-daemon/config.yaml",
  docker: "/etc/docker-daemon/config.yaml",
  builder: "/etc/docker-daemon/config.yaml",
  databases: "/etc/docker-daemon/config.yaml",
  storage: "/etc/docker-daemon/config.yaml",
  monitoring: "/etc/monitoring-daemon/config.yaml",
  relay: "/etc/opfield-relay/config.yaml",
};

/**
 * Protected mode: the owner of the machine a relay runs on turned it on in the relay's local config
 * (`relay-supervisor protected on`). Gateway cannot open a console, run commands, read or write files or collect host
 * diagnostics on it, and cannot turn it off; it can only update the relay with official signed releases and route
 * traffic through it.
 */
export function isNodeProtected(node: Node | NodeDetail | null | undefined): boolean {
  const capabilities = (node?.capabilities ?? {}) as Record<string, unknown>;
  return (
    capabilities.nodeProtected === true ||
    (Array.isArray(capabilities.capabilities) &&
      capabilities.capabilities.includes("node_protected_v1"))
  );
}

/** What the Protected badge explains. */
export const PROTECTED_NODE_DESCRIPTION =
  "Protected by the machine owner: no console, files, commands or host diagnostics from Opfield. Opfield can update the relay with official signed releases and route traffic through it.";

export function isNodeHostFeatureDisabled(
  node: Node | NodeDetail | null | undefined,
  feature: NodeHostFeature
): boolean {
  const capabilities = (node?.capabilities ?? {}) as Record<string, unknown>;
  const { flag, marker } = FEATURES[feature];
  return (
    capabilities[flag] === true ||
    (Array.isArray(capabilities.capabilities) && capabilities.capabilities.includes(marker))
  );
}

/** Why the feature is unavailable and where the node operator turns it back on. */
export function nodeHostFeatureDisabledMessage(
  node: Pick<Node, "type"> | null | undefined,
  feature: NodeHostFeature
): string {
  const { key, label } = FEATURES[feature];
  const path = node ? DAEMON_CONFIG_PATHS[node.type] : undefined;
  const file = path ? `the daemon config (${path})` : "the daemon config file";
  return `${label} disabled in this node's daemon configuration. To enable it, set ${key}: true in ${file} on the node and restart the daemon.`;
}

/**
 * Why the node's daemon refuses every host console session, or null when it accepts them: the console is turned off,
 * or console.user names another user and the daemon does not run as root.
 */
export function nodeConsoleUnavailableMessage(
  node: Node | NodeDetail | null | undefined
): string | null {
  if (isNodeHostFeatureDisabled(node, "console")) {
    return nodeHostFeatureDisabledMessage(node, "console");
  }
  const capabilities = (node?.capabilities ?? {}) as Record<string, unknown>;
  const unavailable =
    capabilities.nodeConsoleUserUnavailable === true ||
    (Array.isArray(capabilities.capabilities) &&
      capabilities.capabilities.includes("node_console_user_unavailable_v1"));
  if (!unavailable) return null;
  const path = node ? DAEMON_CONFIG_PATHS[node.type] : undefined;
  const file = path ? `the daemon config (${path})` : "the daemon config file";
  return `The daemon config sets console.user to another user, but the daemon does not run as root and cannot start console sessions as that user. Remove console.user from ${file} on the node, or run the daemon as root, and restart the daemon.`;
}

/**
 * Turning the console off alone is not a boundary: writing host files as the daemon user can still change the host
 * (systemd units, cron jobs, SSH keys, the daemon config itself). Null unless console is off and files are on.
 */
export function nodeHostFileAccessWarning(
  node: Node | NodeDetail | null | undefined
): { title: string; message: string } | null {
  if (!isNodeHostFeatureDisabled(node, "console") || isNodeHostFeatureDisabled(node, "files")) {
    return null;
  }
  return {
    title: "Host file access is still on",
    message:
      "File access as the daemon user can still change the host, for example systemd units, cron jobs, SSH keys, or the daemon config itself. To remove host access, set files.enabled: false as well.",
  };
}

/** Installer options that turn host access off on the node being installed. */
export interface HostAccessInstallOptions {
  disableConsole: boolean;
  disableFiles: boolean;
  /** Relay installer only: --protected (protected mode, which the machine owner alone can turn off). */
  protectedMode?: boolean;
}

export const DEFAULT_HOST_ACCESS_INSTALL_OPTIONS: HostAccessInstallOptions = {
  disableConsole: false,
  disableFiles: false,
};

/** Appends the installer flags to a generated setup command, whose arguments end it one per continued line. */
export function withHostAccessInstallFlags(
  command: string,
  options: HostAccessInstallOptions
): string {
  if (!command) return command;
  const flags = [
    ...(options.disableConsole ? ["--disable-console"] : []),
    ...(options.disableFiles ? ["--disable-files"] : []),
    ...(options.protectedMode ? ["--protected"] : []),
  ];
  return flags.reduce((result, flag) => `${result} \\\n  ${flag}`, command);
}
