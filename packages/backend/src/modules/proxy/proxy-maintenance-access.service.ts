import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes, proxyHostFolders, proxyHosts } from '@/db/schema/index.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { APP_ENV_MANAGE_SCOPE, hasAppScope, hasAppWideScope } from '@/modules/apps/app-access.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import type { CacheService } from '@/services/cache.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import { effectiveMaintenance } from './effective-maintenance.js';

const CODE_TTL_SECONDS = 5 * 60;
const CODE_PREFIX = 'proxy-maintenance-access:code:';
/** App and environment codes: one code, one user, once per route of the scope. */
const APP_CODE_PREFIX = 'app-maintenance-access:code:';
const APP_REDEEMED_PREFIX = 'app-maintenance-access:redeemed:';
const MAINTENANCE_ACCESS_CAPABILITY = 'proxy_maintenance_access_v1';

type AccessCode = { hostId: string; nodeId: string; userId: string };
type AppAccessCode = { appId: string; environmentId: string | null; userId: string };
function digest(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}

export class ProxyMaintenanceAccessService {
  private routeOffersAccess?: (hostId: string) => Promise<boolean>;

  constructor(
    private readonly db: DrizzleClient,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService
  ) {}

  /** How issue() learns whether a route's maintenance page offers team access (ProxyService renders the route). */
  setRouteAccessCheck(check: (hostId: string) => Promise<boolean>) {
    this.routeOffersAccess = check;
  }

  async issue(hostId: string, userId: string): Promise<{ code: string; expiresInSeconds: number }> {
    const host = await this.requireMaintainedHost(hostId);
    if (!host.nodeId) throw new AppError(409, 'MAINTENANCE_ACCESS_UNAVAILABLE', 'Proxy host has no nginx node');
    await this.requireSupportedNode(host.nodeId);
    // A render failure leaves the decision to the page: the code is issued as before.
    if (this.routeOffersAccess && !(await this.routeOffersAccess(hostId).catch(() => true))) {
      throw new AppError(
        409,
        'MAINTENANCE_ACCESS_UNAVAILABLE',
        "This route's maintenance page has no team access: its config uses secure_link or the /_opfield/maintenance-access paths"
      );
    }

    const code = randomBytes(24).toString('base64url');
    await this.cache.set(
      `${CODE_PREFIX}${digest(code)}`,
      { hostId, nodeId: host.nodeId, userId } satisfies AccessCode,
      CODE_TTL_SECONDS
    );
    await this.audit.log({
      userId,
      action: 'proxy_host.maintenance_access.issue',
      resourceType: 'proxy_host',
      resourceId: hostId,
      details: { expiresInSeconds: CODE_TTL_SECONDS },
    });
    return { code, expiresInSeconds: CODE_TTL_SECONDS };
  }

  /**
   * A code for every route of an app (environmentId null) or of one environment that is in maintenance (own switch or
   * the environment/app overlay, never lockdown) on a node that supports team access. The caller authorizes
   * (apps:env:manage on the environment, or on the whole app for every environment).
   */
  async issueForApp(input: {
    appId: string;
    environmentId: string | null;
    userId: string;
  }): Promise<{ code: string; expiresAt: string; expiresInSeconds: number; routeCount: number }> {
    const hosts = await this.db
      .select({ id: proxyHosts.id })
      .from(proxyHosts)
      .innerJoin(proxyHostFolders, eq(proxyHostFolders.id, proxyHosts.folderId))
      .where(
        and(
          eq(proxyHostFolders.appId, input.appId),
          input.environmentId
            ? eq(proxyHostFolders.appEnvironmentId, input.environmentId)
            : isNotNull(proxyHostFolders.appEnvironmentId)
        )
      );
    let routeCount = 0;
    for (const { id } of hosts) {
      const host = await this.requireMaintainedHost(id).catch(() => null);
      if (!host?.nodeId || !(await this.isNodeSupported(host.nodeId))) continue;
      if (this.routeOffersAccess && !(await this.routeOffersAccess(id).catch(() => true))) continue;
      routeCount += 1;
    }
    if (routeCount === 0) {
      throw new AppError(
        409,
        'MAINTENANCE_ACCESS_UNAVAILABLE',
        input.environmentId
          ? 'No route of this environment is in maintenance on a node that supports team access'
          : 'No route of this app is in maintenance on a node that supports team access'
      );
    }
    const code = randomBytes(24).toString('base64url');
    await this.cache.set(
      `${APP_CODE_PREFIX}${digest(code)}`,
      { appId: input.appId, environmentId: input.environmentId, userId: input.userId } satisfies AppAccessCode,
      CODE_TTL_SECONDS
    );
    await this.audit.log({
      userId: input.userId,
      action: 'app.maintenance_access.issue',
      resourceType: input.environmentId ? 'app_environment' : 'app',
      resourceId: input.environmentId ?? input.appId,
      details: {
        appId: input.appId,
        environmentId: input.environmentId,
        routeCount,
        expiresInSeconds: CODE_TTL_SECONDS,
      },
    });
    return {
      code,
      expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
      expiresInSeconds: CODE_TTL_SECONDS,
      routeCount,
    };
  }

  async redeem(hostId: string, nodeId: string, requestHost: string, code: string): Promise<string | null> {
    const raw = await this.cache.getClient().getdel(`${CODE_PREFIX}${digest(code)}`);
    if (!raw) return this.redeemAppCode(hostId, nodeId, requestHost, code);
    let grant: AccessCode;
    try {
      grant = JSON.parse(raw) as AccessCode;
    } catch {
      return null;
    }
    if (grant.hostId !== hostId || grant.nodeId !== nodeId) return null;
    const host = await this.requireMaintainedHost(hostId).catch(() => null);
    if (
      !host ||
      host.nodeId !== nodeId ||
      !host.domainNames.some((domain) => domain.toLowerCase() === requestHost.toLowerCase())
    ) {
      return null;
    }
    const user = await resolveLiveUser(this.db, grant.userId);
    if (!user || user.isBlocked || !hasScopeForResource(user.scopes, 'proxy:maintenance:bypass', hostId)) return null;
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
    const signature = createHash('md5')
      .update(`${expiresAt}${requestHost}${this.secretForHost(hostId)}`)
      .digest('base64url');
    await this.audit.log({
      userId: grant.userId,
      action: 'proxy_host.maintenance_access.redeem',
      resourceType: 'proxy_host',
      resourceId: hostId,
      details: { nodeId },
    });
    return `${signature},${expiresAt}`;
  }

  /** An app or environment code opens each route of its scope once (a second use on the same route fails). */
  private async redeemAppCode(
    hostId: string,
    nodeId: string,
    requestHost: string,
    code: string
  ): Promise<string | null> {
    const key = digest(code);
    const grant = await this.cache.get<AppAccessCode>(`${APP_CODE_PREFIX}${key}`);
    if (!grant?.appId || !grant.userId) return null;
    const host = await this.requireMaintainedHost(hostId).catch(() => null);
    if (
      !host?.folderId ||
      host.nodeId !== nodeId ||
      !host.domainNames.some((domain) => domain.toLowerCase() === requestHost.toLowerCase())
    ) {
      return null;
    }
    const [folder] = await this.db
      .select({ appId: proxyHostFolders.appId, environmentId: proxyHostFolders.appEnvironmentId })
      .from(proxyHostFolders)
      .where(eq(proxyHostFolders.id, host.folderId))
      .limit(1);
    if (
      !folder?.environmentId ||
      folder.appId !== grant.appId ||
      (grant.environmentId && folder.environmentId !== grant.environmentId)
    ) {
      return null;
    }
    const user = await resolveLiveUser(this.db, grant.userId);
    if (!user || user.isBlocked) return null;
    const stillAllowed = grant.environmentId
      ? hasAppScope(user.scopes, APP_ENV_MANAGE_SCOPE, grant.appId, grant.environmentId)
      : hasAppWideScope(user.scopes, APP_ENV_MANAGE_SCOPE, grant.appId);
    if (!stillAllowed) return null;
    // Once per route: the first redeem on a route claims it for the life of the code.
    const claimed = await this.cache.setIfAbsent(`${APP_REDEEMED_PREFIX}${key}:${hostId}`, true, CODE_TTL_SECONDS);
    if (!claimed) return null;
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
    const signature = createHash('md5')
      .update(`${expiresAt}${requestHost}${this.secretForHost(hostId)}`)
      .digest('base64url');
    await this.audit.log({
      userId: grant.userId,
      action: 'app.maintenance_access.redeem',
      resourceType: 'proxy_host',
      resourceId: hostId,
      details: { nodeId, appId: grant.appId, environmentId: folder.environmentId },
    });
    return `${signature},${expiresAt}`;
  }

  secretForHost(hostId: string) {
    return this.crypto.deriveScopedSecret(`proxy-maintenance-access:${hostId}`);
  }

  async isNodeSupported(nodeId: string | null): Promise<boolean> {
    if (!nodeId) return false;
    const node = await this.db.query.nodes.findFirst({ where: eq(nodes.id, nodeId) });
    const capabilities = node?.capabilities as Record<string, unknown> | null | undefined;
    const reported = capabilities?.capabilities;
    return (
      node?.type === 'nginx' &&
      node.status === 'online' &&
      Array.isArray(reported) &&
      reported.includes(MAINTENANCE_ACCESS_CAPABILITY)
    );
  }

  private async requireMaintainedHost(hostId: string) {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
    if (
      !host ||
      host.isSystem ||
      host.type !== 'proxy' ||
      host.rawConfigEnabled ||
      !host.enabled ||
      // Effective maintenance: the route's own switch or its app overlay; lockdown has no team access.
      !effectiveMaintenance(host) ||
      host.appMaintenanceMode === 'lockdown'
    ) {
      throw new AppError(404, 'MAINTENANCE_ACCESS_UNAVAILABLE', 'Maintenance access is unavailable');
    }
    return host;
  }

  private async requireSupportedNode(nodeId: string) {
    if (!(await this.isNodeSupported(nodeId))) {
      throw new AppError(
        409,
        'MAINTENANCE_ACCESS_UNAVAILABLE',
        'Maintenance access requires an online nginx daemon with maintenance access support'
      );
    }
  }
}
