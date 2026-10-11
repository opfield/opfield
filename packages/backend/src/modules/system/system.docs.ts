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
      'Update without waiting for the long tasks running on the node; they may fail. Also ends the wait of an update that already waits for them.'
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
    'Updates the daemon of a node to the latest release. While backups, image builds, Docker migrations, image pulls, container actions, storage copies, or container archive transfers run on the node, the update waits for them first: `waitingForTasks` in the response, `metadata.updatePhase: waiting_for_tasks` and `metadata.updateWaitingForTasks` on the node. After 30 minutes it goes ahead anyway and keeps a warning in `metadata.lastUpdate.warnings`. `now: true` does not wait and ends the wait of an update already waiting (`waitSkipped`). Nodes in a lease-mode Availability policy then wait for their peers (`leaseSequenced`). An update of a Docker or nginx node whose daemon advertises `daemon_stream_handover_v1` keeps its relay stream sessions; `metadata.lastUpdate.connections` holds what the update kept and cut, and `metadata.lastUpdate.serviceRestart` says when the update restarted the whole service once for a newer launcher (or why not).',
  request: {
    params: NodeIdParamSchema,
    ...optionalJsonBody(
      DaemonUpdateRequestSchema,
      'Optional: `{ "now": true }` to update without waiting for running tasks'
    ),
  },
  responses: okJson(UnknownDataResponseSchema),
});
