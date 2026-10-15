import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  ApiErrorSchema,
  appRoute,
  createdJson,
  jsonBody,
  jsonContent,
  okJson,
  optionalJsonBody,
  pathParamSchema,
  successResponseSchema,
  UnknownDataResponseSchema,
  UnknownListResponseSchema,
} from '@/lib/openapi.js';
import type { AppEnv } from '@/types.js';
import {
  DockerBuildCreateSchema,
  DockerBuildListQuerySchema,
  DockerBuildLogQuerySchema,
  DockerBuildSecretValueSchema,
  DockerPendingContainerVolumesSchema,
  DockerSourceBindingConfigSchema,
} from './docker-build.schemas.js';
import { ComposeSourceProjectCreateSchema } from './docker-source-resource-creation.js';

const tags = ['Docker Builds'];

type Target = {
  noun: string;
  path: string;
  params: readonly string[];
  view: string;
  edit: string;
  manage: string;
};

const TARGETS: readonly Target[] = [
  {
    noun: 'container',
    path: '/nodes/{nodeId}/containers/{containerName}',
    params: ['nodeId', 'containerName'],
    view: 'docker:containers:view on the container (also one that exists only as a queued first source build)',
    edit: 'docker:containers:edit on the container (also one that exists only as a queued first source build)',
    manage: 'docker:containers:manage on the container (also one that exists only as a queued first source build)',
  },
  {
    noun: 'blue/green deployment',
    path: '/nodes/{nodeId}/deployments/{deploymentId}',
    params: ['nodeId', 'deploymentId'],
    view: 'docker:containers:view on the deployment',
    edit: 'docker:containers:edit on the deployment',
    manage: 'docker:containers:manage on the deployment',
  },
  {
    noun: 'Compose Project',
    path: '/nodes/{nodeId}/compose-projects/{projectId}',
    params: ['nodeId', 'projectId'],
    view: 'docker:compose:view on the Compose Project',
    edit: 'docker:compose:manage on the Compose Project',
    manage: 'docker:compose:manage on the Compose Project',
  },
];

const removedResponse = okJson(successResponseSchema.extend({ removed: z.boolean() }));

const buildResponses = {
  ...okJson(UnknownDataResponseSchema),
  ...createdJson(UnknownDataResponseSchema),
  503: {
    description:
      'No Build Worker takes the build: BUILD_WORKERS_PAUSED ("All Build Workers are paused for new builds"), NO_BUILD_WORKER_AVAILABLE, or BUILD_SCHEDULER_UNAVAILABLE.',
    content: jsonContent(ApiErrorSchema),
  },
};

function targetRoutes(target: Target) {
  const params = pathParamSchema(...target.params);
  const secretParams = pathParamSchema(...target.params, 'secretName');
  const source = `${target.path}/source`;
  return [
    appRoute({
      method: 'put',
      path: source,
      tags,
      summary: `Connect or change the Git source of a ${target.noun}`,
      description: `Saves the Git source: connector, repository (projectId), branch, Dockerfile or Compose file and context, build arguments, Build Secret names, automatic build and deploy, and the security policy (vulnerabilityThreshold, vulnerabilityScope all | application | fixable_application | fixable_all). Connecting a source or changing its connector, repository or branch also needs integrations:<provider>:use on the repository. Requires ${target.edit}.`,
      request: { params, ...jsonBody(DockerSourceBindingConfigSchema) },
      responses: okJson(UnknownDataResponseSchema),
    }),
    appRoute({
      method: 'delete',
      path: source,
      tags,
      summary: `Disconnect the Git source of a ${target.noun}`,
      description: `Removes the Git source binding and its Build Secrets; the workload keeps running its current image. For a container that exists only as a queued first source build, the reservation, its env and secrets go too. Requires ${target.edit}.`,
      request: { params },
      responses: removedResponse,
    }),
    appRoute({
      method: 'post',
      path: `${source}/resolve`,
      tags,
      summary: `Resolve the branch head of a ${target.noun}'s Git source`,
      description: `Records the current branch head as the desired commit without building. Requires ${target.edit}.`,
      request: { params },
      responses: okJson(UnknownDataResponseSchema),
    }),
    appRoute({
      method: 'post',
      path: `${source}/builds`,
      tags,
      summary: `Build the Git source of a ${target.noun} now`,
      description: `Queues a manual build of the desired commit (\`commitSha\` must name it when given; \`force\` builds again even when an artifact of the commit exists). Answers 201 with the new build, or 200 with the build that already covers the commit. Requires ${target.manage}.`,
      request: { params, ...optionalJsonBody(DockerBuildCreateSchema) },
      responses: buildResponses,
    }),
    appRoute({
      method: 'get',
      path: `${source}/build-secrets`,
      tags,
      summary: `List the Build Secrets of a ${target.noun}'s Git source`,
      description: `Names and update times only; values are never returned. Requires ${target.view}.`,
      request: { params },
      responses: okJson(UnknownListResponseSchema),
    }),
    appRoute({
      method: 'put',
      path: `${source}/build-secrets/{secretName}`,
      tags,
      summary: `Set a Build Secret of a ${target.noun}'s Git source`,
      description: `Creates or replaces the secret; builds receive it as a BuildKit secret (\`--secret id=<name>\`), never as a build argument or image layer. Requires ${target.edit}.`,
      request: { params: secretParams, ...jsonBody(DockerBuildSecretValueSchema) },
      responses: okJson(UnknownDataResponseSchema),
    }),
    appRoute({
      method: 'delete',
      path: `${source}/build-secrets/{secretName}`,
      tags,
      summary: `Delete a Build Secret of a ${target.noun}'s Git source`,
      description: `Requires ${target.edit}.`,
      request: { params: secretParams },
      responses: removedResponse,
    }),
    ...(target.noun === 'container'
      ? []
      : [
          appRoute({
            method: 'get',
            path: source,
            tags,
            summary: `Get the Git source of a ${target.noun}`,
            description: `The Git source binding: connector, repository, branch, build settings and policy, the desired and deployed commits, automatic build and deploy, and the last poll and webhook state. \`data\` is null without a source. Requires ${target.view}.`,
            request: { params },
            responses: okJson(UnknownDataResponseSchema),
          }),
        ]),
  ];
}

const containerParams = pathParamSchema('nodeId', 'containerName');
const buildParams = pathParamSchema('buildId');

/** Git source and build routes registered with plain handlers (their bodies are parsed by the same schemas). */
export const dockerSourceRouteDocs = [
  appRoute({
    method: 'get',
    path: '/sources/connectors',
    tags,
    summary: 'List the Git connectors a source can come from',
    description:
      'The connectors (id, name, provider) the caller may pick a source from: those its integrations:<provider>:use grants cover. Needs a create or edit scope of a workload (containers, Compose Projects or Pages).',
    responses: okJson(UnknownListResponseSchema),
  }),
  appRoute({
    method: 'get',
    path: '/sources/connectors/{connectorId}/repositories',
    tags,
    summary: 'List the repositories of a Git connector',
    description:
      'Repositories the caller may pick, with `truncated` when more exist past the listing bound (pass `search`), and `refreshing` while the list reloads (`awaitRefresh=true` waits for it).',
    request: {
      params: pathParamSchema('connectorId'),
      query: z.object({ search: z.string().max(200).optional(), awaitRefresh: z.enum(['true', 'false']).optional() }),
    },
    responses: okJson(UnknownListResponseSchema),
  }),
  appRoute({
    method: 'get',
    path: '/nodes/{nodeId}/containers/{containerName}/source/pending',
    tags,
    summary: 'Get a container that exists only as a queued first source build',
    description:
      'The reserved container: its Git source, the creation settings (`initialConfig`, volumes included) and the latest build. 404 PENDING_SOURCE_NOT_FOUND once the container exists. Requires docker:containers:view on it.',
    request: { params: containerParams },
    responses: okJson(UnknownDataResponseSchema),
  }),
  appRoute({
    method: 'put',
    path: '/nodes/{nodeId}/containers/{containerName}/source/pending/volumes',
    tags,
    summary: 'Set the volumes of a container before its first build',
    description:
      'Replaces the managed volume mounts the first build creates the container with (`{ volumes: [{ name, containerPath, readOnly }] }`). Each volume needs docker:volumes:view; one volume per path (400 DOCKER_MOUNT_TARGET_DUPLICATE). 409 SOURCE_CONTAINER_BUILT once the container exists (change its Settings instead). Requires docker:containers:edit on the container.',
    request: { params: containerParams, ...jsonBody(DockerPendingContainerVolumesSchema) },
    responses: okJson(UnknownDataResponseSchema),
  }),
  appRoute({
    method: 'post',
    path: '/nodes/{nodeId}/compose-projects/from-source',
    tags,
    summary: 'Create a Compose Project from a Git source and queue its first build',
    description:
      'Creates the project, saves its Git source and queues the first build of every service with a build section. `initialBuildError` explains a first build that could not be queued; `firstBuildWaiting` says it waits for a Build Worker to be unlocked. Requires docker:compose:create.',
    request: { params: pathParamSchema('nodeId'), ...jsonBody(ComposeSourceProjectCreateSchema) },
    responses: createdJson(UnknownDataResponseSchema),
  }),
  ...TARGETS.flatMap(targetRoutes),
  appRoute({
    method: 'get',
    path: '/builds',
    tags,
    summary: 'List Docker and Pages builds',
    description:
      'Builds the caller may view (containers and deployments: docker:containers:view; Compose: docker:compose:view; Pages: pages:view), newest first, with `nextCursor`. `excludeAppMembers` and `appId` filter like the other lists.',
    request: {
      query: DockerBuildListQuerySchema.extend({
        excludeAppMembers: z.enum(['true', 'false']).optional(),
        appId: z.string().uuid().optional(),
      }),
    },
    responses: okJson(UnknownListResponseSchema),
  }),
  appRoute({
    method: 'get',
    path: '/builds/{buildId}',
    tags,
    summary: 'Get a build',
    description:
      'The build with its target, commit, status, `errorCode`/`errorMessage`, `progress` (rollout note included) and artifact (scan summary, `policyDecision`, `policyReason`).',
    request: { params: buildParams },
    responses: okJson(UnknownDataResponseSchema),
  }),
  appRoute({
    method: 'get',
    path: '/builds/{buildId}/logs',
    tags,
    summary: 'Read the log chunks of a build',
    description:
      'Log chunks in sequence order after `afterSequence` (page with the last sequence until a short page). Chunks end on a line except a partial line flushed after 500 ms; join them in order to read whole lines.',
    request: { params: buildParams, query: DockerBuildLogQuerySchema },
    responses: okJson(UnknownListResponseSchema),
  }),
  appRoute({
    method: 'post',
    path: '/builds/{buildId}/cancel',
    tags,
    summary: 'Cancel a build',
    description:
      'Requests cancellation; a running build stops at its next step. Requires the manage scope of its target.',
    request: { params: buildParams },
    responses: okJson(UnknownDataResponseSchema),
  }),
  appRoute({
    method: 'post',
    path: '/builds/{buildId}/retry',
    tags,
    summary: 'Retry a build',
    description: 'Queues a new build of the same commit and settings. Requires the manage scope of its target.',
    request: { params: buildParams },
    responses: { ...createdJson(UnknownDataResponseSchema), ...buildResponses },
  }),
];

/** Adds the documentation of routes whose handlers are registered without the OpenAPI wrapper. */
export function documentDockerSourceRoutes(router: OpenAPIHono<AppEnv>) {
  for (const route of dockerSourceRouteDocs) router.openAPIRegistry.registerPath(route);
}
