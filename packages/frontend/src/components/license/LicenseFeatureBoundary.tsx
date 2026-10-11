import type { ReactNode } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import {
  hasLicenseFeature,
  LICENSE_FEATURE_PLANS,
  type LicenseFeature,
  requireLicenseFeature,
} from "@/stores/license-paywall";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";

/** Keep a paid screen's loaders unmounted when the host cannot serve it. */
export function LicenseFeatureBoundary({
  feature,
  capability,
  children,
}: {
  feature: LicenseFeature;
  capability: string;
  children: ReactNode;
}) {
  const snapshot = useUIBootstrapStore((state) => state.snapshot);
  const allowed = hasLicenseFeature(feature);
  const moduleReady = !snapshot?.commercialModule || snapshot.commercialModule === "ready";
  if (allowed !== false && moduleReady) return children;
  const plan = LICENSE_FEATURE_PLANS[feature];
  const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
  return (
    <EmptyState
      message={
        allowed === false || snapshot?.license.plan === "community"
          ? `${capability} requires the ${planName} plan.`
          : `${capability} is unavailable while this installation's paid features are not ready.`
      }
      actionLabel="License options"
      onAction={() => requireLicenseFeature(feature, capability)}
    />
  );
}
