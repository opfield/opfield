import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessCatalog } from "@/components/access/access-catalog";
import type { ApiToken, User } from "@/types";
import { ApiTokensSection } from "./ApiTokensSection";

const state = vi.hoisted(() => ({ externalAccess: true, licensed: true }));
const api = vi.hoisted(() => ({
  getCached: vi.fn(() => undefined),
  setCache: vi.fn(),
  listTokens: vi.fn(),
  createToken: vi.fn(),
  updateToken: vi.fn(),
  revokeToken: vi.fn(),
  getTokenRegistryAccess: vi.fn(),
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

vi.mock("@/services/api", () => ({ api }));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => undefined }));
vi.mock("@/stores/ca", () => ({ useCAStore: () => ({ cas: [] }) }));
vi.mock("@/components/access/access-catalog", () => ({ useAccessCatalog: () => catalog }));
vi.mock("@/stores/license-paywall", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/license-paywall")>()),
  hasLicenseFeature: (feature: string) => feature === "git-push-to-deploy" && state.licensed,
}));

// Radix Select scrolls the picked item into view, which jsdom does not implement.
Element.prototype.scrollIntoView = () => undefined;

const user = {
  id: "user-1",
  scopes: ["docker:containers:view", "docker:containers:manage"],
} as User;
const pullToken: ApiToken = {
  id: "token-1",
  name: "ci",
  tokenPrefix: "opf_123456",
  scopes: ["docker:containers:view"],
  registryAccess: { pull: "all" },
  lastUsedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

function renderSection() {
  render(
    <ApiTokensSection
      user={user}
      nodesList={[]}
      proxyHostsList={[]}
      databasesList={[]}
      loggingSchemasList={[]}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.externalAccess = true;
  state.licensed = true;
  api.listTokens.mockResolvedValue([pullToken]);
  api.createToken.mockResolvedValue({ ...pullToken, id: "token-2", token: "opf_secret" });
  api.updateToken.mockResolvedValue(undefined);
  api.getTokenRegistryAccess.mockImplementation(async () => ({
    externalAccessEnabled: state.externalAccess,
  }));
});

describe("token internal registry access", () => {
  it("offers it as a Select while external registry access is on, and saves it", async () => {
    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Create Token" }));
    const level = await screen.findByRole("combobox", { name: "Internal registry access" });
    expect(screen.getByText(/What docker login with this token may do/)).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();

    await userEvent.type(screen.getByPlaceholderText("e.g., CI/CD Pipeline"), "pusher");
    await userEvent.click(level);
    await userEvent.click(await screen.findByRole("option", { name: "Pull and push" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Create Token" }).at(-1)!);

    await waitFor(() => expect(api.createToken).toHaveBeenCalledTimes(1));
    expect(api.createToken).toHaveBeenCalledWith({
      name: "pusher",
      scopes: [],
      exactScopes: true,
      registryAccess: { pull: "all", push: "all" },
      // A new token expires in a month and works from any address unless the dialog says otherwise.
      expiresAt: expect.any(String),
      allowedIps: [],
    });
  }, 15_000);

  it("lists repositories instead of offering all of them to a user with folder grants only", async () => {
    const folder = "folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e";
    render(
      <ApiTokensSection
        user={
          {
            id: "user-1",
            scopes: [`docker:containers:view:${folder}`, `docker:containers:edit:${folder}`],
          } as User
        }
        nodesList={[]}
        proxyHostsList={[]}
        databasesList={[]}
        loggingSchemasList={[]}
      />
    );
    await userEvent.click(await screen.findByRole("button", { name: "Create Token" }));
    await userEvent.type(screen.getByPlaceholderText("e.g., CI/CD Pipeline"), "ci-push");
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Internal registry access" })
    );
    await userEvent.click(await screen.findByRole("option", { name: "Pull and push" }));

    await userEvent.click(screen.getByRole("combobox", { name: "Pull repositories" }));
    expect(
      await screen.findByRole("option", { name: "Selected repositories" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "All repositories" })).toBeNull();
    await userEvent.keyboard("{Escape}");
    const [pull, push] = screen.getAllByRole("textbox", { name: "Repository 1" });
    await userEvent.type(pull!, "team/app");
    await userEvent.type(push!, "team/app");
    await userEvent.click(screen.getAllByRole("button", { name: "Create Token" }).at(-1)!);

    await waitFor(() => expect(api.createToken).toHaveBeenCalledTimes(1));
    expect(api.createToken).toHaveBeenCalledWith(
      expect.objectContaining({ registryAccess: { pull: ["team/app"], push: ["team/app"] } })
    );
    // Typing a token name and two repositories takes a few seconds on a busy CI runner.
  }, 15_000);

  it.each([
    ["external registry access is off", { externalAccess: false, licensed: true }],
    ["the license does not include it", { externalAccess: true, licensed: false }],
  ])("hides it while %s and keeps a token's access on save", async (_, flags) => {
    Object.assign(state, flags);
    renderSection();
    await userEvent.click(await screen.findByText("ci"));
    const name = await screen.findByDisplayValue("ci");
    await waitFor(() => expect(api.getTokenRegistryAccess).toHaveBeenCalled());
    expect(screen.queryByRole("combobox", { name: "Internal registry access" })).toBeNull();
    expect(screen.queryByText("Internal registry")).toBeNull();

    await userEvent.clear(name);
    await userEvent.type(name, "ci-renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateToken).toHaveBeenCalledTimes(1));
    // Only the name: the stored registry access is neither cleared nor rewritten.
    expect(api.updateToken).toHaveBeenCalledWith("token-1", { name: "ci-renamed" });
  });
});

describe("token scopes", () => {
  it("asks Opfield to store exactly the counted scopes, so a Git Use line reopens as Use", async () => {
    const connector = "0b8f2a8e-6f1c-4a57-9a51-3f9d7f1b2c01";
    const use = [
      `integrations:github:use:${connector}/repo/7`,
      `integrations:github:view:${connector}/repo/7`,
    ];
    const owner = {
      id: "user-1",
      scopes: [
        "integrations:github:view",
        "integrations:github:use",
        "integrations:github:repo:read",
      ],
    } as User;
    api.listTokens.mockResolvedValue([{ ...pullToken, scopes: use, registryAccess: {} }]);
    render(
      <ApiTokensSection
        user={owner}
        nodesList={[]}
        proxyHostsList={[]}
        databasesList={[]}
        loggingSchemasList={[]}
      />
    );
    await userEvent.click(await screen.findByText("ci"));
    expect(await screen.findByText("Use repository 7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review 2 scopes" })).toBeInTheDocument();
  });
});
