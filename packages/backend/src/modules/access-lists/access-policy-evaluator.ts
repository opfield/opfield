import { BlockList, isIP } from 'node:net';
import type { AccessRule } from '@/db/schema/access-lists.js';

/**
 * The access decision of a list, the same as the nginx daemon's (contract: Decision; shared vectors in
 * testdata/access/vectors.json). Pure: the caller verifies credentials and tokens and passes the identity they
 * carry. The sign-in page asks it whether a signed-in visitor may enter a host.
 */

/** The parts of an access list the decision reads. */
export interface AccessPolicyList {
  id: string;
  signInMethods: readonly string[];
  skipIpRanges: readonly string[];
  includeRules: readonly AccessRule[];
  requireRules: readonly AccessRule[];
  excludeRules: readonly AccessRule[];
}

/** The identity claims of an access token (`idn`), or of a basic or service token identity. */
export interface AccessIdentity {
  /** Sign-in method: opfield, password, basic, shared, idp:<provider id>, service_token. */
  m: string;
  sub: string;
  em?: string;
  nm?: string;
  grp?: string[];
  /** The list a password, basic or shared identity is valid for. */
  lst?: string;
}

/** Where a verified identity came from: the access token cookie, an Authorization: Basic header, a service token. */
export type AccessIdentitySource = 'cookie' | 'basic' | 'service_token';

export interface PresentedAccessIdentity {
  source: AccessIdentitySource;
  identity: AccessIdentity;
}

/** allow; deny; basic: ask for basic credentials; redirect: send to the sign-in page. */
export type AccessDecision = 'allow' | 'deny' | 'basic' | 'redirect';

const LIST_BOUND_METHODS = new Set(['password', 'basic', 'shared']);

/** An IPv4-mapped IPv6 address (::ffff:192.0.2.1) is the IPv4 client it carries. */
function normalizedIp(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip.trim());
  return mapped ? mapped[1]! : ip.trim();
}

/** Whether `ip` is one of `ranges` (addresses or CIDR ranges, IPv4 or IPv6). Malformed entries match nothing. */
export function ipInRanges(ip: string, ranges: readonly string[]): boolean {
  const address = normalizedIp(ip);
  const family = isIP(address);
  if (family === 0 || ranges.length === 0) return false;
  const blockList = new BlockList();
  for (const range of ranges) {
    const [base, prefix] = range.trim().split('/');
    const rangeFamily = isIP(base ?? '');
    if (rangeFamily === 0) continue;
    const type = rangeFamily === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) {
      blockList.addAddress(base!, type);
    } else if (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (rangeFamily === 4 ? 32 : 128)) {
      blockList.addSubnet(base!, Number(prefix), type);
    }
  }
  return blockList.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function sharesGroup(groups: readonly string[] | undefined, values: readonly string[]): boolean {
  return (groups ?? []).some((group) => values.includes(group));
}

/** Whether a rule matches the identity at this client address. */
export function accessRuleMatches(rule: AccessRule, identity: AccessIdentity, clientIp: string): boolean {
  const email = identity.em?.toLowerCase();
  switch (rule.selector) {
    case 'everyone':
      return true;
    case 'ip':
      return ipInRanges(clientIp, rule.values);
    case 'email':
      return !!email && rule.values.some((value) => value.toLowerCase() === email);
    case 'email_domain':
      return !!email && rule.values.some((value) => email.endsWith(`@${value.toLowerCase()}`));
    case 'opfield_user':
      return identity.m === 'opfield' && rule.values.includes(identity.sub);
    case 'opfield_group':
      return identity.m === 'opfield' && sharesGroup(identity.grp, rule.values);
    case 'sso_group':
      return identity.m.startsWith('idp:') && sharesGroup(identity.grp, rule.values);
    case 'method':
      return rule.values.includes(identity.m);
    case 'service_token':
      return identity.m === 'service_token' && rule.values.includes(identity.sub);
    default:
      return false;
  }
}

/**
 * Whether the list accepts an identity at all: a service token only through an Include rule that names it, any other
 * identity only by a method the list offers; password, basic and shared identities only for the list they signed in to.
 */
export function accessIdentityUsable(list: AccessPolicyList, identity: AccessIdentity): boolean {
  if (identity.m === 'service_token') {
    return list.includeRules.some((rule) => rule.selector === 'service_token' && rule.values.includes(identity.sub));
  }
  if (!list.signInMethods.includes(identity.m)) return false;
  return !LIST_BOUND_METHODS.has(identity.m) || identity.lst === list.id;
}

/** Whether a usable identity passes the rules: no Exclude rule, every Require rule and one Include rule match. */
export function accessIdentityAdmitted(list: AccessPolicyList, identity: AccessIdentity, clientIp: string): boolean {
  if (list.excludeRules.some((rule) => rule.selector !== 'ip' && accessRuleMatches(rule, identity, clientIp))) {
    return false;
  }
  if (!list.requireRules.every((rule) => accessRuleMatches(rule, identity, clientIp))) return false;
  return list.includeRules.some((rule) => accessRuleMatches(rule, identity, clientIp));
}

function withoutIdentity(list: AccessPolicyList): AccessDecision {
  if (list.signInMethods.length === 0) return 'deny';
  if (list.signInMethods.length === 1 && list.signInMethods[0] === 'basic') return 'basic';
  return 'redirect';
}

/** The decision for a request from `clientIp` with the identity it presented (none: undefined). */
export function evaluateAccess(
  list: AccessPolicyList,
  request: { clientIp: string },
  presented?: PresentedAccessIdentity
): AccessDecision {
  const excludedIps = list.excludeRules.filter((rule) => rule.selector === 'ip').flatMap((rule) => rule.values);
  if (ipInRanges(request.clientIp, excludedIps)) return 'deny';
  if (ipInRanges(request.clientIp, list.skipIpRanges)) return 'allow';
  if (!presented) return withoutIdentity(list);

  // A cookie the list cannot use is as good as none; a presented token or Basic header is the visitor's answer.
  const fromCookie = presented.source === 'cookie';
  if (!accessIdentityUsable(list, presented.identity)) return fromCookie ? withoutIdentity(list) : 'deny';
  if (accessIdentityAdmitted(list, presented.identity, request.clientIp)) return 'allow';
  // The sign-in page tells a signed-in visitor they have no access.
  return fromCookie ? 'redirect' : 'deny';
}
