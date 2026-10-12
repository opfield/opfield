import { useMemo } from "react";
import { create } from "zustand";
import { ApiRequestError } from "@/services/api-base";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { LicensePlan } from "@/types";
import type { UIBootstrapShell } from "@/types/ui-bootstrap";

export const LICENSE_FEATURE_PLANS = {
  "storage-connections": "personal",
  "external-database-connections": "personal",
  gitlab: "personal",
  "ai-plan-mode": "personal",
  "ai-scenarios": "personal",
  "ai-sandboxes": "personal",
  "container-export": "personal",
  "blue-green": "personal",
  "cross-node-migration": "personal",
  "managed-storage": "personal",
  "managed-databases": "personal",
  "container-links": "personal",
  "status-pages": "personal",
  "registry-discovery": "personal",
  pages: "personal",
  "secure-runtime": "business",
  "structured-logging": "business",
  "audit-export": "business",
  "git-push-to-deploy": "business",
  "multi-node-availability": "business",
  "compose-applications": "personal",
  "internal-pki": "enterprise",
  "siem-export": "enterprise",
} as const satisfies Record<string, Exclude<LicensePlan, "community">>;

export type LicenseFeature = keyof typeof LICENSE_FEATURE_PLANS;
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

// Mirrors the backend policy: published paid v3/v4 grants predate these
// capability names, and every one of them includes managed-databases.
const PRE_V5_PERSONAL_CAPABILITIES = new Set<LicenseFeature>([
  "storage-connections",
  "external-database-connections",
  "ai-plan-mode",
  "ai-scenarios",
  "ai-sandboxes",
]);

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
  if (
    license.entitlements.features.includes(
      feature === "managed-storage" || feature === "container-links" ? "managed-databases" : feature
    )
  )
    return true;
  return (
    license.entitlementsVersion < 5 &&
    PRE_V5_PERSONAL_CAPABILITIES.has(feature) &&
    license.entitlements.features.includes("managed-databases")
  );
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

/** Navigation items backed by one paid feature. */
const LICENSED_NAVIGATION_ITEMS = {
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
