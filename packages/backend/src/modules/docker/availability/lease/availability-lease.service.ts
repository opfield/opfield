import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  auditLog,
  type DockerAvailabilityPartitionMode,
  dockerAvailabilityLeaseObservations,
  dockerAvailabilityLeaseState,
  type LeasePolicyKind,
  managedAvailabilityMembers,
  managedAvailabilitySets,
} from '@/db/schema/index.js';
import type { AvailabilityLeaseReport, CommandResult } from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type { RelayPolicySigningKeyService } from '@/services/relay-policy-signing-key.service.js';
import { AvailabilityLeaseSource } from './availability-lease-source.js';
import { AvailabilityLeaseCluster } from './lease-cluster.js';
import type { LeaseSigner } from './lease-codec.js';
import { AVAILABILITY_LEASE_PROTOCOL_CAPABILITIES, isStorageProfileNodeType } from './lease-constants.js';
import {
  registerPlannedLeaseHandoff,
  reissueLeaseBootstrap,
  setAvailabilityLegacyRequested,
  setAvailabilityPartitionMode,
  setAvailabilitySurgeSlots,
  setAvailabilityWitness,
} from './lease-controls.js';
import { AvailabilityLeaseDistribution, type RelayLeasePolicyFields } from './lease-distribution.js';
import { availabilityStandbyCount } from './lease-gating.js';
import {
  type LeaseSetOwner,
  leaseAuditSubject,
  leaseEvent,
  leaseHolderAuditEntry,
  leaseModeEvent,
  loadLeaseSetOwner,
  noticeKind,
} from './lease-kind-presentation.js';
import { LeaseCapabilityTracker, loadLeaseParticipants } from './lease-participants.js';
import { LeasePolicies } from './lease-policies.js';
import { registerLeasePolicies } from './lease-policy-registry.js';
import type {
  LeaseDegradedChange,
  LeaseHolderChangeNotice,
  LeaseModeChange,
  LeasePolicyDescriptor,
  LeasePolicySource,
} from './lease-policy-source.js';
import { type RelayLeaseOwner, type RelayLeasePolicyIds, relayLeasePolicyIds } from './lease-relay-gate.js';
import { AvailabilityLeaseReports, type LeaseReporterClock, type LeaseReportSender } from './lease-reports.js';
import {
  bumpLeaseRevision,
  ensureLeaseState,
  loadLeaseCluster,
  loadLeaseMembers,
  type RelayConnectedMembers,
} from './lease-store.js';
import { LeaseTakeoverAudit, type SettledLeaseTakeover } from './lease-takeover-audit.js';
import type {
  DockerAvailabilityLeaseController,
  DockerAvailabilityLeaseHandoffInput,
  DockerAvailabilityLeaseView,
  LeasePolicyView,
} from './lease-types.js';
import { availabilityLeaseView, type LeaseViewContext, leasePolicyView } from './lease-views.js';
import { validateLeaseWitness } from './lease-witness.js';
import {
  ManagedAvailabilityLeaseSource,
  type ManagedAvailabilitySetController,
} from './managed-availability-lease-source.js';

export { leaseExcludedNodes } from './lease-views.js';

const logger = createChildLogger('AvailabilityLeaseService');

/** The lease of an availability set as the control plane reads it (observeSet). */
export interface ManagedAvailabilitySetLease {
  setId: string;
  /** The lease policy of the current period; null before createSetPolicy or in manual mode. */
  leasePolicyId: string | null;
  view: LeasePolicyView | null;
  /** The member whose node holds the primary slot now, and that node; null while nobody holds it. */
  holderMemberId: string | null;
  holderNodeId: string | null;
}

/**
 * The lease host (OSS). It chooses voters and epochs, signs manifests with the relay policy key, delivers them, gates
 * policies by capability, ingests lease reports, audits autonomous transitions and keeps the relay gates, for every
 * kind of lease policy: Docker Availability (whose paid controller attaches here) and database and storage
 * availability sets (whose control plane attaches through attachSetController).
 */
export class AvailabilityLeaseService {
  private relayPublisher: { publishAvailabilityLeaseChange(): Promise<void> } | null = null;
  private readonly sources = new Map<LeasePolicyKind, LeasePolicySource>();
  private readonly availability: AvailabilityLeaseSource;
  private readonly sets: ManagedAvailabilityLeaseSource;
  private readonly cluster: AvailabilityLeaseCluster;
  private readonly policies: LeasePolicies;
  private readonly reports: AvailabilityLeaseReports;
  private readonly distribution: AvailabilityLeaseDistribution;
  private reconciling: Promise<void> | null = null;
  private rerun: Promise<void> | null = null;
  /** Members each relay last reported a live Coordinate stream from (voter reachability). */
  private readonly relayConnections = new Map<string, RelayConnectedMembers>();
  /** D3: since when each member lacks the current capability, for the 2-minute grace of voters and candidates. */
  private readonly capabilities = new LeaseCapabilityTracker();
  /** B-14: holder changes whose audit waits for the takeover time. */
  private readonly takeovers: LeaseTakeoverAudit;

  constructor(
    private readonly db: DrizzleClient,
    private readonly registry: NodeRegistryService,
    private readonly audit: Pick<AuditService, 'log'>,
    private readonly events: Pick<EventBusService, 'publish'>,
    policyKeys: Pick<RelayPolicySigningKeyService, 'signPayload'>
  ) {
    const sign: LeaseSigner = (message, keyId) => policyKeys.signPayload(message, keyId);
    this.cluster = new AvailabilityLeaseCluster(db, sign);
    this.policies = new LeasePolicies(db, sign);
    this.reports = new AvailabilityLeaseReports(db);
    this.distribution = new AvailabilityLeaseDistribution(db, registry);
    this.availability = new AvailabilityLeaseSource(db);
    this.sets = new ManagedAvailabilityLeaseSource(db);
    this.sources.set(this.availability.kind, this.availability);
    this.sources.set(this.sets.kind, this.sets);
    this.takeovers = new LeaseTakeoverAudit(db, {
      write: (settled) => this.auditTakeover(settled),
      written: (settled) => this.takeoverAudited(settled),
      correct: (policyId, slot, holderId, since) => this.reports.correctHolderSince(policyId, slot, holderId, since),
    });
  }

  /** The paid Availability controller; without one every Availability policy stays legacy. */
  attachController(controller: DockerAvailabilityLeaseController): void {
    this.availability.attachController(controller);
  }

  /** The control plane of database and storage availability sets follows its sets' leases through these callbacks. */
  attachSetController(controller: ManagedAvailabilitySetController): void {
    this.sets.attachController(controller);
  }

  setRelayPublisher(publisher: { publishAvailabilityLeaseChange(): Promise<void> }): void {
    this.relayPublisher = publisher;
  }

  /** D7: the fixed standby count, min(2, candidates - slots). */
  standbyCount(candidateNodes: number, slots: number): number {
    return availabilityStandbyCount(candidateNodes, slots);
  }

  /**
   * Periodic and on-demand reconciliation. A caller that arrives while a run is in flight gets one follow-up run that
   * starts after it, so a change it just wrote is never judged by a run that read the state before.
   */
  reconcile(): Promise<void> {
    if (this.reconciling) {
      this.rerun ??= this.reconciling
        .catch(() => undefined)
        .then(() => {
          this.rerun = null;
          return this.reconcile();
        });
      return this.rerun;
    }
    this.reconciling = this.reconcileOnce().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  /** Re-evaluates the lease after a source changed placements, candidates, members or the partition mode. */
  async republishPolicy(_leasePolicyId: string): Promise<void> {
    await this.reconcile();
  }

  /** Shutdown: writes the audit of every holder change still waiting for its takeover time (B-14). */
  async flushTakeoverAudits(): Promise<void> {
    await this.takeovers.flush();
  }

  /**
   * Writes the audit of every holder change whose wait for its takeover time is over (B-14). The periodic reconcile
   * runs it; its first run after a start also writes what a crashed process left waiting.
   */
  async settleTakeoverAudits(now = new Date()): Promise<void> {
    await this.takeovers.settleDue(now).catch((error) => {
      logger.warn('Availability lease holder changes will be audited on the next reconcile', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async listDescriptors(): Promise<{ descriptors: LeasePolicyDescriptor[]; kinds: Set<LeasePolicyKind> }> {
    const descriptors: LeasePolicyDescriptor[] = [];
    const kinds = new Set<LeasePolicyKind>();
    for (const source of this.sources.values()) {
      try {
        const listed = await source.listDesired();
        descriptors.push(...listed.filter((descriptor) => descriptor.kind === source.kind));
        kinds.add(source.kind);
      } catch (error) {
        // A source that cannot answer leaves its policies exactly as published until it answers again.
        logger.warn('A lease policy source did not list its policies; they stay as published', {
          kind: source.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { descriptors, kinds };
  }

  private async reconcileOnce(): Promise<void> {
    const now = new Date();
    await this.settleTakeoverAudits(now);
    const members = new Map((await loadLeaseMembers(this.db)).map((member) => [member.memberId, member]));
    const participants = await loadLeaseParticipants(this.db, this.registry, members, now.getTime());
    this.capabilities.observe(participants, now.getTime());
    const { descriptors, kinds } = await this.listDescriptors();
    const cluster = await this.cluster.reconcile({ members });
    const outcome = await this.policies.reconcile(
      { participants, members, cluster: cluster.cluster, now },
      descriptors,
      kinds
    );
    if (cluster.changed || outcome.changed) await bumpLeaseRevision(this.db);
    if (cluster.changed || outcome.changed) {
      void this.relayPublisher?.publishAvailabilityLeaseChange().catch((error) => {
        logger.warn('Relays will receive the availability lease change with the next policy refresh', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    await this.distribution.syncDaemons(members, now.getTime());
    for (const change of outcome.modeChanges) await this.notifyModeChange(change);
    for (const change of outcome.degradedChanges) await this.notifyDegraded(change);
  }

  private async setOwner(kind: LeasePolicyKind | undefined, resourceId: string | undefined) {
    if (kind !== 'managed_availability_set' || !resourceId) return null;
    return loadLeaseSetOwner(this.db, resourceId).catch(() => null);
  }

  private async notifyModeChange(change: LeaseModeChange): Promise<void> {
    const event = leaseModeEvent(change, await this.setOwner(change.leaseKind, change.resourceId));
    this.events.publish(event.channel, event.payload);
    await this.sources.get(change.leaseKind)?.modeChanged(change);
  }

  private async notifyDegraded(change: LeaseDegradedChange): Promise<void> {
    if (change.reason) {
      logger.warn('A stateful lease policy runs degraded; the host keeps it running (AS9)', {
        leasePolicyId: change.leasePolicyId,
        kind: change.leaseKind,
        reason: change.reason.code,
      });
    }
    await this.sources.get(change.leaseKind)?.degradedChanged?.(change);
  }

  /** Lease fields of every relay policy envelope (relay.v1 PolicyEnvelopePayload 40, 41). */
  relayPolicyFields(): Promise<RelayLeasePolicyFields> {
    return this.distribution.relayFields();
  }

  /** relay.v1 lease_policy_id of endpoints and routes gated by the relay's lease view (lease mode only). */
  relayLeasePolicyIds(endpoints: RelayLeaseOwner[], routes: RelayLeaseOwner[]): Promise<RelayLeasePolicyIds> {
    return relayLeasePolicyIds(this.db, endpoints, routes);
  }

  /** Policy keys whose private half must survive: the key that signs lease blocks (A14). */
  async retainedSigningKeyIds(): Promise<string[]> {
    const cluster = await loadLeaseCluster(this.db);
    return cluster?.signingKeyId ? [cluster.signingKeyId] : [];
  }

  /**
   * A docker, storage-profile or nginx daemon's heartbeat lease section, with the daemon's clock as measured on
   * arrival (N-15). A storage-profile daemon is a docker daemon that hosts availability set members.
   */
  async ingestDaemonReport(
    nodeId: string,
    nodeType: string,
    report: AvailabilityLeaseReport,
    clock?: LeaseReporterClock
  ): Promise<void> {
    if (nodeType !== 'docker' && nodeType !== 'nginx' && !isStorageProfileNodeType(nodeType)) return;
    const kind = nodeType === 'nginx' ? 'nginx' : 'docker';
    await this.ingest({ memberId: nodeId, kind, nodeId, relayInstanceId: null }, report, clock);
  }

  /** A relay's acceptor and gate view, from its runtime status or local health. */
  async ingestRelayReport(relayInstanceId: string, report: AvailabilityLeaseReport): Promise<void> {
    const connected = report.connectedMemberIds;
    if (Array.isArray(connected)) {
      this.relayConnections.set(relayInstanceId, {
        relayId: relayInstanceId,
        memberIds: connected.filter((id) => typeof id === 'string' && id.length > 0),
        reportedAt: Date.now(),
      });
    }
    await this.ingest({ memberId: relayInstanceId, kind: 'relay', nodeId: null, relayInstanceId }, report);
  }

  private async ingest(
    sender: LeaseReportSender,
    report: AvailabilityLeaseReport,
    clock?: LeaseReporterClock
  ): Promise<void> {
    const { notices, sightings, identityChanged } = await this.reports.ingest(sender, report, new Date(), clock);
    for (const notice of notices) await this.recordHolderChange(notice);
    await this.takeovers.observe(sightings);
    // H3: a renewed identity key must reach every manifest that lists the member before its frames are dropped for
    // long; republish now instead of on the next interval.
    if (identityChanged) {
      void this.reconcile().catch((error) => {
        logger.warn('Availability lease manifests will pick up the renewed identity key on the next reconcile', {
          memberId: sender.memberId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private async recordHolderChange(notice: LeaseHolderChangeNotice): Promise<void> {
    const kind = noticeKind(notice);
    if (notice.kind) {
      await this.takeovers.record(notice);
      const event = leaseEvent(
        kind,
        notice.policyId,
        notice.resourceId ?? notice.policyId,
        `lease_${notice.kind}`,
        await this.setOwner(kind, notice.resourceId)
      );
      this.events.publish(event.channel, event.payload);
    }
    await this.sources.get(kind)?.holderChanged(notice);
  }

  private async auditSubject(notice: LeaseHolderChangeNotice) {
    const owner: LeaseSetOwner | null = await this.setOwner(noticeKind(notice), notice.resourceId);
    return leaseAuditSubject({ ...notice, kind: notice.kind === 'handoff' ? 'handoff' : 'failover' }, owner);
  }

  private async auditTakeover(settled: SettledLeaseTakeover): Promise<boolean> {
    const subject = await this.auditSubject(settled.notice);
    // The set (and with it its owner) was deleted meanwhile: nothing to audit on.
    if (!subject) return true;
    return this.audit.log(
      leaseHolderAuditEntry({
        subject,
        notice: settled.notice,
        takeoverId: settled.takeoverId,
        takeoverAt: settled.takeoverAt,
        source: settled.source,
        noticedAt: settled.noticedAt,
      })
    );
  }

  /** A crash between writing a takeover's audit row and clearing its waiting entry must not audit it twice. */
  private async takeoverAudited(settled: SettledLeaseTakeover): Promise<boolean> {
    const subject = await this.auditSubject(settled.notice);
    if (!subject) return true;
    const [row] = await this.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.resourceType, subject.resourceType),
          eq(auditLog.resourceId, subject.resourceId),
          eq(auditLog.action, subject.action),
          sql`${auditLog.details}->>'takeoverId' = ${settled.takeoverId}`
        )
      )
      .limit(1);
    return Boolean(row);
  }

  /** Legacy policies are driven by the backend; every other lease mode is not (D9, A5). */
  async isReactive(leasePolicyId: string): Promise<boolean> {
    const [state] = await this.db
      .select({ mode: dockerAvailabilityLeaseState.mode })
      .from(dockerAvailabilityLeaseState)
      .where(eq(dockerAvailabilityLeaseState.policyId, leasePolicyId))
      .limit(1);
    return (state?.mode ?? 'legacy') === 'legacy';
  }

  private viewContext(): LeaseViewContext {
    return { db: this.db, registry: this.registry, relayConnections: this.relayConnections.values() };
  }

  /** Read-only lease state of an Availability policy (its API shape). */
  getPolicyLease(policyId: string, now = new Date()): Promise<DockerAvailabilityLeaseView> {
    return availabilityLeaseView(this.viewContext(), policyId, now);
  }

  /** Read-only lease state of any lease policy; null when not registered. */
  getLeasePolicyView(leasePolicyId: string, now = new Date()): Promise<LeasePolicyView | null> {
    return leasePolicyView(this.viewContext(), leasePolicyId, now, async (id, kind) => {
      const source = this.sources.get(kind);
      return source?.certifiedStateDetails ? source.certifiedStateDetails(id) : [];
    });
  }

  // --- Database and storage availability sets (host contract of the control plane) ---

  /**
   * Starts the lease policy of a set's new availability period: a fresh lease policy id (M10, never reused, so state
   * an acceptor accepted in an earlier period is never adopted), registered as stateful and written to the set. The
   * set must be in automatic mode with its members written; the bootstrap reserves the slot for the set's primary
   * member. Refused while the set's previous lease policy has not returned to legacy (close it first).
   */
  async createSetPolicy(setId: string): Promise<{ leasePolicyId: string }> {
    const leasePolicyId = await this.db.transaction(async (tx) => {
      const [set] = await tx
        .select({ mode: managedAvailabilitySets.mode, leasePolicyId: managedAvailabilitySets.leasePolicyId })
        .from(managedAvailabilitySets)
        .where(eq(managedAvailabilitySets.id, setId))
        .for('update');
      if (!set) throw new AppError(404, 'AVAILABILITY_SET_NOT_FOUND', 'Availability set not found');
      if (set.mode !== 'automatic') {
        throw new AppError(409, 'AVAILABILITY_SET_MANUAL', 'A manual pair has no lease policy');
      }
      if (set.leasePolicyId) {
        const [previous] = await tx
          .select({ mode: dockerAvailabilityLeaseState.mode })
          .from(dockerAvailabilityLeaseState)
          .where(eq(dockerAvailabilityLeaseState.policyId, set.leasePolicyId))
          .limit(1);
        if (previous && previous.mode !== 'legacy') {
          throw new AppError(
            409,
            'AVAILABILITY_SET_LEASE_OPEN',
            'The previous lease of this availability set is still open; close it first'
          );
        }
      }
      const id = randomUUID();
      const registered = await registerLeasePolicies(tx, [
        { leasePolicyId: id, kind: 'managed_availability_set', resourceId: setId, stateful: true },
      ]);
      if (!registered.has(id)) throw new Error('The lease policy of the availability set could not be registered');
      await ensureLeaseState(tx, id);
      await tx
        .update(managedAvailabilitySets)
        .set({ leasePolicyId: id, updatedAt: new Date() })
        .where(eq(managedAvailabilitySets.id, setId));
      return id;
    });
    await this.reconcile();
    return { leasePolicyId };
  }

  /**
   * Republishes a set's lease after its members, priorities, primary or witness picks changed: the host chooses the
   * voters again and moves to them through a joint epoch that settles only once a live holder renewed under it (AS1).
   */
  async updateSetVoters(_setId: string): Promise<void> {
    await this.reconcile();
  }

  /**
   * Closes the lease of a set's current period (AS9: the only way a set's lease closes; capability, voter or license
   * loss never does). The holder is retained (it keeps serving as the single primary) once a majority of the voters
   * confirmed the close; the control plane follows modeChanged to legacy.
   */
  async closeSetPolicy(setId: string): Promise<void> {
    const [set] = await this.db
      .select({ leasePolicyId: managedAvailabilitySets.leasePolicyId })
      .from(managedAvailabilitySets)
      .where(eq(managedAvailabilitySets.id, setId))
      .limit(1);
    if (!set) throw new AppError(404, 'AVAILABILITY_SET_NOT_FOUND', 'Availability set not found');
    if (!set.leasePolicyId) return;
    await this.db
      .update(dockerAvailabilityLeaseState)
      .set({ legacyRequested: true, updatedAt: new Date() })
      .where(eq(dockerAvailabilityLeaseState.policyId, set.leasePolicyId));
    await this.reconcile();
  }

  /** The lease of a set as the host sees it: the view of its current lease policy and the member holding it. */
  async observeSet(setId: string, now = new Date()): Promise<ManagedAvailabilitySetLease> {
    const [set] = await this.db
      .select({ leasePolicyId: managedAvailabilitySets.leasePolicyId })
      .from(managedAvailabilitySets)
      .where(eq(managedAvailabilitySets.id, setId))
      .limit(1);
    if (!set) throw new AppError(404, 'AVAILABILITY_SET_NOT_FOUND', 'Availability set not found');
    if (!set.leasePolicyId) return { setId, leasePolicyId: null, view: null, holderMemberId: null, holderNodeId: null };
    const [view, [observation]] = await Promise.all([
      this.getLeasePolicyView(set.leasePolicyId, now),
      this.db
        .select({ holderId: dockerAvailabilityLeaseObservations.holderId })
        .from(dockerAvailabilityLeaseObservations)
        .where(
          and(
            eq(dockerAvailabilityLeaseObservations.policyId, set.leasePolicyId),
            eq(dockerAvailabilityLeaseObservations.slot, 0)
          )
        )
        .limit(1),
    ]);
    const holderNodeId = observation?.holderId ?? null;
    const [member] = holderNodeId
      ? await this.db
          .select({ id: managedAvailabilityMembers.id })
          .from(managedAvailabilityMembers)
          .where(and(eq(managedAvailabilityMembers.setId, setId), eq(managedAvailabilityMembers.nodeId, holderNodeId)))
          .limit(1)
      : [];
    return { setId, leasePolicyId: set.leasePolicyId, view, holderMemberId: member?.id ?? null, holderNodeId };
  }

  // --- Docker Availability controls ---

  /** Writes the partition mode (D11, A7) and republishes the manifest. The caller authorized the policy mutation. */
  async setPartitionMode(policyId: string, partitionMode: DockerAvailabilityPartitionMode): Promise<void> {
    await setAvailabilityPartitionMode(this.db, policyId, partitionMode);
    await this.republishPolicy(policyId);
  }

  /** A19: checks a configured witness before a policy is enabled or updated with it. */
  validateWitness(witness: string, scope: { policyId?: string; candidateNodeIds?: readonly string[] }): Promise<void> {
    return validateLeaseWitness(this.db, witness, scope);
  }

  /**
   * A19: sets the policy's witness (a relay instance id or a docker node id), or null for the automatic choice, and
   * republishes the manifest; a voter change runs through a joint epoch (A4). The caller authorized the mutation.
   */
  async setWitness(policyId: string, witness: string | null): Promise<void> {
    await setAvailabilityWitness(this.db, policyId, witness);
    await this.republishPolicy(policyId);
  }

  /**
   * Holds a policy on the legacy path (true) or releases it to the capability gate again (false). Holding it closes a
   * running lease first (A5): use it before operations that need the backend path, such as disabling Availability.
   */
  async setLegacyRequested(policyId: string, requested: boolean): Promise<void> {
    await setAvailabilityLegacyRequested(this.db, policyId, requested);
    await this.republishPolicy(policyId);
  }

  /**
   * Replaces the bootstrap reservation of a lease policy that is still bootstrapping, with a new bootstrap_id (A5).
   * Only for the stuck state where a reserved holder died before it acquired and no holder was observed since.
   */
  async reissueBootstrap(
    leasePolicyId: string,
    bootstrap: Array<{ slot: number; holderNodeId: string }>
  ): Promise<void> {
    await reissueLeaseBootstrap(this.db, leasePolicyId, bootstrap);
    await this.republishPolicy(leasePolicyId);
  }

  /**
   * D9: temporary extra lease slots for a replicated rollout (surge). The manifest then publishes
   * desiredReplicaCount + count slots under a new version; lowering the count removes the highest slots, whose
   * holders stop and release. Failover policies have exactly one slot and reject any surge.
   */
  async setSurgeSlots(policyId: string, count: number): Promise<void> {
    await setAvailabilitySurgeSlots(this.db, policyId, count);
    await this.republishPolicy(policyId);
  }

  /** Marks the next holder change of a key as planned, so it is audited as a handoff (D9). */
  registerPlannedHandoff(
    leasePolicyId: string,
    input: {
      slot: number;
      fromHolderId: string | null;
      toHolderId: string;
      operationId?: string | null;
      ttlMs?: number;
    }
  ): Promise<void> {
    return registerPlannedLeaseHandoff(this.db, leasePolicyId, input);
  }

  /**
   * Planned handoff (D9, A6) of a key of any lease policy (a set's switchover is one): asks the current holder to
   * release it to the successor. The holder checks the successor is ready, stops its workload, deregisters and only
   * then releases.
   */
  async requestHandoff(leasePolicyId: string, input: DockerAvailabilityLeaseHandoffInput): Promise<CommandResult> {
    const view = await this.getPolicyLease(leasePolicyId);
    if (view.mode !== 'lease') {
      throw new AppError(409, 'AVAILABILITY_LEASE_NOT_ACTIVE', 'Handoff needs the policy to run in lease mode');
    }
    const holder = view.holders.find((entry) => entry.slot === input.slot)?.holderNodeId ?? null;
    if (!holder) throw new AppError(409, 'AVAILABILITY_LEASE_NO_HOLDER', 'The lease has no current holder to hand off');
    // An outdated holder still hands over (it speaks the same wire protocol): moving off it is the point.
    if (
      !AVAILABILITY_LEASE_PROTOCOL_CAPABILITIES.some((capability) => this.registry.hasCapability(holder, capability))
    ) {
      throw new AppError(503, 'AVAILABILITY_NODE_DISCONNECTED', 'Waiting for the lease holder to reconnect', {
        retryable: true,
      });
    }
    await this.registerPlannedHandoff(leasePolicyId, {
      slot: input.slot,
      fromHolderId: holder,
      toHolderId: input.successorNodeId,
      operationId: input.operationId ?? null,
    });
    return this.registry.sendCommand(
      holder,
      {
        availabilityLeaseHandoff: {
          policyId: leasePolicyId,
          slot: input.slot,
          successorId: input.successorNodeId,
          operationId: input.operationId ?? '',
          successorGeneration: String(input.successorGeneration),
          manifestVersion: String(view.manifestVersion),
        },
      },
      input.timeoutMs ?? 60_000
    );
  }
}
