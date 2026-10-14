import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IsolatedNotice,
  memberIncidentBlock,
  memberIncidentHold,
} from "@/components/apps/IsolatedNotice";
import type { AppDetail, AppIncident, AppPromotionPreviewItem } from "@/types";
import { shutdownBlockedReason } from "./dialogs/incident-scope";
import { KillSwitchDialog } from "./dialogs/KillSwitchDialog";
import { differenceSummary } from "./dialogs/PromoteDialog";
import { SettingsTab } from "./tabs/SettingsTab";

const api = vi.hoisted(() => ({
  previewAppIncident: vi.fn(),
  isolateApp: vi.fn(),
  releaseAppIsolation: vi.fn(),
  startApp: vi.fn(),
  shutdownApp: vi.fn(),
}));

vi.mock("@/services/api", () => ({ api }));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => undefined }));

function incident(
  kind: AppIncident["kind"],
  environmentId: string,
  extra: Partial<AppIncident> = {}
): AppIncident {
  return {
    id: `${kind}-${environmentId}`,
    batchId: "batch",
    environmentId,
    kind,
    state: "active",
    startedAt: "2026-10-11T09:42:00Z",
    startedBy: { id: "user-1", name: "Maya Chen" },
    releasedAt: null,
    releasedBy: null,
    lastError: null,
    counts: { total: 1, pending: 0, applied: 1, failed: 0, restored: 0, restoreFailed: 0, gone: 0 },
    items: [],
    ...extra,
  };
}

function app(incidents: Record<string, AppIncident[]> = {}, operate = true): AppDetail {
  const env = (id: string, name: string, isProduction: boolean) => ({
    id,
    slug: name,
    name,
    isProduction,
    maintenanceEnabled: false,
    health: "healthy" as const,
    memberCounts: { container: 2 },
    placementFolderIds: {
      containers: null,
      compose: null,
      routes: null,
      databases: null,
      storage: null,
      pages: null,
      certificates: null,
      logging: null,
      domains: null,
    },
    allowedNodeIds: [],
    incidents: incidents[id] ?? [],
  });
  return {
    id: "app-1",
    slug: "shop",
    name: "Shop",
    maintenanceOverride: false,
    environments: [env("env-live", "live", true), env("env-staging", "staging", false)],
    permissions: {
      edit: true,
      delete: true,
      operate,
      envManage: {},
      promote: {},
      operateEnv: { "env-live": operate, "env-staging": true },
    },
  };
}

function settings(detail: AppDetail) {
  render(
    <MemoryRouter>
      <SettingsTab
        app={detail}
        onChanged={vi.fn()}
        onNewEnvironment={vi.fn()}
        onCreateAccessCode={vi.fn()}
        routeCount={3}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.previewAppIncident.mockResolvedValue({
    kind: "isolation",
    environments: [],
    summary: {
      routes: 5,
      links: 5,
      bindings: 2,
      secureLinks: 0,
      publications: 1,
      containers: 6,
      composeProjects: 2,
    },
  });
});

describe("App shutdown and kill switch", () => {
  it("offers Shut down and Isolate app when nothing is stopped or isolated", () => {
    settings(app());
    expect(screen.getByRole("button", { name: /Shut down/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Isolate app/ })).toBeInTheDocument();
  });

  it("offers Start and Turn off with Stopped and Isolated badges during incidents", () => {
    settings(
      app({ "env-live": [incident("shutdown", "env-live"), incident("isolation", "env-live")] })
    );
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText("Isolated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Turn off/ })).toBeInTheDocument();
  });

  it("disables Shut down with the reason while the kill switch isolates every environment", () => {
    settings(
      app({
        "env-live": [incident("isolation", "env-live")],
        "env-staging": [incident("isolation", "env-staging")],
      })
    );
    const shutDown = screen.getByRole("button", { name: /Shut down/ });
    expect(shutDown).toBeDisabled();
    expect(shutDown.getAttribute("title")).toContain("Turn the kill switch off");
  });

  it("refuses a shutdown only for scopes that hold an isolated environment", () => {
    const detail = app({ "env-live": [incident("isolation", "env-live")] });
    expect(shutdownBlockedReason(detail, "all")).toBe(
      "live is isolated by the app kill switch. Turn the kill switch off before shutting it down."
    );
    expect(shutdownBlockedReason(detail, "env-live")).not.toBeNull();
    expect(shutdownBlockedReason(detail, "env-staging")).toBeNull();
    const releasing = app({
      "env-live": [incident("isolation", "env-live", { state: "releasing" })],
    });
    expect(shutdownBlockedReason(releasing, "all")).toBeNull();
    settings(detail);
    expect(screen.getByRole("button", { name: /Shut down/ })).toBeEnabled();
  });

  it("shows the live consequences and isolates only after the name is typed", async () => {
    render(<KillSwitchDialog app={app()} open onOpenChange={vi.fn()} onDone={vi.fn()} />);
    expect(
      await screen.findByText("5 routes show the maintenance page; no access code works")
    ).toBeInTheDocument();
    expect(
      screen.getByText("6 containers and 2 Compose projects lose network access")
    ).toBeInTheDocument();
    const isolate = screen.getByRole("button", { name: "Isolate" });
    expect(isolate).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Type Shop"), { target: { value: "Shop" } });
    expect(isolate).toBeEnabled();
    expect(api.previewAppIncident).toHaveBeenCalledWith("app-1", "isolation", null);
  });

  it("names who isolated which environments and lists items not applied yet", () => {
    render(
      <MemoryRouter>
        <IsolatedNotice
          app={app({
            "env-live": [
              incident("isolation", "env-live", {
                items: [
                  {
                    id: "i1",
                    kind: "container_network",
                    label: "web",
                    status: "failed",
                    attempts: 2,
                    lastError: "node offline",
                  },
                ],
              }),
            ],
          })}
        />
      </MemoryRouter>
    );
    expect(
      screen.getByText(/Isolated by the app kill switch since .* by Maya Chen/)
    ).toBeInTheDocument();
    expect(screen.getByText(/live of Shop: routes show the maintenance page/)).toBeInTheDocument();
    expect(
      screen.getByText(/1 item is not applied yet and retried: web \(node offline\)/)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Turn off/ })).toBeInTheDocument();
  });
});

describe("Promote", () => {
  const item = (
    type: AppPromotionPreviewItem["type"],
    extra: Partial<AppPromotionPreviewItem> = {}
  ) => ({ type, same: false, promotable: true, ...extra }) as AppPromotionPreviewItem;

  it("summarises what differs", () => {
    expect(
      differenceSummary([
        item("container"),
        item("deployment"),
        item("compose"),
        item("pages"),
        item("pages", { same: true }),
      ])
    ).toBe("2 images, 1 Compose revision and 1 Pages deployment");
    expect(differenceSummary([item("container", { same: true })])).toBe("");
  });
});

describe("member incident block (Move to Valkey)", () => {
  const ref = {
    id: "app-1",
    slug: "shop",
    name: "Shop",
    environmentId: "env-live",
    environmentName: "live",
  };

  it("blocks a member of an isolated environment, not a shut-down one, one that is releasing or elsewhere", () => {
    expect(memberIncidentBlock(app({ "env-live": [incident("isolation", "env-live")] }), ref)).toBe(
      "isolation"
    );
    expect(
      memberIncidentBlock(app({ "env-live": [incident("shutdown", "env-live")] }), ref)
    ).toBeNull();
    expect(
      memberIncidentBlock(
        app({ "env-live": [incident("isolation", "env-live", { state: "releasing" })] }),
        ref
      )
    ).toBeNull();
    expect(
      memberIncidentBlock(app({ "env-staging": [incident("isolation", "env-staging")] }), ref)
    ).toBeNull();
    expect(memberIncidentBlock(null, ref)).toBeNull();
    expect(memberIncidentBlock(app(), null)).toBeNull();
  });
});

describe("member incident hold (deletes, unbinds, renames)", () => {
  const ref = {
    id: "app-1",
    slug: "shop",
    name: "Shop",
    environmentId: "env-live",
    environmentName: "live",
  };

  it("holds members of an isolated environment only; a shutdown holds nothing", () => {
    const isolated = app({ "env-live": [incident("isolation", "env-live")] });
    const isolatedReason = "Unavailable while the app kill switch isolates this environment.";
    expect(memberIncidentHold(isolated, ref)).toEqual({
      frozen: isolatedReason,
      kept: isolatedReason,
    });
    const shutDown = app({ "env-live": [incident("shutdown", "env-live")] });
    expect(memberIncidentHold(shutDown, ref)).toEqual({ frozen: null, kept: null });
    expect(memberIncidentHold(app(), ref)).toEqual({ frozen: null, kept: null });
    expect(memberIncidentHold(null, ref)).toEqual({ frozen: null, kept: null });
  });
});
