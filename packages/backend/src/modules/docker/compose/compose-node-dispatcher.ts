import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type {
  DockerComposeDispatcher,
  DockerComposeDispatchInput,
  DockerComposeDispatchResult,
} from './compose-dispatcher.js';

/**
 * The daemon's answer to a command still queued for a handler when its control session was renewed (shared/lifecycle
 * session.go): the command never started, so it is a lost connection to retry, not a failure of the operation.
 */
const NOT_STARTED_BEFORE_SESSION_END = 'the control session ended before the command started';

export class DockerComposeNodeDispatcher implements DockerComposeDispatcher {
  constructor(private nodeDispatch: NodeDispatchService) {}

  async execute(nodeId: string, input: DockerComposeDispatchInput): Promise<DockerComposeDispatchResult> {
    const result = await this.nodeDispatch.sendDockerComposeCommand(nodeId, input.action, {
      operationId: input.operationId,
      projectId: input.projectId,
      projectName: input.projectName,
      revisionId: input.revisionId ?? undefined,
      configDigest: input.configDigest ?? undefined,
      composeYaml: input.yaml == null ? undefined : Buffer.from(input.yaml, 'utf8'),
      // The per-service digests travel with the normalized model; the daemon reads `serviceConfigDigests` from it.
      normalizedModelJson:
        input.normalizedModel == null
          ? undefined
          : JSON.stringify(
              input.serviceConfigDigests
                ? { ...input.normalizedModel, serviceConfigDigests: input.serviceConfigDigests }
                : input.normalizedModel
            ),
      variables: input.variables,
      secrets: input.secrets,
      removeOrphans: input.options.removeOrphans ?? false,
      volumeNames: input.options.volumeNames ?? [],
    });

    if (!result.success && result.error?.includes(NOT_STARTED_BEFORE_SESSION_END)) {
      throw new Error('The node connection changed before the Compose command started');
    }
    return {
      success: result.success,
      message: result.error || undefined,
      detail: result.detail || undefined,
    };
  }
}
