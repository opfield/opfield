import { describe, expect, it } from 'vitest';
import legacy from './fixtures/entitlements-legacy.json';
import {
  COMMUNITY_ENTITLEMENTS,
  canonicalLicenseFeature,
  isCanonicalEntitlements,
  LICENSE_ENTITLEMENTS_VERSION,
  LICENSE_PLAN_ENTITLEMENTS,
  type LicensePlan,
  licensePlanEntitlementsForVersion,
} from './license.types.js';

const plans: LicensePlan[] = ['community', 'personal', 'business', 'enterprise'];

describe('versioned entitlement contracts', () => {
  it.each([3, 4] as const)('preserves every published v%s grant', (version) => {
    // The license server signs `gateway-inference`; Opfield names the same feature `inference`.
    const published = Object.fromEntries(
      plans.map((plan) => [
        plan,
        { ...legacy[version][plan], features: legacy[version][plan].features.map(canonicalLicenseFeature) },
      ])
    );
    expect(licensePlanEntitlementsForVersion(version)).toEqual(published);
    for (const plan of plans) {
      expect(isCanonicalEntitlements(plan, legacy[version][plan], version)).toBe(true);
      expect(isCanonicalEntitlements(plan, legacy[version][plan], 5)).toBe(false);
    }
  });

  it('introduces v5 Community quotas without changing legacy limits', () => {
    expect(LICENSE_ENTITLEMENTS_VERSION).toBe(5);
    expect(COMMUNITY_ENTITLEMENTS).toMatchObject({ managedNodes: 25, users: 3, customPermissionGroups: 1 });
    for (const version of [3, 4]) {
      expect(licensePlanEntitlementsForVersion(version)?.community).toMatchObject({
        managedNodes: 100,
        users: 10,
        customPermissionGroups: 5,
      });
    }
  });

  it.each([
    'gitlab',
    'storage-connections',
    'external-database-connections',
    'managed-storage',
    'ai-plan-mode',
    'ai-scenarios',
    'ai-sandboxes',
  ])('starts %s at Personal in v5', (feature) => {
    expect(COMMUNITY_ENTITLEMENTS.features).not.toContain(feature);
    for (const plan of ['personal', 'business', 'enterprise'] as const) {
      expect(LICENSE_PLAN_ENTITLEMENTS[plan].features).toContain(feature);
      expect(isCanonicalEntitlements(plan, LICENSE_PLAN_ENTITLEMENTS[plan])).toBe(true);
    }
  });

  it('retains the free infrastructure, security and AI entry points', () => {
    expect(COMMUNITY_ENTITLEMENTS.features).toEqual(
      expect.arrayContaining([
        'docker',
        'nginx',
        'tls',
        'auth',
        'rbac',
        'audit',
        'api',
        'mcp',
        'ai-workspace',
        'inference',
      ])
    );
  });

  it('accepts both the current and the pre-2.12.1 inference feature key', () => {
    for (const plan of plans) {
      const signed = {
        ...LICENSE_PLAN_ENTITLEMENTS[plan],
        features: LICENSE_PLAN_ENTITLEMENTS[plan].features.map((feature) =>
          feature === 'inference' ? 'gateway-inference' : feature
        ),
      };
      expect(signed.features).toContain('gateway-inference');
      expect(isCanonicalEntitlements(plan, signed)).toBe(true);
      expect(isCanonicalEntitlements(plan, LICENSE_PLAN_ENTITLEMENTS[plan])).toBe(true);
      expect(isCanonicalEntitlements(plan, { ...signed, features: [...signed.features, 'inference'] })).toBe(false);
    }
  });

  it('rejects unknown versions and edited canonical grants', () => {
    expect(licensePlanEntitlementsForVersion(6)).toBeUndefined();
    expect(isCanonicalEntitlements('community', COMMUNITY_ENTITLEMENTS, 6)).toBe(false);
    expect(isCanonicalEntitlements('community', { ...COMMUNITY_ENTITLEMENTS, users: 100 })).toBe(false);
    expect(
      isCanonicalEntitlements('personal', {
        ...LICENSE_PLAN_ENTITLEMENTS.personal,
        features: [...LICENSE_PLAN_ENTITLEMENTS.personal.features, 'internal-pki'],
      })
    ).toBe(false);
  });
});
