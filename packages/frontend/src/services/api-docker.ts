import { type AppMemberListFilter, setAppMemberListParams } from "@/lib/app-members";
import type {
  ContainerCreateConfig,
  DockerAvailabilityOperation,
  DockerAvailabilityOperationPage,
  DockerAvailabilityPolicy,
  DockerAvailabilityPolicyInput,
  DockerAvailabilityPreflight,
  DockerAvailabilityResource,
  DockerComposeOperation,
  DockerComposeOperationAction,
  DockerComposeProject,
  DockerComposeProjectSummary,
  DockerComposeRevision,
  DockerComposeValidationResult,
  DockerContainer,
  DockerContainerFolder,
  DockerDeployment,
  DockerFolderResourceType,
  DockerFolderTreeNode,
  DockerHealthCheck,
  DockerNetwork,
  DockerSecret,
  DockerVolume,
  Node,
} from "@/types";
import { API_BASE } from "./api-base";
import { withDockerMigrationApi } from "./api-docker-migrations";
import { withDockerWebhookApi } from "./api-docker-webhooks";
import type { ApiClientBaseConstructor } from "./api-mixins";

/**
 * A container stop, restart, kill or removal still running when the request stopped waiting (45 s): the container is
 * in `transition`, and `taskId` finishes the operation.
 */
export type DockerContainerOperationPending = {
  taskId: string | null;
  containerId: string;
  name: string;
  transition: "stopping" | "restarting" | "killing";
};

/** Whether a lifecycle call's result is an operation that still runs. */
export function isPendingContainerOperation(
  value: unknown
): value is DockerContainerOperationPending {
  return !!value && typeof value === "object" && "transition" in value;
}

/** A lifecycle request answers 200 when done, or 202 with the operation that still runs. */
function pendingContainerOperation(
  body: { data?: DockerContainerOperationPending } | null | undefined
): DockerContainerOperationPending | null {
  return body?.data?.transition ? body.data : null;
}

type DockerListEnvelope<T> = {
  data: T[];
  total?: number;
  limit?: number;
  truncated?: boolean;
  nodes?: Array<{
    id: string;
    slug?: string;
    hostname?: string;
    displayName?: string;
    appearanceColor?: Node["appearanceColor"];
  }>;
};

type DockerListQuery = {
  search?: string;
};

type DockerGpuUsage = {
  deviceId: string;
  containerCount: number;
  containers: Array<{ name: string }>;
};

function dockerListQuery(params?: DockerListQuery & AppMemberListFilter & { noCache?: boolean }) {
  const query = new URLSearchParams();
  if (params?.search?.trim()) query.set("search", params.search.trim());
  setAppMemberListParams(query, params);
  if (params?.noCache) query.set("_t", String(Date.now()));
  const qs = query.toString();
  return qs ? `?${qs}` : "";
}

function withDockerListMeta<T extends object>(response: DockerListEnvelope<T>): T[] {
  return (response.data ?? []).map((item) => ({
    ...item,
    _listTotal: response.total ?? response.data.length,
    _listLimit: response.limit ?? response.data.length,
    _listTruncated: response.truncated === true,
  })) as T[];
}

// Snapshot routes use the same daemon-originated list payloads as legacy per-node routes.
// Preserve the existing tolerant casing normalization until every producer is camelCase-only.
function normalizeDockerRow(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  if (Array.isArray(item)) return item.map(normalizeDockerRow);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    const normalizedKey = key.charAt(0).toLowerCase() + key.slice(1);
    out[normalizedKey] = normalizeDockerRow(value);
    if (normalizedKey !== key) out[key] = value;
  }
  return out;
}

function withSnapshotNodeMeta<T extends object>(response: DockerListEnvelope<T>): T[] {
  const nodes = new Map((response.nodes ?? []).map((node) => [node.id, node]));
  return withDockerListMeta(response).map((item) => {
    const nodeId =
      (item as { nodeId?: string; NodeId?: string }).nodeId ?? (item as { NodeId?: string }).NodeId;
    const node = nodeId ? nodes.get(nodeId) : undefined;
    return {
      ...(normalizeDockerRow(item) as T),
      _nodeId: nodeId,
      _nodeSlug: node?.slug ?? "",
      _nodeName: node?.displayName || node?.hostname || "",
      _nodeColor: node?.appearanceColor ?? null,
    };
  }) as T[];
}

import { withDockerResourceApi } from "./api-docker-resources";

export function withDockerApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class DockerApiClient extends withDockerResourceApi(
    withDockerMigrationApi(withDockerWebhookApi(Base))
  ) {
    async getDockerAvailability(
      resource: DockerAvailabilityResource
    ): Promise<DockerAvailabilityPolicy | null> {
      const query = new URLSearchParams(resource as unknown as Record<string, string>);
      return this.unwrapData(
        this.request<{ data: DockerAvailabilityPolicy | null }>(
          `/docker/availability/by-resource?${query}`
        )
      );
    }

    async preflightDockerAvailability(
      input: DockerAvailabilityPolicyInput
    ): Promise<DockerAvailabilityPreflight> {
      return this.unwrapData(
        this.request<{ data: DockerAvailabilityPreflight }>("/docker/availability/preflight", {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
    }

    async enableDockerAvailability(
      input: DockerAvailabilityPolicyInput
    ): Promise<DockerAvailabilityPolicy> {
      return this.unwrapData(
        this.request<{ data: DockerAvailabilityPolicy }>("/docker/availability", {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
    }

    async updateDockerAvailability(
      policyId: string,
      input: Omit<Partial<DockerAvailabilityPolicyInput>, "resource">
    ): Promise<DockerAvailabilityPolicy> {
      return this.unwrapData(
        this.request<{ data: DockerAvailabilityPolicy }>(`/docker/availability/${policyId}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        })
      );
    }

    async listDockerAvailabilityOperations(
      policyId: string
    ): Promise<DockerAvailabilityOperation[]> {
      return this.unwrapData(
        this.request<{ data: DockerAvailabilityOperation[] }>(
          `/docker/availability/${policyId}/operations`
        )
      );
    }

    async listDockerAvailabilityOperationsPage(
      policyId: string,
      query: { page?: number; limit?: number } = {}
    ): Promise<DockerAvailabilityOperationPage> {
      const params = new URLSearchParams();
      if (query.page) params.set("page", String(query.page));
      if (query.limit) params.set("limit", String(query.limit));
      const suffix = params.size ? `?${params.toString()}` : "";
      return this.request<DockerAvailabilityOperationPage>(
        `/docker/availability/${policyId}/operations/page${suffix}`
      );
    }

    async disableDockerAvailability(
      policyId: string,
      input: { survivingPlacementId: string; confirmation: string }
    ): Promise<DockerAvailabilityPolicy> {
      return this.unwrapData(
        this.request<{ data: DockerAvailabilityPolicy }>(
          `/docker/availability/${policyId}/disable`,
          {
            method: "POST",
            body: JSON.stringify(input),
          }
        )
      );
    }

    async retryDockerAvailabilityOperation(policyId: string, operationId: string): Promise<void> {
      await this.request(`/docker/availability/${policyId}/operations/${operationId}/retry`, {
        method: "POST",
      });
    }

    async getDockerNodeBySlug(
      slug: string
    ): Promise<
      Pick<Node, "id" | "slug" | "type" | "hostname" | "displayName" | "appearanceColor">
    > {
      return this.unwrapData(
        this.requestRouteContext<{
          data: Pick<Node, "id" | "slug" | "type" | "hostname" | "displayName" | "appearanceColor">;
        }>(`/docker/nodes/by-slug/${encodeURIComponent(slug)}`)
      );
    }

    // ── Docker Folders ─────────────────────────────────────────────

    async listDockerFolders(
      resourceType: DockerFolderResourceType = "container"
    ): Promise<DockerFolderTreeNode[]> {
      return this.unwrapData(
        this.request<{ data: DockerFolderTreeNode[] }>(
          `/docker/folders?resourceType=${resourceType}`
        )
      );
    }

    async createDockerFolder(data: {
      name: string;
      parentId?: string;
      resourceType?: DockerFolderResourceType;
    }): Promise<DockerContainerFolder> {
      return this.unwrapData(
        this.request<{ data: DockerContainerFolder }>("/docker/folders", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateDockerFolder(id: string, data: { name: string }): Promise<DockerContainerFolder> {
      return this.unwrapData(
        this.request<{ data: DockerContainerFolder }>(`/docker/folders/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    /** Moves a Docker folder (with its subfolders and resources) under `parentId` (null = top level). */
    async moveDockerFolder(id: string, parentId: string | null): Promise<void> {
      await this.request(`/docker/folders/${id}/move`, {
        method: "PUT",
        body: JSON.stringify({ parentId }),
      });
    }

    async deleteDockerFolder(id: string): Promise<void> {
      return this.request<void>(`/docker/folders/${id}`, { method: "DELETE" });
    }

    async reorderDockerFolders(
      items: { id: string; sortOrder: number }[],
      resourceType: DockerFolderResourceType = "container"
    ): Promise<void> {
      return this.request<void>("/docker/folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items, resourceType }),
      });
    }

    async moveDockerResourcesToFolder(
      resourceType: DockerFolderResourceType,
      items: Array<{ nodeId: string; resourceKey: string }>,
      folderId: string | null
    ): Promise<void> {
      return this.request<void>("/docker/folders/move-resources", {
        method: "POST",
        body: JSON.stringify({ resourceType, items, folderId }),
      });
    }

    async moveDockerContainersToFolder(
      items: Array<{ nodeId: string; containerName: string }>,
      folderId: string | null
    ): Promise<void> {
      return this.request<void>("/docker/folders/move-containers", {
        method: "POST",
        body: JSON.stringify({ items, folderId }),
      });
    }

    async reorderDockerContainers(
      items: Array<{ nodeId: string; containerName: string; sortOrder: number }>
    ): Promise<void> {
      return this.request<void>("/docker/folders/reorder-containers", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async reorderDockerResources(
      resourceType: DockerFolderResourceType,
      items: Array<{ nodeId: string; resourceKey: string; sortOrder: number }>
    ): Promise<void> {
      return this.request<void>("/docker/folders/reorder-resources", {
        method: "PUT",
        body: JSON.stringify({ resourceType, items }),
      });
    }

    // ── Docker Compose Projects ───────────────────────────────────────

    async listDockerComposeProjects(
      nodeId?: string,
      filter?: AppMemberListFilter
    ): Promise<DockerComposeProjectSummary[]> {
      const params = new URLSearchParams();
      if (nodeId) params.set("nodeId", nodeId);
      setAppMemberListParams(params, filter);
      const query = params.size ? `?${params}` : "";
      return this.unwrapData(
        this.request<{ data: DockerComposeProjectSummary[] }>(`/docker/compose-projects${query}`)
      );
    }

    async getDockerComposeProject(
      nodeId: string,
      projectId: string
    ): Promise<DockerComposeProject> {
      return this.unwrapData(
        this.request<{ data: DockerComposeProject }>(
          `/docker/nodes/${nodeId}/compose-projects/${projectId}`
        )
      );
    }

    async validateDockerComposeProject(
      nodeId: string,
      input: {
        projectName: string;
        yaml: string;
        variables?: Record<string, string>;
        secretKeys?: string[];
      }
    ): Promise<DockerComposeValidationResult> {
      return this.unwrapData(
        this.request<{ data: DockerComposeValidationResult }>(
          `/docker/nodes/${nodeId}/compose-projects/validate`,
          { method: "POST", body: JSON.stringify(input) }
        )
      );
    }

    async createDockerComposeProject(
      nodeId: string,
      input: {
        folderId?: string | null;
        projectName: string;
        yaml: string;
        variables?: Record<string, string>;
        secretKeys?: string[];
      }
    ): Promise<{ project: DockerComposeProjectSummary; revision: DockerComposeRevision }> {
      return this.unwrapData(
        this.request<{
          data: { project: DockerComposeProjectSummary; revision: DockerComposeRevision };
        }>(`/docker/nodes/${nodeId}/compose-projects`, {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
    }

    async adoptDockerComposeProject(
      nodeId: string,
      projectId: string,
      input: { yaml: string; variables?: Record<string, string>; secretKeys?: string[] }
    ): Promise<{
      project: DockerComposeProjectSummary;
      revision: DockerComposeRevision;
      validation: DockerComposeValidationResult;
    }> {
      return this.unwrapData(
        this.request<{
          data: {
            project: DockerComposeProjectSummary;
            revision: DockerComposeRevision;
            validation: DockerComposeValidationResult;
          };
        }>(`/docker/nodes/${nodeId}/compose-projects/${projectId}/adopt`, {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
    }

    async createDockerComposeRevision(
      nodeId: string,
      projectId: string,
      input: { yaml: string; variables?: Record<string, string>; secretKeys?: string[] }
    ): Promise<DockerComposeRevision> {
      return this.unwrapData(
        this.request<{ data: DockerComposeRevision }>(
          `/docker/nodes/${nodeId}/compose-projects/${projectId}/revisions`,
          { method: "POST", body: JSON.stringify(input) }
        )
      );
    }

    async listDockerComposeRevisions(
      nodeId: string,
      projectId: string
    ): Promise<DockerComposeRevision[]> {
      return this.unwrapData(
        this.request<{ data: DockerComposeRevision[] }>(
          `/docker/nodes/${nodeId}/compose-projects/${projectId}/revisions`
        )
      );
    }

    async deleteDockerComposeRevision(
      nodeId: string,
      projectId: string,
      revisionId: string
    ): Promise<void> {
      await this.request(
        `/docker/nodes/${nodeId}/compose-projects/${projectId}/revisions/${revisionId}`,
        { method: "DELETE" }
      );
    }

    async listDockerComposeOperations(
      nodeId: string,
      projectId: string,
      input: { cursor?: string; limit?: number } = {}
    ): Promise<{ data: DockerComposeOperation[]; nextCursor: string | null }> {
      const query = new URLSearchParams();
      if (input.cursor) query.set("cursor", input.cursor);
      if (input.limit) query.set("limit", String(input.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return this.request<{ data: DockerComposeOperation[]; nextCursor: string | null }>(
        `/docker/nodes/${nodeId}/compose-projects/${projectId}/operations${suffix}`
      );
    }

    async listDockerComposeSecrets(nodeId: string, projectId: string): Promise<DockerSecret[]> {
      return this.unwrapData(
        this.request<{ data: DockerSecret[] }>(
          `/docker/nodes/${nodeId}/compose-projects/${projectId}/secrets`
        )
      );
    }

    async createDockerComposeSecret(
      nodeId: string,
      projectId: string,
      key: string,
      value: string
    ): Promise<DockerSecret> {
      return this.unwrapData(
        this.request<{ data: DockerSecret }>(
          `/docker/nodes/${nodeId}/compose-projects/${projectId}/secrets`,
          { method: "POST", body: JSON.stringify({ key, value }) }
        )
      );
    }

    async updateDockerComposeSecret(
      nodeId: string,
      projectId: string,
      secretId: string,
      value: string
    ): Promise<DockerSecret> {
      return this.unwrapData(
        this.request<{ data: DockerSecret }>(
          `/docker/nodes/${nodeId}/compose-projects/${projectId}/secrets/${secretId}`,
          { method: "PUT", body: JSON.stringify({ value }) }
        )
      );
    }

    async deleteDockerComposeSecret(
      nodeId: string,
      projectId: string,
      secretId: string
    ): Promise<void> {
      await this.request(
        `/docker/nodes/${nodeId}/compose-projects/${projectId}/secrets/${secretId}`,
        { method: "DELETE" }
      );
    }

    async startDockerComposeOperation(
      nodeId: string,
      projectId: string,
      action: DockerComposeOperationAction,
      input: {
        revisionId?: string;
        idempotencyKey: string;
        removeOrphans?: boolean;
        volumeNames?: string[];
      }
    ): Promise<DockerComposeOperation> {
      return this.unwrapData(
        this.request<{ data: DockerComposeOperation }>(
          `/docker/nodes/${nodeId}/compose-projects/${projectId}/actions/${action}`,
          { method: "POST", body: JSON.stringify(input) }
        )
      );
    }

    async deleteDockerComposeProject(nodeId: string, projectId: string): Promise<void> {
      await this.request(`/docker/nodes/${nodeId}/compose-projects/${projectId}`, {
        method: "DELETE",
      });
    }

    async getDockerFolderPlacements(
      resourceType: DockerFolderResourceType,
      items: Array<{ nodeId: string; resourceKey: string }>
    ): Promise<
      Array<{
        nodeId: string;
        resourceKey: string;
        folderId: string | null;
        folderIsSystem: boolean;
        sortOrder: number;
      }>
    > {
      return this.unwrapData(
        this.request<{
          data: Array<{
            nodeId: string;
            resourceKey: string;
            folderId: string | null;
            folderIsSystem: boolean;
            sortOrder: number;
          }>;
        }>("/docker/folders/placements", {
          method: "POST",
          body: JSON.stringify({ resourceType, items }),
        })
      );
    }

    // ── Docker Containers ─────────────────────────────────────────────

    async listDockerContainers(
      nodeId: string,
      options: boolean | (DockerListQuery & AppMemberListFilter & { noCache?: boolean }) = false
    ): Promise<DockerContainer[]> {
      const params = typeof options === "boolean" ? { noCache: options } : options;
      const url = `/docker/nodes/${nodeId}/containers${dockerListQuery(params)}`;
      return withDockerListMeta(await this.request<DockerListEnvelope<DockerContainer>>(url));
    }

    async listDockerGpuUsage(nodeId: string): Promise<DockerGpuUsage[]> {
      return this.unwrapData(
        this.request<{ data: DockerGpuUsage[] }>(`/docker/nodes/${nodeId}/containers/gpu-usage`)
      );
    }

    async listDockerContainerSnapshots(
      params?: DockerListQuery & AppMemberListFilter & { nodeId?: string }
    ) {
      const query = dockerListQuery(params);
      const separator = query ? "&" : "?";
      const nodeId = params?.nodeId
        ? `${separator}nodeId=${encodeURIComponent(params.nodeId)}`
        : "";
      return withSnapshotNodeMeta(
        await this.request<DockerListEnvelope<DockerContainer>>(
          `/docker/containers${query}${nodeId}`
        )
      );
    }

    async inspectContainer(
      nodeId: string,
      containerId: string,
      noCache = false
    ): Promise<Record<string, unknown>> {
      const url = noCache
        ? `/docker/nodes/${nodeId}/containers/${containerId}?_t=${Date.now()}`
        : `/docker/nodes/${nodeId}/containers/${containerId}`;
      return this.unwrapData(this.request<{ data: Record<string, unknown> }>(url));
    }

    async inspectContainerByName(
      nodeId: string,
      name: string,
      noCache = false
    ): Promise<Record<string, unknown>> {
      const path = `/docker/nodes/${nodeId}/containers/by-name/${encodeURIComponent(name)}`;
      return this.unwrapData(
        this.requestRouteContext<{ data: Record<string, unknown> }>(
          noCache ? `${path}?_t=${Date.now()}` : path
        )
      );
    }

    async createContainer(
      nodeId: string,
      config: ContainerCreateConfig
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(`/docker/nodes/${nodeId}/containers`, {
          method: "POST",
          body: JSON.stringify(config),
        })
      );
    }

    async listDockerDeployments(
      nodeId: string,
      params?: DockerListQuery & AppMemberListFilter
    ): Promise<DockerDeployment[]> {
      return withDockerListMeta(
        await this.request<DockerListEnvelope<DockerDeployment>>(
          `/docker/nodes/${nodeId}/deployments${dockerListQuery(params)}`
        )
      );
    }

    async getDockerDeployment(nodeId: string, deploymentId: string): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}`
        )
      );
    }

    async getDockerDeploymentByName(nodeId: string, name: string): Promise<DockerDeployment> {
      return this.unwrapData(
        this.requestRouteContext<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/by-name/${encodeURIComponent(name)}`
        )
      );
    }

    async createDockerDeployment(
      nodeId: string,
      config: Record<string, unknown>
    ): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(`/docker/nodes/${nodeId}/deployments`, {
          method: "POST",
          body: JSON.stringify(config),
        })
      );
    }

    async updateDockerDeployment(
      nodeId: string,
      deploymentId: string,
      config: Record<string, unknown>
    ): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}`,
          { method: "PUT", body: JSON.stringify(config) }
        )
      );
    }

    async deployDockerDeployment(
      nodeId: string,
      deploymentId: string,
      config: { image?: string; tag?: string; env?: Record<string, string> }
    ): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/deploy`,
          { method: "POST", body: JSON.stringify(config) }
        )
      );
    }

    async switchDockerDeployment(
      nodeId: string,
      deploymentId: string,
      slot: "blue" | "green",
      force = false
    ): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/switch`,
          { method: "POST", body: JSON.stringify({ slot, force }) }
        )
      );
    }

    async rollbackDockerDeployment(
      nodeId: string,
      deploymentId: string,
      force = false
    ): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/rollback`,
          { method: "POST", body: JSON.stringify({ force }) }
        )
      );
    }

    async stopDockerDeploymentSlot(
      nodeId: string,
      deploymentId: string,
      slot: "blue" | "green"
    ): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/deployments/${deploymentId}/slots/${slot}/stop`,
        { method: "POST" }
      );
    }

    async startDockerDeployment(nodeId: string, deploymentId: string): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/start`,
          { method: "POST" }
        )
      );
    }

    async stopDockerDeployment(nodeId: string, deploymentId: string): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/stop`,
          { method: "POST" }
        )
      );
    }

    async restartDockerDeployment(nodeId: string, deploymentId: string): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/restart`,
          { method: "POST" }
        )
      );
    }

    async killDockerDeployment(nodeId: string, deploymentId: string): Promise<DockerDeployment> {
      return this.unwrapData(
        this.request<{ data: DockerDeployment }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/kill`,
          { method: "POST" }
        )
      );
    }

    async deleteDockerDeployment(nodeId: string, deploymentId: string): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/deployments/${deploymentId}`, {
        method: "DELETE",
      });
    }

    async getContainerHealthCheck(
      nodeId: string,
      containerName: string
    ): Promise<DockerHealthCheck> {
      return this.unwrapData(
        this.request<{ data: DockerHealthCheck }>(
          `/docker/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/health-check`
        )
      );
    }

    async updateContainerHealthCheck(
      nodeId: string,
      containerName: string,
      data: Partial<DockerHealthCheck>
    ): Promise<DockerHealthCheck> {
      return this.unwrapData(
        this.request<{ data: DockerHealthCheck }>(
          `/docker/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/health-check`,
          { method: "PUT", body: JSON.stringify(data) }
        )
      );
    }

    async testContainerHealthCheck(
      nodeId: string,
      containerName: string,
      data: Partial<DockerHealthCheck>
    ): Promise<{ ok: boolean; status: string; httpStatus?: number; responseMs?: number }> {
      return this.unwrapData(
        this.request<{
          data: { ok: boolean; status: string; httpStatus?: number; responseMs?: number };
        }>(
          `/docker/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/health-check/test`,
          { method: "POST", body: JSON.stringify(data) }
        )
      );
    }

    async getDeploymentHealthCheck(
      nodeId: string,
      deploymentId: string
    ): Promise<DockerHealthCheck> {
      return this.unwrapData(
        this.request<{ data: DockerHealthCheck }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/health-check`
        )
      );
    }

    async updateDeploymentHealthCheck(
      nodeId: string,
      deploymentId: string,
      data: Partial<DockerHealthCheck>
    ): Promise<DockerHealthCheck> {
      return this.unwrapData(
        this.request<{ data: DockerHealthCheck }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/health-check`,
          { method: "PUT", body: JSON.stringify(data) }
        )
      );
    }

    async testDeploymentHealthCheck(
      nodeId: string,
      deploymentId: string,
      data: Partial<DockerHealthCheck>
    ): Promise<{ ok: boolean; status: string; httpStatus?: number; responseMs?: number }> {
      return this.unwrapData(
        this.request<{
          data: { ok: boolean; status: string; httpStatus?: number; responseMs?: number };
        }>(`/docker/nodes/${nodeId}/deployments/${deploymentId}/health-check/test`, {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async startContainer(nodeId: string, containerId: string): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/containers/${containerId}/start`, {
        method: "POST",
      });
    }

    async stopContainer(
      nodeId: string,
      containerId: string,
      timeout?: number
    ): Promise<DockerContainerOperationPending | null> {
      return pendingContainerOperation(
        await this.request<{ data?: DockerContainerOperationPending }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/stop`,
          { method: "POST", body: JSON.stringify(timeout === undefined ? {} : { timeout }) }
        )
      );
    }

    async restartContainer(
      nodeId: string,
      containerId: string,
      timeout?: number
    ): Promise<DockerContainerOperationPending | null> {
      return pendingContainerOperation(
        await this.request<{ data?: DockerContainerOperationPending }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/restart`,
          { method: "POST", body: JSON.stringify(timeout === undefined ? {} : { timeout }) }
        )
      );
    }

    async killContainer(
      nodeId: string,
      containerId: string,
      signal = "SIGKILL"
    ): Promise<DockerContainerOperationPending | null> {
      return pendingContainerOperation(
        await this.request<{ data?: DockerContainerOperationPending }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/kill`,
          { method: "POST", body: JSON.stringify({ signal }) }
        )
      );
    }

    async removeContainer(
      nodeId: string,
      containerId: string
    ): Promise<DockerContainerOperationPending | null> {
      return pendingContainerOperation(
        await this.request<{ data?: DockerContainerOperationPending }>(
          `/docker/nodes/${nodeId}/containers/${containerId}`,
          { method: "DELETE" }
        )
      );
    }

    async renameContainer(nodeId: string, containerId: string, name: string): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/containers/${containerId}/rename`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    }

    async duplicateContainer(
      nodeId: string,
      containerId: string,
      name: string,
      folderId?: string | null
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/duplicate`,
          { method: "POST", body: JSON.stringify({ name, folderId }) }
        )
      );
    }

    containerArchiveDownloadUrl(
      nodeId: string,
      containerId: string,
      includeWritableLayer = false,
      imageMode: "portable" | "registry" = "portable",
      includeSecrets = false,
      includeEnvironment = true
    ): string {
      const query = new URLSearchParams({
        includeWritableLayer: String(includeWritableLayer),
        imageMode,
        includeSecrets: String(includeSecrets),
        includeEnvironment: String(includeEnvironment),
      });
      return `${API_BASE}/docker/nodes/${nodeId}/containers/${containerId}/archive?${query}`;
    }

    async downloadContainerArchive(
      nodeId: string,
      containerId: string,
      includeWritableLayer = false,
      imageMode: "portable" | "registry" = "portable",
      includeSecrets = false,
      includeEnvironment = true,
      onProgress?: (progress: { loaded: number; total: number }) => void
    ): Promise<Blob> {
      const bytes = await this.requestBinary(
        this.containerArchiveDownloadUrl(
          nodeId,
          containerId,
          includeWritableLayer,
          imageMode,
          includeSecrets,
          includeEnvironment
        ),
        {},
        onProgress
      );
      return new Blob([bytes], { type: "application/vnd.wiolett.gwca" });
    }

    async importContainerArchive(
      nodeId: string,
      name: string,
      archive: File,
      resolution: {
        networks?: Record<string, string>;
        createNetworks?: string[];
        volumes?: Record<string, string>;
        createVolumes?: string[];
        ports?: Record<string, number>;
      } = {},
      folderId?: string,
      onProgress?: (progress: { loaded: number; total: number }) => void
    ): Promise<{ containerId: string; containerName: string; imageId: string }> {
      const query = new URLSearchParams({ name });
      if (folderId) query.set("folderId", folderId);
      if (Object.keys(resolution).length > 0) query.set("resolution", JSON.stringify(resolution));
      return this.unwrapData(
        this.uploadRaw<{
          data: { containerId: string; containerName: string; imageId: string };
        }>(`/docker/nodes/${nodeId}/containers/archive?${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/vnd.wiolett.gwca" },
          body: archive,
          onProgress,
        })
      );
    }

    async planContainerArchiveImport(
      nodeId: string,
      metadata: {
        networks: Array<{
          name: string;
          driver?: string;
          subnet?: string;
          gateway?: string;
          createable: boolean;
          createNew?: boolean;
          requiresMapping?: boolean;
        }>;
        mounts: Array<{
          type: "bind" | "volume";
          source: string;
          target: string;
          readOnly: boolean;
          driver?: string;
          labels?: Record<string, string>;
          createNew?: boolean;
          requiresMapping?: boolean;
        }>;
        ports: Array<{
          containerPort: number;
          hostPort: number;
          protocol: "tcp" | "udp";
        }>;
      }
    ): Promise<{
      networks: DockerNetwork[];
      volumes: DockerVolume[];
      resolution: {
        networks: Record<string, string>;
        createNetworks: string[];
        volumes: Record<string, string>;
        createVolumes: string[];
        ports: Record<string, number>;
      };
      conflictingPorts: string[];
    }> {
      return this.unwrapData(
        this.request<{
          data: {
            networks: DockerNetwork[];
            volumes: DockerVolume[];
            resolution: {
              networks: Record<string, string>;
              createNetworks: string[];
              volumes: Record<string, string>;
              createVolumes: string[];
              ports: Record<string, number>;
            };
            conflictingPorts: string[];
          };
        }>(`/docker/nodes/${nodeId}/containers/archive/plan`, {
          method: "POST",
          body: JSON.stringify(metadata),
        })
      );
    }

    async updateContainer(
      nodeId: string,
      containerId: string,
      config: { tag?: string; env?: Record<string, string>; removeEnv?: string[] }
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/update`,
          { method: "POST", body: JSON.stringify(config) }
        )
      );
    }

    async getContainerLogs(
      nodeId: string,
      containerId: string,
      params?: { tail?: number; timestamps?: boolean }
    ): Promise<string[]> {
      const qs = new URLSearchParams();
      if (params?.tail) qs.set("tail", String(params.tail));
      if (params?.timestamps) qs.set("timestamps", "true");
      const query = qs.toString();
      return this.unwrapData(
        this.request<{ data: string[] }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/logs${query ? `?${query}` : ""}`
        )
      );
    }

    async getContainerStats(nodeId: string, containerId: string): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/stats`
        )
      );
    }

    async getContainerTop(
      nodeId: string,
      containerId: string
    ): Promise<{
      Titles: string[];
      Processes: string[][];
      truncated?: boolean;
      totalProcesses?: number;
      limit?: number;
    }> {
      return this.unwrapData(
        this.request<{
          data: {
            Titles: string[];
            Processes: string[][];
            truncated?: boolean;
            totalProcesses?: number;
            limit?: number;
          };
        }>(`/docker/nodes/${nodeId}/containers/${containerId}/top`)
      );
    }

    async getContainerStatsHistory(
      nodeId: string,
      containerId: string
    ): Promise<Record<string, unknown>[]> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown>[] }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/stats/history`
        )
      );
    }

    async getContainerEnv(nodeId: string, containerId: string): Promise<string[]> {
      return this.unwrapData(
        this.request<{ data: string[] }>(`/docker/nodes/${nodeId}/containers/${containerId}/env`)
      );
    }

    async updateContainerEnv(
      nodeId: string,
      containerId: string,
      env: Record<string, string>,
      removeEnv?: string[]
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/env`,
          { method: "PUT", body: JSON.stringify({ env, removeEnv }) }
        )
      );
    }

    async liveUpdateContainer(
      nodeId: string,
      containerId: string,
      config: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/live-update`,
          { method: "POST", body: JSON.stringify(config) }
        )
      );
    }

    async recreateWithConfig(
      nodeId: string,
      containerId: string,
      config: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/recreate`,
          { method: "POST", body: JSON.stringify(config) }
        )
      );
    }

    // ── Docker Secrets ────────────────────────────────────────────────

    async listDockerSecrets(nodeId: string, containerId: string): Promise<DockerSecret[]> {
      return this.unwrapData(
        this.request<{ data: DockerSecret[] }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/secrets`
        )
      );
    }

    async createDockerSecret(
      nodeId: string,
      containerId: string,
      key: string,
      value: string
    ): Promise<DockerSecret> {
      return this.unwrapData(
        this.request<{ data: DockerSecret }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/secrets`,
          {
            method: "POST",
            body: JSON.stringify({ key, value }),
          }
        )
      );
    }

    async updateDockerSecret(
      nodeId: string,
      containerId: string,
      secretId: string,
      value: string
    ): Promise<DockerSecret> {
      return this.unwrapData(
        this.request<{ data: DockerSecret }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/secrets/${secretId}`,
          {
            method: "PUT",
            body: JSON.stringify({ value }),
          }
        )
      );
    }

    async deleteDockerSecret(nodeId: string, containerId: string, secretId: string): Promise<void> {
      await this.request(`/docker/nodes/${nodeId}/containers/${containerId}/secrets/${secretId}`, {
        method: "DELETE",
      });
    }

    async listDockerDeploymentSecrets(
      nodeId: string,
      deploymentId: string
    ): Promise<DockerSecret[]> {
      return this.unwrapData(
        this.request<{ data: DockerSecret[] }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/secrets`
        )
      );
    }

    async createDockerDeploymentSecret(
      nodeId: string,
      deploymentId: string,
      key: string,
      value: string
    ): Promise<DockerSecret> {
      return this.unwrapData(
        this.request<{ data: DockerSecret }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/secrets`,
          {
            method: "POST",
            body: JSON.stringify({ key, value }),
          }
        )
      );
    }

    async updateDockerDeploymentSecret(
      nodeId: string,
      deploymentId: string,
      secretId: string,
      value: string
    ): Promise<DockerSecret> {
      return this.unwrapData(
        this.request<{ data: DockerSecret }>(
          `/docker/nodes/${nodeId}/deployments/${deploymentId}/secrets/${secretId}`,
          {
            method: "PUT",
            body: JSON.stringify({ value }),
          }
        )
      );
    }

    async deleteDockerDeploymentSecret(
      nodeId: string,
      deploymentId: string,
      secretId: string
    ): Promise<void> {
      await this.request(
        `/docker/nodes/${nodeId}/deployments/${deploymentId}/secrets/${secretId}`,
        {
          method: "DELETE",
        }
      );
    }

    // ── Docker Images ─────────────────────────────────────────────────
  };
}
