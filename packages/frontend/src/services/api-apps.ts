import type {
  AppActivityPage,
  AppAllowedNodes,
  AppDetail,
  AppEnvironmentDetail,
  AppEnvironmentUpdateInput,
  AppMaintenanceAccessCode,
  AppMember,
  AppOverview,
  AppOverviewRange,
  AppPlaceInput,
  AppPlaceResult,
  AppSecretsPatch,
  AppSummary,
  AppUpdateInput,
  AppVariables,
  DatabaseConnection,
  ObjectStorageConnection,
  PageProject,
  PaginatedResponse,
  ProxyHost,
} from "@/types";
import type { ApiClientBaseConstructor } from "./api-mixins";

const seg = (value: string) => encodeURIComponent(value);

/** Upper bound of pages read for one app tab list (each page is the endpoint's maximum page size). */
const MAX_MEMBER_PAGES = 50;

/** Cache keys of the Apps pages (invalidated by every `/apps` mutation). */
export const APPS_LIST_CACHE_KEY = "apps:list";
export const appDetailCacheKey = (idOrSlug: string) => `apps:detail:${idOrSlug}`;

export function withAppsApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class AppsApiClient extends Base {
    // ── Apps ───────────────────────────────────────────────────────

    async listApps(): Promise<AppSummary[]> {
      return this.unwrapData(this.request<{ data: AppSummary[] }>("/apps"));
    }

    async createApp(data: { name: string }): Promise<AppDetail> {
      return this.unwrapData(
        this.request<{ data: AppDetail }>("/apps", { method: "POST", body: JSON.stringify(data) })
      );
    }

    async getApp(idOrSlug: string): Promise<AppDetail> {
      return this.unwrapData(this.request<{ data: AppDetail }>(`/apps/${seg(idOrSlug)}`));
    }

    async getAppRouteContext(idOrSlug: string): Promise<AppDetail> {
      return this.unwrapData(
        this.requestRouteContext<{ data: AppDetail }>(`/apps/${seg(idOrSlug)}`)
      );
    }

    async updateApp(id: string, data: AppUpdateInput): Promise<AppDetail> {
      return this.unwrapData(
        this.request<{ data: AppDetail }>(`/apps/${seg(id)}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteApp(id: string): Promise<void> {
      await this.request<unknown>(`/apps/${seg(id)}`, { method: "DELETE" });
    }

    // ── Environments ───────────────────────────────────────────────

    async createAppEnvironment(
      appId: string,
      data: { name: string }
    ): Promise<AppEnvironmentDetail> {
      return this.unwrapData(
        this.request<{ data: AppEnvironmentDetail }>(`/apps/${seg(appId)}/environments`, {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateAppEnvironment(
      appId: string,
      envId: string,
      data: AppEnvironmentUpdateInput
    ): Promise<AppEnvironmentDetail> {
      return this.unwrapData(
        this.request<{ data: AppEnvironmentDetail }>(
          `/apps/${seg(appId)}/environments/${seg(envId)}`,
          { method: "PATCH", body: JSON.stringify(data) }
        )
      );
    }

    async deleteAppEnvironment(appId: string, envId: string): Promise<void> {
      await this.request<unknown>(`/apps/${seg(appId)}/environments/${seg(envId)}`, {
        method: "DELETE",
      });
    }

    // ── Members ────────────────────────────────────────────────────

    async listAppMembers(appId: string, environmentId?: string): Promise<AppMember[]> {
      const query = environmentId ? `?environmentId=${seg(environmentId)}` : "";
      return this.unwrapData(
        this.request<{ data: AppMember[] }>(`/apps/${seg(appId)}/members${query}`)
      );
    }

    /** Import / move into an app environment, or take out of apps (`target: null`). */
    async placeAppMembers(data: AppPlaceInput): Promise<AppPlaceResult> {
      return this.unwrapData(
        this.request<{ data: AppPlaceResult }>("/apps/members/place", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    // ── Variables and secrets ──────────────────────────────────────

    async getAppVariables(appId: string, envId: string): Promise<AppVariables> {
      return this.unwrapData(
        this.request<{ data: AppVariables }>(
          `/apps/${seg(appId)}/environments/${seg(envId)}/variables`
        )
      );
    }

    async setAppVariables(
      appId: string,
      envId: string,
      variables: Array<{ key: string; value: string }>
    ): Promise<AppVariables> {
      return this.unwrapData(
        this.request<{ data: AppVariables }>(
          `/apps/${seg(appId)}/environments/${seg(envId)}/variables`,
          { method: "PUT", body: JSON.stringify({ variables }) }
        )
      );
    }

    async patchAppSecrets(
      appId: string,
      envId: string,
      patch: AppSecretsPatch
    ): Promise<AppVariables> {
      return this.unwrapData(
        this.request<{ data: AppVariables }>(
          `/apps/${seg(appId)}/environments/${seg(envId)}/secrets`,
          { method: "PATCH", body: JSON.stringify(patch) }
        )
      );
    }

    // ── Allowed nodes ──────────────────────────────────────────────

    async listAppAllowedNodes(appId: string, envId: string): Promise<AppAllowedNodes> {
      return this.unwrapData(
        this.request<{ data: AppAllowedNodes }>(
          `/apps/${seg(appId)}/environments/${seg(envId)}/nodes`
        )
      );
    }

    async allowAppNode(appId: string, envId: string, nodeId: string): Promise<AppAllowedNodes> {
      return this.unwrapData(
        this.request<{ data: AppAllowedNodes }>(
          `/apps/${seg(appId)}/environments/${seg(envId)}/nodes`,
          { method: "POST", body: JSON.stringify({ nodeId }) }
        )
      );
    }

    async removeAppNode(appId: string, envId: string, nodeId: string): Promise<AppAllowedNodes> {
      return this.unwrapData(
        this.request<{ data: AppAllowedNodes }>(
          `/apps/${seg(appId)}/environments/${seg(envId)}/nodes`,
          { method: "DELETE", body: JSON.stringify({ nodeId }) }
        )
      );
    }

    // ── Member rows for the app tabs (normal list endpoints, `appId` filter) ──

    /** Every row of a list endpoint the server narrows to one app's members (`appId`), page by page. */
    async listAllAppMembers<T>(path: string, appId: string, limit: number): Promise<T[]> {
      const rows: T[] = [];
      for (let page = 1; page <= MAX_MEMBER_PAGES; page += 1) {
        const response = await this.request<PaginatedResponse<T>>(
          `${path}?appId=${seg(appId)}&limit=${limit}&page=${page}`
        );
        rows.push(...response.data);
        if (page >= (response.pagination?.totalPages ?? 1) || response.data.length < limit) break;
      }
      return rows;
    }

    async listAppRoutes(appId: string): Promise<ProxyHost[]> {
      return this.listAllAppMembers<ProxyHost>("/proxy-hosts", appId, 100);
    }

    async listAppDatabases(appId: string): Promise<DatabaseConnection[]> {
      return this.listAllAppMembers<DatabaseConnection>("/databases", appId, 200);
    }

    async listAppStorage(appId: string): Promise<ObjectStorageConnection[]> {
      return this.listAllAppMembers<ObjectStorageConnection>("/object-storage", appId, 200);
    }

    async listAppPages(appId: string): Promise<PageProject[]> {
      return this.listAllAppMembers<PageProject>("/pages", appId, 100);
    }

    // ── Maintenance access code, overview, activity ────────────────

    async createAppMaintenanceAccessCode(
      appId: string,
      environmentId?: string
    ): Promise<AppMaintenanceAccessCode> {
      return this.unwrapData(
        this.request<{ data: AppMaintenanceAccessCode }>(
          `/apps/${seg(appId)}/maintenance-access-code`,
          { method: "POST", body: JSON.stringify(environmentId ? { environmentId } : {}) }
        )
      );
    }

    async getAppOverview(appId: string, range: AppOverviewRange = "1h"): Promise<AppOverview> {
      return this.unwrapData(
        this.request<{ data: AppOverview }>(`/apps/${seg(appId)}/overview?range=${range}`)
      );
    }

    async getAppActivity(
      appId: string,
      params?: { page?: number; limit?: number; environmentId?: string }
    ): Promise<AppActivityPage> {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.limit) query.set("limit", String(params.limit));
      if (params?.environmentId) query.set("environmentId", params.environmentId);
      return this.request<AppActivityPage>(
        `/apps/${seg(appId)}/activity${query.size ? `?${query}` : ""}`
      );
    }
  };
}
