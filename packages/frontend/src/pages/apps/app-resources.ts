// Member rows of the app tabs: the normal list endpoints filtered to the app (`appId` + the `app` field).
import { useEffect, useRef, useState } from "react";
import { toastApiError } from "@/lib/api-error-toast";
import { isPermissionError } from "@/lib/picker-load-error";
import {
  dockerComposeProjectRoute,
  dockerContainerRoute,
  dockerDeploymentRoute,
} from "@/lib/resource-routes";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { planIncludes } from "@/stores/license-paywall";
import { syncPinnedContainerMeta } from "@/stores/pinned-containers";
import type {
  ContainerLink,
  DatabaseConnection,
  DockerComposeProject,
  DockerComposeProjectSummary,
  DockerContainer,
  LoggingEnvironment,
  ManagedDatabaseBinding,
  ManagedStorageBinding,
  ObjectStorageConnection,
  PageProject,
  ProxyHost,
  SSLCertificate,
} from "@/types";

export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/** A service of a member Compose project, as the project's own page lists it. */
export type AppComposeService = DockerComposeProject["services"][number];

export interface AppComposeRow {
  project: DockerComposeProjectSummary;
  services: AppComposeService[];
}

/** A member type the user's scopes do not show: the tab names it inline instead of failing. */
export interface AppHiddenMembers {
  title: string;
  scope: string;
}

/** Which member lists the user's scopes allow (base scopes; resource scopes filter server-side). */
export interface AppMemberAccess {
  containers: boolean;
  compose: boolean;
  routes: boolean;
  certificates?: boolean;
}

const FULL_ACCESS: AppMemberAccess = {
  containers: true,
  compose: true,
  routes: true,
  certificates: true,
};

export interface AppCompute {
  /** Containers and deployments (kind "deployment"). */
  containers: DockerContainer[];
  compose: AppComposeRow[];
  hidden: AppHiddenMembers[];
}

/**
 * Runs `request` only when the scopes allow it; a refusal (403) counts as not allowed. `null`
 * means hidden, so one refused member type never empties the rest of the tab.
 */
async function whenAllowed<T>(allowed: boolean, request: () => Promise<T>): Promise<T | null> {
  if (!allowed) return null;
  try {
    return await request();
  } catch (error) {
    if (isPermissionError(error)) return null;
    throw error;
  }
}

export interface AppData {
  databases: DatabaseConnection[];
  storage: ObjectStorageConnection[];
  logging: LoggingEnvironment[];
}

/** A private connection a member workload starts: a container link or a DB/storage binding. */
export interface AppLinkRow {
  id: string;
  environmentId: string;
  from: string;
  to: string;
  detail: string;
  status: string;
  tone: "success" | "warning" | "destructive" | "secondary";
  /** The page of the workload that starts the connection. */
  route: string | null;
}

export interface AppNetwork {
  routes: ProxyHost[];
  certificates: SSLCertificate[];
  links: AppLinkRow[];
  hidden: AppHiddenMembers[];
}

/** Every visible container of the app (snapshot rows across nodes) and Compose services by project. */
export async function loadAppCompute(
  appId: string,
  access: AppMemberAccess = FULL_ACCESS
): Promise<AppCompute> {
  const [members, projects] = await Promise.all([
    whenAllowed(access.containers, () => api.listDockerContainerSnapshots({ appId })),
    whenAllowed(access.compose, () => api.listDockerComposeProjects(undefined, { appId })),
  ]);
  const hidden: AppHiddenMembers[] = [];
  if (members === null) {
    hidden.push({ title: "Containers and deployments", scope: "docker:containers:view" });
  }
  if (projects === null) hidden.push({ title: "Compose projects", scope: "docker:compose:view" });
  const memberProjects = (projects ?? []).filter((project) => project.app?.id === appId);
  const containers = (members ?? []).filter(
    (row) => row.app?.id === appId && !row.labels?.[COMPOSE_PROJECT_LABEL]
  );
  syncPinnedContainerMeta(containers);
  // A project's services are not members themselves, and container lists leave Compose containers
  // out: read them from each project, the same services its own page lists.
  const compose = await Promise.all(
    memberProjects.map(async (project) => ({
      project,
      services: [
        ...((await api
          .getDockerComposeProject(project.nodeId, project.id)
          .then((detail) => detail.services)
          .catch(() => [])) ?? []),
      ].sort((a, b) => a.name.localeCompare(b.name)),
    }))
  );
  return { containers, compose, hidden };
}

export function serviceName(container: DockerContainer): string {
  return container.labels?.[COMPOSE_SERVICE_LABEL] ?? container.name;
}

/**
 * Databases, storage and logging environments of the app; a family the license plan lacks or the
 * user may not view is not requested.
 */
export async function loadAppData(
  appId: string,
  options: { loggingEnabled: boolean }
): Promise<AppData> {
  // A family the user may not view is not requested (the app can be visible through other members).
  const auth = useAuthStore.getState();
  const [databases, storage, logging] = await Promise.all([
    planIncludes("external-database-connections") && auth.hasScopedAccess("databases:view")
      ? api.listAppDatabases(appId)
      : [],
    planIncludes("storage-connections") && auth.hasScopedAccess("storage:view")
      ? api.listAppStorage(appId)
      : [],
    options.loggingEnabled && canListAppLogging() ? api.listAppLoggingEnvironments(appId) : [],
  ]);
  return { databases, storage, logging };
}

/** Logging is in the plan and the user may view some environment (logs:read lists them too). */
function canListAppLogging(): boolean {
  const auth = useAuthStore.getState();
  return (
    planIncludes("structured-logging") &&
    (auth.hasScopedAccess("logs:environments:view") || auth.hasScopedAccess("logs:read"))
  );
}

/** Pages projects of the app; none without the Pages plan feature. */
export async function loadAppPages(appId: string): Promise<PageProject[]> {
  return planIncludes("pages") ? api.listAppPages(appId) : [];
}

const LINK_TONE: Record<string, AppLinkRow["tone"]> = {
  ready: "success",
  active: "success",
  creating: "warning",
  waiting: "warning",
  pending: "warning",
  update_required: "warning",
  deleting: "secondary",
  error: "destructive",
};

/**
 * Routes of the app, and the links its member workloads start: container links (outgoing) plus
 * managed database and storage bindings whose target workload is a member.
 */
export async function loadAppNetwork(
  appId: string,
  access: AppMemberAccess = FULL_ACCESS
): Promise<AppNetwork> {
  const [routes, certificates, compute] = await Promise.all([
    whenAllowed(access.routes, () => api.listAppRoutes(appId)),
    whenAllowed(access.certificates !== false, () => api.listAppCertificates(appId)),
    loadAppCompute(appId, access),
  ]);
  const hidden: AppHiddenMembers[] = [
    ...(routes === null ? [{ title: "Routes", scope: "proxy:view" }] : []),
    ...(certificates === null ? [{ title: "SSL certificates", scope: "ssl:cert:view" }] : []),
    ...compute.hidden.map((entry) => ({
      title: `Links from ${entry.title.toLowerCase()}`,
      scope: entry.scope,
    })),
  ];

  interface Workload {
    nodeId: string;
    type: ContainerLink["source"]["type"];
    resourceId: string;
    label: string;
    environmentId: string;
    route: string | null;
  }
  const workloads: Workload[] = [];
  for (const container of compute.containers) {
    const nodeId = container.nodeId ?? container._nodeId;
    if (!nodeId || !container.app) continue;
    workloads.push(
      container.kind === "deployment"
        ? {
            nodeId,
            type: "deployment",
            resourceId: container.deploymentId ?? container.id,
            label: container.name,
            environmentId: container.app.environmentId,
            route: container._nodeSlug
              ? dockerDeploymentRoute(container._nodeSlug, container.name)
              : null,
          }
        : {
            nodeId,
            type: "container",
            resourceId: container.name,
            label: container.name,
            environmentId: container.app.environmentId,
            route: container._nodeSlug
              ? dockerContainerRoute(container._nodeSlug, container.name)
              : null,
          }
    );
  }
  for (const { project, services } of compute.compose) {
    if (!project.app) continue;
    for (const service of services) {
      const name = service.name;
      workloads.push({
        nodeId: project.nodeId,
        type: "compose_service",
        resourceId: `${project.id}:${encodeURIComponent(name)}`,
        label: `${project.name}/${name}`,
        environmentId: project.app.environmentId,
        route: dockerComposeProjectRoute(project.id),
      });
    }
  }
  const workloadKey = (nodeId: string, type: string, resourceId: string) =>
    `${nodeId}\u0000${type}\u0000${resourceId}`;
  const byKey = new Map(workloads.map((w) => [workloadKey(w.nodeId, w.type, w.resourceId), w]));

  const linkLists = await Promise.all(
    (planIncludes("container-links") ? workloads : []).map((workload) =>
      api
        .listContainerLinks({
          nodeId: workload.nodeId,
          type: workload.type,
          resourceId: workload.resourceId,
          direction: "outgoing",
        })
        .then((links) => links.map((link) => ({ link, workload })))
        .catch(() => [])
    )
  );

  const rows: AppLinkRow[] = linkLists.flat().map(({ link, workload }) => ({
    id: `link:${link.id}`,
    environmentId: workload.environmentId,
    from: workload.label,
    // The target's name, never its id: a member by its label, a container by its name, else the alias.
    to:
      byKey.get(workloadKey(link.target.nodeId, link.target.type, link.target.resourceId))?.label ??
      (link.target.type === "container" ? link.target.resourceId : link.alias || "Linked workload"),
    detail: link.alias
      ? `Container link · ${link.alias}:${link.targetPort}`
      : `Container link · port ${link.targetPort}`,
    status: link.status,
    tone: LINK_TONE[link.status] ?? "secondary",
    route: workload.route,
  }));

  // Bindings are listed per managed database / storage; keep those that reach a member workload.
  // Only the lists the user may read: a user who sees the app through some members gets no refusals here.
  const auth = useAuthStore.getState();
  const [managedDatabases, managedStorages] = await Promise.all([
    planIncludes("external-database-connections") && auth.hasScopedAccess("databases:view")
      ? api.listManagedDatabases().catch(() => [])
      : [],
    planIncludes("managed-storage") && auth.hasScopedAccess("storage:view")
      ? api.listManagedObjectStorages().catch(() => [])
      : [],
  ]);
  const bindingRows = await Promise.all([
    ...managedDatabases.map((database) =>
      api
        .listManagedDatabaseBindings(database.id)
        .then((bindings: ManagedDatabaseBinding[]) =>
          bindings.flatMap((binding) => {
            const workload = byKey.get(
              workloadKey(binding.targetNodeId, binding.targetType, binding.targetResourceId)
            );
            return workload
              ? [
                  {
                    id: `db:${binding.id}`,
                    environmentId: workload.environmentId,
                    from: workload.label,
                    to: database.name,
                    detail: "Database binding",
                    status: binding.status,
                    tone: LINK_TONE[binding.status] ?? "secondary",
                    route: workload.route,
                  } satisfies AppLinkRow,
                ]
              : [];
          })
        )
        .catch(() => [] as AppLinkRow[])
    ),
    ...managedStorages.map((storage) =>
      api
        .listManagedStorageBindings(storage.id)
        .then((bindings: ManagedStorageBinding[]) =>
          bindings.flatMap((binding) => {
            const workload = byKey.get(
              workloadKey(binding.targetNodeId, binding.targetType, binding.targetResourceId)
            );
            return workload
              ? [
                  {
                    id: `storage:${binding.id}`,
                    environmentId: workload.environmentId,
                    from: workload.label,
                    to: storage.name,
                    detail: "Storage binding",
                    status: binding.status,
                    tone: LINK_TONE[binding.status] ?? "secondary",
                    route: workload.route,
                  } satisfies AppLinkRow,
                ]
              : [];
          })
        )
        .catch(() => [] as AppLinkRow[])
    ),
  ]);

  return {
    routes: routes ?? [],
    certificates: certificates ?? [],
    links: [...rows, ...bindingRows.flat()],
    hidden,
  };
}

/** Loads with `loader` whenever `key` or `version` changes; keeps the last rows while refreshing. */
export function useAppLoad<T>(key: string | null, version: number, loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (!key) return;
    void version;
    let cancelled = false;
    setLoading(true);
    loaderRef
      .current()
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((error) => {
        // A refused list is an expected state the tab shows inline, never a toast.
        if (!cancelled && !isPermissionError(error)) toastApiError(error, "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, version]);

  return { data, loading: loading && data === null, refreshing: loading };
}
