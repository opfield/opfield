export const LICENSE_LEGACY_ENTITLEMENTS_VERSION = 3;
export const LICENSE_PREVIOUS_ENTITLEMENTS_VERSION = 4;
export const LICENSE_ENTITLEMENTS_VERSION = 5;
export const LICENSE_SUPPORTED_ENTITLEMENTS_VERSIONS: readonly number[] = [3, 4, 5];
export const LICENSE_OFFLINE_GRACE_DAYS = 100;
/** Plan-specific grace after expiration or a plan downgrade, before paid entitlements drop. */
export const LICENSE_PLAN_GRACE_HOURS: Record<'personal' | 'business' | 'enterprise', number> = {
  personal: 24,
  business: 72,
  enterprise: 168,
};
export const LICENSE_PAID_HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
export const LICENSE_COMMUNITY_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
export const LICENSE_SCHEDULER_INTERVAL_MS = LICENSE_PAID_HEARTBEAT_INTERVAL_MS;

export type LicensePlan = 'community' | 'personal' | 'business' | 'enterprise';
export type LicenseRegistrationStatus = 'registered' | 'pending';

export type LicenseStatus =
  | 'community'
  | 'valid'
  | 'expired_grace'
  | 'valid_with_warning'
  | 'unreachable_grace_expired'
  | 'invalid'
  | 'expired'
  | 'revoked'
  | 'replaced'
  | 'deactivated';

export interface EncryptedLicenseCredential {
  encryptedKey: string;
  encryptedDek: string;
}

export interface LicenseEntitlements {
  managedNodes: number | null;
  users: number | null;
  customPermissionGroups: number | null;
  supportLevel: string;
  features: string[];
}

export interface CachedLicenseState {
  registrationStatus: LicenseRegistrationStatus;
  /** Signature over the last accepted server state. Server fields below are only a display copy. */
  attestation?: unknown;
  /** Signature over the latest accepted state of the highest paid plan, kept for continuity. */
  retainedAttestation?: unknown;
  /** Whether no loss was reported since the retained state, so a plan downgrade still has grace. */
  retainedGraceEligible?: boolean;
  status: LicenseStatus;
  plan: LicensePlan;
  paidPlan: Exclude<LicensePlan, 'community'> | null;
  paidLicenseStatus: string;
  licenseName: string | null;
  licenseMetadata: Record<string, unknown>;
  expiresAt: string | null;
  graceUntil: string | null;
  entitlementsVersion: number;
  entitlements: LicenseEntitlements;
  lastCheckedAt: string | null;
  lastValidAt: string | null;
  activeInstallationId: string | null;
  activeInstallationName: string | null;
  errorMessage: string | null;
}

export interface LicenseStatusView {
  status: LicenseStatus;
  plan: LicensePlan;
  registrationStatus: LicenseRegistrationStatus;
  paidLicenseStatus: string;
  licensed: boolean;
  hasKey: boolean;
  keyLast4: string | null;
  licenseName: string | null;
  licenseMetadata: Record<string, unknown>;
  installationId: string;
  installationName: string;
  expiresAt: string | null;
  entitlementsVersion: number;
  entitlements: LicenseEntitlements;
  lastCheckedAt: string | null;
  lastValidAt: string | null;
  graceUntil: string | null;
  offlineGraceUntil: string | null;
  activeInstallationId: string | null;
  activeInstallationName: string | null;
  errorMessage: string | null;
  serverUrl: string;
}

export interface LicenseServerPaidLicense {
  id: string;
  status: 'active' | 'expired' | 'revoked';
  plan: Exclude<LicensePlan, 'community'>;
  name: string;
  expiresAt: string | null;
  keyLast4: string;
  metadata: Record<string, unknown>;
}

export interface LicenseServerState {
  registrationStatus: 'registered';
  effectivePlan: LicensePlan;
  paidLicenseStatus: string;
  paidLicense?: LicenseServerPaidLicense;
  graceUntil: string | null;
  entitlementsVersion: number;
  entitlements: LicenseEntitlements;
  activation?: {
    installationId: string;
    installationName: string;
    activatedAt: string;
    lastHeartbeatAt: string | null;
  };
  serverTime: string;
  /** Ed25519 signature bound to this installation and request; see license-attestation.ts. */
  attestation?: unknown;
}

export interface LicenseServerRegistration {
  installationToken: string;
  state: LicenseServerState;
}

export interface LicenseServerEnvelope<T> {
  data: T;
}

export interface LicenseServerErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

const SHARED_FEATURES = [
  'infrastructure',
  'nginx',
  'docker',
  'tls',
  'domains',
  'monitoring',
  'auth',
  'rbac',
  'audit',
  'api',
  'oauth',
  'mcp',
  'gitlab',
  'ai-workspace',
  'inference',
  'signed-updates',
] as const;

// legacy-name: the legacy inference license feature key — the license server still signs it in place of `inference`;
// remove once the license server issues only `inference`.
const LEGACY_FEATURE_NAMES: Readonly<Record<string, string>> = { 'gateway-inference': 'inference' };

/** A signed feature key under its current name. */
export function canonicalLicenseFeature(feature: string): string {
  return LEGACY_FEATURE_NAMES[feature] ?? feature;
}

const PERSONAL_FEATURES_V3 = [
  ...SHARED_FEATURES,
  'container-export',
  'blue-green',
  'cross-node-migration',
  'managed-databases',
  'status-pages',
  'registry-discovery',
  'pages',
] as const;

const PERSONAL_FEATURES = [...PERSONAL_FEATURES_V3, 'compose-applications'] as const;

const BUSINESS_FEATURES_V3 = [
  ...PERSONAL_FEATURES_V3,
  'secure-runtime',
  'structured-logging',
  'audit-export',
  'security-scanning',
  'guided-onboarding',
] as const;

const BUSINESS_FEATURES = [
  ...PERSONAL_FEATURES,
  'git-push-to-deploy',
  'multi-node-availability',
  'secure-runtime',
  'structured-logging',
  'audit-export',
  'security-scanning',
  'guided-onboarding',
] as const;

const ENTERPRISE_FEATURES_V3 = [
  ...BUSINESS_FEATURES_V3,
  'internal-pki',
  'siem-export',
  'oidc-group-mapping',
  'scim',
  'dedicated-contact',
  'assisted-migration',
] as const;

// Published v3/v4 contracts must remain unchanged when the current plan changes.
export const COMMUNITY_ENTITLEMENTS_V4: LicenseEntitlements = {
  managedNodes: 100,
  users: 10,
  customPermissionGroups: 5,
  supportLevel: 'community',
  features: [...SHARED_FEATURES],
};

export const LICENSE_PLAN_ENTITLEMENTS_V4: Record<LicensePlan, LicenseEntitlements> = {
  community: COMMUNITY_ENTITLEMENTS_V4,
  personal: {
    managedNodes: null,
    users: null,
    customPermissionGroups: null,
    supportLevel: 'standard',
    features: [...PERSONAL_FEATURES],
  },
  business: {
    managedNodes: null,
    users: null,
    customPermissionGroups: null,
    supportLevel: 'priority',
    features: [...BUSINESS_FEATURES],
  },
  enterprise: {
    managedNodes: null,
    users: null,
    customPermissionGroups: null,
    supportLevel: 'priority-dedicated',
    features: [
      ...BUSINESS_FEATURES,
      'internal-pki',
      'siem-export',
      'oidc-group-mapping',
      'scim',
      'dedicated-contact',
      'assisted-migration',
    ],
  },
};

export const LICENSE_PLAN_ENTITLEMENTS_V3: Record<LicensePlan, LicenseEntitlements> = {
  community: COMMUNITY_ENTITLEMENTS_V4,
  personal: {
    managedNodes: null,
    users: null,
    customPermissionGroups: null,
    supportLevel: 'standard',
    features: [...PERSONAL_FEATURES_V3],
  },
  business: {
    managedNodes: null,
    users: null,
    customPermissionGroups: null,
    supportLevel: 'priority',
    features: [...BUSINESS_FEATURES_V3],
  },
  enterprise: {
    managedNodes: null,
    users: null,
    customPermissionGroups: null,
    supportLevel: 'priority-dedicated',
    features: [...ENTERPRISE_FEATURES_V3],
  },
};

const PERSONAL_FEATURES_V5 = [
  'storage-connections',
  'external-database-connections',
  'managed-storage',
  'ai-plan-mode',
  'ai-scenarios',
  'ai-sandboxes',
] as const;

export const COMMUNITY_ENTITLEMENTS: LicenseEntitlements = {
  managedNodes: 25,
  users: 3,
  customPermissionGroups: 1,
  supportLevel: 'community',
  features: SHARED_FEATURES.filter((feature) => feature !== 'gitlab'),
};

export const LICENSE_PLAN_ENTITLEMENTS: Record<LicensePlan, LicenseEntitlements> = {
  community: COMMUNITY_ENTITLEMENTS,
  personal: {
    ...LICENSE_PLAN_ENTITLEMENTS_V4.personal,
    features: [...LICENSE_PLAN_ENTITLEMENTS_V4.personal.features, ...PERSONAL_FEATURES_V5],
  },
  business: {
    ...LICENSE_PLAN_ENTITLEMENTS_V4.business,
    features: [...LICENSE_PLAN_ENTITLEMENTS_V4.business.features, ...PERSONAL_FEATURES_V5],
  },
  enterprise: {
    ...LICENSE_PLAN_ENTITLEMENTS_V4.enterprise,
    features: [...LICENSE_PLAN_ENTITLEMENTS_V4.enterprise.features, ...PERSONAL_FEATURES_V5],
  },
};

export function licensePlanEntitlementsForVersion(
  version: number
): Record<LicensePlan, LicenseEntitlements> | undefined {
  switch (version) {
    case LICENSE_LEGACY_ENTITLEMENTS_VERSION:
      return LICENSE_PLAN_ENTITLEMENTS_V3;
    case LICENSE_PREVIOUS_ENTITLEMENTS_VERSION:
      return LICENSE_PLAN_ENTITLEMENTS_V4;
    case LICENSE_ENTITLEMENTS_VERSION:
      return LICENSE_PLAN_ENTITLEMENTS;
    default:
      return undefined;
  }
}

export function isCanonicalEntitlements(
  plan: LicensePlan,
  value: unknown,
  version = LICENSE_ENTITLEMENTS_VERSION
): value is LicenseEntitlements {
  const expected = licensePlanEntitlementsForVersion(version)?.[plan];
  if (
    !expected ||
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as Partial<LicenseEntitlements>).features)
  ) {
    return false;
  }
  const entitlements = value as LicenseEntitlements;
  const features = entitlements.features.map((feature) =>
    typeof feature === 'string' ? canonicalLicenseFeature(feature) : feature
  );
  return (
    entitlements.managedNodes === expected.managedNodes &&
    entitlements.users === expected.users &&
    entitlements.customPermissionGroups === expected.customPermissionGroups &&
    entitlements.supportLevel === expected.supportLevel &&
    features.length === expected.features.length &&
    new Set(features).size === features.length &&
    features.every((feature) => expected.features.includes(feature))
  );
}
