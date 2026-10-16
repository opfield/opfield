import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { container } from '@/container.js';
import {
  ApiErrorSchema,
  appRoute,
  jsonContent,
  okJson,
  optionalJsonBody,
  pathParamSchema,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { requireDockerContainerScope } from './docker-access.middleware.js';
import { DockerSourceService } from './docker-source.service.js';
import { withDockerSourceBuildState } from './docker-source-build-state.js';

export const DockerSourceRollbackSchema = z.object({
  buildId: z
    .string()
    .uuid()
    .optional()
    .describe('A succeeded build of this source to go back to; default: the build the container ran before.'),
});

export const rollbackContainerSourceRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerName}/source/rollback',
  tags: ['Docker Builds'],
  summary: 'Roll a Git-source container back to a kept build',
  description:
    "Runs a build the internal registry keeps on the container again: `buildId` when given, otherwise the build the container ran before. The registry keeps per container the build it runs and one previous build, so a rollback can go back one build; to run older code, push a revert commit. The container is recreated from that build's image digest with its current settings, env and secrets, the same way a build deploys it (and returned to the image it ran when the rolled-back image fails readiness); a container stopped on request stays stopped and runs the image on its next start. The source then records the rollback's commit as deployed and keeps the build it replaced as the one to return to (roll back again to return to it). It stays on that build until a new commit on the branch, or a manual build, is built and deployed. Returns `{ source, build, previousBuild, note }`; `source.rollbackBuild` in the source answer names the build a rollback would go back to now. Refused with 409 SOURCE_BUILD_IN_PROGRESS while a build of the source is queued, building or deploying. Blue/green deployments roll back with POST …/deployments/{deploymentId}/rollback, Compose Projects by applying an earlier revision. Requires docker:containers:manage on the container.",
  request: {
    params: pathParamSchema('nodeId', 'containerName'),
    ...optionalJsonBody(DockerSourceRollbackSchema),
  },
  responses: {
    ...okJson(UnknownDataResponseSchema),
    404: {
      description:
        'The container has no Git source (SOURCE_BINDING_NOT_FOUND), or `buildId` is not a build of its source (SOURCE_ROLLBACK_BUILD_NOT_FOUND).',
      content: jsonContent(ApiErrorSchema),
    },
    409: {
      description:
        'Nothing was changed. SOURCE_ROLLBACK_UNAVAILABLE: no previous build is kept (push a revert commit instead). SOURCE_BUILD_IN_PROGRESS: a build of the source is queued, building or deploying (`details.buildId`, `details.status`); wait or cancel it. SOURCE_ROLLBACK_BUILD_NOT_SUCCEEDED, SOURCE_ROLLBACK_BUILD_NOT_KEPT, SOURCE_ROLLBACK_BUILD_NOT_APPROVED, SOURCE_ROLLBACK_BUILD_RUNNING: `buildId` names a build that is not succeeded, whose image the registry no longer keeps, that the vulnerability policy did not approve, or that the container already runs (`details` name the value found and the one expected). SOURCE_ROLLBACK_FAILED: the rolled-back image did not become ready and the container runs its previous image again (the message carries the container state). BUILD_ROLLOUT_IN_PROGRESS: a build rollout took the container meanwhile.',
      content: jsonContent(ApiErrorSchema),
    },
  },
});

/** POST …/containers/{containerName}/source/rollback: needs the build scope on the container, as a build does. */
export function registerDockerSourceRollbackRoute(router: OpenAPIHono<AppEnv>) {
  router.openAPIRegistry.registerPath(rollbackContainerSourceRoute);
  router.post(
    '/nodes/:nodeId/containers/:containerName/source/rollback',
    requireDockerContainerScope('docker:containers:manage', 'containerName', { allowPendingSource: true }),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      const input = DockerSourceRollbackSchema.parse(await c.req.json().catch(() => ({})));
      const result = await container.resolve(DockerSourceService).rollback(
        {
          kind: 'container',
          nodeId: c.req.param('nodeId'),
          containerName: decodeURIComponent(c.req.param('containerName')),
        },
        input,
        { ...user, scopes: c.get('effectiveScopes') ?? user.scopes }
      );
      return c.json({ data: { ...result, source: await withDockerSourceBuildState(result.source) } });
    }
  );
}
