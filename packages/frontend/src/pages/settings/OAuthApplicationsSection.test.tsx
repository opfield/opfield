import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessCatalog } from "@/components/access/access-catalog";
import type { OAuthAuthorization, User } from "@/types";
import { OAuthApplicationsSection } from "./OAuthApplicationsSection";

const api = vi.hoisted(() => ({
  getCached: vi.fn(() => undefined),
  setCache: vi.fn(),
  listOAuthAuthorizations: vi.fn(),
  updateOAuthAuthorization: vi.fn(),
  revokeOAuthAuthorization: vi.fn(),
}));
const catalog = vi.hoisted(
  (): AccessCatalog => ({
    ready: true,
    ctx: { folders: [] },
    labels: {},
    gitConnectors: {},
    resources: [],
    loadResources: () => undefined,
    rememberGitLabel: () => undefined,
  })
);
const account = vi.hoisted(() => ({
  user: {
    id: "user-1",
    scopes: ["admin:audit", "docker:containers:view", "docker:containers:manage", "nodes:details"],
  } as User,
}));

vi.mock("@/services/api", () => ({ api }));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => undefined }));
vi.mock("@/stores/ca", () => ({ useCAStore: () => ({ cas: [] }) }));
vi.mock("@/stores/auth", () => ({ useAuthStore: () => account }));
vi.mock("@/components/access/access-catalog", () => ({ useAccessCatalog: () => catalog }));

// Radix Select scrolls the picked item into view, which jsdom does not implement.
Element.prototype.scrollIntoView = () => undefined;

// A grant holding a line (containers viewer) and scopes no line covers (audit log, node details).
const grant: OAuthAuthorization = {
  id: "grant-1",
  clientId: "opf_client_1",
  clientName: "Claude",
  clientUri: null,
  logoUri: null,
  scopes: ["admin:audit", "docker:containers:view", "nodes:details"],
  resource: "https://opfield.test/api/mcp",
  resources: [],
  activeAccessTokens: 1,
  activeRefreshTokens: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  grantExpiresAt: null,
  allowedIps: [],
};

function renderSection() {
  render(
    <OAuthApplicationsSection
      nodesList={[]}
      proxyHostsList={[]}
      databasesList={[]}
      loggingSchemasList={[]}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listOAuthAuthorizations.mockResolvedValue([grant]);
  api.updateOAuthAuthorization.mockImplementation(async (_id, changes) => ({
    ...grant,
    ...(changes.scopes ? { scopes: changes.scopes } : {}),
  }));
});

describe("OAuth application access", () => {
  it("shows the grant as access lines and reopens it unchanged", async () => {
    renderSection();
    await userEvent.click(await screen.findByText("Claude"));

    expect(await screen.findByText("Custom scopes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Access" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review 3 scopes" })).toBeInTheDocument();
    // Nothing changed yet: the scopes read back from the lines are the grant's own.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("saves the remaining lines and keeps the scopes no line covers", async () => {
    renderSection();
    await userEvent.click(await screen.findByText("Claude"));
    await screen.findByText("Custom scopes");

    const removeButtons = screen.getAllByRole("button", { name: /^Remove / });
    const removeLine = removeButtons.find(
      (button) => button.getAttribute("aria-label") !== "Remove Custom scopes"
    );
    expect(removeLine).toBeDefined();
    await userEvent.click(removeLine!);
    expect(screen.getByRole("button", { name: "Review 2 scopes" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateOAuthAuthorization).toHaveBeenCalledTimes(1));
    // Only the scopes: the expiry and addresses are not touched.
    expect(api.updateOAuthAuthorization).toHaveBeenCalledWith("grant-1", {
      scopes: ["admin:audit", "nodes:details"],
    });
  });
});
