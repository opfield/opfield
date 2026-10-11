import type { AuditService } from '@/modules/audit/audit.service.js';
import { APP_VIEW_SCOPE, hasAppWideScope, visibleEnvironmentIds } from './app-access.js';
import { memberTagId } from './app-audit-tagger.js';
import type { AppMembersReader } from './app-members.service.js';
import type { AppsService } from './apps.service.js';

/**
 * App activity: audit rows tagged with the app when they were written, newest first, in the audit log row shape.
 * A caller sees rows of the environments it may view (and app-wide rows) and, unless it may view every member, only
 * rows about members it may view.
 */
export class AppActivityService {
  constructor(
    private readonly apps: AppsService,
    private readonly members: AppMembersReader,
    private readonly audit: AuditService
  ) {}

  async list(scopes: readonly string[], appId: string, query: { page: number; limit: number; environmentId?: string }) {
    const { app, envs } = await this.apps.resolveVisible(scopes, appId);
    const allEnvIds = envs.map((env) => env.id);
    let envIds = visibleEnvironmentIds(scopes, app.id, allEnvIds);
    if (query.environmentId) envIds = envIds.filter((id) => id === query.environmentId);
    const all = await this.members.listMembers(envIds);
    const visible = await this.members.listVisibleMembers(scopes, envIds);
    // Rows about members leave the filter only when the caller views every member of these environments.
    const memberIds = visible.length === all.length ? undefined : visible.map(memberTagId);
    const appWide = hasAppWideScope(scopes, APP_VIEW_SCOPE, app.id) && !query.environmentId;
    const result = await this.audit.getAuditLog({
      page: query.page,
      limit: query.limit,
      appId: app.id,
      appEnvironmentIds: appWide && envIds.length === allEnvIds.length ? undefined : envIds,
      appMemberIds: memberIds,
    });
    return {
      data: result.data,
      total: result.pagination.total,
      page: result.pagination.page,
      limit: result.pagination.limit,
    };
  }
}
