import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { backupRuns, dockerBuilds, dockerMigrations, dockerTasks, storageCopyJobs } from '@/db/schema/index.js';

/**
 * Long work on a node that a daemon restart would cut: what a daemon update waits for before it is sent (see
 * daemon-node-update). `kind` is one of backup, build, migration, docker_task, storage_copy, archive_export,
 * archive_import.
 */
export interface NodeLongTask {
  kind: string;
  id: string;
  label: string;
}

/** Builds in these states run on their builder node. */
const ACTIVE_BUILD_STATUSES = ['claimed', 'checking_out', 'building', 'scanning', 'pushing'] as const;
const ACTIVE_MIGRATION_STATUSES = ['running', 'waiting', 'cancelling'] as const;
const ACTIVE_DOCKER_TASK_STATUSES = ['pending', 'running'] as const;
/** Docker tasks older than this are failed as lost by DockerTaskService; they no longer hold an update back. */
const DOCKER_TASK_STALE_MS = 60 * 60_000;
/** A transfer older than this (a stream nobody read to the end or closed) no longer holds an update back. */
const TRANSFER_STALE_MS = 6 * 60 * 60_000;
/** Per kind; an update shows what it waits for, it does not need every row. */
const PER_KIND_LIMIT = 25;

interface ActiveTransfer extends NodeLongTask {
  startedAt: number;
}

/** Container archive transfers stream through Opfield and the daemon; they live only in this process. */
const activeTransfers = new Map<string, Map<string, ActiveTransfer>>();

/**
 * Counts a container archive export or import on a node until the returned release is called (more than once is
 * fine).
 */
export function beginNodeArchiveTransfer(
  nodeId: string,
  kind: 'archive_export' | 'archive_import',
  label: string,
  now = Date.now()
): () => void {
  const id = randomUUID();
  let transfers = activeTransfers.get(nodeId);
  if (!transfers) {
    transfers = new Map();
    activeTransfers.set(nodeId, transfers);
  }
  transfers.set(id, { kind, id, label, startedAt: now });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = activeTransfers.get(nodeId);
    current?.delete(id);
    if (current?.size === 0) activeTransfers.delete(nodeId);
  };
}

/** Releases the transfer once the stream is read to the end, fails, or is cancelled by its reader. */
export function releaseWhenStreamEnds(
  stream: ReadableStream<Uint8Array>,
  release: () => void
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
}

export function activeNodeArchiveTransfers(nodeId: string, now = Date.now()): NodeLongTask[] {
  return [...(activeTransfers.get(nodeId)?.values() ?? [])]
    .filter((transfer) => now - transfer.startedAt < TRANSFER_STALE_MS)
    .map(({ kind, id, label }) => ({ kind, id, label }));
}

/**
 * The long tasks running on a node now: backup and restore runs it executes, image builds on it, Docker migrations
 * from or to it, pending and running Docker tasks (image pulls, container actions), storage copy jobs it executes,
 * and container archive transfers.
 */
export async function listNodeLongTasks(
  db: Pick<DrizzleClient, 'select'>,
  nodeId: string,
  now = Date.now()
): Promise<NodeLongTask[]> {
  const [backups, builds, migrations, tasks, copies] = await Promise.all([
    db
      .select({
        id: backupRuns.id,
        direction: backupRuns.direction,
        databaseConnectionName: backupRuns.databaseConnectionName,
      })
      .from(backupRuns)
      .where(and(eq(backupRuns.executorNodeId, nodeId), eq(backupRuns.status, 'running')))
      .limit(PER_KIND_LIMIT),
    db
      .select({
        id: dockerBuilds.id,
        repositoryFullPath: dockerBuilds.repositoryFullPath,
        serviceName: dockerBuilds.serviceName,
      })
      .from(dockerBuilds)
      .where(and(eq(dockerBuilds.builderNodeId, nodeId), inArray(dockerBuilds.status, [...ACTIVE_BUILD_STATUSES])))
      .limit(PER_KIND_LIMIT),
    db
      .select({ id: dockerMigrations.id, resourceName: dockerMigrations.resourceName })
      .from(dockerMigrations)
      .where(
        and(
          or(eq(dockerMigrations.sourceNodeId, nodeId), eq(dockerMigrations.targetNodeId, nodeId)),
          inArray(dockerMigrations.status, [...ACTIVE_MIGRATION_STATUSES])
        )
      )
      .limit(PER_KIND_LIMIT),
    db
      .select({ id: dockerTasks.id, type: dockerTasks.type, containerName: dockerTasks.containerName })
      .from(dockerTasks)
      .where(
        and(
          eq(dockerTasks.nodeId, nodeId),
          inArray(dockerTasks.status, [...ACTIVE_DOCKER_TASK_STATUSES]),
          gt(dockerTasks.createdAt, new Date(now - DOCKER_TASK_STALE_MS))
        )
      )
      .limit(PER_KIND_LIMIT),
    db
      .select({
        id: storageCopyJobs.id,
        sourceConnectionName: storageCopyJobs.sourceConnectionName,
        destinationConnectionName: storageCopyJobs.destinationConnectionName,
      })
      .from(storageCopyJobs)
      .where(and(eq(storageCopyJobs.executorNodeId, nodeId), eq(storageCopyJobs.status, 'running')))
      .limit(PER_KIND_LIMIT),
  ]);
  return [
    ...backups.map((run) => ({
      kind: 'backup',
      id: run.id,
      label: `${run.direction === 'restore' ? 'Restore' : 'Backup'} of ${run.databaseConnectionName ?? 'a database'}`,
    })),
    ...builds.map((build) => ({
      kind: 'build',
      id: build.id,
      label: `Build of ${build.repositoryFullPath}${build.serviceName ? ` (${build.serviceName})` : ''}`,
    })),
    ...migrations.map((migration) => ({
      kind: 'migration',
      id: migration.id,
      label: `Migration of ${migration.resourceName}`,
    })),
    ...tasks.map((task) => ({
      kind: 'docker_task',
      id: task.id,
      label:
        task.type === 'pull'
          ? `Image pull ${task.containerName ?? ''}`.trim()
          : `Container ${task.type}${task.containerName ? ` of ${task.containerName}` : ''}`,
    })),
    ...copies.map((copy) => ({
      kind: 'storage_copy',
      id: copy.id,
      label: `Storage copy from ${copy.sourceConnectionName} to ${copy.destinationConnectionName}`,
    })),
    ...activeNodeArchiveTransfers(nodeId, now),
  ];
}
