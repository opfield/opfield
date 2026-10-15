import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { domains, proxyHosts } from '@/db/schema/index.js';
import type { RouteClientIpOptions, RouteClientIpSource } from '@/db/schema/proxy-hosts.js';
import { currentCloudflareCidrList } from '@/lib/cloudflare-ip-ranges.js';
import { createChildLogger } from '@/lib/logger.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { getRegisteredDomainCandidates } from './proxy-domain-node.js';
import {
  clientIpDirectives,
  type EffectiveClientIpSource,
  hasRenderedClientIpBlock,
  markCopiedClientIpBlocks,
} from './route-client-ip.js';

const logger = createChildLogger('RouteClientIp');

/** Domain changes come in bursts (a DNS check touches every domain); they are looked at together. */
const DOMAIN_CHANGE_DEBOUNCE_MS = 2_000;

type ClientIpHost = {
  clientIpSource?: RouteClientIpSource | null;
  clientIpOptions?: RouteClientIpOptions | null;
  domainNames: string[];
};

const proxiedByCloudflare = and(eq(domains.dnsProvider, 'cloudflare'), eq(domains.dnsProxied, true));

/** Whether a registered domain covering one of these names is proxied by Cloudflare (orange cloud). */
export async function servedThroughCloudflare(db: DrizzleClient, domainNames: string[]): Promise<boolean> {
  const candidates = getRegisteredDomainCandidates(domainNames);
  if (candidates.length === 0) return false;
  // Partial database doubles in unit tests have no domains query: such a route renders as direct.
  const row = await db.query?.domains?.findFirst?.({
    where: and(inArray(sql`lower(${domains.domain})`, candidates), proxiedByCloudflare),
    columns: { id: true },
  });
  return Boolean(row);
}

/** auto resolved: Cloudflare when a name of the route is a Cloudflare-proxied domain, else the TCP peer. */
export async function effectiveClientIpSource(db: DrizzleClient, host: ClientIpHost): Promise<EffectiveClientIpSource> {
  const source = host.clientIpSource ?? 'auto';
  if (source !== 'auto') return source;
  return (await servedThroughCloudflare(db, host.domainNames)) ? 'cloudflare' : 'direct';
}

/** The realip directives a route renders now, with the current Cloudflare ranges. */
export async function routeClientIpDirectives(db: DrizzleClient, host: ClientIpHost): Promise<string[]> {
  return clientIpDirectives(
    await effectiveClientIpSource(db, host),
    host.clientIpOptions ?? null,
    currentCloudflareCidrList()
  );
}

/** A raw config as it is stored: an unchanged copy of the rendered directives becomes the marker (route-client-ip.ts). */
export async function rawConfigForWrite(db: DrizzleClient, rawConfig: string, host: ClientIpHost): Promise<string> {
  if (!hasRenderedClientIpBlock(rawConfig)) return rawConfig;
  return markCopiedClientIpBlocks(rawConfig, await routeClientIpDirectives(db, host));
}

/**
 * Re-renders the routes whose client IP directives changed outside the route: a domain was proxied or unproxied at
 * Cloudflare (auto routes on it), or Cloudflare's edge ranges changed (every route that trusts them). Routes of a node
 * without a control session are rendered by its reconnect sync.
 */
export class RouteClientIpReconciler {
  private proxiedDomains: Set<string> | null = null;
  private domainTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly db: DrizzleClient,
    private readonly reapply: (hostId: string) => Promise<unknown>,
    private readonly isNodeConnected: (nodeId: string | null) => boolean
  ) {}

  start(bus: Pick<EventBusService, 'subscribe'>): void {
    void this.loadProxiedDomains()
      .then((domainNames) => {
        this.proxiedDomains ??= domainNames;
      })
      .catch((error) => logger.warn('Reading Cloudflare-proxied domains failed', { error }));
    bus.subscribe('domain.changed', () => {
      if (this.domainTimer) return;
      this.domainTimer = setTimeout(() => {
        this.domainTimer = undefined;
        void this.reconcileDomainChanges().catch((error) =>
          logger.error('Re-rendering routes after a Cloudflare proxy change failed', { error })
        );
      }, DOMAIN_CHANGE_DEBOUNCE_MS);
      this.domainTimer.unref?.();
    });
  }

  async reconcileDomainChanges(): Promise<void> {
    const next = await this.loadProxiedDomains();
    const previous = this.proxiedDomains;
    this.proxiedDomains = next;
    if (!previous) return;
    const changed = new Set([...next].filter((name) => !previous.has(name)));
    for (const name of previous) if (!next.has(name)) changed.add(name);
    if (changed.size === 0) return;
    const hosts = await this.enabledHosts(['auto']);
    await this.reapplyAll(
      hosts.filter((host) => getRegisteredDomainCandidates(host.domainNames).some((name) => changed.has(name))),
      'domain'
    );
  }

  async reconcileCloudflareRanges(): Promise<void> {
    const hosts = await this.enabledHosts(['auto', 'cloudflare']);
    const affected: typeof hosts = [];
    for (const host of hosts) {
      if ((await effectiveClientIpSource(this.db, host)) === 'cloudflare') affected.push(host);
    }
    await this.reapplyAll(affected, 'ranges');
  }

  private async loadProxiedDomains(): Promise<Set<string>> {
    const rows = await this.db
      .select({ domain: sql<string>`lower(${domains.domain})` })
      .from(domains)
      .where(proxiedByCloudflare);
    return new Set(rows.map((row) => row.domain));
  }

  private enabledHosts(sources: RouteClientIpSource[]) {
    return this.db
      .select({
        id: proxyHosts.id,
        nodeId: proxyHosts.nodeId,
        domainNames: proxyHosts.domainNames,
        clientIpSource: proxyHosts.clientIpSource,
        clientIpOptions: proxyHosts.clientIpOptions,
      })
      .from(proxyHosts)
      .where(and(eq(proxyHosts.enabled, true), inArray(proxyHosts.clientIpSource, sources)));
  }

  private async reapplyAll(hosts: Array<{ id: string; nodeId: string | null }>, reason: 'domain' | 'ranges') {
    let succeeded = 0;
    let failed = 0;
    for (const host of hosts) {
      if (host.nodeId && !this.isNodeConnected(host.nodeId)) continue;
      try {
        await this.reapply(host.id);
        succeeded += 1;
      } catch (error) {
        failed += 1;
        logger.error('Failed to re-render route for its client IP source', { hostId: host.id, reason, error });
      }
    }
    if (hosts.length > 0) {
      logger.info('Re-rendered routes for their client IP source', { reason, total: hosts.length, succeeded, failed });
    }
  }
}
