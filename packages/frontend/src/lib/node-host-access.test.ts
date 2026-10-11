import { describe, expect, it } from "vitest";
import type { Node } from "@/types";
import {
  DEFAULT_HOST_ACCESS_INSTALL_OPTIONS,
  isNodeHostFeatureDisabled,
  isNodeProtected,
  nodeConsoleUnavailableMessage,
  nodeHostFeatureDisabledMessage,
  nodeHostFileAccessWarning,
  withHostAccessInstallFlags,
} from "./node-host-access";

function node(type: Node["type"], capabilities: Record<string, unknown>): Node {
  return { type, capabilities } as Node;
}

describe("node host access", () => {
  it("treats console and files as enabled unless the node reports them disabled", () => {
    expect(isNodeHostFeatureDisabled(node("docker", {}), "console")).toBe(false);
    expect(isNodeHostFeatureDisabled(node("docker", {}), "files")).toBe(false);
    expect(isNodeHostFeatureDisabled(null, "console")).toBe(false);
  });

  it("reads the stored flags and the raw markers", () => {
    const consoleOff = node("nginx", { nodeConsoleDisabled: true });
    expect(isNodeHostFeatureDisabled(consoleOff, "console")).toBe(true);
    expect(isNodeHostFeatureDisabled(consoleOff, "files")).toBe(false);
    const filesMarker = node("docker", { capabilities: ["node_files_disabled_v1"] });
    expect(isNodeHostFeatureDisabled(filesMarker, "files")).toBe(true);
  });

  it("warns only when the console is off and host file access is still on", () => {
    expect(nodeHostFileAccessWarning(node("docker", {}))).toBeNull();
    expect(nodeHostFileAccessWarning(node("docker", { nodeFilesDisabled: true }))).toBeNull();
    const both = node("docker", { nodeConsoleDisabled: true, nodeFilesDisabled: true });
    expect(nodeHostFileAccessWarning(both)).toBeNull();
    const consoleOnly = node("docker", { nodeConsoleDisabled: true });
    expect(nodeHostFileAccessWarning(consoleOnly)?.message).toContain(
      "set files.enabled: false as well"
    );
  });

  it("appends the installer flags to a generated setup command", () => {
    const command = "sudo bash setup-node.sh \\\n  --gateway gw:9443";
    expect(withHostAccessInstallFlags(command, DEFAULT_HOST_ACCESS_INSTALL_OPTIONS)).toBe(command);
    const both = { disableConsole: true, disableFiles: true };
    expect(withHostAccessInstallFlags(command, both)).toBe(
      `${command} \\\n  --disable-console \\\n  --disable-files`
    );
    expect(withHostAccessInstallFlags("", both)).toBe("");
    expect(
      withHostAccessInstallFlags(command, {
        disableConsole: false,
        disableFiles: false,
        protectedMode: true,
      })
    ).toBe(`${command} \\\n  --protected`);
  });

  it("reads protected mode from the stored flag and the raw marker", () => {
    expect(isNodeProtected(node("relay", {}))).toBe(false);
    expect(isNodeProtected(null)).toBe(false);
    expect(isNodeProtected(node("relay", { nodeProtected: true }))).toBe(true);
    expect(isNodeProtected(node("relay", { capabilities: ["node_protected_v1"] }))).toBe(true);
  });

  it("names the config key and the daemon config file of the node type", () => {
    expect(nodeHostFeatureDisabledMessage(node("docker", {}), "console")).toBe(
      "The host console is disabled in this node's daemon configuration. To enable it, set console.enabled: true in the daemon config (/etc/docker-daemon/config.yaml) on the node and restart the daemon."
    );
    expect(nodeHostFeatureDisabledMessage(node("bastion", {}), "files")).toContain(
      "set files.enabled: true in the daemon config file on the node"
    );
  });

  it("explains a console the daemon refuses because console.user needs root", () => {
    expect(nodeConsoleUnavailableMessage(node("nginx", {}))).toBeNull();
    expect(nodeConsoleUnavailableMessage(node("nginx", { nodeConsoleDisabled: true }))).toContain(
      "set console.enabled: true"
    );
    const userUnavailable = node("nginx", { nodeConsoleUserUnavailable: true });
    expect(nodeConsoleUnavailableMessage(userUnavailable)).toBe(
      "The daemon config sets console.user to another user, but the daemon does not run as root and cannot start console sessions as that user. Remove console.user from the daemon config (/etc/nginx-daemon/config.yaml) on the node, or run the daemon as root, and restart the daemon."
    );
    const marker = node("monitoring", { capabilities: ["node_console_user_unavailable_v1"] });
    expect(nodeConsoleUnavailableMessage(marker)).toContain("/etc/monitoring-daemon/config.yaml");
    expect(isNodeHostFeatureDisabled(userUnavailable, "console")).toBe(false);
  });
});
