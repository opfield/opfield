import type { DockerDeploymentSlot } from '@/db/schema/index.js';
import { type DockerLabels, labelString, managedLabelKey } from './docker-managed-labels.js';

/** Whether a container is a blue/green deployment's router or slot (either label namespace). */
export function isDockerDeploymentManaged(labels: DockerLabels): boolean {
  return labelString(labels, 'deployment.managed') === 'true';
}

/** The deployment a blue/green container belongs to ('' for any other container). */
export function dockerDeploymentIdLabel(labels: DockerLabels): string {
  return isDockerDeploymentManaged(labels) ? labelString(labels, 'deployment.id') : '';
}

/**
 * The labels of a deployment container, in the namespace the target node writes: `net.opfield.` on daemons that
 * advertise `opfield_labels_v1`, the legacy keys a 2.12.0 daemon reads otherwise.
 */
export function dockerDeploymentLabels(
  deploymentId: string,
  role: 'router' | 'app',
  slot: DockerDeploymentSlot | undefined,
  opfield: boolean
) {
  return {
    [managedLabelKey('deployment.managed', opfield)]: 'true',
    [managedLabelKey('deployment.id', opfield)]: deploymentId,
    [managedLabelKey('deployment.role', opfield)]: role,
    ...(slot ? { [managedLabelKey('deployment.slot', opfield)]: slot } : {}),
  };
}
