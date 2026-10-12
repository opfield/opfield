import { useMemo } from "react";
import { create } from "zustand";
import { ApiRequestError } from "@/services/api-base";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { LicensePlan } from "@/types";
import {
  entitlementsIncludeFeature,
  LICENSE_FEATURE_PLANS,
  type LicenseFeature,
} from "@/types/license-features";
import type { UIBootstrapShell } from "@/types/ui-bootstrap";

export { LICENSE_FEATURE_PLANS, type LicenseFeature } from "@/types/license-features";
export type PaidLicensePlan = Exclude<LicensePlan, "community">;

export const LICENSE_PLAN_RANK: Record<LicensePlan, number> = {
  community: 0,
  personal: 1,
  business: 2,
  enterprise: 3,
};

export interface LicensePaywallRequest {
  reason?: "module-unavailable";
  capability: string;
  requiredPlan: PaidLicensePlan;
  currentPlan: LicensePlan;
  quota?: {
    resource?: string;
    limit?: number;
    current?: number;
  };
}

interface LicensePaywallState {
  request: LicensePaywallRequest | null;
  open: (request: LicensePaywallRequest) => void;
  close: () => void;
}

export const useLicensePaywallStore = create<LicensePaywallState>()((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

function currentPlan(): LicensePlan {
  return useUIBootstrapStore.getState().snapshot?.license.plan ?? "community";
}

type LicenseSnapshot =
  | Partial<Pick<UIBootstrapShell, "license" | "commercialModule">>
  | null
  | undefined;

export function hasLicenseFeature(feature: LicenseFeature): boolean | null {
  return snapshotHasLicenseFeature(useUIBootstrapStore.getState().snapshot, feature);
}

/** Whether the license in a bootstrap snapshot grants a feature; null while unknown. */
export function snapshotHasLicenseFeature(
  snapshot: LicenseSnapshot,
  feature: LicenseFeature
): boolean | null {
  const license = snapshot?.license;
  if (!license) return null;
  return entitlementsIncludeFeature(license.entitlements.features, feature);
}

/**
 * Whether this installation can serve a paid screen: the plan grants it and the
 * commercial module is ready. Unknown state counts as available.
 */
export function canServeLicenseFeature(
  snapshot: LicenseSnapshot,
  feature: LicenseFeature
): boolean {
  const moduleReady = !snapshot?.commercialModule || snapshot.commercialModule === "ready";
  return moduleReady && snapshotHasLicenseFeature(snapshot, feature) !== false;
}

/** Whether the current plan includes a feature (and its module is ready); re-renders on change. */
export function usePlanIncludes(feature: LicenseFeature): boolean {
  return useUIBootstrapStore((state) => canServeLicenseFeature(state.snapshot, feature));
}

/** {@link canServeLicenseFeature} for the current bootstrap snapshot, outside React. */
export function planIncludes(feature: LicenseFeature): boolean {
  return canServeLicenseFeature(useUIBootstrapStore.getState().snapshot, feature);
}

/** Navigation items backed by one paid feature. */
const LICENSED_NAVIGATION_ITEMS = {
  pages: "pages",
  logging: "structured-logging",
  storage: "storage-connections",
  databases: "external-database-connections",
} as const satisfies Record<string, LicenseFeature>;

/** Navigation items the current plan does not grant, for `unlicensedItems`. */
export function unlicensedNavigationItems(
  snapshot: LicenseSnapshot
): (keyof typeof LICENSED_NAVIGATION_ITEMS)[] {
  return (
    Object.entries(LICENSED_NAVIGATION_ITEMS) as [
      keyof typeof LICENSED_NAVIGATION_ITEMS,
      LicenseFeature,
    ][]
  )
    .filter(([, feature]) => !canServeLicenseFeature(snapshot, feature))
    .map(([item]) => item);
}

/** `unlicensedItems` for navigation, from the current bootstrap snapshot. */
export function useUnlicensedNavigationItems() {
  const license = useUIBootstrapStore((state) => state.snapshot?.license);
  const commercialModule = useUIBootstrapStore((state) => state.snapshot?.commercialModule);
  return useMemo(
    () => unlicensedNavigationItems({ license, commercialModule }),
    [license, commercialModule]
  );
}

export function requireLicenseFeature(feature: LicenseFeature, capability: string): boolean {
  const allowed = hasLicenseFeature(feature);
  if (allowed === null) return true;
  if (allowed) return requireCommercialModule(capability, LICENSE_FEATURE_PLANS[feature]);
  useLicensePaywallStore.getState().open({
    capability,
    requiredPlan: LICENSE_FEATURE_PLANS[feature],
    currentPlan: currentPlan(),
  });
  return false;
}

export function requireMinimumLicensePlan(
  requiredPlan: PaidLicensePlan,
  capability: string
): boolean {
  const license = useUIBootstrapStore.getState().snapshot?.license;
  if (!license) return true;
  if (LICENSE_PLAN_RANK[license.plan] >= LICENSE_PLAN_RANK[requiredPlan])
    return requireCommercialModule(capability, requiredPlan);
  useLicensePaywallStore.getState().open({
    capability,
    requiredPlan,
    currentPlan: license.plan,
  });
  return false;
}

function requireCommercialModule(capability: string, requiredPlan: PaidLicensePlan): boolean {
  const state = useUIBootstrapStore.getState().snapshot?.commercialModule;
  // Older backends do not expose module state; retain their existing behavior.
  if (!state || state === "ready") return true;
  useLicensePaywallStore.getState().open({
    capability,
    requiredPlan,
    currentPlan: currentPlan(),
    ...(currentPlan() === "community" ? {} : { reason: "module-unavailable" as const }),
  });
  return false;
}

interface LicenseErrorDetails {
  feature?: unknown;
  requiredPlan?: unknown;
  currentPlan?: unknown;
  resource?: unknown;
  limit?: unknown;
  current?: unknown;
}

function isPaidPlan(value: unknown): value is PaidLicensePlan {
  return value === "personal" || value === "business" || value === "enterprise";
}

function isLicensePlan(value: unknown): value is LicensePlan {
  return value === "community" || isPaidPlan(value);
}

function licenseErrorDetails(details: unknown): LicenseErrorDetails | undefined {
  return details && typeof details === "object" ? (details as LicenseErrorDetails) : undefined;
}

/** The known paid feature named by a structured license denial, if any. */
export function licenseErrorFeature(details: unknown): LicenseFeature | undefined {
  const feature = licenseErrorDetails(details)?.feature;
  return typeof feature === "string" && feature in LICENSE_FEATURE_PLANS
    ? (feature as LicenseFeature)
    : undefined;
}

/** A structured license denial, from a REST error or an AI WebSocket command error. */
export interface LicenseErrorPayload {
  code?: string;
  details?: unknown;
}

export function handleLicenseApiError(error: unknown, capability: string): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  return handleLicenseError(error, capability);
}

/** Opens the shared paywall for a license denial; returns false for any other error code. */
export function handleLicenseError(error: LicenseErrorPayload, capability: string): boolean {
  if (error.code === "COMMERCIAL_MODULE_UNAVAILABLE") {
    const plan = currentPlan();
    useLicensePaywallStore.getState().open({
      capability,
      requiredPlan: plan === "community" ? "personal" : plan,
      currentPlan: plan,
      ...(plan === "community" ? {} : { reason: "module-unavailable" as const }),
    });
    return true;
  }
  if (error.code !== "LICENSE_ENTITLEMENT_REQUIRED" && error.code !== "LICENSE_QUOTA_EXCEEDED") {
    return false;
  }

  const details = licenseErrorDetails(error.details);
  const feature = licenseErrorFeature(error.details);
  const requiredPlan = isPaidPlan(details?.requiredPlan)
    ? details.requiredPlan
    : feature
      ? LICENSE_FEATURE_PLANS[feature]
      : "personal";

  useLicensePaywallStore.getState().open({
    capability,
    requiredPlan,
    currentPlan: isLicensePlan(details?.currentPlan) ? details.currentPlan : currentPlan(),
    quota:
      error.code === "LICENSE_QUOTA_EXCEEDED"
        ? {
            resource: typeof details?.resource === "string" ? details.resource : undefined,
            limit: typeof details?.limit === "number" ? details.limit : undefined,
            current: typeof details?.current === "number" ? details.current : undefined,
          }
        : undefined,
  });
  return true;
}
