import type { DockerComposeNormalizedModel, DockerComposeOperationAction } from '@/db/schema/index.js';

export interface DockerComposeDispatchInput {
  operationId: string;
  projectId: string;
  projectName: string;
  revisionId: string | null;
  configDigest: string | null;
  /**
   * Each service's configuration digest, the value of its revision label: a service the revision leaves unchanged
   * keeps its label and Compose does not recreate it. Without them the daemon labels every service with
   * `configDigest`.
   */
  serviceConfigDigests?: Record<string, string> | null;
  yaml: string | null;
  normalizedModel: DockerComposeNormalizedModel | null;
  variables: Record<string, string>;
  secrets: Record<string, string>;
  /** `pull_create` pulls and creates the revision's containers without starting them (a stopped project). */
  action: DockerComposeOperationAction | 'pull_create';
  options: { removeOrphans?: boolean; volumeNames?: string[] };
}

export interface DockerComposeDispatchResult {
  success: boolean;
  message?: string;
  detail?: string;
}

export interface DockerComposeDispatcher {
  execute(nodeId: string, input: DockerComposeDispatchInput): Promise<DockerComposeDispatchResult>;
}
