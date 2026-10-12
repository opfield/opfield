import type { ReactNode } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import {
  canServeLicenseFeature,
  LICENSE_FEATURE_PLANS,
  type LicenseFeature,
  requireLicenseFeature,
  snapshotHasLicenseFeature,
} from "@/stores/license-paywall";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";

/** The header a locked screen keeps: a whole page, or one panel inside a page. */
export type LicenseFeatureFrame =
  | { kind: "page"; title: string; description?: ReactNode }
  | { kind: "panel"; title: string; description?: ReactNode; icon?: ReactNode };

const PLAN_NOTICE: Record<(typeof LICENSE_FEATURE_PLANS)[LicenseFeature], string> = {
  personal: "Available on the Personal plan and higher.",
  business: "Available on the Business plan and higher.",
  enterprise: "Available on the Enterprise plan.",
};

/** Keep a paid screen's loaders unmounted when the host cannot serve it. */
export function LicenseFeatureBoundary({
  feature,
  capability,
  frame,
  children,
}: {
  feature: LicenseFeature;
  capability: string;
  /** Keeps the screen's own header above the plan notice. */
  frame?: LicenseFeatureFrame;
  children: ReactNode;
}) {
  const snapshot = useUIBootstrapStore((state) => state.snapshot);
  if (canServeLicenseFeature(snapshot, feature)) return children;
  const planDenied =
    snapshotHasLicenseFeature(snapshot, feature) === false ||
    snapshot?.license?.plan === "community";
  const notice = (
    <EmptyState
      embedded={frame?.kind === "panel"}
      message={
        planDenied
          ? PLAN_NOTICE[LICENSE_FEATURE_PLANS[feature]]
          : "Unavailable while this installation's paid features are not ready."
      }
      actionLabel="License options"
      onAction={() => requireLicenseFeature(feature, capability)}
    />
  );

  if (frame?.kind === "page") {
    return (
      <PageTransition>
        <div className="h-full overflow-y-auto p-6 space-y-4">
          <PageHeader
            leading={<LiteModeBackButton />}
            title={frame.title}
            description={frame.description}
          />
          {notice}
        </div>
      </PageTransition>
    );
  }
  if (frame?.kind === "panel") {
    return (
      <PanelShell title={frame.title} description={frame.description} icon={frame.icon}>
        {notice}
      </PanelShell>
    );
  }
  return notice;
}
