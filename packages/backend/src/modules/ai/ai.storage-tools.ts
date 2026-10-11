import { container, TOKENS } from '@/container.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { storageToolRuntime } from '@/modules/object-storage/storage-tool-runtime.js';
import type { User } from '@/types.js';
import { createStorageObjectDownloadLink } from './ai.storage-object-link.js';
import type { AIToolDefinition } from './ai.types.js';

const id = { type: 'string', description: 'Canonical storage connection UUID' };
const object = { type: 'object', additionalProperties: true };
export const STORAGE_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'upload_storage_object',
    description:
      'Upload an object through authenticated MCP using begin/chunk/status/finalize/abort, like Pages artifact uploads. Send exact size and SHA-256, then ordered base64 chunks of at most 1 MiB decoded. Finalization streams the verified private spool into storage. Sessions expire after one hour and do not survive Opfield restart. Never pass credentials. An existing key is overwritten on successful finalization.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['begin', 'chunk', 'status', 'finalize', 'abort'] },
        storageId: id,
        uploadId: { type: 'string', description: 'Upload UUID returned by begin, required for other operations.' },
        bucket: { type: 'string' },
        key: { type: 'string' },
        declaredSizeBytes: { type: 'number', description: 'Exact total bytes for begin.' },
        sha256: { type: 'string', description: 'Lowercase complete object SHA-256 for begin.' },
        contentType: { type: 'string' },
        offset: { type: 'number', description: 'Expected current byte offset for chunk.' },
        contentBase64: { type: 'string', maxLength: 1_398_104 },
      },
      required: ['operation', 'storageId'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Storage',
    requiredScope: 'storage:objects:write',
    mcpOnly: true,
    historyRetention: { mode: 'never_full' },
    invalidateStores: [],
  },
  {
    name: 'download_storage_object',
    description:
      'Download an object of any size through authenticated MCP, also from private managed storage, where presign is refused. Returns a one-time download URL (valid 15 minutes, single use) with a ready `curl -fsS -o <file> <url>` command that streams the object through Opfield; a non-zero curl exit means the file is incomplete. Needs storage:objects:read on the storage connection. A missing bucket or object is refused with STORAGE_NOT_FOUND before a link is made. For a small object, read_object on manage_storage_objects returns the content directly.',
    parameters: {
      type: 'object',
      properties: {
        storageId: id,
        bucket: { type: 'string' },
        key: { type: 'string', description: 'Object key.' },
      },
      required: ['storageId', 'bucket', 'key'],
      additionalProperties: false,
    },
    destructive: false,
    category: 'Storage',
    requiredScope: 'storage:objects:read',
    mcpOnly: true,
    invalidateStores: [],
  },
  {
    name: 'list_storage_connections',
    description: 'List authorized external and managed S3, FTP, FTPS and SFTP connections.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        excludeAppMembers: { type: 'boolean', description: 'Leave out storage that belongs to an app.' },
        appId: { type: 'string', description: 'Only storage of this app (any environment).' },
      },
    },
    destructive: false,
    category: 'Storage',
    requiredScope: 'storage:view',
    invalidateStores: [],
  },
  {
    name: 'get_storage_connection',
    description: 'Read safe storage connection details without credentials.',
    parameters: { type: 'object', properties: { storageId: id }, required: ['storageId'] },
    destructive: false,
    category: 'Storage',
    requiredScope: 'storage:view',
    invalidateStores: [],
  },
  {
    name: 'manage_storage_connection',
    description:
      'Create, update, test or delete an external storage connection, reveal its saved credentials (storage:credentials:reveal; refused while impersonating), or read its health_history and monitoring metrics. Config is validated by the storage API; create accepts config.folderId. delete is refused while backup policies or active backup runs use the storage; finished backup history also blocks it until config.backupHistory is "forget", which removes that history (the backups can no longer be restored or deleted through Opfield; their files stay in storage). Only pass it after the user confirms. ' +
      'Server-side data copy between two S3 connections (managed or external, e.g. a legacy MinIO cluster to SeaweedFS): copy_data_start with config {sourceStorageId, destinationStorageId, buckets: "all" or bucket names (same names on the destination), mode "copy" (default; never deletes) or "sync" (also deletes destination objects missing on the source; refused into a managed cluster whose writes are not frozen while links or writable keys use it, unless allowLiveDestination is true after the user confirms), dryRun (compare only), optional createBuckets, executorNodeId (a Storage node; chosen automatically) and limits {timeoutSeconds, cpuCores, memoryMb, transfers}} returns a job; poll copy_data_status with config.jobId until status is completed, failed or cancelled (never claim completion earlier). The finished job has report.clean plus object counts, bytes and samples of missing/differing/extra keys. copy_data_list (optional config.storageId, config.status "active") and copy_data_cancel (config.jobId). Reruns copy only changes; swapping source and destination is the rollback. Needs storage:objects:read and storage:credentials:use on the source, storage:objects:write and storage:credentials:use on the destination (creating missing buckets also storage:objects:admin) and nodes:backups:execute on the executor; credentials are never returned. To create inside an app environment, pass folderId from get_app placementFolderIds.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'create',
            'update',
            'test',
            'delete',
            'reveal_credentials',
            'health_history',
            'monitoring',
            'copy_data_start',
            'copy_data_status',
            'copy_data_list',
            'copy_data_cancel',
          ],
        },
        storageId: id,
        config: object,
      },
      required: ['action'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Storage',
    requiredScope: 'storage:edit',
    invalidateStores: ['storage:list'],
    // reveal_credentials returns the saved secret; keep it out of saved chat history.
    historyRetention: { mode: 'summary_only' },
  },
  {
    name: 'manage_storage_objects',
    description:
      'List buckets/objects, inspect metadata, create or delete a bucket, create a prefix, delete objects, read a small object, or obtain a supported signed URL. delete_bucket takes config.bucket and needs storage:objects:admin. presign takes config.bucket/key, optional config.operation get or put (put needs storage:objects:write), contentType and expiresIn; private managed storage refuses presign unless its S3 endpoint is published, and then the URL points at the published endpoint. read_object takes config.bucket/key and optional config.maxBytes (default 262144, max 1048576) and returns base64 content; over MCP, download a larger object with download_storage_object.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list_buckets',
            'list_objects',
            'head',
            'create_bucket',
            'delete_bucket',
            'create_prefix',
            'delete_objects',
            'presign',
            'read_object',
          ],
        },
        storageId: id,
        config: object,
      },
      required: ['action', 'storageId'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Storage',
    requiredScope: 'storage:objects:read',
    invalidateStores: [],
  },
  {
    name: 'manage_managed_storage',
    historyRetention: { mode: 'never_full' },
    description:
      'Provision and manage Opfield-managed object storage, private workload links, and scoped IAM keys. New clusters run single-node SeaweedFS (S3 only, no FTP/SFTP, at least 512 MiB memory); existing MinIO clusters are legacy (engine "minio") and stay manageable but cannot be created. Read the catalog before create (catalog and list also work with only storage:create), poll get until ready, then create a bucket-scoped link (create_binding and delete_binding need storage:bind, which storage:iam includes, plus permission to change the workload); a link may target a stopped, crash-looping or not yet deployed workload and is saved into its configuration without waiting for it to become healthy. list_bindings shows the observedState of each ready link: target_applied while the workload has not run it yet (never started, stopped, or its rollout pending or failed), active once its runtime carries it. get_binding_runtime (managedStorageId, bindingId; storage:view and view access to the workload) reports the runtime of one link: activeStreams are its open connections (a storage link has no fixed connection limit; relay admission bounds it by load) and throttledTotal the connections a loaded relay refused. A Git-source container whose first build has not created it yet is linked by its name (permissions are checked on its reserved identity) and its first build starts it with the link; a deployment rollback keeps the current links. create takes an optional config.folderId, the folder of the storage connection of the cluster; it needs storage:create on the node or on that folder. create_access_key returns its generated secret once; access key secrets are never readable again. reveal_credentials returns the cluster root access and secret key (storage:credentials:reveal; refused while impersonating). ca_certificate returns the public Storage CA certificate (certificatePem, fingerprintSha256) that S3 clients of a TLS cluster must trust (storage:view; refused when the cluster has TLS off). delete follows the same backup-history rule as manage_storage_connection (config.backupHistory "forget" after the user confirms); backup files stored in the cluster are deleted with it. ' +
      'Opfield renews the cluster TLS certificate automatically without a restart; certificate_status (storage:view) shows its expiry, renewal state and last renewal error, and renew_certificate (storage:edit; optional config.allowRestart) renews it now: the running cluster loads the new certificate in place (SeaweedFS clusters created before rc.9 reread it within five hours unless allowRestart is set). ' +
      'Cutover actions for migrating a legacy MinIO cluster to SeaweedFS (read internal_documentation topic storage-migration first and follow it): move_binding (managedStorageId = current cluster, bindingId, targetStorageId) points a ready workload link at another cluster keeping its key id/secret, alias and environment, so the workload is not recreated; it rolls back on failure and needs storage:iam on both clusters plus permission to change the workload. import_access_keys (config.sourceStorageId, config.targetStorageId, optional config.keyIds) copies non-expiring operator keys server-side with the same id and secret (storage:iam on both; refused while impersonating); needsNewId lists expiring or incompatible keys. freeze_writes makes every Opfield-issued key and link key of managedStorageId read-only (root keeps full access, so copy_data still works; unmanagedKeys stay writable, null means unknown) and makes Opfield refuse its own uploads, deletes, bucket changes and backups into it; it refuses while backup runs write there; unfreeze_writes restores the keys; get shows writesFrozenAt (storage:iam). move_binding needs every bucket of the link on the target. rehome_backup_history (managedStorageId = source, targetStorageId, optional config.dryRun) points finished backup history at the target after its files were copied there, verifying every artifact (storage:edit on both). targetStorageId, sourceStorageId and managedStorageId are managed storage ids, not storage connection ids. list takes optional config.excludeAppMembers or config.appId (members of one app). To create inside an app environment, pass folderId from get_app placementFolderIds. ' +
      'Availability (Business plan, multi-node-availability; one SeaweedFS storage on 2 to 5 storage nodes, each on its own host; every object is written to two servers before it is acknowledged): availability_preflight (with managedStorageId for existing storage; without it, for create, from config.nodeId and config.nodeIds) shows mode (automatic with witnesses, else manual), voters, witnesses, blockers, warnings and lossWindowText; tell the user the loss window before turning it on. While a server is down for more than 10 s new objects are stored once until it returns, and up to about 1 s of object and bucket metadata changes can be lost in an unplanned failover. create takes config.availability {nodeIds, witness {relayIds, nodeId}, manual, priorityMode}; make_available turns it on for existing storage (config.nodeIds, config.witness, config.manual, config.priorityMode; the storage restarts once). availability (storage:view) reads members, voters, witnesses, state and reason and changesBlocked; availability_events lists failovers and other events (config.page, config.limit). update_availability changes config.priorityMode, failbackDelaySeconds and witness; add_member (config.nodeId), remove_member (memberId), rebuild_member (memberId) and disable_availability (config.keepMemberId = the primary) change the servers; when no member holds the primary role a disable fails after 3 minutes and config.force true keeps config.keepMemberId or the member with the most recent data (the user decides). make_primary (memberId) switches the primary: planned when the primary serves and the copy is eligible (no loss); otherwise refused with AVAILABILITY_LOSSY_PROMOTION and the estimate unless config.acceptDataLoss is true, which only the user may decide. Changing actions need storage:edit. On several servers, update, restart and delete act on every server, copies first (restart: the primary hands over to a restarted copy without loss); an app shutdown pauses the copies first and the primary keeps its role (no failover); delete turns availability off first. After the license grace period make_primary, rebuild_member, remove_member, disable_availability and reads keep working; make_available, add_member, update_availability and create with availability are refused.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'catalog',
            'list',
            'get',
            'create',
            'update',
            'retry',
            'restart',
            'delete',
            'list_bindings',
            'create_binding',
            'delete_binding',
            'get_binding_runtime',
            'list_access_keys',
            'create_access_key',
            'remove_access_key',
            'reveal_credentials',
            'ca_certificate',
            'certificate_status',
            'renew_certificate',
            'move_binding',
            'import_access_keys',
            'freeze_writes',
            'unfreeze_writes',
            'rehome_backup_history',
            'availability',
            'availability_preflight',
            'availability_events',
            'make_available',
            'update_availability',
            'add_member',
            'remove_member',
            'make_primary',
            'rebuild_member',
            'disable_availability',
          ],
        },
        managedStorageId: { type: 'string' },
        memberId: {
          type: 'string',
          description: 'Availability member ID (remove_member, rebuild_member, make_primary).',
        },
        bindingId: { type: 'string' },
        accessKeyId: { type: 'string' },
        targetStorageId: {
          type: 'string',
          description:
            'Managed storage UUID to move to (move_binding, import_access_keys, rehome_backup_history); may also be passed as config.targetStorageId.',
        },
        config: object,
      },
      required: ['action'],
    },
    destructive: true,
    category: 'Storage',
    requiredScope: 'storage:view',
    invalidateStores: ['storage:list'],
  },
];
export const STORAGE_TOOL_NAMES = new Set(STORAGE_AI_TOOLS.map(({ name }) => name));

export async function executeStorageTool(user: User, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!container.isRegistered(TOKENS.CommercialEdition)) return commercialModuleUnavailable();
  // The link checks the scope itself; the storage service it calls applies the storage license.
  if (name === 'download_storage_object') return createStorageObjectDownloadLink(user, args);
  return container
    .resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition)
    .executeStorageTool(user, name, args, storageToolRuntime);
}
