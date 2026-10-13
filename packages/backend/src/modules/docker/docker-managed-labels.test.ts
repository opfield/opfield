import { describe, expect, it } from 'vitest';
import { stripReservedGwcaLabels } from './docker-container-archive-format.js';
import {
  dockerDeploymentIdLabel,
  dockerDeploymentLabels,
  isDockerDeploymentManaged,
} from './docker-deployment-labels.js';
import { isOpfieldInternalContainer } from './docker-internal-containers.js';
import { labelString, nodeWritesOpfieldLabels } from './docker-managed-labels.js';
import { isDockerManagedVolumeLabelled } from './docker-managed-volume.constants.js';
import { isReservedDockerLabel, reservedLabelsDroppedOnDuplicate } from './docker-reserved-labels.js';
import { dockerSecretEnvOwners } from './docker-secret-env.js';

describe('managed Docker labels across the Opfield rename', () => {
  it('reads a legacy-only, a new-only and a doubly labelled container, the net.opfield value winning', () => {
    expect(labelString({ 'wiolett.gateway.deployment.id': 'old' }, 'deployment.id')).toBe('old');
    expect(labelString({ 'net.opfield.deployment.id': 'new' }, 'deployment.id')).toBe('new');
    expect(
      labelString({ 'wiolett.gateway.deployment.id': 'old', 'net.opfield.deployment.id': 'new' }, 'deployment.id')
    ).toBe('new');
    expect(labelString(null, 'deployment.id')).toBe('');
  });

  it('recognizes deployment containers, internal containers and managed volumes in either namespace', () => {
    for (const prefix of ['wiolett.gateway.', 'net.opfield.']) {
      const labels = { [`${prefix}deployment.managed`]: 'true', [`${prefix}deployment.id`]: 'dep-1' };
      expect(isDockerDeploymentManaged(labels)).toBe(true);
      expect(dockerDeploymentIdLabel(labels)).toBe('dep-1');
      expect(isOpfieldInternalContainer({ Labels: { [`${prefix}managed`]: 'backup-runner' } })).toBe(true);
      expect(isOpfieldInternalContainer({ Labels: { [`${prefix}availability.managed`]: 'true' } })).toBe(true);
      expect(
        dockerSecretEnvOwners('node-1', {
          Name: '/web',
          Config: { Labels: { [`${prefix}compose.project-id`]: 'p-1' } },
        })
      ).toContainEqual({ nodeId: 'node-1', containerName: 'compose:p-1', matchValues: true });
    }
    expect(isDockerManagedVolumeLabelled({ 'com.wiolett.gateway.managed-volume': 'true' })).toBe(true);
    expect(isDockerManagedVolumeLabelled({ 'net.opfield.managed-volume': 'true' })).toBe(true);
    expect(isOpfieldInternalContainer({ Labels: { team: 'core' } })).toBe(false);
  });

  it('writes deployment labels in the namespace the node advertises', () => {
    expect(nodeWritesOpfieldLabels({ capabilities: ['opfield_labels_v1'] })).toBe(true);
    expect(nodeWritesOpfieldLabels({ capabilities: [] })).toBe(false);
    expect(dockerDeploymentLabels('dep-1', 'app', 'blue', true)).toEqual({
      'net.opfield.deployment.managed': 'true',
      'net.opfield.deployment.id': 'dep-1',
      'net.opfield.deployment.role': 'app',
      'net.opfield.deployment.slot': 'blue',
    });
    expect(dockerDeploymentLabels('dep-1', 'router', undefined, false)).toEqual({
      'wiolett.gateway.deployment.managed': 'true',
      'wiolett.gateway.deployment.id': 'dep-1',
      'wiolett.gateway.deployment.role': 'router',
    });
  });

  it('reserves the net.opfield namespace and keeps the legacy ones reserved', () => {
    for (const key of ['net.opfield.deployment.id', 'wiolett.gateway.deployment.id', 'com.wiolett.gateway.x']) {
      expect(isReservedDockerLabel(key)).toBe(true);
    }
    expect(isReservedDockerLabel('net.opfieldish.team')).toBe(false);
    expect(
      reservedLabelsDroppedOnDuplicate({
        'net.opfield.archive.image.reference': 'nginx:1',
        'net.opfield.gpu.group-ids': '44',
        'net.opfield.deployment.id': 'dep-1',
      })
    ).toEqual(['net.opfield.deployment.id']);
    expect(
      stripReservedGwcaLabels({
        team: 'core',
        'net.opfield.archive.id': 'a',
        'wiolett.gateway.migration.id': 'm',
        'net.opfield.deployment.managed': 'true',
      })
    ).toEqual({ team: 'core' });
  });
});
