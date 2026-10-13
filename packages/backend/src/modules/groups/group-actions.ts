import { container } from '@/container.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { hasScope, hasScopeForCreation, privilegeBoundaryScopes } from '@/lib/permissions.js';
import { canonicalizeInboundScopes } from '@/lib/scopes.js';
import { dockerTargetIdIssue } from '@/lib/scopes-schemas.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { resolveGitScopePathQualifiers } from '@/modules/integrations/git-scope-paths.js';
import type { CreateGroupInput, UpdateGroupInput } from './group.schemas.js';
import { GroupService } from './group.service.js';
import { PermissionGroupFolderService } from './permission-group-folders.service.js';

/**
 * Permission group administration shared by /api/admin/groups and the AI/MCP
 * tools, so both apply the same resource grants, privilege checks and audit.
 */
export interface GroupActor {
  id: string;
  /** Effective scopes of the request (bounded for programmatic callers). */
  scopes: string[];
  /** Live account scopes behind a programmatic caller; only account-only scopes are taken from them. */
  accountScopes?: string[];
  userAgent?: string;
}

export interface GroupActionServices {
  groupService?: GroupService;
  auditService?: AuditService;
}

function groupServiceOf(services: GroupActionServices): GroupService {
  return services.groupService ?? container.resolve(GroupService);
}

function auditServiceOf(services: GroupActionServices): AuditService {
  return services.auditService ?? container.resolve(AuditService);
}

/** Mirrors requireScopeForResource('admin:groups', 'id'). */
export function assertGroupScope(scopes: string[], groupId: string): void {
  const requiredScope = `admin:groups:${groupId}`;
  if (!hasScope(scopes, requiredScope)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${requiredScope}`);
  }
}

export async function listVisibleGroups(scopes: string[], services: GroupActionServices = {}) {
  const groups = await groupServiceOf(services).listGroups();
  return groups.filter((group) => hasScope(scopes, `admin:groups:${group.id}`));
}

export async function getGroupForActor(actor: GroupActor, groupId: string, services: GroupActionServices = {}) {
  assertGroupScope(actor.scopes, groupId);
  return groupServiceOf(services).getGroup(groupId);
}

/**
 * Resolve Git path qualifiers to stable IDs as the actor and rewrite retired names; a non-empty request whose
 * scopes were all removed is an error, not an empty group.
 */
async function inboundGroupScopes(actor: GroupActor, requested: readonly string[]): Promise<string[]> {
  const resolved = await resolveGitScopePathQualifiers(
    { id: actor.id, scopes: actor.scopes, accountScopes: actor.accountScopes },
    requested
  );
  const scopes = canonicalizeInboundScopes(resolved);
  if (requested.length > 0 && scopes.length === 0) {
    throw new AppError(400, 'INVALID_SCOPE', 'None of the requested scopes exist any more');
  }
  return scopes;
}

/**
 * A group save sends back every scope the group holds. A Docker target the group already holds that names
 * its resource by name (accepted before targets were checked) grants nothing and is dropped; a new one is
 * rejected.
 */
async function dropStaleDockerTargets(requested: readonly string[], stored: readonly string[]): Promise<string[]> {
  const storedSet = new Set(stored);
  const kept: string[] = [];
  for (const scope of requested) {
    const issue = dockerTargetIdIssue(scope);
    if (!issue) kept.push(scope);
    else if (!storedSet.has(scope)) throw new AppError(400, 'INVALID_SCOPE', `${issue}: ${scope}`);
  }
  return kept;
}

export async function createGroupForActor(
  actor: GroupActor,
  parsedInput: CreateGroupInput,
  services: GroupActionServices = {}
) {
  const groupService = groupServiceOf(services);
  const input = { ...parsedInput, scopes: await inboundGroupScopes(actor, parsedInput.scopes) };
  if (!hasScopeForCreation(actor.scopes, 'admin:groups', input.folderId))
    throw new AppError(403, 'FORBIDDEN', 'Select an authorized destination group folder');
  if (input.folderId) await container.resolve(PermissionGroupFolderService).assertFolderExists(input.folderId);
  await groupService.assertCanCreateGroup(input, privilegeBoundaryScopes(actor.scopes, actor.accountScopes, 'grant'));

  const group = await groupService.createGroup(input);
  await grantCreatedResourcePermissions(actor.id, 'admin:groups', group.id);

  await auditServiceOf(services).log({
    userId: actor.id,
    action: 'group.create',
    resourceType: 'permission_group',
    resourceId: group.id,
    details: { name: group.name, scopes: input.scopes },
    userAgent: actor.userAgent,
  });
  return group;
}

export async function updateGroupForActor(
  actor: GroupActor,
  groupId: string,
  parsedInput: UpdateGroupInput,
  services: GroupActionServices = {}
) {
  assertGroupScope(actor.scopes, groupId);
  const groupService = groupServiceOf(services);
  const requestedScopes =
    parsedInput.scopes === undefined
      ? undefined
      : await dropStaleDockerTargets(parsedInput.scopes, (await groupService.getGroup(groupId)).scopes);
  const input = {
    ...parsedInput,
    ...(requestedScopes !== undefined && { scopes: await inboundGroupScopes(actor, requestedScopes) }),
  };
  await groupService.assertCanUpdateGroup(
    groupId,
    input,
    privilegeBoundaryScopes(actor.scopes, actor.accountScopes, 'grant')
  );

  const group = await groupService.updateGroup(groupId, input);

  await auditServiceOf(services).log({
    userId: actor.id,
    action: 'group.update',
    resourceType: 'permission_group',
    resourceId: groupId,
    details: { changes: input },
    userAgent: actor.userAgent,
  });
  return group;
}

export async function deleteGroupForActor(actor: GroupActor, groupId: string, services: GroupActionServices = {}) {
  assertGroupScope(actor.scopes, groupId);
  const groupService = groupServiceOf(services);
  await groupService.assertCanDeleteGroup(groupId, privilegeBoundaryScopes(actor.scopes, actor.accountScopes));

  // getGroup throws 404 if not found, and deleteGroup throws if built-in or has members
  const group = await groupService.getGroup(groupId);
  await groupService.deleteGroup(groupId);

  await auditServiceOf(services).log({
    userId: actor.id,
    action: 'group.delete',
    resourceType: 'permission_group',
    resourceId: groupId,
    details: { name: group.name },
    userAgent: actor.userAgent,
  });
}
