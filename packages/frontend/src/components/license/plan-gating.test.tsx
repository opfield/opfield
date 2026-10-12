import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { visibleNavigationGroups } from "@/lib/app-navigation";
import { PagesSettingsSection } from "@/pages/pages/PageGlobalSettings";
import { ApiRequestError } from "@/services/api-base";
import { unlicensedNavigationItems, useLicensePaywallStore } from "@/stores/license-paywall";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { UIBootstrapShell } from "@/types/ui-bootstrap";
import { LicenseFeatureBoundary } from "./LicenseFeatureBoundary";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const api = vi.hoisted(() => ({
  getPageProfile: vi.fn(),
  getPageProfileOptions: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/services/api", () => ({ api }));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => undefined }));

import { toastApiError } from "@/lib/api-error-toast";

function setPlan(plan: "community" | "personal", features: string[]) {
  useUIBootstrapStore.setState({
    snapshot: {
      license: {
        status: plan === "community" ? "community" : "active",
        plan,
        licensed: plan !== "community",
        expiresAt: null,
        graceUntil: null,
        offlineGraceUntil: null,
        entitlementsVersion: 5,
        entitlements: {
          managedNodes: null,
          users: null,
          customPermissionGroups: null,
          supportLevel: "community",
          features,
        },
      },
      commercialModule: plan === "community" ? "community" : "ready",
    } as unknown as UIBootstrapShell,
  });
}

const planDenial = (method: string) =>
  new ApiRequestError("A higher license plan is required", {
    status: 403,
    code: "LICENSE_ENTITLEMENT_REQUIRED",
    details: { feature: "pages", requiredPlan: "personal", currentPlan: "community" },
    method,
  });

beforeEach(() => {
  vi.clearAllMocks();
  useLicensePaywallStore.setState({ request: null });
  setPlan("community", []);
});

describe("toastApiError", () => {
  it("stays silent on a plan denial from a load", () => {
    toastApiError(planDenial("GET"), "Failed to load");
    expect(toast.error).not.toHaveBeenCalled();
    expect(useLicensePaywallStore.getState().request).toBeNull();
  });

  it("opens the upgrade dialog, not a toast, on a plan denial from an action", () => {
    toastApiError(planDenial("PUT"), "Failed to save", "Pages");
    expect(toast.error).not.toHaveBeenCalled();
    expect(useLicensePaywallStore.getState().request).toMatchObject({
      capability: "Pages",
      requiredPlan: "personal",
    });
  });

  it("toasts every other failure", () => {
    toastApiError(
      new ApiRequestError("Boom", { status: 500, code: "INTERNAL", method: "GET" }),
      "Failed to load"
    );
    expect(toast.error).toHaveBeenCalledWith("Boom");
  });
});

describe("Settings → Features Pages panel", () => {
  it("shows the locked panel without calling the Pages endpoints on a plan without Pages", async () => {
    render(
      <MemoryRouter>
        <PagesSettingsSection />
      </MemoryRouter>
    );
    expect(
      await screen.findByText("Wildcard deployment previews need the Personal plan or higher.")
    ).toBeInTheDocument();
    expect(api.getPageProfile).not.toHaveBeenCalled();
    expect(api.getPageProfileOptions).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("loads the profile when the plan grants Pages", async () => {
    setPlan("personal", ["pages"]);
    api.getPageProfile.mockResolvedValue({
      enabled: false,
      domainId: null,
      certificateId: null,
      labelTemplate: "{hash}",
    });
    api.getPageProfileOptions.mockResolvedValue({ domains: [], nodes: [], certificates: [] });
    render(
      <MemoryRouter>
        <PagesSettingsSection />
      </MemoryRouter>
    );
    await waitFor(() => expect(api.getPageProfile).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText("Wildcard deployment previews need the Personal plan or higher.")
    ).not.toBeInTheDocument();
  });
});

describe("plan-gated pages", () => {
  it("keep their page header above the plan notice", () => {
    render(
      <MemoryRouter>
        <LicenseFeatureBoundary
          feature="storage-connections"
          capability="Storage connections"
          frame={{ kind: "page", title: "Storage" }}
        >
          <p>loaded</p>
        </LicenseFeatureBoundary>
      </MemoryRouter>
    );
    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
    expect(screen.getByText("Available on the Personal plan and higher.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "License options" })).toBeInTheDocument();
    expect(screen.queryByText("loaded")).not.toBeInTheDocument();
  });

  it("are hidden from navigation when the plan does not grant them", () => {
    const scopes = ["pages:view", "storage:view", "databases:view"];
    const ids = (unlicensedItems: ReturnType<typeof unlicensedNavigationItems>) =>
      visibleNavigationGroups({
        scopes,
        pkiEnabled: false,
        pagesEnabled: true,
        siemEnabled: false,
        loggingEnabled: false,
        inferenceEnabled: false,
        unlicensedItems,
      })
        .flatMap((group) => group.items)
        .map((item) => item.id);

    const community = unlicensedNavigationItems(useUIBootstrapStore.getState().snapshot);
    expect(community).toEqual(["pages", "storage", "databases"]);
    expect(ids(community)).not.toContain("pages");
    expect(ids(community)).not.toContain("storage");
    expect(ids(community)).not.toContain("databases");

    setPlan("personal", ["pages", "storage-connections", "external-database-connections"]);
    const personal = unlicensedNavigationItems(useUIBootstrapStore.getState().snapshot);
    expect(personal).toEqual([]);
    expect(ids(personal)).toEqual(expect.arrayContaining(["pages", "storage", "databases"]));
  });
});
