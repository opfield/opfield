import type {
  ContainerLink,
  ContainerLinkEndpoint,
  ContainerLinkEnvironment,
  ContainerLinkStatus,
  DockerComposeProjectSummary,
  DockerContainer,
  NodeAppearanceColor,
} from "@/types";

type BadgeVariant = "success" | "warning" | "secondary" | "destructive";

export function composeServiceResourceId(projectId: string, serviceName: string) {
  return `${projectId}:${encodeURIComponent(serviceName)}`;
}

export function parseComposeServiceResourceId(resourceId: string) {
  const separator = resourceId.indexOf(":");
  if (separator < 0) return { projectId: resourceId, serviceName: "" };
  let serviceName = resourceId.slice(separator + 1);
  try {
    serviceName = decodeURIComponent(serviceName);
  } catch {
    // Keep the raw text; the backend only issues encoded names.
  }
  return { projectId: resourceId.slice(0, separator), serviceName };
}

/** The target's name as a DNS label, the default alias (the backend validates the same shape). */
export function aliasFromName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

const ENVIRONMENT_FIELDS = ["host", "port", "url"] as const;

export function environmentNames(environment: ContainerLinkEnvironment | undefined) {
  return ENVIRONMENT_FIELDS.map((field) => environment?.[field]?.trim()).filter(
    (name): name is string => Boolean(name)
  );
}

const STATUS_BADGES: Record<
  ContainerLinkStatus,
  { label: string; variant: BadgeVariant; detail: string }
> = {
  ready: { label: "ready", variant: "success", detail: "The link is ready." },
  waiting: {
    label: "waiting",
    variant: "secondary",
    detail: "The target is not running. Connections are refused until it starts.",
  },
  pending: {
    label: "pending",
    variant: "secondary",
    detail:
      "Saved on the workload. It takes effect when the workload next starts, rolls out or gets a new revision.",
  },
  update_required: {
    label: "update required",
    variant: "warning",
    detail: "A node of this link needs a newer Docker daemon.",
  },
  error: { label: "error", variant: "destructive", detail: "The link failed." },
  creating: { label: "creating", variant: "secondary", detail: "The link is being created." },
  deleting: { label: "removing", variant: "secondary", detail: "The link is being removed." },
};

export function containerLinkStatusBadge(link: Pick<ContainerLink, "status" | "lastError">) {
  const badge = STATUS_BADGES[link.status] ?? STATUS_BADGES.error;
  return { ...badge, detail: link.lastError || badge.detail };
}

/** Names and nodes of workloads, to show a link's ends the way the user knows them. */
export interface ContainerLinkNames {
  endpoint(endpoint: ContainerLinkEndpoint): {
    name: string;
    nodeName: string;
    nodeColor: NodeAppearanceColor | null;
  };
}

export function buildContainerLinkNames(
  workloads: DockerContainer[],
  projects: DockerComposeProjectSummary[]
): ContainerLinkNames {
  const nodeNames = new Map<string, string>();
  const nodeColors = new Map<string, NodeAppearanceColor | null>();
  const names = new Map<string, string>();
  for (const workload of workloads) {
    const nodeId = workload.nodeId ?? workload._nodeId;
    if (nodeId && workload._nodeName) nodeNames.set(nodeId, workload._nodeName);
    if (nodeId && workload._nodeColor !== undefined) nodeColors.set(nodeId, workload._nodeColor);
    if (workload.kind === "deployment") {
      names.set(`deployment:${workload.deploymentId ?? workload.id}`, workload.name);
    }
  }
  for (const project of projects) {
    if (project._nodeName) nodeNames.set(project.nodeId, project._nodeName);
    if (project._nodeColor !== undefined) nodeColors.set(project.nodeId, project._nodeColor);
    names.set(`compose_service:${project.id}`, project.name);
  }
  return {
    endpoint(endpoint) {
      const nodeName = nodeNames.get(endpoint.nodeId) ?? "";
      const nodeColor = nodeColors.get(endpoint.nodeId) ?? null;
      if (endpoint.type === "container") return { name: endpoint.resourceId, nodeName, nodeColor };
      if (endpoint.type === "deployment") {
        return {
          name: names.get(`deployment:${endpoint.resourceId}`) ?? endpoint.resourceId.slice(0, 8),
          nodeName,
          nodeColor,
        };
      }
      const { projectId, serviceName } = parseComposeServiceResourceId(endpoint.resourceId);
      const project = names.get(`compose_service:${projectId}`);
      return {
        name: project ? `${project} / ${serviceName}` : serviceName || projectId,
        nodeName,
        nodeColor,
      };
    },
  };
}

/** Whether a realtime `container_link` event concerns the workload (a container name, deployment id or Compose project). */
export function containerLinkEventMatches(
  payload: unknown,
  nodeId: string,
  type: ContainerLinkEndpoint["type"],
  resourceId: string
) {
  const event = payload as
    | { resourceKind?: string; nodeId?: string; containerName?: string; scopeResourceId?: string }
    | undefined;
  if (event?.resourceKind !== "container_link" || event.nodeId !== nodeId) return false;
  if (type === "container") return event.containerName === resourceId;
  if (type === "deployment") return event.scopeResourceId === resourceId;
  return event.scopeResourceId?.split(":", 1)[0] === resourceId.split(":", 1)[0];
}
