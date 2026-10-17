import { describe, expect, it } from "vitest";
import type { Node } from "@/types";
import {
  DEFAULT_HOST_ACCESS_INSTALL_OPTIONS,
  isNodeHostFeatureDisabled,
  isNodeProtected,
  nodeConsoleUnavailableMessage,
  nodeHostFeatureDisabledMessage,
  nodeHostFileAccessWarning,
  RELAY_LEGACY_HOST_NAMES_HINT,
  relayLegacyHostNameCount,
  withHostAccessInstallFlags,
} from "./node-host-access";
import { LEGACY_INSTALL_DIR_NAME } from "../../../backend/src/lib/legacy-compat";

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
    const command = `sudo bash setup-node.sh \\\n  --${LEGACY_INSTALL_DIR_NAME} gw:9443`;
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

  it("names the config file a relay of its version reads", () => {
    const relay = (daemonVersion: string | null) => ({ ...node("relay", {}), daemonVersion });
    expect(nodeHostFeatureDisabledMessage(relay("2.12.0"), "console")).toContain(
      `(/etc/${LEGACY_INSTALL_DIR_NAME}-relay-supervisor/config.yaml)`
    );
    expect(nodeHostFeatureDisabledMessage(relay("v2.12.1-rc.2"), "console")).toContain(
      `(/etc/${LEGACY_INSTALL_DIR_NAME}-relay-supervisor/config.yaml)`
    );
    expect(nodeHostFeatureDisabledMessage(relay("v2.12.1"), "console")).toContain(
      "(/etc/opfield-relay/config.yaml)"
    );
    expect(nodeHostFeatureDisabledMessage(relay(null), "console")).toContain(
      "(/etc/opfield-relay/config.yaml)"
    );
  });

  it("names both config files for a 2.12.1 relay that reports old host paths", () => {
    const relay = (legacyNames: Record<string, number> | undefined, live = true) => ({
      ...node("relay", {}),
      daemonVersion: "v2.12.1-rc.3",
      ...(live
        ? { liveHealthReport: { legacyNames }, lastHealthReport: null }
        : { lastHealthReport: { legacyNames } }),
    });
    const both =
      `(/etc/opfield-relay/config.yaml, or /etc/${LEGACY_INSTALL_DIR_NAME}-relay-supervisor/config.yaml while the relay keeps its previous paths)`;
    expect(
      nodeHostFeatureDisabledMessage(relay({ paths: 4, services: 1, config: 1 }), "console")
    ).toContain(both);
    expect(nodeHostFeatureDisabledMessage(relay({ paths: 2 }, false), "files")).toContain(both);
    // Only the control section of the config file is old: the file itself has moved.
    expect(nodeHostFeatureDisabledMessage(relay({ config: 1 }), "console")).toContain(
      "(/etc/opfield-relay/config.yaml)"
    );
    expect(nodeHostFeatureDisabledMessage(relay(undefined), "console")).toContain(
      "(/etc/opfield-relay/config.yaml)"
    );
    // Old paths on another node type do not change its daemon config path.
    const docker = { ...node("docker", {}), liveHealthReport: { legacyNames: { paths: 3 } } };
    expect(nodeHostFeatureDisabledMessage(docker, "console")).toContain(
      "(/etc/docker-daemon/config.yaml)"
    );
  });

  it("counts the host names a relay keeps until it is moved", () => {
    expect(relayLegacyHostNameCount(undefined)).toBe(0);
    expect(relayLegacyHostNameCount({ config: 1, containers: 5 })).toBe(0);
    expect(relayLegacyHostNameCount({ paths: 4, services: 1, users: 1, config: 1 })).toBe(6);
    expect(RELAY_LEGACY_HOST_NAMES_HINT).toContain("run the relay installer");
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
