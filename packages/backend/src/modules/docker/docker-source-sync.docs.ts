import {
  ApiErrorSchema,
  appRoute,
  jsonContent,
  okJson,
  pathParamSchema,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';

const tags = ['Docker Builds'];

const SYNC_DESCRIPTION =
  'Checks the source branch for a new commit now instead of waiting for the next poll or webhook: one poll iteration for this source, also when automatic builds are off. The head is resolved with the connector credentials and recorded as the desired commit; a `poll` build is queued only when the source builds automatically and the head changed or has no build yet. Returns `{ source, changed, build }` (`build` is null when nothing was queued); a refused build answers 503 instead. Within about 10 seconds of the previous poll or sync the current state is returned without asking the Git provider. Requires the same scope as a manual build; no integrations:<provider>:use is needed.';

const syncResponses = {
  ...okJson(UnknownDataResponseSchema),
  502: {
    description:
      'The Git provider refused or failed the check (SOURCE_SYNC_FAILED); the error is kept as the last poll error.',
    content: jsonContent(ApiErrorSchema),
  },
  503: {
    description:
      'The build the check would queue is not admitted: BUILD_WORKERS_PAUSED ("All Build Workers are paused for new builds"), NO_BUILD_WORKER_AVAILABLE, or INTERNAL_REGISTRY_NOT_WRITABLE (the internal registry takes no pushes: its disk is 90% full or more, or it is in maintenance; the message says which). Nothing is queued; also answered within the 10-second window while the branch head still has no build. Sync again once a worker is unlocked or online or the registry is writable; the next poll also builds it then.',
    content: jsonContent(ApiErrorSchema),
  },
};

export const getContainerSourceRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/{containerName}/source',
  tags,
  summary: 'Get the Git source of a container',
  description:
    'The Git source binding of a container: connector, repository, branch, build settings and security policy, the desired and deployed commits, automatic build and deploy, and the last poll and webhook state. `latestBuild` is the latest build (status, trigger, commit, errorCode, errorMessage, policy decision and reason, rollout note; `latestBuilds` holds every service build of a Compose commit) and `state` says in one sentence what it did and what runs on the target, so a source with nothing deployed says why. `data` is null when the container has no Git source. Works for a container that exists only as a queued first source build. Requires docker:containers:view on the container.',
  request: { params: pathParamSchema('nodeId', 'containerName') },
  responses: okJson(UnknownDataResponseSchema),
});

export const syncContainerSourceRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerName}/source/sync',
  tags,
  summary: 'Sync the Git source of a container now',
  description: `${SYNC_DESCRIPTION} Requires docker:containers:manage on the container, including a container that exists only as a queued first source build.`,
  request: { params: pathParamSchema('nodeId', 'containerName') },
  responses: syncResponses,
});

export const syncDeploymentSourceRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/source/sync',
  tags,
  summary: 'Sync the Git source of a blue/green deployment now',
  description: `${SYNC_DESCRIPTION} Requires docker:containers:manage on the deployment.`,
  request: { params: pathParamSchema('nodeId', 'deploymentId') },
  responses: syncResponses,
});

export const syncComposeSourceRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/compose-projects/{projectId}/source/sync',
  tags,
  summary: 'Sync the Git source of a Compose Project now',
  description: `${SYNC_DESCRIPTION} Requires docker:compose:manage on the Compose Project.`,
  request: { params: pathParamSchema('nodeId', 'projectId') },
  responses: syncResponses,
});
