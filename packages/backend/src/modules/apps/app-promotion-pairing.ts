import type { AppMember } from './app-members.service.js';

export type PromotableType = 'container' | 'deployment' | 'compose' | 'pages';
export const PROMOTABLE_TYPES: readonly PromotableType[] = ['container', 'deployment', 'compose', 'pages'];

export interface PromotionEnvironmentNames {
  slug: string;
  name: string;
}

export interface PromotionPair {
  pairKey: string;
  type: PromotableType;
  source: AppMember;
  target: AppMember;
}

export interface UnpairedMember {
  type: PromotableType;
  id: string;
  name: string;
  reason: 'not_in_target' | 'type_differs' | 'ambiguous';
}

/** The name with a trailing `-<environment slug>` (or `-<environment name>`) removed, lowercased. */
export function pairingName(name: string, environment: PromotionEnvironmentNames): string {
  const lower = name.trim().toLowerCase();
  for (const suffix of new Set([environment.slug.toLowerCase(), environment.name.trim().toLowerCase()])) {
    if (suffix && lower.endsWith(`-${suffix}`) && lower.length > suffix.length + 1) {
      return lower.slice(0, -(suffix.length + 1));
    }
  }
  return lower;
}

export function pairKeyOf(type: PromotableType, sourceId: string, targetId: string, targetNodeId?: string | null) {
  return `${type}:${sourceId}->${targetNodeId ? `${targetNodeId}/` : ''}${targetId}`;
}

/**
 * Automatic pairing (owner decision Q5 a): a source member pairs with the target member of the same type whose name
 * is the same, or the same once a trailing `-<environment>` is removed on either side (`shop-help-staging` in staging
 * pairs with `shop-help` in production). A source member without a counterpart is listed as "not in <target>"; a name
 * that matches a member of another type is listed as such; two candidates for one name pair with neither.
 */
export function pairMembers(
  sourceMembers: readonly AppMember[],
  targetMembers: readonly AppMember[],
  sourceEnvironment: PromotionEnvironmentNames,
  targetEnvironment: PromotionEnvironmentNames
): { pairs: PromotionPair[]; unpaired: UnpairedMember[] } {
  const pairs: PromotionPair[] = [];
  const unpaired: UnpairedMember[] = [];
  const promotable = (member: AppMember): member is AppMember & { type: PromotableType } =>
    (PROMOTABLE_TYPES as readonly string[]).includes(member.type);
  const targetsByName = new Map<string, AppMember[]>();
  for (const member of targetMembers.filter(promotable)) {
    const key = pairingName(member.name, targetEnvironment);
    targetsByName.set(key, [...(targetsByName.get(key) ?? []), member]);
  }
  for (const source of sourceMembers.filter(promotable)) {
    const key = pairingName(source.name, sourceEnvironment);
    const candidates = targetsByName.get(key) ?? [];
    const sameType = candidates.filter((candidate) => candidate.type === source.type);
    if (sameType.length === 1) {
      const target = sameType[0]!;
      pairs.push({
        pairKey: pairKeyOf(source.type, source.id, target.id, target.type === 'container' ? target.nodeId : null),
        type: source.type,
        source,
        target,
      });
      continue;
    }
    unpaired.push({
      type: source.type,
      id: source.id,
      name: source.name,
      reason: sameType.length > 1 ? 'ambiguous' : candidates.length > 0 ? 'type_differs' : 'not_in_target',
    });
  }
  return { pairs, unpaired };
}
