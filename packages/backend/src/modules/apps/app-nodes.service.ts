import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { appEnvironmentNodes, nodes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { APP_ENV_MANAGE_SCOPE, APP_VIEW_SCOPE, assertAppScope } from './app-access.js';
import type { AppMemberType } from './app-families.js';
import type { AppMembersReader } from './app-members.service.js';
import type { AppActor, AppsService } from './apps.service.js';

/** Node types an environment can allow: the ones its resources run on. */
export const ALLOWABLE_NODE_TYPES = ['docker', 'nginx', 'databases', 'storage'] as const;

type UsageKey = 'containers' | 'compose' | 'databases' | 'storage' | 'routes' | 'pages';
/** Member types that run on nodes (certificates and logging environments run on none). */
const USAGE_KEY: Readonly<Partial<Record<AppMemberType, UsageKey>>> = {
  container: 'containers',
  deployment: 'containers',
  compose: 'compose',
  database: 'databases',
  storage: 'storage',
  route: 'routes',
  pages: 'pages',
};

function emptyUsage(): Record<UsageKey, number> {
  return { containers: 0, compose: 0, databases: 0, storage: 0, routes: 0, pages: 0 };
}

/**
 * The node allowlist of an environment: creates, imports and placements in the environment are refused on any
 * other node (enforced by the placement guard in every create path). Removing a node keeps what runs there.
 */
export class AppNodesService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly apps: AppsService,
    private readonly members: AppMembersReader
  ) {}

  private freeze?: (environmentId: string) => Promise<void>;

  /** Allowlist changes are refused while the environment is isolated by the kill switch. */
  setFreezeCheck(check: (environmentId: string) => Promise<void>) {
    this.freeze = check;
  }

  async list(actor: AppActor, appId: string, environmentId: string) {
    const { app } = await this.apps.resolveVisible(actor.scopes, appId);
    const env = await this.apps.getEnvironment(app.id, environmentId);
    assertAppScope(actor.scopes, APP_VIEW_SCOPE, app.id, env.id);
    return this.usage(env.id);
  }

  /** Allowed nodes with how many members of each type run on them (all members, for the remove confirmation). */
  async usage(environmentId: string) {
    const rows = await this.db
      .select({
        nodeId: appEnvironmentNodes.nodeId,
        type: nodes.type,
        hostname: nodes.hostname,
        displayName: nodes.displayName,
        status: nodes.status,
      })
      .from(appEnvironmentNodes)
      .innerJoin(nodes, eq(nodes.id, appEnvironmentNodes.nodeId))
      .where(eq(appEnvironmentNodes.environmentId, environmentId));
    const members = await this.members.listMembers([environmentId]);
    return {
      nodes: rows.map((row) => {
        const usedBy = emptyUsage();
        for (const member of members) {
          const key = USAGE_KEY[member.type];
          if (key && member.nodeIds.includes(row.nodeId)) usedBy[key] += 1;
        }
        return {
          nodeId: row.nodeId,
          type: row.type,
          name: row.displayName || row.hostname,
          hostname: row.hostname,
          status: row.status,
          usedBy,
        };
      }),
    };
  }

  async allow(actor: AppActor, appId: string, environmentId: string, nodeId: string) {
    const { app } = await this.apps.resolveVisible(actor.scopes, appId);
    const env = await this.apps.getEnvironment(app.id, environmentId);
    assertAppScope(actor.scopes, APP_ENV_MANAGE_SCOPE, app.id, env.id);
    await this.freeze?.(env.id);
    const [node] = await this.db
      .select({ id: nodes.id, type: nodes.type, hostname: nodes.hostname, displayName: nodes.displayName })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    if (!(ALLOWABLE_NODE_TYPES as readonly string[]).includes(node.type)) {
      throw new AppError(
        400,
        'APP_NODE_TYPE_UNSUPPORTED',
        'Only Docker, Nginx, database and storage nodes can be allowed in an environment'
      );
    }
    const inserted = await this.db
      .insert(appEnvironmentNodes)
      .values({ environmentId: env.id, nodeId: node.id, createdById: actor.userId })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) {
      await this.auditService.log({
        userId: actor.userId,
        action: 'app.environment.allow_node',
        resourceType: 'app_environment',
        resourceId: env.id,
        details: {
          appId: app.id,
          appName: app.name,
          environment: env.name,
          nodeId,
          node: node.displayName || node.hostname,
        },
      });
      this.apps.publish(app.id, 'nodes_changed');
    }
    return this.usage(env.id);
  }

  async remove(actor: AppActor, appId: string, environmentId: string, nodeId: string) {
    const { app } = await this.apps.resolveVisible(actor.scopes, appId);
    const env = await this.apps.getEnvironment(app.id, environmentId);
    assertAppScope(actor.scopes, APP_ENV_MANAGE_SCOPE, app.id, env.id);
    await this.freeze?.(env.id);
    const removed = await this.db
      .delete(appEnvironmentNodes)
      .where(and(eq(appEnvironmentNodes.environmentId, env.id), eq(appEnvironmentNodes.nodeId, nodeId)))
      .returning();
    if (removed.length === 0) throw new AppError(404, 'APP_NODE_NOT_ALLOWED', 'This node is not allowed here');
    await this.auditService.log({
      userId: actor.userId,
      action: 'app.environment.remove_node',
      resourceType: 'app_environment',
      resourceId: env.id,
      details: { appId: app.id, appName: app.name, environment: env.name, nodeId },
    });
    this.apps.publish(app.id, 'nodes_changed');
    return this.usage(env.id);
  }
}
