import { describe, expect, it, vi } from 'vitest';
import { DockerRegistryBuildRetention } from './docker-registry-build-retention.js';
import {
  classifyRegistryRetentionArtifacts,
  type RegistryRetentionArtifactRow,
  type RegistryRetentionBindingTarget,
  type RegistryRetentionPinRow,
  selectRegistryRetentionCandidates,
} from './docker-registry-retention.js';

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
const repo = (binding: string) => `gateway/builds/${binding}`;
const image = (binding: string, n: number) => `127.0.0.1:5443/${repo(binding)}@${digest(n)}`;

/** Build `n` of a source, newer for a larger `n`; digests are unique per source. */
function build(binding: string, n: number, status = 'succeeded', offset = 0): RegistryRetentionArtifactRow {
  return {
    id: `${binding}-${n}`,
    buildId: `build-${binding}-${n}`,
    sourceBindingId: binding,
    ownerKind: 'build',
    repository: repo(binding),
    digest: digest(n + offset),
    createdAt: new Date(Date.UTC(2026, 9, 1) + n * 60_000),
    policyDecision: 'approved',
    buildStatus: status,
  };
}

const deployment = (binding: string): RegistryRetentionBindingTarget => ({
  id: binding,
  targetKind: 'deployment',
  nodeId: 'node-1',
  containerName: null,
  deploymentId: `dep-${binding}`,
  composeProjectId: null,
});

function retainedIds(input: {
  artifacts: RegistryRetentionArtifactRow[];
  references?: unknown[];
  pins?: RegistryRetentionPinRow[];
  bindings?: RegistryRetentionBindingTarget[];
}) {
  const classified = classifyRegistryRetentionArtifacts({
    artifacts: input.artifacts,
    pins: input.pins ?? [],
    references: JSON.stringify(input.references ?? []),
    bindings: input.bindings ?? [],
  });
  const { retained, candidates } = selectRegistryRetentionCandidates(classified);
  return { retained: retained.map((artifact) => artifact.id).sort(), deleted: candidates.length };
}

describe('internal registry retention: running + rollback per container', () => {
  it('keeps the running build and the newest other one of an app with 20 older builds', () => {
    const artifacts = Array.from({ length: 21 }, (_, n) => build('a', n + 1));
    const result = retainedIds({
      artifacts,
      references: [{ config: { image: image('a', 15) } }],
      bindings: [deployment('a')],
    });
    expect(result.retained).toEqual(['a-15', 'a-21']);
    expect(result.deleted).toBe(19);
  });

  it('keeps the running build and the newest successful one when a newer deploy failed', () => {
    const artifacts = [
      build('a', 1),
      build('a', 2),
      build('a', 3),
      build('a', 4),
      build('a', 5, 'failed'),
      build('a', 6, 'failed'),
    ];
    const result = retainedIds({ artifacts, references: [{ config: { image: image('a', 3) } }] });
    expect(result.retained).toEqual(['a-3', 'a-4']);
  });

  it('keeps each app to its own two builds', () => {
    const artifacts = [1, 2, 3, 4].flatMap((n) => [build('a', n), build('b', n, 'succeeded', 100)]);
    const result = retainedIds({
      artifacts,
      references: [{ config: { image: image('a', 2) } }, { config: { image: image('b', 104) } }],
    });
    expect(result.retained).toEqual(['a-2', 'a-4', 'b-3', 'b-4']);
  });

  it('no longer pins every build of a repository that a runtime record names', () => {
    const artifacts = Array.from({ length: 10 }, (_, n) => build('a', n + 1));
    // The old rule pinned all ten: the repository appears in the reference.
    const result = retainedIds({ artifacts, references: [{ config: { image: image('a', 10) } }] });
    expect(result.retained).toEqual(['a-10', 'a-9']);
  });

  it('never deletes pinned, in-flight, Compose- or Availability-referenced builds', () => {
    const artifacts = [
      ...Array.from({ length: 6 }, (_, n) => build('a', n + 1)),
      build('a', 7, 'pushing'),
      { ...build('c', 1), repository: `${repo('c')}/web` },
      { ...build('c', 2), repository: `${repo('c')}/web` },
      { ...build('c', 3), repository: `${repo('c')}/web` },
    ];
    const pins: RegistryRetentionPinRow[] = [
      // Running in an environment it was promoted to, which may roll back to build 1.
      { artifactId: 'a-2', kind: 'active', ownerKey: 'deployment:dep-other', composeRevisionId: null },
      { artifactId: 'a-1', kind: 'rollback', ownerKey: 'deployment:dep-other', composeRevisionId: null },
      // The app's own rollback pin and an old Compose revision decide nothing.
      { artifactId: 'a-3', kind: 'rollback', ownerKey: 'deployment:dep-a', composeRevisionId: null },
      { artifactId: 'c-1', kind: 'manual', ownerKey: 'compose-revision:r1:web', composeRevisionId: 'r1' },
    ];
    const result = retainedIds({
      artifacts,
      pins,
      bindings: [deployment('a'), { ...deployment('c'), targetKind: 'compose_project', composeProjectId: 'p' }],
      references: [
        { image: image('a', 4), runtime: 'availability placement' },
        { source: `services:\n  web:\n    image: 127.0.0.1:5443/${repo('c')}/web@${digest(2)}\n` },
      ],
    });
    expect(result.retained).toEqual(['a-1', 'a-2', 'a-4', 'a-7', 'c-2', 'c-3']);
  });
});

describe('internal registry retention when a build finishes', () => {
  function setup(busy = false) {
    const artifacts = [1, 2, 3, 4].flatMap((n) => [build('a', n), build('b', n, 'succeeded', 100)]);
    const deleted: string[] = [];
    const store = {
      buildRetentionScope: vi.fn(async () => ({ sourceBindingId: 'a', busy })),
      listRetentionArtifacts: vi.fn(async () =>
        classifyRegistryRetentionArtifacts({
          artifacts: artifacts.filter((artifact) => !deleted.includes(artifact.id)),
          pins: [],
          references: '[]',
          bindings: [],
        })
      ),
      markArtifactDeleted: vi.fn(async (id: string) => {
        deleted.push(id);
      }),
      hasActiveRegistryUsers: vi.fn(async () => false),
      hasUncollectedDeletions: vi.fn(async () => true),
    };
    const executor = { deleteManifest: vi.fn(async () => {}) };
    const collectGarbage = vi.fn(async () => undefined);
    const retention = new DockerRegistryBuildRetention(
      {
        store: store as never,
        executor: () => executor as never,
        getState: async () => ({ status: 'ready', maintenancePhase: 'idle', lastGcAt: null }) as never,
        maintenanceRunning: () => false,
        collectGarbage,
      },
      0
    );
    return { retention, deleted, executor, collectGarbage };
  }

  it('deletes only that source builds beyond two, then collects once', async () => {
    vi.useFakeTimers();
    const { retention, deleted, executor, collectGarbage } = setup();
    await expect(retention.prune('build-a-4')).resolves.toBe(2);
    await expect(retention.prune('build-a-4')).resolves.toBe(0);
    expect(deleted).toEqual(['a-1', 'a-2']);
    expect(executor.deleteManifest).toHaveBeenCalledWith(repo('a'), digest(2));
    await vi.runAllTimersAsync();
    expect(collectGarbage).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('leaves a source alone while another of its builds still runs', async () => {
    const { retention, deleted } = setup(true);
    await expect(retention.prune('build-a-4')).resolves.toBe(0);
    expect(deleted).toEqual([]);
  });
});
