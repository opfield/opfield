/**
 * Paid features, the plan that first includes each, and how a signed entitlement map grants them.
 * The single source for the backend policy and the frontend (generated copy in
 * packages/frontend/src/types/license-features.ts; see license-features.test.ts).
 */
export const LICENSE_FEATURE_PLANS = {
  'storage-connections': 'personal',
  'external-database-connections': 'personal',
  gitlab: 'personal',
  'ai-plan-mode': 'personal',
  'ai-scenarios': 'personal',
  'ai-sandboxes': 'personal',
  'container-export': 'personal',
  'blue-green': 'personal',
  'cross-node-migration': 'personal',
  'managed-databases': 'personal',
  'managed-storage': 'personal',
  'status-pages': 'personal',
  'registry-discovery': 'personal',
  pages: 'personal',
  'secure-runtime': 'business',
  'structured-logging': 'business',
  'audit-export': 'business',
  'git-push-to-deploy': 'business',
  'multi-node-availability': 'business',
  'compose-applications': 'personal',
  'container-links': 'personal',
  'internal-pki': 'enterprise',
  'siem-export': 'enterprise',
} as const;

export type LicenseFeature = keyof typeof LICENSE_FEATURE_PLANS;

/**
 * Features granted under another entitlement name. Retained v3/v4 storage uses managed-databases;
 * v5 explicitly includes both.
 */
export const LICENSE_FEATURE_ENTITLEMENT_ALIASES: Partial<Record<LicenseFeature, string>> = {
  'managed-storage': 'managed-databases',
};

/**
 * Published paid v3/v4 grants predate these capability names. Their canonical paid maps all include
 * managed-databases; Community never does. Container links came after v5 too: every paid v3-v5
 * contract grants them through managed-databases. Never add features retroactively to the
 * canonical v3/v4 signed contracts.
 */
export const LICENSE_PRE_V5_PERSONAL_CAPABILITIES: readonly LicenseFeature[] = [
  'storage-connections',
  'external-database-connections',
  'ai-plan-mode',
  'ai-scenarios',
  'ai-sandboxes',
  'container-links',
];

/** Whether an entitlement feature list grants a feature. */
export function entitlementsIncludeFeature(features: readonly string[], feature: LicenseFeature): boolean {
  if (features.includes(LICENSE_FEATURE_ENTITLEMENT_ALIASES[feature] ?? feature)) return true;
  return LICENSE_PRE_V5_PERSONAL_CAPABILITIES.includes(feature) && features.includes('managed-databases');
}
