import { type DockerLabels, labelString, opfieldLabelKey } from './docker-managed-labels.js';

export const DOCKER_MANAGED_VOLUME_LABEL = opfieldLabelKey('managed-volume');

/** Whether the daemon labelled a volume as managed (either label namespace). */
export function isDockerManagedVolumeLabelled(labels: DockerLabels): boolean {
  return labelString(labels, 'managed-volume') === 'true';
}
