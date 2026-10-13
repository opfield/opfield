import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppScopeApp, FolderOption } from "@/components/common/scope-list-helpers";
import { AccessPanel } from "./AccessPanel";
import { AddAccessDialog } from "./AddAccessDialog";
import type { AccessCatalog } from "./access-catalog";
import {
  ACCESS_TYPES,
  type AccessContext,
  type AccessLine,
  APP_ACCESS_TYPE_IDS,
  contextLabels,
  lineScopes,
} from "./access-model";

/** Folder `billing` in every tree but Domains. */
const ctx: AccessContext = {
  folders: ACCESS_TYPES.filter((type) => type.family !== "domains").map(
    (type): FolderOption => ({
      id: `${type.family}-billing`,
      label: "billing",
      family: type.family,
      ancestorIds: [],
    })
  ),
};

const catalog: AccessCatalog = {
  ready: true,
  ctx,
  labels: {},
  gitConnectors: {},
  resources: [],
  loadResources: () => undefined,
  rememberGitLabel: () => undefined,
};

const FAMILIES = [
  "containers",
  "compose",
  "routes",
  "databases",
  "storage",
  "pages",
  "certificates",
] as const;
const shop: AppScopeApp = {
  id: "app-shop",
  name: "Shop",
  environments: [
    { id: "env-production", name: "production", memberCounts: { containers: 2 } },
    { id: "env-staging", name: "staging", memberCounts: { containers: 4, compose: 1, routes: 2 } },
  ].map((environment) => ({
    ...environment,
    folderIds: Object.fromEntries(
      FAMILIES.map((family) => [family, `hidden-${environment.id}-${family}`])
    ),
  })),
};
const appCtx: AccessContext = { ...ctx, apps: [shop] };
const appCatalog: AccessCatalog = { ...catalog, ctx: appCtx, labels: contextLabels(appCtx) };

function renderDialog(
  mode: Parameters<typeof AddAccessDialog>[0]["mode"],
  options: { catalog?: AccessCatalog; line?: AccessLine | null } = {}
) {
  const onSave = vi.fn<(line: AccessLine) => void>();
  render(
    <AddAccessDialog
      open
      onOpenChange={() => undefined}
      subject="orders-team"
      line={options.line ?? null}
      catalog={options.catalog ?? catalog}
      mode={mode}
      onSave={onSave}
      onReviewScopes={() => undefined}
    />
  );
  return onSave;
}

async function pickFolder(name: string) {
  await userEvent.click(screen.getByRole("combobox", { name: "Where" }));
  await userEvent.click(await screen.findByRole("option", { name: "In a project folder" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Folder" }));
  await userEvent.click(await screen.findByRole("button", { name }));
}

describe("Add Access", () => {
  it("starts everywhere, with no folder preselected", () => {
    renderDialog({ kind: "grant", actorScopes: [] });
    expect(screen.getByRole("combobox", { name: "Where" })).toHaveTextContent("Everywhere");
    expect(screen.queryByRole("combobox", { name: "Folder" })).toBeNull();
  });

  it("adds a role in a project folder, leaving out types without that folder", async () => {
    const onSave = renderDialog({ kind: "grant", actorScopes: [] });
    await pickFolder("billing");
    expect(screen.getByText("No folder billing for domains: it is left out.")).toBeInTheDocument();
    expect(screen.getByText(/You can't grant this/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add Access" }));
    const line = onSave.mock.calls[0]![0];
    expect(line).toEqual({
      kind: "resources",
      role: "developer",
      types: ACCESS_TYPES.map((type) => type.id).filter((type) => type !== "domains"),
      where: { kind: "folder", path: "billing" },
      mayDelete: false,
    });
    expect(
      screen.getByRole("button", { name: `Review ${lineScopes(line, ctx).length} scopes` })
    ).toBeInTheDocument();
  });

  it("says what a token line wider than its owner really does", async () => {
    renderDialog({
      kind: "token",
      ownerScopes: [
        "docker:containers:view:folder/docker-billing",
        "docker:containers:manage:folder/docker-billing",
      ],
    });
    await pickFolder("billing");
    expect(screen.getByText("Works as Deployer: you are Deployer in billing")).toBeInTheDocument();
    // The count is what the token keeps: the owner's two scopes, not the line as entered.
    expect(screen.getByRole("button", { name: "Review 2 scopes" })).toBeInTheDocument();
  });
});

describe("Add Access in an app environment", () => {
  it("adds a role in one environment of an app, on the seven types an app holds", async () => {
    const onSave = renderDialog({ kind: "grant", actorScopes: [] }, { catalog: appCatalog });
    await userEvent.click(screen.getByRole("combobox", { name: "Where" }));
    await userEvent.click(await screen.findByRole("option", { name: "In an app environment" }));
    await userEvent.click(screen.getByRole("combobox", { name: "App environment" }));
    expect(screen.getByRole("option", { name: "Shop · every environment" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Shop · production" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: "Shop · staging" }));

    expect(
      screen.getByText("The 7 resources of Shop's staging now, and the ones created there later.")
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Covers" })).toHaveValue("All 7 resource types");
    expect(screen.queryByText("Manage subfolders")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Add Access" }));
    const line = onSave.mock.calls[0]![0];
    expect(line).toEqual({
      kind: "resources",
      role: "developer",
      types: [...APP_ACCESS_TYPE_IDS],
      where: { kind: "app", appId: "app-shop", envId: "env-staging" },
      mayDelete: false,
    });
    const scopes = lineScopes(line, appCtx);
    expect(scopes).toContain("apps:env:manage:env/env-staging");
    expect(scopes).toContain("docker:containers:create:folder/hidden-env-staging-containers");
  });

  it("reopens an app line on every environment as it was added", () => {
    renderDialog(
      { kind: "grant", actorScopes: [] },
      {
        catalog: appCatalog,
        line: {
          kind: "resources",
          role: "viewer",
          types: ["containers", "routes"],
          where: { kind: "app", appId: "app-shop", envId: null },
          mayDelete: false,
        },
      }
    );
    expect(screen.getByRole("combobox", { name: "Where" })).toHaveTextContent(
      "In an app environment"
    );
    expect(screen.getByRole("combobox", { name: "App environment" })).toHaveTextContent(
      "Shop · every environment"
    );
    expect(
      screen.getByText(
        "The 8 resources of Shop's environments now, and the ones created there later."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Covers" })).toHaveValue(
      "Containers and deployments, routes"
    );
  });

  it("offers no app environments without apps", async () => {
    renderDialog({ kind: "grant", actorScopes: [] });
    await userEvent.click(screen.getByRole("combobox", { name: "Where" }));
    expect(await screen.findByRole("option", { name: "In an app environment" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });
});

describe("Access list", () => {
  it("edits own lines and only shows lines from a group", async () => {
    const onEdit = vi.fn();
    render(
      <AccessPanel
        description="Lines from a group change in that group."
        onAdd={() => undefined}
        onEdit={onEdit}
        onRemove={() => undefined}
        views={[
          {
            key: "own",
            index: 0,
            line: { kind: "custom", scopes: ["admin:audit"] },
            title: "Operator in folder orders / staging",
            detail: "Containers and deployments, databases",
          },
          {
            key: "group",
            line: { kind: "custom", scopes: ["admin:audit"] },
            title: "Viewer everywhere",
            detail: "All 8 resource types",
            from: "orders-team",
          },
        ]}
      />
    );
    expect(screen.getByText("All 8 resource types")).toBeInTheDocument();
    expect(screen.getByText("· from orders-team")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Viewer everywhere" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit Operator in folder orders / staging" })
    );
    expect(onEdit).toHaveBeenCalledWith(0);
  });
});
