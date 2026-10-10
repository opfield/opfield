import { setAppMemberListParams } from "@/lib/app-members";
import type {
  DatabaseConnection,
  ManagedCertificateStatus,
  ManagedDatabase,
  ManagedDatabaseBinding,
  ManagedDatabaseBindingCreateInput,
  ManagedDatabaseBindingDeleteInput,
  ManagedDatabaseBindingRuntimeStatus,
  ManagedDatabaseCatalogEntry,
  ManagedDatabaseCreateInput,
  ManagedPostgresExtension,
  PaginatedResponse,
  PostgresTableMetadata,
  RedisKeyRecord,
  ResourceFolder,
  ResourceFolderTreeNode,
  SqlBrowseResult,
  SqlExecutionResult,
  SqlNamespace,
  SqlObjectSummary,
  SqlRowMutationResult,
  SqlTableMetadata,
} from "@/types";
import { API_BASE } from "./api-base";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withDatabaseApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class DatabaseApiClient extends Base {
    // ── Databases ──────────────────────────────────────────────────

    async listDatabases(params?: {
      page?: number;
      limit?: number;
      search?: string;
      type?: "postgres" | "redis" | "clickhouse";
      healthStatus?: "online" | "offline" | "degraded" | "unknown";
      /** App members: see `AppMemberListFilter`. */
      excludeAppMembers?: boolean;
      appId?: string;
    }): Promise<PaginatedResponse<DatabaseConnection>> {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set("page", String(params.page));
      if (params?.limit) searchParams.set("limit", String(params.limit));
      if (params?.search) searchParams.set("search", params.search);
      if (params?.type) searchParams.set("type", params.type);
      if (params?.healthStatus) searchParams.set("healthStatus", params.healthStatus);
      setAppMemberListParams(searchParams, params);
      const query = searchParams.toString();
      return this.request<PaginatedResponse<DatabaseConnection>>(
        `/databases${query ? `?${query}` : ""}`
      );
    }

    async getDatabase(id: string): Promise<DatabaseConnection> {
      return this.unwrapData(this.request<{ data: DatabaseConnection }>(`/databases/${id}`));
    }

    async getDatabaseBySlug(slug: string): Promise<DatabaseConnection> {
      return this.unwrapData(
        this.requestRouteContext<{ data: DatabaseConnection }>(
          `/databases/by-slug/${encodeURIComponent(slug)}`
        )
      );
    }

    async getDatabaseHealthHistory(id: string): Promise<DatabaseConnection["healthHistory"]> {
      return this.unwrapData(this.request(`/databases/${id}/health-history`));
    }

    async getManagedDatabaseLogs(
      id: string,
      params?: { tail?: number; timestamps?: boolean }
    ): Promise<string[]> {
      const query = new URLSearchParams();
      if (params?.tail) query.set("tail", String(params.tail));
      if (params?.timestamps !== undefined) query.set("timestamps", String(params.timestamps));
      return this.unwrapData(
        this.request<{ data: string[] }>(
          `/databases/${encodeURIComponent(id)}/logs${query.size ? `?${query}` : ""}`
        )
      );
    }

    createManagedDatabaseLogStreamWebSocket(id: string, tail = 100): WebSocket {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(
        `${proto}//${window.location.host}${API_BASE}/databases/${encodeURIComponent(id)}/logs/stream?tail=${tail}`
      );
    }

    async createDatabase(data: Record<string, unknown>): Promise<DatabaseConnection> {
      return this.unwrapData(
        this.request<{ data: DatabaseConnection }>("/databases", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    // ── Managed databases ──────────────────────────────────────────

    async listManagedDatabaseCatalog(): Promise<ManagedDatabaseCatalogEntry[]> {
      return this.unwrapData(
        this.request<{ data: ManagedDatabaseCatalogEntry[] }>("/databases/managed/catalog")
      );
    }

    async listManagedDatabases(): Promise<ManagedDatabase[]> {
      return this.unwrapData(this.request<{ data: ManagedDatabase[] }>("/databases/managed"));
    }

    async getManagedDatabase(id: string): Promise<ManagedDatabase> {
      return this.unwrapData(
        this.request<{ data: ManagedDatabase }>(`/databases/managed/${encodeURIComponent(id)}`)
      );
    }

    async createManagedDatabase(data: ManagedDatabaseCreateInput): Promise<ManagedDatabase> {
      return this.unwrapData(
        this.request<{ data: ManagedDatabase }>("/databases/managed", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateManagedDatabase(
      id: string,
      data: Omit<Partial<ManagedDatabaseCreateInput>, "publishedPort" | "publishedNativePort"> & {
        publishedPort?: number | null;
        publishedNativePort?: number | null;
        tags?: string[];
      }
    ): Promise<ManagedDatabase> {
      return this.unwrapData(
        this.request<{ data: ManagedDatabase }>(`/databases/managed/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteManagedDatabase(id: string): Promise<void> {
      await this.request<void>(`/databases/managed/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    }

    async retryManagedDatabaseProvisioning(id: string): Promise<ManagedDatabase> {
      return this.unwrapData(
        this.request<{ data: ManagedDatabase }>(
          `/databases/managed/${encodeURIComponent(id)}/retry-provisioning`,
          { method: "POST" }
        )
      );
    }

    async restartManagedDatabase(id: string): Promise<ManagedDatabase> {
      return this.unwrapData(
        this.request<{ data: ManagedDatabase }>(
          `/databases/managed/${encodeURIComponent(id)}/restart`,
          {
            method: "POST",
          }
        )
      );
    }

    async pauseManagedDatabase(id: string): Promise<ManagedDatabase> {
      return this.unwrapData(
        this.request<{ data: ManagedDatabase }>(
          `/databases/managed/${encodeURIComponent(id)}/pause`,
          {
            method: "POST",
          }
        )
      );
    }

    async unpauseManagedDatabase(id: string): Promise<ManagedDatabase> {
      return this.unwrapData(
        this.request<{ data: ManagedDatabase }>(
          `/databases/managed/${encodeURIComponent(id)}/unpause`,
          {
            method: "POST",
          }
        )
      );
    }

    async revealManagedDatabaseCredentials(id: string): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/databases/managed/${encodeURIComponent(id)}/reveal-credentials`
        )
      );
    }

    async rotateManagedDatabaseDirectCredentials(id: string): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/databases/managed/${encodeURIComponent(id)}/rotate-direct-credentials`,
          { method: "POST" }
        )
      );
    }

    /** Reloads a renewed certificate in place; `allowRestart` permits a restart when the engine does not load it. */
    async rotateManagedDatabaseCertificate(
      id: string,
      options: { allowRestart?: boolean } = {}
    ): Promise<
      ManagedDatabase & {
        certificateRenewal?: { status: string; method?: string; restarted?: boolean };
      }
    > {
      return this.unwrapData(
        this.request<{
          data: ManagedDatabase & {
            certificateRenewal?: { status: string; method?: string; restarted?: boolean };
          };
        }>(`/databases/managed/${encodeURIComponent(id)}/rotate-certificate`, {
          method: "POST",
          body: JSON.stringify(options),
        })
      );
    }

    /** Server certificate expiry and automatic renewal state. */
    async getManagedDatabaseCertificate(id: string): Promise<ManagedCertificateStatus> {
      return this.unwrapData(
        this.request<{ data: ManagedCertificateStatus }>(
          `/databases/managed/${encodeURIComponent(id)}/certificate`
        )
      );
    }

    async listManagedDatabaseBindings(id: string): Promise<ManagedDatabaseBinding[]> {
      return this.unwrapData(
        this.request<{ data: ManagedDatabaseBinding[] }>(
          `/databases/managed/${encodeURIComponent(id)}/bindings`
        )
      );
    }

    async createManagedDatabaseBinding(
      id: string,
      data: ManagedDatabaseBindingCreateInput
    ): Promise<ManagedDatabaseBinding> {
      return this.unwrapData(
        this.request<{ data: ManagedDatabaseBinding }>(
          `/databases/managed/${encodeURIComponent(id)}/bindings`,
          { method: "POST", body: JSON.stringify(data) }
        )
      );
    }

    async deleteManagedDatabaseBinding(
      id: string,
      bindingId: string,
      data?: ManagedDatabaseBindingDeleteInput
    ): Promise<void> {
      await this.request<void>(
        `/databases/managed/${encodeURIComponent(id)}/bindings/${encodeURIComponent(bindingId)}`,
        { method: "DELETE", body: JSON.stringify(data ?? {}) }
      );
    }

    async getManagedDatabaseBindingRuntime(
      id: string,
      bindingId: string
    ): Promise<ManagedDatabaseBindingRuntimeStatus> {
      return this.unwrapData(
        this.request<{ data: ManagedDatabaseBindingRuntimeStatus }>(
          `/databases/managed/${encodeURIComponent(id)}/bindings/${encodeURIComponent(bindingId)}/runtime`
        )
      );
    }

    async revealManagedDatabaseBindingCredentials(
      id: string,
      bindingId: string
    ): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(
          `/databases/managed/${encodeURIComponent(id)}/bindings/${encodeURIComponent(bindingId)}/reveal-credentials`
        )
      );
    }

    async updateDatabase(id: string, data: Record<string, unknown>): Promise<DatabaseConnection> {
      return this.unwrapData(
        this.request<{ data: DatabaseConnection }>(`/databases/${id}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteDatabase(id: string): Promise<void> {
      await this.request<void>(`/databases/${id}`, { method: "DELETE" });
    }

    async listDatabaseFolders(): Promise<ResourceFolderTreeNode[]> {
      return this.unwrapData(
        this.request<{ data: ResourceFolderTreeNode[] }>("/databases/folders")
      );
    }

    async createDatabaseFolder(data: { name: string; parentId?: string }): Promise<ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: ResourceFolder }>("/databases/folders", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateDatabaseFolder(id: string, data: { name: string }): Promise<ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: ResourceFolder }>(`/databases/folders/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteDatabaseFolder(id: string): Promise<void> {
      await this.request<void>(`/databases/folders/${id}`, { method: "DELETE" });
    }

    async reorderDatabaseFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request<void>("/databases/folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async moveDatabasesToFolder(ids: string[], folderId: string | null): Promise<void> {
      await this.request<void>("/databases/folders/move-databases", {
        method: "POST",
        body: JSON.stringify({ ids, folderId }),
      });
    }

    async reorderDatabases(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request<void>("/databases/folders/reorder-databases", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async testDatabase(id: string): Promise<{ ok: true; responseMs: number; status: string }> {
      return this.unwrapData(
        this.request<{ data: { ok: true; responseMs: number; status: string } }>(
          `/databases/${id}/test`,
          { method: "POST" }
        )
      );
    }

    async revealDatabaseCredentials(id: string): Promise<Record<string, unknown>> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> }>(`/databases/${id}/reveal-credentials`)
      );
    }

    createDatabaseMonitoringStream(id: string): EventSource {
      return new EventSource(`${API_BASE}/databases/${id}/monitoring/stream`, {
        withCredentials: true,
      });
    }

    // ── Database Query Tools ─────────────────────────────────────────

    async listSqlNamespaces(id: string): Promise<SqlNamespace[]> {
      return this.unwrapData(
        this.request<{ data: SqlNamespace[] }>(`/databases/${id}/sql/namespaces`)
      );
    }

    async listSqlObjects(id: string, namespace: string): Promise<SqlObjectSummary[]> {
      return this.unwrapData(
        this.request<{ data: SqlObjectSummary[] }>(
          `/databases/${id}/sql/objects?namespace=${encodeURIComponent(namespace)}`
        )
      );
    }

    async getSqlTableMetadata(
      id: string,
      namespace: string,
      table: string
    ): Promise<SqlTableMetadata> {
      const query = new URLSearchParams({ namespace, table }).toString();
      return this.unwrapData(
        this.request<{ data: SqlTableMetadata }>(`/databases/${id}/sql/table-metadata?${query}`)
      );
    }

    async browseSqlRows(
      id: string,
      params: {
        namespace: string;
        table: string;
        page?: number;
        limit?: number;
        sortBy?: string;
        sortOrder?: "asc" | "desc";
        searchColumn?: string;
        searchOperation?: "like" | "equals" | "notEquals" | "greaterThan" | "lessThan";
        searchValue?: string;
      }
    ): Promise<SqlBrowseResult> {
      const query = new URLSearchParams({
        namespace: params.namespace,
        table: params.table,
        page: String(params.page ?? 1),
        limit: String(params.limit ?? 100),
        ...(params.sortBy ? { sortBy: params.sortBy } : {}),
        ...(params.sortOrder ? { sortOrder: params.sortOrder } : {}),
        ...(params.searchColumn ? { searchColumn: params.searchColumn } : {}),
        ...(params.searchOperation ? { searchOperation: params.searchOperation } : {}),
        ...(params.searchValue ? { searchValue: params.searchValue } : {}),
      }).toString();
      return this.unwrapData(
        this.request<{ data: SqlBrowseResult }>(`/databases/${id}/sql/rows?${query}`)
      );
    }

    async insertSqlRow(
      id: string,
      namespace: string,
      table: string,
      values: Record<string, unknown>
    ): Promise<SqlRowMutationResult> {
      return this.unwrapData(
        this.request<{ data: SqlRowMutationResult }>(`/databases/${id}/sql/rows`, {
          method: "POST",
          body: JSON.stringify({ namespace, table, values }),
        })
      );
    }

    async updateSqlRow(
      id: string,
      namespace: string,
      table: string,
      locator: Record<string, unknown>,
      values: Record<string, unknown>
    ): Promise<SqlRowMutationResult> {
      return this.unwrapData(
        this.request<{ data: SqlRowMutationResult }>(`/databases/${id}/sql/rows`, {
          method: "PATCH",
          body: JSON.stringify({ namespace, table, locator, values }),
        })
      );
    }

    async deleteSqlRow(
      id: string,
      namespace: string,
      table: string,
      locator: Record<string, unknown>
    ): Promise<SqlRowMutationResult> {
      return this.unwrapData(
        this.request<{ data: SqlRowMutationResult }>(`/databases/${id}/sql/rows`, {
          method: "DELETE",
          body: JSON.stringify({ namespace, table, locator }),
        })
      );
    }

    async executeSql(id: string, sql: string, signal?: AbortSignal): Promise<SqlExecutionResult> {
      return this.unwrapData(
        this.request<{ data: SqlExecutionResult }>(`/databases/${id}/sql/query`, {
          method: "POST",
          body: JSON.stringify({ sql, maxRows: 500 }),
          ...(signal ? { signal } : {}),
        })
      );
    }

    async listPostgresSchemas(id: string): Promise<string[]> {
      return this.unwrapData(this.request<{ data: string[] }>(`/databases/${id}/postgres/schemas`));
    }

    async listManagedPostgresExtensions(id: string): Promise<ManagedPostgresExtension[]> {
      return this.unwrapData(
        this.request<{ data: ManagedPostgresExtension[] }>(`/databases/${id}/postgres/extensions`)
      );
    }

    async enableManagedPostgresExtension(
      id: string,
      name: string
    ): Promise<ManagedPostgresExtension[]> {
      return this.unwrapData(
        this.request<{ data: ManagedPostgresExtension[] }>(
          `/databases/${id}/postgres/extensions/${encodeURIComponent(name)}`,
          { method: "POST" }
        )
      );
    }

    async disableManagedPostgresExtension(
      id: string,
      name: string
    ): Promise<ManagedPostgresExtension[]> {
      return this.unwrapData(
        this.request<{ data: ManagedPostgresExtension[] }>(
          `/databases/${id}/postgres/extensions/${encodeURIComponent(name)}`,
          { method: "DELETE" }
        )
      );
    }

    async listPostgresTables(
      id: string,
      schema: string
    ): Promise<Array<{ name: string; type: "table" | "view" }>> {
      return this.unwrapData(
        this.request<{ data: Array<{ name: string; type: "table" | "view" }> }>(
          `/databases/${id}/postgres/tables?schema=${encodeURIComponent(schema)}`
        )
      );
    }

    async getPostgresTableMetadata(
      id: string,
      schema: string,
      table: string
    ): Promise<PostgresTableMetadata> {
      const query = new URLSearchParams({ schema, table }).toString();
      return this.unwrapData(
        this.request<{ data: PostgresTableMetadata }>(
          `/databases/${id}/postgres/table-metadata?${query}`
        )
      );
    }

    async browsePostgresRows(
      id: string,
      params: {
        schema: string;
        table: string;
        page?: number;
        limit?: number;
        sortBy?: string;
        sortOrder?: "asc" | "desc";
        searchColumn?: string;
        searchOperation?: "like" | "equals" | "notEquals" | "greaterThan" | "lessThan";
        searchValue?: string;
      }
    ): Promise<{
      metadata: PostgresTableMetadata;
      rows: Record<string, unknown>[];
      total: number;
      page: number;
      limit: number;
    }> {
      const query = new URLSearchParams({
        schema: params.schema,
        table: params.table,
        page: String(params.page ?? 1),
        limit: String(params.limit ?? 100),
        ...(params.sortBy ? { sortBy: params.sortBy } : {}),
        ...(params.sortOrder ? { sortOrder: params.sortOrder } : {}),
        ...(params.searchColumn ? { searchColumn: params.searchColumn } : {}),
        ...(params.searchOperation ? { searchOperation: params.searchOperation } : {}),
        ...(params.searchValue ? { searchValue: params.searchValue } : {}),
      }).toString();
      return this.unwrapData(
        this.request<{
          data: {
            metadata: PostgresTableMetadata;
            rows: Record<string, unknown>[];
            total: number;
            page: number;
            limit: number;
          };
        }>(`/databases/${id}/postgres/rows?${query}`)
      );
    }

    async insertPostgresRow(
      id: string,
      schema: string,
      table: string,
      values: Record<string, unknown>
    ): Promise<Record<string, unknown> | null> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> | null }>(`/databases/${id}/postgres/rows`, {
          method: "POST",
          body: JSON.stringify({ schema, table, values }),
        })
      );
    }

    async updatePostgresRow(
      id: string,
      schema: string,
      table: string,
      primaryKey: Record<string, unknown>,
      values: Record<string, unknown>
    ): Promise<Record<string, unknown> | null> {
      return this.unwrapData(
        this.request<{ data: Record<string, unknown> | null }>(`/databases/${id}/postgres/rows`, {
          method: "PATCH",
          body: JSON.stringify({ schema, table, primaryKey, values }),
        })
      );
    }

    async deletePostgresRow(
      id: string,
      schema: string,
      table: string,
      primaryKey: Record<string, unknown>
    ): Promise<void> {
      await this.request<{ data: { success: true } }>(`/databases/${id}/postgres/rows`, {
        method: "DELETE",
        body: JSON.stringify({ schema, table, primaryKey }),
      });
    }

    async updatePostgresColumnType(
      id: string,
      schema: string,
      table: string,
      column: string,
      dataType: string
    ): Promise<PostgresTableMetadata> {
      return this.unwrapData(
        this.request<{ data: PostgresTableMetadata }>(`/databases/${id}/postgres/columns/type`, {
          method: "PATCH",
          body: JSON.stringify({ schema, table, column, dataType }),
        })
      );
    }

    async addPostgresColumn(
      id: string,
      schema: string,
      table: string,
      column: string,
      dataType: string
    ): Promise<PostgresTableMetadata> {
      return this.unwrapData(
        this.request<{ data: PostgresTableMetadata }>(`/databases/${id}/postgres/columns`, {
          method: "POST",
          body: JSON.stringify({ schema, table, column, dataType }),
        })
      );
    }

    async deletePostgresColumn(
      id: string,
      schema: string,
      table: string,
      column: string
    ): Promise<PostgresTableMetadata> {
      return this.unwrapData(
        this.request<{ data: PostgresTableMetadata }>(`/databases/${id}/postgres/columns`, {
          method: "DELETE",
          body: JSON.stringify({ schema, table, column }),
        })
      );
    }

    async executePostgresSql(
      id: string,
      sql: string
    ): Promise<{
      results: Array<{
        command: string;
        rowCount: number;
        durationMs?: number;
        fields: string[];
        rows: Record<string, unknown>[];
        truncated?: boolean;
        maxRows?: number;
      }>;
      truncated?: boolean;
      resultLimit?: number;
    }> {
      return this.unwrapData(
        this.request<{
          data: {
            results: Array<{
              command: string;
              rowCount: number;
              durationMs?: number;
              fields: string[];
              rows: Record<string, unknown>[];
              truncated?: boolean;
              maxRows?: number;
            }>;
            truncated?: boolean;
            resultLimit?: number;
          };
        }>(`/databases/${id}/postgres/query`, {
          method: "POST",
          body: JSON.stringify({ sql, maxRows: 500 }),
        })
      );
    }

    async scanRedisKeys(
      id: string,
      params?: { cursor?: number; limit?: number; search?: string; type?: string }
    ): Promise<{ cursor: number; done: boolean; keys: RedisKeyRecord[] }> {
      const query = new URLSearchParams();
      if (params?.cursor !== undefined) query.set("cursor", String(params.cursor));
      if (params?.limit !== undefined) query.set("limit", String(params.limit));
      if (params?.search) query.set("search", params.search);
      if (params?.type) query.set("type", params.type);
      return this.unwrapData(
        this.request<{ data: { cursor: number; done: boolean; keys: RedisKeyRecord[] } }>(
          `/databases/${id}/redis/keys${query.toString() ? `?${query.toString()}` : ""}`
        )
      );
    }

    async getRedisKey(
      id: string,
      key: string,
      params?: { offset?: number; limit?: number; maxStringBytes?: number }
    ): Promise<{
      key: string;
      type: string;
      ttlSeconds: number;
      value: unknown;
      page?: Record<string, unknown>;
    }> {
      const query = new URLSearchParams({ key });
      if (params?.offset !== undefined) query.set("offset", String(params.offset));
      if (params?.limit !== undefined) query.set("limit", String(params.limit));
      if (params?.maxStringBytes !== undefined)
        query.set("maxStringBytes", String(params.maxStringBytes));
      return this.unwrapData(
        this.request<{
          data: {
            key: string;
            type: string;
            ttlSeconds: number;
            value: unknown;
            page?: Record<string, unknown>;
          };
        }>(`/databases/${id}/redis/key?${query.toString()}`)
      );
    }

    async setRedisKey(
      id: string,
      data: Record<string, unknown>
    ): Promise<{
      key: string;
      type: string;
      ttlSeconds: number;
      value: unknown;
    }> {
      return this.unwrapData(
        this.request<{
          data: { key: string; type: string; ttlSeconds: number; value: unknown };
        }>(`/databases/${id}/redis/key`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteRedisKey(id: string, key: string): Promise<void> {
      await this.request<{ data: { success: true } }>(`/databases/${id}/redis/key`, {
        method: "DELETE",
        body: JSON.stringify({ key }),
      });
    }

    async expireRedisKey(
      id: string,
      key: string,
      ttlSeconds: number
    ): Promise<{ key: string; type: string; ttlSeconds: number; value: unknown }> {
      return this.unwrapData(
        this.request<{
          data: { key: string; type: string; ttlSeconds: number; value: unknown };
        }>(`/databases/${id}/redis/key/expire`, {
          method: "POST",
          body: JSON.stringify({ key, ttlSeconds }),
        })
      );
    }

    async executeRedisCommand(
      id: string,
      command: string
    ): Promise<{
      results: Array<{ command: string; result: unknown; truncated?: boolean }>;
      truncated?: boolean;
      commandLimit?: number;
    }> {
      return this.unwrapData(
        this.request<{
          data: {
            results: Array<{ command: string; result: unknown; truncated?: boolean }>;
            truncated?: boolean;
            commandLimit?: number;
          };
        }>(`/databases/${id}/redis/command`, {
          method: "POST",
          body: JSON.stringify({ command }),
        })
      );
    }

    // ── System / Updates ──────────────────────────────────────────────
  };
}
