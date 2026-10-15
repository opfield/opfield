import { setAppMemberListParams } from "@/lib/app-members";
import {
  INFERENCE_SELF_USAGE_CACHE_KEY,
  publishInferenceSelfUsage,
} from "@/lib/inference-self-usage";
import type {
  AccessList,
  ConfigurePageProfileRequest,
  CreateAccessListRequest,
  CreateDomainRequest,
  CreatePageDeployTokenRequest,
  CreatePageProjectRequest,
  DashboardBootstrap,
  DashboardBootstrapRequest,
  DashboardStats,
  DeleteDomainRequest,
  DnsStatus,
  Domain,
  DomainSearchResult,
  DomainWithUsage,
  LinkInternalCertRequest,
  NginxTemplate,
  PageDeployment,
  PageDeploymentUploadCreated,
  PageDeployToken,
  PageDeployTokenCreated,
  PageProfile,
  PageProfileOptions,
  PageProject,
  PageProjectFolderTreeNode,
  PageProjectPlacementOption,
  PageProjectPreviewRotation,
  PageRuntimeConfigRecord,
  PageRuntimeConfigsResponse,
  PageTag,
  PageTagMoveResult,
  PaginatedResponse,
  ProxyHost,
  ProxyHostFolder,
  RequestACMECertRequest,
  SSLCertificate,
  SSLCertificateOperationResult,
  SSLCertStatus,
  SSLCertType,
  TemplateVariableDef,
  UpdateDomainRequest,
  UpdatePageProjectRequest,
  UpdatePageRuntimeConfigRequest,
  UploadCertRequest,
} from "@/types";
import { API_BASE } from "./api-base";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withPagesDomainsApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class PagesDomainsApiClient extends Base {
    async listPageProjects(params?: {
      page?: number;
      limit?: number;
      search?: string;
      folderId?: string | null;
      /** App members: see `AppMemberListFilter`. */
      excludeAppMembers?: boolean;
      appId?: string;
    }): Promise<PaginatedResponse<PageProject>> {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set("page", String(params.page));
      if (params?.limit) searchParams.set("limit", String(params.limit));
      if (params?.search) searchParams.set("search", params.search);
      if (params?.folderId !== undefined) {
        if (params.folderId !== null) searchParams.set("folderId", params.folderId);
        else searchParams.set("folderId", "");
      }
      setAppMemberListParams(searchParams, params);
      const query = searchParams.toString();
      return this.request<PaginatedResponse<PageProject>>(`/pages${query ? `?${query}` : ""}`);
    }

    async getPageProject(id: string): Promise<PageProject> {
      return this.unwrapData(this.request<{ data: PageProject }>(`/pages/${id}`));
    }

    async getPageProjectBySlug(slug: string): Promise<PageProject> {
      return this.unwrapData(
        this.request<{ data: PageProject }>(`/pages/by-slug/${encodeURIComponent(slug)}`)
      );
    }

    async createPageProject(data: CreatePageProjectRequest): Promise<PageProject> {
      const project = await this.unwrapData(
        this.request<{ data: PageProject }>("/pages", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
      this.invalidateCache("pages:");
      return project;
    }

    /** Nodes a Project can be placed on; `folderId` in an app environment lists only the nodes it allows. */
    async listPageProjectPlacementOptions(
      folderId?: string | null
    ): Promise<PageProjectPlacementOption[]> {
      const query = folderId ? `?folderId=${encodeURIComponent(folderId)}` : "";
      return this.unwrapData(
        this.request<{ data: PageProjectPlacementOption[] }>(`/pages/placement-options${query}`)
      );
    }

    async migratePageProject(id: string, targetNodeId: string): Promise<PageProject> {
      const project = await this.unwrapData(
        this.request<{ data: PageProject }>(`/pages/${id}/migrate`, {
          method: "POST",
          body: JSON.stringify({ targetNodeId }),
        })
      );
      this.invalidateCache("pages:");
      return project;
    }

    async updatePageProject(id: string, data: UpdatePageProjectRequest): Promise<PageProject> {
      const project = await this.unwrapData(
        this.request<{ data: PageProject }>(`/pages/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
      this.invalidateCache("pages:");
      return project;
    }

    async rotatePagePreviewHash(id: string): Promise<PageProjectPreviewRotation> {
      const result = await this.unwrapData(
        this.request<{ data: PageProjectPreviewRotation }>(`/pages/${id}/preview-hash/rotate`, {
          method: "POST",
        })
      );
      this.invalidateCache("pages:");
      return result;
    }

    async getPageRuntimeConfigs(projectId: string): Promise<PageRuntimeConfigsResponse> {
      return this.unwrapData(
        this.request<{ data: PageRuntimeConfigsResponse }>(`/pages/${projectId}/runtime-configs`)
      );
    }

    async updatePageRuntimeConfigDefault(
      projectId: string,
      data: UpdatePageRuntimeConfigRequest
    ): Promise<PageRuntimeConfigRecord> {
      const config = await this.unwrapData(
        this.request<{ data: PageRuntimeConfigRecord }>(
          `/pages/${projectId}/runtime-configs/default`,
          {
            method: "PUT",
            body: JSON.stringify(data),
          }
        )
      );
      this.invalidateCache("pages:");
      return config;
    }

    async updatePageRuntimeConfigTag(
      projectId: string,
      tagId: string,
      data: UpdatePageRuntimeConfigRequest
    ): Promise<PageRuntimeConfigRecord> {
      const config = await this.unwrapData(
        this.request<{ data: PageRuntimeConfigRecord }>(
          `/pages/${projectId}/runtime-configs/tags/${tagId}`,
          {
            method: "PUT",
            body: JSON.stringify(data),
          }
        )
      );
      this.invalidateCache("pages:");
      return config;
    }

    async deletePageRuntimeConfigTag(
      projectId: string,
      tagId: string,
      expectedGeneration: number
    ): Promise<void> {
      await this.request(`/pages/${projectId}/runtime-configs/tags/${tagId}`, {
        method: "DELETE",
        body: JSON.stringify({ expectedGeneration }),
      });
      this.invalidateCache("pages:");
    }

    async deletePageProject(id: string): Promise<void> {
      await this.request(`/pages/${id}`, { method: "DELETE" });
      this.invalidateCache("pages:");
    }

    async listPageProjectFolders(): Promise<PageProjectFolderTreeNode[]> {
      return this.unwrapData(this.request<{ data: PageProjectFolderTreeNode[] }>("/pages/folders"));
    }

    async createPageProjectFolder(data: {
      name: string;
      parentId?: string;
    }): Promise<import("@/types").ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: import("@/types").ResourceFolder }>("/pages/folders", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updatePageProjectFolder(
      id: string,
      data: { name: string }
    ): Promise<import("@/types").ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: import("@/types").ResourceFolder }>(`/pages/folders/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deletePageProjectFolder(id: string): Promise<void> {
      await this.request(`/pages/folders/${id}`, { method: "DELETE" });
    }

    async reorderPageProjectFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/pages/folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async movePageProjectsToFolder(ids: string[], folderId: string | null): Promise<void> {
      await this.request("/pages/folders/move-projects", {
        method: "POST",
        body: JSON.stringify({ ids, folderId }),
      });
    }

    async reorderPageProjects(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/pages/folders/reorder-projects", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async listPageDeployments(
      projectId: string,
      params?: { page?: number; limit?: number }
    ): Promise<PaginatedResponse<PageDeployment>> {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set("page", String(params.page));
      if (params?.limit) searchParams.set("limit", String(params.limit));
      const query = searchParams.toString();
      return this.request<PaginatedResponse<PageDeployment>>(
        `/pages/${projectId}/deployments${query ? `?${query}` : ""}`
      );
    }

    async uploadPageBuild(
      projectId: string,
      archive: File,
      sha256: string,
      tag: string | undefined,
      onProgress?: (progress: number, phase: "uploading" | "finalizing") => void
    ): Promise<PageDeployment> {
      const created = await this.unwrapData(
        this.request<{ data: PageDeploymentUploadCreated }>("/pages-deploy/deployments", {
          method: "POST",
          body: JSON.stringify({
            projectId,
            declaredSizeBytes: archive.size,
            sha256,
            ...(tag ? { tag } : {}),
            source: { provider: "manual" },
          }),
        })
      );
      const chunkSize = 8 * 1024 * 1024;
      let offset = created.upload.offset;
      let finalized: { deployment: PageDeployment };
      try {
        while (offset < archive.size) {
          const chunk = archive.slice(offset, Math.min(offset + chunkSize, archive.size));
          const response = await this.unwrapData(
            this.request<{ data: { offset: number } }>(
              `/pages-deploy/uploads/${created.upload.id}/chunks`,
              {
                method: "PUT",
                headers: {
                  "Content-Type": "application/octet-stream",
                  "Upload-Offset": String(offset),
                },
                body: chunk,
              }
            )
          );
          offset = response.offset;
          onProgress?.(Math.min(100, Math.round((offset / archive.size) * 100)), "uploading");
        }
        onProgress?.(100, "finalizing");
        finalized = await this.unwrapData(
          this.request<{ data: { deployment: PageDeployment } }>(
            `/pages-deploy/uploads/${created.upload.id}/finalize`,
            { method: "POST" }
          )
        );
      } catch (error) {
        // An upload that never finalized would otherwise stay pending until it expires.
        // A finalize that already failed validation keeps its failed Deployment and reason.
        await this.request(`/pages-deploy/uploads/${created.upload.id}`, {
          method: "DELETE",
        }).catch(() => undefined);
        this.invalidateCache("pages:");
        throw error;
      }
      this.invalidateCache("pages:");
      return finalized.deployment;
    }

    async getPageDeployment(projectId: string, deploymentId: string): Promise<PageDeployment> {
      return this.unwrapData(
        this.request<{ data: PageDeployment }>(`/pages/${projectId}/deployments/${deploymentId}`)
      );
    }

    async pinPageDeployment(
      projectId: string,
      deploymentId: string,
      pinned: boolean
    ): Promise<void> {
      await this.request(`/pages/${projectId}/deployments/${deploymentId}/pin`, {
        method: "PATCH",
        body: JSON.stringify({ pinned }),
      });
      this.invalidateCache("pages:");
    }

    async deletePageDeployment(projectId: string, deploymentId: string): Promise<void> {
      await this.request(`/pages/${projectId}/deployments/${deploymentId}`, { method: "DELETE" });
      this.invalidateCache("pages:");
    }

    async listPageTags(projectId: string): Promise<PageTag[]> {
      return this.unwrapData(this.request<{ data: PageTag[] }>(`/pages/${projectId}/tags`));
    }

    async movePageTag(
      projectId: string,
      tag: string,
      deploymentId: string
    ): Promise<PageTagMoveResult> {
      const result = await this.unwrapData(
        this.request<{ data: PageTagMoveResult }>(
          `/pages/${projectId}/tags/${encodeURIComponent(tag)}`,
          {
            method: "PUT",
            body: JSON.stringify({ deploymentId }),
          }
        )
      );
      this.invalidateCache("pages:");
      return result;
    }

    async deletePageTag(projectId: string, tag: string): Promise<void> {
      await this.request(`/pages/${projectId}/tags/${encodeURIComponent(tag)}`, {
        method: "DELETE",
      });
      this.invalidateCache("pages:");
    }

    async listPageDeployTokens(projectId: string): Promise<PageDeployToken[]> {
      return this.unwrapData(
        this.request<{ data: PageDeployToken[] }>(`/pages/${projectId}/tokens`)
      );
    }

    async createPageDeployToken(
      projectId: string,
      data: CreatePageDeployTokenRequest
    ): Promise<PageDeployTokenCreated> {
      const result = await this.unwrapData(
        this.request<{ data: PageDeployTokenCreated }>(`/pages/${projectId}/tokens`, {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
      this.invalidateCache("pages:");
      return result;
    }

    async revokePageDeployToken(projectId: string, tokenId: string): Promise<void> {
      await this.request(`/pages/${projectId}/tokens/${tokenId}`, { method: "DELETE" });
      this.invalidateCache("pages:");
    }

    async getPageProfile(): Promise<PageProfile> {
      return this.unwrapData(this.request<{ data: PageProfile }>("/pages/settings/profile"));
    }

    async getPageProfileOptions(): Promise<PageProfileOptions> {
      return this.unwrapData(this.request<{ data: PageProfileOptions }>("/pages/settings/options"));
    }

    async updatePageProfile(
      data: ConfigurePageProfileRequest | { enabled: false }
    ): Promise<PageProfile> {
      const result = await this.unwrapData(
        this.request<{ data: PageProfile }>("/pages/settings/profile", {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
      this.invalidateCache("pages:");
      return result;
    }

    async createFolder(data: { name: string; parentId?: string }): Promise<ProxyHostFolder> {
      return this.unwrapData(
        this.request<{ data: ProxyHostFolder }>("/proxy-host-folders", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateFolder(id: string, data: { name: string }): Promise<ProxyHostFolder> {
      return this.unwrapData(
        this.request<{ data: ProxyHostFolder }>(`/proxy-host-folders/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async moveFolder(id: string, parentId: string | null): Promise<ProxyHostFolder> {
      return this.unwrapData(
        this.request<{ data: ProxyHostFolder }>(`/proxy-host-folders/${id}/move`, {
          method: "PUT",
          body: JSON.stringify({ parentId }),
        })
      );
    }

    async deleteFolder(id: string): Promise<void> {
      return this.request<void>(`/proxy-host-folders/${id}`, { method: "DELETE" });
    }

    async reorderFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
      return this.request<void>("/proxy-host-folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async reorderHosts(items: { id: string; sortOrder: number }[]): Promise<void> {
      return this.request<void>("/proxy-host-folders/reorder-hosts", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async moveHostsToFolder(hostIds: string[], folderId: string | null): Promise<void> {
      return this.request<void>("/proxy-host-folders/move-hosts", {
        method: "POST",
        body: JSON.stringify({ hostIds, folderId }),
      });
    }

    // ── Nginx Config Templates ─────────────────────────────────────

    async listNginxTemplates(): Promise<NginxTemplate[]> {
      return this.unwrapData(this.request<{ data: NginxTemplate[] }>("/nginx-templates"));
    }

    async getNginxTemplate(id: string): Promise<NginxTemplate> {
      return this.unwrapData(this.request<{ data: NginxTemplate }>(`/nginx-templates/${id}`));
    }

    async createNginxTemplate(data: {
      name: string;
      description?: string;
      type: string;
      content: string;
      variables?: TemplateVariableDef[];
      folderId?: string | null;
    }): Promise<NginxTemplate> {
      return this.unwrapData(
        this.request<{ data: NginxTemplate }>("/nginx-templates", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateNginxTemplate(
      id: string,
      data: {
        name?: string;
        description?: string | null;
        content?: string;
        variables?: TemplateVariableDef[];
      }
    ): Promise<NginxTemplate> {
      return this.unwrapData(
        this.request<{ data: NginxTemplate }>(`/nginx-templates/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteNginxTemplate(id: string): Promise<void> {
      return this.request<void>(`/nginx-templates/${id}`, { method: "DELETE" });
    }

    async cloneNginxTemplate(id: string): Promise<NginxTemplate> {
      return this.unwrapData(
        this.request<{ data: NginxTemplate }>(`/nginx-templates/${id}/clone`, {
          method: "POST",
        })
      );
    }

    async previewNginxTemplate(content: string, hostId?: string): Promise<{ rendered: string }> {
      return this.unwrapData(
        this.request<{ data: { rendered: string } }>("/nginx-templates/preview", {
          method: "POST",
          body: JSON.stringify({ content, hostId }),
        })
      );
    }

    async listNginxTemplateFolders(): Promise<import("@/types").ResourceFolderTreeNode[]> {
      return this.unwrapData(
        this.request<{ data: import("@/types").ResourceFolderTreeNode[] }>(
          "/nginx-templates/folders"
        )
      );
    }

    async createNginxTemplateFolder(data: {
      name: string;
      parentId?: string;
    }): Promise<import("@/types").ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: import("@/types").ResourceFolder }>("/nginx-templates/folders", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateNginxTemplateFolder(
      id: string,
      data: { name: string }
    ): Promise<import("@/types").ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: import("@/types").ResourceFolder }>(`/nginx-templates/folders/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteNginxTemplateFolder(id: string): Promise<void> {
      await this.request(`/nginx-templates/folders/${id}`, { method: "DELETE" });
    }

    async reorderNginxTemplateFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/nginx-templates/folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async moveNginxTemplatesToFolder(ids: string[], folderId: string | null): Promise<void> {
      await this.request("/nginx-templates/folders/move-templates", {
        method: "POST",
        body: JSON.stringify({ ids, folderId }),
      });
    }

    async reorderNginxTemplates(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/nginx-templates/folders/reorder-templates", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async testNginxTemplate(
      content: string,
      templateId?: string
    ): Promise<{ rendered: string; valid: boolean; errors: string[] }> {
      return this.unwrapData(
        this.request<{ data: { rendered: string; valid: boolean; errors: string[] } }>(
          "/nginx-templates/test",
          {
            method: "POST",
            body: JSON.stringify({ content, templateId }),
          }
        )
      );
    }

    // ── SSL Certificates ───────────────────────────────────────────

    async listSSLCertificates(params?: {
      page?: number;
      limit?: number;
      search?: string;
      type?: SSLCertType;
      status?: SSLCertStatus;
      sortBy?: string;
      sortOrder?: string;
      showSystem?: boolean;
      excludeAppMembers?: boolean;
      appId?: string;
    }): Promise<PaginatedResponse<SSLCertificate>> {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set("page", params.page.toString());
      if (params?.limit) searchParams.set("limit", params.limit.toString());
      if (params?.search) searchParams.set("search", params.search);
      if (params?.type) searchParams.set("type", params.type);
      if (params?.status) searchParams.set("status", params.status);
      if (params?.sortBy) searchParams.set("sortBy", params.sortBy);
      if (params?.sortOrder) searchParams.set("sortOrder", params.sortOrder);
      if (params?.showSystem) searchParams.set("showSystem", "true");
      setAppMemberListParams(searchParams, params);

      const query = searchParams.toString();
      return this.request<PaginatedResponse<SSLCertificate>>(
        `/ssl-certificates${query ? `?${query}` : ""}`
      );
    }

    async getSSLCertificate(id: string): Promise<SSLCertificate> {
      return this.unwrapData(this.request<{ data: SSLCertificate }>(`/ssl-certificates/${id}`));
    }

    async listSSLCertificateFolders(): Promise<import("@/types").ResourceFolderTreeNode[]> {
      return this.unwrapData(
        this.request<{ data: import("@/types").ResourceFolderTreeNode[] }>(
          "/ssl-certificates/folders"
        )
      );
    }

    async createSSLCertificateFolder(data: {
      name: string;
      parentId?: string;
    }): Promise<import("@/types").ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: import("@/types").ResourceFolder }>("/ssl-certificates/folders", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateSSLCertificateFolder(
      id: string,
      data: { name: string }
    ): Promise<import("@/types").ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: import("@/types").ResourceFolder }>(
          `/ssl-certificates/folders/${id}`,
          { method: "PUT", body: JSON.stringify(data) }
        )
      );
    }

    async deleteSSLCertificateFolder(id: string): Promise<void> {
      await this.request(`/ssl-certificates/folders/${id}`, { method: "DELETE" });
    }

    async reorderSSLCertificateFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/ssl-certificates/folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async moveSSLCertificatesToFolder(ids: string[], folderId: string | null): Promise<void> {
      await this.request("/ssl-certificates/folders/move-certificates", {
        method: "POST",
        body: JSON.stringify({ ids, folderId }),
      });
    }

    async reorderSSLCertificates(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/ssl-certificates/folders/reorder-certificates", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async requestACMECert(data: RequestACMECertRequest): Promise<SSLCertificateOperationResult> {
      return this.unwrapData(
        this.request<{ data: SSLCertificateOperationResult }>("/ssl-certificates/acme", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async uploadCert(data: UploadCertRequest): Promise<SSLCertificate> {
      return this.unwrapData(
        this.request<{ data: SSLCertificate }>("/ssl-certificates/upload", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async linkInternalCert(data: LinkInternalCertRequest): Promise<SSLCertificate> {
      return this.unwrapData(
        this.request<{ data: SSLCertificate }>("/ssl-certificates/internal", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async renewSSLCert(id: string): Promise<SSLCertificate | SSLCertificateOperationResult> {
      return this.unwrapData(
        this.request<{ data: SSLCertificate | SSLCertificateOperationResult }>(
          `/ssl-certificates/${id}/renew`,
          { method: "POST" }
        )
      );
    }

    async setSSLCertAutoRenew(
      id: string,
      data: { enabled: boolean; provider?: "cloudflare" }
    ): Promise<SSLCertificate> {
      return this.unwrapData(
        this.request<{ data: SSLCertificate }>(`/ssl-certificates/${id}/auto-renew`, {
          method: "PATCH",
          body: JSON.stringify(data),
        })
      );
    }

    async completeDNSVerify(id: string): Promise<SSLCertificate> {
      return this.unwrapData(
        this.request<{ data: SSLCertificate }>(`/ssl-certificates/${id}/dns-verify`, {
          method: "POST",
        })
      );
    }

    async cancelPendingACMECert(id: string): Promise<void> {
      return this.request<void>(`/ssl-certificates/${id}/acme-cancel`, { method: "POST" });
    }

    async resyncSSLCertificateDistribution(id: string): Promise<{ synchronized: number }> {
      return this.unwrapData(
        this.request<{ data: { synchronized: number } }>(
          `/ssl-certificates/${id}/distribution/resync`,
          {
            method: "POST",
          }
        )
      );
    }

    async deleteSSLCert(id: string): Promise<void> {
      return this.request<void>(`/ssl-certificates/${id}`, { method: "DELETE" });
    }

    // ── Access Lists ───────────────────────────────────────────────

    async listAccessLists(params?: {
      page?: number;
      limit?: number;
      search?: string;
    }): Promise<PaginatedResponse<AccessList>> {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set("page", params.page.toString());
      if (params?.limit) searchParams.set("limit", params.limit.toString());
      if (params?.search) searchParams.set("search", params.search);

      const query = searchParams.toString();
      return this.request<PaginatedResponse<AccessList>>(
        `/access-lists${query ? `?${query}` : ""}`
      );
    }

    async getAccessList(id: string): Promise<AccessList> {
      return this.unwrapData(this.request<{ data: AccessList }>(`/access-lists/${id}`));
    }

    async createAccessList(data: CreateAccessListRequest): Promise<AccessList> {
      return this.unwrapData(
        this.request<{ data: AccessList }>("/access-lists", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateAccessList(
      id: string,
      data: Partial<CreateAccessListRequest>
    ): Promise<AccessList> {
      return this.unwrapData(
        this.request<{ data: AccessList }>(`/access-lists/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteAccessList(id: string): Promise<void> {
      return this.request<void>(`/access-lists/${id}`, { method: "DELETE" });
    }

    // ── Monitoring ─────────────────────────────────────────────────

    async getDashboardStats(showSystem?: boolean): Promise<DashboardStats> {
      return this.unwrapData(
        this.request<{ data: DashboardStats }>(
          `/monitoring/dashboard${showSystem ? "?showSystem=true" : ""}`
        )
      );
    }

    async getDashboardBootstrap(request: DashboardBootstrapRequest): Promise<DashboardBootstrap> {
      const snapshot = await this.unwrapData(
        this.request<{ data: DashboardBootstrap }>("/monitoring/dashboard/bootstrap", {
          method: "POST",
          body: JSON.stringify(request),
        })
      );
      if (snapshot.inferenceUsage) {
        const accepted = this.acceptFreshSnapshot(
          INFERENCE_SELF_USAGE_CACHE_KEY,
          snapshot.inferenceUsage
        );
        this.setCache(INFERENCE_SELF_USAGE_CACHE_KEY, accepted);
        if (accepted === snapshot.inferenceUsage) publishInferenceSelfUsage(accepted);
        else snapshot.inferenceUsage = accepted;
      }
      return snapshot;
    }

    async getHealthOverview(): Promise<ProxyHost[]> {
      return this.unwrapData(this.request<{ data: ProxyHost[] }>("/monitoring/health-status"));
    }

    // ── SSE (Live Logs) ────────────────────────────────────────────

    createLogStream(hostId: string): EventSource {
      return new EventSource(`${API_BASE}/monitoring/logs/${hostId}/stream`, {
        withCredentials: true,
      });
    }

    createProxyLogStreamWebSocket(hostId: string, tail = 200): WebSocket {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(
        `${proto}//${window.location.host}/api/monitoring/logs/${hostId}/ws?tail=${tail}`
      );
    }

    createNodeNginxLogStreamWebSocket(nodeId: string, tail = 200): WebSocket {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(
        `${proto}//${window.location.host}/api/nodes/${nodeId}/nginx-logs/ws?tail=${tail}`
      );
    }

    // ── Domains ────────────────────────────────────────────────────

    async listDomains(params?: {
      page?: number;
      limit?: number;
      search?: string;
      dnsStatus?: DnsStatus;
      excludeAppMembers?: boolean;
      appId?: string;
    }): Promise<PaginatedResponse<Domain>> {
      const sp = new URLSearchParams();
      if (params?.page) sp.set("page", params.page.toString());
      if (params?.limit) sp.set("limit", params.limit.toString());
      if (params?.search) sp.set("search", params.search);
      if (params?.dnsStatus) sp.set("dnsStatus", params.dnsStatus);
      setAppMemberListParams(sp, params);
      const q = sp.toString();
      return this.request<PaginatedResponse<Domain>>(`/domains${q ? `?${q}` : ""}`);
    }

    async getDomain(id: string): Promise<DomainWithUsage> {
      return this.unwrapData(this.request<{ data: DomainWithUsage }>(`/domains/${id}`));
    }

    async previewDomain(
      data: Pick<
        CreateDomainRequest,
        "domain" | "dnsProvider" | "ttl" | "proxied" | "nginxNodeId" | "ingressGroupId"
      >
    ): Promise<import("@/types").DomainPreview> {
      return this.unwrapData(
        this.request<{ data: import("@/types").DomainPreview }>("/domains/preview", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async createDomain(data: CreateDomainRequest): Promise<Domain> {
      return this.unwrapData(
        this.request<{ data: Domain }>("/domains", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async listDomainNginxNodes(): Promise<import("@/types").DomainNginxNodeOptions> {
      return this.unwrapData(
        this.request<{ data: import("@/types").DomainNginxNodeOptions }>("/domains/nginx-nodes")
      );
    }

    async resolveDomainCloudflareMigration(
      id: string,
      data: import("@/types").ResolveCloudflareMigrationRequest
    ): Promise<DomainWithUsage> {
      return this.unwrapData(
        this.request<{ data: DomainWithUsage }>(`/domains/${id}/cloudflare-migration/resolve`, {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async previewDomainIngressMigration(
      id: string,
      targetNodeId: string
    ): Promise<import("@/types").DomainIngressMigrationImpact> {
      return this.unwrapData(
        this.request<{ data: import("@/types").DomainIngressMigrationImpact }>(
          `/domains/${id}/ingress-migration/preview`,
          { method: "POST", body: JSON.stringify({ targetNodeId }) }
        )
      );
    }

    async migrateDomainIngress(
      id: string,
      targetNodeId: string
    ): Promise<import("@/types").DomainIngressMigrationImpact> {
      return this.unwrapData(
        this.request<{ data: import("@/types").DomainIngressMigrationImpact }>(
          `/domains/${id}/ingress-migration`,
          { method: "POST", body: JSON.stringify({ targetNodeId }) }
        )
      );
    }

    async updateDomain(id: string, data: UpdateDomainRequest): Promise<Domain> {
      return this.unwrapData(
        this.request<{ data: Domain }>(`/domains/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteDomain(id: string, data?: DeleteDomainRequest): Promise<void> {
      await this.request<void>(`/domains/${id}`, {
        method: "DELETE",
        body: JSON.stringify(data ?? {}),
      });
    }

    /**
     * Re-probes the domain's DNS. `repair: false` only reads (resolver and
     * provider records) and never rewrites a drifted Cloudflare record; the
     * detail dialog checks this way when it opens.
     */
    async checkDomainDns(id: string, options: { repair?: boolean } = {}): Promise<Domain> {
      const query = options.repair === false ? "?repair=false" : "";
      return this.unwrapData(
        this.request<{ data: Domain }>(`/domains/${id}/check-dns${query}`, { method: "POST" })
      );
    }

    /** `folderId` is the SSL certificate folder for the new certificate (root when omitted). */
    async issueDomainCert(id: string, folderId?: string | null): Promise<SSLCertificate> {
      return this.unwrapData(
        this.request<{ data: SSLCertificate }>(`/domains/${id}/issue-cert`, {
          method: "POST",
          body: JSON.stringify(folderId ? { folderId } : {}),
        })
      );
    }

    async listDomainFolders(): Promise<import("@/types").ResourceFolderTreeNode[]> {
      return this.unwrapData(
        this.request<{ data: import("@/types").ResourceFolderTreeNode[] }>("/domains/folders")
      );
    }

    async createDomainFolder(data: {
      name: string;
      parentId?: string;
    }): Promise<import("@/types").ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: import("@/types").ResourceFolder }>("/domains/folders", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateDomainFolder(
      id: string,
      data: { name: string }
    ): Promise<import("@/types").ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: import("@/types").ResourceFolder }>(`/domains/folders/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteDomainFolder(id: string): Promise<void> {
      await this.request(`/domains/folders/${id}`, { method: "DELETE" });
    }

    async reorderDomainFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/domains/folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async moveDomainsToFolder(ids: string[], folderId: string | null): Promise<void> {
      await this.request("/domains/folders/move-domains", {
        method: "POST",
        body: JSON.stringify({ ids, folderId }),
      });
    }

    async reorderDomains(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/domains/folders/reorder-domains", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async searchDomains(q: string): Promise<DomainSearchResult[]> {
      return this.unwrapData(
        this.request<{ data: DomainSearchResult[] }>(`/domains/search?q=${encodeURIComponent(q)}`)
      );
    }
  };
}
