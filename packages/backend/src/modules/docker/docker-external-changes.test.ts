import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuditRequestContext, runWithAuditRequestContext } from '@/modules/audit/audit-request-context.js';
import {
  type DockerExternalChange,
  DockerExternalChangeWatcher,
  externalChangeConsequence,
  managedAs,
} from './docker-external-changes.service.js';
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

  // rc.3 GO-3 and explore O-6: stops, kills, pauses and updates count, and each says what it means.
  it('says what each kind of change means', () => {
    expect(managedAs(change({ containerId: '1a2b3c', action: 'stopped' }), records)).toBe('container');
    expect(externalChangeConsequence('removed')).toContain('permissions were reset');
    expect(externalChangeConsequence('created')).toContain('new container under a managed name');
    for (const action of ['stopped', 'killed', 'paused', 'unpaused', 'updated'] as const) {
      expect(externalChangeConsequence(action)).not.toContain('permissions were reset');
    }
    expect(externalChangeConsequence('updated')).toContain('docker update');
  });

  it('ignores containers Opfield does not manage', () => {
    expect(managedAs(change({}), records)).toBeNull();
    expect(managedAs(change({ labels: { 'com.docker.compose.project': 'sandbox' } }), records)).toBeNull();
  });
});

describe('when the watcher reads a node', () => {
  const nodeId = 'node-1';

  function watcher() {
    const handlers = new Map<string, (payload: unknown) => void>();
    const eventBus = {
      subscribe: (channel: string, fn: (payload: unknown) => void) => {
        handlers.set(channel, fn);
        return () => handlers.delete(channel);
      },
      publish: vi.fn(),
    };
    const registry = {
      getNode: () => ({ nodeId, type: 'docker', hostname: 'app-node-1' }),
      hasCapability: () => true,
      getNodesByType: () => [{ nodeId }],
    };
    const instance = new DockerExternalChangeWatcher(
      {} as never,
      { sendDockerContainerCommand: vi.fn() } as never,
      registry as never,
      eventBus as never,
      { log: vi.fn() }
    );
    const pulls: number[] = [];
    vi.spyOn(instance, 'pullNow').mockImplementation(async () => {
      pulls.push(Date.now());
    });
    return { instance, handlers, pulls };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The health report with the container diff leaves at the Docker event; the daemon lists the change 3 s later.
  it('reads it again after the daemon listed the change', () => {
    const { instance, handlers, pulls } = watcher();
    instance.start();
    handlers.get('docker.container.changed')!({ nodeId, id: 'c1', action: 'updated' });
    vi.advanceTimersByTime(10_000);
    expect(pulls).toEqual([1_500, 6_000]);
    instance.stop();
  });

  // rc.3 GF-2: the pull started from a request's event wrote the request's IP, token and tool arguments into the
  // audit row of a change root made on the node.
  it('pulls outside the audit context of the request that triggered it', async () => {
    const { instance } = watcher();
    vi.mocked(instance.pullNow).mockRestore();
    const contexts: unknown[] = [];
    (instance as unknown as { pull: (nodeId: string) => Promise<void> }).pull = async () => {
      contexts.push(getAuditRequestContext());
    };
    const request = {
      ipAddress: '172.20.0.138',
      mcp: { toolName: 'create_docker_container', category: 'x', arguments: {} },
    };
    runWithAuditRequestContext(request, () => instance.schedule(nodeId));
    vi.advanceTimersByTime(2_000);
    await runWithAuditRequestContext(request, () => instance.pullNow('node-2'));
    await vi.runAllTimersAsync();
    expect(contexts).toEqual([undefined, undefined]);
  });

  it('reads every capable node once a minute', () => {
    const { instance, pulls } = watcher();
    instance.start();
    vi.advanceTimersByTime(120_000);
    expect(pulls).toEqual([60_000, 120_000]);
    instance.stop();
  });
});
