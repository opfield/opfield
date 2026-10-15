import { describe, expect, it } from 'vitest';
import { type DockerExternalChange, managedAs } from './docker-external-changes.service.js';
import type { DockerManagedRecords } from './docker-managed-records.js';

const records: DockerManagedRecords = {
  recordedNames: new Set(['web', 'api']),
  recordedIds: new Set(['1a2b3c']),
  reservedNames: new Map([['api', 'its Git source']]),
  sourceContainers: new Map([['api', 'binding-1']]),
  composeProjects: new Set(['shop']),
  volumes: new Set(),
  networks: new Set(),
};

const change = (overrides: Partial<DockerExternalChange>): DockerExternalChange => ({
  seq: 1,
  at: '2026-10-15T12:00:00Z',
  action: 'removed',
  containerId: 'ffff',
  name: 'scratch',
  ...overrides,
});

describe('changes outside Opfield', () => {
  it('names what a managed container was to Opfield', () => {
    expect(managedAs(change({ name: 'api', action: 'created' }), records)).toBe('Git-source container');
    expect(managedAs(change({ containerId: '1a2b3c' }), records)).toBe('container');
    expect(managedAs(change({ name: 'web-new', oldName: 'web', action: 'renamed' }), records)).toBe('container');
    expect(managedAs(change({ labels: { 'com.docker.compose.project': 'shop' } }), records)).toBe(
      'Compose project "shop"'
    );
    expect(managedAs(change({ labels: { 'net.opfield.deployment.id': 'd1' } }), records)).toBe('Opfield workload');
  });

  it('ignores containers Opfield does not manage', () => {
    expect(managedAs(change({}), records)).toBeNull();
    expect(managedAs(change({ labels: { 'com.docker.compose.project': 'sandbox' } }), records)).toBeNull();
  });
});
