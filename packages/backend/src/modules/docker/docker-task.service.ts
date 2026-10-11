import { and, desc, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { type DockerTaskFollowUps, type DockerTaskTracking, dockerTasks } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { EventBusService } from '@/services/event-bus.service.js';

const logger = createChildLogger('DockerTaskService');
const ACTIVE_TASK_STATUSES = ['pending', 'running'] as const;
const COMPLETED_TASK_STATUSES = ['completed', 'succeeded', 'failed'] as const;
const STALE_ACTIVE_TASK_TIMEOUT_MS = 60 * 60 * 1000;
const LOST_STARTUP_TRACKING_ERROR = 'Task tracking interrupted by backend restart';
/** Progress of a task Gateway lost track of while the node may still run it. */
export const DETACHED_TASK_PROGRESS = 'Opfield lost track of it; checks with the node once it is connected';

export type DockerTaskRow = typeof dockerTasks.$inferSelect;
/** A task as the API shows it: without what Gateway keeps to settle it with its node and what it still owes then. */
export type PublicDockerTask = Omit<DockerTaskRow, 'tracking' | 'commandId' | 'followUps'>;

/**
 * Records a task's tracking without ever failing the operation it belongs to: tracking only lets Gateway settle the
 * task later, should it lose track of it. Resolves whether it was recorded.
 */
export function trackDockerTask(
  taskService: Pick<DockerTaskService, 'track'> | undefined,
  id: string | undefined,
  tracking: DockerTaskTracking,
  commandId?: string
): Promise<boolean> {
  if (!taskService || !id) return Promise.resolve(false);
  return Promise.resolve()
    .then(() => taskService.track(id, tracking, commandId))
    .then(
      () => true,
      () => false
    );
}

/** Detaches a task (see DockerTaskService.detach) without ever throwing; resolves whether it was kept. */
export function detachDockerTask(
  taskService: Pick<DockerTaskService, 'detach'> | undefined,
  id: string | undefined,
  error: string
): Promise<boolean> {
  if (!taskService || !id) return Promise.resolve(false);
  return Promise.resolve()
    .then(() => taskService.detach(id, error))
    .then(
      (kept) => kept === true,
      () => false
    );
}

export function publicDockerTask(row: DockerTaskRow): PublicDockerTask {
  const { tracking: _tracking, commandId: _commandId, followUps: _followUps, ...task } = row;
  return task;
}

function isCompletedTaskStatus(status: string | undefined): boolean {
  return COMPLETED_TASK_STATUSES.includes(status as (typeof COMPLETED_TASK_STATUSES)[number]);
}

/** A status that ends the task: whatever it is set to besides pending or running. */
function endsTask(status: string | undefined): boolean {
  return status !== undefined && !ACTIVE_TASK_STATUSES.includes(status as (typeof ACTIVE_TASK_STATUSES)[number]);
}

export class DockerTaskService {
  constructor(private db: DrizzleClient) {}

  private eventBus?: EventBusService;
  private containerTaskTerminalHandler?: (task: {
    nodeId: string;
    containerId: string | null;
    containerName: string | null;
  }) => void | Promise<void>;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }
  setContainerTaskTerminalHandler(
    handler: (task: {
      nodeId: string;
      containerId: string | null;
      containerName: string | null;
    }) => void | Promise<void>
  ) {
    this.containerTaskTerminalHandler = handler;
  }
  private async handleContainerTaskTerminal(task: {
    nodeId: string;
    containerId?: string | null;
    containerName?: string | null;
  }) {
    await this.containerTaskTerminalHandler?.({
      nodeId: task.nodeId,
      containerId: task.containerId ?? null,
      containerName: task.containerName ?? null,
    });
  }
  private emit(task: { id: string; nodeId: string; status: string; progress?: string | null; error?: string | null }) {
    this.eventBus?.publish('docker.task.changed', {
      taskId: task.id,
      nodeId: task.nodeId,
      status: task.status,
      progress: task.progress ?? null,
      error: task.error ?? null,
    });
  }

  async list(filters?: {
    nodeId?: string;
    status?: string;
    type?: string;
    /** The newest this many tasks; all when omitted. */
    limit?: number;
    allowedNodeIds?: string[];
  }) {
    await this.markStaleActiveTasksFailed();
    const conditions = [];
    if (filters?.nodeId) conditions.push(eq(dockerTasks.nodeId, filters.nodeId));
    if (filters?.status) conditions.push(eq(dockerTasks.status, filters.status));
    if (filters?.type) conditions.push(eq(dockerTasks.type, filters.type));
    if (filters?.allowedNodeIds) {
      if (filters.allowedNodeIds.length === 0) return [];
      conditions.push(inArray(dockerTasks.nodeId, filters.allowedNodeIds));
    }

    const query = this.db
      .select()
      .from(dockerTasks)
      .where(buildWhere(conditions))
      .orderBy(desc(dockerTasks.createdAt))
      .$dynamic();
    const rows = await (filters?.limit ? query.limit(filters.limit) : query);
    return rows.map(publicDockerTask);
  }

  async get(id: string) {
    await this.markStaleActiveTasksFailed();
    const [row] = await this.db.select().from(dockerTasks).where(eq(dockerTasks.id, id)).limit(1);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Docker task not found');
    return publicDockerTask(row);
  }

  /**
   * Waits until the task ends (any status besides pending or running) or `timeoutMs` passes, reading it every
   * `pollMs`. Returns the last row read: still active after the timeout, null when the task is gone.
   */
  async waitForEnd(id: string, timeoutMs: number, pollMs = 2000): Promise<PublicDockerTask | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await this.db.select().from(dockerTasks).where(eq(dockerTasks.id, id)).limit(1);
      if (!row) return null;
      if (endsTask(row.status) || Date.now() >= deadline) return publicDockerTask(row);
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    }
  }

  async forceCancel(id: string) {
    await this.markStaleActiveTasksFailed();
    const [existing] = await this.db.select().from(dockerTasks).where(eq(dockerTasks.id, id)).limit(1);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Docker task not found');
    if (!ACTIVE_TASK_STATUSES.includes(existing.status as (typeof ACTIVE_TASK_STATUSES)[number])) {
      throw new AppError(409, 'TASK_NOT_ACTIVE', 'Only pending or running Docker tasks can be force-cancelled');
    }

    return publicDockerTask(
      await this.update(id, {
        status: 'failed',
        error: 'Force-cancelled by user',
        completedAt: new Date(),
      })
    );
  }

  async create(input: { nodeId: string; containerId?: string; containerName?: string; type: string }) {
    await this.markStaleActiveTasksFailed();
    const [row] = await this.db
      .insert(dockerTasks)
      .values({
        nodeId: input.nodeId,
        containerId: input.containerId ?? null,
        containerName: input.containerName ?? null,
        type: input.type,
        status: 'pending',
      })
      .returning();

    this.emit(row);
    return row;
  }

  async markStaleActiveTasksFailed(now = new Date()) {
    const cutoff = new Date(now.getTime() - STALE_ACTIVE_TASK_TIMEOUT_MS);
    const rows = await this.db
      .update(dockerTasks)
      .set({
        status: 'failed',
        error: 'Timed out after backend restart or lost task watcher',
        completedAt: now,
        followUps: null,
      })
      .where(and(inArray(dockerTasks.status, [...ACTIVE_TASK_STATUSES]), lt(dockerTasks.createdAt, cutoff)))
      .returning();

    for (const row of rows) {
      this.emit(row);
      await this.handleContainerTaskTerminal(row);
    }
    if (rows.length > 0) {
      logger.warn(`Marked ${rows.length} stale docker task(s) as failed`);
    }
    return rows.length;
  }

  /**
   * At startup no task has a watch in this process. A task Gateway can settle with its node (it has tracking: an image
   * pull, a stop, restart, kill, update or recreate the node runs on) stays active, detached, so a daemon update that
   * waits for the node's tasks still sees it; it is settled once the node is connected (DockerTaskReconciler). A task
   * without tracking fails as before.
   */
  async detachActiveTasksOnStartup(now = new Date()) {
    const detached = await this.db
      .update(dockerTasks)
      .set({
        detachedAt: sql`coalesce(${dockerTasks.detachedAt}, ${now.toISOString()}::timestamptz)`,
        progress: DETACHED_TASK_PROGRESS,
      })
      .where(and(inArray(dockerTasks.status, [...ACTIVE_TASK_STATUSES]), isNotNull(dockerTasks.tracking)))
      .returning();
    for (const row of detached) this.emit(row);

    const rows = await this.db
      .update(dockerTasks)
      .set({
        status: 'failed',
        error: LOST_STARTUP_TRACKING_ERROR,
        completedAt: now,
        followUps: null,
      })
      .where(and(inArray(dockerTasks.status, [...ACTIVE_TASK_STATUSES]), isNull(dockerTasks.tracking)))
      .returning();

    for (const row of rows) {
      this.emit(row);
      await this.handleContainerTaskTerminal(row);
    }
    if (detached.length > 0) {
      logger.info(
        `Kept ${detached.length} active docker task(s) after backend startup; they are settled with their nodes`
      );
    }
    if (rows.length > 0) {
      logger.warn(`Marked ${rows.length} active docker task(s) as failed after backend startup`);
    }
    await this.expireFollowUps();
    return { detached: detached.length, failed: rows.length };
  }

  /**
   * Records what settles the task with its node should Gateway lose track of it, the command the task runs as (a pull,
   * update or recreate: the daemon tells by it how it ended), and what it owes once settled (an update's or recreate's
   * env follow-ups, kept until they ran or the task ended).
   */
  async track(id: string, tracking: DockerTaskTracking, commandId?: string, followUps?: DockerTaskFollowUps) {
    await this.db
      .update(dockerTasks)
      .set({ tracking, ...(commandId ? { commandId } : {}), ...(followUps ? { followUps } : {}) })
      .where(eq(dockerTasks.id, id));
  }

  /**
   * Gateway lost track of an active task the node may still run (the node's control stream dropped, or the answer
   * did not come in time): it stays active, detached, and is settled with the node once that is connected again. A
   * task without tracking cannot be settled later and fails with `error`. Returns whether the task was kept.
   */
  async detach(id: string, error: string, now = new Date()): Promise<boolean> {
    const [row] = await this.db
      .update(dockerTasks)
      .set({ detachedAt: now, progress: DETACHED_TASK_PROGRESS })
      .where(
        and(
          eq(dockerTasks.id, id),
          inArray(dockerTasks.status, [...ACTIVE_TASK_STATUSES]),
          isNotNull(dockerTasks.tracking)
        )
      )
      .returning();
    if (row) {
      this.emit(row);
      logger.info('Docker task detached: the node may still run it', {
        taskId: id,
        nodeId: row.nodeId,
        type: row.type,
      });
      return true;
    }
    await this.settle(id, { status: 'failed', error });
    return false;
  }

  /** The active tasks Gateway lost track of, oldest first. */
  async listDetached(nodeId?: string): Promise<DockerTaskRow[]> {
    const conditions = [inArray(dockerTasks.status, [...ACTIVE_TASK_STATUSES]), isNotNull(dockerTasks.detachedAt)];
    if (nodeId) conditions.push(eq(dockerTasks.nodeId, nodeId));
    return this.db
      .select()
      .from(dockerTasks)
      .where(and(...conditions))
      .orderBy(dockerTasks.createdAt);
  }

  /** Shows what a detached task waits for now, while the node still runs it. */
  async noteDetached(id: string, progress: string) {
    const [row] = await this.db
      .update(dockerTasks)
      .set({ progress })
      .where(
        and(
          eq(dockerTasks.id, id),
          inArray(dockerTasks.status, [...ACTIVE_TASK_STATUSES]),
          sql`${dockerTasks.progress} is distinct from ${progress}`
        )
      )
      .returning();
    if (row) this.emit(row);
  }

  /** Ends an active task (a task already ended, e.g. force-cancelled, keeps its outcome). Returns whether it ended. */
  async settle(
    id: string,
    outcome: { status: 'succeeded'; progress: string } | { status: 'failed'; error: string },
    now = new Date()
  ): Promise<boolean> {
    const [row] = await this.db
      .update(dockerTasks)
      .set({
        status: outcome.status,
        ...(outcome.status === 'succeeded' ? { progress: outcome.progress } : { error: outcome.error }),
        completedAt: now,
        detachedAt: null,
        followUps: null,
      })
      .where(and(eq(dockerTasks.id, id), inArray(dockerTasks.status, [...ACTIVE_TASK_STATUSES])))
      .returning();
    if (!row) return false;
    this.emit(row);
    await this.handleContainerTaskTerminal(row);
    return true;
  }

  /**
   * Takes what an active task still owes, so that it runs once: the first caller gets it and it is gone for every
   * later one (also across backend processes). Null when nothing is owed, it was taken already, or the task ended.
   */
  async takeFollowUps(id: string): Promise<DockerTaskFollowUps | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ followUps: dockerTasks.followUps })
        .from(dockerTasks)
        .where(
          and(
            eq(dockerTasks.id, id),
            inArray(dockerTasks.status, [...ACTIVE_TASK_STATUSES]),
            isNotNull(dockerTasks.followUps)
          )
        )
        .for('update');
      if (!row?.followUps) return null;
      await tx.update(dockerTasks).set({ followUps: null }).where(eq(dockerTasks.id, id));
      return row.followUps;
    });
  }

  /**
   * Drops what ended tasks still kept (each end clears it; this also covers rows an earlier release ended, which
   * does not know the column). Active tasks keep theirs until they end; one stale for an hour ends then.
   */
  async expireFollowUps(): Promise<number> {
    const rows = await this.db
      .update(dockerTasks)
      .set({ followUps: null })
      .where(and(isNotNull(dockerTasks.followUps), notInArray(dockerTasks.status, [...ACTIVE_TASK_STATUSES])))
      .returning({ id: dockerTasks.id });
    return rows.length;
  }

  async update(
    id: string,
    updates: {
      status?: string;
      progress?: string;
      error?: string;
      completedAt?: Date;
    }
  ) {
    const values: Record<string, unknown> = {};
    if (updates.status !== undefined) values.status = updates.status;
    if (updates.progress !== undefined) values.progress = updates.progress;
    if (updates.error !== undefined) values.error = updates.error;
    if (updates.completedAt !== undefined) values.completedAt = updates.completedAt;
    // An ended task owes nothing more: what it still owed is dropped with its end.
    if (endsTask(updates.status)) values.followUps = null;

    const [row] = await this.db.update(dockerTasks).set(values).where(eq(dockerTasks.id, id)).returning();

    if (!row) throw new AppError(404, 'NOT_FOUND', 'Docker task not found');
    this.emit(row);
    if (isCompletedTaskStatus(row.status)) {
      await this.handleContainerTaskTerminal(row);
    }
    return row;
  }

  /**
   * Handle a task progress/status update from a daemon CommandResult.
   * The detail field is expected to be a JSON string with task information.
   */
  async handleTaskUpdate(nodeId: string, detail: string) {
    try {
      const data = JSON.parse(detail) as {
        taskId?: string;
        containerId?: string;
        containerName?: string;
        type?: string;
        status?: string;
        progress?: string;
        error?: string;
      };

      if (data.taskId) {
        // Update existing task
        const updates: Record<string, unknown> = {};
        if (data.status) updates.status = data.status;
        if (data.progress) updates.progress = data.progress;
        if (data.error) updates.error = data.error;
        if (data.status === 'completed' || data.status === 'failed') {
          updates.completedAt = new Date();
        }
        if (endsTask(data.status)) updates.followUps = null;

        await this.db
          .update(dockerTasks)
          .set(updates)
          .where(and(eq(dockerTasks.id, data.taskId), inArray(dockerTasks.status, [...ACTIVE_TASK_STATUSES])));
      } else if (data.type) {
        // Create a new task from the update
        await this.create({
          nodeId,
          containerId: data.containerId,
          containerName: data.containerName,
          type: data.type,
        });
      }
    } catch (error) {
      logger.error('Failed to handle task update', { nodeId, error });
    }
  }

  /**
   * Delete tasks that were completed more than 24 hours ago.
   */
  async cleanup() {
    await this.markStaleActiveTasksFailed();
    await this.expireFollowUps();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await this.db
      .delete(dockerTasks)
      .where(and(inArray(dockerTasks.status, [...COMPLETED_TASK_STATUSES]), lt(dockerTasks.completedAt, cutoff)))
      .returning({ id: dockerTasks.id });

    if (result.length > 0) {
      logger.info(`Cleaned up ${result.length} completed docker tasks`);
    }
    return result.length;
  }
}
