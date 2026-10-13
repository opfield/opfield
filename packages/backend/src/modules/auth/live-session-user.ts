import { eq, or, sql } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { users } from '@/db/schema/index.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { canManageUser, hasScope } from '@/lib/permissions.js';
import { canonicalizeScopes } from '@/lib/scopes.js';
import { hasTokenPrefix } from '@/lib/token-prefixes.js';
import { SessionService } from '@/services/session.service.js';
import type { SessionData, User } from '@/types.js';

export interface GroupScopeRecord {
  id: string;
  parentId: string | null;
  scopes: unknown;
  name?: string | null;
  require2fa?: boolean;
}

export function userGroupIds(groupId: string, additionalGroupIds: readonly string[] = []): string[] {
  return [...new Set([groupId, ...additionalGroupIds])];
}

export function userBelongsToGroup(groupId: string) {
  return or(eq(users.groupId, groupId), sql`${groupId}::uuid = ANY(${users.additionalGroupIds})`);
}

export function groupsRequireMfa(groupIds: readonly string[], groupMap: Map<string, GroupScopeRecord>): boolean {
  return groupIds.some((id) => groupMap.get(id)?.require2fa === true);
}

export function computeEffectiveGroupAccess(groupId: string, groupMap: Map<string, GroupScopeRecord>) {
  const group = groupMap.get(groupId);
  const scopeSet = new Set<string>();

  if (group) {
    for (const scope of (group.scopes as string[]) ?? []) scopeSet.add(scope);

    const visited = new Set<string>([group.id]);
    let parent = group.parentId ? groupMap.get(group.parentId) : undefined;
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      for (const scope of (parent.scopes as string[]) ?? []) scopeSet.add(scope);
      parent = parent.parentId ? groupMap.get(parent.parentId) : undefined;
    }
  }

  return {
    groupName: group?.name ?? 'unknown',
    scopes: canonicalizeScopes([...scopeSet]),
  };
}

export function computeEffectiveUserAccess(
  groupId: string,
  groupMap: Map<string, GroupScopeRecord>,
  additionalScopes: unknown,
  additionalGroupIds: readonly string[] = []
) {
  const groupIds = userGroupIds(groupId, additionalGroupIds);
  const groupNames = groupIds.map((id) => groupMap.get(id)?.name ?? 'unknown');
  const groupScopes = canonicalizeScopes(groupIds.flatMap((id) => computeEffectiveGroupAccess(id, groupMap).scopes));
  const normalizedAdditionalScopes = canonicalizeScopes(
    Array.isArray(additionalScopes)
      ? additionalScopes.filter((scope): scope is string => typeof scope === 'string')
      : []
  );

  return {
    groupName: groupNames[0],
    groupIds,
    groupNames,
    require2fa: groupsRequireMfa(groupIds, groupMap),
    groupScopes,
    additionalScopes: normalizedAdditionalScopes,
    scopes: canonicalizeScopes([...groupScopes, ...normalizedAdditionalScopes]),
  };
}

export async function fetchGroupScopeMap(db: DrizzleClient): Promise<Map<string, GroupScopeRecord>> {
  const allGroups = await db.query.permissionGroups.findMany({
    columns: { id: true, parentId: true, scopes: true, name: true, require2fa: true },
  });
  return new Map(allGroups.map((group) => [group.id, group]));
}

export async function resolveEffectiveGroupAccess(db: DrizzleClient, groupId: string) {
  const groupMap = await fetchGroupScopeMap(db);
  return computeEffectiveGroupAccess(groupId, groupMap);
}

export async function resolveEffectiveUserAccess(
  db: DrizzleClient,
  groupId: string,
  additionalScopes: unknown,
  additionalGroupIds: readonly string[] = []
) {
  const groupMap = await fetchGroupScopeMap(db);
  return computeEffectiveUserAccess(groupId, groupMap, additionalScopes, additionalGroupIds);
}

export async function resolveLiveUser(db: DrizzleClient, userId: string): Promise<User | null> {
  const dbUser = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!dbUser) return null;

  const groupMap = await fetchGroupScopeMap(db);
  const { groupName, groupNames, groupIds, require2fa, groupScopes, additionalScopes, scopes } =
    computeEffectiveUserAccess(dbUser.groupId, groupMap, dbUser.additionalScopes, dbUser.additionalGroupIds);
  const effectiveScopes = dbUser.deletedAt ? [] : await expandFolderScopes(db, scopes);
  return {
    id: dbUser.id,
    oidcSubject: dbUser.oidcSubject,
    authMethod: dbUser.authMethod,
    email: dbUser.email,
    name: dbUser.name,
    avatarUrl: dbUser.avatarUrl,
    groupId: dbUser.groupId,
    groupName,
    groupNames,
    groupIds,
    require2fa,
    groupScopes,
    additionalScopes,
    scopes: effectiveScopes,
    isBlocked: dbUser.isBlocked || Boolean(dbUser.deletedAt),
    blockedBy: dbUser.isBlocked ? (dbUser.blockedBy ?? 'admin') : null,
    isDeleted: Boolean(dbUser.deletedAt),
    aiApprovalMode: dbUser.aiApprovalMode,
  };
}

export interface LiveSessionUser {
  user: User;
  effectiveScopes: string[];
  session: SessionData;
  impersonation?: {
    actor: User;
    subject: User;
    authorized: boolean;
  };
}

export function requiresSessionMfaReauthentication(user: User, session: SessionData): boolean {
  if (!user.require2fa || user.authMethod === 'oidc' || session.mfaSatisfiedAt !== undefined) {
    return false;
  }

  const mfaGraceExpiresAt = session.mfaGraceExpiresAt;
  return !(
    typeof mfaGraceExpiresAt === 'number' &&
    Number.isFinite(mfaGraceExpiresAt) &&
    mfaGraceExpiresAt > Date.now()
  );
}

export async function resolveLiveSessionUser(
  token: string,
  knownSession?: SessionData
): Promise<LiveSessionUser | null> {
  if (!token || hasTokenPrefix(token, 'api')) return null;

  const sessionService = container.resolve(SessionService);
  const session = knownSession ?? (await sessionService.getSession(token));
  if (!session) return null;

  const sessionUserId = session.userId ?? session.user?.id;
  if (!sessionUserId) return null;

  const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
  const user = await resolveLiveUser(db, sessionUserId);
  if (!user) return null;

  if (session.purpose === 'impersonation') {
    const original = await sessionService.getOriginalSessionForImpersonation(session);
    if (!original || !session.impersonation) return null;

    const actor = await resolveLiveUser(db, session.impersonation.actorUserId);
    if (!actor || actor.isBlocked || actor.isDeleted || requiresSessionMfaReauthentication(actor, original.session)) {
      return null;
    }

    const authorized = hasScope(actor.scopes, 'admin:users:impersonate') && !canManageUser(actor.scopes, user.scopes);

    return {
      user,
      effectiveScopes: authorized ? user.scopes : [],
      session,
      impersonation: { actor, subject: user, authorized },
    };
  }

  return { user, effectiveScopes: user.scopes, session };
}
