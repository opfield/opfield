// Generated from packages/backend/src/modules/license/license-features.ts. Do not edit by hand.
// Regenerate: cd packages/backend && UPDATE_LICENSE_FEATURES=1 pnpm vitest run src/modules/license/license-features.test.ts

/** Paid features and the plan that first includes each. */
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
  "managed-databases": "personal",
  "managed-storage": "personal",
  "status-pages": "personal",
  "registry-discovery": "personal",
  pages: "personal",
  "secure-runtime": "business",
  "structured-logging": "business",
  "audit-export": "business",
  "git-push-to-deploy": "business",
  "multi-node-availability": "business",
  "compose-applications": "personal",
  "container-links": "personal",
  "internal-pki": "enterprise",
  "siem-export": "enterprise",
} as const;

export type LicenseFeature = keyof typeof LICENSE_FEATURE_PLANS;

/** Features granted under another entitlement name. */
export const LICENSE_FEATURE_ENTITLEMENT_ALIASES: Partial<Record<LicenseFeature, string>> = {
  "managed-storage": "managed-databases",
};

/** Granted to every paid v3-v5 contract through managed-databases. */
export const LICENSE_PRE_V5_PERSONAL_CAPABILITIES: readonly LicenseFeature[] = [
  "storage-connections",
  "external-database-connections",
  "ai-plan-mode",
  "ai-scenarios",
  "ai-sandboxes",
  "container-links",
];

/** Whether an entitlement feature list grants a feature; the same rule as the backend policy. */
export function entitlementsIncludeFeature(
  features: readonly string[],
  feature: LicenseFeature
): boolean {
  if (features.includes(LICENSE_FEATURE_ENTITLEMENT_ALIASES[feature] ?? feature)) return true;
  return (
    LICENSE_PRE_V5_PERSONAL_CAPABILITIES.includes(feature) && features.includes("managed-databases")
  );
}
