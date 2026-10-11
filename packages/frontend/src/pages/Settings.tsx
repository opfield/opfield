import {
  Activity,
  Bot,
  Braces,
  KeyRound,
  Network,
  Plug,
  ServerCog,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PoweredByFooter } from "@/components/common/PoweredByFooter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuthStore } from "@/stores/auth";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { Node } from "@/types";
import { PagesSettingsSection } from "./pages/PageGlobalSettings";
import { AIConfigSection } from "./settings/AIConfigSection";
import { AuthProvisioningSection } from "./settings/AuthProvisioningSection";
import { CloudSection } from "./settings/CloudSection";
import { DockerRegistriesSection } from "./settings/DockerRegistriesSection";
import { EnvironmentSettingsSection } from "./settings/EnvironmentSettingsSection";
import { HousekeepingSection } from "./settings/HousekeepingSection";
import { InferenceSettingsSection } from "./settings/InferenceSettingsSection";
import { IntegrationsSection } from "./settings/IntegrationsSection";
import { InternalRegistrySection } from "./settings/InternalRegistrySection";
import { LicenseSection } from "./settings/LicenseSection";
import { RelaySettingsSection } from "./settings/RelaySettingsSection";
import { StatusPageSection } from "./settings/StatusPageSection";
import { UpdateSection } from "./settings/UpdateSection";

const SETTINGS_TABS = [
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
type SettingsTab = (typeof SETTINGS_TABS)[number];

function isSettingsTab(value: string | null | undefined): value is SettingsTab {
  return SETTINGS_TABS.includes(value as SettingsTab);
}

export function Settings() {
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const { hasScope } = useAuthStore();
  const shellNodes = useUIBootstrapStore((state) => state.snapshot?.navigation.nodes.data);
  const [nodesList, setNodesList] = useState<Node[]>(() => shellNodes ?? []);
  const activeTab = isSettingsTab(tabParam) ? tabParam : null;
  const inferenceEnabled = useSystemConfigStore((state) => state.config.features.inferenceEnabled);

  const canUpdate = hasScope("admin:update");
  const canViewGatewaySettings = hasScope("settings:gateway:view");
  const canEditGatewaySettings = hasScope("settings:gateway:edit");
  const canViewHousekeeping = hasScope("housekeeping:view");
  const canRunHousekeeping = hasScope("housekeeping:run");
  const canConfigureHousekeeping = hasScope("housekeeping:configure");
  const canConfigAI = hasScope("feat:ai:configure");
  const canConfigInference =
    inferenceEnabled &&
    (hasScope("inference:providers:view") ||
      hasScope("inference:models:manage") ||
      hasScope("inference:limits:manage") ||
      hasScope("inference:usage:view"));
  const canManageRegistries = hasScope("docker:registries:view");
  const canViewLicense = hasScope("license:view");
  const canManageLicense = hasScope("license:manage");
  const canViewStatusPage = hasScope("status-page:view");
  const canViewPagesSettings = hasScope("pages:settings:view") || hasScope("pages:settings:edit");
  const canViewIntegrations =
    hasScope("integrations:hosting:view") ||
    hasScope("integrations:hosting:manage") ||
    hasScope("integrations:gitlab:view") ||
    hasScope("integrations:gitlab:manage") ||
    hasScope("integrations:cloudflare:view") ||
    hasScope("integrations:cloudflare:manage") ||
    hasScope("integrations:github:view") ||
    hasScope("integrations:github:manage") ||
    hasScope("integrations:git:view") ||
    hasScope("integrations:git:manage") ||
    hasScope("integrations:ssh:view") ||
    hasScope("integrations:ssh:manage");
  const canAccessGeneralTab = canViewGatewaySettings || canUpdate || canViewLicense;
  const canAccessAdvancedTab = canViewGatewaySettings || canManageRegistries;
  const canAccessFeaturesTab =
    canViewGatewaySettings || canViewStatusPage || canViewHousekeeping || canViewPagesSettings;
  const availableTabs = useMemo<SettingsTab[]>(() => {
    const tabs: SettingsTab[] = [];
    if (canAccessGeneralTab) tabs.push("general");
    if (canViewGatewaySettings) tabs.push("authentication");
    if (canAccessAdvancedTab) tabs.push("advanced");
    if (canViewGatewaySettings) tabs.push("environment");
    if (canViewGatewaySettings) tabs.push("relay");
    if (canAccessFeaturesTab) tabs.push("features");
    if (canViewIntegrations) tabs.push("integrations");
    if (canConfigInference) tabs.push("inference");
    if (canConfigAI) tabs.push("ai");
    return tabs;
  }, [
    canAccessFeaturesTab,
    canAccessAdvancedTab,
    canAccessGeneralTab,
    canViewGatewaySettings,
    canConfigAI,
    canConfigInference,
    canViewIntegrations,
  ]);
  const currentTab = activeTab && availableTabs.includes(activeTab) ? activeTab : availableTabs[0];

  useEffect(() => {
    if (currentTab !== "advanced" && currentTab !== "features") {
      setNodesList([]);
      return;
    }
    // The authenticated shell has already loaded this permission-filtered
    // projection. Reusing it avoids an empty select followed by a separate
    // nodes request when a settings tab first mounts.
    setNodesList(shellNodes ?? []);
  }, [currentTab, shellNodes]);

  useEffect(() => {
    const firstTab = availableTabs[0];
    if (!firstTab) return;
    if (!tabParam || !isSettingsTab(tabParam) || !availableTabs.includes(tabParam)) {
      navigate(`/settings/${firstTab}`, { replace: true });
    }
  }, [availableTabs, navigate, tabParam]);

  const handleTabChange = (value: string) => {
    navigate(`/settings/${value}`);
  };

  if (!currentTab) return <Navigate to="/profile" replace />;

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <PageHeader
          title="Settings"
          description="Application and system settings"
          leading={<LiteModeBackButton />}
        />

        <Tabs value={currentTab} onValueChange={handleTabChange} className="flex flex-col">
          <TabsList className="shrink-0">
            {canAccessGeneralTab && (
              <TabsTrigger value="general" className="gap-1.5">
                <ServerCog className="h-3.5 w-3.5" />
                General
              </TabsTrigger>
            )}
            {canViewGatewaySettings && (
              <TabsTrigger value="authentication" className="gap-1.5">
                <KeyRound className="h-3.5 w-3.5" />
                Authentication
              </TabsTrigger>
            )}
            {canAccessAdvancedTab && (
              <TabsTrigger value="advanced" className="gap-1.5">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Advanced
              </TabsTrigger>
            )}
            {canViewGatewaySettings && (
              <TabsTrigger value="environment" className="gap-1.5">
                <Braces className="h-3.5 w-3.5" />
                Environment
              </TabsTrigger>
            )}
            {canViewGatewaySettings && (
              <TabsTrigger value="relay" className="gap-1.5">
                <Activity className="h-3.5 w-3.5" />
                Relay
              </TabsTrigger>
            )}
            {canAccessFeaturesTab && (
              <TabsTrigger value="features" className="gap-1.5">
                <Sparkles className="h-3.5 w-3.5" />
                Features
              </TabsTrigger>
            )}
            {canViewIntegrations && (
              <TabsTrigger value="integrations" className="gap-1.5">
                <Plug className="h-3.5 w-3.5" />
                Integrations
              </TabsTrigger>
            )}
            {canConfigAI && (
              <TabsTrigger value="ai" className="gap-1.5">
                <Bot className="h-3.5 w-3.5" />
                AI Workspace
              </TabsTrigger>
            )}
            {canConfigInference && (
              <TabsTrigger value="inference" className="gap-1.5">
                <Network className="h-3.5 w-3.5" />
                Inference
              </TabsTrigger>
            )}
          </TabsList>

          {canAccessGeneralTab && (
            <TabsContent value="general" className="pb-0">
              <div className="space-y-4">
                {canViewGatewaySettings && (
                  <AuthProvisioningSection canEdit={canEditGatewaySettings} section="general" />
                )}
                {canViewLicense ? (
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    {canUpdate && <UpdateSection canUpdate={canUpdate} />}
                    <LicenseSection canManage={canManageLicense} />
                    <CloudSection
                      canManage={canManageLicense}
                      canViewAudit={hasScope("admin:audit")}
                    />
                  </div>
                ) : (
                  canUpdate && <UpdateSection canUpdate={canUpdate} />
                )}
                <PoweredByFooter />
              </div>
            </TabsContent>
          )}

          {canViewGatewaySettings && (
            <TabsContent value="authentication" className="pb-0">
              <div className="space-y-4">
                <AuthProvisioningSection
                  canEdit={canEditGatewaySettings}
                  section="authentication"
                />
                <PoweredByFooter />
              </div>
            </TabsContent>
          )}
          {canAccessAdvancedTab && (
            <TabsContent value="advanced" className="pb-0">
              <div className="space-y-4">
                {canViewGatewaySettings && (
                  <AuthProvisioningSection canEdit={canEditGatewaySettings} section="advanced" />
                )}
                {canManageRegistries && <DockerRegistriesSection nodesList={nodesList} />}
                <PoweredByFooter />
              </div>
            </TabsContent>
          )}

          {canViewGatewaySettings && (
            <TabsContent value="environment" className="pb-0">
              <div className="space-y-4">
                <EnvironmentSettingsSection canEdit={canEditGatewaySettings} />
                <PoweredByFooter />
              </div>
            </TabsContent>
          )}

          {canViewGatewaySettings && (
            <TabsContent value="relay" className="pb-0">
              <div className="space-y-4">
                <RelaySettingsSection canEdit={canEditGatewaySettings} />
                <PoweredByFooter />
              </div>
            </TabsContent>
          )}

          {canAccessFeaturesTab && (
            <TabsContent value="features" className="pb-0">
              <div className="space-y-4">
                {canViewGatewaySettings && (
                  <AuthProvisioningSection canEdit={canEditGatewaySettings} section="features" />
                )}
                {canManageRegistries && <InternalRegistrySection nodesList={nodesList} />}
                {canViewPagesSettings && <PagesSettingsSection />}
                {canViewStatusPage && <StatusPageSection nodesList={nodesList} />}

                {canViewHousekeeping && (
                  <HousekeepingSection
                    canRun={canRunHousekeeping}
                    canConfigure={canConfigureHousekeeping}
                  />
                )}
                <PoweredByFooter />
              </div>
            </TabsContent>
          )}

          {canViewIntegrations && (
            <TabsContent value="integrations" className="pb-0">
              <div className="space-y-4">
                <IntegrationsSection />
                <PoweredByFooter />
              </div>
            </TabsContent>
          )}

          {canConfigAI && (
            <TabsContent value="ai" className="pb-0">
              <div className="space-y-4">
                <AIConfigSection />
                <PoweredByFooter />
              </div>
            </TabsContent>
          )}
          {canConfigInference && (
            <TabsContent value="inference" className="pb-0">
              <div className="space-y-4">
                <InferenceSettingsSection />
                <PoweredByFooter />
              </div>
            </TabsContent>
          )}
        </Tabs>
      </div>
    </PageTransition>
  );
}
