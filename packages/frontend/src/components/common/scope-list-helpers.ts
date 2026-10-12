import { toast } from "sonner";
import {
  isManagedDatabaseCandidateNode,
  isManagedStorageCandidateNode,
} from "@/lib/managed-database-nodes";
import { extractBaseScope, hasScopeBase, scopeMatches } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { canServeLicenseFeature, type LicenseFeature } from "@/stores/license-paywall";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import {
  type AppMemberFamily,
  type AppMemberType,
  type CA,
  type DatabaseConnection,
  type Domain,
  FOLDER_SCOPABLE_SCOPES,
  type LoggingEnvironment,
  type LoggingSchema,
  type Node,
  type ProxyHost,
} from "@/types";
import {
  FOLDER_CREATION_SCOPES,
  GIT_CONNECTOR_SCOPES,
  GIT_TARGET_SCOPES,
} from "@/types/scope-resource-restrictions";

const FOLDER_TARGET_PREFIX = "folder/";
const FOLDER_SCOPABLE_SET = new Set<string>(FOLDER_SCOPABLE_SCOPES);
const CREATION_SCOPES = new Set<string>(FOLDER_CREATION_SCOPES);
const GIT_TARGET_SCOPE_SET = new Set<string>(GIT_TARGET_SCOPES);
const GIT_PROVIDER_NAMES: Record<string, string> = {
  gitlab: "GitLab",
  github: "GitHub",
  git: "Git",
};

export interface ScopeItem {
  value: string;
  label: string;
  desc: string;
  group: string;
  hideValue?: boolean;
  meta?: string;
}

export interface ResourceOption {
  id: string;
  label: string;
  parentId?: string;
  folderId?: string | null;
  depth?: number;
  kind?: "container" | "deployment";
}

export type ScopeResourceCatalog = Partial<Record<string, ResourceOption[]>>;

export function reportScopeLoadError(resource: string, error: unknown) {
  // Feature/permission changes can race a lookup. These are not load failures.
  if (error && typeof error === "object") {
    const { code, status } = error as { code?: string; status?: number };
    if (
      status === 403 ||
      [
        "FORBIDDEN",
        "LOGGING_DISABLED",
        "PKI_DISABLED",
        "DOMAINS_DISABLED",
        "FEATURE_DISABLED",
      ].includes(code ?? "")
    )
      return;
  }
  toast.error(`Could not load ${resource} for permission restrictions`, {
    id: `scope-load-${resource}`,
    description: error instanceof Error ? error.message : undefined,
  });
}

const PLAN_GATED_PERMISSIONS: readonly (readonly [string, LicenseFeature])[] = [
  ["pki:", "internal-pki"],
  ["audit:siem", "siem-export"],
  ["storage:", "storage-connections"],
  ["databases:", "external-database-connections"],
  ["pages:", "pages"],
  ["integrations:gitlab", "gitlab"],
];

export function canLoadScopeResource(permission: string, nodeId?: string): boolean {
  const features = useSystemConfigStore.getState().config.features;
  if (permission.startsWith("logs:") && !features.loggingEnabled) return false;
  if (permission.startsWith("domains:") && !features.domainsEnabled) return false;
  if (permission.startsWith("pki:") && !features.pkiEnabled) return false;
  // Resources of a feature the plan does not include are not listed (their API refuses).
  const snapshot = useUIBootstrapStore.getState().snapshot;
  for (const [prefix, feature] of PLAN_GATED_PERMISSIONS) {
    if (permission.startsWith(prefix) && !canServeLicenseFeature(snapshot, feature)) return false;
  }
  const scopes = useAuthStore.getState().user?.scopes ?? [];
  if (!hasScopeBase(scopes, permission)) return false;
  if (!nodeId || scopeMatches(scopes, permission)) return true;
  return (
    scopeMatches(scopes, `${permission}:${nodeId}`) ||
    scopeMatches(scopes, `${permission}:node/${nodeId}`) ||
    scopes.some((scope) => {
      const base = extractBaseScope(scope);
      if (base === scope) return false;
      const target = scope.slice(base.length + 1);
      // Folder membership is resolved by the API. The node inventory is already
      // access-filtered, and its resource endpoint returns only permitted items.
      return (
        (target.startsWith("folder/") || target.startsWith(`${nodeId}/`)) &&
        scopeMatches([scope], `${permission}:${target}`)
      );
    })
  );
}

export async function loadScopeResourceList<T>(
  permission: string,
  load: () => Promise<T[]>
): Promise<T[]> {
  return canLoadScopeResource(permission) ? load() : [];
}

const folderLookupPermissions: Partial<Record<FolderFamily, string>> = {
  groups: "admin:groups",
  users: "admin:users",
  domains: "domains:view",
  proxy: "proxy:view",
  nodes: "nodes:details",
  databases: "databases:view",
  storage: "storage:view",
  pages: "pages:view",
  ssl: "ssl:cert:view",
  "pki-cas": "pki:ca:view",
  "pki-certificates": "pki:cert:view",
  "nginx-templates": "proxy:templates:view",
  "logging-environments": "logs:environments:view",
  "logging-schemas": "logs:schemas:view",
  docker: "docker:containers:view",
  "docker-network": "docker:networks:view",
  "docker-volume": "docker:volumes:view",
  "docker-image": "docker:images:view",
  "docker-compose": "docker:compose:view",
};

export async function allResourcePages<T>(
  load: (
    page: number
  ) => Promise<{ data: T[]; pagination?: { totalPages: number }; totalPages?: number }>
): Promise<T[]> {
  const resources: T[] = [];
  for (let page = 1; ; page++) {
    const result = await load(page);
    resources.push(...result.data);
    if (!result.data.length || page >= (result.pagination?.totalPages ?? result.totalPages ?? 1))
      return resources;
  }
}

export async function loadScopeResourceCatalog(
  scopes: readonly ScopeItem[],
  nodes: readonly Node[]
): Promise<ScopeResourceCatalog> {
  const families = new Set(
    scopes
      .map((scope) => folderFamilyForScope(scope.value))
      .filter(
        (family) =>
          family &&
          (!folderLookupPermissions[family] ||
            canLoadScopeResource(folderLookupPermissions[family]!))
      )
  );
  const catalog: ScopeResourceCatalog = {};
  const nodeOptions = (kind: string) =>
    nodes
      .filter((node) => node.type === kind)
      .map((node) => ({
        id: `node/${node.id}`,
        label: node.displayName || node.hostname,
      }));
  const loads: Promise<void>[] = [];
  if (families.has("storage"))
    loads.push(
      allResourcePages((page) => api.listObjectStorages({ page, limit: 100 }))
        .then((items) => {
          catalog.storage = [
            ...nodeOptions("storage"),
            ...items.map((item) => ({ id: item.id, label: item.name, folderId: item.folderId })),
          ];
        })
        .catch((error) => {
          reportScopeLoadError("storage", error);
          catalog.storage = [];
        })
    );
  if (families.has("groups"))
    loads.push(
      api
        .listGroups()
        .then((groups) => {
          catalog.groups = groups.map((group) => ({
            id: group.id,
            label: group.name,
            folderId: group.folderId,
          }));
        })
        .catch((error) => {
          reportScopeLoadError("groups", error);
          catalog.groups = [];
        })
    );
  if (families.has("users"))
    loads.push(
      api
        .listUsers()
        .then((users) => {
          catalog.users = users.map((user) => ({
            id: user.id,
            label: user.name || user.email,
            folderId: user.folderId,
          }));
        })
        .catch((error) => {
          reportScopeLoadError("users", error);
          catalog.users = [];
        })
    );
  if (families.has("pages"))
    loads.push(
      (async () => {
        const projects = await allResourcePages((page) =>
          api.listPageProjects({ page, limit: 100 })
        );
        catalog.pages = [
          ...nodeOptions("nginx"),
          ...projects.map((project) => ({
            id: project.id,
            label: project.name,
            folderId: project.folderId,
          })),
        ];
      })().catch((error) => {
        reportScopeLoadError("Pages projects", error);
        catalog.pages = [];
      })
    );
  if (families.has("nginx-templates"))
    loads.push(
      api
        .listNginxTemplates()
        .then((templates) => {
          // Built-in templates are never in a folder, but can still be granted one by one.
          catalog["nginx-templates"] = templates.map((template) => ({
            id: template.id,
            label: template.name,
            folderId: template.folderId,
          }));
        })
        .catch((error) => {
          reportScopeLoadError("nginx templates", error);
          catalog["nginx-templates"] = [];
        })
    );
  if (families.has("ssl"))
    loads.push(
      (async () => {
        const certs = await allResourcePages((page) =>
          api.listSSLCertificates({ page, limit: 100 })
        );
        catalog.ssl = certs.map((cert) => ({
          id: cert.id,
          label: cert.name,
          folderId: cert.folderId,
        }));
      })().catch((error) => {
        reportScopeLoadError("SSL certificates", error);
        catalog.ssl = [];
      })
    );
  if (
    canLoadScopeResource("integrations:hosting:view") &&
    scopes.some(
      ({ value }) => value.startsWith("hosting:") || value.startsWith("integrations:hosting:")
    )
  ) {
    loads.push(
      api
        .listHostingConnectors()
        .then((accounts) => {
          catalog.hosting = [
            ...[...new Set(accounts.map((account) => account.provider))].map((provider) => ({
              id: `provider/${provider}`,
              label: `${provider} (all accounts)`,
            })),
            ...accounts.map((account) => ({
              id: `account/${account.id}`,
              label: `${account.name} (${account.provider})`,
            })),
          ];
        })
        .catch((error) => {
          reportScopeLoadError("hosting accounts", error);
          catalog.hosting = [];
        })
    );
  }
  for (const [family, type] of [
    ["docker-network", "network"],
    ["docker-volume", "volume"],
    ["docker-image", "image"],
    ["docker-compose", "compose"],
  ] as const) {
    if (!families.has(family)) continue;
    loads.push(
      (async () => {
        const resources = await Promise.all(
          nodes
            .filter(
              (node) =>
                node.type === "docker" &&
                canLoadScopeResource(folderLookupPermissions[family]!, node.id)
            )
            .map(async (node) => {
              const parent = { id: node.id, label: node.displayName || node.hostname };
              try {
                const children: ResourceOption[] =
                  type === "network"
                    ? (await api.listDockerNetworks(node.id)).flatMap((row) =>
                        row.scopeResourceId
                          ? [
                              {
                                id: `${node.id}/${row.scopeResourceId}`,
                                label: row.name,
                                parentId: node.id,
                                folderId: row.folderId,
                              },
                            ]
                          : []
                      )
                    : type === "volume"
                      ? (await api.listDockerVolumes(node.id)).map((row) => ({
                          id: `${node.id}/${row.name}`,
                          label: row.name,
                          parentId: node.id,
                          folderId: row.folderId,
                        }))
                      : type === "image"
                        ? (await api.listDockerImages(node.id)).map((row) => ({
                            id: `${node.id}/${row.id}`,
                            label: row.repoTags?.[0] ?? row.id,
                            parentId: node.id,
                            folderId: row.folderId,
                          }))
                        : (await api.listDockerComposeProjects(node.id)).map((row) => ({
                            id: `${node.id}/${row.id}`,
                            label: row.name,
                            parentId: node.id,
                            folderId: row.folderId,
                          }));
                return [parent, ...children];
              } catch (error) {
                reportScopeLoadError(`${type} resources on ${parent.label}`, error);
                return [parent];
              }
            })
        );
        catalog[family] = resources.flat();
      })().catch((error) => {
        reportScopeLoadError(family, error);
        catalog[family] = [];
      })
    );
  }
  await Promise.all(loads);
  return catalog;
}

export interface FolderOption {
  id: string;
  label: string;
  family: FolderFamily;
  ancestorIds: string[];
  /** A hidden folder of an app environment ("Shop · staging"): shown for grants, never offered. */
  appEnvironment?: boolean;
}

/* ------------------------------------------------------------------------------------------------
 * Apps: an environment holds its members in one hidden folder per family. Grants name those
 * folders (`<scope>:folder/<id>`) and the app scopes name the app or environment
 * (`apps:view:<appId>`, `apps:view:env/<envId>`); both read as "Shop · staging".
 * ---------------------------------------------------------------------------------------------- */

export interface AppScopeEnvironment {
  id: string;
  name: string;
  /** Members now, per family. */
  memberCounts: Partial<Record<AppMemberFamily, number>>;
  /** The hidden folder of each family. */
  folderIds: Partial<Record<AppMemberFamily, string>>;
}

export interface AppScopeApp {
  id: string;
  name: string;
  environments: AppScopeEnvironment[];
  /**
   * The hidden app-root folder of each family, when Gateway reports it: a grant there covers every
   * environment, also the ones added later.
   */
  rootFolderIds?: Partial<Record<AppMemberFamily, string>>;
}

/** The folder tree each app family's hidden folders live in. */
export const APP_FAMILY_FOLDER_FAMILY: Readonly<Record<AppMemberFamily, FolderFamily>> = {
  containers: "docker",
  compose: "docker-compose",
  routes: "proxy",
  databases: "databases",
  storage: "storage",
  pages: "pages",
};

export const APP_SCOPE_PREFIX = "apps:";

/** App scopes that name an app only (`<appId>`), never one environment. */
const APP_ONLY_SCOPES = new Set(["apps:edit", "apps:delete"]);

/** "Shop · staging", or "Shop · every environment" for the whole app. */
export function appPlaceLabel(
  app: Pick<AppScopeApp, "name">,
  environment?: { name: string } | null
) {
  return `${app.name} · ${environment ? environment.name : "every environment"}`;
}

/** Member counts by type (the API) as counts by family (the access lines). */
function familyMemberCounts(
  counts: Partial<Record<AppMemberType, number>>
): Partial<Record<AppMemberFamily, number>> {
  return {
    containers: (counts.container ?? 0) + (counts.deployment ?? 0),
    compose: counts.compose ?? 0,
    routes: counts.route ?? 0,
    databases: counts.database ?? 0,
    storage: counts.storage ?? 0,
    pages: counts.pages ?? 0,
  };
}

/**
 * The apps the signed-in user can see, with each environment's hidden folders and member counts
 * (one `getApp` per app: the list does not carry the folders). Empty without `apps:view`.
 */
export async function loadAppScopeCatalog(): Promise<AppScopeApp[]> {
  if (!canLoadScopeResource("apps:view")) return [];
  let summaries: Awaited<ReturnType<typeof api.listApps>>;
  try {
    summaries = await api.listApps();
  } catch (error) {
    reportScopeLoadError("apps", error);
    return [];
  }
  const apps = await Promise.all(
    summaries.map(async (summary): Promise<AppScopeApp | null> => {
      try {
        const detail = await api.getApp(summary.id);
        return {
          id: detail.id,
          name: detail.name,
          environments: detail.environments.map((environment) => ({
            id: environment.id,
            name: environment.name,
            memberCounts: familyMemberCounts(environment.memberCounts ?? {}),
            folderIds: Object.fromEntries(
              Object.entries(environment.placementFolderIds ?? {}).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string"
              )
            ),
          })),
          rootFolderIds: detail.rootFolderIds
            ? (Object.fromEntries(
                Object.entries(detail.rootFolderIds).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string"
                )
              ) as Partial<Record<AppMemberFamily, string>>)
            : undefined,
        };
      } catch (error) {
        reportScopeLoadError(`app ${summary.name}`, error);
        return null;
      }
    })
  );
  return apps.filter((app): app is AppScopeApp => app !== null);
}

/** Restriction options of the app scopes: each app, then its environments. */
export function appScopeResourceOptions(apps: readonly AppScopeApp[]): ResourceOption[] {
  return apps.flatMap((app) => [
    { id: app.id, label: appPlaceLabel(app) },
    ...app.environments.map((environment) => ({
      id: `env/${environment.id}`,
      label: appPlaceLabel(app, environment),
      parentId: app.id,
    })),
  ]);
}

/** The hidden folders of the apps, labelled by their app and environment, in each family's tree. */
export function appFolderOptions(apps: readonly AppScopeApp[]): FolderOption[] {
  return apps.flatMap((app) => {
    const roots = Object.entries(app.rootFolderIds ?? {}) as [AppMemberFamily, string][];
    return [
      ...roots.map(([family, id]) => ({
        id,
        label: appPlaceLabel(app),
        family: APP_FAMILY_FOLDER_FAMILY[family],
        ancestorIds: [],
        appEnvironment: true,
      })),
      ...app.environments.flatMap((environment) =>
        (Object.entries(environment.folderIds) as [AppMemberFamily, string][]).map(
          ([family, id]) => ({
            id,
            label: appPlaceLabel(app, environment),
            family: APP_FAMILY_FOLDER_FAMILY[family],
            ancestorIds: app.rootFolderIds?.[family] ? [app.rootFolderIds[family]!] : [],
            appEnvironment: true,
          })
        )
      ),
    ];
  });
}

export type FolderFamily =
  | "groups"
  | "users"
  | "domains"
  | "proxy"
  | "nodes"
  | "docker"
  | "docker-network"
  | "docker-volume"
  | "docker-image"
  | "docker-compose"
  | "pages"
  | "ssl"
  | "pki-cas"
  | "pki-certificates"
  | "nginx-templates"
  | "databases"
  | "storage"
  | "logging-environments"
  | "logging-schemas";

interface FolderTreeLike {
  id: string;
  name: string;
  children?: FolderTreeLike[];
}

export interface DockerResourceOption {
  id: string;
  nodeId: string;
  label: string;
  kind: "container" | "deployment";
  folderId?: string | null;
}

export interface ParsedScopedSelections {
  baseScopes: string[];
  resources: Record<string, string[]>;
  exactBaseScopes: Set<string>;
}

export type RestrictionRow =
  | { type: "folder"; key: string; folder: FolderOption; depth: 0 | 1 }
  | { type: "resource"; key: string; resource: ResourceOption; depth: 0 | 1 | 2 };

export function folderTarget(folderId: string) {
  return `${FOLDER_TARGET_PREFIX}${folderId}`;
}

export function isFolderTarget(value: string) {
  return value.startsWith(FOLDER_TARGET_PREFIX);
}

export function folderFamilyForScope(scope: string): FolderFamily | null {
  if (!FOLDER_SCOPABLE_SET.has(scope)) return null;
  if (scope === "admin:groups") return "groups";
  if (scope === "admin:users" || scope === "admin:users:impersonate") return "users";
  if (scope.startsWith("domains:")) return "domains";
  if (scope.startsWith("proxy:templates:")) return "nginx-templates";
  if (scope.startsWith("proxy:")) return "proxy";
  if (scope.startsWith("pki:ca:")) return "pki-cas";
  if (scope.startsWith("pki:cert:")) return "pki-certificates";
  if (scope.startsWith("pages:")) return "pages";
  if (scope.startsWith("ssl:cert:")) return "ssl";
  // Ingress groups live in node folders.
  if (scope.startsWith("nodes:") || scope.startsWith("ingress:groups:")) return "nodes";
  if (scope.startsWith("docker:containers:") || scope === "docker:availability:manage") {
    return "docker";
  }
  if (scope.startsWith("docker:networks:")) return "docker-network";
  if (scope.startsWith("docker:volumes:")) return "docker-volume";
  if (scope.startsWith("docker:images:")) return "docker-image";
  if (scope.startsWith("docker:compose:")) return "docker-compose";
  if (scope.startsWith("databases:")) return "databases";
  if (scope.startsWith("storage:")) return "storage";
  if (scope.startsWith("logs:schemas:")) return "logging-schemas";
  if (isLoggingEnvironmentScope(scope)) return "logging-environments";
  return null;
}

/** Scopes qualified by a logging environment ID (environment actions, log reading, ingest tokens). */
function isLoggingEnvironmentScope(scope: string): boolean {
  return (
    scope.startsWith("logs:environments:") ||
    scope.startsWith("logs:tokens:") ||
    scope === "logs:read"
  );
}

/** Scopes whose restriction targets are Docker nodes, folders, containers, and deployments. */
function isDockerWorkloadScope(scope: string): boolean {
  return (
    (scope.startsWith("docker:containers:") && scope !== "docker:containers:create") ||
    scope === "docker:availability:manage"
  );
}

export function flattenFolderTree(
  tree: FolderTreeLike[],
  family: FolderFamily,
  parentPath: string[] = [],
  ancestorIds: string[] = []
): FolderOption[] {
  return tree.flatMap((folder) => {
    const path = [...parentPath, folder.name];
    return [
      { id: folder.id, label: path.join("/"), family, ancestorIds },
      ...flattenFolderTree(folder.children ?? [], family, path, [...ancestorIds, folder.id]),
    ];
  });
}

export async function loadFolderFamily(family: FolderFamily): Promise<FolderOption[]> {
  const permission = folderLookupPermissions[family];
  const createPermission = FOLDER_CREATION_SCOPES.find(
    (scope) => folderFamilyForScope(scope) === family
  );
  const managePermission = family.startsWith("docker")
    ? "docker:folders:manage"
    : permission?.replace(/:(view|details)$/, ":folders:manage");
  if (
    permission &&
    ![permission, createPermission, managePermission].some(
      (scope) => scope && canLoadScopeResource(scope)
    )
  )
    return [];
  const load = async (promise: Promise<FolderTreeLike[]>) =>
    promise.catch((error) => {
      reportScopeLoadError(`${family} folders`, error);
      return [];
    });
  switch (family) {
    case "groups":
      return flattenFolderTree(await load(api.listAdminGroupFolders()), family);
    case "users":
      return flattenFolderTree(await load(api.listAdminUserFolders()), family);
    case "domains":
      return flattenFolderTree(await load(api.listDomainFolders()), family);
    case "proxy":
      return flattenFolderTree(await load(api.listFolders()), family);
    case "nodes":
      return flattenFolderTree(await load(api.listNodeFolders()), family);
    case "storage":
      return flattenFolderTree(await load(api.listObjectStorageFolders()), family);
    case "databases":
      return flattenFolderTree(await load(api.listDatabaseFolders()), family);
    case "logging-environments":
      return flattenFolderTree(await load(api.listLoggingEnvironmentFolders()), family);
    case "logging-schemas":
      return flattenFolderTree(await load(api.listLoggingSchemaFolders()), family);
    case "docker":
      return flattenFolderTree(await load(api.listDockerFolders("container")), family);
    case "docker-network":
      return flattenFolderTree(await load(api.listDockerFolders("network")), family);
    case "docker-volume":
      return flattenFolderTree(await load(api.listDockerFolders("volume")), family);
    case "docker-image":
      return flattenFolderTree(await load(api.listDockerFolders("image")), family);
    case "docker-compose":
      return flattenFolderTree(await load(api.listDockerFolders("compose")), family);
    case "pages":
      return flattenFolderTree(await load(api.listPageProjectFolders()), family);
    case "ssl":
      return flattenFolderTree(await load(api.listSSLCertificateFolders()), family);
    case "pki-cas":
      return flattenFolderTree(await load(api.listCAFolders()), family);
    case "pki-certificates":
      return flattenFolderTree(await load(api.listCertificateFolders()), family);
    case "nginx-templates":
      return flattenFolderTree(await load(api.listNginxTemplateFolders()), family);
  }
}

export function matchesQuery(scope: ScopeItem, q: string): boolean {
  return (
    scope.label.toLowerCase().includes(q) ||
    scope.value.toLowerCase().includes(q) ||
    scope.desc.toLowerCase().includes(q)
  );
}

export function parseScopedSelections(
  values: string[],
  restrictableScopes: readonly string[] = []
): ParsedScopedSelections {
  const baseScopes: string[] = [];
  const resources: Record<string, string[]> = {};
  const exactBaseScopes = new Set<string>();
  const sortedRestrictableScopes = [...restrictableScopes].sort((a, b) => b.length - a.length);
  const restrictableScopeSet = new Set<string>(restrictableScopes);

  for (const value of values) {
    if (restrictableScopeSet.has(value)) {
      if (!baseScopes.includes(value)) baseScopes.push(value);
      exactBaseScopes.add(value);
      continue;
    }

    let matchedBase: string | null = null;
    for (const base of sortedRestrictableScopes) {
      if (value.startsWith(`${base}:`)) {
        matchedBase = base;
        const resourceId = value.slice(base.length + 1);
        if (!baseScopes.includes(base)) baseScopes.push(base);
        if (!resources[base]) resources[base] = [];
        if (!resources[base].includes(resourceId)) resources[base].push(resourceId);
        break;
      }
    }

    if (matchedBase) continue;
    if (!baseScopes.includes(value)) baseScopes.push(value);
    exactBaseScopes.add(value);
  }

  return { baseScopes, resources, exactBaseScopes };
}

/** Determine which resource list to show for a scope */
export function getResourceOptions(
  scope: string,
  cas?: CA[],
  nodes?: Node[],
  proxyHosts?: ProxyHost[],
  databases?: DatabaseConnection[],
  domains?: Domain[],
  loggingEnvironments?: LoggingEnvironment[],
  loggingSchemas?: LoggingSchema[],
  dockerResources?: DockerResourceOption[],
  dockerRegistryRepositories?: string[],
  catalog: ScopeResourceCatalog = {}
): ResourceOption[] {
  const family = folderFamilyForScope(scope);
  if (scope.startsWith("hosting:") || scope.startsWith("integrations:hosting:")) {
    const accountScope =
      scope.startsWith("integrations:") ||
      scope.startsWith("hosting:billing:") ||
      scope === "hosting:resources:create";
    return accountScope
      ? (catalog.hosting ?? [])
      : [
          ...(catalog.hosting ?? []),
          ...(nodes ?? []).map((node) => ({
            id: `node/${node.id}`,
            label: node.displayName || node.hostname,
          })),
        ];
  }
  if (CREATION_SCOPES.has(scope) && scope !== "ssl:cert:issue") {
    if (scope.startsWith("docker:"))
      return (nodes ?? [])
        .filter((node) => node.type === "docker")
        .map((node) => ({ id: node.id, label: node.displayName || node.hostname }));
    if (scope === "storage:create")
      return (nodes ?? [])
        .filter(isManagedStorageCandidateNode)
        .map((node) => ({ id: `node/${node.id}`, label: node.displayName || node.hostname }));
    if (scope === "proxy:create" || scope === "pages:create" || scope === "databases:create") {
      return (nodes ?? [])
        .filter((node) =>
          scope === "databases:create"
            ? isManagedDatabaseCandidateNode(node)
            : node.type === "nginx"
        )
        .map((node) => ({ id: `node/${node.id}`, label: node.displayName || node.hostname }));
    }
    return [];
  }
  // Ingress group grants name node folders only, never one group or node.
  if (scope.startsWith("ingress:groups:")) return [];
  if (scope.startsWith(APP_SCOPE_PREFIX)) {
    const options = catalog.apps ?? [];
    return APP_ONLY_SCOPES.has(scope) ? options.filter((option) => !option.parentId) : options;
  }
  if (family && catalog[family]) return catalog[family]!;
  // Template grants name templates, never routes; the list comes from the catalog above.
  if (scope.startsWith("proxy:templates:")) return [];
  if (scope.startsWith("logs:schemas:")) {
    return (loggingSchemas ?? []).map((schema) => ({
      id: schema.id,
      label: schema.name,
      folderId: schema.folderId,
    }));
  }
  if (isLoggingEnvironmentScope(scope)) {
    return (loggingEnvironments ?? []).map((environment) => ({
      id: environment.id,
      label: environment.name,
      folderId: environment.folderId,
    }));
  }
  if (scope.startsWith("domains:")) {
    return (domains ?? []).map((domain) => ({
      id: domain.id,
      label: domain.domain,
      folderId: domain.folderId,
    }));
  }
  if (scope.startsWith("databases:")) {
    return [
      ...(nodes ?? [])
        .filter(isManagedDatabaseCandidateNode)
        .map((node) => ({ id: `node/${node.id}`, label: node.displayName || node.hostname })),
      ...(databases ?? []).map((database) => ({
        id: database.id,
        label: `${database.name} (${database.host}:${database.port})`,
        folderId: database.folderId,
      })),
    ];
  }
  if (isDockerWorkloadScope(scope)) {
    return (nodes ?? [])
      .filter((n) => n.type === "docker")
      .flatMap((n) => [
        { id: n.id, label: n.displayName || n.hostname, depth: 0 },
        ...(dockerResources ?? [])
          .filter((resource) => resource.nodeId === n.id)
          .map((resource) => ({
            id: `${n.id}/${resource.id}`,
            label: resource.label,
            parentId: n.id,
            folderId: resource.folderId,
            depth: 1,
            kind: resource.kind,
          })),
      ]);
  }
  if (scope.startsWith("docker:registries:internal:")) {
    return (dockerRegistryRepositories ?? []).map((repository) => ({
      id: repository,
      label: repository,
    }));
  }
  if (scope.startsWith("docker:")) {
    return (nodes ?? [])
      .filter((n) => n.type === "docker")
      .map((n) => ({ id: n.id, label: n.displayName || n.hostname, depth: 0 }));
  }
  if (scope.startsWith("nodes:")) {
    return (nodes ?? []).map((n) => ({
      id: n.id,
      label: n.displayName || n.hostname,
      folderId: n.folderId,
    }));
  }
  if (scope === "proxy:create") {
    return (nodes ?? [])
      .filter((node) => node.type === "nginx")
      .map((node) => ({ id: node.id, label: node.displayName || node.hostname }));
  }
  if (scope.startsWith("proxy:")) {
    return [
      ...(nodes ?? [])
        .filter((node) => node.type === "nginx")
        .map((node) => ({ id: `node/${node.id}`, label: node.displayName || node.hostname })),
      ...(proxyHosts ?? []).map((p) => ({
        id: p.id,
        label: p.domainNames[0] || p.id,
        folderId: p.folderId,
      })),
    ];
  }
  if (scope.startsWith("pki:ca:")) {
    // An intermediate CA reports the folder of its root, so it is listed in that folder.
    return (cas ?? []).map((ca) => ({ id: ca.id, label: ca.commonName, folderId: ca.folderId }));
  }
  if (scope.startsWith("pki:cert:")) {
    return (cas ?? []).map((ca) => ({ id: ca.id, label: ca.commonName }));
  }
  return [];
}

export function getResourceLabel(scope: string): string {
  if (GIT_TARGET_SCOPE_SET.has(scope) && scope.startsWith("integrations:gitlab:"))
    return "Restrict to GitLab connectors, or to groups and projects within a connector (leave unchecked for all):";
  if (GIT_TARGET_SCOPE_SET.has(scope) && scope.startsWith("integrations:github:"))
    return "Restrict to GitHub connectors, or to owners and repositories within a connector (leave unchecked for all):";
  if (
    GIT_TARGET_SCOPE_SET.has(scope) ||
    (GIT_CONNECTOR_SCOPES as readonly string[]).includes(scope)
  )
    return `Restrict to specific ${GIT_PROVIDER_NAMES[scope.split(":")[1]!]} connectors (leave unchecked for all):`;
  if (scope === "admin:groups" || scope === "admin:users" || scope === "admin:users:impersonate")
    return "Restrict to folders or individual accounts/groups (creation requires a destination folder; leave unchecked for all):";
  if (scope.startsWith("hosting:") || scope.startsWith("integrations:hosting:")) {
    return scope.startsWith("integrations:") ||
      scope.startsWith("hosting:billing:") ||
      scope === "hosting:resources:create"
      ? "Restrict to providers or hosting accounts (leave unchecked for all):"
      : "Restrict to providers, hosting accounts or nodes (node access is also required; leave unchecked for all):";
  }
  if (CREATION_SCOPES.has(scope) && scope !== "ssl:cert:issue")
    return "Restrict creation to destination folders or nodes where applicable (leave unchecked for all):";
  if (scope.startsWith("pages:"))
    return "Restrict to nodes, Page Project folders or individual projects (leave unchecked for all):";
  if (scope.startsWith("ssl:cert:"))
    return "Restrict to certificate folders or individual certificates (leave unchecked for all):";
  if (scope.startsWith("domains:")) {
    return "Restrict to domain folders or individual domains (leave unchecked for all):";
  }
  if (scope.startsWith("storage:"))
    return "Restrict to storage folders or individual storage connections (leave unchecked for all):";
  if (scope.startsWith("databases:")) {
    return "Restrict to database folders or individual databases (leave unchecked for all):";
  }
  if (scope.startsWith("docker:registries:internal:")) {
    return "Restrict to specific internal registry repositories (leave unchecked for all):";
  }
  if (scope.startsWith("docker:")) {
    return folderFamilyForScope(scope)
      ? "Restrict to Docker nodes, folders or individual resources (leave unchecked for all):"
      : "Restrict to specific Docker nodes (leave unchecked for all):";
  }
  if (scope.startsWith("nodes:")) return "Restrict to specific nodes (leave unchecked for all):";
  if (scope.startsWith(APP_SCOPE_PREFIX))
    return APP_ONLY_SCOPES.has(scope)
      ? "Restrict to specific apps (leave unchecked for all):"
      : "Restrict to apps or single app environments (leave unchecked for all):";
  if (scope.startsWith("ingress:groups:"))
    return "Restrict to node folders; a folder covers the ingress groups in it and its subfolders (leave unchecked for all):";
  if (scope === "proxy:create")
    return "Restrict to specific Ingress nodes (leave unchecked for all):";
  if (scope.startsWith("proxy:templates:"))
    return "Restrict to template folders or individual nginx templates (leave unchecked for all):";
  if (scope.startsWith("proxy:"))
    return "Restrict to route folders or individual routes (leave unchecked for all):";
  if (scope.startsWith("logs:schemas:"))
    return "Restrict to schema folders or individual logging schemas (leave unchecked for all):";
  if (isLoggingEnvironmentScope(scope))
    return "Restrict to environment folders or individual logging environments (leave unchecked for all):";
  if (scope.startsWith("pki:ca:"))
    return "Restrict to CA folders or individual CAs (leave unchecked for all):";
  if (folderFamilyForScope(scope) === "pki-certificates")
    return "Restrict to certificate folders or specific CAs (leave unchecked for all):";
  return "Restrict to specific CAs (leave unchecked for all):";
}
