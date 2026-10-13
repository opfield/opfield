import { Boxes, Network } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { useInferenceCoreStatus } from "@/hooks/use-inference-core-status";
import { useRealtime } from "@/hooks/use-realtime";
import {
  INFERENCE_CATALOG_CHANGED_CHANNEL,
  INFERENCE_USAGE_CHANGED_CHANNEL,
} from "@/lib/inference-self-usage";
import { useAuthStore } from "@/stores/auth";
import type { InferenceCoreStatus } from "@/types/inference-core";
import { InferenceActivityPanel } from "../inference/InferenceActivityPanel";
import { InferenceUsersTable } from "../inference/InferenceAdminTables";
import { InferenceOverview } from "../inference/InferenceUsagePanels";
import {
  InferenceCoreLifecyclePanel,
  inferenceCoreBlockedReason,
  isInferenceCoreReady,
} from "./inference/InferenceCoreLifecyclePanel";
import { InferenceEndpointSettingsPanel } from "./inference/InferenceEndpointSettingsPanel";
import { InferenceModelsPanel } from "./inference/InferenceModelsPanel";
import { InferenceProvidersPanel } from "./inference/InferenceProvidersPanel";

function CorePrerequisiteNotice({
  title,
  description,
  status,
  icon,
}: {
  title: string;
  description: string;
  status: InferenceCoreStatus | null;
  icon: ReactNode;
}) {
  const reason =
    inferenceCoreBlockedReason(status) ??
    (status === null
      ? "The inference core status could not be loaded. Resolve the error above before configuring providers and models."
      : null);
  if (!reason) return null;
  return (
    <PanelShell title={title} description={description} icon={icon}>
      <p className="px-4 py-3 text-sm text-muted-foreground">{reason}</p>
    </PanelShell>
  );
}

export function InferenceSettingsSection() {
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [providerRevision, setProviderRevision] = useState(0);
  const [usageRevision, setUsageRevision] = useState(0);
  const hasScope = useAuthStore((state) => state.hasScope);
  const canViewUsage = hasScope("inference:usage:view");
  const canViewProviders = hasScope("inference:providers:view");
  const canManageProviders = hasScope("inference:providers:manage");
  const canManageModels = hasScope("inference:models:manage");
  const canManageLimits = hasScope("inference:limits:manage");
  const core = useInferenceCoreStatus(canViewProviders);
  const coreReady = isInferenceCoreReady(core.status);
  // Until the core status is known, keep dependent panels unmounted.
  // Provider/model panels stay disabled with an explanation unless the core is
  // compatible and ready.
  const coreStatusKnown = core.status !== null || core.error !== null;
  // Once shown, the provider and model panels stay mounted (hidden) while the core is briefly not
  // ready, so a dialog open in them closes with its animation instead of vanishing with the panel.
  const coreWasReady = useRef(false);
  if (coreReady) coreWasReady.current = true;
  const providersMounted = coreReady || coreWasReady.current;
  // The tab stays hidden until the core status is known: the panels that wait
  // for it mount in the same commit and report their own loads before this
  // one ends, so nothing appears after the tab is revealed.
  useContentLoading(canViewProviders && !coreStatusKnown);
  const refreshCatalog = () => setCatalogRevision((value) => value + 1);
  const refreshUsage = () => setUsageRevision((value) => value + 1);
  useRealtime(
    canViewProviders || canManageModels ? INFERENCE_CATALOG_CHANGED_CHANNEL : null,
    refreshCatalog,
    { onReconnect: refreshCatalog }
  );
  useRealtime(
    canViewUsage || canManageLimits ? INFERENCE_USAGE_CHANGED_CHANNEL : null,
    refreshUsage,
    { onReconnect: refreshUsage }
  );

  return (
    <div className="space-y-4">
      {canViewProviders && (
        <InferenceCoreLifecyclePanel
          mode="settings"
          status={core.status}
          loading={core.loading}
          error={core.error}
          canManage={canManageProviders}
          onRefresh={core.refresh}
        />
      )}
      {canViewProviders && <InferenceEndpointSettingsPanel />}
      {canViewUsage && <InferenceOverview refreshToken={usageRevision} />}
      {canViewProviders && coreStatusKnown && !coreReady && (
        <CorePrerequisiteNotice
          title="Providers"
          description="Connected accounts and API credentials. Higher connections are used first by Sequential routing; Balanced distributes evenly."
          status={core.status}
          icon={<Network className="h-4 w-4" />}
        />
      )}
      {canViewProviders && providersMounted && (
        <div hidden={!coreReady}>
          <InferenceProvidersPanel
            refreshToken={catalogRevision}
            onConnectionsChanged={() => setProviderRevision((value) => value + 1)}
          />
        </div>
      )}
      {canManageModels && canViewProviders && coreStatusKnown && !coreReady && (
        <CorePrerequisiteNotice
          title="Models"
          description="Models exposed to users and the provider account group serving each model"
          status={core.status}
          icon={<Boxes className="h-4 w-4" />}
        />
      )}
      {canManageModels && (!canViewProviders || providersMounted) && (
        <div hidden={canViewProviders && !coreReady}>
          <InferenceModelsPanel refreshToken={catalogRevision + providerRevision} />
        </div>
      )}
      {(canViewUsage || canManageLimits) && (
        <InferenceUsersTable
          canManage={canManageLimits}
          canViewUsage={canViewUsage}
          refreshToken={usageRevision}
        />
      )}
      {canViewUsage && <InferenceActivityPanel refreshToken={usageRevision} />}
    </div>
  );
}
