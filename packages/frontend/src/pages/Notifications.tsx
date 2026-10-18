import { FolderPlus, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { LicenseFeatureBoundary } from "@/components/license/LicenseFeatureBoundary";
import { LicensePlanBadge } from "@/components/license/LicensePlanBadge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useSiemAvailable } from "@/hooks/use-plan-gated-features";
import { hasCreationDestination } from "@/lib/creation-folders";
import { AlertsTab } from "@/pages/notifications/AlertsTab";
import { DELIVERY_PAGE_SIZE, DeliveryLogTab } from "@/pages/notifications/DeliveryLogTab";
import {
  SIEM_DELIVERY_PAGE_SIZE,
  SiemDeliveryLogTab,
} from "@/pages/notifications/SiemDeliveryLogTab";
import {
  SIEM_DESTINATION_CACHE_KEY,
  SiemDestinationsTab,
} from "@/pages/notifications/SiemDestinationsTab";
import { WebhooksTab } from "@/pages/notifications/WebhooksTab";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { requireLicenseFeature } from "@/stores/license-paywall";
import { useSystemConfigStore } from "@/stores/system-config";

const TABS = [
  { value: "alerts", label: "Alerts" },
  { value: "webhooks", label: "Webhooks" },
  { value: "deliveries", label: "Delivery Log" },
  { value: "siem", label: "SIEM" },
  { value: "siem-deliveries", label: "SIEM Delivery Log" },
] as const;

export function Notifications() {
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { hasAnyScope, hasScopedAccess, user } = useAuthStore();
  const siemEnabled = useSiemAvailable();
  const siemSwitchedOn = useSystemConfigStore((state) => state.config.features.siemEnabled);
  // Same scopes as the notification routes: *:view to read, *:manage to change (manage implies view). Both are
  // held broadly, on single rules or webhooks, or on their folders; the lists show what the grants cover.
  const canReadAlerts = hasScopedAccess("notifications:alerts:view");
  const canAccessAlerts = canReadAlerts;
  const canReadWebhooks = hasScopedAccess("notifications:webhooks:view");
  // Creating needs manage broadly or on a destination folder.
  const canManageAlerts = hasCreationDestination(user?.scopes ?? [], "notifications:alerts:manage");
  const canAccessWebhooks = canReadWebhooks;
  const canManageWebhooks = hasCreationDestination(
    user?.scopes ?? [],
    "notifications:webhooks:manage"
  );
  const canManageAlertFolders = useCanManageSomeFolders("notifications:alerts:folders:manage");
  const canManageWebhookFolders = useCanManageSomeFolders("notifications:webhooks:folders:manage");
  const [createAlertFolder, setCreateAlertFolder] = useState<(() => void) | null>(null);
  const [createWebhookFolder, setCreateWebhookFolder] = useState<(() => void) | null>(null);
  const receiveAlertFolderAction = useCallback(
    (fn: () => void) => setCreateAlertFolder(() => fn),
    []
  );
  const receiveWebhookFolderAction = useCallback(
    (fn: () => void) => setCreateWebhookFolder(() => fn),
    []
  );
  // Delivery history belongs to webhooks.
  const canViewDeliveries = canReadWebhooks;
  const canViewSiem = siemEnabled && hasAnyScope("audit:siem:view", "audit:siem:manage");
  const canManageSiem = siemEnabled && hasAnyScope("audit:siem:manage");
  const visibleTabs = TABS.filter((tab) => {
    if (tab.value === "alerts") return canAccessAlerts;
    if (tab.value === "webhooks") return canAccessWebhooks;
    if (tab.value === "deliveries") return canViewDeliveries;
    if (tab.value === "siem") return canViewSiem;
    if (tab.value === "siem-deliveries") return canViewSiem;
    return false;
  });
  // A SIEM tab the plan does not include: the page keeps its header and shows the plan notice.
  const siemPlanLocked =
    siemSwitchedOn &&
    !siemEnabled &&
    hasAnyScope("audit:siem:view", "audit:siem:manage") &&
    (tabParam === "siem" || tabParam === "siem-deliveries" || visibleTabs.length === 0);
  const activeTab =
    tabParam && visibleTabs.some((t) => t.value === tabParam)
      ? tabParam
      : visibleTabs[0]?.value || "alerts";
  const [openCreateAlertToken, setOpenCreateAlertToken] = useState(0);
  const [openCreateWebhookToken, setOpenCreateWebhookToken] = useState(0);
  const [refreshDeliveriesToken, setRefreshDeliveriesToken] = useState(0);
  const [openCreateSiemToken, setOpenCreateSiemToken] = useState(0);
  const [refreshSiemDeliveriesToken, setRefreshSiemDeliveriesToken] = useState(0);

  useEffect(() => {
    if (canReadAlerts) {
      api
        .listAllAlertRules()
        .then((rules) => api.setCache("notifications:alerts", rules))
        .catch(() => {});
    }
    if (canReadWebhooks) {
      api
        .listAllWebhooks()
        .then((webhooks) => api.setCache("notifications:webhooks", webhooks))
        .catch(() => {});
    }
    if (canViewDeliveries) {
      api
        .listDeliveries({ page: 1, limit: DELIVERY_PAGE_SIZE })
        .then((result) => {
          api.setCache("notifications:deliveries:all", result.data ?? []);
          api.setCache("notifications:deliveries:all:has-more", (result.totalPages ?? 1) > 1);
        })
        .catch(() => {});
    }
    if (canViewSiem) {
      api
        .listSiemDestinations({ limit: 100 })
        .then((result) => api.setCache(SIEM_DESTINATION_CACHE_KEY, result.data ?? []))
        .catch(() => {});
      api
        .listSiemDeliveries({ page: 1, limit: SIEM_DELIVERY_PAGE_SIZE })
        .then((result) => {
          api.setCache("audit:siem:deliveries:all", result.data ?? []);
          api.setCache("audit:siem:deliveries:all:has-more", (result.totalPages ?? 1) > 1);
        })
        .catch(() => {});
    }
  }, [canReadAlerts, canReadWebhooks, canViewDeliveries, canViewSiem]);

  // The folder action of the open list, when the caller may manage its folders.
  const createFolderAction =
    activeTab === "alerts" && canManageAlertFolders
      ? createAlertFolder
      : activeTab === "webhooks" && canManageWebhookFolders
        ? createWebhookFolder
        : null;
  const folderButton = createFolderAction ? (
    <Button variant="outline" onClick={() => createFolderAction()}>
      <FolderPlus className="h-4 w-4" />
      Add Folder
    </Button>
  ) : null;
  const folderActions = createFolderAction
    ? [
        {
          label: "Add Folder",
          icon: <FolderPlus className="h-4 w-4" />,
          onClick: createFolderAction,
        },
      ]
    : [];
  const headerAction =
    activeTab === "alerts" && (canManageAlerts || folderButton) ? (
      <>
        {folderButton}
        {canManageAlerts && (
          <Button onClick={() => setOpenCreateAlertToken((v) => v + 1)}>
            <Plus /> New Alert
          </Button>
        )}
      </>
    ) : activeTab === "webhooks" && (canManageWebhooks || folderButton) ? (
      <>
        {folderButton}
        {canManageWebhooks && (
          <Button onClick={() => setOpenCreateWebhookToken((v) => v + 1)}>
            <Plus /> New Webhook
          </Button>
        )}
      </>
    ) : activeTab === "deliveries" && canViewDeliveries ? (
      <Button variant="outline" onClick={() => setRefreshDeliveriesToken((v) => v + 1)}>
        Refresh
      </Button>
    ) : activeTab === "siem" && canManageSiem ? (
      <Button
        onClick={() => {
          if (!requireLicenseFeature("siem-export", "SIEM destinations")) return;
          setOpenCreateSiemToken((v) => v + 1);
        }}
      >
        <Plus /> New SIEM Destination
      </Button>
    ) : activeTab === "siem-deliveries" && canViewSiem ? (
      <Button variant="outline" onClick={() => setRefreshSiemDeliveriesToken((v) => v + 1)}>
        Refresh
      </Button>
    ) : null;
  const headerActions =
    activeTab === "alerts"
      ? [
          ...folderActions,
          ...(canManageAlerts
            ? [
                {
                  label: "New Alert",
                  icon: <Plus className="h-4 w-4" />,
                  onClick: () => setOpenCreateAlertToken((v) => v + 1),
                },
              ]
            : []),
        ]
      : activeTab === "webhooks"
        ? [
            ...folderActions,
            ...(canManageWebhooks
              ? [
                  {
                    label: "New Webhook",
                    icon: <Plus className="h-4 w-4" />,
                    onClick: () => setOpenCreateWebhookToken((v) => v + 1),
                  },
                ]
              : []),
          ]
        : activeTab === "deliveries" && canViewDeliveries
          ? [
              {
                label: "Refresh",
                onClick: () => setRefreshDeliveriesToken((v) => v + 1),
              },
            ]
          : activeTab === "siem" && canManageSiem
            ? [
                {
                  label: "New SIEM Destination",
                  icon: <Plus className="h-4 w-4" />,
                  onClick: () => {
                    if (!requireLicenseFeature("siem-export", "SIEM destinations")) return;
                    setOpenCreateSiemToken((v) => v + 1);
                  },
                },
              ]
            : activeTab === "siem-deliveries" && canViewSiem
              ? [
                  {
                    label: "Refresh",
                    onClick: () => setRefreshSiemDeliveriesToken((v) => v + 1),
                  },
                ]
              : [];

  useEffect(() => {
    if (visibleTabs.length === 0) return;
    if (!tabParam || !visibleTabs.some((t) => t.value === tabParam)) {
      navigate(`/notifications/${activeTab}`, { replace: true });
    }
  }, [activeTab, navigate, tabParam, visibleTabs]);

  const usesFillLayout =
    !siemPlanLocked && (activeTab === "deliveries" || activeTab === "siem-deliveries");

  return (
    <PageTransition>
      <div
        className={
          usesFillLayout
            ? "h-full flex flex-col overflow-hidden p-6 gap-6"
            : "h-full overflow-y-auto p-6 space-y-6"
        }
      >
        <PageHeader
          className="shrink-0"
          leading={<LiteModeBackButton />}
          title="Notifications"
          badges={activeTab.startsWith("siem") ? <LicensePlanBadge feature="siem-export" /> : null}
          description={
            siemEnabled
              ? "Manage alert rules, webhooks, SIEM audit export, and delivery activity"
              : "Manage alert rules, webhooks, and delivery activity"
          }
          actions={
            <ResponsiveHeaderActions actions={headerActions}>
              {headerAction}
            </ResponsiveHeaderActions>
          }
        />
        {siemPlanLocked ? (
          <LicenseFeatureBoundary feature="siem-export" capability="SIEM export">
            {null}
          </LicenseFeatureBoundary>
        ) : (
          <Tabs
            value={activeTab}
            onValueChange={(v) => navigate(`/notifications/${v}`, { replace: true })}
            className={`flex flex-col ${usesFillLayout ? "flex-1 min-h-0" : ""}`}
          >
            {visibleTabs.length > 1 && (
              <TabsList>
                {visibleTabs.map((t) => (
                  <TabsTrigger key={t.value} value={t.value} className="flex items-center gap-2">
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            )}
            {canAccessAlerts && (
              <TabsContent value="alerts" className="mt-4">
                <AlertsTab
                  canRead={canReadAlerts}
                  openCreateToken={openCreateAlertToken}
                  onCreateFolderRef={receiveAlertFolderAction}
                />
              </TabsContent>
            )}
            {canAccessWebhooks && (
              <TabsContent value="webhooks" className="mt-4">
                <WebhooksTab
                  canRead={canReadWebhooks}
                  openCreateToken={openCreateWebhookToken}
                  onCreateFolderRef={receiveWebhookFolderAction}
                />
              </TabsContent>
            )}
            {canViewDeliveries && (
              <TabsContent
                value="deliveries"
                className="mt-4 flex flex-col flex-1 min-h-0 overflow-hidden"
              >
                <DeliveryLogTab
                  refreshToken={refreshDeliveriesToken}
                  onConfigureWebhook={
                    canAccessWebhooks
                      ? () => navigate("/notifications/webhooks", { replace: true })
                      : undefined
                  }
                />
              </TabsContent>
            )}
            {canViewSiem && (
              <TabsContent value="siem" className="mt-4">
                <SiemDestinationsTab
                  canManage={canManageSiem}
                  canRead={canViewSiem}
                  openCreateToken={openCreateSiemToken}
                  onViewDeliveryLog={(destination) =>
                    navigate(
                      `/notifications/siem-deliveries?destinationId=${encodeURIComponent(destination.id)}`
                    )
                  }
                />
              </TabsContent>
            )}
            {canViewSiem && (
              <TabsContent
                value="siem-deliveries"
                className="mt-4 flex flex-col flex-1 min-h-0 overflow-hidden"
              >
                <SiemDeliveryLogTab
                  canManage={canManageSiem}
                  initialDestinationId={searchParams.get("destinationId")}
                  onDestinationFilterChange={(destinationId) => {
                    setSearchParams(
                      (current) => {
                        const next = new URLSearchParams(current);
                        if (destinationId) next.set("destinationId", destinationId);
                        else next.delete("destinationId");
                        return next;
                      },
                      { replace: true }
                    );
                  }}
                  refreshToken={refreshSiemDeliveriesToken}
                />
              </TabsContent>
            )}
          </Tabs>
        )}
      </div>
    </PageTransition>
  );
}
