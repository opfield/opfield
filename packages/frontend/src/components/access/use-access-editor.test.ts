import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AccessCatalog } from "./access-catalog";
import {
  ACCESS_TYPES,
  type AccessLine,
  lineScopes,
  linesToScopes,
  type ResourceAccessLine,
} from "./access-model";
import { useAccessEditor } from "./use-access-editor";

const catalog = vi.hoisted(() => ({ current: null as AccessCatalog | null }));
vi.mock("./access-catalog", () => ({ useAccessCatalog: () => catalog.current }));

/** Folder `billing` in every tree but Domains. */
catalog.current = {
  ready: true,
  ctx: {
    folders: ACCESS_TYPES.filter((type) => type.family !== "domains").map((type) => ({
      id: `${type.family}-billing`,
      label: "billing",
      family: type.family,
      ancestorIds: [],
    })),
  },
  labels: {},
  gitConnectors: {},
  resources: [],
  loadResources: () => undefined,
  rememberGitLabel: () => undefined,
};
const ctx = catalog.current.ctx;
const ALL_TYPES = ACCESS_TYPES.map((type) => type.id);

const viewerEverywhere: ResourceAccessLine = {
  kind: "resources",
  role: "viewer",
  types: ALL_TYPES,
  where: { kind: "everywhere" },
  mayDelete: false,
};
const developerInBilling: AccessLine = {
  kind: "resources",
  role: "developer",
  types: ALL_TYPES.filter((type) => type !== "domains"),
  where: { kind: "folder", path: "billing" },
  mayDelete: false,
};
const operatorOnWeb: AccessLine = {
  kind: "resources",
  role: "operator",
  types: ["containers"],
  where: { kind: "resources", ids: { containers: ["node-1/web"] } },
  mayDelete: false,
};

describe("access editor", () => {
  it("reopens overlapping lines as they were saved, counting what is stored", async () => {
    const lines = [viewerEverywhere, developerInBilling, operatorOnWeb];
    const stored = linesToScopes(lines, ctx);
    expect(stored.length).toBeLessThan(
      new Set(lines.flatMap((line) => lineScopes(line, ctx))).size
    );
    const { result } = renderHook(() => useAccessEditor({ open: true, scopes: stored }));
    await waitFor(() => expect(result.current.lines).toEqual(lines));
    expect(result.current.scopes).toEqual(stored);
    expect(result.current.changed).toBe(false);
    expect(result.current.views.map((view) => view.note)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("says when a line adds nothing to the others", async () => {
    const { result } = renderHook(() =>
      useAccessEditor({ open: true, scopes: linesToScopes([viewerEverywhere], ctx) })
    );
    await waitFor(() => expect(result.current.lines).toHaveLength(1));
    act(() =>
      result.current.saveLine({
        ...viewerEverywhere,
        types: ["containers"],
        where: { kind: "folder", path: "billing" },
      })
    );
    expect(result.current.views[1]?.note).toBe(
      "Adds nothing: the other lines already give this access"
    );
    expect(result.current.changed).toBe(false);
  });

  it("counts what a token keeps of a line wider than its owner", async () => {
    const ownerScopes = linesToScopes([viewerEverywhere, developerInBilling, operatorOnWeb], ctx);
    const { result } = renderHook(() => useAccessEditor({ open: true, scopes: [], ownerScopes }));
    await waitFor(() => expect(result.current.lines).toEqual([]));
    const operatorEverywhere: AccessLine = {
      kind: "resources",
      role: "operator",
      types: ["containers"],
      where: { kind: "everywhere" },
      mayDelete: false,
    };
    act(() => result.current.saveLine(operatorEverywhere));
    expect(lineScopes(operatorEverywhere, ctx)).toHaveLength(9);
    // docker:containers:view, the Developer set in billing, the Operator set on node-1/web.
    expect(result.current.scopes).toHaveLength(13);
    expect(result.current.views[0]?.note).toMatch(/^Works as /);
  });

  it("keeps its lines while the dialog closes and starts again from the stored scopes at the next opening", async () => {
    const stored = linesToScopes([viewerEverywhere], ctx);
    const { result, rerender } = renderHook(
      ({ open }) => useAccessEditor({ open, scopes: stored }),
      {
        initialProps: { open: true },
      }
    );
    await waitFor(() => expect(result.current.lines).toHaveLength(1));
    act(() => result.current.saveLine(developerInBilling));
    expect(result.current.lines).toHaveLength(2);

    rerender({ open: false });
    // Past any close animation: the content is what it was until the next opening.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(result.current.lines).toHaveLength(2);
    expect(result.current.views).toHaveLength(2);

    rerender({ open: true });
    await waitFor(() => expect(result.current.lines).toEqual([viewerEverywhere]));
  });

  it("narrows an OAuth request by removing a line, within the request and keeping custom scopes", async () => {
    const custom = ["admin:audit", "nodes:details"];
    const grantable = [...linesToScopes([viewerEverywhere, operatorOnWeb], ctx), ...custom].sort();
    const { result } = renderHook(() =>
      useAccessEditor({ open: true, scopes: grantable, ownerScopes: grantable })
    );
    await waitFor(() => expect(result.current.lines).toHaveLength(3));
    expect(result.current.scopes).toEqual(grantable);
    expect(result.current.views.every((view) => view.note === undefined)).toBe(true);

    const operatorIndex = result.current.lines.findIndex(
      (line) => line.kind === "resources" && line.role === "operator"
    );
    act(() => result.current.removeLine(operatorIndex));
    expect(result.current.lines.find((line) => line.kind === "custom")).toEqual({
      kind: "custom",
      scopes: custom,
    });
    expect(result.current.scopes.every((scope) => grantable.includes(scope))).toBe(true);
    expect(result.current.scopes).toEqual(
      [...linesToScopes([viewerEverywhere], ctx), ...custom].sort()
    );
  });
});
