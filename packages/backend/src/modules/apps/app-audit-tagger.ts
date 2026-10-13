import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { appEnvironments, managedDatabaseInstances, managedStorageClusters } from '@/db/schema/index.js';
import type { AuditEntry } from '@/modules/audit/audit.service.js';
import { type AppFamily, type AppMemberType, familyOfMemberType } from './app-families.js';
import type { AppFolderService } from './app-folders.service.js';
import type { AppMemberKey, AppMembershipService } from './app-membership.js';

/** App columns written with an audit row. */
export interface AppAuditTag {
  appId: string;
  appEnvironmentId: string | null;
  appMemberType: AppMemberType | null;
  appMemberId: string | null;
}

const CACHE_TTL_MS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id an audit row records for a member: containers `<nodeId>:<name>`, every other type its id. */
export function memberTagId(member: { type: AppMemberType; id: string; nodeId?: string | null }): string {
  return member.type === 'container' ? `${member.nodeId ?? ''}:${member.id}` : member.id;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Tags audit rows with the app, environment and member they concern, when they are written: a container's audit id
 * changes on recreate, so matching rows to members later is unreliable. History starts when a resource joins an app.
 * Covers app rows, membership moves and the audit resource types of the member families; other rows stay
 * untagged. Lookups are cached for 10 s and dropped on every app change.
 */
export class AppAuditTagger {
  private cache = new Map<string, { at: number; tag: AppAuditTag | null }>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly folders: AppFolderService,
    private readonly membership: AppMembershipService
  ) {}

  invalidate(): void {
    this.cache.clear();
  }

  async tag(entry: AuditEntry): Promise<AppAuditTag | null> {
    const details = (entry.details ?? {}) as Record<string, unknown>;
    switch (entry.resourceType) {
      case 'app':
        return entry.resourceId
          ? { appId: entry.resourceId, appEnvironmentId: null, appMemberType: null, appMemberId: null }
          : null;
      case 'app_environment': {
        const appId = text(details.appId) ?? (await this.appOfEnvironment(entry.resourceId));
        return appId
          ? { appId, appEnvironmentId: entry.resourceId ?? null, appMemberType: null, appMemberId: null }
          : null;
      }
      case 'app_member': {
        const appId = text(details.appId) ?? text(details.fromAppId);
        if (!appId) return null;
        const memberType = text(details.memberType) as AppMemberType | null;
        return {
          appId,
          appEnvironmentId: text(details.environmentId) ?? text(details.fromEnvironmentId),
          appMemberType: memberType,
          appMemberId: entry.resourceId ?? null,
        };
      }
    }
    const member = await this.memberOf(entry, details);
    return member ? this.tagMember(member) : null;
  }

  /** Which member an audit row of a member family names, or null. */
  private async memberOf(entry: AuditEntry, details: Record<string, unknown>): Promise<AppMemberKey | null> {
    const id = entry.resourceId ?? null;
    switch (entry.resourceType) {
      case 'proxy_host':
        return id && UUID_RE.test(id) ? { type: 'route', id } : null;
      case 'database':
      case 'database_connection':
        return id && UUID_RE.test(id) ? { type: 'database', id } : null;
      case 'managed_database': {
        const connection = await this.connectionOfManagedDatabase(id);
        return connection ? { type: 'database', id: connection } : null;
      }
      case 'object_storage':
      case 'object_storage_connection':
      case 'storage':
        return id && UUID_RE.test(id) ? { type: 'storage', id } : null;
      case 'managed_storage_cluster': {
        const connection = await this.connectionOfStorageCluster(id);
        return connection ? { type: 'storage', id: connection } : null;
      }
      case 'page_project':
        return id && UUID_RE.test(id) ? { type: 'pages', id } : null;
      case 'page_deployment':
      case 'page_tag': {
        const projectId = text(details.projectId);
        return projectId && UUID_RE.test(projectId) ? { type: 'pages', id: projectId } : null;
      }
      case 'ssl_certificate':
        return id && UUID_RE.test(id) ? { type: 'certificate', id } : null;
      case 'logging-environment':
        return id && UUID_RE.test(id) ? { type: 'logging', id } : null;
      case 'logging-token': {
        const environmentId = text(details.environmentId);
        return environmentId && UUID_RE.test(environmentId) ? { type: 'logging', id: environmentId } : null;
      }
      case 'docker-compose-project':
      case 'compose':
        return id && UUID_RE.test(id) ? { type: 'compose', id } : null;
      case 'docker-deployment':
      case 'deployment':
        return id && UUID_RE.test(id) ? { type: 'deployment', id } : null;
      case 'docker-container':
      case 'container': {
        const nodeId = text(details.nodeId);
        const name = text(details.containerName) ?? text(details.name);
        return nodeId && name ? { type: 'container', id: name.replace(/^\/+/, ''), nodeId } : null;
      }
      default:
        return null;
    }
  }

  private async tagMember(member: AppMemberKey): Promise<AppAuditTag | null> {
    const key = `${member.type}:${memberTagId(member)}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.tag;
    const folders = await this.membership.memberFolders([member]);
    const entry = [...folders.values()][0];
    const ref = entry?.folderId
      ? await this.folders.resolveFolder(familyOfMemberType(member.type) as AppFamily, entry.folderId)
      : null;
    const tag: AppAuditTag | null = ref?.environmentId
      ? {
          appId: ref.appId,
          appEnvironmentId: ref.environmentId,
          appMemberType: member.type,
          appMemberId: memberTagId(member),
        }
      : null;
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(key, { at: Date.now(), tag });
    return tag;
  }

  private async appOfEnvironment(environmentId: string | undefined): Promise<string | null> {
    if (!environmentId || !UUID_RE.test(environmentId)) return null;
    const [row] = await this.db
      .select({ appId: appEnvironments.appId })
      .from(appEnvironments)
      .where(eq(appEnvironments.id, environmentId))
      .limit(1);
    return row?.appId ?? null;
  }

  private async connectionOfManagedDatabase(id: string | null): Promise<string | null> {
    if (!id || !UUID_RE.test(id)) return null;
    const [row] = await this.db
      .select({ connectionId: managedDatabaseInstances.databaseConnectionId })
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.id, id))
      .limit(1);
    return row?.connectionId ?? null;
  }

  private async connectionOfStorageCluster(id: string | null): Promise<string | null> {
    if (!id || !UUID_RE.test(id)) return null;
    const [row] = await this.db
      .select({ connectionId: managedStorageClusters.objectStorageConnectionId })
      .from(managedStorageClusters)
      .where(eq(managedStorageClusters.id, id))
      .limit(1);
    return row?.connectionId ?? null;
  }
}
