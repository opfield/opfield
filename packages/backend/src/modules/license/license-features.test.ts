import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LICENSE_PLAN_ENTITLEMENTS } from './license.types.js';
import {
  entitlementsIncludeFeature,
  LICENSE_FEATURE_ENTITLEMENT_ALIASES,
  LICENSE_FEATURE_PLANS,
  LICENSE_PRE_V5_PERSONAL_CAPABILITIES,
} from './license-features.js';

const FRONTEND_FEATURES = join(process.cwd(), '../frontend/src/types/license-features.ts');

const key = (name: string) => (/^[a-z]+$/.test(name) ? name : `"${name}"`);

/** The generated frontend module, formatted the way Biome keeps it (100 columns, double quotes). */
function renderFrontendFeatures(): string {
  return [
    '// Generated from packages/backend/src/modules/license/license-features.ts. Do not edit by hand.',
    '// Regenerate: cd packages/backend && UPDATE_LICENSE_FEATURES=1 pnpm vitest run src/modules/license/license-features.test.ts',
    '',
    '/** Paid features and the plan that first includes each. */',
    'export const LICENSE_FEATURE_PLANS = {',
    ...Object.entries(LICENSE_FEATURE_PLANS).map(([feature, plan]) => `  ${key(feature)}: "${plan}",`),
    '} as const;',
    '',
    'export type LicenseFeature = keyof typeof LICENSE_FEATURE_PLANS;',
    '',
    '/** Features granted under another entitlement name. */',
    'export const LICENSE_FEATURE_ENTITLEMENT_ALIASES: Partial<Record<LicenseFeature, string>> = {',
    ...Object.entries(LICENSE_FEATURE_ENTITLEMENT_ALIASES).map(([feature, alias]) => `  ${key(feature)}: "${alias}",`),
    '};',
    '',
    '/** Granted to every paid v3-v5 contract through managed-databases. */',
    'export const LICENSE_PRE_V5_PERSONAL_CAPABILITIES: readonly LicenseFeature[] = [',
    ...LICENSE_PRE_V5_PERSONAL_CAPABILITIES.map((feature) => `  "${feature}",`),
    '];',
    '',
    '/** Whether an entitlement feature list grants a feature; the same rule as the backend policy. */',
    'export function entitlementsIncludeFeature(',
    '  features: readonly string[],',
    '  feature: LicenseFeature',
    '): boolean {',
    '  if (features.includes(LICENSE_FEATURE_ENTITLEMENT_ALIASES[feature] ?? feature)) return true;',
    '  return (',
    '    LICENSE_PRE_V5_PERSONAL_CAPABILITIES.includes(feature) && features.includes("managed-databases")',
    '  );',
    '}',
    '',
  ].join('\n');
}

describe('license features', () => {
  it('keeps the generated frontend copy current', () => {
    const rendered = renderFrontendFeatures();
    if (process.env.UPDATE_LICENSE_FEATURES === '1') writeFileSync(FRONTEND_FEATURES, rendered);
    expect(readFileSync(FRONTEND_FEATURES, 'utf8')).toBe(rendered);
  });

  it('grants every feature of a plan to that plan', () => {
    for (const [feature, plan] of Object.entries(LICENSE_FEATURE_PLANS)) {
      expect(
        entitlementsIncludeFeature(
          LICENSE_PLAN_ENTITLEMENTS[plan].features,
          feature as keyof typeof LICENSE_FEATURE_PLANS
        )
      ).toBe(true);
      expect(
        entitlementsIncludeFeature(
          LICENSE_PLAN_ENTITLEMENTS.community.features,
          feature as keyof typeof LICENSE_FEATURE_PLANS
        )
      ).toBe(false);
    }
  });
});
