import { describe, expect, it } from "vitest";
import {
  type AppScopeApp,
  type FolderOption,
  folderFamilyForScope,
} from "@/components/common/scope-list-helpers";
import {
  API_TOKEN_SCOPES,
  FOLDER_SCOPABLE_SCOPES,
  GROUP_ASSIGNABLE_SCOPES,
  RESOURCE_SCOPABLE_SCOPES,
  TOKEN_SCOPES,
} from "@/types";
import { FOLDER_CREATION_SCOPES, GIT_TARGET_SCOPES } from "@/types/scope-resource-restrictions";
import {
  extractBaseScope as backendBaseScope,
  canonicalizeInboundScopes,
  canonicalizeScopes,
  MANUAL_APPROVAL_SCOPE_SET,
  scopeCleanupAdditions,
} from "../../../../backend/src/lib/scopes";
import {
  BUILTIN_GROUPS,
  OPERATOR_SCOPES,
  VIEWER_SCOPES,
} from "../../../../backend/src/lib/scopes-builtins";
import {
  ACCESS_ROLES,
  ACCESS_TYPES,
  type AccessContext,
  type AccessLine,
  APP_ACCESS_TYPE_IDS,
  APP_ROLE_SCOPES,
  accessTypeScopes,
  appMemberCount,
  boundAccessScopes,
  contextLabels,
  describeLine,
  GIT_LEVELS,
  type GitAccessLine,
  gitLevelScopes,
  lineScopes,
  linesAddingNothing,
  linesToScopes,
  narrowedNote,
  newFoldersNote,
  principalHolds,
  type ResourceAccessLine,
  scopesToLines,
  tokenStoredScopes,
} from "./access-model";

const CONNECTOR = "0b8f2a8e-6f1c-4a57-9a51-3f9d7f1b2c01";
const OTHER_CONNECTOR = "0b8f2a8e-6f1c-4a57-9a51-3f9d7f1b2c02";

/** Folder `billing` exists in every tree but Domains; `orders/staging` only for containers. */
function folders(): FolderOption[] {
  const families = ACCESS_TYPES.map((type) => type.family).filter((family) => family !== "domains");
  return [
    ...families.map((family) => ({
      id: `${family}-orders`,
      label: "orders",
      family,
      ancestorIds: [],
    })),
    ...families.map((family) => ({
      id: `${family}-billing`,
      label: "billing",
      family,
      ancestorIds: [],
    })),
    {
      id: "docker-orders-staging",
      label: "orders/staging",
      family: "docker",
      ancestorIds: ["docker-orders"],
    },
    { id: "domains-orders", label: "orders", family: "domains", ancestorIds: [] },
  ];
}

const ctx: AccessContext = { folders: folders() };
const ALL_TYPES = ACCESS_TYPES.map((type) => type.id);
const sorted = (scopes: readonly string[]) => [...new Set(scopes)].sort();

describe("access roles and types", () => {
  const catalog = new Set<string>(TOKEN_SCOPES.map((scope) => scope.value));
  const groupAssignable = new Set<string>(GROUP_ASSIGNABLE_SCOPES.map((scope) => scope.value));
  const tokenAssignable = new Set<string>(API_TOKEN_SCOPES.map((scope) => scope.value));
  const folderScopable = new Set<string>(FOLDER_SCOPABLE_SCOPES);
  const resourceScopable = new Set<string>(RESOURCE_SCOPABLE_SCOPES);
  const creation = new Set<string>(FOLDER_CREATION_SCOPES);

  it("names only catalog scopes that groups and tokens can be given, in the type's folder tree", () => {
    for (const type of ACCESS_TYPES) {
      for (const scope of accessTypeScopes(type)) {
        expect(catalog.has(scope), scope).toBe(true);
        expect(groupAssignable.has(scope), scope).toBe(true);
        expect(tokenAssignable.has(scope), scope).toBe(true);
        expect(folderScopable.has(scope), scope).toBe(true);
        expect(folderFamilyForScope(scope), scope).toBe(type.family);
        if (!creation.has(scope)) expect(resourceScopable.has(scope), scope).toBe(true);
      }
    }
    for (const provider of ["gitlab", "github", "git"] as const) {
      for (const scope of gitLevelScopes(provider, "write")) {
        expect((GIT_TARGET_SCOPES as readonly string[]).includes(scope), scope).toBe(true);
        expect(groupAssignable.has(scope) && tokenAssignable.has(scope), scope).toBe(true);
      }
    }
  });

  it("gives each scope to one type", () => {
    const owners = new Map<string, string>();
    for (const type of ACCESS_TYPES) {
      for (const scope of accessTypeScopes(type)) {
        expect(owners.get(scope) ?? type.id, scope).toBe(type.id);
        owners.set(scope, type.id);
      }
    }
  });

  it("matches the built-in viewer and operator groups type by type", () => {
    for (const type of ACCESS_TYPES) {
      const own = accessTypeScopes(type).filter((scope) => !type.delete.includes(scope));
      expect(sorted(type.roles.viewer), type.id).toEqual(
        sorted(own.filter((s) => VIEWER_SCOPES.includes(s)))
      );
      expect(sorted(type.roles.operator), type.id).toEqual(
        sorted(own.filter((s) => OPERATOR_SCOPES.includes(s)))
      );
    }
  });

  it("orders Git levels from Use to Edit code and CI", () => {
    expect(GIT_LEVELS.map((level) => level.value)).toEqual(["use", "read", "write"]);
    expect(gitLevelScopes("gitlab", "read")).toEqual([
      "integrations:gitlab:view",
      "integrations:gitlab:use",
      "integrations:gitlab:repo:read",
    ]);
  });
});

describe("lines and scopes", () => {
  const canonical: AccessLine[] = [
    {
      kind: "resources",
      role: "viewer",
      types: ALL_TYPES,
      where: { kind: "everywhere" },
      mayDelete: false,
    },
    {
      kind: "resources",
      role: "developer",
      types: ALL_TYPES.filter((type) => type !== "domains"),
      where: { kind: "folder", path: "billing" },
      mayDelete: true,
    },
    {
      kind: "resources",
      role: "operator",
      types: ["containers"],
      where: { kind: "folder", path: "orders/staging" },
      mayDelete: false,
    },
    {
      kind: "resources",
      role: "deployer",
      types: ["containers", "pages"],
      where: {
        kind: "resources",
        ids: { containers: ["node-1/api", "node-1/web"], pages: ["site-1"] },
      },
      mayDelete: false,
    },
    {
      kind: "git",
      provider: "gitlab",
      connectorId: CONNECTOR,
      repositories: { kind: "group", id: "42" },
      level: "write",
    },
    {
      kind: "git",
      provider: "github",
      connectorId: OTHER_CONNECTOR,
      repositories: { kind: "some", ids: ["7", "9"] },
      level: "use",
    },
    {
      kind: "git",
      provider: "git",
      connectorId: null,
      repositories: { kind: "all" },
      level: "read",
    },
    { kind: "custom", scopes: ["admin:audit", "nodes:details"] },
  ];

  it("builds plain and qualified scopes", () => {
    const scopes = linesToScopes(canonical, ctx);
    expect(scopes).toContain("docker:containers:view");
    expect(scopes).toContain("docker:containers:create:folder/docker-billing");
    expect(scopes).toContain("docker:containers:delete:folder/docker-billing");
    expect(scopes).toContain("docker:containers:secrets:folder/docker-orders-staging");
    expect(scopes).toContain("docker:containers:manage:node-1/api");
    expect(scopes).toContain("pages:deploy:site-1");
    expect(scopes).toContain(`integrations:gitlab:repo:write:${CONNECTOR}/group/42`);
    expect(scopes).toContain(`integrations:github:use:${OTHER_CONNECTOR}/repo/9`);
    expect(scopes).toContain("integrations:git:repo:read");
    // Creation names a destination, never a resource.
    expect(scopes.some((scope) => scope.startsWith("docker:containers:create:node-1/"))).toBe(
      false
    );
  });

  it("parses its own scopes back into the same lines", () => {
    expect(scopesToLines(linesToScopes(canonical, ctx), ctx)).toEqual(canonical);
  });

  it("parses every built-in group without losing a scope", () => {
    for (const group of BUILTIN_GROUPS) {
      const lines = scopesToLines(group.scopes, ctx);
      expect(linesToScopes(lines, ctx), group.name).toEqual(sorted(group.scopes));
    }
    const operator = scopesToLines(OPERATOR_SCOPES, ctx);
    expect(describeLine(operator[0]!).title).toBe("Operator everywhere");
    expect(describeLine(scopesToLines(VIEWER_SCOPES, ctx)[0]!)).toEqual({
      title: "Viewer everywhere",
      detail: "All 8 resource types",
    });
  });

  it("parses arbitrary scope sets without loss, the same way every time", () => {
    const pool = [
      ...TOKEN_SCOPES.map((scope) => scope.value),
      ...ACCESS_TYPES.flatMap((type) =>
        accessTypeScopes(type).flatMap((scope) => [
          `${scope}:folder/${type.family}-orders`,
          `${scope}:folder/${type.family}-missing`,
          `${scope}:node-1/api`,
        ])
      ),
      `integrations:gitlab:use:${CONNECTOR}`,
      `integrations:gitlab:view:${CONNECTOR}`,
      `integrations:gitlab:view:${CONNECTOR}/project/5`,
      `integrations:gitlab:use:${CONNECTOR}/project/5`,
    ];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 200; round += 1) {
      const scopes = pool.filter(() => random() < 0.3);
      const lines = scopesToLines(scopes, ctx);
      // The scopes as Opfield stores them: a broad scope drops its qualified forms.
      expect(linesToScopes(lines, ctx)).toEqual(canonicalizeScopes(scopes));
      expect(scopesToLines([...scopes].reverse(), ctx)).toEqual(lines);
    }
  });

  it("leaves out types without the folder and reads them as such", () => {
    const line: AccessLine = {
      kind: "resources",
      role: "viewer",
      types: ALL_TYPES,
      where: { kind: "folder", path: "billing" },
      mayDelete: false,
    };
    expect(lineScopes(line, ctx).some((scope) => scope.startsWith("domains:"))).toBe(false);
    expect(describeLine(scopesToLines(lineScopes(line, ctx), ctx)[0]!)).toEqual({
      title: "Viewer in folder billing",
      detail:
        "Containers and deployments, Compose projects, routes, SSL certificates, databases, object storage, Pages",
    });
  });

  it("names roles, places and Git targets", () => {
    const labels = {
      resource: (_type: string, id: string) => (id === "node-1/api" ? "orders-api" : undefined),
      connector: () => "gitlab.example.com",
      gitTarget: () => "example-labs/orders",
    };
    expect(describeLine(canonical[2]!, labels)).toEqual({
      title: "Operator in folder orders / staging",
      detail: "Containers and deployments",
    });
    expect(describeLine(canonical[3]!, labels).title).toBe("Deployer on 3 resources");
    expect(describeLine(canonical[4]!, labels)).toEqual({
      title: "Edit code and CI in group example-labs/orders",
      detail: "GitLab · gitlab.example.com",
    });
    expect(describeLine(canonical[6]!).title).toBe("Read code in every repository");
    expect(describeLine(canonical[6]!).detail).toBe("Every Git connector");
  });

  it("offers the four roles", () => {
    expect(ACCESS_ROLES.map((role) => role.title)).toEqual([
      "Viewer",
      "Deployer",
      "Developer",
      "Operator",
    ]);
  });
});

describe("overlapping lines after a save", () => {
  const viewerEverywhere: ResourceAccessLine = {
    kind: "resources",
    role: "viewer",
    types: ALL_TYPES,
    where: { kind: "everywhere" },
    mayDelete: false,
  };
  const deployerInBilling: ResourceAccessLine = {
    kind: "resources",
    role: "deployer",
    types: ALL_TYPES.filter((type) => type !== "domains"),
    where: { kind: "folder", path: "billing" },
    mayDelete: false,
  };
  const overlapping: AccessLine[] = [
    viewerEverywhere,
    deployerInBilling,
    {
      kind: "resources",
      role: "developer",
      types: ALL_TYPES,
      where: { kind: "folder", path: "orders" },
      mayDelete: false,
    },
    {
      kind: "resources",
      role: "operator",
      types: ["containers", "routes"],
      where: { kind: "resources", ids: { containers: ["node-1/web"], routes: ["route-1"] } },
      mayDelete: false,
    },
    {
      kind: "git",
      provider: "github",
      connectorId: CONNECTOR,
      repositories: { kind: "some", ids: ["1345854252"] },
      level: "write",
    },
  ];
  const entered = sorted(overlapping.flatMap((line) => lineScopes(line, ctx)));

  it.each([
    ["groups", canonicalizeScopes],
    ["user additional permissions", canonicalizeInboundScopes],
  ] as const)("keeps the lines of %s as the backend stores them", (_, store) => {
    const stored = store(entered);
    // The qualified view scopes go: "Viewer everywhere" covers them.
    expect(stored.length).toBeLessThan(entered.length);
    expect(stored).not.toContain("docker:containers:view:folder/docker-orders");
    expect(stored).not.toContain("docker:containers:view:node-1/web");
    expect(stored).not.toContain("proxy:view:route-1");
    // The Review count is what is stored, and the stored scopes read back as the same lines.
    expect(linesToScopes(overlapping, ctx)).toEqual(stored);
    expect(scopesToLines(stored, ctx)).toEqual(overlapping);
  });

  it("reads a line on some types as it was added", () => {
    const lines: AccessLine[] = [
      viewerEverywhere,
      { ...deployerInBilling, types: ["containers"] },
      {
        kind: "resources",
        role: "developer",
        types: ["routes", "databases"],
        where: { kind: "folder", path: "orders" },
        mayDelete: true,
      },
    ];
    const stored = canonicalizeScopes(lines.flatMap((line) => lineScopes(line, ctx)));
    expect(scopesToLines(stored, ctx)).toEqual(lines);
  });

  it("adds Manage subfolders to a folder line and reads it back", () => {
    const line: AccessLine = {
      kind: "resources",
      role: "developer",
      types: ["routes", "ssl"],
      where: { kind: "folder", path: "orders" },
      mayDelete: false,
      manageFolders: true,
    };
    const scopes = lineScopes(line, ctx);
    // Every resource type offers it, Docker lists through the shared Docker folder scope.
    expect(ACCESS_TYPES.every((type) => !!type.foldersManage)).toBe(true);
    expect(scopes).toContain("proxy:folders:manage:folder/proxy-orders");
    expect(scopes).toContain("ssl:cert:folders:manage:folder/ssl-orders");
    expect(scopesToLines(scopes, ctx)).toEqual([line]);
    expect(describeLine(line).detail).toContain("manages subfolders");
    // Only folder lines manage folders: everywhere keeps folder management out of the line.
    const everywhere = lineScopes({ ...line, where: { kind: "everywhere" } }, ctx);
    expect(everywhere.some((scope) => scope.includes(":folders:manage"))).toBe(false);
  });

  it("never reads a line out of broad scopes alone", () => {
    expect(scopesToLines(["docker:containers:view", "proxy:view"], ctx)).toEqual([
      { ...viewerEverywhere, types: ["containers", "routes"] },
    ]);
    // A qualified scope the broad one covers adds nothing: it is not stored, so it is no line.
    expect(
      scopesToLines(["docker:containers:view", "docker:containers:view:folder/docker-billing"], ctx)
    ).toEqual([{ ...viewerEverywhere, types: ["containers"] }]);
  });

  it("marks a line the other lines already cover", () => {
    const covered: AccessLine = {
      kind: "resources",
      role: "viewer",
      types: ["containers"],
      where: { kind: "folder", path: "billing" },
      mayDelete: false,
    };
    expect(linesAddingNothing([viewerEverywhere, covered], ctx)).toEqual([false, true]);
    expect(linesAddingNothing(overlapping, ctx)).toEqual(overlapping.map(() => false));
    expect(linesAddingNothing([covered], ctx)).toEqual([false]);
    expect(scopesToLines(linesToScopes([viewerEverywhere, covered], ctx), ctx)).toEqual([
      viewerEverywhere,
    ]);
  });
});

describe("token narrowing", () => {
  const developerInBilling: AccessLine = {
    kind: "resources",
    role: "developer",
    types: ["containers"],
    where: { kind: "folder", path: "billing" },
    mayDelete: false,
  };
  const deployerInBilling = lineScopes({ ...developerInBilling, role: "deployer" }, ctx);

  it("says what a line wider than its owner really does", () => {
    expect(narrowedNote(developerInBilling, deployerInBilling, ctx)).toBe(
      "Works as Deployer: you are Deployer in billing"
    );
    expect(
      narrowedNote(developerInBilling, linesToScopes([developerInBilling], ctx), ctx)
    ).toBeNull();
    expect(narrowedNote(developerInBilling, [], ctx)).toBe(
      "Does nothing: you hold none of this access"
    );
  });

  it("counts a folder grant for its subfolders and narrows broad scopes to held resources", () => {
    const staging: AccessLine = {
      ...developerInBilling,
      role: "viewer",
      where: { kind: "folder", path: "orders/staging" },
    };
    expect(narrowedNote(staging, ["docker:containers:view:folder/docker-orders"], ctx)).toBeNull();
    expect(boundAccessScopes(["proxy:view"], ["proxy:edit:route-1"])).toEqual([
      "proxy:view:route-1",
    ]);
  });

  /** The owner of stand check P4: Viewer everywhere, Developer in a folder, Operator on one container. */
  const owner = linesToScopes(
    [
      {
        kind: "resources",
        role: "viewer",
        types: ALL_TYPES,
        where: { kind: "everywhere" },
        mayDelete: false,
      },
      { ...developerInBilling },
      {
        kind: "resources",
        role: "operator",
        types: ["containers"],
        where: { kind: "resources", ids: { containers: ["node-1/web"] } },
        mayDelete: false,
      },
    ],
    ctx
  );
  const operatorEverywhere: ResourceAccessLine = {
    kind: "resources",
    role: "operator",
    types: ["containers"],
    where: { kind: "everywhere" },
    mayDelete: false,
  };

  /**
   * Backend token create: canonicalizeInboundScopes, withDelegableCleanupAdditions unless the client
   * sends `exactScopes` (the token dialog does), canonicalizeScopes.
   */
  function backendStoredTokenScopes(
    sent: readonly string[],
    ownerScopes: readonly string[],
    { exact }: { exact: boolean }
  ) {
    const canonical = canonicalizeInboundScopes(sent);
    const additions = exact
      ? []
      : canonical
          .flatMap(scopeCleanupAdditions)
          .filter(
            (scope) =>
              !MANUAL_APPROVAL_SCOPE_SET.has(backendBaseScope(scope)) &&
              principalHolds(ownerScopes, scope, ctx)
          );
    return canonicalizeScopes([...canonical, ...additions]);
  }

  it("counts the owner's part a token keeps of a wider line", () => {
    const entered = lineScopes(operatorEverywhere, ctx);
    expect(entered).toHaveLength(9);
    const kept = tokenStoredScopes(linesToScopes([operatorEverywhere], ctx), owner, ctx);
    // docker:containers:view, the Developer set in billing and the Operator set on node-1/web.
    expect(kept).toHaveLength(13);
    expect(backendStoredTokenScopes(kept, owner, { exact: true })).toEqual(kept);
    expect(scopesToLines(kept, ctx)).toEqual([
      { ...operatorEverywhere, role: "viewer" },
      developerInBilling,
      {
        kind: "resources",
        role: "operator",
        types: ["containers"],
        where: { kind: "resources", ids: { containers: ["node-1/web"] } },
        mayDelete: false,
      },
    ]);
  });

  it("keeps overlapping token lines as the backend stores them", () => {
    const lines: AccessLine[] = [{ ...operatorEverywhere, role: "viewer" }, developerInBilling];
    const kept = tokenStoredScopes(linesToScopes(lines, ctx), owner, ctx);
    expect(kept).not.toContain("docker:containers:view:folder/docker-billing");
    expect(backendStoredTokenScopes(kept, owner, { exact: true })).toEqual(kept);
    expect(scopesToLines(kept, ctx)).toEqual(lines);
  });

  it("keeps a Git Use line as Use on a new token", () => {
    const use: GitAccessLine = {
      kind: "git",
      provider: "github",
      connectorId: CONNECTOR,
      repositories: { kind: "some", ids: ["7"] },
      level: "use",
    };
    const githubOwner = [
      "integrations:github:view",
      "integrations:github:use",
      "integrations:github:repo:read",
    ];
    const kept = tokenStoredScopes(linesToScopes([use], ctx), githubOwner, ctx);
    expect(kept).toEqual(lineScopes(use, ctx).sort());
    expect(backendStoredTokenScopes(kept, githubOwner, { exact: true })).toEqual(kept);
    expect(scopesToLines(kept, ctx)).toEqual([use]);
    // Without exactScopes Opfield adds repository reads, and the line would reopen as Read code.
    expect(
      scopesToLines(backendStoredTokenScopes(kept, githubOwner, { exact: false }), ctx)
    ).toEqual([{ ...use, level: "read" }]);
  });
});

describe("app environment lines", () => {
  const FAMILIES = [
    "containers",
    "compose",
    "routes",
    "databases",
    "storage",
    "pages",
    "certificates",
    "domains",
  ] as const;
  const environment = (
    id: string,
    name: string,
    counts: AppScopeApp["environments"][0]["memberCounts"]
  ) => ({
    id,
    name,
    memberCounts: counts,
    folderIds: Object.fromEntries(FAMILIES.map((family) => [family, `hidden-${id}-${family}`])),
  });
  const shop: AppScopeApp = {
    id: "app-shop",
    name: "Shop",
    environments: [
      environment("env-production", "production", { containers: 3, routes: 2 }),
      environment("env-staging", "staging", { containers: 4, compose: 1, routes: 2 }),
    ],
  };
  const northwind: AppScopeApp = {
    id: "app-northwind",
    name: "Northwind",
    environments: [environment("env-nw-production", "production", { pages: 1 })],
  };
  const appCtx: AccessContext = { folders: folders(), apps: [shop, northwind] };
  const staging = { kind: "app", appId: "app-shop", envId: "env-staging" } as const;
  const everyEnvironment = { kind: "app", appId: "app-shop", envId: null } as const;
  const appLine = (
    role: ResourceAccessLine["role"],
    where: ResourceAccessLine["where"],
    mayDelete = false
  ): ResourceAccessLine => ({
    kind: "resources",
    role,
    types: [...APP_ACCESS_TYPE_IDS],
    where,
    mayDelete,
  });

  it("grants the environment's hidden folders and the role's app scopes on it", () => {
    const scopes = lineScopes(appLine("developer", staging), appCtx);
    expect(scopes).toContain("docker:containers:create:folder/hidden-env-staging-containers");
    expect(scopes).toContain("docker:compose:manage:folder/hidden-env-staging-compose");
    expect(scopes).toContain("proxy:edit:folder/hidden-env-staging-routes");
    expect(scopes).toContain("pages:deploy:folder/hidden-env-staging-pages");
    expect(scopes).toContain("ssl:cert:issue:folder/hidden-env-staging-certificates");
    expect(sorted(scopes.filter((scope) => scope.startsWith("apps:")))).toEqual([
      "apps:env:manage:env/env-staging",
      "apps:promote:env/env-staging",
      "apps:view:env/env-staging",
    ]);
    expect(scopes.some((scope) => scope.includes("env-production"))).toBe(false);
    expect(scopes).toContain("domains:view:folder/hidden-env-staging-domains");
    // Domains and certificates are granted on the environment's folder only.
    for (const prefix of ["domains:", "ssl:"]) {
      expect(
        scopes
          .filter((scope) => scope.startsWith(prefix))
          .every((scope) => scope.includes("folder/"))
      ).toBe(true);
    }
  });

  it("gives each role its app scopes", () => {
    const appScopes = (role: ResourceAccessLine["role"]) =>
      sorted(
        lineScopes(appLine(role, staging), appCtx).filter((scope) => scope.startsWith("apps:"))
      );
    expect(appScopes("viewer")).toEqual(["apps:view:env/env-staging"]);
    expect(appScopes("deployer")).toEqual([
      "apps:promote:env/env-staging",
      "apps:view:env/env-staging",
    ]);
    expect(appScopes("operator")).toEqual(
      sorted(APP_ROLE_SCOPES.operator.map((scope) => `${scope}:env/env-staging`))
    );
  });

  it("grants every current environment's folders and the app scopes on the app for every environment", () => {
    const scopes = lineScopes(appLine("viewer", everyEnvironment), appCtx);
    expect(scopes).toContain("docker:containers:view:folder/hidden-env-production-containers");
    expect(scopes).toContain("docker:containers:view:folder/hidden-env-staging-containers");
    expect(scopes).toContain("apps:view:app-shop");
    expect(scopes.some((scope) => scope.includes("env/"))).toBe(false);
  });

  it("grants the app-root folders for every environment where Opfield reports them", () => {
    const roots = Object.fromEntries(FAMILIES.map((family) => [family, `root-shop-${family}`]));
    const rootCtx: AccessContext = { ...appCtx, apps: [{ ...shop, rootFolderIds: roots }] };
    const line = appLine("developer", everyEnvironment, true);
    const scopes = lineScopes(line, rootCtx);
    expect(scopes).toContain("docker:containers:delete:folder/root-shop-containers");
    expect(scopes.some((scope) => scope.includes("hidden-env-"))).toBe(false);
    expect(scopesToLines(linesToScopes([line], rootCtx), rootCtx)).toEqual([line]);
    // A grant on the app-root folder holds each environment's folder.
    expect(
      principalHolds(scopes, "docker:containers:view:folder/hidden-env-staging-containers", rootCtx)
    ).toBe(true);
  });

  for (const role of ACCESS_ROLES.map((item) => item.id)) {
    for (const where of [staging, everyEnvironment]) {
      for (const mayDelete of role === "developer" || role === "operator"
        ? [false, true]
        : [false]) {
        it(`reads back ${role} in ${where.envId ?? "every environment"}${mayDelete ? " with delete" : ""}`, () => {
          const line = appLine(role, where, mayDelete);
          expect(scopesToLines(linesToScopes([line], appCtx), appCtx)).toEqual([line]);
        });
      }
    }
  }

  it("reads app lines next to folder lines and lines on some types", () => {
    const lines: AccessLine[] = [
      {
        kind: "resources",
        role: "viewer",
        types: ALL_TYPES.filter((type) => type !== "domains"),
        where: { kind: "folder", path: "billing" },
        mayDelete: false,
      },
      { ...appLine("deployer", everyEnvironment), types: ["containers", "pages"] },
      appLine("operator", { kind: "app", appId: "app-northwind", envId: "env-nw-production" }),
      appLine("developer", { kind: "app", appId: "app-shop", envId: "env-production" }, true),
    ];
    const parsed = scopesToLines(linesToScopes(lines, appCtx), appCtx);
    // Folder lines first, then apps in their order: Shop (every environment, production), Northwind.
    expect(parsed).toEqual([lines[0], lines[1], lines[3], lines[2]]);
  });

  it("reads hidden-folder grants without app scopes as the role in the place, resources only", () => {
    const scopes = [
      "docker:containers:view:folder/hidden-env-staging-containers",
      "docker:containers:view:folder/rw-f1",
    ];
    const ctx: AccessContext = {
      ...appCtx,
      folders: [
        ...appCtx.folders,
        { id: "rw-f1", label: "rw-f1", family: "docker", ancestorIds: [] },
      ],
    };
    const lines = scopesToLines(scopes, ctx);
    const labels = contextLabels(ctx);
    expect(lines.map((line) => describeLine(line, labels).title)).toEqual([
      "Viewer in folder rw-f1",
      "Viewer in Shop · staging",
    ]);
    expect(describeLine(lines[1]!, labels).detail).toBe(
      "Containers and deployments · resources only"
    );
    expect(lines.some((line) => line.kind === "custom")).toBe(false);
    expect(sorted(linesToScopes(lines, ctx))).toEqual(sorted(scopes));
  });

  it("keeps a resources-only app line without app scopes when it is saved again", () => {
    const roots = Object.fromEntries(FAMILIES.map((family) => [family, `root-shop-${family}`]));
    const rootCtx: AccessContext = { ...appCtx, apps: [{ ...shop, rootFolderIds: roots }] };
    for (const where of [staging, everyEnvironment]) {
      const line: ResourceAccessLine = {
        ...appLine("developer", where),
        types: ["containers", "routes"],
        appScopes: false,
      };
      const scopes = linesToScopes([line], rootCtx);
      expect(scopes.some((scope) => scope.startsWith("apps:"))).toBe(false);
      expect(scopesToLines(scopes, rootCtx)).toEqual([line]);
    }
  });

  it("names the app and environment and the eight types", () => {
    const labels = contextLabels(appCtx);
    expect(describeLine(appLine("developer", staging), labels)).toEqual({
      title: "Developer in Shop · staging",
      detail: "All 8 resource types",
    });
    expect(
      describeLine({ ...appLine("viewer", everyEnvironment), types: ["routes"] }, labels)
    ).toEqual({
      title: "Viewer in Shop · every environment",
      detail: "Routes",
    });
    expect(appMemberCount(appCtx, staging)).toBe(7);
    expect(appMemberCount(appCtx, everyEnvironment, ["containers"])).toBe(7);
  });

  it("counts an app scope on the whole app for each environment", () => {
    expect(principalHolds(["apps:view:app-shop"], "apps:view:env/env-staging", appCtx)).toBe(true);
    expect(principalHolds(["apps:view:app-shop"], "apps:view:env/env-nw-production", appCtx)).toBe(
      false
    );
    expect(principalHolds(["apps:promote"], "apps:promote:env/env-staging", appCtx)).toBe(true);
  });
});

describe("folders created after a folder line was saved", () => {
  const line: AccessLine = {
    kind: "resources",
    role: "viewer",
    types: ["databases"],
    where: { kind: "folder", path: "orders" },
    mayDelete: false,
  };
  const before: AccessContext = { folders: folders() };
  const stored = new Set(linesToScopes([line], before));
  const after: AccessContext = {
    folders: [
      ...folders(),
      { id: "apps-orders", label: "orders", family: "apps", ancestorIds: [] },
    ],
  };

  it("says the line does not cover an Apps folder of its path created later, until it is saved again", () => {
    expect(newFoldersNote(line, stored, after)).toBe(
      "The folder orders now also exists in Apps: save to cover it too."
    );
    expect(newFoldersNote(line, new Set(linesToScopes([line], after)), after)).toBeNull();
  });

  it("says nothing for a line that covers every folder of its path, or one just added", () => {
    expect(newFoldersNote(line, stored, before)).toBeNull();
    expect(newFoldersNote(line, new Set(), after)).toBeNull();
  });
});
