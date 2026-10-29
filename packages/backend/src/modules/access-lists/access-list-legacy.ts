import { isIP } from 'node:net';
import type { AccessRule, AccessSignInMethod } from '@/db/schema/access-lists.js';
import { AppError } from '@/middleware/error-handler.js';
import type { LegacyIpRule, MoveAccessListIpRuleInput } from './access-list.schemas.js';

/**
 * The fields published API clients and scripts sent before sign-in based lists (ipRules, basicAuthEnabled,
 * basicAuthUsers) keep their meaning: they are converted with exactly the mapping of migration 0279. nginx checked
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

interface Cidr {
  family: 4 | 6;
  base: bigint;
  prefix: number;
}

const bitsOf = (family: 4 | 6) => (family === 4 ? 32 : 128);

function parseCidr(value: string): Cidr | null {
  const [address = '', prefixText] = value.split('/');
  const family = isIP(address);
  if (family !== 4 && family !== 6) return null;
  const bits = bitsOf(family);
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  let number = 0n;
  if (family === 4) {
    for (const part of address.split('.')) number = (number << 8n) | BigInt(Number(part));
  } else {
    // Expand :: and a trailing embedded IPv4 address into eight groups.
    const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1];
    let text = address;
    if (embedded) {
      const octets = embedded.split('.').map(Number);
      text = `${address.slice(0, -embedded.length)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
    }
    const [head = '', tail] = text.split('::');
    const headGroups = head ? head.split(':') : [];
    const tailGroups = tail ? tail.split(':') : [];
    const groups =
      tail === undefined
        ? headGroups
        : [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups];
    for (const group of groups) number = (number << 16n) | BigInt(Number.parseInt(group, 16));
  }
  const hostBits = BigInt(bits - prefix);
  return { family, base: (number >> hostBits) << hostBits, prefix };
}

function formatCidr({ family, base, prefix }: Cidr): string {
  let address: string;
  if (family === 4) {
    address = [24n, 16n, 8n, 0n].map((shift) => String((base >> shift) & 255n)).join('.');
  } else {
    const groups = Array.from({ length: 8 }, (_, index) => Number((base >> BigInt(112 - index * 16)) & 0xffffn));
    // The longest run of two or more zero groups becomes :: (RFC 5952).
    let runStart = -1;
    let runLength = 0;
    for (let index = 0; index < 8; ) {
      if (groups[index] !== 0) {
        index += 1;
        continue;
      }
      let end = index;
      while (end < 8 && groups[end] === 0) end += 1;
      if (end - index > runLength) [runStart, runLength] = [index, end - index];
      index = end;
    }
    const hex = groups.map((group) => group.toString(16));
    address =
      runLength >= 2
        ? `${hex.slice(0, runStart).join(':')}::${hex.slice(runStart + runLength).join(':')}`
        : hex.join(':');
  }
  return prefix === bitsOf(family) ? address : `${address}/${prefix}`;
}

/** Whether `inner` lies inside `outer` (or equals it). */
function within(inner: Cidr, outer: Cidr): boolean {
  if (inner.family !== outer.family || inner.prefix < outer.prefix) return false;
  const hostBits = BigInt(bitsOf(outer.family) - outer.prefix);
  return inner.base >> hostBits === outer.base >> hostBits;
}

/** `range` without the addresses in `covers`, as CIDR ranges: a partly covered range splits into its two halves. */
function subtractCidr(range: Cidr, covers: Cidr[]): Cidr[] {
  if (covers.some((cover) => within(range, cover))) return [];
  if (!covers.some((cover) => within(cover, range))) return [range];
  const prefix = range.prefix + 1;
  const upper = range.base | (1n << BigInt(bitsOf(range.family) - prefix));
  return [...subtractCidr({ ...range, prefix }, covers), ...subtractCidr({ ...range, base: upper, prefix }, covers)];
}

/**
 * What a deny rule still denied: nginx took the first rule that matched, so an address an earlier allow rule matched
 * was let in. The rule as written when no earlier allow overlaps it.
 */
function deniedAfter(value: string, earlierAllows: string[]): string[] {
  const range = parseCidr(value);
  if (!range) return [value];
  const covers = earlierAllows.map(parseCidr).filter((cover): cover is Cidr => cover !== null);
  const remaining = subtractCidr(range, covers);
  return remaining.length === 1 && remaining[0]!.prefix === range.prefix ? [value] : remaining.map(formatCidr);
}

/** The sign-in fields of a list written with the legacy fields (migration 0279). */
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
    if (rule.type === 'allow') allows.push(value);
    else denies.push(...deniedAfter(value, allows));
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

/**
 * POST /api/access-lists/:id/ip-rules/move of clients written before sign-in based lists: the rule moves in the list's
 * legacy view (deny rules first, then allow rules) and the result is converted again, so a deny rule moved after an
 * allow rule stops excluding what that allow rule covers. A list the legacy fields cannot express is refused.
 */
export function movedLegacyIpRules(list: AccessListRules, { fromIndex, toIndex }: MoveAccessListIpRuleInput) {
  const fields = legacyAccessFieldsOf(list);
  if (!fields) {
    throw new AppError(
      409,
      'ACCESS_LIST_NOT_LEGACY',
      'This access list uses sign-in rules that IP rules cannot express; edit it with the sign-in fields instead'
    );
  }
  const rules = [...fields.ipRules];
  if (fromIndex >= rules.length || toIndex >= rules.length) {
    throw new AppError(
      400,
      'IP_RULE_INDEX_OUT_OF_RANGE',
      `The access list has ${rules.length} IP rule(s); fromIndex and toIndex are 0-based positions below that`
    );
  }
  const [moved] = rules.splice(fromIndex, 1);
  rules.splice(toIndex, 0, moved!);
  return { ...fields, ipRules: rules, moved: moved! };
}
