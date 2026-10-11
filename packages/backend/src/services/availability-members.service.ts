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
import type { NodeDispatchService } from './node-dispatch.service.js';

const logger = createChildLogger('AvailabilityMembers');

export { MANAGED_AVAILABILITY_MEMBER_CAPABILITY } from './node-dispatch.service.js';

/** A member that reports an older configuration revision than the set's is configured again at most this often. */
const RECONFIGURE_RETRY_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;

export type AvailabilitySetRow = typeof managedAvailabilitySets.$inferSelect;
export type AvailabilityMemberRow = typeof managedAvailabilityMembers.$inferSelect;

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
/** A node update waits at most this long for the set primaries on the node to hand over. */
const NODE_UPDATE_HANDOFF_TIMEOUT_MS = 5 * 60_000;

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
   * (the owner kinds' handoffs start a planned switchover and wait for it). Bounded; a handoff that fails or times out
   * only logs, and the update goes on (the set then fails over or waits as for any restart).
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
    const loaded = await this.loadSet(setId);
    if (!loaded) return [];
    const failed: string[] = [];
    for (const member of loaded.members) {
      if (onlyMemberId && member.id !== onlyMemberId) continue;
      try {
        const result = await this.send(member.nodeId, {
          configure: await this.memberConfig(loaded.set, loaded.members, member),
        });
        if (!result?.success) {
          failed.push(member.id);
          logger.warn('Availability member configuration was not applied', {
            setId,
            memberId: member.id,
            nodeId: member.nodeId,
            error: result ? result.error : 'the node does not run availability members',
          });
          continue;
        }
        this.lastConfigured.set(member.id, { revision: loaded.set.configRevision, at: this.now() });
      } catch (error) {
        failed.push(member.id);
        logger.warn('Availability member configuration was not sent', {
          setId,
          memberId: member.id,
          error: (error as Error).message,
        });
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
  async assignPrimary(setId: string, assignment?: AvailabilityPrimaryAssignment): Promise<string[]> {
    const loaded = await this.loadSet(setId);
    if (!loaded) return [];
    const signed = assignment ?? (await this.signedAssignment(loaded.set));
    if (!signed) throw new Error('The availability set has no signed primary assignment to send');
    const failed: string[] = [];
    for (const member of loaded.members) {
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

  private async applyReport(set: AvailabilitySetRow, member: AvailabilityMemberRow, report: AvailabilityMemberReport) {
    const reportedAt = new Date(this.now());
    const position: Record<string, string> = { ...(report.position ?? {}) };
    delete position[MEMBER_RUNTIME_STOPPED_KEY];
    delete position[MEMBER_RUNTIME_PENDING_RESTART_KEY];
    if (report.stopped) position[MEMBER_RUNTIME_STOPPED_KEY] = 'true';
    if (report.pendingRestartOperationId)
      position[MEMBER_RUNTIME_PENDING_RESTART_KEY] = report.pendingRestartOperationId;
    await this.db
      .update(managedAvailabilityMembers)
      .set({
        role: normalizeRole(report.role),
        eligible: report.eligible,
        eligibilityReason: report.eligibilityReason ? report.eligibilityReason.slice(0, 64) : null,
        lagBytes: report.lagBytes === undefined ? null : Number(report.lagBytes),
        lagSeconds: report.lagSeconds ?? null,
        syncState: normalizeSyncState(report.syncState),
        enginePosition: position,
        lastError: report.lastError || null,
        status: member.desiredState === 'removing' ? 'removing' : 'ready',
        lastReportedAt: reportedAt,
        updatedAt: reportedAt,
      })
      .where(eq(managedAvailabilityMembers.id, member.id));
    await this.maybeReconfigure(set, member, Number(report.configRevision ?? 0));
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

function normalizeSyncState(state: string | undefined): ManagedAvailabilityMemberSyncState {
  return state === 'sync' || state === 'async' ? state : 'none';
}
