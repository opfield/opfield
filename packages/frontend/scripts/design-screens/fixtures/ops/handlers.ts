/** Fixture API handlers for the ops screens: notifications, logging, settings, administration, profile. */
import { HttpResponse, http } from "msw";
import { ok, wrapped } from "../../handlers";
import { pagesHandlers } from "../data/pages-handlers";
import { storageHandlers } from "../data/storage-handlers";
import { cloudflareConnectors, domains } from "../edge/domains";
import { sslHandlers } from "../edge/ssl";
import { routeHandlers } from "../routes/handlers";
import {
  auditEntries,
  certificateAuthorities,
  databaseConnections,
  deletedUsers,
  groups,
  proxyHosts,
  users,
} from "./admin";
import { alertCategories, webhookPresets } from "./alert-catalog";
import {
  loggingEnvironments,
  loggingEvents,
  loggingMetadata,
  loggingSchemas,
  productionTokens,
} from "./logging";
import {
  alertRules,
  deliveries,
  page,
  siemDeliveries,
  siemDestinations,
  webhooks,
} from "./notifications";
import {
  apiTokens,
  browserSessions,
  inferenceSelfUsage,
  inferenceTokens,
  inferenceUsageOverview,
  localAccountUser,
  mfaStatus,
  oauthAuthorizations,
  passkeys,
} from "./profile";
import { authSettings, cloudStatus, licenseStatus, systemVersion } from "./settings";
import {
  aiConfig,
  aiSandboxArtifacts,
  aiSandboxStatus,
  aiSkills,
  dockerRegistries,
  environmentSettings,
  gitConnectors,
  githubConnectors,
  gitlabConnectors,
  hostingConnectors,
  housekeepingConfig,
  housekeepingStats,
  inferenceActivity,
  inferenceConnections,
  inferenceCoreStatus,
  inferenceLimits,
  inferenceModels,
  inferenceProviderCatalog,
  inferenceUsers,
  internalRegistryState,
  pageProfile,
  pageProfileOptions,
  relaySnapshot,
  sshConnectors,
  statusPageProxyTemplates,
} from "./settings-tabs";
import {
  statusPageConfig,
  statusPageIncidents,
  statusPageServices,
  statusPageSources,
} from "./status-page";

const paginated = <T>(data: T[], limit = 100) =>
  ok({ data, pagination: { page: 1, limit, total: data.length, totalPages: 1 } });

const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });

export function notificationsHandlers() {
  return [
    http.get("*/api/notifications/alert-rules/categories", () => wrapped(alertCategories)),
    http.get("*/api/notifications/alert-rules", () => ok(page(alertRules))),
    http.get("*/api/notifications/webhooks/presets", () => wrapped(webhookPresets)),
    http.get("*/api/notifications/webhooks", () => ok(page(webhooks))),
    http.get("*/api/notifications/deliveries", () => ok(page(deliveries))),
    http.get("*/api/notifications/deliveries/stats", () =>
      wrapped({ total: 1_284, success: 1_271, failed: 9, retrying: 4 })
    ),
    http.get("*/api/audit/siem/destinations", () => ok(page(siemDestinations))),
    http.get("*/api/audit/siem/deliveries", () => ok(page(siemDeliveries))),
  ];
}

export function loggingHandlers() {
  return [
    http.get("*/api/logging/environments/by-slug/:slug", ({ params }) => {
      const environment = loggingEnvironments.find((item) => item.slug === params.slug);
      return environment ? wrapped(environment) : notFound();
    }),
    http.get("*/api/logging/environments", () => wrapped(loggingEnvironments)),
    http.get("*/api/logging/environments/:id/tokens", ({ params }) =>
      wrapped(productionTokens.filter((token) => token.environmentId === params.id))
    ),
    http.get("*/api/logging/schemas/by-slug/:slug", ({ params }) => {
      const schema = loggingSchemas.find((item) => item.slug === params.slug);
      return schema ? wrapped(schema) : notFound();
    }),
    http.get("*/api/logging/environment-folders", () => wrapped([])),
    http.get("*/api/logging/schemas", () => wrapped(loggingSchemas)),
    http.get("*/api/logging/schema-folders", () => wrapped([])),
    http.get("*/api/logging/environments/:id/metadata", () => wrapped(loggingMetadata)),
    http.post("*/api/logging/environments/:id/search", ({ params }) =>
      ok({
        data: loggingEvents.filter((event) => event.environmentId === params.id),
        nextCursor: null,
      })
    ),
    http.get("*/api/logging/environments/:id/facets", () =>
      wrapped({
        services: loggingMetadata.services,
        sources: loggingMetadata.sources,
        severities: ["debug", "info", "warn", "error"].map((severity) => ({
          severity,
          count: loggingEvents.filter((event) => event.severity === severity).length,
        })),
        labels: loggingMetadata.labelValues,
      })
    ),
  ];
}

export function settingsHandlers() {
  return [
    http.get("*/api/admin/auth-settings", () => ok(authSettings)),
    http.get("*/api/system/version", () => wrapped(systemVersion)),
    http.get("*/api/system/license/status", () => wrapped(licenseStatus)),
    http.get("*/api/system/cloud/status", () => wrapped(cloudStatus)),
    http.get("*/api/system/release-notes", () =>
      wrapped([
        { version: "2.14.0", notes: "Relay lanes, SIEM export retries and faster route reloads." },
      ])
    ),
  ];
}

export function adminHandlers() {
  return [
    http.get("*/api/admin/users", () => ok(users)),
    http.get("*/api/admin/users/deleted", () => ok(deletedUsers)),
    http.get("*/api/admin/user-folders", () => wrapped([])),
    http.get("*/api/admin/groups", () => ok(groups)),
    http.get("*/api/admin/groups/folders", () => wrapped([])),
    // Scope pickers of the group and user permission editors.
    http.get("*/api/proxy-hosts", () => paginated(proxyHosts)),
    http.get("*/api/databases", () => paginated(databaseConnections)),
    http.get("*/api/cas", () => ok(certificateAuthorities)),
    http.get("*/api/logging/schemas", () => wrapped(loggingSchemas)),
    http.get("*/api/audit", () => paginated(auditEntries)),
    http.get("*/api/audit/users", () =>
      wrapped(
        Array.from(
          new Map(
            auditEntries
              .filter((entry) => entry.userId)
              .map((entry) => [
                entry.userId,
                { userId: entry.userId, userName: entry.userName, userEmail: entry.userEmail },
              ])
          ).values()
        )
      )
    ),
  ];
}

export function profileHandlers() {
  return [
    http.get("*/auth/me", () => ok(localAccountUser)),
    http.get("*/auth/me/mfa", () => ok(mfaStatus)),
    http.get("*/auth/me/passkeys", () => ok(passkeys)),
    http.get("*/auth/me/sessions", () => ok(browserSessions)),
    http.get("*/api/inference/usage/self", () => ok(inferenceSelfUsage)),
    http.get("*/api/inference/usage/self/overview", () => ok(inferenceUsageOverview)),
    http.get("*/api/tokens", () => ok(apiTokens)),
    http.get("*/api/oauth/authorizations", () => wrapped(oauthAuthorizations)),
    http.get("*/api/inference/tokens", () => ok(inferenceTokens)),
  ];
}

export function statusPageHandlers() {
  return [
    http.get("*/api/status-page/settings", () => wrapped(statusPageConfig)),
    http.get("*/api/status-page/services", () => wrapped(statusPageServices)),
    http.get("*/api/status-page/sources", () => wrapped(statusPageSources)),
    http.get("*/api/status-page/incidents", ({ request }) => {
      const url = new URL(request.url);
      const status = url.searchParams.get("status") ?? "all";
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const rows = statusPageIncidents.filter((item) => status === "all" || item.status === status);
      return wrapped(rows.slice(offset, offset + limit));
    }),
  ];
}

/** Every settings tab beyond General: its sections read these on mount. */
export function settingsTabHandlers() {
  return [
    ...settingsHandlers(),
    http.get("*/api/docker/registries/internal/state", () => wrapped(internalRegistryState)),
    http.get("*/api/docker/registries", () => wrapped(dockerRegistries)),
    http.get("*/api/settings/environment", () => ok(environmentSettings)),
    http.get("*/api/system/relay", () => wrapped(relaySnapshot)),
    http.get("*/api/pages/settings/profile", () => wrapped(pageProfile)),
    http.get("*/api/pages/settings/options", () => wrapped(pageProfileOptions)),
    http.get("*/api/status-page/settings", () => wrapped(statusPageConfig)),
    http.get("*/api/status-page/proxy-templates", () => wrapped(statusPageProxyTemplates)),
    http.get("*/api/housekeeping/config", () => wrapped(housekeepingConfig)),
    http.get("*/api/housekeeping/stats", () => wrapped(housekeepingStats)),
    http.get("*/api/integrations/cloudflare/connectors", () => wrapped(cloudflareConnectors)),
    http.get("*/api/integrations/gitlab/connectors", () => wrapped(gitlabConnectors)),
    http.get("*/api/integrations/github/connectors", () => wrapped(githubConnectors)),
    http.get("*/api/integrations/github/oauth", () => wrapped({ available: true })),
    http.get("*/api/integrations/git/connectors", () => wrapped(gitConnectors)),
    http.get("*/api/integrations/ssh/connectors", () => wrapped(sshConnectors)),
    http.get("*/api/integrations/hosting", () => ok(hostingConnectors)),
    http.get("*/api/inference/usage/system", () => ok(inferenceUsageOverview)),
    http.get("*/api/inference/usage/users", () => ok(inferenceUsers)),
    http.get("*/api/inference/limits/users", () => ok(inferenceUsers)),
    http.get("*/api/inference/limits", () => ok(inferenceLimits)),
    http.get("*/api/inference/usage/activity", () =>
      ok({ data: inferenceActivity, nextPage: null })
    ),
    http.get("*/api/inference/core/status", () => ok(inferenceCoreStatus)),
    http.get("*/api/inference/providers/catalog", () => ok(inferenceProviderCatalog)),
    http.get("*/api/inference/providers/connections", () => ok(inferenceConnections)),
    http.get("*/api/inference/models", () => ok(inferenceModels)),
    http.get("*/api/ai/config", () => wrapped(aiConfig)),
    http.get("*/api/ai/skills", () => wrapped(aiSkills)),
    http.get("*/api/ai/sandbox/status", () => wrapped(aiSandboxStatus)),
    http.get("*/api/ai/sandbox/jobs", () => wrapped([])),
    http.get("*/api/ai/sandbox/artifacts", () => ok({ data: aiSandboxArtifacts, nextPage: null })),
    http.get("*/api/domains/search", () =>
      wrapped(
        domains.map(({ id, domain, dnsStatus, dnsProvider, nginxNodeId }) => ({
          id,
          domain,
          dnsStatus,
          dnsProvider,
          nginxNodeId,
        }))
      )
    ),
    ...sslHandlers(),
  ];
}

const emptyDockerList = () => ok({ data: [], nodes: [], total: 0, limit: 1000, truncated: false });

/**
 * Resource lists the scope editor (group permissions, API tokens) preloads so a
 * scope can be narrowed to single resources: routes, storage, certificates,
 * Pages projects, integrations and per-node Docker resources.
 */
export function scopePickerHandlers() {
  return [
    http.get("*/api/docker/nodes/:nodeId/containers", emptyDockerList),
    http.get("*/api/docker/nodes/:nodeId/images", emptyDockerList),
    http.get("*/api/docker/nodes/:nodeId/networks", emptyDockerList),
    http.get("*/api/docker/nodes/:nodeId/volumes", emptyDockerList),
    http.get("*/api/docker/compose-projects", () => wrapped([])),
    http.get("*/api/docker/registries/internal/repositories", () =>
      wrapped(["northwind/storefront", "northwind/api", "northwind/worker"])
    ),
    http.get("*/api/integrations/gitlab/connectors", () => wrapped(gitlabConnectors)),
    http.get("*/api/integrations/github/connectors", () => wrapped(githubConnectors)),
    http.get("*/api/integrations/git/connectors", () => wrapped(gitConnectors)),
    http.get("*/api/integrations/hosting", () => ok(hostingConnectors)),
    ...storageHandlers(),
    ...sslHandlers(),
    ...pagesHandlers(),
    ...routeHandlers(),
  ];
}
