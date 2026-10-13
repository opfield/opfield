import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { finishDialogAnimations, stubDialogAnimations } from "@/test/dialog-animation";
import type {
  InferenceOAuthSession,
  InferenceProviderCatalogItem,
  InferenceProviderConnection,
} from "@/types/inference";
import { InferenceSettingsSection } from "../InferenceSettingsSection";
import { InferenceProvidersPanel } from "./InferenceProvidersPanel";

const api = vi.hoisted(() => ({
  getCached: vi.fn(() => undefined),
  setCache: vi.fn(),
  listInferenceProviderCatalog: vi.fn(),
  listInferenceProviderConnections: vi.fn(),
  startInferenceOAuth: vi.fn(),
  getInferenceOAuthStatus: vi.fn(),
  cancelInferenceOAuth: vi.fn(),
}));

const core = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let state: string = "ready";
  return {
    get state() {
      return state;
    },
    set(next: string) {
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("@/services/api", () => ({ api }));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => undefined }));
vi.mock("@/hooks/use-inference-core-status", () => ({
  useInferenceCoreStatus: () => {
    const state = useSyncExternalStore(core.subscribe, () => core.state);
    return {
      status: { state, compatibility: "compatible", operation: null },
      loading: false,
      error: null,
      refresh: async () => undefined,
    };
  },
}));
vi.mock("./InferenceCoreLifecyclePanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./InferenceCoreLifecyclePanel")>()),
  InferenceCoreLifecyclePanel: () => null,
}));
vi.mock("./InferenceEndpointSettingsPanel", () => ({ InferenceEndpointSettingsPanel: () => null }));
vi.mock("./InferenceModelsPanel", () => ({ InferenceModelsPanel: () => null }));
vi.mock("../../inference/InferenceUsagePanels", () => ({ InferenceOverview: () => null }));
vi.mock("../../inference/InferenceAdminTables", () => ({ InferenceUsersTable: () => null }));
vi.mock("../../inference/InferenceActivityPanel", () => ({ InferenceActivityPanel: () => null }));
vi.mock("@/components/common/ConfirmDialog", () => ({
  confirmAction: async (_options: unknown, action: () => Promise<unknown>) => {
    await action();
    return true;
  },
}));

Element.prototype.scrollIntoView = () => undefined;

const chatgpt: InferenceProviderCatalogItem = {
  id: "openai-codex",
  label: "ChatGPT subscription",
  family: "openai",
  wireProtocol: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authTypes: ["oauth"],
  subscription: true,
  featured: true,
  termsVersion: "1",
  oauthFlow: "device",
  completionMode: "device_poll",
};

const pending: InferenceOAuthSession = {
  id: "oauth-1",
  providerId: chatgpt.id,
  status: "pending",
  authorizationUrl: "https://auth.openai.com/codex/device",
  completionMode: "device_poll",
  userCode: "ABCD-EFGH",
  pollIntervalSeconds: 1,
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
};

describe("Connect Inference Provider", () => {
  let restoreAnimations: () => void;

  beforeEach(() => {
    restoreAnimations = stubDialogAnimations();
    useAuthStore.setState({ hasScope: () => true } as never);
    api.listInferenceProviderCatalog.mockResolvedValue([chatgpt]);
    api.listInferenceProviderConnections.mockResolvedValue([]);
    api.startInferenceOAuth.mockResolvedValue(pending);
    api.cancelInferenceOAuth.mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreAnimations();
    vi.clearAllMocks();
  });

  async function connectAndComplete(onListedAgain?: () => void) {
    await userEvent.click(await screen.findByRole("button", { name: "Connect provider" }));
    await userEvent.type(await screen.findByPlaceholderText("Team account"), "Team");
    await userEvent.click(screen.getByRole("button", { name: "Start authorization" }));
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();

    const connection: InferenceProviderConnection = {
      id: "connection-1",
      providerId: chatgpt.id,
      name: "Team",
      authType: "oauth",
      baseUrl: chatgpt.baseUrl,
      accountLabel: "team@example.com",
      enabled: true,
      routingOrder: 0,
      minimumRemainingPercent: 0,
      apiMonthlyLimitMicrodollars: null,
      apiMonthlySpentMicrodollars: 0,
      routingStrategy: "sequential",
      status: "healthy",
      healthReason: null,
      syncStatus: "success",
      syncLastError: null,
      lastSyncedAt: null,
      quota: [],
      discoveredModels: [],
    };
    api.listInferenceProviderConnections.mockImplementation(async () => {
      onListedAgain?.();
      return [connection];
    });
    api.getInferenceOAuthStatus.mockResolvedValue({
      ...pending,
      status: "complete",
      connectionId: connection.id,
    });

    // The dialog closes with its exit animation: still in the document, closed, with its content.
    await waitFor(
      () =>
        expect(screen.getByRole("dialog", { hidden: true })).toHaveAttribute(
          "data-state",
          "closed"
        ),
      { timeout: 3_000 }
    );
    await waitFor(() => expect(api.listInferenceProviderConnections).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("dialog", { hidden: true })).toHaveAttribute("data-state", "closed");
    expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument();

    finishDialogAnimations();
    await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
  }

  it("plays its close animation once a device authorization completes", async () => {
    render(<InferenceProvidersPanel />);
    await connectAndComplete();
  });

  it("keeps closing with its animation when the core turns not ready meanwhile", async () => {
    core.set("ready");
    render(<InferenceSettingsSection />);
    await connectAndComplete(() => act(() => core.set("degraded")));
    // The panel comes back with the core, without a remount losing its rows.
    act(() => core.set("ready"));
    expect(await screen.findByText("Team")).toBeVisible();
  });
});
