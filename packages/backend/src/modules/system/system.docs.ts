import { z } from '@hono/zod-openapi';
import {
  appRoute,
  jsonBody,
  NodeIdParamSchema,
  okJson,
  optionalJsonBody,
  pathParamSchema,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import { RELEASE_VERSION_PATTERN } from '@/lib/semver.js';

const VersionParamSchema = pathParamSchema('version');
const UpdateRequestSchema = z.object({
  version: z.string().regex(RELEASE_VERSION_PATTERN),
});
export const DaemonUpdateRequestSchema = z.object({
  now: z
    .boolean()
    .optional()
    .describe(
      'Update without waiting for the long tasks running on the node (they may fail) or for its lease peers. Also ends the wait of an update that already waits for them.'
    ),
});

export const systemVersionRoute = appRoute({
  method: 'get',
  path: '/version',
  tags: ['System'],
  summary: 'Get Opfield version and update status',
  responses: okJson(UnknownDataResponseSchema),
});

export const systemConfigRoute = appRoute({
  method: 'get',
  path: '/config',
  tags: ['System'],
  summary: 'Get Opfield runtime configuration',
  responses: okJson(UnknownDataResponseSchema),
});

export const checkSystemUpdateRoute = appRoute({
  method: 'post',
  path: '/check-update',
  tags: ['System'],
  summary: 'Check for Opfield updates',
  responses: okJson(UnknownDataResponseSchema),
});

export const performSystemUpdateRoute = appRoute({
  method: 'post',
  path: '/update',
  tags: ['System'],
  summary: 'Trigger Opfield self-update',
  request: jsonBody(UpdateRequestSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const proceedSystemUpdateRoute = appRoute({
  method: 'post',
  path: '/update/proceed',
  tags: ['System'],
  summary: 'Update now without waiting for running orchestration operations',
  responses: okJson(UnknownDataResponseSchema),
});

export const acknowledgeSystemUpdateFailureRoute = appRoute({
  method: 'post',
  path: '/update/acknowledge',
  tags: ['System'],
  summary: 'Stop reporting an Opfield update that did not complete',
  responses: okJson(UnknownDataResponseSchema),
});

export const performRelayUpdateRoute = appRoute({
  method: 'post',
  path: '/relay-update',
  tags: ['System'],
  summary: 'Trigger relay self-update',
  request: jsonBody(UpdateRequestSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const abandonRelayUpdateRoute = appRoute({
  method: 'post',
  path: '/relay-update/abandon',
  tags: ['System'],
  summary: 'Abandon a stuck or paused Relay Pool update and resume the relays it drained',
  responses: okJson(UnknownDataResponseSchema),
});

export const releaseNotesForVersionRoute = appRoute({
  method: 'get',
  path: '/release-notes/{version}',
  tags: ['System'],
  summary: 'Get release notes for a version',
  request: { params: VersionParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const releaseNotesRoute = appRoute({
  method: 'get',
  path: '/release-notes',
  tags: ['System'],
  summary: 'Get release notes for available updates',
  responses: okJson(UnknownDataResponseSchema),
});

export const daemonUpdatesRoute = appRoute({
  method: 'get',
  path: '/daemon-updates',
  tags: ['System'],
  summary: 'List daemon update status',
  responses: okJson(UnknownDataResponseSchema),
});

export const checkDaemonUpdatesRoute = appRoute({
  method: 'post',
  path: '/daemon-updates/check',
  tags: ['System'],
  summary: 'Check for daemon updates',
  responses: okJson(UnknownDataResponseSchema),
});

export const updateDaemonRoute = appRoute({
  method: 'post',
  path: '/daemon-updates/{nodeId}',
  tags: ['System'],
  summary: 'Trigger daemon update for a node',
  description:
    'Updates the daemon of a node to the latest release. While backups, image builds, Docker migrations, image pulls, container actions, storage copies, or container archive transfers run on the node, the update waits for them first: `waitingForTasks` in the response, `metadata.updatePhase: waiting_for_tasks` and `metadata.updateWaitingForTasks` on the node. After 30 minutes it goes ahead anyway and keeps a warning in `metadata.lastUpdate.warnings`. Nodes in a lease-mode Availability policy then wait for their peers (`leaseSequenced`). `now: true` waits for neither and ends the wait of an update already waiting (`waitSkipped`); skipping the peers is kept as a warning in `metadata.lastUpdate.warnings`. An update of a Docker or nginx node whose daemon advertises `daemon_stream_handover_v1` keeps its relay stream sessions; `metadata.lastUpdate.connections` holds what the update kept and cut, and `metadata.lastUpdate.serviceRestart` says when the update restarted the whole service once for a newer launcher (or why not).',
  request: {
    params: NodeIdParamSchema,
    ...optionalJsonBody(
      DaemonUpdateRequestSchema,
      'Optional: `{ "now": true }` to update without waiting for running tasks or lease peers'
    ),
  },
  responses: okJson(UnknownDataResponseSchema),
});

// ─── Relay pool (served by plain routes in system.routes.ts; documented here) ───────────────────────────────

const RelayInstanceParamSchema = pathParamSchema('instanceId');
const RelayConfirmSchema = z.object({ confirm: z.literal(true).describe('Must be true') });
const RELAY_ADMIN = 'Needs admin:system.';
const RELAY_POOL_ANSWER = 'Answers the relay pool snapshot after the change (the same data as GET /system/relay).';

export const getRelayPoolRoute = appRoute({
  method: 'get',
  path: '/relay',
  tags: ['System'],
  summary: 'Get the relay pool',
  description:
    'The local relay supervisor state and, when the relay pool runs, every relay instance with its health, drain state, streams, port change and certificate. Needs settings:opfield:view.',
  responses: okJson(UnknownDataResponseSchema),
});

export const retryRelayRecoveryRoute = appRoute({
  method: 'post',
  path: '/relay/recovery',
  tags: ['System'],
  summary: 'Retry the local relay recovery',
  description: `Starts the local relay's recovery again after it stopped. ${RELAY_ADMIN}`,
  responses: okJson(UnknownDataResponseSchema),
});

export const rebalanceRelayPoolRoute = appRoute({
  method: 'post',
  path: '/relay/rebalance',
  tags: ['System'],
  summary: 'Rebalance streams across the relay pool',
  description: `Stages moving streams to the relays they belong on. 202 while a move is staging, 200 when nothing had to move. ${RELAY_ADMIN}`,
  responses: {
    ...okJson(UnknownDataResponseSchema),
    202: {
      description: 'A rebalance is staging',
      content: { 'application/json': { schema: UnknownDataResponseSchema } },
    },
  },
});

export const drainRelayInstanceRoute = appRoute({
  method: 'post',
  path: '/relay/instances/{instanceId}/drain',
  tags: ['System'],
  summary: 'Drain a relay instance',
  description: `New streams avoid the relay and its streams move to the others. ${RELAY_POOL_ANSWER} ${RELAY_ADMIN}`,
  request: { params: RelayInstanceParamSchema, ...jsonBody(RelayConfirmSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const resumeRelayInstanceRoute = appRoute({
  method: 'post',
  path: '/relay/instances/{instanceId}/resume',
  tags: ['System'],
  summary: 'Resume a drained relay instance',
  description: `The relay takes new streams again. ${RELAY_POOL_ANSWER} ${RELAY_ADMIN}`,
  request: { params: RelayInstanceParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const forceDisconnectRelayInstanceRoute = appRoute({
  method: 'post',
  path: '/relay/instances/{instanceId}/force-disconnect',
  tags: ['System'],
  summary: 'Force-disconnect a relay instance',
  description: `Cuts the relay's streams at once (they reconnect through other relays). ${RELAY_POOL_ANSWER} ${RELAY_ADMIN}`,
  request: { params: RelayInstanceParamSchema, ...jsonBody(RelayConfirmSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateRelayInstanceRoute = appRoute({
  method: 'patch',
  path: '/relay/instances/{instanceId}',
  tags: ['System'],
  summary: 'Change relay instance settings',
  description: `Whether availability witnesses (database and storage sets) may run on this relay. Answers the relay instance. ${RELAY_ADMIN}`,
  request: {
    params: RelayInstanceParamSchema,
    ...jsonBody(z.object({ witnessHostingAllowed: z.boolean() }).strict()),
  },
  responses: okJson(UnknownDataResponseSchema),
});

export const changeRelayServicePortRoute = appRoute({
  method: 'post',
  path: '/relay/instances/{instanceId}/service-port',
  tags: ['System'],
  summary: 'Move a remote relay to another TCP port',
  description: `Runs in the background: the relay's streams leave, its supervisor restarts it on the port and it returns to the pool. 202 once it began; the instance's portChange follows it (a failure stays there). ${RELAY_ADMIN}`,
  request: {
    params: RelayInstanceParamSchema,
    ...jsonBody(z.object({ servicePort: z.number().int().min(1).max(65535) }).strict()),
  },
  responses: {
    202: {
      description: 'The port change began',
      content: { 'application/json': { schema: UnknownDataResponseSchema } },
    },
  },
});

export const reenrollRelayInstanceRoute = appRoute({
  method: 'post',
  path: '/relay/instances/{instanceId}/reenroll',
  tags: ['System'],
  summary: 'Issue a re-enrollment token for a remote relay',
  description: `A single-use token and the installer command that repairs an enrolled remote relay. Refused while impersonating. ${RELAY_ADMIN}`,
  request: { params: RelayInstanceParamSchema, ...jsonBody(RelayConfirmSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const renewRelayCertificateRoute = appRoute({
  method: 'post',
  path: '/relay/instances/{instanceId}/renew-certificate',
  tags: ['System'],
  summary: "Renew a remote relay's server certificate now",
  description: `Instead of waiting for the hourly check. ${RELAY_POOL_ANSWER} ${RELAY_ADMIN}`,
  request: { params: RelayInstanceParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

/** The relay pool operations, for the OpenAPI document only: plain routes serve them. */
export const relayPoolRouteDocs = [
  getRelayPoolRoute,
  retryRelayRecoveryRoute,
  rebalanceRelayPoolRoute,
  drainRelayInstanceRoute,
  resumeRelayInstanceRoute,
  forceDisconnectRelayInstanceRoute,
  updateRelayInstanceRoute,
  changeRelayServicePortRoute,
  reenrollRelayInstanceRoute,
  renewRelayCertificateRoute,
];
