import { hasCreationDestination } from "@/lib/creation-folders";
import { hasScopeBase } from "@/lib/scope-utils";

/**
 * The tabs of the Docker page and who may open each, on the global section scopes (grants held only
 * through app places left out, see `useGlobalSectionAccess`). The page, its guard, the sidebar item
 * and the command palette all read this list, like the Routes and Certificates hubs.
 */
export type DockerTab =
  | "containers"
  | "compose"
  | "images"
  | "volumes"
  | "networks"
  | "tasks"
  | "builds";

export interface DockerTabContext {
  /** Global section scopes. */
  scopes: readonly string[];
  /** Git push-to-deploy is in the plan, or builds from before exist (the page checks); unset: no. */
  buildsAvailable?: boolean;
}

export interface DockerTabDef {
  value: DockerTab;
  label: string;
  canAccess: (context: DockerTabContext) => boolean;
}

/** A list the user may view, or a destination they may create in (a folder creator's folder may still be empty). */
function viewOrCreate(scopes: readonly string[], view: string, create: string): boolean {
  return hasScopeBase(scopes, view) || hasCreationDestination(scopes, create, { nodeGrants: true });
}

export const DOCKER_TABS: readonly DockerTabDef[] = [
  {
    value: "containers",
    label: "Containers",
    canAccess: ({ scopes }) =>
      viewOrCreate(scopes, "docker:containers:view", "docker:containers:create") ||
      hasScopeBase(scopes, "docker:folders:manage"),
  },
  {
    value: "compose",
    label: "Compose",
    canAccess: ({ scopes }) => viewOrCreate(scopes, "docker:compose:view", "docker:compose:create"),
  },
  {
    value: "images",
    label: "Images",
    canAccess: ({ scopes }) => viewOrCreate(scopes, "docker:images:view", "docker:images:pull"),
  },
  {
    value: "volumes",
    label: "Volumes",
    canAccess: ({ scopes }) => viewOrCreate(scopes, "docker:volumes:view", "docker:volumes:create"),
  },
  {
    value: "networks",
    label: "Networks",
    canAccess: ({ scopes }) =>
      viewOrCreate(scopes, "docker:networks:view", "docker:networks:create"),
  },
  {
    value: "tasks",
    label: "Tasks",
    canAccess: ({ scopes }) => hasScopeBase(scopes, "docker:tasks"),
  },
  {
    // The builds list answers container, Compose and Pages builds the user may view.
    value: "builds",
    label: "Builds",
    canAccess: ({ scopes, buildsAvailable }) =>
      buildsAvailable === true &&
      (hasScopeBase(scopes, "docker:containers:view") ||
        hasScopeBase(scopes, "docker:compose:view") ||
        hasScopeBase(scopes, "pages:view")),
  },
];

export function visibleDockerTabs(context: DockerTabContext): DockerTabDef[] {
  return DOCKER_TABS.filter((tab) => tab.canAccess(context));
}

/**
 * The Docker section opens with any tab but Builds: Pages builds alone show on their Pages project,
 * and container or Compose builds come with the Containers or Compose tab.
 */
export function canAccessDockerSection(scopes: readonly string[]): boolean {
  return DOCKER_TABS.some((tab) => tab.value !== "builds" && tab.canAccess({ scopes }));
}

/** Docker view scopes that list nodes (the shell's Docker node list answers the same ones and creation). */
const DOCKER_NODE_VIEW_SCOPES = [
  "docker:containers:view",
  "docker:compose:view",
  "docker:images:view",
  "docker:volumes:view",
  "docker:networks:view",
] as const;

/**
 * `hasDockerNodes` of the navigation: Docker nodes are known (UI bootstrap), or a view grant outside
 * app places holds the item while they load.
 */
export function hasDockerNodesForNavigation(
  dockerNodeCount: number,
  scopes: readonly string[]
): boolean {
  return dockerNodeCount > 0 || DOCKER_NODE_VIEW_SCOPES.some((base) => hasScopeBase(scopes, base));
}
