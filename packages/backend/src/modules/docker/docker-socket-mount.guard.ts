import path from 'node:path';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';

type DockerMountInput = {
  hostPath?: string | null;
  containerPath?: string | null;
  name?: string | null;
  readOnly?: boolean | null;
};

type DockerInspectMount = {
  Type?: string;
  Source?: string;
  Destination?: string;
  Name?: string;
  RW?: boolean;
};

type DockerInspectData = {
  HostConfig?: { Binds?: string[] | null } | null;
  Mounts?: DockerInspectMount[] | null;
};

export type NormalizedMountDefinition = {
  type: 'bind' | 'volume';
  source: string;
  target: string;
  readOnly: boolean;
  options?: readonly string[];
};

function normalizeHostPath(input: string | null | undefined): string {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return '';
  return path.posix.normalize(trimmed.replaceAll('\\', '/'));
}

function normalizeContainerPath(input: string | null | undefined): string {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return '';
  return path.posix.normalize(trimmed.replaceAll('\\', '/'));
}

function normalizeMountInput(mount: DockerMountInput): NormalizedMountDefinition | null {
  const target = normalizeContainerPath(mount.containerPath);
  if (!target) return null;
  const hostPath = normalizeHostPath(mount.hostPath);
  if (hostPath) {
    return { type: 'bind', source: hostPath, target, readOnly: mount.readOnly === true };
  }
  const name = String(mount.name ?? '').trim();
  if (!name) return null;
  return { type: 'volume', source: name, target, readOnly: mount.readOnly === true };
}

function parseBindOptions(modeParts: string[]): { readOnly: boolean; options: string[] } {
  const tokens = modeParts
    .flatMap((part) => part.split(','))
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return {
    readOnly: tokens.includes('ro'),
    options: tokens.filter((token) => token !== 'ro' && token !== 'rw').sort(),
  };
}

function parseBindDefinition(bind: string): NormalizedMountDefinition | null {
  const [rawSource, rawTarget, ...modeParts] = bind.split(':');
  const target = normalizeContainerPath(rawTarget);
  if (!rawSource || !target) return null;
  const source = rawSource.trim();
  if (!source) return null;
  const { readOnly, options } = parseBindOptions(modeParts);
  if (source.startsWith('/')) {
    return { type: 'bind', source: normalizeHostPath(source), target, readOnly, options };
  }
  return { type: 'volume', source, target, readOnly, options };
}

export function normalizeMountDefinitionsFromConfig(config: {
  mounts?: DockerMountInput[] | null;
  volumes?: DockerMountInput[] | null;
}): NormalizedMountDefinition[] {
  const definitions: NormalizedMountDefinition[] = [];
  for (const mount of config.mounts ?? []) {
    const normalized = normalizeMountInput(mount);
    if (normalized) definitions.push(normalized);
  }
  for (const mount of config.volumes ?? []) {
    const normalized = normalizeMountInput(mount);
    if (normalized) definitions.push(normalized);
  }
  return sortMountDefinitions(definitions);
}

export function normalizeMountDefinitionsFromInspect(
  inspect: DockerInspectData | null | undefined
): NormalizedMountDefinition[] {
  const definitions: NormalizedMountDefinition[] = [];
  const bindTargets = new Set<string>();
  for (const bind of inspect?.HostConfig?.Binds ?? []) {
    const normalized = parseBindDefinition(bind);
    if (normalized) {
      definitions.push(normalized);
      bindTargets.add(definitionIdentity(normalized));
    }
  }
  for (const mount of inspect?.Mounts ?? []) {
    const target = normalizeContainerPath(mount.Destination);
    if (!target) continue;
    const type = String(mount.Type ?? '').toLowerCase();
    if (type === 'bind') {
      const source = normalizeHostPath(mount.Source);
      if (source) {
        const definition = { type: 'bind' as const, source, target, readOnly: mount.RW === false };
        if (!bindTargets.has(definitionIdentity(definition))) definitions.push(definition);
      }
      continue;
    }
    if (type === 'volume') {
      const source = String(mount.Name ?? mount.Source ?? '').trim();
      if (source) {
        const definition = { type: 'volume' as const, source, target, readOnly: mount.RW === false };
        if (!bindTargets.has(definitionIdentity(definition))) definitions.push(definition);
      }
    }
  }
  return sortMountDefinitions(dedupeMountDefinitions(definitions));
}

function sortMountDefinitions(definitions: NormalizedMountDefinition[]): NormalizedMountDefinition[] {
  return [...definitions].sort((a, b) => serializeMount(a).localeCompare(serializeMount(b)));
}

function dedupeMountDefinitions(definitions: NormalizedMountDefinition[]): NormalizedMountDefinition[] {
  return [...new Map(definitions.map((definition) => [serializeMount(definition), definition])).values()];
}

function serializeMount(definition: NormalizedMountDefinition): string {
  const options = [...(definition.options ?? [])].sort().join(',');
  return `${definition.type}:${definition.source}:${definition.target}:${definition.readOnly ? 'ro' : 'rw'}:${options}`;
}

function definitionIdentity(definition: NormalizedMountDefinition): string {
  return `${definition.type}:${definition.source}:${definition.target}:${definition.readOnly ? 'ro' : 'rw'}`;
}

function definitionsEqual(current: NormalizedMountDefinition[], next: NormalizedMountDefinition[]): boolean {
  if (current.length !== next.length) return false;
  return current.every((definition, index) => serializeMount(definition) === serializeMount(next[index]));
}

/** docker:volumes:view on `<nodeId>/<volume>`, as broad, node and folder grants resolve to it. */
function canViewDockerVolume(actorScopes: readonly string[], nodeId: string, volumeName: string): boolean {
  const scopes = [...actorScopes];
  return (
    hasScope(scopes, 'docker:volumes:view') ||
    hasScope(scopes, `docker:volumes:view:${nodeId}`) ||
    hasScope(scopes, `docker:volumes:view:${nodeId}/${volumeName}`)
  );
}

function hasConfigMountFields(config: { mounts?: unknown; volumes?: unknown } | undefined) {
  return !!config && (Object.hasOwn(config, 'mounts') || Object.hasOwn(config, 'volumes'));
}

/** Recreate request fields that never change what runs against the container's mounts (compared separately). */
const NON_WORKLOAD_RECREATE_FIELDS = new Set(['env', 'labels', 'networks', 'mounts', 'volumes']);

/**
 * Whether a container recreate request can run other code against the container's host binds. Only a request
 * limited to environment, labels, networks and unchanged mounts keeps the image; any other field (the image
 * included, even under the same reference, since a pull can bring other code) counts as a change.
 */
export function containerRecreateChangesWorkload(request: Record<string, unknown>): boolean {
  return Object.keys(request).some((key) => request[key] !== undefined && !NON_WORKLOAD_RECREATE_FIELDS.has(key));
}

export function assertDockerMountChangeAllowed(args: {
  nodeId: string;
  resourceId?: string;
  actorScopes: readonly string[];
  nextConfig?: { mounts?: DockerMountInput[] | null; volumes?: DockerMountInput[] | null };
  nextDefinitions?: NormalizedMountDefinition[];
  currentInspect?: DockerInspectData | null;
  currentDefinitions?: NormalizedMountDefinition[];
  useCurrentWhenNextMissing?: boolean;
  /**
   * Whether the change can run other code against the workload's host binds: another image, command,
   * entrypoint, user or runtime. Left out, it counts as a change. A recreate that keeps all of that and the
   * mounts (only environment, secrets, labels or Opfield link networks differ) grants no new host access,
   * so it needs no mounts scope from anyone.
   */
  workloadChanged?: boolean;
  /** Volumes the operation creates itself (an archive import); their creation is authorized on its own. */
  createdVolumes?: readonly string[];
}): { mountsChanged: boolean } {
  const currentDefinitions = args.currentDefinitions ?? normalizeMountDefinitionsFromInspect(args.currentInspect);
  const nextDefinitions = args.nextDefinitions
    ? sortMountDefinitions(args.nextDefinitions)
    : args.useCurrentWhenNextMissing && !hasConfigMountFields(args.nextConfig)
      ? currentDefinitions
      : normalizeMountDefinitionsFromConfig(args.nextConfig ?? {});
  const mountsChanged = !definitionsEqual(currentDefinitions, nextDefinitions);
  // docker:containers:mounts guards host bind mounts only: new ones are refused, legacy ones are kept or removed
  // with it.
  const isBind = (definition: NormalizedMountDefinition) => definition.type === 'bind';
  const bindsChanged = !definitionsEqual(currentDefinitions.filter(isBind), nextDefinitions.filter(isBind));

  const resourceSuffix = args.resourceId ? `${args.nodeId}/${args.resourceId}` : args.nodeId;
  const hasMountScope = hasScope([...args.actorScopes], `docker:containers:mounts:${resourceSuffix}`);
  const preservesHostBindCapability = args.workloadChanged !== false && currentDefinitions.some(isBind);
  if ((bindsChanged || preservesHostBindCapability) && !hasMountScope) {
    throw new AppError(
      403,
      'MISSING_DOCKER_MOUNTS_SCOPE',
      preservesHostBindCapability && !bindsChanged
        ? 'Changing the image, command or runtime of a Docker container or deployment with host bind mounts requires docker:containers:mounts'
        : 'Changing Docker container or deployment mounts requires docker:containers:mounts for host binds'
    );
  }

  // A managed volume is attached with view access to that volume (its edit implies view); the workload's own create
  // or edit authorizes the rest. Volumes already attached the same way stay without a check.
  const attached = new Set(currentDefinitions.map(serializeMount));
  const created = new Set(args.createdVolumes ?? []);
  for (const definition of nextDefinitions) {
    if (definition.type !== 'volume' || attached.has(serializeMount(definition)) || created.has(definition.source)) {
      continue;
    }
    if (!canViewDockerVolume(args.actorScopes, args.nodeId, definition.source)) {
      throw new AppError(
        403,
        'MISSING_DOCKER_VOLUME_SCOPE',
        `Attaching volume "${definition.source}" requires docker:volumes:view on it`,
        { requiredScope: 'docker:volumes:view' }
      );
    }
  }

  return { mountsChanged };
}
