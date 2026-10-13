import type {
  AlertCategoryDef,
  AlertRule,
  NotificationWebhook,
  SiemAuthType,
  SiemDelivery,
  SiemDeliveryStatus,
  SiemDestination,
  WebhookDelivery,
  WebhookPreset,
} from "@/types";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withNotificationApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class NotificationApiClient extends Base {
    // ── Notification Alert Rules ──────────────────────────────────────

    async listAlertRules(params?: {
      page?: number;
      limit?: number;
      type?: string;
      enabled?: boolean;
      search?: string;
    }): Promise<{
      data: AlertRule[];
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    }> {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.limit) query.set("limit", String(params.limit));
      if (params?.type) query.set("type", params.type);
      if (params?.enabled !== undefined) query.set("enabled", String(params.enabled));
      if (params?.search) query.set("search", params.search);
      const qs = query.toString();
      return this.request(`/notifications/alert-rules${qs ? `?${qs}` : ""}`);
    }

    /** What a relay_pool or docker_availability rule can be scoped to (they have no list of their own). */
    async getAlertCategoryResources(
      category: "relay_pool" | "docker_availability"
    ): Promise<Array<{ id: string; label: string }>> {
      return this.unwrapData(
        this.request<{ data: Array<{ id: string; label: string }> }>(
          `/notifications/alert-rules/categories/${category}/resources`
        )
      );
    }

    async getAlertCategories(): Promise<AlertCategoryDef[]> {
      return this.unwrapData(this.request("/notifications/alert-rules/categories"));
    }

    async createAlertRule(
      data: Omit<AlertRule, "id" | "createdAt" | "updatedAt" | "isBuiltin">
    ): Promise<AlertRule> {
      return this.unwrapData(
        this.request("/notifications/alert-rules", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateAlertRule(
      id: string,
      data: Partial<Omit<AlertRule, "id" | "createdAt" | "updatedAt" | "isBuiltin">>
    ): Promise<AlertRule> {
      return this.unwrapData(
        this.request(`/notifications/alert-rules/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteAlertRule(id: string): Promise<void> {
      await this.request(`/notifications/alert-rules/${id}`, { method: "DELETE" });
    }

    // ── Notification Webhooks ───────────────────────────────────────

    async listWebhooks(params?: {
      page?: number;
      limit?: number;
      enabled?: boolean;
      search?: string;
    }): Promise<{
      data: NotificationWebhook[];
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    }> {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.limit) query.set("limit", String(params.limit));
      if (params?.enabled !== undefined) query.set("enabled", String(params.enabled));
      if (params?.search) query.set("search", params.search);
      const qs = query.toString();
      return this.request(`/notifications/webhooks${qs ? `?${qs}` : ""}`);
    }

    async getWebhookPresets(): Promise<WebhookPreset[]> {
      return this.unwrapData(this.request("/notifications/webhooks/presets"));
    }

    async createWebhook(
      data: Omit<NotificationWebhook, "id" | "createdAt" | "updatedAt">
    ): Promise<NotificationWebhook> {
      return this.unwrapData(
        this.request("/notifications/webhooks", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateWebhook(
      id: string,
      data: Partial<Omit<NotificationWebhook, "id" | "createdAt" | "updatedAt">>
    ): Promise<NotificationWebhook> {
      return this.unwrapData(
        this.request(`/notifications/webhooks/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteWebhook(id: string): Promise<void> {
      await this.request(`/notifications/webhooks/${id}`, { method: "DELETE" });
    }

    async testWebhook(
      id: string
    ): Promise<{ success: boolean; statusCode?: number; error?: string; rendered?: string }> {
      return this.unwrapData(
        this.request(`/notifications/webhooks/${id}/test`, { method: "POST" })
      );
    }

    async previewWebhookTemplate(
      bodyTemplate: string
    ): Promise<{ rendered: string; context: Record<string, unknown> }> {
      return this.unwrapData(
        this.request("/notifications/webhooks/preview", {
          method: "POST",
          body: JSON.stringify({ bodyTemplate }),
        })
      );
    }

    // ── Notification Deliveries ─────────────────────────────────────

    async listDeliveries(params?: {
      page?: number;
      limit?: number;
      webhookId?: string;
      status?: string;
      eventType?: string;
    }): Promise<{
      data: WebhookDelivery[];
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    }> {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.limit) query.set("limit", String(params.limit));
      if (params?.webhookId) query.set("webhookId", params.webhookId);
      if (params?.status) query.set("status", params.status);
      if (params?.eventType) query.set("eventType", params.eventType);
      const qs = query.toString();
      return this.request(`/notifications/deliveries${qs ? `?${qs}` : ""}`);
    }

    async getDelivery(id: string): Promise<WebhookDelivery> {
      return this.unwrapData(
        this.request<{ data: WebhookDelivery }>(`/notifications/deliveries/${id}`)
      );
    }

    async getDeliveryStats(
      webhookId?: string
    ): Promise<{ total: number; success: number; failed: number; retrying: number }> {
      const qs = webhookId ? `?webhookId=${webhookId}` : "";
      return this.unwrapData(this.request(`/notifications/deliveries/stats${qs}`));
    }

    // ── SIEM Audit Export ────────────────────────────────────────────

    async listSiemDestinations(params?: {
      page?: number;
      limit?: number;
      enabled?: boolean;
      search?: string;
    }): Promise<{
      data: SiemDestination[];
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    }> {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.limit) query.set("limit", String(params.limit));
      if (params?.enabled !== undefined) query.set("enabled", String(params.enabled));
      if (params?.search) query.set("search", params.search);
      const qs = query.toString();
      return this.request(`/audit/siem/destinations${qs ? `?${qs}` : ""}`);
    }

    async getSiemDestination(id: string): Promise<SiemDestination> {
      return this.unwrapData(
        this.request<{ data: SiemDestination }>(`/audit/siem/destinations/${id}`)
      );
    }

    async createSiemDestination(data: {
      name: string;
      url: string;
      authType: SiemAuthType;
      customHeaderName?: string;
      secret: string;
      enabled?: boolean;
    }): Promise<SiemDestination> {
      return this.unwrapData(
        this.request<{ data: SiemDestination }>("/audit/siem/destinations", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateSiemDestination(
      id: string,
      data: Partial<{
        name: string;
        url: string;
        authType: SiemAuthType;
        customHeaderName: string;
        secret: string;
        enabled: boolean;
      }>
    ): Promise<SiemDestination> {
      return this.unwrapData(
        this.request<{ data: SiemDestination }>(`/audit/siem/destinations/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteSiemDestination(id: string): Promise<{ discardedDeliveries: number }> {
      return this.unwrapData(
        this.request<{ data: { discardedDeliveries: number } }>(`/audit/siem/destinations/${id}`, {
          method: "DELETE",
        })
      );
    }

    async testSiemDestination(id: string): Promise<{
      success: boolean;
      statusCode?: number;
      responseTimeMs: number;
      error?: string;
    }> {
      return this.unwrapData(
        this.request(`/audit/siem/destinations/${id}/test`, { method: "POST" })
      );
    }

    async listSiemDeliveries(params?: {
      page?: number;
      limit?: number;
      destinationId?: string;
      status?: SiemDeliveryStatus;
    }): Promise<{
      data: SiemDelivery[];
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    }> {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.limit) query.set("limit", String(params.limit));
      if (params?.destinationId) query.set("destinationId", params.destinationId);
      if (params?.status) query.set("status", params.status);
      const qs = query.toString();
      return this.request(`/audit/siem/deliveries${qs ? `?${qs}` : ""}`);
    }

    async getSiemDelivery(id: string): Promise<SiemDelivery> {
      return this.unwrapData(this.request<{ data: SiemDelivery }>(`/audit/siem/deliveries/${id}`));
    }

    async requeueSiemDelivery(
      id: string
    ): Promise<{ id: string; destinationId: string; status: SiemDeliveryStatus }> {
      return this.unwrapData(
        this.request<{ data: { id: string; destinationId: string; status: SiemDeliveryStatus } }>(
          `/audit/siem/deliveries/${id}/requeue`,
          { method: "POST", body: JSON.stringify({}) }
        )
      );
    }
  };
}
