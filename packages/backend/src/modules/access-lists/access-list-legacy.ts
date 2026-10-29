import type { AccessRule, AccessSignInMethod } from '@/db/schema/access-lists.js';
import type { LegacyIpRule } from './access-list.schemas.js';

/**
 * The fields published API clients and scripts sent before sign-in based lists (ipRules, basicAuthEnabled,
 * basicAuthUsers) keep their meaning: they are converted with exactly the mapping of migration 0277. nginx checked
 * the IP rules in order up to the first `all` rule and denied what matched none (no rules: everyone got in); basic
 * authentication applied on top (satisfy all).
 */

export interface LegacyAccessFields {
  ipRules: LegacyIpRule[];
  basicAuthEnabled: boolean;
}

export interface AccessListRules {
  signInMethods: AccessSignInMethod[];
  skipIpRanges: string[];
  includeRules: AccessRule[];
  requireRules: AccessRule[];
  excludeRules: AccessRule[];
}

const EVERY_ADDRESS = ['0.0.0.0/0', '::/0'];

/** The sign-in fields of a list written with the legacy fields (migration 0277). */
export function legacyAccessRules({ ipRules, basicAuthEnabled }: LegacyAccessFields): AccessListRules {
  const allows: string[] = [];
  const denies: string[] = [];
  let allAllowed = false;
  for (const rule of ipRules) {
    const value = rule.value.trim();
    if (value.toLowerCase() === 'all') {
      allAllowed = rule.type === 'allow';
      break;
    }
    (rule.type === 'allow' ? allows : denies).push(value);
  }
  const ipRestricted = ipRules.length > 0 && !allAllowed;
  return {
    signInMethods: basicAuthEnabled ? ['basic'] : [],
    skipIpRanges: basicAuthEnabled ? [] : ipRestricted ? allows : [...EVERY_ADDRESS],
    includeRules: basicAuthEnabled ? [{ selector: 'everyone', values: [] }] : [],
    requireRules: basicAuthEnabled && ipRestricted ? [{ selector: 'ip', values: allows }] : [],
    excludeRules: denies.length > 0 ? [{ selector: 'ip', values: denies }] : [],
  };
}

function sameRules(left: AccessListRules, right: AccessListRules): boolean {
  const normalize = (rules: AccessListRules) =>
    JSON.stringify([
      rules.signInMethods,
      rules.skipIpRanges,
      rules.includeRules.map((rule) => [rule.selector, rule.values]),
      rules.requireRules.map((rule) => [rule.selector, rule.values]),
      rules.excludeRules.map((rule) => [rule.selector, rule.values]),
    ]);
  return normalize(left) === normalize(right);
}

/**
 * The legacy fields of a list that the legacy fields can express (the inverse of legacyAccessRules), so a legacy
 * update of one field keeps the others; null for a list that uses anything else (sign-in methods, identity rules).
 */
export function legacyAccessFieldsOf(list: AccessListRules): LegacyAccessFields | null {
  const basicAuthEnabled = list.signInMethods.includes('basic');
  const ip = (rules: AccessRule[]) => rules.find((rule) => rule.selector === 'ip')?.values ?? [];
  const denies = ip(list.excludeRules);
  const everyAddress =
    !basicAuthEnabled &&
    EVERY_ADDRESS.every((range) => list.skipIpRanges.includes(range)) &&
    list.skipIpRanges.length === 2;
  const restricted = basicAuthEnabled ? list.requireRules.length > 0 : !everyAddress;
  const allows = basicAuthEnabled ? ip(list.requireRules) : everyAddress ? [] : list.skipIpRanges;
  const ipRules: LegacyIpRule[] = [
    ...denies.map((value) => ({ type: 'deny' as const, value })),
    ...allows.map((value) => ({ type: 'allow' as const, value })),
    ...(restricted && denies.length === 0 && allows.length === 0 ? [{ type: 'deny' as const, value: 'all' }] : []),
    ...(!restricted && denies.length > 0 ? [{ type: 'allow' as const, value: 'all' }] : []),
  ];
  const fields = { ipRules, basicAuthEnabled };
  return sameRules(legacyAccessRules(fields), list) ? fields : null;
}
