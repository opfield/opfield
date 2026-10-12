import { FolderPlus, Plus } from "lucide-react";
import { useRef } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { HubTabPanel, HubTabs } from "@/components/common/HubTabs";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { LicensePlanBadge } from "@/components/license/LicensePlanBadge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePkiAvailable } from "@/hooks/use-plan-gated-features";
import { hasCreationDestination } from "@/lib/creation-folders";
import { useAuthStore } from "@/stores/auth";
import { requireLicenseFeature } from "@/stores/license-paywall";
import { NginxTemplates } from "./NginxTemplates";
import { Templates } from "./Templates";

const NO_SCOPES: string[] = [];

const TABS = [
  {
    value: "pki",
    label: "PKI Certificates",
    scope: "pki:templates:view",
    createScope: "pki:templates:create",
    foldersScope: "pki:templates:folders:manage",
  },
  {
    value: "nginx",
    label: "Nginx Config",
    scope: "proxy:templates:view",
    createScope: "proxy:templates:manage",
    foldersScope: "proxy:templates:folders:manage",
  },
] as const;

const KIND_DESCRIPTIONS = {
  pki: "PKI certificate templates",
  nginx: "Nginx configuration templates",
} as const;

/**
 * PKI and nginx templates. With `kind` it is the Templates tab of the Certificates (PKI) or Routes
 * (nginx) page and shows only that kind.
 */
export function TemplatesPage({ kind }: { kind?: "pki" | "nginx" } = {}) {
  const { tab: routeTab } = useParams<{ tab?: string }>();
  const tabParam = kind ?? routeTab;
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess } = useAuthStore();
  const scopes = useAuthStore((s) => s.user?.scopes ?? NO_SCOPES);
  const pkiEnabled = usePkiAvailable();

  const pkiCreateRef = useRef<(() => void) | null>(null);
  const nginxCreateRef = useRef<(() => void) | null>(null);
  const createFolderRefs = useRef<Record<string, () => void>>({});

  const visibleTabs = TABS.filter((t) => {
    if (kind && t.value !== kind) return false;
    if (t.value === "pki" && !pkiEnabled) return false;
    return hasScopedAccess(t.scope);
  });
  const activeTab =
    tabParam && visibleTabs.some((t) => t.value === tabParam)
      ? tabParam
      : visibleTabs[0]?.value || "pki";

  if (visibleTabs.length === 0) {
    return <Navigate to="/" replace />;
  }

  const handleTabChange = (value: string) => {
    navigate(`/templates/${value}`, { replace: true });
  };

  const activeTabDef = TABS.find((t) => t.value === activeTab);
  const canManageFolders = !!activeTabDef && hasScope(activeTabDef.foldersScope);
  const openCreateFolder = () => createFolderRefs.current[activeTab]?.();

  const renderCreateAction = () => {
    if (!activeTabDef || !hasScope(activeTabDef.createScope)) return null;

    switch (activeTab) {
      case "pki":
        return (
          <Button
            onClick={() => {
              if (!requireLicenseFeature("internal-pki", "Internal PKI templates")) return;
              pkiCreateRef.current?.();
            }}
          >
            <Plus className="h-4 w-4" />
            Create Template
          </Button>
        );
      case "nginx":
        return (
          <Button onClick={() => nginxCreateRef.current?.()}>
            <Plus className="h-4 w-4" />
            Create Template
          </Button>
        );
      default:
        return null;
    }
  };
  const folderActions = canManageFolders
    ? [
        {
          label: "Add Folder",
          icon: <FolderPlus className="h-4 w-4" />,
          onClick: openCreateFolder,
        },
      ]
    : [];
  const createActions =
    activeTab === "pki" && hasScope("pki:templates:create")
      ? [
          {
            label: "Create Template",
            icon: <Plus className="h-4 w-4" />,
            onClick: () => {
              if (!requireLicenseFeature("internal-pki", "Internal PKI templates")) return;
              pkiCreateRef.current?.();
            },
          },
        ]
      : activeTab === "nginx" && hasCreationDestination(scopes, "proxy:templates:manage")
        ? [
            {
              label: "Create Template",
              icon: <Plus className="h-4 w-4" />,
              onClick: () => nginxCreateRef.current?.(),
            },
          ]
        : [];

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <PageHeader
        className="shrink-0"
        leading={<LiteModeBackButton />}
        title="Templates"
        badges={activeTab === "pki" ? <LicensePlanBadge feature="internal-pki" /> : null}
        description={
          kind ? KIND_DESCRIPTIONS[kind] : "Certificate and nginx configuration templates"
        }
        actions={
          <ResponsiveHeaderActions actions={[...folderActions, ...createActions]}>
            {canManageFolders && (
              <Button variant="outline" onClick={openCreateFolder}>
                <FolderPlus className="h-4 w-4" />
                Add Folder
              </Button>
            )}
            {renderCreateAction()}
          </ResponsiveHeaderActions>
        }
      />
      <HubTabs />
      <HubTabPanel className="space-y-4">
        <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col">
          {pkiEnabled && !kind && (
            <TabsList className="shrink-0">
              {visibleTabs.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} className="gap-1.5">
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          )}

          {visibleTabs.some((tab) => tab.value === "pki") && (
            <TabsContent value="pki" className={kind ? "mt-0" : undefined}>
              <Templates
                embedded
                onCreateRef={(fn) => {
                  pkiCreateRef.current = fn;
                }}
                onCreateFolderRef={(fn) => {
                  createFolderRefs.current.pki = fn;
                }}
              />
            </TabsContent>
          )}
          {visibleTabs.some((tab) => tab.value === "nginx") && (
            <TabsContent value="nginx" className={kind ? "mt-0" : undefined}>
              <NginxTemplates
                embedded
                onCreateRef={(fn) => {
                  nginxCreateRef.current = fn;
                }}
                onCreateFolderRef={(fn) => {
                  createFolderRefs.current.nginx = fn;
                }}
              />
            </TabsContent>
          )}
        </Tabs>
      </HubTabPanel>
    </div>
  );
}
