import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { waitForReveal } from "@/test/reveal";
import type { AppSummary, User } from "@/types";
import { AppsList } from "./AppsList";

const api = vi.hoisted(() => ({
  getCached: vi.fn(() => undefined),
  setCache: vi.fn(),
  listApps: vi.fn(),
  createApp: vi.fn(),
}));

vi.mock("@/services/api", () => ({ api }));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => undefined }));

const shop: AppSummary = {
  id: "app-1",
  slug: "shop",
  name: "Shop",
  environments: [
    { id: "env-2", name: "staging", isProduction: false, health: "healthy" },
    { id: "env-1", name: "live", isProduction: true, health: "failing" },
  ],
  health: "failing",
  incident: "none",
  cpuPercent: 18.4,
  memoryBytes: 626 * 1024 * 1024,
  running: 6,
  failing: 2,
  degraded: 1,
};

function signIn(scopes: string[]) {
  useAuthStore.setState({ user: { id: "user-1", scopes } as User, isLoading: false });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Apps list", () => {
  it("shows the empty state with the create action for a user who may create apps", async () => {
    signIn(["apps:view", "apps:create"]);
    api.listApps.mockResolvedValue([]);
    render(
      <MemoryRouter>
        <AppsList />
      </MemoryRouter>
    );

    expect(await screen.findByText(/No apps yet/)).toBeInTheDocument();
    await waitForReveal();
    expect(screen.getByRole("button", { name: "Create an app" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New App/ })).toBeInTheDocument();
  });

  it("lists apps with Production first and the Production environment's health", async () => {
    signIn(["apps:view"]);
    api.listApps.mockResolvedValue([shop]);
    render(
      <MemoryRouter>
        <AppsList />
      </MemoryRouter>
    );

    expect(await screen.findByText("Shop")).toBeInTheDocument();
    await waitForReveal();
    expect(screen.getByText("live, staging")).toBeInTheDocument();
    expect(screen.getByText("18.4%")).toBeInTheDocument();
    expect(screen.getByText("failing")).toBeInTheDocument();
    // Without apps:create there is no New App.
    expect(screen.queryByRole("button", { name: /New App/ })).not.toBeInTheDocument();
  });
});
