import { type AppMemberListFilter, setAppMemberListParams } from "@/lib/app-members";
import type {
  DockerBuild,
  DockerBuildAdmissionStatus,
  DockerBuildLogChunk,
  DockerBuildSecret,
  DockerBuildSourceRepository,
  DockerBuildStatus,
  DockerComposeSourceProjectCreateResult,
  DockerImage,
  DockerInternalRegistrySettings,
  DockerInternalRegistryState,
  DockerNetwork,
  DockerRegistry,
  DockerRuntimeStatus,
  DockerSourceBinding,
  DockerSourceBindingConfig,
  DockerSourceConnector,
  DockerSourceResourceCreateRequest,
  DockerSourceResourceCreateResult,
  DockerSourceSyncResult,
  DockerSourceTarget,
  DockerTask,
  DockerVolume,
  FileEntry,
  Node,
  PagesBuildDiscovery,
} from "@/types";
import type { GitScopeTargetTruncation } from "@/types/integrations";
import { API_BASE } from "./api-base";
import type { ApiClientBaseConstructor } from "./api-mixins";

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

interface DockerBuildListParams extends AppMemberListFilter {
  sourceBindingId?: string;
  builderNodeId?: string;
  status?: DockerBuildStatus;
  provider?: "gitlab" | "github" | "git";
  branch?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

function dockerSourcePath(target: DockerSourceTarget): string {
  if (target.kind === "container") {
    return `/docker/nodes/${target.nodeId}/containers/${encodeURIComponent(target.containerName)}/source`;
  }
  if (target.kind === "deployment") {
    return `/docker/nodes/${target.nodeId ?? "_"}/deployments/${target.deploymentId}/source`;
  }
  if (target.kind === "pages_project") {
    return `/pages/projects/${target.pageProjectId}/source`;
  }
  return `/docker/nodes/${target.nodeId}/compose-projects/${target.composeProjectId}/source`;
}

type DockerListQuery = {
  search?: string;
};

function dockerListQuery(params?: DockerListQuery & { noCache?: boolean }) {
  const query = new URLSearchParams();
  if (params?.search?.trim()) query.set("search", params.search.trim());
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

export function withDockerResourceApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class DockerResourceApiClient extends Base {
    async listDockerImages(nodeId: string, params?: DockerListQuery): Promise<DockerImage[]> {
      return withDockerListMeta(
        await this.request<DockerListEnvelope<DockerImage>>(
          `/docker/nodes/${nodeId}/images${dockerListQuery(params)}`
        )
      );
    }

    async listDockerImageSnapshots(params?: DockerListQuery & { nodeId?: string }) {
      const query = dockerListQuery(params);
      const separator = query ? "&" : "?";
      const nodeId = params?.nodeId
        ? `${separator}nodeId=${encodeURIComponent(params.nodeId)}`
        : "";
      return withSnapshotNodeMeta(
        await this.request<DockerListEnvelope<DockerImage>>(`/docker/images${query}${nodeId}`)
      );
    }

    async pullImage(
      nodeId: string,
      imageRef: string,
      registryId?: string,
      folderId?: string
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(`/docker/nodes/${nodeId}/images/pull`, {
          method: "POST",
          body: JSON.stringify({ imageRef, registryId, folderId }),
        })
      );
    }

    async removeImage(nodeId: string, imageId: string): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/images/${encodeURIComponent(imageId)}`, {
        method: "DELETE",
      });
    }

    async pruneImages(nodeId: string): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(`/docker/nodes/${nodeId}/images/prune`, {
          method: "POST",
        })
      );
    }

    // ── Docker Volumes ────────────────────────────────────────────────

    async listDockerVolumes(nodeId: string, params?: DockerListQuery): Promise<DockerVolume[]> {
      return withDockerListMeta(
        await this.request<DockerListEnvelope<DockerVolume>>(
          `/docker/nodes/${nodeId}/volumes${dockerListQuery(params)}`
        )
      );
    }

    async listDockerVolumeSnapshots(params?: DockerListQuery & { nodeId?: string }) {
      const query = dockerListQuery(params);
      const separator = query ? "&" : "?";
      const nodeId = params?.nodeId
        ? `${separator}nodeId=${encodeURIComponent(params.nodeId)}`
        : "";
      return withSnapshotNodeMeta(
        await this.request<DockerListEnvelope<DockerVolume>>(`/docker/volumes${query}${nodeId}`)
      );
    }

    async inspectDockerVolume(nodeId: string, name: string): Promise<DockerVolume> {
      return this.unwrapData(
        this.request<{ data: DockerVolume }>(
          `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}`
        )
      );
    }

    async resolveDockerVolumeByName(nodeId: string, name: string): Promise<DockerVolume> {
      return this.unwrapData(
        this.requestRouteContext<{ data: DockerVolume }>(
          `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}`
        )
      );
    }

    async listVolumeDir(nodeId: string, name: string, path: string): Promise<FileEntry[]> {
      const response = await this.request<DockerListEnvelope<FileEntry>>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`
      );
      return withDockerListMeta(response);
    }

    async readVolumeFile(nodeId: string, name: string, path: string): Promise<ArrayBuffer> {
      return this.requestBinary(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/read?path=${encodeURIComponent(path)}`
      );
    }

    async writeVolumeFile(nodeId: string, name: string, path: string, content: string) {
      const encoded = new TextEncoder().encode(content);
      return this.unwrapData(
        this.uploadRaw<{ data: unknown }>(
          `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/write?path=${encodeURIComponent(path)}`,
          {
            method: "PUT",
            body: encoded,
            headers: { "Content-Type": "application/octet-stream" },
          }
        )
      );
    }

    async createVolumeFile(
      nodeId: string,
      name: string,
      path: string,
      content: Blob | BufferSource | string = "",
      onProgress?: (progress: { loaded: number; total: number }) => void
    ) {
      const body =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content instanceof Blob
            ? content
            : content;
      return this.uploadRaw<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/create?path=${encodeURIComponent(path)}`,
        {
          method: "POST",
          body,
          headers: { "Content-Type": "application/octet-stream" },
          onProgress,
        }
      );
    }

    async initVolumeFileUpload(
      nodeId: string,
      name: string,
      path: string,
      totalBytes: number
    ): Promise<{ uploadId: string; chunkSize: number }> {
      return this.unwrapData(
        this.request<{ data: { uploadId: string; chunkSize: number } }>(
          `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/uploads`,
          {
            method: "POST",
            body: JSON.stringify({ path, totalBytes }),
          }
        )
      );
    }

    async uploadVolumeFileChunk(
      nodeId: string,
      name: string,
      uploadId: string,
      offset: number,
      content: Blob,
      onProgress?: (progress: { loaded: number; total: number }) => void
    ): Promise<{ receivedBytes: number; totalBytes: number }> {
      return this.unwrapData(
        this.uploadRaw<{ data: { receivedBytes: number; totalBytes: number } }>(
          `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/uploads/${uploadId}/chunks?offset=${offset}`,
          {
            method: "PUT",
            body: content,
            headers: { "Content-Type": "application/octet-stream" },
            onProgress,
          }
        )
      );
    }

    async completeVolumeFileUpload(
      nodeId: string,
      name: string,
      uploadId: string,
      path: string,
      totalBytes: number
    ): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/uploads/${uploadId}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ path, totalBytes }),
        }
      );
    }

    async abortVolumeFileUpload(nodeId: string, name: string, uploadId: string): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/uploads/${uploadId}`,
        { method: "DELETE" }
      );
    }

    async createVolumeDirectory(nodeId: string, name: string, path: string) {
      return this.request<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/directory`,
        {
          method: "POST",
          body: JSON.stringify({ path }),
        }
      );
    }

    async deleteVolumeFile(nodeId: string, name: string, path: string) {
      return this.request<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`,
        { method: "DELETE" }
      );
    }

    async moveVolumeFile(nodeId: string, name: string, fromPath: string, toPath: string) {
      return this.request<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/files/move`,
        {
          method: "POST",
          body: JSON.stringify({ fromPath, toPath }),
        }
      );
    }

    async exportDockerVolume(nodeId: string, name: string): Promise<Blob> {
      const response = await fetch(
        `${API_BASE}/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/export`,
        { headers: this.getHeaders() }
      );
      if (!response.ok) throw new Error("Failed to export volume");
      return response.blob();
    }

    async createVolume(
      nodeId: string,
      config: {
        name: string;
        storageKind?: "regular" | "disk-image";
        capacityBytes?: number;
        folderId?: string;
      }
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(`/docker/nodes/${nodeId}/volumes`, {
          method: "POST",
          body: JSON.stringify(config),
        })
      );
    }

    async getVolumeMetrics(
      nodeId: string,
      name: string
    ): Promise<import("@/types").DockerVolumeMetrics> {
      return this.unwrapData(
        this.request<{ data: import("@/types").DockerVolumeMetrics }>(
          `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/metrics`
        )
      );
    }

    async resizeVolume(nodeId: string, name: string, capacityBytes: number): Promise<void> {
      await this.request(`/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/resize`, {
        method: "POST",
        body: JSON.stringify({ capacityBytes }),
      });
    }

    async listManagedVolumeOptions(nodeId: string): Promise<Array<{ name: string }>> {
      return this.unwrapData(
        this.request<{ data: Array<{ name: string }> }>(`/docker/nodes/${nodeId}/managed-volumes`)
      );
    }

    async adoptVolume(nodeId: string, name: string): Promise<void> {
      await this.request(`/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/adopt`, {
        method: "POST",
      });
    }

    async preflightDockerRuntime(nodeId: string): Promise<DockerRuntimeStatus> {
      return this.unwrapData(
        this.request<{ data: DockerRuntimeStatus }>(
          `/docker/nodes/${nodeId}/runtime/runsc/preflight`,
          {
            method: "POST",
          }
        )
      );
    }

    async installDockerRuntime(nodeId: string): Promise<DockerRuntimeStatus> {
      return this.unwrapData(
        this.request<{ data: DockerRuntimeStatus }>(
          `/docker/nodes/${nodeId}/runtime/runsc/install`,
          {
            method: "POST",
          }
        )
      );
    }

    async removeVolume(nodeId: string, name: string): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    }

    async renameVolume(nodeId: string, name: string, newName: string): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/rename`,
        {
          method: "POST",
          body: JSON.stringify({ name: newName }),
        }
      );
    }

    async updateVolumeLabels(
      nodeId: string,
      name: string,
      labels: Record<string, string>
    ): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/volumes/${encodeURIComponent(name)}/labels`,
        {
          method: "PUT",
          body: JSON.stringify({ labels }),
        }
      );
    }

    // ── Docker Networks ───────────────────────────────────────────────

    async listDockerNetworks(nodeId: string, params?: DockerListQuery): Promise<DockerNetwork[]> {
      return withDockerListMeta(
        await this.request<DockerListEnvelope<DockerNetwork>>(
          `/docker/nodes/${nodeId}/networks${dockerListQuery(params)}`
        )
      );
    }

    async listDockerNetworkSnapshots(params?: DockerListQuery & { nodeId?: string }) {
      const query = dockerListQuery(params);
      const separator = query ? "&" : "?";
      const nodeId = params?.nodeId
        ? `${separator}nodeId=${encodeURIComponent(params.nodeId)}`
        : "";
      return withSnapshotNodeMeta(
        await this.request<DockerListEnvelope<DockerNetwork>>(`/docker/networks${query}${nodeId}`)
      );
    }

    async refreshDockerSnapshots(input: {
      nodeId?: string;
      resource:
        | "containers"
        | "images"
        | "volumes"
        | "networks"
        | "container-detail"
        | "volume-detail"
        | "volume-metrics";
      key?: string;
    }): Promise<void> {
      await this.request<void>("/docker/snapshots/refresh", {
        method: "POST",
        body: JSON.stringify(input),
      });
    }

    async createNetwork(
      nodeId: string,
      config: {
        name: string;
        driver?: string;
        subnet?: string;
        gateway?: string;
        folderId?: string | null;
      }
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(`/docker/nodes/${nodeId}/networks`, {
          method: "POST",
          body: JSON.stringify(config),
        })
      );
    }

    async removeNetwork(nodeId: string, networkId: string): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/networks/${networkId}`, {
        method: "DELETE",
      });
    }

    async connectContainerToNetwork(
      nodeId: string,
      networkId: string,
      containerId: string
    ): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/networks/${networkId}/connect`, {
        method: "POST",
        body: JSON.stringify({ containerId }),
      });
    }

    async disconnectContainerFromNetwork(
      nodeId: string,
      networkId: string,
      containerId: string
    ): Promise<void> {
      await this.request<void>(`/docker/nodes/${nodeId}/networks/${networkId}/disconnect`, {
        method: "POST",
        body: JSON.stringify({ containerId }),
      });
    }

    // ── Docker File Browser ───────────────────────────────────────────

    async listContainerDir(
      nodeId: string,
      containerId: string,
      path: string
    ): Promise<FileEntry[]> {
      const response = await this.request<DockerListEnvelope<FileEntry>>(
        `/docker/nodes/${nodeId}/containers/${containerId}/files?path=${encodeURIComponent(path)}`
      );
      return withDockerListMeta(response);
    }

    async readContainerFile(
      nodeId: string,
      containerId: string,
      path: string
    ): Promise<ArrayBuffer> {
      return this.requestBinary(
        `/docker/nodes/${nodeId}/containers/${containerId}/files/read?path=${encodeURIComponent(path)}`
      );
    }

    async writeContainerFile(nodeId: string, containerId: string, path: string, content: string) {
      const encoded = new TextEncoder().encode(content);
      return this.unwrapData(
        this.uploadRaw<{ data: unknown }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/files/write?path=${encodeURIComponent(path)}`,
          {
            method: "PUT",
            body: encoded,
            headers: { "Content-Type": "application/octet-stream" },
          }
        )
      );
    }

    async createContainerFile(
      nodeId: string,
      containerId: string,
      path: string,
      content: Blob | BufferSource | string = "",
      onProgress?: (progress: { loaded: number; total: number }) => void
    ) {
      const body =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content instanceof Blob
            ? content
            : content;
      return this.uploadRaw<void>(
        `/docker/nodes/${nodeId}/containers/${containerId}/files/create?path=${encodeURIComponent(path)}`,
        {
          method: "POST",
          body,
          headers: { "Content-Type": "application/octet-stream" },
          onProgress,
        }
      );
    }

    async initContainerFileUpload(
      nodeId: string,
      containerId: string,
      path: string,
      totalBytes: number
    ): Promise<{ uploadId: string; chunkSize: number }> {
      return this.unwrapData(
        this.request<{ data: { uploadId: string; chunkSize: number } }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/files/uploads`,
          {
            method: "POST",
            body: JSON.stringify({ path, totalBytes }),
          }
        )
      );
    }

    async uploadContainerFileChunk(
      nodeId: string,
      containerId: string,
      uploadId: string,
      offset: number,
      content: Blob,
      onProgress?: (progress: { loaded: number; total: number }) => void
    ): Promise<{ receivedBytes: number; totalBytes: number }> {
      return this.unwrapData(
        this.uploadRaw<{ data: { receivedBytes: number; totalBytes: number } }>(
          `/docker/nodes/${nodeId}/containers/${containerId}/files/uploads/${uploadId}/chunks?offset=${offset}`,
          {
            method: "PUT",
            body: content,
            headers: { "Content-Type": "application/octet-stream" },
            onProgress,
          }
        )
      );
    }

    async completeContainerFileUpload(
      nodeId: string,
      containerId: string,
      uploadId: string,
      path: string,
      totalBytes: number
    ): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/containers/${containerId}/files/uploads/${uploadId}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ path, totalBytes }),
        }
      );
    }

    async abortContainerFileUpload(
      nodeId: string,
      containerId: string,
      uploadId: string
    ): Promise<void> {
      await this.request<void>(
        `/docker/nodes/${nodeId}/containers/${containerId}/files/uploads/${uploadId}`,
        { method: "DELETE" }
      );
    }

    async createContainerDirectory(nodeId: string, containerId: string, path: string) {
      return this.request<void>(
        `/docker/nodes/${nodeId}/containers/${containerId}/files/directory`,
        {
          method: "POST",
          body: JSON.stringify({ path }),
        }
      );
    }

    async deleteContainerFile(nodeId: string, containerId: string, path: string) {
      return this.request<void>(
        `/docker/nodes/${nodeId}/containers/${containerId}/files?path=${encodeURIComponent(path)}`,
        { method: "DELETE" }
      );
    }

    async moveContainerFile(nodeId: string, containerId: string, fromPath: string, toPath: string) {
      return this.request<void>(`/docker/nodes/${nodeId}/containers/${containerId}/files/move`, {
        method: "POST",
        body: JSON.stringify({ fromPath, toPath }),
      });
    }

    // ── Docker Registries ─────────────────────────────────────────────

    async listDockerRegistries(): Promise<DockerRegistry[]> {
      return this.unwrapData(this.request<{ data: DockerRegistry[] }>("/docker/registries"));
    }

    async createRegistry(config: {
      name: string;
      url: string;
      username?: string;
      password?: string;
      trustedAuthRealm?: string;
      scope?: string;
      nodeId?: string;
    }): Promise<DockerRegistry> {
      return this.unwrapData(
        this.request<{ data: DockerRegistry }>("/docker/registries", {
          method: "POST",
          body: JSON.stringify(config),
        })
      );
    }

    async updateRegistry(
      id: string,
      config: Partial<{
        name: string;
        url: string;
        username?: string;
        password?: string;
        trustedAuthRealm?: string;
        scope?: string;
        nodeId?: string;
      }>
    ): Promise<DockerRegistry> {
      return this.unwrapData(
        this.request<{ data: DockerRegistry }>(`/docker/registries/${id}`, {
          method: "PUT",
          body: JSON.stringify(config),
        })
      );
    }

    async deleteRegistry(id: string): Promise<void> {
      await this.request<void>(`/docker/registries/${id}`, { method: "DELETE" });
    }

    async testRegistry(id: string): Promise<{ ok: boolean; error?: string }> {
      const result = await this.unwrapData(
        this.request<{
          data: { success?: boolean; ok?: boolean; error?: string; statusText?: string };
        }>(`/docker/registries/${id}/test`, { method: "POST" })
      );
      return { ok: result.success ?? result.ok ?? false, error: result.error || result.statusText };
    }

    async testRegistryDirect(creds: {
      url: string;
      username?: string;
      password?: string;
      trustedAuthRealm?: string;
    }): Promise<{ ok: boolean; error?: string }> {
      const result = await this.unwrapData(
        this.request<{ data: { success?: boolean; error?: string; statusText?: string } }>(
          `/docker/registries/test`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(creds),
          }
        )
      );
      return { ok: result.success ?? false, error: result.error || result.statusText };
    }

    // ── Docker Tasks ──────────────────────────────────────────────────

    async listDockerTasks(params?: {
      nodeId?: string;
      status?: string;
      type?: string;
    }): Promise<DockerTask[]> {
      const qs = new URLSearchParams();
      if (params?.nodeId) qs.set("nodeId", params.nodeId);
      if (params?.status) qs.set("status", params.status);
      if (params?.type) qs.set("type", params.type);
      const query = qs.toString();
      return this.unwrapData(
        this.request<{ data: DockerTask[] }>(`/docker/tasks${query ? `?${query}` : ""}`)
      );
    }

    async getDockerTask(id: string): Promise<DockerTask> {
      return this.unwrapData(this.request<{ data: DockerTask }>(`/docker/tasks/${id}`));
    }

    async forceCancelDockerTask(id: string): Promise<DockerTask> {
      return this.unwrapData(
        this.request<{ data: DockerTask }>(`/docker/tasks/${id}/force-cancel`, {
          method: "POST",
        })
      );
    }

    // ── Docker Git sources and builds ─────────────────────────────────

    async listDockerBuildPage(
      params?: DockerBuildListParams
    ): Promise<{ data: DockerBuild[]; nextCursor: string | null }> {
      const query = new URLSearchParams();
      if (params?.sourceBindingId) query.set("sourceBindingId", params.sourceBindingId);
      if (params?.builderNodeId) query.set("builderNodeId", params.builderNodeId);
      if (params?.status) query.set("status", params.status);
      if (params?.provider) query.set("provider", params.provider);
      if (params?.branch) query.set("branch", params.branch);
      if (params?.search) query.set("search", params.search);
      if (params?.cursor) query.set("cursor", params.cursor);
      setAppMemberListParams(query, params);
      query.set("limit", String(params?.limit ?? 100));
      return this.request<{ data: DockerBuild[]; nextCursor: string | null }>(
        `/docker/builds?${query.toString()}`
      );
    }

    async listDockerBuilds(params?: DockerBuildListParams): Promise<DockerBuild[]> {
      return (await this.listDockerBuildPage(params)).data;
    }

    async getDockerBuild(buildId: string): Promise<DockerBuild> {
      return this.unwrapData(
        this.request<{ data: DockerBuild }>(`/docker/builds/${encodeURIComponent(buildId)}`)
      );
    }

    async getDockerBuildLogs(buildId: string): Promise<DockerBuildLogChunk[]> {
      const pageSize = 500;
      const chunks: DockerBuildLogChunk[] = [];
      // A full page means more chunks may follow: page on until a short one, so a long build is not cut short.
      for (let page = 0; page < 200; page++) {
        const afterSequence = chunks.length > 0 ? chunks[chunks.length - 1]!.sequence : -1;
        const next = await this.unwrapData(
          this.request<{ data: DockerBuildLogChunk[] }>(
            `/docker/builds/${buildId}/logs?limit=${pageSize}&afterSequence=${afterSequence}`
          )
        );
        chunks.push(...next);
        if (next.length < pageSize) break;
      }
      return chunks;
    }

    async cancelDockerBuild(buildId: string): Promise<DockerBuild> {
      return this.unwrapData(
        this.request<{ data: DockerBuild }>(`/docker/builds/${buildId}/cancel`, { method: "POST" })
      );
    }

    async retryDockerBuild(buildId: string): Promise<DockerBuild> {
      return this.unwrapData(
        this.request<{ data: DockerBuild }>(`/docker/builds/${buildId}/retry`, { method: "POST" })
      );
    }

    /** Git connectors for every source picker (Docker workloads and Pages builds); no integration scope needed. */
    async listDockerSourceConnectors(): Promise<DockerSourceConnector[]> {
      return this.unwrapData(
        this.request<{ data: DockerSourceConnector[] }>("/docker/sources/connectors")
      );
    }

    /**
     * Repositories a source can be built from. `search` finds repositories past the GitHub
     * listing bound; `truncated` says the list is cut and the search should be refined.
     * `refreshing` says the server answered with its last list while it reloads it;
     * `awaitRefresh` asks for the reloaded list.
     */
    async listDockerBuildRepositories(
      connectorId: string,
      target?: DockerSourceTarget,
      search?: string,
      options?: { awaitRefresh?: boolean }
    ): Promise<{
      repositories: DockerBuildSourceRepository[];
      truncated?: GitScopeTargetTruncation;
      refreshing?: boolean;
    }> {
      const base =
        target?.kind === "pages_project"
          ? `/pages/projects/${target.pageProjectId}/source/connectors/${connectorId}/repositories`
          : `/docker/sources/connectors/${connectorId}/repositories`;
      const params = new URLSearchParams();
      if (search?.trim()) params.set("search", search.trim());
      if (options?.awaitRefresh) params.set("awaitRefresh", "true");
      const query = params.size ? `?${params.toString()}` : "";
      const response = await this.request<{
        data: DockerBuildSourceRepository[];
        truncated?: GitScopeTargetTruncation;
        refreshing?: boolean;
      }>(`${base}${query}`);
      return {
        repositories: response?.data ?? [],
        truncated: response?.truncated,
        refreshing: response?.refreshing === true,
      };
    }

    async discoverPagesBuild(
      pageProjectId: string,
      input: { connectorId: string; projectId: string; branch: string; applicationRoot: string }
    ): Promise<PagesBuildDiscovery> {
      return this.unwrapData(
        this.request<{ data: PagesBuildDiscovery }>(
          `/pages/projects/${pageProjectId}/source/discovery`,
          { method: "POST", body: JSON.stringify(input) }
        )
      );
    }

    async getDockerSource(target: DockerSourceTarget): Promise<DockerSourceBinding | null> {
      return this.unwrapData(
        this.request<{ data: DockerSourceBinding | null }>(dockerSourcePath(target))
      );
    }

    async getPendingDockerSourceContainer(nodeId: string, containerName: string) {
      return this.unwrapData(
        this.request<{
          data: {
            pendingSourceBuild: true;
            nodeId: string;
            containerName: string;
            sourceBindingId: string;
            scopeResourceId: string;
            repositoryFullPath?: string;
            latestBuild?: { id: string; status: string; errorCode: string | null } | null;
          };
        }>(`/docker/nodes/${nodeId}/containers/${encodeURIComponent(containerName)}/source/pending`)
      );
    }

    async upsertDockerSource(
      target: DockerSourceTarget,
      config: DockerSourceBindingConfig
    ): Promise<DockerSourceBinding> {
      return this.unwrapData(
        this.request<{ data: DockerSourceBinding }>(dockerSourcePath(target), {
          method: "PUT",
          body: JSON.stringify(config),
        })
      );
    }

    async removeDockerSource(target: DockerSourceTarget): Promise<void> {
      await this.request<{ success: true; removed: boolean }>(dockerSourcePath(target), {
        method: "DELETE",
      });
    }

    async listDockerBuildSecrets(target: DockerSourceTarget): Promise<DockerBuildSecret[]> {
      const path = `${dockerSourcePath(target)}/build-secrets`;
      return this.unwrapData(this.request<{ data: DockerBuildSecret[] }>(path));
    }

    async upsertDockerBuildSecret(
      target: DockerSourceTarget,
      name: string,
      value: string
    ): Promise<DockerBuildSecret> {
      const base = `${dockerSourcePath(target)}/build-secrets`;
      return this.unwrapData(
        this.request<{ data: DockerBuildSecret }>(`${base}/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: JSON.stringify({ value }),
        })
      );
    }

    async deleteDockerBuildSecret(target: DockerSourceTarget, name: string): Promise<void> {
      const base = `${dockerSourcePath(target)}/build-secrets`;
      await this.request(`${base}/${encodeURIComponent(name)}`, { method: "DELETE" });
    }

    async createDockerSourceBuild(
      target: DockerSourceTarget,
      input: { commitSha?: string; force?: boolean } = {}
    ): Promise<DockerBuild> {
      const path = `${dockerSourcePath(target)}/builds`;
      const result = await this.unwrapData(
        this.request<{ data: { build: DockerBuild; created: boolean } }>(path, {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
      return result.build;
    }

    /**
     * Checks the source branch for new commits now instead of waiting for the next poll or webhook,
     * and queues the automatic build of a new head when the source builds automatically.
     */
    async syncDockerSource(target: DockerSourceTarget): Promise<DockerSourceSyncResult> {
      return this.unwrapData(
        this.request<{ data: DockerSourceSyncResult }>(`${dockerSourcePath(target)}/sync`, {
          method: "POST",
        })
      );
    }

    async createDockerSourceResource(
      nodeId: string,
      input: DockerSourceResourceCreateRequest
    ): Promise<DockerSourceResourceCreateResult> {
      return this.unwrapData(
        this.request<{ data: DockerSourceResourceCreateResult }>(
          `/docker/nodes/${nodeId}/source-resources`,
          {
            method: "POST",
            body: JSON.stringify(input),
          }
        )
      );
    }

    async createDockerComposeSourceProject(
      nodeId: string,
      input: { projectName: string; source: DockerSourceBindingConfig; folderId?: string | null }
    ): Promise<DockerComposeSourceProjectCreateResult> {
      return this.unwrapData(
        this.request<{ data: DockerComposeSourceProjectCreateResult }>(
          `/docker/nodes/${nodeId}/compose-projects/from-source`,
          {
            method: "POST",
            body: JSON.stringify(input),
          }
        )
      );
    }

    async getDockerBuildAdmission(nodeId: string): Promise<DockerBuildAdmissionStatus> {
      return this.unwrapData(
        this.request<{ data: DockerBuildAdmissionStatus }>(
          `/docker/nodes/${nodeId}/source-resources/admission`
        )
      );
    }

    async getDockerInternalRegistryState(): Promise<DockerInternalRegistryState> {
      return this.unwrapData(
        this.request<{ data: DockerInternalRegistryState }>("/docker/registries/internal/state")
      );
    }

    async listDockerInternalRegistryRepositories(): Promise<string[]> {
      return this.unwrapData(
        this.request<{ data: string[] }>("/docker/registries/internal/repositories")
      );
    }

    async updateDockerInternalRegistrySettings(
      settings: DockerInternalRegistrySettings
    ): Promise<DockerInternalRegistryState> {
      return this.unwrapData(
        this.request<{ data: DockerInternalRegistryState }>(
          "/docker/registries/internal/settings",
          {
            method: "PUT",
            body: JSON.stringify(settings),
          }
        )
      );
    }

    // ── Docker Exec WebSocket ─────────────────────────────────────────

    createExecWebSocket(nodeId: string, containerId: string, shell = "/bin/sh"): WebSocket {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/docker/nodes/${nodeId}/containers/${containerId}/exec?shell=${encodeURIComponent(shell)}`;
      return new WebSocket(url);
    }

    // ── Node Console WebSocket ─────────────────────────────────────

    createNodeExecWebSocket(nodeId: string, shell = "auto"): WebSocket {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/nodes/${nodeId}/exec?shell=${encodeURIComponent(shell)}`;
      return new WebSocket(url);
    }

    // ── Docker Log Stream WebSocket ─────────────────────────────────

    createLogStreamWebSocket(nodeId: string, containerId: string, tail = 100): WebSocket {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/docker/nodes/${nodeId}/containers/${containerId}/logs/stream?tail=${tail}`;
      return new WebSocket(url);
    }
  };
}
