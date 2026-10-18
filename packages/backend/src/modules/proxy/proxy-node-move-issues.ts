import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes, proxyAdditionalRoutes, proxyHosts, sslCertificates } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertAppPlacement } from '@/modules/apps/app-placement-guard.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { PageRouteService } from '@/modules/pages/routes/page-route.service.js';
import { nodeHasDistributionCapability } from '@/services/nginx-certificate-distribution.service.js';
import type { IngressMoveIssue } from './ingress-move-issues.js';
import type { ProxySecureLinkService } from './proxy-secure-link.service.js';

/** The capabilities an Nginx daemon reports when it can serve Pages routes (as the Pages runtime requires them). */
const PAGES_ROUTE_CAPABILITIES = ['nginx_pages_v1', 'nginx_pages_config_v1'];
/** Additional Route states in the middle of a change: a node move would refuse to stage them. */
const ADDITIONAL_ROUTE_BUSY_STATES = new Set(['staging', 'provisioning', 'cleanup_pending']);

export interface NodeMoveIssueDeps {
  db: DrizzleClient;
  isNodeConnected(nodeId: string): boolean;
  secureLinks?: Pick<ProxySecureLinkService, 'listAdditional'>;
  pageRoutes?: Pick<PageRouteService, 'migrationIssues'>;
}

function reportedCapabilities(capabilities: unknown): string[] {
  const reported = (capabilities as Record<string, unknown> | null | undefined)?.capabilities;
  return Array.isArray(reported) ? reported.filter((value): value is string => typeof value === 'string') : [];
}

/**
 * Everything a move of these routes to targetNodeId (updateProxyHost with a new nodeId, as an ingress migration does
 * for each route of a domain) would be refused for, and what stays behind, before anything moves. Mirrors the checks
 * of the move itself: the target node is connected and open for new services, each route's app environment allows
 * it, no additional Secure Link pins a route to its node, TLS and Pages can be delivered there, and no Additional
 * Route is in the middle of a change.
 */
export async function collectNodeMoveIssues(
  deps: NodeMoveIssueDeps,
  hostIds: readonly string[],
  targetNodeId: string
): Promise<IngressMoveIssue[]> {
  const issues: IngressMoveIssue[] = [];
  if (hostIds.length === 0) return issues;
  const hosts = (
    await deps.db
      .select()
      .from(proxyHosts)
      .where(inArray(proxyHosts.id, [...hostIds]))
  ).filter((host) => host.nodeId !== targetNodeId);
  if (hosts.length === 0) return issues;
  const [target] = await deps.db
    .select({
      type: nodes.type,
      status: nodes.status,
      capabilities: nodes.capabilities,
      displayName: nodes.displayName,
      hostname: nodes.hostname,
    })
    .from(nodes)
    .where(eq(nodes.id, targetNodeId))
    .limit(1);
  const targetName = target?.displayName || target?.hostname || 'The target node';
  const blocker = (issue: Omit<IngressMoveIssue, 'severity'>) => issues.push({ severity: 'blocker', ...issue });

  if (!target || target.status !== 'online' || !deps.isNodeConnected(targetNodeId)) {
    blocker({
      code: 'NODE_NOT_CONNECTED',
      message: `${targetName} is not connected`,
      fix: `Bring ${targetName} back online (its daemon must be connected to Opfield), or choose another node`,
      resourceType: 'node',
      resourceId: targetNodeId,
    });
  }
  try {
    await assertNodeAllowsServiceCreation(deps.db, targetNodeId, 'nginx');
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    blocker({
      code: error.code ?? 'NODE_SERVICE_CREATION_LOCKED',
      message: `${targetName}: ${error.message}`,
      fix:
        error.code === 'NODE_SERVICE_CREATION_LOCKED'
          ? `Unlock new services on ${targetName} (Nodes > ${targetName} > Unlock, or set_node_service_creation_lock), or choose another node`
          : 'Choose an Nginx node',
      resourceType: 'node',
      resourceId: targetNodeId,
    });
  }

  const targetCapabilities = reportedCapabilities(target?.capabilities);
  const servesPages = PAGES_ROUTE_CAPABILITIES.every((capability) => targetCapabilities.includes(capability));
  const additionalRoutes = await deps.db
    .select({
      id: proxyAdditionalRoutes.id,
      proxyHostId: proxyAdditionalRoutes.proxyHostId,
      path: proxyAdditionalRoutes.path,
      targetKind: proxyAdditionalRoutes.targetKind,
      status: proxyAdditionalRoutes.status,
    })
    .from(proxyAdditionalRoutes)
    .where(
      and(
        inArray(
          proxyAdditionalRoutes.proxyHostId,
          hosts.map((host) => host.id)
        ),
        eq(proxyAdditionalRoutes.enabled, true)
      )
    );
  const certificateIds = [...new Set(hosts.flatMap((host) => (host.sslCertificateId ? [host.sslCertificateId] : [])))];
  const certificates = certificateIds.length
    ? await deps.db
        .select({
          id: sslCertificates.id,
          name: sslCertificates.name,
          status: sslCertificates.status,
          certificatePem: sslCertificates.certificatePem,
        })
        .from(sslCertificates)
        .where(inArray(sslCertificates.id, certificateIds))
    : [];

  for (const host of hosts) {
    const routeName = host.domainNames[0] ?? host.slug;
    const routeIssue = (issue: Omit<IngressMoveIssue, 'severity' | 'resourceType' | 'resourceId'>) =>
      blocker({ ...issue, resourceType: 'route', resourceId: host.id });

    try {
      await assertAppPlacement(deps.db, 'routes', host.folderId, [targetNodeId]);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      routeIssue({
        code: error.code ?? 'APP_NODE_NOT_ALLOWED',
        message: `Route ${routeName}: ${error.message}`,
        fix: `Allow ${targetName} in the app environment of the route (Apps > the app > environment > Nodes > Allow node, or manage_app_environment allow_node), then preview again`,
      });
    }
    if ((await deps.secureLinks?.listAdditional(host.id))?.length) {
      routeIssue({
        code: 'ADDITIONAL_SECURE_LINK_NODE_MOVE_BLOCKED',
        message: `Route ${routeName} has additional Secure Links, which keep it on its node`,
        fix: 'Remove the additional Secure Links of the route (route > Secure Links, or manage_additional_secure_link), move, then add them again',
      });
    }
    if (host.sslEnabled && (host.sslCertificateId || host.internalCertificateId)) {
      if (target && !nodeHasDistributionCapability(target.capabilities)) {
        routeIssue({
          code: 'NGINX_TLS_DAEMON_UPDATE_REQUIRED',
          message: `${targetName} cannot receive the TLS certificate of route ${routeName}`,
          fix: `Update the Nginx daemon of ${targetName} (Nodes > ${targetName} > Update, or manage_system_updates update_daemon), then preview again`,
        });
      }
      const certificate = host.sslCertificateId
        ? certificates.find((candidate) => candidate.id === host.sslCertificateId)
        : null;
      if (host.sslCertificateId && !certificate?.certificatePem) {
        routeIssue({
          code: 'SSL_CERTIFICATE_UNAVAILABLE',
          message: `The TLS certificate of route ${routeName} has no issued certificate to deliver to ${targetName}`,
          fix: 'Issue or upload the certificate (SSL Certificates), or select another certificate on the route, then preview again',
        });
      } else if (certificate && certificate.status === 'expired') {
        issues.push({
          severity: 'warning',
          code: 'SSL_CERTIFICATE_EXPIRED',
          message: `Route ${routeName} moves with its expired TLS certificate ${certificate.name}`,
          fix: 'Renew the certificate (SSL Certificates > the certificate > Renew)',
          resourceType: 'route',
          resourceId: host.id,
        });
      }
    }
    if (host.upstreamKind === 'pages') {
      try {
        if (!deps.pageRoutes) throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages routes are unavailable');
        issues.push(...(await deps.pageRoutes.migrationIssues(host.id, host.nodeId, targetNodeId)));
      } catch (error) {
        routeIssue({
          code: error instanceof AppError && error.code ? error.code : 'PAGES_ROUTE_UNAVAILABLE',
          message: `Pages route ${routeName} cannot be checked: ${error instanceof Error ? error.message : String(error)}`,
          fix: 'Make sure Pages is licensed and enabled, then preview again',
        });
      }
    }
    for (const route of additionalRoutes.filter((candidate) => candidate.proxyHostId === host.id)) {
      if (ADDITIONAL_ROUTE_BUSY_STATES.has(route.status)) {
        routeIssue({
          code: 'ADDITIONAL_ROUTE_CHANGED',
          message: `Additional route ${route.path} of ${routeName} is being changed (${route.status})`,
          fix: 'Wait for the change to finish, then preview again',
        });
      } else if (route.status === 'failed') {
        issues.push({
          severity: 'warning',
          code: 'ADDITIONAL_ROUTE_FAILED',
          message: `Additional route ${route.path} of ${routeName} has failed and is not served; it moves as it is`,
          fix: 'Fix or recreate the additional route after the move',
          resourceType: 'route',
          resourceId: host.id,
        });
      }
      if (route.targetKind === 'pages' && route.status === 'ready' && !servesPages) {
        routeIssue({
          code: 'PAGES_DAEMON_UPDATE_REQUIRED',
          message: `${targetName} cannot serve the Pages additional route ${route.path} of ${routeName}`,
          fix: `Update the Nginx daemon of ${targetName} (Nodes > ${targetName} > Update, or manage_system_updates update_daemon), then preview again`,
        });
      }
    }
  }
  return dedupeIssues(issues);
}

/** One issue per code and resource: several routes can report the same node problem. */
function dedupeIssues(issues: IngressMoveIssue[]): IngressMoveIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.severity}:${issue.code}:${issue.resourceType}:${issue.resourceId}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
