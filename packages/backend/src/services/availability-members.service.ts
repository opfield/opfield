import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type ManagedAvailabilityEngine,
  type ManagedAvailabilityMemberRole,
  type ManagedAvailabilityMemberSyncState,
  managedAvailabilityMembers,
  managedAvailabilitySets,
  managedDatabaseInstances,
  managedStorageClusters,
} from '@/db/schema/index.js';
import type {
  AvailabilityMemberCommand,
  AvailabilityMemberConfig,
  AvailabilityMemberEvent,
  AvailabilityMemberReport,
  AvailabilityPrimaryAssignment,
  CommandResult,
} from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import { availabilityMemberConfigError } from './availability-member-config.rules.js';
import type { NodeDispatchService } from './node-dispatch.service.js';

const logger = createChildLogger('AvailabilityMembers');

export { MANAGED_AVAILABILITY_MEMBER_CAPABILITY } from './node-dispatch.service.js';

/** A member that reports an older configuration revision than the set's is configured again at most this often. */
const RECONFIGURE_RETRY_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;

export type AvailabilitySetRow = typeof managedAvailabilitySets.$inferSelect;
export type AvailabilityMemberRow = typeof managedAvailabilityMembers.$inferSelect;

/** A member whose node did not take the set's configuration (configureSetResults). */
export interface AvailabilityMemberConfigureFailure {
  memberId: string;
  nodeId: string;
  error: string;
  /** The node (or the rules it applies) refused the configuration; false: unreachable or not capable yet. */
  refused: boolean;
}

/** A member event as the node queued it, with the time it happened on the data plane. */
export interface AvailabilityMemberEventRecord {
  sequence: number;
  kind: string;
  at: Date;
  reason: string | null;
  operationId: string | null;
  detail: Record<string, string>;
}

export type EngineConfigProvider = (
  setId: string,
  memberId: string
) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
export type MemberEventListener = (
  set: AvailabilitySetRow,
  member: AvailabilityMemberRow,
  events: AvailabilityMemberEventRecord[]
) => Promise<void>;
/** Signs a manual pair's primary assignment (services/availability-assignment-signing.ts). */
export interface PrimaryAssignmentSigner {
  signPrimaryAssignment(input: {
    setId: string;
    primaryMemberId: string;
    generation: number;
  }): Promise<AvailabilityPrimaryAssignment>;
}
/** Whether a member's engine is to stay stopped (a paused set); see registerRunState. */
export type MemberRunStateProvider = (
  set: AvailabilitySetRow,
  member: AvailabilityMemberRow
) => Promise<{ stopped?: boolean }> | { stopped?: boolean };
/** Runs before a node's daemon restarts for an update (a set primary on it hands over first). */
export type NodeUpdateHandoff = (nodeId: string) => Promise<void>;

/**
 * Keys of a member row's `engine_position` the member runtime itself reports (not the engine): `runtime.stopped` =
 * "true" while the engine is down because the set is paused, `runtime.pendingRestart` = the operation id of a requested
 * restart that has not finished.
 */
export const MEMBER_RUNTIME_STOPPED_KEY = 'runtime.stopped';
export const MEMBER_RUNTIME_PENDING_RESTART_KEY = 'runtime.pendingRestart';
/** A manual pair's assigned primary that does not serve gets the current assignment again at most this often. */
const ASSIGNMENT_CONFIRM_RETRY_MS = 10_000;
/** How often Gateway asks the nodes of manual pairs for a report (their primaries' contact with Gateway). */
export const MANUAL_CONTACT_INTERVAL_MS = 5_000;
/** A node update waits at most this long for the set primaries on the node to hand over. */
const NODE_UPDATE_HANDOFF_TIMEOUT_MS = 5 * 60_000;

/** A node's update waits: a set primary on it could not hand over (see beforeNodeUpdate). */
export class NodeUpdatePostponedError extends Error {
  readonly code = 'NODE_UPDATE_POSTPONED';
}

export type PrimaryChangedListener = (
  set: AvailabilitySetRow,
  member: AvailabilityMemberRow,
  previousMemberId: string | null
) => Promise<void> | void;

/**
 * Engine-agnostic member plumbing of database and storage availability sets (open core): Gateway's configuration of
 * each member's node (AvailabilityMemberCommand), and the member reports of the health stream
 * (HealthReport.availability_members): observed member fields, queued member events (delivered to the listeners,
 * acknowledged to the node only after every listener resolved, replays skipped by `last_event_at`) and holder
 * following (`primary_member_id` and the resource's `node_id` move to the member that reports serving as primary).
 * The orchestration (commercial core) calls it; the lease host stays the authority over who is primary.
 */
export class AvailabilityMembersService {
  private readonly engineConfig = new Map<ManagedAvailabilityEngine, EngineConfigProvider>();
  private readonly eventListeners: MemberEventListener[] = [];
  private readonly primaryListeners: PrimaryChangedListener[] = [];
  private readonly runStateProviders: MemberRunStateProvider[] = [];
  private readonly nodeUpdateHandoffs: NodeUpdateHandoff[] = [];
  private readonly lastConfigured = new Map<string, { revision: number; at: number }>();
  private readonly assignmentConfirmSent = new Map<string, number>();
  private readonly ingesting = new Set<string>();
  private signer: PrimaryAssignmentSigner | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly dispatch: Pick<NodeDispatchService, 'sendAvailabilityMember'>,
    private readonly now: () => number = Date.now
  ) {}

  /** Manual pairs: the signer of the primary assignment their members verify. */
  setAssignmentSigner(signer: PrimaryAssignmentSigner): void {
    this.signer = signer;
  }

  /** A manual pair's current primary assignment, signed; null without a primary or a signer. */
  async signedAssignment(set: AvailabilitySetRow): Promise<AvailabilityPrimaryAssignment | null> {
    if (set.mode !== 'manual' || !set.primaryMemberId || set.primaryGeneration <= 0 || !this.signer) return null;
    return this.signer.signPrimaryAssignment({
      setId: set.id,
      primaryMemberId: set.primaryMemberId,
      generation: set.primaryGeneration,
    });
  }

  /** Supplies the engine's own configuration of each member (`engine_config`, JSON). */
  registerEngineConfig(engine: ManagedAvailabilityEngine, provider: EngineConfigProvider): void {
    this.engineConfig.set(engine, provider);
  }

  /** Member events (failover, fence, rejoin, ...); the node keeps them until every listener resolved. */
  onMemberEvents(listener: MemberEventListener): void {
    this.eventListeners.push(listener);
  }

  /** Called after `primary_member_id` and the resource's `node_id` followed a new serving primary. */
  onPrimaryChanged(listener: PrimaryChangedListener): void {
    this.primaryListeners.push(listener);
  }

  /** Whether each member's engine stays stopped (paused sets); providers of every owner kind are asked. */
  registerRunState(provider: MemberRunStateProvider): void {
    this.runStateProviders.push(provider);
  }

  /** Handoffs that run before a node's daemon restarts for an update (see beforeNodeUpdate). */
  registerNodeUpdateHandoff(handler: NodeUpdateHandoff): void {
    this.nodeUpdateHandoffs.push(handler);
  }

  /**
   * Before a node's daemon restarts for an update: every set primary on the node hands over to a healthy copy first
   * (the owner kinds' handoffs start a planned switchover and wait for it). Bounded. A primary that could not hand over
   * and keeps serving on the node (or a handoff still running at the bound) postpones the update: it throws a
   * NODE_UPDATE_POSTPONED error, so the daemon is never restarted under it and its clients are not cut a second time.
   * Any other failure only logs, and the update goes on (the set then fails over or waits as for any restart).
   */
  async beforeNodeUpdate(nodeId: string): Promise<void> {
    if (this.nodeUpdateHandoffs.length === 0) return;
    const hosted = await this.db
      .select({ id: managedAvailabilityMembers.id })
      .from(managedAvailabilityMembers)
      .where(eq(managedAvailabilityMembers.nodeId, nodeId))
      .limit(1);
    if (hosted.length === 0) return;
    for (const handoff of this.nodeUpdateHandoffs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          handoff(nodeId),
          new Promise<void>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('the handoff did not finish in time')),
              NODE_UPDATE_HANDOFF_TIMEOUT_MS
            );
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        const timedOut = (error as Error).message === 'the handoff did not finish in time';
        if (timedOut || (error as { code?: string }).code === 'AVAILABILITY_HANDOFF_FAILED') {
          logger.warn('Availability primaries did not hand over before the node update; it is postponed', {
            nodeId,
            error: (error as Error).message,
          });
          throw new NodeUpdatePostponedError(
            timedOut
              ? 'The update was postponed: a primary on this node was still handing over to its copy'
              : `The update was postponed: ${(error as Error).message}`
          );
        }
        logger.warn('Availability primaries did not hand over before the node update; it goes on', {
          nodeId,
          error: (error as Error).message,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  private async memberStopped(set: AvailabilitySetRow, member: AvailabilityMemberRow): Promise<boolean> {
    for (const provider of this.runStateProviders) {
      try {
        if ((await provider(set, member)).stopped) return true;
      } catch (error) {
        logger.warn('Availability member run state is unknown; the member keeps running', {
          setId: set.id,
          memberId: member.id,
          error: (error as Error).message,
        });
      }
    }
    return false;
  }

  private async loadSet(setId: string): Promise<{ set: AvailabilitySetRow; members: AvailabilityMemberRow[] } | null> {
    const [set] = await this.db.select().from(managedAvailabilitySets).where(eq(managedAvailabilitySets.id, setId));
    if (!set) return null;
    const members = await this.db
      .select()
      .from(managedAvailabilityMembers)
      .where(eq(managedAvailabilityMembers.setId, setId));
    members.sort((a, b) => a.memberIndex - b.memberIndex);
    return { set, members };
  }

  /** The configuration of one member as its node applies it. */
  async memberConfig(
    set: AvailabilitySetRow,
    members: AvailabilityMemberRow[],
    member: AvailabilityMemberRow
  ): Promise<AvailabilityMemberConfig> {
    const provider = this.engineConfig.get(set.engine);
    const engineConfig = provider ? await provider(set.id, member.id) : undefined;
    const config: AvailabilityMemberConfig = {
      setId: set.id,
      memberId: member.id,
      engine: set.engine,
      ownerKind: set.ownerKind,
      ownerId: set.ownerId,
      mode: set.mode,
      durability: set.durability,
      syncDegradeAfterSeconds: set.syncDegradeAfterSeconds,
      maxLagBytes: String(set.maxLagBytes),
      members: members.map((peer) => ({
        memberId: peer.id,
        nodeId: peer.nodeId,
        memberIndex: peer.memberIndex,
        priority: peer.priority,
        removing: peer.desiredState === 'removing',
      })),
      configRevision: String(set.configRevision),
      publishedPort: member.publishedPort ?? 0,
    };
    if (set.mode === 'automatic' && set.leasePolicyId) config.leasePolicyId = set.leasePolicyId;
    const assignment = await this.signedAssignment(set);
    if (assignment) config.primary = assignment;
    if (engineConfig) config.engineConfig = Buffer.from(JSON.stringify(engineConfig));
    if (await this.memberStopped(set, member)) config.stopped = true;
    return config;
  }

  private async send(nodeId: string, command: AvailabilityMemberCommand): Promise<CommandResult | null> {
    return this.dispatch.sendAvailabilityMember(nodeId, command, COMMAND_TIMEOUT_MS);
  }

  /**
   * Sends the current configuration to every member's node (after members, settings, the lease policy or published
   * ports changed; bump `config_revision` first). Returns the members whose node did not take it.
   */
  async configureSet(setId: string, onlyMemberId?: string): Promise<string[]> {
    return (await this.configureSetResults(setId, onlyMemberId)).map((failure) => failure.memberId);
  }

  /**
   * configureSet with the reason of every member whose node did not take the configuration: `refused` when the node
   * (or the rules it applies, availability-member-config.rules.ts) refused it, which does not clear on its own; not
   * refused when the node was unreachable or does not run availability members (yet).
   */
  async configureSetResults(setId: string, onlyMemberId?: string): Promise<AvailabilityMemberConfigureFailure[]> {
    const loaded = await this.loadSet(setId);
    if (!loaded) return [];
    const failed: AvailabilityMemberConfigureFailure[] = [];
    for (const member of loaded.members) {
      if (onlyMemberId && member.id !== onlyMemberId) continue;
      const fail = (error: string, refused: boolean) => {
        failed.push({ memberId: member.id, nodeId: member.nodeId, error, refused });
        logger.warn('Availability member configuration was not applied', {
          setId,
          memberId: member.id,
          nodeId: member.nodeId,
          error,
        });
      };
      try {
        const config = await this.memberConfig(loaded.set, loaded.members, member);
        // A configuration the node is bound to refuse is not sent (an automatic set before its lease policy exists).
        const invalid = availabilityMemberConfigError(config);
        if (invalid) {
          fail(invalid, true);
          continue;
        }
        const result = await this.send(member.nodeId, { configure: config });
        if (!result) {
          fail('the node does not run availability members', false);
          continue;
        }
        if (!result.success) {
          fail(result.error || 'the node refused the configuration', true);
          continue;
        }
        this.lastConfigured.set(member.id, { revision: loaded.set.configRevision, at: this.now() });
      } catch (error) {
        fail(`unreachable: ${(error as Error).message}`, false);
      }
    }
    return failed;
  }

  /** Stops a member for good on its node (it runs as a stopped copy until its runtime is removed). */
  async removeMember(setId: string, memberId: string, nodeId: string): Promise<CommandResult | null> {
    return this.send(nodeId, { remove: { setId, memberId } });
  }

  /**
   * Sends a manual pair's primary assignment to every member: the given one (already signed), or the set's current
   * one signed now. Returns the members whose node did not take it.
   */
  async assignPrimary(
    setId: string,
    assignment?: AvailabilityPrimaryAssignment,
    onlyMemberId?: string
  ): Promise<string[]> {
    const loaded = await this.loadSet(setId);
    if (!loaded) return [];
    const signed = assignment ?? (await this.signedAssignment(loaded.set));
    if (!signed) throw new Error('The availability set has no signed primary assignment to send');
    const failed: string[] = [];
    for (const member of loaded.members) {
      // A planned manual switch tells the old primary alone first (it steps down before the copy is promoted).
      if (onlyMemberId && member.id !== onlyMemberId) continue;
      const result = await this.send(member.nodeId, { assignPrimary: signed }).catch(() => null);
      if (!result?.success) failed.push(member.id);
    }
    return failed;
  }

  /** Restarts one member's engine on its node (every engine); the primary only with allowPrimary. */
  async restartMember(
    setId: string,
    memberId: string,
    nodeId: string,
    operationId: string,
    allowPrimary: boolean
  ): Promise<CommandResult | null> {
    return this.send(nodeId, {
      restart: { setId, memberId, operationId, ...(allowPrimary ? { allowPrimary: true } : {}) },
    });
  }

  /** Asks the holder's node for a planned switchover to successorMemberId (automatic sets). */
  async switchover(
    setId: string,
    holderNodeId: string,
    successorMemberId: string,
    operationId: string
  ): Promise<CommandResult | null> {
    return this.send(holderNodeId, { switchover: { setId, successorMemberId, operationId } });
  }

  /** Ingests the member reports of one node's health report. */
  async ingestReports(nodeId: string, reports: AvailabilityMemberReport[]): Promise<void> {
    if (this.ingesting.has(nodeId)) return;
    this.ingesting.add(nodeId);
    try {
      await this.ingestReportsNow(nodeId, reports);
    } finally {
      this.ingesting.delete(nodeId);
    }
  }

  private async ingestReportsNow(nodeId: string, reports: AvailabilityMemberReport[]): Promise<void> {
    const reported = new Set(reports.map((report) => report.memberId));
    const rows = await this.db
      .select({ member: managedAvailabilityMembers, set: managedAvailabilitySets })
      .from(managedAvailabilityMembers)
      .innerJoin(managedAvailabilitySets, eq(managedAvailabilitySets.id, managedAvailabilityMembers.setId))
      .where(eq(managedAvailabilityMembers.nodeId, nodeId));
    for (const { member, set } of rows) {
      const report = reports.find((candidate) => candidate.memberId === member.id && candidate.setId === set.id);
      if (!report) {
        if (!reported.has(member.id) && member.desiredState === 'member') {
          // The node does not run the member (it lost its file, or the configuration never arrived).
          await this.maybeReconfigure(set, member, -1);
        }
        continue;
      }
      try {
        await this.applyReport(set, member, report);
      } catch (error) {
        logger.warn('Availability member report was not recorded', {
          setId: set.id,
          memberId: member.id,
          error: (error as Error).message,
        });
      }
    }
  }

  private async maybeReconfigure(set: AvailabilitySetRow, member: AvailabilityMemberRow, reported: number) {
    if (reported >= set.configRevision) return;
    const last = this.lastConfigured.get(member.id);
    if (last && last.revision >= set.configRevision && this.now() - last.at < RECONFIGURE_RETRY_MS) return;
    this.lastConfigured.set(member.id, { revision: set.configRevision, at: this.now() });
    await this.configureSet(set.id, member.id);
  }

  /**
   * A manual pair's assigned primary that does not serve (it self-fenced, or its daemon restarted) promotes only once
   * it confirmed the current assignment from Gateway or its peer: Gateway sends it again (at most every
   * ASSIGNMENT_CONFIRM_RETRY_MS per member).
   */
  private async maybeConfirmAssignment(
    set: AvailabilitySetRow,
    member: AvailabilityMemberRow,
    report: AvailabilityMemberReport
  ): Promise<void> {
    if (set.mode !== 'manual' || set.primaryMemberId !== member.id || report.role === 'primary') return;
    if (member.desiredState !== 'member' || !this.signer) return;
    const last = this.assignmentConfirmSent.get(member.id) ?? 0;
    if (this.now() - last < ASSIGNMENT_CONFIRM_RETRY_MS) return;
    this.assignmentConfirmSent.set(member.id, this.now());
    try {
      await this.assignPrimary(set.id, undefined, member.id);
    } catch (error) {
      logger.warn('The primary assignment was not sent again to the assigned primary', {
        setId: set.id,
        memberId: member.id,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Asks the nodes of manual pairs for a health report every MANUAL_CONTACT_INTERVAL_MS: each request is the contact
   * a manual primary needs to keep serving (it self-fences 30 s after the last one), and the reports keep Gateway's
   * view of it fresh (the 45 s rule of a lossy switch counts from the last report). Returns a stop function.
   */
  startManualPairContact(requestHealth: (nodeId: string) => void): () => void {
    const timer = setInterval(() => {
      void this.manualPairNodes()
        .then((nodeIds) => {
          for (const nodeId of nodeIds) requestHealth(nodeId);
        })
        .catch((error: unknown) =>
          logger.debug('Manual pair nodes could not be listed', { error: (error as Error).message })
        );
    }, MANUAL_CONTACT_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async manualPairNodes(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ nodeId: managedAvailabilityMembers.nodeId })
      .from(managedAvailabilityMembers)
      .innerJoin(managedAvailabilitySets, eq(managedAvailabilitySets.id, managedAvailabilityMembers.setId))
      .where(eq(managedAvailabilitySets.mode, 'manual'));
    return rows.map((row) => row.nodeId);
  }

  /** The copies a manual pair's primary last reported confirming synchronously (pgha `syncCopies`). */
  private async primarySyncCopies(primaryMemberId: string): Promise<string[]> {
    const [primary] = await this.db
      .select({ enginePosition: managedAvailabilityMembers.enginePosition })
      .from(managedAvailabilityMembers)
      .where(eq(managedAvailabilityMembers.id, primaryMemberId))
      .limit(1);
    const value = (primary?.enginePosition as Record<string, unknown> | null | undefined)?.syncCopies;
    return typeof value === 'string' && value ? value.split(',') : [];
  }

  private async applyReport(set: AvailabilitySetRow, member: AvailabilityMemberRow, report: AvailabilityMemberReport) {
    const reportedAt = new Date(this.now());
    const position: Record<string, string> = { ...(report.position ?? {}) };
    delete position[MEMBER_RUNTIME_STOPPED_KEY];
    delete position[MEMBER_RUNTIME_PENDING_RESTART_KEY];
    if (report.stopped) position[MEMBER_RUNTIME_STOPPED_KEY] = 'true';
    if (report.pendingRestartOperationId)
      position[MEMBER_RUNTIME_PENDING_RESTART_KEY] = report.pendingRestartOperationId;
    let syncState = normalizeSyncState(report.syncState);
    if (set.mode === 'manual' && syncState === 'async' && set.primaryMemberId && set.primaryMemberId !== member.id) {
      // A Postgres standby cannot see its own sync_state and a manual pair certifies nothing: the primary's report
      // names the copies its walsenders confirm synchronously.
      syncState = (await this.primarySyncCopies(set.primaryMemberId)).includes(member.id) ? 'sync' : 'async';
    }
    await this.db
      .update(managedAvailabilityMembers)
      .set({
        role: normalizeRole(report.role),
        eligible: report.eligible,
        eligibilityReason: report.eligibilityReason ? report.eligibilityReason.slice(0, 64) : null,
        lagBytes: report.lagBytes === undefined ? null : Number(report.lagBytes),
        lagSeconds: report.lagSeconds ?? null,
        syncState,
        enginePosition: position,
        lastError: report.lastError || (copyNotStreaming(report) ? COPY_NOT_STREAMING : null),
        status: reportedStatus(member, report),
        lastReportedAt: reportedAt,
        updatedAt: reportedAt,
      })
      .where(eq(managedAvailabilityMembers.id, member.id));
    await this.maybeReconfigure(set, member, Number(report.configRevision ?? 0));
    await this.maybeConfirmAssignment(set, member, report);
    if (report.role === 'primary' && report.serving && set.primaryMemberId !== member.id) {
      await this.followPrimary(set, member, reportedAt);
    }
    if (report.events?.length) await this.deliverEvents(set, member, report.events);
  }

  /**
   * The member serves as primary: the set and the resource's node follow it, so readers of `node_id` (tools,
   * monitoring, backups, certificate renewal) reach the primary. The data plane never depends on it.
   */
  private async followPrimary(set: AvailabilitySetRow, member: AvailabilityMemberRow, at: Date) {
    const previous = set.primaryMemberId;
    const updated = await this.db.transaction(async (tx) => {
      const [moved] = await tx
        .update(managedAvailabilitySets)
        .set({ primaryMemberId: member.id, primarySince: at, updatedAt: at })
        .where(
          and(
            eq(managedAvailabilitySets.id, set.id),
            previous === null
              ? sql`${managedAvailabilitySets.primaryMemberId} IS NULL`
              : eq(managedAvailabilitySets.primaryMemberId, previous)
          )
        )
        .returning({ id: managedAvailabilitySets.id });
      if (!moved) return false;
      if (set.ownerKind === 'managed_database') {
        await tx
          .update(managedDatabaseInstances)
          .set({ nodeId: member.nodeId, updatedAt: at })
          .where(eq(managedDatabaseInstances.id, set.ownerId));
      } else {
        await tx
          .update(managedStorageClusters)
          .set({ nodeId: member.nodeId, updatedAt: at })
          .where(eq(managedStorageClusters.id, set.ownerId));
      }
      return true;
    });
    if (!updated) return;
    logger.info('Availability set primary moved', { setId: set.id, memberId: member.id, nodeId: member.nodeId });
    const current = { ...set, primaryMemberId: member.id, primarySince: at };
    for (const listener of this.primaryListeners) {
      try {
        await listener(current, member, previous);
      } catch (error) {
        logger.warn('Availability primary listener failed', { setId: set.id, error: (error as Error).message });
      }
    }
  }

  private async deliverEvents(set: AvailabilitySetRow, member: AvailabilityMemberRow, raw: AvailabilityMemberEvent[]) {
    const events = raw
      .map(
        (event): AvailabilityMemberEventRecord => ({
          sequence: Number(event.sequence),
          kind: event.kind,
          at: new Date(Number(event.atUnixMs)),
          reason: event.reason || null,
          operationId: event.operationId || null,
          detail: event.detail ?? {},
        })
      )
      .filter((event) => Number.isFinite(event.sequence) && event.sequence > 0)
      .sort((a, b) => a.sequence - b.sequence);
    if (events.length === 0) return;
    const fresh = member.lastEventAt
      ? events.filter((event) => event.at.getTime() > member.lastEventAt!.getTime())
      : events;
    if (fresh.length > 0) {
      for (const listener of this.eventListeners) {
        await listener(set, member, fresh);
      }
      const newest = new Date(Math.max(...fresh.map((event) => event.at.getTime())));
      await this.db
        .update(managedAvailabilityMembers)
        .set({ lastEventAt: newest })
        .where(eq(managedAvailabilityMembers.id, member.id));
    }
    const through = events[events.length - 1]!.sequence;
    await this.send(member.nodeId, {
      ackEvents: { setId: set.id, memberId: member.id, throughSequence: String(through) },
    }).catch((error) => {
      logger.debug('Availability member events were not acknowledged', {
        setId: set.id,
        memberId: member.id,
        error: (error as Error).message,
      });
    });
  }

  /** Members of the sets on the given nodes (for callers that need the node's members, e.g. node removal checks). */
  async membersOnNodes(nodeIds: string[]): Promise<AvailabilityMemberRow[]> {
    if (nodeIds.length === 0) return [];
    return this.db.select().from(managedAvailabilityMembers).where(inArray(managedAvailabilityMembers.nodeId, nodeIds));
  }
}

function normalizeRole(role: string | undefined): ManagedAvailabilityMemberRole {
  switch (role) {
    case 'primary':
    case 'copy':
    case 'rebuilding':
    case 'fenced':
      return role;
    default:
      return 'unknown';
  }
}

/** What a member whose engine runs as a copy but does not stream shows (it holds none of the primary's new data). */
export const COPY_NOT_STREAMING = 'The copy does not stream from the primary';

/** A member reporting as a copy whose engine replicates from no primary (sync state none). */
function copyNotStreaming(report: Pick<AvailabilityMemberReport, 'role' | 'syncState'>): boolean {
  return report.role === 'copy' && normalizeSyncState(report.syncState) === 'none';
}

/**
 * A member is ready when it serves as the primary or streams from it as a copy: a copy that does not stream (a cluster
 * that is not a copy of the primary's, a mesh that cannot reach it) is an error, a member being seeded or rebuilt is
 * creating. Nothing that does not hold the primary's data shows ready.
 */
export function reportedStatus(
  member: Pick<AvailabilityMemberRow, 'desiredState'>,
  report: Pick<AvailabilityMemberReport, 'role' | 'syncState'>
): AvailabilityMemberRow['status'] {
  if (member.desiredState === 'removing') return 'removing';
  if (report.role === 'rebuilding') return 'creating';
  if (copyNotStreaming(report)) return 'error';
  return 'ready';
}

function normalizeSyncState(state: string | undefined): ManagedAvailabilityMemberSyncState {
  return state === 'sync' || state === 'async' ? state : 'none';
}
