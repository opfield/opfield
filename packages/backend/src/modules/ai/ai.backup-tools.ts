import { container, TOKENS } from '@/container.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { backupRuntime } from '@/modules/backups/backup-runtime.js';
import type { User } from '@/types.js';
import type { AIToolDefinition } from './ai.types.js';
export const BACKUP_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'manage_database_backups',
    category: 'Databases',
    requiredScope: 'databases:backups:view',
    destructive: true,
    invalidateStores: [],
    description:
      'List native backup policies/history, manage policies (config: destinationId, bucket, prefix, optional staging target, executorNodeId, schedule, timezone, retentionCount, limits, enabled), run or cancel a backup or restore run (config.force ends a run whose executor cannot confirm), restore a verified artifact into an empty target (config: executorNodeId plus newManagedDatabaseName or restoreTargetConnectionId, optional targetDatabaseName and limits; a new managed database is created in config.folderId, which needs databases:create on the Storage node or that folder, with config.storageSizeGb, cpuCores, memoryMb and swapMb as in managed database create, each defaulting to the value of the source managed instance), and delete_run to remove a finished run from history. When that backup still has files, delete_run needs config.artifacts: "delete" removes the files first (the entry is kept if that fails) and "forget" removes only the entry and leaves the files in storage; ask the user which one before calling. Backups of deleted databases stay in history with their files: list_orphaned_runs lists them (each run keeps databaseConnectionName), restore_orphaned restores one into a new managed database or an empty connection (same config as restore; a new database gets the engine and version of the backup), cancel_orphaned cancels such a restore and delete_orphaned_run removes an entry (same artifacts rule as delete_run). These four take no databaseId and need the unscoped databases:backups:* scope, because deleting a database removes the grants that name it. Runtime addresses and credentials are resolved by Gateway.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list_policies',
            'list_runs',
            'create_policy',
            'update_policy',
            'delete_policy',
            'run',
            'cancel',
            'restore',
            'delete_run',
            'list_orphaned_runs',
            'restore_orphaned',
            'cancel_orphaned',
            'delete_orphaned_run',
          ],
        },
        databaseId: {
          type: 'string',
          description: 'Required for every action except the *_orphaned ones, which work on deleted databases.',
        },
        policyId: { type: 'string' },
        runId: { type: 'string' },
        config: {
          type: 'object',
          description:
            'create_policy and update_policy: the full policy, which requires destinationId, bucket, prefix, executorNodeId, timezone, retentionCount and limits with all four fields (schedule, staging and enabled are optional). restore and restore_orphaned: requires executorNodeId plus newManagedDatabaseName or restoreTargetConnectionId (another empty connection, never the source database); limits may set any of the four fields. cancel and cancel_orphaned: { force }. delete_run and delete_orphaned_run: { artifacts }.',
          properties: {
            destinationId: { type: 'string' },
            bucket: { type: 'string' },
            prefix: { type: 'string' },
            stagingStorageConnectionId: { type: ['string', 'null'] },
            stagingBucket: { type: ['string', 'null'] },
            executorNodeId: {
              type: 'string',
              description:
                'A Storage node that runs backup jobs: list_nodes with type storage, whose capabilities include database_backups_v1. Any other node is refused.',
            },
            schedule: { type: ['string', 'null'], description: 'Cron expression; null for manual runs only.' },
            timezone: {
              type: 'string',
              description: 'IANA time zone of the schedule, such as UTC or Europe/Berlin. Required for a policy.',
            },
            retentionCount: {
              type: 'number',
              description: 'Completed backups to keep. Required for a policy.',
            },
            limits: {
              type: 'object',
              description:
                'Runner limits. A policy requires all four fields; a restore may set any of them (the rest keep their defaults).',
              properties: {
                workspaceBytes: { type: 'number' },
                timeoutSeconds: { type: 'number' },
                cpuCores: { type: 'number' },
                memoryMb: { type: 'number' },
              },
              additionalProperties: false,
            },
            enabled: { type: 'boolean' },
            newManagedDatabaseName: { type: 'string' },
            folderId: {
              type: ['string', 'null'],
              description:
                'restore with newManagedDatabaseName: folder of the new database (databases:create on the Storage node or this folder).',
            },
            storageSizeGb: {
              type: 'number',
              description: 'restore with newManagedDatabaseName: disk of the new database in GiB (as in create).',
            },
            cpuCores: {
              type: 'number',
              description: 'restore with newManagedDatabaseName: CPU cores of the new database.',
            },
            memoryMb: {
              type: 'number',
              description: 'restore with newManagedDatabaseName: memory of the new database.',
            },
            swapMb: { type: 'number', description: 'restore with newManagedDatabaseName: swap of the new database.' },
            targetDatabaseName: { type: 'string', description: 'Database name inside the restore target.' },
            restoreTargetConnectionId: { type: 'string' },
            overwrite: { type: 'boolean', enum: [false] },
            force: { type: 'boolean' },
            artifacts: {
              type: 'string',
              enum: ['delete', 'forget'],
              description: 'delete_run and delete_orphaned_run: what to do with backup files that still exist.',
            },
          },
          additionalProperties: false,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];
export async function executeBackupTool(user: User, args: Record<string, unknown>): Promise<unknown> {
  if (!container.isRegistered(TOKENS.CommercialEdition)) return commercialModuleUnavailable();
  return container
    .resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition)
    .executeBackupTool(user, args, backupRuntime);
}
