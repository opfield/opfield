import { scopeMatches } from "@/lib/scope-utils";

/**
 * The tabs of the Settings page and the grants behind them. The page and its sidebar item read
 * the same predicate, so the item shows exactly when the page has a tab to open.
 */
export const SETTINGS_TABS = [
  "general",
  "authentication",
  "advanced",
  "environment",
  "relay",
  "features",
  "integrations",
  "inference",
  "ai",
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const INTEGRATION_SCOPES = [
  "integrations:hosting:view",
  "integrations:hosting:manage",
  "integrations:gitlab:view",
  "integrations:gitlab:manage",
  "integrations:cloudflare:view",
  "integrations:cloudflare:manage",
  "integrations:github:view",
  "integrations:github:manage",
  "integrations:git:view",
  "integrations:git:manage",
  "integrations:ssh:view",
  "integrations:ssh:manage",
] as const;

const INFERENCE_SCOPES = [
  "inference:providers:view",
  "inference:models:manage",
  "inference:limits:manage",
  "inference:usage:view",
] as const;

export function settingsAccess(scopes: readonly string[], inferenceEnabled: boolean) {
  const has = (scope: string) => scopeMatches(scopes, scope);
  const canUpdate = has("admin:update");
  const canViewOpfieldSettings = has("settings:opfield:view");
  const canViewHousekeeping = has("housekeeping:view");
  const canManageRegistries = has("docker:registries:view");
  const canViewLicense = has("license:view");
  const canViewStatusPage = has("status-page:view");
  const canViewPagesSettings = has("pages:settings:view") || has("pages:settings:edit");
  const canTransferConfiguration = has("admin:system");
  const access = {
    canUpdate,
    canViewOpfieldSettings,
    canEditOpfieldSettings: has("settings:opfield:edit"),
    canViewHousekeeping,
    canRunHousekeeping: has("housekeeping:run"),
    canConfigureHousekeeping: has("housekeeping:configure"),
    canConfigAI: has("feat:ai:configure"),
    canConfigInference: inferenceEnabled && INFERENCE_SCOPES.some(has),
    canManageRegistries,
    canViewLicense,
    canManageLicense: has("license:manage"),
    canViewStatusPage,
    canViewPagesSettings,
    canViewIntegrations: INTEGRATION_SCOPES.some(has),
    canTransferConfiguration,
    canAccessGeneralTab:
      canViewOpfieldSettings || canUpdate || canViewLicense || canTransferConfiguration,
    canAccessAdvancedTab: canViewOpfieldSettings || canManageRegistries,
    canAccessFeaturesTab:
      canViewOpfieldSettings || canViewStatusPage || canViewHousekeeping || canViewPagesSettings,
  };
  const tabs: SettingsTab[] = [];
  if (access.canAccessGeneralTab) tabs.push("general");
  if (canViewOpfieldSettings) tabs.push("authentication");
  if (access.canAccessAdvancedTab) tabs.push("advanced");
  if (canViewOpfieldSettings) tabs.push("environment");
  if (canViewOpfieldSettings) tabs.push("relay");
  if (access.canAccessFeaturesTab) tabs.push("features");
  if (access.canViewIntegrations) tabs.push("integrations");
  if (access.canConfigInference) tabs.push("inference");
  if (access.canConfigAI) tabs.push("ai");
  return { ...access, tabs };
}
