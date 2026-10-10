import { setAppMemberListParams } from "@/lib/app-members";
import type {
  ManagedCertificateStatus,
  ObjectStorageBucket,
  ObjectStorageConnection,
  ObjectStorageListing,
  ObjectStorageObjectMetadata,
  ObjectStoragePresignResult,
  ObjectStorageProvider,
  ObjectStorageRevealedCredentials,
  PaginatedResponse,
  ResourceFolder,
  ResourceFolderTreeNode,
} from "@/types";
import type {
  ManagedObjectStorage,
  ManagedObjectStorageCaCertificate,
  ManagedObjectStorageCatalogEntry,
  ManagedObjectStorageCreateInput,
  ManagedStorageAccessKey,
  ManagedStorageAccessKeyCreated,
  ManagedStorageAccessKeyCreateInput,
  ManagedStorageBinding,
  ManagedStorageBindingCreateInput,
  ManagedStorageBindingDeleteInput,
  ManagedStorageBindingRuntimeStatus,
} from "@/types/object-storage";
import { API_BASE } from "./api-base";
import type { ApiClientBaseConstructor } from "./api-mixins";

export interface StorageDeleteOptions {
  /** Confirms removing finished backup history that still references the storage. */
  backupHistory?: "forget";
}

function storageDeleteQuery(options: StorageDeleteOptions): string {
  return options.backupHistory ? `?backupHistory=${options.backupHistory}` : "";
}

export function withObjectStorageApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class ObjectStorageApiClient extends Base {
    // ── Object Storage ─────────────────────────────────────────────

    async listObjectStorages(params?: {
      page?: number;
      limit?: number;
      search?: string;
      provider?: ObjectStorageProvider;
      healthStatus?: "online" | "offline" | "degraded" | "unknown";
      /** App members: see `AppMemberListFilter`. */
      excludeAppMembers?: boolean;
      appId?: string;
    }): Promise<PaginatedResponse<ObjectStorageConnection>> {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set("page", String(params.page));
      if (params?.limit) searchParams.set("limit", String(params.limit));
      if (params?.search) searchParams.set("search", params.search);
      if (params?.provider) searchParams.set("provider", params.provider);
      if (params?.healthStatus) searchParams.set("healthStatus", params.healthStatus);
      setAppMemberListParams(searchParams, params);
      const query = searchParams.toString();
      return this.request<PaginatedResponse<ObjectStorageConnection>>(
        `/object-storage${query ? `?${query}` : ""}`
      );
    }

    async getObjectStorage(id: string): Promise<ObjectStorageConnection> {
      return this.unwrapData(
        this.request<{ data: ObjectStorageConnection }>(`/object-storage/${id}`)
      );
    }

    async getObjectStorageBySlug(slug: string): Promise<ObjectStorageConnection> {
      return this.unwrapData(
        this.requestRouteContext<{ data: ObjectStorageConnection }>(
          `/object-storage/by-slug/${encodeURIComponent(slug)}`
        )
      );
    }

    async getObjectStorageHealthHistory(
      id: string
    ): Promise<ObjectStorageConnection["healthHistory"]> {
      return this.unwrapData(this.request(`/object-storage/${id}/health-history`));
    }

    async createObjectStorage(data: Record<string, unknown>): Promise<ObjectStorageConnection> {
      return this.unwrapData(
        this.request<{ data: ObjectStorageConnection }>("/object-storage", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateObjectStorage(
      id: string,
      data: Record<string, unknown>
    ): Promise<ObjectStorageConnection> {
      return this.unwrapData(
        this.request<{ data: ObjectStorageConnection }>(`/object-storage/${id}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        })
      );
    }

    /** `backupHistory: "forget"` confirms removing the finished backup history that references it. */
    async deleteObjectStorage(id: string, options: StorageDeleteOptions = {}): Promise<void> {
      await this.request<void>(`/object-storage/${id}${storageDeleteQuery(options)}`, {
        method: "DELETE",
      });
    }

    async listObjectStorageFolders(): Promise<ResourceFolderTreeNode[]> {
      return this.unwrapData(
        this.request<{ data: ResourceFolderTreeNode[] }>("/object-storage/folders")
      );
    }

    async createObjectStorageFolder(data: {
      name: string;
      parentId?: string;
    }): Promise<ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: ResourceFolder }>("/object-storage/folders", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateObjectStorageFolder(id: string, data: { name: string }): Promise<ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: ResourceFolder }>(`/object-storage/folders/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteObjectStorageFolder(id: string): Promise<void> {
      await this.request<void>(`/object-storage/folders/${id}`, { method: "DELETE" });
    }

    async reorderObjectStorageFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request<void>("/object-storage/folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async moveObjectStoragesToFolder(ids: string[], folderId: string | null): Promise<void> {
      await this.request<void>("/object-storage/folders/move-connections", {
        method: "POST",
        body: JSON.stringify({ ids, folderId }),
      });
    }

    async reorderObjectStorages(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request<void>("/object-storage/folders/reorder-connections", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async testObjectStorage(
      id: string
    ): Promise<{ ok: boolean; responseMs: number; status: string }> {
      return this.unwrapData(
        this.request<{ data: { ok: boolean; responseMs: number; status: string } }>(
          `/object-storage/${id}/test`,
          { method: "POST" }
        )
      );
    }

    async revealObjectStorageCredentials(id: string): Promise<ObjectStorageRevealedCredentials> {
      return this.unwrapData(
        this.request<{ data: ObjectStorageRevealedCredentials }>(
          `/object-storage/${id}/reveal-credentials`
        )
      );
    }

    createObjectStorageMonitoringStream(id: string): EventSource {
      return new EventSource(`${API_BASE}/object-storage/${id}/monitoring/stream`, {
        withCredentials: true,
      });
    }

    // ── Managed object storage ─────────────────────────────────────

    async listManagedObjectStorageCatalog(): Promise<ManagedObjectStorageCatalogEntry[]> {
      return this.unwrapData(
        this.request<{ data: ManagedObjectStorageCatalogEntry[] }>("/managed-storage/catalog")
      );
    }

    async listManagedObjectStorages(): Promise<ManagedObjectStorage[]> {
      return this.unwrapData(this.request<{ data: ManagedObjectStorage[] }>("/managed-storage"));
    }

    async getManagedObjectStorage(id: string): Promise<ManagedObjectStorage> {
      return this.unwrapData(
        this.request<{ data: ManagedObjectStorage }>(`/managed-storage/${encodeURIComponent(id)}`)
      );
    }

    async createManagedObjectStorage(
      data: ManagedObjectStorageCreateInput
    ): Promise<ManagedObjectStorage> {
      return this.unwrapData(
        this.request<{ data: ManagedObjectStorage }>("/managed-storage", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateManagedObjectStorage(
      id: string,
      data: Partial<ManagedObjectStorageCreateInput>
    ): Promise<ManagedObjectStorage> {
      return this.unwrapData(
        this.request<{ data: ManagedObjectStorage }>(`/managed-storage/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteManagedObjectStorage(
      id: string,
      options: StorageDeleteOptions = {}
    ): Promise<void> {
      await this.request<void>(
        `/managed-storage/${encodeURIComponent(id)}${storageDeleteQuery(options)}`,
        { method: "DELETE" }
      );
    }

    async restartManagedObjectStorage(id: string): Promise<ManagedObjectStorage> {
      return this.unwrapData(
        this.request<{ data: ManagedObjectStorage }>(
          `/managed-storage/${encodeURIComponent(id)}/restart`,
          {
            method: "POST",
          }
        )
      );
    }

    async retryManagedObjectStorageProvisioning(id: string): Promise<ManagedObjectStorage> {
      return this.unwrapData(
        this.request<{ data: ManagedObjectStorage }>(
          `/managed-storage/${encodeURIComponent(id)}/retry-provisioning`,
          { method: "POST" }
        )
      );
    }

    async revealManagedObjectStorageCredentials(
      id: string
    ): Promise<{ accessKey: string; secretKey: string }> {
      return this.unwrapData(
        this.request<{ data: { accessKey: string; secretKey: string } }>(
          `/managed-storage/${encodeURIComponent(id)}/reveal-credentials`
        )
      );
    }

    /** 404/409 when the cluster has TLS off. */
    async getManagedObjectStorageCaCertificate(
      id: string
    ): Promise<ManagedObjectStorageCaCertificate> {
      return this.unwrapData(
        this.request<{ data: ManagedObjectStorageCaCertificate }>(
          `/managed-storage/${encodeURIComponent(id)}/ca-certificate`
        )
      );
    }

    /** Server certificate expiry and automatic renewal state; 409 when TLS is off. */
    async getManagedObjectStorageCertificate(id: string): Promise<ManagedCertificateStatus> {
      return this.unwrapData(
        this.request<{ data: ManagedCertificateStatus }>(
          `/managed-storage/${encodeURIComponent(id)}/certificate`
        )
      );
    }

    async renewManagedObjectStorageCertificate(
      id: string,
      options: { allowRestart?: boolean } = {}
    ): Promise<{
      outcome: { status: string; method?: string; restarted?: boolean };
      status: ManagedCertificateStatus;
    }> {
      return this.unwrapData(
        this.request<{
          data: {
            outcome: { status: string; method?: string; restarted?: boolean };
            status: ManagedCertificateStatus;
          };
        }>(`/managed-storage/${encodeURIComponent(id)}/certificate/renew`, {
          method: "POST",
          body: JSON.stringify(options),
        })
      );
    }

    // ── Managed storage IAM access keys ────────────────────────────

    async createManagedStorageAccessKey(
      id: string,
      data: ManagedStorageAccessKeyCreateInput
    ): Promise<ManagedStorageAccessKeyCreated> {
      return this.unwrapData(
        this.request<{ data: ManagedStorageAccessKeyCreated }>(
          `/managed-storage/${encodeURIComponent(id)}/iam-keys`,
          {
            method: "POST",
            body: JSON.stringify(data),
          }
        )
      );
    }

    async listManagedStorageAccessKeys(id: string): Promise<ManagedStorageAccessKey[]> {
      return this.unwrapData(
        this.request<{ data: ManagedStorageAccessKey[] }>(
          `/managed-storage/${encodeURIComponent(id)}/iam-keys`
        )
      );
    }

    async removeManagedStorageAccessKey(id: string, accessKeyId: string): Promise<void> {
      await this.request<{ data: { success: true } }>(
        `/managed-storage/${encodeURIComponent(id)}/iam-keys/${encodeURIComponent(accessKeyId)}`,
        { method: "DELETE" }
      );
    }

    // ── Managed storage bindings ───────────────────────────────────

    async createManagedStorageBinding(
      id: string,
      data: ManagedStorageBindingCreateInput
    ): Promise<ManagedStorageBinding> {
      return this.unwrapData(
        this.request<{ data: ManagedStorageBinding }>(
          `/managed-storage/${encodeURIComponent(id)}/bindings`,
          { method: "POST", body: JSON.stringify(data) }
        )
      );
    }

    async listManagedStorageBindings(id: string): Promise<ManagedStorageBinding[]> {
      return this.unwrapData(
        this.request<{ data: ManagedStorageBinding[] }>(
          `/managed-storage/${encodeURIComponent(id)}/bindings`
        )
      );
    }

    async getManagedStorageBindingRuntime(
      id: string,
      bindingId: string
    ): Promise<ManagedStorageBindingRuntimeStatus> {
      return this.unwrapData(
        this.request<{ data: ManagedStorageBindingRuntimeStatus }>(
          `/managed-storage/${encodeURIComponent(id)}/bindings/${encodeURIComponent(bindingId)}/runtime`
        )
      );
    }

    async deleteManagedStorageBinding(
      id: string,
      bindingId: string,
      data?: ManagedStorageBindingDeleteInput
    ): Promise<void> {
      await this.request<{ data: { success: true } }>(
        `/managed-storage/${encodeURIComponent(id)}/bindings/${encodeURIComponent(bindingId)}`,
        data ? { method: "DELETE", body: JSON.stringify(data) } : { method: "DELETE" }
      );
    }

    // ── Buckets ─────────────────────────────────────────────────────

    async listBuckets(id: string): Promise<ObjectStorageBucket[]> {
      return this.unwrapData(
        this.request<{ data: ObjectStorageBucket[] }>(`/object-storage/${id}/buckets`)
      );
    }

    async createBucket(id: string, bucket: string): Promise<void> {
      await this.request<{ success: true }>(`/object-storage/${id}/buckets`, {
        method: "POST",
        body: JSON.stringify({ bucket }),
      });
    }

    async deleteBucket(id: string, bucket: string): Promise<void> {
      await this.request<{ success: true }>(
        `/object-storage/${id}/buckets?bucket=${encodeURIComponent(bucket)}`,
        { method: "DELETE" }
      );
    }

    // ── Objects ─────────────────────────────────────────────────────

    async listObjects(
      id: string,
      params: {
        bucket: string;
        prefix?: string;
        delimiter?: string;
        continuationToken?: string;
        maxKeys?: number;
      }
    ): Promise<ObjectStorageListing> {
      const query = new URLSearchParams({ bucket: params.bucket });
      query.set("delimiter", params.delimiter ?? "/");
      if (params.prefix) query.set("prefix", params.prefix);
      if (params.continuationToken) query.set("continuationToken", params.continuationToken);
      if (params.maxKeys !== undefined) query.set("maxKeys", String(params.maxKeys));
      return this.unwrapData(
        this.request<{ data: ObjectStorageListing }>(
          `/object-storage/${id}/objects?${query.toString()}`
        )
      );
    }

    async getObjectMetadata(
      id: string,
      bucket: string,
      key: string
    ): Promise<ObjectStorageObjectMetadata> {
      const query = new URLSearchParams({ bucket, key });
      return this.unwrapData(
        this.request<{ data: ObjectStorageObjectMetadata }>(
          `/object-storage/${id}/objects/metadata?${query.toString()}`
        )
      );
    }

    async readObject(id: string, bucket: string, key: string): Promise<ArrayBuffer> {
      const query = new URLSearchParams({ bucket, key });
      return this.requestBinary(`/object-storage/${id}/objects/download?${query.toString()}`);
    }

    objectDownloadUrl(id: string, bucket: string, key: string): string {
      const query = new URLSearchParams({ bucket, key });
      return `${API_BASE}/object-storage/${id}/objects/download?${query.toString()}`;
    }

    async presignObject(
      id: string,
      body: {
        bucket: string;
        key: string;
        operation: "get" | "put";
        contentType?: string;
        expiresIn: number;
      }
    ): Promise<ObjectStoragePresignResult> {
      return this.unwrapData(
        this.request<{ data: ObjectStoragePresignResult }>(
          `/object-storage/${id}/objects/presign`,
          {
            method: "POST",
            body: JSON.stringify(body),
          }
        )
      );
    }

    async uploadObject(
      id: string,
      params: { bucket: string; key: string; contentType: string; body: Blob | File },
      onProgress?: (progress: { loaded: number; total: number }) => void
    ): Promise<void> {
      const query = new URLSearchParams({
        bucket: params.bucket,
        key: params.key,
        contentType: params.contentType,
      });
      await this.uploadRaw<{ success: true }>(
        `/object-storage/${id}/objects/upload?${query.toString()}`,
        {
          method: "POST",
          body: params.body,
          headers: { "Content-Type": params.contentType || "application/octet-stream" },
          onProgress,
        }
      );
    }

    async createPrefix(id: string, bucket: string, prefix: string): Promise<void> {
      await this.request<{ success: true }>(`/object-storage/${id}/objects/prefix`, {
        method: "POST",
        body: JSON.stringify({ bucket, prefix }),
      });
    }

    async deleteObjects(id: string, bucket: string, keys: string[]): Promise<void> {
      await this.request<{ success: true }>(`/object-storage/${id}/objects`, {
        method: "DELETE",
        body: JSON.stringify({ bucket, keys }),
      });
    }
  };
}
