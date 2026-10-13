/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ACTION_OPTIONS,
  getAuditActionLabel,
  hasAuditActionLabel,
} from "./audit-action-labels";

const BACKEND_SRC = resolve(__dirname, "../../../../backend/src");
const DOTTED = "[a-z][a-z0-9_-]*(?:\\.[a-z0-9_-]+)+";
const NOT_AN_ACTION = /\.(js|ts|json|md|com|dev|io|org|local)$/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.includes(".test.") && !name.includes("test-helpers")
      ? [path]
      : [];
  });
}

/** Audit actions the backend writes: `action: '…'`, audit helpers' first argument and *_AUDIT_ACTIONS constants. */
function emittedActions(): { literals: Set<string>; templates: Set<string> } {
  const literals = new Set<string>();
  const templates = new Set<string>();
  const add = (value: string) => {
    if (NOT_AN_ACTION.test(value)) return;
    if (value.includes("${")) templates.add(value);
    else if (new RegExp(`^${DOTTED}$`).test(value)) literals.add(value);
  };
  for (const file of sources(BACKEND_SRC)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\baction:\s*([^,\n]+)/g)) {
      for (const value of match[1]!.matchAll(/'([^']+)'|`([^`]+)`/g)) add(value[1] ?? value[2]!);
    }
    for (const match of source.matchAll(/\b\w*[aA]udit\w*\(\s*([^\n]{0,200})/g)) {
      const firstArgs = match[1]!.split(/,\s*\{/)[0]!;
      for (const value of firstArgs.matchAll(/'([^']+)'|`([^`]+)`/g)) add(value[1] ?? value[2]!);
    }
    for (const match of source.matchAll(/AUDIT_ACTIONS?\s*=\s*\{([^}]*)\}/g)) {
      for (const value of match[1]!.matchAll(/'([^']+)'/g)) add(value[1]!);
    }
  }
  return { literals, templates };
}

/** Values the backend fills into action templates; a template not listed here fails the test. */
function scannedValues(key: string): string[] {
  const values = new Set<string>();
  for (const file of sources(BACKEND_SRC)) {
    for (const match of readFileSync(file, "utf8").matchAll(
      new RegExp(`\\b${key}:\\s*'([^']+)'`, "g")
    )) {
      values.add(match[1]!);
    }
  }
  return [...values];
}

const TEMPLATE_VALUES: Record<string, () => string[]> = {
  "${this.config.auditResourceType}.create": () =>
    scannedValues("auditResourceType").map((t) => `${t}.create`),
  "${this.config.auditResourceType}.update": () =>
    scannedValues("auditResourceType").map((t) => `${t}.update`),
  "${this.config.auditResourceType}.delete": () =>
    scannedValues("auditResourceType").map((t) => `${t}.delete`),
  "${this.config.auditResourceType}.move": () =>
    scannedValues("auditResourceType").map((t) => `${t}.move`),
  "${movedResourceType}.move_to_folder": () =>
    [...scannedValues("resourceName"), ...scannedValues("auditMovedResourceType")]
      .filter((name) => !name.includes("/"))
      .map((name) => `${name}.move_to_folder`),
  "hosting.vm.${input.action}.requested": () =>
    [
      "start",
      "shutdown",
      "reboot",
      "resize",
      "delete",
      "recover",
      "snapshot_create",
      "snapshot_delete",
      "snapshot_restore",
    ].map((action) => `hosting.vm.${action}.requested`),
  "docker.availability.lease_${notice.kind}": () => [
    "docker.availability.lease_failover",
    "docker.availability.lease_handoff",
  ],
  "health.${status}": () => [
    "health.sampled",
    "health.configured",
    "health.stopped",
    "health.unknown",
  ],
  "route.${method.toLowerCase()}": () => ["route.post", "route.put", "route.patch", "route.delete"],
  "mcp.${tool.name}": () => ["mcp.update_route"],
  "mcp.${toolName}": () => ["mcp.update_route"],
  "${source}.${toolName}": () => ["ai.manage_node", "mcp.manage_node"],
  "auth.${routeName}${mutation}": () => ["auth.passkeys_register", "auth.me_profile.update"],
};
for (const verb of ["create", "update", "delete", "test"]) {
  TEMPLATE_VALUES[`integrations.\${provider}.connector.${verb}`] = () =>
    ["github", "git"].map((provider) => `integrations.${provider}.connector.${verb}`);
}
for (const verb of ["authorize", "disconnect"]) {
  TEMPLATE_VALUES[`integrations.\${provider}.user_credential.${verb}`] = () =>
    ["github", "git"].map((provider) => `integrations.${provider}.user_credential.${verb}`);
}

describe("audit action labels", () => {
  const { literals, templates } = emittedActions();

  it("finds the backend's audit actions", () => {
    expect(literals.size).toBeGreaterThan(250);
    expect(literals).toContain("app.start");
    expect(literals).toContain("cloud.request");
  });

  it("labels every action the backend writes", () => {
    const unlabelled = [...literals].filter((action) => !hasAuditActionLabel(action));
    expect(unlabelled).toEqual([]);
  });

  it("labels every value of every action template", () => {
    const unknownTemplates = [...templates].filter((template) => !(template in TEMPLATE_VALUES));
    expect(unknownTemplates).toEqual([]);
    const unlabelled = [...templates]
      .flatMap((template) => TEMPLATE_VALUES[template]?.() ?? [])
      .filter((action) => !hasAuditActionLabel(action));
    expect(unlabelled).toEqual([]);
  });

  it("reads plainly and lists every action in the filter", () => {
    expect(getAuditActionLabel("app.start")).toBe("Started app");
    expect(getAuditActionLabel("mcp.update_route")).toBe("MCP: Update route");
    expect(getAuditActionLabel("auth.me_profile.update")).toBe("Account: me profile (changed)");
    expect(AUDIT_ACTION_OPTIONS).toHaveLength(Object.keys(AUDIT_ACTION_LABELS).length);
    for (const label of Object.values(AUDIT_ACTION_LABELS)) {
      expect(label).toMatch(/^[A-Z]/);
      expect(label).not.toMatch(/_|\s{2}/);
    }
  });
});
