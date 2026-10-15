import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PoweredByFooter } from "@/components/common/PoweredByFooter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SETTINGS_TABS, type SettingsTab, settingsAccess } from "@/lib/settings-tabs";
import { useAuthStore } from "@/stores/auth";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { Node } from "@/types";
import { PagesSettingsSection } from "./pages/PageGlobalSettings";
import { AIConfigSection } from "./settings/AIConfigSection";
import { AuthProvisioningSection } from "./settings/AuthProvisioningSection";
import { CloudSection } from "./settings/CloudSection";
import { ConfigurationTransferSection } from "./settings/ConfigurationTransferSection";
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

const NO_SCOPES: readonly string[] = [];

function isSettingsTab(value: string | null | undefined): value is SettingsTab {
  return SETTINGS_TABS.includes(value as SettingsTab);
}

export function Settings() {
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const shellNodes = useUIBootstrapStore((state) => state.snapshot?.navigation.nodes.data);
  const [nodesList, setNodesList] = useState<Node[]>(() => shellNodes ?? []);
  const activeTab = isSettingsTab(tabParam) ? tabParam : null;
  const inferenceEnabled = useSystemConfigStore((state) => state.config.features.inferenceEnabled);

  const scopes = useAuthStore((state) => state.user?.scopes ?? NO_SCOPES);
  // The sidebar item reads the same predicate (lib/settings-tabs).
  const access = useMemo(
    () => settingsAccess(scopes, inferenceEnabled),
    [inferenceEnabled, scopes]
  );
  const {
    canUpdate,
    canViewOpfieldSettings,
    canEditOpfieldSettings,
    canViewHousekeeping,
    canRunHousekeeping,
    canConfigureHousekeeping,
    canConfigAI,
    canConfigInference,
    canManageRegistries,
    canViewLicense,
    canManageLicense,
    canViewStatusPage,
    canViewPagesSettings,
    canViewIntegrations,
    canTransferConfiguration,
    canAccessGeneralTab,
    canAccessAdvancedTab,
    canAccessFeaturesTab,
    tabs: availableTabs,
  } = access;
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
          {/* A page left with one tab shows no tab row. */}
          {availableTabs.length > 1 && (
            <TabsList className="shrink-0">
              {canAccessGeneralTab && (
                <TabsTrigger value="general" className="gap-1.5">
                  General
                </TabsTrigger>
              )}
              {canViewOpfieldSettings && (
                <TabsTrigger value="authentication" className="gap-1.5">
                  Authentication
                </TabsTrigger>
              )}
              {canAccessAdvancedTab && (
                <TabsTrigger value="advanced" className="gap-1.5">
                  Advanced
                </TabsTrigger>
              )}
              {canViewOpfieldSettings && (
                <TabsTrigger value="environment" className="gap-1.5">
                  Environment
                </TabsTrigger>
              )}
              {canViewOpfieldSettings && (
                <TabsTrigger value="relay" className="gap-1.5">
                  Relay
                </TabsTrigger>
              )}
              {canAccessFeaturesTab && (
                <TabsTrigger value="features" className="gap-1.5">
                  Features
                </TabsTrigger>
              )}
              {canViewIntegrations && (
                <TabsTrigger value="integrations" className="gap-1.5">
                  Integrations
                </TabsTrigger>
              )}
              {canConfigAI && (
                <TabsTrigger value="ai" className="gap-1.5">
                  AI Workspace
                </TabsTrigger>
              )}
              {canConfigInference && (
                <TabsTrigger value="inference" className="gap-1.5">
                  Inference
                </TabsTrigger>
              )}
            </TabsList>
          )}

          {canAccessGeneralTab && (
            <TabsContent value="general" className="pb-0">
              <div className="space-y-4">
                {canViewOpfieldSettings && (
                  <AuthProvisioningSection canEdit={canEditOpfieldSettings} section="general" />
                )}
                {canViewLicense ? (
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    {canUpdate && <UpdateSection canUpdate={canUpdate} />}
                    <LicenseSection canManage={canManageLicense} />
                    {/* Connecting the installation is license management: others do not see the block. */}
                    {canManageLicense && <CloudSection canManage />}
                  </div>
                ) : (
                  canUpdate && <UpdateSection canUpdate={canUpdate} />
                )}
                {canTransferConfiguration && <ConfigurationTransferSection />}
                <PoweredByFooter />
              </div>
            </TabsContent>
          )}

          {canViewOpfieldSettings && (
            <TabsContent value="authentication" className="pb-0">
              <div className="space-y-4">
                <AuthProvisioningSection
                  canEdit={canEditOpfieldSettings}
                  section="authentication"
                />
                <PoweredByFooter />
              </div>
            </TabsContent>
          )}
          {canAccessAdvancedTab && (
            <TabsContent value="advanced" className="pb-0">
              <div className="space-y-4">
                {canViewOpfieldSettings && (
                  <AuthProvisioningSection canEdit={canEditOpfieldSettings} section="advanced" />
                )}
                {canManageRegistries && <DockerRegistriesSection nodesList={nodesList} />}
                <PoweredByFooter />
              </div>
            </TabsContent>
          )}

          {canViewOpfieldSettings && (
            <TabsContent value="environment" className="pb-0">
              <div className="space-y-4">
                <EnvironmentSettingsSection canEdit={canEditOpfieldSettings} />
                <PoweredByFooter />
              </div>
            </TabsContent>
          )}

          {canViewOpfieldSettings && (
            <TabsContent value="relay" className="pb-0">
              <div className="space-y-4">
                <RelaySettingsSection canEdit={canEditOpfieldSettings} />
                <PoweredByFooter />
              </div>
            </TabsContent>
          )}

          {canAccessFeaturesTab && (
            <TabsContent value="features" className="pb-0">
              <div className="space-y-4">
                {canViewOpfieldSettings && (
                  <AuthProvisioningSection canEdit={canEditOpfieldSettings} section="features" />
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
