import { createChildLogger } from '@/lib/logger.js';
import {
  LEASE_PEER_SETTLE_TIMEOUT_MS,
  type LeaseUpdateBlocker,
  type LeaseUpdateView,
  leasePoliciesOf,
  leaseUpdateBlockers,
} from './daemon-update-lease-gate.js';

const logger = createChildLogger('DaemonUpdateRollout');

/** Requests for lease members arriving together are ordered together (standbys before holders). */
export const DAEMON_UPDATE_COALESCE_MS = 2_000;
/** How often waiting requests look at their peers again. */
export const DAEMON_UPDATE_POLL_MS = 2_000;
/** The longest an update waits for its lease peers before it gives up with a clear error. */
export const DAEMON_UPDATE_QUEUE_TIMEOUT_MS = 30 * 60_000;

export class DaemonUpdateWaitTimeoutError extends Error {
  constructor(
    readonly memberId: string,
    readonly blockers: LeaseUpdateBlocker[]
  ) {
    super(
      `Update of ${memberId} waited ${Math.round(DAEMON_UPDATE_QUEUE_TIMEOUT_MS / 60_000)} min for lease peers ` +
        `that did not settle: ${blockers.map((blocker) => `${blocker.memberId} ${blocker.reason}`).join(', ') || 'none'}`
    );
    this.name = 'DaemonUpdateWaitTimeoutError';
  }
}

export interface DaemonUpdateRolloutRequest {
  /** Lease member id: the node id of a docker daemon, the relay instance id of a relay. */
  memberId: string;
  /** Restarts the member (sends the update, or lets a relay rollout step go on). */
  run: () => Promise<void>;
  /** Called when the reasons the request waits for change. */
  onWait?: (blockers: LeaseUpdateBlocker[]) => Promise<void> | void;
  /**
   * Reasons of the request's own to wait, looked at in each pass besides its lease peers (an ingress node waits for
   * the other nodes of its batch). They never fail the request: past its timeout it goes ahead without them.
   */
  waitFor?: () => Promise<LeaseUpdateBlocker[]>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface QueuedRequest extends DaemonUpdateRolloutRequest {
  enqueuedAt: number;
  waitKey: string;
  /** The operator's "update now": the request goes in the next pass whatever it waits for. */
  skipWait?: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface DaemonUpdateRolloutDeps {
  loadView: () => Promise<LeaseUpdateView>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  coalesceMs?: number;
  pollMs?: number;
}

/**
 * Serializes restarts of lease members (A-rolling updates): a daemon or relay that votes in or is a candidate of an
 * availability policy in lease mode restarts only while every other voter and candidate of each of its lease policies
 * has settled (see daemon-update-lease-gate). Among requests that could go, standbys go before holders, then the
 * oldest first; requests of members that share no lease policy go in the same pass. Members of no lease policy never
 * enter the queue, except ingress nodes, which wait for the other nodes of their batch (request.waitFor).
 */
export class DaemonUpdateRollout {
  private readonly queue: QueuedRequest[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private passing: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly coalesceMs: number;
  private readonly pollMs: number;

  constructor(private readonly deps: DaemonUpdateRolloutDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.coalesceMs = deps.coalesceMs ?? DAEMON_UPDATE_COALESCE_MS;
    this.pollMs = deps.pollMs ?? DAEMON_UPDATE_POLL_MS;
  }

  /** Whether a member votes in or is a candidate of a lease policy, so its restart must be sequenced. */
  async isLeaseMember(memberId: string): Promise<boolean> {
    const view = await this.deps.loadView();
    return leasePoliciesOf(view.topology, memberId).length > 0;
  }

  /** Member ids waiting, in queue order. */
  pending(): string[] {
    return this.queue.map((request) => request.memberId);
  }

  /** Resolves once the request ran; rejects when it timed out, was aborted, or its run failed. */
  enqueue(request: DaemonUpdateRolloutRequest): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const queued: QueuedRequest = { ...request, enqueuedAt: this.now(), waitKey: '', resolve, reject };
      this.queue.push(queued);
      request.signal?.addEventListener(
        'abort',
        () => {
          if (this.remove(queued)) reject(new Error(`Update of ${request.memberId} was abandoned`));
        },
        { once: true }
      );
      this.arm(this.coalesceMs);
    });
  }

  /**
   * The operator's "update now" for a member whose update waits in the queue: it goes in the next pass without waiting
   * for its lease peers. False when no update of the member waits here.
   */
  releaseWait(memberId: string): boolean {
    const request = this.queue.find((queued) => queued.memberId === memberId);
    if (!request) return false;
    request.skipWait = true;
    void this.runPass();
    return true;
  }

  /**
   * After a member restarted (at `since`), waits until it reports its lease state again with an acceptor that does
   * not abstain, bounded by LEASE_PEER_SETTLE_TIMEOUT_MS. A member of no lease policy is settled at once.
   */
  async awaitSettled(memberId: string, since: number, signal?: AbortSignal): Promise<'settled' | 'timed_out'> {
    const deadline = since + LEASE_PEER_SETTLE_TIMEOUT_MS;
    for (;;) {
      if (signal?.aborted) throw new Error(`Update of ${memberId} was abandoned`);
      const view = await this.deps.loadView().catch(() => null);
      if (view) {
        if (leasePoliciesOf(view.topology, memberId).length === 0) return 'settled';
        const state = view.states.get(memberId);
        if (!state) return 'settled';
        if (state.reportedAt !== null && state.reportedAt >= since && !state.abstaining) return 'settled';
      }
      if (this.now() >= deadline) {
        logger.warn('Lease member did not report a voting acceptor after its update in time; the rollout goes on', {
          memberId,
          waitedMs: this.now() - since,
        });
        return 'timed_out';
      }
      await this.sleep(this.pollMs);
    }
  }

  /** One scheduling pass; the timer runs it, tests call it directly. */
  async runPass(): Promise<void> {
    if (this.passing) return this.passing;
    this.passing = this.pass().finally(() => {
      this.passing = null;
      if (this.queue.length > 0) this.arm(this.pollMs);
    });
    return this.passing;
  }

  private async pass(): Promise<void> {
    if (this.queue.length === 0) return;
    let view: LeaseUpdateView;
    try {
      view = await this.deps.loadView();
    } catch (error) {
      logger.warn('Lease state for the daemon update rollout is unavailable; retrying', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const now = this.now();
    const holds = (request: QueuedRequest) => (view.topology.holders.has(request.memberId) ? 1 : 0);
    const ordered = [...this.queue].sort(
      (left, right) =>
        holds(left) - holds(right) || left.enqueuedAt - right.enqueuedAt || left.memberId.localeCompare(right.memberId)
    );
    // Policies whose member this pass lets restart: another member of them waits for the next pass, when the
    // restart shows in the lease state (update phase, relay step).
    const claimed = new Map<string, string>();
    for (const request of ordered) {
      const policies = leasePoliciesOf(view.topology, request.memberId);
      const { blockers, settleTimedOut } = leaseUpdateBlockers(view, request.memberId, now);
      for (const policyId of policies) {
        const other = claimed.get(policyId);
        if (other) blockers.push({ memberId: other, policyId, reason: 'updating' });
      }
      const timedOut = now - request.enqueuedAt >= (request.timeoutMs ?? DAEMON_UPDATE_QUEUE_TIMEOUT_MS);
      if (request.waitFor && !timedOut) {
        blockers.push(
          ...(await request.waitFor().catch((error: unknown) => {
            logger.warn('Daemon update could not check the other nodes of its batch; it goes ahead', {
              memberId: request.memberId,
              error: error instanceof Error ? error.message : String(error),
            });
            return [];
          }))
        );
      }
      if (blockers.length > 0 && request.skipWait) {
        logger.warn('Daemon update goes ahead on request without waiting for its lease peers', {
          memberId: request.memberId,
          waitingFor: blockers,
        });
      } else if (blockers.length > 0) {
        if (timedOut) {
          this.remove(request);
          request.reject(new DaemonUpdateWaitTimeoutError(request.memberId, blockers));
          continue;
        }
        const waitKey = blockers.map((blocker) => `${blocker.memberId}:${blocker.reason}`).join(',');
        if (waitKey !== request.waitKey) {
          request.waitKey = waitKey;
          logger.info(
            blockers.every((blocker) => blocker.reason === 'ingress_last')
              ? 'Ingress node update waits for the other nodes of its batch'
              : 'Daemon update waits for lease peers of the same availability policy',
            { memberId: request.memberId, waitingFor: blockers }
          );
          await Promise.resolve(request.onWait?.(blockers)).catch(() => undefined);
        }
        continue;
      }
      if (settleTimedOut.length > 0) {
        logger.warn('Lease peers did not settle in time; the update goes on without them', {
          memberId: request.memberId,
          peers: settleTimedOut,
        });
      }
      for (const policyId of policies) claimed.set(policyId, request.memberId);
      this.remove(request);
      try {
        await request.run();
        request.resolve();
      } catch (error) {
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private remove(request: QueuedRequest): boolean {
    const index = this.queue.indexOf(request);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  private arm(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runPass();
    }, delayMs);
    this.timer.unref?.();
  }
}
