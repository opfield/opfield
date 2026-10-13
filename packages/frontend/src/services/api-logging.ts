import { type AppMemberListFilter, setAppMemberListParams } from "@/lib/app-members";
import type {
  LoggingEnvironment,
  LoggingFacets,
  LoggingIngestToken,
  LoggingMaintenanceSnapshot,
  LoggingMetadata,
  LoggingSchema,
  LoggingSearchRequest,
  LoggingSearchResult,
  ResourceFolder,
  ResourceFolderTreeNode,
} from "@/types";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withLoggingApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class LoggingApiClient extends Base {
    // ── External Logging ────────────────────────────────────────────

    async getLoggingHealth(): Promise<LoggingMaintenanceSnapshot> {
      return this.unwrapData(this.request<{ data: LoggingMaintenanceSnapshot }>("/logging/health"));
    }

    async listLoggingEnvironments(
      params?: { search?: string } & AppMemberListFilter
    ): Promise<LoggingEnvironment[]> {
      const query = new URLSearchParams();
      if (params?.search) query.set("search", params.search);
      setAppMemberListParams(query, params);
      const qs = query.toString();
      return this.unwrapData(
        this.request<{ data: LoggingEnvironment[] }>(`/logging/environments${qs ? `?${qs}` : ""}`)
      );
    }

    async createLoggingEnvironment(data: Partial<LoggingEnvironment>): Promise<LoggingEnvironment> {
      return this.unwrapData(
        this.request<{ data: LoggingEnvironment }>("/logging/environments", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async getLoggingEnvironmentBySlug(slug: string): Promise<LoggingEnvironment> {
      return this.unwrapData(
        this.requestRouteContext<{ data: LoggingEnvironment }>(
          `/logging/environments/by-slug/${encodeURIComponent(slug)}`
        )
      );
    }

    async updateLoggingEnvironment(
      id: string,
      data: Partial<LoggingEnvironment>
    ): Promise<LoggingEnvironment> {
      // Updates never move an environment (the API rejects folderId); moves use the folder endpoints.
      const { folderId: _folderId, ...body } = data;
      return this.unwrapData(
        this.request<{ data: LoggingEnvironment }>(`/logging/environments/${id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        })
      );
    }

    async deleteLoggingEnvironment(id: string): Promise<void> {
      await this.request<void>(`/logging/environments/${id}`, { method: "DELETE" });
    }

    async listLoggingEnvironmentFolders(): Promise<ResourceFolderTreeNode[]> {
      return this.unwrapData(
        this.request<{ data: ResourceFolderTreeNode[] }>("/logging/environment-folders")
      );
    }

    async createLoggingEnvironmentFolder(data: {
      name: string;
      parentId?: string;
    }): Promise<ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: ResourceFolder }>("/logging/environment-folders", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateLoggingEnvironmentFolder(
      id: string,
      data: { name: string }
    ): Promise<ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: ResourceFolder }>(`/logging/environment-folders/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteLoggingEnvironmentFolder(id: string): Promise<void> {
      await this.request(`/logging/environment-folders/${id}`, { method: "DELETE" });
    }

    async reorderLoggingEnvironmentFolders(
      items: { id: string; sortOrder: number }[]
    ): Promise<void> {
      await this.request("/logging/environment-folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async moveLoggingEnvironmentsToFolder(ids: string[], folderId: string | null): Promise<void> {
      await this.request("/logging/environment-folders/move-environments", {
        method: "POST",
        body: JSON.stringify({ ids, folderId }),
      });
    }

    async reorderLoggingEnvironments(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/logging/environment-folders/reorder-environments", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async listLoggingSchemas(params?: { search?: string }): Promise<LoggingSchema[]> {
      const query = new URLSearchParams();
      if (params?.search) query.set("search", params.search);
      const qs = query.toString();
      return this.unwrapData(
        this.request<{ data: LoggingSchema[] }>(`/logging/schemas${qs ? `?${qs}` : ""}`)
      );
    }

    async getLoggingSchema(id: string): Promise<LoggingSchema> {
      return this.unwrapData(this.request<{ data: LoggingSchema }>(`/logging/schemas/${id}`));
    }

    async getLoggingSchemaBySlug(slug: string): Promise<LoggingSchema> {
      return this.unwrapData(
        this.requestRouteContext<{ data: LoggingSchema }>(
          `/logging/schemas/by-slug/${encodeURIComponent(slug)}`
        )
      );
    }

    async createLoggingSchema(data: Partial<LoggingSchema>): Promise<LoggingSchema> {
      return this.unwrapData(
        this.request<{ data: LoggingSchema }>("/logging/schemas", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateLoggingSchema(id: string, data: Partial<LoggingSchema>): Promise<LoggingSchema> {
      const { folderId: _folderId, ...body } = data;
      return this.unwrapData(
        this.request<{ data: LoggingSchema }>(`/logging/schemas/${id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        })
      );
    }

    async deleteLoggingSchema(id: string): Promise<void> {
      await this.request<void>(`/logging/schemas/${id}`, { method: "DELETE" });
    }

    async listLoggingSchemaFolders(): Promise<ResourceFolderTreeNode[]> {
      return this.unwrapData(
        this.request<{ data: ResourceFolderTreeNode[] }>("/logging/schema-folders")
      );
    }

    async createLoggingSchemaFolder(data: {
      name: string;
      parentId?: string;
    }): Promise<ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: ResourceFolder }>("/logging/schema-folders", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateLoggingSchemaFolder(id: string, data: { name: string }): Promise<ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: ResourceFolder }>(`/logging/schema-folders/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteLoggingSchemaFolder(id: string): Promise<void> {
      await this.request(`/logging/schema-folders/${id}`, { method: "DELETE" });
    }

    async reorderLoggingSchemaFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/logging/schema-folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async moveLoggingSchemasToFolder(ids: string[], folderId: string | null): Promise<void> {
      await this.request("/logging/schema-folders/move-schemas", {
        method: "POST",
        body: JSON.stringify({ ids, folderId }),
      });
    }

    async reorderLoggingSchemas(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/logging/schema-folders/reorder-schemas", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async listLoggingTokens(environmentId: string): Promise<LoggingIngestToken[]> {
      return this.unwrapData(
        this.request<{ data: LoggingIngestToken[] }>(
          `/logging/environments/${environmentId}/tokens`
        )
      );
    }

    async createLoggingToken(
      environmentId: string,
      data: { name: string; expiresAt?: string | null }
    ): Promise<LoggingIngestToken> {
      return this.unwrapData(
        this.request<{ data: LoggingIngestToken }>(
          `/logging/environments/${environmentId}/tokens`,
          {
            method: "POST",
            body: JSON.stringify(data),
          }
        )
      );
    }

    async deleteLoggingToken(environmentId: string, tokenId: string): Promise<void> {
      await this.request<void>(`/logging/environments/${environmentId}/tokens/${tokenId}`, {
        method: "DELETE",
      });
    }

    async searchLogs(
      environmentId: string,
      data: LoggingSearchRequest
    ): Promise<{ data: LoggingSearchResult[]; nextCursor: string | null }> {
      return this.request(`/logging/environments/${environmentId}/search`, {
        method: "POST",
        body: JSON.stringify({ limit: 100, ...data }),
      });
    }

    async getLoggingFacets(
      environmentId: string,
      params?: { from?: string; to?: string }
    ): Promise<LoggingFacets> {
      const query = new URLSearchParams();
      if (params?.from) query.set("from", params.from);
      if (params?.to) query.set("to", params.to);
      const qs = query.toString();
      return this.unwrapData(
        this.request<{ data: LoggingFacets }>(
          `/logging/environments/${environmentId}/facets${qs ? `?${qs}` : ""}`
        )
      );
    }

    async getLoggingMetadata(environmentId: string): Promise<LoggingMetadata> {
      return this.unwrapData(
        this.request<{ data: LoggingMetadata }>(`/logging/environments/${environmentId}/metadata`)
      );
    }
  };
}
