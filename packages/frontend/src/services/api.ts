import { NORMAL_LIST_FILTER } from "@/lib/app-members";
import { useAuthStore } from "@/stores/auth";
import { hasLicenseFeature, type LicenseFeature } from "@/stores/license-paywall";
import { useUIStore } from "@/stores/ui";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type {
  Alert,
  ApiToken,
  AuditLogEntry,
  AuthProvisioningSettings,
  BrowserSession,
  EnvironmentSettings,
  EnvironmentSettingsResponse,
  EnvironmentSettingsUpdate,
  FinalizeSetupState,
  FinalizeSetupStep,
  FinalizeSetupStepStatus,
  PaginatedResponse,
  PermissionGroup,
  ResourceSearchResponse,
  SystemConfig,
  TokenRegistryAccess,
  UIBootstrapShell,
  User,
} from "@/types";
import type { AIScenario, PageContext } from "@/types/ai";
import type { FileEntry } from "@/types/docker";
import { withAIStatusApi } from "./api-ai-status";
import { withAppsApi } from "./api-apps";
import { withAuthApi } from "./api-auth";
import { withAvailabilitySetsApi } from "./api-availability-sets";
import { withBackupApi } from "./api-backups";
import { API_BASE, ApiClientBase } from "./api-base";
import { withConfigurationTransferApi } from "./api-configuration-transfer";
import { withContainerLinksApi } from "./api-container-links";
import { withDatabaseApi } from "./api-databases";
import { withDockerApi } from "./api-docker";
import { withHostingApi } from "./api-hosting";
import { withInferenceApi } from "./api-inference";
import { withInferenceCoreApi } from "./api-inference-core";
import { withIngressGroupsApi } from "./api-ingress-groups";
import { withIntegrationsApi } from "./api-integrations";
import { withLoggingApi } from "./api-logging";
import { withNotificationApi } from "./api-notifications";
import { withObjectStorageApi } from "./api-object-storage";
import { withPagesDomainsApi } from "./api-pages-domains";
import { withPkiApi } from "./api-pki";
import { withProxyApi } from "./api-proxy";
import { withSystemApi } from "./api-system";
import { type BackgroundPrewarmTask, runBackgroundPrewarm } from "./background-prewarm";

class ApiClient extends withAppsApi(
  withIngressGroupsApi(
    withPagesDomainsApi(
      withAIStatusApi(
        withInferenceCoreApi(
          withInferenceApi(
            withIntegrationsApi(
              withLoggingApi(
                withNotificationApi(
                  withAuthApi(
                    withSystemApi(
                      withDockerApi(
                        withBackupApi(
                          withObjectStorageApi(
                            withContainerLinksApi(
                              withDatabaseApi(
                                withPkiApi(
                                  withProxyApi(
                                    withHostingApi(
                                      withAvailabilitySetsApi(
                                        withConfigurationTransferApi(ApiClientBase)
                                      )
                                    )
                                  )
                                )
                              )
                            )
                          )
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
  )
) {
  private prewarmTail: Promise<void> = Promise.resolve();

  async getUIBootstrap(): Promise<UIBootstrapShell> {
    return this.unwrapData(this.request<{ data: UIBootstrapShell }>("/ui/bootstrap"));
  }

  async getFinalizeSetupState(): Promise<FinalizeSetupState | null> {
    return this.unwrapData(this.request<{ data: FinalizeSetupState | null }>("/finalize-setup"));
  }

  async updateFinalizeSetupStep(
    step: FinalizeSetupStep,
    status: Exclude<FinalizeSetupStepStatus, "pending">
  ): Promise<FinalizeSetupState> {
    return this.unwrapData(
      this.request<{ data: FinalizeSetupState }>(`/finalize-setup/steps/${step}`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      })
    );
  }

  async getFinalizeSetupMfaReminder(): Promise<boolean> {
    const result = await this.unwrapData(
      this.request<{ data: { show: boolean } }>("/finalize-setup/mfa-reminder")
    );
    return result.show;
  }

  async getAIScenarios(context?: PageContext): Promise<AIScenario[]> {
    const params = context ? `?context=${encodeURIComponent(JSON.stringify(context))}` : "";
    return this.unwrapData(this.request<{ data: AIScenario[] }>(`/ai/scenarios${params}`));
  }

  async hideFinalizeSetupMfaReminder(): Promise<void> {
    await this.request("/finalize-setup/mfa-reminder/hide", { method: "POST" });
  }

  /**
   * Warm route-level read models after authentication. Requests are started
   * sequentially by runBackgroundPrewarm so login never becomes an API burst.
   */
  prefetchAll(
    isAdmin: boolean,
    signal: AbortSignal,
    extraTasks: BackgroundPrewarmTask[] = []
  ): Promise<void> {
    const showSystem =
      useUIStore.getState().showSystemCertificates &&
      useAuthStore.getState().hasScope("admin:details:certificates");
    const auth = useAuthStore.getState();
    const moduleState = useUIBootstrapStore.getState().snapshot?.commercialModule;
    const licensed = (feature: LicenseFeature) =>
      (!moduleState || moduleState === "ready") && hasLicenseFeature(feature) !== false;
    const tasks: BackgroundPrewarmTask[] = [];
    const add = (condition: boolean, key: string, run: () => Promise<unknown>) => {
      if (condition) tasks.push({ key, run });
    };
    const cache =
      <T>(key: string, request: () => Promise<T>) =>
      () =>
        request().then((data) => {
          this.setCache(key, data);
          return data;
        });

    add(
      true,
      "dashboard:stats",
      cache(`dashboard:stats:${showSystem ? "system" : "default"}`, () =>
        this.getDashboardStats(showSystem)
      )
    );
    add(
      true,
      "dashboard:health",
      cache("dashboard:health", () => this.getHealthOverview())
    );
    add(
      licensed("internal-pki") && auth.hasScopedAccess("pki:ca:view"),
      "cas",
      cache(`cas:list:${showSystem ? "system" : "default"}`, () => this.listCAs({ showSystem }))
    );
    add(
      auth.hasScopedAccess("proxy:view"),
      "proxy-hosts",
      cache("proxy:grouped", () => this.getGroupedProxyHosts({ ...NORMAL_LIST_FILTER }))
    );
    add(
      licensed("pages") && auth.hasScopedAccess("pages:view"),
      "pages-projects",
      cache("pages:projects", () =>
        this.listPageProjects({ page: 1, limit: 100, ...NORMAL_LIST_FILTER })
      )
    );
    add(
      licensed("pages") &&
        (auth.hasScopedAccess("pages:view") || auth.hasScope("pages:folders:manage")),
      "pages-project-folders",
      cache("pages:project-folders", () => this.listPageProjectFolders())
    );
    add(
      auth.hasScopedAccess("ssl:cert:view"),
      "ssl-certificates",
      cache(`ssl:list:${showSystem ? "system" : "default"}`, () =>
        this.listSSLCertificates({
          page: 1,
          limit: 25,
          status: "active",
          showSystem,
          ...NORMAL_LIST_FILTER,
        })
      )
    );
    add(
      licensed("internal-pki") && auth.hasScopedAccess("pki:cert:view"),
      "pki-certificates",
      cache(`certificates:list:${showSystem ? "system" : "default"}`, () =>
        this.listCertificates({ page: 1, limit: 25, status: "active", showSystem })
      )
    );
    add(
      auth.hasScopedAccess("domains:view"),
      "domains",
      cache("domains:list:folder-view", () =>
        this.listDomains({ page: 1, limit: 1000, ...NORMAL_LIST_FILTER })
      )
    );
    add(
      licensed("internal-pki") && auth.hasScope("pki:templates:view"),
      "pki-templates",
      cache("templates:list", () => this.listTemplates())
    );
    add(
      auth.hasScopedAccess("acl:view"),
      "access-lists",
      cache("access-lists:list", () => this.listAccessLists())
    );
    add(
      auth.hasScopedAccess("proxy:templates:view"),
      "nginx-templates",
      cache("nginx-templates:list", () => this.listNginxTemplates())
    );
    add(
      auth.hasScopedAccess("nodes:details"),
      "nodes",
      cache("nodes:list:default", () => this.listNodes({ page: 1, limit: 50 }))
    );
    add(
      licensed("external-database-connections") && auth.hasScopedAccess("databases:view"),
      "databases",
      cache("databases:list", () =>
        this.listDatabases({ limit: 200, ...NORMAL_LIST_FILTER }).then((result) => result.data)
      )
    );
    // Without a logging backend the lists answer 503; the Logging pages load them on demand.
    const loggingEnabled =
      this.getCached<SystemConfig>("system:config", Number.POSITIVE_INFINITY)?.features
        ?.loggingEnabled === true;
    add(
      loggingEnabled &&
        licensed("structured-logging") &&
        auth.hasScopedAccess("logs:environments:view"),
      "logging-environments",
      cache("logging:environments", () => this.listLoggingEnvironments())
    );
    add(
      loggingEnabled && licensed("structured-logging") && auth.hasScopedAccess("logs:schemas:view"),
      "logging-schemas",
      cache("logging:schemas", () => this.listLoggingSchemas())
    );
    add(
      auth.hasScope("settings:opfield:view"),
      "opfield-settings",
      cache("settings:auth-provisioning", () => this.getAuthProvisioningSettings())
    );
    add(auth.hasScope("settings:opfield:view"), "relay", () => this.getRelayStatus());
    add(
      auth.hasScope("docker:registries:view"),
      "docker-registries",
      cache("settings:docker-registries", () => this.listDockerRegistries())
    );
    add(
      auth.hasScope("housekeeping:view"),
      "housekeeping-config",
      cache("housekeeping:config", () => this.getHousekeepingConfig())
    );
    add(
      auth.hasScope("housekeeping:view"),
      "housekeeping-stats",
      cache("housekeeping:stats", () => this.getHousekeepingStats())
    );
    add(
      auth.hasScope("license:view"),
      "license",
      cache("settings:license-status", () => this.getLicenseStatus())
    );
    add(
      licensed("status-pages") && auth.hasScope("status-page:view"),
      "status-page-settings",
      cache("settings:status-page-config", () => this.getStatusPageSettings())
    );
    add(
      licensed("status-pages") && auth.hasScope("status-page:view"),
      "status-page-templates",
      cache("settings:status-page-proxy-templates", () => this.listStatusPageProxyTemplates())
    );
    add(
      licensed("gitlab") &&
        auth.hasAnyScope("integrations:gitlab:view", "integrations:gitlab:manage"),
      "gitlab-integrations",
      cache("settings:gitlab-connectors", () => this.listGitLabConnectors())
    );
    add(
      auth.hasAnyScope("notifications:alerts:view", "notifications:alerts:manage"),
      "notification-alerts",
      cache("notifications:alerts", () =>
        this.listAlertRules({ limit: 100 }).then((result) => result.data ?? [])
      )
    );
    add(
      auth.hasAnyScope("notifications:webhooks:view", "notifications:webhooks:manage"),
      "notification-webhooks",
      cache("notifications:webhooks", () =>
        this.listWebhooks({ limit: 100 }).then((result) => result.data ?? [])
      )
    );
    add(
      auth.hasScope("feat:ai:configure"),
      "ai-settings",
      cache("settings:ai-config", () => this.getAIConfig())
    );
    // The inference API answers 404 (INFERENCE_DISABLED) while Inference is switched off.
    const inferenceEnabled =
      useUIBootstrapStore.getState().snapshot?.systemConfig.features.inferenceEnabled === true;
    add(
      inferenceEnabled && auth.hasScope("inference:providers:view"),
      "inference-provider-catalog",
      () => this.listInferenceProviderCatalog()
    );
    add(
      inferenceEnabled && auth.hasScope("inference:providers:view"),
      "inference-provider-connections",
      () => this.listInferenceProviderConnections()
    );
    add(
      auth.hasScope("admin:update"),
      "version",
      cache("system:version", () => this.getVersionInfo())
    );
    add(
      isAdmin && auth.hasScopedAccess("admin:users"),
      "admin-users",
      cache("admin:users", () => this.listUsers())
    );
    add(
      isAdmin && auth.hasScopedAccess("admin:groups"),
      "admin-groups",
      cache("admin:groups", () => this.listGroups())
    );
    add(
      isAdmin && auth.hasScopedAccess("admin:audit"),
      "audit",
      cache("audit:list", () => this.getAuditLog({ limit: 25 }))
    );

    const run = this.prewarmTail
      .catch(() => {})
      .then(async () => {
        if (signal.aborted) return;
        await runBackgroundPrewarm([...tasks, ...extraTasks], signal);
      });
    // A reconnect reconciliation must never overlap the initial login prewarm.
    // Queue it behind the active run so request starts remain staggered.
    this.prewarmTail = run.catch(() => {});
    return run;
  }

  // ── Audit ─────────────────────────────────────────────────────────

  async getAuditLog(params?: {
    page?: number;
    limit?: number;
    action?: string;
    actions?: string[];
    resourceType?: string;
    resourceTypes?: string[];
    userId?: string;
    userIds?: string[];
    from?: string;
    to?: string;
    excludedActions?: string[];
    excludedResourceTypes?: string[];
  }): Promise<PaginatedResponse<AuditLogEntry>> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set("page", params.page.toString());
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.action) searchParams.set("action", params.action);
    for (const action of params?.actions ?? []) searchParams.append("action", action);
    if (params?.resourceType) searchParams.set("resourceType", params.resourceType);
    for (const resourceType of params?.resourceTypes ?? []) {
      searchParams.append("resourceType", resourceType);
    }
    if (params?.userId) searchParams.set("userId", params.userId);
    for (const userId of params?.userIds ?? []) searchParams.append("userId", userId);
    if (params?.from) searchParams.set("from", params.from);
    if (params?.to) searchParams.set("to", params.to);
    for (const action of params?.excludedActions ?? [])
      searchParams.append("excludeAction", action);
    for (const resourceType of params?.excludedResourceTypes ?? []) {
      searchParams.append("excludeResourceType", resourceType);
    }

    const query = searchParams.toString();
    return this.request<PaginatedResponse<AuditLogEntry>>(`/audit${query ? `?${query}` : ""}`);
  }

  async exportAuditLog(params: {
    actions?: string[];
    resourceTypes?: string[];
    userIds?: string[];
    from?: string;
    to?: string;
    excludedActions?: string[];
    excludedResourceTypes?: string[];
  }): Promise<AuditLogEntry[]> {
    return this.unwrapData(
      this.request<{ data: AuditLogEntry[] }>("/audit/export", {
        method: "POST",
        body: JSON.stringify(params),
      })
    );
  }

  async getAuditUsers(): Promise<
    Array<{ userId: string | null; userName: string | null; userEmail: string | null }>
  > {
    return this.unwrapData(
      this.request<{
        data: Array<{ userId: string | null; userName: string | null; userEmail: string | null }>;
      }>("/audit/users")
    );
  }

  // ── Alerts ────────────────────────────────────────────────────────

  async getAlerts(): Promise<Alert[]> {
    return this.request<Alert[]>("/alerts");
  }

  async dismissAlert(id: string): Promise<void> {
    return this.request<void>(`/alerts/${id}/dismiss`, { method: "POST" });
  }

  async searchResources(
    query: string,
    options?: { types?: string[]; nodeId?: string; limit?: number; signal?: AbortSignal }
  ): Promise<ResourceSearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (options?.types?.length) params.set("types", options.types.join(","));
    if (options?.nodeId) params.set("nodeId", options.nodeId);
    if (options?.limit) params.set("limit", String(options.limit));
    return this.unwrapData(
      this.request<{ data: ResourceSearchResponse }>(`/resources/search?${params.toString()}`, {
        signal: options?.signal,
      })
    );
  }

  // ── Tokens ────────────────────────────────────────────────────────

  async listTokens(): Promise<ApiToken[]> {
    return this.request<ApiToken[]>("/tokens");
  }

  async createToken(data: {
    name: string;
    scopes: string[];
    registryAccess?: TokenRegistryAccess;
    /** Store exactly these scopes, without the grants Opfield adds for older scripts. */
    exactScopes?: boolean;
    /** ISO moment the token stops working; null or absent: never. */
    expiresAt?: string | null;
    /** Addresses or CIDR ranges the token works from; empty: any address. */
    allowedIps?: string[];
  }): Promise<ApiToken & { token: string }> {
    return this.request(`/tokens`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async renameToken(id: string, name: string): Promise<void> {
    return this.updateToken(id, { name });
  }

  async updateToken(
    id: string,
    data: {
      name?: string;
      scopes?: string[];
      registryAccess?: TokenRegistryAccess;
      expiresAt?: string | null;
      allowedIps?: string[];
    }
  ): Promise<void> {
    return this.request<void>(`/tokens/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  }

  async revokeToken(id: string): Promise<void> {
    return this.request<void>(`/tokens/${id}`, { method: "DELETE" });
  }

  /** Whether Docker clients can reach the internal registry, so tokens may get registry access. */
  async getTokenRegistryAccess(): Promise<{ externalAccessEnabled: boolean }> {
    return this.request<{ externalAccessEnabled: boolean }>("/tokens/registry-access");
  }

  /** The client address Opfield sees for this browser: what token address limits are checked against. */
  async getTokenClientAddress(): Promise<{ ipAddress: string | null }> {
    return this.request<{ ipAddress: string | null }>("/tokens/client-address");
  }

  // ── Admin ─────────────────────────────────────────────────────────

  async listUsers(): Promise<User[]> {
    return this.request<User[]>("/admin/users");
  }

  async createUser(data: {
    folderId?: string | null;
    email: string;
    name: string;
    groupId: string;
    groupIds?: string[];
    authMethod?: "oidc" | "password" | "email_otp";
  }): Promise<User> {
    return this.request<User>("/admin/users", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateUserGroup(userId: string, groups: string | string[]): Promise<User> {
    return this.request<User>(`/admin/users/${userId}/group`, {
      method: "PATCH",
      body: JSON.stringify(typeof groups === "string" ? { groupId: groups } : { groupIds: groups }),
    });
  }

  async updateUserAuthMethod(
    userId: string,
    authMethod: "oidc" | "password" | "email_otp"
  ): Promise<User> {
    return this.request<User>(`/admin/users/${userId}/auth-method`, {
      method: "PATCH",
      body: JSON.stringify({ authMethod }),
    });
  }

  async updateUserName(userId: string, name: string): Promise<User> {
    return this.request<User>(`/admin/users/${userId}/name`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  async resetUserAvatar(userId: string): Promise<User> {
    return this.request<User>(`/admin/users/${userId}/avatar`, { method: "DELETE" });
  }

  async sendUserPasswordLink(
    userId: string
  ): Promise<{ message: string; purpose: "password_setup" | "password_reset" }> {
    return this.request(`/admin/users/${userId}/password-setup`, { method: "POST" });
  }

  async sendUserInvitation(userId: string): Promise<User> {
    return this.request<User>(`/admin/users/${userId}/invitation`, { method: "POST" });
  }

  async listAdminUserSessions(userId: string): Promise<BrowserSession[]> {
    return this.request<BrowserSession[]>(`/admin/users/${userId}/sessions`);
  }

  async impersonateUser(userId: string): Promise<void> {
    await this.request(`/admin/users/${userId}/impersonate`, { method: "POST" });
  }

  async revokeAdminUserSession(userId: string, sessionId: string): Promise<void> {
    await this.request(`/admin/users/${userId}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  }

  async revokeAllAdminUserSessions(userId: string): Promise<void> {
    await this.request(`/admin/users/${userId}/sessions`, { method: "DELETE" });
  }

  async resetAdminUserMfa(userId: string): Promise<void> {
    await this.request(`/admin/users/${userId}/mfa/reset`, { method: "POST" });
  }

  async updateUserAdditionalPermissions(userId: string, additionalScopes: string[]): Promise<User> {
    return this.request<User>(`/admin/users/${userId}/additional-permissions`, {
      method: "PUT",
      body: JSON.stringify({ additionalScopes }),
    });
  }

  async blockUser(userId: string, blocked: boolean): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/admin/users/${userId}/block`, {
      method: "PATCH",
      body: JSON.stringify({ blocked }),
    });
  }

  async deleteUser(userId: string): Promise<void> {
    await this.request(`/admin/users/${userId}`, { method: "DELETE" });
  }

  async listDeletedUsers(): Promise<import("@/types").DeletedUser[]> {
    return this.request<import("@/types").DeletedUser[]>("/admin/users/deleted");
  }

  async restoreUser(userId: string, groups?: string | string[]): Promise<User> {
    return this.request<User>(`/admin/users/${userId}/restore`, {
      method: "POST",
      body: JSON.stringify(
        typeof groups === "string" ? { groupId: groups } : groups ? { groupIds: groups } : {}
      ),
    });
  }

  async listAdminUserFolders(): Promise<import("@/types").ResourceFolderTreeNode[]> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolderTreeNode[] }>("/admin/user-folders")
    );
  }

  async createAdminUserFolder(data: {
    name: string;
    parentId?: string;
  }): Promise<import("@/types").ResourceFolder> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolder }>("/admin/user-folders", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async updateAdminUserFolder(
    id: string,
    data: { name: string }
  ): Promise<import("@/types").ResourceFolder> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolder }>(`/admin/user-folders/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      })
    );
  }

  /** Moves a resource folder under `parentId` (null = top level); `basePath` is the list's folder route. */
  async moveResourceFolder(basePath: string, id: string, parentId: string | null): Promise<void> {
    await this.request(`${basePath}/${id}/move`, {
      method: "PUT",
      body: JSON.stringify({ parentId }),
    });
  }

  async deleteAdminUserFolder(id: string): Promise<void> {
    await this.request(`/admin/user-folders/${id}`, { method: "DELETE" });
  }

  async reorderAdminUserFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
    await this.request("/admin/user-folders/reorder", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  async moveAdminUsersToFolder(ids: string[], folderId: string | null): Promise<void> {
    await this.request("/admin/user-folders/move-users", {
      method: "POST",
      body: JSON.stringify({ ids, folderId }),
    });
  }

  async reorderAdminUsers(items: { id: string; sortOrder: number }[]): Promise<void> {
    await this.request("/admin/user-folders/reorder-users", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  async getAuthProvisioningSettings(): Promise<AuthProvisioningSettings> {
    return this.request<AuthProvisioningSettings>("/admin/auth-settings");
  }

  async getEnvironmentSettings(): Promise<EnvironmentSettingsResponse> {
    return this.request<EnvironmentSettingsResponse>("/settings/environment");
  }

  async updateEnvironmentSettings(data: EnvironmentSettingsUpdate): Promise<EnvironmentSettings> {
    return this.unwrapData(
      this.request<{ data: EnvironmentSettings }>("/settings/environment", {
        method: "PATCH",
        body: JSON.stringify(data),
      })
    );
  }

  async updateAuthProvisioningSettings(data: {
    oidcAutoCreateUsers?: boolean;
    oidcDefaultGroupId?: string;
    oidcRequireVerifiedEmail?: boolean;
    oauthExtendedCallbackCompatibility?: boolean;
    mfaExistingSessionGracePeriodDays?: number;
    methods?: Partial<NonNullable<AuthProvisioningSettings["methods"]>>;
    passwordPolicy?: Partial<NonNullable<AuthProvisioningSettings["passwordPolicy"]>>;
    smtp?: {
      host: string;
      port: number;
      tlsMode: "starttls" | "tls";
      username: string;
      password?: string;
      senderName: string;
      senderEmail: string;
      testRecipient?: string;
      testEmailKind?: "smtp_configuration" | "password_setup" | "password_reset" | "email_otp";
    };
    oidc?: {
      issuer: string;
      clientId: string;
      clientSecret?: string;
      redirectUri: string;
      scopes?: string;
      displayName?: string | null;
    };
    /** remove: removes the OIDC provider; opfield_account: Use Opfield account for sign-in; cancel_opfield_account. */
    oidcProviderAction?: "remove" | "opfield_account" | "cancel_opfield_account";
    logging?: {
      mode: "disabled" | "local" | "external";
      url?: string;
      username?: string;
      password?: string;
      database?: string;
      table?: string;
      requestTimeoutMs?: number;
    };
    mcpServerEnabled?: boolean;
    mcpExtendedCompatibility?: boolean;
    webTlsEnabled?: boolean;
    generalSettings?: Partial<AuthProvisioningSettings["generalSettings"]>;
    networkSecurity?: Partial<AuthProvisioningSettings["networkSecurity"]>;
    outboundWebhookPolicy?: Partial<AuthProvisioningSettings["outboundWebhookPolicy"]>;
  }): Promise<AuthProvisioningSettings> {
    return this.request<AuthProvisioningSettings>("/admin/auth-settings", {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  // ── Permission Groups ──

  async listGroups(): Promise<PermissionGroup[]> {
    return this.request<PermissionGroup[]>("/admin/groups");
  }

  async getGroup(id: string): Promise<PermissionGroup> {
    return this.request<PermissionGroup>(`/admin/groups/${id}`);
  }

  async createGroup(data: {
    folderId?: string | null;
    name: string;
    description?: string;
    scopes: string[];
    parentId?: string | null;
    require2fa?: boolean;
  }): Promise<PermissionGroup> {
    return this.request<PermissionGroup>("/admin/groups", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateGroup(
    id: string,
    data: {
      name?: string;
      description?: string | null;
      scopes?: string[];
      parentId?: string | null;
      require2fa?: boolean;
    }
  ): Promise<PermissionGroup> {
    return this.request<PermissionGroup>(`/admin/groups/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteGroup(id: string): Promise<void> {
    await this.request(`/admin/groups/${id}`, { method: "DELETE" });
  }

  async listAdminGroupFolders(): Promise<import("@/types").ResourceFolderTreeNode[]> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolderTreeNode[] }>("/admin/groups/folders")
    );
  }

  async createAdminGroupFolder(data: {
    name: string;
    parentId?: string;
  }): Promise<import("@/types").ResourceFolder> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolder }>("/admin/groups/folders", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async updateAdminGroupFolder(
    id: string,
    data: { name: string }
  ): Promise<import("@/types").ResourceFolder> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolder }>(`/admin/groups/folders/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      })
    );
  }

  async deleteAdminGroupFolder(id: string): Promise<void> {
    await this.request(`/admin/groups/folders/${id}`, { method: "DELETE" });
  }

  async reorderAdminGroupFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
    await this.request("/admin/groups/folders/reorder", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  async moveAdminGroupsToFolder(ids: string[], folderId: string | null): Promise<void> {
    await this.request("/admin/groups/folders/move-groups", {
      method: "POST",
      body: JSON.stringify({ ids, folderId }),
    });
  }

  async reorderAdminGroups(items: { id: string; sortOrder: number }[]): Promise<void> {
    await this.request("/admin/groups/folders/reorder-groups", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  // ── Nodes ──

  async listNodes(params?: {
    hosting?: string;
    search?: string;
    type?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    data: import("@/types").Node[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const query = new URLSearchParams();
    if (params?.search) query.set("search", params.search);
    if (params?.type) query.set("type", params.type);
    if (params?.status) query.set("status", params.status);
    if (params?.hosting) query.set("hosting", params.hosting);
    if (params?.page) query.set("page", String(params.page));
    if (params?.limit) query.set("limit", String(params.limit));
    const qs = query.toString();
    return this.request(`/nodes${qs ? `?${qs}` : ""}`);
  }

  async getNode(id: string): Promise<import("@/types").NodeDetail> {
    return this.unwrapData(this.request(`/nodes/${id}`));
  }

  async getNodeBySlug(slug: string): Promise<import("@/types").NodeDetail> {
    return this.unwrapData(this.requestRouteContext(`/nodes/by-slug/${encodeURIComponent(slug)}`));
  }

  async getNodeHealthHistory(id: string): Promise<Array<{ ts: string; status: string }>> {
    return this.unwrapData(this.request(`/nodes/${id}/health-history`));
  }

  async createNode(data: {
    type?: string;
    hostname: string;
    displayName?: string;
    folderId?: string | null;
    serviceAddresses?: string[];
    servicePort?: number;
  }): Promise<import("@/types").CreateNodeResponse> {
    return this.unwrapData(
      this.request("/nodes", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  /** Replaces the enrollment token of a node that has not enrolled yet. */
  async regenerateNodeEnrollmentToken(id: string): Promise<import("@/types").CreateNodeResponse> {
    return this.unwrapData(
      this.request(`/nodes/${encodeURIComponent(id)}/enrollment-token`, { method: "POST" })
    );
  }

  async updateNode(
    id: string,
    data: {
      displayName?: string | null;
      appearanceColor?: import("@/types").NodeAppearanceColor | null;
      serviceAddresses?: string[];
      serviceAddress?: string | null;
      secondaryServiceAddress?: string | null;
      confirmDomainDnsUpdate?: boolean;
      builderSettings?: {
        parallelism: number;
        timeoutMinutes: number;
      };
    }
  ): Promise<import("@/types").Node> {
    return this.unwrapData(
      this.request(`/nodes/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      })
    );
  }

  async setNodeServiceCreationLock(
    id: string,
    serviceCreationLocked: boolean
  ): Promise<import("@/types").NodeDetail> {
    return this.unwrapData(
      this.request(`/nodes/${id}/service-creation-lock`, {
        method: "PATCH",
        body: JSON.stringify({ serviceCreationLocked }),
      })
    );
  }

  async deleteNode(id: string, options: { cascadeProxyHosts?: boolean } = {}): Promise<void> {
    const query = options.cascadeProxyHosts ? "?cascadeProxyHosts=true" : "";
    await this.request(`/nodes/${id}${query}`, { method: "DELETE" });
  }

  async listNodeFolders(): Promise<import("@/types").ResourceFolderTreeNode[]> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolderTreeNode[] }>("/nodes/folders")
    );
  }

  async createNodeFolder(data: {
    name: string;
    parentId?: string;
  }): Promise<import("@/types").ResourceFolder> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolder }>("/nodes/folders", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async updateNodeFolder(
    id: string,
    data: { name: string }
  ): Promise<import("@/types").ResourceFolder> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolder }>(`/nodes/folders/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      })
    );
  }

  async deleteNodeFolder(id: string): Promise<void> {
    await this.request(`/nodes/folders/${id}`, { method: "DELETE" });
  }

  async reorderNodeFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
    await this.request("/nodes/folders/reorder", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  async moveNodesToFolder(ids: string[], folderId: string | null): Promise<void> {
    await this.request("/nodes/folders/move-nodes", {
      method: "POST",
      body: JSON.stringify({ ids, folderId }),
    });
  }

  async reorderNodes(items: { id: string; sortOrder: number }[]): Promise<void> {
    await this.request("/nodes/folders/reorder-nodes", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  createNodeMonitoringStream(nodeId: string, options: { focused?: boolean } = {}): EventSource {
    const query = options.focused ? "?focused=true" : "";
    return new EventSource(`${API_BASE}/nodes/${nodeId}/monitoring/stream${query}`, {
      withCredentials: true,
    });
  }

  async getNodeNginxConfig(nodeId: string): Promise<string> {
    const result = await this.unwrapData(
      this.request<{ data: { content: string } }>(`/nodes/${nodeId}/config`)
    );
    return result.content;
  }

  async updateNodeNginxConfig(
    nodeId: string,
    content: string
  ): Promise<{ valid: boolean; error?: string }> {
    return this.unwrapData(
      this.request<{ data: { valid: boolean; error?: string } }>(`/nodes/${nodeId}/config`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      })
    );
  }

  async testNodeNginxConfig(
    nodeId: string,
    content?: string
  ): Promise<{ valid: boolean; error?: string }> {
    return this.unwrapData(
      this.request<{ data: { valid: boolean; error?: string } }>(`/nodes/${nodeId}/config/test`, {
        method: "POST",
        body: content ? JSON.stringify({ content }) : undefined,
      })
    );
  }

  async listNodeDir(nodeId: string, path: string): Promise<FileEntry[]> {
    const response = await this.request<{
      data: FileEntry[];
      total?: number;
      limit?: number;
      truncated?: boolean;
    }>(`/nodes/${nodeId}/files?path=${encodeURIComponent(path)}`);
    const data = response.data;
    if (Array.isArray(data)) {
      Object.defineProperty(data, "_listMeta", {
        value: {
          total: response.total,
          limit: response.limit,
          truncated: response.truncated,
        },
        enumerable: false,
      });
    }
    return data;
  }

  async readNodeFile(nodeId: string, path: string): Promise<ArrayBuffer> {
    return this.requestBinary(`/nodes/${nodeId}/files/read?path=${encodeURIComponent(path)}`);
  }

  async writeNodeFile(nodeId: string, path: string, content: string) {
    const encoded = new TextEncoder().encode(content);
    return this.unwrapData(
      this.uploadRaw<{ data: unknown }>(
        `/nodes/${nodeId}/files/write?path=${encodeURIComponent(path)}`,
        {
          method: "PUT",
          body: encoded,
          headers: { "Content-Type": "application/octet-stream" },
        }
      )
    );
  }

  async createNodeFile(
    nodeId: string,
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
    return this.uploadRaw<void>(`/nodes/${nodeId}/files/create?path=${encodeURIComponent(path)}`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/octet-stream" },
      onProgress,
    });
  }

  async initNodeFileUpload(
    nodeId: string,
    path: string,
    totalBytes: number
  ): Promise<{ uploadId: string; chunkSize: number }> {
    return this.unwrapData(
      this.request<{ data: { uploadId: string; chunkSize: number } }>(
        `/nodes/${nodeId}/files/uploads`,
        {
          method: "POST",
          body: JSON.stringify({ path, totalBytes }),
        }
      )
    );
  }

  async uploadNodeFileChunk(
    nodeId: string,
    uploadId: string,
    offset: number,
    content: Blob,
    onProgress?: (progress: { loaded: number; total: number }) => void
  ): Promise<{ receivedBytes: number; totalBytes: number }> {
    return this.unwrapData(
      this.uploadRaw<{ data: { receivedBytes: number; totalBytes: number } }>(
        `/nodes/${nodeId}/files/uploads/${uploadId}/chunks?offset=${offset}`,
        {
          method: "PUT",
          body: content,
          headers: { "Content-Type": "application/octet-stream" },
          onProgress,
        }
      )
    );
  }

  async completeNodeFileUpload(
    nodeId: string,
    uploadId: string,
    path: string,
    totalBytes: number
  ): Promise<void> {
    await this.request<void>(`/nodes/${nodeId}/files/uploads/${uploadId}/complete`, {
      method: "POST",
      body: JSON.stringify({ path, totalBytes }),
    });
  }

  async abortNodeFileUpload(nodeId: string, uploadId: string): Promise<void> {
    await this.request<void>(`/nodes/${nodeId}/files/uploads/${uploadId}`, { method: "DELETE" });
  }

  async createNodeDirectory(nodeId: string, path: string) {
    return this.request<void>(`/nodes/${nodeId}/files/directory`, {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  async deleteNodeFile(nodeId: string, path: string) {
    return this.request<void>(`/nodes/${nodeId}/files?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    });
  }

  async moveNodeFile(nodeId: string, fromPath: string, toPath: string) {
    return this.request<void>(`/nodes/${nodeId}/files/move`, {
      method: "POST",
      body: JSON.stringify({ fromPath, toPath }),
    });
  }

  // ── AI Assistant ──
}

export const api = new ApiClient();
