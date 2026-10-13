import { and, count, eq, isNull, or, sql } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { permissionGroups, users } from '@/db/schema/index.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope, isScopeSubset } from '@/lib/permissions.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { canonicalizeScopes, withoutRetiredScopes } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AISandboxService } from '@/modules/ai/ai.sandbox.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import {
  computeEffectiveGroupAccess,
  computeEffectiveUserAccess,
  fetchGroupScopeMap,
  userBelongsToGroup,
} from '@/modules/auth/live-session-user.js';
import { mfaRequiredChannel } from '@/modules/auth/mfa-events.js';
import { type LicenseQuotaService, requireConfiguredLicenseQuota } from '@/modules/license/license-quota.service.js';
import { SessionService } from '@/services/session.service.js';
import type { CreateGroupInput, UpdateGroupInput } from './group.schemas.js';
import { assertGroupParent } from './group-inheritance.js';

const logger = createChildLogger('GroupService');
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

interface DirectGroupMember {
  id: string;
  authMethod: string;
  otherGroupRequiresMfa?: boolean;
}

function disallowedScopes(effectiveScopes: string[], actorScopes: string[]) {
  return effectiveScopes.filter((scope) => !hasScope(actorScopes, scope));
}

function assertNoProtectedSystemScope(effectiveScopes: string[]) {
  if (effectiveScopes.includes('admin:system')) {
    throw new AppError(403, 'SCOPE_NOT_ALLOWED', 'admin:system cannot be assigned to custom groups');
  }
}

@injectable()
export class GroupService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    @inject(SessionService) private readonly sessionService: SessionService,
    @inject(AuthSettingsService) private readonly authSettingsService: AuthSettingsService
  ) {}

  private eventBus?: import('@/services/event-bus.service.js').EventBusService;
  private sandboxService?: AISandboxService;
  private licenseQuota?: LicenseQuotaService;
  setEventBus(bus: import('@/services/event-bus.service.js').EventBusService) {
    this.eventBus = bus;
  }
  setSandboxService(service: AISandboxService) {
    this.sandboxService = service;
  }
  setLicenseQuotaService(service: LicenseQuotaService) {
    this.licenseQuota = service;
  }
  private emitGroup(id: string, action: 'created' | 'updated' | 'deleted') {
    this.eventBus?.publish('group.changed', { id, action });
  }

  private collectDescendantGroupIds(
    groupId: string,
    groupMap: Map<string, { id: string; parentId: string | null }>
  ): string[] {
    const descendants: string[] = [];
    const queue = [groupId];
    const visited = new Set([groupId]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const group of groupMap.values()) {
        if (group.parentId !== current || visited.has(group.id)) continue;
        visited.add(group.id);
        descendants.push(group.id);
        queue.push(group.id);
      }
    }

    return descendants;
  }

  /** Cascade a permissions change to every user in the affected group tree. */
  private async cascadePermissions(groupId: string) {
    const groupMap = await fetchGroupScopeMap(this.db);
    const affectedGroupIds = [groupId, ...this.collectDescendantGroupIds(groupId, groupMap)];

    const affected = await this.db
      .select({
        id: users.id,
        groupId: users.groupId,
        additionalGroupIds: users.additionalGroupIds,
        additionalScopes: users.additionalScopes,
        isBlocked: users.isBlocked,
      })
      .from(users)
      .where(and(or(...affectedGroupIds.map(userBelongsToGroup)), isNull(users.deletedAt)));

    for (const u of affected) {
      const scopes = u.isBlocked
        ? []
        : await expandFolderScopes(
            this.db,
            computeEffectiveUserAccess(u.groupId, groupMap, u.additionalScopes, u.additionalGroupIds).scopes
          );
      this.eventBus?.publish(`permissions.changed.${u.id}`, { scopes, groupId: u.groupId });
      await this.sandboxService?.revokeUserAccess(u.id, scopes, 'permissions_changed').catch((error) => {
        logger.warn('Failed to revoke sandbox jobs after group permission cascade', { userId: u.id, groupId, error });
      });
    }
  }

  /** Refresh dashboards and member sessions after a group's stored scopes changed outside this service. */
  async announceScopesChanged(groupIds: readonly string[]): Promise<void> {
    for (const groupId of new Set(groupIds)) {
      this.emitGroup(groupId, 'updated');
      await this.cascadePermissions(groupId);
    }
  }

  /** Notify every direct local member so active dashboards refresh MFA policy state. */
  private async notifyMfaPolicyChanged(
    groupId: string,
    groupName: string,
    require2fa: boolean,
    members: DirectGroupMember[]
  ): Promise<{ memberCount: number }> {
    const localMembers = members.filter((member) => member.authMethod !== 'oidc');
    if (localMembers.length === 0) return { memberCount: members.length };

    for (const member of localMembers) {
      this.eventBus?.publish(mfaRequiredChannel(member.id), {
        groupId,
        groupName,
        require2fa: require2fa || Boolean(member.otherGroupRequiresMfa),
      });
    }
    return { memberCount: members.length };
  }

  private async getDirectGroupMembers(groupId: string): Promise<DirectGroupMember[]> {
    return this.db
      .select({
        id: users.id,
        authMethod: users.authMethod,
        otherGroupRequiresMfa: sql<boolean>`EXISTS (SELECT 1 FROM permission_groups g WHERE g.id <> ${groupId}::uuid AND g.require_2fa AND (g.id = ${users.groupId} OR g.id = ANY(${users.additionalGroupIds})))`,
      })
      .from(users)
      .where(and(userBelongsToGroup(groupId), isNull(users.deletedAt)));
  }

  private async updateMfaSessionGraceDeadlines(members: DirectGroupMember[], require2fa: boolean): Promise<void> {
    const localUserIds = members
      .filter((member) => member.authMethod !== 'oidc' && !member.otherGroupRequiresMfa)
      .map((member) => member.id);
    if (localUserIds.length === 0) return;

    if (require2fa) {
      const { mfaExistingSessionGracePeriodDays } = await this.authSettingsService.getConfig();
      const gracePeriodDays =
        Number.isInteger(mfaExistingSessionGracePeriodDays) &&
        mfaExistingSessionGracePeriodDays >= 0 &&
        mfaExistingSessionGracePeriodDays <= 7
          ? mfaExistingSessionGracePeriodDays
          : 0;
      const mfaGraceExpiresAt = Date.now() + gracePeriodDays * MILLISECONDS_PER_DAY;
      await Promise.all(
        localUserIds.map((userId) => this.sessionService.setUserSessionsMfaGraceExpiresAt(userId, mfaGraceExpiresAt))
      );
      return;
    }

    await Promise.all(localUserIds.map((userId) => this.sessionService.clearUserSessionsMfaGraceExpiresAt(userId)));
  }

  async getEffectiveScopesForGroupId(groupId: string): Promise<string[]> {
    const groupMap = await fetchGroupScopeMap(this.db);
    return computeEffectiveGroupAccess(groupId, groupMap).scopes;
  }

  async buildEffectiveScopes(scopes: string[], parentId: string | null | undefined): Promise<string[]> {
    const directScopes = canonicalizeScopes(scopes);
    if (!parentId) return directScopes;

    const parentScopes = await this.getEffectiveScopesForGroupId(parentId);
    return canonicalizeScopes([...directScopes, ...parentScopes]);
  }

  async assertCanCreateGroup(input: CreateGroupInput, actorScopes: string[]): Promise<void> {
    const effectiveScopes = await this.buildEffectiveScopes(input.scopes, input.parentId);
    assertNoProtectedSystemScope(effectiveScopes);
    if (!isScopeSubset(effectiveScopes, actorScopes)) {
      throw new AppError(
        403,
        'SCOPE_NOT_ALLOWED',
        `Cannot grant scopes you do not possess: ${disallowedScopes(effectiveScopes, actorScopes).join(', ')}`
      );
    }
  }

  async assertCanUpdateGroup(id: string, input: UpdateGroupInput, actorScopes: string[]): Promise<void> {
    const existingGroup = await this.getGroup(id);
    if (existingGroup.isBuiltin) {
      const nonSecurityChanges =
        input.name !== undefined ||
        input.description !== undefined ||
        input.scopes !== undefined ||
        input.parentId !== undefined;
      if (nonSecurityChanges || input.require2fa === undefined || !actorScopes.includes('admin:system')) {
        throw new AppError(
          403,
          'BUILTIN_GROUP',
          'Only system administrators can update MFA policy on a built-in group'
        );
      }
      return;
    }

    if (input.scopes !== undefined || input.parentId !== undefined || input.require2fa !== undefined) {
      const groupMap = await fetchGroupScopeMap(this.db);
      const affected = [id, ...this.collectDescendantGroupIds(id, groupMap)];
      if (affected.some((groupId) => !hasScope(actorScopes, `admin:groups:${groupId}`)))
        throw new AppError(403, 'GROUP_ACCESS_DENIED', 'You must have access to every affected group');
      const currentScopes = affected.flatMap((groupId) => computeEffectiveGroupAccess(groupId, groupMap).scopes);
      if (!isScopeSubset(currentScopes, actorScopes))
        throw new AppError(403, 'SCOPE_NOT_ALLOWED', 'Cannot change groups with permissions you do not possess');
    }

    if (input.scopes === undefined && input.parentId === undefined) return;

    const nextScopes = input.scopes ?? existingGroup.scopes;
    const nextParentId = input.parentId !== undefined ? input.parentId : existingGroup.parentId;
    const effectiveScopes = await this.buildEffectiveScopes(nextScopes, nextParentId);
    assertNoProtectedSystemScope(effectiveScopes);

    if (!isScopeSubset(effectiveScopes, actorScopes)) {
      throw new AppError(
        403,
        'SCOPE_NOT_ALLOWED',
        `Cannot grant scopes you do not possess: ${disallowedScopes(effectiveScopes, actorScopes).join(', ')}`
      );
    }
  }

  async assertCanDeleteGroup(id: string, actorScopes: string[]): Promise<void> {
    const groupMap = await fetchGroupScopeMap(this.db);
    if (!groupMap.has(id)) {
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Permission group not found');
    }

    const affectedGroupIds = [id, ...this.collectDescendantGroupIds(id, groupMap)];
    if (affectedGroupIds.some((groupId) => !hasScope(actorScopes, `admin:groups:${groupId}`))) {
      throw new AppError(403, 'GROUP_ACCESS_DENIED', 'You must have access to every affected group');
    }
    const affectedScopes = [
      ...new Set(affectedGroupIds.flatMap((groupId) => computeEffectiveGroupAccess(groupId, groupMap).scopes)),
    ];

    if (!isScopeSubset(affectedScopes, actorScopes)) {
      throw new AppError(
        403,
        'SCOPE_NOT_ALLOWED',
        `Cannot delete a group that affects scopes you do not possess: ${disallowedScopes(affectedScopes, actorScopes).join(', ')}`
      );
    }
  }

  async listGroups() {
    const groups = await this.db
      .select({
        id: permissionGroups.id,
        name: permissionGroups.name,
        description: permissionGroups.description,
        isBuiltin: permissionGroups.isBuiltin,
        parentId: permissionGroups.parentId,
        folderId: permissionGroups.folderId,
        sortOrder: permissionGroups.sortOrder,
        scopes: permissionGroups.scopes,
        require2fa: permissionGroups.require2fa,
        createdAt: permissionGroups.createdAt,
        updatedAt: permissionGroups.updatedAt,
        memberCount: sql<number>`(SELECT count(*) FROM users WHERE (users.group_id = "permission_groups"."id" OR "permission_groups"."id" = ANY(users.additional_group_ids)) AND users.deleted_at IS NULL)::int`,
      })
      .from(permissionGroups)
      .orderBy(
        sql`${permissionGroups.isBuiltin} DESC`,
        sql`${permissionGroups.sortOrder} ASC`,
        sql`jsonb_array_length(${permissionGroups.scopes}) DESC`
      );

    // Build a map for inherited scope computation
    const groupMap = new Map(groups.map((g) => [g.id, g]));

    return groups.map((g) => ({
      ...g,
      scopes: withoutRetiredScopes(g.scopes),
      inheritedScopes: this.computeInheritedScopes(g.id, groupMap),
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    }));
  }

  async getGroup(id: string) {
    const group = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.id, id),
    });

    if (!group) {
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Permission group not found');
    }

    const [{ count: memberCount }] = await this.db
      .select({ count: count() })
      .from(users)
      .where(and(userBelongsToGroup(id), isNull(users.deletedAt)));

    // Fetch all groups for inherited scope computation
    const allGroups = await this.db.select().from(permissionGroups);
    const groupMap = new Map(allGroups.map((g) => [g.id, g]));

    return {
      ...group,
      scopes: withoutRetiredScopes(group.scopes),
      memberCount: Number(memberCount),
      inheritedScopes: this.computeInheritedScopes(group.id, groupMap),
      createdAt: group.createdAt.toISOString(),
      updatedAt: group.updatedAt.toISOString(),
    };
  }

  async getGroupByName(name: string) {
    return this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.name, name),
    });
  }

  async createGroup(input: CreateGroupInput) {
    const scopes = canonicalizeScopes(input.scopes);
    const existing = await this.getGroupByName(input.name);
    if (existing) {
      throw new AppError(409, 'GROUP_EXISTS', `Group "${input.name}" already exists`);
    }

    if (input.parentId) {
      assertGroupParent(await this.db.select().from(permissionGroups), '__new__', input.parentId);
    }

    const createGroup = async (executor: DrizzleExecutor) => {
      const [group] = await executor
        .insert(permissionGroups)
        .values({
          name: input.name,
          description: input.description ?? null,
          isBuiltin: false,
          parentId: input.parentId ?? null,
          folderId: input.folderId ?? null,
          scopes,
          require2fa: input.require2fa ?? false,
        })
        .returning();
      return group;
    };
    const group = await requireConfiguredLicenseQuota(this.licenseQuota).run(
      'customPermissionGroups',
      async (tx) => {
        const [result] = await tx
          .select({ count: count() })
          .from(permissionGroups)
          .where(eq(permissionGroups.isBuiltin, false));
        return Number(result?.count ?? 0);
      },
      createGroup
    );

    logger.info('Created permission group', { groupId: group.id, name: group.name, parentId: group.parentId });
    this.emitGroup(group.id, 'created');
    if (group.require2fa) {
      this.eventBus?.publish('group.mfa.required', {
        groupId: group.id,
        groupName: group.name,
        require2fa: true,
        memberCount: 0,
      });
    }

    return {
      ...group,
      inheritedScopes: input.parentId ? await this.getEffectiveScopesForGroupId(input.parentId) : [],
      memberCount: 0,
      createdAt: group.createdAt.toISOString(),
      updatedAt: group.updatedAt.toISOString(),
    };
  }

  async updateGroup(id: string, input: UpdateGroupInput) {
    const group = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.id, id),
    });

    if (!group) {
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Permission group not found');
    }

    const builtinMfaOnly =
      group.isBuiltin &&
      input.require2fa !== undefined &&
      input.name === undefined &&
      input.description === undefined &&
      input.scopes === undefined &&
      input.parentId === undefined;
    if (group.isBuiltin && !builtinMfaOnly) {
      throw new AppError(403, 'BUILTIN_GROUP', 'Cannot modify a built-in group');
    }

    if (input.name) {
      const existing = await this.getGroupByName(input.name);
      if (existing && existing.id !== id) {
        throw new AppError(409, 'GROUP_EXISTS', `Group "${input.name}" already exists`);
      }
    }

    // Validate parentId doesn't create a cycle or exceed nesting depth
    if (input.parentId !== undefined) {
      if (input.parentId === id) {
        throw new AppError(400, 'CYCLE_DETECTED', 'A group cannot be its own parent');
      }
      if (input.parentId) {
        const allGroups = await this.db.select().from(permissionGroups);
        assertGroupParent(allGroups, id, input.parentId);
      }
    }

    const nextMfaPolicy = input.require2fa;
    const mfaPolicyChanged = nextMfaPolicy !== undefined && nextMfaPolicy !== group.require2fa;
    const mfaMembers = mfaPolicyChanged ? await this.getDirectGroupMembers(id) : [];
    if (mfaPolicyChanged && nextMfaPolicy !== undefined) {
      await this.updateMfaSessionGraceDeadlines(mfaMembers, nextMfaPolicy);
    }

    const [updated] = await this.db
      .update(permissionGroups)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.scopes !== undefined && { scopes: canonicalizeScopes(input.scopes) }),
        ...(input.parentId !== undefined && { parentId: input.parentId }),
        ...(input.require2fa !== undefined && { require2fa: input.require2fa }),
        updatedAt: new Date(),
      })
      .where(eq(permissionGroups.id, id))
      .returning();

    logger.info('Updated permission group', { groupId: id, name: updated.name });
    this.emitGroup(id, 'updated');
    if (mfaPolicyChanged && nextMfaPolicy !== undefined) {
      const { memberCount } = await this.notifyMfaPolicyChanged(updated.id, updated.name, nextMfaPolicy, mfaMembers);
      this.eventBus?.publish('group.mfa.required', {
        groupId: updated.id,
        groupName: updated.name,
        require2fa: nextMfaPolicy,
        memberCount,
      });
    }
    if (input.scopes !== undefined || input.parentId !== undefined) {
      await this.cascadePermissions(id);
    }

    return {
      ...updated,
      scopes: withoutRetiredScopes(updated.scopes),
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  async deleteGroup(id: string) {
    const group = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.id, id),
    });

    if (!group) {
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Permission group not found');
    }

    if (group.isBuiltin) {
      throw new AppError(403, 'BUILTIN_GROUP', 'Cannot delete a built-in group');
    }

    const childGroupIds = await transactionWithScopeCleanup(this.db, async (tx) => {
      // Serialize deletion with primary and secondary membership assignment.
      await tx
        .select({ id: permissionGroups.id })
        .from(permissionGroups)
        .where(eq(permissionGroups.id, id))
        .for('update');
      const [{ count: memberCount }] = await tx
        .select({ count: count() })
        .from(users)
        .where(and(userBelongsToGroup(id), isNull(users.deletedAt)));
      if (Number(memberCount) > 0)
        throw new AppError(
          409,
          'GROUP_HAS_MEMBERS',
          `Cannot delete group with ${memberCount} assigned user(s). Reassign them first.`
        );
      const children = await tx
        .select({ id: permissionGroups.id })
        .from(permissionGroups)
        .where(eq(permissionGroups.parentId, id));
      await tx.update(permissionGroups).set({ parentId: null }).where(eq(permissionGroups.parentId, id));
      await tx.delete(permissionGroups).where(eq(permissionGroups.id, id));
      return children.map((child) => child.id);
    });
    logger.info('Deleted permission group', { groupId: id, name: group.name });
    this.emitGroup(id, 'deleted');

    for (const childGroupId of childGroupIds) {
      await this.cascadePermissions(childGroupId);
    }
  }

  async getMemberIds(groupId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(userBelongsToGroup(groupId), isNull(users.deletedAt)));
    return rows.map((r) => r.id);
  }

  /**
   * Compute inherited scopes by walking the parent chain.
   * Returns scopes from all ancestors (deduped), NOT including the group's own scopes.
   */
  private computeInheritedScopes(
    groupId: string,
    groupMap: Map<string, { id: string; parentId: string | null; scopes: unknown }>
  ): string[] {
    const inherited = new Set<string>();
    const group = groupMap.get(groupId);
    if (!group) return [];

    let current = group.parentId ? groupMap.get(group.parentId) : null;
    const visited = new Set<string>([groupId]);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const parentScopes = withoutRetiredScopes((current.scopes as string[]) ?? []);
      for (const s of parentScopes) inherited.add(s);
      current = current.parentId ? groupMap.get(current.parentId) : null;
    }

    return [...inherited];
  }
}
