import {
  INFERENCE_SELF_USAGE_CACHE_KEY,
  publishInferenceSelfUsage,
} from "@/lib/inference-self-usage";
import type {
  InferenceActivityFilters,
  InferenceActivityPage,
  InferenceActivityQuery,
  InferenceLimitInput,
  InferenceLimitPolicy,
  InferenceLimitResetResult,
  InferenceModel,
  InferenceOAuthSession,
  InferenceProviderCatalogItem,
  InferenceProviderConnection,
  InferenceSelfUsage,
  InferenceSystemUsage,
  InferenceToken,
  InferenceUsageOverview,
  InferenceUserUsage,
} from "@/types/inference";
import type { ApiClientBaseConstructor } from "./api-mixins";

/** A model as the inference data plane lists it to a client (`GET /api/inference/v1/models`). */
export interface InferenceClientModel {
  id: string;
  display_name?: string | null;
}

export function withInferenceApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class InferenceApi extends Base {
    listInferenceTokens(): Promise<InferenceToken[]> {
      return this.request("/inference/tokens");
    }

    createInferenceToken(name: string): Promise<InferenceToken & { token: string }> {
      return this.request("/inference/tokens", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    }

    /** The models the current user can call: the catalog their inference keys see, read with the session. */
    async listInferenceCatalog(): Promise<InferenceClientModel[]> {
      const body = await this.request<{ data?: InferenceClientModel[] }>("/inference/catalog");
      return body?.data ?? [];
    }

    revokeInferenceToken(id: string): Promise<void> {
      return this.request(`/inference/tokens/${id}`, { method: "DELETE" });
    }

    async getInferenceSelfUsage(): Promise<InferenceSelfUsage> {
      const usage = await this.request<InferenceSelfUsage>("/inference/usage/self");
      const accepted = this.acceptFreshSnapshot(INFERENCE_SELF_USAGE_CACHE_KEY, usage);
      if (accepted !== usage) this.setCache(INFERENCE_SELF_USAGE_CACHE_KEY, accepted);
      else publishInferenceSelfUsage(accepted);
      return accepted;
    }

    getInferenceSelfUsageOverview(): Promise<InferenceUsageOverview> {
      return this.request("/inference/usage/self/overview");
    }

    getInferenceSystemUsage(): Promise<InferenceSystemUsage> {
      return this.request("/inference/usage/system");
    }

    listInferenceUsersUsage(): Promise<InferenceUserUsage[]> {
      return this.request("/inference/usage/users");
    }

    listInferenceLimitUsers(): Promise<InferenceUserUsage[]> {
      return this.request("/inference/limits/users");
    }

    listInferenceActivity(query: InferenceActivityQuery = {}): Promise<InferenceActivityPage> {
      const params = new URLSearchParams();
      if (query.page) params.set("page", String(query.page));
      if (query.limit) params.set("limit", String(query.limit));
      if (query.search) params.set("search", query.search);
      if (query.status) params.set("status", query.status);
      if (query.userId) params.set("userId", query.userId);
      if (query.model) params.set("model", query.model);
      const suffix = params.size ? `?${params.toString()}` : "";
      return this.request(`/inference/usage/activity${suffix}`);
    }

    listInferenceActivityFilters(): Promise<InferenceActivityFilters> {
      return this.request("/inference/usage/activity/filters");
    }

    listInferenceProviderCatalog(): Promise<InferenceProviderCatalogItem[]> {
      return this.request("/inference/providers/catalog");
    }

    listInferenceProviderConnections(): Promise<InferenceProviderConnection[]> {
      return this.request("/inference/providers/connections");
    }

    createInferenceProviderConnection(
      data: Record<string, unknown>
    ): Promise<InferenceProviderConnection> {
      return this.request("/inference/providers/connections", {
        method: "POST",
        body: JSON.stringify(data),
      });
    }

    startInferenceOAuth(data: Record<string, unknown>): Promise<InferenceOAuthSession> {
      return this.request("/inference/providers/oauth/start", {
        method: "POST",
        body: JSON.stringify(data),
      });
    }

    getInferenceOAuthStatus(id: string): Promise<InferenceOAuthSession> {
      return this.request(`/inference/providers/oauth/${id}`);
    }

    completeInferenceOAuth(id: string, callback?: string): Promise<InferenceOAuthSession> {
      return this.request(`/inference/providers/oauth/${id}/complete`, {
        method: "POST",
        body: JSON.stringify({ callback }),
      });
    }

    cancelInferenceOAuth(id: string): Promise<InferenceOAuthSession> {
      return this.request(`/inference/providers/oauth/${id}/cancel`, { method: "POST" });
    }

    syncInferenceProvider(id: string): Promise<InferenceProviderConnection> {
      return this.request(`/inference/providers/connections/${id}/sync`, { method: "POST" });
    }

    updateInferenceProvider(
      id: string,
      data: Record<string, unknown>
    ): Promise<InferenceProviderConnection> {
      return this.request(`/inference/providers/connections/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
    }

    disconnectInferenceProvider(id: string): Promise<void> {
      return this.request(`/inference/providers/connections/${id}`, { method: "DELETE" });
    }

    updateInferenceRouting(
      providerId: string,
      routingStrategy: "even" | "balanced" | "sequential"
    ) {
      return this.request(`/inference/providers/${providerId}/routing`, {
        method: "PATCH",
        body: JSON.stringify({ routingStrategy }),
      });
    }

    listInferenceModels(): Promise<InferenceModel[]> {
      return this.request("/inference/models");
    }

    reorderInferenceModels(items: Array<{ id: string; sortOrder: number }>): Promise<void> {
      return this.request("/inference/models/reorder", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    saveInferenceModelConfiguration(
      id: string | null,
      data: Record<string, unknown>
    ): Promise<InferenceModel> {
      return this.request(
        id ? `/inference/models/${id}/configuration` : "/inference/models/configuration",
        {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(data),
        }
      );
    }

    deleteInferenceModel(id: string): Promise<void> {
      return this.request(`/inference/models/${id}`, { method: "DELETE" });
    }

    listInferenceLimits(): Promise<InferenceLimitPolicy[]> {
      return this.request("/inference/limits");
    }

    async setInferenceDefaultLimits(data: InferenceLimitInput): Promise<InferenceLimitPolicy[]> {
      const policies = await this.request<InferenceLimitPolicy[]>("/inference/limits/default", {
        method: "PUT",
        body: JSON.stringify(data),
      });
      this.invalidateCache("req:/api/inference/usage");
      this.invalidateCache("req:/api/inference/limits/users");
      return policies;
    }

    async setInferenceUserLimits(
      id: string,
      data: InferenceLimitInput
    ): Promise<InferenceLimitPolicy[]> {
      const policies = await this.request<InferenceLimitPolicy[]>(`/inference/limits/users/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
      this.invalidateCache("req:/api/inference/usage");
      this.invalidateCache("req:/api/inference/limits/users");
      return policies;
    }

    async deleteInferenceUserLimits(id: string): Promise<void> {
      await this.request(`/inference/limits/users/${id}`, { method: "DELETE" });
      this.invalidateCache("req:/api/inference/usage");
      this.invalidateCache("req:/api/inference/limits/users");
    }

    async resetInferenceUserLimits(id: string): Promise<InferenceLimitResetResult> {
      const result = await this.request<InferenceLimitResetResult>(
        `/inference/limits/users/${id}/reset`,
        { method: "POST" }
      );
      this.invalidateCache("req:/api/inference/usage");
      this.invalidateCache("req:/api/inference/usage/users");
      this.invalidateCache("req:/api/inference/limits/users");
      return result;
    }
  };
}
