import { z } from '@hono/zod-openapi';
import {
  appRoute,
  createdJson,
  dataResponseSchema,
  IdParamSchema,
  jsonBody,
  jsonContent,
  okJson,
  optionalJsonBody,
  pathParamSchema,
  UnknownDataResponseSchema,
  UnknownListResponseSchema,
} from '@/lib/openapi.js';
import { availabilityRouteDocs } from '@/modules/databases/managed-availability.docs.js';
import {
  ManagedCertificateStatusSchema,
  RenewManagedCertificateSchema,
} from '@/modules/managed-workloads/certificate-renewal.docs.js';
import { DeleteStorageQuerySchema } from '@/modules/object-storage/object-storage.schemas.js';
import {
  CreateManagedStorageAccessKeySchema,
  CreateManagedStorageBindingSchema,
  CreateManagedStorageSchema,
  DeleteManagedStorageBindingSchema,
  ImportManagedStorageAccessKeysSchema,
  ManagedStorageAvailabilityCreatePreflightSchema,
  ManagedStorageListQuerySchema,
  MoveManagedStorageBindingSchema,
  RehomeManagedStorageBackupHistorySchema,
  UpdateManagedStorageSchema,
} from './managed-storage.schemas.js';

const accessKeyParams = pathParamSchema('id', 'accessKeyId');

const TAG = 'Managed Storage';

export const listManagedStorageCatalogRoute = appRoute({
  method: 'get',
  path: '/catalog',
  tags: [TAG],
  summary: 'List curated managed object storage versions',
  responses: okJson(UnknownDataResponseSchema),
});

export const listManagedStorageRoute = appRoute({
  method: 'get',
  path: '/',
  tags: [TAG],
  summary: 'List managed object storage clusters',
  request: { query: ManagedStorageListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createManagedStorageRoute = appRoute({
  method: 'post',
  path: '/',
  tags: [TAG],
  summary: 'Deploy a managed object storage cluster',
  description:
    'With `availability` (several servers) the create waits until every server took its part, 180 s at most. When a server fails or does not answer within the 180 s, it answers 409 `AVAILABILITY_CREATE_FAILED` with the reason, but the storage exists: it stays on its first server with availability off and is never deleted for the failure (`details.kept: true`, `details.id`, `details.name`, `details.nodeId`, `details.nodeName`). Fix the cause, then turn availability on with `POST /{id}/availability`, or delete the storage. In the rare case that a server still holds a setup step when the wait ends, it answers 202 with `status: "creating"` and `setupPending: true`: poll the get until `status` leaves `creating`; `availabilityFailure` then names a failure. A failed create is never answered 201.',
  request: jsonBody(CreateManagedStorageSchema),
  responses: {
    ...createdJson(UnknownDataResponseSchema),
    202: {
      description: 'Accepted: a server still holds a setup step (setupPending); poll the get',
      content: jsonContent(UnknownDataResponseSchema),
    },
  },
});

export const getManagedStorageRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: [TAG],
  summary: 'Get managed object storage cluster details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateManagedStorageRoute = appRoute({
  method: 'patch',
  path: '/{id}',
  tags: [TAG],
  summary: 'Update managed object storage cluster configuration',
  description:
    'On several servers (availability on) every member takes the settings, and the members publish what the storage publishes.',
  request: { params: IdParamSchema, ...jsonBody(UpdateManagedStorageSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteManagedStorageRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: [TAG],
  summary: 'Delete a managed object storage cluster',
  description:
    'Refused while backup policies or active backup runs use the storage. Finished backup history also blocks deletion (409 STORAGE_BACKUP_HISTORY_EXISTS with historyRecords and backupsWithFiles) unless backupHistory=forget confirms removing it; forgotten backups can no longer be restored or deleted through Opfield, and files stored in this managed storage are deleted with it. Storage on several servers (availability on) answers at once with `deleting: true`: availability is turned off first (every other member and its data go), then the storage is deleted.',
  request: { params: IdParamSchema, query: DeleteStorageQuerySchema },
  responses: okJson(z.object({ success: z.boolean() })),
});

export const retryManagedStorageProvisioningRoute = appRoute({
  method: 'post',
  path: '/{id}/retry-provisioning',
  tags: [TAG],
  summary: 'Retry failed managed object storage provisioning',
  description:
    'Provisions a managed storage cluster in `error` again on its node and answers 200 with the cluster once the node answered (`ready`, or `error` with the new lastError): the cluster already exists, so nothing is created (201 is for create). What the node kept of it (storage image, container) is taken over with its data. 409 MANAGED_STORAGE_NOT_RETRYABLE when the cluster did not fail or its node still holds it (change its settings, restart or delete it instead), 409 MANAGED_STORAGE_NODE_STATE_UNKNOWN when the node daemon cannot tell what it kept (update the node first), 409 MANAGED_STORAGE_NODE_UNAVAILABLE when the node is offline.',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const restartManagedStorageRoute = appRoute({
  method: 'post',
  path: '/{id}/restart',
  tags: [TAG],
  summary: 'Restart a managed object storage container',
  description:
    'On several servers (availability on) a rolling restart: copies first, then a planned switchover, then the old primary. Answers at once with status `updating`.',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

/** Public certificate material: the Storage CA an S3 client of a TLS cluster must trust. */
export const ManagedStorageCaCertificateSchema = z.object({
  certificatePem: z.string().openapi({ description: 'PEM-encoded Storage CA certificate' }),
  fingerprintSha256: z.string().openapi({
    description: 'SHA-256 fingerprint of the CA certificate (DER), as upper-case hex pairs joined by colons',
    example: 'AB:12:CD:34:EF:56:78:90:AB:12:CD:34:EF:56:78:90:AB:12:CD:34:EF:56:78:90:AB:12:CD:34:EF:56:78:90',
  }),
});

export const getManagedStorageCaCertificateRoute = appRoute({
  method: 'get',
  path: '/{id}/ca-certificate',
  tags: [TAG],
  summary: 'Get the Storage CA certificate that TLS clients of a managed object storage cluster must trust',
  description:
    'Returns the public certificate of the Storage CA that issued the cluster TLS certificate. Requires the same view permission as reading the cluster. Refused with 409 MANAGED_STORAGE_TLS_DISABLED when the cluster does not serve TLS.',
  request: { params: IdParamSchema },
  responses: okJson(dataResponseSchema(ManagedStorageCaCertificateSchema)),
});

export const getManagedStorageCertificateRoute = appRoute({
  method: 'get',
  path: '/{id}/certificate',
  tags: [TAG],
  summary: 'Get the TLS certificate of a managed object storage cluster and its automatic renewal status',
  description:
    'Opfield renews the certificate while the cluster runs (two thirds into its lifetime or 30 days before expiry) and delivers it without a restart. Shows expiry, the renewal state and the last renewal error. Requires the same view permission as reading the cluster.',
  request: { params: IdParamSchema },
  responses: okJson(dataResponseSchema(ManagedCertificateStatusSchema)),
});

export const renewManagedStorageCertificateRoute = appRoute({
  method: 'post',
  path: '/{id}/certificate/renew',
  tags: [TAG],
  summary: 'Renew the TLS certificate of a managed object storage cluster now',
  description:
    'Issues a new certificate from the Storage CA and has the running cluster load it without a restart; it becomes current once the cluster serves it. SeaweedFS clusters created before rc.9 reread their certificate within five hours (state awaiting_reload) unless allowRestart is set.',
  request: { params: IdParamSchema, ...optionalJsonBody(RenewManagedCertificateSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const revealManagedStorageCredentialsRoute = appRoute({
  method: 'get',
  path: '/{id}/reveal-credentials',
  tags: [TAG],
  summary: 'Reveal managed object storage root credentials',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createManagedStorageAccessKeyRoute = appRoute({
  method: 'post',
  path: '/{id}/iam-keys',
  tags: [TAG],
  summary: 'Create a managed object storage IAM access key (secret returned once)',
  request: { params: IdParamSchema, ...jsonBody(CreateManagedStorageAccessKeySchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const listManagedStorageAccessKeysRoute = appRoute({
  method: 'get',
  path: '/{id}/iam-keys',
  tags: [TAG],
  summary: 'List a managed object storage cluster IAM access keys (no secrets)',
  request: { params: IdParamSchema },
  responses: okJson(UnknownListResponseSchema),
});

const bindingParams = IdParamSchema.extend({ bindingId: z.string().uuid() });

export const createManagedStorageBindingRoute = appRoute({
  method: 'post',
  path: '/{id}/bindings',
  tags: [TAG],
  summary: 'Bind a workload to a managed object storage cluster over a private connector',
  description:
    'The link is saved into the workload whatever it is doing and the call does not wait for the workload to become healthy. A ready link reports observedState target_applied while the workload has not run it yet (never started, stopped, or its rollout pending or failed) and active once its runtime carries it. A Git-source container whose first build has not created it yet is linked by its name, authorized on its reserved identity, and its first build starts it with the link.',
  request: { params: IdParamSchema, ...jsonBody(CreateManagedStorageBindingSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const listManagedStorageBindingsRoute = appRoute({
  method: 'get',
  path: '/{id}/bindings',
  tags: [TAG],
  summary: 'List managed object storage bindings',
  description:
    "observedState says whether the link reached the workload's runtime: active once the running workload carries it (for a container: the link network and every link variable in its environment, checked on the container), target_applied while it is saved but not run yet (never started, stopped, or its rollout pending), preparing or error otherwise. A link saved while its workload's node was offline stays creating (lastError says so) and is set up when the node reconnects.",
  request: { params: IdParamSchema },
  responses: okJson(UnknownListResponseSchema),
});

export const deleteManagedStorageBindingRoute = appRoute({
  method: 'delete',
  path: '/{id}/bindings/{bindingId}',
  tags: [TAG],
  summary: 'Remove a managed object storage binding',
  request: {
    params: bindingParams,
    body: { required: false, content: { 'application/json': { schema: DeleteManagedStorageBindingSchema } } },
  },
  responses: okJson(z.object({ success: z.boolean() })),
});

export const getManagedStorageBindingRuntimeRoute = appRoute({
  method: 'get',
  path: '/{id}/bindings/{bindingId}/runtime',
  tags: [TAG],
  summary: 'Get managed object storage link runtime',
  description:
    "The link's Relay counters and its connections as the node running the workload reports them: activeStreams are the link's open connections (no fixed limit; relay admission bounds them by load), openedTotal and the byte counters what it carried through that node, throttledTotal counts the connections the node or a relay refused. connections is null while that node's daemon does not report links. The Relay counters sum every relay that holds the link's routes; relayCountersComplete is false when one did not answer, and those counters are then partial. Needs storage:view and view access to the linked workload.",
  request: { params: bindingParams },
  responses: okJson(UnknownDataResponseSchema),
});

export const removeManagedStorageAccessKeyRoute = appRoute({
  method: 'delete',
  path: '/{id}/iam-keys/{accessKeyId}',
  tags: [TAG],
  summary: 'Revoke a managed object storage IAM access key',
  request: { params: accessKeyParams },
  responses: okJson(z.object({ success: z.boolean() })),
});

// ── MinIO -> SeaweedFS cutover ────────────────────────────────────────────

export const moveManagedStorageBindingRoute = appRoute({
  method: 'post',
  path: '/{id}/bindings/{bindingId}/move',
  tags: [TAG],
  summary: 'Move a workload link to another managed object storage cluster',
  description:
    'Points the link at targetStorageId without recreating the workload: the link keeps its alias, network and environment, and its key keeps the same access key id and secret, recreated on the target. Only the relay route moves (the connector is recreated when the clusters differ in TLS). Needs storage:iam on both clusters and permission to change the linked workload. A failure rolls the route, connector and target key back; the source key is revoked afterwards, best effort.',
  request: { params: bindingParams, ...jsonBody(MoveManagedStorageBindingSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const importManagedStorageAccessKeysRoute = appRoute({
  method: 'post',
  path: '/{id}/iam-keys/import',
  tags: [TAG],
  summary: 'Copy access keys from another managed object storage cluster into this one',
  description:
    'Creates the non-expiring access keys of sourceStorageId (or only keyIds) in this cluster with the same access key id and secret, server-side; secrets are never returned. Expiring keys and keys the target engine cannot accept are reported in needsNewId. Needs storage:iam on both clusters; refused while impersonating.',
  request: { params: IdParamSchema, ...jsonBody(ImportManagedStorageAccessKeysSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const freezeManagedStorageWritesRoute = appRoute({
  method: 'post',
  path: '/{id}/freeze-writes',
  tags: [TAG],
  summary: 'Make every issued key of a managed object storage cluster read-only',
  description:
    'Migration write freeze: rewrites the policy of every access key and workload-link key Opfield issued on this cluster to read-only, including keys issued later, until unfreeze. The root credentials keep full access. Keys Opfield did not issue are reported in unmanagedKeys and stay writable. Idempotent; a partial failure returns 502 MANAGED_STORAGE_FREEZE_INCOMPLETE and a retry re-applies every key.',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const unfreezeManagedStorageWritesRoute = appRoute({
  method: 'post',
  path: '/{id}/unfreeze-writes',
  tags: [TAG],
  summary: 'Restore every issued key of a managed object storage cluster to its own access',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const rehomeManagedStorageBackupHistoryRoute = appRoute({
  method: 'post',
  path: '/{id}/backup-history/rehome',
  tags: [TAG],
  summary: 'Move finished backup history of this cluster to another managed object storage cluster',
  description:
    'After the backup files were copied to targetStorageId (same buckets and keys), points finished backup runs at it so this cluster can be deleted without forgetting the history. A run moves only when every artifact exists in the target with its manifest size; blocked runs are reported and stay. Active runs refuse the move; backup policies are not changed. dryRun only reports. Needs storage:edit on both clusters.',
  request: { params: IdParamSchema, ...jsonBody(RehomeManagedStorageBackupHistorySchema) },
  responses: okJson(UnknownDataResponseSchema),
});

/** Storage availability (one storage on several servers), served by the commercial edition. */
export const managedStorageAvailabilityRoutes = availabilityRouteDocs({
  base: '/{id}',
  createPreflightPath: '/availability/preflight',
  createPreflightSchema: ManagedStorageAvailabilityCreatePreflightSchema,
  tag: TAG,
  noun: 'storage',
  viewScope: 'storage:view',
  editScope: 'storage:edit',
  createScope: 'storage:create',
});
