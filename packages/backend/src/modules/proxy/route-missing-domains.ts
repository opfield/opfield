import { and, eq, isNotNull } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { domainFolders, proxyHostFolders } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  assertFolderDomainsAllowed,
  domainPolicyForFolder,
  refusedDomainNames,
} from '@/modules/apps/app-domain-allowlist.js';
import { CreateDomainSchema } from '@/modules/domains/domain.schemas.js';
import { DomainsService } from '@/modules/domains/domain.service.js';
import { assertDomainCreationOnGroup } from '@/modules/ingress-groups/ingress-group-operations.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { findRegisteredDomainNodes } from './proxy-domain-node.js';

const logger = createChildLogger('RouteMissingDomains');

function database(): DrizzleClient {
  return container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
}

/** Where a new route goes: the domains it creates for missing hostnames are served there too. */
export interface RouteDomainTarget {
  domainNames: readonly string[];
  folderId?: string | null;
  nodeId: string;
  ingressGroupId: string | null;
}

/** One route hostname no registered domain covers. */
export interface MissingRouteDomain {
  hostname: string;
  /** create: a Cloudflare domain is created in zoneName with the route; unavailable: reason says why not. */
  status: 'create' | 'unavailable';
  zoneName: string | null;
  code: string | null;
  reason: string | null;
}

export interface CreatedRouteDomain {
  id: string;
  domain: string;
  zoneName: string | null;
}

export interface MissingRouteDomainsOutcome {
  created: CreatedRouteDomain[];
  skipped: MissingRouteDomain[];
}

const ZONE_REASONS: Readonly<Record<string, string>> = {
  CLOUDFLARE_ZONE_NOT_FOUND: 'No Cloudflare zone covers this name',
  CLOUDFLARE_ZONE_AMBIGUOUS: 'Several Cloudflare connectors have a zone for this name',
  CLOUDFLARE_DNS_NOT_CONFIGURED: 'Cloudflare DNS is not set up',
};

/**
 * The domain folder a route's domains belong in: inside an app, the domains folder of the route's environment;
 * elsewhere the root (route folders and domain folders are separate trees).
 */
export async function domainFolderForRouteFolder(
  db: DrizzleClient,
  routeFolderId: string | null | undefined
): Promise<string | null> {
  if (!routeFolderId) return null;
  const [folder] = await db
    .select({ environmentId: proxyHostFolders.appEnvironmentId })
    .from(proxyHostFolders)
    .where(and(eq(proxyHostFolders.id, routeFolderId), isNotNull(proxyHostFolders.appId)))
    .limit(1);
  if (!folder?.environmentId) return null;
  const [domainFolder] = await db
    .select({ id: domainFolders.id })
    .from(domainFolders)
    .where(eq(domainFolders.appEnvironmentId, folder.environmentId))
    .limit(1);
  return domainFolder?.id ?? null;
}

/** The domain create endpoint's checks: domains:create on the folder or node, on every member for a group. */
async function canCreateDomainAt(
  scopes: readonly string[],
  folderId: string | null,
  target: Pick<RouteDomainTarget, 'nodeId' | 'ingressGroupId'>
): Promise<boolean> {
  if (!target.ingressGroupId) return hasScopeForCreation(scopes, 'domains:create', folderId, target.nodeId);
  try {
    await assertDomainCreationOnGroup(scopes, target.ingressGroupId, folderId);
    return true;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}

async function cloudflareZoneOf(hostname: string): Promise<string> {
  if (!container.isRegistered(IntegrationsService)) {
    throw new AppError(409, 'CLOUDFLARE_DNS_NOT_CONFIGURED', 'Cloudflare DNS integration is not configured');
  }
  const context = await container.resolve(IntegrationsService).resolveCloudflareDnsContext(hostname);
  return context.zone.name;
}

function uniqueHostnames(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.trim().toLowerCase().replace(/\.+$/, '')).filter(Boolean))];
}

/**
 * The route hostnames no registered domain covers (the route's own match rules: an exact domain or a covering
 * wildcard), each with whether a Cloudflare domain can be created for it and in which zone, or why not.
 */
export async function planMissingRouteDomains(
  scopes: readonly string[],
  target: RouteDomainTarget,
  db: DrizzleClient = database()
): Promise<MissingRouteDomain[]> {
  const domainFolderId = await domainFolderForRouteFolder(db, target.folderId);
  const [policy, canCreate] = await Promise.all([
    domainPolicyForFolder(db, 'routes', target.folderId),
    canCreateDomainAt(scopes, domainFolderId, target),
  ]);
  const result: MissingRouteDomain[] = [];
  for (const hostname of uniqueHostnames(target.domainNames)) {
    if ((await findRegisteredDomainNodes(db, [hostname])).length > 0) continue;
    const entry: MissingRouteDomain = { hostname, status: 'unavailable', zoneName: null, code: null, reason: null };
    const unavailable = (code: string, reason: string) => result.push({ ...entry, code, reason });
    if (!CreateDomainSchema.shape.domain.safeParse(hostname).success) {
      unavailable('INVALID_DOMAIN', 'Not a domain name Opfield can register');
    } else if (policy && refusedDomainNames(policy, [hostname]).length > 0) {
      unavailable('APP_DOMAIN_NOT_ALLOWED', `Not allowed in ${policy.appName} · ${policy.environmentName}`);
    } else if (!canCreate) {
      unavailable('FORBIDDEN', 'You cannot create domains here');
    } else {
      try {
        result.push({ ...entry, status: 'create', zoneName: await cloudflareZoneOf(hostname) });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        unavailable(error.code, ZONE_REASONS[error.code] ?? error.message);
      }
    }
  }
  return result;
}

/** Remove domains a route create made when the route itself failed (records it created go with them). */
export async function removeCreatedRouteDomains(created: readonly CreatedRouteDomain[], userId: string): Promise<void> {
  const service = container.resolve(DomainsService);
  for (const domain of [...created].reverse()) {
    try {
      const row = await service.getDomain(domain.id);
      // Records that matched before Opfield created the domain stay; records it created are deleted.
      await service.deleteDomain(domain.id, userId, {
        deleteDns: row.dnsOwnership === 'matched_existing' ? false : undefined,
      });
    } catch (error) {
      logger.warn('Failed to remove a domain created for a route that was not created', {
        domainId: domain.id,
        domain: domain.domain,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Creates the Cloudflare domains of the route's missing hostnames before the route (placed where the route is, in
 * the matching domain folder), then the route; a route that fails takes the domains this request created with it.
 * Names the caller may not create, without a Cloudflare zone, or refused by the provider are skipped, not fatal.
 */
export async function createRouteWithMissingDomains<T>(
  scopes: readonly string[],
  userId: string,
  target: RouteDomainTarget,
  createRoute: () => Promise<T>
): Promise<{ route: T; domains: MissingRouteDomainsOutcome }> {
  const db = database();
  // The route would be refused for names outside its environment's allowlist: refuse before creating any domain.
  await assertFolderDomainsAllowed(db, 'routes', target.folderId, target.domainNames);
  const plan = await planMissingRouteDomains(scopes, target, db);
  const outcome: MissingRouteDomainsOutcome = {
    created: [],
    skipped: plan.filter((entry) => entry.status !== 'create'),
  };
  const folderId = await domainFolderForRouteFolder(db, target.folderId);
  const service = container.resolve(DomainsService);
  try {
    for (const entry of plan.filter((item) => item.status === 'create')) {
      try {
        const row = await service.createDomain(
          {
            domain: entry.hostname,
            dnsProvider: 'cloudflare',
            folderId,
            ...(target.ingressGroupId ? { ingressGroupId: target.ingressGroupId } : { nginxNodeId: target.nodeId }),
          },
          userId
        );
        outcome.created.push({ id: row.id, domain: row.domain, zoneName: row.providerZoneName ?? entry.zoneName });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        outcome.skipped.push({ ...entry, status: 'unavailable', code: error.code, reason: error.message });
      }
    }
    return { route: await createRoute(), domains: outcome };
  } catch (error) {
    await removeCreatedRouteDomains(outcome.created, userId);
    throw error;
  }
}

/** The fields a route create response adds for createMissingDomains (none when the flag is off). */
export interface MissingRouteDomainsResponse {
  createdDomains?: CreatedRouteDomain[];
  skippedDomains?: Array<Pick<MissingRouteDomain, 'hostname' | 'code' | 'reason'>>;
}

/** Route create (REST and MCP): with `createMissingDomains`, the missing domains first; otherwise the route only. */
export async function createRouteMaybeWithDomains<T>(
  createMissingDomains: boolean | undefined,
  scopes: readonly string[],
  userId: string,
  target: RouteDomainTarget,
  createRoute: () => Promise<T>
): Promise<{ route: T; response: MissingRouteDomainsResponse }> {
  if (!createMissingDomains) return { route: await createRoute(), response: {} };
  const { route, domains } = await createRouteWithMissingDomains(scopes, userId, target, createRoute);
  return {
    route,
    response: {
      createdDomains: domains.created,
      skippedDomains: domains.skipped.map(({ hostname, code, reason }) => ({ hostname, code, reason })),
    },
  };
}
