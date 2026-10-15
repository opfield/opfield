import { ACTIVE_BUILD_STATUSES } from './docker-build-policy.js';

/**
 * How many builds the internal registry holds per container (per source binding and image repository): the one the
 * workload runs and one to roll back to. Fixed, not a setting: a larger count is what filled the production disk.
 */
export const REGISTRY_BUILDS_KEPT_PER_CONTAINER = 2;

export interface RegistryRetentionArtifact {
  id: string;
  sourceBindingId: string | null;
  repository: string;
  digest: string;
  createdAt: Date;
  /** Never deleted, and not counted toward the builds kept per container (a build still pushing or deploying). */
  pinned: boolean;
  /** A successful build: it may stay as the container's rollback build. */
  retainInHistory: boolean;
  /** A workload runs this exact digest now: always kept, and counted toward the builds kept per container. */
  running?: boolean;
}

export interface RegistryRetentionArtifactRow {
  id: string;
  buildId: string | null;
  sourceBindingId: string | null;
  ownerKind: string;
  repository: string;
  digest: string;
  createdAt: Date;
  policyDecision: string;
  buildStatus: string | null;
}

/** An artifact pin that has not expired. */
export interface RegistryRetentionPinRow {
  artifactId: string;
  kind: string;
  ownerKey: string;
  composeRevisionId: string | null;
}

export interface RegistryRetentionBindingTarget {
  id: string;
  targetKind: string;
  nodeId: string | null;
  containerName: string | null;
  deploymentId: string | null;
  composeProjectId: string | null;
}

/** Whether a pin owner key names the source binding's own target, as the build rollout writes it. */
function isOwnTargetKey(binding: RegistryRetentionBindingTarget | undefined, ownerKey: string): boolean {
  if (!binding) return false;
  if (binding.targetKind === 'deployment') return ownerKey === `deployment:${binding.deploymentId}`;
  if (binding.targetKind === 'container') return ownerKey === `container:${binding.nodeId}:${binding.containerName}`;
  if (binding.targetKind === 'compose_project') return ownerKey.startsWith(`compose:${binding.composeProjectId}:`);
  return false;
}

/**
 * What retention may do with each artifact. A Git build is running when a runtime record names its exact digest (or
 * its build tag) or its target's active pin holds it; a reference to the build repository alone no longer protects
 * every build in it. The target's own rollback pin does not protect: the rollback build is the newest other
 * successful build. Pins of other owners (a promoted environment, Availability) and builds still in flight do.
 * Compose revision pins protect nothing on their own: the active revision is a runtime reference already.
 * Mirrored (non-build) artifacts keep the earlier conservative rule.
 */
export function classifyRegistryRetentionArtifacts(input: {
  artifacts: RegistryRetentionArtifactRow[];
  pins: RegistryRetentionPinRow[];
  references: string;
  bindings: RegistryRetentionBindingTarget[];
}): RegistryRetentionArtifact[] {
  const pinsByArtifact = new Map<string, RegistryRetentionPinRow[]>();
  for (const pin of input.pins) {
    pinsByArtifact.set(pin.artifactId, [...(pinsByArtifact.get(pin.artifactId) ?? []), pin]);
  }
  const bindings = new Map(input.bindings.map((binding) => [binding.id, binding]));
  const inFlight = new Set<string>(ACTIVE_BUILD_STATUSES);
  return input.artifacts.map((artifact) => {
    const pins = pinsByArtifact.get(artifact.id) ?? [];
    const base = {
      id: artifact.id,
      sourceBindingId: artifact.sourceBindingId,
      repository: artifact.repository,
      digest: artifact.digest,
      createdAt: artifact.createdAt,
    };
    if (artifact.ownerKind !== 'build' || !artifact.sourceBindingId) {
      return {
        ...base,
        pinned:
          pins.length > 0 ||
          input.references.includes(`${artifact.repository}@`) ||
          input.references.includes(`${artifact.repository}:`),
        retainInHistory: false,
        running: false,
      };
    }
    const binding = bindings.get(artifact.sourceBindingId);
    const referenced =
      input.references.includes(`${artifact.repository}@${artifact.digest}`) ||
      (artifact.buildId !== null && input.references.includes(`${artifact.repository}:${artifact.buildId}`));
    const running = referenced || pins.some((pin) => pin.kind === 'active');
    const protectedByPin = pins.some((pin) => {
      if (pin.kind === 'active') return false;
      if (pin.kind === 'rollback') return !isOwnTargetKey(binding, pin.ownerKey);
      if (pin.kind === 'manual') return pin.composeRevisionId === null;
      return true;
    });
    return {
      ...base,
      pinned: protectedByPin || (artifact.buildStatus !== null && inFlight.has(artifact.buildStatus)),
      retainInHistory: artifact.policyDecision === 'approved' && artifact.buildStatus === 'succeeded',
      running,
    };
  });
}

function digestKey(artifact: RegistryRetentionArtifact): string {
  return `${artifact.repository}\0${artifact.digest}`;
}

/**
 * Per container (source binding and image repository): the running build(s) and the newest other successful build,
 * at most REGISTRY_BUILDS_KEPT_PER_CONTAINER together unless more are running. Pinned artifacts stay besides; an
 * artifact that shares its manifest with a kept one stays with it. Everything else is a deletion candidate.
 */
export function selectRegistryRetentionCandidates(artifacts: RegistryRetentionArtifact[]): {
  retained: RegistryRetentionArtifact[];
  candidates: RegistryRetentionArtifact[];
} {
  const retainedIds = new Set(artifacts.filter((artifact) => artifact.pinned).map((artifact) => artifact.id));
  const containers = new Map<string, RegistryRetentionArtifact[]>();
  for (const artifact of artifacts) {
    if (!artifact.sourceBindingId) continue;
    const key = `${artifact.sourceBindingId}\0${artifact.repository}`;
    containers.set(key, [...(containers.get(key) ?? []), artifact]);
  }
  for (const group of containers.values()) {
    const kept = new Set<string>();
    for (const artifact of group.filter((candidate) => candidate.running)) {
      retainedIds.add(artifact.id);
      kept.add(digestKey(artifact));
    }
    const rollback = group
      .filter((artifact) => !artifact.running && artifact.retainInHistory)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    for (const artifact of rollback) {
      if (kept.has(digestKey(artifact))) {
        retainedIds.add(artifact.id);
        continue;
      }
      if (kept.size >= REGISTRY_BUILDS_KEPT_PER_CONTAINER) break;
      retainedIds.add(artifact.id);
      kept.add(digestKey(artifact));
    }
  }
  const retainedDigests = new Set(artifacts.filter((artifact) => retainedIds.has(artifact.id)).map(digestKey));
  for (const artifact of artifacts) {
    if (retainedDigests.has(digestKey(artifact))) retainedIds.add(artifact.id);
  }
  return {
    retained: artifacts.filter((artifact) => retainedIds.has(artifact.id)),
    candidates: artifacts.filter((artifact) => !retainedIds.has(artifact.id)),
  };
}
