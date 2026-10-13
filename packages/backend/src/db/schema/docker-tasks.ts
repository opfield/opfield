import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes.js';

/**
 * What Opfield needs to settle a task with its node after it lost track of it (Opfield restarted, or the node's
 * control stream dropped while the task ran): the node may still run it. `deadlineAt` is when the task's own watch
 * would have given up.
 */
export type DockerTaskTracking =
  | {
      /** An image pull: the daemon tells how the pull of `commandId` ended (pull_status), or the image is present. */
      kind: 'pull';
      imageRef: string;
      deadlineAt: string;
      registryId?: string | null;
      /** The folder and user a pull by a user places the image for, and the images the node had before it. */
      folderId?: string | null;
      userId?: string | null;
      preexistingImageIds?: string[];
    }
  | {
      /** A stop, kill or restart: done once the container reached the state. */
      kind: 'state';
      containerId: string;
      /** `exited`: no process left; `restarted`: started again (StartedAt moved from `previousStartedAt`). */
      expect: 'exited' | 'restarted';
      previousStartedAt?: string | null;
      progress: string;
      deadlineAt: string;
    }
  | {
      /**
       * An update or recreate: done once a container of the name with another ID reached `expectedState`. Recorded
       * before it is dispatched, without `daemonTaskId` until the daemon answered; the daemon also finds its task by
       * the task's `commandId`.
       */
      kind: 'replace';
      containerName: string;
      oldContainerId: string;
      expectedState: string;
      daemonTaskId?: string | null;
      /** Recorded before the dispatch: the daemon has not answered yet (an asynchronous daemon task may follow). */
      beforeAnswer?: boolean;
      progress: string;
      deadlineAt: string;
    }
  | {
      /** A removal Opfield itself runs once a stop ended: it does not run without Opfield. */
      kind: 'remove';
      containerId: string;
    };

/**
 * What an update or recreate still owes once it is settled with the node, kept only until then so that it is done also
 * when Opfield lost track of the task (it restarted, or the node's control stream dropped). The env values it needs
 * are sealed like stored container env (the same key and envelope); the API never shows them.
 */
export interface DockerTaskFollowUps {
  /** The container whose stored env the follow-ups write. */
  containerName: string;
  /** The lease the operation held the container with: taken over when the task is settled after Opfield restarted. */
  leaseToken?: string;
  /** Once the replacement succeeded: align stored env entries that only mirrored the replaced image's defaults. */
  reconcileEnvAfterImageChange?: boolean;
  /** Once the daemon reports that the update failed: put back the stored env the update saved before it ran. */
  restoreEnvAfterFailedUpdate?: boolean;
  /** The env the follow-ups need (see DockerEnvFollowUpPayload), sealed with the stored env's key. */
  sealed: { encryptedKey: string; encryptedDek: string };
}

export const dockerTasks = pgTable('docker_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  nodeId: uuid('node_id')
    .notNull()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  containerId: text('container_id'),
  containerName: text('container_name'),
  type: text('type').notNull(),
  status: text('status').notNull().default('pending'),
  progress: text('progress'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  /** The daemon command a pull, update or recreate runs as; the daemon tells how it ended by it. */
  commandId: text('command_id'),
  tracking: jsonb('tracking').$type<DockerTaskTracking>(),
  /** Since when Opfield has lost track of the active task; it is settled with the node once that is connected. */
  detachedAt: timestamp('detached_at', { withTimezone: true }),
  /** What the task still owes once settled; cleared when it ran or the task ended. */
  followUps: jsonb('follow_ups').$type<DockerTaskFollowUps>(),
});
