import { createHash } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityPlacements,
  dockerDeploymentRoutes,
  dockerDeployments,
  managedStorageClusters,
  nodes,
  proxyAdditionalRoutes,
  proxyAdditionalSecureLinks,
  proxyHosts,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { proxyHostsServedByNode, resolveIngressNodes } from '@/modules/ingress-groups/ingress-nodes.js';
import {
  secureLinkSourceNodeIds,
  secureLinksSourcedByNode,
} from '@/modules/ingress-groups/ingress-secure-link-sources.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { isNodeNotConnectedError } from '@/services/node-connection-errors.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
import type { ContainerLinkTargetProvider } from './container-link-targets.js';
import type { ProxyDockerUpstreamService } from './proxy-docker-upstream.service.js';
import {
  availabilityMemberBindingFields,
  availabilityMemberSyncContext,
  syncableAvailabilityMember,
} from './proxy-secure-link-availability.js';
import { secureLinkLoopbackAddress } from './secure-link-loopback.js';

type ProxyHostRow = typeof proxyHosts.$inferSelect;
export type ProxyAdditionalSecureLinkRow = typeof proxyAdditionalSecureLinks.$inferSelect;

export type ProxyAdditionalSecureLinkPurpose = 'user_managed' | 'additional_route' | 'availability_member';

export interface CreateProxyAdditionalSecureLinkInput {
  name: string;
  upstreamKind: 'docker_container' | 'docker_deployment' | 'managed_storage';
  forwardScheme?: 'http' | 'https';
  dockerNodeId?: string | null;
  dockerContainerName?: string | null;
  dockerComposeProjectId?: string | null;
  dockerComposeServiceName?: string | null;
  dockerDeploymentId?: string | null;
  dockerContainerPort?: number;
  managedStorageId?: string | null;
}

interface BindingDetail {
  linkId: string;
  generation: number;
  port: number;
  targetNetwork?: string;
}

export interface AvailabilitySecureLinkMemberInput {
  placementId: string;
  ingressOwnerKey: string;
  dockerNodeId: string;
  upstreamKind: 'docker_container' | 'docker_deployment';
  forwardScheme: 'http' | 'https';
  dockerContainerName?: string | null;
  dockerComposeProjectId?: string | null;
  dockerComposeServiceName?: string | null;
  dockerDeploymentId?: string | null;
  dockerContainerPort: number;
  dockerHostPort: number;
  targetNetwork: string;
  targetContainer: string;
  /**
   * A standby placement's member (D7): provisioned end to end but never probed, and served only by daemons that
   * open it while its candidate holds the data-plane lease.
   */
  dormant?: boolean;
}

const PROXY_SECURE_LINK_PROBE_ATTEMPTS = 6;
const PROXY_SECURE_LINK_PROBE_RETRY_MS = 500;
const NGINX_SECURE_LINK_SOCKET_ONLY_CAPABILITY = 'nginx_secure_link_socket_only_v1';
const logger = createChildLogger('ProxySecureLinkService');
const DOCKER_UPSTREAM_KINDS = ['docker_container', 'docker_deployment'] as const;

/** One source (a single-node route) is passed as before; a group route passes every member. */
function relaySources(sources: readonly string[]): string | readonly string[] {
  return sources.length === 1 ? sources[0]! : sources;
}

function isDockerUpstream(kind: string): kind is (typeof DOCKER_UPSTREAM_KINDS)[number] {
  return (DOCKER_UPSTREAM_KINDS as readonly string[]).includes(kind);
}

function isManagedStorageUpstream(kind: string): kind is 'managed_storage' {
  return kind === 'managed_storage';
}

// Handlebars tolerates whitespace inside the delimiters (`{{ additionalSecureLinks.x }}`
// renders the same as `{{additionalSecureLinks.x}}`), so the reference guard below must
// tolerate it too. A binding name is already constrained to `[A-Za-z][A-Za-z0-9_]{0,63}`
// (see assertAdditionalReferences), so no regex escaping is required.
function additionalSecureLinkVariablePattern(name: string): RegExp {
  return new RegExp(`\\{\\{\\s*additionalSecureLinks\\.${name}\\s*\\}\\}`);
}

// The variable renders to the nginx upstream `opfield_additional_secure_link_<id>` (dashes
// become underscores), and a config can name that upstream directly. A binding id is a UUID
// (hex and dashes), so no regex escaping is required; either separator is accepted.
function additionalSecureLinkUpstreamPattern(bindingId: string): RegExp {
  const id = bindingId.toLowerCase().split('-').join('[-_]');
  // legacy-name: gateway_additional_secure_link_ of configs written before 2.12.1 — remove once every node reports none
  return new RegExp(`(?:opfield|gateway)_additional_secure_link_${id}(?![A-Za-z0-9_])`, 'i');
}

function firstReference(text: string | null | undefined, patterns: RegExp[]): string | null {
  if (!text) return null;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

/**
 * A target binding in the sync that releases `excludedNetwork` from the connector (B-24): only the links bound to that
 * network leave. A link that may pick another network is pinned to the one it is bound to, so the daemon cannot move it
 * onto the released network; one without a recorded network stays as it is (the sync drops it if the daemon reports it
 * on the released network). Every other link keeps its connector binding: dropping every Docker-container link here
 * took a serving Availability holder off its node until the reconcile that follows bound it again.
 */
function releasedNetworkBinding<T extends { targetNetwork: string; allowNetworkReselection: boolean }>(
  binding: T,
  excludedNetwork: string | undefined
): T[] {
  if (!excludedNetwork) return [binding];
  if (binding.targetNetwork === excludedNetwork) return [];
  if (!binding.allowNetworkReselection || !binding.targetNetwork) return [binding];
  return [{ ...binding, allowNetworkReselection: false }];
}

/** True when `after` differs from `before` only by the target network the daemon picked during target sync. */
/** A Secure Link an app kill switch holds closed refuses changes and deletion until the incident is released. */
function assertNotIncidentSuspended(binding: Pick<ProxyAdditionalSecureLinkRow, 'incidentSuspendedBy'>): void {
  if (binding.incidentSuspendedBy) {
    throw new AppError(
      409,
      'APP_ISOLATED',
      'This Secure Link is closed by an app kill switch; turn the kill switch off before changing it'
    );
  }
}

function isNetworkReselection(before: ProxyAdditionalSecureLinkRow, after: ProxyAdditionalSecureLinkRow): boolean {
  return (
    after.status === 'provisioning' &&
    after.generation > before.generation &&
    after.targetNetwork !== before.targetNetwork &&
    after.dockerNodeId === before.dockerNodeId &&
    after.targetContainer === before.targetContainer &&
    after.dockerHostPort === before.dockerHostPort &&
    after.name === before.name
  );
}

export class ProxySecureLinkService {
  private eventBus?: EventBusService;
  private readonly targetNodeSyncs = new Map<string, Promise<void>>();
  private readonly sourceNodeSyncs = new Map<string, Promise<void>>();
  private readonly linkOperations = new Map<string, Promise<unknown>>();
  private containerLinkTargets?: ContainerLinkTargetProvider;

  constructor(
    private readonly db: DrizzleClient,
    private readonly dispatch: NodeDispatchService,
    private readonly relayPolicy: RelayPolicyService,
    private connectorImage: string,
    private readonly dockerUpstreams?: ProxyDockerUpstreamService
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  async updateConnectorImage(connectorImage: string): Promise<void> {
    if (connectorImage === this.connectorImage) return;
    this.connectorImage = connectorImage;

    try {
      const [hosts, additional] = await Promise.all([
        this.db.query.proxyHosts.findMany({
          where: and(
            inArray(proxyHosts.upstreamKind, [...DOCKER_UPSTREAM_KINDS]),
            ne(proxyHosts.secureLinkStatus, 'cleanup_pending'),
            ne(proxyHosts.secureLinkGeneration, 0)
          ),
          columns: { dockerNodeId: true },
        }),
        (this.db.query as any).proxyAdditionalSecureLinks
          ? (this.db.query as any).proxyAdditionalSecureLinks.findMany({
              where: inArray(proxyAdditionalSecureLinks.status, ['provisioning', 'active']),
              columns: { dockerNodeId: true },
            })
          : Promise.resolve([]),
      ]);
      const targetNodeIds = new Set<string>();
      for (const host of hosts) {
        if (host.dockerNodeId) targetNodeIds.add(host.dockerNodeId);
      }
      for (const binding of additional as Array<{ dockerNodeId: string; upstreamKind: string }>) {
        if (isDockerUpstream(binding.upstreamKind)) targetNodeIds.add(binding.dockerNodeId);
      }
      for (const nodeId of (await this.containerLinkTargets?.targetNodeIds()) ?? []) targetNodeIds.add(nodeId);

      const nodesToSync = [...targetNodeIds];
      const results = await Promise.allSettled(nodesToSync.map((nodeId) => this.syncTargetNode(nodeId)));
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.warn('Failed to apply the updated Secure Link connector image to a Docker node', {
            nodeId: nodesToSync[index],
            error: result.reason,
          });
        }
      });
    } catch (error) {
      logger.warn('Failed to reconcile Secure Link connectors after the Relay update', { error });
    }
  }

  async getRuntime(linkId: string) {
    return this.relayPolicy.getProxyRouteRuntime(linkId);
  }

  async listAdditional(
    proxyHostId: string,
    purpose: ProxyAdditionalSecureLinkPurpose = 'user_managed'
  ): Promise<ProxyAdditionalSecureLinkRow[]> {
    return this.db.query.proxyAdditionalSecureLinks.findMany({
      where: and(
        eq(proxyAdditionalSecureLinks.proxyHostId, proxyHostId),
        eq(proxyAdditionalSecureLinks.purpose, purpose)
      ),
      orderBy: (binding, { asc }) => [asc(binding.createdAt)],
    });
  }

  async listAllAdditional(proxyHostId: string): Promise<ProxyAdditionalSecureLinkRow[]> {
    return this.db.query.proxyAdditionalSecureLinks.findMany({
      where: eq(proxyAdditionalSecureLinks.proxyHostId, proxyHostId),
      orderBy: (binding, { asc }) => [asc(binding.createdAt)],
    });
  }

  async getActiveAdditional(
    proxyHostId: string,
    purpose: ProxyAdditionalSecureLinkPurpose = 'user_managed'
  ): Promise<ProxyAdditionalSecureLinkRow[]> {
    return this.db.query.proxyAdditionalSecureLinks.findMany({
      where: and(
        eq(proxyAdditionalSecureLinks.proxyHostId, proxyHostId),
        eq(proxyAdditionalSecureLinks.purpose, purpose),
        eq(proxyAdditionalSecureLinks.status, 'active')
      ),
      orderBy: (binding, { asc }) => [asc(binding.name)],
    });
  }

  async getActiveAvailabilityMembers(
    proxyHostId: string,
    ingressOwnerKey: string
  ): Promise<ProxyAdditionalSecureLinkRow[]> {
    return this.db.query.proxyAdditionalSecureLinks.findMany({
      where: and(
        eq(proxyAdditionalSecureLinks.proxyHostId, proxyHostId),
        eq(proxyAdditionalSecureLinks.purpose, 'availability_member'),
        eq(proxyAdditionalSecureLinks.availabilityOwnerKey, ingressOwnerKey),
        eq(proxyAdditionalSecureLinks.status, 'active')
      ),
      orderBy: (binding, { asc }) => [asc(binding.name)],
    });
  }

  async ensureAvailabilityMember(
    host: ProxyHostRow,
    input: AvailabilitySecureLinkMemberInput
  ): Promise<ProxyAdditionalSecureLinkRow> {
    if (!host.nodeId || host.type !== 'proxy' || host.rawConfigEnabled) {
      throw new AppError(409, 'AVAILABILITY_INGRESS_UNAVAILABLE', 'Availability requires a managed Proxy Host');
    }
    const availabilitySources = await this.hostSources(host);
    if (!(await this.nodesSupportSecureLinks([...availabilitySources, input.dockerNodeId], availabilitySources))) {
      throw new AppError(
        409,
        'PROXY_SECURE_LINK_UPDATE_REQUIRED',
        'Update both Nginx and Docker daemons before activating this Availability placement'
      );
    }
    const existing = await this.db.query.proxyAdditionalSecureLinks.findFirst({
      where: and(
        eq(proxyAdditionalSecureLinks.proxyHostId, host.id),
        eq(proxyAdditionalSecureLinks.purpose, 'availability_member'),
        eq(proxyAdditionalSecureLinks.availabilityOwnerKey, input.ingressOwnerKey),
        eq(proxyAdditionalSecureLinks.referenceId, input.placementId)
      ),
    });
    const dormant = input.dormant === true;
    // A container's member names no network: its daemon selects the container's network and the link records it on
    // the first serving provision. That recorded choice is the same target, not a change. Treating it as one
    // re-provisioned the member at every lease handoff (the old holder going dormant, the successor serving), and a
    // failed re-provision re-issued its relay endpoint: 4.6 s of the handoff gap (N-13).
    const unchanged =
      existing?.status === 'active' &&
      !existing.lastError &&
      existing.dockerNodeId === input.dockerNodeId &&
      (!input.targetNetwork || existing.targetNetwork === input.targetNetwork) &&
      existing.targetContainer === input.targetContainer &&
      existing.dockerHostPort === input.dockerHostPort &&
      // A Route edit of the application port or Compose service re-provisions the member (C-1 follow-up).
      existing.dockerContainerPort === input.dockerContainerPort &&
      (existing.dockerComposeServiceName ?? null) === (input.dockerComposeServiceName ?? null);
    if (unchanged && existing.dormant === dormant) return existing;
    if (unchanged) return this.setAvailabilityMemberDormant(host, input.placementId, input.ingressOwnerKey, dormant);
    if (existing) {
      const [reprovisioning] = await this.db
        .update(proxyAdditionalSecureLinks)
        .set({
          dockerNodeId: input.dockerNodeId,
          upstreamKind: input.upstreamKind,
          forwardScheme: input.forwardScheme ?? 'http',
          dockerContainerName: input.dockerContainerName ?? null,
          dockerComposeProjectId: input.dockerComposeProjectId ?? null,
          dockerComposeServiceName: input.dockerComposeServiceName ?? null,
          dockerDeploymentId: input.dockerDeploymentId ?? null,
          dockerContainerPort: input.dockerContainerPort,
          dockerHostPort: input.dockerHostPort,
          targetNetwork: input.targetNetwork,
          targetContainer: input.targetContainer,
          dormant,
          status: 'provisioning',
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(proxyAdditionalSecureLinks.id, existing.id))
        .returning();
      if (reprovisioning) {
        const ready = await this.createAdditionalFromExisting(host, existing.id);
        if (ready.status !== 'active' || ready.lastError) {
          throw new AppError(
            409,
            'AVAILABILITY_INGRESS_MEMBER_NOT_READY',
            ready.lastError ?? 'Availability Secure Link member did not become ready',
            { retryable: true, placementId: input.placementId }
          );
        }
        return ready;
      }
    }
    const [created] = await this.db
      .insert(proxyAdditionalSecureLinks)
      .values({
        proxyHostId: host.id,
        name: `availability_${createHash('sha256').update(input.ingressOwnerKey).digest('hex').slice(0, 12)}_${input.placementId.replaceAll('-', '')}`.slice(
          0,
          64
        ),
        purpose: 'availability_member',
        referenceId: input.placementId,
        availabilityOwnerKey: input.ingressOwnerKey,
        upstreamKind: input.upstreamKind,
        forwardScheme: input.forwardScheme,
        sourceNodeId: host.nodeId,
        dockerNodeId: input.dockerNodeId,
        dockerContainerName: input.dockerContainerName ?? null,
        dockerComposeProjectId: input.dockerComposeProjectId ?? null,
        dockerComposeServiceName: input.dockerComposeServiceName ?? null,
        dockerDeploymentId: input.dockerDeploymentId ?? null,
        dockerContainerPort: input.dockerContainerPort,
        dockerHostPort: input.dockerHostPort,
        targetNetwork: input.targetNetwork,
        targetContainer: input.targetContainer,
        dormant,
        status: 'provisioning',
      })
      .returning();
    if (!created) throw new AppError(500, 'SECURE_LINK_CREATE_FAILED', 'Availability member was not created');
    const ready = await this.createAdditionalFromExisting(host, created.id);
    if (ready.status !== 'active' || ready.lastError) {
      throw new AppError(
        409,
        'AVAILABILITY_INGRESS_MEMBER_NOT_READY',
        ready.lastError ?? 'Availability Secure Link member did not become ready',
        { retryable: true, placementId: input.placementId }
      );
    }
    return ready;
  }

  /**
   * Resends the Secure Link bindings of every Availability member of a policy, after its lease mode changed: members
   * carry the lease policy only while the policy is in lease mode (B2), so nginx gates them by the lease only then.
   */
  async syncAvailabilityPolicyMembers(policyId: string): Promise<void> {
    const members = await this.db
      .select({
        sourceNodeId: proxyAdditionalSecureLinks.sourceNodeId,
        dockerNodeId: proxyAdditionalSecureLinks.dockerNodeId,
        proxyHostId: proxyAdditionalSecureLinks.proxyHostId,
      })
      .from(proxyAdditionalSecureLinks)
      .innerJoin(
        dockerAvailabilityPlacements,
        eq(dockerAvailabilityPlacements.id, proxyAdditionalSecureLinks.referenceId)
      )
      .where(
        and(
          eq(proxyAdditionalSecureLinks.purpose, 'availability_member'),
          eq(dockerAvailabilityPlacements.policyId, policyId)
        )
      );
    // A member of a route on an ingress group has a source on every group member.
    const sources = new Set<string>();
    for (const hostId of new Set(members.map(({ proxyHostId }) => proxyHostId))) {
      const host = await this.db.query.proxyHosts.findFirst({
        where: eq(proxyHosts.id, hostId),
        columns: { nodeId: true, ingressGroupId: true },
      });
      const recorded = members.find((member) => member.proxyHostId === hostId)?.sourceNodeId ?? null;
      for (const nodeId of await secureLinkSourceNodeIds(this.db, host, recorded)) sources.add(nodeId);
    }
    await Promise.all([
      ...[...sources].map((nodeId) => this.syncSourceNode(nodeId)),
      ...[...new Set(members.map(({ dockerNodeId }) => dockerNodeId))].map((nodeId) => this.syncTargetNode(nodeId)),
    ]);
  }

  /**
   * Marks an Availability member dormant (its placement became a standby) or live (it serves). Sockets and connectors
   * follow on both daemons; in lease mode they additionally follow the lease holder (D8).
   */
  async setAvailabilityMemberDormant(
    host: ProxyHostRow,
    placementId: string,
    ingressOwnerKey: string,
    dormant: boolean
  ): Promise<ProxyAdditionalSecureLinkRow> {
    const [updated] = await this.db
      .update(proxyAdditionalSecureLinks)
      .set({ dormant, updatedAt: new Date() })
      .where(
        and(
          eq(proxyAdditionalSecureLinks.proxyHostId, host.id),
          eq(proxyAdditionalSecureLinks.purpose, 'availability_member'),
          eq(proxyAdditionalSecureLinks.availabilityOwnerKey, ingressOwnerKey),
          eq(proxyAdditionalSecureLinks.referenceId, placementId)
        )
      )
      .returning();
    if (!updated) throw new AppError(404, 'AVAILABILITY_INGRESS_MEMBER_NOT_FOUND', 'Availability member not found');
    await Promise.all([
      this.syncSourceNodes(await this.bindingSources(updated, host)),
      this.syncTargetNode(updated.dockerNodeId),
    ]);
    return updated;
  }

  /**
   * An app kill switch holds a Secure Link closed (`incidentId`) or opens it again (null). Its sources and its target
   * leave it out of their sync sets, so the nginx socket and the connector endpoint close; the row, its generation and
   * its listener stay, and Availability's own dormant flag is untouched. Returns the holder before the change (the
   * prior state the incident records), or undefined when the link is gone.
   */
  async setIncidentSuspended(
    linkId: string,
    incidentId: string | null
  ): Promise<{ previous: string | null } | undefined> {
    const existing = await this.db.query.proxyAdditionalSecureLinks.findFirst({
      where: eq(proxyAdditionalSecureLinks.id, linkId),
    });
    if (!existing) return undefined;
    return this.withLinkOperation(linkId, async () => {
      const [updated] = await this.db
        .update(proxyAdditionalSecureLinks)
        .set({ incidentSuspendedBy: incidentId, updatedAt: new Date() })
        .where(eq(proxyAdditionalSecureLinks.id, linkId))
        .returning();
      if (!updated) return undefined;
      if ((existing.incidentSuspendedBy ?? null) !== incidentId) {
        const sources = await this.bindingSources(updated);
        const syncs: Array<Promise<unknown>> = [this.syncSourceNodes(sources)];
        if (isDockerUpstream(updated.upstreamKind)) syncs.push(this.syncTargetNode(updated.dockerNodeId));
        const results = await Promise.allSettled(syncs);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed && failed.status === 'rejected') throw failed.reason;
      }
      return { previous: existing.incidentSuspendedBy ?? null };
    });
  }

  async deleteAvailabilityMember(
    host: ProxyHostRow,
    placementId: string,
    ingressOwnerKey: string,
    beforeRuntimeCleanup?: () => Promise<void>
  ): Promise<void> {
    const binding = await this.db.query.proxyAdditionalSecureLinks.findFirst({
      where: and(
        eq(proxyAdditionalSecureLinks.proxyHostId, host.id),
        eq(proxyAdditionalSecureLinks.purpose, 'availability_member'),
        eq(proxyAdditionalSecureLinks.availabilityOwnerKey, ingressOwnerKey),
        eq(proxyAdditionalSecureLinks.referenceId, placementId)
      ),
    });
    if (!binding) return;
    await this.withLinkOperation(binding.id, async () => {
      const current = await this.db.query.proxyAdditionalSecureLinks.findFirst({
        where: and(eq(proxyAdditionalSecureLinks.id, binding.id), eq(proxyAdditionalSecureLinks.proxyHostId, host.id)),
      });
      if (!current) return;
      try {
        await this.db
          .update(proxyAdditionalSecureLinks)
          .set({ status: 'cleanup_pending', lastError: null, updatedAt: new Date() })
          .where(eq(proxyAdditionalSecureLinks.id, current.id));
        await beforeRuntimeCleanup?.();
        await this.deprovisionAdditionalRuntime(current, host);
        await this.db.delete(proxyAdditionalSecureLinks).where(eq(proxyAdditionalSecureLinks.id, current.id));
        this.emitAdditionalState(host, current, 'deleted');
      } catch (error) {
        const [pending] = await this.db
          .update(proxyAdditionalSecureLinks)
          .set({
            status: 'cleanup_pending',
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          })
          .where(eq(proxyAdditionalSecureLinks.id, current.id))
          .returning();
        this.emitAdditionalState(host, pending ?? current, 'cleanup_failed');
        throw error;
      }
    });
  }

  async getManagedRoute(routeId: string): Promise<ProxyAdditionalSecureLinkRow | null> {
    const bindings = await this.db.query.proxyAdditionalSecureLinks.findMany({
      where: and(
        eq(proxyAdditionalSecureLinks.purpose, 'additional_route'),
        eq(proxyAdditionalSecureLinks.referenceId, routeId)
      ),
      orderBy: (binding, { desc }) => [desc(binding.createdAt)],
    });
    return bindings.find((binding) => binding.status === 'active') ?? bindings[0] ?? null;
  }

  async createAdditional(
    host: ProxyHostRow,
    input: CreateProxyAdditionalSecureLinkInput,
    actorScopes?: string[]
  ): Promise<ProxyAdditionalSecureLinkRow> {
    if (host.type !== 'proxy' || host.rawConfigEnabled || !host.nodeId) {
      throw new AppError(
        409,
        'ADDITIONAL_SECURE_LINK_UNAVAILABLE',
        'Additional Secure Links require a managed proxy host'
      );
    }
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.name)) {
      throw new AppError(
        400,
        'INVALID_SECURE_LINK_NAME',
        'Binding name must start with a letter and contain only letters, numbers, and underscores'
      );
    }
    if (
      isDockerUpstream(input.upstreamKind) &&
      (!input.dockerContainerPort || input.dockerContainerPort < 1 || input.dockerContainerPort > 65535)
    ) {
      throw new AppError(400, 'INVALID_DOCKER_PORT', 'Container port must be between 1 and 65535');
    }

    const target = await this.resolveAdditionalTarget(input, actorScopes);
    const createSources = await this.hostSources(host);
    if (
      !(await this.nodesSupportSecureLinks(
        isManagedStorageUpstream(input.upstreamKind) ? createSources : [...createSources, target.nodeId],
        createSources
      ))
    ) {
      throw new AppError(
        409,
        'PROXY_SECURE_LINK_UPDATE_REQUIRED',
        'Update both Nginx and Docker daemons before provisioning this binding'
      );
    }
    if (isDockerUpstream(input.upstreamKind) && !this.connectorImage) {
      throw new AppError(503, 'SECURE_LINK_CONNECTOR_UNAVAILABLE', 'Secure Link connector image is not configured');
    }
    const existing = await this.db.query.proxyAdditionalSecureLinks.findFirst({
      where: and(
        eq(proxyAdditionalSecureLinks.proxyHostId, host.id),
        eq(proxyAdditionalSecureLinks.purpose, 'user_managed'),
        eq(proxyAdditionalSecureLinks.name, input.name)
      ),
    });
    if (existing) throw new AppError(409, 'SECURE_LINK_NAME_EXISTS', 'A binding with this name already exists');

    const persist = async (db: Pick<DrizzleClient, 'insert'>, resolved: typeof target) =>
      (
        await db
          .insert(proxyAdditionalSecureLinks)
          .values({
            proxyHostId: host.id,
            name: input.name,
            purpose: 'user_managed',
            referenceId: null,
            upstreamKind: input.upstreamKind,
            forwardScheme: resolved.forwardScheme,
            sourceNodeId: host.nodeId!,
            dockerNodeId: resolved.nodeId,
            dockerContainerName: input.upstreamKind === 'docker_container' ? resolved.container : null,
            dockerComposeProjectId: input.upstreamKind === 'docker_container' ? input.dockerComposeProjectId : null,
            dockerComposeServiceName: input.upstreamKind === 'docker_container' ? input.dockerComposeServiceName : null,
            dockerDeploymentId: input.upstreamKind === 'docker_deployment' ? input.dockerDeploymentId : null,
            managedStorageId: resolved.managedStorageId ?? null,
            dockerContainerPort: resolved.applicationPort,
            dockerHostPort: resolved.targetPort,
            targetNetwork: resolved.network,
            targetContainer: resolved.container,
          })
          .returning()
      )[0]!;
    const created = target.managedStorageId
      ? await this.db.transaction(async (tx) => {
          // Match storage deletion's row lock before it claims external teardown.
          await tx
            .select({ id: managedStorageClusters.id })
            .from(managedStorageClusters)
            .where(eq(managedStorageClusters.id, target.managedStorageId!))
            .for('update');
          const currentTarget = await this.resolveAdditionalTarget(input, actorScopes, true, tx);
          return persist(tx, currentTarget);
        })
      : await persist(this.db, target);

    this.emitAdditionalState(host, created, 'provisioning');
    void this.createAdditionalFromExisting(host, created.id).catch((error) => {
      logger.error('Background additional Secure Link provisioning failed unexpectedly', {
        hostId: host.id,
        bindingId: created.id,
        error,
      });
    });
    return created;
  }

  /** Provision a route-owned binding synchronously enough for a route
   * transaction: failures are persisted as `failed` and are retryable by the
   * Additional Route service.  It never falls back to a direct Docker host. */
  async createManagedRoute(
    host: ProxyHostRow,
    routeId: string,
    input: CreateProxyAdditionalSecureLinkInput
  ): Promise<ProxyAdditionalSecureLinkRow> {
    if (host.type !== 'proxy' || host.rawConfigEnabled || !host.nodeId) {
      throw new AppError(409, 'ADDITIONAL_ROUTE_UNAVAILABLE', 'Additional Routes require a managed proxy host');
    }
    const target = await this.resolveAdditionalTarget(input);
    const routeSources = await this.hostSources(host);
    if (!(await this.nodesSupportSecureLinks([...routeSources, target.nodeId], routeSources))) {
      throw new AppError(
        409,
        'PROXY_SECURE_LINK_UPDATE_REQUIRED',
        'Update both Nginx and Docker daemons before provisioning this route'
      );
    }
    if (!this.connectorImage) {
      throw new AppError(503, 'SECURE_LINK_CONNECTOR_UNAVAILABLE', 'Secure Link connector image is not configured');
    }
    const existing = await this.getManagedRoute(routeId);
    if (existing) {
      const targetUnchanged =
        existing.sourceNodeId === host.nodeId &&
        existing.upstreamKind === input.upstreamKind &&
        existing.forwardScheme === input.forwardScheme &&
        existing.dockerNodeId === target.nodeId &&
        existing.dockerContainerName === (input.upstreamKind === 'docker_container' ? target.container : null) &&
        existing.dockerComposeProjectId ===
          (input.upstreamKind === 'docker_container' ? (input.dockerComposeProjectId ?? null) : null) &&
        existing.dockerComposeServiceName ===
          (input.upstreamKind === 'docker_container' ? (input.dockerComposeServiceName ?? null) : null) &&
        existing.dockerDeploymentId ===
          (input.upstreamKind === 'docker_deployment' ? input.dockerDeploymentId : null) &&
        existing.dockerContainerPort === input.dockerContainerPort &&
        existing.dockerHostPort === target.targetPort &&
        // Container targets deliberately resolve with an empty network here;
        // the Docker daemon chooses and persists the reachable network while
        // materializing the connector. Treat that empty value as a wildcard
        // or every reconciliation would stage another active binding.
        (target.network === '' || existing.targetNetwork === target.network) &&
        existing.targetContainer === target.container;
      if (existing.status === 'active' && targetUnchanged) return existing;
      if (existing.status === 'active') {
        const name = `route_${routeId.replace(/-/g, '')}_r${existing.generation + 1}_${Date.now().toString(36)}`.slice(
          0,
          64
        );
        const [staged] = await this.db
          .insert(proxyAdditionalSecureLinks)
          .values({
            proxyHostId: host.id,
            name,
            purpose: 'additional_route',
            referenceId: routeId,
            upstreamKind: input.upstreamKind,
            forwardScheme: input.forwardScheme ?? 'http',
            sourceNodeId: host.nodeId,
            dockerNodeId: target.nodeId,
            dockerContainerName: input.upstreamKind === 'docker_container' ? target.container : null,
            dockerComposeProjectId: input.upstreamKind === 'docker_container' ? input.dockerComposeProjectId : null,
            dockerComposeServiceName: input.upstreamKind === 'docker_container' ? input.dockerComposeServiceName : null,
            dockerDeploymentId: input.upstreamKind === 'docker_deployment' ? input.dockerDeploymentId : null,
            dockerContainerPort: input.dockerContainerPort!,
            dockerHostPort: target.targetPort,
            targetNetwork: target.network,
            targetContainer: target.container,
            generation: existing.generation + 1,
            status: 'provisioning',
          })
          .returning();
        if (!staged) {
          throw new AppError(500, 'SECURE_LINK_CREATE_FAILED', 'Managed route replacement was not created');
        }
        try {
          const ready = await this.createAdditionalFromExisting(host, staged.id);
          if (ready.status !== 'active') {
            throw new Error(ready.lastError ?? 'Managed route replacement did not become active');
          }
          return ready;
        } catch (error) {
          await this.deleteManagedRouteBinding(host, staged.id).catch(() => undefined);
          throw error;
        }
      }
      if (existing.status === 'cleanup_pending') {
        await this.deprovisionAdditionalRuntime(existing, host).catch(() => undefined);
      }
      await this.db
        .update(proxyAdditionalSecureLinks)
        .set({
          status: 'provisioning',
          generation: existing.generation + 1,
          sourceNodeId: host.nodeId,
          upstreamKind: input.upstreamKind,
          forwardScheme: input.forwardScheme ?? 'http',
          dockerNodeId: target.nodeId,
          dockerContainerName: input.upstreamKind === 'docker_container' ? target.container : null,
          dockerComposeProjectId: input.upstreamKind === 'docker_container' ? input.dockerComposeProjectId : null,
          dockerComposeServiceName: input.upstreamKind === 'docker_container' ? input.dockerComposeServiceName : null,
          dockerDeploymentId: input.upstreamKind === 'docker_deployment' ? input.dockerDeploymentId : null,
          dockerContainerPort: input.dockerContainerPort!,
          dockerHostPort: target.targetPort,
          targetNetwork: target.network,
          targetContainer: target.container,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(proxyAdditionalSecureLinks.id, existing.id));
      return this.createAdditionalFromExisting(host, existing.id);
    }
    const [created] = await this.db
      .insert(proxyAdditionalSecureLinks)
      .values({
        proxyHostId: host.id,
        name: `route_${routeId.replace(/-/g, '')}`.slice(0, 64),
        purpose: 'additional_route',
        referenceId: routeId,
        upstreamKind: input.upstreamKind,
        forwardScheme: input.forwardScheme ?? 'http',
        sourceNodeId: host.nodeId,
        dockerNodeId: target.nodeId,
        dockerContainerName: input.upstreamKind === 'docker_container' ? target.container : null,
        dockerComposeProjectId: input.upstreamKind === 'docker_container' ? input.dockerComposeProjectId : null,
        dockerComposeServiceName: input.upstreamKind === 'docker_container' ? input.dockerComposeServiceName : null,
        dockerDeploymentId: input.upstreamKind === 'docker_deployment' ? input.dockerDeploymentId : null,
        dockerContainerPort: input.dockerContainerPort!,
        dockerHostPort: target.targetPort,
        targetNetwork: target.network,
        targetContainer: target.container,
      })
      .returning();
    if (!created) throw new AppError(500, 'SECURE_LINK_CREATE_FAILED', 'Managed route binding was not created');
    this.emitAdditionalState(host, created, 'provisioning');
    return this.createAdditionalFromExisting(host, created.id);
  }

  async deleteManagedRoute(host: ProxyHostRow, routeId: string): Promise<void> {
    const bindings = await this.db.query.proxyAdditionalSecureLinks.findMany({
      where: and(
        eq(proxyAdditionalSecureLinks.proxyHostId, host.id),
        eq(proxyAdditionalSecureLinks.purpose, 'additional_route'),
        eq(proxyAdditionalSecureLinks.referenceId, routeId)
      ),
    });
    for (const binding of bindings) await this.deleteManagedRouteBinding(host, binding.id);
  }

  /**
   * Materialize a second source listener for a route move.  The existing
   * binding is deliberately left untouched until the host's destination
   * configuration has been applied successfully.
   */
  async stageManagedRouteMigration(
    host: ProxyHostRow,
    routeId: string,
    targetNodeId: string
  ): Promise<{ previousBindingId: string; stagedBindingId: string; generation: number }> {
    const current = await this.getManagedRoute(routeId);
    if (!current) throw new AppError(409, 'SECURE_LINK_ROUTE_NOT_READY', 'Managed route Secure Link is unavailable');
    if (current.sourceNodeId === targetNodeId) {
      return { previousBindingId: current.id, stagedBindingId: current.id, generation: current.generation };
    }
    const existing = await this.db.query.proxyAdditionalSecureLinks.findFirst({
      where: and(
        eq(proxyAdditionalSecureLinks.proxyHostId, host.id),
        eq(proxyAdditionalSecureLinks.purpose, 'additional_route'),
        eq(proxyAdditionalSecureLinks.referenceId, routeId),
        eq(proxyAdditionalSecureLinks.sourceNodeId, targetNodeId),
        inArray(proxyAdditionalSecureLinks.status, ['provisioning', 'active'])
      ),
    });
    if (existing) {
      const ready =
        existing.status === 'active'
          ? existing
          : await this.createAdditionalFromExisting({ ...host, nodeId: targetNodeId }, existing.id);
      return { previousBindingId: current.id, stagedBindingId: ready.id, generation: ready.generation };
    }
    if (!(await this.nodesSupportSecureLinks([targetNodeId, current.dockerNodeId], targetNodeId))) {
      throw new AppError(
        409,
        'PROXY_SECURE_LINK_UPDATE_REQUIRED',
        'Update both Nginx and Docker daemons before moving this Additional Route'
      );
    }
    const name = `route_${routeId.replace(/-/g, '')}_m${current.generation + 1}`.slice(0, 64);
    const [staged] = await this.db
      .insert(proxyAdditionalSecureLinks)
      .values({
        proxyHostId: host.id,
        name,
        purpose: 'additional_route',
        referenceId: routeId,
        upstreamKind: current.upstreamKind,
        forwardScheme: current.forwardScheme,
        sourceNodeId: targetNodeId,
        dockerNodeId: current.dockerNodeId,
        dockerContainerName: current.dockerContainerName,
        dockerComposeProjectId: current.dockerComposeProjectId,
        dockerComposeServiceName: current.dockerComposeServiceName,
        dockerDeploymentId: current.dockerDeploymentId,
        dockerContainerPort: current.dockerContainerPort,
        dockerHostPort: current.dockerHostPort,
        targetNetwork: current.targetNetwork,
        targetContainer: current.targetContainer,
        generation: current.generation + 1,
        status: 'provisioning',
      })
      .returning();
    if (!staged)
      throw new AppError(500, 'SECURE_LINK_CREATE_FAILED', 'Managed route migration binding was not created');
    try {
      const ready = await this.createAdditionalFromExisting({ ...host, nodeId: targetNodeId }, staged.id);
      if (ready.status !== 'active') {
        throw new Error(ready.lastError ?? 'Managed route migration binding did not become active');
      }
      return { previousBindingId: current.id, stagedBindingId: ready.id, generation: ready.generation };
    } catch (error) {
      await this.deleteManagedRouteBinding(host, staged.id).catch(() => undefined);
      throw error;
    }
  }

  async deleteManagedRouteBinding(host: ProxyHostRow, bindingId: string): Promise<void> {
    const binding = await this.db.query.proxyAdditionalSecureLinks.findFirst({
      where: and(
        eq(proxyAdditionalSecureLinks.id, bindingId),
        eq(proxyAdditionalSecureLinks.proxyHostId, host.id),
        eq(proxyAdditionalSecureLinks.purpose, 'additional_route')
      ),
    });
    if (!binding) return;
    await this.db
      .update(proxyAdditionalSecureLinks)
      .set({ status: 'cleanup_pending', lastError: null, updatedAt: new Date() })
      .where(eq(proxyAdditionalSecureLinks.id, binding.id));
    await this.finishAdditionalDeletion(host, binding);
  }

  async retryAdditional(
    host: ProxyHostRow,
    bindingId: string,
    actorScopes?: string[]
  ): Promise<ProxyAdditionalSecureLinkRow> {
    const binding = await this.requireAdditional(host.id, bindingId, 'user_managed');
    assertNotIncidentSuspended(binding);
    if (!isDockerUpstream(binding.upstreamKind) && !isManagedStorageUpstream(binding.upstreamKind)) {
      throw new AppError(409, 'INVALID_SECURE_LINK_TARGET', 'Secure Link target is not supported');
    }
    const target = await this.resolveAdditionalTarget({ ...binding, upstreamKind: binding.upstreamKind }, actorScopes);
    await this.db
      .update(proxyAdditionalSecureLinks)
      .set({ status: 'cleanup_pending', updatedAt: new Date() })
      .where(eq(proxyAdditionalSecureLinks.id, binding.id));
    await this.deprovisionAdditionalRuntime(binding, host);
    await this.db
      .update(proxyAdditionalSecureLinks)
      .set({
        generation: binding.generation + 1,
        status: 'provisioning',
        dockerNodeId: target.nodeId,
        dockerContainerName: binding.upstreamKind === 'docker_container' ? target.container : null,
        managedStorageId: target.managedStorageId ?? null,
        dockerContainerPort: target.applicationPort,
        dockerHostPort: target.targetPort,
        forwardScheme: target.forwardScheme,
        targetNetwork: target.network,
        targetContainer: target.container,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(proxyAdditionalSecureLinks.id, binding.id));
    return this.createAdditionalFromExisting(host, binding.id);
  }

  /**
   * Points an existing user-managed Additional Secure Link at another target
   * in place. The link keeps its id and name, so `{{additionalSecureLinks.<name>}}`
   * and configs that name its upstream keep working. An active managed storage
   * link moving to another managed storage cluster only moves its relay route:
   * the link stays active throughout and the previous target is restored when
   * the new one does not answer. Every other retarget re-provisions the link
   * with the new target, like retry.
   *
   * `applyRouteConfig` renders the Route config for the switched link (its
   * upstream carries the link scheme). Its failure fails the retarget: an
   * in-place move goes back to the previous cluster, and the config is
   * applied again for it.
   */
  async retargetAdditional(
    host: ProxyHostRow,
    bindingId: string,
    input: Omit<CreateProxyAdditionalSecureLinkInput, 'name'>,
    actorScopes?: string[],
    applyRouteConfig?: (link: ProxyAdditionalSecureLinkRow) => Promise<void>
  ): Promise<ProxyAdditionalSecureLinkRow> {
    const binding = await this.requireAdditional(host.id, bindingId, 'user_managed');
    assertNotIncidentSuspended(binding);
    if (!isDockerUpstream(input.upstreamKind) && !isManagedStorageUpstream(input.upstreamKind)) {
      throw new AppError(409, 'INVALID_SECURE_LINK_TARGET', 'Secure Link target is not supported');
    }
    if (
      isDockerUpstream(input.upstreamKind) &&
      (!input.dockerContainerPort || input.dockerContainerPort < 1 || input.dockerContainerPort > 65535)
    ) {
      throw new AppError(400, 'INVALID_DOCKER_PORT', 'Container port must be between 1 and 65535');
    }
    if (isDockerUpstream(input.upstreamKind) && !this.connectorImage) {
      throw new AppError(503, 'SECURE_LINK_CONNECTOR_UNAVAILABLE', 'Secure Link connector image is not configured');
    }
    const next = { ...input, name: binding.name };
    const target = await this.resolveAdditionalTarget(next, actorScopes);
    const retargetSources = await this.hostSources(host);
    if (
      !(await this.nodesSupportSecureLinks(
        isManagedStorageUpstream(input.upstreamKind) ? retargetSources : [...retargetSources, target.nodeId],
        retargetSources
      ))
    ) {
      throw new AppError(
        409,
        'PROXY_SECURE_LINK_UPDATE_REQUIRED',
        'Update both Nginx and Docker daemons before provisioning this binding'
      );
    }
    if (
      binding.status === 'active' &&
      isManagedStorageUpstream(binding.upstreamKind) &&
      isManagedStorageUpstream(input.upstreamKind)
    ) {
      if (binding.managedStorageId === target.managedStorageId) return binding;
      return this.retargetManagedStorageInPlace(host, binding, next, applyRouteConfig);
    }

    await this.db
      .update(proxyAdditionalSecureLinks)
      .set({ status: 'cleanup_pending', updatedAt: new Date() })
      .where(eq(proxyAdditionalSecureLinks.id, binding.id));
    await this.deprovisionAdditionalRuntime(binding, host);
    const stage = async (db: Pick<DrizzleClient, 'update'>, resolved: typeof target) =>
      db
        .update(proxyAdditionalSecureLinks)
        .set({
          generation: binding.generation + 1,
          status: 'provisioning',
          upstreamKind: input.upstreamKind,
          dockerNodeId: resolved.nodeId,
          dockerContainerName: input.upstreamKind === 'docker_container' ? resolved.container : null,
          dockerComposeProjectId:
            input.upstreamKind === 'docker_container' ? (input.dockerComposeProjectId ?? null) : null,
          dockerComposeServiceName:
            input.upstreamKind === 'docker_container' ? (input.dockerComposeServiceName ?? null) : null,
          dockerDeploymentId: input.upstreamKind === 'docker_deployment' ? (input.dockerDeploymentId ?? null) : null,
          managedStorageId: resolved.managedStorageId ?? null,
          dockerContainerPort: resolved.applicationPort,
          dockerHostPort: resolved.targetPort,
          forwardScheme: resolved.forwardScheme,
          targetNetwork: resolved.network,
          targetContainer: resolved.container,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(proxyAdditionalSecureLinks.id, binding.id));
    if (target.managedStorageId) {
      await this.db.transaction(async (tx) => {
        // Match storage deletion's row lock before it claims external teardown.
        await tx
          .select({ id: managedStorageClusters.id })
          .from(managedStorageClusters)
          .where(eq(managedStorageClusters.id, target.managedStorageId!))
          .for('update');
        await stage(tx, await this.resolveAdditionalTarget(next, actorScopes, true, tx));
      });
    } else {
      await stage(this.db, target);
    }
    const provisioned = await this.createAdditionalFromExisting(host, binding.id);
    if (applyRouteConfig && provisioned.status === 'active') {
      try {
        await applyRouteConfig(provisioned);
      } catch (error) {
        throw new AppError(
          502,
          'SECURE_LINK_ROUTE_CONFIG_FAILED',
          `The Secure Link was retargeted, but the Route config could not be applied: ${
            error instanceof Error ? error.message : String(error)
          }. Retry the retarget.`
        );
      }
    }
    return provisioned;
  }

  private async retargetManagedStorageInPlace(
    host: ProxyHostRow,
    binding: ProxyAdditionalSecureLinkRow,
    next: CreateProxyAdditionalSecureLinkInput,
    applyRouteConfig?: (link: ProxyAdditionalSecureLinkRow) => Promise<void>
  ): Promise<ProxyAdditionalSecureLinkRow> {
    return this.withLinkOperation(binding.id, async () => {
      const previous = await this.requireAdditional(host.id, binding.id);
      if (previous.status !== 'active' || previous.generation !== binding.generation) {
        throw new AppError(409, 'SECURE_LINK_BUSY', 'The Secure Link changed while it was being retargeted; retry');
      }
      const staged = await this.db.transaction(async (tx) => {
        // Match storage deletion's row lock before it claims external teardown.
        await tx
          .select({ id: managedStorageClusters.id })
          .from(managedStorageClusters)
          .where(eq(managedStorageClusters.id, next.managedStorageId!))
          .for('update');
        const resolved = await this.resolveAdditionalTarget(next, undefined, false, tx);
        const [row] = await tx
          .update(proxyAdditionalSecureLinks)
          .set({
            generation: previous.generation + 1,
            managedStorageId: resolved.managedStorageId ?? null,
            dockerNodeId: resolved.nodeId,
            dockerContainerPort: resolved.applicationPort,
            dockerHostPort: resolved.targetPort,
            forwardScheme: resolved.forwardScheme,
            targetNetwork: resolved.network,
            targetContainer: resolved.container,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(proxyAdditionalSecureLinks.id, previous.id),
              eq(proxyAdditionalSecureLinks.generation, previous.generation),
              eq(proxyAdditionalSecureLinks.status, 'active')
            )
          )
          .returning();
        return row;
      });
      if (!staged?.managedStorageId) {
        throw new AppError(409, 'SECURE_LINK_BUSY', 'The Secure Link changed while it was being retargeted; retry');
      }
      try {
        const sources = await this.bindingSources(staged, host);
        await this.relayPolicy.ensureManagedStorageProxySecureLink(
          staged.id,
          staged.managedStorageId,
          relaySources(sources),
          staged.dockerNodeId
        );
        await this.syncSourceNodes(sources);
        await this.probeSources(sources, {
          linkId: staged.id,
          scheme: staged.forwardScheme,
          path: '/',
          timeoutSeconds: 10,
        });
        if (applyRouteConfig) await applyRouteConfig(staged);
        this.emitAdditionalState(host, staged, 'active');
        return staged;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const restored = await this.restoreManagedStorageTarget(host, previous, staged, message);
        if (restored && applyRouteConfig) {
          await applyRouteConfig(restored).catch((applyError) =>
            logger.warn('Route config was not reapplied after a failed Secure Link retarget', {
              bindingId: restored.id,
              error: applyError instanceof Error ? applyError.message : String(applyError),
            })
          );
        }
        throw new AppError(502, 'SECURE_LINK_RETARGET_FAILED', `Secure Link was not retargeted: ${message}`);
      }
    });
  }

  /**
   * Puts a failed in-place retarget back on its previous managed storage
   * cluster; returns the restored link, or null when it could not be restored
   * (the link is then marked failed).
   */
  private async restoreManagedStorageTarget(
    host: ProxyHostRow,
    previous: ProxyAdditionalSecureLinkRow,
    staged: ProxyAdditionalSecureLinkRow,
    reason: string
  ): Promise<ProxyAdditionalSecureLinkRow | null> {
    const [restored] = await this.db
      .update(proxyAdditionalSecureLinks)
      .set({
        generation: staged.generation + 1,
        managedStorageId: previous.managedStorageId,
        dockerNodeId: previous.dockerNodeId,
        dockerContainerPort: previous.dockerContainerPort,
        dockerHostPort: previous.dockerHostPort,
        forwardScheme: previous.forwardScheme,
        targetNetwork: previous.targetNetwork,
        targetContainer: previous.targetContainer,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(proxyAdditionalSecureLinks.id, staged.id), eq(proxyAdditionalSecureLinks.generation, staged.generation))
      )
      .returning();
    if (!restored?.managedStorageId) return null;
    try {
      const sources = await this.bindingSources(restored, host);
      await this.relayPolicy.ensureManagedStorageProxySecureLink(
        restored.id,
        restored.managedStorageId,
        relaySources(sources),
        restored.dockerNodeId
      );
      await this.syncSourceNodes(sources);
      return restored;
    } catch (error) {
      const [failed] = await this.db
        .update(proxyAdditionalSecureLinks)
        .set({
          status: 'failed',
          lastError: `Retarget failed (${reason}) and the previous target could not be restored: ${
            error instanceof Error ? error.message : String(error)
          }`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(proxyAdditionalSecureLinks.id, restored.id),
            eq(proxyAdditionalSecureLinks.generation, restored.generation)
          )
        )
        .returning();
      if (failed) this.emitAdditionalState(host, failed, 'failed');
      return null;
    }
  }

  async deleteAdditional(host: ProxyHostRow, bindingId: string): Promise<void> {
    const binding = await this.requireAdditional(host.id, bindingId, 'user_managed');
    assertNotIncidentSuspended(binding);
    const reference = await this.findAdditionalReference(host, binding);
    if (reference) {
      const routeLabel = host.domainNames?.[0] ?? host.id;
      throw new AppError(
        409,
        'SECURE_LINK_IN_USE',
        `Route ${routeLabel} still references ${reference.text} in its ${reference.location}; remove it there before deleting this binding`
      );
    }
    const [pending] = await this.db
      .update(proxyAdditionalSecureLinks)
      .set({ status: 'cleanup_pending', lastError: null, updatedAt: new Date() })
      .where(eq(proxyAdditionalSecureLinks.id, binding.id))
      .returning();
    this.emitAdditionalState(host, pending ?? binding, 'cleanup_pending');
    void this.finishAdditionalDeletion(host, binding).catch((error) => {
      logger.error('Background additional Secure Link cleanup failed unexpectedly', {
        hostId: host.id,
        bindingId: binding.id,
        error,
      });
    });
  }

  /**
   * A config that still uses the binding, by its template variable or by the rendered upstream
   * name: the route's Advanced config, its raw config while raw mode is on, and the Advanced
   * config of its additional routes (inserted verbatim, so only the upstream name applies there).
   */
  private async findAdditionalReference(
    host: ProxyHostRow,
    binding: ProxyAdditionalSecureLinkRow
  ): Promise<{ text: string; location: string } | null> {
    const patterns = [
      additionalSecureLinkVariablePattern(binding.name),
      additionalSecureLinkUpstreamPattern(binding.id),
    ];
    const advanced = firstReference(host.advancedConfig, patterns);
    if (advanced) return { text: advanced, location: 'Advanced config' };
    const raw = host.rawConfigEnabled ? firstReference(host.rawConfig, patterns) : null;
    if (raw) return { text: raw, location: 'raw config' };
    const routes = await this.db
      .select({ path: proxyAdditionalRoutes.path, advancedConfig: proxyAdditionalRoutes.advancedConfig })
      .from(proxyAdditionalRoutes)
      .where(eq(proxyAdditionalRoutes.proxyHostId, host.id));
    for (const route of routes) {
      const text = firstReference(route.advancedConfig, [additionalSecureLinkUpstreamPattern(binding.id)]);
      if (text) return { text, location: `additional route ${route.path} Advanced config` };
    }
    return null;
  }

  async reconcileAdditionalLifecycle(): Promise<boolean> {
    const pending = await this.db.query.proxyAdditionalSecureLinks.findMany({
      where: inArray(proxyAdditionalSecureLinks.status, ['provisioning', 'active', 'cleanup_pending']),
    });
    let retryNeeded = false;
    for (let binding of pending) {
      if (binding.status === 'active') {
        // Placement-owned members are reconciled by Docker Availability using
        // the placement-local target identity. Re-resolving them through the
        // logical Compose/Deployment target would incorrectly move them back
        // to the origin node.
        if (binding.purpose === 'availability_member') continue;
        if (isManagedStorageUpstream(binding.upstreamKind)) {
          try {
            const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, binding.proxyHostId) });
            if (!host) continue;
            await this.reconcileActiveAdditional(host, binding);
          } catch (error) {
            logger.debug('Managed storage Secure Link reconciliation is still pending', {
              bindingId: binding.id,
              error,
            });
            retryNeeded = true;
          }
          continue;
        }
        if (!binding.dockerComposeProjectId || !binding.dockerComposeServiceName) {
          try {
            const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, binding.proxyHostId) });
            if (!host) continue;
            await this.reconcileActiveAdditional(host, binding);
          } catch (error) {
            logger.debug('Standalone Secure Link reconciliation is still pending', { bindingId: binding.id, error });
            retryNeeded = true;
          }
          continue;
        }
        try {
          if (!isDockerUpstream(binding.upstreamKind)) continue;
          const target = await this.resolveAdditionalTarget({ ...binding, upstreamKind: binding.upstreamKind });
          if (
            binding.dockerNodeId === target.nodeId &&
            binding.dockerContainerName === target.container &&
            binding.targetContainer === target.container &&
            binding.dockerHostPort === target.targetPort
          ) {
            continue;
          }
          const [updated] = await this.db
            .update(proxyAdditionalSecureLinks)
            .set({
              status: 'provisioning',
              generation: binding.generation + 1,
              dockerNodeId: target.nodeId,
              dockerContainerName: target.container,
              dockerHostPort: target.targetPort,
              targetNetwork: target.network,
              targetContainer: target.container,
              lastError: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(proxyAdditionalSecureLinks.id, binding.id),
                eq(proxyAdditionalSecureLinks.generation, binding.generation),
                eq(proxyAdditionalSecureLinks.status, 'active')
              )
            )
            .returning();
          if (!updated) continue;
          binding = updated;
        } catch (error) {
          logger.debug('Compose Secure Link target is not ready for reconciliation', {
            bindingId: binding.id,
            error,
          });
          retryNeeded = true;
          continue;
        }
      }
      const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, binding.proxyHostId) });
      if (!host) continue;
      try {
        if (binding.status === 'cleanup_pending') {
          await this.finishAdditionalDeletion(host, binding);
        } else {
          await this.createAdditionalFromExisting(host, binding.id);
        }
      } catch (error) {
        logger.debug('Additional Secure Link lifecycle reconciliation is still pending', {
          hostId: binding.proxyHostId,
          bindingId: binding.id,
          error,
        });
        retryNeeded = true;
      }
    }
    return retryNeeded;
  }

  async cleanupAdditionalForHost(host: ProxyHostRow): Promise<void> {
    // Host deletion is the one lifecycle operation that must include hidden
    // route-owned bindings.  User-facing list/get/reference methods remain
    // purpose-filtered above.
    const bindings = await this.db.query.proxyAdditionalSecureLinks.findMany({
      where: eq(proxyAdditionalSecureLinks.proxyHostId, host.id),
    });
    if (bindings.length === 0) return;
    await this.db
      .update(proxyAdditionalSecureLinks)
      .set({ status: 'cleanup_pending', lastError: null, updatedAt: new Date() })
      .where(eq(proxyAdditionalSecureLinks.proxyHostId, host.id));
    for (const binding of bindings) {
      // After a provisioning step still running for the link: it would put the relay state back once revoked.
      await this.withLinkOperation(binding.id, () =>
        this.relayPolicy.revokeOwner('proxy_host_secure_link', binding.id)
      );
    }
    const sourceNodes = [
      ...new Set([...bindings.map((binding) => binding.sourceNodeId), ...(await this.hostSources(host))]),
    ];
    const targetNodes = [
      ...new Set(
        bindings.filter((binding) => isDockerUpstream(binding.upstreamKind)).map((binding) => binding.dockerNodeId)
      ),
    ];
    await Promise.all([
      ...sourceNodes.map((nodeId) => this.syncSourceNode(nodeId)),
      ...targetNodes.map((nodeId) => this.syncTargetNode(nodeId)),
    ]);
    await this.db.delete(proxyAdditionalSecureLinks).where(eq(proxyAdditionalSecureLinks.proxyHostId, host.id));
  }

  /**
   * Retire relay state when an offline Nginx source is being permanently
   * removed from Gateway. The unavailable source cannot acknowledge a fresh
   * snapshot, so only target nodes are synchronized and their cleanup is best
   * effort after the central grants have been revoked.
   */
  async abandonOfflineSource(host: ProxyHostRow): Promise<void> {
    const bindings = await this.db.query.proxyAdditionalSecureLinks.findMany({
      where: eq(proxyAdditionalSecureLinks.proxyHostId, host.id),
    });
    if (bindings.length > 0) {
      await this.db
        .update(proxyAdditionalSecureLinks)
        .set({ status: 'cleanup_pending', lastError: null, updatedAt: new Date() })
        .where(eq(proxyAdditionalSecureLinks.proxyHostId, host.id));
    }
    if (host.secureLinkGeneration > 0) {
      await this.db
        .update(proxyHosts)
        .set({ secureLinkStatus: 'cleanup_pending', secureLinkLastError: null, updatedAt: new Date() })
        .where(eq(proxyHosts.id, host.id));
      await this.relayPolicy.revokeOwner('proxy_host_secure_link', host.id, { allowDeferredSnapshot: true });
    }
    for (const binding of bindings) {
      await this.relayPolicy.revokeOwner('proxy_host_secure_link', binding.id, { allowDeferredSnapshot: true });
    }

    const targetNodes = [
      ...(host.dockerNodeId ? [host.dockerNodeId] : []),
      ...bindings.filter((binding) => isDockerUpstream(binding.upstreamKind)).map((binding) => binding.dockerNodeId),
    ];
    const targetResults = await Promise.allSettled(
      [...new Set(targetNodes)].map((nodeId) => this.syncTargetNode(nodeId))
    );
    for (const result of targetResults) {
      if (result.status === 'rejected') {
        logger.warn('Failed to remove abandoned Secure Link state from a target node', {
          hostId: host.id,
          error: result.reason,
        });
      }
    }
    if (bindings.length > 0) {
      await this.db.delete(proxyAdditionalSecureLinks).where(eq(proxyAdditionalSecureLinks.proxyHostId, host.id));
    }
  }

  async assertAdditionalReferences(proxyHostId: string, snippet: string | null | undefined): Promise<void> {
    // Whitespace-tolerant to match what Handlebars actually resolves (see
    // additionalSecureLinkVariablePattern above): `{{ additionalSecureLinks.x }}`
    // renders identically to `{{additionalSecureLinks.x}}`.
    const matches = [...(snippet ?? '').matchAll(/\{\{\s*additionalSecureLinks\.([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g)];
    if (matches.length === 0) return;
    const active = await this.getActiveAdditional(proxyHostId);
    const names = new Set(active.map((binding) => binding.name));
    const missing = [...new Set(matches.map((match) => match[1]!).filter((name) => !names.has(name)))];
    if (missing.length > 0) {
      throw new AppError(
        400,
        'INVALID_SECURE_LINK_REFERENCE',
        `Unknown or inactive additional Secure Link: ${missing.join(', ')}`
      );
    }
  }

  private async createAdditionalFromExisting(
    host: ProxyHostRow,
    bindingId: string
  ): Promise<ProxyAdditionalSecureLinkRow> {
    return this.withLinkOperation(bindingId, async () => {
      let binding = await this.requireAdditional(host.id, bindingId);
      if (binding.status !== 'provisioning') return binding;
      const sources = await this.bindingSources(binding, host);
      // Relay state that already carries this link to the same node may be serving right now: an Availability
      // member whose holder took over while Gateway was away and is re-provisioned when Gateway returns (B-18), or
      // a member re-provisioned in place. A failed attempt must never tear that path down (make-before-break): it
      // keeps the link active with its error for the next attempt, and revokes only relay state it created itself.
      const retained =
        !isManagedStorageUpstream(binding.upstreamKind) &&
        (await this.relayPolicy.hasProxySecureLinkEndpoint?.(binding.id, binding.dockerNodeId)) === true;
      // A link re-provisioned on another node (its target migrated) leaves a binding on the node it reached before.
      const formerNodeId = isManagedStorageUpstream(binding.upstreamKind)
        ? null
        : ((await this.relayPolicy.proxySecureLinkTargetNodeId?.(binding.id)) ?? null);
      try {
        if (isManagedStorageUpstream(binding.upstreamKind)) {
          if (!binding.managedStorageId) throw new Error('Managed storage Secure Link is missing its storage identity');
          await this.relayPolicy.ensureManagedStorageProxySecureLink(
            binding.id,
            binding.managedStorageId,
            relaySources(sources),
            binding.dockerNodeId
          );
        } else {
          // A dormant member's container is created but not started, so the daemon may report it unavailable.
          await this.syncTargetNode(binding.dockerNodeId, undefined, binding.dormant ? undefined : binding.id);
          // Target sync advances the generation itself when the daemon reselects the
          // container network (always, for a binding recorded without one). Adopt that
          // generation; any other concurrent change still fails the guards below.
          const synced = await this.requireAdditional(host.id, binding.id);
          if (isNetworkReselection(binding, synced)) binding = synced;
          await this.relayPolicy.ensureProxySecureLink(binding.id, relaySources(sources), binding.dockerNodeId);
        }
        await this.syncSourceNodes(sources);
        if (!binding.dormant && !binding.incidentSuspendedBy) {
          await this.probeSources(sources, {
            linkId: binding.id,
            scheme: binding.forwardScheme,
            path: '/',
            timeoutSeconds: 10,
          });
        }
        const [active] = await this.db
          .update(proxyAdditionalSecureLinks)
          .set({ status: 'active', lastError: null, updatedAt: new Date() })
          .where(
            and(
              eq(proxyAdditionalSecureLinks.id, binding.id),
              eq(proxyAdditionalSecureLinks.status, 'provisioning'),
              eq(proxyAdditionalSecureLinks.generation, binding.generation)
            )
          )
          .returning();
        if (formerNodeId && formerNodeId !== binding.dockerNodeId) {
          await this.releaseFormerTargetNode(formerNodeId, binding.id);
        }
        if (active) {
          this.emitAdditionalState(host, active, 'active');
          return active;
        }
        return this.requireAdditional(host.id, binding.id);
      } catch (error) {
        const current = await this.requireAdditional(host.id, binding.id);
        if (current.generation !== binding.generation || current.status !== 'provisioning') return current;
        // An Availability member keeps its relay endpoint and route through a failed provision (N-13): the next
        // attempt reuses them, so a lease handoff or a transient failure never re-issues the endpoint and its grants
        // (a new endpoint had to be placed, granted and registered again: 4.6 s). The member is revoked only when it
        // is deleted; while it is failed nginx leaves it out of the upstream. A link whose serving path was retained
        // through a re-provision (B-18) keeps it as well.
        if (!retained && binding.purpose !== 'availability_member') {
          await this.relayPolicy.revokeOwner('proxy_host_secure_link', binding.id).catch(() => undefined);
        }
        const [failed] = await this.db
          .update(proxyAdditionalSecureLinks)
          .set({
            // Active keeps the link in every node's bindings, so the path that serves stays up.
            status: retained ? 'active' : 'failed',
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(proxyAdditionalSecureLinks.id, binding.id),
              eq(proxyAdditionalSecureLinks.status, 'provisioning'),
              eq(proxyAdditionalSecureLinks.generation, binding.generation)
            )
          )
          .returning();
        await Promise.allSettled([
          this.syncSourceNodes(sources),
          ...(isManagedStorageUpstream(binding.upstreamKind) ? [] : [this.syncTargetNode(binding.dockerNodeId)]),
        ]);
        if (failed) {
          this.emitAdditionalState(host, failed, retained ? 'active' : 'failed');
          return failed;
        }
        return this.requireAdditional(host.id, binding.id);
      }
    });
  }

  private async reconcileActiveAdditional(host: ProxyHostRow, binding: ProxyAdditionalSecureLinkRow): Promise<void> {
    const sources = await this.bindingSources(binding, host);
    if (isManagedStorageUpstream(binding.upstreamKind)) {
      if (!binding.managedStorageId) throw new Error('Managed storage Secure Link is missing its storage identity');
      const target = await this.resolveAdditionalTarget(
        { name: binding.name, upstreamKind: 'managed_storage', managedStorageId: binding.managedStorageId },
        undefined,
        false
      );
      if (binding.dockerNodeId !== target.nodeId || binding.forwardScheme !== target.forwardScheme) {
        const [staged] = await this.db
          .update(proxyAdditionalSecureLinks)
          .set({
            generation: binding.generation + 1,
            status: 'provisioning',
            dockerNodeId: target.nodeId,
            dockerContainerPort: target.applicationPort,
            dockerHostPort: target.targetPort,
            forwardScheme: target.forwardScheme,
            targetNetwork: target.network,
            targetContainer: target.container,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(proxyAdditionalSecureLinks.id, binding.id),
              eq(proxyAdditionalSecureLinks.generation, binding.generation),
              eq(proxyAdditionalSecureLinks.status, 'active')
            )
          )
          .returning();
        if (staged) await this.createAdditionalFromExisting(host, staged.id);
        return;
      }
      await this.relayPolicy.ensureManagedStorageProxySecureLink(
        binding.id,
        binding.managedStorageId,
        relaySources(sources),
        binding.dockerNodeId
      );
      await this.syncSourceNodes(sources);
      return;
    }
    await this.syncTargetNode(binding.dockerNodeId, undefined, binding.id);
    await this.relayPolicy.ensureProxySecureLink(binding.id, relaySources(sources), binding.dockerNodeId);
    await this.syncSourceNodes(sources);
  }

  private async finishAdditionalDeletion(host: ProxyHostRow, binding: ProxyAdditionalSecureLinkRow): Promise<void> {
    return this.withLinkOperation(binding.id, async () => {
      const current = await this.db.query.proxyAdditionalSecureLinks.findFirst({
        where: and(eq(proxyAdditionalSecureLinks.id, binding.id), eq(proxyAdditionalSecureLinks.proxyHostId, host.id)),
      });
      if (!current) return;
      if (current.status !== 'cleanup_pending') return;
      try {
        await this.deprovisionAdditionalRuntime(current, host);
        await this.db.delete(proxyAdditionalSecureLinks).where(eq(proxyAdditionalSecureLinks.id, current.id));
        this.emitAdditionalState(host, current, 'deleted');
      } catch (error) {
        const [pending] = await this.db
          .update(proxyAdditionalSecureLinks)
          .set({
            status: 'cleanup_pending',
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          })
          .where(eq(proxyAdditionalSecureLinks.id, current.id))
          .returning();
        this.emitAdditionalState(host, pending ?? current, 'cleanup_failed');
        throw error;
      }
    });
  }

  private async deprovisionAdditionalRuntime(
    binding: ProxyAdditionalSecureLinkRow,
    host?: Pick<ProxyHostRow, 'nodeId' | 'ingressGroupId'>
  ): Promise<void> {
    const sources = await this.bindingSources(binding, host);
    await this.relayPolicy.revokeOwner('proxy_host_secure_link', binding.id, { allowDeferredSnapshot: true });
    await Promise.allSettled([
      this.syncSourceNodes(sources),
      ...(isManagedStorageUpstream(binding.upstreamKind) ? [] : [this.syncTargetNode(binding.dockerNodeId)]),
    ]);
  }

  private async requireAdditional(
    proxyHostId: string,
    bindingId: string,
    purpose?: ProxyAdditionalSecureLinkPurpose
  ): Promise<ProxyAdditionalSecureLinkRow> {
    const binding = await this.db.query.proxyAdditionalSecureLinks.findFirst({
      where: and(
        eq(proxyAdditionalSecureLinks.id, bindingId),
        eq(proxyAdditionalSecureLinks.proxyHostId, proxyHostId),
        purpose ? eq(proxyAdditionalSecureLinks.purpose, purpose) : undefined
      ),
    });
    if (!binding) throw new AppError(404, 'SECURE_LINK_BINDING_NOT_FOUND', 'Additional Secure Link binding not found');
    return binding;
  }

  private emitAdditionalState(host: ProxyHostRow, binding: ProxyAdditionalSecureLinkRow, action: string): void {
    const payload = { id: host.id, bindingId: binding.id, name: binding.name, action };
    this.eventBus?.publish('proxy.secure-link.changed', payload);
    this.eventBus?.publish('proxy.host.changed', {
      ...payload,
      action: 'additional_secure_link_changed',
      bindingAction: action,
    });
  }

  async prepare(
    host: ProxyHostRow,
    requireCapabilities: boolean,
    force = false,
    phase: 'provisioning' | 'reconciliation' = 'provisioning'
  ): Promise<ProxyHostRow> {
    try {
      const result = await this.withLinkOperation(host.id, async () => {
        // Reconciliation can be queued from both daemon reconnect and the
        // background sweep. Refresh only after acquiring the per-link lock so
        // a queued operation cannot restart a cutover from its stale snapshot.
        const lockedHost =
          phase === 'reconciliation'
            ? ((await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, host.id) })) ?? host)
            : host;
        return this.prepareLocked(lockedHost, requireCapabilities, force);
      });
      this.emitLinkState(result, phase, result.secureLinkLastError ? 'failed' : 'ready', result.secureLinkLastError);
      return result;
    } catch (error) {
      this.emitLinkState(host, phase, 'failed', error);
      throw error;
    }
  }

  private async prepareLocked(host: ProxyHostRow, requireCapabilities: boolean, force: boolean): Promise<ProxyHostRow> {
    // A raw-mode Route (type raw, or a proxy with raw config) keeps its Docker target and Secure Link.
    if ((host.type !== 'proxy' && host.type !== 'raw') || !isDockerUpstream(host.upstreamKind) || !host.nodeId) {
      return host;
    }
    const target = await this.resolveTarget(host);
    // A route on an ingress group has a source (relay route, grants, listener) on every member.
    const sources = await this.hostSources(host);
    const supported = await this.nodesSupportSecureLinks(
      [...sources, target.nodeId],
      host.type === 'raw' || host.rawConfigEnabled ? undefined : sources
    );
    if (!supported) {
      if (requireCapabilities) {
        throw new AppError(
          409,
          'PROXY_SECURE_LINK_UPDATE_REQUIRED',
          'Update both Nginx and Docker daemons before creating this Docker proxy link'
        );
      }
      return host;
    }
    if (!this.connectorImage) {
      throw new AppError(503, 'SECURE_LINK_CONNECTOR_UNAVAILABLE', 'Secure Link connector image is not configured');
    }

    const changed =
      host.dockerNodeId !== target.nodeId ||
      host.secureLinkTargetNetwork !== target.network ||
      host.secureLinkTargetContainer !== target.container ||
      host.secureLinkTargetHost !== null ||
      host.dockerContainerPort !== target.applicationPort ||
      host.dockerHostPort !== target.targetPort;
    const cutoverCommitted = host.secureLinkMigratedAt != null;
    // The relay endpoint names the node the link reaches. When the Route's target runs on another node now (its
    // container or deployment migrated, or the Route names the same container on another node), the link follows it
    // even though nothing else about the target changed.
    const linkedNodeId = cutoverCommitted
      ? ((await this.relayPolicy.proxySecureLinkTargetNodeId?.(host.id)) ?? null)
      : null;
    const moved = linkedNodeId !== null && linkedNodeId !== target.nodeId;
    // Another caller may already have prepared and probed this exact generation
    // and be between prepare() and commitCutover(). Keep that durable hand-off
    // intact instead of reverting it to provisioning from a second reconciler.
    if (!cutoverCommitted && host.secureLinkStatus === 'cutover_ready' && !changed) return host;
    const activeUpdate = cutoverCommitted && (changed || host.secureLinkStatus === 'updating');
    if (cutoverCommitted && host.secureLinkStatus === 'active' && !changed) {
      if (!force && !moved) return host;
      try {
        // A moved link is re-pointed in place: the target node gets its binding first, then the relay endpoint
        // moves to it (the former node's grant is withdrawn), and the source listener and Nginx config stay as
        // they are.
        await this.syncTargetNode(target.nodeId, undefined, host.id);
        await this.relayPolicy.ensureProxySecureLink(host.id, relaySources(sources), target.nodeId);
        await this.syncSourceNodes(sources);
        const probe = await this.probeSources(sources, {
          linkId: host.id,
          scheme: host.forwardScheme ?? 'http',
          path: host.healthCheckUrl || '/',
          timeoutSeconds: 10,
        });
        if (!probe.httpStatus) throw new Error(probe.error || 'Secure Link end-to-end probe failed');
        if (moved) await this.releaseFormerTargetNode(linkedNodeId!, host.id);
        const [refreshed] = await this.db
          .update(proxyHosts)
          .set({ secureLinkLastError: null, updatedAt: new Date() })
          .where(and(eq(proxyHosts.id, host.id), eq(proxyHosts.secureLinkGeneration, host.secureLinkGeneration)))
          .returning();
        return refreshed ?? host;
      } catch (error) {
        await this.markCutoverError(host.id, error);
        throw error;
      }
    }
    const generation =
      host.secureLinkGeneration < 1
        ? 1
        : changed || host.secureLinkStatus === 'cleanup_pending'
          ? host.secureLinkGeneration + 1
          : host.secureLinkGeneration;
    await this.db
      .update(proxyHosts)
      .set({
        dockerNodeId: target.nodeId,
        dockerHostPort: target.targetPort,
        dockerProtocol: 'tcp',
        secureLinkGeneration: generation,
        secureLinkStatus: activeUpdate ? 'updating' : 'provisioning',
        secureLinkLastError: null,
        secureLinkTargetNetwork: target.network,
        secureLinkTargetContainer: target.container,
        secureLinkTargetHost: null,
        updatedAt: new Date(),
      })
      .where(eq(proxyHosts.id, host.id));

    try {
      if (activeUpdate) {
        // Close the production path before mutating the in-place target binding.
        // The replacement source listener is intentionally unreachable from the
        // currently loaded Nginx config until probe and atomic config cutover.
        await this.relayPolicy.revokeOwner('proxy_host_secure_link', host.id);
        await this.syncSourceNodes(sources, host.id);
      }
      await this.syncTargetNode(target.nodeId, undefined, host.id);
      await this.relayPolicy.ensureProxySecureLink(host.id, relaySources(sources), target.nodeId);
      if (!activeUpdate) await this.syncSourceNodes(sources);
      const probe = await this.probeSources(sources, {
        linkId: host.id,
        scheme: host.forwardScheme ?? 'http',
        path: host.healthCheckUrl || '/',
        timeoutSeconds: 10,
      });
      if (!probe.httpStatus) throw new Error(probe.error || 'Secure Link end-to-end probe failed');
      if (moved) await this.releaseFormerTargetNode(linkedNodeId!, host.id);
      await this.db
        .update(proxyHosts)
        .set({ secureLinkStatus: 'cutover_ready', secureLinkLastError: null, updatedAt: new Date() })
        .where(and(eq(proxyHosts.id, host.id), eq(proxyHosts.secureLinkGeneration, generation)));
      const refreshed = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, host.id) });
      if (!refreshed) throw new Error('Secure Link state disappeared after source synchronization');
      return refreshed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!cutoverCommitted) {
        await this.relayPolicy.revokeOwner('proxy_host_secure_link', host.id).catch(() => undefined);
      }
      await this.db
        .update(proxyHosts)
        .set({
          secureLinkStatus: cutoverCommitted ? (activeUpdate ? 'updating' : 'provisioning') : 'legacy',
          ...(cutoverCommitted
            ? {}
            : {
                forwardHost: host.forwardHost,
                forwardPort: host.forwardPort,
                dockerNodeId: host.dockerNodeId,
                dockerHostPort: host.dockerHostPort,
                dockerProtocol: host.dockerProtocol,
                secureLinkGeneration: 0,
                secureLinkTargetNetwork: host.secureLinkTargetNetwork,
                secureLinkTargetContainer: host.secureLinkTargetContainer,
                secureLinkTargetHost: host.secureLinkTargetHost,
                secureLinkListenerPort: host.secureLinkListenerPort,
                secureLinkConnectorPort: host.secureLinkConnectorPort,
              }),
          secureLinkLastError: message,
          updatedAt: new Date(),
        })
        .where(eq(proxyHosts.id, host.id));
      if (!cutoverCommitted) {
        await Promise.allSettled([this.syncSourceNodes(sources), this.syncTargetNode(target.nodeId)]);
      }
      if (requireCapabilities || cutoverCommitted) throw error;
      const restored = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, host.id) });
      return restored ?? host;
    }
  }

  async activate(hostId: string): Promise<void> {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
    if (!host) throw new Error('Secure Link state disappeared before activation');

    if (host.nodeId && isDockerUpstream(host.upstreamKind) && host.secureLinkGeneration > 0) {
      // The delivered Nginx config now owns the cutover. Reconcile the source
      // listener before making activation durable: a generated config uses the
      // Unix socket, so the daemon drops the temporary loopback TCP listener.
      // Raw/user-owned configs keep TCP because their upstream may still
      // reference the durable port.
      const generated = host.type === 'proxy' && !host.rawConfigEnabled;
      await this.syncSourceNodes(await this.hostSources(host), undefined, generated ? host.id : undefined);
    }

    await this.db
      .update(proxyHosts)
      .set({
        secureLinkStatus: 'active',
        secureLinkLastError: null,
        updatedAt: new Date(),
      })
      .where(eq(proxyHosts.id, hostId));
  }

  async commitCutover(hostId: string): Promise<ProxyHostRow> {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
    if (!host || host.secureLinkGeneration < 1) throw new Error('Secure Link is not prepared for cutover');
    if (!host.nodeId) throw new Error('Secure Link source node is unavailable');
    if (!host.secureLinkMigratedAt) {
      // A staged assignment becoming active changes the source grant bundle and
      // rebuilds its relay lanes asynchronously. Serialize the final source sync
      // and prove the new lanes before making the cutover durable; otherwise the
      // immediate Nginx config probe can race that rebuild and reset a healthy
      // Secure Link.
      const sources = await this.hostSources(host);
      await this.syncSourceNodes(sources);
      const probe = await this.probeSources(sources, {
        linkId: host.id,
        scheme: host.forwardScheme ?? 'http',
        path: host.healthCheckUrl || '/',
        timeoutSeconds: 10,
      });
      if (!probe.httpStatus) throw new Error(probe.error || 'Secure Link cutover probe failed');

      const [committed] = await this.db
        .update(proxyHosts)
        .set({ secureLinkMigratedAt: new Date(), updatedAt: new Date() })
        .where(eq(proxyHosts.id, hostId))
        .returning();
      if (!committed) throw new Error('Secure Link cutover state was not persisted');
    }

    // Listener reconciliation and cutover persistence use separate writes and
    // may overlap another create/reconcile caller. Never render Nginx from the
    // pre-cutover row (whose durable Docker endpoint is the safety sentinel).
    const authoritative = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
    if (!authoritative?.secureLinkMigratedAt) throw new Error('Secure Link cutover state was not persisted');
    return authoritative;
  }

  async markCutoverError(hostId: string, error: unknown): Promise<void> {
    await this.db
      .update(proxyHosts)
      .set({ secureLinkLastError: error instanceof Error ? error.message : String(error), updatedAt: new Date() })
      .where(eq(proxyHosts.id, hostId));
  }

  async cleanup(host: ProxyHostRow): Promise<void> {
    await this.withLinkOperation(host.id, () => this.cleanupLocked(host));
  }

  /**
   * Relay state of a deleted Route that its cleanup could not reach: a link revoked by an attempt that failed, or
   * left by an earlier release. The periodic relay policy reconciliation removes it when this fails.
   */
  async releaseOrphanedRelayState(): Promise<void> {
    await this.relayPolicy.removeOrphanedState().catch((error) =>
      logger.warn('Relay state left by a deleted Route is removed by the next relay policy reconciliation', {
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }

  private async cleanupLocked(host: ProxyHostRow): Promise<void> {
    if (host.secureLinkGeneration < 1) return;
    const before = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, host.id) });
    if (!before || before.secureLinkGeneration > host.secureLinkGeneration) return;
    const cleanupGeneration = before.secureLinkGeneration;
    await this.db
      .update(proxyHosts)
      .set({
        // A Docker-to-manual update clears the public Docker reference before
        // teardown. Retain the former node only while cleanup is pending so a
        // retry after failure or Gateway restart can still remove its binding.
        dockerNodeId: host.dockerNodeId,
        secureLinkStatus: 'cleanup_pending',
        secureLinkLastError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(proxyHosts.id, host.id), eq(proxyHosts.secureLinkGeneration, cleanupGeneration)));
    try {
      await this.relayPolicy.revokeOwner('proxy_host_secure_link', host.id);
      await Promise.all([
        this.syncSourceNodes(await this.hostSources(host)),
        host.dockerNodeId ? this.syncTargetNode(host.dockerNodeId) : Promise.resolve(),
      ]);
      const current = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, host.id) });
      await this.db
        .update(proxyHosts)
        .set({
          ...(!current || !isDockerUpstream(current.upstreamKind) ? { dockerNodeId: null } : {}),
          ...(!current || !isDockerUpstream(current.upstreamKind) || current.type === 'raw' || current.rawConfigEnabled
            ? { secureLinkMigratedAt: null }
            : {}),
          secureLinkGeneration: 0,
          secureLinkStatus: 'legacy',
          secureLinkLastError: null,
          secureLinkListenerPort: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(proxyHosts.id, host.id),
            eq(proxyHosts.secureLinkGeneration, cleanupGeneration),
            eq(proxyHosts.secureLinkStatus, 'cleanup_pending')
          )
        );
    } catch (error) {
      await this.db
        .update(proxyHosts)
        .set({
          secureLinkStatus: 'cleanup_pending',
          secureLinkLastError: error instanceof Error ? error.message : String(error),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(proxyHosts.id, host.id),
            eq(proxyHosts.secureLinkGeneration, cleanupGeneration),
            eq(proxyHosts.secureLinkStatus, 'cleanup_pending')
          )
        );
      throw error;
    }
  }

  async reconcileExisting(host: ProxyHostRow): Promise<ProxyHostRow> {
    return this.prepare(host, false, true, 'reconciliation');
  }

  /**
   * Whether a committed Route link still reaches another Docker node than the one its target runs on: the target
   * migrated, or the Route was pointed at the same container on another node. The reconciliation re-points it.
   */
  async targetMoved(host: ProxyHostRow): Promise<boolean> {
    if (host.secureLinkGeneration < 1 || !host.secureLinkMigratedAt || !isDockerUpstream(host.upstreamKind)) {
      return false;
    }
    const linkedNodeId = await this.relayPolicy.proxySecureLinkTargetNodeId?.(host.id);
    if (!linkedNodeId) return false;
    const target = await this.resolveTarget(host).catch(() => null);
    return target !== null && target.nodeId !== linkedNodeId;
  }

  /**
   * Drops the connector binding a link left on the Docker node it reached before it moved. A former node that cannot
   * be reached now drops it when it reconnects and its target bindings are reconciled.
   */
  private async releaseFormerTargetNode(nodeId: string, linkId: string): Promise<void> {
    await this.syncTargetNode(nodeId).catch((error) =>
      logger.warn('A moved Secure Link keeps a binding on its former Docker node until that node reconciles', {
        linkId,
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }

  async reconcileTargetNode(nodeId: string): Promise<void> {
    await this.syncTargetNode(nodeId);
  }

  /** The container links each Docker node serves as a target, sent with its proxy Secure Link bindings. */
  setContainerLinkTargets(provider: ContainerLinkTargetProvider): void {
    this.containerLinkTargets = provider;
  }

  async releaseTargetNetwork(nodeId: string, networkName: string): Promise<void> {
    await this.syncTargetNode(nodeId, networkName);
  }

  async reconcileSourceNode(nodeId: string): Promise<void> {
    // A daemon without Secure Link support has no source bindings to reconcile.
    if (!(await this.nodesSupportSecureLinks([nodeId]))) return;
    await this.syncSourceNode(nodeId);
  }

  private async withLinkOperation<T>(linkId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.linkOperations.get(linkId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.linkOperations.set(linkId, current);
    try {
      return await current;
    } finally {
      if (this.linkOperations.get(linkId) === current) this.linkOperations.delete(linkId);
    }
  }

  private emitLinkState(
    host: ProxyHostRow,
    phase: 'provisioning' | 'reconciliation',
    state: 'ready' | 'failed',
    error?: unknown
  ): void {
    const payload = {
      id: host.id,
      domain: host.domainNames?.[0] ?? host.id,
      phase,
      state,
      failureCode: state === 'failed' ? this.failureCode(error) : null,
    };
    this.eventBus?.publish('proxy.secure-link.changed', payload);
    // Proxy host cache consumers use this established resource channel.
    this.eventBus?.publish('proxy.host.changed', { ...payload, action: 'secure_link_changed' });
  }

  private failureCode(error: unknown): string {
    if (error instanceof AppError) return error.code;
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (/timeout|timed out/i.test(message)) return 'timeout';
    if (/offline|unavailable|disconnect/i.test(message)) return 'node_unavailable';
    if (/probe|status|response/i.test(message)) return 'probe_failed';
    return 'secure_link_failed';
  }

  private async nodesSupportSecureLinks(
    nodeIds: string[],
    socketOnlySourceNodeIds?: string | readonly string[]
  ): Promise<boolean> {
    const socketOnly = new Set(
      socketOnlySourceNodeIds === undefined
        ? []
        : typeof socketOnlySourceNodeIds === 'string'
          ? [socketOnlySourceNodeIds]
          : socketOnlySourceNodeIds
    );
    const unique = [...new Set(nodeIds)];
    const rows = await this.db
      .select({ id: nodes.id, capabilities: nodes.capabilities })
      .from(nodes)
      .where(inArray(nodes.id, unique));
    if (rows.length !== unique.length) return false;
    return rows.every((row) => {
      const reported = (row.capabilities as Record<string, unknown> | null)?.capabilities;
      return (
        Array.isArray(reported) &&
        reported.includes('proxy_secure_links_v1') &&
        (!socketOnly.has(row.id) || reported.includes(NGINX_SECURE_LINK_SOCKET_ONLY_CAPABILITY))
      );
    });
  }

  private async resolveTarget(host: ProxyHostRow): Promise<{
    nodeId: string;
    network: string;
    container: string;
    applicationPort: number;
    targetPort: number;
  }> {
    if (!host.dockerContainerPort) throw new AppError(400, 'INVALID_DOCKER_PORT', 'Container port is required');
    if (host.upstreamKind === 'docker_container') {
      if (!host.dockerNodeId || !host.dockerContainerName) {
        throw new AppError(400, 'INVALID_DOCKER_TARGET', 'Docker node and container are required');
      }
      return {
        nodeId: host.dockerNodeId,
        network: host.secureLinkTargetNetwork ?? '',
        container: host.dockerContainerName,
        applicationPort: host.dockerContainerPort,
        targetPort: host.dockerContainerPort,
      };
    }
    if (!host.dockerDeploymentId) throw new AppError(400, 'INVALID_DOCKER_TARGET', 'Docker deployment is required');
    const [deployment] = await this.db
      .select({
        nodeId: dockerDeployments.nodeId,
        networkName: dockerDeployments.networkName,
        routerName: dockerDeployments.routerName,
      })
      .from(dockerDeployments)
      .where(eq(dockerDeployments.id, host.dockerDeploymentId))
      .limit(1);
    if (!deployment) throw new AppError(404, 'DOCKER_DEPLOYMENT_NOT_FOUND', 'Docker deployment not found');
    const routes = await this.db
      .select({ hostPort: dockerDeploymentRoutes.hostPort })
      .from(dockerDeploymentRoutes)
      .where(
        and(
          eq(dockerDeploymentRoutes.deploymentId, host.dockerDeploymentId),
          eq(dockerDeploymentRoutes.containerPort, host.dockerContainerPort)
        )
      );
    if (routes.length !== 1)
      throw new AppError(409, 'DOCKER_PORT_AMBIGUOUS', 'Deployment application port is unavailable');
    return {
      nodeId: deployment.nodeId,
      network: deployment.networkName,
      container: deployment.routerName,
      applicationPort: host.dockerContainerPort,
      targetPort: routes[0]!.hostPort,
    };
  }

  /**
   * The Docker access a Route upstream needs: the caller must be able to see
   * the container or deployment a link sends the Route's traffic to (Compose
   * targets get the same check while they are resolved). Internal
   * reconciliation passes no scopes: it re-resolves a target a user already
   * chose.
   */
  private async assertDockerTargetAccess(input: CreateProxyAdditionalSecureLinkInput, actorScopes?: string[]) {
    if (!actorScopes) return;
    // Broad Docker view (or node-wide, for a container) covers every target
    // there, so it needs no per-container identity from the snapshot cache: a
    // container the cache has not seen yet is not refused for such a caller.
    if (hasScope(actorScopes, 'docker:containers:view')) return;
    if (
      input.upstreamKind === 'docker_container' &&
      input.dockerNodeId &&
      hasScope(actorScopes, `docker:containers:view:${input.dockerNodeId}`)
    )
      return;
    if (!this.dockerUpstreams) {
      throw new AppError(503, 'DOCKER_UPSTREAMS_UNAVAILABLE', 'Docker upstream resolution is unavailable');
    }
    await this.dockerUpstreams.resolve(
      {
        upstreamKind: input.upstreamKind,
        dockerNodeId: input.dockerNodeId,
        dockerContainerName: input.dockerContainerName,
        dockerDeploymentId: input.dockerDeploymentId,
        dockerContainerPort: input.dockerContainerPort,
        dockerProtocol: 'tcp',
      },
      { actorScopes, refreshOnMiss: true }
    );
  }

  private async resolveAdditionalTarget(
    input: CreateProxyAdditionalSecureLinkInput,
    actorScopes?: string[],
    enforceStorageScope = true,
    db: Pick<DrizzleClient, 'select'> = this.db
  ): Promise<{
    nodeId: string;
    network: string;
    container: string;
    applicationPort: number;
    targetPort: number;
    forwardScheme: 'http' | 'https';
    managedStorageId?: string;
  }> {
    if (input.upstreamKind === 'managed_storage') {
      if (!input.managedStorageId) {
        throw new AppError(400, 'INVALID_MANAGED_STORAGE_TARGET', 'Managed storage is required');
      }
      const [storage] = await db
        .select({
          id: managedStorageClusters.id,
          nodeId: managedStorageClusters.nodeId,
          status: managedStorageClusters.status,
          pendingOperation: managedStorageClusters.pendingOperation,
          tlsEnabled: managedStorageClusters.tlsEnabled,
          objectStorageConnectionId: managedStorageClusters.objectStorageConnectionId,
        })
        .from(managedStorageClusters)
        .where(eq(managedStorageClusters.id, input.managedStorageId))
        .limit(1);
      if (!storage) throw new AppError(404, 'MANAGED_STORAGE_NOT_FOUND', 'Managed storage cluster not found');
      if (
        enforceStorageScope &&
        (!storage.objectStorageConnectionId ||
          !hasScope(actorScopes ?? [], `storage:view:${storage.objectStorageConnectionId}`))
      ) {
        throw new AppError(403, 'FORBIDDEN', 'Viewing the selected managed storage is required');
      }
      if (storage.status !== 'ready' || storage.pendingOperation) {
        throw new AppError(409, 'MANAGED_STORAGE_NOT_READY', 'Managed storage is not ready for Secure Links');
      }
      return {
        nodeId: storage.nodeId,
        network: '',
        container: `managed-storage-${storage.id}`,
        applicationPort: 9000,
        targetPort: 9000,
        forwardScheme: storage.tlsEnabled ? 'https' : 'http',
        managedStorageId: storage.id,
      };
    }
    if (input.upstreamKind === 'docker_container') {
      if (!input.dockerNodeId) {
        throw new AppError(400, 'INVALID_DOCKER_TARGET', 'Docker node and container are required');
      }
      if (input.dockerComposeProjectId || input.dockerComposeServiceName) {
        if (!this.dockerUpstreams) {
          throw new AppError(503, 'DOCKER_UPSTREAMS_UNAVAILABLE', 'Docker upstream resolution is unavailable');
        }
        const resolved = await this.dockerUpstreams.resolve(
          {
            upstreamKind: 'docker_container',
            dockerNodeId: input.dockerNodeId,
            dockerContainerName: input.dockerContainerName,
            dockerComposeProjectId: input.dockerComposeProjectId,
            dockerComposeServiceName: input.dockerComposeServiceName,
            dockerContainerPort: input.dockerContainerPort!,
            dockerProtocol: 'tcp',
          },
          { actorScopes, requireAvailable: true, refreshOnMiss: true }
        );
        return {
          nodeId: resolved.dockerNodeId!,
          network: '',
          container: resolved.dockerContainerName!,
          applicationPort: input.dockerContainerPort!,
          targetPort: resolved.dockerContainerPort,
          forwardScheme: input.forwardScheme ?? 'http',
        };
      }
      if (!input.dockerContainerName) {
        throw new AppError(400, 'INVALID_DOCKER_TARGET', 'Docker node and container are required');
      }
      await this.assertDockerTargetAccess(input, actorScopes);
      return {
        nodeId: input.dockerNodeId,
        network: '',
        container: input.dockerContainerName,
        applicationPort: input.dockerContainerPort!,
        targetPort: input.dockerContainerPort!,
        forwardScheme: input.forwardScheme ?? 'http',
      };
    }
    if (!input.dockerDeploymentId) {
      throw new AppError(400, 'INVALID_DOCKER_TARGET', 'Docker deployment is required');
    }
    await this.assertDockerTargetAccess(input, actorScopes);
    const [deployment] = await this.db
      .select({
        nodeId: dockerDeployments.nodeId,
        networkName: dockerDeployments.networkName,
        routerName: dockerDeployments.routerName,
      })
      .from(dockerDeployments)
      .where(eq(dockerDeployments.id, input.dockerDeploymentId))
      .limit(1);
    if (!deployment) throw new AppError(404, 'DOCKER_DEPLOYMENT_NOT_FOUND', 'Docker deployment not found');
    const routes = await this.db
      .select({ hostPort: dockerDeploymentRoutes.hostPort })
      .from(dockerDeploymentRoutes)
      .where(
        and(
          eq(dockerDeploymentRoutes.deploymentId, input.dockerDeploymentId),
          eq(dockerDeploymentRoutes.containerPort, input.dockerContainerPort!)
        )
      );
    if (routes.length !== 1) {
      throw new AppError(409, 'DOCKER_PORT_AMBIGUOUS', 'Deployment application port is unavailable');
    }
    return {
      nodeId: deployment.nodeId,
      network: deployment.networkName,
      container: deployment.routerName,
      applicationPort: input.dockerContainerPort!,
      targetPort: routes[0]!.hostPort,
      forwardScheme: input.forwardScheme ?? 'http',
    };
  }

  /** Source nginx nodes of a route's primary link: every member of its ingress group, else its node. */
  private async hostSources(host: Pick<ProxyHostRow, 'nodeId' | 'ingressGroupId'>): Promise<string[]> {
    return resolveIngressNodes(this.db, host);
  }

  /** Source nginx nodes of an additional link: every member of its route's ingress group, else its source. */
  private async bindingSources(
    binding: ProxyAdditionalSecureLinkRow,
    host?: Pick<ProxyHostRow, 'nodeId' | 'ingressGroupId'> | null
  ): Promise<string[]> {
    const owner =
      host ??
      (await this.db.query?.proxyHosts?.findFirst({
        where: eq(proxyHosts.id, binding.proxyHostId),
        columns: { nodeId: true, ingressGroupId: true },
      }));
    return secureLinkSourceNodeIds(this.db, owner, binding.sourceNodeId);
  }

  private async syncSourceNodes(
    nodeIds: readonly string[],
    rotateLinkId?: string,
    forceSocketOnlyLinkId?: string
  ): Promise<void> {
    const extra =
      forceSocketOnlyLinkId !== undefined
        ? [rotateLinkId, forceSocketOnlyLinkId]
        : rotateLinkId !== undefined
          ? [rotateLinkId]
          : [];
    const sources = [...new Set(nodeIds)];
    // A member of an ingress group that is not connected takes its source bindings in its reconnect resync, as
    // probeSources assumes: it must not fail a change of the group's route on the members that are online (IG-1).
    // One source (a single-node route) fails as before.
    const group = sources.length > 1;
    await Promise.all(
      sources.map(async (nodeId) => {
        if (group && !this.dispatch.isNodeConnected(nodeId)) return;
        try {
          await (this.syncSourceNode as (nodeId: string, ...rest: Array<string | undefined>) => Promise<void>)(
            nodeId,
            ...extra
          );
        } catch (error) {
          if (group && isNodeNotConnectedError(error)) return;
          throw error;
        }
      })
    );
  }

  /**
   * End-to-end probe through every connected source. A group route's link must work on each member that is
   * connected; members that are offline are probed after they reconnect (their source sync runs then). With no
   * source connected the first one is probed, which fails like a single-node link on an offline node.
   */
  private async probeSources(
    nodeIds: readonly string[],
    input: Parameters<NodeDispatchService['probeProxySecureLink']>[1]
  ): Promise<Awaited<ReturnType<NodeDispatchService['probeProxySecureLink']>>> {
    // One source (a single-node route) is probed as before, connected or not.
    if (nodeIds.length === 1) return this.probeSecureLink(nodeIds[0]!, input);
    const connected = nodeIds.filter((nodeId) => this.dispatch.isNodeConnected(nodeId));
    const targets = connected.length > 0 ? connected : nodeIds.slice(0, 1);
    if (targets.length === 0) throw new Error('The Secure Link has no source nginx node');
    let first: Awaited<ReturnType<NodeDispatchService['probeProxySecureLink']>> | undefined;
    for (const nodeId of targets) {
      const result = await this.probeSecureLink(nodeId, input);
      first ??= result;
    }
    return first!;
  }

  /**
   * Brings the source side of every Secure Link of a route in line with the nodes that serve it now: relay routes
   * and grants for each source, listeners on each source node, and an end-to-end probe through each connected source
   * that was added. Sources that no longer serve the route lose their routes and listeners. Used when a route moves
   * between one node and an ingress group and when a group gains or loses a member.
   */
  async syncHostSources(host: ProxyHostRow, previousSourceNodeIds: readonly string[] = []): Promise<void> {
    const sources = await this.hostSources(host);
    const removed = previousSourceNodeIds.filter((nodeId) => !sources.includes(nodeId));
    const added = sources.filter((nodeId) => !previousSourceNodeIds.includes(nodeId));
    const primaryActive =
      host.type === 'proxy' &&
      isDockerUpstream(host.upstreamKind) &&
      host.secureLinkGeneration > 0 &&
      host.secureLinkStatus !== 'cleanup_pending' &&
      host.dockerNodeId;
    if (primaryActive) {
      await this.withLinkOperation(host.id, async () => {
        await this.relayPolicy.ensureProxySecureLink(host.id, relaySources(sources), host.dockerNodeId!);
      });
    }
    const bindings = await this.db.query.proxyAdditionalSecureLinks.findMany({
      where: and(
        eq(proxyAdditionalSecureLinks.proxyHostId, host.id),
        inArray(proxyAdditionalSecureLinks.status, ['provisioning', 'active'])
      ),
    });
    for (const binding of bindings) {
      await this.withLinkOperation(binding.id, async () => {
        if (isManagedStorageUpstream(binding.upstreamKind)) {
          if (!binding.managedStorageId) return;
          await this.relayPolicy.ensureManagedStorageProxySecureLink(
            binding.id,
            binding.managedStorageId,
            relaySources(sources),
            binding.dockerNodeId
          );
        } else {
          await this.relayPolicy.ensureProxySecureLink(binding.id, relaySources(sources), binding.dockerNodeId);
        }
      });
    }
    // Connected sources must take their listeners now; offline sources and sources that stopped serving the route
    // converge when they reconnect (the reconnect resync sends each node its full source binding set).
    const connectedSources = sources.filter((nodeId) => this.dispatch.isNodeConnected(nodeId));
    await this.syncSourceNodes(connectedSources);
    await Promise.allSettled(
      [...sources.filter((nodeId) => !connectedSources.includes(nodeId)), ...removed].map((nodeId) =>
        this.syncSourceNode(nodeId)
      )
    );
    const connectedAdded = added.filter((nodeId) => this.dispatch.isNodeConnected(nodeId));
    for (const nodeId of connectedAdded) {
      if (primaryActive && host.secureLinkStatus === 'active') {
        await this.probeSecureLink(nodeId, {
          linkId: host.id,
          scheme: host.forwardScheme ?? 'http',
          path: host.healthCheckUrl || '/',
          timeoutSeconds: 10,
        });
      }
      for (const binding of bindings) {
        if (binding.status !== 'active' || binding.dormant || binding.incidentSuspendedBy) continue;
        await this.probeSecureLink(nodeId, {
          linkId: binding.id,
          scheme: binding.forwardScheme,
          path: '/',
          timeoutSeconds: 10,
        });
      }
    }
  }

  private async syncTargetNode(nodeId: string, excludedNetwork?: string, requiredLinkId?: string): Promise<void> {
    const previous = this.targetNodeSyncs.get(nodeId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.syncTargetNodeLocked(nodeId, excludedNetwork, requiredLinkId));
    this.targetNodeSyncs.set(nodeId, current);
    try {
      await current;
    } finally {
      if (this.targetNodeSyncs.get(nodeId) === current) this.targetNodeSyncs.delete(nodeId);
    }
  }

  private async syncTargetNodeLocked(nodeId: string, excludedNetwork?: string, requiredLinkId?: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const hosts = await this.db.query.proxyHosts.findMany({
        where: and(
          eq(proxyHosts.dockerNodeId, nodeId),
          inArray(proxyHosts.upstreamKind, [...DOCKER_UPSTREAM_KINDS]),
          ne(proxyHosts.secureLinkStatus, 'cleanup_pending'),
          ne(proxyHosts.secureLinkGeneration, 0)
        ),
      });
      const additional: ProxyAdditionalSecureLinkRow[] = (this.db.query as any).proxyAdditionalSecureLinks
        ? await (this.db.query as any).proxyAdditionalSecureLinks.findMany({
            where: and(
              eq(proxyAdditionalSecureLinks.dockerNodeId, nodeId),
              inArray(proxyAdditionalSecureLinks.upstreamKind, [...DOCKER_UPSTREAM_KINDS]),
              inArray(proxyAdditionalSecureLinks.status, ['provisioning', 'active'])
            ),
          })
        : [];
      const members = await availabilityMemberSyncContext(this.db, nodeId, additional);
      const containerLinkBindings = (await this.containerLinkTargets?.targetBindings(nodeId)) ?? [];
      const containerLinkIds = new Set(containerLinkBindings.map((binding) => binding.linkId));
      const targetBindings = [
        ...hosts.map((host) => ({
          linkId: host.id,
          role: 'target' as const,
          generation: host.secureLinkGeneration,
          targetNetwork: host.secureLinkTargetNetwork ?? '',
          targetContainer: host.secureLinkTargetContainer ?? '',
          targetHost: host.secureLinkTargetHost ?? '',
          targetPort: host.dockerHostPort ?? host.dockerContainerPort ?? 0,
          connectorImage: this.connectorImage,
          allowNetworkReselection: host.upstreamKind === 'docker_container',
        })),
        ...additional
          .filter((binding) => !binding.incidentSuspendedBy && syncableAvailabilityMember(binding, members))
          .map((binding) => ({
            linkId: binding.id,
            role: 'target' as const,
            generation: binding.generation,
            targetNetwork: binding.targetNetwork,
            targetContainer: binding.targetContainer,
            targetHost: '',
            targetPort: binding.dockerHostPort,
            connectorImage: this.connectorImage,
            allowNetworkReselection: binding.upstreamKind === 'docker_container',
            ...availabilityMemberBindingFields(binding, members),
          })),
        ...containerLinkBindings.map((binding) => ({
          ...binding,
          role: 'target' as const,
          targetHost: '',
          connectorImage: this.connectorImage,
        })),
      ].flatMap((binding) => releasedNetworkBinding(binding, excludedNetwork));
      const additionalIds = new Set(additional.map((binding: ProxyAdditionalSecureLinkRow) => binding.id));
      let appliedBindings = targetBindings;
      let result = await this.dispatch.sendProxySecureLinks(nodeId, appliedBindings);
      const unavailable = new Map<string, string>();
      for (;;) {
        while (!result.success) {
          const message = result.error || 'Docker daemon rejected secure-link bindings';
          // One link whose target does not resolve (stopped, gone, or without a usable network) must not keep the
          // node's other links from applying: it leaves this sync and keeps the error, and the rest apply.
          const unresolved = this.parseUnresolvedTarget(message);
          if (!unresolved || unresolved.linkId === requiredLinkId) throw new Error(message);
          const nextBindings = appliedBindings.filter((binding) => binding.linkId !== unresolved.linkId);
          if (nextBindings.length === appliedBindings.length) throw new Error(message);
          // A link pinned for a network release whose container left its network serves nothing there: no error.
          const detached =
            Boolean(excludedNetwork) &&
            unresolved.reason.startsWith('target container is not attached to the selected network');
          if (!detached) unavailable.set(unresolved.linkId, message);
          appliedBindings = nextBindings;
          result = await this.dispatch.sendProxySecureLinks(nodeId, appliedBindings);
        }
        if (!excludedNetwork) break;
        // A link without a recorded network may resolve onto the released network: only those leave as well.
        const onReleased = new Set(
          this.parseBindings(result.detail)
            .filter((status) => status.targetNetwork === excludedNetwork)
            .map((status) => status.linkId)
        );
        const nextBindings = appliedBindings.filter((binding) => !onReleased.has(binding.linkId));
        if (nextBindings.length === appliedBindings.length) break;
        appliedBindings = nextBindings;
        result = await this.dispatch.sendProxySecureLinks(nodeId, appliedBindings);
      }
      await this.recordUnavailableTargets(
        new Map([...unavailable].filter(([linkId]) => !containerLinkIds.has(linkId))),
        additionalIds
      );
      let statuses = this.parseBindings(result.detail);
      const statusByLink = new Map(statuses.map((binding) => [binding.linkId, binding]));
      let networkChanged = false;
      const reconciledBindings = appliedBindings.map((binding) => {
        const status = statusByLink.get(binding.linkId);
        if (!status?.targetNetwork || status.targetNetwork === binding.targetNetwork) return binding;
        networkChanged = true;
        return {
          ...binding,
          generation: binding.generation + 1,
          targetNetwork: status.targetNetwork,
        };
      });
      if (networkChanged) {
        let desiredStateChanged = false;
        for (const binding of reconciledBindings) {
          const original = appliedBindings.find((candidate) => candidate.linkId === binding.linkId);
          if (!original || original.targetNetwork === binding.targetNetwork) continue;
          if (containerLinkIds.has(binding.linkId)) {
            const recorded = await this.containerLinkTargets!.recordTargetNetwork(
              binding.linkId,
              original.generation,
              binding.generation,
              binding.targetNetwork
            );
            if (!recorded) {
              desiredStateChanged = true;
              break;
            }
            continue;
          }
          const applied = additionalIds.has(binding.linkId)
            ? await this.db
                .update(proxyAdditionalSecureLinks)
                .set({ generation: binding.generation, targetNetwork: binding.targetNetwork, updatedAt: new Date() })
                .where(
                  and(
                    eq(proxyAdditionalSecureLinks.id, binding.linkId),
                    eq(proxyAdditionalSecureLinks.generation, original.generation)
                  )
                )
                .returning({ id: proxyAdditionalSecureLinks.id })
            : await this.db
                .update(proxyHosts)
                .set({
                  secureLinkGeneration: binding.generation,
                  secureLinkTargetNetwork: binding.targetNetwork,
                  updatedAt: new Date(),
                })
                .where(and(eq(proxyHosts.id, binding.linkId), eq(proxyHosts.secureLinkGeneration, original.generation)))
                .returning({ id: proxyHosts.id });
          if (applied.length === 0) {
            desiredStateChanged = true;
            break;
          }
        }
        if (desiredStateChanged) {
          if (attempt === 0) continue;
          throw new Error('Proxy secure-link desired state changed during network reconciliation');
        }
        result = await this.dispatch.sendProxySecureLinks(nodeId, reconciledBindings);
        if (!result.success) throw new Error(result.error || 'Docker daemon rejected reconciled secure-link bindings');
        statuses = this.parseBindings(result.detail);
      }
      if (this.containerLinkTargets && (containerLinkIds.size > 0 || unavailable.size > 0)) {
        await this.containerLinkTargets.recordTargetStatuses(
          nodeId,
          statuses.filter((binding) => containerLinkIds.has(binding.linkId)),
          new Map([...unavailable].filter(([linkId]) => containerLinkIds.has(linkId)))
        );
      }
      for (const binding of statuses) {
        if (containerLinkIds.has(binding.linkId)) continue;
        if (additionalIds.has(binding.linkId)) {
          await this.db
            .update(proxyAdditionalSecureLinks)
            .set({
              connectorPort: binding.port,
              ...(binding.targetNetwork ? { targetNetwork: binding.targetNetwork } : {}),
              lastError: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(proxyAdditionalSecureLinks.id, binding.linkId),
                eq(proxyAdditionalSecureLinks.generation, binding.generation)
              )
            );
        } else {
          await this.db
            .update(proxyHosts)
            .set({
              secureLinkConnectorPort: binding.port,
              secureLinkLastError: null,
              ...(binding.targetNetwork ? { secureLinkTargetNetwork: binding.targetNetwork } : {}),
            })
            .where(and(eq(proxyHosts.id, binding.linkId), eq(proxyHosts.secureLinkGeneration, binding.generation)));
        }
      }
      return;
    }
  }

  /** The link and reason of a Docker daemon refusal that names one link whose target did not resolve. */
  private parseUnresolvedTarget(message: string): { linkId: string; reason: string } | null {
    const match = message.match(
      /resolve secure-link ([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}): ([^\n]+)/i
    );
    return match ? { linkId: match[1]!.toLowerCase(), reason: match[2]!.trim() } : null;
  }

  private async recordUnavailableTargets(
    unavailable: ReadonlyMap<string, string>,
    additionalIds: ReadonlySet<string>
  ): Promise<void> {
    for (const [linkId, message] of unavailable) {
      if (additionalIds.has(linkId)) {
        await this.db
          .update(proxyAdditionalSecureLinks)
          .set({ lastError: message, updatedAt: new Date() })
          .where(eq(proxyAdditionalSecureLinks.id, linkId));
      } else {
        await this.db
          .update(proxyHosts)
          .set({ secureLinkLastError: message, updatedAt: new Date() })
          .where(eq(proxyHosts.id, linkId));
      }
    }
  }

  private async syncSourceNode(nodeId: string, rotateLinkId?: string, forceSocketOnlyLinkId?: string): Promise<void> {
    const previous = this.sourceNodeSyncs.get(nodeId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.syncSourceNodeLocked(nodeId, rotateLinkId, forceSocketOnlyLinkId));
    this.sourceNodeSyncs.set(nodeId, current);
    try {
      await current;
    } finally {
      if (this.sourceNodeSyncs.get(nodeId) === current) this.sourceNodeSyncs.delete(nodeId);
    }
  }

  private async syncSourceNodeLocked(
    nodeId: string,
    rotateLinkId?: string,
    forceSocketOnlyLinkId?: string
  ): Promise<void> {
    // A node is the source of its own routes' links and of the links of every route of its ingress groups.
    const hosts = await this.db.query.proxyHosts.findMany({
      where: and(
        proxyHostsServedByNode(this.db, nodeId),
        inArray(proxyHosts.upstreamKind, [...DOCKER_UPSTREAM_KINDS]),
        ne(proxyHosts.secureLinkStatus, 'cleanup_pending'),
        ne(proxyHosts.secureLinkGeneration, 0)
      ),
    });
    const additional: ProxyAdditionalSecureLinkRow[] = (this.db.query as any).proxyAdditionalSecureLinks
      ? await (this.db.query as any).proxyAdditionalSecureLinks.findMany({
          where: and(
            secureLinksSourcedByNode(this.db, nodeId),
            inArray(proxyAdditionalSecureLinks.status, ['provisioning', 'active'])
          ),
        })
      : [];
    if (forceSocketOnlyLinkId && !hosts.some((host) => host.id === forceSocketOnlyLinkId)) {
      throw new Error('Secure Link state changed before socket-only activation');
    }
    const members = await availabilityMemberSyncContext(this.db, nodeId, additional);
    const result = await this.dispatch.sendProxySecureLinks(nodeId, [
      ...hosts.map((host) => {
        const sourceConfigManaged =
          (host.secureLinkStatus === 'active' || host.id === forceSocketOnlyLinkId) &&
          host.type === 'proxy' &&
          !host.rawConfigEnabled;
        return {
          linkId: host.id,
          role: 'source' as const,
          generation: host.secureLinkGeneration,
          listenerPort: host.secureLinkListenerPort ?? 0,
          sourceConfigManaged,
          rotateListener: host.id === rotateLinkId,
          // Raw/user-owned primary configs may still reference the durable
          // loopback listener. Generated configs and additional links use the
          // Unix socket and can safely drop TCP.
          socketOnly: sourceConfigManaged,
          loopbackAddress: secureLinkLoopbackAddress(host.secureLinkLoopbackSlot),
        };
      }),
      ...additional
        .filter((binding) => !binding.incidentSuspendedBy && syncableAvailabilityMember(binding, members))
        .map((binding) => ({
          linkId: binding.id,
          role: 'source' as const,
          generation: binding.generation,
          listenerPort: binding.listenerPort ?? 0,
          sourceConfigManaged: false,
          rotateListener: binding.id === rotateLinkId,
          socketOnly: true,
          loopbackAddress: secureLinkLoopbackAddress(binding.loopbackSlot),
          ...availabilityMemberBindingFields(binding, members),
        })),
    ]);
    if (!result.success) throw new Error(result.error || 'Nginx daemon rejected secure-link listeners');
    const additionalIds = new Set(additional.map((binding: ProxyAdditionalSecureLinkRow) => binding.id));
    for (const binding of this.parseBindings(result.detail)) {
      if (additionalIds.has(binding.linkId)) {
        await this.db
          .update(proxyAdditionalSecureLinks)
          .set({ listenerPort: binding.port || null, updatedAt: new Date() })
          .where(
            and(
              eq(proxyAdditionalSecureLinks.id, binding.linkId),
              eq(proxyAdditionalSecureLinks.generation, binding.generation)
            )
          );
      } else {
        await this.db
          .update(proxyHosts)
          .set({ secureLinkListenerPort: binding.port || null })
          .where(and(eq(proxyHosts.id, binding.linkId), eq(proxyHosts.secureLinkGeneration, binding.generation)));
      }
    }
  }

  private parseBindings(detail: string | undefined): BindingDetail[] {
    if (!detail) return [];
    const decoded = JSON.parse(detail) as { bindings?: BindingDetail[] };
    return Array.isArray(decoded.bindings) ? decoded.bindings : [];
  }

  private async probeSecureLink(
    nodeId: string,
    input: Parameters<NodeDispatchService['probeProxySecureLink']>[1]
  ): Promise<Awaited<ReturnType<NodeDispatchService['probeProxySecureLink']>>> {
    let lastError: unknown = new Error('Secure Link end-to-end probe failed');
    for (let attempt = 0; attempt < PROXY_SECURE_LINK_PROBE_ATTEMPTS; attempt++) {
      try {
        const result = await this.dispatch.probeProxySecureLink(nodeId, input);
        if (result.httpStatus) return result;
        lastError = new Error(result.error || 'Secure Link end-to-end probe failed');
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < PROXY_SECURE_LINK_PROBE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, PROXY_SECURE_LINK_PROBE_RETRY_MS));
      }
    }
    throw lastError;
  }
}
