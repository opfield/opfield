import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { LicenseService } from './license.service.js';
import {
  isCanonicalEntitlements,
  LICENSE_ENTITLEMENTS_VERSION,
  LICENSE_SUPPORTED_ENTITLEMENTS_VERSIONS,
  type LicenseEntitlements,
  type LicensePlan,
  type LicenseStatus,
  type LicenseStatusView,
} from './license.types.js';
import { entitlementsIncludeFeature, LICENSE_FEATURE_PLANS, type LicenseFeature } from './license-features.js';

const logger = createChildLogger('LicensePolicyService');

export { LICENSE_FEATURE_PLANS, type LicenseFeature } from './license-features.js';

export type LicenseQuotaResource = 'managedNodes' | 'users' | 'customPermissionGroups';
export type PaidLicensePlan = Exclude<LicensePlan, 'community'>;

function includesFeature(entitlements: LicenseEntitlements, feature: LicenseFeature): boolean {
  return entitlementsIncludeFeature(entitlements.features, feature);
}

// Statuses reached after a grace period ended. Their entitlements are Community,
// so current-plan checks fail; existing paid resources use continuity instead.
const LICENSE_POST_GRACE_STATUSES = new Set<LicenseStatus>(['expired', 'unreachable_grace_expired']);

const LICENSE_PLAN_RANK: Record<LicensePlan, number> = {
  community: 0,
  personal: 1,
  business: 2,
  enterprise: 3,
};

export interface SafeLicenseSummary {
  status: LicenseStatus;
  plan: LicensePlan;
  licensed: boolean;
  expiresAt: string | null;
  graceUntil: string | null;
  offlineGraceUntil: string | null;
  entitlementsVersion: number;
  entitlements: LicenseEntitlements;
}

export function requireConfiguredLicensePolicy(service?: LicensePolicyService): LicensePolicyService {
  if (service) return service;
  logger.error('License policy service is not configured');

  // LICENSE ENFORCEMENT: Missing policy wiring must fail closed; bypassing this guard violates the project license/TOS.
  throw new AppError(503, 'SERVICE_UNAVAILABLE', 'The requested operation is temporarily unavailable');
}

/**
 * License gate classes. Every paid gate uses one of two checks:
 *
 * - Current plan (`requireFeature`/`hasFeature`): creating paid resources, changing
 *   their configuration, and the paid service features SIEM forwarding and external
 *   Docker-client registry access. Passes during valid, expiration grace
 *   (24h/3d/7d), offline grace (100 days), and downgrade grace; fails afterwards.
 *   Revocation, replacement, and deactivation have no grace.
 * - Existing runtime (`requireFeatureForExistingRuntime`/`hasFeatureForExistingRuntime`):
 *   viewing, logs, monitoring, credential reveal, deletion, scheduled work, and the
 *   runtime of resources that already exist. Also passes after every grace for the
 *   highest paid plan the installation held, proven by a stored signed state.
 */
export async function hasConfiguredLicenseFeature(
  service: LicensePolicyService | undefined,
  feature: LicenseFeature
): Promise<boolean> {
  if (!service) {
    logger.error('License policy service is not configured', { feature });
    return false;
  }
  return service.hasFeature(feature);
}

export async function hasConfiguredLicenseFeatureForExistingRuntime(
  service: LicensePolicyService | undefined,
  feature: LicenseFeature
): Promise<boolean> {
  if (!service) {
    logger.error('License policy service is not configured', { feature, boundary: 'existing-runtime' });
    return false;
  }
  return service.hasFeatureForExistingRuntime(feature);
}

export class LicensePolicyService {
  constructor(private readonly licenses: LicenseService) {}

  async getSummary(): Promise<SafeLicenseSummary> {
    const status = await this.licenses.getStatus();
    if (!this.isPolicyStateValid(status)) {
      logger.error('License policy state is invalid', this.invalidStateDetails(status));
      return {
        status: 'invalid',
        plan: 'community',
        licensed: false,
        expiresAt: status.expiresAt,
        graceUntil: null,
        offlineGraceUntil: null,
        entitlementsVersion: status.entitlementsVersion,
        entitlements: {
          managedNodes: 0,
          users: 0,
          customPermissionGroups: 0,
          supportLevel: 'unavailable',
          features: [],
        },
      };
    }
    return this.toSafeSummary(status);
  }

  /** Current plan, including every grace period. See the gate classes above. */
  async hasFeature(feature: LicenseFeature): Promise<boolean> {
    const status = await this.licenses.getStatus();
    return (
      this.isPolicyStateValid(status) &&
      !LICENSE_POST_GRACE_STATUSES.has(status.status) &&
      includesFeature(status.entitlements, feature)
    );
  }

  /** Current plan, including every grace period. See the gate classes above. */
  async requireFeature(feature: LicenseFeature): Promise<void> {
    const status = await this.requireValidPolicyState();
    if (!LICENSE_POST_GRACE_STATUSES.has(status.status) && includesFeature(status.entitlements, feature)) {
      return;
    }

    // LICENSE ENFORCEMENT: Removing or bypassing this authoritative check violates the project license/TOS.
    throw new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'A higher license plan is required', {
      feature,
      requiredPlan: LICENSE_FEATURE_PLANS[feature],
      currentPlan: status.plan,
      licenseStatus: status.status,
    });
  }

  /**
   * Existing paid resources: current plan, or continuity for the highest paid plan
   * this installation held. Continuity survives expiry, offline grace, downgrade,
   * revocation, replacement, and deactivation; it never admits new paid resources.
   */
  async hasFeatureForExistingRuntime(feature: LicenseFeature): Promise<boolean> {
    const status = await this.licenses.getStatus();
    if (!this.isPolicyStateValid(status)) return false;
    if (includesFeature(status.entitlements, feature)) return true;
    const retained = await this.licenses.getRuntimeContinuityEntitlements();
    return retained ? includesFeature(retained, feature) : false;
  }

  /** Existing paid resources; see {@link hasFeatureForExistingRuntime}. */
  async requireFeatureForExistingRuntime(feature: LicenseFeature): Promise<void> {
    const status = await this.requireValidPolicyState();
    if (includesFeature(status.entitlements, feature)) return;
    const retained = await this.licenses.getRuntimeContinuityEntitlements();
    if (retained && includesFeature(retained, feature)) return;

    throw new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'A higher license plan is required', {
      feature,
      requiredPlan: LICENSE_FEATURE_PLANS[feature],
      currentPlan: status.plan,
      licenseStatus: status.status,
    });
  }

  async requireMinimumPlan(requiredPlan: PaidLicensePlan): Promise<void> {
    const status = await this.requireValidPolicyState();
    if (LICENSE_PLAN_RANK[status.plan] >= LICENSE_PLAN_RANK[requiredPlan]) return;

    throw new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'A higher license plan is required', {
      requiredPlan,
      currentPlan: status.plan,
      licenseStatus: status.status,
    });
  }

  async requireQuota(resource: LicenseQuotaResource, current: number): Promise<void> {
    const status = await this.requireValidPolicyState();
    const limit = status.entitlements[resource];
    if (limit === null || current < limit) return;

    // LICENSE ENFORCEMENT: Removing or bypassing this authoritative check violates the project license/TOS.
    throw new AppError(409, 'LICENSE_QUOTA_EXCEEDED', 'The current license plan quota has been reached', {
      resource,
      limit,
      current,
      currentPlan: status.plan,
    });
  }

  private async requireValidPolicyState(): Promise<LicenseStatusView> {
    const status = await this.licenses.getStatus();
    if (this.isPolicyStateValid(status)) return status;
    logger.error('License policy state is invalid', this.invalidStateDetails(status));

    // LICENSE ENFORCEMENT: Protected mutations must fail closed when policy data is corrupt or unsupported.
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'The requested operation is temporarily unavailable');
  }

  private isPolicyStateValid(status: LicenseStatusView): boolean {
    const entitlements = status.entitlements;
    const plans: LicensePlan[] = ['community', 'personal', 'business', 'enterprise'];
    const statuses: LicenseStatus[] = [
      'community',
      'valid',
      'expired_grace',
      'valid_with_warning',
      'unreachable_grace_expired',
      'invalid',
      'expired',
      'revoked',
      'replaced',
      'deactivated',
    ];
    if (!plans.includes(status.plan) || !statuses.includes(status.status)) return false;
    if (!LICENSE_SUPPORTED_ENTITLEMENTS_VERSIONS.includes(status.entitlementsVersion)) {
      return false;
    }
    if (!entitlements || typeof entitlements !== 'object' || !Array.isArray(entitlements.features)) return false;
    if (typeof entitlements.supportLevel !== 'string') return false;
    if (
      !(['managedNodes', 'users', 'customPermissionGroups'] as const).every((resource) => {
        const value = entitlements[resource];
        return value === null || (Number.isInteger(value) && value >= 0);
      })
    ) {
      return false;
    }
    if (!isCanonicalEntitlements(status.plan, entitlements, status.entitlementsVersion)) return false;

    if (status.status === 'community') {
      return status.plan === 'community' && status.licensed;
    }
    if (status.status === 'valid' || status.status === 'expired_grace' || status.status === 'valid_with_warning') {
      return status.plan !== 'community' && status.licensed;
    }
    return status.plan === 'community' && !status.licensed;
  }

  private invalidStateDetails(status: LicenseStatusView): Record<string, unknown> {
    return {
      status: status.status,
      plan: status.plan,
      entitlementsVersion: status.entitlementsVersion,
      expectedEntitlementsVersion: LICENSE_ENTITLEMENTS_VERSION,
    };
  }

  private toSafeSummary(status: LicenseStatusView): SafeLicenseSummary {
    return {
      status: status.status,
      plan: status.plan,
      licensed: status.licensed,
      expiresAt: status.expiresAt,
      graceUntil: status.graceUntil,
      offlineGraceUntil: status.offlineGraceUntil,
      entitlementsVersion: status.entitlementsVersion,
      entitlements: status.entitlements,
    };
  }
}
